use serde::Serialize;
use std::collections::BTreeMap;
use tidewater_formats::script::{MISSILE_KINDS, Op, Scripts};
use tidewater_sim::{Missile, TILE_PX, World, slots::PERMANENT_EFFECTS, spells::Fx};

#[derive(Serialize)]
pub(super) struct MapEffect {
    pub kind: u8,
    pub x: i32,
    pub y: i32,
    pub frame: u8,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub mirrored: bool,
}

pub(super) struct EffectAnimations([Animation; MISSILE_KINDS]);

impl EffectAnimations {
    pub(super) fn new(scripts: &Scripts) -> Self {
        Self(std::array::from_fn(|kind| {
            Animation::new(scripts, kind as u8).unwrap_or_default()
        }))
    }

    pub(super) fn visible(&self, world: &World, player: u8) -> Vec<MapEffect> {
        let reveal = world.reveal_view();
        world
            .missiles
            .iter()
            .skip(PERMANENT_EFFECTS)
            .flatten()
            .filter_map(|effect| {
                let age = effect.visible_age()?;
                let x = effect.pos.0.div_euclid(TILE_PX);
                let y = effect.pos.1.div_euclid(TILE_PX);
                if !reveal && !(-1..=1).any(|dy| (-1..=1).any(|dx| !world.vision.unseen_by(player, x + dx, y + dy))) {
                    return None;
                }
                let (column, mirrored) = facing(effect);
                let base = self.0.get(effect.kind as usize)?.frame(age, effect.fx);
                Some(MapEffect {
                    kind: effect.kind,
                    x: effect.pos.0,
                    y: effect.pos.1,
                    frame: base.checked_add(column)?,
                    mirrored,
                })
            })
            .collect()
    }
}

/// Only sheets that contain five facings per animation frame take a direction column.
fn facing(effect: &Missile) -> (u8, bool) {
    if !matches!(effect.kind, 0x00..=0x03 | 0x07 | 0x0a | 0x0d..=0x12 | 0x18 | 0x1b) {
        return (0, false);
    }
    let (dx, dy) = (effect.to.0 - effect.from.0, effect.to.1 - effect.from.1);
    if (dx, dy) == (0, 0) {
        return (0, false);
    }
    let angle = f64::from(dx).atan2(-f64::from(dy));
    let index = ((angle / std::f64::consts::FRAC_PI_4).round() as i8).rem_euclid(8) as usize;
    ([0, 1, 2, 3, 4, 3, 2, 1][index], index >= 5)
}

#[derive(Default)]
struct Animation {
    start: u8,
    flight: Track,
    landing: Track,
}

impl Animation {
    fn new(scripts: &Scripts, kind: u8) -> Option<Self> {
        // The start step restarts the script with wait=1, so it keeps the
        // start script's frame until the next update.
        let mut script = Cursor::new(scripts.missile_animation(kind, 0)?, 0);
        let mut start = None;
        for _ in 0..64 {
            if script.next_wait(scripts)?.1 {
                start = Some(script.frame);
                break;
            }
        }
        let start = start?;
        let single_pass = matches!(kind, 0x08 | 0x09 | 0x0b | 0x15..=0x17 | 0x19..=0x1a | 0x1c);
        let flight = Track::read(scripts, scripts.missile_animation(kind, 1)?, start, single_pass)?;
        // Blizzard shards remain in their slots for a four-cycle landing
        // animation. Other impacts use separate effect slots and sheets.
        let landing = if kind == 0x05 {
            Track::read(scripts, scripts.missile_animation(kind, 2)?, start, true)?
        } else {
            Track::default()
        };
        Some(Self { start, flight, landing })
    }

    fn frame(&self, age: u16, state: Fx) -> u8 {
        if let Fx::Shard {
            landed: landed @ 1..=4, ..
        } = state
        {
            return self.landing.frame(usize::from(4 - landed)).unwrap_or(self.start);
        }
        age.checked_sub(1)
            .and_then(|elapsed| self.flight.frame(usize::from(elapsed)))
            .unwrap_or(self.start)
    }
}

#[derive(Default)]
struct Track {
    frames: Vec<u8>,
    loop_start: Option<usize>,
}

impl Track {
    fn read(scripts: &Scripts, pc: u16, start: u8, single_pass: bool) -> Option<Self> {
        let mut cursor = Cursor::new(pc, start);
        let mut track = Self::default();
        let mut visited = BTreeMap::new();
        // The original effects have short tracks. Bound malformed scripts
        // so an invalid installation cannot stall a browser.
        for _ in 0..512 {
            if let Some(at) = visited.insert((cursor.pc, cursor.frame), track.frames.len()) {
                track.loop_start = Some(at);
                return Some(track);
            }
            let (wait, step) = cursor.next_wait(scripts)?;
            if single_pass && step {
                break;
            }
            track
                .frames
                .extend(std::iter::repeat_n(cursor.frame, usize::from(wait)));
        }
        Some(track)
    }

    fn frame(&self, age: usize) -> Option<u8> {
        if age < self.frames.len() {
            return Some(self.frames[age]);
        }
        if let Some(start) = self.loop_start {
            let period = self.frames.len() - start;
            return self.frames.get(start + (age - start) % period).copied();
        }
        self.frames.last().copied()
    }
}

struct Cursor {
    pc: u16,
    frame: u8,
}

impl Cursor {
    fn new(pc: u16, frame: u8) -> Self {
        Self { pc, frame }
    }

    fn next_wait(&mut self, scripts: &Scripts) -> Option<(u16, bool)> {
        for _ in 0..64 {
            let op = scripts.decode(self.pc)?;
            self.pc = self.pc.checked_add(op.size() as u16)?;
            match op {
                Op::Frame(frame) | Op::MoveFrame(_, frame) | Op::Move2Frame(_, frame) => self.frame = frame,
                Op::Jump(pc) => self.pc = pc,
                Op::StepDone => return Some((1, true)),
                Op::Wait(wait)
                | Op::WaitHasteSlow(wait)
                | Op::WaitHaste(wait)
                | Op::WaitSlow(wait)
                | Op::WaitCarry(wait) => return Some((if wait == 0 { 256 } else { u16::from(wait) }, false)),
                Op::Halt => return Some((256, false)),
                _ => {}
            }
        }
        None
    }
}
