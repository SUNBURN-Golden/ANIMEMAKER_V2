'use strict';
// 체험 모드: AI 없이 내 PC 에서 가짜 결과물을 만들어 전체 흐름을 무료로 확인한다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runFfmpeg } = require('../media/ffmpeg');
const { DEFAULT_ART_STYLE } = require('../defaults');
const { keyColorFor } = require('../media/keyer');
const { keyFrames, motionSlots } = require('../pipeline/xsheet');

const PALETTE = ['ff5e62', 'ff9966', 'f9d423', '7bc96f', '4facfe', '7c3aed', 'f472b6', '22d3ee', 'a3e635', 'fb7185', '60a5fa', 'fbbf24', '34d399', 'c084fc', 'f87171'];

/** 체험용 가사 (Suno 가사 형식) */
const DEMO_LYRICS = `[Intro]

[Verse 1]
작은 불빛 하나 따라
낯선 길을 걸어가
두근대는 이 마음이
나를 앞으로 데려가

[Chorus]
날아올라 저 하늘로
멈추지 마 지금 이대로
반짝이는 우리 꿈이
세상을 물들여

[Verse 2]
다시 한 번 손을 잡고
끝이 아닌 시작으로
함께라면 두렵지 않아
우리의 노래가 돼

[Chorus]
날아올라 저 하늘로
멈추지 마 지금 이대로
반짝이는 우리 꿈이
세상을 물들여

[Outro]`;

/** 체험용 캐릭터 (잠긴 상태로 만들어 바로 에피소드를 시작할 수 있게) */
const DEMO_CHARACTER = {
  name: '하루',
  personality_ko: '호기심 많고 씩씩한 열두 살 소녀. 겁이 나도 친구를 위해 먼저 손을 내민다.',
  description_ko: '짧은 갈색 단발머리, 큰 갈색 눈, 빨간 목도리, 노란 우비, 갈색 장화',
  locked: {
    summary: 'a cheerful 12-year-old girl with a short brown bob, big round brown eyes and a long red scarf',
    face: 'round soft face, small nose, rosy cheeks, thick expressive eyebrows',
    hair: 'short chestnut-brown bob with straight bangs and one cowlick on top',
    eyes: 'large round warm-brown eyes with a single white highlight',
    body: 'small and slim, about 145 cm tall, child proportions (head about 1/5 of height)',
    outfit: 'bright yellow raincoat with big round buttons, navy shorts, brown rubber boots',
    props: 'long red knitted scarf that always flutters behind her',
  },
  palette: [
    { name: 'scarf red', hex: '#d7263d' },
    { name: 'hair brown', hex: '#6b3e26' },
    { name: 'raincoat yellow', hex: '#f4c430' },
    { name: 'boots brown', hex: '#7a4a2a' },
    { name: 'skin', hex: '#f6d5bf' },
  ],
  rules: { must: ['always wears the long red scarf', 'always wears the yellow raincoat'], never: ['never change hair color or hairstyle', 'never older than 12'] },
};

function demoPlan(topic, wf, series) {
  const hero = series && series.characters && series.characters[0] ? series.characters[0].name : '주인공';
  const ep = series ? series.episode : 1;
  return {
    title: `${topic || `${hero}의 반짝이는 하루`} (체험)`,
    logline: `${hero} 이(가) 작은 불빛을 따라 하늘을 나는 이야기`,
    concept: '체험 모드에서 자동으로 만든 기획안이에요. 실제 AI 를 연결하면 가사와 지난 에피소드를 보고 훨씬 풍부한 이야기를 써요.',
    episode_summary_ko: `EP${ep}: ${hero} 이(가) 비 오는 골목에서 작은 불빛을 발견하고, 그 빛을 따라 하늘을 날며 새 친구를 만난다. 새벽 지붕 위에서 다음 모험을 약속한다.`,
    visual_style: (wf && wf.visualStyle) || 'hand-drawn cel animation',
    characters: series ? [] : [{ name: hero, description_ko: '밝은 표정의 주인공', appearance_en: DEMO_CHARACTER.locked.summary }],
    guest_characters: [{ name: '반디', description_ko: '빛나는 작은 반딧불 요정', appearance_en: 'a tiny glowing firefly spirit with soft green light' }],
    world_en: 'a small rainy harbor town at dusk with warm window lights and wet cobblestones',
    story: [
      { act: 1, sections: ['Intro', 'Verse 1'], summary_ko: `${hero} 이(가) 비 오는 골목에서 신비한 빛을 발견한다`, visual_en: `${hero} finds a tiny glowing light in a rainy alley` },
      { act: 2, sections: ['Chorus'], summary_ko: '빛을 따라 하늘로 날아오른다', visual_en: `${hero} flies over the rooftops following the light, scarf streaming` },
      { act: 3, sections: ['Verse 2'], summary_ko: '친구와 손을 잡고 다시 걷는다', visual_en: `${hero} and the firefly spirit walk along the harbor under the stars` },
      { act: 4, sections: ['Chorus', 'Outro'], summary_ko: '새벽, 지붕 위에서 미소 지으며 마무리', visual_en: `${hero} smiles at sunrise on a rooftop` },
    ],
    music: { genre: 'J-pop', mood: 'uplifting' },
  };
}

// 체험 배경 판의 장소 (인물 없이 장소만)
const DEMO_PLACES = ['a narrow rainy alley at dusk, puddles and paper lanterns', 'wet rooftops under a deep blue night sky', 'a quiet harbor under the stars', 'tiled rooftops at sunrise, soft pink clouds'];

/**
 * LLM 이 줄 법한 모양의 타임시트 (일부러 프레임 합계를 딱 맞추지 않고 '초' 와 '반복' 표기도 섞는다 → PC 가 고친다)
 * 움직이는 컷은 열쇠 그림을 사이클로, 멈춤 컷은 그림 1~2장을 길게.
 * @param {{segments:object[], frames:number[], highlights:boolean[], alloc:number[], plan:object, mode?:string, keyRate?:number, motion?:boolean[], layers?:boolean}} ctx
 */
function demoXsheet(ctx) {
  const moves = ['zoom_in', 'pan_right', 'truck_in', 'pan_left', 'zoom_out', 'pan_up', 'hold'];
  const hero = (ctx.plan && ctx.plan.characters && ctx.plan.characters[0] && ctx.plan.characters[0].name) || 'the hero';
  const acts = (ctx.plan && ctx.plan.story) || [];
  const motionMode = ctx.mode && ctx.mode !== 'limited';
  const unit = keyFrames(ctx.keyRate);
  return {
    shots: ctx.segments.map((s, i) => {
      const N = ctx.frames[i];
      const act = acts[Math.min(acts.length - 1, Math.floor((i / ctx.segments.length) * acts.length))] || { visual_en: 'a rainy town' };
      const motion = motionMode && !!(ctx.motion && ctx.motion[i]);
      const hl = ctx.highlights[i];
      let ids;
      let exposure;
      if (motion) {
        const slots = motionSlots(N, ctx.keyRate);
        ids = Array.from({ length: Math.max(2, Math.min(6, slots)) }, (_, k) => String.fromCharCode(65 + k));
        exposure = [{ cycle: ids, each: unit, repeat: Math.ceil(slots / ids.length) }];
      } else {
        const n = motionMode ? Math.min(2, Math.max(1, Math.round(N / 96))) : (ctx.alloc[i] || 1);
        ids = Array.from({ length: n }, (_, k) => String.fromCharCode(65 + k));
        exposure = !motionMode && hl
          ? [{ cycle: ids, each: 2, repeat: Math.ceil(N / (2 * ids.length)) }]
          : ids.map((d) => ({ drawing: d, seconds: Math.round((N / ids.length / 24) * 10) / 10 }));
      }
      return {
        shot: s.index,
        motion,
        highlight: hl,
        characters: [hero],
        scene_en: act.visual_en,
        framing_en: i % 2 ? 'medium shot' : 'wide shot',
        bg: { prompt_en: DEMO_PLACES[Math.max(0, acts.indexOf(act)) % DEMO_PLACES.length] },
        drawings: ids.map((d, k) => ({ id: d, prompt_en: motion ? `${hero} waving, key ${k + 1} of ${ids.length}: the arm a little further along the wave` : `${hero} ${k ? 'turns and smiles' : 'looks up at the light'}` })),
        exposure,
        camera: { move: motion ? (i % 2 ? 'truck_in' : 'pan_right') : moves[i % moves.length] },
        fx: i === 0 ? ['fade_in'] : hl ? ['sparkle'] : [],
        transition_out: { type: ['cut', 'dissolve', 'cut', 'fade', 'cut', 'fadeblack'][i % 6], beats: i % 2 ? 1 : 0 },
      };
    }),
  };
}

function hex(palette, i, d) {
  return String((palette && palette[i] && palette[i].hex) || d).replace('#', '');
}

/** 사람 모양 상자 그림 (몸·머리·머리카락·목도리·팔·다리) */
function figureBoxes(cx, by, u, pal, { arm = 0, scarf = 0, leg = 0 } = {}) {
  const r = (v) => Math.round(v);
  return [
    `drawbox=x=${r(cx - u * 0.5)}:y=${r(by)}:w=${r(u)}:h=${r(u * 1.9)}:color=0x${hex(pal, 2, '#f4c430')}:t=fill`,
    `drawbox=x=${r(cx - u * 0.45 - leg * u * 0.2)}:y=${r(by + u * 1.9)}:w=${r(u * 0.35)}:h=${r(u * 0.8)}:color=0x${hex(pal, 3, '#7a4a2a')}:t=fill`,
    `drawbox=x=${r(cx + u * 0.1 + leg * u * 0.2)}:y=${r(by + u * 1.9)}:w=${r(u * 0.35)}:h=${r(u * 0.8)}:color=0x${hex(pal, 3, '#7a4a2a')}:t=fill`,
    `drawbox=x=${r(cx - u * 0.42)}:y=${r(by - u * 0.85)}:w=${r(u * 0.84)}:h=${r(u * 0.85)}:color=0x${hex(pal, 4, '#f6d5bf')}:t=fill`,
    `drawbox=x=${r(cx - u * 0.48)}:y=${r(by - u * 0.95)}:w=${r(u * 0.96)}:h=${r(u * 0.35)}:color=0x${hex(pal, 1, '#6b3e26')}:t=fill`,
    `drawbox=x=${r(cx - u * 0.5)}:y=${r(by - u * 0.05)}:w=${r(u * (1 + scarf))}:h=${r(u * 0.25)}:color=0x${hex(pal, 0, '#d7263d')}:t=fill`,
    `drawbox=x=${r(cx + u * 0.45)}:y=${r(by + u * (0.2 - arm))}:w=${r(u * 0.7)}:h=${r(u * 0.22)}:color=0x${hex(pal, 2, '#f4c430')}:t=fill`,
  ];
}

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

module.exports = { DEMO_LYRICS, DEMO_CHARACTER, demoPlan, demoXsheet, demoDrawing, demoBg, demoCel, demoCharacterRef, demoImage, demoMusic, createDemoSeries };
