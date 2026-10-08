'use strict';
// 렌더링 합성기의 '순수 계산' 부분: 카메라 창 계산 · 샘플링 · 효과 · 합성. 파일·ffmpeg 를 쓰지 않는다.
//  - PC 앱(media/render.js 의 renderShot)과 폰 앱(안드로이드 WebView, esbuild 묶음)이 같은 파일을 쓴다 (scripts/shared-modules.js).
//    fs / path / ffmpeg / Buffer 를 쓰지 않는다 (test/shared-purity.test.js 가 지킨다). 픽셀 배열은 Uint8Array · Uint8ClampedArray 모두 된다.
//  - 순수 함수: rand, parallaxFraming, coverSize, cameraRect, cameraWindow, blankImage, sampleFrame, fxState, drawSparkles, applyFx, composite.
//  - 폰의 Canvas2D 합성기는 cameraRect / cameraWindow 가 돌려주는 원본 창으로 ctx.drawImage(img, x0, y0, winW, winH, 0, 0, W, H) 를 불러
//    sampleFrame 과 같은 화면을 만든다. sampleFrame·composite·applyFx 는 GPU 가 없을 때 쓰는 (PC 와 똑같은 결과의) CPU 대체 경로다.
//  - 그림 파일 읽기(decodeCover)와 컷 영상 만들기(renderShot)는 ffmpeg·fs 가 필요해서 render.js 에 남아 있다. render.js 는 여기 이름을 그대로 다시 내보낸다.
//  - 멀티플레인: 배경(BG) 판과 인물 셀(투명)을 따로 놓고 겹친다. 카메라가 움직이면 배경은 인물보다
//    조금 덜 움직여서(기본 0.8배) 깊이가 느껴진다.
//  - 크게 펼친 그림 위에서 카메라를 움직인다 (팬·줌·트럭·흔들기). 좌표를 소수점까지 계산해서
//    움직임이 계단처럼 떨리지 않는다.
//  - 손그림 느낌: 2프레임마다 아주 살짝 흔들리는 '라인 보일'(인물 셀만), 효과(fx): 페이드·플래시·반짝임·충격 흔들림
const { cameraAt } = require('../pipeline/xsheet');

/** 같은 입력이면 늘 같은 값이 나오는 난수 (0~1) */
function rand(seed, k, ch) {
  let x = (Math.imul(seed | 0, 374761393) + Math.imul(k | 0, 668265263) + Math.imul(ch | 0, 2147483647)) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** 배경 판의 구도: 카메라보다 parallax 배만큼만 다가가고 움직인다 (같은 x·y 로 정확히 parallax 배 이동) */
function parallaxFraming(fr, parallax = 0.8) {
  return { zoom: 1 + (fr.zoom - 1) * parallax, x: fr.x, y: fr.y };
}

/**
 * 컷의 카메라가 가장 크게 확대하는 만큼 그림을 크게 펼쳐 둔 크기 (확대해도 흐려지지 않게).
 * 그림은 화면 비율에 맞춰 꽉 채우도록(cover) cw×ch 로 준비한다. renderShot 과 폰 합성기가 같은 크기를 쓴다.
 * @param {{start:{zoom:number},end:{zoom:number}}} cam shot.camera
 * @returns {{S:number,cw:number,ch:number}}
 */
function coverSize(cam, W, H) {
  const S = Math.max(1, cam.start.zoom, cam.end.zoom);
  return { S, cw: Math.round(W * S), ch: Math.round(H * S) };
}

/**
 * 카메라 구도 → 큰 그림(cw×ch)에서 잘라 낼 '원본 창'. sampleFrame 이 쓰는 식 그대로다 (소수점 포함).
 * Canvas2D 합성기: ctx.drawImage(img, x0, y0, winW, winH, 0, 0, W, H).
 * 흔들림(dx, dy) 때문에 창이 그림 가장자리를 조금 넘을 수 있다: sampleFrame 은 가장자리 픽셀을 늘려 채우고,
 * drawImage 는 넘친 만큼이 비므로 창을 [0,cw]×[0,ch] 안으로 밀어 넣어 쓴다.
 * @param {number} cw 큰 그림 너비 (coverSize 참고)
 * @param {number} ch 큰 그림 높이
 * @param {number} W 출력 너비
 * @param {number} H 출력 높이
 * @param {{zoom:number,x:number,y:number}} fr 구도 (zoom 1 = 그림 전체, x·y = -1~1)
 * @param {number} [dx] 출력 기준 픽셀 단위 흔들림 (가로)
 * @param {number} [dy] 출력 기준 픽셀 단위 흔들림 (세로)
 * @returns {{winW:number,winH:number,cx:number,cy:number,x0:number,y0:number,stx:number,sty:number}}
 *   winW×winH = 원본 창 크기, (cx, cy) = 창 가운데, (x0, y0) = 창 왼쪽 위, stx·sty = 출력 한 픽셀이 차지하는 원본 픽셀 수
 */
function cameraRect(cw, ch, W, H, fr, dx = 0, dy = 0) {
  const winW = cw / fr.zoom;
  const winH = ch / fr.zoom;
  const cx = cw / 2 + fr.x * (cw - winW) / 2 + dx * (winW / W);
  const cy = ch / 2 + fr.y * (ch - winH) / 2 + dy * (winH / H);
  const stx = winW / W;
  const sty = winH / H;
  const x0 = cx - winW / 2;
  const y0 = cy - winH / 2;
  return { winW, winH, cx, cy, x0, y0, stx, sty };
}

/**
 * 카메라 cam 의 컷 안 진행도 p(0~1) 에서의 원본 창 (cameraAt → 선택적 배경 시차 → cameraRect).
 * @param {object} cam shot.camera
 * @param {number} p 컷 안 진행도 0~1 (프레임 f 는 N > 1 ? f / (N - 1) : 0)
 * @param {{W:number,H:number,cw?:number,ch?:number,dx?:number,dy?:number,parallax?:number}} o
 *   cw·ch 를 안 주면 coverSize(cam, W, H). parallax 를 주면 배경 판의 구도(parallaxFraming, 보통 0.8)로 계산한다.
 * @returns {{fr:{zoom:number,x:number,y:number},cw:number,ch:number,winW:number,winH:number,cx:number,cy:number,x0:number,y0:number,stx:number,sty:number}}
 */
function cameraWindow(cam, p, o) {
  const size = o.cw && o.ch ? { cw: o.cw, ch: o.ch } : coverSize(cam, o.W, o.H);
  const base = cameraAt(cam, p);
  const fr = o.parallax == null ? base : parallaxFraming(base, o.parallax);
  return { fr, cw: size.cw, ch: size.ch, ...cameraRect(size.cw, size.ch, o.W, o.H, fr, o.dx || 0, o.dy || 0) };
}

/** 그림이 없을 때 쓰는 빈 카드 (짙은 보라) */
function blankImage(cw, ch) {
  const b = new Uint8Array(cw * ch * 3); // 0 으로 채워진 Uint8Array (Buffer.alloc 과 같다)
  for (let i = 0; i < b.length; i += 3) { b[i] = 42; b[i + 1] = 36; b[i + 2] = 64; }
  return b;
}

/**
 * 카메라 구도로 큰 그림의 한 부분을 잘라 출력 크기로 (쌍선형 보간, 고정소수점 2단계).
 * @param {Uint8Array|Uint8ClampedArray} src cw×ch RGB (chans 4 면 RGBA)
 * @param {{zoom:number,x:number,y:number}} fr 구도 (zoom 1 = 그림 전체)
 * @param {number} dx 출력 기준 픽셀 단위 흔들림
 * @returns {Uint8Array} W×H×chans (원본 창 계산은 cameraRect 를 그대로 쓴다)
 */
function sampleFrame(src, cw, ch, W, H, fr, dx = 0, dy = 0, chans = 3) {
  const out = new Uint8Array(W * H * chans); // Buffer.allocUnsafe 와 같은 잘림 규칙 (모든 칸을 아래에서 채운다)
  const { stx, sty, x0, y0 } = cameraRect(cw, ch, W, H, fr, dx, dy);
  const colI = new Int32Array(W);
  const colF = new Int32Array(W);
  for (let x = 0; x < W; x++) {
    let s = x0 + (x + 0.5) * stx - 0.5;
    if (s < 0) s = 0;
    if (s > cw - 1.001) s = cw - 1.001;
    const i = s | 0;
    colI[x] = i * chans;
    colF[x] = ((s - i) * 256) | 0;
  }
  const stride = cw * chans;
  const n = W * chans;
  let A = new Int32Array(n);
  let B = new Int32Array(n);
  let rowA = -1;
  let rowB = -1;
  const hrow = chans === 4 ? (sy, dst) => {
    const r = sy * stride;
    let k = 0;
    for (let x = 0; x < W; x++) {
      const p = r + colI[x];
      const f = colF[x];
      const g = 256 - f;
      dst[k++] = src[p] * g + src[p + 4] * f;
      dst[k++] = src[p + 1] * g + src[p + 5] * f;
      dst[k++] = src[p + 2] * g + src[p + 6] * f;
      dst[k++] = src[p + 3] * g + src[p + 7] * f;
    }
  } : (sy, dst) => {
    const r = sy * stride;
    let k = 0;
    for (let x = 0; x < W; x++) {
      const p = r + colI[x];
      const f = colF[x];
      const g = 256 - f;
      dst[k++] = src[p] * g + src[p + 3] * f;
      dst[k++] = src[p + 1] * g + src[p + 4] * f;
      dst[k++] = src[p + 2] * g + src[p + 5] * f;
    }
  };
  let o = 0;
  for (let y = 0; y < H; y++) {
    let s = y0 + (y + 0.5) * sty - 0.5;
    if (s < 0) s = 0;
    if (s > ch - 1.001) s = ch - 1.001;
    const sy = s | 0;
    const fy = ((s - sy) * 256) | 0;
    const gy = 256 - fy;
    if (sy !== rowA) {
      if (sy === rowB) { const t = A; A = B; B = t; rowA = rowB; rowB = -1; } else { hrow(sy, A); rowA = sy; }
    }
    if (sy + 1 !== rowB) { hrow(sy + 1, B); rowB = sy + 1; }
    for (let k = 0; k < n; k++) out[o++] = (A[k] * gy + B[k] * fy + 32768) >> 16;
  }
  return out;
}

/** 프레임 f(컷 안 번호) 에서의 효과 세기 */
function fxState(fx, f, N) {
  const st = { fade: 1, flash: 0, sparkle: fx.includes('sparkle'), shake: 0 };
  const len = Math.max(2, Math.min(18, Math.round(N / 4)));
  if (fx.includes('fade_in') && f < len) st.fade = Math.min(st.fade, (f + 1) / (len + 1));
  if (fx.includes('fade_out') && f >= N - len) st.fade = Math.min(st.fade, (N - f) / (len + 1));
  if (fx.includes('flash') && f < 8) st.flash = 0.85 * (1 - f / 8);
  if (fx.includes('shake') && f < 14) st.shake = 1 - f / 14;
  return st;
}

/** 반짝임: 작은 별들이 반짝반짝 (그림 위에 더하기) */
function drawSparkles(buf, W, H, seed, r) {
  const count = 22;
  const u = Math.max(3, Math.round(Math.min(W, H) / 90));
  for (let i = 0; i < count; i++) {
    const px = Math.floor(rand(seed, i, 11) * W);
    const py = Math.floor(rand(seed, i, 12) * H * 0.85);
    const tw = Math.sin(r * 0.45 + rand(seed, i, 13) * 6.283);
    if (tw <= 0.1) continue;
    const len = Math.round(u * (1 + 2 * tw));
    for (let d = -len; d <= len; d++) {
      const a = (1 - Math.abs(d) / (len + 1)) * tw * 0.9;
      for (const [x, y] of [[px + d, py], [px, py + d]]) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const p = (y * W + x) * 3;
        buf[p] = buf[p] + (255 - buf[p]) * a;
        buf[p + 1] = buf[p + 1] + (250 - buf[p + 1]) * a;
        buf[p + 2] = buf[p + 2] + (210 - buf[p + 2]) * a;
      }
    }
  }
}

function applyFx(buf, st, W, H, seed, r) {
  if (st.sparkle) drawSparkles(buf, W, H, seed, r);
  if (st.flash > 0) { const a = st.flash; for (let i = 0; i < buf.length; i++) buf[i] += (255 - buf[i]) * a; }
  if (st.fade < 1) { const a = Math.max(0, st.fade); for (let i = 0; i < buf.length; i++) buf[i] *= a; }
}

/** 미리 곱한 알파의 셀(RGBA)을 배경(RGB) 위에 얹는다 */
function composite(cel, bg, n) {
  const out = new Uint8Array(n * 3);
  const oc = new Uint8ClampedArray(out.buffer, out.byteOffset, out.length); // 합성 결과는 반올림해서 쓴다 (Uint8Array 로 바로 쓰면 잘라 버린다)
  for (let i = 0, j = 0; i < n * 4; i += 4, j += 3) {
    const ia = 255 - cel[i + 3];
    oc[j] = cel[i] + (bg[j] * ia + 127) / 255;
    oc[j + 1] = cel[i + 1] + (bg[j + 1] * ia + 127) / 255;
    oc[j + 2] = cel[i + 2] + (bg[j + 2] * ia + 127) / 255;
  }
  return out;
}

module.exports = {
  rand, parallaxFraming, coverSize, cameraRect, cameraWindow, blankImage, sampleFrame, fxState, drawSparkles, applyFx, composite,
};
