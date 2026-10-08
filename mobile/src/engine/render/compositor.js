// 그림 합성기 (Canvas2D): 타임시트 + 그림 → 24fps 한 장씩.  PC 앱 media/render.js renderShot + assemble.js 의 xfade 이어붙이기를 폰에서 같은 산수로 한다.
//
//   const comp = createCompositor({ xs, W, H, materials, finish, seed });
//   await comp.prepare(r);          // r 번째 장에 필요한 컷(과 전환 이웃)의 그림을 읽어 둔다 (한 번에 컷 2개까지만 메모리에)
//   comp.frameAt(r, ctx);           // r 번째 장을 W×H 컨텍스트에 그린다 (동기, 읽어 둔 그림만으로 정해진다)
//   comp.release();                 // 읽어 둔 그림을 모두 닫는다
//
// 한 장을 그리는 순서 (PC 와 같다):
//   ① frames.js 가 r → (컷, 컷 안 프레임 f, 조각 번호 rr, 전환 진행도 p) 를 정한다 (lead/tail · 짝수 전환 · 경계 가운데 겹침).
//   ② 컷 안에서: 그림 id = 노출표[f] (사이 그림 'A~B' 가 있으면 그것), 카메라 = cameraAt(cam, f/(N-1)), 흔들기 = rand(seed, floor(rr/2), 3|4),
//      배경 = parallaxFraming(0.8) + 흔들기만, 인물 셀 = 라인 보일(2프레임마다 ±0.55px · 확대 ±0.125%, rand 채널 1·2·5) 까지.
//   ③ 원본 창(렌더 코어 cameraRect)대로 ctx.drawImage(판, x0, y0, winW, winH, 0, 0, W, H) — 판은 화면 비율에 꽉 채운(cover) cw×ch.
//   ④ 효과(반짝임 · 번쩍 · 페이드) → (전환 중이면 두 컷을 섞기) → 필름 느낌 마무리.
//   ⑤ 이전 장과 "키"가 같으면 다시 그리지 않는다 (같은 컨텍스트에 이어서 그릴 때. 사이에 다른 것을 그렸다면 invalidate() 또는 {fresh:true}).
//
// materials 약속 (C2b 가 만든다):
//   materials.shot(i) → Promise<{ bg: ImageBitmap|null, layers: Map<id, ImageBitmap|null> | {id: bitmap} }>
//     - i 는 xs.shots 의 0부터 번호. xs.layers 가 참이면 layers 는 배경을 뺀 투명 셀(미리 곱한 알파 RGBA) · 아니면 통째 그림. bg 는 배경 판(투명 없음).
//     - 사이 그림은 id 'A~B' (xsheet.pairKey) 로 같은 layers 에 넣는다. 없으면 없는 것 (A 를 붙든다).
//     - 그림이 없는 칸(null)은 여기서 대신하지 않는다: 셀이면 투명(배경만), 통째 그림이면 짙은 보라 빈 카드. 이웃 그림으로 "대신하기"는 materials 몫이다.
//     - **돌려준 비트맵의 주인은 합성기다.** 합성기가 판으로 바꾸고 원본을 close() 한다. 같은 비트맵을 다른 곳에서 계속 쓸 거면 복사본을 주자.
//   materials.close?(i) → 합성기가 컷 i 를 놓은 뒤 부른다 (자기 쪽 캐시를 비우라는 알림).

import X from '../../../../src/main/pipeline/xsheet.js';
import RC from '../../../../src/main/media/render-core.js';
import { buildLayout, frameInfo, shotsForFrame, shotsForRange } from './frames.js';
import { drawTransition } from './transitions.js';
import { createFinish, normalizeFinish } from './finish.js';
import { makeCanvas, frameContext } from './util.js';

const { rand, parallaxFraming, coverSize, cameraRect, fxState } = RC;
const { cameraAt, expandExposure, pairKey } = X;

const BLANK_CARD = '#2a2440'; // 그림이 없을 때 (PC: 42,36,64)
const PAPER_BG = '#f4ecd8'; // 배경 판이 하나도 없을 때 (PC: blank_bg.png)
const DEFAULT_CAMERA = Object.freeze({ move: 'hold', start: { zoom: 1, x: 0, y: 0 }, end: { zoom: 1, x: 0, y: 0 }, ease: 'linear' });

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sizeOf = (s) => ({ w: s.width || s.naturalWidth || s.videoWidth || 0, h: s.height || s.naturalHeight || s.videoHeight || 0 });
const hasImage = (s) => !!s && sizeOf(s).w > 0 && sizeOf(s).h > 0;
const closeImage = (s) => { try { if (s && typeof s.close === 'function') s.close(); } catch (_) { /* 이미 닫힘 */ } };

/** 컷의 판 크기: 카메라가 가장 크게 확대하는 만큼 크게 펼친다 (render-core.coverSize 와 같다) */
export function plateSizeFor(shot, W, H) {
  const { S, cw, ch } = coverSize((shot && shot.camera) || DEFAULT_CAMERA, W, H);
  return { S, cw, ch };
}

/** 컷 하나를 읽어 두는 데 드는 메모리(바이트) 어림: (그림 수 + 배경) × cw × ch × 4 */
export function estimateShotBytes(shot, W, H, drawingCount = null) {
  const { cw, ch } = plateSizeFor(shot, W, H);
  const n = drawingCount == null ? ((shot.drawings && shot.drawings.length) || 1) : drawingCount;
  return (n + 1) * cw * ch * 4;
}

/**
 * 반짝임 별 점들 [x, y, 세기, x, y, 세기, …] — render-core.drawSparkles 와 똑같은 계산 (같은 난수 · 같은 순서).
 * 테스트가 drawSparkles 결과와 같은지 맞춰 본다.
 */
export function sparkleList(W, H, seed, r) {
  const out = [];
  const u = Math.max(3, Math.round(Math.min(W, H) / 90));
  for (let i = 0; i < 22; i++) {
    const px = Math.floor(rand(seed, i, 11) * W);
    const py = Math.floor(rand(seed, i, 12) * H * 0.85);
    const tw = Math.sin(r * 0.45 + rand(seed, i, 13) * 6.283);
    if (tw <= 0.1) continue;
    const len = Math.round(u * (1 + 2 * tw));
    for (let d = -len; d <= len; d++) {
      const a = (1 - Math.abs(d) / (len + 1)) * tw * 0.9;
      const xs = [px + d, px];
      const ys = [py, py + d];
      for (let q = 0; q < 2; q++) {
        if (xs[q] < 0 || ys[q] < 0 || xs[q] >= W || ys[q] >= H) continue;
        out.push(xs[q], ys[q], a);
      }
    }
  }
  return out;
}

const sparkleStyles = [];
function sparkleStyle(a) {
  const q = Math.max(0, Math.min(255, Math.round(a * 255)));
  return sparkleStyles[q] || (sparkleStyles[q] = `rgba(255,250,210,${(q / 255).toFixed(4)})`);
}

/**
 * @param {{xs:object, W:number, H:number, materials:{shot:(i:number)=>Promise<any>, close?:(i:number)=>void}, finish?:object, seed?:number, parallax?:number,
 *          quality?:'high'|'medium'|'low', createCanvas?:(w:number,h:number)=>any}} o
 *   finish: { boil, vignette, warm, grain, paper } (기본: boil·vignette·warm 켬, grain·paper 끔)
 *   quality: ctx.imageSmoothingQuality (기본 'high'). 'low' 는 쌍선형이라 PC 앱(sampleFrame)과 같은 보간이고 소프트웨어 래스터에서 더 빠르다 (미리보기용).
 */
export function createCompositor({ xs, W, H, materials, finish, seed = 1, parallax = 0.8, quality = 'high', createCanvas = makeCanvas }) {
  if (!xs || !Array.isArray(xs.shots) || !xs.shots.length) throw new Error('타임시트에 컷이 없어요');
  if (!(W > 0) || !(H > 0)) throw new Error('영상 크기가 올바르지 않아요');
  const layout = buildLayout(xs);
  const layered = !!xs.layers;
  const flags = normalizeFinish(finish);
  const fin = createFinish({ W, H, finish: flags, seed, makeCanvas: createCanvas });
  const loaded = new Map(); // 컷 번호 → 읽어 둔 것
  const loading = new Map(); // 컷 번호 → Promise
  const warnings = [];
  const stats = { frames: 0, drawn: 0, reused: 0, transitions: 0, missing: 0, loads: 0, drops: 0 };
  let generation = 0;
  let prepareToken = 0;
  let scratch = null; // 판 만들 때 쓰는 캔버스
  let tA = null;
  let tB = null;
  let lastCtx = null;
  let lastKey = null;
  let wanted = new Set(); // prefetch() 가 미리 읽어 두라고 한 컷 (prepare 가 놓지 않는다)

  const seedOf = (i) => (seed || 1) * 7919 + layout.spans[i].shot;

  // ---------- 읽기 / 놓기 ----------
  /** 원본 비트맵 → 컷의 판(cw×ch, 화면 비율에 꽉 채움). 크기가 이미 맞으면 그대로 쓴다. 원본은 합성기가 주인이라 바꾸고 닫는다 */
  async function toPlate(src, cw, ch) {
    const { w, h } = sizeOf(src);
    if (w === cw && h === ch) return src;
    if (!scratch) scratch = createCanvas(cw, ch);
    if (scratch.width !== cw) scratch.width = cw;
    if (scratch.height !== ch) scratch.height = ch;
    const cx = scratch.getContext('2d');
    cx.clearRect(0, 0, cw, ch);
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    const s = Math.max(cw / w, ch / h);
    const dw = w * s;
    const dh = h * s;
    cx.drawImage(src, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
    const plate = typeof scratch.transferToImageBitmap === 'function' ? scratch.transferToImageBitmap() : await createImageBitmap(scratch);
    closeImage(src);
    return plate;
  }

  async function loadShot(i) {
    const gen = generation;
    const shot = xs.shots[i];
    const { cw, ch } = plateSizeFor(shot, W, H);
    const mats = (await materials.shot(i)) || {};
    const getLayer = (id) => {
      const L = mats.layers;
      if (!L) return null;
      return L instanceof Map ? L.get(id) : L[id];
    };
    const originals = new Set();
    if (mats.bg) originals.add(mats.bg);
    if (mats.layers) for (const v of (mats.layers instanceof Map ? mats.layers.values() : Object.values(mats.layers))) if (v) originals.add(v);
    if (gen !== generation) { // 읽는 동안 release() 됐다
      originals.forEach(closeImage);
      try { if (materials.close) materials.close(i); } catch (_) { /* 알림일 뿐 */ }
      return null;
    }
    const has = (a, b) => hasImage(getLayer(pairKey(a, b)));
    let table = expandExposure(shot, has);
    const N = layout.spans[i].frames;
    if (table.length !== N) {
      warnings.push(`컷 ${layout.spans[i].shot}: 타임시트 프레임 합계(${table.length})가 컷 길이(${N})와 달라서 맞췄어요`);
      table = table.length > N ? table.slice(0, N) : table.concat(Array(N - table.length).fill(table[table.length - 1] || 'A'));
    }
    const plateOf = new Map(); // 원본 → 판 (같은 비트맵을 여러 id 가 쓰면 한 번만)
    const make = async (src) => {
      if (!hasImage(src)) return null;
      if (!plateOf.has(src)) plateOf.set(src, await toPlate(src, cw, ch));
      return plateOf.get(src);
    };
    const plates = new Map();
    for (const id of new Set(table)) plates.set(id, await make(getLayer(id)));
    const bg = layered ? await make(mats.bg) : null;
    // 판으로 쓰지 않은 원본(표에 없는 그림 · 사이 그림 · 안 쓰는 배경)은 닫는다
    const keep = new Set([...plateOf.values()]);
    for (const o of originals) if (!keep.has(o)) closeImage(o);
    if (gen !== generation) { // 판을 만드는 동안 release() 됐다
      keep.forEach(closeImage);
      try { if (materials.close) materials.close(i); } catch (_) { /* 알림일 뿐 */ }
      return null;
    }
    let bytes = 0;
    for (const p of keep) { const s = sizeOf(p); bytes += s.w * s.h * 4; }
    stats.loads++;
    return { i, shot, cw, ch, S: cw / W, table, plates, bg, keep, bytes };
  }

  function ensure(i) {
    if (loaded.has(i)) return Promise.resolve(loaded.get(i));
    if (loading.has(i)) return loading.get(i);
    const p = loadShot(i).then((e) => {
      loading.delete(i);
      if (e) loaded.set(i, e);
      return e;
    }, (err) => {
      loading.delete(i);
      throw err;
    });
    loading.set(i, p);
    return p;
  }

  function drop(i) {
    const e = loaded.get(i);
    if (!e) return;
    loaded.delete(i);
    for (const p of e.keep) closeImage(p);
    e.plates.clear();
    stats.drops++;
    try { if (materials.close) materials.close(i); } catch (_) { /* 알림일 뿐 */ }
  }

  // ---------- 한 컷 조각 그리기 ----------
  /** 조각 r (컷 안 프레임 f) 의 그림 · 구도 · 흔들림 · 효과 세기 — 같은 값이면 같은 그림이다 */
  function stateOf(E, rr, f) {
    const shot = E.shot;
    const cam = shot.camera || DEFAULT_CAMERA;
    const N = layout.spans[E.i].frames;
    const sd = seedOf(E.i);
    const id = E.table[f];
    const base = cameraAt(cam, N > 1 ? f / (N - 1) : 0);
    const st = fxState(shot.fx || [], f, N);
    let sx = 0;
    let sy = 0;
    const amp = (cam.move === 'shake' ? (cam.shake || 0.012) : 0) + st.shake * 0.02;
    if (amp > 0) {
      const k = Math.floor(rr / 2);
      sx = (rand(sd, k, 3) - 0.5) * 2 * amp * W;
      sy = (rand(sd, k, 4) - 0.5) * 2 * amp * H;
    }
    let dx = sx;
    let dy = sy;
    let zoom = base.zoom;
    if (flags.boil) {
      const k = Math.floor(rr / 2);
      dx += (rand(sd, k, 1) - 0.5) * 1.1;
      dy += (rand(sd, k, 2) - 0.5) * 1.1;
      zoom = Math.max(1, zoom * (1 + (rand(sd, k, 5) - 0.5) * 0.0025));
    }
    const fr = { zoom, x: base.x, y: base.y };
    const bfr = layered ? parallaxFraming(base, parallax) : null;
    const key = `${E.i}|${id}|${fr.zoom.toFixed(5)}|${fr.x.toFixed(5)}|${fr.y.toFixed(5)}|${dx.toFixed(3)}|${dy.toFixed(3)}|${bfr ? `${bfr.zoom.toFixed(5)}|${sx.toFixed(3)}|${sy.toFixed(3)}` : ''}|${st.fade.toFixed(3)}|${st.flash.toFixed(3)}|${st.sparkle ? rr : ''}`;
    return { id, fr, dx, dy, bfr, sx, sy, st, sd, rr, key };
  }

  /** 판에서 원본 창을 잘라 W×H 로 (render-core.cameraRect 의 창, 가장자리 안으로 밀어 넣음) */
  function drawPlate(ctx, E, img, fr, dx, dy, copy) {
    const w = cameraRect(E.cw, E.ch, W, H, fr, dx, dy);
    const x0 = clamp(w.x0, 0, Math.max(0, E.cw - w.winW));
    const y0 = clamp(w.y0, 0, Math.max(0, E.ch - w.winH));
    ctx.globalCompositeOperation = copy ? 'copy' : 'source-over';
    ctx.drawImage(img, x0, y0, w.winW, w.winH, 0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawSparkles(ctx, sd, rr) {
    const list = sparkleList(W, H, sd, rr);
    for (let q = 0; q < list.length; q += 3) {
      ctx.fillStyle = sparkleStyle(list[q + 2]);
      ctx.fillRect(list[q], list[q + 1], 1, 1);
    }
  }

  function paintClip(ctx, E, s) {
    ctx.globalAlpha = 1;
    if (layered) {
      if (E.bg) drawPlate(ctx, E, E.bg, s.bfr, s.sx, s.sy, true);
      else { ctx.fillStyle = PAPER_BG; ctx.fillRect(0, 0, W, H); }
      const cel = E.plates.get(s.id);
      if (cel) drawPlate(ctx, E, cel, s.fr, s.dx, s.dy, false);
    } else {
      const pic = E.plates.get(s.id);
      if (pic) drawPlate(ctx, E, pic, s.fr, s.dx, s.dy, true);
      else { ctx.fillStyle = BLANK_CARD; ctx.fillRect(0, 0, W, H); }
    }
    const st = s.st;
    if (st.sparkle) drawSparkles(ctx, s.sd, s.rr);
    if (st.flash > 0) { ctx.fillStyle = `rgba(255,255,255,${Math.min(1, st.flash).toFixed(4)})`; ctx.fillRect(0, 0, W, H); }
    if (st.fade < 1) { ctx.fillStyle = `rgba(0,0,0,${(1 - Math.max(0, st.fade)).toFixed(4)})`; ctx.fillRect(0, 0, W, H); }
  }

  function scratchCtx(which) {
    if (which === 'A') {
      if (!tA) tA = frameContext(createCanvas(W, H));
      return tA;
    }
    if (!tB) tB = frameContext(createCanvas(W, H));
    return tB;
  }

  function drawMissing(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = BLANK_CARD;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // ---------- 바깥으로 내보내는 것 ----------
  const api = {
    W,
    H,
    fps: layout.fps,
    totalFrames: layout.total,
    layout,
    finish: fin.flags,
    warnings,
    stats,

    /** r 번째 장(과 앞으로 ahead 장)에 필요한 컷 그림을 읽어 둔다. 필요 없는 컷은 놓는다 (메모리 아낌) */
    async prepare(r, o = {}) {
      const ahead = Math.max(0, Math.floor(o.ahead || 0));
      const need = ahead ? shotsForRange(layout, r, r + ahead) : shotsForFrame(layout, r);
      const token = ++prepareToken;
      const gen = generation;
      await Promise.all(need.map(ensure));
      for (const i of need) wanted.delete(i); // 미리 읽은 컷이 이제 쓰인다
      if (o.evict !== false && token === prepareToken && gen === generation) {
        const keep = new Set([...need, ...wanted]);
        for (const i of [...loaded.keys()]) if (!keep.has(i) && !loading.has(i)) drop(i);
      }
    },

    /**
     * (기다리지 않는다) r 번째 장 다음에 필요해질 컷이 곧(aheadFrames 장 안) 시작하면 미리 읽기 시작한다 — 인코딩하는 동안 다음 컷의 그림을 읽을 수 있다.
     * 지금 필요한 컷 + 미리 읽는 컷 하나까지만 메모리에 둔다 (컷이 아주 짧으면 그 이상일 수 있다).
     */
    prefetch(r, aheadFrames = 48) {
      const now = shotsForFrame(layout, r);
      const nx = Math.max(...now) + 1;
      if (nx >= layout.spans.length || layout.spans[nx].clipStart - r > aheadFrames) return;
      wanted = new Set([nx]); // 예전에 부탁한 컷은 더 지키지 않는다 (이동해서 안 쓰게 된 것이 메모리에 남지 않게)
      if (loaded.has(nx) || loading.has(nx)) return;
      ensure(nx).catch(() => { wanted.delete(nx); }); // 실패는 prepare 가 그 컷을 읽을 때 다시 던진다
    },

    /** r 번째 장에 필요한 그림이 다 읽혀 있나 (동기) */
    isReady(r) {
      return shotsForFrame(layout, r).every((i) => loaded.has(i));
    },

    /** 읽혀 있는 컷 번호들 (진단·시험용) */
    loadedShots() {
      return [...loaded.keys()].sort((a, b) => a - b);
    },
    loadedBytes() {
      let n = 0;
      for (const e of loaded.values()) n += e.bytes;
      return n;
    },

    /** 직전 장을 다시 그리지 않고 재사용해도 되는 상태를 잊는다 (같은 컨텍스트에 다른 것을 그렸을 때) */
    invalidate() {
      lastCtx = null;
      lastKey = null;
    },

    /**
     * r 번째 장(0부터, 정수)을 ctx(W×H)에 그린다. 동기. 읽어 두지 않은 컷이 필요하면 빈 카드를 그리고 {missing:true} 를 돌려준다.
     * @returns {{frame:number, kind:'single'|'transition', reused:boolean, missing:boolean}}
     */
    frameAt(r, ctx, o = {}) {
      stats.frames++;
      const fi = frameInfo(layout, r);
      const R = fi.R;
      const ea = loaded.get(fi.a.i);
      const eb = fi.kind === 'transition' ? loaded.get(fi.b.i) : null;
      if (!ea || (fi.kind === 'transition' && !eb)) {
        stats.missing++;
        drawMissing(ctx);
        lastCtx = null;
        lastKey = null;
        return { frame: R, kind: fi.kind, reused: false, missing: true };
      }
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = quality;
      let reused = false;
      if (fi.kind === 'single') {
        const s = stateOf(ea, fi.a.r, fi.a.f);
        const canReuse = !o.fresh && !flags.grain && lastCtx === ctx && lastKey === s.key;
        if (canReuse) {
          reused = true;
          stats.reused++;
        } else {
          paintClip(ctx, ea, s);
          fin.apply(ctx, R);
          stats.drawn++;
        }
        lastCtx = ctx;
        lastKey = s.key;
      } else {
        const ca = scratchCtx('A');
        const cb = scratchCtx('B');
        ca.imageSmoothingQuality = quality;
        cb.imageSmoothingQuality = quality;
        paintClip(ca, ea, stateOf(ea, fi.a.r, fi.a.f));
        paintClip(cb, eb, stateOf(eb, fi.b.r, fi.b.f));
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        drawTransition(ctx, fi.tr.xfade, ca.canvas, cb.canvas, fi.tr.p, W, H);
        fin.apply(ctx, R);
        stats.drawn++;
        stats.transitions++;
        lastCtx = null;
        lastKey = null;
      }
      ctx.restore();
      return { frame: R, kind: fi.kind, reused, missing: false };
    },

    /** 읽어 둔 그림을 모두 닫는다. 이어서 prepare() 하면 다시 읽는다 */
    release() {
      generation++;
      for (const i of [...loaded.keys()]) drop(i);
      wanted = new Set();
      scratch = null;
      tA = null;
      tB = null;
      lastCtx = null;
      lastKey = null;
      fin.dispose();
    },
  };
  return api;
}
