//! Run the browser engine's request protocol natively for cross-target comparisons.

use anyhow::{Context, Result};
use serde_json::Value;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use tidewater_web::Engine;

fn main() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let root = PathBuf::from(args.next().context("Usage: trace GAME-DIRECTORY [--fingerprints]")?);
    let fingerprints = args.next().is_some_and(|value| value == "--fingerprints");
    let mut engine = Engine::open(
        std::fs::read(root.join("War2Dat.mpq"))?,
        std::fs::read(root.join("War2Patch.mpq"))?,
    )?;
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout());
    for command in stdin.lock().split(b'\n') {
        let command = command?;
        if !command.is_empty() {
            let request: Value = serde_json::from_slice(&command)?;
            let response = match request["op"].as_str() {
                Some("loadScenario") => {
                    let path = request["pudFile"].as_str().context("Missing PUD fixture path")?;
                    engine.load_scenario(&command, &std::fs::read(path)?)?
                }
                Some("saveCheckpoint") => serde_json::to_vec(&engine.save_checkpoint()?)?,
                Some("restoreCheckpoint") => {
                    let data: Vec<u8> = serde_json::from_value(request["checkpoint"].clone())?;
                    engine.restore_checkpoint(&data)?
                }
                _ => engine.request(&command)?,
            };
            if fingerprints {
                let frame: Value = serde_json::from_slice(&response)?;
                let keys = [
                    "tick",
                    "hash",
                    "width",
                    "height",
                    "player",
                    "race",
                    "resources",
                    "fog",
                    "mission",
                    "scenario",
                    "nextMission",
                    "outcome",
                ];
                let selected: serde_json::Map<_, _> = keys
                    .into_iter()
                    .filter_map(|key| frame.get(key).map(|value| (key.to_string(), value.clone())))
                    .collect();
                serde_json::to_writer(&mut stdout, &selected)?;
            } else {
                stdout.write_all(&response)?;
            }
            stdout.write_all(b"\n")?;
        }
    }
    stdout.flush()?;
    Ok(())
}
