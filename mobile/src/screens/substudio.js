// 💬 가사 자막 고치기 (자막 스튜디오) — 폰 판. 실제 영상(가사 글씨 없는 영상) 위에 실제 글꼴·크기의 자막을 얹어 보면서 모양 · 글자 · 시간을 고친다.
//   mountSubStudio(host, ctx) → { update(snap), destroy(), isDirty(), confirmLeave() }   ctx = { id, engine, getSnap(), toast, onClose(info?), ui, go?, native? }
//   화면 전체를 덮는 편집 화면이다 (위: 영상 + 내 조절줄, 아래: 접었다 펼치는 탭 시트 🎨 모양 | ✏️ 글자 | ⏱ 시간).
//   고친 것은 [저장] 을 누를 때까지 이 화면 안(작업 사본)에만 있다. 저장하면 saveSubtitles → applyChanges(깨끗한 원본에 자막을 다시 입히기).
//   영상을 못 덮는 시트가 아니라 화면 아래에 붙은 시트인 이유: 자막이 영상 위에서 어떻게 보이는지가 이 화면의 전부라서 영상이 계속 보여야 한다.
import { h, clear, toast as toastDefault, bottomSheet, confirmBox } from '../ui.js';
import SubStyle from '../../../src/shared/subtitle-style.js';
import SubRender from '../../../src/shared/subtitle-render.js';
import { installFonts } from '../fonts.js';
import { BK } from '../engine/keys.js';
import * as db from '../db.js';
import * as Core from './substudio-core.js';
import { createUrlBox, firstPicture, runApply, clamp, vibrate, fmtClock, fmtTenth, etaText, estimateApplySec, friendly } from './done-parts.js';
import { openTapSync } from './tap-sync.js';

const S = SubStyle;
const R = SubRender;
const { NUDGE } = Core;
const mem = { guideSeen: false };
const QUIET = 1700; // 자주 나오는 확인 알림은 짧게 (미리보기를 가리지 않게) // 화면을 다시 열어도 기억하는 것 (9:16 은 처음 한 번 안전 영역을 켜 준다)
const FONT_SAMPLE = '가나다라 ABC 함께라면 두렵지 않아';

export function mountSubStudio(host, ctx) {
  const { engine, id } = ctx;
  const say = ctx.toast || toastDefault;
  let snap = (ctx.getSnap && ctx.getSnap()) || {};
  let destroyed = false;
  let tab = 'look';
  let dockState = 'half'; // half | full | peek
  let style = S.normalizeStyle({});
  let lines = [];
  let base = null; // 마지막으로 알게 된 저장된 값 {lineSig, styleSig, style}
  let applyToSeries = false;
  let sel = null; // 고른 줄 열쇠
  let activeK = null; // 지금 재생 위치에 떠 있는 줄
  let phase = 'idle'; // idle | saving | applying
  let showGuide = false;
  let emptyMode = false;
  let errorMsg = '';
  const hist = [];

  const out = () => ({ W: (snap.outSize && snap.outSize.w) || 1280, H: (snap.outSize && snap.outSize.h) || 720 });
  const sctx = () => { const o = out(); return { w: o.W, h: o.H }; };
  const isTall = () => out().H > out().W;
  const hasSeries = () => !!(snap.series && snap.series.id);
  const hasClean = () => !!(snap.output && snap.output.clean);
  const duration = () => Number(snap.durationSec) || (Number.isFinite(vEl.duration) ? vEl.duration : 0) || 0;
  const shown = () => lines.filter((l) => !l.hidden && l.text.trim());
  const findLine = (k) => lines.find((l) => l._k === k) || null;
  const indexOf = (k) => lines.findIndex((l) => l._k === k);
  const firstShowTime = () => { const f = shown()[0]; return f ? f.start + Math.min(0.5, Math.max(0.1, (f.end - f.start) / 2)) : 0; };
  const styleN = () => S.normalizeStyle(style, sctx());

  // ───── 작업 사본 ─────
  function readSnap() {
    const timed = !!(snap.timing && ['tap', 'lrc', 'srt'].includes(snap.timing.lyricsSource));
    const ls = Core.recompute(((snap.timing && snap.timing.lyrics) || []).map((l) => Core.mkLine(l, timed)), duration());
    const st = S.normalizeStyle(snap.subtitleStyle || (snap.workflow && snap.workflow.subtitles), sctx());
    return { lines: ls, style: st, lineSig: Core.sigLines(ls), styleSig: Core.sigStyle(st) };
  }
  const cloneLines = (ls) => ls.map((l) => ({ ...l }));
  const dirtyLines = () => !!base && Core.sigLines(lines) !== base.lineSig;
  const dirtyStyle = () => !!base && (Core.sigStyle(style) !== base.styleSig || applyToSeries);
  const isDirty = () => dirtyLines() || dirtyStyle();
  function initWork() {
    const b = readSnap();
    base = { lineSig: b.lineSig, styleSig: b.styleSig, style: { ...b.style } };
    lines = cloneLines(b.lines);
    style = { ...b.style };
    applyToSeries = false;
    sel = null;
    activeK = null;
    hist.length = 0;
    emptyMode = !lines.length;
  }
  function pushUndo(key) {
    const now = Date.now();
    const last = hist[hist.length - 1];
    if (key && last && last.key === key && now - last.at < 1500) { last.at = now; return; }
    hist.push({ key, at: now, st: { style: { ...style }, lines: cloneLines(lines), apply: applyToSeries } });
    if (hist.length > 80) hist.shift();
    refreshHeader();
  }
  function undo() {
    const e = hist.pop();
    if (!e) return;
    style = e.st.style;
    lines = e.st.lines;
    applyToSeries = e.st.apply;
    afterRestructure();
    afterStyle(true);
    say('↩ 방금 한 것을 되돌렸어요', 'ok', QUIET);
  }

  // ───── 영상 · 소리 (한 개의 <video> 로 영상도 노래도 튼다) ─────
  const vEl = h('video', { class: 'ss-video', playsinline: true, preload: 'auto' });
  const stillEl = h('img', { class: 'ss-still', alt: '', hidden: true });
  const ov = h('canvas', { class: 'ss-ov' });
  const vbox = h('div', { class: 'ss-vbox' }, vEl, stillEl, ov);
  const stage = h('section', { class: 'ss-stage' }, vbox);
  const urls = createUrlBox();
  let mode = 'none'; // video | audio | none
  let mediaKey = '';
  let heldTime = 0;
  let wantSeek = null;
  let playUntil = null;
  let loop = 0;
  let loopKind = '';
  let drawQ = 0;
  let baseFrame = null; // 미리보기 그림 한 장 (꾸밈 모음 썸네일 바탕)
  let thumbQ = 0;

  const media = () => (mode === 'none' ? null : vEl);
  const playing = () => !!media() && !vEl.paused && !vEl.ended;
  const curTime = () => {
    if (!media()) return heldTime;
    return vEl.readyState === 0 && wantSeek != null ? wantSeek : (vEl.currentTime || 0);
  };
  function seekTo(t) {
    const d = duration();
    const v = clamp(Number(t) || 0, 0, d ? Math.max(0, d - 0.05) : Infinity);
    heldTime = v;
    if (media()) { try { vEl.currentTime = v; wantSeek = null; } catch (_) { wantSeek = v; } }
    scheduleDraw();
    updateControls();
  }
  function play(until) {
    if (!media() || phase === 'applying') return;
    playUntil = until == null ? null : until;
    const p = vEl.play();
    if (p && p.catch) p.catch(() => {});
  }
  function pause() { if (media()) vEl.pause(); playUntil = null; }
  function togglePlay() {
    if (playing()) { pause(); return; }
    const d = duration();
    if (d && curTime() >= d - 0.2) seekTo(0);
    play();
  }
  /** 이 줄이 화면에 보이는 순간으로 가기 (재생 중이 아니어도) */
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
    if (destroyed || !media() || vEl.paused) return;
    const step = () => {
      loop = 0;
      if (destroyed || !playing()) return;
      draw();
      updateControls();
      if (playUntil != null && curTime() >= playUntil) { pause(); return; }
      startLoop();
    };
    if (vEl.requestVideoFrameCallback) { loopKind = 'v'; loop = vEl.requestVideoFrameCallback(step); } else { loopKind = 'r'; loop = requestAnimationFrame(step); }
  }
  const moved = () => { scheduleDraw(); updateControls(); };
  ['seeked', 'timeupdate', 'loadeddata', 'durationchange'].forEach((ev) => vEl.addEventListener(ev, moved));
  vEl.addEventListener('loadedmetadata', () => {
    if (wantSeek != null) { try { vEl.currentTime = wantSeek; } catch (_) { /* 다음 기회에 */ } wantSeek = null; }
    fitStage();
    moved();
  });
  vEl.addEventListener('play', () => { startLoop(); updateControls(); });
  vEl.addEventListener('pause', () => { stopLoop(); moved(); });
  vEl.addEventListener('ended', () => { stopLoop(); moved(); });
  let baseFresh = false; // 첫 가사 순간으로 간 뒤의 장면을 한 번 받았는가
  vEl.addEventListener('loadeddata', () => { if (!baseFrame && mode === 'video') captureBase(); });
  vEl.addEventListener('seeked', () => { if (!baseFresh && mode === 'video' && vEl.videoWidth) { baseFresh = true; captureBase(); } });
  vEl.addEventListener('error', () => {
    if (!vEl.getAttribute('src') || mode !== 'video') return;
    notice('영상 파일을 열지 못했어요 · 노래로 미리 보고 있어요', 'warn');
    mediaKey = '';
    forceAudio = true;
    refreshMedia();
  });
  let forceAudio = false;

  async function refreshMedia() {
    if (destroyed) return;
    const o = snap.output || {};
    const key = hasClean() && !forceAudio ? `v|${o.clean}|${o.cleanAt || 0}` : `a|${snap.song ? snap.song.rev : 0}`;
    if (key === mediaKey) return;
    mediaKey = key;
    let blob = null;
    let m = 'none';
    try {
      if (key[0] === 'v') { blob = await engine.render.output(id, 'clean'); m = blob ? 'video' : 'none'; }
      if (!blob) { blob = await db.getFile(BK.song(id)); m = blob ? 'audio' : 'none'; }
    } catch (_) { blob = null; m = 'none'; }
    if (destroyed || key !== mediaKey) return;
    mode = m;
    baseFrame = null;
    baseFresh = false;
    stillEl.hidden = m === 'video';
    vEl.classList.toggle('audio-only', m !== 'video');
    if (m !== 'video') {
      const pic = await firstPicture(engine, id, snap).catch(() => null);
      if (destroyed || key !== mediaKey) return;
      if (pic) { stillEl.onload = () => { captureBase(); }; stillEl.src = urls.get('still', `${key}|p`, pic); } else { stillEl.removeAttribute('src'); captureBase(); }
    }
    const first = shown().length ? firstShowTime() : Math.min(5, duration() * 0.3); // 가사가 없으면 처음의 까만 장면 말고 조금 뒤
    heldTime = first;
    wantSeek = first;
    if (blob) vEl.src = urls.get('media', key, blob); else { vEl.removeAttribute('src'); vEl.load(); }
    fitStage();
    scheduleDraw();
    updateControls();
  }
  /** 꾸밈 모음 썸네일에 쓸 그림 한 장 (영상의 한 장면 · 영상이 아직 없으면 첫 그림 · 그것도 없으면 은은한 바탕) */
  function captureBase() {
    const { W, H } = out();
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    try {
      if (mode === 'video' && vEl.videoWidth) g.drawImage(vEl, 0, 0, W, H);
      else if (stillEl.naturalWidth) g.drawImage(stillEl, 0, 0, W, H);
      else {
        const gr = g.createLinearGradient(0, 0, W, H);
        gr.addColorStop(0, '#6b7bd8'); gr.addColorStop(1, '#b07be0');
        g.fillStyle = gr; g.fillRect(0, 0, W, H);
      }
    } catch (_) { /* 그림을 못 읽으면 바탕 없이 */ }
    baseFrame = c;
    if (mode !== 'video' && !stillEl.getAttribute('src')) { try { stillEl.src = c.toDataURL('image/jpeg', 0.7); } catch (_) { /* 바탕 없이 */ } } // 그림이 없으면 은은한 바탕을 깐다
    paintThumbsSoon();
  }

  // ───── 그리기 ─────
  const SAMPLE = S.SAMPLE_LINES[0];
  function draw() {
    drawQ = 0;
    if (destroyed) return;
    const { W, H } = out();
    if (ov.width !== W) ov.width = W;
    if (ov.height !== H) ov.height = H;
    const g = ov.getContext('2d');
    const st = styleN();
    g.clearRect(0, 0, W, H);
    if (st.enabled) {
      if (emptyMode) R.drawFrame(g, [{ text: SAMPLE, start: 0, end: 1e9 }], 1, st, W, H);
      else R.drawFrame(g, Core.realLines(lines), curTime(), st, W, H);
    }
    if (showGuide) R.drawSafeGuide(g, st, W, H, { label: true });
    markActive();
  }
  function scheduleDraw() { if (destroyed || drawQ) return; drawQ = requestAnimationFrame(draw); }
  function markActive() {
    const t = curTime();
    const a = shown().find((l) => t >= l.start && t < l.end);
    const k = a ? a._k : null;
    if (k === activeK) return;
    activeK = k;
    for (const r of rowRefs.values()) r.el.classList.toggle('now', r.k === k);
    for (const r of timeRefs.values()) r.el.classList.toggle('now', r.k === k);
  }
  function fitStage() {
    const { W, H } = out();
    const cw = stage.clientWidth - 16;
    const ch = stage.clientHeight - 12;
    if (cw <= 0 || ch <= 0) return;
    const f = Core.fitRect(cw, ch, W, H);
    vbox.style.width = `${Math.floor(f.w)}px`;
    vbox.style.height = `${Math.floor(f.h)}px`;
  }

  // ───── 조절줄 (영상 아래: 자막을 가리지 않는다) ─────
  const playBtn = h('button', { type: 'button', class: 'ss-play', 'aria-label': '재생 / 멈춤', onclick: () => { vibrate(); togglePlay(); } }, '▶');
  const barFill = h('i', { class: 'ss-bar-fill' });
  const barThumb = h('b', { class: 'ss-bar-thumb' });
  const bar = h('div', { class: 'ss-bar', role: 'slider', tabindex: '0', 'aria-label': '재생 위치' }, h('span', { class: 'ss-bar-track' }, barFill), barThumb);
  const clockEl = h('div', { class: 'ss-clock' }, '0:00');
  const guideBtn = h('button', { type: 'button', class: 'ss-guide', 'aria-pressed': 'false', onclick: () => { vibrate(); setGuide(!showGuide); } }, '📐 안전 영역');
  const ctl = h('div', { class: 'ss-ctl' }, playBtn, bar, clockEl, guideBtn);
  let scrub = false;
  const posToT = (e) => { const r = bar.getBoundingClientRect(); return clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1) * duration(); };
  bar.addEventListener('pointerdown', (e) => { scrub = true; try { bar.setPointerCapture(e.pointerId); } catch (_) { /* 무시 */ } seekTo(posToT(e)); });
  bar.addEventListener('pointermove', (e) => { if (scrub) seekTo(posToT(e)); });
  const endScrub = () => { scrub = false; };
  bar.addEventListener('pointerup', endScrub);
  bar.addEventListener('pointercancel', endScrub);
  bar.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') seekTo(curTime() - 3); else if (e.key === 'ArrowRight') seekTo(curTime() + 3); });
  function setGuide(on) {
    showGuide = !!on;
    guideBtn.setAttribute('aria-pressed', String(showGuide));
    scheduleDraw();
  }
  function updateControls() {
    if (destroyed) return;
    const t = curTime();
    const d = duration();
    playBtn.textContent = playing() ? '⏸' : '▶';
    playBtn.disabled = !media() || phase === 'applying';
    const pct = d ? clamp(t / d, 0, 1) * 100 : 0;
    barFill.style.width = `${pct}%`;
    barThumb.style.left = `${pct}%`;
    bar.setAttribute('aria-valuenow', String(Math.round(pct)));
    clockEl.textContent = `${fmtClock(t)} / ${fmtClock(d)}`;
  }

  // ───── 위쪽 줄 · 알림 · 되돌리기 ─────
  const dirtyDot = h('span', { class: 'ss-dirty', hidden: true }, '● 바뀐 곳이 있어요');
  const undoBtn = h('button', { type: 'button', class: 'ss-undo', 'aria-label': '방금 한 것 되돌리기', onclick: () => { vibrate(); undo(); } }, '↩');
  const backBtn = h('button', { type: 'button', class: 'ss-back', 'aria-label': '나가기', onclick: () => { vibrate(); onBack(); } }, '←');
  const top = h('header', { class: 'ss-top' }, backBtn, h('div', { class: 'ss-title' }, '💬 가사 자막 고치기'), dirtyDot, undoBtn);
  const noticeEl = h('div', { class: 'ss-notice', role: 'alert', hidden: true });
  function notice(msg, kind = 'warn') {
    clear(noticeEl);
    if (!msg) { noticeEl.hidden = true; return; }
    noticeEl.hidden = false;
    noticeEl.className = `ss-notice ${kind}`;
    noticeEl.append(h('span', { class: 'grow' }, msg), h('button', { type: 'button', class: 'btn small', onclick: () => notice('') }, '닫기'));
  }

  async function confirmLeave() {
    if (phase !== 'idle') return false;
    if (!isDirty()) return true;
    const r = await bottomSheet({
      title: '저장하지 않은 변경이 있어요',
      body: h('p', { class: 'pre' }, '나갈까요?\n나가면 고친 것이 사라져요.'),
      buttons: [{ label: '나가기', kind: 'danger', value: true }, { label: '계속 고치기', kind: 'primary', value: false }],
      sticky: true, closeLabel: null,
    }).result;
    return r === true;
  }
  async function onBack() {
    if (await confirmLeave()) { if (ctx.onClose) ctx.onClose({ cancelled: true }); }
  }

  // ───── 아래 시트: 탭 ─────
  const grab = h('button', { type: 'button', class: 'ss-grab', 'aria-label': '시트 크게 / 작게', onclick: () => { vibrate(); setDock(dockState === 'half' ? 'full' : 'half'); } }, h('i'));
  const foldBtn = h('button', { type: 'button', class: 'ss-fold', onclick: () => { vibrate(); setDock(dockState === 'peek' ? 'half' : 'peek'); } }, '접기 ⌄');
  const TABS = [['look', '🎨 모양'], ['text', '✏️ 글자'], ['time', '⏱ 시간']];
  const tabBtns = TABS.map(([k, label]) => h('button', { type: 'button', class: 'ss-tab', role: 'tab', 'data-t': k, onclick: () => { vibrate(); setTab(k); if (dockState === 'peek') setDock('half'); } }, label));
  const tabs = h('div', { class: 'ss-tabs', role: 'tablist' }, tabBtns, foldBtn);
  const paneLook = h('div', { class: 'ss-pane', 'data-t': 'look' });
  const paneText = h('div', { class: 'ss-pane', 'data-t': 'text', hidden: true });
  const paneTime = h('div', { class: 'ss-pane', 'data-t': 'time', hidden: true });
  const body = h('div', { class: 'ss-body' }, paneLook, paneText, paneTime);
  const hintEl = h('div', { class: 'ss-hint' });
  const saveBtn = h('button', { type: 'button', class: 'btn primary ss-save', onclick: () => { vibrate(); doSave(); } });
  const foot = h('div', { class: 'ss-foot' }, hintEl, saveBtn);
  const dock = h('section', { class: 'ss-dock half' }, grab, tabs, body, foot);
  const root = h('div', { class: 'ss', role: 'dialog', 'aria-label': '가사 자막 고치기' }, top, stage, ctl, noticeEl, dock);
  host.appendChild(root);
  document.documentElement.classList.add('ss-open');

  function setTab(t) {
    tab = t;
    tabBtns.forEach((b) => { const on = b.dataset.t === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
    paneLook.hidden = t !== 'look';
    paneText.hidden = t !== 'text';
    paneTime.hidden = t !== 'time';
    body.scrollTop = 0;
    if (t === 'text') for (const r of rowRefs.values()) autoGrow(r.ta);
    if (t === 'look') paintThumbsSoon();
  }
  function setDock(s) {
    dockState = s;
    dock.className = `ss-dock ${s}`;
    foldBtn.textContent = s === 'peek' ? '펼치기 ⌃' : '접기 ⌄';
    requestAnimationFrame(fitStage);
  }
  function layout() {
    const vv = window.visualViewport;
    const vh = Math.round((vv && vv.height) || window.innerHeight || 800);
    root.style.setProperty('--vvh', `${vh}px`);
    root.style.setProperty('--dock-half', `${Math.round(vh * 0.54)}px`);
    root.style.setProperty('--dock-full', `${Math.max(260, vh - 56 - 64 - 170)}px`);
    fitStage();
  }

  // ───── 🎨 모양 ─────
  function seg(items, get, pick, cls = '') {
    const els = items.map((it) => h('button', { type: 'button', class: `ss-opt ${it.cls || ''}`, 'data-v': it.id, onclick: () => { vibrate(); pick(it.id); } }, it.label));
    return { el: h('div', { class: `ss-seg ${cls}`, role: 'group' }, els), sync: () => els.forEach((b, i) => b.setAttribute('aria-pressed', String(items[i].id === get()))) };
  }
  const syncs = [];
  const sec = (title, ...kids) => h('div', { class: 'ss-sec' }, h('div', { class: 'ss-sec-h' }, title), ...kids);
  const cur = () => styleN();
  function setStyle(patch, key) {
    pushUndo(key || `style:${Object.keys(patch).join(',')}`);
    style = S.mergeStyle(style, patch, sctx());
    afterStyle();
  }
  function applyPreset(pid) {
    pushUndo(`preset:${pid}`);
    style = S.applyPreset(style, pid, sctx());
    afterStyle();
  }
  let fontLoadToken = 0;
  async function loadFonts(ids) {
    const token = ++fontLoadToken;
    try { await Promise.all(ids.map((f) => (S.FONT_BY_ID[f] && S.FONT_BY_ID[f].family ? document.fonts.load(S.fontCss(f, 40), FONT_SAMPLE) : null))); } catch (_) { /* 시스템 글꼴로 */ }
    if (token === fontLoadToken && !destroyed) { R.clearLayoutCache(); scheduleDraw(); paintThumbsSoon(); }
  }
  function afterStyle(skipFont) {
    syncs.forEach((f) => f());
    if (!skipFont) loadFonts([styleN().font]);
    scheduleDraw();
    refreshHeader();
    if (tab === 'text') refreshWarnings();
    paintThumbsSoon(true);
  }

  // 꾸밈 모음 (7개): 이 영상의 한 장면 + 이 노래 첫 줄을 진짜 그리개로 그린 작은 그림
  const thumbW = () => (isTall() ? 72 : 96);
  const thumbH = () => Math.round((thumbW() * out().H) / out().W);
  const presetTiles = S.PRESETS.map((p) => {
    const cv = h('canvas', { class: 'ss-pthumb', 'aria-hidden': 'true' });
    const tile = h('button', { type: 'button', class: 'ss-ptile', 'data-p': p.id, onclick: () => { vibrate(); applyPreset(p.id); } }, cv, h('span', { class: 'ss-pname' }, `${p.emoji} ${p.label}`));
    return { p, cv, tile };
  });
  /** 썸네일에 쓸 글: 이 노래 첫 줄의 앞부분 (짧아야 작은 칸에서도 글꼴이 알아보인다) */
  const sampleText = () => {
    const f = shown()[0];
    const words = (f ? f.text : SAMPLE).trim().split(/\s+/);
    let out2 = words[0] || SAMPLE;
    for (let i = 1; i < words.length && Array.from(`${out2} ${words[i]}`).length <= 9; i++) out2 += ` ${words[i]}`;
    return out2;
  };
  function paintThumbsSoon(posOnly) {
    if (thumbQ || destroyed) return;
    thumbQ = setTimeout(() => { thumbQ = 0; paintThumbs(); }, posOnly ? 120 : 30);
  }
  let thumbFont = false;
  async function paintThumbs() {
    if (destroyed || (paneLook.hidden && thumbFont)) return;
    if (!baseFrame) return;
    if (!thumbFont) { thumbFont = true; await loadFonts(S.PRESETS.map((p) => p.style.font)); if (destroyed) return; }
    const { W, H } = out();
    const tw = thumbW(); const th = thumbH();
    const text = sampleText();
    const sub = document.createElement('canvas'); // 자막만 그린 투명 그림 (drawFrame 은 그릴 때마다 판을 지운다)
    sub.width = W; sub.height = H;
    const g = sub.getContext('2d');
    // 자를 자리: 보통 크기 · 기본 모양 자막 상자를 가운데로, 글자 11개 너비 (칸마다 같은 배율이라 크기 차이도 보인다)
    const refSt = S.applyPreset({ ...style, enabled: true, size: 'm', sizeScale: 1 }, 'basic', sctx());
    const drawn = R.drawFrame(g, [{ text, start: 0, end: 5 }], 2.5, refSt, W, H);
    const rb = drawn[0] ? drawn[0].box : { x: W / 2 - 100, y: H * 0.85, w: 200, h: 40 };
    let cw = Math.min(W, S.sizeFor(refSt, W, H) * 11);
    let ch = (cw * th) / tw;
    if (ch > H) { ch = H; cw = (ch * tw) / th; }
    const cx = clamp(rb.x + rb.w / 2 - cw / 2, 0, W - cw);
    const cy = clamp(rb.y + rb.h / 2 - ch / 2, 0, H - ch);
    for (const { p, cv } of presetTiles) {
      cv.width = tw * 2; cv.height = th * 2;
      cv.style.width = `${tw}px`; cv.style.height = `${th}px`;
      R.drawFrame(g, [{ text, start: 0, end: 5 }], 2.5, S.applyPreset({ ...style, enabled: true }, p.id, sctx()), W, H);
      const c2 = cv.getContext('2d');
      c2.drawImage(baseFrame, cx, cy, cw, ch, 0, 0, cv.width, cv.height);
      c2.drawImage(sub, cx, cy, cw, ch, 0, 0, cv.width, cv.height);
    }
  }
  /** 그림이 그려지기 전에도 칸 크기가 정해져 있게 (그려진 뒤 칸이 커지며 화면이 튀지 않게) */
  function sizeThumbs() {
    const tw = thumbW(); const th = thumbH();
    for (const { cv } of presetTiles) { cv.style.width = `${tw}px`; cv.style.height = `${th}px`; }
  }
  sizeThumbs();
  const presetRow = h('div', { class: 'ss-presets', role: 'listbox', 'aria-label': '자막 꾸밈 모음' }, presetTiles.map((t) => t.tile));
  syncs.push(() => { const cp = cur().preset; presetTiles.forEach(({ p, tile }) => tile.setAttribute('aria-pressed', String(p.id === cp))); });

  const enableBtn = h('button', { type: 'button', class: 'ss-switch', role: 'switch', onclick: () => { vibrate(); setStyle({ enabled: !cur().enabled }, 'enabled'); } },
    h('span', { class: 'ss-sw-label' }, '자막 보이기'), h('span', { class: 'ss-sw-knob' }));
  syncs.push(() => { const on = cur().enabled; enableBtn.setAttribute('aria-checked', String(on)); enableBtn.classList.toggle('on', on); });

  const sizeSeg = seg(S.SIZES.map((s) => ({ id: s.id, label: s.label })), () => cur().size, (v) => setStyle({ size: v, sizeScale: 1 }), 'cols4');
  const posSeg = seg(S.POSITIONS.map((s) => ({ id: s.id, label: s.label })), () => cur().position, (v) => setStyle({ position: v, marginPct: null }), 'cols3');
  const outSeg = seg(S.OUTLINES.map((s) => ({ id: s.id, label: s.label })), () => cur().outline, (v) => setStyle({ outline: v }), 'cols4');
  const boxSeg = seg(S.BOXES.map((s) => ({ id: s.id, label: s.label })), () => cur().box, (v) => setStyle({ box: v }), 'cols3');
  [sizeSeg, posSeg, outSeg, boxSeg].forEach((s) => syncs.push(s.sync));
  const swatches = S.COLOR_SWATCHES.map((c) => h('button', {
    type: 'button', class: 'ss-sw', style: { background: c }, 'data-c': c, 'aria-label': `글자 색 ${c}`,
    onclick: () => { vibrate(); setStyle({ color: c, outlineColor: Core.autoOutline(c) }); },
  }));
  syncs.push(() => { const c = cur().color; swatches.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.c === c))); });
  const fontTiles = S.FONTS.map((f) => h('button', {
    type: 'button', class: 'ss-ftile', 'data-f': f.id, style: { fontFamily: f.stack, fontWeight: String(f.weight) }, onclick: () => { vibrate(); setStyle({ font: f.id }); },
  }, h('span', { class: 'ss-fsample' }, '가나다 ABC'), h('span', { class: 'ss-fname' }, f.label)));
  syncs.push(() => { const f = cur().font; fontTiles.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === f))); });

  // 고급: 숫자는 막대 대신 [−][+] 단추 (끌어서 고치지 않는다)
  function stepper(label, get, set, fmt) {
    const val = h('span', { class: 'ss-step-val' });
    const dec = h('button', { type: 'button', class: 'ss-step', 'aria-label': `${label} 줄이기`, onclick: () => { vibrate(); set(-1); } }, '−');
    const inc = h('button', { type: 'button', class: 'ss-step', 'aria-label': `${label} 늘리기`, onclick: () => { vibrate(); set(1); } }, '＋');
    syncs.push(() => { val.textContent = fmt(get()); });
    return h('div', { class: 'ss-stepper' }, h('span', { class: 'ss-step-l' }, label), dec, val, inc);
  }
  const scaleStep = stepper('크기 배율', () => cur().sizeScale, (d) => setStyle({ sizeScale: Core.round2(clamp(cur().sizeScale + d * 0.1, 0.6, 2)) }, 'scale'), (v) => `×${v.toFixed(1)}`);
  const marginStep = stepper('가장자리 여백', () => cur().marginPct, (d) => {
    const { H } = out();
    const rect = S.safeRect(styleN(), out().W, H);
    const m = cur().marginPct == null ? Math.round(((cur().position === 'top' ? rect.margin.top : rect.margin.bottom) / H) * 100) : cur().marginPct;
    setStyle({ marginPct: Math.round(clamp(m + d, 0, 40)) }, 'margin');
  }, (v) => (v == null ? '자동' : `${v}%`));
  const fadeStep = stepper('나타나는 시간', () => cur().fade, (d) => setStyle({ fade: Core.round2(clamp(cur().fade + d * 0.05, 0, 1)) }, 'fade'), (v) => `${v.toFixed(2)}초`);
  const marginAuto = h('button', { type: 'button', class: 'btn small', onclick: () => { vibrate(); setStyle({ marginPct: null }); } }, '여백 자동으로');
  const resetBtn = h('button', { type: 'button', class: 'btn ss-reset', onclick: () => { vibrate(); resetLook(); } }, '↺ 처음 모양으로');
  function resetLook() {
    pushUndo('reset');
    style = { ...(base ? base.style : S.normalizeStyle({}, sctx())) };
    afterStyle();
    say('처음 모양으로 되돌렸어요', 'ok', QUIET);
  }
  const seriesCheck = h('label', { class: 'ss-check', hidden: true },
    h('input', { type: 'checkbox', onchange: (e) => { pushUndo('series'); applyToSeries = e.target.checked; refreshHeader(); } }),
    h('span', null, '이 모양을 이 이야기 모음 전체에 쓰기'));
  paneLook.append(
    enableBtn,
    sec('🎨 꾸밈 모음', presetRow),
    sec('✨ 더 꾸미기'),
    sec('크기', sizeSeg.el), sec('위치', posSeg.el), sec('글자 색', h('div', { class: 'ss-swatches' }, swatches)),
    sec('테두리', outSeg.el), sec('글자 바탕', boxSeg.el), sec('글꼴', h('div', { class: 'ss-fonts' }, fontTiles)),
    h('div', { class: 'ss-sec' }, resetBtn, seriesCheck),
    h('details', { class: 'fold ss-adv' }, h('summary', null, '고급'), scaleStep, marginStep, h('div', { class: 'ss-adv-row' }, marginAuto), fadeStep));

  // ───── ✏️ 글자 ─────
  const rowRefs = new Map();
  const timeRefs = new Map();
  const rowsText = h('div', { class: 'ss-rows' });
  const rowsTime = h('div', { class: 'ss-rows' });
  const addBtn = h('button', { type: 'button', class: 'btn ss-add', onclick: () => { vibrate(); doAdd(); } }, '＋ 줄 추가');
  const emptyBox = () => {
    const ta = h('textarea', { class: 'ss-paste', rows: '7', placeholder: '가사를 붙여 넣어 주세요 (한 줄에 한 문장)', 'aria-label': '가사', hidden: true });
    const go = h('button', { type: 'button', class: 'btn primary big', hidden: true, onclick: async () => {
      const raw = ta.value.trim();
      if (!raw) { say('가사를 먼저 붙여 넣어 주세요', 'err'); return; }
      go.disabled = true;
      try {
        await engine.edits.updateLyricsText(id, raw, '');
        snap = (await engine.projects.get(id)) || snap;
        initWork();
        buildAll();
        say('✅ 가사를 넣었어요. 이제 자막을 고칠 수 있어요');
      } catch (e) { notice(friendly(e), 'err'); }
      go.disabled = false;
    } }, '이 가사로 시작하기');
    const open = h('button', { type: 'button', class: 'btn primary big', onclick: () => { ta.hidden = false; go.hidden = false; open.hidden = true; ta.focus(); } }, '📝 가사 붙여넣기');
    return h('div', { class: 'ss-empty' }, h('div', { class: 'ss-empty-ico', 'aria-hidden': 'true' }, '💬'), h('h3', null, '가사를 넣으면 여기서 자막을 꾸밀 수 있어요'),
      h('p', { class: 'small muted' }, '노래에 맞는 가사를 붙여 넣으면, 영상 위에 자막이 어떻게 보일지 바로 보면서 고를 수 있어요. 🎨 모양 탭은 지금도 써 볼 수 있어요.'), open, ta, go);
  };
  function autoGrow(ta) {
    if (!ta.offsetParent) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight + 2, 200)}px`;
  }
  const warnsOf = (l) => {
    const st = styleN();
    const lay = l.text.trim() ? R.getLayout(ov.getContext('2d'), l.text, st, out().W, out().H) : null;
    return Core.lineWarnings(l, lay);
  };
  function refreshWarnings() {
    for (const r of rowRefs.values()) {
      const l = findLine(r.k);
      if (!l) continue;
      const w = warnsOf(l);
      r.warn.hidden = !w.length;
      r.warn.textContent = w.length ? `⚠ ${w.join(' · ')}` : '';
    }
  }
  function selectRow(k, seek) {
    sel = k;
    for (const r of rowRefs.values()) r.el.classList.toggle('sel', r.k === k);
    for (const r of timeRefs.values()) r.el.classList.toggle('sel', r.k === k);
    if (seek) showLine(findLine(k), false);
  }
  function rowMenu(l, caret) {
    const i = indexOf(l._k);
    let sh;
    const item = (label, fn, cls = '') => h('button', { type: 'button', class: `btn ss-menu-btn ${cls}`, onclick: () => { vibrate(); sh.close(); fn(); } }, label);
    sh = bottomSheet({
      title: `${i + 1}번째 줄`,
      body: h('div', { class: 'ss-menu' },
        h('p', { class: 'small muted ss-menu-text' }, l.text || '(빈 줄)'),
        item('✂ 나누기 (글자 커서에서 둘로)', () => doSplit(l, caret)),
        item('⤵ 아래 줄과 합치기', () => doMerge(l)),
        item(l.hidden ? '👀 다시 보이기' : '🙈 숨기기 (영상에 안 나와요)', () => doHide(l)),
        item('🗑 지우기', () => doDelete(l), 'danger')),
    });
  }
  function buildTextRow(l, i) {
    const n = h('span', { class: 'ss-n' }, String(i + 1));
    const tchip = h('button', { type: 'button', class: 'ss-tchip', 'aria-label': '이 줄로 가기', onclick: () => { selectRow(l._k, false); showLine(l, true); } }, fmtTenth(l.start));
    const badge = h('span', { class: `ss-badge ${l._tapped ? 'ok' : ''}` }, l._tapped ? '맞춤' : '예상');
    const hid = h('span', { class: 'ss-hidden-badge' }, '숨김');
    const listen = h('button', { type: 'button', class: 'ss-ico', 'aria-label': '여기서 듣기', onclick: () => { vibrate(); selectRow(l._k, false); seekTo(l.start); play(l.end + 0.2); } }, '▶');
    let caret = 0;
    const more = h('button', { type: 'button', class: 'ss-ico', 'aria-label': '더 보기', onclick: () => { vibrate(); rowMenu(l, caret); } }, '⋯');
    const ta = h('textarea', { class: 'ss-ta', rows: '1', enterkeyhint: 'done', placeholder: '가사를 적어 주세요', 'aria-label': `${i + 1}번째 줄 가사` });
    ta.value = l.text;
    const warn = h('div', { class: 'ss-warn', hidden: true });
    const el = h('div', { class: `ss-row${l.hidden ? ' hid' : ''}`, 'data-k': l._k }, h('div', { class: 'ss-row-head' }, n, tchip, badge, hid, h('span', { class: 'grow' }), listen, more), ta, warn);
    ta.addEventListener('input', () => {
      pushUndo(`text:${l._k}`);
      l.text = ta.value;
      autoGrow(ta);
      const w = warnsOf(l);
      warn.hidden = !w.length;
      warn.textContent = w.length ? `⚠ ${w.join(' · ')}` : '';
      const tr = timeRefs.get(l._k);
      if (tr) tr.txt.textContent = l.text || '(빈 줄)';
      scheduleDraw();
      refreshHeader();
    });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.blur(); } });
    const saveCaret = () => { caret = ta.selectionStart; };
    ['keyup', 'click', 'select', 'blur'].forEach((ev) => ta.addEventListener(ev, saveCaret));
    ta.addEventListener('focus', () => {
      selectRow(l._k, true);
      setTimeout(() => { if (!destroyed) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 320);
    });
    el.addEventListener('click', (e) => { if (e.target === el || e.target === el.firstChild) selectRow(l._k, true); });
    rowRefs.set(l._k, { k: l._k, el, ta, tchip, badge, warn, n });
    return el;
  }
  function buildTimeRow(l, i) {
    const n = h('span', { class: 'ss-n' }, String(i + 1));
    const txt = h('span', { class: 'ss-ttext' }, l.text || '(빈 줄)');
    const head = h('button', { type: 'button', class: 'ss-thead', onclick: () => { selectRow(l._k, false); showLine(l, true); } }, n, txt, h('span', { class: 'grow' }));
    const startV = h('span', { class: 'ss-tval' });
    const endV = h('span', { class: 'ss-tval' });
    const nudge = (d) => { vibrate(); pushUndo(`ns:${l._k}`); const i2 = indexOf(l._k); Core.setStart(lines, i2, l.start + d, duration()); afterTime(l, true); };
    const nudgeE = (d) => {
      vibrate(); pushUndo(`ne:${l._k}`);
      const moved = Core.nudgeEnd(lines, indexOf(l._k), d, duration());
      if (Math.abs(moved) < 0.005) { hist.pop(); say(d > 0 ? '다음 줄이 곧 시작해서 더 늘릴 수 없어요' : '더 줄일 수 없어요', 'warn'); return; }
      afterTime(l, false);
    };
    const b = (label, fn, cls = '') => h('button', { type: 'button', class: `ss-tbtn ${cls}`, onclick: fn }, label);
    const el = h('div', { class: `ss-trow${l.hidden ? ' hid' : ''}`, 'data-k': l._k },
      head,
      h('div', { class: 'ss-trow-line' }, h('span', { class: 'ss-tl' }, '시작'), startV, b('− 0.1초', () => nudge(-NUDGE)), b('＋ 0.1초', () => nudge(NUDGE))),
      h('div', { class: 'ss-trow-line' }, h('span', { class: 'ss-tl' }, '끝'), endV, b('끝 −', () => nudgeE(-NUDGE)), b('끝 ＋', () => nudgeE(NUDGE))),
      b('🎯 지금 여기가 시작', () => {
        vibrate(); pushUndo(`here:${l._k}`);
        Core.setStart(lines, indexOf(l._k), curTime(), duration());
        afterTime(l, false);
      }, 'here'));
    timeRefs.set(l._k, { k: l._k, el, txt, startV, endV });
    paintTimeRow(l);
    return el;
  }
  function paintTimeRow(l) {
    const t = timeRefs.get(l._k);
    if (t) { t.startV.textContent = fmtTenth(l.start); t.endV.textContent = `${fmtTenth(l.end)}${l.endLocked ? ' 🔒' : ''}`; }
    const r = rowRefs.get(l._k);
    if (r) { r.tchip.textContent = fmtTenth(l.start); r.badge.textContent = l._tapped ? '맞춤' : '예상'; r.badge.classList.toggle('ok', !!l._tapped); }
  }
  /** 시간을 고친 뒤: 숫자만 제자리에서 고치고 (줄 목록을 다시 만들지 않는다), 그 줄이 보이는 순간으로 간다 */
  function afterTime(l, seek) {
    for (const x of lines) paintTimeRow(x);
    if (seek) showLine(l, true); else scheduleDraw();
    if (tab === 'text') refreshWarnings();
    refreshHeader();
  }
  function renderRows() {
    rowRefs.clear(); timeRefs.clear();
    clear(rowsText); clear(rowsTime);
    lines.forEach((l, i) => { rowsText.appendChild(buildTextRow(l, i)); rowsTime.appendChild(buildTimeRow(l, i)); });
    if (sel) selectRow(sel, false);
    if (tab === 'text') for (const r of rowRefs.values()) autoGrow(r.ta);
    refreshWarnings();
    markActiveSoon();
  }
  const markActiveSoon = () => { activeK = null; markActive(); };
  function afterRestructure(focusK) {
    renderRows();
    scheduleDraw();
    refreshHeader();
    updateControls();
    if (focusK) { const r = rowRefs.get(focusK); if (r) { selectRow(focusK, true); r.el.scrollIntoView({ block: 'center' }); if (!r.ta.value) r.ta.focus(); } }
  }
  function doSplit(l, caret) {
    pushUndo();
    const b = Core.splitLine(lines, indexOf(l._k), caret, duration());
    if (!b) { hist.pop(); say('이 줄은 나눌 수 없어요. 글자 가운데를 눌러 커서를 놓고 다시 해 보세요', 'warn'); return; }
    afterRestructure(b._k);
    say('✂ 둘로 나눴어요', 'ok', QUIET);
  }
  function doMerge(l) {
    const i = indexOf(l._k);
    if (i < 0 || i >= lines.length - 1) { say('아래에 합칠 줄이 없어요', 'warn'); return; }
    pushUndo();
    const a = Core.mergeNext(lines, i, duration());
    afterRestructure(a ? a._k : null);
    say('⤵ 아래 줄과 합쳤어요', 'ok', QUIET);
  }
  function doHide(l) {
    pushUndo();
    l.hidden = !l.hidden;
    afterRestructure();
    say(l.hidden ? '🙈 숨겼어요. 영상에는 안 나와요' : '👀 다시 보이게 했어요', 'ok', QUIET);
  }
  function doDelete(l) {
    pushUndo();
    lines.splice(indexOf(l._k), 1);
    if (sel === l._k) sel = null;
    afterRestructure();
    say('🗑 지웠어요 · 위의 ↩ 로 되돌릴 수 있어요', 'ok', QUIET);
  }
  function doAdd() {
    pushUndo();
    const l = Core.addLine(lines, sel ? indexOf(sel) : -1, curTime(), duration());
    afterRestructure(l._k);
  }
  paneText.append(h('div', { class: 'ss-tools' }, addBtn), rowsText);

  // ───── ⏱ 시간 ─────
  const tapBtn = h('button', { type: 'button', class: 'btn primary big ss-tapbtn', onclick: () => { vibrate(); openTap(); } }, '🎤 처음부터 탭으로 맞추기');
  const shiftAllBtn = (label, d) => h('button', { type: 'button', class: 'btn ss-shift', onclick: () => {
    vibrate(); pushUndo();
    const k = Core.shiftAll(lines, d, duration());
    for (const x of lines) paintTimeRow(x);
    scheduleDraw(); refreshHeader();
    say(k ? `${d < 0 ? '⏪' : '⏩'} 모두 ${Math.abs(d)}초 ${d < 0 ? '당겼어요' : '미뤘어요'}` : '더 옮길 수 없어요', k ? 'ok' : 'warn', QUIET);
  } }, label);
  paneTime.append(tapBtn,
    h('div', { class: 'ss-shiftrow' }, shiftAllBtn('⏪ 모두 0.1초 당기기', -NUDGE), shiftAllBtn('⏩ 모두 0.1초 미루기', NUDGE)),
    h('p', { class: 'small muted' }, '자막이 늦으면 당기고, 빠르면 미뤄요. 줄 이름을 누르면 영상이 그 줄로 가요. 영상을 알맞은 곳에 세우고 [🎯 지금 여기가 시작] 을 눌러도 돼요.'),
    rowsTime);

  async function openTap() {
    const vis = shown();
    if (!vis.length) { say('먼저 가사 줄을 하나 이상 만들어 주세요', 'err'); return; }
    pause();
    let clean = null;
    let song = null;
    try {
      clean = hasClean() ? await engine.render.output(id, 'clean') : null;
      song = clean ? null : await db.getFile(BK.song(id));
    } catch (_) { /* 소리 없이 */ }
    const { W, H } = out();
    const res = await openTapSync(ctx, {
      lines: vis.map((l) => ({ text: l.text, start: l.start, end: l.end, part: 1, section: l.section, sectionStart: l.sectionStart })),
      duration: duration() || 1, videoBlob: clean, songBlob: song, confirmed: false,
      style: () => ({ style: { ...style }, W, H }), title: '🎤 처음부터 탭으로 맞추기', saveLabel: '💾 이대로 쓰기',
    });
    if (!res || destroyed) return;
    pushUndo();
    Core.mergeTap(lines, vis, res.lines, res.flags, duration());
    afterRestructure();
    say(res.left ? `✅ 시간을 바꿨어요 · ${res.left}줄은 아직 자동 시간이에요` : '✅ 시간을 모두 맞췄어요');
  }

  // ───── 저장하고 영상에 입히기 ─────
  function storeReason() {
    if (!hasClean()) return '영상이 만들어지면 자막이 입혀져요';
    if (snap.running) return '지금은 영상을 만드는 중이라 저장만 해요';
    if (snap.status === 'waiting') return 'AI 앱에 부탁한 그림을 받은 뒤에 영상에 입혀져요 · 지금은 저장만 해요';
    return '';
  }
  function refreshHeader() {
    if (destroyed) return;
    const idle = phase === 'idle';
    const d = isDirty();
    const store = !!storeReason();
    const subsPending = !!((snap.changes && snap.changes.subs) || snap.subsStale);
    dirtyDot.hidden = !(idle && d);
    undoBtn.disabled = !hist.length;
    const eta = etaText(estimateApplySec(snap, { subs: true, render: !!(snap.changes && snap.changes.render) }));
    let label; let off = false; let why = '';
    if (phase === 'saving') { label = '💾 저장하는 중이에요…'; off = true; } else if (phase === 'applying') { label = '✨ 자막을 입히는 중이에요…'; off = true; } else if (emptyMode) { label = '💾 저장하고 영상에 입히기'; off = true; why = '가사를 넣으면 저장할 수 있어요'; } else if (snap.running && snap.currentStep === 'subtitles') { label = '💾 저장하기'; off = true; why = '지금 자막을 영상에 입히는 중이에요'; } else if (d) label = store ? '💾 저장하기' : `💾 저장하고 영상에 입히기 (${eta})`;
    else if (!store && subsPending) label = `✨ 영상에 입히기 (${eta})`;
    else { label = store ? '💾 저장하기' : `💾 저장하고 영상에 입히기 (${eta})`; off = true; why = '바꾼 것이 없어요'; }
    saveBtn.textContent = label;
    saveBtn.disabled = off;
    hintEl.textContent = off ? why : (store ? storeReason() : '');
    hintEl.hidden = !hintEl.textContent;
  }
  function adoptSaved(res) {
    const saved = Core.recompute(((res && res.lines) || []).map((l) => Core.mkLine(l, true)), duration());
    const mine = Core.realLines(lines);
    if (mine.length === saved.length) saved.forEach((l, i) => { l._k = mine[i]._k; l._tapped = mine[i]._tapped; });
    const st = S.normalizeStyle(res && res.style ? res.style : style, sctx());
    base = { lineSig: Core.sigLines(saved), styleSig: Core.sigStyle(st), style: { ...st } };
    lines = cloneLines(saved);
    style = { ...st };
    applyToSeries = false;
    afterRestructure();
    afterStyle(true);
  }
  async function doSave() {
    if (phase !== 'idle' || destroyed) return;
    notice('');
    const d = isDirty();
    const store = !!storeReason();
    phase = 'saving';
    refreshHeader();
    try {
      if (d) {
        const payload = { applyToSeries: applyToSeries && hasSeries() };
        if (dirtyStyle()) payload.style = { ...style };
        if (dirtyLines()) payload.lines = Core.realLines(lines).map(Core.toSaveLine);
        const res = await engine.edits.saveSubtitles(id, payload);
        adoptSaved(res);
        if (res && res.lost > 0) say(`맞춰 둔 시간 ${res.lost}줄이 달라졌어요`, 'warn', 4500);
      }
      if (store) {
        phase = 'idle';
        refreshHeader();
        say(hasClean() ? '💾 저장했어요. 만들기가 끝나면 ✨ 고친 것 반영하기로 영상에 입혀요' : '💾 저장했어요. 영상이 만들어지면 자막이 입혀져요');
        if (ctx.onClose) ctx.onClose({ saved: true });
        return;
      }
      pause();
      phase = 'applying';
      refreshHeader();
      updateControls();
      const r = await runApply(ctx, { okMsg: '✅ 자막을 입혔어요' });
      if (destroyed) return; // 그 사이 화면이 닫혔다: 결과는 엔진에 저장돼 있고 알림도 갔다
      phase = 'idle';
      if (r.ok) { if (ctx.onClose) ctx.onClose({ applied: true }); return; }
      notice(r.cancelled ? '영상 입히기를 멈췄어요. 저장은 되어 있으니 [✨ 영상에 입히기] 를 누르면 이어서 해요' : `자막을 영상에 입히지 못했어요. 저장은 되어 있어요. ${r.error || ''}`, 'err');
    } catch (e) {
      phase = 'idle';
      notice(friendly(e), 'err');
    }
    if (!destroyed) { refreshHeader(); updateControls(); }
  }

  // ───── 한꺼번에 만들기 · 새 소식 ─────
  function buildAll() {
    renderRows();
    // 가사가 없을 때: 글자 · 시간 탭에 붙여넣기 칸 (모양 탭은 그대로 쓸 수 있다)
    for (const pane of [paneText, paneTime]) pane.querySelectorAll('.ss-empty').forEach((x) => x.remove());
    if (emptyMode) { paneText.prepend(emptyBox()); paneTime.prepend(emptyBox()); }
    addBtn.hidden = emptyMode;
    rowsText.hidden = emptyMode; rowsTime.hidden = emptyMode;
    tapBtn.hidden = emptyMode;
    paneTime.querySelectorAll(':scope > .ss-shiftrow, :scope > p.small').forEach((x) => { x.hidden = emptyMode; });
    seriesCheck.hidden = !hasSeries();
    sizeThumbs();
    syncs.forEach((f) => f());
    scheduleDraw();
    refreshHeader();
    updateControls();
  }
  /** 엔진 소식: 모양 · 줄이 저장된 값과 달라졌고 내가 안 고친 상태면 새로 읽는다. 고치는 중이면 작업 사본을 지키고 영상 · 단추 상태만 새로 한다 */
  function update(next) {
    if (destroyed || !next) return;
    snap = next;
    if (phase === 'idle' && !isDirty()) {
      const fresh = readSnap();
      if (!base || fresh.lineSig !== base.lineSig || fresh.styleSig !== base.styleSig || (!lines.length && fresh.lines.length)) { initWork(); buildAll(); }
    }
    refreshMedia();
    refreshHeader();
  }

  // ───── 시작 ─────
  installFonts();
  initWork();
  setTab('look');
  setDock('half');
  buildAll();
  layout();
  if (!mem.guideSeen && isTall()) { setGuide(true); mem.guideSeen = true; } // 세로 영상은 처음 한 번 안전 영역을 켜 둔다
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fitStage()) : null;
  if (ro) ro.observe(stage);
  const onVV = () => { layout(); const f = document.activeElement; if (f && f.classList && f.classList.contains('ss-ta')) setTimeout(() => f.scrollIntoView({ block: 'center', behavior: 'smooth' }), 120); };
  window.addEventListener('resize', onVV);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', onVV);
  loadFonts([styleN().font]);
  refreshMedia();
  const off = engine.on ? engine.on('update', (s) => { if (s && s.id === id) update(s); }) : null;
  if (!snap.id) engine.projects.get(id).then(update).catch(() => {});

  return {
    update,
    isDirty,
    confirmLeave,
    destroy() {
      destroyed = true;
      if (off) off();
      stopLoop();
      if (drawQ) cancelAnimationFrame(drawQ);
      if (ro) ro.disconnect();
      window.removeEventListener('resize', onVV);
      if (window.visualViewport) window.visualViewport.removeEventListener('resize', onVV);
      try { vEl.pause(); } catch (_) { /* 무시 */ }
      vEl.removeAttribute('src');
      try { vEl.load(); } catch (_) { /* 무시 */ }
      urls.dispose();
      document.documentElement.classList.remove('ss-open');
      root.remove();
    },
  };
}
