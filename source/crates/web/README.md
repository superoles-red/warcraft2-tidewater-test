# Warcraft II campaigns and Quick Battle in the browser

Build and verify from the Tidewater workspace folder with Rust 1.97.1 and the
`wasm32-unknown-unknown` target installed.

```sh
cargo build --locked -p tidewater-web --release --target wasm32-unknown-unknown
cargo build --locked -p tidewater-web --release --example trace
node crates/web/tests/parity.mjs "/path/to/Warcraft II" \
  target/wasm32-unknown-unknown/release/tidewater_web.wasm \
  target/release/examples/trace
```

The test folder for Warcraft II supplies its own `War2Dat.mpq` and
`War2Patch.mpq`. The crate does not contain game data. The parity test
completes Hillsbrad using normal commands, starts and restarts all 52
missions, and compares native and WebAssembly responses and game-state hashes.

Copy `engine.js` and the release `tidewater_web.wasm` into the browser pilot.
Load site-local game archives as byte arrays and pass them to
`await createTidewater(war2Dat, war2Patch)`. The returned function accepts
requests such as `{op: 'snapshot'}`. Read the four campaign lists with
`{op: 'campaigns'}`, then load an entry by ID with `{op: 'loadMission', id}`.
`restart` resets the current mission. A win uses `nextMission` to identify the
next entry in the same campaign. The browser persists unlocked missions.

Start Quick Battle with `{op: 'loadScenario', id, title, pud, options}`, with the
selected PUD as a byte array. The scenario ID and title are used for display and
session metadata. The engine reads geography, objects, and stored settings
directly from the map. `options` can specify `race`, `opponents`, `resources`,
`terrain`, `oneWorker`, `fixedStarts`, `fog` and a reproducible `seed`.
Restart reuses the same map, settings and seed; invalid inputs leave the
current campaign or scenario running.

```sh
node crates/web/tests/quick-battle.mjs "/path/to/Warcraft II" \
  target/wasm32-unknown-unknown/release/tidewater_web.wasm \
  target/release/examples/trace
```

For the packaged map list, pass its `scenarios/catalog.json` as the fourth
argument. The test compares map setup, early simulation and restart on native
and WebAssembly hosts. The browser's Continue slot uses `{op: 'saveCheckpoint'}` to obtain the current
battle's binary bytes. On launch, open the same campaign mission or scenario
and pass these bytes using `{op: 'restoreCheckpoint', checkpoint}`. The
checkpoint records the army, orders, resources, construction, and map state.
The native load rules clear the selection and reset simulation timers.

The format is capped at 4 MiB and binds the checkpoint to the original map,
options, and simulation tables. Bump its magic version if the native
world-save encoding changes incompatibly. The browser owns persistence and
must not offer Continue after battle completion.

```sh
node crates/web/tests/checkpoint.mjs "/path/to/Warcraft II" \
  target/wasm32-unknown-unknown/release/tidewater_web.wasm \
  target/release/examples/trace
```

Use the `frame` request and a browser
monotonic timestamp for normal pacing, or `step` with a cycle count for
deterministic checks. Call `resetClock` after a pause in frame delivery.

Positions in requests and unit positions use world pixels. Terrain changes,
placement boxes, audio cue locations and the opening view use tile coordinates.
A full snapshot supplies mission metadata, the terrain grid, both vision maps
and a state hash. Normal responses carry the current units, selection,
resources, legal actions and any changed vision or terrain. Explicit hashes
are available through `{op: 'hash'}`. Events and sound cues are consumed when
read.

All missions use the original campaign technology allowances and the same
command-panel rules as the desktop game.

The read-only attract mode uses `{op: 'loadDemo', id, seed}` (IDs 1–4) to run the
original installed demo maps with the Classic scheduler and both computer sides.
Steps report `demo.finished` at the end of playback. Demo state cannot overwrite
the browser's battle checkpoint. Winning and losing return the original score
rows and mission score, including the victory bonus.
