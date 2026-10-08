// 만들기 방식 3가지('폰 가볍게' · '폰 지브리식' · '연습 모드') + 그림 순서표를 폰에 맞게 다듬기 + 부탁 횟수·시간 어림
//
// 공용 xsheet.js 는 고치지 않는다. 폰 가볍게에 필요한 설정(움직이는 장면 수, 배경을 막마다 1장, 멈춘 장면 그림 2장 이하)은
// 공용 함수가 돌려준 결과를 여기서 다듬어서 얻는다 (자세한 건 보고서의 '공용 코드 요청').
import { D, X, SubStyle, Key } from './shared.js';
import { sum, round1, fmtMinutes } from './util.js';

export const WORKFLOW_KINDS = Object.freeze(['phone-lite', 'phone-ghibli', 'demo']);
export const ASPECTS = Object.freeze(['9:16', '16:9', '1:1', '4:5']);
export const QUALITIES = Object.freeze(['480p', '720p', '1080p']);

/** AI 앱에 한 번 부탁하고(보내기 → 기다리기 → 그림 받아 오기) 끝나는 데 걸리는 분. ※ 가정이에요 — 재 본 값이 아니에요 */
export const REQUEST_MINUTES = Object.freeze({ low: 1, mid: 1.25, high: 1.5 });
export const ESTIMATE_ASSUMPTION = '부탁 한 번에 1~1.5분쯤 걸린다고 어림한 값이에요. AI 앱과 폰에 따라 달라요.';

/** 폰 모드의 그림 순서표·기획 부탁 글에 덧붙이는 영어 안내 (workflow.extraInstructions 로 들어간다) */
export const PHONE_GUIDE = 'PHONE MODE (small drawing budget): keep the story simple (5 to 6 acts); at most 2 short MOTION shots and every other shot is a HOLD shot; each HOLD shot has 1 or 2 drawings only; use the SAME bg.prompt_en text (word for word) for every shot that takes place in the same place or act, because only one background is painted per act.';

export const WORKFLOW_INFO = Object.freeze({
  'phone-lite': Object.freeze({
    id: 'phone-lite', emoji: '📱', name: '폰 가볍게',
    description: '움직이는 장면은 2개만, 그림은 50장 안쪽이에요 (배경은 이야기 막마다 1장). AI 앱에 부탁하는 횟수가 가장 적어요. 처음이라면 이걸로!',
    warning: null,
  }),
  'phone-ghibli': Object.freeze({
    id: 'phone-ghibli', emoji: '🌿', name: '폰 지브리식',
    description: '신나는 장면이 더 많이, 더 부드럽게 움직여요. 대신 그림이 훨씬 많이 필요해요.',
    warning: '그림을 100장 넘게 부탁해야 해서 몇 시간이 걸릴 수 있어요. 처음이라면 [폰 가볍게] 를 권해요.',
  }),
  demo: Object.freeze({
    id: 'demo', emoji: '🧪', name: '연습 모드',
    description: 'AI 앱 없이 연습용 그림과 노래로 끝까지 만들어 봐요. 만드는 순서를 익히는 데 좋아요.',
    warning: null,
  }),
});

/**
 * 만들기 방식 → 워크플로우(공용 BASE_WORKFLOW 사본 + 폰 설정).
 * phone: { kind, maxMotionShots(움직이는 장면 수 상한, null=제한 없음), maxHoldCels(멈춘 장면 그림 상한), bgGrouping('act'|'scene'|'shot'), requestMinutes }
 * @param {'phone-lite'|'phone-ghibli'|'demo'} kind
 * @param {{aspect?:string, quality?:string}} [o]
 */
export function makeWorkflow(kind, { aspect = '9:16', quality = '720p' } = {}) {
  if (!WORKFLOW_INFO[kind]) throw new Error(`알 수 없는 만들기 방식이에요: ${kind}`);
  const asp = ASPECTS.includes(aspect) ? aspect : '9:16';
  const q = QUALITIES.includes(quality) ? quality : '720p';
  const wf = JSON.parse(JSON.stringify(D.BASE_WORKFLOW));
  Object.assign(wf, {
    aspect: asp,
    quality: q,
    motionMode: 'ghibli',
    keyRate: 6,
    inbetween: 'off', // 사이 그림 엔진은 폰에서 끈다 (열쇠 그림을 그대로 이어 보여요)
    layers: true,
    finish: { boil: true, vignette: true, warm: true, grain: false, paper: false },
    subtitles: { enabled: true, preset: asp === '9:16' ? 'shorts' : 'basic' },
    reviewBeforeDrawings: true,
    lyricSyncPause: true,
  });
  if (asp === '9:16') Object.assign(wf, { pace: 'fast', minClipSec: 2, maxClipSec: 12 });
  if (kind === 'phone-lite') {
    Object.assign(wf, { drawingBudget: 52, minClips: 14, maxClips: 22, extraInstructions: PHONE_GUIDE }); // 52 ≈ 50: 공용 예산은 배경을 장면마다 1장으로 세므로, 막마다 1장으로 묶으면 34~40장쯤이 된다
    wf.phone = { kind, maxMotionShots: 2, maxHoldCels: 2, bgGrouping: 'act', requestMinutes: REQUEST_MINUTES.mid };
  } else if (kind === 'phone-ghibli') {
    Object.assign(wf, { drawingBudget: 0, extraInstructions: '' });
    wf.phone = { kind, maxMotionShots: null, maxHoldCels: null, bgGrouping: 'scene', requestMinutes: REQUEST_MINUTES.mid };
  } else {
    Object.assign(wf, { drawingBudget: 40, minClips: 8, maxClips: 12, reviewBeforeDrawings: false, extraInstructions: '' });
    wf.demoSongSeconds = 60;
    wf.phone = { kind, maxMotionShots: 2, maxHoldCels: 2, bgGrouping: 'act', requestMinutes: REQUEST_MINUTES.mid };
  }
  return wf;
}

/** 영상 크기 { w, h } (PC 의 outputSize 와 같다) */
export const outSizeOf = (wf) => SubStyle.outputSize(wf.aspect, wf.quality);

/** 셀 배경색: 시리즈 캐릭터 팔레트에 초록이 있으면 마젠타, 아니면 초록 */
export function keyColorOf(series) {
  const pal = series ? (series.characters || []).flatMap((c) => c.palette || []) : [];
  return Key.keyColorFor(pal);
}

// ───────────────────────── 그림 순서표 짜기 (공용 함수 + 폰 다듬기) ─────────────────────────

/** 움직이는 장면을 cap 개까지만: 하이라이트·에너지가 높은 장면부터 남긴다 (xsheet 의 prio 와 같은 기준) */
export function capMotion(motion, segments, highlights, mode, cap) {
  if (cap == null || !(cap >= 0) || mode !== 'ghibli') return motion;
  if (motion.filter(Boolean).length <= cap) return motion;
  const prio = (i) => (highlights[i] ? 2 : 0) + (typeof segments[i].level === 'number' ? segments[i].level : 0.5);
  const keep = new Set(motion.map((m, i) => (m ? i : -1)).filter((i) => i >= 0).sort((a, b) => prio(b) - prio(a) || a - b).slice(0, cap));
  return motion.map((_, i) => keep.has(i));
}

/**
 * runner.xsheetContext 의 폰 판. 타임시트(순서표)를 짜는 데 필요한 값들.
 * @param {object} p 작품 (timing · music · plan · workflow)
 * @param {object|null} series 얼려 둔 시리즈 사본
 * @param {{motionMode?:string, drawingBudget?:number}|null} [over] 지금 설정 대신 이 값으로 계산해 본다
 */
export function buildXsheetContext(p, series, over = null) {
  const t = p.timing;
  const analysis = p.music.analysis;
  const frames = t.frames || X.shotFrames(t.segments);
  const highlights = t.highlights || X.markHighlights(t.segments, t.lyrics);
  const wf = over ? { ...p.workflow, ...over } : p.workflow;
  const mode = X.MODES.includes(wf.motionMode) ? wf.motionMode : 'ghibli';
  const keyRate = Number(wf.keyRate) === 8 ? 8 : 6;
  const layers = wf.layers !== false;
  const motion = capMotion(X.assignMotion(t.segments, frames, highlights, mode), t.segments, highlights, mode, wf.phone && wf.phone.maxMotionShots);
  const budget = X.resolveBudget(wf, analysis.duration, t.segments.length, { mode, frames, motion, keyRate, layers });
  return {
    plan: p.plan, series, segments: t.segments, lyrics: t.lyrics, analysis, wf,
    frames, highlights, mode, keyRate, layers, motion, budget,
    alloc: X.allocateDrawings(frames, highlights, Math.max(t.segments.length, budget - (layers ? t.segments.length : 0))),
  };
}

/** AI 가 '움직임: 예' 로 적은 장면이 상한을 넘으면 '아니오' 로 고쳐서 공용 함수에 넘긴다 */
function sanitizeRawMotion(raw, ctx) {
  const ph = ctx.wf.phone || {};
  if (ph.maxMotionShots == null || ctx.mode !== 'ghibli') return raw;
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.shots) ? raw.shots : null;
  if (!list) return raw;
  const idxByShot = new Map(ctx.segments.map((s, i) => [s.index, i]));
  const out = list.map((s, k) => {
    if (!s || typeof s !== 'object' || s.motion !== true) return s;
    const no = Number(s.shot ?? s.index ?? s.clip ?? s.cut);
    const i = idxByShot.has(no) ? idxByShot.get(no) : list.length === ctx.segments.length ? k : -1;
    return i >= 0 && !ctx.motion[i] ? { ...s, motion: false } : s;
  });
  return Array.isArray(raw) ? out : { ...raw, shots: out };
}

/** 멈춘 장면의 그림을 max 장까지만 (남기는 건 앞쪽 그림, 노출은 박자에 맞춰 다시 나눈다) */
function capHoldCels(xs, ctx, max) {
  xs.shots.forEach((s, i) => {
    if (s.motion || s.drawings.length <= max) return;
    const kept = s.drawings.slice(0, max);
    const beats = X.beatFramesIn(ctx.segments[i], ctx.analysis || { beats: [] }, s.startFrame);
    s.drawings = kept;
    s.exposure = X.holdExposure(kept.map((d) => d.id), s.frames, beats);
  });
}

/**
 * 배경 판 묶기: 같은 막(act)·같은 장소의 이어진 장면은 배경 한 장을 같이 쓴다.
 *  'shot' 장면마다 한 장 · 'scene' 배경 주문 글이 같은 이어진 장면끼리 · 'act' 같은 막이거나 주문 글이 같은 이어진 장면끼리
 * @returns {{leader:number, shots:number[]}[]} leader = 배경을 그리는 장면 번호(묶음의 첫 장면)
 */
export function groupBackgrounds(xs, plan, mode = 'shot') {
  const n = xs.shots.length;
  const story = (plan && plan.story) || [];
  const actOf = (i) => (story.length ? Math.min(story.length - 1, Math.floor((i / Math.max(1, n)) * story.length)) : 0);
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const groups = [];
  xs.shots.forEach((s, i) => {
    if (!s.bg) return;
    const prompt = norm(s.bg.prompt_en);
    const last = groups[groups.length - 1];
    const same = last && mode !== 'shot' && ((mode === 'act' && last.act === actOf(i)) || (prompt && last.prompt === prompt));
    if (same) last.shots.push(s.shot);
    else groups.push({ leader: s.shot, shots: [s.shot], act: actOf(i), prompt });
  });
  return groups.map(({ leader, shots }) => ({ leader, shots }));
}

/** 그림 순서표 → 그릴 그림 수 · AI 앱에 부탁할 횟수 · 걸릴 시간 (※ 부탁 한 번 1~1.5분은 가정) */
export function estimateHandoffs(xs, wf = {}, o = {}) {
  const shots = xs.shots || [];
  const bg = xs.layers ? (xs.bgGroups ? xs.bgGroups.length : shots.filter((s) => s.bg).length) : 0;
  const cels = sum(shots.map((s) => s.drawings.length));
  const images = bg + cels;
  const textRequests = o.textRequests == null ? 2 : o.textRequests;
  const requests = images + textRequests;
  const per = (wf.phone && wf.phone.requestMinutes) || REQUEST_MINUTES.mid;
  const motionShots = shots.filter((s) => s.motion);
  const est = {
    images, bg, cels, inbetweens: 0,
    textRequests, imageRequests: images, requests,
    minutes: Math.max(1, Math.ceil(requests * per)),
    minutesLow: Math.max(1, Math.ceil(requests * REQUEST_MINUTES.low)),
    minutesHigh: Math.max(1, Math.ceil(requests * REQUEST_MINUTES.high)),
    secPerImage: Math.round(per * 60),
    motionShots: motionShots.length,
    motionSeconds: round1(sum(motionShots.map((s) => s.frames)) / X.FPS),
    assumption: ESTIMATE_ASSUMPTION,
  };
  est.text = estimateText(est);
  est.warning = est.minutes >= 120 ? '몇 시간이 걸릴 수 있어요. [그림 줄여서 빨리] 로 장수를 줄여 보세요.' : null;
  return est;
}

export function estimateText(e) {
  return `그림 약 ${e.images}장 (${e.bg ? `배경 ${e.bg}장 + ` : ''}인물 ${e.cels}장) · AI 앱에 ${e.requests}번쯤 부탁해야 해요 · 예상 ${fmtMinutes(e.minutes)}`;
}

/** 공용 정리가 끝난 순서표에 폰 설정(멈춘 장면 그림 상한 · 배경 묶기 · 부탁 횟수 어림)을 입힌다 */
export function finalizeXsheet(xs, ctx, o = {}) {
  const ph = (ctx.wf && ctx.wf.phone) || {};
  if (ph.maxHoldCels > 0) capHoldCels(xs, ctx, ph.maxHoldCels);
  xs.bgGroups = xs.layers ? groupBackgrounds(xs, ctx.plan, ph.bgGrouping || 'shot') : [];
  xs.bgOf = Object.fromEntries(xs.bgGroups.flatMap((g) => g.shots.map((s) => [s, g.leader])));
  xs.estimate = estimateHandoffs(xs, ctx.wf, o);
  xs.totalDrawings = xs.estimate.images;
  return xs;
}

/**
 * 그림 순서표 만들기. raw = AI 답장(없거나 망가졌으면 null → PC 방식 기본 순서표)
 * @returns {object} xs (공용 normalizeXsheet 결과 + bgGroups · bgOf · 폰 estimate)
 */
export function planXsheet(raw, ctx, o = {}) {
  const xs = X.normalizeXsheet(sanitizeRawMotion(raw, ctx), ctx);
  return finalizeXsheet(xs, ctx, o);
}

/** 장면 번호 → 그 장면이 쓰는 배경 판을 그리는 장면 번호 (묶음이 없으면 자기 자신) */
export const bgLeaderOf = (xs, shotNo) => (xs.bgOf && xs.bgOf[shotNo] != null ? xs.bgOf[shotNo] : shotNo);
