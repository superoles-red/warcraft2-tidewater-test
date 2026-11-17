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

/// The panel class of a type, which picks its rules.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    Melee,
    Siege,
    Archer,
    Sea,
    Transport,
    Bare,
    /// No panel class ("none" in the spec's table).
    Nothing,
    Farm,
    Training,
    Church,
    ScoutTower,
    Plain,
    Shipyard,
    Hall,
    LumberMill,
    Smith,
    MageTower,
    Refinery,
    OilSource,
    GoldMine,
    Tower,
}

/// The class and panel kind of a type; `None` past the spec's table (0x69).
pub fn class(t: u8) -> Option<(Class, u8)> {
    use Class::*;
    Some(match t {
        0x0A..=0x0D | 0x15 | 0x18 => (Melee, 2),
        0x00 | 0x01 | 0x06 | 0x07 | 0x0E | 0x0F | 0x16 | 0x17 | 0x19 | 0x23 | 0x28..=0x2F | 0x31..=0x34 | 0x37 => {
            (Melee, 1)
        }
        0x02 | 0x03 | 0x10 | 0x11 => (Melee, 1),
        0x04 | 0x05 => (Siege, 1),
        0x08 | 0x09 | 0x12 | 0x13 | 0x14 | 0x35 => (Archer, 1),
        0x1A | 0x1B | 0x1E..=0x21 | 0x26 | 0x27 => (Sea, 1),
        0x1C | 0x1D => (Transport, 1),
        0x22 | 0x24 | 0x25 | 0x38 | 0x39 => (Bare, 1),
        0x30 | 0x36 | 0x5E | 0x5F | 0x69 => (Nothing, 0),
        0x3A | 0x3B => (Farm, 1),
        0x3C | 0x3D | 0x44..=0x47 => (Training, 3),
        0x3E | 0x3F => (Church, 3),
        0x40 | 0x41 => (ScoutTower, 3),
        0x42 | 0x43 | 0x65 | 0x67 | 0x68 => (Plain, 3),
        0x64 | 0x66 => (Plain, 1),
        0x48 | 0x49 => (Shipyard, 3),
        0x4A | 0x4B | 0x58..=0x5B => (Hall, 3),
        0x4C | 0x4D => (LumberMill, 3),
        0x4E | 0x4F | 0x52 | 0x53 => (Smith, 3),
        0x50 | 0x51 => (MageTower, 3),
        0x54 | 0x55 => (Refinery, 3),
        0x56 | 0x57 | 0x5D => (OilSource, 3),
        0x5C => (GoldMine, 1),
        0x60..=0x63 => (Tower, 3),
        _ => return None,
    })
}

/// The level line's number: 1 plus the owner's levels for the class (spec "Level line").
pub fn level(t: u8, st: &UnitStats, levels: &[u8], spells: u32) -> u32 {
    let (wu, au) = (st.weapons_upgradable as u32, st.armor_upgradable as u32);
    let level = |group: usize| u32::from(levels.get(group).copied().unwrap_or_default());
    let knows = |bit: u8| u32::from(spells & (1 << bit) != 0);
    1 + match class(t).map(|(class, _)| class) {
        Some(Class::Melee) => {
            wu * level(1)
                + au * level(2)
                + match t {
                    0x0A => [4, 6, 7, 8, 9].iter().map(|&b| knows(b)).sum(),
                    0x0B => [13, 15, 16, 17, 19].iter().map(|&b| knows(b)).sum(),
                    0x0C => 1 + knows(1) + knows(3),
                    0x0D => 1 + knows(11) + knows(18),
                    _ => 0,
                }
        }
        Some(Class::Siege) => level(6),
        Some(Class::Archer) => level(7) + level(10) + level(9) + level(8) + level(0) + au * level(2),
        Some(Class::Sea) => level(5) + wu * level(3) + au * level(4),
        Some(Class::Transport) => level(5) + level(4),
        _ => 0,
    }
}

/// Whether the original unit panel shows a mana row for this type.
pub fn shows_mana(t: u8, st: &UnitStats) -> bool {
    class(t).is_some_and(|(class, _)| class == Class::Melee) && st.flags & tidewater_formats::udta::flags::CASTER != 0
}
