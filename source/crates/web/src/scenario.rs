//! A custom game uses the same map parser, setup, and simulation as the desktop.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tidewater_formats::{
    identity::{FNV_BASIS, fnv_extend},
    install::Install,
    pud::{Era, Pud},
};
use tidewater_sim::{
    Rng, World,
    setup::{Custom, Game, Resources, Setup, Start, TerrainChoice, race},
};

use crate::campaign::{Catalog, Mission};

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Race {
    #[default]
    MapDefault,
    Human,
    Orc,
    Random,
}

impl Race {
    fn choose(self, seed: u32) -> Option<u8> {
        match self {
            Self::MapDefault => None,
            Self::Human => Some(race::HUMAN),
            Self::Orc => Some(race::ORC),
            // Choose the explicit race from the scenario seed, independently of the in-game draws.
            Self::Random => Some(Rng::new(seed ^ 0x7291_9b31).ranged(0, 1) as u8),
        }
    }
}

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum ResourcesChoice {
    #[default]
    MapDefault,
    Low,
    Medium,
    High,
    Random,
}

impl From<ResourcesChoice> for Resources {
    fn from(choice: ResourcesChoice) -> Self {
        match choice {
            ResourcesChoice::MapDefault => Self::MapDefault,
            ResourcesChoice::Low => Self::Low,
            ResourcesChoice::Medium => Self::Medium,
            ResourcesChoice::High => Self::High,
            ResourcesChoice::Random => Self::Random,
        }
    }
}

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Terrain {
    #[default]
    MapDefault,
    Forest,
    Winter,
    Wasteland,
    Swamp,
    Random,
}

impl From<Terrain> for TerrainChoice {
    fn from(terrain: Terrain) -> Self {
        match terrain {
            Terrain::MapDefault => Self::MapDefault,
            Terrain::Forest => Self::Set(Era::Forest),
            Terrain::Winter => Self::Set(Era::Winter),
            Terrain::Wasteland => Self::Set(Era::Wasteland),
            Terrain::Swamp => Self::Set(Era::Swamp),
            Terrain::Random => Self::Random,
        }
    }
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    race: Race,
    opponents: Option<u8>,
    resources: ResourcesChoice,
    terrain: Terrain,
    one_worker: bool,
    fixed_starts: bool,
    fog: bool,
    seed: u32,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            race: Race::default(),
            opponents: None,
            resources: ResourcesChoice::default(),
            terrain: Terrain::default(),
            one_worker: false,
            fixed_starts: false,
            fog: true,
            seed: 0,
        }
    }
}

impl Options {
    fn setup(self) -> Result<Setup> {
        if self.opponents.is_some_and(|n| !(1..=7).contains(&n)) {
            bail!("The number of opponents must be from 1 to 7");
        }
        Ok(Setup {
            game: Game::Custom(Custom {
                race: self.race.choose(self.seed),
                opponents: self.opponents,
                resources: self.resources.into(),
                terrain: self.terrain.into(),
                one_worker: self.one_worker,
                fixed_starts: self.fixed_starts,
                fog_of_war: self.fog,
            }),
            ..Setup::default()
        })
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    id: String,
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    options: Options,
    #[serde(default)]
    seed: u32,
}

pub struct Scenario {
    pub meta: Metadata,
    map: Pud,
    setup: Setup,
    map_hash: u64,
}

impl Scenario {
    pub fn new(header: &[u8], data: &[u8]) -> Result<Self> {
        if header.len() > 8192 || data.len() > 1024 * 1024 {
            bail!("The scenario or its metadata is too large");
        }
        let mut meta: Metadata = serde_json::from_slice(header).context("Invalid scenario metadata")?;
        if meta.id.trim().is_empty() || meta.title.trim().is_empty() {
            bail!("The scenario ID and title are required");
        }
        let map = Pud::parse(data).context("Invalid Warcraft II map")?;
        if meta.description.is_empty() {
            meta.description = map.description();
        }
        meta.seed = meta.options.seed;
        let setup = meta.options.setup()?;
        let map_hash = fnv_extend(
            fnv_extend(
                fnv_extend(FNV_BASIS, meta.id.as_bytes()),
                &serde_json::to_vec(&meta.options)?,
            ),
            data,
        );
        Ok(Self {
            meta,
            map,
            setup,
            map_hash,
        })
    }

    pub fn start(&self, install: &mut Install, catalog: &Catalog) -> Result<(World, u8, Mission)> {
        let start = Start::choose(&self.map, &self.setup, self.meta.seed)?;
        let (mut world, _) = tidewater_replay::start::build_world(install, &self.map, &start)?;
        world.start_up();

        let mission = Mission::quick(
            self.meta.id.clone(),
            self.meta.title.clone(),
            self.meta.description.clone(),
            catalog.quick_objectives()?,
            world.start.view,
            start.era,
            self.map_hash,
        );
        Ok((world, start.local, mission))
    }
}
