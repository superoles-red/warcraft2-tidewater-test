// BNE lowers chained music by 0.10 dB every 20 ms in the last 616,000 bytes.
const fadeDuration = 616000 / 88200;
const dbPerSecond = 5;
const floorDb = -33.96;
const amplitude = seconds => 10 ** (-seconds * dbPerSecond / 20);

export function createMusicFade(player, stage, volume) {
  let chained = false;
  let anchor;

  function update(allowAdvance = true) {
    const level = volume();
    const position = player.currentTime;
    const fadeStart = player.duration - fadeDuration;
    const fading = chained && Number.isFinite(fadeStart) && fadeStart > 0;
    const elapsed = position - fadeStart;
    const cutoff = Math.max(0, (20 * Math.log10(level) - floorDb) / dbPerSecond);
    const scale = !fading || elapsed <= 0 ? 1
      : elapsed >= cutoff || player.ended ? 0 : amplitude(elapsed);

    if (!stage) {
      player.volume = level * scale;
      player.muted = level * scale === 0;
      return;
    }

    const {context, gain} = stage;
    const now = context.currentTime;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(scale, now);
    anchor = undefined;
    if (!fading || !allowAdvance || !scale || !level || player.paused || player.seeking ||
        player.readyState < player.HAVE_FUTURE_DATA || player.playbackRate <= 0) return;

    // The audio clock runs the fade while streaming, without waking a JS timer.
    const at = seconds => now + (seconds - position) / player.playbackRate;
    const fadeEnd = fadeStart + Math.min(cutoff, fadeDuration);
    if (elapsed < 0) gain.setValueAtTime(1, at(fadeStart));
    if (cutoff > 0) gain.exponentialRampToValueAtTime(amplitude(Math.min(cutoff, fadeDuration)), at(fadeEnd));
    gain.setValueAtTime(0, at(fadeEnd) + .001);
    anchor = {position, time:now, rate:player.playbackRate};
  }

  for (const event of ['playing', 'seeked', 'ratechange', 'durationchange', 'emptied'])
    player.addEventListener(event, () => update());
  for (const event of ['pause', 'seeking', 'waiting', 'ended'])
    player.addEventListener(event, () => update(false));
  player.addEventListener('timeupdate', () => {
    if (!chained || player.duration - player.currentTime > fadeDuration + 1) return;
    if (!stage || !anchor) {
      update();
      return;
    }
    // A media decoder can lag the audio clock briefly after a seek or interruption.
    const expected = anchor.position + (stage.context.currentTime - anchor.time) * anchor.rate;
    if (Math.abs(expected - player.currentTime) > .08) update();
  });

  return {
    update,
    chain(enabled) {
      chained = enabled;
      update();
    },
  };
}
