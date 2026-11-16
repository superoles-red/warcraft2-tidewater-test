//! Run the browser engine's request protocol natively for cross-target comparisons.

use anyhow::{Context, Result};
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use tidewater_web::Engine;

fn main() -> Result<()> {
    let root = PathBuf::from(std::env::args_os().nth(1).context("Usage: trace GAME-DIRECTORY")?);
    let mut engine = Engine::open(
        std::fs::read(root.join("War2Dat.mpq"))?,
        std::fs::read(root.join("War2Patch.mpq"))?,
    )?;
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout());
    for command in stdin.lock().split(b'\n') {
        let command = command?;
        if !command.is_empty() {
            let response = engine.request(&command)?;
            stdout.write_all(&response)?;
            stdout.write_all(b"\n")?;
        }
    }
    stdout.flush()?;
    Ok(())
}
