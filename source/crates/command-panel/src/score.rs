//! Original single-player score row labels, nations and counts.

use tidewater_sim::{World, ai::controller};

/// The mission score bonus for victory.
pub const VICTORY_BONUS: u32 = 500;

/// The rows' labels in `network.tbl`.
pub mod label {
    pub const YOU: u16 = 34;
    pub const ENEMY: u16 = 35;
    pub const ALLY: u16 = 36;
}

/// The row label of slot `slot` (single player), or `None` when it isn't shown. `controllers` are the slots'
/// controllers as they were when the game started; `allied` tells whether the local player counts a slot allied.
pub fn row_label(slot: u8, local: u8, controllers: &[u8; 8], allied: impl Fn(u8) -> bool) -> Option<u16> {
    if slot == local {
        return Some(label::YOU);
    }
    if controllers[slot as usize] != controller::COMPUTER {
        return None;
    }
    Some(if allied(slot) { label::ALLY } else { label::ENEMY })
}

/// The `network.tbl` entry of a row's name, by slot and race ("Players shown").
pub fn name_entry(slot: u8, race: u8, bdp_campaign: bool) -> u16 {
    const HUMAN_NAMES: [u16; 8] = [50, 46, 52, 56, 58, 54, 48, 60];
    const ORC_NAMES: [u16; 8] = [51, 47, 53, 57, 59, 55, 49, 61];
    const BDP_ORC_NAMES: [u16; 8] = [94, 92, 95, 97, 98, 96, 93, 99];
    let s = slot as usize & 7;
    match (race == tidewater_sim::setup::race::ORC, bdp_campaign) {
        (true, true) => BDP_ORC_NAMES[s],
        (true, false) => ORC_NAMES[s],
        _ => HUMAN_NAMES[s],
    }
}

/// One shown player's statistics.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    pub units: u32,
    pub buildings: u32,
    pub gold: u32,
    pub lumber: u32,
    pub oil: u32,
    pub kills: u32,
    pub razings: u32,
}

impl Stats {
    pub const NAMES: [&'static str; 7] = ["Units", "Buildings", "Gold", "Lumber", "Oil", "Kills", "Razings"];

    pub fn values(&self) -> [u32; 7] {
        [
            self.units,
            self.buildings,
            self.gold,
            self.lumber,
            self.oil,
            self.kills,
            self.razings,
        ]
    }

    /// Player `p`'s statistics at the end of a game: units and buildings are those alive now plus those lost, both
    /// read from the per-type counts (only completed units and buildings of a type that has one; spec "Statistics").
    pub fn of_world(w: &World, p: u8) -> Stats {
        let alive = |building: bool| {
            w.units
                .iter()
                .filter(|u| u.owner == p && u.building == building && !u.dying && !u.removing && World::counted(u))
                .count() as u32
        };
        let pl = &w.players[p as usize];
        Stats {
            units: alive(false) + pl.units_lost,
            buildings: alive(true) + pl.buildings_lost,
            gold: pl.gathered[0],
            lumber: pl.gathered[1],
            oil: pl.gathered[2],
            kills: pl.kills,
            razings: pl.razings,
        }
    }
}

/// One row of the score screen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    pub slot: u8,
    pub label: u16,
    pub name: u16,
    pub stats: Stats,
}

/// The rows of a single-player score screen. `start_controllers` are the slots' controllers when the game started.
pub fn rows(w: &World, local: u8, start_controllers: &[u8; 8], bdp_campaign: bool) -> Vec<Row> {
    let allied = |q: u8| w.players[local as usize].allies & (1 << q) != 0;
    (0..8u8)
        .filter_map(|slot| {
            let label = row_label(slot, local, start_controllers, allied)?;
            let race = w.players[slot as usize].race;
            Some(Row {
                slot,
                label,
                name: name_entry(slot, race, bdp_campaign),
                stats: Stats::of_world(w, slot),
            })
        })
        .collect()
}
