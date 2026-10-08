'use strict';
// 셀(인물 그림) 배경 빼기 · 색 맞추기의 '순수 계산' 부분: RGBA 배열만 받고 돌려준다.
//  - PC 앱(media/keyer.js)과 폰 앱(안드로이드 WebView, esbuild 묶음)이 같은 파일을 쓴다 (scripts/shared-modules.js).
//    fs / path / ffmpeg / Buffer 를 쓰지 않는다 (test/shared-purity.test.js 가 지킨다). 입력 배열은 Uint8Array · Uint8ClampedArray 모두 된다.
//  - 순수 함수: hexToRgb, rgbToHex, hsv, keyColorFor, keyName, median, keyCel, hasRealAlpha, colorStats, stabilizeColors, overKey, celDifference
//    (상수 KEY_GREEN, KEY_MAGENTA, HARD, SOFT, KEY_DRIFT 포함).
//  - 파일 읽기·쓰기(readRgba, writePng, processCel, exists)는 ffmpeg 가 필요해서 keyer.js 에 남아 있다. keyer.js 는 여기 이름을 그대로 다시 내보낸다.
//  - 그림 AI 에게 '단색 배경(초록 #00FF00, 팔레트에 초록이 있으면 마젠타 #FF00FF)' 위에 인물만 그리게 하고,
//    여기서 그 배경을 지워 투명한 셀(RGBA)로 만든다.
//  - 배경색은 정해 둔 색이 아니라 '그림 가장자리의 실제 색(중앙값)' 으로 잡는다 (AI 가 살짝 다른 초록을 써도 됨).
//  - 가장자리에서부터 비슷한 색만 이어서 지운다(flood fill) → 눈동자처럼 인물 안에 갇힌 초록은 남는다.
//  - 경계는 부드럽게(소프트 매트), 배경색이 번진 테두리는 원래 색으로 되돌린다(디스필).
//  - 같은 컷의 셀끼리 색이 깜빡이지 않게 첫 셀의 평균·분산에 60% 정도 맞춘다.

const KEY_GREEN = '#00ff00';
const KEY_MAGENTA = '#ff00ff';
const HARD = 90; // 이보다 가까우면 배경 (RGB 거리, 최대 441)
const SOFT = 175; // 이보다 멀면 인물. 사이는 반투명
const KEY_DRIFT = 160; // 가장자리 색이 부탁한 배경색에서 이만큼까지 달라도 배경으로 본다 (AI 가 살짝 다른 초록을 써도 됨)

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(c) {
  return `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

function hsv(r, g, b) {
  const mx = Math.max(r, g, b) / 255;
  const mn = Math.min(r, g, b) / 255;
  const d = mx - mn;
  let hh = 0;
  if (d > 0) {
    if (mx === r / 255) hh = ((g - b) / 255 / d) % 6;
    else if (mx === g / 255) hh = (b - r) / 255 / d + 2;
    else hh = (r - g) / 255 / d + 4;
  }
  return { h: (hh * 60 + 360) % 360, s: mx ? d / mx : 0, v: mx };
}

/** 캐릭터 팔레트에 초록 계열이 있으면 마젠타, 아니면 초록을 배경색으로 쓴다 */
function keyColorFor(palette = []) {
  const hasGreen = palette.some((p) => {
    const c = hexToRgb(p && p.hex);
    if (!c) return false;
    const { h, s, v } = hsv(...c);
    return h >= 70 && h <= 170 && s >= 0.25 && v >= 0.2;
  });
  return hasGreen ? KEY_MAGENTA : KEY_GREEN;
}

function keyName(hex) {
  return String(hex).toLowerCase() === KEY_MAGENTA ? 'magenta' : 'green';
}

function median(arr) {
  const a = Float64Array.from(arr).sort();
  return a.length ? a[a.length >> 1] : 0;
}

/**
 * 배경 빼기 (순수 계산). px 는 RGBA (알파는 무시).
 * @param {{keyColor?:string, expect?:string, spill?:boolean, global?:boolean}} [opts] keyColor 를 주면 그 색을 정확히 배경으로 본다 (사이 그림 다시 빼기용)
 *   expect: 부탁한 배경색. 가장자리 색이 이것과 너무 다르면 빼지 않는다
 *   spill: 배경에 이어진 '배경색이 섞인 얼룩' 까지 반투명으로 (사이 그림용)
 *   global: 정확한 배경색은 이어져 있지 않아도 지운다 (사이 그림용)
 * @returns {{ok:boolean, reason?:string, alpha?:Uint8Array, rgba?:Uint8ClampedArray, key?:number[], bgFraction?:number}}
 */
function keyCel(px, w, h, opts = {}) {
  const n = w * h;
  // 1) 가장자리 2픽셀의 색 → 배경색 (중앙값)
  const border = [];
  const bw = Math.min(2, Math.floor(Math.min(w, h) / 4) || 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= bw && x < w - bw && y >= bw && y < h - bw) { x = w - bw - 1; continue; }
      border.push(y * w + x);
    }
  }
  const key = opts.keyColor ? hexToRgb(opts.keyColor) : [0, 1, 2].map((c) => median(border.map((i) => px[i * 4 + c])));
  const dist = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dr = px[i * 4] - key[0];
    const dg = px[i * 4 + 1] - key[1];
    const db = px[i * 4 + 2] - key[2];
    dist[i] = Math.sqrt(dr * dr + dg * dg + db * db);
  }
  const uniform = border.filter((i) => dist[i] < HARD).length / border.length;
  if (uniform < 0.6) return { ok: false, reason: 'border', key };
  // 부탁한 배경색(초록/마젠타)과 너무 다르면 (예: 하늘이 있는 전체 그림) 빼지 않는다
  const want = opts.expect ? hexToRgb(opts.expect) : null;
  if (want && Math.hypot(key[0] - want[0], key[1] - want[1], key[2] - want[2]) > KEY_DRIFT) return { ok: false, reason: 'notkey', key };
  // 2) 가장자리에서 비슷한 색만 이어서 채우기 (4방향)
  const bg = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  for (const i of border) if (dist[i] < HARD && !bg[i]) { bg[i] = 1; stack[sp++] = i; }
  let filled = sp;
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % w;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w];
    for (const j of nb) {
      if (j < 0 || j >= n || bg[j] || dist[j] >= HARD) continue;
      bg[j] = 1;
      stack[sp++] = j;
      filled++;
    }
  }
  // (사이 그림용) 정확한 배경색이면 갇혀 있어도 배경: 움직임 계산이 다리 사이 같은 좁은 틈의 입구를 섞인 색으로 막아 버린다.
  // 인물 색은 배경색을 피해서 골랐으므로(초록/마젠타) 괜찮다.
  if (opts.global) for (let i = 0; i < n; i++) if (!bg[i] && dist[i] < HARD) { bg[i] = 1; filled++; }
  const bgFraction = filled / n;
  if (bgFraction < 0.03) return { ok: false, reason: 'nobg', key };
  // 2b) (사이 그림용) 배경색이 섞여 번진 곳: 배경에 이어진 '배경색 기운' 이 강한 픽셀까지 반투명으로
  //     (움직임을 계산해서 만든 그림은 팔·다리 둘레에 배경색이 섞인 얼룩이 생긴다)
  const keyness = new Float32Array(n);
  const grown = new Uint8Array(n);
  if (opts.spill) {
    const H = [0, 1, 2].filter((k) => key[k] > 127);
    const L = [0, 1, 2].filter((k) => key[k] <= 127);
    const den = Math.max(1, Math.min(...H.map((k) => key[k])) - Math.max(0, ...L.map((k) => key[k])));
    const kn = (i) => {
      let hv = 255;
      for (const k of H) hv = Math.min(hv, px[i * 4 + k]);
      let lv = 0;
      for (const k of L) lv = Math.max(lv, px[i * 4 + k]);
      return Math.max(0, Math.min(1, (hv - lv) / den));
    };
    for (let i = 0; i < n; i++) if (bg[i]) stack[sp++] = i;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= n || bg[j] || grown[j]) continue;
        const v = kn(j);
        if (v < 0.15) continue;
        grown[j] = 1;
        keyness[j] = v;
        stack[sp++] = j;
      }
    }
  }
  // 3) 배경에서 몇 픽셀 떨어졌는지 (최대 3) → 부드러운 테두리 · 번짐 지우기 범위
  const ring = new Uint8Array(n).fill(255);
  let frontier = [];
  for (let i = 0; i < n; i++) if (bg[i]) { ring[i] = 0; frontier.push(i); }
  for (let d = 1; d <= 3 && frontier.length; d++) {
    const next = [];
    for (const i of frontier) {
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= n || ring[j] !== 255) continue;
        ring[j] = d;
        next.push(j);
      }
    }
    frontier = next;
  }
  // 4) 알파 + 색 되돌리기
  const hi = key.map((v) => v > 127);
  const alpha = new Uint8Array(n);
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    let a = 255;
    if (bg[i]) a = 0;
    else if (ring[i] <= 2 && dist[i] < SOFT) a = Math.round(((dist[i] - HARD) / (SOFT - HARD)) * 255);
    if (grown[i]) a = Math.min(a, Math.round((1 - keyness[i]) * 255));
    a = Math.max(0, Math.min(255, a));
    alpha[i] = a;
    let r = px[i * 4];
    let g = px[i * 4 + 1];
    let b = px[i * 4 + 2];
    if (a > 0 && a < 255) {
      // 반투명 테두리: c = a·F + (1-a)·K 에서 원래 색 F 를 되찾는다
      const t = a / 255;
      r = (r - (1 - t) * key[0]) / t;
      g = (g - (1 - t) * key[1]) / t;
      b = (b - (1 - t) * key[2]) / t;
    }
    if (a > 0 && (ring[i] <= 3 || grown[i])) {
      // 디스필: 배경색 쪽으로 치우친 성분을 반만 덜어 낸다
      const c = [r, g, b];
      const hiV = Math.min(...c.filter((_, k) => hi[k]));
      const loV = Math.max(...c.filter((_, k) => !hi[k]), 0);
      const spill = hiV - loV;
      if (spill > 0 && c.some((_, k) => !hi[k])) for (let k = 0; k < 3; k++) if (hi[k]) c[k] -= spill * 0.5;
      [r, g, b] = c;
    }
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = a;
  }
  return { ok: true, alpha, rgba: out, key, bgFraction };
}

/** 이미 투명도가 있는 그림인지 (1% 넘게 투명하면) */
function hasRealAlpha(px, n) {
  let t = 0;
  for (let i = 0; i < n; i++) if (px[i * 4 + 3] < 250) t++;
  return t / n > 0.01;
}

/** 불투명한 부분의 채널별 평균 · 표준편차 */
function colorStats(rgba, n) {
  const sum = [0, 0, 0];
  const sq = [0, 0, 0];
  let cnt = 0;
  for (let i = 0; i < n; i++) {
    if (rgba[i * 4 + 3] < 230) continue;
    for (let c = 0; c < 3; c++) { const v = rgba[i * 4 + c]; sum[c] += v; sq[c] += v * v; }
    cnt++;
  }
  if (!cnt) return null;
  const mean = sum.map((s) => s / cnt);
  const std = sq.map((s, c) => Math.sqrt(Math.max(0, s / cnt - mean[c] * mean[c])));
  return { mean, std, n: cnt };
}

/** 색 맞추기: 기준(첫 셀)의 평균·분산 쪽으로 strength 만큼 (제자리에서 고침) */
function stabilizeColors(rgba, n, ref, strength = 0.6) {
  const cur = colorStats(rgba, n);
  if (!cur || !ref) return cur;
  const k = [0, 1, 2].map((c) => Math.max(0.7, Math.min(1.4, (ref.std[c] || 1) / (cur.std[c] || 1))));
  for (let i = 0; i < n; i++) {
    if (!rgba[i * 4 + 3]) continue;
    for (let c = 0; c < 3; c++) {
      const v = rgba[i * 4 + c];
      const target = (v - cur.mean[c]) * k[c] + ref.mean[c];
      rgba[i * 4 + c] = v + strength * (target - v);
    }
  }
  return colorStats(rgba, n);
}

/** 정해진 배경색 위에 다시 얹은 그림 (사이 그림 계산용) */
function overKey(rgba, n, keyHex) {
  const k = hexToRgb(keyHex);
  const out = new Uint8Array(n * 3); // 0 으로 채워진 Uint8Array (Buffer.alloc 과 같은 값 · 같은 잘림 규칙. Uint8ClampedArray 는 반올림해서 달라진다)
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(rgba[i * 4 + c] * a + k[c] * (1 - a));
  }
  return out;
}

/**
 * 두 셀이 얼마나 다른지 (0 = 같음, 1 = 전혀 다름). 작게 줄인 그림의 알파와 색으로 계산.
 *  - 크기 변화 (인물 넓이 비율), 움직인 거리 (인물 크기에 비해), 모양 변화 (가운데를 맞춘 뒤 겹치는 정도), 색 변화
 *  - 셀(투명 배경)이 아니면(전체 그림) 색 변화만 본다
 */
function celDifference(a, b) {
  if (a.width !== b.width || a.height !== b.height) return 1;
  const w = a.width;
  const h = a.height;
  const n = w * h;
  const mom = (img) => {
    let s = 0;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
      const al = img.data[i * 4 + 3] / 255;
      s += al;
      sx += al * (i % w);
      sy += al * Math.floor(i / w);
    }
    return { s, cx: s ? sx / s : 0, cy: s ? sy / s : 0 };
  };
  const ma = mom(a);
  const mb = mom(b);
  if (ma.s < 1 || mb.s < 1) return ma.s < 1 && mb.s < 1 ? 0 : 1;
  const area = Math.min(ma.s, mb.s) / Math.max(ma.s, mb.s);
  const move = Math.hypot(mb.cx - ma.cx, mb.cy - ma.cy) / Math.sqrt(Math.max(ma.s, mb.s));
  const dx = Math.round(mb.cx - ma.cx);
  const dy = Math.round(mb.cy - ma.cy);
  let inter = 0;
  let dc = 0;
  let both = 0;
  for (let y = 0; y < h; y++) {
    const yb = y + dy;
    for (let x = 0; x < w; x++) {
      const xb = x + dx;
      const i = y * w + x;
      const aa = a.data[i * 4 + 3] / 255;
      if (!aa || yb < 0 || yb >= h || xb < 0 || xb >= w) continue;
      const j = yb * w + xb;
      const ab = b.data[j * 4 + 3] / 255;
      inter += Math.min(aa, ab);
      if (aa > 0.5 && ab > 0.5) {
        both++;
        dc += (Math.abs(a.data[i * 4] - b.data[j * 4]) + Math.abs(a.data[i * 4 + 1] - b.data[j * 4 + 1]) + Math.abs(a.data[i * 4 + 2] - b.data[j * 4 + 2])) / 765;
      }
    }
  }
  const shape = 1 - inter / (ma.s + mb.s - inter);
  const colour = both ? dc / both : 0;
  return Math.min(1, Math.max(shape, move / 2, colour * 2, 1 - area));
}

module.exports = {
  KEY_GREEN, KEY_MAGENTA, HARD, SOFT, KEY_DRIFT,
  hexToRgb, rgbToHex, hsv, keyColorFor, keyName, median, keyCel, hasRealAlpha, colorStats, stabilizeColors, overKey, celDifference,
};
