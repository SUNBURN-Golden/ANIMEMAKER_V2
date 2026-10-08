// 미리보기: 합성기의 그림(frameAt)을 <canvas> 에 노래와 맞춰 보여 준다 (인코딩 없음 — 카메라 · 효과 · 전환 · 마무리까지 그대로).
//   const pv = createPreview({ compositor, canvas, audioEl });   // audioEl(<audio>)은 없어도 된다 (소리 없는 시계로 간다)
//   await pv.play(); pv.pause(); await pv.seekFrame(r); await pv.seekSeconds(t);
//   const off = pv.on('frame', ({frame, time}) => …);  // 'frame' | 'state' | 'end' | 'error'.  pv.dispose()
//   const blob = await renderStill(compositor, frameIndex, { width: 320 });  // 장면 고치기 화면의 작은 그림용 (JPEG Blob). pv.renderStill(r, opts) 도 같다
//
// 시계: audioEl 이 재생 중이면 audioEl.currentTime × 24 가 기준이고(소리가 주인), 아니면 performance.now 로 센다.
//   느리면 건너뛴다(dropped 에 센다): 그리는 장은 늘 "지금 시각의 장" 이라서 화면이 소리보다 늦어지지 않는다.
//   다음 컷 그림이 아직 안 읽혔으면 소리를 멈추고 기다렸다가(state 'buffering') 이어서 간다. 재생 중에는 앞 2초 분량의 컷을 미리 읽는다.
import { secondsToFrame } from './frames.js';
import { makeCanvas, frameContext, canvasToBlob, nowMs } from './util.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * @param {{compositor:any, canvas:HTMLCanvasElement|OffscreenCanvas, audioEl?:HTMLAudioElement|null, lookaheadSec?:number,
 *          raf?:(cb:Function)=>any, caf?:(id:any)=>void, now?:()=>number}} o
 */
export function createPreview({ compositor, canvas, audioEl = null, lookaheadSec = 2, raf, caf, now = nowMs }) {
  const fps = compositor.fps;
  const total = compositor.totalFrames;
  const lookahead = Math.round(lookaheadSec * fps);
  const requestFrame = raf || ((cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : setTimeout(() => cb(now()), 16)));
  const cancelFrame = caf || ((id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id)));
  if (canvas.width !== compositor.W) canvas.width = compositor.W;
  if (canvas.height !== compositor.H) canvas.height = compositor.H;
  const ctx = frameContext(canvas);
  const listeners = { frame: new Set(), state: new Set(), end: new Set(), error: new Set() };
  let audio = audioEl;
  let frame = -1; // 마지막으로 그린 장
  let playing = false;
  let buffering = false;
  let silent = !audio; // 소리 없이 시계로만 가는 중
  let timer = 0;
  let anchorSec = 0;
  let anchorWall = 0;
  let seekToken = 0;
  let dropped = 0;
  let drawn = 0;
  let prefetching = false;
  let lastPrefetch = -1e9;
  let disposed = false;

  const emit = (name, data) => { for (const cb of [...listeners[name]]) { try { cb(data); } catch (_) { /* 듣는 쪽 오류는 무시 */ } } };
  const state = () => (disposed ? 'disposed' : buffering ? 'buffering' : playing ? 'playing' : 'paused');
  const setBuffering = (b) => { if (buffering !== b) { buffering = b; emit('state', { state: state() }); } };
  const fail = (e) => emit('error', e);

  const audioRunning = () => !!audio && !silent && playing && !buffering && !audio.paused && !audio.ended && audio.readyState >= 2;
  const position = () => (audioRunning() ? audio.currentTime : anchorSec + (now() - anchorWall) / 1000);
  const setAnchor = (sec) => { anchorSec = sec; anchorWall = now(); };

  function drawFrame(r, fresh = false) {
    if (playing && frame >= 0 && r > frame + 1) dropped += r - frame - 1;
    compositor.frameAt(r, ctx, { fresh });
    frame = r;
    drawn++;
    emit('frame', { frame: r, time: r / fps });
  }

  function prefetch(r) {
    if (prefetching || r - lastPrefetch < 12) return;
    prefetching = true;
    lastPrefetch = r;
    compositor.prepare(r, { ahead: lookahead }).catch(fail).then(() => { prefetching = false; });
  }

  function tick() {
    timer = 0;
    if (!playing || disposed) return;
    const t = position();
    const target = secondsToFrame(t, fps);
    if (target >= total) { finish(); return; }
    if (target !== frame) {
      if (!compositor.isReady(target)) {
        // 그림이 아직 안 읽혔다: 소리를 멈추고 읽을 때까지 기다린다
        if (audio && !silent && !audio.paused) { try { audio.pause(); } catch (_) { /* 무시 */ } }
        setBuffering(true);
        const token = seekToken;
        compositor.prepare(target, { ahead: lookahead }).then(() => {
          if (disposed || !playing || token !== seekToken) return;
          resume(target);
        }, (e) => { fail(e); api.pause(); });
        return;
      }
      drawFrame(target);
      prefetch(target);
    }
    timer = requestFrame(tick);
  }

  function startAudio(sec) {
    if (!audio || silent) return;
    try { audio.currentTime = sec; } catch (_) { /* 아직 못 움직임 */ }
    const p = audio.play();
    if (p && typeof p.catch === 'function') p.catch(() => { silent = true; emit('state', { state: state(), silentAudio: true }); });
  }

  function resume(r) {
    setAnchor(r / fps);
    setBuffering(false);
    startAudio(r / fps);
    if (r !== frame) drawFrame(r);
    if (!timer) timer = requestFrame(tick);
  }

  function finish() {
    playing = false;
    if (audio && !audio.paused) { try { audio.pause(); } catch (_) { /* 무시 */ } }
    emit('state', { state: 'ended' });
    emit('end', { frame, time: frame / fps });
  }

  const api = {
    get frame() { return frame; },
    get playing() { return playing; },
    getState() {
      return { state: state(), playing, buffering, frame, time: frame < 0 ? 0 : frame / fps, dropped, drawn, silent, totalFrames: total, fps };
    },

    /** 재생 시작 (끝까지 갔었다면 처음부터). 사용자 손가락 동작 안에서 불러야 소리가 난다 */
    async play() {
      if (disposed || playing) return;
      const start = frame < 0 || frame >= total - 1 ? 0 : frame;
      const token = ++seekToken;
      await compositor.prepare(start, { ahead: lookahead });
      if (disposed || token !== seekToken) return;
      if (frame !== start) drawFrame(start, true);
      playing = true;
      buffering = false;
      setAnchor(start / fps);
      startAudio(start / fps);
      emit('state', { state: 'playing' });
      if (!timer) timer = requestFrame(tick);
    },

    pause() {
      if (!playing && !buffering) return;
      playing = false;
      seekToken++;
      if (timer) { cancelFrame(timer); timer = 0; }
      if (audio && !audio.paused) { try { audio.pause(); } catch (_) { /* 무시 */ } }
      buffering = false;
      emit('state', { state: 'paused' });
    },

    /** r 번째 장으로 (재생 중이어도 된다). 빠르게 여러 번 부르면 마지막 것만 그린다 */
    async seekFrame(r) {
      if (disposed) return;
      r = clamp(Math.floor(Number(r) || 0), 0, Math.max(0, total - 1));
      const token = ++seekToken;
      setAnchor(r / fps);
      if (audio) { try { audio.currentTime = r / fps; } catch (_) { /* 무시 */ } }
      try {
        await compositor.prepare(r, { ahead: playing ? lookahead : 0 });
      } catch (e) { fail(e); return; }
      if (disposed || token !== seekToken) return;
      drawFrame(r, true);
      if (playing) {
        setAnchor(r / fps);
        if (buffering) resume(r);
        else if (!timer) timer = requestFrame(tick);
      }
    },
    seekSeconds(t) {
      return api.seekFrame(secondsToFrame(Math.max(0, Number(t) || 0), fps));
    },

    on(name, cb) {
      if (!listeners[name]) throw new Error(`알 수 없는 이벤트예요: ${name}`);
      listeners[name].add(cb);
      return () => listeners[name].delete(cb);
    },

    setAudio(el) {
      audio = el || null;
      silent = !audio;
    },

    /** 이 미리보기의 합성기로 r 번째 장의 작은 그림(JPEG Blob)을 만든다 — 재생 중인 컷 그림은 놓지 않는다 (renderStill 참고) */
    renderStill(r, o = {}) {
      return renderStill(compositor, r, { evict: false, ...o });
    },

    /** 멈추고 이벤트를 끊는다. 합성기(와 그 그림)는 부른 쪽이 release() 한다 */
    dispose() {
      if (disposed) return;
      api.pause();
      disposed = true;
      for (const s of Object.values(listeners)) s.clear();
    },
  };
  return api;
}

/**
 * 한 장면의 작은 그림 (장면 고치기 화면용). 합성기에서 r 번째 장을 그려 JPEG Blob 으로 돌려준다.
 * @param {{width?:number, mime?:string, quality?:number, as?:'blob'|'bitmap'|'canvas', evict?:boolean}} [o]
 *   evict:false 면 다른 컷 그림을 놓지 않는다 (재생 중인 합성기에 쓸 때)
 */
export async function renderStill(compositor, r, o = {}) {
  await compositor.prepare(r, { evict: o.evict !== false });
  const W = compositor.W;
  const H = compositor.H;
  const c = makeCanvas(W, H);
  const ctx = frameContext(c);
  compositor.frameAt(r, ctx, { fresh: true });
  let out = c;
  if (o.width && o.width !== W) {
    const h = Math.max(1, Math.round((H * o.width) / W));
    out = makeCanvas(o.width, h);
    frameContext(out).drawImage(c, 0, 0, o.width, h);
  }
  if (o.as === 'canvas') return out;
  if (o.as === 'bitmap') return createImageBitmap(out);
  return canvasToBlob(out, o.mime || 'image/jpeg', o.quality == null ? 0.85 : o.quality);
}
