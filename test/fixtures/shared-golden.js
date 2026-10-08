'use strict';
// shared-equivalence.test.js 와 골든 생성기가 함께 쓰는 '결정적인' 입력과 계산 (시드 고정 난수 · 파일/ffmpeg 입력 없음).
//  - shared-golden.json 의 값은 모듈을 *-core 로 나누기 전의 원본 코드(keyer.js · render.js · audio.js · characters.js · series.js · ai/demo.js · prompts.js)로 만들었다.
//    나눈 뒤의 코드가 같은 입력에서 같은 값(sha1)을 내야 한다 → 동작이 비트 단위로 같다는 뜻.
//  - 입력 만드는 방식을 바꾸면 골든도 다시 만들어야 하므로 이 파일의 입력 부분은 건드리지 않는다.
//  - 부동소수점 값은 문자열(toFixed)로 비교한다 (Math 함수의 마지막 자리 차이로 깨지지 않게).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sha1 = (...parts) => {
  const h = crypto.createHash('sha1');
  for (const p of parts) h.update(typeof p === 'string' ? p : new Uint8Array(p.buffer, p.byteOffset, p.byteLength));
  return h.digest('hex');
};
// Node 에서는 옛 코드가 요구하는 Buffer 로, 브라우저(Buffer 없음)에서는 그대로 Uint8Array 로
const asNodeBuffer = (u8) => (typeof Buffer === 'undefined' ? u8 : Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength));
const f9 = (x) => Number(x).toFixed(9);
const jsonSha = (v) => sha1(JSON.stringify(v));

/** mulberry32: 정수 연산만 쓰는 시드 난수 (0~1) */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- 입력 만들기

/** 부드러운 그라데이션 + 잡음 RGB (쌍선형 보간이 값을 바꾸도록) */
function randomRgb(w, h, seed) {
  const r = rng(seed);
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      out[i] = Math.floor((x / w) * 200 + r() * 55);
      out[i + 1] = Math.floor((y / h) * 200 + r() * 55);
      out[i + 2] = Math.floor(((x + y) / (w + h)) * 200 + r() * 55);
    }
  }
  return out;
}

/** 미리 곱한 알파의 셀(RGBA): 가장자리가 부드러운 타원 */
function premultCel(w, h, seed) {
  const r = rng(seed);
  const out = new Uint8Array(w * h * 4);
  const cx = w * 0.5;
  const cy = h * 0.5;
  const rx = w * 0.28;
  const ry = h * 0.4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      const d = Math.sqrt(dx * dx + dy * dy);
      const a = Math.max(0, Math.min(1, (1.15 - d) * 6));
      const alpha = Math.round(a * 255);
      const i = (y * w + x) * 4;
      const base = [200 - (x % 7) * 3, 60 + (y % 11) * 4, 90 + Math.floor(r() * 30)];
      for (let c = 0; c < 3; c++) out[i + c] = Math.round((base[c] * alpha) / 255);
      out[i + 3] = alpha;
    }
  }
  return out;
}

/**
 * 체험 셀(ai/demo.js 의 demoCel 과 같은 그림): 단색 배경 위에 figureBoxes 사각형들. ffmpeg 없이 JS 로 칠한다.
 * @param {Function} figureBoxes
 */
function demoCelPixels(figureBoxes, { w = 640, h = 360, key = '00ff00', shot = 2, index = 1, count = 4, motion = true, palette } = {}) {
  const pal = palette || [{ hex: '#d7263d' }, { hex: '#6b3e26' }, { hex: '#f4c430' }, { hex: '#7a4a2a' }, { hex: '#f6d5bf' }];
  const u = Math.min(w, h) / 7;
  const ang = count > 1 ? ((index + 0.5) / count) * Math.PI * 2 : 0;
  const cx = w * (0.48 + (motion ? 0.012 * Math.sin(ang) : 0.02 * index)) + (shot % 3) * w * 0.03;
  const by = h * 0.36 - (motion ? u * 0.1 * Math.abs(Math.cos(ang)) : 0);
  const boxes = figureBoxes(cx, by, u, pal, {
    arm: motion ? 0.35 + 0.4 * Math.sin(ang) : (index % 2) * 0.5,
    leg: motion ? 0.8 * Math.cos(ang) : 0,
    scarf: motion ? 0.25 + 0.15 * Math.cos(ang) : 0.2,
  });
  const px = new Uint8ClampedArray(w * h * 4);
  const k = [0, 2, 4].map((o) => parseInt(key.slice(o, o + 2), 16));
  for (let i = 0; i < w * h; i++) px.set([k[0], k[1], k[2], 255], i * 4);
  for (const b of boxes) {
    const m = /x=(-?\d+):y=(-?\d+):w=(-?\d+):h=(-?\d+):color=0x([0-9a-f]{6}):t=fill/i.exec(b);
    if (!m) throw new Error(`unexpected drawbox: ${b}`);
    const [x0, y0, bw, bh] = [+m[1], +m[2], +m[3], +m[4]];
    const col = [0, 2, 4].map((o) => parseInt(m[5].slice(o, o + 2), 16));
    for (let y = Math.max(0, y0); y < Math.min(h, y0 + bh); y++) for (let x = Math.max(0, x0); x < Math.min(w, x0 + bw); x++) px.set([col[0], col[1], col[2], 255], (y * w + x) * 4);
  }
  return px;
}

/** AI 가 그린 듯한 셀: 살짝 다른 배경색 + 잡음 + 부드럽게 섞인 가장자리 + 몸통 안에 갇힌 점 (keyer.test.js 의 fakeCel 과 같은 모양) */
function noisyCel(w, h, bgc, seed) {
  const r = rng(seed);
  const px = new Uint8ClampedArray(w * h * 4);
  const red = [210, 30, 40];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cx = Math.max(0, Math.min(1, Math.min(x + 1 - w / 3 + 0.5, (2 * w) / 3 + 0.5 - x)));
      const cy = Math.max(0, Math.min(1, Math.min(y + 1 - h / 4 + 0.5, (3 * h) / 4 + 0.5 - y)));
      const a = cx * cy;
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) px[i + c] = Math.round(red[c] * a + bgc[c] * (1 - a) + ((x * 7 + y * 3 + c) % 5) - 2 + (r() - 0.5) * 2);
      px[i + 3] = 255;
    }
  }
  for (let y = Math.floor(h / 2); y < Math.floor(h / 2) + 5; y++) for (let x = Math.floor(w / 2); x < Math.floor(w / 2) + 5; x++) { const i = (y * w + x) * 4; px[i] = 0; px[i + 1] = 255; px[i + 2] = 0; }
  return px;
}

/** 투명도가 있는 셀 PNG 용 (곧은 알파 RGBA): 가장자리가 부드러운 타원 + 잡음 */
function straightCel(w, h, seed) {
  const r = rng(seed);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - w * 0.5) / (w * 0.22);
      const dy = (y - h * 0.5) / (h * 0.38);
      const d = Math.sqrt(dx * dx + dy * dy);
      const i = (y * w + x) * 4;
      out[i] = 200 - (x % 7) * 3;
      out[i + 1] = 60 + (y % 11) * 4;
      out[i + 2] = 90 + Math.floor(r() * 30);
      out[i + 3] = Math.round(Math.max(0, Math.min(1, (1.1 - d) * 6)) * 255);
    }
  }
  return out;
}

/** 알파가 0 또는 255 뿐인 셀 (renderShot 시험용): ffmpeg 의 premultiply 반올림 방식과 상관없이 같은 값이 나온다 */
function binaryCel(w, h, seed) {
  const out = straightCel(w, h, seed);
  for (let i = 3; i < out.length; i += 4) out[i] = out[i] >= 128 ? 255 : 0;
  return out;
}

/**
 * render.js 의 영상 인코더(ffmpegWriter 중 libx264 로 만드는 것)만 가로채서 프레임(raw RGB)을 받아 보는 장치.
 * render.js 를 불러오기 *전에* 설치한다 (render.js 가 불러올 때 함수를 붙잡아 가기 때문). 나머지 ffmpegWriter 호출(PNG 쓰기 등)은 그대로 통과.
 * 인코더(x264)는 스레드 수에 따라 결과가 달라질 수 있어서, 영상 파일 대신 인코더에 들어가는 프레임을 비교한다.
 */
function installFrameSink(ffmpegModule) {
  const real = ffmpegModule.ffmpegWriter;
  const state = { sink: null };
  ffmpegModule.ffmpegWriter = (args, opts) => (state.sink && args.includes('libx264') ? state.sink : real(args, opts));
  return state;
}

/** 박자 있는 소리 (킥 드럼 + 낮은 음): media.test.js 의 synth 와 같다. 22050Hz 모노 */
function clickTrack(bpm, dur, offset = 0.37, SR = 22050) {
  const n = Math.floor(dur * SR);
  const s = new Float32Array(n);
  const p = 60 / bpm;
  let k = 0;
  for (let i = 0; i < n; i++) s[i] = 0.05 * Math.sin((2 * Math.PI * 220 * i) / SR);
  for (let t = offset; t < dur; t += p, k++) {
    const st = Math.floor(t * SR);
    const acc = k % 4 === 0 ? 1 : 0.6;
    for (let i = 0; i < SR * 0.25 && st + i < n; i++) {
      const tt = i / SR;
      s[st + i] += acc * 0.8 * Math.exp(-tt * 18) * Math.sin(2 * Math.PI * (60 + 80 * Math.exp(-tt * 30)) * tt);
    }
  }
  return s;
}

/** Float32 소리 → 16비트 정수 (ffmpeg 가 풀면 x/32768 로 되돌아와서 두 경로의 입력이 똑같다) */
function toInt16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
  return out;
}

function wavBytes(int16, sampleRate) {
  const dataLen = int16.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // 모노
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  Buffer.from(int16.buffer, int16.byteOffset, dataLen).copy(buf, 44);
  return buf;
}

function fakeRef(kind, size, seed) {
  const r = rng(seed);
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) b[i] = Math.floor(r() * 256);
  const sig = kind === 'png' ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] : [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46];
  b.set(sig, 0);
  return b;
}

function sampleCharacter() {
  return {
    id: 'char-golden1',
    name: '  하   루  ',
    version: '3.7',
    locked: {
      summary: 'a cheerful   girl with a short brown bob and a long red scarf. '.repeat(20), // 900자에서 잘린다
      face: 'round soft face,\n small nose',
      hair: 'short chestnut-brown bob',
      eyes: '',
      body: 'x'.repeat(500), // 400자에서 잘린다
      outfit: 'bright yellow raincoat, navy shorts',
      props: 'long red knitted scarf',
      extra: 'ignored',
    },
    palette: ['#ABC', { name: 'hair brown', hex: '6b3e26' }, { name: 'bad', hex: '#zzz' }, null, { name: 'n'.repeat(60), hex: '#12345678' }, 'FFF', { hex: '#a1b2c3' }],
    rules: { must: 'always wears the scarf\n\n   \nalways wears the raincoat', never: ['never older than 12', '', '  never change hair color  '] },
    personality_ko: '  호기심   많고\n씩씩한 소녀 ',
    description_ko: '짧은 갈색 단발머리, 큰 갈색 눈, 빨간 목도리',
    refs: [
      { file: 'refs/a.png', kind: 'turnaround', label: '앞 옆 뒤', mime: 'image/png' },
      { file: 'refs/b.jpg', kind: 'weird', label: '', mime: 'image/jpeg' },
      { file: 'refs/c.png', kind: 'expressions', label: '표정 '.repeat(40), mime: 'image/webp' },
    ],
    lockedAt: 1700000000000,
    createdAt: 1690000000000,
    updatedAt: 1700000001234,
  };
}

function sampleSeries() {
  return {
    id: 'ser-golden1',
    name: ' 하루의   비 오는\t마을 ',
    emoji: '🌻🌻🌻🌻🌻🌻🌻🌻🌻🌻',
    characterIds: ['a', 2, '', 'b', 'c', 'd', 'e'],
    bible: { art_en: '', world_ko: ' 비 오는   마을\t', tone_ko: '포근함 '.repeat(120), notes_en: 'no text in pictures' },
    workflowId: 42,
    episodeCounter: '7.9',
    episodes: [
      { number: 3, projectId: 'p3', title: '세 번째   이야기', summary_ko: ' 하늘을\t날다 ', madeAt: 1700000000000 },
      { number: 'x', projectId: 7, title: 'y'.repeat(200), summary_ko: null, madeAt: 'bad' },
      { number: 1, projectId: 'p1', title: '첫 이야기', summary_ko: '시작', madeAt: 1690000000000 },
    ],
    createdAt: 1690000000000,
    updatedAt: 1690000000001,
  };
}

function demoCtx(D, mode, keyRate) {
  const durs = [4.0, 6.5, 3.2, 8.0, 5.5, 2.5, 7.0, 4.5, 6.0];
  let t = 0;
  const segments = durs.map((d, i) => { const s = { index: i + 1, start: t, end: t + d, duration: d, lyrics: [], energy: 'mid', level: 0.5 }; t += d; return s; });
  const wf = { visualStyle: 'soft watercolor cel animation' };
  return {
    segments,
    frames: durs.map((d) => Math.round(d * 24)),
    highlights: [false, true, false, false, true, false, true, false, false],
    alloc: [2, 6, 1, 3, 6, 1, 5, 2, 2],
    motion: [false, true, false, false, true, false, false, false, true],
    plan: D.demoPlan('여름 바다', wf, null),
    mode,
    keyRate,
  };
}

// ---------------------------------------------------------------- 영역별 계산 (m = { K: keyer, R: render, A: audio, C: characters, S: series, D: demo, P: prompts } — 옛 공개 이름들)

function computeKeyer(m) {
  const K = m.K;
  const out = {};
  const w = 640;
  const h = 360;
  // 체험 셀 (평평한 초록 배경): 보통 · 사이 그림용(정확한 색 + 번짐 + 전체)
  const cel = demoCelPixels(m.D.figureBoxes, { w, h });
  const cel2 = demoCelPixels(m.D.figureBoxes, { w, h, index: 2, shot: 4, motion: false });
  out.inputs = { demoCel: sha1(cel), demoCel2: sha1(cel2) };
  const sum = (k) => ({ ok: k.ok, reason: k.reason || null, key: k.key, bgFraction: k.bgFraction === undefined ? null : f9(k.bgFraction), rgba: k.rgba ? sha1(k.rgba) : null, alpha: k.alpha ? sha1(k.alpha) : null });
  const k1 = K.keyCel(cel, w, h, { expect: K.KEY_GREEN });
  out.demoCel = sum(k1);
  out.demoCelExact = sum(K.keyCel(cel, w, h, { keyColor: K.KEY_GREEN, spill: true, global: true }));
  const k2 = K.keyCel(cel2, w, h, { expect: K.KEY_GREEN });
  out.demoCel2 = sum(k2);
  out.wrongKeyIsRejected = sum(K.keyCel(cel, w, h, { expect: K.KEY_MAGENTA }));
  // AI 가 그린 듯한 셀 (초록 · 마젠타 배경), 가장자리가 제각각인 전체 그림
  const g = noisyCel(w, h, [12, 236, 24], 11);
  const mg = noisyCel(w, h, [250, 5, 248], 12);
  out.noisyGreen = sum(K.keyCel(g, w, h, { expect: K.KEY_GREEN }));
  out.noisyGreenSpill = sum(K.keyCel(g, w, h, { keyColor: K.KEY_GREEN, spill: true, global: true }));
  out.noisyMagenta = sum(K.keyCel(mg, w, h, { expect: K.KEY_MAGENTA }));
  const photo = randomRgb(w, h, 13);
  const photoRgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) photoRgba.set([photo[i * 3], photo[i * 3 + 1], photo[i * 3 + 2], 255], i * 4);
  out.fullPicture = sum(K.keyCel(photoRgba, w, h, { expect: K.KEY_GREEN }));
  // 색 맞추기: 첫 셀 기준으로 둘째 셀을 끌어당김 (제자리 수정) → 값 · 통계
  const n = w * h;
  const stat = (s) => (s ? { mean: s.mean.map(f9), std: s.std.map(f9), n: s.n } : null);
  const ref = K.colorStats(k1.rgba, n);
  const drift = new Uint8ClampedArray(k2.rgba);
  for (let i = 0; i < n; i++) { drift[i * 4] = Math.min(255, drift[i * 4] * 1.1 + 25); drift[i * 4 + 2] = Math.max(0, drift[i * 4 + 2] - 20); }
  const after = K.stabilizeColors(drift, n, ref, 0.6);
  out.stats = { ref: stat(ref), after: stat(after), stabilized: sha1(drift) };
  const drift2 = new Uint8ClampedArray(k2.rgba);
  K.stabilizeColors(drift2, n, ref, 1);
  out.stabilizedFull = sha1(drift2);
  // 사이 그림 판 (셀을 배경색 위에 얹기), 투명도 판별, 셀 차이
  out.overKey = { green: sha1(K.overKey(k1.rgba, n, K.KEY_GREEN)), magenta: sha1(K.overKey(k2.rgba, n, '#ff00ff')) };
  out.hasRealAlpha = { keyed: K.hasRealAlpha(k1.rgba, n), opaque: K.hasRealAlpha(cel, n) };
  const small = (px, sw, sh) => ({ data: px, width: sw, height: sh });
  const sh = new Uint8ClampedArray(k1.rgba.length);
  sh.set(k1.rgba.subarray(8 * 4));
  out.celDifference = {
    same: f9(K.celDifference(small(k1.rgba, w, h), small(k1.rgba, w, h))),
    pose: f9(K.celDifference(small(k1.rgba, w, h), small(k2.rgba, w, h))),
    shifted: f9(K.celDifference(small(k1.rgba, w, h), small(sh, w, h))),
    sizeMismatch: f9(K.celDifference(small(k1.rgba, w, h), small(k1.rgba.subarray(0, 4 * 10 * 10), 10, 10))),
  };
  // 작은 도우미들
  const pals = [[{ hex: '#d7263d' }, { hex: '#7a4a2a' }], [{ hex: '#d7263d' }, { hex: '#2e8b57' }], [{ hex: '#1f3d2a' }], [{ hex: 'oops' }, null], []];
  out.keyColorFor = pals.map((p) => K.keyColorFor(p));
  out.keyName = [K.keyName('#FF00FF'), K.keyName('#00ff00'), K.keyName('x')];
  out.hex = { hexToRgb: ['#0a1B2c', '0a1b2c', 'xyz', '', '#12345'].map((v) => K.hexToRgb(v)), rgbToHex: [[0, 0, 0], [255.4, 128.5, 7.2], [10, 20, 30]].map((v) => K.rgbToHex(v)) };
  out.hsv = [[255, 0, 0], [0, 128, 0], [30, 60, 200], [0, 0, 0], [128, 128, 128]].map((c) => { const v = K.hsv(...c); return [f9(v.h), f9(v.s), f9(v.v)]; });
  out.median = [K.median([5, 1, 3]), K.median([]), K.median([9, 9, 1, 2])];
  return out;
}

function computeRender(m) {
  const R = m.R;
  const out = {};
  const frames = {
    hold: { S: 1, fr: { zoom: 1, x: 0, y: 0 }, dx: 0, dy: 0 },
    pan: { S: 1.25, fr: { zoom: 1.25, x: 0.6, y: -0.25 }, dx: 0, dy: 0 },
    zoom: { S: 1.6, fr: { zoom: 1.43, x: 0.1, y: 0.3 }, dx: 0, dy: 0 },
  };
  for (const [W, H] of [[1280, 720], [720, 1280]]) {
    const res = {};
    const run = (name, S, fr, dx, dy, chans, seed) => {
      const cw = Math.round(W * S);
      const ch = Math.round(H * S);
      const src = chans === 4 ? premultCel(cw, ch, seed) : randomRgb(cw, ch, seed);
      const o = R.sampleFrame(src, cw, ch, W, H, fr, dx, dy, chans);
      res[`${name}${chans === 4 ? '-cel' : ''}`] = { len: o.length, sha1: sha1(o) };
    };
    for (const [name, f] of Object.entries(frames)) run(name, f.S, f.fr, f.dx, f.dy, 3, 100 + W);
    // 흔들기 (카메라 흔들림 + 충격): renderShot 과 같은 식으로 rand 에서 dx, dy
    const seed = 7919 * 3 + 5;
    const rr = 13;
    const k = Math.floor(rr / 2);
    const amp = 0.012 + 0.5 * 0.02;
    const sx = (R.rand(seed, k, 3) - 0.5) * 2 * amp * W;
    const sy = (R.rand(seed, k, 4) - 0.5) * 2 * amp * H;
    run('shake', 1, frames.hold.fr, sx, sy, 3, 200 + W);
    // 라인 보일 (셀만): 작은 위치 · 크기 떨림 + RGBA
    const bdx = (R.rand(seed, k, 1) - 0.5) * 1.1;
    const bdy = (R.rand(seed, k, 2) - 0.5) * 1.1;
    const bfr = { ...frames.pan.fr, zoom: Math.max(1, frames.pan.fr.zoom * (1 + (R.rand(seed, k, 5) - 0.5) * 0.0025)) };
    run('boil', 1.25, bfr, bdx, bdy, 4, 300 + W);
    run('pan', 1.25, frames.pan.fr, 0, 0, 4, 400 + W);
    res.shakeOffsets = [f9(sx), f9(sy), f9(bdx), f9(bdy), f9(bfr.zoom)];
    out[`${W}x${H}`] = res;
  }
  // 합성 (미리 곱한 셀 위 배경) · 효과
  const cw = 640;
  const ch = 360;
  const n = cw * ch;
  const cel = premultCel(cw, ch, 21);
  const bg = randomRgb(cw, ch, 22);
  out.composite = sha1(R.composite(cel, bg, n));
  const fxCases = [
    { name: 'fade_in', fx: ['fade_in'], f: 3, N: 48, r: 3 },
    { name: 'fade_out', fx: ['fade_out'], f: 44, N: 48, r: 44 },
    { name: 'flash', fx: ['flash'], f: 2, N: 48, r: 2 },
    { name: 'sparkle', fx: ['sparkle'], f: 10, N: 48, r: 10 },
    { name: 'sparkle2', fx: ['sparkle'], f: 21, N: 48, r: 21 },
    { name: 'all', fx: ['sparkle', 'flash', 'fade_in', 'shake'], f: 1, N: 24, r: 1 },
    { name: 'none', fx: [], f: 5, N: 24, r: 5 },
  ];
  out.applyFx = {};
  out.fxState = {};
  for (const c of fxCases) {
    const st = R.fxState(c.fx, c.f, c.N);
    out.fxState[c.name] = { fade: f9(st.fade), flash: f9(st.flash), sparkle: st.sparkle, shake: f9(st.shake) };
    const buf = randomRgb(cw, ch, 30);
    R.applyFx(buf, st, cw, ch, 7919 + 3, c.r);
    out.applyFx[c.name] = sha1(buf);
  }
  out.blankImage = sha1(R.blankImage(64, 36));
  out.rand = [R.rand(1, 2, 3), R.rand(7922, 6, 1), R.rand(-5, 0, 99), R.rand(123456789, 987654321, 5)].map(f9);
  out.parallaxFraming = [R.parallaxFraming({ zoom: 1.5, x: 0.2, y: -0.3 }), R.parallaxFraming({ zoom: 2, x: 0, y: 1 }, 0.5)].map((v) => [f9(v.zoom), f9(v.x), f9(v.y)]);
  return out;
}

/** processCel (PNG 읽기 → 배경 빼기 → 색 맞추기 → PNG 쓰기) : 다시 읽은 픽셀로 비교한다 (PNG 는 무손실) */
async function computeProcessCel(m, dir) {
  const { K, D } = m;
  const w = 320;
  const h = 180;
  const cel = demoCelPixels(D.figureBoxes, { w, h });
  const src = path.join(dir, 'proc-cel.png');
  await K.writePng(src, cel, w, h);
  const ref = K.colorStats(K.keyCel(demoCelPixels(D.figureBoxes, { w, h, index: 3, shot: 5 }), w, h, { expect: K.KEY_GREEN }).rgba, w * h);
  const stat = (s) => (s ? { mean: s.mean.map(f9), std: s.std.map(f9), n: s.n } : null);
  const out = {};
  for (const [name, o] of [['plain', { keyColor: K.KEY_GREEN }], ['stabilized', { keyColor: K.KEY_GREEN, refStats: ref, strength: 0.8 }], ['exact', { keyColor: K.KEY_GREEN, exactKey: true }], ['wrongKey', { keyColor: K.KEY_MAGENTA }]]) {
    const r = await K.processCel(src, { celOut: path.join(dir, `proc-${name}-cel.png`), plateOut: path.join(dir, `proc-${name}-plate.png`), ...o });
    if (!r.keyed) { out[name] = { keyed: false, reason: r.reason, width: r.width, height: r.height }; continue; } // 부탁한 색이 아니면 빼지 않는다
    const celBack = await K.readRgba(r.cel);
    const plateBack = await K.readRgba(r.plate);
    out[name] = { keyed: r.keyed, source: r.source, width: r.width, height: r.height, stats: stat(r.stats), cel: sha1(celBack.data), plate: sha1(plateBack.data) };
  }
  // 알파가 이미 있는 PNG 와 단색 배경이 아닌 그림
  const alphaSrc = path.join(dir, 'proc-alpha.png');
  await K.writePng(alphaSrc, straightCel(w, h, 5), w, h);
  const ra = await K.processCel(alphaSrc, { celOut: path.join(dir, 'pa-cel.png'), plateOut: path.join(dir, 'pa-plate.png'), keyColor: K.KEY_MAGENTA });
  out.alpha = { keyed: ra.keyed, source: ra.source, plate: sha1((await K.readRgba(ra.plate)).data) };
  const photo = randomRgb(w, h, 6);
  const photoSrc = path.join(dir, 'proc-photo.png');
  await K.writePng(photoSrc, photo, w, h, { rgb: true });
  const rp = await K.processCel(photoSrc, { celOut: path.join(dir, 'pp-cel.png'), plateOut: path.join(dir, 'pp-plate.png'), keyColor: K.KEY_GREEN });
  out.photo = { keyed: rp.keyed, reason: rp.reason };
  return out;
}

/**
 * renderShot (ffmpeg 로 그림 읽기 → 프레임 만들기 → 인코더로 보내기): 인코더에 들어가는 프레임으로 비교한다.
 * 그림 파일을 정확히 '펼친 크기' 로 만들어 두어서 ffmpeg 의 크기 맞추기는 그냥 통과하고, 셀의 알파는 0/255 뿐이라 premultiply 반올림에도 기대지 않는다
 * (플랫폼·ffmpeg 버전에 따라 달라질 곳이 없다).
 */
async function computeRenderShot(m, dir, sinkState) {
  const { K, R } = m;
  const W = 160;
  const H = 90;
  const out = {};
  const variants = {
    layered: { cam: { move: 'pan_right', ease: 'inout', start: { zoom: 1.1, x: -0.5, y: 0 }, end: { zoom: 1.35, x: 0.5, y: 0.2 } }, fx: ['fade_in', 'sparkle'], boil: true, bg: true, lead: 2, tail: 3, seed: 3 },
    flat: { cam: { move: 'shake', shake: 0.02, ease: 'linear', start: { zoom: 1, x: 0, y: 0 }, end: { zoom: 1, x: 0, y: 0 } }, fx: ['flash', 'shake', 'fade_out'], boil: false, bg: false, lead: 0, tail: 0, seed: 1 },
    zoomOut: { cam: { move: 'zoom_out', ease: 'out', start: { zoom: 1.6, x: 0.3, y: -0.3 }, end: { zoom: 1, x: 0, y: 0 } }, fx: [], boil: true, bg: true, lead: 1, tail: 1, seed: 2 },
  };
  for (const [name, v] of Object.entries(variants)) {
    const S = Math.max(1, v.cam.start.zoom, v.cam.end.zoom);
    const cw = Math.round(W * S);
    const ch = Math.round(H * S);
    const N = 16;
    const files = new Map();
    let bg = null;
    if (v.bg) {
      bg = path.join(dir, `${name}-bg.png`);
      await K.writePng(bg, randomRgb(cw, ch, 41), cw, ch, { rgb: true });
      for (const [id, seed] of [['A', 42], ['B', 43]]) { const f = path.join(dir, `${name}-${id}.png`); await K.writePng(f, binaryCel(cw, ch, seed), cw, ch); files.set(id, f); }
    } else {
      for (const [id, seed] of [['A', 44], ['B', 45]]) { const f = path.join(dir, `${name}-${id}.png`); await K.writePng(f, randomRgb(cw, ch, seed), cw, ch, { rgb: true }); files.set(id, f); }
    }
    files.set('C', null); // 그림이 없으면 빈 카드 / 투명 셀
    const table = Array.from({ length: N }, (_, i) => ['A', 'A', 'B', 'C'][i % 4]);
    const shot = { shot: 4, frames: N, camera: v.cam, fx: v.fx };
    const hashes = [];
    sinkState.sink = { async write(buf) { hashes.push(sha1(buf)); }, async end() {} };
    let r;
    try {
      r = await R.renderShot({ shot, table, files, bg, W, H, lead: v.lead, tail: v.tail, boil: v.boil, seed: v.seed, out: path.join(dir, `${name}.mp4`) });
    } finally { sinkState.sink = null; }
    out[name] = { frames: r.frames, layered: r.layered, written: hashes.length, unique: new Set(hashes).size, first: hashes[0], last: hashes[hashes.length - 1], sha1: jsonSha(hashes) };
  }
  return out;
}

async function computeAudio(m, dir) {
  const A = m.A;
  const out = {};
  const pack = (a) => ({ duration: a.duration, bpm: a.bpm, beatPeriod: a.beatPeriod, beats: a.beats.length, downbeats: a.downbeats.length, bars: a.bars.length, first: a.beats.slice(0, 4), sha1: jsonSha(a) });
  const track = toInt16(clickTrack(120, 30, 0.37));
  const samples = Float32Array.from(track, (v) => v / 32768);
  out.samples120 = pack(A.analyzeSamples(samples, 120));
  out.samples120NoPrior = pack(A.analyzeSamples(samples));
  const t92 = toInt16(clickTrack(92, 20, 0.2));
  out.samples92 = pack(A.analyzeSamples(Float32Array.from(t92, (v) => v / 32768), 92));
  out.tempo = [A.estimateTempo(new Float64Array(2000).map((_, i) => (i % 21 === 0 ? 1 : 0)), 86.1328125, 120)].map(f9);
  out.fixOctave = [A.fixOctave(60), A.fixOctave(240), A.fixOctave(100, 50), A.fixOctave(95, 190)].map(f9);
  if (!dir) return out; // 브라우저 검사: 파일(ffmpeg) 경로는 건너뛴다
  // 파일 경로 (옛 analyzeSong: ffmpeg 로 풀어서 분석) — 같은 값이어야 한다
  const wav = path.join(dir, 'click120.wav');
  fs.writeFileSync(wav, wavBytes(track, 22050));
  const viaFile = await A.analyzeSong(wav, { priorBpm: 120 });
  out.file120 = pack(viaFile);
  out.fileEqualsSamples = JSON.stringify(viaFile) === JSON.stringify(A.analyzeSamples(samples, 120));
  return out;
}

function computeCharacters(m) {
  const C = m.C;
  const out = {};
  const raw = sampleCharacter();
  const n = C.normalizeCharacter(raw);
  out.normalized = { sha1: jsonSha(n), name: n.name, version: n.version, palette: n.palette, rules: n.rules, summaryLen: n.locked.summary.length, bodyLen: n.locked.body.length, refs: n.refs };
  out.empty = jsonSha({ ...C.normalizeCharacter({}), createdAt: 0, updatedAt: 0 });
  out.helpers = {
    hex: ['#FfF', 'abc', '12345', '#zzz', '  #AABBCC ', null, 123456].map((v) => C.normalizeHex(v)),
    sniff: [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]), Uint8Array.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0]), Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), Uint8Array.from([0x89, 0x50]), null].map((v) => C.sniffImage(v)),
    validate: [C.validateCharacter(n), C.validateCharacter(C.normalizeCharacter({})), C.validateCharacter(n, { requireRefs: true }), C.validateCharacter({ ...n, refs: [] }, { requireRefs: true })],
    locked: C.lockedText(n),
    palette: C.paletteText(n),
    block: C.characterBlock(n),
  };
  // 옛 toAmchar 는 Buffer 를 받는다 (toString('base64')). 새 코어는 Uint8Array 도 받는다: shared-equivalence 에서 따로 확인
  const bufs = [fakeRef('png', 5000, 1), fakeRef('jpg', 7777, 2), fakeRef('png', 6000, 3)].map(asNodeBuffer);
  const am = C.toAmchar(n, bufs);
  const amText = JSON.stringify(am, null, 1);
  out.toAmchar = { sha1: sha1(amText), refs: am.refs.map((r) => [r.kind, r.label, r.mime, r.data.length, sha1(r.data)]), keys: Object.keys(am) };
  const back = C.fromAmchar(amText);
  out.fromAmchar = {
    character: jsonSha(back.character),
    refs: back.refs.map((r) => [r.kind, r.label, r.mime, r.buffer.length, sha1(r.buffer)]),
    bytesEqual: back.refs.every((r, i) => sha1(r.buffer) === sha1(bufs[i])),
  };
  // 다른 모양의 입력: 객체 · BOM 붙은 글 · 바이트
  const viaObj = C.fromAmchar(JSON.parse(amText));
  const viaBom = C.fromAmchar(`\uFEFF${amText}`);
  const viaBytes = C.fromAmchar(asNodeBuffer(new TextEncoder().encode(amText)));
  const viaBomBytes = C.fromAmchar(asNodeBuffer(new TextEncoder().encode(`\uFEFF${amText}`)));
  out.fromAmcharInputs = [viaObj, viaBom, viaBytes, viaBomBytes].map((v) => jsonSha([v.character, v.refs.map((r) => [r.kind, r.label, r.mime, sha1(r.buffer)])]));
  // 줄바꿈 · 공백이 낀 base64 (손으로 고친 파일) 도 읽는다
  const wrapped = JSON.parse(amText);
  wrapped.refs[0].data = wrapped.refs[0].data.replace(/(.{76})/g, '$1\n  ');
  out.fromAmcharWrapped = sha1(C.fromAmchar(wrapped).refs[0].buffer);
  // 틀린 입력의 한국어 오류 문장
  const base64 = (u8) => (typeof Buffer === 'undefined' ? C.b64encode(u8) : Buffer.from(u8).toString('base64')); // 브라우저에서는 코어의 b64encode (Node 에서 Buffer 와 같음은 shared-equivalence 가 따로 확인)
  const png = base64(bufs[0]);
  const base = { format: 'animemaker.character', formatVersion: 1, name: '하루', locked: { summary: 'a girl' }, refs: [{ kind: 'turnaround', data: png }] };
  const tooBig = new Uint8Array(12 * 1024 * 1024 + 1); // 12MB 를 넘는 PNG
  tooBig.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const bad = [
    'not json', '', null, { format: 'other' }, { ...base, formatVersion: 99 },
    { ...base, refs: [{ kind: 'x', data: base64(new TextEncoder().encode('hello world, not an image')) }] },
    { ...base, refs: Array.from({ length: 7 }, () => ({ data: png })) },
    { ...base, name: '' }, { ...base, locked: {} }, { ...base, lockedAt: 1700000000000, refs: [] },
    { ...base, refs: [{ kind: 'turnaround', data: base64(tooBig) }] },
    { ...base, refs: [null] },
  ];
  out.errors = bad.map((b) => { try { C.fromAmchar(b); return 'OK'; } catch (e) { return e.message; } });
  return out;
}

function computeSeries(m) {
  const S = m.S;
  const raw = sampleSeries();
  const n = S.normalizeSeries(raw);
  return {
    normalized: { sha1: jsonSha(n), name: n.name, emoji: n.emoji, characterIds: n.characterIds, episodes: n.episodes.map((e) => [e.number, e.projectId, e.title.length, e.summary_ko]), counter: n.episodeCounter, art: n.bible.art_en.length, subtitleStyle: n.subtitleStyle },
    empty: jsonSha({ ...S.normalizeSeries({}), createdAt: 0, updatedAt: 0 }),
    episode: jsonSha(S.normalizeEpisode({ number: '5', projectId: 9, title: ' 제목\t있음 ', summary_ko: 's'.repeat(500), madeAt: 1700000000000 })),
    keepsId: S.normalizeSeries({ id: 'abc' }).id,
  };
}

function computeDemo(m) {
  const D = m.D;
  const out = {};
  const wf = { visualStyle: 'soft watercolor cel animation' };
  const series = { characters: [{ name: '하루' }], episode: 4 };
  out.lyrics = sha1(D.DEMO_LYRICS);
  out.character = jsonSha(D.DEMO_CHARACTER);
  out.plans = [D.demoPlan('여름 바다', wf, null), D.demoPlan('', null, series), D.demoPlan('x', {}, { episode: 2 })].map(jsonSha);
  out.xsheets = [
    D.demoXsheet(demoCtx(D, 'limited')),
    D.demoXsheet(demoCtx(D, 'ghibli', 6)),
    D.demoXsheet(demoCtx(D, 'full', 8)), // keyRate 8 → 열쇠 그림 한 장이 3프레임 (그 밖의 값은 4프레임)
    D.demoXsheet({ ...demoCtx(D, 'limited'), plan: {}, motion: undefined }),
  ].map(jsonSha);
  out.figureBoxes = [
    D.figureBoxes(320.4, 130.7, 51.43, [{ hex: '#d7263d' }, { hex: '#6b3e26' }, { hex: '#f4c430' }, { hex: '#7a4a2a' }, { hex: '#f6d5bf' }], { arm: 0.5, scarf: 0.3, leg: -0.4 }),
    D.figureBoxes(100, 50, 20, [], {}),
    D.figureBoxes(100, 50, 20, undefined),
  ].map(jsonSha);
  return out;
}

function computePrompts(m) {
  const { P, C, D } = m;
  const hero = C.normalizeCharacter({ ...D.DEMO_CHARACTER, id: 'char-demo', createdAt: 1, updatedAt: 2 });
  const series = {
    name: '하루의 비 오는 마을',
    episode: 3,
    bible: { art_en: 'soft hand-painted 1990s cel animation', world_ko: '비가 자주 오는 항구 마을', tone_ko: '포근함', notes_en: 'never show text' },
    characters: [{ ...hero, role: 'protagonist' }],
    previous: [{ number: 1, title: '첫 비', summary_ko: '불빛을 발견' }, { number: 2, title: '', summary_ko: '친구를 만남' }],
  };
  const wf = { aspect: '16:9', visualStyle: 'cel animation', minClips: 10, maxClips: 14 };
  const plan = P.normalizePlan(D.demoPlan('여름', wf, series), wf, series);
  const shot = { shot: 2, scene_en: '하루 under the rain lanterns', framing_en: 'medium shot', characters: ['하루'], bg: { prompt_en: 'a rainy alley' } };
  const drawing = { id: 'A', prompt_en: '하루 looks up at the light' };
  return {
    plan: jsonSha(plan),
    seriesBlock: sha1(P.seriesBlock(series)),
    cel: sha1(P.composeCelPrompt({ plan, series, shot, drawing, wf, keyColor: '#00ff00' })),
    celMagenta: sha1(P.composeCelPrompt({ plan, series: null, shot, drawing, wf, keyColor: '#FF00FF' })),
    drawing: sha1(P.composeDrawingPrompt({ plan, series, shot, drawing, wf })),
    sheets: ['turnaround', 'expressions', 'fullbody'].map((k) => sha1(P.characterSheetPrompt(k, hero, 'cel art'))),
    describe: sha1(P.describeCharacterPrompt({ name: '하루', description_ko: '단발', personality_ko: '씩씩' })),
  };
}

/** Date.now 를 고정해서 계산한다 (normalizeSeries 등이 빈 시각을 '지금' 으로 채우는 곳도 같은 값이 나오도록) */
function frozen(fn) {
  const real = Date.now;
  Date.now = () => 1700000000000;
  try { return fn(); } finally { Date.now = real; }
}

/** 모든 영역. m 은 옛 공개 이름을 가진 모듈들 { K, R, A, C, S, D, P }, sinkState 는 installFrameSink 의 반환값 */
async function computeAll(m, dir, sinkState) {
  return {
    keyer: computeKeyer(m),
    processCel: await computeProcessCel(m, dir),
    render: computeRender(m),
    renderShot: await computeRenderShot(m, dir, sinkState),
    audio: await computeAudio(m, dir),
    characters: frozen(() => computeCharacters(m)),
    series: frozen(() => computeSeries(m)),
    demo: computeDemo(m),
    prompts: computePrompts(m),
  };
}

module.exports = {
  sha1, rng, randomRgb, premultCel, straightCel, binaryCel, installFrameSink, demoCelPixels, noisyCel, clickTrack, toInt16, wavBytes, fakeRef, sampleCharacter, sampleSeries, demoCtx,
  computeKeyer, computeProcessCel, computeRender, computeRenderShot, computeAudio, computeCharacters, computeSeries, computeDemo, computePrompts, computeAll, frozen,
};
