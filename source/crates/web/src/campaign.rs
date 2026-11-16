use anyhow::{Context, Result};
use serde::Serialize;
use tidewater_formats::{
    identity::{FNV_BASIS, fnv_extend},
    install::Install,
    pud::{Era, Pud},
    tbl::StringTable,
};
use tidewater_sim::{
    World,
    setup::{Setup, Start},
    victory::mission_entry,
};

pub const FIRST: u8 = 0;

#[derive(Clone, Copy)]
struct Episode {
    id: &'static str,
    folder: &'static str,
    stem: &'static str,
    race: u8,
    expansion: bool,
    count: u8,
}

const EPISODES: [Episode; 4] = [
    Episode {
        id: "human",
        folder: "Human",
        stem: "Human",
        race: 0,
        expansion: false,
        count: 14,
    },
    Episode {
        id: "orc",
        folder: "Orc",
        stem: "Orc",
        race: 1,
        expansion: false,
        count: 14,
    },
    Episode {
        id: "xhuman",
        folder: "XHuman",
        stem: "2XHum",
        race: 0,
        expansion: true,
        count: 12,
    },
    Episode {
        id: "xorc",
        folder: "XOrc",
        stem: "2XOrc",
        race: 1,
        expansion: true,
        count: 12,
    },
];

impl Episode {
    fn entry(self, number: u8) -> u8 {
        mission_entry(self.expansion, self.race == 1, number)
    }

    fn path(self, number: u8) -> String {
        format!("Campaign\\{}\\{}{:02}.pud", self.folder, self.stem, number)
    }

    fn locate(id: u8) -> Option<(Self, u8)> {
        let episode = EPISODES[usize::from(id % 2) + if id >= 28 { 2 } else { 0 }];
        let number = (id % 28) / 2 + 1;
        (number <= episode.count && episode.entry(number) == id).then_some((episode, number))
    }
}

#[derive(Serialize)]
pub struct Campaign {
    id: &'static str,
    race: u8,
    expansion: bool,
    missions: Vec<Preview>,
}

#[derive(Serialize)]
struct Preview {
    id: u8,
    number: u8,
    title: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mission {
    pub id: Option<u8>,
    campaign: &'static str,
    number: Option<u8>,
    path: String,
    title: String,
    story: String,
    objectives: Vec<String>,
    /// The top-left tile of the opening camera view.
    start: [i32; 2],
    era: Era,
    #[serde(skip)]
    pub next: Option<u8>,
    #[serde(skip)]
    pub map_hash: u64,
}

impl Mission {
    pub fn demo(path: String, view: (i32, i32), era: Era, map_hash: u64) -> Self {
        Self {
            id: None,
            campaign: "demo",
            number: None,
            path,
            title: "Demo".to_string(),
            story: String::new(),
            objectives: Vec::new(),
            start: [view.0, view.1],
            era,
            next: None,
            map_hash,
        }
    }

    pub fn is_expansion(&self) -> bool {
        matches!(self.campaign, "xhuman" | "xorc")
    }

    pub fn quick(
        path: String,
        title: String,
        story: String,
        objectives: Vec<String>,
        view: (i32, i32),
        era: Era,
        map_hash: u64,
    ) -> Self {
        Self {
            id: None,
            campaign: "quick",
            number: None,
            path,
            title,
            story,
            objectives,
            start: [view.0, view.1],
            era,
            next: None,
            map_hash,
        }
    }
}

fn read_table(install: &mut Install, path: &str) -> Result<StringTable> {
    StringTable::parse(&install.read(path).with_context(|| format!("Reading {path}"))?)
        .with_context(|| format!("Decoding {path}"))
}

/// Original English tables are ASCII. Localized Russian table overlays use Windows-1251.
pub fn decode(bytes: &[u8]) -> String {
    const HIGH: &str = "ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—�™љ›њќћџ ЎўЈ¤Ґ¦§Ё©Є«¬­®Ї°±Ііґµ¶·ё№є»јЅѕї";
    bytes
        .iter()
        .map(|&byte| match byte {
            0..=127 => char::from(byte),
            128..=191 => HIGH.chars().nth(usize::from(byte - 128)).unwrap_or('�'),
            _ => char::from_u32(0x410 + u32::from(byte - 192)).unwrap_or('�'),
        })
        .collect()
}

fn text(table: &StringTable, index: usize) -> Result<String> {
    let entry = table
        .0
        .get(index)
        .with_context(|| format!("Missing text entry {}", index + 1))?;
    Ok(decode(entry)
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\r' | '\n' | '\t'))
        .collect())
}

pub struct Catalog(StringTable);

impl Catalog {
    pub fn new(install: &mut Install) -> Result<Self> {
        Ok(Self(read_table(install, "rez\\objctivs.tbl")?))
    }

    pub fn campaigns(&self) -> Result<Vec<Campaign>> {
        EPISODES
            .into_iter()
            .map(|episode| {
                let missions = (1..=episode.count)
                    .map(|number| {
                        let id = episode.entry(number);
                        Ok(Preview {
                            id,
                            number,
                            title: text(&self.0, usize::from(id) + 59)?,
                        })
                    })
                    .collect::<Result<_>>()?;
                Ok(Campaign {
                    id: episode.id,
                    race: episode.race,
                    expansion: episode.expansion,
                    missions,
                })
            })
            .collect()
    }

    fn objectives(&self, entry: usize) -> Result<Vec<String>> {
        Ok(text(&self.0, entry)?
            .lines()
            .map(|line| line.trim().trim_start_matches('-').trim())
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect())
    }

    pub fn quick_objectives(&self) -> Result<Vec<String>> {
        self.objectives(58)
    }

    pub fn start(&self, install: &mut Install, id: u8) -> Result<(World, u8, Mission)> {
        let (episode, number) = Episode::locate(id).context("Unknown campaign mission")?;
        let path = episode.path(number);
        let bytes = install.read(&path).with_context(|| format!("Reading {path}"))?;
        let map = Pud::parse(&bytes)?;
        let map_hash = fnv_extend(fnv_extend(FNV_BASIS, path.as_bytes()), &bytes);
        let start = Start::choose(&map, &Setup::for_map(&path), 0)?;
        let (mut world, _) = tidewater_replay::start::build_world(install, &map, &start)?;
        world.start_up();

        let story_path = format!("rez\\{}{number}.tbl", episode.stem.to_ascii_lowercase());
        let story = text(&read_table(install, &story_path)?, 0)?;
        let title = text(&self.0, usize::from(id) + 59)?;
        let objectives = self.objectives(usize::from(id))?;
        let (x, y) = world.start.view;
        let mission = Mission {
            id: Some(id),
            campaign: episode.id,
            number: Some(number),
            path,
            title,
            story,
            objectives,
            start: [x, y],
            era: start.era,
            next: (number < episode.count).then(|| episode.entry(number + 1)),
            map_hash,
        };
        Ok((world, start.local, mission))
    }
}
