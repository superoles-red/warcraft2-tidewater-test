export function followMediaVisibility(player, signal) {
  let playing = false;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      playing = !player.paused;
      player.pause();
    } else if (playing) {
      player.play().catch(() => {});
    }
  }, {signal});
  signal.addEventListener('abort', () => {
    player.pause();
    player.removeAttribute('src');
    player.load();
  }, {once: true});
}

export function playNativeVideo(content, {
  src, signal, volume = 1, poster, playLabel = 'Play', onEnd, onError, skipOnTap = false,
}) {
  const video = document.createElement('video');
  const start = document.createElement('button');
  video.playsInline = true;
  video.disablePictureInPicture = true;
  video.className = 'story-video';
  if (poster) video.poster = poster;
  video.volume = volume;
  video.muted = volume === 0;
  start.type = 'button';
  start.className = 'war-button story-start';
  start.textContent = playLabel;
  start.hidden = true;
  const fail = () => {
    if (signal.aborted) return;
    start.hidden = true;
    onError?.();
  };
  const play = () => {
    video.play().catch(error => {
      if (signal.aborted || error.name === 'AbortError') return;
      if (error.name === 'NotAllowedError') start.hidden = false;
      else fail();
    });
  };
  start.addEventListener('click', play, {signal});
  video.addEventListener('playing', () => { start.hidden = true; }, {signal});
  video.addEventListener('ended', onEnd, {signal, once: true});
  video.addEventListener('error', fail, {signal, once: true});
  if (skipOnTap) video.addEventListener('click', onEnd, {signal, once: true});
  followMediaVisibility(video, signal);
  content.append(video, start);
  video.src = src;
  play();
  return video;
}
