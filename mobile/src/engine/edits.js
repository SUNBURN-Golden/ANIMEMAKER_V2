// 고치기 (PC 앱 edits.js · subs.js · runner.js 의 편집 메서드와 같은 규칙, 폰 저장소에 맞춤)
//  그림: 내 그림으로 바꾸기(replace) · 예전 그림으로 되돌리기(restoreVersion) — 다시 그리기(regenerate)는 AI 앱 부탁이라 handoff.js
//  장면: 시간(retime) · 카메라(setCamera) · 효과(setFx) · 장면 넘기기(setTransition)
//  자막: 모양(setSubtitleStyle) · 줄(setLyricLines) · 한꺼번에(saveSubtitles) · 가사 글(updateLyricsText) · 탭 시간(updateLyrics)
//  그 밖: 이야기(updatePlan) · 노래(replaceSong) · BPM(setBpm) · 마디 시작(setBarNudge) · 고친 것 반영하기(applyChanges)
// 고치면 영상이 오래된 것이 된다: renderStale / dirtyShots (영상) · subsStale (자막). 영상 만드는 중에는 막는다(runningNoEdit).
import { X, EC, T, L, P, SubCore, SubStyle } from './shared.js';
import { BK } from './keys.js';
import { MSG, STEPS } from './model.js';
import { applyPicture, rekey, affectedShots, trimHistory } from './drawings.js';
import { analyzeSongInto, computeLyrics, resetFrom, runPipeline, assertRunnable } from './pipeline.js';
import { itemView, applyFromOf } from './snapshot.js';
import { clone } from './util.js';
import { outSizeOf } from './workflows.js';

const finished = (rt) => rt.save().then(() => { rt.emit(); });

function assertEditable(rt) {
  if (rt.running) throw new Error(MSG.runningNoEdit);
}

/** 영상을 이어 붙이는 중(영상 만들기 · 자막)에 그림을 바꾸면 '고친 표시' 가 사라질 수 있어서 막는다 */
function assertNotRendering(rt) {
  if (rt.running && ['render', 'subtitles'].includes(rt.p.currentStep)) throw new Error(MSG.runningNoEdit);
}

const shotIndex = (rt, shotNo) => {
  const { xs } = rt;
  if (!xs) throw new Error(MSG.noXsheet);
  const i = xs.shots.findIndex((s) => s.shot === shotNo);
  if (i < 0) throw new Error(MSG.noShot);
  return i;
};

/** 컷(구간)이 이미 정해졌는지 (그 뒤의 가사 수정은 자막만 다시 입힌다) */
export const cutsFixed = (p) => !!(p.steps.timing && p.steps.timing.status === 'done' && p.timing && p.timing.segments);

// ───────────────────────── 그림 ─────────────────────────

/**
 * 내가 고른 그림 파일로 바꾼다 (인물 셀이면 배경 빼기까지). 옛 그림은 '예전 그림' 으로 남고, 이 그림은 custom(내가 바꿈)이 되어서
 * 나중에 순서표를 다시 짜도 사라지지 않는다.
 * @param {Blob} blob
 * @param {{matchColors?:boolean}} [opts] matchColors: 같은 장면 첫 그림의 색에 맞춰 줄지 (기본 끔)
 */
export async function replace(rt, shotNo, id, blob, opts = {}) {
  const it = typeof id === 'string' ? rt.itemOf(shotNo, id) : null;
  if (!it) throw new Error(MSG.noItem);
  if (it.status === 'running' || (rt.p.redraws || []).some((r) => r.key === it.key && r.status === 'running')) throw new Error(MSG.itemBusy);
  assertNotRendering(rt);
  if (!blob || typeof blob.size !== 'number') throw new Error(MSG.noFile);
  if (blob.type && !/^image\//.test(blob.type)) throw new Error(MSG.notImage);
  await rt.exclusive('pic', () => rt.heavy('key', { title: '그림 바꾸는 중', modal: false, foreground: false }, ({ signal }) => applyPicture(rt, it, blob, { mode: 'replace', matchColors: !!(opts && opts.matchColors), signal })));
  rt.p.redraws = (rt.p.redraws || []).filter((r) => r.key !== it.key); // 내 그림으로 정했으니 다시 그리기 요청은 필요 없다
  if (rt.p.handoff && rt.p.handoff.key === it.key) rt.p.handoff = null;
  rt.log(`🖼 ${it.kind === 'bg' ? '배경' : `그림 컷${shotNo}-${id}`} 을 내 그림으로 바꿨어요.`);
  await finished(rt);
  return itemView(it);
}

/**
 * 예전 그림으로 되돌린다. 지금 그림은 '예전 그림' 맨 앞으로 가서 다시 돌아올 수 있다 (둘이 자리를 바꾼다).
 * @param {number} index 예전 그림 번호 (0 = 가장 최근)
 */
export async function restoreVersion(rt, shotNo, id, index) {
  const it = typeof id === 'string' ? rt.itemOf(shotNo, id) : null;
  if (!it) throw new Error(MSG.noItem);
  if (it.status === 'running' || (rt.p.redraws || []).some((r) => r.key === it.key && r.status === 'running')) throw new Error(MSG.itemBusy);
  assertNotRendering(rt);
  const taken = EC.takeHistory(it.history, index);
  const blob = taken && taken.entry.file ? await rt.getBlob(taken.entry.file) : null;
  if (!taken || !blob) throw new Error(MSG.noVersion);
  const { entry, rest } = taken;
  const picKey = BK.pic(rt.id, shotNo, id);
  // 1) 지금 그림 → 예전 그림 (새 번호로 복사)
  let curEntry = null;
  const cur = it.file ? await rt.getBlob(it.file) : null;
  if (cur) {
    const k = EC.nextVersion(it);
    const hk = BK.hist(rt.id, shotNo, id, k);
    await rt.putBlob(hk, cur);
    curEntry = { file: hk, at: it.updatedAt || rt.now(), kind: it.source === 'user' ? 'user' : 'ai' };
    if (it.note) curEntry.note = it.note;
    if (it.source === 'user' && it.matchColors) curEntry.matchColors = true;
    it.vseq = k;
  }
  // 2) 고른 예전 그림 → 지금 그림 자리
  await rt.putBlob(picKey, blob);
  await rt.delBlob(entry.file);
  // 3) 항목 칸 바꾸기: 그림 · 만든 방법 · 요청 글 (주문 글을 직접 고쳤던 그림이면 그 글도)
  const curPrompt = it.prompt;
  const wasEdited = it.promptEdited;
  Object.assign(it, { file: picKey, status: 'done', error: null, updatedAt: rt.now(), keyed: null, cel: null, stats: null, keySource: null, keyReason: null, custom: true, source: entry.kind === 'user' ? 'user' : 'ai' });
  await rt.delBlob(BK.cel(rt.id, shotNo, id));
  if (entry.note) it.note = entry.note; else delete it.note;
  if (entry.kind === 'user' && entry.matchColors) it.matchColors = true; else delete it.matchColors;
  if (entry.prompt && entry.prompt !== curPrompt) {
    if (curEntry) { curEntry.prompt = curPrompt; if (wasEdited) curEntry.promptEdited = true; }
    it.prompt = entry.prompt;
    if (entry.promptEdited) it.promptEdited = true; else delete it.promptEdited;
  }
  it.history = curEntry ? EC.pushHistory(rest, curEntry, Number.MAX_SAFE_INTEGER).history : rest;
  await trimHistory(rt, it);
  await rt.saveItem(it);
  await rt.exclusive('pic', () => rt.heavy('key', { title: '그림 정리하는 중', modal: false, foreground: false }, ({ signal }) => rekey(rt, it, { matchColors: it.source === 'user' ? !!it.matchColors : true, signal })));
  rt.markDirty(...affectedShots(rt, it));
  rt.log(`↩ ${it.kind === 'bg' ? '배경' : `그림 컷${shotNo}-${id}`} 을 예전 그림으로 되돌렸어요.`);
  await finished(rt);
  return itemView(it);
}

// ───────────────────────── 장면 (시간 · 카메라 · 효과 · 넘기기) ─────────────────────────

/** 그림 한 칸의 노출 프레임 바꾸기 (컷 길이는 그대로: 이웃 칸이 차이를 가져간다) */
export async function retime(rt, shotNo, index, frames) {
  assertEditable(rt);
  const i = shotIndex(rt, shotNo);
  rt.xs.shots[i] = X.retimeExposure(rt.xs.shots[i], index, frames);
  rt.markDirty(shotNo);
  await finished(rt);
  return rt.xs.shots[i];
}

/** 컷의 카메라 움직임 바꾸기 */
export async function setCamera(rt, shotNo, move) {
  assertEditable(rt);
  const i = shotIndex(rt, shotNo);
  if (!X.CAMERA_MOVES.includes(move)) throw new Error('알 수 없는 카메라 움직임이에요.');
  const shot = rt.xs.shots[i];
  shot.camera = X.normalizeCamera({ move }, shot.fx);
  rt.markDirty(shotNo);
  await finished(rt);
  return shot;
}

/** 장면의 효과를 바꾼다 (최대 3개; 이름은 xsheet.FX_TYPES · 별칭 가능; [] = 효과 없음) */
export async function setFx(rt, shotNo, fxArray) {
  assertEditable(rt);
  const i = shotIndex(rt, shotNo);
  const { xs } = rt;
  const chk = EC.checkFx(fxArray);
  if (chk.error) throw new Error(chk.error);
  const shot = xs.shots[i];
  shot.fx = chk.fx;
  shot.camera = X.normalizeCamera(shot.camera, shot.fx); // 흔들기 효과는 확대 여유가 필요하다
  const dirty = [shot.shot];
  // 앞 장면에서 스르륵 넘어오는 효과(dissolve_in)는 순서표를 짤 때처럼 앞 전환으로 바꾼다
  if (i > 0 && shot.fx.includes('dissolve_in') && xs.transitions[i - 1] && xs.transitions[i - 1].type === 'cut') {
    const tr = EC.makeTransition('dissolve', { prev: xs.transitions[i - 1], framesA: xs.shots[i - 1].frames, framesB: shot.frames, beatPeriod: beatPeriodOf(rt) });
    if (!tr.tooShort) {
      xs.transitions[i - 1] = tr;
      xs.shots[i - 1].transition_out = EC.transitionOut(tr, beatPeriodOf(rt));
      dirty.push(xs.shots[i - 1].shot);
    }
  }
  rt.markDirty(...dirty);
  await finished(rt);
  return shot;
}

const beatPeriodOf = (rt) => (rt.p.music && rt.p.music.analysis && rt.p.music.analysis.beatPeriod) || 0.5;

/** 이 장면에서 다음 장면으로 넘어가는 모양을 바꾼다 (길이는 지금 것을 지킨다). 앞뒤 두 장면이 모두 '바뀐 장면' 이 된다 */
export async function setTransition(rt, shotNo, type) {
  assertEditable(rt);
  const i = shotIndex(rt, shotNo);
  const { xs } = rt;
  if (i >= xs.shots.length - 1) throw new Error('마지막 장면은 다음 장면이 없어서 바꿀 수 없어요.');
  if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(T.TRANSITIONS, type)) throw new Error(`알 수 없는 장면 넘기기예요: ${String(type).slice(0, 30)}`);
  const tr = EC.makeTransition(type, { prev: xs.transitions[i], framesA: xs.shots[i].frames, framesB: xs.shots[i + 1].frames, beatPeriod: beatPeriodOf(rt) });
  if (tr.tooShort) throw new Error('장면이 너무 짧아서 이 모양으로는 넘길 수 없어요. 다른 모양을 골라 주세요.');
  xs.transitions[i] = tr;
  xs.shots[i].transition_out = EC.transitionOut(tr, beatPeriodOf(rt));
  rt.markDirty(xs.shots[i].shot, xs.shots[i + 1].shot);
  rt.log(`✨ 컷 ${shotNo} 다음 장면으로 넘어가는 모양: ${T.TRANSITIONS[type].label}`);
  await finished(rt);
  return tr;
}

// ───────────────────────── 자막 ─────────────────────────

function assertSubsIdle(rt) {
  const st = rt.p.steps && rt.p.steps.subtitles;
  if (rt.running && st && st.status === 'running') throw new Error('지금 자막을 영상에 입히는 중이에요. 끝난 뒤에 고쳐 주세요.');
}

/** 자막이 바뀌었다고 표시: 다음에 자막 단계가 다시 돈다 (컷이 정해진 뒤라면 단계를 '대기' 로) */
function markSubsStale(rt) {
  rt.p.subsStale = true;
  if (cutsFixed(rt.p) && rt.p.steps.subtitles) rt.p.steps.subtitles.status = 'pending';
}

/** 지금 작품의 자막 모양 (정규화본) */
export const subtitleStyleOf = (rt) => SubStyle.normalizeStyle(rt.wf.subtitles, outSizeOf(rt.wf));

/** 시리즈 전체의 기본 모양으로 저장 (enabled 는 에피소드마다 따로 정하므로 뺀다) */
async function saveSeriesStyle(rt, style) {
  const s = rt.p.seriesId && (await rt.db.getSeries(rt.p.seriesId));
  if (!s) return false;
  const { enabled, ...look } = style; // eslint-disable-line no-unused-vars
  s.subtitleStyle = look;
  await rt.db.putSeries(s);
  rt.log('📺 이 모양을 이야기 모음(시리즈) 전체의 기본 자막으로 저장했어요.');
  return true;
}

/** 줄 목록을 검사해 정리하고, 사라지는 맞춘 줄 수를 센다 (아직 적용하지 않는다) */
function prepareLines(rt, lines) {
  const { p } = rt;
  const duration = (p.song && p.song.duration) || (p.music && p.music.analysis && p.music.analysis.duration) || 0;
  const prev = (p.timing && p.timing.lyrics) || [];
  const clean = SubCore.cleanLyricLines(lines, { duration, prev });
  const timed = p.timing && p.timing.lyricsSource && p.timing.lyricsSource !== 'auto';
  const lost = timed && prev.length ? SubCore.lostCount(prev, clean) : 0;
  return { clean, lost: Math.max(0, lost) };
}

/** 정리한 줄을 적용: timing.lyrics · 원문(lyricsInput) · 컷의 가사 번호 · '고침' 표시 */
function commitLines(rt, clean) {
  const { p } = rt;
  if (!p.timing) p.timing = {};
  p.timing.lyrics = clean;
  p.timing.lyricsSource = 'tap'; // 사용자가 직접 정한 시간 → 다시 계산하지 않고 그대로 쓴다
  const li = p.lyricsInput || {};
  p.lyricsInput = {
    raw: L.linesToRaw(clean), source: 'text',
    lines: clean.map((l) => ({ text: l.text, section: l.section, sectionStart: l.sectionStart, gapBefore: 0, ...(l.hidden ? { hidden: true } : {}) })),
    timed: null, sections: [...new Set(clean.map((l) => l.section).filter(Boolean))], trailingGaps: li.trailingGaps || 0,
  };
  SubCore.relinkSegments(p.timing.segments, clean);
  markSubsStale(rt);
}

/**
 * 자막 모양 바꾸기. style 은 일부 칸만 있어도, 옛 형식이어도 된다 (AMSubtitleStyle.mergeStyle 규칙). 자막을 입히는 중만 아니면 언제든 된다.
 * @returns {Promise<object>} 정규화된 새 스타일
 */
export async function setSubtitleStyle(rt, style, opts = {}) {
  assertSubsIdle(rt);
  const next = SubStyle.mergeStyle(rt.wf.subtitles, style, outSizeOf(rt.wf));
  rt.wf.subtitles = next;
  markSubsStale(rt);
  if (opts && opts.applyToSeries) await saveSeriesStyle(rt, next);
  rt.log(`💬 자막 모양을 바꿨어요 (${SubStyle.describe(next)})${next.enabled ? '' : ' · 자막 끔'}`);
  await finished(rt);
  return next;
}

/**
 * 가사 줄 전체 교체 (글 고치기 · 나누기 · 합치기 · 숨기기 · 줄 추가/삭제 · 시간 고치기).
 * 줄: { text, start, end, hidden?, endLocked?, section?, sectionStart? }. 시간은 '직접 맞춤'(lyricsSource 'tap')이 된다.
 */
export async function setLyricLines(rt, lines) {
  assertSubsIdle(rt);
  const { clean } = prepareLines(rt, lines);
  commitLines(rt, clean);
  rt.log(`✏️ 가사 자막 ${clean.length}줄을 저장했어요.`);
  await finished(rt);
  return rt.p.timing.lyrics;
}

/**
 * 자막 모양과 가사 줄을 한 번에 저장 (둘 다 검사를 통과해야 적용된다).
 * @returns {Promise<{style:object, lines:object[], lost:number}>} lost = 사라진 '맞춘 시간' 줄 수
 */
export async function saveSubtitles(rt, o = {}) {
  assertSubsIdle(rt);
  const has = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (o.lines !== undefined && o.lines !== null && !Array.isArray(o.lines)) throw new Error('가사 줄 목록이 올바르지 않아요.');
  let next = null;
  let prepared = null;
  if (has(o.style)) next = SubStyle.mergeStyle(rt.wf.subtitles, o.style, outSizeOf(rt.wf));
  if (Array.isArray(o.lines)) prepared = prepareLines(rt, o.lines);
  if (next) {
    rt.wf.subtitles = next;
    markSubsStale(rt);
    if (o.applyToSeries) await saveSeriesStyle(rt, next);
  }
  if (prepared) {
    commitLines(rt, prepared.clean);
    rt.log(`✏️ 가사 자막 ${prepared.clean.length}줄을 저장했어요.`);
  }
  if (next) rt.log(`💬 자막 모양을 바꿨어요 (${SubStyle.describe(next)})${next.enabled ? '' : ' · 자막 끔'}`);
  if (next || prepared) await finished(rt);
  return { style: subtitleStyleOf(rt), lines: (rt.p.timing && rt.p.timing.lyrics) || [], lost: prepared ? prepared.lost : 0 };
}

/**
 * 가사 글 바꾸기 (붙여넣기 또는 .txt/.lrc/.srt 파일). 줄 수가 같으면 맞춰 둔 시간은 그대로 두고 글자만 바꾸고, 줄 수가 달라져도 직접 맞춘(탭) 시간은 지킨다(같은·비슷한 줄은 시간 유지, 새 줄은 이웃 사이로).
 * 시간이 든 .lrc/.srt 이거나 맞춘 시간이 없으면 새로 계산한다. 자막을 입히는 중에는 막힌다.
 * @param {{dryRun?:boolean}} [opts] dryRun: 적용하지 않고 사라질 줄 수만 알려 준다
 * @returns {Promise<{lost:number, kept:number, added:number, mode:'same'|'merge'|'recompute'|'timed'|'none'}>}
 */
export async function updateLyricsText(rt, raw, filename, opts = {}) {
  const { p } = rt;
  const st7 = p.steps && p.steps.subtitles;
  if (rt.running && st7 && st7.status === 'running') throw new Error('지금 자막을 영상에 입히는 중이에요. 끝난 뒤에 고쳐 주세요.');
  if (rt.running && !cutsFixed(p)) throw new Error('진행 중에는 바꿀 수 없어요.');
  const prev = (p.timing && p.timing.lyrics) || [];
  const prevSource = p.timing && p.timing.lyricsSource;
  const li = L.parseLyrics(raw, filename);
  const hasAnalysis = !!(p.music && p.music.analysis);
  let next = null;
  let info = { lost: 0, kept: 0, added: 0, mode: 'none' };
  if (hasAnalysis) {
    if (!li.timed && prev.length && li.lines.length === prev.length && (cutsFixed(p) || prevSource === 'tap')) {
      // 줄 수가 같으면 맞춰 둔 시간은 그대로 두고 글자만 바꾼다 (글이 바뀐 줄만 숨김 여부를 새로 읽는다)
      const lyrics = prev.map((l, i) => {
        const nl = li.lines[i];
        const same = SubCore.normText(l.text) === SubCore.normText(nl.text);
        const o = { ...l, text: nl.text, section: nl.section || l.section };
        if (!same) { delete o.words; if (nl.hidden) o.hidden = true; else delete o.hidden; }
        return o;
      });
      next = { lyrics, source: prevSource };
      info = { lost: 0, kept: prev.length, added: 0, mode: 'same' };
    } else if (!li.timed && prev.length && prevSource === 'tap') {
      const m = SubCore.mergeLyricLines(prev, li.lines, { beats: p.music.analysis.beats, duration: p.music.analysis.duration });
      if (m.matched > 0) {
        next = { lyrics: m.lyrics, source: 'tap' };
        info = { lost: m.lost, kept: m.matched, added: m.added, mode: 'merge' };
      }
    }
    if (!next) info = { lost: prevSource === 'tap' ? prev.length : 0, kept: 0, added: 0, mode: li.timed ? 'timed' : 'recompute' }; // 새로 계산하면 직접 맞춘 시간은 모두 사라진다
  }
  if (opts && opts.dryRun) return info;
  p.lyricsInput = li;
  if (hasAnalysis) {
    if (next) {
      p.timing = { ...(p.timing || {}), lyrics: next.lyrics, lyricsSource: next.source };
    } else {
      const c = computeLyrics(p);
      p.timing = { ...(p.timing || {}), lyrics: c.lyrics, lyricsSource: c.source };
    }
    SubCore.relinkSegments(p.timing.segments, p.timing.lyrics);
  }
  if (!rt.running) {
    if (cutsFixed(p)) { if (p.steps.subtitles) p.steps.subtitles.status = 'pending'; } else if (p.steps.timing) p.steps.timing.status = 'pending';
  } else if (cutsFixed(p) && p.steps.subtitles) {
    p.steps.subtitles.status = 'pending';
  }
  p.subsStale = true;
  await finished(rt);
  return info;
}

/**
 * 탭으로 맞춘 가사 타이밍 저장 (구간 정보는 같은 순서의 기존 줄에서 가져온다).
 * 숨긴 줄(hidden) · 끝을 직접 정한 줄(endLocked) · 단어 시간(words)은 글이 같은 기존 줄에서 이어받는다.
 */
export async function updateLyrics(rt, lyrics) {
  const { p } = rt;
  if (!p.timing) throw new Error('타이밍 단계가 아직 없어요.');
  const prev = p.timing.lyrics || [];
  const pairs = SubCore.matchLines(prev.map((l) => l.text), lyrics.map((l) => String(l.text)));
  const from = new Map(pairs.map((pr) => [pr.n, { old: prev[pr.o], exact: pr.exact }]));
  const matchedOld = new Set(pairs.map((pr) => pr.o));
  // 숨긴 줄은 탭 화면에 안 보여 줄 수도 있다 → 받은 목록에 없으면 원래 시간 그대로 다시 넣는다 (줄이 사라지지 않게)
  const keptHidden = prev.filter((l, i) => l.hidden && !matchedOld.has(i));
  p.timing.lyrics = [...lyrics.map((l, i) => {
    const m = from.get(i);
    const old = m ? m.old : null;
    const same = !!(prev[i] && prev[i].text === l.text);
    const line = {
      text: String(l.text), part: l.part || 1, start: Number(l.start), end: Number(l.end),
      section: (same ? prev[i].section : l.section) || '', sectionStart: !!(same ? prev[i].sectionStart : l.sectionStart),
    };
    if (typeof l.hidden === 'boolean') line.hidden = l.hidden;
    else if (old && old.hidden !== undefined && m.exact) line.hidden = old.hidden;
    if (old && m.exact && old.words) line.words = old.words;
    if (l.endLocked === true) line.endLocked = true;
    else if (old && old.endLocked && old.end > line.start + 0.1) { line.end = old.end; line.endLocked = true; }
    return line;
  }), ...keptHidden.map((l) => ({ ...l }))].filter((l) => l.text && l.end > l.start).sort((a, b) => a.start - b.start);
  p.timing.lyricsSource = 'tap';
  SubCore.relinkSegments(p.timing.segments, p.timing.lyrics);
  p.subsStale = true;
  if (!rt.running && cutsFixed(p) && p.steps.subtitles) p.steps.subtitles.status = 'pending';
  await finished(rt);
  return p.timing.lyrics;
}

// ───────────────────────── 이야기 · 노래 ─────────────────────────

/** 기획안 수정 */
export async function updatePlan(rt, plan) {
  rt.p.plan = P.normalizePlan(plan, rt.wf, rt.series);
  await finished(rt);
  return rt.p.plan;
}

/** 단계 이후를 '다시 해야 함' 으로 (노래·박자가 바뀌어 컷이 달라질 때) */
export function invalidateFrom(rt, step) {
  resetFrom(rt, STEPS.indexOf(step));
  rt.p.renderStale = true;
  if (rt.p.status === 'done') rt.p.status = 'stopped';
  rt.p.waiting = null;
  rt.p.error = null;
}

/** 노래 파일 바꾸기 → 분석부터 다시 (이야기는 유지, 그림 순서표는 새 컷에 맞춰 다시) */
export async function replaceSong(rt, blob, name = '') {
  if (rt.running) throw new Error('진행 중에는 바꿀 수 없어요.');
  if (!blob || !(blob.size > 0)) throw new Error(MSG.noSong);
  const { p } = rt;
  await rt.putBlob(BK.song(rt.id), blob);
  p.song = { key: BK.song(rt.id), name: name || p.song.name, type: blob.type || '', size: blob.size, rev: ((p.song && p.song.rev) || 0) + 1 };
  p.music = null;
  p.timing = null;
  invalidateFrom(rt, 'music');
  await finished(rt);
  return p.song;
}

/** BPM 직접 지정 후 다시 분석 (컷이 달라지므로 가사 맞추기부터 다시) */
export async function setBpm(rt, bpm) {
  if (rt.running) throw new Error('진행 중에는 바꿀 수 없어요.');
  const v = Number(bpm);
  if (!Number.isFinite(v) || v < 30 || v > 300) throw new Error('BPM 은 30에서 300 사이의 숫자로 적어 주세요.');
  if (!rt.p.music || !rt.p.song) throw new Error('노래가 아직 없어요.');
  rt.p.music.bpmOverride = Math.round(v * 10) / 10;
  const analysis = await analyzeSongInto(rt);
  invalidateFrom(rt, 'timing');
  await finished(rt);
  return analysis;
}

/**
 * 마디 시작 박 옮기기 (±1 박). 박자 분석을 다시 하지 않고, 저장된 박 목록에서 마디 시작을 다시 고른다 (마디별 세기는 원래 값을 시간 비율로 섞어 어림).
 * @param {number} delta 박 수 (예: +1, -1)
 */
export async function setBarNudge(rt, delta) {
  if (rt.running) throw new Error('진행 중에는 바꿀 수 없어요.');
  const m = rt.p.music;
  if (!m || !m.analysis) throw new Error('노래가 아직 분석되지 않았어요.');
  const d = Math.round(Number(delta));
  if (!Number.isFinite(d) || d === 0) throw new Error(MSG.noMotionChange);
  const a = { ...m.analysis }; // 새 객체로 바꾼다 (화면이 들고 있는 예전 snapshot 을 건드리지 않게)
  m.analysis = a;
  if (!m.base) {
    const first = a.downbeats[0];
    const at = a.beats.findIndex((b) => Math.abs(b - first) < 1e-6);
    m.base = { downbeats: a.downbeats.slice(), bars: clone(a.bars) };
    m.phase0 = at >= 0 ? at % 4 : 0;
  }
  m.barNudge = (((m.barNudge || 0) + d) % 4 + 4) % 4;
  const phase = (m.phase0 + m.barNudge) % 4;
  const round3 = (x) => Math.round(x * 1000) / 1000;
  a.downbeats = a.beats.filter((_, i) => i % 4 === phase).map(round3);
  const marks = [0, ...a.downbeats.filter((t) => t > 0.05), a.duration];
  const bars = [];
  for (let i = 0; i < marks.length - 1; i++) {
    const s = marks[i];
    const e = marks[i + 1];
    if (e - s < 0.05) continue;
    let acc = 0;
    let w = 0;
    for (const b of m.base.bars) {
      const o = Math.min(e, b.end) - Math.max(s, b.start);
      if (o > 0) { acc += o * b.energy; w += o; }
    }
    const energy = w ? round3(acc / w) : 0.5;
    bars.push({ start: round3(s), end: round3(e), energy, level: energy > 0.75 ? 'high' : energy > 0.45 ? 'mid' : 'low' });
  }
  a.bars = bars;
  invalidateFrom(rt, 'timing');
  rt.log(`🥁 마디 시작을 ${d > 0 ? '+' : ''}${d}박 옮겼어요.`);
  await finished(rt);
  return a;
}

// ───────────────────────── 고친 것 반영하기 ─────────────────────────

/**
 * 고친 것 반영하기: 끝나지 않은 단계가 있으면 그 단계부터, 아니면 그림·카메라·시간·효과·전환이 바뀌었으면 영상 만들기(+자막), 자막만 바뀌었으면 자막 입히기만.
 * 완성(done)된 작품에서도 시작한다. 오래 걸려서 기다리지 않고 바로 돌려준다 (진행은 update 이벤트로). 폰은 영상을 통째로 다시 만든다(장면별 캐시 없음).
 * @returns {{from:string|null}}
 */
export function applyChanges(rt, onError = () => {}) {
  if (rt.running) return { from: null };
  assertRunnable(rt);
  if (rt.p.status === 'waiting') return { from: null }; // 기다리는 부탁이 있으면 그것부터
  const from = applyFromOf(rt.p, !!(rt.p.output && rt.p.output.clean));
  if (!from) return { from: null };
  rt.log(`✨ 고친 것 반영하기 시작 (${from} 단계부터)`);
  runPipeline(rt, { from }).catch(onError);
  return { from };
}

