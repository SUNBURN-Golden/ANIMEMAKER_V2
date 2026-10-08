'use strict';
// 체험 모드의 순수 부분: AI 없이 가짜 기획안·타임시트·가사·캐릭터·그림 상자 좌표를 만든다.
//  - PC 앱(ai/demo.js)과 폰 앱(안드로이드 WebView, esbuild 묶음)이 같은 파일을 쓴다 (scripts/shared-modules.js · test/shared-purity.test.js).
//    fs / os / path / ffmpeg 를 쓰지 않는다. 필요한 것은 pipeline/xsheet 의 순수 함수(keyFrames, motionSlots)뿐이다.
//  - 순수: PALETTE, DEMO_LYRICS, DEMO_CHARACTER, DEMO_PLACES, demoPlan, demoXsheet, hex, figureBoxes.
//    figureBoxes 는 ffmpeg drawbox 필터 글자를 돌려준다 (폰은 같은 숫자로 캔버스에 사각형을 그린다).
//  - ffmpeg(lavfi)로 그림·음악을 만드는 함수들(demoDrawing, demoBg, demoCel, demoCharacterRef, demoImage, demoMusic, createDemoSeries)은
//    ai/demo.js 에 남아 있고, 이 파일의 이름을 그대로 다시 내보낸다.
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

module.exports = { PALETTE, DEMO_LYRICS, DEMO_CHARACTER, DEMO_PLACES, demoPlan, demoXsheet, hex, figureBoxes };
