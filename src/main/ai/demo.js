'use strict';
// 체험 모드: AI 없이 내 PC 에서 가짜 결과물을 만들어 전체 흐름을 무료로 확인한다.
//  - 순수 부분(가짜 기획안 · 타임시트 · 가사 · 캐릭터 · 그림 상자 좌표)은 demo-data.js 로 옮겨 폰 앱과 같은 파일을 쓴다.
//    여기서는 그 이름을 그대로 다시 내보내므로 `require('./ai/demo')` 는 예전과 똑같이 쓸 수 있다.
//  - 여기에 남은 것: ffmpeg(lavfi)로 그림·음악을 만드는 함수들과 체험 시리즈 만들기 (fs · os · ffmpeg).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runFfmpeg } = require('../media/ffmpeg');
const { DEFAULT_ART_STYLE } = require('../defaults');
const { keyColorFor } = require('../media/keyer');
const data = require('./demo-data');

const { PALETTE, DEMO_CHARACTER, hex, figureBoxes } = data;

async function lavfiImage(src, vf, out, signal) {
  try {
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', src.gradient, '-vf', vf, '-frames:v', '1', out], { signal });
  } catch (_) {
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', src.flat, '-vf', vf, '-frames:v', '1', out], { signal });
  }
  return out;
}

/** 체험용 '그림': 컷마다 다른 배경 + 팔레트 색의 인물. 그림마다 자세·위치가 달라서 넘기면 움직여 보인다. */
async function demoDrawing({ shot = 1, index = 0, count = 1, highlight = false, palette = [], w = 1280, h = 720, out, signal }) {
  const c0 = PALETTE[(shot * 3) % PALETTE.length];
  const c1 = PALETTE[(shot * 3 + 5) % PALETTE.length];
  const u = Math.min(w, h) / 7;
  const ph = count > 1 ? index / count : 0;
  const cx = w * (highlight ? 0.3 + 0.4 * ph : 0.45 + 0.08 * ph);
  const by = h * 0.42 - (highlight ? u * 0.6 * Math.abs(Math.sin(ph * Math.PI * 2)) : 0);
  const vf = [
    `drawbox=x=0:y=${Math.round(h * 0.78)}:w=${w}:h=${Math.round(h * 0.22)}:color=0x2f5d3a@0.85:t=fill`,
    `drawbox=x=${Math.round(w * 0.72)}:y=${Math.round(h * 0.1)}:w=${Math.round(u * 0.9)}:h=${Math.round(u * 0.9)}:color=0xfff4c2@0.9:t=fill`,
    ...figureBoxes(cx, by, u, palette, { arm: index % 2 ? 0.7 : 0, scarf: highlight ? 0.3 + 0.4 * (index % 3) : 0.2 }),
  ].join(',');
  return lavfiImage({
    gradient: `gradients=s=${w}x${h}:c0=0x${c0}:c1=0x${c1}:x0=0:y0=0:x1=${w}:y1=${h}:d=1`,
    flat: `color=c=0x${c0}:s=${w}x${h}:d=1`,
  }, vf, out, signal);
}

/** 체험용 배경 그림 (BG plate): 하늘 · 언덕 · 해 · 나무, 인물 없음 */
async function demoBg({ shot = 1, w = 1280, h = 720, out, signal }) {
  const c0 = PALETTE[(shot * 3) % PALETTE.length];
  const c1 = PALETTE[(shot * 3 + 5) % PALETTE.length];
  const r = (v) => Math.round(v);
  const vf = [
    `drawbox=x=0:y=${r(h * 0.72)}:w=${w}:h=${r(h * 0.28)}:color=0x2f5d3a:t=fill`,
    `drawbox=x=${r(w * 0.05)}:y=${r(h * 0.62)}:w=${r(w * 0.35)}:h=${r(h * 0.12)}:color=0x4a7d4f:t=fill`,
    `drawbox=x=${r(w * 0.55)}:y=${r(h * 0.58)}:w=${r(w * 0.4)}:h=${r(h * 0.16)}:color=0x3e6e45:t=fill`,
    `drawbox=x=${r(w * 0.76)}:y=${r(h * 0.1)}:w=${r(h * 0.13)}:h=${r(h * 0.13)}:color=0xfff4c2:t=fill`,
    ...[0.12, 0.3, 0.68, 0.88].map((x, k) => `drawbox=x=${r(w * x)}:y=${r(h * (0.4 + 0.05 * (k % 2)))}:w=${r(w * 0.035)}:h=${r(h * 0.3)}:color=0x5a3d28:t=fill,drawbox=x=${r(w * (x - 0.03))}:y=${r(h * (0.3 + 0.05 * (k % 2)))}:w=${r(w * 0.095)}:h=${r(h * 0.14)}:color=0x2e7d32:t=fill`),
  ].join(',');
  return lavfiImage({
    gradient: `gradients=s=${w}x${h}:c0=0x${c0}:c1=0x${c1}:x0=0:y0=0:x1=0:y1=${h}:d=1`,
    flat: `color=c=0x${c0}:s=${w}x${h}:d=1`,
  }, vf, out, signal);
}

/**
 * 체험용 인물 셀: 단색(크로마키) 배경 위에 인물만. 움직이는 컷은 열쇠 그림마다 팔·다리·몸이 조금씩 움직인다.
 * @param {{index:number, count:number, motion:boolean, keyColor?:string, palette?:object[]}} o
 */
async function demoCel({ shot = 1, index = 0, count = 1, motion = false, keyColor, palette = [], w = 1280, h = 720, out, signal }) {
  const key = String(keyColor || keyColorFor(palette)).replace('#', '');
  const u = Math.min(w, h) / 7;
  // 반 칸 어긋난 위상: 이웃한 열쇠 그림끼리 늘 조금씩 다르다 (같은 자세가 두 번 이어지지 않게)
  const ang = count > 1 ? ((index + 0.5) / count) * Math.PI * 2 : 0;
  const cx = w * (0.48 + (motion ? 0.012 * Math.sin(ang) : 0.02 * index)) + (shot % 3) * w * 0.03;
  const by = h * 0.36 - (motion ? u * 0.1 * Math.abs(Math.cos(ang)) : 0);
  const vf = figureBoxes(cx, by, u, palette, {
    arm: motion ? 0.35 + 0.4 * Math.sin(ang) : (index % 2) * 0.5,
    leg: motion ? 0.8 * Math.cos(ang) : 0,
    scarf: motion ? 0.25 + 0.15 * Math.cos(ang) : 0.2,
  }).join(',');
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', `color=c=0x${key}:s=${w}x${h}:d=1`, '-vf', vf, '-frames:v', '1', out], { signal });
  return out;
}

/** 체험용 캐릭터 기준 그림 (턴어라운드 4면 · 표정 6개 · 전신) */
async function demoCharacterRef({ kind = 'turnaround', palette = [], w = 1536, h = 1024, out, signal }) {
  const u = Math.min(w, h) / 8;
  let boxes = [];
  if (kind === 'expressions') {
    for (let i = 0; i < 6; i++) {
      const cx = w * (0.2 + 0.3 * (i % 3));
      const cy = h * (0.3 + 0.42 * Math.floor(i / 3));
      boxes.push(
        `drawbox=x=${Math.round(cx - u)}:y=${Math.round(cy - u)}:w=${Math.round(u * 2)}:h=${Math.round(u * 2)}:color=0x${hex(palette, 4, '#f6d5bf')}:t=fill`,
        `drawbox=x=${Math.round(cx - u * 1.05)}:y=${Math.round(cy - u * 1.1)}:w=${Math.round(u * 2.1)}:h=${Math.round(u * 0.7)}:color=0x${hex(palette, 1, '#6b3e26')}:t=fill`,
        `drawbox=x=${Math.round(cx - u * 0.5)}:y=${Math.round(cy + u * (0.3 + 0.1 * (i % 3)))}:w=${Math.round(u)}:h=${Math.round(u * 0.15 * (1 + (i % 2)))}:color=0x7a2a2a:t=fill`,
      );
    }
  } else if (kind === 'fullbody') {
    boxes = figureBoxes(w * 0.5, h * 0.3, u * 1.6, palette, { scarf: 0.4 });
  } else {
    for (let i = 0; i < 4; i++) boxes.push(...figureBoxes(w * (0.14 + 0.24 * i), h * 0.32, u * 1.1, palette, { scarf: i === 3 ? 0 : 0.2 }));
  }
  return lavfiImage({ gradient: `color=c=0xfdfcf8:s=${w}x${h}:d=1`, flat: `color=c=0xfdfcf8:s=${w}x${h}:d=1` }, boxes.join(','), out, signal);
}

/** 단순한 가짜 그림 (테스트·도우미 연습용) */
async function demoImage({ index = 0, slot = 1, w = 720, h = 1280, out, signal }) {
  const c0 = PALETTE[index % PALETTE.length];
  const c1 = PALETTE[(index + 5 + slot) % PALETTE.length];
  const bx = Math.round(w * (0.15 + 0.25 * (slot - 1)));
  const vf = [
    `drawbox=x=${bx}:y=${Math.round(h * 0.55)}:w=${Math.round(w * 0.3)}:h=${Math.round(w * 0.3)}:color=white@0.85:t=fill`,
    `drawbox=x=${Math.round(w * 0.1)}:y=${Math.round(h * 0.1)}:w=${Math.round(w * 0.8)}:h=${Math.round(h * 0.03)}:color=black@0.35:t=fill`,
  ].join(',');
  return lavfiImage({
    gradient: `gradients=s=${w}x${h}:c0=0x${c0}:c1=0x${c1}:x0=0:y0=0:x1=${w}:y1=${h}:d=1`,
    flat: `color=c=0x${c0}:s=${w}x${h}:d=1`,
  }, vf, out, signal);
}

/** 박자가 분명한 체험용 음악 (킥 드럼 + 화음) */
async function demoMusic({ part = 1, seconds = 30, bpm = 120, out, signal }) {
  const p = (60 / bpm).toFixed(5);
  const bar = (240 / bpm).toFixed(5);
  const chords = part % 2 ? [261.63, 329.63, 392.0] : [220.0, 277.18, 329.63];
  const pad = chords.map((f, i) => `${(0.07 - i * 0.01).toFixed(3)}*sin(2*PI*${f}*t)`).join('+');
  const kick = `(1+0.6*lt(mod(t,${bar}),${p}))*0.55*sin(2*PI*(50+90*exp(-30*mod(t,${p})))*mod(t,${p}))*exp(-9*mod(t,${p}))`;
  const hat = `0.05*sin(2*PI*7000*t+30*sin(2*PI*3100*t))*exp(-60*mod(t+${(60 / bpm / 2).toFixed(5)},${p}))`;
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', `aevalsrc='${kick}+${hat}+${pad}':s=44100:d=${seconds}`,
    '-af', 'afade=t=in:d=0.3,volume=0.9', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '192k', out], { signal });
  return out;
}

/**
 * 체험용 시리즈 만들기: 체험 캐릭터(기준 그림 3장, 잠금) + 시리즈 하나.
 * @param {import('../store').Store} store
 */
async function createDemoSeries(store, { signal } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am2-demo-char-'));
  try {
    let c = store.characters.save({ ...DEMO_CHARACTER });
    for (const kind of ['turnaround', 'expressions', 'fullbody']) {
      const f = path.join(tmp, `${kind}.png`);
      await demoCharacterRef({ kind, palette: DEMO_CHARACTER.palette, w: kind === 'fullbody' ? 768 : 1536, h: 1024, out: f, signal });
      c = await store.characters.addRef(c.id, f, kind);
    }
    c = store.characters.lock(c.id);
    const series = store.series.save({
      name: '하루의 비 오는 마을 (체험)',
      emoji: '☔',
      characterIds: [c.id],
      bible: {
        art_en: DEFAULT_ART_STYLE,
        world_ko: '비가 자주 오는 작은 항구 마을. 따뜻한 창문 불빛과 젖은 돌길.',
        tone_ko: '포근하고 신비로운 모험, 마지막은 늘 희망차게.',
      },
    });
    return { character: c, series };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { ...data, demoDrawing, demoBg, demoCel, demoCharacterRef, demoImage, demoMusic, createDemoSeries };
