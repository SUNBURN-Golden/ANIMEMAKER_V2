'use strict';
/*
 * 가사 시간 맞추기 화면 (PC 앱과 폰 앱이 함께 쓴다)
 *  - 1단계 맞추기: 노래를 들으며 노란 줄이 시작될 때 [지금!] (PC 는 스페이스바)
 *  - 2단계 확인하기: 자막이 실제처럼 나오는 것을 보며 줄마다 −/+ 0.1초, 전체 당기기/미루기
 * 계산 부분은 화면 없이도 쓸 수 있어서 테스트에서 바로 부른다.
 * PC 앱: <script> 로 읽으면 window.AMLyricSync, 폰 앱·테스트: import / require
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AMLyricSync = api;
})(typeof self !== 'undefined' ? self : this, () => {
  const MIN_GAP = 0.3; // 두 줄 시작 사이 최소 간격 (초)
  const REACTION = 0.12; // 버튼을 누르는 데 걸리는 시간만큼 앞당김 (초, 1배속 기준)
  const MAX_LINE = 7; // 자막 한 줄이 가장 오래 떠 있는 시간 (초)
  const TAIL = 0.3; // 마지막 줄은 노래 끝보다 이만큼 앞에서 시작
  const KEEP = ['text', 'part', 'section', 'sectionStart'];

  // ---------- 계산 ----------

  /**
   * @param {{text:string,start:number}[]} lines
   * @param {number} duration 노래 길이 (초)
   * @param {{confirmed?:boolean}} o confirmed: 이미 정확한 시간(직접 맞춤·.lrc·.srt)이면 true
   */
  function create(lines, duration, { confirmed = false } = {}) {
    const s = {
      n: lines.length,
      duration: Number(duration) || 0,
      marks: lines.map((l) => Math.max(0, Number(l.start) || 0)),
      tapped: lines.map(() => !!confirmed),
      idx: confirmed ? lines.length : 0, // 맞추기에서 다음에 누를 줄
      history: [],
    };
    normalize(s);
    return s;
  }

  /** 줄 순서 지키기: 앞 줄보다 MIN_GAP 이상 뒤, 마지막 줄은 노래 끝 전 */
  function normalize(s) {
    const { marks, n } = s;
    for (let i = 0; i < n; i++) {
      const lo = i ? marks[i - 1] + MIN_GAP : 0;
      if (marks[i] < lo) marks[i] = lo;
    }
    if (s.duration > 0) {
      for (let i = n - 1; i >= 0; i--) {
        const hi = i === n - 1 ? s.duration - TAIL : marks[i + 1] - MIN_GAP;
        if (marks[i] > hi) marks[i] = Math.max(0, hi);
      }
    }
  }

  function snapshot(s) {
    s.history.push({ marks: s.marks.slice(), tapped: s.tapped.slice(), idx: s.idx });
    if (s.history.length > 300) s.history.shift();
  }

  /** 방금 한 것 취소 (맞추기·고치기·전체 옮기기 모두) */
  function undo(s) {
    const prev = s.history.pop();
    if (!prev) return false;
    Object.assign(s, prev);
    return true;
  }

  /** 누른 순간의 노래 시간 → 줄 시작 시간 (누르는 데 걸린 시간만큼 앞당김) */
  function tapTime(currentTime, rate = 1) {
    return Math.max(0, currentTime - REACTION * (rate || 1));
  }

  /** 맞추기: 지금 줄(idx)의 시작을 t 로 정하고 다음 줄로. 정해진 줄 번호를 돌려준다 (다 했으면 -1) */
  function tap(s, t) {
    if (s.idx >= s.n) return -1;
    snapshot(s);
    const i = s.idx;
    s.marks[i] = Math.max(t, i ? s.marks[i - 1] + MIN_GAP : 0);
    s.tapped[i] = true;
    s.idx = i + 1;
    normalize(s); // 뒤 줄이 더 앞에 있으면 함께 밀린다
    return i;
  }

  /** 한 줄만 조금 당기기(-)/미루기(+). 앞뒤 줄을 넘지 않는다 */
  function nudge(s, i, d) {
    if (i < 0 || i >= s.n) return 0;
    snapshot(s);
    const lo = i ? s.marks[i - 1] + MIN_GAP : 0;
    const hi = i + 1 < s.n ? s.marks[i + 1] - MIN_GAP : (s.duration > 0 ? s.duration - TAIL : Infinity);
    const before = s.marks[i];
    s.marks[i] = Math.min(hi, Math.max(lo, before + d));
    s.tapped[i] = true;
    return s.marks[i] - before;
  }

  /** 모든 줄을 함께 당기기(-)/미루기(+) */
  function shiftAll(s, d) {
    if (!s.n) return 0;
    snapshot(s);
    const lo = -s.marks[0];
    const hi = s.duration > 0 ? s.duration - TAIL - s.marks[s.n - 1] : Infinity;
    const k = Math.min(hi, Math.max(lo, d));
    for (let i = 0; i < s.n; i++) s.marks[i] += k;
    return k;
  }

  /** i 번째 줄을 다시 맞추려면 어디서부터 들으면 되나 */
  function leadIn(s, i) {
    if (i < 0 || i >= s.n) return 0;
    // 맞춘 줄은 2.5초 전부터, 아직 예상인 줄은 앞 줄 시작부터 (예상이 늦어도 놓치지 않게)
    if (s.tapped[i]) return Math.max(0, s.marks[i] - 2.5);
    return i > 0 ? s.marks[i - 1] : 0;
  }

  /** 줄마다 자막이 사라지는 시간 */
  function ends(s) {
    return s.marks.map((m, i) => Math.min(
      i + 1 < s.n ? s.marks[i + 1] - 0.05 : (s.duration > 0 ? s.duration - 0.1 : m + MAX_LINE),
      m + MAX_LINE,
    ));
  }

  /** t 초에 화면에 떠 있는 줄 (없으면 -1). hold: 줄 사이 아주 짧은 빈틈은 앞 줄로 (미리보기가 깜빡이지 않게) */
  function activeAt(s, t, e = ends(s), hold = 0) {
    let lo = 0;
    let hi = s.n - 1;
    let k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (s.marks[mid] <= t) { k = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return k >= 0 && t < e[k] + hold ? k : -1;
  }

  function untapped(s) {
    return s.tapped.filter((x) => !x).length;
  }

  /** 저장할 줄들 */
  function result(s, lines) {
    const e = ends(s);
    return lines.map((l, i) => {
      const o = {};
      for (const k of KEEP) if (l[k] !== undefined) o[k] = l[k];
      o.start = Math.round(s.marks[i] * 1000) / 1000;
      o.end = Math.round(e[i] * 1000) / 1000;
      return o;
    });
  }

  function fmt(t, digits = 1) {
    const f = 10 ** digits;
    const x = Math.round(Math.max(0, t || 0) * f) / f;
    const m = Math.floor(x / 60);
    const sec = (x - m * 60).toFixed(digits).padStart(digits ? 3 + digits : 2, '0');
    return `${m}:${sec}`;
  }

  // ---------- 실제 영상 + 실제 자막 (video · styleProvider 를 줄 때만 쓴다) ----------

  /** 확인하기에서 자막 그리개(AMSubtitleRender.drawFrame)에 넘길 줄들: 지금 맞춘 시작·끝 시간과 숨김 표시를 합친다 */
  function checkLines(s, lines) {
    const e = ends(s);
    return lines.map((l, i) => ({ text: l.text, start: s.marks[i], end: e[i], hidden: !!l.hidden }));
  }

  /**
   * t 초 화면에 나오는 자막을 ctx 에 그린다 (스튜디오 미리보기와 같은 그리개). 그리개가 없으면 아무것도 하지 않는다.
   * @param {{drawFrame:Function}|null} R AMSubtitleRender (모양 만들기 도구). 폰 앱처럼 없을 수도 있다
   * @returns {object[]} 그린 줄들 (없으면 [])
   */
  function drawCheck(R, ctx, s, lines, t, style, W, H) {
    if (!R || typeof R.drawFrame !== 'function' || !ctx) return [];
    return R.drawFrame(ctx, checkLines(s, lines), t, style, W, H) || [];
  }

  /** 영상 상자 크기 (CSS): 가로는 칸 폭까지, 세로는 화면 높이의 vh % 까지 — 영상 비율을 지킨다 */
  function stageSize(W, H, maxVh = 44, maxPx = 560) {
    const ar = W > 0 && H > 0 ? W / H : 16 / 9;
    return { aspect: `${W > 0 ? W : 16} / ${H > 0 ? H : 9}`, width: `min(100%, ${maxPx}px, ${Math.round(maxVh * ar * 100) / 100}vh)` };
  }

  // ---------- 화면 ----------

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  /** 버튼을 눌러도 포커스를 가져가지 않게 (스페이스바가 버튼을 다시 누르지 않도록) */
  function btn(cls, label, onclick, title) {
    return h('button', { class: `btn ${cls || ''}`, type: 'button', title, onmousedown: (e) => e.preventDefault(), onclick }, label);
  }

  const CSS = `
.ls { display: flex; flex-direction: column; gap: 10px; }
.ls-modes { display: flex; gap: 4px; background: var(--primary-soft, #f1eafe); padding: 4px; border-radius: 999px; }
.ls-modes button { flex: 1; border: 0; background: transparent; padding: 9px 8px; border-radius: 999px; font: inherit; font-weight: 700; color: var(--muted, #6b6780); cursor: pointer; }
.ls-modes button.on { background: var(--panel, #fff); color: var(--primary, #7c3aed); box-shadow: 0 1px 4px rgba(31, 27, 46, .15); }
.ls-modes button.pulse { animation: ls-pulse .8s ease-in-out infinite alternate; }
@keyframes ls-pulse { from { box-shadow: 0 0 0 0 rgba(124, 58, 237, 0); } to { box-shadow: 0 0 0 4px rgba(124, 58, 237, .45); } }
.ls-help { margin: 0; font-size: 14px; line-height: 1.5; }
.ls-player { display: flex; align-items: center; gap: 10px; }
.ls-play { width: 44px; height: 44px; flex: none; border: 0; border-radius: 50%; background: var(--primary, #7c3aed); color: #fff; font-size: 17px; cursor: pointer; }
.ls-time { flex: none; min-width: 84px; font-size: 13px; color: var(--muted, #6b6780); font-variant-numeric: tabular-nums; }
.ls-bar { position: relative; flex: 1; height: 32px; cursor: pointer; touch-action: none; }
.ls-bar::before { content: ''; position: absolute; left: 0; right: 0; top: 14px; height: 4px; border-radius: 2px; background: var(--line, #e7e4f0); }
.ls-fill { position: absolute; left: 0; top: 14px; height: 4px; border-radius: 2px; background: #c4b5fd; }
.ls-tick { position: absolute; top: 10px; width: 4px; height: 12px; margin-left: -2px; border-radius: 2px; background: #c9c4d8; }
.ls-tick.ok { background: var(--primary, #7c3aed); }
.ls-tick.cur { top: 6px; height: 20px; background: #f59e0b; }
.ls-head { position: absolute; top: 3px; bottom: 3px; width: 2px; margin-left: -1px; background: var(--ink, #1f1b2e); }
.ls-rate { flex: none; width: auto; }
.ls-stage { display: flex; flex-direction: column; justify-content: center; gap: 6px; min-height: 150px; padding: 14px; border-radius: var(--radius, 14px); background: #1f1b2e; color: #fff; text-align: center; transition: background .12s; }
.ls-stage.flash { background: #5b21b6; }
.ls-prev { font-size: 14px; color: #a7a3b8; }
.ls-cue { align-self: center; padding: 2px 10px; border-radius: 999px; background: rgba(255, 255, 255, .14); font-size: 12px; }
.ls-cur { font-size: 26px; font-weight: 800; line-height: 1.35; color: #fde047; word-break: keep-all; }
.ls-next { font-size: 15px; color: #d6d3e1; }
.ls-sub { min-height: 1.4em; font-size: 24px; font-weight: 800; line-height: 1.35; color: #fff; text-shadow: 0 0 3px #000, 0 2px 4px #000; word-break: keep-all; }
.ls-sub.none { font-size: 16px; font-weight: 600; color: #8b879c; text-shadow: none; }
.ls-cap { font-size: 12px; color: #a7a3b8; }
.ls-vbox { position: relative; align-self: center; overflow: hidden; border-radius: 10px; background: #000; max-width: 100%; }
.ls-vbox video, .ls-vbox canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.ls-vbox video { object-fit: contain; }
.ls-vbox canvas { pointer-events: none; }
.ls-acts { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 8px; }
.ls-big { min-width: min(300px, 64%); min-height: 62px; padding: 14px 26px; border-radius: 999px; font-size: 24px; font-weight: 800; }
.ls-progress { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--muted, #6b6780); }
.ls-meter { flex: 1; height: 8px; overflow: hidden; border-radius: 4px; background: var(--line, #e7e4f0); }
.ls-meter > i { display: block; width: 0; height: 100%; background: var(--ok, #16a34a); transition: width .2s; }
.ls-keys { font-size: 12px; color: var(--muted, #6b6780); text-align: center; }
.ls-keys kbd { display: inline-block; margin: 0 2px; padding: 0 6px; border: 1px solid var(--line, #e7e4f0); border-bottom-width: 2px; border-radius: 5px; background: #fff; font: inherit; font-size: 11px; }
@media (hover: none) { .ls-keys { display: none; } }
.ls-list { position: relative; max-height: 30vh; overflow: auto; padding: 4px; border: 1px solid var(--line, #e7e4f0); border-radius: 12px; }
.ls-secrow { padding: 6px 8px 0; font-size: 11px; font-weight: 700; color: var(--primary, #7c3aed); }
.ls-row { padding: 6px 8px; border-radius: 9px; cursor: pointer; }
.ls-row:hover { background: #faf9fd; }
.ls-line { display: flex; align-items: baseline; gap: 8px; }
.ls-n { flex: none; width: 22px; text-align: right; font-size: 12px; color: var(--muted, #6b6780); }
.ls-t { flex: none; width: 50px; font-size: 13px; font-variant-numeric: tabular-nums; }
.ls-chip { flex: none; padding: 1px 7px; border-radius: 999px; background: #eeedf3; color: var(--muted, #6b6780); font-size: 11px; }
.ls-chip.ok { background: #e8f7ee; color: var(--ok, #16a34a); }
.ls-txt { flex: 1; word-break: keep-all; }
.ls-row.cur { background: #fef9c3; font-weight: 700; }
.ls-row.active { background: var(--primary-soft, #f1eafe); }
.ls-row.sel { box-shadow: inset 0 0 0 2px var(--primary, #7c3aed); }
.ls-row-acts { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 2px 30px; }
.ls.ls-tap .only-check, .ls.ls-check .only-tap { display: none !important; }
`;

  /**
   * 화면 만들기
   * @param {{lines:object[], duration:number, src:string, confirmed?:boolean, isActive?:()=>boolean,
   *   video?:object, styleProvider?:()=>({style:object,W:number,H:number}), renderer?:{drawFrame:Function}}} o
   *   isActive: 키보드를 받아도 되는지 (다른 창이 위에 떠 있으면 false)
   *   video: (고르기) <video> 같은 것 (currentTime · play() · pause() · paused · addEventListener …). 주면 노래 대신 이 영상을 틀고,
   *     2단계 확인하기의 어두운 무대에 글씨 대신 '진짜 영상 + 진짜 모양의 자막'을 보여 준다. 영상 요소는 부른 쪽 것이라 닫을 때 src 를 지우지 않는다.
   *   styleProvider: (고르기) 지금 자막 모양과 영상 출력 크기를 돌려주는 함수 — video 와 함께 쓴다. 매 그림마다 부른다.
   *   renderer: (고르기) 자막 그리개 (기본: 전역 AMSubtitleRender). 없으면 영상만 보이고 자막은 그리지 않는다.
   *   둘 다 안 주면 예전과 똑같이 동작한다 (폰 앱 tap.js · 옛 프로젝트 창).
   * @returns {{el:HTMLElement, result:()=>object[], untapped:()=>number, tappedFlags:()=>boolean[], destroy:()=>void, state:object, audio:HTMLMediaElement}}
   */
  function mount(o) {
    if (!document.getElementById('am-ls-style')) document.head.appendChild(h('style', { id: 'am-ls-style' }, CSS));
    const lines = o.lines;
    const s = create(lines, o.duration, { confirmed: o.confirmed });
    const D = s.duration || 1;
    let mode = o.confirmed ? 'check' : 'tap';
    let sel = -1;
    let justDone = false;
    let raf = 0;
    let shownActive = -2;
    let flashTimer = 0;

    const video = o.video || null;
    const audio = video || h('audio', { preload: 'auto', src: o.src });
    if (video && o.src && !video.src && !video.currentSrc) video.src = o.src; // 영상에 주소가 아직 없으면 src 로 채운다
    const R = o.renderer || (typeof self !== 'undefined' && self.AMSubtitleRender) || null;
    const styleNow = () => {
      const v = o.styleProvider ? o.styleProvider() : null;
      return {
        style: (v && v.style) || {},
        W: (v && v.W) || video.videoWidth || 1280,
        H: (v && v.H) || video.videoHeight || 720,
      };
    };
    const listeners = []; // 부른 쪽 영상에 붙인 귀는 닫을 때 떼어 낸다
    const on = (type, fn) => { audio.addEventListener(type, fn); listeners.push([type, fn]); };
    const pct = (t) => `${Math.max(0, Math.min(100, (t / D) * 100))}%`;
    const seek = (t) => { audio.currentTime = Math.max(0, Math.min(D - 0.05, t)); live(true); };
    const play = () => { const p = audio.play(); if (p && p.catch) p.catch(() => {}); };

    // 위: 단계 고르기
    const tabTap = h('button', { type: 'button', onclick: () => setMode('tap') }, '🎤 1. 맞추기');
    const tabCheck = h('button', { type: 'button', onclick: () => setMode('check') }, '👀 2. 확인하기');
    const help = h('p', { class: 'ls-help' });

    // 노래 재생 줄
    const playBtn = h('button', { class: 'ls-play', type: 'button', title: '재생 / 멈춤', onmousedown: (e) => e.preventDefault(), onclick: () => (audio.paused ? play() : audio.pause()) }, '▶');
    const timeEl = h('span', { class: 'ls-time' });
    const fill = h('div', { class: 'ls-fill' });
    const ticks = h('div');
    const head = h('div', { class: 'ls-head' });
    const bar = h('div', { class: 'ls-bar', title: '누르면 그 위치로 가요' }, fill, ticks, head);
    bar.addEventListener('pointerdown', (e) => {
      const r = bar.getBoundingClientRect();
      seek(((e.clientX - r.left) / r.width) * D);
    });
    const rate = h('select', { class: 'ls-rate', title: '느리게 들으면 맞추기 쉬워요' },
      h('option', { value: '1' }, '보통 속도'), h('option', { value: '0.75' }, '0.75배'), h('option', { value: '0.5' }, '0.5배'));
    rate.addEventListener('change', () => { audio.playbackRate = Number(rate.value); });

    // 무대 (큰 글씨)
    const prevEl = h('div', { class: 'ls-prev only-tap' });
    const cueEl = h('div', { class: 'ls-cue only-tap' });
    const curEl = h('div', { class: 'ls-cur only-tap' });
    const nextEl = h('div', { class: 'ls-next only-tap' });
    const subEl = h('div', { class: 'ls-sub only-check' });
    const capEl = h('div', { class: 'ls-cap only-check' });
    // 진짜 영상 + 자막 그림판 (video 를 줬을 때만): 숨겨도 영상은 계속 틀 수 있어서 맞추기 단계에서는 CSS 로만 감춘다
    const vcanvas = video ? h('canvas', { class: 'ls-vcanvas' }) : null;
    const vbox = video ? h('div', { class: 'ls-vbox only-check' }, typeof Node !== 'undefined' && video instanceof Node ? video : null, vcanvas) : null; // Node 가 아닌 '영상 비슷한 것'은 그냥 틀기만 한다
    const stage = h('div', { class: 'ls-stage', onclick: () => { if (mode === 'tap') primary(); } }, prevEl, cueEl, curEl, nextEl, video ? vbox : subEl, capEl);

    // 버튼들
    const undoBtn = btn('small', '↩ 방금 것 취소', () => doUndo(), '키보드: Backspace');
    const bigBtn = btn('primary ls-big', '▶ 노래 틀기', () => primary());
    const restartBtn = btn('small only-tap', '⏮ 처음부터', () => { snapshot(s); s.idx = 0; seek(0); play(); renderAll(); });
    const earlier = btn('small only-check', '⏪ 자막이 늦어요 (모두 0.1초 당기기)', () => { shiftAll(s, -0.1); renderAll(); });
    const later = btn('small only-check', '⏩ 자막이 빨라요 (모두 0.1초 미루기)', () => { shiftAll(s, 0.1); renderAll(); });
    const progText = h('span');
    const meter = h('i');
    const list = h('div', { class: 'ls-list' });

    const el = h('div', { class: 'ls' },
      h('div', { class: 'ls-modes' }, tabTap, tabCheck),
      help,
      h('div', { class: 'ls-player' }, playBtn, timeEl, bar, rate),
      stage,
      h('div', { class: 'ls-acts' }, bigBtn),
      h('div', { class: 'ls-acts' }, undoBtn, restartBtn, earlier, later),
      h('div', { class: 'ls-progress' }, progText, h('div', { class: 'ls-meter' }, meter)),
      h('div', { class: 'ls-keys' },
        h('kbd', null, 'Space'), ' 지금! / 재생 · ', h('kbd', null, 'Backspace'), ' 방금 것 취소 · ', h('kbd', null, '←'), h('kbd', null, '→'), ' 3초 이동'),
      list,
      video ? null : audio);

    function setMode(m) {
      mode = m;
      if (m === 'tap') {
        if (s.idx >= s.n) s.idx = sel >= 0 ? sel : 0;
        if (audio.paused) seek(leadIn(s, s.idx));
      } else if (justDone) {
        justDone = false;
        seek(0);
        play();
      }
      renderAll();
    }

    function primary() {
      if (mode === 'check') { if (audio.paused) play(); else audio.pause(); return; }
      if (audio.paused) {
        if (s.idx >= s.n) { snapshot(s); s.idx = 0; seek(0); renderAll(); }
        play();
        return;
      }
      doTap();
    }

    function doTap() {
      const i = tap(s, tapTime(audio.currentTime, audio.playbackRate));
      if (i < 0) return;
      stage.classList.add('flash');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => stage.classList.remove('flash'), 140);
      if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(25);
      if (s.idx >= s.n) justDone = true;
      renderAll();
    }

    function doUndo() {
      if (!undo(s)) return;
      if (mode === 'tap' && s.idx < s.n) seek(leadIn(s, s.idx));
      renderAll();
    }

    function renderStage() {
      if (mode === 'tap') {
        const i = s.idx;
        prevEl.textContent = i > 0 ? `✔ ${lines[i - 1].text}  (${fmt(s.marks[i - 1])})` : '';
        const sec = i < s.n && lines[i].section && (i === 0 || lines[i].section !== lines[i - 1].section) ? lines[i].section : '';
        cueEl.textContent = sec;
        cueEl.style.display = sec ? '' : 'none';
        curEl.textContent = i < s.n ? lines[i].text : '🎉 다 맞췄어요!';
        nextEl.textContent = i + 1 < s.n ? `다음 줄: ${lines[i + 1].text}` : i < s.n ? '마지막 줄이에요' : '[👀 2. 확인하기] 를 눌러 처음부터 들어 보세요';
      } else {
        const a = activeAt(s, audio.currentTime, ends(s), 0.1);
        if (!video) {
          subEl.textContent = a >= 0 ? lines[a].text : '(지금은 자막이 없는 부분)';
          subEl.classList.toggle('none', a < 0);
        }
        capEl.textContent = a >= 0 ? `${a + 1}번째 줄 · ${fmt(s.marks[a])} 에 나와요` : '완성 영상에서도 이 시간에는 자막이 안 나와요';
      }
    }

    function renderTop() {
      el.className = `ls ls-${mode}`; // ls-tap / ls-check (앱의 .check 같은 이름과 겹치지 않게)
      tabTap.classList.toggle('on', mode === 'tap');
      tabCheck.classList.toggle('on', mode === 'check');
      tabCheck.classList.toggle('pulse', mode === 'tap' && justDone);
      help.textContent = mode === 'tap'
        ? '노래를 틀고, 노란 글씨 줄을 부르기 시작하는 순간 [지금!] 을 누르세요. 놓쳤으면 [↩ 방금 것 취소] 를 누르면 조금 앞에서 다시 들려줘요.'
        : '노래에 맞춰 자막이 제때 나오는지 보세요. 한 줄만 어긋나면 아래 목록에서 그 줄을 눌러 고치고, 전부 어긋나면 [자막이 늦어요/빨라요] 를 누르세요.';
      bigBtn.textContent = mode === 'tap'
        ? (audio.paused ? (s.idx >= s.n ? '▶ 처음부터 다시 맞추기' : '▶ 노래 틀기') : (s.idx < s.n ? '지금!' : '✔ 다 맞췄어요'))
        : (audio.paused ? '▶ 들으며 확인하기' : '⏸ 잠깐 멈추기');
      undoBtn.disabled = !s.history.length;
      const done = s.n - untapped(s);
      progText.textContent = `${done} / ${s.n} 줄 맞춤`;
      meter.style.width = `${s.n ? (done / s.n) * 100 : 0}%`;
      playBtn.textContent = audio.paused ? '▶' : '⏸';
    }

    function renderTicks() {
      while (ticks.firstChild) ticks.removeChild(ticks.firstChild);
      s.marks.forEach((m, i) => ticks.appendChild(h('div', {
        class: `ls-tick ${s.tapped[i] ? 'ok' : ''} ${mode === 'tap' && i === s.idx ? 'cur' : ''}`,
        style: { left: pct(m) },
        title: `${i + 1}. ${lines[i].text} (${fmt(s.marks[i])})`,
      })));
    }

    function rowActions(i) {
      return h('div', { class: 'ls-row-acts', onclick: (e) => e.stopPropagation() },
        btn('small', '▶ 여기서 듣기', () => { seek(s.marks[i] - 1); play(); }),
        btn('small', '− 0.1초 (빨리)', () => { nudge(s, i, -0.1); renderAll(); seek(s.marks[i] - 1); play(); }),
        btn('small', '+ 0.1초 (늦게)', () => { nudge(s, i, 0.1); renderAll(); seek(s.marks[i] - 1); play(); }),
        btn('small', '🎤 이 줄부터 다시 맞추기', () => {
          snapshot(s);
          s.idx = i;
          mode = 'tap';
          seek(leadIn(s, i));
          play();
          renderAll();
        }));
    }

    function renderList() {
      while (list.firstChild) list.removeChild(list.firstChild);
      lines.forEach((l, i) => {
        if (l.section && (i === 0 || l.section !== lines[i - 1].section)) list.appendChild(h('div', { class: 'ls-secrow' }, l.section));
        list.appendChild(h('div', {
          class: `ls-row ${mode === 'tap' && i === s.idx ? 'cur' : ''} ${i === sel ? 'sel' : ''}`,
          'data-i': i,
          onclick: () => { sel = sel === i ? -1 : i; renderList(); },
        },
        h('div', { class: 'ls-line' },
          h('span', { class: 'ls-n' }, i + 1),
          h('span', { class: 'ls-t' }, fmt(s.marks[i])),
          h('span', { class: `ls-chip ${s.tapped[i] ? 'ok' : ''}` }, s.tapped[i] ? '✔ 맞춤' : '예상'),
          h('span', { class: 'ls-txt' }, l.text)),
        i === sel ? rowActions(i) : null));
      });
      shownActive = -2;
      if (mode === 'tap') scrollTo(s.idx < s.n ? s.idx : s.n - 1);
    }

    function rowEl(i) { return list.querySelector(`.ls-row[data-i="${i}"]`); }

    function scrollTo(i) {
      const r = rowEl(i);
      if (!r) return;
      if (r.offsetTop < list.scrollTop || r.offsetTop + r.offsetHeight > list.scrollTop + list.clientHeight) {
        list.scrollTop = Math.max(0, r.offsetTop - list.clientHeight / 3);
      }
    }

    function renderAll() {
      renderTop();
      renderStage();
      renderTicks();
      renderList();
      live(true);
    }

    /** 재생 중 계속 바뀌는 것: 재생 위치, 시간, 확인하기의 지금 줄 */
    /** 진짜 영상 위 자막 그림판 다시 그리기 (재생 중에는 매 순간 부른다) */
    function drawReal() {
      if (!video || !vcanvas || mode !== 'check') return;
      const { style, W, H } = styleNow();
      if (vcanvas.width !== W) vcanvas.width = W;
      if (vcanvas.height !== H) vcanvas.height = H;
      const z = stageSize(W, H);
      if (vbox.style.aspectRatio !== z.aspect) { vbox.style.aspectRatio = z.aspect; vbox.style.width = z.width; }
      const ctx = vcanvas.getContext('2d');
      if (!ctx) return;
      drawCheck(R, ctx, s, lines, audio.currentTime || 0, style, W, H);
    }

    function live(force) {
      const t = audio.currentTime || 0;
      head.style.left = pct(t);
      fill.style.width = pct(t);
      timeEl.textContent = `${fmt(t)} / ${fmt(D, 0)}`;
      drawReal();
      if (mode === 'check') {
        const a = activeAt(s, t, ends(s), 0.1);
        if (a !== shownActive || force) {
          const old = rowEl(shownActive);
          if (old) old.classList.remove('active');
          shownActive = a;
          const r = rowEl(a);
          if (r) { r.classList.add('active'); scrollTo(a); }
          renderStage();
        }
      }
    }

    const loop = () => { live(false); raf = audio.paused ? 0 : requestAnimationFrame(loop); };
    on('play', () => { renderTop(); if (!raf) raf = requestAnimationFrame(loop); });
    on('pause', () => { renderTop(); live(true); });
    on('seeked', () => live(true));
    on('loadedmetadata', () => live(true));
    if (video) on('loadeddata', () => live(true));
    // 모양에 쓰는 글꼴이 아직 안 읽혔으면 읽고 다시 그린다 (스튜디오는 미리 읽어 두므로 보통 바로 끝난다)
    if (video && R && R.style && typeof document !== 'undefined' && document.fonts && document.fonts.load) {
      try { Promise.resolve(document.fonts.load(R.style.fontCss(styleNow().style, 40), '가나다ABC')).then(() => live(true), () => {}); } catch (_) { /* 글꼴이 없어도 그린다 */ }
    }

    const onKey = (e) => {
      if (!el.isConnected || (o.isActive && !o.isActive())) return;
      const tg = e.target;
      if (tg && /^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName)) return;
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        if (!e.repeat) primary();
      } else if (e.code === 'Backspace') {
        e.preventDefault();
        doUndo();
      } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        e.preventDefault();
        seek(audio.currentTime + (e.code === 'ArrowLeft' ? -3 : 3));
      }
    };
    document.addEventListener('keydown', onKey);
    renderAll();

    return {
      el,
      audio,
      state: s,
      result: () => result(s, lines),
      untapped: () => untapped(s),
      tappedFlags: () => s.tapped.slice(),
      destroy: () => {
        document.removeEventListener('keydown', onKey);
        if (raf) cancelAnimationFrame(raf);
        clearTimeout(flashTimer);
        for (const [type, fn] of listeners) audio.removeEventListener(type, fn); // 귀를 먼저 떼야 pause 가 다시 그리지 않는다
        audio.pause();
        if (video) return; // 영상 요소는 부른 쪽 것: 주소를 지우는 것도 부른 쪽이 한다
        audio.removeAttribute('src');
        try { audio.load(); } catch (_) { /* noop */ }
      },
    };
  }

  return { MIN_GAP, REACTION, MAX_LINE, create, normalize, undo, tapTime, tap, nudge, shiftAll, leadIn, ends, activeAt, untapped, result, fmt, checkLines, drawCheck, stageSize, mount };
});
