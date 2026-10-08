// 작품 기록 · 그림 기록의 모양과 만드는 순서(단계) 이름
//
// 작품 기록(projects 창고, 작게 유지): 그림은 넣지 않는다(drawings 창고에 따로), 덩어리(Blob)는 열쇠 이름만 가진다.
// 그림 기록(drawings 창고, 키 [projectId, key]): key = '<장면번호>:<그림id>' (배경 판은 '<장면번호>:bg')
import { drawingKey } from './keys.js';

export const STEPS = Object.freeze(['music', 'plan', 'timing', 'xsheet', 'drawings', 'render', 'subtitles']);
export const STEP_LABELS = Object.freeze({
  music: '노래 분석 (박자·마디)',
  plan: '이야기 짜기',
  timing: '가사 맞추기 · 컷 나누기',
  xsheet: '그림 순서표 짜기',
  drawings: '그림 모으기',
  render: '영상 만들기',
  subtitles: '자막 입히기',
});
export const SCHEMA = 2;
export const LOG_KEEP = 60;

/** 사용자에게 그대로 보이는 안내 (해요체) */
export const MSG = Object.freeze({
  noProject: '작품을 찾을 수 없어요.',
  runningNoEdit: '지금은 영상을 만드는 중이에요. 끝난 뒤에 바꿔 주세요.',
  runningNoRedraw: '지금은 영상을 만드는 중이에요. 끝난 뒤에 그림을 다시 그려 주세요.',
  redrawing: '그림을 정리하는 중이에요. 잠시 뒤에 다시 눌러 주세요.',
  planning: '그림 순서표를 다시 짜는 중이에요. 끝나면 다시 눌러 주세요.',
  noItem: '그림을 찾을 수 없어요.',
  noShot: '장면을 찾을 수 없어요.',
  noXsheet: '아직 그림 순서표가 없어요. 순서표를 만든 뒤에 바꿀 수 있어요.',
  itemBusy: '이 그림은 지금 정리하는 중이에요. 끝난 뒤에 해 주세요.',
  noVersion: '그 예전 그림을 찾을 수 없어요.',
  noFile: '고른 그림 파일을 찾을 수 없어요.',
  noSong: '노래 파일을 찾을 수 없어요. 노래를 다시 골라 주세요.',
  alreadyRunning: '이미 만드는 중이에요.',
  needSteps: '앞 단계를 먼저 끝내 주세요.',
  noMotionChange: '바꿀 내용이 없어요.',
  motionLate: '이미 그림을 다 모은 뒤에는 바꿀 수 없어요. 새 영상을 만들 때 골라 주세요.',
  motionBusy: '지금은 바꿀 수 없어요. 그림 수를 확인하는 단계에서만 바꿀 수 있어요.',
  notImage: '그림 파일(png, jpg, webp)을 골라 주세요.',
  badImage: '그림 파일을 읽지 못했어요. 다른 파일로 해 보세요.',
  nothingToSend: '지금 AI 앱에 부탁할 것이 없어요.',
});

export function newSteps() {
  return Object.fromEntries(STEPS.map((s) => [s, { status: 'pending' }]));
}

/**
 * 새 작품 기록
 * @param {{id:string, now:number, title:string, topic:string, kind:string, workflow:object, providers:{text:string,image:string},
 *          series:object|null, seriesId:string|null, song:object, lyricsInput:object}} o
 */
export function newProjectRecord(o) {
  return {
    id: o.id, schema: SCHEMA, title: o.title, topic: o.topic || '',
    createdAt: o.now, updatedAt: o.now,
    kind: o.kind, workflow: o.workflow, providers: o.providers,
    seriesId: o.seriesId || null, series: o.series || null,
    lyricsInput: o.lyricsInput, song: o.song,
    music: null, plan: null, planSource: null, timing: null, xsheet: null,
    status: 'idle', error: null, currentStep: null, steps: newSteps(), waiting: null,
    approvals: { lyrics: false }, drawingsApproved: false,
    handoff: null, redraws: [],
    renderStale: false, subsStale: false, dirtyShots: [], subsFallback: false,
    output: {}, logTail: [],
  };
}

/** 그림 기록 한 줄 (status: pending → running(받아서 정리하는 중) → done / skipped / error) */
export function newItem(projectId, kind, shotNo, id, prompt) {
  return {
    projectId, key: drawingKey(shotNo, id), kind, shot: shotNo, id, prompt,
    status: 'pending', file: null, cel: null, keyed: null, stats: null, keySource: null, keyReason: null,
    w: null, h: null, source: null, error: null, history: [],
  };
}

/** 그림이 있는 기록인가 (받아서 저장까지 끝난 것) */
export const hasPicture = (it) => !!(it && it.file && it.status === 'done');
