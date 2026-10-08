// 만드는 순서(7단계)와 그 돌리기. PC 앱 runner.js 의 run / step_* 를 폰 방식으로 옮긴 것.
//
// 폰 방식의 핵심: AI 앱의 답장을 기다릴 때 '기다리는 약속(Promise)'을 붙들지 않는다. 단계가 '기다려야 해요' 하고 멈추면
// p.waiting 을 저장하고 돌리기를 끝낸다 (status 'waiting'). 앱이 꺼져도 저장돼 있고, 답장/그림이 오면 engine 이 run() 을 다시 불러서
// 그 단계부터 이어 간다. 각 단계는 몇 번을 불러도 같은 결과가 나오게(다시 들어올 수 있게) 쓴다.
import { X, P, T, DD, SubStyle, SC } from './shared.js';
import { STEPS, STEP_LABELS, MSG } from './model.js';
import { BK } from './keys.js';
import { buildXsheetContext, planXsheet, keyColorOf, outSizeOf } from './workflows.js';
import { buildDrawings, nextPending, applyPicture, ensureCelsKeyed } from './drawings.js';
import { createMaterials } from './materials.js';
import { drawingsReviewExtra, reviewMessage } from './motion.js';
import { isAbortError, throwIfAborted, fmtSeconds } from './util.js';
import { buildQueue } from './queue.js';

const WAIT = Object.freeze({ wait: true });

export function friendlyError(e) {
  const first = String((e && e.message) || e || '').split('\n')[0].trim();
  if (!first) return '알 수 없는 문제가 생겼어요.';
  return /[가-힣]/.test(first) ? first : `문제가 생겼어요: ${first.slice(0, 160)}`;
}

function setWaiting(rt, w) {
  rt.p.waiting = { ...w };
}

const textRequestsOf = (rt) => (rt.p.providers.text === 'demo' ? 0 : 2);

// ───────────────────────── 돌리기 ─────────────────────────

/** 영상 만들기를 새로 시작할 수 있는지 (순서표를 다시 짜는 중이면 막는다) */
export function assertRunnable(rt) {
  if (rt._planning) throw new Error(MSG.planning);
}

/** 단계 이후의 결과를 '다시 해야 함' 으로 (그 단계부터 다시 할 때) */
export function resetFrom(rt, startIdx) {
  const { p } = rt;
  for (const s of STEPS.slice(startIdx)) if (p.steps[s]) p.steps[s] = { status: 'pending' };
  if (startIdx <= STEPS.indexOf('plan') && p.plan) p.planStale = true;
  if (startIdx <= STEPS.indexOf('timing')) p.approvals = { ...(p.approvals || {}), lyrics: false };
  if (startIdx <= STEPS.indexOf('xsheet') && p.xsheet) p.xsheetStale = true;
}

/**
 * 영상 만들기를 (from 단계부터) 돌린다. 끝났거나, 기다려야 하거나(AI 앱 부탁 · 확인), 멈추거나, 오류가 나면 돌려준다.
 * 이미 돌고 있으면 새로 시작하지 않고 그 일을 같이 기다린다.
 * @returns {Promise<object>} 작품 상태(snapshot)
 */
export function runPipeline(rt, { from } = {}) {
  if (rt.running) return rt.runPromise;
  assertRunnable(rt);
  if (from && !STEPS.includes(from)) return Promise.reject(new Error('알 수 없는 단계예요.'));
  rt.running = true;
  rt.ctl = new AbortController();
  rt.runPromise = (async () => {
    const { p } = rt;
    p.status = 'running';
    p.error = null;
    p.waiting = null;
    const startIdx = from ? STEPS.indexOf(from) : 0;
    if (from) resetFrom(rt, startIdx);
    try {
      await rt.save();
      for (let i = startIdx; i < STEPS.length; i++) {
        const step = STEPS[i];
        if (p.steps[step] && p.steps[step].status === 'done') continue;
        throwIfAborted(rt.ctl.signal);
        rt.setStep(step, { status: 'running', message: '진행 중…', startedAt: rt.now(), progress: null });
        rt.log(`▶ ${STEP_LABELS[step]} 시작`);
        const res = await STEP_IMPL[step](rt);
        if (res && res.wait) {
          rt.setStep(step, { status: 'waiting', message: p.waiting.message });
          p.status = 'waiting';
          rt.log(`⏸ ${p.waiting.title || STEP_LABELS[step]}`);
          return;
        }
        rt.setStep(step, { status: 'done', message: '완료', finishedAt: rt.now() });
        rt.log(`✔ ${STEP_LABELS[step]} 완료`);
        await rt.save();
      }
      p.status = 'done';
      p.waiting = null;
      rt.log('🎉 모든 단계가 끝났어요!');
    } catch (e) {
      const step = p.currentStep;
      if (isAbortError(e)) {
        p.status = 'stopped';
        if (step) p.steps[step] = { ...(p.steps[step] || {}), status: 'stopped', message: '중지됨' };
        rt.log('■ 중지했어요.');
      } else {
        p.status = 'error';
        p.error = friendlyError(e);
        if (step) p.steps[step] = { ...(p.steps[step] || {}), status: 'error', message: p.error };
        rt.log(`✖ 오류: ${(e && e.message) || e}`);
      }
      p.waiting = null;
    } finally {
      rt.running = false;
      rt.ctl = null;
      try { await rt.save(); } catch (e) { rt.engine.reportError(e); }
      rt.emit();
    }
  })().then(() => rt.snapshot());
  return rt.runPromise;
}

// ───────────────────────── 1. 노래 ─────────────────────────

/** 노래를 읽고 박자를 분석해서 p.music 에 적는다 (분석은 일꾼에서) */
export async function analyzeSongInto(rt) {
  const { p } = rt;
  const blob = await rt.getBlob(BK.song(rt.id));
  if (!blob) throw new Error(MSG.noSong);
  const prior = (p.music && p.music.bpmOverride) || null;
  const analysis = await rt.heavy(null, { title: '노래 분석하는 중', modal: true, foreground: false }, ({ signal }) => rt.services.analyzeSong(blob, { priorBpm: prior, signal }));
  p.music = {
    songRev: (p.song && p.song.rev) || 0, bpmOverride: prior, bpmUsed: prior, barNudge: 0, base: null, phase0: null,
    analysis, partRanges: [{ index: 1, start: 0, end: analysis.duration }],
  };
  p.song.duration = analysis.duration;
  const li = p.lyricsInput || { lines: [] };
  rt.log(`🎵 노래 ${P.fmtTime(analysis.duration)} · BPM ${analysis.bpm} · 마디 ${analysis.downbeats.length}개 · 가사 ${li.lines.length}줄${li.timed ? ' (시간 포함 가사)' : ''}`);
  return analysis;
}

async function stepMusic(rt) {
  const { p } = rt;
  const m = p.music;
  const reuse = m && m.analysis && m.songRev === ((p.song && p.song.rev) || 0) && (m.bpmUsed || null) === (m.bpmOverride || null);
  if (reuse) { p.song.duration = m.analysis.duration; return undefined; } // 다시 열어도 다시 분석하지 않는다
  rt.setStep('music', { message: '노래의 박자를 분석하는 중…' });
  await analyzeSongInto(rt);
  return undefined;
}

// ───────────────────────── 2. 기획 ─────────────────────────

export function applyPlan(rt, raw, source) {
  const { p } = rt;
  p.plan = P.normalizePlan(raw, rt.wf, rt.series);
  p.planStale = false;
  p.planSource = source;
  p.title = p.plan.title || p.title;
  if (rt.series) rt.log(`📺 ${rt.series.name} EP${rt.series.episode}: 주인공 ${rt.series.characters.map((c) => c.name).join(', ')} (고정)`);
  return p.plan;
}

async function stepPlan(rt) {
  const { p } = rt;
  if (p.plan && !p.planStale) return undefined;
  if (p.providers.text === 'demo') {
    applyPlan(rt, DD.demoPlan(p.topic, rt.wf, rt.series), 'demo');
    return undefined;
  }
  setWaiting(rt, { key: 'handoff:plan', kind: 'plan', title: '이야기 짜기를 AI 앱에 부탁하기', message: 'AI 앱에 이야기(기획)를 부탁해 주세요. 답장은 앱으로 공유하거나 붙여넣으면 돼요.' });
  return WAIT;
}

// ───────────────────────── 3. 타이밍 ─────────────────────────

/** 올린 가사 → 자막 줄 + 시간 (시간이 든 가사 파일이면 그대로, 아니면 자동 추정) */
export function computeLyrics(p) {
  const li = p.lyricsInput || { lines: [] };
  const { analysis } = p.music;
  const withSection = (arr) => arr.map((t, i) => ({
    ...t, part: 1,
    section: (li.lines[i] && li.lines[i].section) || t.section || '',
    sectionStart: li.lines[i] ? !!li.lines[i].sectionStart : !!t.sectionStart,
    ...((li.lines[i] && li.lines[i].hidden) || t.hidden ? { hidden: true } : {}),
  }));
  if (li.timed && li.timed.length) return { lyrics: withSection(li.timed), source: li.source };
  const est = T.estimateLyricTiming(li.lines.map((l) => ({ ...l, part: 1 })), p.music.partRanges, analysis, { trailingGaps: li.trailingGaps });
  return { lyrics: withSection(est), source: 'auto' };
}

async function stepTiming(rt) {
  const { p } = rt;
  const { analysis } = p.music;
  const parts = p.music.partRanges;
  const prev = p.timing || {};
  let lyrics;
  if (prev.lyricsSource === 'tap' && Array.isArray(prev.lyrics) && prev.lyrics.length) {
    lyrics = prev.lyrics;
    rt.log('⌨ 직접 맞춘(탭) 가사 타이밍을 사용해요.');
  } else {
    const c = computeLyrics(p);
    p.timing = { ...prev, lyrics: c.lyrics, lyricsSource: c.source };
    lyrics = c.lyrics;
    if (c.source !== 'auto' && lyrics.length) rt.log(`⏱ 가사 파일(${c.source})의 시간을 그대로 써요.`);
    await rt.save();
    // 탭으로 가사 시간을 맞출 기회: 시간이 없는 가사일 때만, 컷을 나누기 전에 (컷 경계가 가사 시작에 맞춰지므로)
    if (c.source === 'auto' && lyrics.length && rt.wf.lyricSyncPause !== false && !(p.approvals && p.approvals.lyrics)) {
      setWaiting(rt, {
        key: 'review:lyrics', kind: 'review', title: '가사 시간 맞추기',
        message: '가사 자막 시간을 맞출 차례예요. [탭으로 가사 맞추기] 를 누르고 노래를 들으며 줄이 시작될 때마다 톡 눌러 주면 정확해져요. (컷도 가사에 맞춰 나눠요) 건너뛰려면 [자동 추정으로 계속] 을 눌러 주세요.',
      });
      return WAIT;
    }
    lyrics = p.timing.lyrics; // 그 사이 탭으로 맞췄거나 가사를 고쳤을 수 있다
  }
  const range = T.scaledCutRange(rt.wf.minClips, rt.wf.maxClips, analysis.duration);
  if (range.minClips !== rt.wf.minClips) rt.log(`ℹ 3분보다 짧은 노래라서 컷 수를 ${range.minClips}~${range.maxClips}개로 줄였어요.`);
  const segments = T.segmentSong(analysis, lyrics, parts, { minClips: range.minClips, maxClips: range.maxClips, minLen: rt.wf.minClipSec, maxLen: rt.wf.maxClipSec, pace: rt.wf.pace });
  p.timing.segments = segments;
  p.timing.frames = X.shotFrames(segments);
  p.timing.highlights = X.markHighlights(segments, lyrics);
  rt.log(`✂ 컷 ${segments.length}개로 나눴어요 (하이라이트 ${p.timing.highlights.filter(Boolean).length}개): ${segments.map((s) => s.duration.toFixed(1)).join('s, ')}s`);
  await rt.save();
  return undefined;
}

// ───────────────────────── 4. 그림 순서표 ─────────────────────────

/**
 * 그림 순서표를 정해서 적용한다 (raw = AI 답장 · null 이면 PC 방식 기본 순서표). 그림 목록(buildDrawings)도 다시 만든다.
 * @param {'llm'|'fallback'|'demo'} source
 */
export async function applyXsheet(rt, raw, source) {
  const { p } = rt;
  const ctx = buildXsheetContext(p, rt.series);
  const xs = planXsheet(raw, ctx, { textRequests: textRequestsOf(rt) });
  xs.keyColor = keyColorOf(rt.series);
  xs.source = source;
  for (const n of xs.notes.slice(0, 30)) rt.log(`🔧 ${n}`);
  p.xsheet = xs;
  p.xsheetStale = false;
  p.drawingsApproved = false;
  await buildDrawings(rt);
  const e = xs.estimate;
  rt.log(`📋 그림 순서표 (${{ llm: 'AI 가 짬', fallback: 'PC 방식', demo: '연습' }[source] || source}): 컷 ${xs.shots.length}개 · 움직이는 컷 ${e.motionShots}개(${e.motionSeconds}초) · ${e.text}`);
  await rt.save();
  return xs;
}

async function stepXsheet(rt) {
  const { p } = rt;
  if (p.xsheet && !p.xsheetStale) return undefined;
  if (p.providers.text === 'demo') {
    await applyXsheet(rt, DD.demoXsheet(buildXsheetContext(p, rt.series)), 'demo');
    return undefined;
  }
  setWaiting(rt, {
    key: 'handoff:xsheet', kind: 'xsheet', title: '그림 순서표를 AI 앱에 부탁하기',
    message: 'AI 앱에 그림 순서표를 부탁해 주세요. AI 앱을 쓰지 않고 폰이 기본 순서표를 짜게 할 수도 있어요.',
    canFallback: true,
  });
  return WAIT;
}

// ───────────────────────── 5. 그림 모으기 ─────────────────────────

const itemTitle = (it) => (it.kind === 'bg' ? `배경 그림 · 컷 ${it.shot}` : `인물 그림 · 컷 ${it.shot}-${it.id}`);
export { itemTitle };

/** 연습용 그림 한 장 (연습 모드와 engine.demo.fill 이 같이 쓴다). 화면보다 조금 크게 그려서 카메라가 움직일 여유를 준다 */
export async function demoPicture(rt, it) {
  const { xs } = rt;
  const size = outSizeOf(rt.wf);
  const W = Math.round(size.w * 1.2);
  const H = Math.round(size.h * 1.2);
  if (it.kind === 'bg') return rt.services.demo.bg({ W, H, shot: it.shot });
  const shot = xs.shots.find((s) => s.shot === it.shot);
  const palette = rt.series && rt.series.characters[0] ? rt.series.characters[0].palette : DD.DEMO_CHARACTER.palette;
  const index = shot.drawings.findIndex((d) => d.id === it.id);
  const o = { W, H, shot: it.shot, index: Math.max(0, index), count: shot.drawings.length, highlight: !!shot.highlight, motion: !!shot.motion, keyColor: xs.keyColor, palette };
  return xs.layers ? rt.services.demo.cel(o) : rt.services.demo.drawing(o);
}

/** 연습 모드: 모든 그림을 연습용 그림으로 채운다 (받는 길과 똑같이 applyPicture 를 거친다) */
async function fillDemoPictures(rt) {
  const todo = buildQueue(rt.xs, (rt.p.timing && rt.p.timing.segments) || []).map((q) => rt.drawings.get(q.key)).filter((it) => it && it.status === 'pending');
  if (!todo.length) return;
  await rt.exclusive('pic', () => rt.heavy('key', { title: '연습 그림 만드는 중', modal: false, foreground: todo.length >= 4 }, async ({ signal, progress }) => {
    let n = 0;
    for (const it of todo) {
      throwIfAborted(signal);
      await applyPicture(rt, it, await demoPicture(rt, it), { mode: 'initial', signal });
      n++;
      progress(n / todo.length, `연습 그림 ${n}/${todo.length}장`);
      rt.setStep('drawings', { message: `${n}/${todo.length}장 완료`, progress: { done: n, total: todo.length } });
    }
  }));
}

async function stepDrawings(rt) {
  const { p } = rt;
  await rt.exclusive('pic', async () => {}); // 정리 중인 그림이 있으면 끝나길 기다린다
  const items = rt.items();
  const todo = items.filter((it) => !(it.status === 'done' && it.file) && it.status !== 'skipped');
  // 그리기 전에 예상 장수·시간을 보여 주고 멈춘다 (연습 모드는 공짜라 멈추지 않는다)
  if (todo.length && !p.drawingsApproved && rt.wf.reviewBeforeDrawings !== false && p.providers.image !== 'demo') {
    setWaiting(rt, { key: 'review:drawings', kind: 'review', title: '그림 수 확인', message: reviewMessage(rt), ...drawingsReviewExtra(rt) });
    return WAIT;
  }
  p.drawingsApproved = true;
  if (p.providers.image === 'demo') {
    await fillDemoPictures(rt);
    return undefined;
  }
  const next = nextPending(rt);
  if (!next) {
    const skipped = items.filter((it) => it.status === 'skipped').length;
    if (skipped) rt.log(`ℹ 건너뛴 그림 ${skipped}장은 가까운 다른 그림으로 대신 보여 줘요.`);
    return undefined;
  }
  const done = items.filter((it) => it.status === 'done').length;
  rt.setStep('drawings', { message: `${done}/${items.length}장 모았어요`, progress: { done, total: items.length } });
  setWaiting(rt, { key: `image:${next.key}`, kind: next.kind, title: itemTitle(next), message: `AI 앱에 ${itemTitle(next)} 을(를) 부탁해 주세요.`, itemKey: next.key });
  return WAIT;
}

// ───────────────────────── 6. 영상 만들기 ─────────────────────────

function renderProgress(rt) {
  return (e) => {
    const pct = Math.round((e.fraction || 0) * 100);
    const eta = e.etaMs > 1500 ? ` · 남은 시간 약 ${fmtSeconds(e.etaMs / 1000)}` : '';
    rt.setStep('render', { message: `깨끗한 원본 만드는 중 ${pct}%${eta}`, progress: { done: e.frame, total: e.total } });
  };
}

/** 깨끗한 원본(자막 없는 영상)을 만들어 Blob 으로 돌려준다 (작품 상태는 건드리지 않는다) */
export async function renderCleanBlob(rt, { draft = false, title = '영상 만드는 중', onProgress = rt.progressHook } = {}) {
  const { xs } = rt;
  if (!xs) throw new Error('그림 순서표가 없어요. 순서표 단계부터 다시 해 주세요.');
  const size = draft ? draftSize(rt) : outSizeOf(rt.wf);
  const songBlob = await rt.getBlob(BK.song(rt.id));
  const report = renderProgress(rt);
  return rt.heavy(null, { title, modal: true, foreground: true }, async ({ signal, progress }) => {
    const R = rt.services.render;
    const audio = songBlob ? await rt.services.decodeSong(songBlob) : null;
    const materials = createMaterials(rt, { draft });
    const compositor = R.createCompositor({ xs, W: size.w, H: size.h, materials, finish: rt.wf.finish, quality: draft ? 'low' : 'high' });
    return R.exportClean({
      compositor, audio, signal,
      onProgress: (e) => {
        progress(e.fraction, `영상 만드는 중 ${Math.round((e.fraction || 0) * 100)}%`);
        if (!draft) report(e);
        if (onProgress) { try { onProgress(e); } catch (_) { /* 화면 쪽 오류가 영상 만들기를 멈추면 안 된다 */ } }
      },
    });
  });
}

/** 초안(애니매틱)은 작은 크기로 빨리: 긴 변 640px */
function draftSize(rt) {
  const { w, h } = outSizeOf(rt.wf);
  const k = Math.min(1, 640 / Math.max(w, h));
  const even = (v) => Math.max(2, Math.round((v * k) / 2) * 2);
  return { w: even(w), h: even(h) };
}

async function stepRender(rt) {
  const { p } = rt;
  if (!p.xsheet) throw new Error('그림 순서표가 없어요. 순서표 단계부터 다시 해 주세요.');
  const t0 = rt.now();
  const unkeyed = rt.items().filter((it) => rt.layers && it.kind !== 'bg' && it.status === 'done' && it.file && (it.keyed == null || (it.keyed && !it.cel))).length;
  if (unkeyed) {
    rt.setStep('render', { message: `그림 ${unkeyed}장의 배경을 빼는 중…` });
    await rt.exclusive('pic', () => rt.heavy('key', { title: '그림 정리하는 중', modal: false, foreground: unkeyed >= 4 }, ({ signal }) => ensureCelsKeyed(rt, signal)));
  }
  const out = await renderCleanBlob(rt);
  throwIfAborted(rt.ctl && rt.ctl.signal);
  await rt.putBlob(BK.clean(rt.id), out.blob);
  p.output = {
    ...(p.output || {}), clean: BK.clean(rt.id), cleanAt: rt.now(), bytes: out.bytes, seconds: out.seconds, frames: out.frames,
    codecs: out.codecs, fallbackCodec: !!(out.fallback && (out.fallback.video || out.fallback.audio)), audioDropped: !!out.audioDropped,
  };
  p.renderStale = false;
  p.dirtyShots = []; // 지금까지 고친 장면이 모두 영상에 들어갔다
  p.subsStale = true;
  p.steps.render = { ...(p.steps.render || {}), lastMs: rt.now() - t0, msPerFrame: Math.round(out.msPerFrame || 0), shotsTotal: p.xsheet.shots.length };
  rt.log(`🎬 깨끗한 원본 (자막 없음): ${p.xsheet.totalFrames}프레임 · ${out.codecs.video}${out.codecs.audio ? `/${out.codecs.audio}` : ' (소리 없음)'}`);
  await rt.save();
  return undefined;
}

// ───────────────────────── 7. 자막 ─────────────────────────

async function stepSubtitles(rt) {
  const { p } = rt;
  const out = p.output || {};
  if (!out.clean) throw new Error('깨끗한 원본 영상이 없어요. [영상 만들기] 부터 다시 해 주세요.');
  const t0 = rt.now();
  const { w, h } = outSizeOf(rt.wf);
  const style = SubStyle.normalizeStyle(rt.wf.subtitles, { w, h });
  const total = p.xsheet.totalFrames / X.FPS;
  // 숨긴 줄은 영상에도 SRT/LRC 에도 넣지 않는다
  const shown = ((p.timing && p.timing.lyrics) || []).filter((l) => !l.hidden && l.text);
  const lines = shown.filter((l) => l.start < total).map((l) => ({ ...l, end: Math.min(l.end, total) }));
  const R = rt.services.render;
  let video = out.clean;
  let burned = false;
  let subsFallback = false;
  if (style.enabled && lines.length) {
    const clean = await rt.getBlob(out.clean);
    if (!clean) throw new Error('깨끗한 원본 영상을 찾을 수 없어요. [영상 만들기] 부터 다시 해 주세요.');
    rt.setStep('subtitles', { message: '가사 자막을 입히는 중…' });
    const r = await rt.heavy(null, { title: '자막 입히는 중', modal: true, foreground: true }, ({ signal, progress }) => R.burnSubtitles({
      clean, lines, style, W: w, H: h, signal,
      onProgress: (e) => {
        const f = e && typeof e.fraction === 'number' ? e.fraction : 0;
        progress(f, `자막 입히는 중 ${Math.round(f * 100)}%`);
        rt.setStep('subtitles', { message: `가사 자막 입히는 중 ${Math.round(f * 100)}%`, progress: { done: Math.round(f * 100), total: 100 } });
      },
    }));
    subsFallback = !!r.subsFallback;
    if (r.burned) {
      await rt.putBlob(BK.final(rt.id), r.blob);
      video = BK.final(rt.id);
      burned = true;
    }
  } else {
    rt.log('ℹ 자막이 꺼져 있거나 보여 줄 가사가 없어서 깨끗한 원본을 그대로 완성본으로 써요.');
  }
  if (!burned) await rt.delBlob(BK.final(rt.id)); // 예전에 입힌 완성본이 남아 있으면 치운다
  await rt.putBlob(BK.srt(rt.id), new Blob([R.makeSrt(shown)], { type: 'text/plain' }));
  await rt.putBlob(BK.lrc(rt.id), new Blob([R.makeLrc(shown, p.plan ? p.plan.title : p.title)], { type: 'text/plain' }));
  p.output = { ...out, video, srt: BK.srt(rt.id), lrc: BK.lrc(rt.id), madeAt: rt.now(), burned };
  p.subsStale = false;
  p.subsFallback = subsFallback;
  if (burned) p.steps.subtitles = { ...(p.steps.subtitles || {}), lastMs: rt.now() - t0 };
  if (p.seriesId && rt.series) await recordEpisode(rt);
  await rt.save();
  return undefined;
}

/** 시리즈 기록에 이번 에피소드 요약을 남긴다 (다음 에피소드 기획에 쓰인다) */
async function recordEpisode(rt) {
  const { p } = rt;
  try {
    const s = await rt.db.getSeries(p.seriesId);
    if (!s) return;
    const ep = SC.normalizeEpisode({ number: rt.series.episode, projectId: p.id, title: p.plan.title, summary_ko: p.plan.episode_summary_ko || '', madeAt: rt.now() });
    s.episodes = [...(s.episodes || []).filter((e) => e.number !== ep.number), ep].sort((a, b) => a.number - b.number);
    await rt.db.putSeries(s);
    rt.log(`📚 ${rt.series.name} 기록에 EP${ep.number} 요약을 남겼어요.`);
  } catch (e) {
    rt.log(`⚠ 시리즈 기록 실패: ${(e && e.message) || e}`);
  }
}

const STEP_IMPL = { music: stepMusic, plan: stepPlan, timing: stepTiming, xsheet: stepXsheet, drawings: stepDrawings, render: stepRender, subtitles: stepSubtitles };

