//! Browser host for the Warcraft II campaigns.

#![deny(unsafe_code)]

use std::io::Cursor;
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tidewater_command_panel::score as results;
use tidewater_formats::{
    identity::{FNV_BASIS, data_hash, fnv_extend},
    install::{Files, Install},
    mpq::ReadSeek,
};
use tidewater_sim::economy::{Event, JobKind};
use tidewater_sim::sound::{Cue, Pick, Place, Sound};
use tidewater_sim::timing::{Pacing, Scheduler};
use tidewater_sim::victory::Outcome;
use tidewater_sim::vision::Map;
use tidewater_sim::{Command, Order, Unit, UnitId, World};

const TILE: i32 = tidewater_sim::TILE_PX;
const PEASANT: u8 = 2;
const WORKER_CAP: usize = 9;

#[cfg(target_arch = "wasm32")]
mod abi;

mod campaign;
use campaign::{Campaign, Catalog, Mission};

mod checkpoint;
use checkpoint::Origin;

mod panel;
use panel::{Action, Commands, Text};

mod scenario;
use scenario::Scenario;

#[derive(Clone)]
struct ArchiveBytes(Arc<Vec<u8>>);

impl AsRef<[u8]> for ArchiveBytes {
    fn as_ref(&self) -> &[u8] {
        self.0.as_slice()
    }
}

struct Archives {
    data: ArchiveBytes,
    patch: ArchiveBytes,
}

impl Files for Archives {
    fn open(&self, name: &str) -> std::io::Result<Option<Box<dyn ReadSeek>>> {
        let source = if name.eq_ignore_ascii_case("War2Dat.mpq") {
            &self.data
        } else if name.eq_ignore_ascii_case("War2Patch.mpq") {
            &self.patch
        } else {
            return Ok(None);
        };
        Ok((!source.as_ref().is_empty()).then(|| Box::new(Cursor::new(source.clone())) as Box<dyn ReadSeek>))
    }
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Request {
    Snapshot,
    Campaigns,
    LoadMission {
        id: u8,
    },
    LoadDemo {
        id: u8,
        #[serde(default)]
        seed: u32,
    },
    Hash,
    Step {
        cycles: u32,
    },
    Frame {
        now: i64,
    },
    ResetClock,
    Restart,
    Select {
        x: f64,
        y: f64,
        #[serde(default)]
        radius: f64,
    },
    SelectIds {
        ids: Vec<u32>,
    },
    Move {
        x: f64,
        y: f64,
    },
    Smart {
        x: f64,
        y: f64,
    },
    Target {
        action: String,
        spell: Option<u8>,
        x: f64,
        y: f64,
    },
    Cast {
        kind: u8,
    },
    Unload,
    CheckBuild {
        kind: u8,
        x: f64,
        y: f64,
    },
    Build {
        kind: u8,
        x: f64,
        y: f64,
    },
    Train {
        kind: u8,
    },
    Upgrade {
        kind: u8,
    },
    Research {
        kind: u8,
    },
    Stop,
    Hold,
    ReturnGoods,
    Cancel,
    HoldWorkers,
    ReleaseWorkers,
    Speed {
        speed: u8,
    },
    Fog {
        enabled: bool,
    },
    Surrender,
}

#[derive(Serialize)]
struct Placement {
    x: i32,
    y: i32,
    width: u16,
    height: u16,
    valid: bool,
    message: Option<u16>,
    reason: Option<String>,
    blocked: Vec<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UnitView<'a> {
    id: u32,
    owner: u8,
    colour: u8,
    kind: u8,
    picture: u8,
    name: Option<&'a str>,
    name_entry: Option<u16>,
    x: i32,
    y: i32,
    tile_x: i32,
    tile_y: i32,
    width: i32,
    height: i32,
    hp: u16,
    max_hp: u16,
    building: bool,
    rect_selectable: bool,
    construction: bool,
    progress: Option<u8>,
    job: Option<JobKind>,
    facing: u8,
    frame: u16,
    mirrored: bool,
    sprite: String,
    minimap: bool,
    dying: bool,
    order: &'static str,
    armor: u8,
    damage: [u8; 2],
    damage_range: [u32; 2],
    display_speed: u8,
    sight: u32,
    range: u8,
    resources: u32,
    resources_amount: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Resources {
    gold: u32,
    lumber: u32,
    oil: u32,
    food_used: u32,
    food_supply: u32,
}

#[derive(Serialize)]
struct SoundView {
    cue: &'static str,
    kind: Option<u8>,
    tile: Option<(i32, i32)>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Score {
    kills: u32,
    razings: u32,
    units_lost: u32,
    buildings_lost: u32,
    gathered: [u32; 3],
    score: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    mission_score: Option<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    rows: Vec<ScoreRow>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScoreRow {
    slot: u8,
    color: u8,
    name_entry: u16,
    label: u16,
    values: [u32; 7],
}

#[derive(Serialize)]
struct DemoView {
    id: u8,
    finished: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot<'a> {
    tick: u32,
    player: u8,
    player_colour: u8,
    race: u8,
    width: u16,
    height: u16,
    tile_size: i32,
    resources: Resources,
    units: Vec<UnitView<'a>>,
    selection: Vec<u32>,
    actions: Vec<Action>,
    fog: bool,
    speed: u8,
    cycle_ms: u32,
    outcome: Option<&'static str>,
    next_mission: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    campaigns: Option<Vec<Campaign>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scenario: Option<&'a scenario::Metadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    demo: Option<DemoView>,
    score: Score,
    #[serde(skip_serializing_if = "Option::is_none")]
    mission: Option<&'a Mission>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    terrain: Option<&'a [u16]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    terrain_regions: Option<&'a [u16]>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    terrain_changes: Vec<(i32, i32, u16)>,
    #[serde(skip_serializing_if = "Option::is_none")]
    explored: Option<&'a [u8]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    visible: Option<&'a [u8]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    placement: Option<Placement>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    events: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    sounds: Vec<SoundView>,
}

/// A campaign session using the same engine on the desktop and in WebAssembly.
pub struct Engine {
    install: Install,
    origin: Origin,
    catalog: Catalog,
    text: Text,
    world: World,
    player: u8,
    mission: Mission,
    scenario: Option<Scenario>,
    demo: Option<u8>,
    start_controllers: [u8; 8],
    speeds: Vec<u8>,
    clock: Option<Scheduler>,
    sent_explored: Vec<u8>,
    sent_visible: Vec<u8>,
}

impl Engine {
    pub fn open(data: Vec<u8>, patch: Vec<u8>) -> Result<Self> {
        let archives = Archives {
            data: ArchiveBytes(Arc::new(data)),
            patch: ArchiveBytes(Arc::new(patch)),
        };
        let mut install = Install::from_files(Box::new(archives))?;
        let catalog = Catalog::new(&mut install)?;
        let text = Text::load(&mut install)?;
        let simulation_data = data_hash(|name| install.read(name))?;
        let (world, player, mission) = catalog.start(&mut install, campaign::FIRST)?;
        let speeds = tidewater_command_panel::stats::speeds(&world.scripts, &world.stats.0);
        let start_controllers = std::array::from_fn(|slot| world.players[slot].controller);
        let origin = Origin {
            data: simulation_data,
            map: mission.map_hash,
            start: world.state_hash(),
        };
        Ok(Self {
            install,
            origin,
            catalog,
            text,
            world,
            player,
            mission,
            scenario: None,
            demo: None,
            start_controllers,
            speeds,
            clock: None,
            sent_explored: Vec::new(),
            sent_visible: Vec::new(),
        })
    }

    /// Decode one browser request and return a compact, JSON-encoded state update.
    pub fn request(&mut self, request: &[u8]) -> Result<Vec<u8>> {
        let request: Request = serde_json::from_slice(request)?;
        if self.demo.is_some()
            && !matches!(
                request,
                Request::Snapshot
                    | Request::Campaigns
                    | Request::LoadMission { .. }
                    | Request::LoadDemo { .. }
                    | Request::Hash
                    | Request::Step { .. }
                    | Request::Frame { .. }
                    | Request::ResetClock
            )
        {
            bail!("Demo playback does not take battle commands");
        }
        let mut full = false;
        let mut hash = false;
        let mut placement = None;
        let mut campaigns = None;
        let player = self.player;
        match request {
            Request::Snapshot => full = true,
            Request::Campaigns => campaigns = Some(self.catalog.campaigns()?),
            Request::LoadMission { id } => {
                self.load_mission(id)?;
                full = true;
            }
            Request::LoadDemo { id, seed } => {
                self.load_demo(id, seed)?;
                full = true;
            }
            Request::Hash => hash = true,
            Request::Step { cycles } => {
                if !(1..=600).contains(&cycles) {
                    bail!("cycles must be between 1 and 600");
                }
                self.step(cycles);
            }
            Request::Frame { now } => {
                if now < 0 {
                    bail!("clock must be non-negative");
                }
                let pacing = self.pacing();
                let speed = self.world.speed;
                let scheduler = self.clock.get_or_insert_with(|| Scheduler::new(pacing, speed, now));
                if scheduler.speed() != speed {
                    scheduler.set_speed(speed, now);
                }
                let cycles = scheduler.frame(now);
                self.step(cycles);
            }
            Request::ResetClock => self.clock = None,
            Request::Restart => {
                self.restart()?;
                full = true;
            }
            Request::SelectIds { ids } => self.select(&ids.into_iter().map(UnitId).collect::<Vec<_>>())?,
            Request::Select { x, y, radius } => {
                let hit = self.hit(x, y, radius.clamp(0.0, 24.0));
                self.select(hit.as_slice())?;
            }
            Request::Move { x, y } => {
                let to = self.tile(x, y)?;
                let units = self
                    .selection()
                    .into_iter()
                    .filter(|&id| {
                        self.world
                            .unit(id)
                            .is_some_and(|unit| unit.owner == player && self.world.is_mobile(unit))
                    })
                    .collect();
                self.send(Command::Move { player, units, to });
            }
            Request::Smart { x, y } => {
                let tile = self.tile(x, y)?;
                let target = self.hit(x, y, 0.0);
                self.send(Command::RightClick { player, target, tile });
            }
            Request::Target { action, spell, x, y } => {
                let tile = self.tile(x, y)?;
                let target = self.hit(x, y, 0.0);
                let aim = self.commands().target(&self.text, &action, spell)?;
                if let Some(command) = tidewater_command_panel::target_command(aim, player, target, tile) {
                    self.send(command);
                }
            }
            Request::CheckBuild { kind, x, y } => placement = Some(self.placement(kind, x, y)?),
            Request::Build { kind, x, y } => {
                let site = self.placement(kind, x, y)?;
                let unit = self.primary()?;
                if site.valid {
                    self.send(Command::Build {
                        player,
                        unit,
                        kind,
                        tile: (site.x, site.y),
                    });
                }
                placement = Some(site);
            }
            Request::Train { kind } => self.execute_panel("train", Some(kind))?,
            Request::Upgrade { kind } => self.execute_panel("upgrade", Some(kind))?,
            Request::Research { kind } => self.execute_panel("research", Some(kind))?,
            Request::Cast { kind } => self.execute_panel("cast", Some(kind))?,
            Request::Unload => self.execute_panel("unload", None)?,
            Request::Stop => self.execute_panel("stop", None)?,
            Request::Hold => self.execute_panel("hold", None)?,
            Request::ReturnGoods => self.execute_panel("returnGoods", None)?,
            Request::Cancel => self.execute_panel("cancel", None)?,
            Request::HoldWorkers => self.send(Command::HoldWorkers { player }),
            Request::ReleaseWorkers => self.send(Command::ReleaseWorkers { player }),
            Request::Speed { speed } => {
                if speed > 8 {
                    bail!("speed must be between 0 and 8");
                }
                self.send(Command::Speed { player, speed });
            }
            Request::Fog { enabled } => self.world.set_fog_of_war(enabled),
            Request::Surrender => self.send(Command::Surrender { player }),
        }
        self.snapshot(full, hash, placement, campaigns)
    }

    /// Starts a selected map with the requested options. An invalid selection leaves the current game intact.
    pub fn load_scenario(&mut self, metadata: &[u8], data: &[u8]) -> Result<Vec<u8>> {
        let scenario = Scenario::new(metadata, data)?;
        let state = scenario.start(&mut self.install, &self.catalog)?;
        self.activate(state);
        self.scenario = Some(scenario);
        self.snapshot(true, false, None, None)
    }

    fn activate(&mut self, state: (World, u8, Mission)) {
        (self.world, self.player, self.mission) = state;
        self.origin.map = self.mission.map_hash;
        self.origin.start = self.world.state_hash();
        self.speeds = tidewater_command_panel::stats::speeds(&self.world.scripts, &self.world.stats.0);
        self.start_controllers = std::array::from_fn(|slot| self.world.players[slot].controller);
        self.demo = None;
        self.clock = None;
    }

    fn load_mission(&mut self, id: u8) -> Result<()> {
        let state = self.catalog.start(&mut self.install, id)?;
        self.activate(state);
        self.scenario = None;
        Ok(())
    }

    fn load_demo(&mut self, id: u8, seed: u32) -> Result<()> {
        use tidewater_formats::pud::Pud;
        use tidewater_sim::{
            cheats::Flags,
            setup::{Setup, Start},
            victory::Victory,
        };

        if !(1..=4).contains(&id) {
            bail!("Unknown Warcraft II demo");
        }
        let path = format!("OrigMaps\\Attract\\ATTRCT{id:02}.PUD");
        let data = self.install.read(&path)?;
        let map = Pud::parse(&data)?;
        let setup = Setup {
            enhanced: false,
            ..Setup::default()
        };
        let start = Start::choose(&map, &setup, seed)?;
        let (mut world, _) = tidewater_replay::start::build_world(&mut self.install, &map, &start)?;
        world.victory = Victory::for_demo();
        world.sounds.demo = true;
        world.start_cheats(Flags::default().for_demo());
        world.start_up();
        let mission = Mission::demo(path, world.start.view, start.era, fnv_extend(FNV_BASIS, &data));
        self.activate((world, start.local, mission));
        self.scenario = None;
        self.demo = Some(id);
        Ok(())
    }

    fn demo_finished(&self) -> bool {
        // Two start-up cycles run before the displayed tick counter starts.
        self.demo.is_some() && self.world.tick >= tidewater_sim::victory::DEMO_COUNTDOWN - 1
    }

    fn fresh_current(&mut self) -> Result<(World, u8, Mission)> {
        if let Some(scenario) = &self.scenario {
            scenario.start(&mut self.install, &self.catalog)
        } else {
            let id = self.mission.id.context("No mission is running")?;
            self.catalog.start(&mut self.install, id)
        }
    }

    fn restart(&mut self) -> Result<()> {
        let state = self.fresh_current()?;
        self.activate(state);
        Ok(())
    }

    /// Saves the world of the current battle for the browser's single Continue slot.
    pub fn save_checkpoint(&self) -> Result<Vec<u8>> {
        if self.demo.is_some() {
            bail!("A demo cannot be continued as a battle");
        }
        if self.world.players[self.player as usize].result.is_some() {
            bail!("A finished battle cannot be continued");
        }
        checkpoint::save(self.origin, &self.world)
    }

    /// Restores a checkpoint over a fresh template of the exact same map and setup.
    pub fn restore_checkpoint(&mut self, checkpoint: &[u8]) -> Result<Vec<u8>> {
        let (seed, state) = checkpoint::read(self.origin, checkpoint)?;
        let (mut world, player, _) = self.fresh_current()?;
        world.restore(state, seed)?;
        if world.players[player as usize].result.is_some() {
            bail!("A finished battle cannot be continued");
        }
        self.world = world;
        self.clock = None;
        Ok(self.snapshot(true, false, None, None)?)
    }

    fn pacing(&self) -> Pacing {
        if self.world.rules.enhanced {
            Pacing::Enhanced
        } else {
            Pacing::Classic
        }
    }

    fn step(&mut self, n: u32) {
        for _ in 0..n {
            if self.demo_finished() || self.world.players[self.player as usize].result.is_some() {
                break;
            }
            self.world.step(&[]);
        }
    }

    fn send(&mut self, command: Command) {
        if self.world.players[self.player as usize].result.is_none() {
            let acknowledge = matches!(
                command,
                Command::RightClick { .. } | Command::Issue { .. } | Command::Move { .. }
            );
            self.world.turn(&[command]);
            if acknowledge && let Some(id) = self.world.first_selected(self.player) {
                self.world.acknowledge(id);
            }
        }
    }

    fn selection(&self) -> Vec<UnitId> {
        self.world.selection(self.player)
    }

    fn primary(&self) -> Result<UnitId> {
        self.world
            .first_selected(self.player)
            .filter(|&id| self.world.unit(id).is_some_and(|unit| unit.owner == self.player))
            .context("Select a unit you control first")
    }

    fn select(&mut self, ids: &[UnitId]) -> Result<()> {
        if ids.len() > WORKER_CAP {
            bail!("Only {WORKER_CAP} units can be selected");
        }
        let mut selected = Vec::new();
        for &id in ids {
            let Some(unit) = self.world.unit(id) else { continue };
            if self.selectable(unit) && (ids.len() == 1 || unit.owner == self.player) && !selected.contains(&id) {
                selected.push(id);
            }
        }
        self.send(Command::Select {
            player: self.player,
            units: self.world.slots_of(&selected),
        });
        if let Some(id) = self.world.first_selected(self.player) {
            self.world.select_sound(id);
        }
        Ok(())
    }

    fn selectable(&self, unit: &Unit) -> bool {
        unit.stays_selected() && (unit.owner == self.player || self.world.visible_to(self.player, unit.id))
    }

    fn hit(&self, x: f64, y: f64, radius: f64) -> Option<UnitId> {
        self.world
            .units
            .iter()
            .filter(|unit| self.selectable(unit))
            .filter_map(|unit| {
                let left = f64::from(unit.pos.0);
                let top = f64::from(unit.pos.1);
                let right = left + f64::from(i32::from(unit.size.0) * TILE);
                let bottom = top + f64::from(i32::from(unit.size.1) * TILE);
                let distance = (x - x.clamp(left, right)).hypot(y - y.clamp(top, bottom));
                let (cx, cy) = unit.centre_px();
                let centre = (x - f64::from(cx)).hypot(y - f64::from(cy));
                (distance <= radius).then_some((unit.id, distance, centre))
            })
            .min_by(|a, b| a.1.total_cmp(&b.1).then(a.2.total_cmp(&b.2)))
            .map(|p| p.0)
    }

    fn tile(&self, x: f64, y: f64) -> Result<(i32, i32)> {
        let tile = (
            (x / f64::from(TILE)).floor() as i32,
            (y / f64::from(TILE)).floor() as i32,
        );
        if !self.world.terrain.contains(tile.0, tile.1) {
            bail!("Destination is outside the map");
        }
        Ok(tile)
    }

    fn commands(&self) -> Commands<'_> {
        Commands::new(&self.world, self.player)
    }

    fn execute_panel(&mut self, op: &str, kind: Option<u8>) -> Result<()> {
        let command = self.commands().command(&self.text, op, kind)?;
        self.send(command);
        Ok(())
    }

    fn placement(&self, kind: u8, x: f64, y: f64) -> Result<Placement> {
        self.commands().placed(&self.text, kind)?;
        let unit = self.primary()?;
        let tile = self.tile(x, y)?;
        let site = self.world.site_at(kind, tile);
        let message = self.world.check_site(kind, site, unit).message();
        let (width, height) = self.world.stats.0[kind as usize].size;
        Ok(Placement {
            x: site.0,
            y: site.1,
            width,
            height,
            valid: message.is_none(),
            message,
            reason: message.map(|entry| self.text.message(entry)),
            blocked: self.world.bad_site_tiles(kind, site, unit),
        })
    }

    fn snapshot(
        &mut self,
        full: bool,
        hash: bool,
        placement: Option<Placement>,
        campaigns: Option<Vec<Campaign>>,
    ) -> Result<Vec<u8>> {
        let cycle_ms = self.clock.as_ref().map_or_else(
            || Scheduler::new(self.pacing(), self.world.speed, 0).cycle_ms(),
            Scheduler::cycle_ms,
        );
        let demo = self.demo.map(|id| DemoView {
            id,
            finished: self.demo_finished(),
        });
        let actions = if demo.is_some() {
            Vec::new()
        } else {
            self.commands().actions(&self.text)
        };
        let world = &mut self.world;
        let player = &world.players[self.player as usize];
        let outcome = demo.is_none().then_some(player.result).flatten();
        let score_rows = if outcome.is_some() {
            results::rows(world, self.player, &self.start_controllers, self.mission.is_expansion())
                .into_iter()
                .map(|row| ScoreRow {
                    slot: row.slot,
                    color: world.players[usize::from(row.slot)].colour,
                    name_entry: row.name,
                    label: row.label,
                    values: row.stats.values(),
                })
                .collect()
        } else {
            Vec::new()
        };
        let explored = world.vision.flags(Map::Explored);
        let visible = world.vision.flags(Map::Visible);
        let send_explored = full || explored != self.sent_explored;
        let send_visible = full || visible != self.sent_visible;
        if send_explored {
            self.sent_explored = explored.to_vec();
        }
        if send_visible {
            self.sent_visible = visible.to_vec();
        }
        let redraw = std::mem::take(&mut world.terrain.redraw);
        let mut terrain_changes: Vec<_> = redraw
            .into_iter()
            .filter_map(|(x, y)| world.terrain.tile(x, y).map(|tile| (x, y, tile)))
            .collect();
        terrain_changes.sort_unstable();
        terrain_changes.dedup();

        let events = std::mem::take(&mut world.events)
            .into_iter()
            .filter_map(|event| event_view(event, self.player))
            .collect();
        let sounds = std::mem::take(&mut world.sounds.cues)
            .into_iter()
            .filter_map(sound_view)
            .collect();

        let snapshot = Snapshot {
            tick: world.tick,
            player: self.player,
            player_colour: player.colour,
            race: player.race,
            width: world.terrain.width,
            height: world.terrain.height,
            tile_size: TILE,
            resources: Resources {
                gold: player.gold,
                lumber: player.lumber,
                oil: player.oil,
                food_used: world.food_used(self.player),
                food_supply: world.food_supply(self.player),
            },
            units: world
                .units
                .iter()
                .filter(|unit| {
                    !unit.inside
                        && !unit.removing
                        && (demo.is_some() || unit.owner == self.player || world.visible_to(self.player, unit.id))
                })
                .map(|unit| unit_view(world, unit, &self.text, &self.speeds))
                .collect(),
            selection: world.selection(self.player).into_iter().map(|id| id.0).collect(),
            fog: world.rules.fog_of_war,
            speed: world.speed,
            cycle_ms,
            outcome: outcome.map(outcome_name),
            next_mission: self.mission.next,
            campaigns,
            scenario: self.scenario.as_ref().map(|scenario| &scenario.meta),
            demo,
            score: Score {
                kills: player.kills,
                razings: player.razings,
                units_lost: player.units_lost,
                buildings_lost: player.buildings_lost,
                gathered: player.gathered,
                score: player.score,
                mission_score: outcome.map(|o| {
                    player.score.saturating_add(if o == Outcome::Victory {
                        results::VICTORY_BONUS
                    } else {
                        0
                    })
                }),
                rows: score_rows,
            },
            actions,
            mission: full.then_some(&self.mission),
            hash: (full || hash).then(|| format!("{:016x}", world.state_hash())),
            terrain: full.then_some(&world.terrain.tiles),
            terrain_regions: full.then_some(&world.terrain.regions),
            terrain_changes,
            explored: send_explored.then_some(&self.sent_explored),
            visible: send_visible.then_some(&self.sent_visible),
            placement,
            events,
            sounds,
        };
        Ok(serde_json::to_vec(&snapshot)?)
    }
}

fn unit_view<'a>(world: &World, unit: &Unit, text: &'a Text, speeds: &[u8]) -> UnitView<'a> {
    let stats = &world.stats.0[unit.kind as usize];
    let (minimum, maximum) = tidewater_command_panel::stats::damage(stats.basic_damage, stats.piercing_damage);
    let facing = unit.facing & 7;
    let mirrored = !unit.building && facing > 4;
    let offset = if unit.building { 0 } else { facing.min(8 - facing) };
    let construction = unit.construction.is_some();
    let frame = if unit.building && construction {
        1
    } else {
        unit.script.frame
    };
    UnitView {
        id: unit.id.0,
        owner: unit.owner,
        colour: world.players[unit.colour as usize].colour,
        kind: unit.kind,
        picture: unit.picture(),
        name: text.unit_name(unit.kind),
        name_entry: tidewater_command_panel::unit_name_entry(unit.kind),
        x: unit.pos.0,
        y: unit.pos.1,
        tile_x: unit.tile.0,
        tile_y: unit.tile.1,
        width: i32::from(unit.size.0) * TILE,
        height: i32::from(unit.size.1) * TILE,
        hp: unit.hp,
        max_hp: stats.hit_points,
        building: unit.building,
        rect_selectable: stats.rect_selectable,
        construction,
        progress: (construction || unit.job.is_some()).then_some(unit.mana),
        job: unit.job.map(|job| job.kind),
        facing,
        frame: u16::from(frame) + u16::from(offset),
        mirrored,
        sprite: format!("unit-{}-{}.png", unit.picture(), unit.owner),
        minimap: world.on_minimap(unit),
        dying: unit.dying,
        order: order_name(unit),
        armor: stats.armor,
        damage: [stats.basic_damage, stats.piercing_damage],
        damage_range: [minimum, maximum],
        display_speed: speeds.get(usize::from(unit.kind)).copied().unwrap_or(0),
        sight: stats.sight,
        range: stats.attack_range,
        resources: unit.resources,
        resources_amount: matches!(unit.kind, 86 | 87 | 92 | 93).then_some(unit.resources * 100),
    }
}

fn order_name(unit: &Unit) -> &'static str {
    match unit.order {
        Order::Build { .. } | Order::InsideSite { .. } => "building",
        Order::Harvest { .. } | Order::ReturnGoods { .. } | Order::Enter { .. } | Order::Inside { .. } => "harvesting",
        Order::Attack { .. } | Order::AttackMove { .. } | Order::Chase { .. } | Order::AttackInPlace { .. } => {
            "attacking"
        }
        Order::Patrol { .. } => "patrolling",
        Order::StandGround => "holding",
        Order::Repair { .. } => "repairing",
        _ if unit.construction.is_some() => "building",
        _ if unit.job.is_some() => "working",
        _ if unit.is_moving() => "moving",
        _ => "idle",
    }
}

fn outcome_name(outcome: Outcome) -> &'static str {
    match outcome {
        Outcome::Victory => "victory",
        Outcome::Defeat => "defeat",
        Outcome::GameEnded => "ended",
    }
}

fn event_view(event: Event, local: u8) -> Option<String> {
    match event {
        Event::CantAfford { player, shortage } | Event::CantRepair { player, shortage } if player == local => {
            Some(format!("Not enough {}", format!("{shortage:?}").to_lowercase()))
        }
        Event::NoRoom { player, .. } if player == local => Some("No room for the unit".to_owned()),
        Event::CantPlace { player, .. } if player == local => Some("Can't build there".to_owned()),
        Event::TooManyUnits { player } if player == local => Some("Too many units".to_owned()),
        Event::ResearchDone { player, .. } if player == local => Some("Research complete".to_owned()),
        _ => None,
    }
}

fn sound_view(Cue { sound, place }: Cue) -> Option<SoundView> {
    if matches!(
        place,
        Some(Place::Unit { inside: true, .. } | Place::Unit { hidden: true, .. } | Place::Tile { unseen: true, .. })
    ) {
        return None;
    }
    let (cue, kind) = match sound {
        Sound::Select { kind, pick, .. } => (
            match pick {
                Pick::Burning => "burning",
                Pick::Constructing => "constructing",
                Pick::Building { .. } => "buildingSelect",
                Pick::Annoyed(_) => "annoyed",
                _ => "select",
            },
            Some(kind),
        ),
        Sound::Acknowledge { kind } => ("acknowledge", Some(kind)),
        Sound::Ready { kind } => ("ready", Some(kind)),
        Sound::WorkComplete { peasant } => ("workComplete", peasant.then_some(PEASANT)),
        Sound::Help { building } => (if building { "buildingHelp" } else { "help" }, None),
        Sound::Attack { kind, .. } | Sound::TowerFire { kind } => ("attack", Some(kind)),
        Sound::Chop { .. } => ("chop", None),
        Sound::Death { kind, .. } => ("death", Some(kind)),
        Sound::BuildingDeath | Sound::Explode | Sound::CritterExplode => ("explode", None),
        Sound::Impact { kind, .. } => ("impact", Some(kind)),
        Sound::Construction => ("construction", None),
        Sound::Dock => ("dock", None),
        Sound::Rescue | Sound::Capture => ("rescue", None),
        Sound::Spell(kind) => ("spell", Some(kind)),
        Sound::AttackPending { .. } | Sound::ChopPending { .. } => return None,
    };
    Some(SoundView {
        cue,
        kind,
        tile: place.map(|position| position.tile()),
    })
}
