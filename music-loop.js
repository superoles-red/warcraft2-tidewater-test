export function createMusicLoop(context, output, onReady) {
  let track;
  let source;
  let startedAt = 0;
  let offset = 0;

  function pause() {
    if (!source) return;
    const elapsed = offset + Math.max(0, context.currentTime - startedAt);
    offset = elapsed < source.loopEnd ? elapsed
      : source.loopStart + (elapsed - source.loopStart) % (source.loopEnd - source.loopStart);
    source.stop();
    source.disconnect();
    source = undefined;
  }

  function clear() {
    pause();
    track?.controller.abort();
    track = undefined;
    offset = 0;
  }

  function load(url) {
    const controller = new AbortController();
    const entry = {url, controller};
    track = entry;
    fetch(url, {signal:controller.signal}).then(async response => {
      if (!response.ok) throw new Error(`Can't load ${url}`);
      const data = await response.arrayBuffer();
      if (controller.signal.aborted) return;
      return context.decodeAudioData(data);
    }).then(buffer => {
      if (track !== entry) return;
      entry.buffer = buffer;
      onReady();
    }, () => {
      if (track !== entry) return;
      entry.failed = true;
      onReady();
    });
  }

  function sync(url, {loopStart, loopEnd}, playing) {
    if (track && track.url !== url) clear();
    if (track?.failed) return false;
    if (!playing) {
      pause();
      return true;
    }
    if (!track) load(url);
    const buffer = track.buffer;
    if (buffer && !source) {
      source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      // A music loop runs on the audio clock, without media seeks or JS timers.
      source.loopStart = loopStart;
      // Some AAC decoders keep padding out to the end of the last packet.
      source.loopEnd = Math.min(loopEnd ?? buffer.duration, buffer.duration);
      source.connect(output);
      startedAt = context.currentTime;
      source.start(startedAt, offset);
    }
    return true;
  }

  return {sync, clear};
}
