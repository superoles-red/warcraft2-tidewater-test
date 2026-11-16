# Human01 in the browser

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
completes Hillsbrad using normal commands and compares native and WebAssembly
responses at every step, including their game-state hashes.

Copy `engine.js` and the release `tidewater_web.wasm` into the browser pilot.
Load site-local game archives as byte arrays and pass them to
`await createTidewater(war2Dat, war2Patch)`. The returned function accepts
requests such as `{op: 'snapshot'}`. Use the `frame` request and a browser
monotonic timestamp for normal pacing, or `step` with a cycle count for
deterministic checks. Call `resetClock` after a pause in frame delivery.

Positions in requests and unit positions use world pixels. Terrain changes,
placement boxes, audio cue locations and the opening view use tile coordinates.
A full snapshot supplies mission metadata, the terrain grid, both vision maps
and a state hash. Normal responses carry the current units, selection,
resources, legal actions and any changed vision or terrain. Explicit hashes
are available through `{op: 'hash'}`. Events and sound cues are consumed when
read.

Hillsbrad uses the original campaign's technology allowances. Commands for
buildings or jobs outside those allowances are rejected.
