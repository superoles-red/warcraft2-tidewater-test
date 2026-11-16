//! A compact browser save envelope around the native world's save format.

use anyhow::{Result, bail};
use tidewater_formats::identity::{FNV_BASIS, fnv_extend};
use tidewater_sim::World;

const MAGIC: &[u8; 4] = b"TWC1";
const HEADER_BYTES: usize = 4 + 3 * 8 + 4;
const CHECKSUM_BYTES: usize = 8;
const MAX_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy)]
pub struct Origin {
    pub data: u64,
    pub map: u64,
    pub start: u64,
}

impl Origin {
    fn write(self, buffer: &mut Vec<u8>) {
        buffer.extend_from_slice(MAGIC);
        buffer.extend_from_slice(&self.data.to_le_bytes());
        buffer.extend_from_slice(&self.map.to_le_bytes());
        buffer.extend_from_slice(&self.start.to_le_bytes());
    }
}

pub fn save(origin: Origin, world: &World) -> Result<Vec<u8>> {
    let state = world.save_state();
    let bytes = HEADER_BYTES + state.len() + CHECKSUM_BYTES;
    if bytes > MAX_BYTES {
        bail!("This game exceeds the maximum checkpoint size");
    }
    let mut checkpoint = Vec::with_capacity(bytes);
    origin.write(&mut checkpoint);
    checkpoint.extend_from_slice(&world.rng.state.to_le_bytes());
    checkpoint.extend_from_slice(&state);
    let checksum = fnv_extend(FNV_BASIS, &checkpoint);
    checkpoint.extend_from_slice(&checksum.to_le_bytes());
    Ok(checkpoint)
}

pub fn read(origin: Origin, data: &[u8]) -> Result<(u32, &[u8])> {
    if !(HEADER_BYTES + CHECKSUM_BYTES + 1..=MAX_BYTES).contains(&data.len()) || !data.starts_with(MAGIC) {
        bail!("Unsupported or incomplete Warcraft II checkpoint");
    }
    let (content, footer) = data.split_at(data.len() - CHECKSUM_BYTES);
    if fnv_extend(FNV_BASIS, content).to_le_bytes() != footer {
        bail!("The Warcraft II checkpoint is damaged");
    }
    let mut actual = Vec::with_capacity(HEADER_BYTES);
    origin.write(&mut actual);
    if !content.starts_with(&actual) {
        bail!("Load the original mission or scenario before restoring its checkpoint");
    }
    let seed = u32::from_le_bytes(content[actual.len()..HEADER_BYTES].try_into()?);
    Ok((seed, &content[HEADER_BYTES..]))
}
