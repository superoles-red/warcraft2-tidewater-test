# Tidewater engine source

The WebAssembly engine uses Tidewater's formats, replay and simulation crates from [aca98d2](https://github.com/nlwstein/tidewater/tree/aca98d2c889d80741e1dc428ebf3043ade16e6e3). The browser bridge, shared command logic and the engine overrides used by this build are in `source/crates`. Copy the contents of `source/` over that checkout and build with `cargo build --locked --release -p tidewater-web --target wasm32-unknown-unknown`. See [LICENSE-TIDEWATER.txt](LICENSE-TIDEWATER.txt).
