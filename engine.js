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
  const readBytes = () => new Uint8Array(
    wasm.memory.buffer, wasm.wc2_output(), wasm.wc2_output_len(),
  );
  const read = () => decoder.decode(readBytes());

  const bytes = value => ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
  const game = bytes(data);
  const update = patch ? bytes(patch) : null;
  write(game, update);
  if (wasm.wc2_init(game.length)) throw new Error(read());

  return request => {
    let status;
    if (request.op === 'saveCheckpoint') {
      if (wasm.wc2_save_checkpoint()) throw new Error(read());
      return readBytes().slice();
    }
    if (request.op === 'restoreCheckpoint') {
      write(bytes(request.checkpoint));
      status = wasm.wc2_restore_checkpoint();
    } else if (request.op === 'loadScenario') {
      const {pud, ...fields} = request;
      const metadata = encoder.encode(JSON.stringify(fields));
      write(metadata, bytes(pud));
      status = wasm.wc2_scenario(metadata.byteLength);
    } else {
      write(encoder.encode(JSON.stringify(request)));
      status = wasm.wc2_request();
    }
    if (status) throw new Error(read());
    return JSON.parse(read());
  };
}
