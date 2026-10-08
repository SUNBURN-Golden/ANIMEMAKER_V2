// 영상 엔진 시험용 브라우저 쪽 도구 (test/e2e-render.test.js 가 Chromium 안에서 부른다). 앱 번들에는 들어가지 않는다.
import * as R from '../../src/engine/render/index.js';
import { decodeSong } from '../../src/audio.js';
import RC from '../../../src/main/media/render-core.js';
import X from '../../../src/main/pipeline/xsheet.js';
import KC from '../../../src/main/media/keyer-core.js';
import SS from '../../../src/shared/subtitle-style.js';
import { Input, BlobSource, ALL_FORMATS, CanvasSink, EncodedPacketSink, StreamTarget } from 'mediabunny';

const T = {};
window.T = T;
T.R = R;
T.blobs = {};
T.live = { made: 0, closed: 0 };
T.openCount = () => T.live.made - T.live.closed;
const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** 비트맵 하나가 만들어지고 닫히는 것을 센다 (합성기가 주인이 된 그림을 빠짐없이 닫는지 보려고) */
function track(bmp) {
  T.live.made++;
  let done = false;
  const orig = bmp.close.bind(bmp);
  bmp.close = () => { if (!done) { done = true; T.live.closed++; } orig(); };
  return bmp;
}

const b64 = async (blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
T.sha1 = async (blob) => [...new Uint8Array(await crypto.subtle.digest('SHA-1', await blob.arrayBuffer()))].map((x) => x.toString(16).padStart(2, '0')).join('');

/** 연습용 셀 PNG → 배경 뺀 비트맵 (미리 곱한 알파) */
T.keyedBitmap = async (blob) => {
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const id = ctx.getImageData(0, 0, c.width, c.height);
  const k = KC.keyCel(id.data, c.width, c.height, {});
  if (!k.ok) throw new Error(`배경 빼기 실패: ${k.reason}`);
  return createImageBitmap(new ImageData(new Uint8ClampedArray(k.rgba), c.width, c.height), { premultiplyAlpha: 'premultiply' });
};

/** 연습용 그림으로 만든 materials: shot(i) 를 부를 때마다 새 비트맵을 준다 (주인은 합성기) */
T.demoMaterials = async (xs, W, H, { seed = 1 } = {}) => {
  const layered = !!xs.layers;
  const cache = new Map();
  const build = async (i) => {
    const s = xs.shots[i];
    const bg = layered ? await R.demoBg({ W, H, shot: s.shot, seed }) : null;
    const cels = new Map();
    for (const [k, d] of s.drawings.entries()) {
      const o = { W, H, shot: s.shot, index: k, count: s.drawings.length, highlight: s.highlight, motion: s.motion };
      cels.set(d.id, layered ? await R.demoCel(o) : await R.demoDrawing(o));
    }
    return { bg, cels };
  };
  return {
    calls: [],
    closed: [],
    async shot(i) {
      this.calls.push(i);
      if (!cache.has(i)) cache.set(i, await build(i));
      const { bg, cels } = cache.get(i);
      const layers = new Map();
      for (const [id, blob] of cels) layers.set(id, track(layered ? await T.keyedBitmap(blob) : await createImageBitmap(blob)));
      return { bg: bg ? track(await createImageBitmap(bg)) : null, layers };
    },
    close(i) { this.closed.push(i); },
  };
};

// ---------- ① PC 앱 합성(sampleFrame + composite + applyFx) 과 같은지 ----------
/** PC 앱 render.js renderShot 한 장의 계산을 그대로 옮긴 기준 (렌더 코어 함수만 쓴다) */
function refFrame({ shot, table, bg, cels, cw, ch, W, H, lead, boil, seed, parallax, r }) {
  const N = shot.frames;
  const f = Math.min(N - 1, Math.max(0, r - lead));
  const id = table[f];
  const cam = shot.camera;
  const base = X.cameraAt(cam, N > 1 ? f / (N - 1) : 0);
  const st = RC.fxState(shot.fx || [], f, N);
  const sd = seed * 7919 + shot.shot;
  let sx = 0;
  let sy = 0;
  const amp = (cam.move === 'shake' ? (cam.shake || 0.012) : 0) + st.shake * 0.02;
  if (amp > 0) {
    const k = Math.floor(r / 2);
    sx = (RC.rand(sd, k, 3) - 0.5) * 2 * amp * W;
    sy = (RC.rand(sd, k, 4) - 0.5) * 2 * amp * H;
  }
  const fr = { ...base };
  let dx = sx;
  let dy = sy;
  if (boil) {
    const k = Math.floor(r / 2);
    dx += (RC.rand(sd, k, 1) - 0.5) * 1.1;
    dy += (RC.rand(sd, k, 2) - 0.5) * 1.1;
    fr.zoom = Math.max(1, fr.zoom * (1 + (RC.rand(sd, k, 5) - 0.5) * 0.0025));
  }
  const bfr = RC.parallaxFraming(base, parallax);
  const buf = RC.composite(RC.sampleFrame(cels.get(id), cw, ch, W, H, fr, dx, dy, 4), RC.sampleFrame(bg, cw, ch, W, H, bfr, sx, sy, 3), W * H);
  RC.applyFx(buf, st, W, H, sd, r);
  return buf;
}

T.parity = async ({ W, H, move, fx = [], boil = false, N = 48, frames = [0, 7, 24, 47], seed = 1, shake, quality }) => {
  const cam = X.normalizeCamera({ move, ...(shake ? { shake } : {}) }, fx);
  const shot = { shot: 1, frames: N, camera: cam, fx, exposure: [{ drawing: 'A', frames: N }], drawings: [{ id: 'A' }], motion: false };
  const xs = { fps: 24, totalFrames: N, layers: true, shots: [shot], transitions: [] };
  const { cw, ch } = RC.coverSize(cam, W, H);
  const bg = new Uint8Array(cw * ch * 3);
  const cel = new Uint8Array(cw * ch * 4); // 미리 곱한 알파
  const celRaw = new Uint8ClampedArray(cw * ch * 4); // 곱하지 않은 (비트맵 만들기용)
  const bgRaw = new Uint8ClampedArray(cw * ch * 4);
  const rx0 = cw * 0.375;
  const rx1 = cw * 0.625;
  const ry0 = ch * 0.25;
  const ry1 = ch * 0.75;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = y * cw + x;
      const r = clamp8(128 + 100 * Math.sin(x / 37) * Math.cos(y / 53));
      const g = clamp8((x / cw) * 255);
      const b = clamp8((y / ch) * 255);
      bg[i * 3] = r; bg[i * 3 + 1] = g; bg[i * 3 + 2] = b;
      bgRaw[i * 4] = r; bgRaw[i * 4 + 1] = g; bgRaw[i * 4 + 2] = b; bgRaw[i * 4 + 3] = 255;
      const ex = Math.min(x - rx0, rx1 - x);
      const ey = Math.min(y - ry0, ry1 - y);
      const e = Math.min(ex, ey);
      const a = e <= 0 ? 0 : e >= 12 ? 255 : Math.round((e / 12) * 255); // 가장자리 12픽셀은 점점 불투명
      const cr = clamp8(40 + 200 * ((x - rx0) / (rx1 - rx0)));
      const cg = clamp8(220 - 150 * ((y - ry0) / (ry1 - ry0)));
      const cb = 90;
      celRaw[i * 4] = cr; celRaw[i * 4 + 1] = cg; celRaw[i * 4 + 2] = cb; celRaw[i * 4 + 3] = a;
      cel[i * 4] = Math.round((cr * a) / 255); cel[i * 4 + 1] = Math.round((cg * a) / 255); cel[i * 4 + 2] = Math.round((cb * a) / 255); cel[i * 4 + 3] = a;
    }
  }
  const mats = {
    async shot() {
      return {
        bg: track(await createImageBitmap(new ImageData(bgRaw, cw, ch), { premultiplyAlpha: 'premultiply' })),
        layers: new Map([['A', track(await createImageBitmap(new ImageData(celRaw, cw, ch), { premultiplyAlpha: 'premultiply' }))]]),
      };
    },
  };
  const comp = R.createCompositor({ xs, W, H, materials: mats, finish: { boil, vignette: false, warm: false }, seed, quality });
  await comp.prepare(0);
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false });
  const table = X.frameTable(shot);
  const out = [];
  for (const r of frames) {
    comp.frameAt(r, ctx, { fresh: true });
    const got = ctx.getImageData(0, 0, W, H).data;
    const ref = refFrame({ shot, table, bg, cels: new Map([['A', cel]]), cw, ch, W, H, lead: 0, boil, seed, parallax: 0.8, r });
    let sum = 0;
    let max = 0;
    let big = 0;
    for (let i = 0; i < W * H; i++) {
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(got[i * 4 + c] - ref[i * 3 + c]);
        sum += d;
        if (d > max) max = d;
        if (d > 8) big++;
      }
    }
    out.push({ r, mae: sum / (W * H * 3), max, bigFrac: big / (W * H * 3) });
  }
  comp.release();
  return { W, H, move, fx, boil, cw, ch, frames: out, mae: out.reduce((a, b) => a + b.mae, 0) / out.length, open: T.openCount() };
};

// ---------- ② 화면전환: 가운데 장은 정확히 반반, 진행은 한 방향 ----------
const solidBitmap = async (r, g, b, w = 64, h = 36) => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255; }
  return track(await createImageBitmap(new ImageData(d, w, h)));
};

T.transitionProbe = async ({ xfade = 'fade', T: Tn = 12, N = 48, W = 320, H = 180 } = {}) => {
  const cam = X.normalizeCamera({ move: 'hold' }, []);
  const mk = (i) => ({ shot: i + 1, frames: N, camera: cam, fx: [], exposure: [{ drawing: 'A', frames: N }], drawings: [{ id: 'A' }] });
  const xs = { fps: 24, totalFrames: 2 * N, layers: true, shots: [mk(0), mk(1)], transitions: [{ type: xfade, xfade, duration: Tn / 24, frames: Tn }] };
  const colors = [[255, 0, 0], [0, 0, 255]];
  const mats = { async shot(i) { return { bg: await solidBitmap(...colors[i]), layers: new Map() }; } };
  const comp = R.createCompositor({ xs, W, H, materials: mats, finish: { boil: false, vignette: false, warm: false } });
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false });
  const px = [];
  const cut = N;
  for (let r = cut - Tn / 2 - 3; r < cut + Tn / 2 + 3; r++) {
    await comp.prepare(r);
    const info = comp.frameAt(r, ctx, { fresh: true });
    const d = ctx.getImageData(Math.floor(W / 2), Math.floor(H / 2), 1, 1).data;
    px.push({ r, kind: info.kind, rgb: [d[0], d[1], d[2]] });
  }
  const loaded = comp.loadedShots();
  comp.release();
  return { xfade, Tn, cut, px, loaded, open: T.openCount() };
};

/** drawTransition 만: 모든 이름이 p=0 에서 A, p=1 에서 B 이고 가운데에서 둘 다 섞여 보이는지 (왼쪽 절반 빨강 / 오른쪽 절반 파랑 → 위치에 따라 달라지는 전환도 본다) */
T.drawTransitionProbe = async () => {
  const W = 160;
  const H = 90;
  const flat = (r, g, b) => { const c = new OffscreenCanvas(W, H); const x = c.getContext('2d'); x.fillStyle = `rgb(${r},${g},${b})`; x.fillRect(0, 0, W, H); return c; };
  const A = flat(255, 0, 0);
  const B = flat(0, 0, 255);
  const out = {};
  for (const name of R.TRANSITION_NAMES) {
    const res = {};
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      const c = new OffscreenCanvas(W, H);
      const x = c.getContext('2d', { alpha: false });
      x.fillStyle = '#00ff00'; // 안 덮인 곳이 있으면 초록이 보인다
      x.fillRect(0, 0, W, H);
      R.drawTransition(x, name, A, B, p, W, H);
      const d = x.getImageData(0, 0, W, H).data;
      let green = 0;
      let rsum = 0;
      let bsum = 0;
      for (let i = 0; i < W * H; i++) { if (d[i * 4 + 1] > 200 && d[i * 4] < 60 && d[i * 4 + 2] < 60) green++; rsum += d[i * 4]; bsum += d[i * 4 + 2]; }
      res[p] = { green, r: rsum / (W * H), b: bsum / (W * H) };
    }
    out[name] = res;
  }
  return out;
};

// ---------- ③ 다시 그리기 건너뛰기 ----------
T.reuseProbe = async ({ boil }) => {
  const W = 320;
  const H = 180;
  const N = 48;
  const cam = X.normalizeCamera({ move: 'hold' }, []);
  const shot = { shot: 1, frames: N, camera: cam, fx: [], exposure: [{ drawing: 'A', frames: N }], drawings: [{ id: 'A' }] };
  const xs = { fps: 24, totalFrames: N, layers: true, shots: [shot], transitions: [] };
  // 보일이 눈에 보이도록 줄무늬 배경 + 구멍 뚫린 줄무늬 셀 (납작한 한 가지 색이면 위치가 조금 움직여도 똑같이 보인다)
  const stripes = async (holes) => {
    const w = 128;
    const h = 72;
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const v = ((x + y) >> 2) % 2 ? 40 : 220;
        d[i] = v; d[i + 1] = 120; d[i + 2] = 255 - v; d[i + 3] = holes && ((x >> 3) % 2 === 0) ? 0 : 255;
      }
    }
    return track(await createImageBitmap(new ImageData(d, w, h), { premultiplyAlpha: 'premultiply' }));
  };
  const mats = { async shot() { return { bg: await stripes(false), layers: new Map([['A', await stripes(true)]]) }; } };
  const comp = R.createCompositor({ xs, W, H, materials: mats, finish: { boil, vignette: true, warm: true } });
  await comp.prepare(0);
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false });
  const flags = [];
  const hash = [];
  for (let r = 0; r < N; r++) {
    flags.push(comp.frameAt(r, ctx).reused);
    const d = ctx.getImageData(0, 0, W, H).data;
    let h = 0;
    for (let i = 0; i < d.length; i++) h = (h * 31 + d[i]) | 0;
    hash.push(h);
  }
  // 재사용한 장은 새로 그린 장과 픽셀까지 같다
  const fresh = new OffscreenCanvas(W, H);
  const fctx = fresh.getContext('2d', { alpha: false });
  let mismatch = 0;
  for (let r = 0; r < N; r++) {
    comp.frameAt(r, fctx, { fresh: true });
    const a = fctx.getImageData(0, 0, W, H).data;
    comp.frameAt(r, ctx, { fresh: true });
    const b = ctx.getImageData(0, 0, W, H).data;
    for (let i = 0; i < a.length; i += 61) if (a[i] !== b[i]) { mismatch++; break; }
  }
  const stats = { ...comp.stats };
  comp.release();
  return { boil, reusedCount: flags.filter(Boolean).length, flags, stats, mismatch, distinct: new Set(hash).size };
};

// ---------- ③-2 노출표: 사이 그림 · 없는 그림 · 레이어 없는 타임시트 ----------
T.tableProbe = async () => {
  const W = 160;
  const H = 90;
  const N = 24;
  const cam = X.normalizeCamera({ move: 'hold' }, []);
  cam.start = { zoom: 1, x: 0, y: 0 };
  cam.end = { zoom: 1, x: 0, y: 0 };
  const shot = { shot: 1, frames: N, motion: true, camera: cam, fx: [], exposure: [{ drawing: 'A', frames: 4 }, { drawing: 'B', frames: 4 }, { drawing: 'A', frames: 16 }], drawings: [{ id: 'A' }, { id: 'B' }] };
  const table = X.expandExposure(shot, () => true);
  const read = async (layers, makeLayers) => {
    const xs = { fps: 24, totalFrames: N, layers, shots: [shot], transitions: [] };
    const comp = R.createCompositor({ xs, W, H, materials: { async shot() { return { bg: layers ? await solidBitmap(200, 200, 200) : null, layers: await makeLayers() }; } }, finish: { boil: false, vignette: false, warm: false } });
    await comp.prepare(0);
    const ctx = new OffscreenCanvas(W, H).getContext('2d', { alpha: false });
    const px = [];
    for (let r = 0; r < N; r++) { comp.frameAt(r, ctx, { fresh: true }); const d = ctx.getImageData(80, 45, 1, 1).data; px.push([d[0], d[1], d[2]]); }
    comp.release();
    return px;
  };
  const sol = (r, g, b) => solidBitmap(r, g, b);
  return {
    table,
    withInbetween: await read(true, async () => new Map([['A', await sol(255, 0, 0)], ['B', await sol(0, 255, 0)], ['A~B', await sol(0, 0, 255)]])),
    without: await read(true, async () => new Map([['A', await sol(255, 0, 0)], ['B', await sol(0, 255, 0)]])),
    missingCel: await read(true, async () => new Map([['A', await sol(255, 0, 0)], ['B', null]])),
    pictures: await read(false, async () => new Map([['A', await sol(255, 0, 0)], ['B', null]])),
    objectLayers: await read(true, async () => ({ A: await sol(255, 0, 0), B: await sol(0, 255, 0) })),
  };
};

/** 마무리 비교용: 같은 장을 마무리 없이 / 따뜻함만 / 비네팅만 / 둘 다 그린 PNG (PC 앱 ffmpeg 필터 결과와 비교한다) */
T.finishFrames = async ({ xs, W, H, r }) => {
  const mats = await T.demoMaterials(xs, W, H);
  const out = {};
  for (const [k, f] of Object.entries({ base: {}, warm: { warm: true }, vig: { vignette: true }, both: { warm: true, vignette: true } })) {
    const comp = R.createCompositor({ xs, W, H, materials: mats, finish: { boil: false, vignette: false, warm: false, ...f } });
    await comp.prepare(r);
    const c = new OffscreenCanvas(W, H);
    comp.frameAt(r, c.getContext('2d', { alpha: false }), { fresh: true });
    out[k] = await b64(await c.convertToBlob({ type: 'image/png' }));
    comp.release();
  }
  return out;
};

/** 속도 재기: 합성만 (읽기 · 그리기) / 합성+인코딩. 한 장마다 1×1 읽기로 그리기를 끝까지 시킨다 */
T.perf = async ({ xs, W, H, seconds, windows, quality }) => {
  const out = { W, H };
  const timing = { materials: 0, calls: 0 };
  const base = await T.demoMaterials(xs, W, H);
  const mats = { shot: async (i) => { const t = performance.now(); const r = await base.shot(i); timing.materials += performance.now() - t; timing.calls++; return r; }, close: (i) => base.close(i) };
  const ctx = new OffscreenCanvas(W, H).getContext('2d', { alpha: false });
  for (const [label, finish] of [['draw-only', { boil: false, vignette: false, warm: false }], ['default', undefined], ['default+grain+paper', { grain: true, paper: true }]]) {
    const comp = R.createCompositor({ xs, W, H, materials: mats, finish, quality });
    let frames = 0;
    let ms = 0;
    let prepMs = 0;
    for (const [from, len] of windows) {
      const t0 = performance.now();
      await comp.prepare(from);
      prepMs += performance.now() - t0;
      comp.invalidate();
      const t1 = performance.now();
      for (let r = from; r < from + len; r++) {
        if (!comp.isReady(r)) await comp.prepare(r);
        comp.frameAt(r, ctx);
        ctx.getImageData(0, 0, 1, 1);
        frames++;
      }
      ms += performance.now() - t1;
    }
    out[label] = { msPerFrame: ms / frames, frames, prepareMsPerWindow: prepMs / windows.length, bytes: comp.loadedBytes(), reused: comp.stats.reused, transitions: comp.stats.transitions };
    comp.release();
  }
  out.materialsMsPerCall = timing.materials / Math.max(1, timing.calls);
  // 인코딩만: 정지한 한 장(재사용)을 인코더에 24fps 로 넣는다 (VP9 소프트웨어)
  {
    const cam = X.normalizeCamera({ move: 'hold' }, []);
    const N = 240;
    const shot = { shot: 1, frames: N, camera: cam, fx: [], exposure: [{ drawing: 'A', frames: N }], drawings: [{ id: 'A' }] };
    const xs1 = { fps: 24, totalFrames: N, layers: true, shots: [shot], transitions: [] };
    const m1 = { async shot() { return { bg: await T.keyedBitmapFromBlob(await R.demoBg({ W, H, shot: 1 })), layers: new Map() }; } };
    const comp = R.createCompositor({ xs: xs1, W, H, materials: m1, finish: { boil: false, vignette: false, warm: false } });
    const r = await R.exportClean({ compositor: comp, audio: null });
    out.encodeOnly = { msPerFrame: r.msPerFrame, frames: r.frames, codec: r.codecs.video, bytes: r.bytes, reused: r.reusedFrames };
  }
  const audio = await decodeSong(await R.demoSong({ seconds, bpm: 120 }));
  const comp = R.createCompositor({ xs, W, H, materials: mats });
  const t0 = performance.now();
  const r = await R.exportClean({ compositor: comp, audio });
  out.full = { msPerFrame: r.msPerFrame, frames: r.frames, ms: performance.now() - t0, bytes: r.bytes, codecs: r.codecs, reused: r.reusedFrames, stats: comp.stats };
  T.blobs.perf = r.blob;
  out.heap = performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize } : null;
  return out;
};
T.keyedBitmapFromBlob = async (blob) => createImageBitmap(blob);

/** 판 만들기 비용: 1536×1024 원본 9장(배경 + 셀 8)을 화면 크기에 꽉 채우는 판으로 */
T.plateCost = async ({ W, H, zoom = 1.25, n = 8 }) => {
  const c = new OffscreenCanvas(1536, 1024);
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 1536, 1024);
  g.addColorStop(0, '#345'); g.addColorStop(1, '#fa6');
  x.fillStyle = g; x.fillRect(0, 0, 1536, 1024);
  const src = await createImageBitmap(c);
  const cam = X.normalizeCamera({ move: 'pan_right' }, []);
  cam.start.zoom = zoom; cam.end.zoom = zoom;
  const ids = Array.from({ length: n }, (_, k) => String.fromCharCode(65 + k));
  const shot = { shot: 1, frames: 48, camera: cam, fx: [], exposure: ids.map((d, k) => ({ drawing: d, frames: 6 })), drawings: ids.map((id) => ({ id })), motion: true };
  const xs = { fps: 24, totalFrames: 48, layers: true, shots: [shot], transitions: [] };
  const mats = { async shot() { return { bg: await createImageBitmap(src), layers: new Map(await Promise.all(ids.map(async (id) => [id, await createImageBitmap(src)]))) }; } };
  const comp = R.createCompositor({ xs, W, H, materials: mats });
  const t = performance.now();
  await comp.prepare(0);
  const ms = performance.now() - t;
  const bytes = comp.loadedBytes();
  comp.release();
  return { ms, perPlate: ms / (n + 1), bytes, plates: n + 1, cw: Math.round(W * zoom), ch: Math.round(H * zoom) };
};

/** 필름 알갱이 · 종이: 켜면 조금 달라지고(종이는 어두워지고), 같은 장은 늘 같고, 알갱이는 장마다 다르다 */
T.grainPaperProbe = async () => {
  const W = 320;
  const H = 180;
  const cam = X.normalizeCamera({ move: 'hold' }, []);
  const shot = { shot: 1, frames: 48, camera: cam, fx: [], exposure: [{ drawing: 'A', frames: 48 }], drawings: [{ id: 'A' }] };
  const xs = { fps: 24, totalFrames: 48, layers: true, shots: [shot], transitions: [] };
  const mats = { async shot() { return { bg: await solidBitmap(120, 150, 180), layers: new Map() }; } };
  const frame = async (finish, r) => {
    const comp = R.createCompositor({ xs, W, H, materials: mats, finish: { boil: false, vignette: false, warm: false, ...finish } });
    await comp.prepare(r);
    const ctx = new OffscreenCanvas(W, H).getContext('2d', { alpha: false });
    comp.frameAt(r, ctx, { fresh: true });
    const d = ctx.getImageData(0, 0, W, H).data;
    comp.release();
    return d;
  };
  const mean = (a) => { let s = 0; for (let i = 0; i < a.length; i += 4) s += a[i] + a[i + 1] + a[i + 2]; return s / (a.length / 4 * 3); };
  const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); return s / (a.length / 4 * 3); };
  const base = await frame({}, 3);
  const g3 = await frame({ grain: true }, 3);
  const g3b = await frame({ grain: true }, 3);
  const g4 = await frame({ grain: true }, 4);
  const p3 = await frame({ paper: true }, 3);
  const p3b = await frame({ paper: true }, 3);
  return {
    grainVsBase: diff(g3, base), grainSame: diff(g3, g3b), grainNextFrame: diff(g3, g4), grainMeanShift: mean(g3) - mean(base),
    paperVsBase: diff(p3, base), paperSame: diff(p3, p3b), paperMeanShift: mean(p3) - mean(base),
  };
};

// ---------- ④ 내보내기 · 읽어 보기 ----------
T.exportDemo = async ({ xs, W, H, seconds, bpm = 120, name = 'clean', finish, cancelAt = 0, seed = 1, wantAudio = true }) => {
  const mats = await T.demoMaterials(xs, W, H, { seed });
  const comp = R.createCompositor({ xs, W, H, materials: mats, finish, seed });
  const origPrepare = comp.prepare.bind(comp);
  let maxLoaded = 0;
  comp.prepare = async (...a) => { await origPrepare(...a); maxLoaded = Math.max(maxLoaded, comp.loadedShots().length); };
  const audio = wantAudio ? await decodeSong(await R.demoSong({ seconds, bpm })) : null;
  const progress = [];
  const ctl = new AbortController();
  const base = { maxLoaded: 0 };
  try {
    const res = await R.exportClean({
      compositor: comp, audio, signal: ctl.signal, tags: { title: '시험 영상' },
      onProgress: (p) => { progress.push(p); if (cancelAt && p.frame >= cancelAt) ctl.abort(); },
    });
    T.blobs[name] = res.blob;
    return {
      ok: true, codecs: res.codecs, frames: res.frames, seconds: res.seconds, bytes: res.bytes, ms: res.ms, msPerFrame: res.msPerFrame, fallback: res.fallback, probe: res.probe,
      reused: res.reusedFrames, stats: comp.stats, progress: { count: progress.length, first: progress[0], last: progress[progress.length - 1] }, maxLoaded,
      open: T.openCount(), calls: mats.calls, closed: mats.closed, warnings: comp.warnings, blobSize: res.blob.size,
    };
  } catch (e) {
    return { ok: false, error: { name: e.name, message: e.message }, open: T.openCount(), progress: { count: progress.length, last: progress[progress.length - 1] }, maxLoaded, stats: comp.stats, blob: !!T.blobs[name] , ...base };
  }
};

/** 스트리밍 목표(StreamTarget): 메모리에 통째로 안 모으고 조각(chunk)으로 받는다 — 나중에 파일에 바로 쓰는 목표를 끼울 자리 */
T.exportStream = async ({ xs, W, H }) => {
  const chunks = [];
  let size = 0;
  const target = new StreamTarget(new WritableStream({ write(c) { chunks.push(c); size = Math.max(size, c.position + c.data.byteLength); } }));
  const mats = await T.demoMaterials(xs, W, H);
  const comp = R.createCompositor({ xs, W, H, materials: mats });
  const res = await R.exportClean({ compositor: comp, audio: null, target });
  const buf = new Uint8Array(size);
  for (const c of chunks) buf.set(c.data, c.position);
  T.blobs.stream = new Blob([buf], { type: 'video/mp4' });
  return { blob: res.blob, bytes: res.bytes, size, chunks: chunks.length, open: T.openCount() };
};

T.readVideo = async (name) => {
  const input = new Input({ source: new BlobSource(T.blobs[name]), formats: ALL_FORMATS });
  const v = await input.getPrimaryVideoTrack();
  const a = await input.getPrimaryAudioTrack();
  const vs = await v.computePacketStats();
  const tags = await input.getMetadataTags();
  const out = {
    vcodec: await v.getCodec(), w: await v.getDisplayWidth(), h: await v.getDisplayHeight(), packets: vs.packetCount, fps: vs.averagePacketRate, vdur: await v.computeDuration(),
    first: await v.getFirstTimestamp(), tags: { comment: tags.comment, description: tags.description, title: tags.title }, size: T.blobs[name].size,
  };
  if (a) {
    out.acodec = await a.getCodec();
    out.sr = await a.getSampleRate();
    out.ch = await a.getNumberOfChannels();
    out.apackets = (await a.computePacketStats()).packetCount;
    out.adur = await a.computeDuration();
    let bytes = 0;
    for await (const p of new EncodedPacketSink(a).packets()) bytes += p.byteLength;
    out.abytes = bytes;
  }
  if (input.dispose) input.dispose();
  return out;
};

async function grab(name, t) {
  const input = new Input({ source: new BlobSource(T.blobs[name]), formats: ALL_FORMATS });
  const v = await input.getPrimaryVideoTrack();
  const sink = new CanvasSink(v, { poolSize: 1 });
  const wc = await sink.getCanvas(t);
  const c = wc.canvas;
  const img = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  if (input.dispose) input.dispose();
  return img;
}

/** 두 영상의 같은 시각 장을 비교: thr 보다 많이 다른 곳의 바깥 상자와 개수, 전체 평균 차이 */
T.diffFrames = async (a, b, t, thr = 40, t2 = t) => {
  const A = await grab(a, t);
  const B = await grab(b, t2);
  let x0 = 1e9; let y0 = 1e9; let x1 = -1; let y1 = -1; let count = 0; let sum = 0; let max = 0;
  for (let y = 0; y < A.height; y++) {
    for (let x = 0; x < A.width; x++) {
      const i = (y * A.width + x) * 4;
      const d = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]));
      sum += d;
      if (d > max) max = d;
      if (d > thr) { count++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  return { w: A.width, h: A.height, count, bbox: count ? { x0, y0, x1, y1 } : null, mean: sum / (A.width * A.height), max };
};

/** 한 장에서 어떤 색(허용 오차 안)인 픽셀 수 */
T.countColor = async (name, t, rgb, tol = 30) => {
  const A = await grab(name, t);
  let n = 0;
  for (let i = 0; i < A.data.length; i += 4) if (Math.abs(A.data[i] - rgb[0]) <= tol && Math.abs(A.data[i + 1] - rgb[1]) <= tol && Math.abs(A.data[i + 2] - rgb[2]) <= tol) n++;
  return { n, total: A.width * A.height };
};

/** 인코더가 없는 폰: 한국어 오류와 probe 가 실리는지 */
T.noEncoderProbe = async () => {
  const cam = X.normalizeCamera({ move: 'hold' }, []);
  const shot = { shot: 1, frames: 24, camera: cam, fx: [], exposure: [{ drawing: 'A', frames: 24 }], drawings: [{ id: 'A' }] };
  const xs = { fps: 24, totalFrames: 24, layers: true, shots: [shot], transitions: [] };
  const comp = R.createCompositor({ xs, W: 64, H: 36, materials: { async shot() { return { bg: await solidBitmap(1, 2, 3), layers: new Map() }; } } });
  try {
    await R.exportClean({ compositor: comp });
    return { threw: false };
  } catch (e) {
    return { threw: true, name: e.name, message: e.message, probe: e.probe, open: T.openCount() };
  }
};

/** 한 장의 평균 색 (전환 · 페이드 확인용) */
T.meanColor = async (name, t) => {
  const A = await grab(name, t);
  let r = 0; let g = 0; let b = 0;
  for (let i = 0; i < A.data.length; i += 4) { r += A.data[i]; g += A.data[i + 1]; b += A.data[i + 2]; }
  const n = A.data.length / 4;
  return [r / n, g / n, b / n];
};

/** 여러 장을 한 장에 모은 그림(PNG base64): 눈으로 보려고 */
T.sheet = async (items, cols, thumbW) => {
  const imgs = [];
  for (const it of items) imgs.push({ label: it.label, img: await grab(it.name, it.t) });
  const tw = thumbW;
  const th = Math.round((tw * imgs[0].img.height) / imgs[0].img.width);
  const rows = Math.ceil(imgs.length / cols);
  const c = new OffscreenCanvas(cols * tw, rows * (th + 22));
  const x = c.getContext('2d');
  x.fillStyle = '#222';
  x.fillRect(0, 0, c.width, c.height);
  x.font = '14px sans-serif';
  imgs.forEach((it, k) => {
    const tmp = new OffscreenCanvas(it.img.width, it.img.height);
    tmp.getContext('2d').putImageData(it.img, 0, 0);
    const cx = (k % cols) * tw;
    const cy = Math.floor(k / cols) * (th + 22);
    x.drawImage(tmp, cx, cy + 22, tw, th);
    x.fillStyle = '#fff';
    x.fillText(it.label, cx + 4, cy + 15);
  });
  return b64(await c.convertToBlob({ type: 'image/png' }));
};

T.burnDemo = async ({ clean = 'clean', name = 'final', lines, style, W, H, cancelAt = 0 }) => {
  const ctl = new AbortController();
  const progress = [];
  try {
    const res = await R.burnSubtitles({
      clean: T.blobs[clean], lines, style, W, H, signal: ctl.signal,
      onProgress: (p) => { progress.push(p); if (cancelAt && p.frame >= cancelAt) ctl.abort(); },
    });
    T.blobs[name] = res.blob;
    return { ok: true, codecs: res.codecs, burned: res.burned, subsFallback: res.subsFallback, seconds: res.seconds, ms: res.ms, size: res.blob.size, same: res.blob === T.blobs[clean], progress: progress.length, lastProgress: progress[progress.length - 1] };
  } catch (e) {
    return { ok: false, error: { name: e.name, message: e.message }, progress: progress.length };
  }
};

T.safeRect = (style, W, H) => SS.safeRect(SS.normalizeStyle(style, { w: W, h: H }), W, H);

// ---------- ⑤ 미리보기 ----------
T.previewProbe = async () => {
  const W = 480;
  const H = 270;
  const seconds = 5;
  const total = seconds * 24;
  const cam = X.normalizeCamera({ move: 'pan_right' }, []);
  const mk = (i, N) => ({ shot: i + 1, frames: N, camera: cam, fx: [], exposure: [{ drawing: 'A', frames: N }], drawings: [{ id: 'A' }], motion: false, highlight: false });
  const xs = { fps: 24, totalFrames: total, layers: true, shots: [mk(0, 60), mk(1, 60)], transitions: [{ type: 'fade', xfade: 'fade', duration: 0.5, frames: 12 }] };
  const mats = await T.demoMaterials(xs, W, H);
  const comp = R.createCompositor({ xs, W, H, materials: mats });
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const out = {};
  // (1) 소리 없이 재생: 시계를 따라간다
  const pv = R.createPreview({ compositor: comp, canvas });
  const frames = [];
  pv.on('frame', (e) => frames.push(e.frame));
  const states = [];
  pv.on('state', (e) => states.push(e.state));
  const t0 = performance.now();
  await pv.play();
  await new Promise((r) => setTimeout(r, 1200));
  const elapsed = (performance.now() - t0) / 1000;
  pv.pause();
  const st1 = pv.getState();
  out.silent = { elapsed, last: st1.frame, drawn: st1.drawn, dropped: st1.dropped, monotonic: frames.every((f, i) => i === 0 || f > frames[i - 1]), states };
  // (2) 느린 컴퓨터: 한 장 그리는 데 70ms → 건너뛰지만 시계(프레임 번호)는 따라간다
  const slow = R.createPreview({ compositor: comp, canvas });
  const orig = comp.frameAt.bind(comp);
  comp.frameAt = (r, ctx, o) => { const t = performance.now(); while (performance.now() - t < 70) { /* 느린 폰 흉내 */ } return orig(r, ctx, o); };
  const t1 = performance.now();
  await slow.seekFrame(0);
  await slow.play();
  await new Promise((r) => setTimeout(r, 1500));
  const el2 = (performance.now() - t1) / 1000;
  slow.pause();
  const st2 = slow.getState();
  comp.frameAt = orig;
  out.slow = { elapsed: el2, last: st2.frame, drawn: st2.drawn, dropped: st2.dropped, expected: Math.floor(el2 * 24) };
  slow.dispose();
  // (3) 이동 · 끝에서 멈춤 · 작은 그림
  await pv.seekFrame(100);
  out.seek = { frame: pv.getState().frame };
  await pv.seekSeconds(1.5);
  out.seek2 = pv.getState().frame;
  const still2 = await pv.renderStill(81, { width: 100 });
  out.still2 = { type: still2.type, size: still2.size };
  const still = await R.renderStill(comp, 80, { width: 160 });
  const bmp = await createImageBitmap(still);
  out.still = { type: still.type, size: still.size, w: bmp.width, h: bmp.height };
  const ended = [];
  pv.on('end', (e) => ended.push(e.frame));
  await pv.seekFrame(total - 6);
  await pv.play();
  await new Promise((r) => setTimeout(r, 600));
  out.end = { ended, state: pv.getState().state, frame: pv.getState().frame };
  // (4) 소리와 맞추기: <audio> 가 기준 시계
  const wav = await R.demoSong({ seconds, bpm: 120 });
  const audio = new Audio(URL.createObjectURL(wav));
  audio.preload = 'auto';
  const pva = R.createPreview({ compositor: comp, canvas, audioEl: audio });
  await pva.seekFrame(0);
  await pva.play();
  await new Promise((r) => setTimeout(r, 1200));
  const sa = pva.getState();
  out.audio = { silent: sa.silent, audioTime: audio.currentTime, paused: audio.paused, frame: sa.frame, drift: Math.abs(audio.currentTime - sa.frame / 24) };
  pva.dispose();
  out.audio.pausedAfterDispose = audio.paused;
  pv.dispose();
  comp.release();
  out.open = T.openCount();
  canvas.remove();
  return out;
};

// ---------- ⑥ 연습용 그림 · 글꼴 ----------
T.demoProbe = async () => {
  const out = {};
  const dec = async (blob) => { const b = await createImageBitmap(blob); const c = new OffscreenCanvas(b.width, b.height); const x = c.getContext('2d'); x.drawImage(b, 0, 0); return { w: b.width, h: b.height, data: x.getImageData(0, 0, b.width, b.height).data }; };
  const bg1 = await R.demoBg({ W: 640, H: 360, shot: 1, seed: 3 });
  const bg1b = await R.demoBg({ W: 640, H: 360, shot: 1, seed: 3 });
  const bg2 = await R.demoBg({ W: 640, H: 360, shot: 2, seed: 3 });
  out.bg = { type: bg1.type, same: (await T.sha1(bg1)) === (await T.sha1(bg1b)), differsByShot: (await T.sha1(bg1)) !== (await T.sha1(bg2)) };
  const d = await dec(bg1);
  out.bg.size = [d.w, d.h];
  const cels = [];
  for (let i = 0; i < 4; i++) cels.push(await R.demoCel({ W: 640, H: 360, shot: 1, index: i, count: 4, motion: true }));
  const c0 = await dec(cels[0]);
  const key = [c0.data[0], c0.data[1], c0.data[2]];
  const keyed = KC.keyCel(c0.data, c0.w, c0.h, {});
  out.cel = { key, ok: keyed.ok, bgFraction: keyed.bgFraction, distinct: new Set(await Promise.all(cels.map(T.sha1))).size };
  const magenta = await dec(await R.demoCel({ W: 64, H: 36, palette: [{ hex: '#22aa33' }] }));
  out.cel.magentaKey = [magenta.data[0], magenta.data[1], magenta.data[2]];
  const full = await dec(await R.demoDrawing({ W: 640, H: 360, shot: 1, index: 0, count: 1 }));
  out.drawing = { size: [full.w, full.h], border: [full.data[0], full.data[1], full.data[2]] };
  out.refs = {};
  for (const kind of ['turnaround', 'expressions', 'fullbody']) { const b = await R.demoCharacterRef({ kind, W: 768, H: 512 }); out.refs[kind] = { type: b.type, size: b.size }; }
  return out;
};

T.fontProbe = async () => {
  const out = {};
  out.jua = await R.ensureSubtitleFonts({ font: 'jua' }, '안녕하세요 반짝이는 우리 꿈이');
  out.pretendard = await R.ensureSubtitleFonts({ font: 'pretendard' }, '안녕하세요');
  out.system = await R.ensureSubtitleFonts({ font: 'system' }, '안녕하세요');
  const orig = document.fonts.load.bind(document.fonts);
  document.fonts.load = async () => { throw new Error('글꼴 파일이 없어요'); };
  const fakeStyle = { font: 'dohyeon' };
  out.failed = await R.ensureSubtitleFonts(fakeStyle, '안녕');
  document.fonts.load = orig;
  return out;
};

window.__harnessReady = true;
