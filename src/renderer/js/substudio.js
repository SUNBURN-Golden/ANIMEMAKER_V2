'use strict';
/*
 * substudio: 💬 가사 자막 고치기 (자막 스튜디오)
 *   실제 영상(자막 없는 영상) 위에 실제 글꼴·크기의 자막을 얹어 보면서, 모양 고르기 · 글 고치기 · 시간 고치기를 한 화면에서 한다.
 *   AM.substudio.mount(host, ctx) → { update(snap), destroy(), isDirty() }   (ctx: id, getSnap, api, toast, onClose, onBusy?)
 *   고친 것은 저장 버튼을 누를 때까지 이 화면 안(작업 사본)에만 있다. 저장하면 proj:saveSubtitles → proj:applyChanges 를 차례로 부른다.
 *   위쪽 (줄 계산) 은 화면 없이도 쓸 수 있는 순수 함수라서 AM.substudio.util 로 내놓는다 (test/substudio.test.js).
 */
(function (AM) {
  const S = window.AMSubtitleStyle;
  const R = window.AMSubtitleRender;

  // ---------- 숫자·글 도우미 ----------
  const MIN_GAP = 0.2; // 두 줄 시작 사이 최소 간격 (초)
  const MAX_HOLD = 7; // 끝을 따로 정하지 않은 줄이 떠 있는 가장 긴 시간 (백엔드와 같다)
  const NUDGE = 0.1;
  const LIMITS = { chars: 16, cps: 9, short: 0.8, long: 7 };
  const round2 = (x) => Math.round(x * 100) / 100;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /** 0:32 */
  function fmtClock(t) {
    const x = Math.max(0, Math.floor(Number(t) || 0));
    return `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`;
  }
  /** 0:32.4 */
  function fmtTenth(t) {
    const x = Math.round(Math.max(0, Number(t) || 0) * 10) / 10;
    const m = Math.floor(x / 60);
    return `${m}:${(x - m * 60).toFixed(1).padStart(4, '0')}`;
  }
  /** 지난번에 걸린 시간: 1분 38초 (모르면 '약 2분') */
  function lastTimeLabel(ms) {
    const sec = Number(ms) / 1000;
    if (Number.isFinite(sec) && sec > 0) return AM.fmtDur ? AM.fmtDur(sec) : `${Math.round(sec)}초`;
    return '약 2분';
  }

  let keySeq = 0;
  const newKey = () => `k${++keySeq}`;

  // ---------- 가사 줄 (작업 사본) ----------
  /** 백엔드 줄 → 작업 줄. tapped: 사람이 맞춘 시간인지 */
  function mkLine(raw, tapped) {
    const start = Number(raw.start) || 0;
    const l = {
      _k: newKey(), text: String(raw.text == null ? '' : raw.text), start, end: Number(raw.end) > start ? Number(raw.end) : start + 0.5,
      hidden: !!raw.hidden, endLocked: raw.endLocked === true, section: raw.section || '', sectionStart: raw.sectionStart === true, _tapped: !!tapped,
    };
    if (raw.part != null) l.part = raw.part;
    if (raw.words) l.words = raw.words;
    return l;
  }

  /** 작업 줄 → 백엔드로 보낼 줄 (끝은 사람이 정한 줄만 보낸다: 나머지는 백엔드가 같은 규칙으로 정한다) */
  function toSaveLine(l) {
    const o = { text: l.text, start: round2(l.start), hidden: !!l.hidden };
    if (l.endLocked) { o.end = round2(l.end); o.endLocked = true; }
    if (l.section) o.section = l.section;
    if (l.sectionStart) o.sectionStart = true;
    return o;
  }

  /**
   * 시간 순으로 세우고 줄마다 끝 시간을 정한다 (백엔드 cleanLyricLines 와 같은 규칙 → 미리 본 대로 영상에 나온다).
   * 끝이 정해진 줄(endLocked)은 그 끝을 지키되 다음 줄 직전을 넘지 않는다.
   */
  function recompute(lines, dur) {
    lines.sort((a, b) => a.start - b.start);
    lines.forEach((l, i) => {
      const next = lines[i + 1];
      const limit = next ? next.start - 0.05 : (dur ? dur - 0.05 : Infinity);
      let end;
      if (l.endLocked && l.end > l.start) {
        end = l.end;
        if (end > limit && limit > l.start + 0.1) end = limit;
      } else {
        end = limit - l.start >= 0.3 ? Math.min(limit, l.start + MAX_HOLD) : l.start + 0.3;
      }
      if (dur) end = Math.min(end, dur);
      if (!(end > l.start)) end = l.start + 0.1;
      l.end = end;
    });
    return lines;
  }

  /** 바뀌었는지 비교하는 서명: 글 · 시작 · 숨김 · (정한) 끝 */
  function sigLines(lines) {
    return JSON.stringify(lines.filter((l) => l.text.trim()).map((l) => [l.text.trim(), round2(l.start), l.hidden ? 1 : 0, l.endLocked ? round2(l.end) : 0]));
  }
  function sigStyle(style) {
    const s = S.normalizeStyle(style);
    return JSON.stringify(Object.keys(s).sort().map((k) => [k, s[k]]));
  }

  /** 줄 앞뒤 칸 안에서 시작 시간 옮기기: 앞 줄보다 MIN_GAP 뒤, 다음 줄보다 MIN_GAP 앞, 정한 끝보다 앞, 노래 안 */
  function startBounds(lines, i, dur) {
    const prev = lines[i - 1];
    const next = lines[i + 1];
    const lo = prev ? prev.start + MIN_GAP : 0;
    let hi = next ? next.start - MIN_GAP : (dur ? dur - 0.3 : Infinity);
    if (lines[i].endLocked) hi = Math.min(hi, lines[i].end - 0.2);
    return [lo, Math.max(lo, hi)];
  }

  /** i 번째 줄의 시작을 t 초로 (경계 안으로). 바뀐 만큼(초)을 돌려준다 */
  function setStart(lines, i, t, dur) {
    const l = lines[i];
    if (!l) return 0;
    const [lo, hi] = startBounds(lines, i, dur);
    const before = l.start;
    l.start = round2(clamp(t, lo, hi));
    l._tapped = true;
    recompute(lines, dur);
    return l.start - before;
  }

  /** i 번째 줄의 끝을 d 초 옮기기 (끝을 사람이 정한 것으로 표시) */
  function nudgeEnd(lines, i, d, dur) {
    const l = lines[i];
    if (!l) return 0;
    const next = lines[i + 1];
    const hi = next ? next.start - 0.05 : (dur ? dur : Infinity);
    const before = l.end;
    l.end = round2(clamp(before + d, l.start + 0.2, Math.max(l.start + 0.2, hi)));
    l.endLocked = true;
    l._tapped = true;
    recompute(lines, dur);
    return l.end - before;
  }

  /** 모든 줄을 함께 d 초 옮기기 (맨 앞은 0 아래로, 맨 뒤는 노래 밖으로 못 나감). 옮긴 만큼을 돌려준다 */
  function shiftAll(lines, d, dur) {
    if (!lines.length) return 0;
    const first = Math.min(...lines.map((l) => l.start));
    const last = Math.max(...lines.map((l) => l.start));
    const k = clamp(d, -first, dur ? Math.max(-first, dur - 0.3 - last) : Infinity);
    for (const l of lines) { l.start = round2(l.start + k); if (l.endLocked) l.end = round2(l.end + k); }
    recompute(lines, dur);
    return k;
  }

  /** 글을 caret 위치에서 둘로 나누기. 뒤쪽 줄의 시작은 두 시간 사이(글자 수 비율)에 둔다. 나눌 수 없으면 null */
  function splitLine(lines, i, caret, dur) {
    const a = lines[i];
    if (!a) return null;
    const full = a.text;
    let pos = Number.isFinite(caret) ? caret : 0;
    if (pos <= 0 || pos >= full.length) { // 캐럿이 맨 앞·뒤면 가운데에서 가장 가까운 띄어쓰기
      const mid = full.length / 2;
      let best = -1;
      for (let k = 1; k < full.length - 1; k++) if (/\s/.test(full[k]) && (best < 0 || Math.abs(k - mid) < Math.abs(best - mid))) best = k;
      pos = best < 0 ? Math.floor(mid) : best;
    }
    const left = full.slice(0, pos).trim();
    const right = full.slice(pos).trim();
    if (!left || !right) return null;
    const span = Math.max(0.2, a.end - a.start);
    const ratio = clamp(Array.from(left).length / Math.max(1, Array.from(left).length + Array.from(right).length), 0.25, 0.75);
    const b = mkLine({ text: right, start: round2(a.start + span * ratio), end: a.end, hidden: a.hidden, endLocked: a.endLocked, section: a.section, sectionStart: false }, a._tapped);
    b._tapped = a._tapped;
    a.text = left;
    a.endLocked = false; // 앞 줄의 끝은 뒤 줄 시작에서 저절로 정해진다
    lines.splice(i + 1, 0, b);
    recompute(lines, dur);
    return b;
  }

  /** i 번째 줄과 다음 줄을 하나로. 합친 줄을 돌려준다 (다음 줄이 없으면 null) */
  function mergeNext(lines, i, dur) {
    const a = lines[i];
    const b = lines[i + 1];
    if (!a || !b) return null;
    a.text = `${a.text.trim()} ${b.text.trim()}`.trim();
    a.hidden = a.hidden && b.hidden;
    a.endLocked = b.endLocked;
    a.end = b.end;
    a._tapped = a._tapped || b._tapped;
    lines.splice(i + 1, 1);
    recompute(lines, dur);
    return a;
  }

  /**
   * 새 줄 하나 끼우기: after(보통 고른 줄 번호, 없으면 -1=맨 뒤) 다음에, 재생 위치가 그 칸 안이면 거기, 아니면 앞 줄이 끝난 직후.
   * 글은 비어 있다 (사람이 적는다). 만든 줄을 돌려준다
   */
  function addLine(lines, after, playhead, dur) {
    const i = after >= 0 ? Math.min(after, lines.length - 1) : lines.length - 1;
    const prev = lines[i];
    const next = lines[i + 1];
    const lo = prev ? prev.start + 0.3 : 0;
    const hi = next ? next.start - 0.3 : (dur ? dur - 0.5 : Infinity);
    let t;
    if (Number.isFinite(playhead) && playhead >= lo && playhead <= hi) t = playhead;
    else if (prev && prev.end + 0.1 <= hi) t = prev.end + 0.1;
    else t = Math.min(hi, Math.max(lo, ((prev ? prev.start : 0) + (next ? next.start : (dur || 5))) / 2));
    const l = mkLine({ text: '', start: round2(Math.max(0, t)), end: round2(Math.max(0, t) + 2) }, false);
    l._new = true;
    lines.splice(i + 1, 0, l);
    recompute(lines, dur);
    return l;
  }

  /** 글에서 찾아 바꾸기. 바뀐 줄 수를 돌려준다 */
  function replaceAll(lines, find, to) {
    if (!find) return 0;
    let n = 0;
    for (const l of lines) {
      if (l.text.includes(find)) { l.text = l.text.split(find).join(to); n++; }
    }
    return n;
  }

  /**
   * 탭으로 맞춘 결과를 작업 줄에 섞기. shown: 탭 창에 보여 준 줄들(숨기지 않은 줄), result: 탭 창의 결과(같은 순서), flags: 줄마다 맞췄는지.
   * 숨긴 줄은 옛 시간 그대로. 끝을 정해 둔 줄은 그 끝을 지킨다.
   */
  function mergeTap(lines, shown, result, flags, dur) {
    shown.forEach((l, i) => {
      const r = result[i];
      if (!r || !lines.includes(l)) return;
      l.start = round2(r.start);
      if (!l.endLocked) l.end = round2(r.end);
      if (flags && flags[i]) l._tapped = true;
    });
    recompute(lines, dur);
  }

  /** 줄 하나에 붙는 가벼운 경고들 (막지 않는다). lay: AMSubtitleRender.getLayout 결과 (없어도 됨) */
  function lineWarnings(l, lay) {
    const out = [];
    if (l.hidden || !l.text.trim()) return out;
    if (l.text.split('\n').some((s) => Array.from(s.trim()).length > LIMITS.chars)) out.push(`한 줄이 ${LIMITS.chars}자보다 길어요`);
    if (lay && lay.lineCount >= 3) out.push('3줄이 돼요');
    const d = l.end - l.start;
    const chars = Array.from(l.text.replace(/\s+/g, '')).length;
    if (d < LIMITS.short) out.push(`${LIMITS.short}초보다 짧아요`);
    if (d > LIMITS.long) out.push(`${LIMITS.long}초보다 길어요`);
    if (d > 0 && chars / d > LIMITS.cps) out.push('너무 빨리 지나가요');
    return out;
  }

  /** 글자 색의 밝기에 맞춰 테두리 색: 밝은 글씨는 검정, 어두운 글씨는 흰색 */
  function autoOutline(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return '#000000';
    const n = parseInt(m[1], 16);
    const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
    return lum > 0.5 ? '#000000' : '#ffffff';
  }

  /** 상자 안에 비율을 지켜 넣었을 때 보이는 영상의 자리 (object-fit: contain) */
  function fitRect(boxW, boxH, vw, vh) {
    if (!(vw > 0 && vh > 0 && boxW > 0 && boxH > 0)) return { x: 0, y: 0, w: boxW, h: boxH };
    const k = Math.min(boxW / vw, boxH / vh);
    const w = vw * k;
    const h = vh * k;
    return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
  }

  /** 줄 목록 → 글 + 시간 같은 실제 줄 (비어 있는 줄은 뺀다) */
  const realLines = (lines) => lines.filter((l) => l.text.trim());

  // ---------- 글꼴 (한 번만 읽는다) ----------
  let fontsPromise = null;
  function ensureFonts() {
    if (fontsPromise) return fontsPromise;
    if (!document.getElementById('ss-fontface')) {
      const st = document.createElement('style');
      st.id = 'ss-fontface';
      st.textContent = S.fontFaceCss('assets/fonts/');
      document.head.appendChild(st);
    }
    const sample = '가나다라 ABC 함께라면 두렵지 않아';
    fontsPromise = Promise.all(S.FONTS.filter((f) => f.family).map((f) => document.fonts.load(S.fontCss(f.id, 40), sample).catch(() => null))).then(() => true, () => true);
    return fontsPromise;
  }

  const mem = { guideAuto: false }; // 화면을 다시 열어도 기억하는 것 (파일에는 저장하지 않는다)
  const TIMED = ['tap', 'lrc', 'srt'];
  const STEP_SENTENCE = { render: '🎬 영상을 다시 만드는 중이에요', subtitles: '💬 가사 자막을 입히는 중이에요' };

  // ======================================================================================
  function mount(host, ctx) {
    const { h, clear } = AM;
    const api = ctx.api || window.api;
    const toast = ctx.toast || AM.toast;
    let snap = (ctx.getSnap && ctx.getSnap()) || {};
    const id = ctx.id || snap.id;

    let destroyed = false;
    let tab = 'look';
    let style = S.normalizeStyle({});
    let lines = [];
    let base = null; // 마지막으로 알게 된 저장된 값 {lines, style, lineSig, styleSig}
    let applyToSeries = false;
    let outlineManual = false;
    let sel = null; // 고른 줄의 열쇠
    let activeK = null; // 지금 재생 위치에 떠 있는 줄
    let phase = 'idle'; // idle | saving | applying
    let applyMark = null;
    let errorMsg = '';
    let notice = '';
    let showGuide = false;
    let emptyMode = false;
    let errNote = false; // 영상 파일을 열지 못해서 띄운 안내가 떠 있는 동안
    let badUrl = ''; // 열리지 않은 영상 주소 (같은 주소를 계속 다시 열지 않게)
    const hist = [];

    // ---- 스냅샷에서 읽기 ----
    const out = () => ({ W: (snap.outSize && snap.outSize.w) || 1280, H: (snap.outSize && snap.outSize.h) || 720 });
    const sctx = () => ({ w: out().W, h: out().H });
    const isTall = () => out().H > out().W;
    const abs = (rel) => (rel ? AM.joinPath(snap.dir, rel) : null);
    const hasVideoFile = () => !!(snap.output && snap.output.clean);
    const cleanUrl = () => (hasVideoFile() ? AM.fileUrl(abs(snap.output.clean), (snap.output.cleanAt || snap.output.madeAt || 0)) : '');
    const songUrl = () => (snap.music && snap.music.song ? AM.fileUrl(abs(snap.music.song)) : '');
    const hasSeries = () => !!(snap.series && snap.series.id);
    function stillUrl() {
      const ds = (snap.drawings || []).filter((d) => d && d.file);
      const d = ds.find((x) => x.id === 'bg' && x.shot === 1) || ds.find((x) => x.id === 'bg') || ds[0];
      return d ? AM.fileUrl(abs(d.file), d.vseq || d.redraws || '') : '';
    }
    function duration() {
      const m = media();
      return Number(snap.durationSec) || Number(snap.music && snap.music.analysis && snap.music.analysis.duration) || Number(snap.song && snap.song.duration) || (m && m.duration) || 0;
    }
    function readSnap() {
      const timed = !!(snap.timing && TIMED.includes(snap.timing.lyricsSource));
      const ls = recompute(((snap.timing && snap.timing.lyrics) || []).map((l) => mkLine(l, timed)), duration());
      const st = S.normalizeStyle(snap.subtitleStyle || (snap.workflow && snap.workflow.subtitles), sctx());
      return { lines: ls, style: st, lineSig: sigLines(ls), styleSig: sigStyle(st) };
    }
    const cloneLines = (ls) => ls.map((l) => ({ ...l }));
    const dirtyLines = () => !!base && sigLines(lines) !== base.lineSig;
    const dirtyStyle = () => !!base && (sigStyle(style) !== base.styleSig || applyToSeries);
    const isDirty = () => dirtyLines() || dirtyStyle();
    const shown = () => lines.filter((l) => !l.hidden && l.text.trim());
    const findLine = (k) => lines.find((l) => l._k === k) || null;
    const indexOf = (k) => lines.findIndex((l) => l._k === k);
    const firstShowTime = () => { const f = shown()[0]; return f ? f.start + Math.min(0.5, Math.max(0.1, (f.end - f.start) / 2)) : 0; };

    // ---- 되돌리기 ----
    function work() { return { style: { ...style }, lines: cloneLines(lines), apply: applyToSeries, om: outlineManual }; }
    function pushUndo(key) {
      const now = Date.now();
      const last = hist[hist.length - 1];
      if (key && last && last.key === key && now - last.at < 1500) { last.at = now; return; }
      hist.push({ key, at: now, st: work() });
      if (hist.length > 80) hist.shift();
      refreshUndo();
    }
    function undo() {
      const e = hist.pop();
      if (!e) return;
      style = e.st.style;
      lines = e.st.lines;
      applyToSeries = e.st.apply;
      outlineManual = e.st.om;
      afterRestructure();
      toast('↩ 방금 한 것을 되돌렸어요');
    }

    // ======================================================================================
    // 영상 · 소리
    // ======================================================================================
    const vEl = h('video', { class: 'ss-video', preload: 'auto', playsinline: '' });
    const aEl = h('audio', { preload: 'auto' });
    const imgEl = h('img', { class: 'ss-still', alt: '' });
    const stillCv = h('canvas', { class: 'ss-still' });
    const overlay = h('canvas', { class: 'ss-overlay' });
    let stillOk = false;
    let mode = 'none'; // video(자막 없는 영상) | audio(영상이 아직 없음: 노래 + 그림 한 장) | released(영상을 만드는 중: 잠깐 놓아 줌) | none
    let heldTime = 0;
    let wantSeek = null;
    let loadedUrl = '';
    let playUntil = null;
    let loop = 0;
    let loopKind = '';
    let scrubbing = false;
    let drawQ = 0;

    const media = () => (mode === 'video' ? vEl : mode === 'audio' ? aEl : null);
    const playing = () => { const m = media(); return !!m && !m.paused && !m.ended; };
    const curTime = () => {
      const m = media();
      if (!m) return heldTime;
      return m.readyState === 0 && wantSeek != null ? wantSeek : (m.currentTime || 0); // 아직 못 읽었으면 가려던 곳
    };

    function seekTo(t) {
      const d = duration();
      const v = clamp(Number(t) || 0, 0, d ? Math.max(0, d - 0.05) : Infinity);
      const m = media();
      heldTime = v;
      if (m) { try { m.currentTime = v; wantSeek = null; } catch (_) { wantSeek = v; } }
      scheduleDraw();
      updateControls();
    }
    function play(until) {
      const m = media();
      if (!m || phase === 'applying') return;
      playUntil = until == null ? null : until;
      const p = m.play();
      if (p && p.catch) p.catch(() => {});
    }
    function pause() { const m = media(); if (m) m.pause(); playUntil = null; }
    function togglePlay() {
      if (playing()) { pause(); return; }
      const d = duration();
      if (d && curTime() >= d - 0.2) seekTo(0);
      play();
    }
    /** 이 줄이 화면에 보이는 순간으로 가기 (재생 중이면 그대로 계속) */
    function showLine(l, always) {
      if (!l) return;
      const t = curTime();
      if (!always && t >= l.start && t < l.end) return;
      seekTo(l.start + Math.min(0.5, Math.max(0.15, (l.end - l.start) / 2)));
    }

    function stopLoop() {
      if (!loop) return;
      if (loopKind === 'v' && vEl.cancelVideoFrameCallback) vEl.cancelVideoFrameCallback(loop); else cancelAnimationFrame(loop);
      loop = 0;
    }
    function startLoop() {
      stopLoop();
      const m = media();
      if (destroyed || !m || m.paused) return;
      const step = () => {
        loop = 0;
        if (destroyed || !playing()) return;
        draw();
        updateControls();
        if (playUntil != null && curTime() >= playUntil) { pause(); return; }
        startLoop();
      };
      if (m === vEl && vEl.requestVideoFrameCallback) { loopKind = 'v'; loop = vEl.requestVideoFrameCallback(step); } else { loopKind = 'r'; loop = requestAnimationFrame(step); }
    }

    function wireMedia(el) {
      const moved = () => { if (media() !== el) return; scheduleDraw(); updateControls(); };
      ['seeked', 'timeupdate', 'loadeddata', 'durationchange'].forEach((ev) => el.addEventListener(ev, moved));
      el.addEventListener('loadedmetadata', () => {
        if (media() !== el) return;
        if (wantSeek != null) { try { el.currentTime = wantSeek; } catch (_) { /* 다음 기회에 */ } wantSeek = null; }
        layoutStage();
        moved();
      });
      el.addEventListener('play', () => { if (media() !== el) return; startLoop(); updateControls(); });
      el.addEventListener('pause', () => { if (media() !== el) return; stopLoop(); moved(); });
      el.addEventListener('ended', () => { if (media() !== el) return; stopLoop(); moved(); });
      el.addEventListener('error', () => {
        if (media() !== el || !el.getAttribute('src')) return;
        if (el === vEl) { badUrl = loadedUrl; loadedUrl = ''; releaseVideo(); loadAudio(); errNote = true; noteText('영상 파일을 열지 못했어요 · 노래로 미리 보고 있어요'); }
      });
    }
    wireMedia(vEl);
    wireMedia(aEl);

    function captureStill() {
      if (!vEl.videoWidth) return false;
      try {
        stillCv.width = vEl.videoWidth;
        stillCv.height = vEl.videoHeight;
        stillCv.getContext('2d').drawImage(vEl, 0, 0);
        return true;
      } catch (_) { return false; }
    }
    /** 영상을 만드는 동안 파일을 잡고 있지 않도록 놓아 준다 (윈도우는 열려 있는 파일을 지우지 못한다) */
    function releaseVideo() {
      stopLoop();
      if (vEl.getAttribute('src')) {
        heldTime = vEl.currentTime || heldTime;
        stillOk = captureStill();
        try { vEl.pause(); } catch (_) { /* noop */ }
        vEl.removeAttribute('src');
        try { vEl.load(); } catch (_) { /* noop */ }
      }
      if (aEl.getAttribute('src')) { try { aEl.pause(); } catch (_) { /* noop */ } }
      loadedUrl = '';
      playUntil = null;
      if (mode !== 'released') { mode = 'released'; showModeUI(); }
      updateControls();
    }
    function loadVideo(url) {
      if (mode === 'video' && loadedUrl === url) return;
      if (aEl.getAttribute('src')) { aEl.pause(); aEl.removeAttribute('src'); try { aEl.load(); } catch (_) { /* noop */ } }
      wantSeek = heldTime > 0 ? heldTime : firstShowTime();
      loadedUrl = url;
      mode = 'video';
      vEl.src = url;
      try { vEl.load(); } catch (_) { /* noop */ }
      showModeUI();
    }
    function loadAudio() {
      const url = songUrl();
      if (mode === 'audio' || !url) { if (!url && mode !== 'none') { mode = 'none'; showModeUI(); } return; }
      wantSeek = heldTime > 0 ? heldTime : firstShowTime();
      mode = 'audio';
      aEl.src = url;
      try { aEl.load(); } catch (_) { /* noop */ }
      showModeUI();
    }
    /** 스냅샷을 보고 영상 · 소리를 알맞게 (영상 만드는 중이면 놓고, 끝나면 새 영상) */
    function refreshMedia() {
      if (emptyMode) return;
      const rendering = snap.running && (snap.currentStep === 'render' || snap.currentStep === 'subtitles');
      if (rendering || phase === 'applying') { releaseVideo(); return; }
      if (hasVideoFile() && cleanUrl() !== badUrl) loadVideo(cleanUrl());
      else if (mode === 'video' || mode === 'released' || mode === 'none') { if (mode === 'video') releaseVideo(); loadAudio(); }
    }

    let noteEl;
    function noteText(t) { if (noteEl) { noteEl.textContent = t || ''; noteEl.hidden = !t; } }
    /** 미리보기 위 한 줄 안내: 영상을 만드는 중 · 영상이 아직 없음 · 자막을 껐음 */
    function updateNote() {
      if (mode === 'released') noteText('🎬 새 영상을 만드는 중이에요');
      else if (mode === 'audio' || mode === 'none') noteText('영상이 만들어지면 여기서 자막을 꾸밀 수 있어요');
      else if (!style.enabled) noteText('자막을 껐어요 · 완성 영상에 글씨가 나오지 않아요');
      else noteText('');
    }
    function showModeUI() {
      vEl.hidden = mode !== 'video';
      stillCv.hidden = !(mode === 'released' && stillOk);
      const pic = stillUrl();
      if (pic && imgEl.getAttribute('data-src') !== pic) { imgEl.setAttribute('data-src', pic); imgEl.src = pic; }
      imgEl.hidden = !(pic && (mode === 'audio' || mode === 'none' || (mode === 'released' && !stillOk)));
      updateNote();
      if (playBtn) playBtn.disabled = !media();
      layoutStage();
      scheduleDraw();
      updateControls();
      grabBackground();
    }

    // ---- 미리보기 그리기 ----
    function scheduleDraw() {
      if (drawQ || destroyed) return;
      drawQ = requestAnimationFrame(() => { drawQ = 0; draw(); });
    }
    function draw() {
      if (destroyed || !overlay.isConnected) return;
      const { W, H } = out();
      if (overlay.width !== W) overlay.width = W;
      if (overlay.height !== H) overlay.height = H;
      const g = overlay.getContext('2d');
      g.clearRect(0, 0, W, H);
      if (style.enabled && R) R.drawFrame(g, lines, curTime(), style, W, H);
      if (showGuide && R) R.drawSafeGuide(g, style, W, H);
      markActive();
    }
    let stage;
    function layoutStage() {
      if (!stage) return;
      const { W, H } = out();
      stage.style.setProperty('--ss-ar', String(W / H));
      stage.style.aspectRatio = `${W} / ${H}`;
      const b = stage.getBoundingClientRect();
      let vw = W;
      let vh = H;
      if (mode === 'video' && vEl.videoWidth) { vw = vEl.videoWidth; vh = vEl.videoHeight; }
      const r = fitRect(b.width, b.height, vw, vh);
      overlay.style.left = `${r.x}px`;
      overlay.style.top = `${r.y}px`;
      overlay.style.width = `${r.w}px`;
      overlay.style.height = `${r.h}px`;
    }

    // ======================================================================================
    // 미리보기 + 컨트롤 막대
    // ======================================================================================
    let playBtn;
    let seekEl;
    let timeEl;
    let subSwitch;
    let guideBtn;
    function buildPreview() {
      playBtn = h('button', { type: 'button', class: 'ss-play', title: '재생 / 멈춤 (스페이스바)', 'aria-label': '재생 / 멈춤', onclick: togglePlay }, '▶');
      seekEl = h('input', { type: 'range', class: 'ss-seek', min: '0', max: '100', step: '0.01', value: '0', 'aria-label': '재생 위치', title: '누르거나 끌어서 옮겨요' });
      seekEl.addEventListener('pointerdown', () => { scrubbing = true; });
      const endScrub = () => { scrubbing = false; };
      seekEl.addEventListener('pointerup', endScrub);
      seekEl.addEventListener('pointercancel', endScrub);
      seekEl.addEventListener('input', () => seekTo(parseFloat(seekEl.value)));
      seekEl.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') e.preventDefault(); }); // ← → 는 2초 이동 (아래 키 처리)
      timeEl = h('span', { class: 'ss-time' }, '0:00 / 0:00');
      subSwitch = h('button', { type: 'button', class: 'ss-switch', role: 'switch', 'aria-checked': 'true', title: '끄면 자막 없이 영상이 완성돼요', onclick: () => setStyle({ enabled: !style.enabled }, 'enabled') },
        h('span', { class: 'ss-sw-track' }, h('i')), h('span', { class: 'ss-sw-label' }, '자막 보이기'));
      guideBtn = h('button', {
        type: 'button', class: 'ss-tog', 'aria-pressed': 'false', title: '숏폼 앱의 버튼에 가려질 수 있는 곳을 붉게 보여 줘요 (영상에는 나오지 않아요)',
        onclick: () => { showGuide = !showGuide; refreshControls(); scheduleDraw(); },
      }, '📐 안전 영역');
      noteEl = h('div', { class: 'ss-note', hidden: true });
      stage = h('div', { class: 'ss-stage' }, vEl, imgEl, stillCv, overlay, noteEl);
      // ss-pin: 좁은 창에서 글을 고치는 동안 화면 위에 붙어 있는 부분 (영상 + 재생 막대)
      const prevEl = h('section', { class: 'ss-preview', 'aria-label': '미리보기' },
        h('div', { class: 'ss-pin' },
          h('div', { class: 'ss-stagewrap' }, stage),
          h('div', { class: 'ss-controls' }, playBtn, seekEl, timeEl)),
        h('div', { class: 'ss-controls2' }, subSwitch, guideBtn));
      if ('ResizeObserver' in window) { ro2 = new ResizeObserver(() => layoutStage()); ro2.observe(stage); }
      return prevEl;
    }
    let ro2 = null;

    function refreshControls() {
      if (!subSwitch) return;
      subSwitch.setAttribute('aria-checked', style.enabled ? 'true' : 'false');
      subSwitch.classList.toggle('on', !!style.enabled);
      guideBtn.setAttribute('aria-pressed', showGuide ? 'true' : 'false');
      guideBtn.classList.toggle('on', showGuide);
      if (!errNote) updateNote();
    }
    function updateControls() {
      if (!seekEl) return;
      const d = duration();
      const t = curTime();
      if (d && Number(seekEl.max) !== d) seekEl.max = String(d);
      if (!scrubbing) seekEl.value = String(t);
      seekEl.style.setProperty('--p', `${d ? clamp((t / d) * 100, 0, 100) : 0}%`);
      timeEl.textContent = `${fmtClock(t)} / ${fmtClock(d)}`;
      playBtn.textContent = playing() ? '⏸' : '▶';
      playBtn.disabled = !media() || phase === 'applying';
      playBtn.title = mode === 'released' ? '새 영상을 만드는 중이라 잠깐 틀 수 없어요' : '재생 / 멈춤 (스페이스바)';
    }

    // ---- 지금 떠 있는 줄 표시 (두 목록 모두) ----
    function markActive() {
      const a = (R && R.activeLines ? R.activeLines(lines, curTime()) : [])[0];
      const k = a ? a._k : null;
      if (k === activeK) return;
      activeK = k;
      for (const m of [textRows, timeRows]) for (const [rk, r] of m) r.el.classList.toggle('active', rk === k);
      if (k && playing() && !listHasFocus()) {
        scrollRow((tab === 'time' ? timeRows : textRows).get(k));
      }
    }
    function listHasFocus() { const a = document.activeElement; return !!a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && root.contains(a); }

    // ======================================================================================
    // 모양 고르기 미리보기 그림 (실제 영상 한 장면 위에 같은 그리개로)
    // ======================================================================================
    let bgCanvas = null;
    let bgToken = 0;
    let bgSig = '';
    const thumbs = new Map(); // 프리셋 id | 'custom' → <canvas>
    const THUMB_W = 480;
    const BG_W = 1000; // 장면 한 장을 따 두는 크기 (확대해도 흐리지 않게)

    function grabVideoFrame(url, at, g, tw, th) {
      return new Promise((resolve) => {
        const v = document.createElement('video');
        v.muted = true;
        v.preload = 'auto';
        let finished = false;
        const done = (ok) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          try { v.pause(); v.removeAttribute('src'); v.load(); } catch (_) { /* noop */ }
          resolve(ok);
        };
        const timer = setTimeout(() => done(false), 9000);
        v.addEventListener('error', () => done(false));
        v.addEventListener('loadedmetadata', () => { v.currentTime = clamp(at, 0, Math.max(0, (v.duration || 1) - 0.15)); });
        v.addEventListener('seeked', () => { try { g.drawImage(v, 0, 0, tw, th); done(true); } catch (_) { done(false); } });
        v.src = url;
      });
    }
    function grabImage(url, g, tw, th) {
      return new Promise((resolve) => {
        const im = new Image();
        im.onload = () => { try { g.drawImage(im, 0, 0, tw, th); resolve(true); } catch (_) { resolve(false); } };
        im.onerror = () => resolve(false);
        im.src = url;
      });
    }
    async function grabBackground() {
      const url = mode === 'video' ? loadedUrl : '';
      const pic = stillUrl();
      const sig = `${url}|${pic}|${out().W}x${out().H}`;
      if (!thumbs.size || sig === bgSig || mode === 'released') return;
      bgSig = sig;
      const token = ++bgToken;
      const { W, H } = out();
      const c = document.createElement('canvas');
      c.width = BG_W;
      c.height = Math.round((BG_W * H) / W);
      const g = c.getContext('2d');
      const first = shown()[0];
      let ok = false;
      if (url) ok = await grabVideoFrame(url, first ? first.start + 0.6 : 1, g, c.width, c.height);
      if (!ok && pic) ok = await grabImage(pic, g, c.width, c.height);
      if (!ok) {
        const grad = g.createLinearGradient(0, 0, c.width, c.height);
        grad.addColorStop(0, '#6d5bd0');
        grad.addColorStop(1, '#2b2150');
        g.fillStyle = grad;
        g.fillRect(0, 0, c.width, c.height);
      }
      if (token !== bgToken || destroyed) return;
      bgCanvas = c;
      drawThumbs();
    }
    function thumbText() { const f = shown()[0]; return (f && f.text.replace(/\n/g, ' ')) || S.SAMPLE_LINES[0]; }
    /** 모양 그림 한 장: 영상 한 장면 위에 이 모양의 자막을, 글씨가 잘 보이게 자막 둘레만 확대해서 (모든 칸이 같은 배율이라 크기 차이도 보인다) */
    function drawThumb(cv, it, z) {
      const { W, H } = out();
      const g = cv.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, cv.width, cv.height);
      const cw = W / z;
      const ch = H / z;
      const has = it.lay.lines.length > 0;
      const sx = clamp((has ? it.lay.x + it.lay.w / 2 : W / 2) - cw / 2, 0, W - cw);
      const sy = clamp((has ? it.lay.y + it.lay.h / 2 : H * 0.82) - ch / 2, 0, H - ch);
      if (bgCanvas) {
        const kx = bgCanvas.width / W;
        const ky = bgCanvas.height / H;
        g.drawImage(bgCanvas, sx * kx, sy * ky, cw * kx, ch * ky, 0, 0, cv.width, cv.height);
      } else { g.fillStyle = '#3a2f66'; g.fillRect(0, 0, cv.width, cv.height); }
      g.save();
      g.scale(cv.width / cw, cv.height / ch);
      g.translate(-sx, -sy);
      R.drawLine(g, it.lay, it.st, W, H, { alpha: 1 });
      g.restore();
    }
    function drawThumbs() {
      if (destroyed || !thumbs.size || !R) return;
      const { W, H } = out();
      const text = thumbText();
      const probe = measureCtx;
      const items = [];
      for (const [pid, cv] of thumbs) {
        const st = S.normalizeStyle(pid === 'custom' ? style : S.applyPreset(style, pid, sctx()), { w: W, h: H });
        items.push({ cv, st, lay: R.getLayout(probe, text, st, W, H) });
      }
      const widest = Math.max(...items.map((it) => it.lay.w), 1);
      const z = clamp(W / (widest * 1.14), 1.05, H > W ? 2.4 : 3);
      for (const it of items) drawThumb(it.cv, it, z);
    }
    let thumbQ = 0;
    function scheduleThumbs() { if (thumbQ || destroyed) return; thumbQ = requestAnimationFrame(() => { thumbQ = 0; drawThumbs(); }); }

    // ======================================================================================
    // 고치기: 모두 이 함수들을 지난다 (되돌리기 · 다시 그리기 · 저장 단추 상태)
    // ======================================================================================
    let lastPreset = 'basic';
    const styleRefreshers = [];
    let measureCtx = null;
    const stale = { text: true, time: true };
    let sigFor = null; // 줄 경고 계산을 다시 할지 보는 모양 서명 (모양 객체가 바뀔 때만 다시 만든다)
    let sigNow = '';

    function setStyle(patch, key) {
      pushUndo(key || 'style');
      style = S.mergeStyle(style, patch, sctx());
      afterStyleEdit();
    }
    function afterStyleEdit() {
      if (style.preset !== 'custom') lastPreset = style.preset;
      refreshStyleUI();
      refreshControls();
      scheduleDraw();
      scheduleThumbs();
      stale.text = true;
      stale.time = true;
      patchVisible();
      syncDirty();
    }
    /** 줄이 늘거나 줄거나 순서가 바뀐 뒤 (나누기 · 합치기 · 지우기 · 탭 · 되돌리기 …) */
    function afterRestructure() {
      recompute(lines, duration());
      if (sel && !findLine(sel)) sel = null;
      reconcileAll();
      refreshStyleUI();
      refreshControls();
      scheduleDraw();
      scheduleThumbs();
      syncDirty();
      refreshUndo();
    }
    /** 글 · 시간만 가볍게 바뀐 뒤 */
    function afterEdit() {
      recompute(lines, duration());
      stale.text = true;
      stale.time = true;
      patchVisible();
      scheduleDraw();
      syncDirty();
    }

    function syncDirty() {
      const d = isDirty();
      // 저장하지 않고 나가려 할 때 한 번만 묻는다 (다른 화면이 둔 물음은 건드리지 않는다)
      if (d && !AM.leaveGuard) AM.leaveGuard = guard;
      else if (!d && AM.leaveGuard === guard) AM.leaveGuard = null;
      refreshHeader();
    }
    const guard = async () => (phase !== 'idle' ? true : AM.confirmBox('저장하지 않은 변경이 있어요', '나갈까요?', '나가기', 'danger'));

    // ======================================================================================
    // 🎨 모양
    // ======================================================================================
    const POS_ICON = { top: '⬆', middle: '⏺', bottom: '⬇' };
    let customTile = null;
    let presetsEl = null;
    let hintEl = null;
    let seriesRow = null;
    let seriesChk = null;
    let undoBtn = null;
    const btn = (label, onclick, cls, title) => h('button', { type: 'button', class: `btn ${cls || ''}`, title, onclick }, label);

    function seg(options, get, set, label) {
      const el = h('div', { class: 'ss-seg', role: 'group', 'aria-label': label });
      const bs = options.map((o) => {
        const b = h('button', { type: 'button', class: 'ss-segbtn', 'aria-pressed': 'false', title: o.title, onclick: () => set(o.id) }, o.icon ? h('span', { class: 'ss-ico', 'aria-hidden': 'true' }, o.icon) : null, o.label);
        el.appendChild(b);
        return b;
      });
      styleRefreshers.push(() => options.forEach((o, i) => { const on = get() === o.id; bs[i].classList.toggle('on', on); bs[i].setAttribute('aria-pressed', on ? 'true' : 'false'); }));
      return el;
    }
    const group = (title, body, hint) => h('div', { class: 'ss-group' }, h('div', { class: 'ss-glabel' }, title), body, hint || null);

    function rangeRow(label, get, set, o) {
      const val = h('span', { class: 'ss-rval' });
      const inp = h('input', { type: 'range', class: 'ss-range', min: String(o.min), max: String(o.max), step: String(o.step), 'aria-label': label });
      inp.addEventListener('input', () => set(parseFloat(inp.value)));
      styleRefreshers.push(() => { const v = get(); if (document.activeElement !== inp || inp.value === '') inp.value = String(v); val.textContent = o.fmt(v); });
      return h('label', { class: 'ss-adv' }, h('span', { class: 'ss-advl' }, label), inp, val);
    }
    function colorRow(label, get, set, extra) {
      const inp = h('input', { type: 'color', class: 'ss-color', 'aria-label': label });
      inp.addEventListener('input', () => set(inp.value));
      styleRefreshers.push(() => { inp.value = get(); });
      return h('label', { class: 'ss-adv' }, h('span', { class: 'ss-advl' }, label), inp, extra || null);
    }

    function pickPreset(pid) {
      pushUndo('preset');
      style = S.applyPreset(style, pid, sctx());
      outlineManual = false;
      afterStyleEdit();
      ensureVisible();
    }
    function pickColor(c) {
      const patch = { color: c };
      if (!outlineManual) patch.outlineColor = autoOutline(c);
      setStyle(patch, 'color');
      ensureVisible();
    }
    function resetLook() {
      pushUndo('reset');
      const pid = S.PRESET_BY_ID[style.preset] ? style.preset : (lastPreset || 'basic');
      style = S.mergeStyle(S.applyPreset(style, pid, sctx()), { position: 'bottom', marginPct: null }, sctx());
      outlineManual = false;
      afterStyleEdit();
      ensureVisible();
      toast('↩ 처음 모양으로 돌렸어요');
    }
    /** 지금 재생 위치에 자막이 없으면 가장 가까운 줄로 가서, 바꾼 모양이 바로 보이게 */
    function ensureVisible() {
      if (playing() || !shown().length) return;
      const t = curTime();
      let best = null;
      let bd = Infinity;
      for (const l of shown()) {
        const dist = t < l.start ? l.start - t : t >= l.end ? t - l.end : 0;
        if (dist < bd) { bd = dist; best = l; }
      }
      if (best && bd > 0) seekTo(best.start + Math.min(0.5, Math.max(0.15, (best.end - best.start) / 2)));
    }

    function buildLook() {
      const { W, H } = out();
      const th = Math.round((THUMB_W * H) / W);
      presetsEl = h('div', { class: `ss-presets${H > W ? ' tall' : ''}` });
      const tile = (pid, label, desc) => {
        const cv = h('canvas', { class: 'ss-thumb', width: THUMB_W, height: th, 'aria-hidden': 'true' });
        thumbs.set(pid, cv);
        return h('button', { type: 'button', class: 'ss-preset', 'data-p': pid, 'aria-pressed': 'false', title: desc, onclick: () => { if (pid !== 'custom') pickPreset(pid); } },
          cv, h('span', { class: 'ss-pname' }, label), h('span', { class: 'ss-pcheck', 'aria-hidden': 'true' }, '✓'));
      };
      for (const p of S.PRESETS) presetsEl.appendChild(tile(p.id, `${p.emoji} ${p.label}`, p.desc));
      customTile = tile('custom', '🎨 내가 꾸민 모양', '아래에서 고른 대로 꾸민 모양이에요');
      customTile.hidden = true;
      presetsEl.appendChild(customTile);

      const swatches = h('div', { class: 'ss-swatches' }, S.COLOR_SWATCHES.map((c) => h('button', {
        type: 'button', class: 'ss-sw', 'data-c': c.toLowerCase(), style: { background: c }, title: c, 'aria-label': `글자 색 ${c}`, 'aria-pressed': 'false', onclick: () => pickColor(c),
      }, h('span', { class: 'ss-swcheck', 'aria-hidden': 'true' }, '✓'))));
      const fonts = h('div', { class: 'ss-fonts' }, S.FONTS.map((f) => h('button', {
        type: 'button', class: 'ss-font', 'data-f': f.id, 'aria-pressed': 'false', onclick: () => setStyle({ font: f.id }, 'font'),
      }, h('span', { class: 'ss-fsample', style: { fontFamily: f.stack, fontWeight: String(f.weight) } }, '가나다 ABC'), h('span', { class: 'ss-fname' }, f.label), h('span', { class: 'ss-fcheck', 'aria-hidden': 'true' }, '✓'))));
      hintEl = h('div', { class: 'ss-hint', hidden: true }, '💡 배경이 복잡하면 읽기 어려워요');

      const manualMargin = () => style.marginPct != null;
      const marginRow = h('div', { class: 'ss-adv' }, h('span', { class: 'ss-advl' }, '가장자리 여백'));
      const mAuto = btn('자동', () => setStyle({ marginPct: null }, 'margin'), 'small ss-mini');
      const mManual = btn('직접', () => {
        const m = S.layoutMetrics(style, W, H).margin;
        setStyle({ marginPct: Math.round(((style.position === 'top' ? m.top : m.bottom) / H) * 1000) / 10 }, 'margin');
      }, 'small ss-mini');
      const mRange = h('input', { type: 'range', class: 'ss-range', min: '0', max: '40', step: '0.5', 'aria-label': '여백(%)' });
      mRange.addEventListener('input', () => setStyle({ marginPct: parseFloat(mRange.value) }, 'margin'));
      const mVal = h('span', { class: 'ss-rval' });
      marginRow.append(mAuto, mManual, mRange, mVal);
      styleRefreshers.push(() => {
        mAuto.classList.toggle('on', !manualMargin());
        mManual.classList.toggle('on', manualMargin());
        mRange.disabled = !manualMargin();
        if (manualMargin() && document.activeElement !== mRange) mRange.value = String(style.marginPct);
        mVal.textContent = manualMargin() ? `${style.marginPct}%` : '자동';
      });
      const outAuto = btn('자동', () => { outlineManual = false; setStyle({ outlineColor: autoOutline(style.color) }, 'outcolor'); }, 'small ss-mini', '글자 밝기에 맞춰 검정 / 흰색');

      const adv = AM.kit.fold('고급 (숫자·색 직접 고르기)', h('div', { class: 'ss-advbox' },
        rangeRow('글자 크기 배율', () => style.sizeScale, (v) => setStyle({ sizeScale: v }, 'scale'), { min: 0.6, max: 2, step: 0.05, fmt: (v) => `×${Number(v).toFixed(2)}` }),
        marginRow,
        rangeRow('나타나는 시간', () => style.fade, (v) => setStyle({ fade: v }, 'fade'), { min: 0, max: 1, step: 0.05, fmt: (v) => `${Number(v).toFixed(2)}초` }),
        colorRow('글자 색 직접 고르기', () => style.color, (v) => pickColor(v)),
        colorRow('테두리 색', () => style.outlineColor, (v) => { outlineManual = true; setStyle({ outlineColor: v }, 'outcolor'); }, outAuto),
        colorRow('글자 바탕 색', () => style.boxColor, (v) => setStyle({ boxColor: v }, 'boxcolor')),
        group('줄 수 (가장 많이)', seg([1, 2, 3].map((n) => ({ id: n, label: `${n}줄` })), () => style.maxLines, (v) => setStyle({ maxLines: v }, 'maxlines'), '최대 줄 수')),
        group('안전 영역 (버튼에 안 가려지게 비워 두기)', seg([{ id: 'auto', label: '자동' }, { id: 'off', label: '끄기' }], () => style.safeArea, (v) => setStyle({ safeArea: v }, 'safe'), '안전 영역'))));

      seriesChk = h('input', { type: 'checkbox', id: `ss-series-${id}` });
      seriesChk.addEventListener('change', () => { pushUndo('series'); applyToSeries = seriesChk.checked; syncDirty(); });
      seriesRow = h('label', { class: 'ss-series', for: `ss-series-${id}`, hidden: !hasSeries() }, seriesChk, h('span', null, '이 모양을 이 이야기 모음 전체에 쓰기', snap.series && snap.series.name ? h('em', null, ` (${AM.niceTitle(snap.series.name)})`) : null));

      styleRefreshers.push(() => {
        for (const b of presetsEl.children) {
          const on = b.dataset.p === style.preset;
          b.classList.toggle('on', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        customTile.hidden = style.preset !== 'custom';
        for (const b of swatches.children) { const on = b.dataset.c === String(style.color).toLowerCase(); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
        for (const b of fonts.children) { const on = b.dataset.f === style.font; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
        hintEl.hidden = !(style.outline === 'none' && style.box === 'none');
        seriesChk.checked = applyToSeries;
        seriesRow.hidden = !hasSeries();
      });

      return h('div', { class: 'ss-pane ss-look', 'data-pane': 'look' },
        group('🎨 모양 고르기', presetsEl, h('p', { class: 'ss-sub' }, '누르면 위 영상에 바로 입혀 보여요.')),
        h('h3', { class: 'ss-h3' }, '더 꾸미기'),
        group('크기', seg(S.SIZES.map((s) => ({ id: s.id, label: s.label })), () => style.size, (v) => setStyle({ size: v }, 'size'), '글자 크기')),
        group('위치', seg(S.POSITIONS.map((p) => ({ id: p.id, label: p.label, icon: POS_ICON[p.id] })), () => style.position, (v) => setStyle({ position: v }, 'pos'), '글자 위치')),
        group('글자 색', swatches),
        group('테두리', seg(S.OUTLINES.map((o) => ({ id: o.id, label: o.label })), () => style.outline, (v) => setStyle({ outline: v }, 'outline'), '테두리')),
        group('글자 바탕', seg(S.BOXES.map((b) => ({ id: b.id, label: b.label })), () => style.box, (v) => setStyle({ box: v }, 'box'), '글자 바탕')),
        hintEl,
        group('글꼴', fonts),
        h('div', { class: 'ss-lookfoot' }, btn('↩ 처음 모양으로', resetLook, 'ss-reset', '고른 모양의 처음 모습으로 돌아가요'), seriesRow),
        adv);
    }
    function refreshStyleUI() { for (const f of styleRefreshers) f(); }

    // ======================================================================================
    // 줄 목록 (✏️ 글자 · ⏱ 시간)
    // ======================================================================================
    const textRows = new Map();
    const timeRows = new Map();
    let textList = null;
    let timeList = null;

    function reconcile(container, map, make, patch) {
      const seen = new Set();
      let prev = null;
      lines.forEach((l, i) => {
        let r = map.get(l._k);
        if (!r) { r = make(l._k); map.set(l._k, r); }
        patch(r, l, i);
        const want = prev ? prev.nextSibling : container.firstChild;
        if (r.el !== want) container.insertBefore(r.el, want);
        prev = r.el;
        seen.add(l._k);
      });
      for (const [k, r] of map) if (!seen.has(k)) { r.el.remove(); map.delete(k); }
    }
    function reconcileAll() {
      if (textList) reconcile(textList, textRows, makeTextRow, patchTextRow);
      if (timeList) reconcile(timeList, timeRows, makeTimeRow, patchTimeRow);
      stale.text = false;
      stale.time = false;
      if (emptyHint) emptyHint.hidden = lines.length > 0;
    }
    /** 보이는 탭의 줄만 고쳐 쓴다 (다른 탭은 열 때) */
    function patchVisible() {
      if (tab === 'text' && textList) { lines.forEach((l, i) => { const r = textRows.get(l._k); if (r) patchTextRow(r, l, i); }); stale.text = false; }
      if (tab === 'time' && timeList) { lines.forEach((l, i) => { const r = timeRows.get(l._k); if (r) patchTimeRow(r, l, i); }); stale.time = false; }
    }
    let emptyHint = null;

    function select(k) {
      sel = k;
      for (const m of [textRows, timeRows]) for (const [rk, r] of m) r.el.classList.toggle('sel', rk === k);
    }
    function autoGrow(ta) {
      ta.style.height = 'auto';
      if (ta.scrollHeight) ta.style.height = `${ta.scrollHeight + 2}px`;
    }
    function layoutOf(l) {
      if (!R || !measureCtx || !l.text.trim()) return null;
      const { W, H } = out();
      try { return R.getLayout(measureCtx, l.text, style, W, H); } catch (_) { return null; }
    }

    // ---- 글자 탭의 줄 ----
    function makeTextRow(k) {
      const num = h('span', { class: 'ss-num' });
      const sec = h('span', { class: 'ss-sec' });
      const chip = h('button', { type: 'button', class: 'ss-timechip', title: '영상을 이 줄이 나오는 곳으로 옮겨요', onclick: () => { select(k); showLine(findLine(k), true); } });
      const badge = h('span', { class: 'ss-badge' });
      const listen = btn('▶ 여기서 듣기', () => listenLine(k, 0), 'small ss-listen', '이 줄이 나오는 곳부터 이 줄이 끝날 때까지 들어요');
      const menu = AM.kit.menu(() => rowMenu(k), { title: '이 줄에 하고 싶은 것', class: 'ss-menu' });
      const ta = h('textarea', { class: 'ss-ta', rows: '1', spellcheck: 'false', 'aria-label': '자막 글', placeholder: '여기에 글을 적어요' });
      const warn = h('div', { class: 'ss-warns' });
      const el = h('div', { class: 'ss-row', 'data-k': k },
        h('div', { class: 'ss-rtop' }, num, chip, sec, h('span', { class: 'grow' }), listen, menu), ta, h('div', { class: 'ss-rbot' }, badge, warn));
      ta.addEventListener('focus', () => { select(k); showLine(findLine(k), false); });
      ta.addEventListener('input', () => {
        const l = findLine(k);
        if (!l) return;
        pushUndo(`text:${k}`);
        l.text = ta.value;
        autoGrow(ta);
        afterEdit();
        if (shown()[0] === l) scheduleThumbs();
      });
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { // Enter = 다음 줄 (줄바꿈은 Shift+Enter)
          e.preventDefault();
          const nx = lines[indexOf(k) + 1];
          const r = nx && textRows.get(nx._k);
          if (r) { r.ta.focus({ preventScroll: true }); r.ta.setSelectionRange(0, 0); scrollRow(r); }
        } else if (e.key === 'Escape') ta.blur();
      });
      el.addEventListener('pointerdown', (e) => { if (!e.target.closest('button, textarea')) { select(k); showLine(findLine(k), false); } });
      return { el, num, sec, chip, badge, ta, warn, listen, k, wsig: '' };
    }
    function patchTextRow(r, l, i) {
      r.num.textContent = String(i + 1);
      r.sec.textContent = l.sectionStart && l.section ? `· ${l.section}` : '';
      r.chip.textContent = fmtClock(l.start);
      r.badge.textContent = l.hidden ? '🙈 숨겼어요' : (l._tapped ? '✅ 직접 맞춘 시간' : '~ 자동으로 맞춘 시간');
      r.badge.className = `ss-badge${l.hidden ? ' off' : l._tapped ? ' ok' : ''}`;
      r.el.classList.toggle('off', !!l.hidden);
      r.el.classList.toggle('sel', sel === l._k);
      r.el.classList.toggle('active', activeK === l._k);
      if (r.ta.value !== l.text) { r.ta.value = l.text; autoGrow(r.ta); }
      if (sigFor !== style) { sigFor = style; sigNow = S.styleSig(style); }
      const sig = `${l.text}|${l.hidden}|${round2(l.end - l.start)}|${sigNow}`;
      if (sig !== r.wsig) {
        r.wsig = sig;
        const w = lineWarnings(l, layoutOf(l));
        clear(r.warn);
        for (const t of w) r.warn.appendChild(h('span', { class: 'ss-warn' }, `⚠ ${t}`));
      }
    }
    function rowMenu(k) {
      const l = findLine(k);
      const i = indexOf(k);
      if (!l) return [];
      return [
        { label: '✂ 나누기 (커서 자리에서)', onClick: () => doSplit(k) },
        { label: '⤵ 아래 줄과 합치기', onClick: () => doMerge(k), disabled: i >= lines.length - 1 },
        { label: l.hidden ? '👁 다시 보이기' : '🙈 숨기기', onClick: () => doHide(k) },
        { label: '🗑 지우기', danger: true, onClick: () => doDelete(k) },
      ];
    }
    function listenLine(k, lead) {
      const l = findLine(k);
      if (!l || !media() || phase === 'applying') return;
      select(k);
      seekTo(Math.max(0, l.start - lead));
      play(l.end);
    }
    function doSplit(k) {
      const i = indexOf(k);
      const r = textRows.get(k);
      const caret = r ? r.ta.selectionStart : 0;
      pushUndo();
      const b = splitLine(lines, i, caret, duration());
      if (!b) { hist.pop(); refreshUndo(); toast('여기서는 나눌 수 없어요. 글 가운데를 눌러 보세요', 'err'); return; }
      afterRestructure();
      select(b._k);
      showLine(b, true);
      toast('✂ 두 줄로 나눴어요');
    }
    function doMerge(k) {
      const i = indexOf(k);
      pushUndo();
      const a = mergeNext(lines, i, duration());
      if (!a) { hist.pop(); refreshUndo(); return; }
      afterRestructure();
      select(a._k);
      showLine(a, true);
      toast('⤵ 아래 줄과 합쳤어요');
    }
    function doHide(k) {
      const l = findLine(k);
      if (!l) return;
      pushUndo();
      l.hidden = !l.hidden;
      afterRestructure();
      toast(l.hidden ? '🙈 숨겼어요 (영상에 나오지 않아요)' : '👁 다시 보여요');
    }
    function doDelete(k) {
      const i = indexOf(k);
      if (i < 0) return;
      pushUndo();
      lines.splice(i, 1);
      sel = (lines[i] || lines[i - 1] || {})._k || null;
      afterRestructure();
      toast('🗑 지웠어요 (되돌리려면 ↩)');
    }
    function doAdd() {
      pushUndo();
      const after = sel ? indexOf(sel) : lines.length - 1;
      const l = addLine(lines, after, curTime(), duration());
      afterRestructure();
      select(l._k);
      const r = textRows.get(l._k);
      if (r) { scrollRow(r); r.ta.focus({ preventScroll: true }); }
    }
    function doReplace(find, to) {
      if (!find) { toast('바꿀 글을 적어 주세요', 'err'); return; }
      pushUndo();
      const n = replaceAll(lines, find, to);
      if (!n) { hist.pop(); refreshUndo(); toast('그 글이 들어 있는 줄이 없어요'); return; }
      afterRestructure();
      toast(`🔎 ${n}줄을 바꿨어요`);
    }

    function buildText() {
      textList = h('div', { class: 'ss-rows' });
      emptyHint = h('p', { class: 'ss-sub', hidden: true }, '줄이 하나도 없어요. 아래 [＋ 줄 추가] 를 눌러 보세요.');
      const find = h('input', { type: 'text', class: 'ss-find', placeholder: '찾을 글', 'aria-label': '찾을 글' });
      const to = h('input', { type: 'text', class: 'ss-find', placeholder: '바꿀 글', 'aria-label': '바꿀 글' });
      const fold = AM.kit.fold('🔎 찾아 바꾸기 (같은 글자를 모두 고쳐요)', h('div', { class: 'ss-findbox' }, find, to, btn('모두 바꾸기', () => doReplace(find.value, to.value), 'ss-doreplace')));
      return h('div', { class: 'ss-pane ss-textpane', 'data-pane': 'text' },
        h('p', { class: 'ss-sub' }, '글을 고치면 위 영상에 바로 보여요. Enter 는 다음 줄로, Shift+Enter 는 줄바꿈이에요.'),
        emptyHint, textList, btn('＋ 줄 추가', doAdd, 'ss-add', '고른 줄 아래에 새 줄을 넣어요'), fold);
    }

    // ---- 시간 탭의 줄 ----
    function makeTimeRow(k) {
      const num = h('span', { class: 'ss-num' });
      const txt = h('span', { class: 'ss-ttext' });
      const play = btn('▶ 듣기', () => listenLine(k, 1), 'small ss-listen', '이 줄 1초 전부터 들어요');
      const sv = h('span', { class: 'ss-tval' });
      const ev = h('span', { class: 'ss-tval' });
      const row = (label, a, v, b) => h('div', { class: 'ss-tcell' }, h('span', { class: 'ss-tlab' }, label), a, v, b);
      const dec = btn('− 0.1초', () => nudgeTime(k, -NUDGE), 'ss-t', '0.1초 일찍 나와요');
      const inc = btn('+ 0.1초', () => nudgeTime(k, NUDGE), 'ss-t', '0.1초 늦게 나와요');
      const edec = btn('끝 −', () => nudgeEndTime(k, -NUDGE), 'ss-t', '0.1초 일찍 사라져요');
      const einc = btn('끝 +', () => nudgeEndTime(k, NUDGE), 'ss-t', '0.1초 늦게 사라져요');
      const now = btn('🎯 지금 여기가 시작', () => nowStart(k), 'ss-t ss-now', '영상이 지금 있는 곳을 이 줄이 나오는 시작으로 해요');
      const el = h('div', { class: 'ss-trow', 'data-k': k },
        h('div', { class: 'ss-rtop' }, num, txt, play),
        h('div', { class: 'ss-tgrid' }, row('시작', dec, sv, inc), row('끝', edec, ev, einc)),
        now);
      el.addEventListener('pointerdown', (e) => { if (!e.target.closest('button')) { select(k); showLine(findLine(k), false); } });
      return { el, num, txt, sv, ev, dec, inc, edec, einc, now, play, k };
    }
    function patchTimeRow(r, l, i) {
      r.num.textContent = String(i + 1);
      r.txt.textContent = (l.hidden ? '🙈 ' : '') + (l.text.replace(/\n/g, ' ') || '(빈 줄)');
      r.sv.textContent = fmtTenth(l.start);
      clear(r.ev);
      r.ev.append(fmtTenth(l.end), h('small', { class: 'ss-evtag' }, l.endLocked ? '직접 정함' : '자동'));
      r.el.classList.toggle('off', !!l.hidden);
      r.el.classList.toggle('sel', sel === l._k);
      r.el.classList.toggle('active', activeK === l._k);
      for (const b of [r.dec, r.inc, r.edec, r.einc, r.now, r.play]) b.disabled = !!l.hidden;
    }
    function flashRow(k) {
      const r = timeRows.get(k);
      if (!r) return;
      r.el.classList.remove('flash');
      void r.el.offsetWidth; // 애니메이션을 다시 시작
      r.el.classList.add('flash');
    }
    function afterTimeEdit(k, moved) {
      afterEdit();
      flashRow(k);
      const l = findLine(k);
      if (!moved && l) toast('더 옮길 수 없어요 (이웃 줄과 너무 가까워요)');
      if (l && !playing()) seekTo(l.start + Math.max(0.2, (style.fade || 0.15) + 0.1));
    }
    function nudgeTime(k, d) {
      const i = indexOf(k);
      if (i < 0) return;
      select(k);
      pushUndo(`t:${k}`);
      const moved = setStart(lines, i, lines[i].start + d, duration());
      afterTimeEdit(k, Math.abs(moved) > 1e-9);
    }
    function nudgeEndTime(k, d) {
      const i = indexOf(k);
      if (i < 0) return;
      select(k);
      pushUndo(`te:${k}`);
      const moved = nudgeEnd(lines, i, d, duration());
      afterEdit();
      flashRow(k);
      if (Math.abs(moved) < 1e-9) toast('더 옮길 수 없어요');
      if (!playing()) { const l = findLine(k); if (l) seekTo(Math.max(l.start, l.end - 0.4)); }
    }
    function nowStart(k) {
      const i = indexOf(k);
      if (i < 0) return;
      select(k);
      pushUndo(`t:${k}`);
      const t = Math.max(0, curTime() - (playing() ? 0.12 : 0)); // 재생 중에 누르면 누르는 데 걸린 시간만큼 앞당겨요
      const moved = setStart(lines, i, t, duration());
      afterTimeEdit(k, true);
      if (Math.abs(moved) < 1e-9) toast('이미 여기가 시작이에요');
      else toast('🎯 여기가 시작이 됐어요');
    }
    function doShiftAll(d) {
      pushUndo(`shift`);
      const moved = shiftAll(lines, d, duration());
      afterEdit();
      toast(Math.abs(moved) < 1e-9 ? '더 옮길 수 없어요' : (d < 0 ? '⏪ 모든 자막을 0.1초 당겼어요' : '⏩ 모든 자막을 0.1초 미뤘어요'));
      if (!playing()) ensureVisible();
    }

    function buildTime() {
      timeList = h('div', { class: 'ss-rows' });
      return h('div', { class: 'ss-pane ss-timepane', 'data-pane': 'time' },
        h('div', { class: 'ss-ttop' },
          btn('🎤 처음부터 탭으로 맞추기', openTap, 'primary ss-tapbtn', '노래를 들으며 줄이 시작할 때마다 [지금!] 을 눌러 맞춰요'),
          h('div', { class: 'ss-shift' },
            btn('⏪ 자막이 늦어요 · 모두 0.1초 당기기', () => doShiftAll(-NUDGE), 'ss-t'),
            btn('⏩ 자막이 빨라요 · 모두 0.1초 미루기', () => doShiftAll(NUDGE), 'ss-t'))),
        h('p', { class: 'ss-sub' }, '줄을 누르면 영상이 그 줄로 가요. 영상을 알맞은 곳에 세우고 [🎯 지금 여기가 시작] 을 눌러도 돼요.'),
        timeList);
    }

    // ======================================================================================
    // 🎤 탭으로 맞추기 (기존 두 단계 화면을 큰 창에서)
    // ======================================================================================
    let tapModal = null;
    function openTap() {
      if (tapModal || phase !== 'idle') return;
      const vis = shown();
      if (!vis.length) { toast('먼저 가사 줄을 하나 이상 만들어 주세요', 'err'); return; }
      const LS = window.AMLyricSync;
      if (!LS) { toast('맞추기 화면을 열 수 없어요', 'err'); return; }
      pause();
      const modalRoot = document.getElementById('modal-root');
      let tv = null;
      if (hasVideoFile() && mode !== 'released') {
        tv = document.createElement('video');
        tv.preload = 'auto';
        tv.setAttribute('playsinline', '');
        tv.src = cleanUrl();
      }
      const w = LS.mount({
        lines: vis.map((l) => ({ text: l.text, start: l.start, end: l.end, part: 1, section: l.section, sectionStart: l.sectionStart })),
        duration: duration() || 1,
        src: tv ? undefined : songUrl(),
        confirmed: false,
        video: tv || undefined,
        styleProvider: () => ({ style, W: out().W, H: out().H }),
        isActive: () => !!modalRoot.lastElementChild && modalRoot.lastElementChild.contains(w.el),
      });
      const release = () => { if (tv) { try { tv.pause(); tv.removeAttribute('src'); tv.load(); } catch (_) { /* noop */ } } };
      tapModal = AM.kit.sheet('🎤 처음부터 탭으로 맞추기', w.el, [
        { label: '취소' },
        {
          label: '💾 이대로 쓰기',
          kind: 'primary',
          onClick: () => {
            pushUndo();
            const left = w.untapped();
            mergeTap(lines, vis, w.result(), w.tappedFlags(), duration());
            afterRestructure();
            toast(left ? `✅ 시간을 바꿨어요 · ${left}줄은 아직 자동 시간이에요` : '✅ 시간을 모두 맞췄어요');
            return false;
          },
        },
      ], { width: 'min(1000px, 96vw)', sticky: true, onClose: () => { w.destroy(); release(); tapModal = null; scheduleDraw(); } });
    }

    function refreshUndo() { if (undoBtn) undoBtn.disabled = !hist.length; }

    // ======================================================================================
    // 위쪽 줄: 제목 · 취소 · 저장 (진행 막대)
    // ======================================================================================
    let root = null;
    let saveBtn;
    let cancelBtn;
    let dirtyDot;
    let saveHint;
    let progWrap;
    let progText;
    let progBar;
    let noticeEl;
    let tabBtns = [];
    let panes = {};

    const lastMs = () => (snap.steps && snap.steps.subtitles && snap.steps.subtitles.lastMs) || 0;
    /** 영상에 바로 입힐 수 없고 저장만 하는 때 */
    function storeReason() {
      if (!hasVideoFile()) return '영상이 만들어지면 자막이 입혀져요';
      if (snap.running) return '지금은 영상을 만드는 중이라 저장만 해요';
      if ((snap.redrawing || []).length) return '그림을 다시 그리는 중이라 저장만 해요. 끝나면 ✨ 고친 것 반영하기를 눌러 주세요';
      return '';
    }
    const onlyStore = () => !!storeReason();

    function buildHeader() {
      cancelBtn = btn('취소', onCancel, 'ss-cancel', '고친 것을 버리고 돌아가요');
      saveBtn = h('button', { type: 'button', class: 'btn primary ss-save', onclick: doSave });
      progBar = AM.kit.progressBar(null);
      progText = h('div', { class: 'ss-progtext', 'aria-live': 'polite' });
      progWrap = h('div', { class: 'ss-prog', hidden: true }, progText, progBar);
      dirtyDot = h('span', { class: 'ss-dirty', hidden: true }, '● 바뀐 곳이 있어요');
      saveHint = h('div', { class: 'ss-savehint' });
      return h('header', { class: 'ss-head' },
        h('div', { class: 'ss-title' }, h('h2', null, '💬 가사 자막 고치기')),
        h('div', { class: 'ss-actions' },
          h('div', { class: 'ss-btnrow' }, saveHint, dirtyDot, cancelBtn, saveBtn, progWrap)));
    }
    function progressInfo() {
      const st = snap.steps || {};
      const cs = snap.currentStep;
      const step = snap.running && STEP_SENTENCE[cs] ? cs : 'subtitles';
      const s = st[step] || {};
      const pct = s.progress && s.progress.total ? clamp((s.progress.done / s.progress.total) * 100, 0, 100) : null;
      const base0 = snap.running ? (STEP_SENTENCE[cs] || '💬 자막을 입히고 있어요') : '💾 저장했어요 · 곧 시작해요';
      return { text: pct == null ? base0 : `${base0} · ${Math.round(pct)}%`, pct };
    }
    function refreshHeader() {
      if (!saveBtn) return;
      const idle = phase === 'idle';
      const d = isDirty();
      const store = onlyStore();
      const subsPending = !!((snap.changes && snap.changes.subs) || snap.subsStale);
      progWrap.hidden = idle;
      saveBtn.hidden = !idle || emptyMode;
      cancelBtn.hidden = !idle;
      dirtyDot.hidden = !(idle && d);
      if (!idle) {
        if (phase === 'saving') { progText.textContent = '💾 저장하는 중이에요…'; progBar.set(null); } else {
          const p = progressInfo();
          progText.textContent = p.text;
          progBar.set(p.pct);
        }
        saveHint.textContent = '';
        return;
      }
      if (emptyMode) { saveHint.textContent = ''; return; }
      const time = `지난번 ${lastTimeLabel(lastMs())}`;
      let label;
      let off = false;
      let why = '';
      if (snap.running && snap.currentStep === 'subtitles') { label = '💾 저장하기'; off = true; why = '지금 자막을 영상에 입히는 중이에요. 끝나면 고칠 수 있어요'; } else if (d) label = store ? '💾 저장하기' : `💾 저장하고 영상에 입히기 (${time})`;
      else if (!store && subsPending) label = `✨ 영상에 입히기 (${time})`;
      else { label = store ? '💾 저장하기' : `💾 저장하고 영상에 입히기 (${time})`; off = true; why = '바꾼 것이 없어요'; }
      saveBtn.textContent = label;
      saveBtn.disabled = off;
      saveBtn.title = why;
      saveHint.textContent = off ? why : (store ? storeReason() : '');
    }

    async function onCancel() {
      if (phase !== 'idle') return;
      if (isDirty() && !await AM.confirmBox('저장하지 않은 변경이 있어요', '나갈까요?', '나가기', 'danger')) return;
      if (AM.leaveGuard === guard) AM.leaveGuard = null; // 방금 물었으니 또 묻지 않게
      if (ctx.onClose) ctx.onClose();
    }

    function showNotice() {
      if (!noticeEl) return;
      clear(noticeEl);
      if (errorMsg) {
        noticeEl.appendChild(h('div', { class: 'notice err ss-notice', role: 'alert' },
          h('span', { class: 'grow' }, `⚠ ${errorMsg}`),
          h('button', { type: 'button', class: 'btn small', onclick: () => { errorMsg = ''; showNotice(); } }, '닫기')));
      }
      if (notice) noticeEl.appendChild(h('div', { class: 'notice info ss-notice' }, notice));
    }
    function setPhase(p) {
      phase = p;
      if (ctx.onBusy) { try { ctx.onBusy(p !== 'idle'); } catch (_) { /* noop */ } }
      if (root) root.classList.toggle('ss-busy', p !== 'idle');
      if (p === 'applying') releaseVideo();
      refreshHeader();
      updateControls();
    }

    // ---- 저장하고 영상에 입히기 ----
    function adoptSaved(res) {
      const saved = recompute(((res && res.lines) || []).map((l) => mkLine(l, true)), duration());
      const mine = realLines(lines);
      if (mine.length === saved.length) saved.forEach((l, i) => { l._k = mine[i]._k; l._tapped = mine[i]._tapped; });
      const st = S.normalizeStyle(res && res.style ? res.style : style, sctx());
      base = { lines: saved, style: st, lineSig: sigLines(saved), styleSig: sigStyle(st) };
      if (notice) { notice = ''; showNotice(); }
      lines = cloneLines(saved);
      style = { ...st };
      applyToSeries = false;
      afterRestructure();
    }
    async function doSave() {
      if (phase !== 'idle' || destroyed) return;
      errorMsg = '';
      showNotice();
      const d = isDirty();
      const store = onlyStore();
      setPhase('saving');
      try {
        if (d) {
          const payload = { applyToSeries: applyToSeries && hasSeries() };
          if (dirtyStyle()) payload.style = { ...style };
          if (dirtyLines()) payload.lines = realLines(lines).map(toSaveLine);
          adoptSaved(await api.saveSubtitles(id, payload));
        }
        if (store) {
          setPhase('idle');
          toast(hasVideoFile() ? '💾 저장했어요. 영상에는 ✨ 고친 것 반영하기를 누르면 입혀져요' : '💾 저장했어요. 영상이 만들어지면 자막이 입혀져요', 'ok');
          if (ctx.onClose) ctx.onClose();
          return;
        }
        applyMark = { madeAt: (snap.output && snap.output.madeAt) || 0, t0: Date.now(), sawRunning: false };
        setPhase('applying'); // 영상 파일을 먼저 놓는다 (첫 소식이 오기 전에)
        const r = await api.applyChanges(id);
        if ((!r || r.from == null) && !snap.running) finishApply();
      } catch (e) {
        applyMark = null;
        setPhase('idle');
        errorMsg = (e && e.message) || '저장하지 못했어요';
        showNotice();
        refreshMedia();
      }
    }
    /** 소식이 올 때마다: 영상 입히기가 끝났는지 본다 */
    function checkApply() {
      if (phase !== 'applying' || !applyMark) return;
      if (snap.running) { applyMark.sawRunning = true; return; }
      const madeAt = (snap.output && snap.output.madeAt) || 0;
      if (!applyMark.sawRunning && madeAt === applyMark.madeAt && Date.now() - applyMark.t0 < 6000) return; // 아직 시작 소식을 기다리는 중
      finishApply();
    }
    function finishApply() {
      const madeAt = (snap.output && snap.output.madeAt) || 0;
      const ok = !snap.subsStale && (madeAt !== (applyMark ? applyMark.madeAt : 0) || !(snap.changes && snap.changes.subs));
      const fallback = snap.subsFallback === true;
      applyMark = null;
      setPhase('idle');
      if (ok) {
        toast('✅ 자막을 입혔어요', 'ok');
        if (fallback) toast('글꼴 때문에 간단한 방식으로 입혔어요. 모양이 미리 본 것과 조금 다를 수 있어요');
        if (ctx.onClose) ctx.onClose();
        return;
      }
      errorMsg = snap.status === 'stopped'
        ? '영상 입히기를 멈췄어요. 저장은 되어 있으니 [✨ 영상에 입히기] 를 누르면 이어서 해요'
        : (snap.error ? `자막을 영상에 입히지 못했어요. ${snap.error}` : '자막을 영상에 입히지 못했어요. 저장은 되어 있으니 [✨ 영상에 입히기] 를 다시 눌러 보세요');
      showNotice();
      refreshMedia();
    }

    // ======================================================================================
    // 가사가 없을 때
    // ======================================================================================
    function buildEmpty() {
      const ta = h('textarea', { class: 'ss-paste', rows: '9', hidden: true, placeholder: '가사를 붙여 넣어 주세요 (한 줄에 한 문장)', 'aria-label': '가사' });
      const go = btn('이 가사로 시작하기', async () => {
        const raw = ta.value.trim();
        if (!raw) { toast('가사를 먼저 붙여 넣어 주세요', 'err'); return; }
        go.disabled = true;
        try {
          await api.updateLyricsText(id, raw, '');
          snap = (ctx.getSnap && ctx.getSnap()) || snap;
          if (((snap.timing && snap.timing.lyrics) || []).length) { initWork(); build(); refreshMedia(); } else { notice = '가사를 저장했어요. 곧 자막을 꾸밀 수 있게 돼요'; showNotice(); }
        } catch (e) { errorMsg = (e && e.message) || '가사를 저장하지 못했어요'; showNotice(); }
        go.disabled = false;
      }, 'primary big');
      go.hidden = true;
      const open = btn('📝 가사 붙여넣기', () => { ta.hidden = false; go.hidden = false; open.hidden = true; ta.focus(); }, 'primary big');
      return h('section', { class: 'ss-empty' },
        h('div', { class: 'ss-empty-ico', 'aria-hidden': 'true' }, '💬'),
        h('h3', null, '가사를 넣으면 여기서 자막을 꾸밀 수 있어요'),
        h('p', null, '노래에 맞는 가사를 붙여 넣으면, 영상 위에 자막이 어떻게 보일지 바로 보면서 고를 수 있어요.'),
        open, ta, go);
    }

    // ======================================================================================
    // 전체 만들기 · 소식 받기 · 키보드 · 닫기
    // ======================================================================================
    function initWork() {
      base = readSnap();
      lines = cloneLines(base.lines);
      style = { ...base.style };
      lastPreset = S.PRESET_BY_ID[style.preset] ? style.preset : 'basic';
      applyToSeries = false;
      outlineManual = false;
      sel = null;
      activeK = null;
      hist.length = 0;
      heldTime = firstShowTime();
    }
    function setTab(t) {
      tab = t;
      tabBtns.forEach((b) => { const on = b.dataset.t === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
      for (const k of Object.keys(panes)) panes[k].hidden = k !== t;
      if ((t === 'text' && stale.text) || (t === 'time' && stale.time)) { reconcileAll(); }
      if (t === 'text') { for (const r of textRows.values()) autoGrow(r.ta); }
      const body = root && root.querySelector('.ss-tabbody');
      if (body) body.scrollTop = 0;
      if (t !== 'look' && sel) scrollRow((t === 'text' ? textRows : timeRows).get(sel));
    }
    /** 줄 목록 칸 안에서만 스크롤해서 그 줄이 보이게 (바깥 화면은 움직이지 않는다) */
    function scrollRow(r) {
      const body = r && root && root.querySelector('.ss-tabbody');
      if (!body || !r.el.offsetParent) return;
      const b = body.getBoundingClientRect();
      const e = r.el.getBoundingClientRect();
      if (e.top < b.top + 4) body.scrollTop += e.top - b.top - 8;
      else if (e.bottom > b.bottom - 4) body.scrollTop += e.bottom - b.bottom + 8;
    }
    function buildTabs() {
      const defs = [['look', '🎨 모양'], ['text', '✏️ 글자'], ['time', '⏱ 시간']];
      tabBtns = defs.map(([k, label]) => h('button', { type: 'button', role: 'tab', class: 'ss-tab', 'data-t': k, 'aria-selected': 'false', onclick: () => setTab(k) }, label));
      undoBtn = btn('↩ 되돌리기', undo, 'small ss-undo', '방금 한 것을 되돌려요 (Ctrl+Z)');
      panes = { look: buildLook(), text: buildText(), time: buildTime() };
      return h('section', { class: 'ss-panel' },
        h('div', { class: 'ss-tabs', role: 'tablist' }, ...tabBtns, h('span', { class: 'grow' }), undoBtn),
        h('div', { class: 'ss-tabbody' }, panes.look, panes.text, panes.time));
    }
    function build() {
      clear(root);
      thumbs.clear();
      styleRefreshers.length = 0;
      textRows.clear();
      timeRows.clear();
      bgCanvas = null;
      bgSig = '';
      stage = null;
      if (ro2) { ro2.disconnect(); ro2 = null; }
      root.appendChild(buildHeader());
      noticeEl = h('div', { class: 'ss-notices' });
      root.appendChild(noticeEl);
      emptyMode = !lines.length;
      if (emptyMode) {
        pause();
        root.appendChild(buildEmpty());
        refreshHeader();
        showNotice();
        return;
      }
      // 지난번 영상을 간단한 방식으로 입혔다면(글꼴 문제) 미리 보는 모양과 조금 달랐을 수 있다고 한 번 알려 준다
      if (snap.subsFallback === true && !notice) notice = '지난번에는 글꼴 때문에 간단한 방식으로 입혔어요. 영상의 글씨가 여기서 본 것과 조금 달랐을 수 있어요.';
      root.appendChild(h('div', { class: 'ss-body' }, buildPreview(), buildTabs()));
      setTab(tab);
      reconcileAll();
      refreshStyleUI();
      refreshControls();
      refreshUndo();
      refreshHeader();
      showNotice();
      layoutStage();
      showModeUI();
    }

    function update(next) {
      if (destroyed) return;
      snap = next || (ctx.getSnap && ctx.getSnap()) || snap;
      const rd = readSnap();
      const changed = !base || rd.lineSig !== base.lineSig || rd.styleSig !== base.styleSig;
      if (changed) {
        const wasDirty = isDirty();
        base = rd;
        if (phase === 'idle' && !wasDirty) { // 고친 것이 없으면 다른 곳에서 바뀐 값을 그대로 받아들인다
          lines = cloneLines(rd.lines);
          style = { ...rd.style };
          if (emptyMode !== !lines.length) { build(); refreshMedia(); } else afterRestructure();
        } else if (emptyMode && rd.lines.length) { initWork(); build(); refreshMedia(); }
      }
      if (!emptyMode) {
        if (seriesRow) seriesRow.hidden = !hasSeries();
        refreshMedia();
      }
      refreshHeader();
      checkApply();
    }

    const isTyping = (tg) => !!tg && (tg.tagName === 'TEXTAREA' || tg.tagName === 'SELECT' || tg.isContentEditable
      || (tg.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'color', 'submit'].includes(tg.type)));
    function onKey(e) {
      if (destroyed || !root || !root.isConnected) return;
      if (document.querySelector('#modal-root .modal-back')) return; // 창이 떠 있으면 쉰다
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && String(e.key).toLowerCase() === 'z' && !isTyping(e.target)) { e.preventDefault(); undo(); return; }
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey || emptyMode) return;
      if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) togglePlay(); } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        e.preventDefault();
        seekTo(curTime() + (e.code === 'ArrowLeft' ? -2 : 2));
      }
    }
    function onKeyUp(e) { // 스페이스바로 포커스 있는 단추가 또 눌리지 않게
      if (destroyed || emptyMode || e.code !== 'Space' || isTyping(e.target)) return;
      if (document.querySelector('#modal-root .modal-back')) return;
      e.preventDefault();
    }

    // ---- 시작 ----
    measureCtx = document.createElement('canvas').getContext('2d');
    root = h('div', { class: 'ss' });
    host.appendChild(root);
    initWork();
    if (isTall() && !mem.guideAuto) { showGuide = true; mem.guideAuto = true; } // 세로 영상은 처음 열 때 한 번 안전 영역을 보여 준다
    /** 오른쪽 탭 칸이 창 아래로 넘치지 않게 높이를 맞춘다 (칸 안에서만 스크롤) */
    function fitPanel() {
      const p = root && root.querySelector('.ss-panel');
      if (!p || root.classList.contains('ss-narrow') || window.innerWidth <= 900) { if (p) p.style.maxHeight = ''; return; }
      const pt = parseFloat(root.style.getPropertyValue('--ss-pt')) || 0;
      const stuck = pt + (parseFloat(getComputedStyle(p).top) || 0);
      const top = Math.max(p.getBoundingClientRect().top, stuck);
      p.style.maxHeight = `${Math.max(300, window.innerHeight - top - 14)}px`;
    }
    const mainScroller = host.closest ? host.closest('#main') : null;
    if (mainScroller) mainScroller.addEventListener('scroll', fitPanel, { passive: true });
    window.addEventListener('resize', fitPanel);
    let ro = null;
    if ('ResizeObserver' in window) {
      ro = new ResizeObserver(() => {
        root.classList.toggle('ss-narrow', root.getBoundingClientRect().width < 900);
        if (root.firstElementChild) root.style.setProperty('--ss-head-h', `${root.firstElementChild.offsetHeight}px`); // 아래 붙는 칸이 위쪽 줄 밑에서 멈추게
        const mainEl = root.closest('#main'); // 붙는 줄이 #main 안쪽 여백이 아니라 맨 위에 붙게 그 여백만큼 올려 준다
        root.style.setProperty('--ss-pt', `${mainEl ? parseFloat(getComputedStyle(mainEl).paddingTop) || 0 : 0}px`);
        layoutStage();
        fitPanel();
      });
      ro.observe(root);
    }
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('keyup', onKeyUp, true);
    build();
    refreshMedia();
    ensureFonts().then(() => {
      if (destroyed) return;
      for (const r of textRows.values()) r.wsig = '';
      stale.text = true;
      stale.time = true;
      patchVisible();
      scheduleDraw();
      drawThumbs();
    });

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      stopLoop();
      cancelAnimationFrame(drawQ);
      cancelAnimationFrame(thumbQ);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('resize', fitPanel);
      if (mainScroller) mainScroller.removeEventListener('scroll', fitPanel);
      if (ro) ro.disconnect();
      if (ro2) ro2.disconnect();
      if (tapModal) { try { tapModal.close(); } catch (_) { /* noop */ } }
      for (const e of [vEl, aEl]) { try { e.pause(); e.removeAttribute('src'); e.load(); } catch (_) { /* noop */ } }
      if (AM.leaveGuard === guard) AM.leaveGuard = null;
      if (phase !== 'idle' && ctx.onBusy) { try { ctx.onBusy(false); } catch (_) { /* noop */ } }
      if (root && root.parentNode) root.parentNode.removeChild(root);
    }

    const ctl = {
      update,
      destroy() { destroy(); if (AM.substudio.active === ctl) AM.substudio.active = null; },
      isDirty: () => !destroyed && isDirty(),
      /** 확인용: 지금 작업 사본을 복사해서 보여 준다 (화면은 이걸 쓰지 않는다) */
      _state: () => ({ style: { ...style }, lines: cloneLines(lines), phase, tab, mode, sel, time: curTime(), playing: playing(), emptyMode }),
    };
    AM.substudio.active = ctl;
    return ctl;
  }

  AM.substudio = {
    mount,
    active: null, // 지금 열려 있는 스튜디오 (확인용)
    util: {
      fmtClock, fmtTenth, lastTimeLabel, mkLine, toSaveLine, recompute, sigLines, sigStyle, startBounds, setStart, nudgeEnd, shiftAll, splitLine, mergeNext,
      addLine, replaceAll, mergeTap, lineWarnings, autoOutline, fitRect, realLines, LIMITS,
    },
  };
}(window.AM));
