//! The original unit statistics shown in the information panel.

use tidewater_formats::script::{Op, Scripts, anim};
use tidewater_formats::udta::UnitStats;

/// The damage range of a type (spec "Damage").
pub fn damage(basic: u8, piercing: u8) -> (u32, u32) {
    let (b, p) = (basic as i32, piercing as i32);
    let max = b + p;
    let min = ((b - 30).div_euclid(2)).max(0) + (p + 1) / 2;
    (min as u32, max as u32)
}

/// The move duration D(t) of a type: its move animation walked to the second step-done (spec "Speed").
pub fn move_duration(scripts: &Scripts, t: u8) -> u32 {
    let Some(mut pc) = scripts.unit(t, anim::MOVE) else {
        return 0;
    };
    let (mut d, mut done) = (0u32, 0);
    // A guard against scripts that loop without a step-done.
    for _ in 0..10_000 {
        let Some(op) = scripts.decode(pc) else { break };
        match op {
            Op::StepDone => {
                d += 1;
                done += 1;
                if done == 2 {
                    break;
                }
            }
            Op::Wait(n) | Op::WaitHasteSlow(n) | Op::WaitHaste(n) | Op::WaitSlow(n) | Op::WaitCarry(n) => d += n as u32,
            Op::Jump(to) => {
                pc = to;
                continue;
            }
            _ => {}
        }
        pc = pc.wrapping_add(op.size() as u16);
    }
    d
}

/// Speed per type: floor(10 x D(0) / D(t)) in 8 bits, with D halved for air and naval movers; 0 when D(t) is 0.
pub fn speeds(scripts: &Scripts, stats: &[UnitStats]) -> Vec<u8> {
    let d = |t: u8| {
        let d = move_duration(scripts, t);
        match stats.get(t as usize).map(|s| s.movement_class) {
            Some(1 | 2) => d / 2,
            _ => d,
        }
    };
    let base = d(0);
    (0..stats.len().min(256))
        .map(|t| {
            let dt = d(t as u8);
            (10 * base).checked_div(dt).unwrap_or(0) as u8
        })
        .collect()
}
