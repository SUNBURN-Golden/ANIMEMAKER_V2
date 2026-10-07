'use strict';
// 렌더링 합성기 (앱 안에 들어 있음, 따로 설치할 것 없음): 타임시트의 컷 하나 → 영상 조각.
//  - 타임시트대로 그림을 프레임 수만큼 보여 준다 (노출).
//  - 크게 펼친 그림 위에서 카메라를 움직인다 (팬·줌·트럭·흔들기). 좌표를 소수점까지 계산해서
//    움직임이 계단처럼 떨리지 않는다. 픽셀 계산은 앱이 직접 하고, 그림 읽기·영상 압축만 ffmpeg 가 한다.
//  - 손그림 느낌: 2프레임마다 아주 살짝 흔들리는 '라인 보일(필름 흔들림)', 효과(fx): 페이드·플래시·반짝임·충격 흔들림
const fs = require('fs');
const { runFfmpeg, ffmpegWriter } = require('./ffmpeg');
const { cameraAt, frameTable, FPS } = require('../pipeline/xsheet');

/** 같은 입력이면 늘 같은 값이 나오는 난수 (0~1) */
function rand(seed, k, ch) {
  let x = (Math.imul(seed | 0, 374761393) + Math.imul(k | 0, 668265263) + Math.imul(ch | 0, 2147483647)) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** 그림 파일 → 화면 비율에 맞춰 꽉 채운 RGB 픽셀 (cw×ch) */
async function decodeCover(file, cw, ch, signal) {
  const { stdout } = await runFfmpeg(['-i', file, '-frames:v', '1', '-vf',
    `scale=${cw}:${ch}:force_original_aspect_ratio=increase:flags=lanczos,crop=${cw}:${ch},format=rgb24`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { capture: 'stdout', signal });
  if (stdout.length < cw * ch * 3) throw new Error(`그림을 읽지 못했습니다: ${file}`);
  return stdout.subarray(0, cw * ch * 3);
}

/** 그림이 없을 때 쓰는 빈 카드 (짙은 보라) */
function blankImage(cw, ch) {
  const b = Buffer.alloc(cw * ch * 3);
  for (let i = 0; i < b.length; i += 3) { b[i] = 42; b[i + 1] = 36; b[i + 2] = 64; }
  return b;
}

/**
 * 카메라 구도로 큰 그림의 한 부분을 잘라 출력 크기로 (쌍선형 보간, 고정소수점 2단계).
 * @param {Buffer} src cw×ch RGB
 * @param {{zoom:number,x:number,y:number}} fr 구도 (zoom 1 = 그림 전체)
 * @param {number} dx 출력 기준 픽셀 단위 흔들림
 */
function sampleFrame(src, cw, ch, W, H, fr, dx = 0, dy = 0) {
  const out = Buffer.allocUnsafe(W * H * 3);
  const winW = cw / fr.zoom;
  const winH = ch / fr.zoom;
  const cx = cw / 2 + fr.x * (cw - winW) / 2 + dx * (winW / W);
  const cy = ch / 2 + fr.y * (ch - winH) / 2 + dy * (winH / H);
  const stx = winW / W;
  const sty = winH / H;
  const x0 = cx - winW / 2;
  const y0 = cy - winH / 2;
  const colI = new Int32Array(W);
  const colF = new Int32Array(W);
  for (let x = 0; x < W; x++) {
    let s = x0 + (x + 0.5) * stx - 0.5;
    if (s < 0) s = 0;
    if (s > cw - 1.001) s = cw - 1.001;
    const i = s | 0;
    colI[x] = i * 3;
    colF[x] = ((s - i) * 256) | 0;
  }
  const stride = cw * 3;
  const n = W * 3;
  let A = new Int32Array(n);
  let B = new Int32Array(n);
  let rowA = -1;
  let rowB = -1;
  const hrow = (sy, dst) => {
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

/**
 * 컷 하나 렌더링 → 영상 조각 (24fps, 프레임 수 = lead + 컷 프레임 + tail).
 * lead/tail 은 화면전환으로 앞뒤 컷과 겹치는 여분 프레임 (첫/마지막 구도를 유지).
 * @param {{shot:object, files:Map<string,string|null>, W:number, H:number, lead?:number, tail?:number,
 *          boil?:boolean, seed?:number, out:string, signal?:AbortSignal, onProgress?:(f:number)=>void}} o
 */
async function renderShot(o) {
  const { shot, files, W, H, out, signal } = o;
  const lead = o.lead || 0;
  const tail = o.tail || 0;
  const N = shot.frames;
  const total = lead + N + tail;
  const table = frameTable(shot);
  if (table.length !== N) throw new Error(`컷 ${shot.shot}: 타임시트 프레임 합계(${table.length})가 컷 길이(${N})와 달라요.`);
  const cam = shot.camera;
  const fx = shot.fx || [];
  const seed = (o.seed || 1) * 7919 + shot.shot;
  // 가장 크게 확대하는 만큼 그림을 크게 펼쳐 둔다 (확대해도 흐려지지 않게)
  const S = Math.max(1, cam.start.zoom, cam.end.zoom);
  const cw = Math.round(W * S);
  const ch = Math.round(H * S);
  const imgs = new Map();
  for (const id of new Set(table)) {
    const f = files.get(id);
    imgs.set(id, f && fs.existsSync(f) ? await decodeCover(f, cw, ch, signal) : blankImage(cw, ch));
  }
  const enc = ffmpegWriter(['-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(FPS), '-i', 'pipe:0',
    '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-r', String(FPS), out], { signal });
  let prevKey = '';
  let prevBuf = null;
  try {
    for (let r = 0; r < total; r++) {
      const f = Math.min(N - 1, Math.max(0, r - lead));
      const id = table[f];
      const fr = cameraAt(cam, N > 1 ? f / (N - 1) : 0);
      const st = fxState(fx, f, N);
      let dx = 0;
      let dy = 0;
      if (o.boil) {
        // 2프레임마다 바뀌는 아주 작은 흔들림과 크기 떨림 (손으로 찍은 셀 애니의 '라인 보일' 느낌)
        const k = Math.floor(r / 2);
        dx += (rand(seed, k, 1) - 0.5) * 1.1;
        dy += (rand(seed, k, 2) - 0.5) * 1.1;
        fr.zoom = Math.max(1, fr.zoom * (1 + (rand(seed, k, 5) - 0.5) * 0.0025));
      }
      const amp = (cam.move === 'shake' ? (cam.shake || 0.012) : 0) + st.shake * 0.02;
      if (amp > 0) {
        const k = Math.floor(r / 2);
        dx += (rand(seed, k, 3) - 0.5) * 2 * amp * W;
        dy += (rand(seed, k, 4) - 0.5) * 2 * amp * H;
      }
      const key = `${id}|${fr.zoom.toFixed(5)}|${fr.x.toFixed(5)}|${fr.y.toFixed(5)}|${dx.toFixed(3)}|${dy.toFixed(3)}|${st.fade.toFixed(3)}|${st.flash.toFixed(3)}|${st.sparkle ? r : ''}`;
      let buf = prevBuf;
      if (key !== prevKey) {
        buf = sampleFrame(imgs.get(id), cw, ch, W, H, fr, dx, dy);
        applyFx(buf, st, W, H, seed, r);
      }
      await enc.write(buf);
      prevKey = key;
      prevBuf = buf;
      if (o.onProgress && r % 24 === 0) o.onProgress(r / total);
    }
  } finally {
    await enc.end();
  }
  return { file: out, frames: total };
}

module.exports = { renderShot, sampleFrame, decodeCover, fxState, rand };
