// Load the browser engine. The returned request function can be used in a dedicated
// Worker and transfers only the current state, never the installed archives again.
export async function createTidewater(data, patch, {wasmUrl, wasmBytes} = {}) {
  const url = wasmUrl ?? new URL('./tidewater_web.wasm', import.meta.url);
  let compiled;
  if (wasmBytes) {
    compiled = await WebAssembly.instantiate(wasmBytes);
  } else {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Unable to load the Warcraft II engine');
    if (WebAssembly.instantiateStreaming && response.headers.get('Content-Type')?.includes('application/wasm')) {
      compiled = await WebAssembly.instantiateStreaming(response);
    } else {
      compiled = await WebAssembly.instantiate(await response.arrayBuffer());
    }
  }

  const wasm = compiled.instance.exports;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const write = (first, second) => {
    const pointer = wasm.wc2_input(first.length + (second?.length ?? 0));
    if (!pointer) throw new RangeError('Invalid Warcraft II engine input size');
    const memory = new Uint8Array(wasm.memory.buffer);
    memory.set(first, pointer);
    if (second?.length) memory.set(second, pointer + first.length);
  };
  const read = () => decoder.decode(new Uint8Array(
    wasm.memory.buffer, wasm.wc2_output(), wasm.wc2_output_len(),
  ));

  const bytes = value => ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
  const game = bytes(data);
  const update = patch ? bytes(patch) : null;
  write(game, update);
  if (wasm.wc2_init(game.length)) throw new Error(read());

  return request => {
    write(encoder.encode(JSON.stringify(request)));
    if (wasm.wc2_request()) throw new Error(read());
    return JSON.parse(read());
  };
}
