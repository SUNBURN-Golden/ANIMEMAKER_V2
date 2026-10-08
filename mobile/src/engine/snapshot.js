// 화면에 보내는 작품 상태(snapshot): PC 앱의 runner.snapshot() 과 같은 생각 — 저장된 작품 + 지금 상태.
// 덩어리(Blob)와 큰 글은 넣지 않는다. 받은 쪽은 이 객체를 고치면 안 된다 (읽기 전용).
import { EC, X, SubStyle } from './shared.js';
import { STEPS, STEP_LABELS } from './model.js';
import { buildQueue } from './queue.js';
import { REQUEST_MINUTES } from './workflows.js';
import { fmtMinutes } from './util.js';

/** 노래 길이(초). 아직 분석 전이면 null */
export function songSeconds(p) {
  return (p.music && p.music.analysis && p.music.analysis.duration) || (p.song && p.song.duration) || null;
}

/**
 * 이 폰에서 영상을 다시 만드는 데 걸릴 시간(초) 어림.
 * 지난번에 잰 시간(steps.render.lastMs)이 있으면 그것, 없으면 프레임 수 × 0.067초(샌드박스 측정) × 2.5 (※ 폰이 2.5배 느리다는 가정)
 */
export function renderEtaSec(p) {
  const rs = (p.steps && p.steps.render) || {};
  if (rs.lastMs > 0) return rs.lastMs / 1000;
  const frames = (p.xsheet && p.xsheet.totalFrames) || (songSeconds(p) || 60) * X.FPS;
  return frames * 0.067 * 2.5;
}

/** 고친 것 {render, subs, shots[], count, etaSec}. 폰은 영상을 통째로 다시 만들어서(장면별 캐시 없음) 바뀐 장면 수와 상관없이 같은 시간이 걸린다 */
export function changesOf(p) {
  const shots = Array.isArray(p.dirtyShots) ? [...p.dirtyShots] : [];
  const render = !!(p.renderStale || shots.length);
  const subs = !!p.subsStale;
  const count = (shots.length || (render ? 1 : 0)) + (subs ? 1 : 0);
  let etaSec = null;
  if (render || subs) {
    const song = songSeconds(p) || 60;
    const ss = (p.steps && p.steps.subtitles) || {};
    etaSec = Math.max(1, Math.round((render ? renderEtaSec(p) : 0) + (ss.lastMs > 0 ? ss.lastMs / 1000 : Math.max(10, song * 0.45))));
  }
  return { render, subs, shots, count, etaSec };
}

/** 고친 것 반영하기를 시작한다면 어느 단계부터인지 (할 일이 없으면 null) */
export function applyFromOf(p, hasClean) {
  return EC.decideApplyFrom({ steps: p.steps || {}, renderStale: p.renderStale, dirtyShots: p.dirtyShots, subsStale: p.subsStale, hasClean });
}

export function itemView(it) {
  return {
    key: it.key, kind: it.kind, shot: it.shot, id: it.id, status: it.status, prompt: it.prompt,
    hasPicture: !!(it.file && it.status === 'done'), keyed: it.keyed, keyReason: it.keyReason || null, w: it.w || null, h: it.h || null,
    source: it.source || null, custom: !!it.custom, note: it.note || null, promptEdited: !!it.promptEdited, redraws: it.redraws || 0,
    error: it.error || null, updatedAt: it.updatedAt || null,
    history: (it.history || []).map((h, index) => ({ index, at: h.at, kind: h.kind, note: h.note || null })),
  };
}

/** "지금 할 일" 한 줄 (큰 버튼 하나) */
function nextAction(p, canApply, redraws) {
  if (p.status === 'error') return { kind: 'error', label: p.error || '문제가 생겼어요' };
  if (p.status === 'running') {
    const st = (p.steps && p.steps[p.currentStep]) || {};
    return { kind: 'running', step: p.currentStep, label: st.message || '만드는 중이에요' };
  }
  if (p.status === 'waiting' && p.waiting) {
    if (p.waiting.kind === 'review') return { kind: 'review', key: p.waiting.key, label: p.waiting.title || '확인하고 계속하기' };
    return { kind: 'handoff', handoffKind: p.waiting.kind, key: p.waiting.key, label: p.waiting.title || 'AI 앱에 부탁하기' };
  }
  if (redraws.length) return { kind: 'handoff', handoffKind: 'redraw', key: redraws[0].key, label: '다시 그릴 그림을 부탁하기' };
  if (p.status === 'done') return canApply ? { kind: 'apply', label: '고친 것 반영하기' } : { kind: 'done', label: '완성했어요' };
  return { kind: 'run', label: p.status === 'stopped' ? '이어서 만들기' : '만들기 시작' };
}

/**
 * @param {import('./runtime.js').ProjectRuntime} rt
 */
export function buildSnapshot(rt) {
  const p = rt.p;
  const items = [...rt.drawings.values()];
  const changes = changesOf(p);
  const size = SubStyle.outputSize(p.workflow.aspect, p.workflow.quality);
  const segments = (p.timing && p.timing.segments) || [];
  const queue = buildQueue(p.xsheet, segments).map((q) => {
    const it = rt.drawings.get(q.key);
    return { key: q.key, kind: q.kind, shot: q.shot, id: q.id, weight: q.weight, status: it ? it.status : 'pending' };
  });
  const next = queue.find((q) => q.status === 'pending') || null;
  const count = (s) => items.filter((it) => it.status === s).length;
  const handoffText = p.providers.text !== 'demo';
  const textPending = handoffText ? (p.plan ? 0 : 1) + (p.xsheet ? 0 : 1) : 0;
  const imagePending = p.providers.image !== 'demo' ? count('pending') + count('running') + count('error') : 0;
  const remainingRequests = textPending + imagePending;
  const per = (p.workflow.phone && p.workflow.phone.requestMinutes) || REQUEST_MINUTES.mid;
  const work = {
    total: items.length, done: count('done'), skipped: count('skipped'), pending: count('pending'), running: count('running'), error: count('error'),
    textPending, remainingRequests, remainingMinutes: remainingRequests ? Math.max(1, Math.ceil(remainingRequests * per)) : 0,
  };
  work.text = work.remainingRequests ? `남은 부탁 ${work.remainingRequests}번 · ${fmtMinutes(work.remainingMinutes)}` : '부탁할 것이 없어요';
  const redrawing = (p.redraws || []).map((r) => ({ shot: Number(r.key.split(':')[0]), id: r.key.split(':')[1], key: r.key, status: r.status === 'running' ? 'running' : 'queued', note: r.note || null }));
  const hasClean = !!(p.output && p.output.clean);
  const canApply = !rt.running && !rt.busyKeying() && !rt._planning && p.status !== 'waiting' && applyFromOf(p, hasClean) !== null;
  const output = p.output || {};
  return {
    id: p.id, title: p.title, topic: p.topic, kind: p.kind, createdAt: p.createdAt, updatedAt: p.updatedAt,
    workflow: p.workflow, providers: p.providers, aspect: p.workflow.aspect, quality: p.workflow.quality,
    series: p.series ? { id: p.series.id, name: p.series.name, emoji: p.series.emoji, episode: p.series.episode, characters: p.series.characters.map((c) => ({ id: c.id, name: c.name })) } : null,
    status: p.status, running: rt.running, error: p.error || null, currentStep: p.currentStep || null,
    stepOrder: STEPS, stepLabels: STEP_LABELS, steps: p.steps,
    waiting: p.waiting || null, handoff: p.handoff ? { kind: p.handoff.kind, key: p.handoff.key, redraw: !!p.handoff.redraw, requestedAt: p.handoff.requestedAt } : null,
    next: nextAction(p, canApply, redrawing),
    song: p.song ? { name: p.song.name, size: p.song.size, rev: p.song.rev || 0 } : null,
    music: p.music ? { bpm: p.music.analysis && p.music.analysis.bpm, bpmOverride: p.music.bpmOverride || null, barNudge: p.music.barNudge || 0, analysis: p.music.analysis || null } : null,
    lyricsInput: p.lyricsInput, plan: p.plan, timing: p.timing, xsheet: p.xsheet,
    drawings: items.sort((a, b) => a.shot - b.shot || (a.id === 'bg' ? -1 : b.id === 'bg' ? 1 : a.id < b.id ? -1 : 1)).map(itemView),
    queue, nextKey: next ? next.key : null, work, redrawing,
    changes, subtitleStyle: SubStyle.normalizeStyle(p.workflow.subtitles, size), outSize: size, canApply,
    durationSec: songSeconds(p),
    estimate: p.xsheet ? p.xsheet.estimate : null,
    output: {
      clean: output.clean || null, video: output.video || null, srt: output.srt || null, lrc: output.lrc || null, draft: output.draft || null,
      madeAt: output.madeAt || null, cleanAt: output.cleanAt || null, bytes: output.bytes || null, seconds: output.seconds || null, codecs: output.codecs || null,
      burned: !!output.burned, hasVideo: !!output.video,
    },
    renderStale: !!p.renderStale, subsStale: !!p.subsStale, dirtyShots: [...(p.dirtyShots || [])], subsFallback: !!p.subsFallback,
    approvals: p.approvals, drawingsApproved: !!p.drawingsApproved,
    log: p.logTail || [],
  };
}
