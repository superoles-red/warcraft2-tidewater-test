# Tidewater engine source

The WebAssembly engine uses Tidewater's formats, replay and simulation crates from [aca98d2](https://github.com/nlwstein/tidewater/tree/aca98d2c889d80741e1dc428ebf3043ade16e6e3). The browser bridge is in `source/tidewater-web`. Add it to that checkout's `crates` directory and build with `cargo build --release -p tidewater-web --target wasm32-unknown-unknown`. See [LICENSE-TIDEWATER.txt](LICENSE-TIDEWATER.txt).
