//! Browser host for the first Warcraft II human campaign mission.

#![deny(unsafe_code)]

use std::io::Cursor;
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tidewater_formats::{
    install::{Files, Install},
    mpq::ReadSeek,
    pud::Pud,
    tbl::StringTable,
};
use tidewater_sim::economy::{Event, JobKind};
use tidewater_sim::setup::{Setup, Start, campaign_entry};
use tidewater_sim::sound::{Cue, Pick, Place, Sound};
use tidewater_sim::timing::{Pacing, Scheduler};
use tidewater_sim::victory::Outcome;
use tidewater_sim::vision::Map;
use tidewater_sim::{Command, Order, Unit, UnitId, World};

const MAP_NAME: &str = "Campaign\\Human\\Human01.pud";
const TILE: i32 = tidewater_sim::TILE_PX;
const PEASANT: u8 = 2;
const FOOTMAN: u8 = 0;
const FARM: u8 = 58;
const BARRACKS: u8 = 60;
const HALL: u8 = 74;
const WORKER_CAP: usize = 9;

#[cfg(target_arch = "wasm32")]
mod abi;

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

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum TargetAction {
    Move,
    Attack,
    Patrol,
    Harvest,
    Repair,
    AttackGround,
    Demolish,
    Unload,
}

impl TargetAction {
    fn command(self) -> u8 {
        match self {
            Self::Move => 3,
            Self::Patrol => 5,
            Self::Attack => 8,
            Self::AttackGround => 17,
            Self::Demolish => 19,
            Self::Harvest => 23,
            Self::Repair => 27,
            Self::Unload => 29,
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Request {
    Snapshot,
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
        action: TargetAction,
        x: f64,
        y: f64,
    },
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
#[serde(rename_all = "camelCase")]
struct Mission {
    path: &'static str,
    title: String,
    objectives: Vec<String>,
    // The top-left tile of the opening camera view.
    start: [i32; 2],
    era: tidewater_formats::pud::Era,
}

#[derive(Serialize)]
struct Placement {
    x: i32,
    y: i32,
    width: u16,
    height: u16,
    valid: bool,
    message: Option<u16>,
    blocked: Vec<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UnitView {
    id: u32,
    owner: u8,
    colour: u8,
    kind: u8,
    picture: u8,
    x: i32,
    y: i32,
    tile_x: i32,
    tile_y: i32,
    width: i32,
    height: i32,
    hp: u16,
    max_hp: u16,
    building: bool,
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
    sight: u32,
    range: u8,
    resources: u32,
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

#[derive(Clone, Copy, Serialize)]
struct Action {
    op: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    action: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<u8>,
    label: &'static str,
    icon: u16,
    slot: u8,
    cost: [u32; 3],
    enabled: bool,
}

impl Action {
    fn plain(op: &'static str, label: &'static str, icon: u16, slot: u8) -> Self {
        Self {
            op,
            action: None,
            kind: None,
            label,
            icon,
            slot,
            cost: [0; 3],
            enabled: true,
        }
    }

    fn target(action: &'static str, label: &'static str, icon: u16, slot: u8) -> Self {
        Self {
            action: Some(action),
            ..Self::plain("target", label, icon, slot)
        }
    }
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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot<'a> {
    tick: u32,
    player: u8,
    race: u8,
    width: u16,
    height: u16,
    tile_size: i32,
    resources: Resources,
    units: Vec<UnitView>,
    selection: Vec<u32>,
    actions: Vec<Action>,
    fog: bool,
    speed: u8,
    cycle_ms: u32,
    outcome: Option<&'static str>,
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
    world: World,
    player: u8,
    mission: Mission,
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
        let (world, player, mission) = start_mission(&mut install)?;
        Ok(Self {
            install,
            world,
            player,
            mission,
            clock: None,
            sent_explored: Vec::new(),
            sent_visible: Vec::new(),
        })
    }

    /// Decode one browser request and return a compact, JSON-encoded state update.
    pub fn request(&mut self, request: &[u8]) -> Result<Vec<u8>> {
        let request: Request = serde_json::from_slice(request)?;
        let mut full = false;
        let mut hash = false;
        let mut placement = None;
        let player = self.player;
        match request {
            Request::Snapshot => full = true,
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
                (self.world, self.player, self.mission) = start_mission(&mut self.install)?;
                self.clock = None;
                full = true;
            }
            Request::SelectIds { ids } => self.select(&ids.into_iter().map(UnitId).collect::<Vec<_>>())?,
            Request::Select { x, y, radius } => {
                let hit = self.hit(x, y, radius.clamp(0.0, 24.0), true);
                self.select(hit.as_slice())?;
            }
            Request::Move { x, y } => {
                let to = self.tile(x, y)?;
                let units = self
                    .selection()
                    .into_iter()
                    .filter(|&id| self.world.unit(id).is_some_and(|unit| self.world.is_mobile(unit)))
                    .collect();
                self.send(Command::Move { player, units, to });
            }
            Request::Smart { x, y } => {
                let tile = self.tile(x, y)?;
                let target = self.hit(x, y, 0.0, false);
                self.send(Command::RightClick { player, target, tile });
            }
            Request::Target { action, x, y } => {
                let tile = self.tile(x, y)?;
                let target = if matches!(action, TargetAction::AttackGround) {
                    None
                } else {
                    self.hit(x, y, 0.0, false)
                };
                if !matches!(action, TargetAction::Repair) || target.is_some() {
                    self.send(Command::Issue {
                        player,
                        command: action.command(),
                        target,
                        tile,
                    });
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
            Request::Train { kind } => {
                self.require_action("train", Some(kind))?;
                self.send(Command::Train {
                    player,
                    building: self.primary()?,
                    kind,
                });
            }
            Request::Upgrade { kind } => {
                self.require_action("upgrade", Some(kind))?;
                self.send(Command::Upgrade {
                    player,
                    building: self.primary()?,
                    to: kind,
                });
            }
            Request::Research { kind } => {
                self.require_action("research", Some(kind))?;
                self.send(Command::Research {
                    player,
                    building: self.primary()?,
                    upgrade: kind,
                });
            }
            Request::Stop => self.send(Command::Issue {
                player,
                command: 2,
                target: None,
                tile: (0, 0),
            }),
            Request::Hold => self.send(Command::Issue {
                player,
                command: 13,
                target: None,
                tile: (0, 0),
            }),
            Request::ReturnGoods => self.send(Command::Issue {
                player,
                command: 24,
                target: None,
                tile: (0, 0),
            }),
            Request::Cancel => {
                self.require_action("cancel", None)?;
                let unit = self.primary()?;
                let command = if self.world.unit(unit).is_some_and(|u| u.construction.is_some()) {
                    Command::Cancel { player, unit }
                } else {
                    Command::CancelJob { player, unit }
                };
                self.send(command);
            }
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
        self.snapshot(full, hash, placement)
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
            if self.world.players[self.player as usize].result.is_some() {
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
        self.world.first_selected(self.player).context("Select a unit first")
    }

    fn select(&mut self, ids: &[UnitId]) -> Result<()> {
        if ids.len() > WORKER_CAP {
            bail!("Only {WORKER_CAP} units can be selected");
        }
        let mut selected = Vec::new();
        for &id in ids {
            let Some(unit) = self.world.unit(id) else { continue };
            if self.selectable(unit) && !selected.contains(&id) {
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
        unit.owner == self.player && unit.stays_selected() && !unit.inside
    }

    fn hit(&self, x: f64, y: f64, radius: f64, owned: bool) -> Option<UnitId> {
        self.world
            .units
            .iter()
            .filter(|unit| {
                if owned {
                    self.selectable(unit)
                } else {
                    unit.present() && !unit.dying && self.world.visible_to(self.player, unit.id)
                }
            })
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

    fn require_action(&self, op: &str, kind: Option<u8>) -> Result<()> {
        if !self
            .actions()
            .into_iter()
            .any(|action| action.op == op && action.kind == kind && action.enabled)
        {
            bail!("Action is unavailable");
        }
        Ok(())
    }

    fn placement(&self, kind: u8, x: f64, y: f64) -> Result<Placement> {
        self.require_action("build", Some(kind))?;
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
            blocked: self.world.bad_site_tiles(kind, site, unit),
        })
    }

    fn actions(&self) -> Vec<Action> {
        let selection = self.selection();
        let Some(unit) = selection.first().and_then(|&id| self.world.unit(id)) else {
            return Vec::new();
        };
        let player = &self.world.players[self.player as usize];
        let allowed = |bit: u8| player.units_allowed & (1 << bit) != 0;
        let priced = |op, kind, label, icon, slot, cost, food| Action {
            kind: Some(kind),
            cost,
            enabled: self.world.can_afford(self.player, cost, food).is_ok(),
            ..Action::plain(op, label, icon, slot)
        };
        let mut actions = Vec::with_capacity(9);
        if unit.building {
            if unit.construction.is_some() || unit.job.is_some() {
                actions.push(Action::plain(
                    "cancel",
                    if unit.construction.is_some() {
                        "Cancel construction"
                    } else {
                        "Cancel job"
                    },
                    91,
                    8,
                ));
                return actions;
            }
            for (kind, bit, label, icon) in [(PEASANT, 1, "Train Peasant", 0), (FOOTMAN, 0, "Train Footman", 2)] {
                if allowed(bit)
                    && tidewater_sim::tech::trains(unit.kind, kind)
                    && self.world.training_requirement_met(self.player, kind)
                {
                    actions.push(priced("train", kind, label, icon, 0, self.world.unit_cost(kind), true));
                }
            }
            return actions;
        }
        actions.extend([
            Action::target("move", "Move", 83, 0),
            Action::plain("stop", "Stop", 164, 1),
            Action::target("attack", "Attack", 116, 2),
        ]);
        if unit.kind == PEASANT {
            actions.push(Action::target("repair", "Repair", 85, 3));
            if unit.carrying {
                actions.push(Action::plain("returnGoods", "Return goods", 89, 5));
            } else {
                actions.push(Action::target("harvest", "Harvest", 86, 4));
            }
            if selection.len() == 1 {
                for (kind, bit, label, icon, slot) in [
                    (FARM, 16, "Build Farm", 38, 0),
                    (BARRACKS, 17, "Build Barracks", 42, 1),
                    (HALL, 26, "Build Town Hall", 40, 2),
                ] {
                    if allowed(bit) && (kind == HALL || player.had_hall) {
                        actions.push(priced(
                            "build",
                            kind,
                            label,
                            icon,
                            slot,
                            self.world.unit_cost(kind),
                            false,
                        ));
                    }
                }
            }
        } else {
            actions.push(Action::target("patrol", "Patrol", 178, 3));
            actions.push(Action::plain("hold", "Stand ground", 180, 4));
        }
        actions
    }

    fn snapshot(&mut self, full: bool, hash: bool, placement: Option<Placement>) -> Result<Vec<u8>> {
        let cycle_ms = self.clock.as_ref().map_or_else(
            || Scheduler::new(self.pacing(), self.world.speed, 0).cycle_ms(),
            Scheduler::cycle_ms,
        );
        let actions = self.actions();
        let world = &mut self.world;
        let player = &world.players[self.player as usize];
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
                        && (unit.owner == self.player || world.visible_to(self.player, unit.id))
                })
                .map(|unit| unit_view(world, unit))
                .collect(),
            selection: world.selection(self.player).into_iter().map(|id| id.0).collect(),
            fog: world.rules.fog_of_war,
            speed: world.speed,
            cycle_ms,
            outcome: player.result.map(outcome_name),
            score: Score {
                kills: player.kills,
                razings: player.razings,
                units_lost: player.units_lost,
                buildings_lost: player.buildings_lost,
                gathered: player.gathered,
                score: player.score,
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

fn start_mission(install: &mut Install) -> Result<(World, u8, Mission)> {
    let map = Pud::parse(&install.read(MAP_NAME)?)?;
    let start = Start::choose(&map, &Setup::for_map(MAP_NAME), 0)?;
    let (mut world, _) = tidewater_replay::start::build_world(install, &map, &start)?;
    world.start_up();

    let entry = usize::from(campaign_entry(MAP_NAME).context("Expected a campaign mission")?);
    let table = StringTable::parse(&install.read("rez\\objctivs.tbl")?)?;
    let title = table.text(entry + 59).context("Mission title is missing")?;
    let objectives = table
        .text(entry)
        .context("Mission objectives are missing")?
        .lines()
        .map(|line| line.trim().trim_start_matches('-').trim())
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect();
    let view = world.start.view;
    let mission = Mission {
        path: MAP_NAME,
        title,
        objectives,
        start: [view.0, view.1],
        era: start.era,
    };
    Ok((world, start.local, mission))
}

fn unit_view(world: &World, unit: &Unit) -> UnitView {
    let stats = &world.stats.0[unit.kind as usize];
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
        x: unit.pos.0,
        y: unit.pos.1,
        tile_x: unit.tile.0,
        tile_y: unit.tile.1,
        width: i32::from(unit.size.0) * TILE,
        height: i32::from(unit.size.1) * TILE,
        hp: unit.hp,
        max_hp: stats.hit_points,
        building: unit.building,
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
        sight: stats.sight,
        range: stats.attack_range,
        resources: unit.resources,
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
