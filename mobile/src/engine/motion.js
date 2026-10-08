// 그림 줄여서 빨리(움직임 방식 · 그림 장수 예산 바꾸기) — PC 앱 edits.js 의 estimateMotion / lighterAlternative / setMotion 을 폰에 맞게 옮긴 것.
// 폰은 순서표를 다시 짤 때 AI 앱에 다시 부탁하지 않는다(부탁 한 번이 비싸서): 지금 순서표를 새 설정에 맞춰 PC 방식으로 다시 정리하거나, 더 많이 움직이는 쪽이면 기본 순서표를 짠다.
import { X, EC } from './shared.js';
import { MSG } from './model.js';
import { buildXsheetContext, planXsheet, keyColorOf } from './workflows.js';
import { buildDrawings } from './drawings.js';
import { clone } from './util.js';

const RANK = { limited: 0, ghibli: 1, full: 2 };

/** setMotion / estimateMotion 에 들어온 값 검사 → 바꿀 값만 */
export function motionPatch(o) {
  const out = {};
  const raw = o && typeof o === 'object' ? o : {};
  if (raw.motionMode !== undefined && raw.motionMode !== null && raw.motionMode !== '') {
    if (!X.MODES.includes(raw.motionMode)) throw new Error('알 수 없는 움직임 방식이에요. 신나는 부분만 · 계속 · 조금만 중에서 골라 주세요.');
    out.motionMode = raw.motionMode;
  }
  if (raw.drawingBudget !== undefined && raw.drawingBudget !== null && raw.drawingBudget !== '') {
    const b = EC.checkBudget(raw.drawingBudget);
    if (b === null) throw new Error('그림 장수는 0(자동) 또는 3000 이하의 숫자로 적어 주세요.');
    out.drawingBudget = b;
  }
  return out;
}

const textRequestsOf = (rt) => (rt.p.providers.text === 'demo' ? 0 : 2);

/** 새 설정으로 순서표를 다시 정리해 본다 (프로젝트는 안 바꾼다). 지금 순서표가 있고 더 가벼운 쪽이면 그 순서표를 다시 맞춰 세고, 아니면 기본 순서표로 센다 */
function replan(rt, patch) {
  const { p } = rt;
  const ctx = buildXsheetContext(p, rt.series, patch);
  const cur = p.xsheet;
  const lighter = !!cur && RANK[ctx.mode] <= RANK[cur.mode];
  let xs;
  let source = 'pc';
  if (lighter) {
    const raw = clone(cur.shots).map((s) => (ctx.mode === cur.mode ? s : { ...s, motion: undefined }));
    xs = planXsheet(raw, ctx, { textRequests: textRequestsOf(rt) });
    source = 'current';
  } else {
    xs = planXsheet(null, ctx, { textRequests: textRequestsOf(rt) });
  }
  xs.keyColor = keyColorOf(rt.series);
  return { xs, ctx, source };
}

/**
 * 움직임 방식 · 그림 장수 예산을 이렇게 바꾸면 그림이 몇 장, 몇 분쯤 걸릴지 어림한다 (프로젝트는 바꾸지 않는다).
 * @returns {{ready:boolean, pictures:number|null, minutes:number|null, text:string, bg?:number, cels?:number, inbetweens?:number, motionShots?:number, requests?:number, motionMode?:string, drawingBudget?:number, source?:string}}
 */
export function estimateMotion(rt, o = {}) {
  const patch = motionPatch(o);
  const { p } = rt;
  const t = p.timing;
  if (!(t && t.segments && p.music && p.music.analysis && p.plan)) return { ready: false, pictures: null, minutes: null, text: '' };
  const { xs, ctx, source } = replan(rt, patch);
  const e = xs.estimate;
  return {
    ready: true, pictures: e.images, minutes: e.minutes, text: e.text, bg: e.bg, cels: e.cels, inbetweens: 0, motionShots: e.motionShots, requests: e.requests,
    motionMode: ctx.mode, drawingBudget: Number(ctx.wf.drawingBudget) || 0, source,
  };
}

/** 지금보다 가벼운 방법 하나 (없으면 null): 15% 넘게 줄어드는 첫 후보, 없으면 가장 많이 줄어드는 것(조금이라도 줄 때만) */
export function lighterAlternative(rt) {
  const xs = rt.p.xsheet;
  if (!xs || !xs.estimate) return null;
  const now = xs.estimate.images;
  let best = null;
  for (const c of EC.lighterCandidates(xs.mode, now, xs.shots.length, xs.layers)) {
    let est;
    try { est = estimateMotion(rt, c); } catch (_) { continue; }
    if (!est.ready || est.pictures >= now) continue;
    const alt = { ...c, pictures: est.pictures, minutes: est.minutes, text: est.text };
    if (est.pictures <= now * 0.85) return alt;
    if (!best || alt.pictures < best.pictures) best = alt;
  }
  return best;
}

/** '그림 수 확인' 카드에 같이 보내는 값: 지금 예상 + [그림 줄여서 빨리] 를 누르면 되는 값 */
export function drawingsReviewExtra(rt) {
  const xs = rt.p.xsheet;
  const e = xs.estimate;
  let alt = null;
  try { alt = lighterAlternative(rt); } catch (_) { /* 예상이 안 돼도 카드는 보인다 */ }
  return {
    estimate: { pictures: e.images, minutes: e.minutes, text: e.text, requests: e.requests, warning: e.warning || null, assumption: e.assumption, motionMode: xs.mode, drawingBudget: Number(rt.wf.drawingBudget) || 0 },
    alt,
  };
}

export const reviewMessage = (rt) => `그림을 모으기 전에 확인해 주세요. ${rt.p.xsheet.estimate.text}. 괜찮으면 [계속] 을 눌러 주세요. 너무 많으면 [그림 줄여서 빨리] 로 장수를 줄일 수 있어요.`;

/**
 * 이 영상만 움직임 방식 · 그림 장수 예산을 바꾸고 그림 순서표를 다시 짠다. 타임시트를 짜기 전이거나 '그림 수 확인' 에서 기다리는 중(또는 그 단계에서 멈춘 상태)에만 된다.
 * 이미 받은 그림은 주문이 같으면 그대로 쓴다.
 * @returns {Promise<{motionMode:string, drawingBudget:number, replanned:boolean, pictures:number|null, minutes:number|null, text:string, estimate:object|null}>}
 */
export async function setMotion(rt, o = {}) {
  const patch = motionPatch(o);
  if (!Object.keys(patch).length) throw new Error(MSG.noMotionChange);
  if (rt._planning) throw new Error(MSG.planning);
  if (rt.busyKeying()) throw new Error(MSG.redrawing);
  const { p } = rt;
  const planned = !!(p.xsheet && p.steps.xsheet && p.steps.xsheet.status === 'done');
  const atReview = !!(p.status === 'waiting' && p.waiting && p.waiting.key === 'review:drawings');
  if (rt.running) throw new Error(MSG.motionBusy);
  if (planned && !atReview && p.steps.drawings && p.steps.drawings.status === 'done') throw new Error(MSG.motionLate);
  if (planned && !atReview && p.steps.drawings && p.steps.drawings.status === 'waiting') throw new Error(MSG.motionBusy);
  const prev = { motionMode: p.workflow.motionMode, drawingBudget: p.workflow.drawingBudget };
  Object.assign(p.workflow, patch);
  const summary = () => ({ motionMode: p.workflow.motionMode, drawingBudget: Number(p.workflow.drawingBudget) || 0 });
  if (!planned) {
    // 아직 순서표를 짜기 전: 설정만 바꾸면 된다 (다음에 순서표를 짤 때 쓰인다)
    rt.log(`🎛 이 영상의 움직임 설정을 바꿨어요 (${p.workflow.motionMode}${patch.drawingBudget !== undefined ? `, 그림 예산 ${p.workflow.drawingBudget || '자동'}` : ''}).`);
    await rt.save();
    let est = null;
    try { est = estimateMotion(rt, {}); } catch (_) { /* 어림이 안 돼도 설정은 바뀌었다 */ }
    rt.emit();
    return { ...summary(), replanned: false, pictures: est && est.ready ? est.pictures : null, minutes: est && est.ready ? est.minutes : null, text: est ? est.text : '', estimate: null };
  }
  const saved = { xsheet: p.xsheet, waiting: p.waiting, drawingsApproved: p.drawingsApproved };
  rt._planning = true;
  try {
    const { xs, source } = replan(rt, {});
    xs.source = source === 'current' ? 'refit' : 'fallback';
    p.xsheet = xs;
    p.drawingsApproved = false;
    await buildDrawings(rt);
  } catch (e) {
    p.workflow.motionMode = prev.motionMode;
    if (prev.drawingBudget === undefined) delete p.workflow.drawingBudget; else p.workflow.drawingBudget = prev.drawingBudget;
    Object.assign(p, saved);
    await rt.save();
    throw new Error(`그림 순서표를 다시 짜지 못했어요. 잠시 뒤에 다시 눌러 주세요. (${String((e && e.message) || e).split('\n')[0].slice(0, 120)})`);
  } finally {
    rt._planning = false;
  }
  p.steps.xsheet = { ...p.steps.xsheet, status: 'done', message: '완료' };
  if (!atReview && p.steps.drawings) p.steps.drawings = { ...p.steps.drawings, status: 'pending' };
  if (atReview) p.waiting = { ...p.waiting, ...drawingsReviewExtra(rt), message: reviewMessage(rt), busy: false };
  const e = p.xsheet.estimate;
  rt.log(`🎛 움직임 설정을 바꿔서 그림 순서표를 다시 짰어요 → ${e.text}`);
  await rt.save();
  rt.emit();
  return { ...summary(), replanned: true, pictures: e.images, minutes: e.minutes, text: e.text, estimate: e };
}
