'use strict';
// 기본 설정과 기본 워크플로우(템플릿)

// 그림체 약속(스타일 바이블)의 기본값. 회사·작품 이름 대신 '어떤 그림인지' 를 영어로 풀어 쓴다.
const DEFAULT_ART_STYLE = 'hand-drawn 2D cel animation frame in the look of late-1980s to 1990s Japanese and classic Western feature animation: clean confident ink outlines, flat cel colors with one soft shadow tone, expressive faces, lush hand-painted watercolor and gouache backgrounds, warm natural light, gentle film-like softness';

// 화면에 보이는 그림체 예시 (한국어 이름 → 영어 설명)
const ART_PRESETS = [
  ['🌿 80~90년대 손그림 셀 애니 (지브리·디즈니 감성)', DEFAULT_ART_STYLE],
  ['🏰 클래식 동화 장편 애니', 'classic hand-drawn fairy-tale feature animation look: elegant flowing ink lines, rich painted backgrounds with soft glow, storybook color harmony, theatrical lighting, cel colors'],
  ['🧸 수채화 그림책', 'soft watercolor picture-book animation: pencil-like outlines, transparent watercolor washes, pastel colors, paper texture, cozy and gentle mood'],
  ['🌃 90년대 TV 애니', '1990s TV anime cel animation look: bold black outlines, two-tone cel shading, saturated colors, painted sky backgrounds, slight film grain'],
];

const DEFAULT_SETTINGS = {
  version: 2,
  firstRunDone: false,
  projectsDir: '', // 비어 있으면 문서\AnimeMaker V2
  downloadsDir: '', // 비어 있으면 시스템 다운로드 폴더
  providers: {
    text: 'demo',
    image: 'demo',
  },
  helperSites: { image: 'gemini' },
  agents: {
    codex: { path: '', model: '', extraArgs: '' },
    grok: { path: '', model: '', extraArgs: '' },
    agy: { path: '', model: '', extraArgs: '' },
    claude: { path: '', model: '', extraArgs: '' },
  },
  bot: {
    enabled: false,
    acceptedRisk: false,
    browser: 'edge', // edge | chrome | custom
    browserPath: '',
    pace: 1.0, // 1 = 사람 속도, 클수록 느리게
    gapSeconds: 8, // 생성 요청 사이 쉬는 시간
  },
  onLimit: 'wait', // wait: 기다렸다 자동 재시도 | stop: 멈추고 알려주기
  limitWaitMinutes: 20,
  limitMaxHours: 6,
  concurrency: { image: 1 },
};

const BASE_WORKFLOW = {
  aspect: '16:9',
  quality: '720p',
  visualStyle: DEFAULT_ART_STYLE, // 시리즈가 없을 때만 쓰인다 (시리즈가 있으면 시리즈의 그림체 약속을 따른다)
  // 컷(샷) 나누기: 영상 길이 = 노래 길이. 컷 경계는 박자 위에만 놓인다.
  minClips: 16,
  maxClips: 28,
  minClipSec: 2,
  maxClipSec: 16,
  pace: 'normal',
  // 움직임 방식
  //  ghibli : 지브리식 — 노래의 40~50% (후렴·신나는 컷)만 1초에 열쇠 그림 6~8장 + PC 가 사이 그림, 나머지는 멈춘 그림 + 카메라
  //  full   : 모든 컷을 움직임 (그림이 아주 많이 필요)
  //  limited: 리미티드 — 컷마다 그림 몇 장 + 카메라 (가장 적게 그림)
  motionMode: 'ghibli',
  keyRate: 6, // 움직이는 컷의 1초당 열쇠 그림 (6 → 4프레임씩, 8 → 3프레임씩)
  inbetween: 'auto', // 사이 그림: auto(RIFE 있으면 RIFE, 없으면 ffmpeg) | rife | ffmpeg | off
  layers: true, // 배경 판 + 인물 셀(단색 배경을 빼서 투명하게) 따로 그려서 겹치기
  // 그림 장수 예산 (상한선): 0 = 움직임 방식에 맞춰 자동. 숫자를 적으면 그보다 많이 그리지 않는다 (구독 사용량 지키기)
  drawingBudget: 0,
  transitionStyle: 'mixed',
  // 손그림 필름 느낌 마무리 (내 PC 에서 렌더링할 때 입힘)
  finish: { boil: true, grain: true, vignette: true, warm: true, paper: false },
  // 가사 자막: 모양은 프리셋 이름 하나로 (basic = 흰 글씨 + 검은 테두리, 아래 8%). 다른 칸은 비워 두면 프리셋 값을 따른다 → src/shared/subtitle-style.js
  // (예전 {sizePct, color:'white'|'yellow', box, marginPct} 형식도 그대로 읽는다)
  subtitles: { enabled: true, preset: 'basic' },
  extraInstructions: '',
  lyricSyncPause: true, // 가사에 시간이 없으면 컷을 나누기 전에 '탭으로 가사 맞추기' 기회를 준다
  reviewAfterPlan: false,
  reviewAfterTiming: false,
  reviewBeforeDrawings: true, // 그리기 전에 '그림 약 N장, 약 H시간' 예상을 보여 주고 멈추기 (체험 모드는 안 멈춤)
};

const BUILTIN_WORKFLOWS = [
  {
    ...BASE_WORKFLOW,
    id: 'builtin-cel-wide',
    builtin: true,
    emoji: '🌿',
    name: '손그림 셀 애니 (가로 16:9)',
    description: '유튜브용 가로 화면. 후렴·신나는 장면은 1초에 6장 + 사이 그림으로 부드럽게 움직이고(지브리식), 조용한 장면은 그림 몇 장을 길게 보여 주며 카메라가 천천히 움직여요. 처음이라면 이걸로!',
  },
  {
    ...BASE_WORKFLOW,
    id: 'builtin-cel-vertical',
    builtin: true,
    emoji: '📱',
    name: '세로 숏폼 셀 애니 (9:16)',
    description: '쇼츠·릴스·틱톡용 세로 화면. 컷을 조금 더 짧고 빠르게 나눠요.',
    aspect: '9:16',
    pace: 'fast',
    minClips: 18,
    maxClips: 30,
    minClipSec: 2,
    maxClipSec: 12,
    subtitles: { enabled: true, preset: 'shorts' }, // 아주 큰 글씨 + 버튼에 안 가려지는 안전 영역
  },
  {
    ...BASE_WORKFLOW,
    id: 'builtin-storybook',
    builtin: true,
    emoji: '🧸',
    name: '수채화 그림책 (정사각)',
    description: '1:1 정사각. 느린 노래에 어울리게 컷을 길게 쓰고 부드럽게 넘겨요. 종이 질감도 입혀요.',
    aspect: '1:1',
    pace: 'slow',
    minClips: 12,
    maxClips: 20,
    transitionStyle: 'smooth',
    visualStyle: ART_PRESETS[2][1],
    finish: { boil: true, grain: false, vignette: true, warm: true, paper: true },
  },
];

module.exports = { DEFAULT_SETTINGS, BASE_WORKFLOW, BUILTIN_WORKFLOWS, DEFAULT_ART_STYLE, ART_PRESETS };
