'use strict';
// 편집 백엔드의 '순수' 계산 모음 (파일·ffmpeg·러너 없이 테스트할 수 있다). edits.js / runner.js 가 가져다 쓴다. DESIGN §3
//  - 그림 기록(history) 고리: 최대 6개, 가장 최근 것이 맨 앞
//  - 다시 그리기 주문 글 (한국어 요청 → 영어 지시), 알기 쉬운 오류 문장
//  - 고친 것 반영하기: 어느 단계부터 (decideApplyFrom), 걸릴 시간 (applyEta)
//  - 화면 넘기기(전환) 만들기, 효과 검사, 새 영상 만들 때 얹는 워크플로우 값(workflowOverrides) 검사
//  - 그림 줄여서 빨리: 더 가벼운 후보 고르기
const { TRANSITIONS } = require('../media/timeline');
const X = require('./xsheet');

const FPS = 24;
const HISTORY_MAX = 6;
const NOTE_MAX = 200;
const STEP_ORDER = ['music', 'plan', 'timing', 'xsheet', 'drawings', 'render', 'subtitles'];

/** 화면에 그대로 보이는 안내 문장 (해요체) */
const MSG = {
  redrawing: '그림을 다시 그리는 중이에요. 끝나면 다시 눌러 주세요.',
  runningNoRedraw: '지금은 영상을 만드는 중이에요. 끝난 뒤에 그림을 다시 그려 주세요.',
  runningNoEdit: '지금은 영상을 만드는 중이에요. 끝난 뒤에 바꿔 주세요.',
  planning: '그림 순서표를 다시 짜는 중이에요. 끝나면 다시 눌러 주세요.',
  noItem: '그림을 찾을 수 없어요.',
  noShot: '장면을 찾을 수 없어요.',
  noXsheet: '아직 그림 순서표가 없어요. 영상을 만든 뒤에 바꿀 수 있어요.',
  itemBusy: '이 그림은 지금 다시 그리는 중이에요. 끝난 뒤에 해 주세요.',
  itemDrawing: '지금 이 그림을 그리는 중이에요. 끝난 뒤에 해 주세요.',
  noVersion: '그 예전 그림을 찾을 수 없어요.',
  noFile: '고른 그림 파일을 찾을 수 없어요.',
  previewBusy: '지금 영상을 만드는 중이라서 장면 미리보기를 잠깐 못 해요. 끝나면 다시 눌러 주세요.',
  previewRedraw: '이 장면의 그림을 다시 그리는 중이에요. 끝나면 미리 볼 수 있어요.',
  noMotionChange: '바꿀 내용이 없어요.',
  motionLate: '이미 그림을 다 그린 뒤에는 바꿀 수 없어요. 새 영상을 만들 때 골라 주세요.',
  motionBusy: '지금은 바꿀 수 없어요. 그림 수를 확인하는 단계에서만 바꿀 수 있어요.',
};

function round3(x) { return Math.round(x * 1000) / 1000; }

// ---------------------------------------------------------------- 그림 기록 (history)

/** 기록 파일 이름: shot03_A.v2.png (배경 판은 shot03_bg.v2.png) */
function historyName(shot, id, k, ext) {
  return `shot${String(shot).padStart(2, '0')}_${id}.v${k}${ext || '.png'}`;
}

/** 다음 기록 번호: 이 그림의 기록 파일 이름들 가운데 가장 큰 번호 + 1 (it.vseq 가 더 크면 그것 + 1) */
function nextVersion(it) {
  let k = Number(it && it.vseq) || 0;
  for (const h of (it && it.history) || []) {
    const m = /\.v(\d+)\.[^.]+$/.exec(String((h && h.file) || ''));
    if (m) k = Math.max(k, Number(m[1]));
  }
  return k + 1;
}

/** 기록 맨 앞에 넣는다. 최대 개수를 넘으면 가장 오래된 것부터 빼서 dropped 로 돌려준다 (파일 지우기는 부른 쪽이) */
function pushHistory(history, entry, max = HISTORY_MAX) {
  const list = [entry, ...(Array.isArray(history) ? history : [])];
  const dropped = list.splice(max);
  return { history: list, dropped };
}

/** 기록에서 하나를 꺼낸다 (바꿔치기용). 없으면 null */
function takeHistory(history, index) {
  const list = Array.isArray(history) ? history : [];
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= list.length) return null;
  return { entry: list[i], rest: list.filter((_, k) => k !== i) };
}

// ---------------------------------------------------------------- 다시 그리기 주문 글

/** 한국어 요청: 한 줄로, 앞뒤 공백 없이, 200자까지 */
function normalizeNote(note) {
  return String(note == null ? '' : note).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);
}

/** 그림 주문 글 뒤에 붙이는 한 줄 (한국어 요청 그대로) */
function changeRequestLine(note) {
  return `USER CHANGE REQUEST: ${note} (keep the character design, palette and everything else identical)`;
}

/** 지금 그림을 고쳐 달라고 첫 번째로 붙일 때 그 그림에 달아 주는 설명 */
const CUR_NOTE = {
  cel: 'the current drawing of this same shot — EDIT this image: change only what the user change request says, keep everything else identical',
  bg: 'the current background painting of this shot — EDIT this image: change only what the user change request says; keep the place, framing, palette, light and painting style identical (no characters)',
  full: 'the current drawing of this same shot — EDIT this image: change only what the user change request says, keep everything else identical',
};

/**
 * 한국어 요청으로 고쳐 그릴 때의 전체 주문 글: 고치기(edit) 안내 + 원래 주문 글 + USER CHANGE REQUEST 한 줄.
 * @param {{base:string, note:string, kind:'cel'|'bg'|'full', keyColor?:string|null}} o
 */
function notePrompt({ base, note, kind, keyColor }) {
  const head = kind === 'bg'
    ? ['EDIT MODE: Edit the first attached image (the current background painting of this shot). Change only what the user change request below asks.',
      'Keep the place, composition, palette, lighting and painting style the same. Do not add any characters.']
    : ['EDIT MODE: Edit the first attached image (the current drawing of this shot). Change only what the user change request below asks.',
      `Keep the character's design, line style, colours, size and position on the frame the same${keyColor ? `, and keep the plain flat solid ${String(keyColor).toUpperCase()} background` : ', and keep the same background'}.`];
  return [...head, '', String(base || ''), '', changeRequestLine(note)].join('\n');
}

/** 그림 AI 가 실패했을 때 화면에 보여 줄 쉬운 문장 */
function friendlyDrawError(e, what = '그림') {
  const first = String((e && e.message) || e || '').split('\n')[0].trim();
  const kind = e && e.kind;
  if (e && e.name === 'AbortError') return '그림 다시 그리기를 멈췄어요.';
  if (kind === 'limit' || (e && e.name === 'LimitError')) return '오늘 쓸 수 있는 만큼 다 썼어요. 조금 쉬었다가 다시 해 주세요.';
  if (kind === 'auth') return 'AI 연결(로그인)이 풀렸어요. 설정에서 다시 연결해 주세요.';
  if (kind === 'notInstalled') return 'AI 연결 프로그램이 설치되어 있지 않아요. 설정에서 확인해 주세요.';
  return `${what}을 다시 그리지 못했어요. 잠시 뒤에 다시 눌러 주세요.${first ? ` (${first.slice(0, 120)})` : ''}`;
}

// ---------------------------------------------------------------- 고친 것 반영하기

/**
 * 고친 것 반영하기를 어느 단계부터 시작할지.
 *  (a) 끝나지 않은 단계가 있으면 그 단계부터  (b) 그림·카메라·시간·효과·전환이 바뀌었으면 'render'  (c) 자막만 바뀌었으면 'subtitles'  (d) 할 일이 없으면 null
 * 둘 이상이 겹치면 가장 앞 단계부터 (자막 모양을 바꾸면 자막 단계가 '대기' 로 바뀌는데, 영상도 고쳤다면 영상부터 다시 만들어야 하므로).
 * 자막부터 하려는데 깨끗한 원본이 없으면 'render' 부터 (원본을 먼저 만들어야 하므로).
 */
function decideApplyFrom({ steps, renderStale, dirtyShots, subsStale, hasClean }) {
  const idx = (s) => STEP_ORDER.indexOf(s);
  let from = null;
  for (const s of STEP_ORDER) if (!steps || !steps[s] || steps[s].status !== 'done') { from = s; break; } // (a)
  const needRender = !!(renderStale || (Array.isArray(dirtyShots) && dirtyShots.length));
  if (needRender && (from === null || idx('render') < idx(from))) from = 'render'; // (b)
  if (subsStale && from === null) from = 'subtitles'; // (c)
  if (from === 'subtitles' && hasClean === false) from = 'render';
  return from;
}

/**
 * 걸릴 시간(초). 지난번에 잰 시간이 있으면 그것으로, 없으면 노래 길이로 어림한다.
 *  - 영상(render): 바뀐 장면마다 '움직이는 장면 / 멈춘 장면' 지난번 평균 시간 + 이어 붙이는 시간
 *    (장면별로 잰 값이 없으면 지난번 전체 시간 × 바뀐 장면 비율, 그것도 없으면 노래 길이 × 0.9)
 *  - 자막(subtitles): 영상을 다시 만들면 늘 뒤따른다. 지난번 시간, 없으면 노래 길이의 절반쯤(최소 10초)
 * @param {{render:boolean, subs:boolean, shots?:{motion:boolean}[], nChanged?:number, nShots?:number, songSec?:number, steps?:object}} o
 *   shots: 바뀐 장면들(움직이는 장면인지) · nChanged: 장면 정보가 없을 때 바뀐 장면 수
 * @returns {number|null} 할 일이 없으면 null
 */
function applyEta({ render, subs, shots = null, nChanged = 0, nShots = 0, songSec = 0, steps = {} }) {
  if (!render && !subs) return null;
  const song = Number(songSec) > 0 ? Number(songSec) : 60;
  const rs = steps.render || {};
  const ss = steps.subtitles || {};
  let sec = 0;
  if (render) {
    const list = Array.isArray(shots) && shots.length ? shots : null;
    const n = list ? list.length : nChanged > 0 ? nChanged : Math.max(1, nShots);
    const per = (motion) => (motion ? rs.motionShotMs : rs.holdShotMs) || rs.shotMs || 0;
    if (rs.assembleMs > 0 && (rs.shotMs > 0 || rs.motionShotMs > 0 || rs.holdShotMs > 0)) {
      const each = list ? list.reduce((a, x) => a + per(x.motion), 0) : n * (rs.shotMs || rs.holdShotMs || rs.motionShotMs);
      sec += (each + rs.assembleMs) / 1000;
    } else if (rs.lastMs > 0 && nShots > 0 && (!rs.shotsTotal || rs.shotsRendered === rs.shotsTotal)) {
      sec += (rs.lastMs / 1000) * Math.min(1, n / nShots);
    } else {
      sec += song * 0.9;
    }
  }
  if (render || subs) sec += ss.lastMs > 0 ? ss.lastMs / 1000 : Math.max(10, song * 0.45);
  return Math.max(1, Math.round(sec));
}

// ---------------------------------------------------------------- 장면 넘기기 · 효과

/** 장면 하나에서 다음 장면으로 넘어가는 모양 만들기 (xsheet.transitions[i] 모양). 길이(frames)는 지금 것을 지킨다 */
function makeTransition(type, { prev, framesA, framesB, beatPeriod = 0.5 }) {
  const def = TRANSITIONS[type];
  if (!def) return null;
  if (!def.xfade) return { type: 'cut', xfade: null, duration: 0, frames: 0 };
  const beats = type === 'flash' ? 0.5 : 1;
  let fr = prev && prev.frames > 0 ? prev.frames : Math.max(2, Math.round((beats * beatPeriod * FPS) / 2) * 2);
  fr = Math.min(fr, Math.floor((Math.min(framesA, framesB) * 0.6) / 2) * 2);
  if (fr < 2) return { tooShort: true };
  return { type, xfade: def.xfade, duration: round3(fr / FPS), frames: fr };
}

/** 컷의 transition_out 모양 (타임시트에 같이 적어 둔다): beats 는 0.25 단위 */
function transitionOut(tr, beatPeriod = 0.5) {
  if (!tr || !tr.frames) return { type: 'cut', beats: 0 };
  const beats = Math.max(0, Math.min(2, Math.round((tr.frames / FPS / (beatPeriod || 0.5)) * 4) / 4));
  return { type: tr.type, beats };
}

/** 효과 목록 검사: 알아듣는 이름(별칭 포함)만, 중복 없이, 3개까지. 틀린 것이 있으면 알려 주는 문장을 돌려준다 */
function checkFx(raw) {
  const list = Array.isArray(raw) ? raw : raw == null || raw === '' ? [] : [raw];
  const fx = X.normalizeFx(list);
  const bad = list.filter((x) => X.normalizeFx([x]).length === 0).map((x) => (typeof x === 'object' && x ? x.type || x.name : x)).filter((x) => x != null && x !== '');
  if (bad.length) return { error: `알 수 없는 효과예요: ${bad.join(', ')}` };
  const uniq = new Set(list.flatMap((x) => X.normalizeFx([x])));
  if (uniq.size > 3) return { error: '효과는 한 장면에 3개까지만 쓸 수 있어요.' };
  return { fx };
}

// ---------------------------------------------------------------- 새 영상: 영상 모양 덮어쓰기 (workflowOverrides)

const ASPECTS = ['16:9', '9:16', '1:1', '4:5'];
const QUALITIES = ['480p', '720p', '1080p'];
const PACES = ['slow', 'normal', 'fast'];
const OVERRIDE_KEYS = ['aspect', 'quality', 'motionMode', 'keyRate', 'drawingBudget', 'pace'];

/** 그림 장수 예산 값 검사: 0(자동) 또는 1~3000 의 정수. 틀리면 null */
function checkBudget(v) {
  if (v === '' || v == null || typeof v === 'boolean') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 3000) return null;
  return Math.round(n);
}

/**
 * 워크플로우에 얹을 값 걸러내기: 허용된 6개 키만, 값이 올바른 것만 (나머지는 조용히 버린다).
 * @returns {object} 얕게 합칠 값
 */
function normalizeOverrides(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  if (ASPECTS.includes(o.aspect)) out.aspect = o.aspect;
  if (QUALITIES.includes(o.quality)) out.quality = o.quality;
  if (X.MODES.includes(o.motionMode)) out.motionMode = o.motionMode;
  if (Number(o.keyRate) === 6 || Number(o.keyRate) === 8) out.keyRate = Number(o.keyRate);
  const b = o.drawingBudget === undefined ? null : checkBudget(o.drawingBudget);
  if (b !== null) out.drawingBudget = b;
  if (PACES.includes(o.pace)) out.pace = o.pace;
  return out;
}

// ---------------------------------------------------------------- 그림 줄여서 빨리

/** 지금보다 한 단계 가벼운 움직임 방식 후보들 (앞에서부터 시도) */
function lighterCandidates(mode, currentImages, shotCount, layers) {
  const out = [];
  if (mode === 'full') out.push({ motionMode: 'ghibli' }, { motionMode: 'limited' });
  else if (mode === 'ghibli') out.push({ motionMode: 'limited' });
  const floor = shotCount * (layers ? 2 : 1);
  const cut = Math.max(floor, Math.round((currentImages * 0.6) / 5) * 5);
  if (cut < currentImages) out.push({ motionMode: mode === 'full' ? 'ghibli' : mode, drawingBudget: cut });
  if (mode === 'ghibli' && cut < currentImages) out.push({ motionMode: 'limited', drawingBudget: cut });
  return out;
}

module.exports = {
  FPS, HISTORY_MAX, NOTE_MAX, STEP_ORDER, MSG, ASPECTS, QUALITIES, PACES, OVERRIDE_KEYS, CUR_NOTE,
  historyName, nextVersion, pushHistory, takeHistory,
  normalizeNote, changeRequestLine, notePrompt, friendlyDrawError,
  decideApplyFrom, applyEta,
  makeTransition, transitionOut, checkFx,
  checkBudget, normalizeOverrides, lighterCandidates,
};
