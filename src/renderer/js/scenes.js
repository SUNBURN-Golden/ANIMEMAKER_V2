'use strict';
/* scenes: 장면 고치기 — AM.scenes.mount(host, ctx) → { update(snap), destroy() }
 *
 *   ┌ 큰 미리보기 (배경 + 인물 겹침 · 카메라 미리 움직임 · [▶ 이 장면 영상으로 미리보기]) ┐
 *   [1][2][3 ✏️][4 🏃]…                 ← 장면 띠 (길이에 비례한 폭 · 썸네일 · 시간 · 가사 일부)
 *   ┌ 장면 4 · 0:30~0:40 · "가사" ─ 🎨 그림 · ⏱ 보여 주는 시간 · 🎥 카메라 · ✨ 효과 / 다음 장면으로 ┐
 *
 * ctx = { id, getSnap(), api, toast, onClose(), onBusy?(bool), focusShot? }   (B2-common.md 의 약속)
 *  - 화면은 처음에 한 번만 만들고, update(snap) 마다 띠·타일·값만 제자리에서 고친다 (입력 중인 칸은 건드리지 않는다).
 *  - 영상(<video>)은 '이 장면 미리보기'(work/preview) 하나뿐이다. 영상을 이어 붙이기 시작하면 놓아 준다 (윈도우 파일 잠금).
 *  - 백엔드가 막는 때: 영상을 만드는 중이면 카메라·시간·효과·장면 넘기기·그림 다시 그리기가 막힌다 (이유를 화면에 보여 준다).
 */
(function (AM) {
  const { h, clear } = AM;
  const FPS = 24;
  const BG = 'bg';
  const STEP_FR = 6; // 0.25초
  const MIN_FR = 6; // 한 그림을 보여 주는 가장 짧은 시간 (0.25초)
  const MAX_FX = 3;
  const PARALLAX = 0.8; // 배경은 카메라보다 0.8배만 다가간다 (media/render.js 와 같다)
  const IMG_EXT = ['png', 'jpg', 'jpeg', 'webp'];
  const ARS = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5 };

  // 장면 넘기기(전환) 이름: ui.js 에 AM.TRANSITION_LABEL 이 생기면 그것이 우선한다
  const TRANSITION_LABEL = {
    cut: '✂️ 컷', dissolve: '🌫 스르륵', fade: '◐ 페이드', fadeblack: '🌑 암전', flash: '⚡ 번쩍',
    slideleft: '⬅ 밀어내기', slideup: '⬆ 위로 밀기', wipeleft: '🧹 닦아내기', zoomin: '🔎 쑥 들어가기',
    circleopen: '⭕ 동그랗게', pixelize: '🔳 모자이크', smoothleft: '〰 부드럽게',
  };
  const TRANSITION_TIP = {
    cut: '바로 다음 장면으로 바뀌어요', dissolve: '두 장면이 스르륵 겹쳐요', fade: '서서히 바뀌어요', fadeblack: '까맣게 됐다가 다음 장면이 나와요',
    flash: '하얗게 번쩍하며 바뀌어요', slideleft: '옆으로 밀면서 바뀌어요', slideup: '위로 밀면서 바뀌어요', wipeleft: '옆으로 닦아내듯 바뀌어요',
    zoomin: '쑥 빨려 들어가듯 바뀌어요', circleopen: '동그랗게 열리며 바뀌어요', pixelize: '네모 조각으로 흩어지며 바뀌어요', smoothleft: '부드럽게 밀려나며 바뀌어요',
  };
  const TR_ORDER = ['cut', 'dissolve', 'fade', 'fadeblack', 'flash', 'slideleft', 'slideup', 'wipeleft', 'zoomin', 'circleopen', 'pixelize', 'smoothleft'];
  const FX_ORDER = ['fade_in', 'fade_out', 'flash', 'sparkle', 'shake', 'dissolve_in'];

  // ---------- 작은 도우미 ----------
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const abs = (snap, rel) => AM.joinPath(snap.dir, rel);
  const url = (snap, rel, v) => (rel ? AM.fileUrl(abs(snap, rel), v) : '');
  const fmtTime = (sec) => { const t = Math.max(0, Math.floor(Number(sec) || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
  const secText = (fr) => `${+(fr / FPS).toFixed(2)}초`;
  const drawingOf = (snap, shotNo, id) => (snap.drawings || []).find((d) => d.shot === shotNo && d.id === id);
  // 이모지 그림으로 보이게 (화살표 글자는 그냥 두면 까만 글자로 나온다)
  const emojiOf = (t) => (/^[\u2B05\u27A1\u2B06\u2B07]$/.test(t) ? `${t}\uFE0F` : t);
  const splitLabel = (s) => { const m = String(s || '').match(/^(\S+)\s+(.*)$/); return m ? { ico: emojiOf(m[1]), txt: m[2] } : { ico: '', txt: String(s || '') }; };
  const errText = (e) => AM.kit.friendlyError(e && e.message ? e.message : String(e == null ? '' : e)).text;
  const noop = () => {};

  /** 보이는 그림 파일: 배경 빼기가 된 인물은 투명 PNG(cel), 아니면 원래 파일 */
  function celView(it) {
    if (!it || !it.file) return null;
    if (it.kind !== 'bg' && it.id !== BG && it.keyed && it.cel) return { rel: it.cel, checker: true };
    return { rel: it.file, checker: false };
  }

  function setSrc(img, src) {
    const cur = img.getAttribute('src') || '';
    if (cur === (src || '')) return;
    if (src) img.setAttribute('src', src); else img.removeAttribute('src');
  }
  function setText(el, t) { if (el.textContent !== t) el.textContent = t; }
  function setHidden(el, on) { el.classList.toggle('hidden', !!on); }

  /** 카메라 구도 → CSS (그림 전체를 1/w 배로 키우고 보이는 창의 왼쪽 위를 맞춘다. 흔들림은 px) */
  function tfOf(fr, jx, jy) {
    const u = window.AMCamera.unitRect(fr);
    return `translate(${(jx || 0).toFixed(2)}px, ${(jy || 0).toFixed(2)}px) scale(${(1 / u.w).toFixed(5)}, ${(1 / u.h).toFixed(5)}) translate(${(-u.x * 100).toFixed(4)}%, ${(-u.y * 100).toFixed(4)}%)`;
  }
  /** 효과 (media/render-core.js fxState 와 같은 셈) */
  function fxAt(fx, f, N) {
    const st = { fade: 1, flash: 0, shake: 0 };
    const len = Math.max(2, Math.min(18, Math.round(N / 4)));
    if (fx.includes('fade_in') && f < len) st.fade = Math.min(st.fade, (f + 1) / (len + 1));
    if (fx.includes('fade_out') && f >= N - len) st.fade = Math.min(st.fade, (N - f) / (len + 1));
    if (fx.includes('flash') && f < 8) st.flash = 0.85 * (1 - f / 8);
    if (fx.includes('shake') && f < 14) st.shake = 1 - f / 14;
    return st;
  }
  function rnd(k, salt) { const x = Math.sin(k * 127.1 + salt * 311.7) * 43758.5453; return x - Math.floor(x); }

  /** 이 장면에 나오는 가사 (숨긴 줄은 뺀다) */
  function lyricsOf(snap, i) {
    const t = snap.timing;
    const seg = t && t.segments && t.segments[i];
    if (!seg || !Array.isArray(seg.lyrics)) return '';
    return seg.lyrics.map((k) => (t.lyrics || [])[k]).filter((l) => l && !l.hidden && l.text).map((l) => l.text).join(' / ');
  }

  function mount(host, ctx) {
    const api = ctx.api || window.api;
    const say = ctx.toast || AM.toast;
    const TL = { ...TRANSITION_LABEL, ...(AM.TRANSITION_LABEL || {}) };
    const S = {
      snap: ctx.getSnap ? ctx.getSnap() : null,
      built: false, destroyed: false, raf: 0, stripKey: '',
      sel: null, selId: null, // 고른 장면 번호(shot.shot) · 미리보기에 보여 줄 그림
      cards: new Map(), P: null,
      opt: new Map(), touched: new Map(), local: new Set(), expOv: new Map(), retiming: new Set(),
      mode: 'still', anim: null, clip: null, clipBusy: 0, reduced: false, redrawing: false, hist: null, ar: '',
    };
    const el = {};

    const snap = () => S.snap || (ctx.getSnap && ctx.getSnap()) || { drawings: [], xsheet: null };
    const pid = () => snap().id || ctx.id;
    const shots = () => (snap().xsheet && snap().xsheet.shots) || [];
    const curShot = () => shots().find((s) => s.shot === S.sel) || null;
    const isLayered = () => !!(snap().xsheet && snap().xsheet.layers);
    const running = () => !!snap().running;
    const renderPhase = () => running() && ['render', 'subtitles'].includes(snap().currentStep);
    const redrawList = () => snap().redrawing || [];
    const redrawOf = (n, id) => {
      const r = redrawList().find((x) => x.shot === n && x.id === id);
      if (r) return r.status === 'running' ? 'running' : 'queued';
      return S.local.has(`${n}:${id}`) ? 'queued' : null;
    };
    const shotBusy = (n) => redrawList().some((r) => r.shot === n) || [...S.local].some((k) => k.startsWith(`${n}:`));
    const camMove = (shot) => S.opt.get(`cam:${shot.shot}`) || (shot.camera && shot.camera.move) || 'hold';
    const fxList = (shot) => S.opt.get(`fx:${shot.shot}`) || shot.fx || [];
    const trOf = (shot) => {
      const s = snap(); const i = shots().indexOf(shot);
      return S.opt.get(`tr:${shot.shot}`) || (s.xsheet && s.xsheet.transitions && s.xsheet.transitions[i] && s.xsheet.transitions[i].type) || 'cut';
    };
    const rowsOf = (shot) => S.expOv.get(shot.shot) || shot.exposure || [];
    const celIds = (shot) => (shot.drawings || []).map((d) => d.id);
    const idLabel = (shot, id) => (id === BG ? '🏞 배경' : (celIds(shot)[0] === id ? '첫 그림' : '다음 그림'));

    function schedule() { if (S.destroyed || S.raf) return; S.raf = requestAnimationFrame(() => { S.raf = 0; flush(); }); }
    function changedSet() {
      const s = snap();
      const set = new Set((s.changes && s.changes.shots) || s.dirtyShots || []);
      const now = Date.now();
      for (const [n, t] of [...S.touched]) {
        if (set.has(n)) S.touched.delete(n);
        else if (now - t > 4000 && s.changes && s.changes.count === 0) S.touched.delete(n);
        else set.add(n);
      }
      return set;
    }
    function touch(...nums) { nums.forEach((n) => { if (n != null) S.touched.set(n, Date.now()); }); schedule(); }
    /** 고치는 일을 하고, 안 되면 쉬운 말로 알려 준다 */
    async function attempt(fn, okMsg) {
      try { const r = await fn(); if (okMsg) say(okMsg, 'ok'); return { ok: true, r }; } catch (e) { say(errText(e), 'err'); return { ok: false }; }
    }

    // ---------- 뼈대 ----------
    const root = h('div', { class: 'sc-root' });
    el.empty = h('div', { class: 'sc-empty notice info' }, '🎬 장면을 나누고 그림을 그리는 중이에요. 장면이 준비되면 여기서 고칠 수 있어요.');
    el.bg = h('img', { class: 'sc-img sc-bg hidden', alt: '', draggable: 'false' });
    el.cel = h('img', { class: 'sc-img sc-cel hidden', alt: '', draggable: 'false' });
    el.dark = h('div', { class: 'sc-ov sc-ov-dark' });
    el.flash = h('div', { class: 'sc-ov sc-ov-flash' });
    el.sparkles = h('div', { class: 'sc-sparkles hidden', 'aria-hidden': 'true' }, Array.from({ length: 12 }, (_, k) => h('i', { style: { left: `${8 + rnd(k, 1) * 84}%`, top: `${6 + rnd(k, 2) * 70}%` } }, '✦')));
    el.msg = h('div', { class: 'sc-msg hidden' });
    el.badge = h('div', { class: 'sc-badge' });
    el.progBar = h('i');
    el.prog = h('div', { class: 'sc-prog hidden', 'aria-hidden': 'true' }, el.progBar);
    el.stage = h('div', { class: 'sc-stage', role: 'group', 'aria-label': '고른 장면 미리보기' }, el.bg, el.cel, el.dark, el.flash, el.sparkles, el.msg, el.badge, el.prog);

    el.btnPlay = h('button', { type: 'button', class: 'btn sc-act', onclick: () => playCamera() }, '🎥 카메라 움직여 보기');
    el.btnSound = h('button', { type: 'button', class: 'btn sc-act', 'aria-pressed': 'false', onclick: () => toggleSound() }, '🔊 소리 들으며 보기');
    el.btnRow = h('div', { class: 'sc-btnrow' }, el.btnPlay, el.btnSound);
    el.btnClip = h('button', { type: 'button', class: 'btn primary sc-act', onclick: () => makeClip() }, '▶ 이 장면 영상으로 미리보기');
    el.btnClose = h('button', { type: 'button', class: 'btn sc-act hidden', onclick: () => closeClip() }, '✕ 닫기');
    el.btnStart = h('button', { type: 'button', class: 'btn sc-act', 'aria-pressed': 'true', onclick: () => showEnd(0) }, '처음 모습');
    el.btnEnd = h('button', { type: 'button', class: 'btn sc-act', 'aria-pressed': 'false', onclick: () => showEnd(1) }, '끝 모습');
    el.reduce = h('div', { class: 'sc-reduce hidden', role: 'group', 'aria-label': '카메라 처음과 끝' }, el.btnStart, el.btnEnd);
    el.note = h('div', { class: 'sc-note', 'aria-live': 'polite' });
    el.sinfo = panelHead(); // 중간 크기 창에서는 미리보기 옆에 장면 이름을 보여 준다 (아래 칸 머리는 숨는다)
    el.sinfo.el.classList.add('sc-sinfo');
    el.bar = h('div', { class: 'sc-stagebar' }, el.sinfo.el, el.btnRow, el.btnClip, el.btnClose, el.reduce, el.note);

    el.strip = h('div', { class: 'sc-strip', role: 'listbox', 'aria-label': '장면 띠', onkeydown: onStripKey });
    el.prev = h('button', { type: 'button', class: 'sc-nav sc-prev', 'aria-label': '앞쪽 장면 보기', onclick: () => scrollStrip(-1) }, '‹');
    el.next = h('button', { type: 'button', class: 'sc-nav sc-next', 'aria-label': '뒤쪽 장면 보기', onclick: () => scrollStrip(1) }, '›');
    el.stripWrap = h('div', { class: 'sc-stripwrap' }, el.prev, el.strip, el.next);

    el.top = h('div', { class: 'sc-top' }, h('div', { class: 'sc-stagewrap' }, el.stage, el.bar), el.stripWrap);
    el.panel = h('div', { class: 'sc-panel' });
    el.head = h('div', { class: 'sc-head' },
      h('div', { class: 'sc-headtext' },
        h('h2', { class: 'sc-title' }, '✏️ 고치고 싶은 장면을 눌러 보세요'),
        h('span', { class: 'sc-hint' }, '고친 장면에는 ✏️ 표시가 생기고, 아래 [고친 것 반영하기] 를 누르면 영상에 들어가요.')),
      ctx.onClose ? h('button', { type: 'button', class: 'btn sc-back', onclick: () => ctx.onClose() }, '← 영상으로 돌아가기') : null);
    root.appendChild(h('div', { class: 'sc-grid' }, el.head, el.empty, el.top, el.panel));
    // 이전 그림 팝오버: 인물을 초록 바탕에서 그린 원본 파일이라, 초록 바탕을 투명하게 보여 주는 필터 (보기용, 파일은 그대로)
    const SVGNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.setAttribute('aria-hidden', 'true'); svg.style.position = 'absolute';
    svg.innerHTML = '<filter id="sc-key-green" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0.5 -1 0.5 0 1"/><feComponentTransfer><feFuncA type="table" tableValues="0 0 1 1"/></feComponentTransfer></filter>';
    root.appendChild(svg);
    host.appendChild(root);

    const mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    S.reduced = !!(mq && mq.matches);
    const onMq = () => { S.reduced = !!(mq && mq.matches); };
    if (mq && mq.addEventListener) mq.addEventListener('change', onMq);
    const onResize = () => schedule();
    window.addEventListener('resize', onResize);
    // 붙어 있는 위쪽 칸의 높이를 알려 둔다: 키보드로 이동한 단추가 그 밑에 가려지지 않게 (css scroll-margin)
    const fitTop = () => root.style.setProperty('--sc-top-h', `${el.top.offsetHeight}px`);
    const ro = window.ResizeObserver ? new ResizeObserver(fitTop) : null;
    if (ro) ro.observe(el.top);

    // ---------- 장면 띠 ----------
    function buildCard(shot) {
      const c = {};
      c.bgImg = h('img', { class: 'sc-timg hidden', alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
      c.celImg = h('img', { class: 'sc-timg hidden', alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
      c.num = h('span', { class: 'sc-cnum' }, String(shot.shot));
      c.mMotion = h('span', { class: 'sc-mk', title: '움직이는 장면이에요' }, '🏃');
      c.mHl = h('span', { class: 'sc-mk', title: '하이라이트 장면이에요' }, '⭐');
      c.mEdit = h('span', { class: 'sc-mk edit', title: '고친 장면이에요' }, '✏️');
      c.marks = h('span', { class: 'sc-cmarks' }, c.mMotion, c.mHl, c.mEdit);
      c.spin = h('span', { class: 'sc-cspin hidden', title: '그림을 그리는 중이에요' }, AM.kit.spinner());
      c.thumb = h('span', { class: 'sc-cthumb' }, c.bgImg, c.celImg, c.num, c.marks, c.spin);
      c.time = h('span', { class: 'sc-ctime' });
      c.lyric = h('span', { class: 'sc-clyric' });
      c.el = h('button', { type: 'button', class: 'sc-card', role: 'option', dataset: { shot: String(shot.shot) }, onclick: () => selectScene(shot.shot, { smooth: true }) }, c.thumb, c.time, c.lyric);
      return c;
    }
    function rebuildStrip(list, key) {
      S.stripKey = key;
      S.cards.clear();
      clear(el.strip);
      list.forEach((shot) => { const c = buildCard(shot); S.cards.set(shot.shot, c); el.strip.appendChild(c.el); });
    }
    function patchCard(c, shot, i, ch) {
      const s = snap();
      const dur = (shot.end - shot.start) || (shot.frames / FPS);
      const w = Math.round(clamp(dur * 16, 96, 240));
      if (c.w !== w) { c.el.style.width = `${w}px`; c.w = w; }
      const sel = shot.shot === S.sel;
      c.el.classList.toggle('sel', sel);
      c.el.setAttribute('aria-selected', sel ? 'true' : 'false');
      c.el.tabIndex = sel ? 0 : -1;
      const src = picSources(s, shot, null);
      setSrc(c.bgImg, src.bg); setHidden(c.bgImg, !src.bg);
      setSrc(c.celImg, src.cel); setHidden(c.celImg, !src.cel);
      c.thumb.classList.toggle('nobg', !src.bg);
      c.thumb.classList.toggle('empty', !src.bg && !src.cel);
      setText(c.time, fmtTime(shot.start));
      const ly = lyricsOf(s, i);
      setText(c.lyric, ly || '🎵 노래만 나와요');
      c.lyric.classList.toggle('none', !ly);
      c.lyric.title = ly;
      const ed = ch.has(shot.shot);
      setHidden(c.mMotion, !shot.motion); setHidden(c.mHl, !shot.highlight); setHidden(c.mEdit, !ed);
      setHidden(c.spin, !shotBusy(shot.shot));
      const label = `장면 ${shot.shot}, ${fmtTime(shot.start)}부터 ${Math.round(dur)}초${shot.motion ? ', 움직여요' : ''}${shot.highlight ? ', 하이라이트' : ''}${ed ? ', 고쳤어요' : ''}${ly ? `, ${ly}` : ''}`;
      if (c.label !== label) { c.el.setAttribute('aria-label', label); c.label = label; }
    }
    function syncStrip() {
      const list = shots();
      const key = list.map((s) => s.shot).join(',');
      if (key !== S.stripKey) rebuildStrip(list, key);
      const ch = changedSet();
      list.forEach((shot, i) => { const c = S.cards.get(shot.shot); if (c) patchCard(c, shot, i, ch); });
      const more = el.strip.scrollWidth > el.strip.clientWidth + 2; // 띠가 넘칠 때만 ‹ › 단추를 보여 준다
      setHidden(el.prev, !more); setHidden(el.next, !more);
    }
    function scrollStrip(dir) {
      el.strip.scrollBy({ left: dir * Math.max(160, el.strip.clientWidth * 0.7), behavior: S.reduced ? 'auto' : 'smooth' });
    }
    function centerCard(n, smooth) {
      const c = S.cards.get(n);
      if (!c) return;
      const left = c.el.offsetLeft - (el.strip.clientWidth - c.el.offsetWidth) / 2;
      el.strip.scrollTo({ left: Math.max(0, left), behavior: smooth && !S.reduced ? 'smooth' : 'auto' });
    }
    function onStripKey(e) {
      const list = shots();
      const i = list.findIndex((s) => s.shot === S.sel);
      let k = -1;
      if (e.key === 'ArrowRight') k = Math.min(list.length - 1, i + 1);
      else if (e.key === 'ArrowLeft') k = Math.max(0, i - 1);
      else if (e.key === 'Home') k = 0;
      else if (e.key === 'End') k = list.length - 1;
      if (k < 0) return;
      e.preventDefault();
      if (k !== i && list[k]) { selectScene(list[k].shot, { smooth: true, focus: true }); }
    }

    // ---------- 장면 고르기 ----------
    function selectScene(n, o = {}) {
      if (S.sel === n && S.P) { centerCard(n, o.smooth); return; }
      const first = S.sel == null;
      stopSound();
      stopAnim(true);
      closeClip(true);
      closeHistory();
      S.sel = n;
      S.selId = null;
      S.P = null;
      syncStrip();
      buildPanel();
      syncStage();
      centerCard(n, o.smooth && !first);
      if (o.focus) { const c = S.cards.get(n); if (c) c.el.focus({ preventScroll: true }); }
    }

    // ---------- 큰 미리보기 ----------
    function picSources(s, shot, selId) {
      const lay = !!(s.xsheet && s.xsheet.layers);
      let bg = null; let cel = null; let checker = false;
      if (lay) { const b = drawingOf(s, shot.shot, BG); if (b && b.file) bg = url(s, b.file, b.updatedAt); }
      const id = selId || (shot.drawings && shot.drawings[0] && shot.drawings[0].id);
      if (id && id !== BG) {
        const it = drawingOf(s, shot.shot, id);
        const v = celView(it);
        if (v) { cel = url(s, v.rel, it.updatedAt); checker = v.checker; }
      }
      return { bg, cel, checker };
    }
    function setAspect(ar) {
      S.ar = ar;
      const n = ARS[ar] || 16 / 9;
      root.style.setProperty('--sc-ar', `${(ar || '16:9').replace(':', ' / ')}`);
      root.style.setProperty('--sc-arn', String(+n.toFixed(4)));
      root.classList.toggle('ar-tall', n < 1);
    }
    function syncStage() {
      const s = snap(); const shot = curShot();
      if (!shot) return;
      const ar = (s.workflow && s.workflow.aspect) || '16:9';
      if (ar !== S.ar) setAspect(ar);
      el.sinfo.patch(shot, shots().indexOf(shot));
      const src = picSources(s, shot, S.selId);
      if (S.mode !== 'anim') { setSrc(el.bg, src.bg); setSrc(el.cel, src.cel); }
      setHidden(el.bg, !src.bg); setHidden(el.cel, !src.cel && S.mode !== 'anim');
      el.stage.classList.toggle('nobg', !src.bg);
      // 영상을 이어 붙이는 동안에는 미리보기 영상을 놓아 준다 (윈도우에서 파일이 잠기지 않게)
      if (renderPhase() && S.clip) { closeClip(true); say('새 영상을 만드는 중이라 장면 영상 미리보기를 닫았어요', undefined); }
      // 가운데 안내
      let msg = '';
      let spin = false;
      if (S.clipBusy === shot.shot) { msg = '미리보기를 만드는 중…'; spin = true; }
      else if (!src.bg && !src.cel && S.mode !== 'clip') { msg = shotBusy(shot.shot) ? '그림을 그리는 중이에요…' : '아직 그리지 못했어요'; spin = shotBusy(shot.shot); }
      const mkey = `${spin ? 1 : 0}|${msg}`;
      if (el.msg.dataset.k !== mkey) { // 안내 글이 바뀔 때만 다시 쓴다 (업데이트가 자주 와도 돌고 있는 표시를 끊지 않게)
        el.msg.dataset.k = mkey;
        clear(el.msg);
        if (msg) { if (spin) el.msg.appendChild(AM.kit.spinner()); el.msg.appendChild(document.createTextNode(msg)); }
      }
      setHidden(el.msg, !msg);
      el.stage.classList.toggle('dim', S.clipBusy === shot.shot);
      // 이름표
      if (S.mode === 'still') setText(el.badge, `장면 ${shot.shot}${S.selId === BG ? ' · 🏞 배경만' : S.selId ? ` · 그림 ${S.selId}` : ''}`);
      // 단추
      const hasPic = !!(src.bg || src.cel);
      const busyHere = shotBusy(shot.shot);
      el.btnPlay.disabled = !hasPic || !!S.clipBusy;
      el.btnSound.disabled = !hasPic || !!S.clipBusy || !songRel();
      let why = '';
      if (renderPhase()) why = '지금은 영상을 만드는 중이에요';
      else if (busyHere) why = '이 장면의 그림을 그리는 중이에요. 끝나면 미리 볼 수 있어요';
      else if (S.clipBusy && S.clipBusy !== shot.shot) why = '다른 장면의 미리보기를 만드는 중이에요';
      else if (S.clipBusy) why = '약 10초쯤 걸려요';
      else why = '소리도 함께 나와요 · 약 10초쯤 걸려요';
      el.btnClip.disabled = !!(renderPhase() || busyHere || S.clipBusy || !hasPic);
      setText(el.note, why);
      el.btnClip.classList.toggle('busy', S.clipBusy === shot.shot);
      setHidden(el.btnClose, S.mode !== 'clip');
      setHidden(el.btnClip, S.mode === 'clip');
      setHidden(el.btnRow, S.mode === 'clip');
    }

    // --- 카메라 미리 움직이기 ---
    function camFor(shot, move) {
      const fx = fxList(shot);
      if (!move || move === (shot.camera && shot.camera.move)) return window.AMCamera.normalizeCamera(shot.camera || { move: 'hold' }, fx);
      return window.AMCamera.normalizeCamera({ move }, fx);
    }
    function stopAnim(reset) {
      const A = S.anim;
      if (A && A.raf) cancelAnimationFrame(A.raf);
      if (A && A.timer) clearTimeout(A.timer);
      S.anim = null;
      if (S.mode === 'anim') S.mode = 'still';
      setHidden(el.prog, true);
      setHidden(el.reduce, true);
      if (reset) resetStill();
    }
    function resetStill() {
      el.bg.style.transform = ''; el.cel.style.transform = '';
      el.dark.style.opacity = '0'; el.flash.style.opacity = '0'; setHidden(el.sparkles, true);
      el.stage.classList.remove('playing');
      const shot = curShot();
      if (shot) { const src = picSources(snap(), shot, S.selId); setSrc(el.cel, src.cel); setHidden(el.cel, !src.cel); setHidden(el.bg, !src.bg); setText(el.badge, `장면 ${shot.shot}${S.selId === BG ? ' · 🏞 배경만' : ''}`); }
    }
    function playCamera(move, o = {}) {
      const shot = curShot();
      if (!shot || !window.AMCamera) return;
      if (S.mode === 'clip') closeClip(true);
      if (!o.real) stopSound(); // 소리 없이 움직여 볼 때는 소리를 끈다
      stopAnim(false);
      const s = snap();
      const fx = fxList(shot);
      const cam = camFor(shot, move);
      const N = Math.max(2, shot.frames || 72);
      const real = (shot.end - shot.start) || N / FPS;
      const sec = o.real ? Math.max(1.5, real) : clamp(real, 1.5, 6); // 소리와 함께 볼 때는 진짜 길이로
      // 노출 순서대로 그림을 바꿔 보여 준다 (사이 그림은 영상 미리보기에서)
      const rows = []; let acc = 0;
      rowsOf(shot).forEach((r) => { rows.push({ from: acc, id: r.drawing }); acc += r.frames; });
      const urls = new Map();
      if (S.selId !== BG) celIds(shot).forEach((id) => { const it = drawingOf(s, shot.shot, id); const v = celView(it); if (v) { const u = url(s, v.rel, it.updatedAt); urls.set(id, u); const im = new Image(); im.src = u; } });
      const A = {
        shot: shot.shot, cam, fx, N, rows, urls, dur: sec * 1000, t0: 0, waitAudio: !!o.wait, W: el.stage.clientWidth || 640, H: el.stage.clientHeight || 360, lay: isLayered(), raf: 0, timer: 0, state: 0, move: cam.move,
      };
      S.anim = A; S.mode = 'anim';
      el.stage.classList.add('playing');
      const lab = splitLabel(AM.CAMERA_LABEL[cam.move] || cam.move);
      setText(el.badge, `${lab.ico} ${lab.txt}${sec < ((shot.end - shot.start) || 0) - 0.05 ? ' · 빠르게 보여 줘요' : ''}`);
      if (S.reduced) { setHidden(el.reduce, false); showEnd(0); return; }
      setHidden(el.prog, false);
      el.progBar.style.width = '0%';
      A.raf = requestAnimationFrame(tick);
    }
    function frameAt(A, p) {
      const f = Math.min(A.N - 1, Math.max(0, Math.floor(p * A.N)));
      const fr = window.AMCamera.cameraAt(A.cam, A.N > 1 ? f / (A.N - 1) : 0);
      const st = fxAt(A.fx, f, A.N);
      let jx = 0; let jy = 0;
      const amp = (A.cam.move === 'shake' ? (A.cam.shake || 0.012) : 0) + st.shake * 0.02;
      if (amp > 0) { const k = Math.floor(f / 2); jx = (rnd(k, 3) - 0.5) * 2 * amp * A.W; jy = (rnd(k, 4) - 0.5) * 2 * amp * A.H; }
      el.cel.style.transform = tfOf(fr, jx, jy);
      el.bg.style.transform = A.lay ? tfOf(window.AMCamera.parallaxFraming(fr, PARALLAX), jx, jy) : el.cel.style.transform;
      el.dark.style.opacity = String(+(1 - st.fade).toFixed(3));
      el.flash.style.opacity = String(+st.flash.toFixed(3));
      const sp = A.fx.includes('sparkle');
      setHidden(el.sparkles, !sp);
      if (sp) [...el.sparkles.children].forEach((c, k) => { c.style.opacity = String(Math.max(0, Math.sin(f * 0.45 + rnd(k, 5) * 6.283)).toFixed(2)); });
      // 이 순간에 보이는 그림
      if (A.urls.size) {
        let id = A.rows.length ? A.rows[0].id : null;
        for (const r of A.rows) { if (r.from <= f) id = r.id; else break; }
        const u = A.urls.get(id);
        if (u) { setSrc(el.cel, u); setHidden(el.cel, false); }
      }
    }
    function tick(now) {
      const A = S.anim;
      if (!A || S.destroyed) return;
      if (A.waitAudio) { A.t0 = 0; A.raf = requestAnimationFrame(tick); return; } // 소리가 나오기 시작할 때까지 처음 모습으로 기다린다
      if (!A.t0) A.t0 = now;
      const p = clamp((now - A.t0) / A.dur, 0, 1);
      frameAt(A, p);
      el.progBar.style.width = `${(p * 100).toFixed(1)}%`;
      if (p < 1) { A.raf = requestAnimationFrame(tick); return; }
      A.raf = 0;
      A.timer = setTimeout(() => { if (S.anim === A) stopAnim(true); }, 700);
    }
    /** 움직임 줄이기 설정: 처음 모습 / 끝 모습을 눌러 바꿔 본다 */
    function showEnd(end) {
      const A = S.anim;
      if (!A) return;
      A.state = end;
      frameAt(A, end ? 0.999 : 0);
      el.btnStart.setAttribute('aria-pressed', end ? 'false' : 'true');
      el.btnEnd.setAttribute('aria-pressed', end ? 'true' : 'false');
    }

    // --- 소리 들으며 보기: 노래 파일의 이 장면 부분만 들려 주고, 그림·카메라도 같은 길이로 움직여 보인다 (영상을 만들지 않아서 바로 된다) ---
    const songRel = () => { const s = snap(); return (s.music && s.music.song) || (s.song && s.song.file) || ''; };
    function setSoundUi() {
      const on = !!S.audio;
      setText(el.btnSound, on ? '⏹ 소리 끄기' : '🔊 소리 들으며 보기');
      el.btnSound.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    function stopSound() {
      const a = S.audio;
      if (!a) return;
      S.audio = null;
      try { a.pause(); a.removeAttribute('src'); a.load(); } catch (_) { /* noop */ }
      setSoundUi();
    }
    function toggleSound() {
      if (S.audio) { stopSound(); stopAnim(true); return; }
      const shot = curShot(); const rel = songRel();
      if (!shot || !rel) return;
      const a = new Audio();
      a.preload = 'auto';
      S.audio = a;
      setSoundUi();
      const start = shot.start || 0;
      const end = shot.end || start + 5;
      a.addEventListener('loadedmetadata', () => {
        if (S.audio !== a) return;
        try { a.currentTime = start; } catch (_) { /* noop */ }
        const pr = a.play();
        if (pr && pr.catch) pr.catch(() => { if (S.audio === a) { stopSound(); stopAnim(true); } });
      }, { once: true });
      a.addEventListener('playing', () => { if (S.audio === a && S.anim) S.anim.waitAudio = false; });
      a.addEventListener('timeupdate', () => { if (S.audio === a && a.currentTime >= end - 0.03) stopSound(); });
      a.addEventListener('ended', () => { if (S.audio === a) stopSound(); });
      a.addEventListener('error', () => { if (S.audio === a) { stopSound(); stopAnim(true); say('노래를 들려주지 못했어요', 'err'); } });
      a.setAttribute('src', url(snap(), rel));
      playCamera(camMove(shot), { real: true, wait: true });
      if (S.reduced && S.anim) S.anim.waitAudio = false;
    }

    // --- 이 장면 영상으로 미리보기 ---
    function releaseVideo() {
      const v = S.clip;
      if (!v) return;
      try { v.pause(); v.removeAttribute('src'); v.load(); } catch (_) { /* noop */ }
      v.remove();
      S.clip = null;
    }
    function closeClip(silent) {
      releaseVideo();
      if (S.mode === 'clip') S.mode = 'still';
      el.stage.classList.remove('clip');
      if (!silent) { resetStill(); syncStage(); }
    }
    async function makeClip() {
      const shot = curShot();
      if (!shot || S.clipBusy) return;
      stopSound();
      stopAnim(true);
      closeClip(true);
      S.clipBusy = shot.shot;
      syncStage();
      try {
        const r = await api.previewShot(pid(), shot.shot);
        if (S.destroyed || S.sel !== shot.shot) return; // 다른 장면으로 옮겼으면 버린다 (다음에 누르면 금방 나온다)
        openClip(r);
      } catch (e) {
        if (!S.destroyed) say(errText(e), 'err');
      } finally {
        S.clipBusy = 0;
        if (!S.destroyed) syncStage();
      }
    }
    function openClip(r) {
      releaseVideo();
      const v = h('video', { class: 'sc-video', controls: true, playsinline: true, preload: 'auto', 'aria-label': '이 장면 영상 미리보기' });
      v.addEventListener('error', () => { if (S.clip === v) { say('미리보기 영상을 열지 못했어요', 'err'); closeClip(); } });
      // 다른 곳(영상 화면)이 영상 파일을 놓아 주려고 src 를 비우면 빈 검은 상자가 남지 않게 닫는다
      v.addEventListener('emptied', () => { if (S.clip === v && !v.getAttribute('src')) closeClip(); });
      v.setAttribute('src', AM.fileUrl(r.file, Date.now()));
      S.clip = v;
      S.mode = 'clip';
      el.stage.classList.add('clip');
      el.stage.insertBefore(v, el.msg);
      setText(el.badge, `🎞 장면 ${S.sel} 영상${r.hasAudio === false ? '' : ' · 소리도 나와요'}`);
      syncStage();
      const pr = v.play();
      if (pr && pr.catch) pr.catch(noop);
    }

    // ---------- 아래 고치기 칸 ----------
    function sec(emoji, title, hint) {
      return h('div', { class: 'sc-sh' }, h('h3', null, h('span', { class: 'sc-sh-ico', 'aria-hidden': 'true' }, emoji), title), hint ? h('p', { class: 'sc-sh-hint' }, hint) : null);
    }

    function buildPanel() {
      closeHistory();
      clear(el.panel);
      const shot = curShot();
      if (!shot) return;
      const P = {
        head: panelHead(), warn: h('div', { class: 'sc-warn notice warn hidden', role: 'status' }),
        draw: drawSection(), time: timeSection(), cam: camSection(), fx: fxSection(), adv: advSection(),
      };
      S.P = P;
      el.panel.append(P.head.el, P.warn,
        P.draw.el,
        h('div', { class: 'sc-two' }, P.time.el, P.cam.el),
        P.fx.el, P.adv.el);
      syncPanel();
    }
    function syncPanel() {
      const shot = curShot(); const P = S.P;
      if (!shot || !P) return;
      const s = snap();
      if (S.hist) { // 팝오버를 연 사이 이 그림의 기록이 바뀌었으면 닫는다 (보이는 것과 다른 그림으로 돌아가지 않게)
        const it = drawingOf(s, S.hist.shotNo, S.hist.id);
        if (((it && it.history) || []).map((e) => e.file).join('|') !== S.hist.sig) closeHistory();
      }
      const i = shots().indexOf(shot);
      P.head.patch(shot, i);
      const lock = running();
      setHidden(P.warn, !lock);
      if (lock) setText(P.warn, `🎬 지금은 영상을 만드는 중이에요. 끝나면 다시 고칠 수 있어요.${renderPhase() ? '' : ' (그림 다시 그리기·카메라·시간·효과가 잠깐 쉬어요)'}`);
      for (const k of ['draw', 'time', 'cam', 'fx', 'adv']) {
        const sc = P[k];
        const key = sc.struct(shot, s);
        if (key !== sc.key) { sc.key = key; sc.rebuild(shot, s); }
        sc.patch(shot, s);
      }
    }

    // --- 머리 ---
    function panelHead() {
      const title = h('div', { class: 'sc-ptitle' });
      const chips = h('div', { class: 'sc-pchips' });
      const lyric = h('div', { class: 'sc-plyric' });
      const e = h('div', { class: 'sc-phead' }, title, chips, lyric);
      return {
        el: e,
        patch(shot, i) {
          setText(title, `장면 ${shot.shot} · ${fmtTime(shot.start)}~${fmtTime(shot.end)}`);
          const ly = lyricsOf(snap(), i);
          setText(lyric, ly ? `“${ly}”` : '🎵 노래만 나와요');
          const tag = [];
          if (shot.motion) tag.push(['motion', '🏃 움직여요']);
          if (shot.highlight) tag.push(['warn', '⭐ 하이라이트']);
          if (changedSet().has(shot.shot)) tag.push(['pri', '✏️ 고쳤어요']);
          const sig = tag.map((t) => t.join(':')).join('|');
          if (chips.dataset.sig !== sig) { chips.dataset.sig = sig; clear(chips); tag.forEach(([k, t]) => chips.appendChild(h('span', { class: `chip ${k}` }, t))); }
        },
      };
    }

    // --- 🎨 그림 ---
    function drawSection() {
      const grid = h('div', { class: 'sc-tiles' });
      const mnote = h('div', { class: 'sc-mnote hidden' });
      const cutBtn = h('button', { type: 'button', class: 'btn sc-cut hidden', onclick: () => askCut() }, '🔄 이 장면 그림 전부 다시 그리기');
      const box = h('div', { class: 'sc-sec sc-sec-draw' }, sec('🎨', '그림', '고치고 싶은 그림 아래 단추를 눌러요. 그림을 누르면 위 미리보기에 크게 보여요.'), h('div', { class: 'sc-mrow' }, mnote, cutBtn), grid);
      const tiles = new Map();
      const o = { el: box, key: '' };
      o.struct = (shot) => `${isLayered() ? 'L' : 'F'}|${shot.motion ? 'M' : 'H'}|${isLayered() ? BG : ''},${celIds(shot).join(',')}`;
      o.rebuild = (shot) => {
        tiles.clear(); clear(grid);
        const ids = (isLayered() ? [BG] : []).concat(celIds(shot));
        if (S.selId && !ids.includes(S.selId)) S.selId = null; // 그림이 바뀌어 없어졌으면 첫 그림으로
        ids.forEach((id) => { const t = buildTile(shot, id); tiles.set(id, t); grid.appendChild(t.el); });
        grid.classList.toggle('scroll', !!shot.motion || ids.length > 5);
      };
      o.patch = (shot, s) => {
        tiles.forEach((t) => patchTile(t, shot, s));
        const xs = s.xsheet || {};
        setHidden(mnote, !shot.motion); setHidden(cutBtn, !shot.motion);
        if (shot.motion) {
          setText(mnote, `🏃 움직이는 장면 · 1초에 ${xs.keyRate || 6}장`);
          const n = (isLayered() ? 1 : 0) + celIds(shot).length;
          cutBtn.dataset.n = String(n);
          cutBtn.disabled = running();
          cutBtn.title = running() ? '지금은 영상을 만드는 중이에요' : '';
        }
      };
      return o;
    }
    function buildTile(shot, id) {
      const t = { id };
      const isBg = id === BG;
      t.img = h('img', { class: 'sc-tim', alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
      t.name = h('span', { class: 'sc-tname' }, isBg ? '🏞 배경' : `${id} · ${idLabel(shot, id)}`);
      t.mark = h('span', { class: 'sc-tmark hidden' });
      t.ph = h('span', { class: 'sc-tph hidden' });
      t.spin = h('span', { class: 'sc-tspin hidden' }, AM.kit.spinner());
      t.thumb = h('button', { type: 'button', class: 'sc-tthumb', 'aria-pressed': 'false', onclick: () => pickShow(id) }, t.img, t.ph, t.name, t.mark, t.spin);
      t.stat = h('div', { class: 'sc-tstat', 'aria-live': 'polite' });
      t.note = h('div', { class: 'sc-tnote hidden' });
      t.err = h('div', { class: 'sc-terr hidden' });
      t.bRedo = h('button', { type: 'button', class: 'btn sc-tbtn', onclick: () => askRedo(shot.shot, id) }, '🔄 다시 그리기');
      t.bMine = h('button', { type: 'button', class: 'btn sc-tbtn', onclick: () => askMine(shot.shot, id) }, '🖼 내 그림으로');
      t.bBack = h('button', { type: 'button', class: 'btn sc-tbtn hidden', onclick: () => openHistory(t.bBack, shot.shot, id) }, '↩ 이전 그림');
      t.el = h('div', { class: 'sc-tile', dataset: { id } }, t.thumb, t.stat, t.note, t.err, h('div', { class: 'sc-tbtns' }, t.bRedo, t.bMine, t.bBack));
      // 그림 파일을 끌어다 놓아도 바뀐다 (끌어놓기는 덤 — 단추로도 다 된다)
      t.el.addEventListener('dragover', (e) => { if (!canReplace(shot.shot, id)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; t.el.classList.add('drop'); });
      t.el.addEventListener('dragleave', () => t.el.classList.remove('drop'));
      t.el.addEventListener('drop', (e) => {
        e.preventDefault(); t.el.classList.remove('drop');
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!f || !canReplace(shot.shot, id)) return;
        const p = api.pathForFile ? api.pathForFile(f) : f.path;
        if (!p) { say('그림 파일을 찾지 못했어요. [🖼 내 그림으로] 단추로 골라 주세요.', 'err'); return; }
        doMine(shot.shot, id, p);
      });
      return t;
    }
    function canReplace(n, id) { return !renderPhase() && !redrawOf(n, id); }
    function patchTile(t, shot, s) {
      const it = drawingOf(s, shot.shot, t.id);
      const rd = redrawOf(shot.shot, t.id);
      const v = celView(it);
      setSrc(t.img, v ? url(s, v.rel, it.updatedAt) : '');
      t.thumb.classList.toggle('checker', !!(v && v.checker));
      t.thumb.classList.toggle('empty', !v);
      const sel = (S.selId || celIds(shot)[0]) === t.id;
      t.el.classList.toggle('sel', sel);
      t.thumb.setAttribute('aria-pressed', sel ? 'true' : 'false');
      t.thumb.setAttribute('aria-label', `${t.id === BG ? '배경' : `그림 ${t.id}`} 크게 보기`);
      let st = '';
      let kind = 'ok';
      if (rd === 'running' || (it && it.status === 'running')) { st = '그리는 중…'; kind = 'busy'; }
      else if (rd === 'queued') { st = '기다리는 중'; kind = 'wait'; }
      else if (!it || !it.file) { st = it && it.status === 'error' ? '⚠ 문제 있어요' : '아직 그리지 못했어요'; kind = it && it.status === 'error' ? 'err' : 'none'; }
      else if (it.error || it.status === 'error') { st = '⚠ 문제 있어요'; kind = 'err'; }
      else if (it.source === 'user') { st = '🖼 내 그림'; kind = 'mine'; }
      else if (it.custom || it.note) { st = '✏️ 내가 바꿈'; kind = 'mine'; }
      setText(t.stat, st);
      t.stat.dataset.kind = kind;
      setHidden(t.spin, !(kind === 'busy' || kind === 'wait'));
      setText(t.ph, !v ? (kind === 'busy' ? '그리는 중…' : '아직 그리지 못했어요') : '');
      setHidden(t.ph, !!v);
      const note = it && it.note && !it.error ? `“${it.note}”` : '';
      setText(t.note, note); setHidden(t.note, !note);
      const err = it && it.error ? String(it.error) : '';
      setText(t.err, err); t.err.title = err; setHidden(t.err, !err || kind === 'busy');
      const lock = running();
      t.bRedo.disabled = lock || !it;
      t.bRedo.title = lock ? '지금은 영상을 만드는 중이에요' : '';
      const can = canReplace(shot.shot, t.id) && !!it;
      t.bMine.disabled = !can;
      t.bMine.title = !can && rd ? '이 그림은 지금 그리는 중이에요' : renderPhase() ? '지금은 영상을 만드는 중이에요' : '';
      const hist = (it && it.history) || [];
      setHidden(t.bBack, !hist.length);
      t.bBack.disabled = !can;
      t.bBack.title = hist.length ? `이전 그림 ${hist.length}장` : '';
    }
    function pickShow(id) {
      if (S.mode === 'clip') closeClip(true);
      stopSound();
      stopAnim(false);
      S.selId = id;
      resetStill();
      syncStage();
      syncPanel();
    }

    // 다시 그리기 (작은 시트)
    function payLine() {
      const pv = snap().providers || (AM.state.settings && AM.state.settings.providers) || {};
      const info = AM.providerInfo('image', pv.image);
      return info.mode === 'demo' ? '연습 모드 · 무료' : 'AI 가 그려요 · 구독 사용량이 조금 들어요';
    }
    function askRedo(shotNo, id) {
      const shot = shots().find((x) => x.shot === shotNo);
      const name = id === BG ? '배경' : `그림 ${id}`;
      const input = h('input', { type: 'text', class: 'sc-note-in', maxlength: '120', placeholder: '예: 웃는 얼굴로, 우산을 들고', 'aria-label': '어떻게 바꿀까요?', autocomplete: 'off' });
      const starters = [['😊 표정 바꾸기', '활짝 웃는 얼굴로'], ['🙌 자세 바꾸기', '두 손을 번쩍 든 자세로'], ['✨ 그냥 새로 그리기', '']];
      const chips = starters.map(([label, phrase]) => h('button', {
        type: 'button', class: 'sc-chip', 'aria-pressed': 'false',
        onclick: () => { input.value = phrase; input.focus(); sync(); },
      }, label));
      const body = h('div', { class: 'sc-redo' },
        h('p', { class: 'sc-q' }, '어떻게 바꿀까요?'),
        input,
        h('div', { class: 'sc-chips' }, chips),
        h('p', { class: 'sc-pay' }, `💰 ${payLine()}`),
        h('p', { class: 'sc-sheet-hint' }, '지금 그림은 저장돼요. 마음에 안 들면 ↩ 이전 그림으로 돌아갈 수 있어요.'));
      let m = null;
      const go = () => { const note = input.value.trim(); m.close(); startRedo(shotNo, id, note); };
      m = AM.kit.sheet(`🔄 장면 ${shotNo} · ${shot ? idLabel(shot, id) : name} 다시 그리기`, body, [
        { label: '취소' },
        { label: '🔄 그냥 새로 그리기', kind: 'primary', onClick: () => { go(); return true; } },
      ], { width: 'min(560px, 94vw)' });
      const okBtn = m.box.querySelectorAll('.foot .btn')[1];
      function sync() {
        const has = !!input.value.trim();
        if (okBtn) okBtn.textContent = has ? '🔄 이렇게 다시 그리기' : '🔄 그냥 새로 그리기';
        chips.forEach((c, k) => c.setAttribute('aria-pressed', (k === 2 ? !has : (has && input.value === starters[k][1])) ? 'true' : 'false'));
      }
      input.addEventListener('input', sync);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      sync();
      setTimeout(() => input.focus(), 30);
    }
    function startRedo(shotNo, id, note) {
      const key = `${shotNo}:${id}`;
      S.local.add(key);
      touch(shotNo);
      syncPanel(); syncStrip();
      const opts = { id };
      if (note) opts.note = note;
      say(note ? '이렇게 다시 그려 볼게요 🎨' : '새로 그려 볼게요 🎨', undefined);
      // 그림이 다 그려질 때까지 기다리지 않는다: 그리는 중 표시는 snap.redrawing 이 보여 준다
      Promise.resolve().then(() => api.regenerate(pid(), 'drawing', shotNo, opts)).then((r) => {
        if (r && r.cancelled) say('그림 그리기를 멈췄어요', undefined);
        else if (r && r.skipped) say('이 그림은 건너뛰었어요. 그림은 그대로예요', undefined);
        else if (r && r.error) say(errText(r.error), 'err');
        else say(`🎨 장면 ${shotNo}의 새 그림이 왔어요`, 'ok');
      }, (e) => { say(errText(e), 'err'); }).then(() => { S.local.delete(key); schedule(); });
    }

    // 이 장면 그림 전부 다시 그리기 (움직이는 장면)
    function askCut() {
      const shot = curShot();
      if (!shot) return;
      const n = (isLayered() ? 1 : 0) + celIds(shot).length;
      const body = h('div', { class: 'sc-redo' },
        h('p', { class: 'sc-q' }, `그림 ${n}장을 차례로 다시 그려요 · 시간이 걸려요`),
        h('p', { class: 'sc-sheet-hint' }, '움직이는 장면은 그림이 서로 이어져야 해서, 배경부터 차례로 전부 새로 그려요. 지금 그림은 저장돼서 ↩ 이전 그림으로 돌아올 수 있어요.'),
        h('p', { class: 'sc-pay' }, `💰 ${payLine()}`));
      AM.kit.sheet(`🔄 장면 ${shot.shot} 그림 전부 다시 그리기`, body, [
        { label: '취소' },
        {
          label: `🔄 ${n}장 다시 그리기`, kind: 'primary',
          onClick: () => {
            const keys = [(isLayered() ? [BG] : []), celIds(shot)].flat().map((id) => `${shot.shot}:${id}`);
            keys.forEach((k) => S.local.add(k));
            touch(shot.shot); syncPanel(); syncStrip();
            say('차례로 다시 그려 볼게요 🎨', undefined);
            Promise.resolve().then(() => api.regenerateCut(pid(), shot.shot)).then((r) => {
              if (r && r.cancelled) say('그림 그리기를 멈췄어요', undefined); else say(`🎨 장면 ${shot.shot}의 그림을 모두 새로 그렸어요`, 'ok');
            }, (e) => say(errText(e), 'err')).then(() => { keys.forEach((k) => S.local.delete(k)); schedule(); });
          },
        },
      ], { width: 'min(560px, 94vw)' });
    }

    // 내 그림으로
    function askMine(shotNo, id) {
      const isBg = id === BG;
      const drop = h('div', { class: 'sc-drop' }, h('span', { 'aria-hidden': 'true' }, '📥'), ' 여기에 그림 파일을 끌어다 놓아도 돼요');
      let m = null;
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', (e) => {
        e.preventDefault(); drop.classList.remove('over');
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        const p = f && (api.pathForFile ? api.pathForFile(f) : f.path);
        if (f && !p) { say('그림 파일을 찾지 못했어요. [📁 그림 고르기] 단추를 눌러 주세요.', 'err'); return; }
        if (p) { m.close(); doMine(shotNo, id, p); }
      });
      const body = h('div', { class: 'sc-redo' },
        h('p', { class: 'sc-q' }, isBg ? '내 그림이나 사진을 배경으로 써요.' : '내가 그린 그림이나 사진으로 바꿔요.'),
        h('p', { class: 'sc-hintbig' }, isBg ? '💡 그림 전체가 배경으로 쓰여요.' : '💡 투명 PNG 나 한 가지 색 배경이면 인물만 쏙 빠져요.'),
        drop,
        h('p', { class: 'sc-sheet-hint' }, 'png · jpg · webp 그림 파일을 고를 수 있어요. 지금 그림은 저장돼서 ↩ 이전 그림으로 돌아올 수 있어요.'));
      m = AM.kit.sheet('🖼 내 그림으로 바꾸기', body, [
        { label: '취소' },
        {
          label: '📁 그림 고르기', kind: 'primary',
          onClick: async () => {
            const f = await api.pickFile({ filters: [{ name: '그림', extensions: IMG_EXT }] });
            if (!f) return true; // 고르지 않았으면 이 창에 그대로 있는다
            doMine(shotNo, id, f);
            return undefined;
          },
        },
      ], { width: 'min(560px, 94vw)' });
    }
    async function doMine(shotNo, id, file) {
      if (!file) return;
      if (!IMG_EXT.includes(String(file).split('.').pop().toLowerCase())) { say('그림 파일(png, jpg, webp)을 골라 주세요.', 'err'); return; }
      const res = await attempt(() => api.replaceItem(pid(), 'drawing', shotNo, file, id, {}), '🖼 내 그림으로 바꿨어요');
      if (res.ok) { touch(shotNo); if (S.sel === shotNo) S.selId = id; schedule(); }
    }

    // 이전 그림 (작은 팝오버)
    function closeHistory() {
      const H = S.hist;
      if (!H) return;
      H.pop.remove();
      document.removeEventListener('mousedown', H.onDoc, true);
      document.removeEventListener('keydown', H.onKey, true);
      window.removeEventListener('resize', closeHistory);
      S.hist = null;
    }
    function openHistory(anchor, shotNo, id) {
      closeHistory();
      const s = snap();
      const it = drawingOf(s, shotNo, id);
      const hist = (it && it.history) || [];
      if (!hist.length) return;
      const keyed = id !== BG && isLayered() && String((s.xsheet && s.xsheet.keyColor) || '').toLowerCase() === '#00ff00';
      const items = hist.map((e, k) => h('button', {
        type: 'button', class: 'sc-hitem', title: e.note ? `“${e.note}”` : '',
        onclick: () => { closeHistory(); doRestore(shotNo, id, k); },
      },
      h('span', { class: `sc-hthumb${keyed && e.kind !== 'user' ? ' checker' : ''}` }, h('img', { src: url(s, e.file, e.at), alt: '', draggable: 'false', style: keyed && e.kind !== 'user' ? { filter: 'url(#sc-key-green)' } : null })),
      h('span', { class: 'sc-hlabel' }, k === 0 ? '방금 전' : `${k + 1}번 전`),
      h('span', { class: 'sc-hsub' }, e.note ? `“${e.note}”` : e.kind === 'user' ? '🖼 내 그림' : '')));
      const pop = h('div', { class: 'sc-hist', role: 'dialog', 'aria-label': '이전 그림 고르기' },
        h('div', { class: 'sc-hist-title' }, '↩ 어떤 그림으로 돌아갈까요?'),
        h('div', { class: 'sc-hist-list' }, items),
        h('div', { class: 'sc-hist-foot' }, '지금 그림은 저장돼요. 다시 ↩ 를 눌러 돌아올 수 있어요.'));
      pop.style.setProperty('--sc-ar', root.style.getPropertyValue('--sc-ar') || '16 / 9');
      const sig = hist.map((e) => e.file).join('|');
      document.body.appendChild(pop);
      const r = anchor.getBoundingClientRect();
      const pr = pop.getBoundingClientRect();
      let left = r.left;
      if (left + pr.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - pr.width - 8);
      let top = r.bottom + 6;
      if (top + pr.height > window.innerHeight - 8) top = Math.max(8, r.top - pr.height - 6);
      pop.style.left = `${left}px`; pop.style.top = `${top}px`;
      const onDoc = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) closeHistory(); };
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeHistory(); anchor.focus(); } };
      document.addEventListener('mousedown', onDoc, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', closeHistory);
      S.hist = { pop, onDoc, onKey, shotNo, id, sig };
      const first = pop.querySelector('.sc-hitem');
      if (first) first.focus();
    }
    async function doRestore(shotNo, id, index) {
      const res = await attempt(() => api.restoreVersion(pid(), shotNo, id, index), '↩ 이전 그림으로 되돌렸어요');
      if (res.ok) { touch(shotNo); if (S.sel === shotNo) S.selId = id; schedule(); }
    }

    // --- ⏱ 보여 주는 시간 ---
    function timeSection() {
      const body = h('div', { class: 'sc-rows' });
      const foot = h('p', { class: 'sc-foot' });
      const box = h('div', { class: 'sc-sec sc-sec-time' }, sec('⏱', '보여 주는 시간', '그림을 몇 초 동안 보여 줄지 정해요.'), body, foot);
      const rowsEl = [];
      const o = { el: box, key: '' };
      o.struct = (shot) => (shot.motion ? 'M' : rowsOf(shot).length < 2 ? 'one' : `rows:${rowsOf(shot).map((r) => r.drawing).join(',')}`);
      o.rebuild = (shot, s) => {
        clear(body); rowsEl.length = 0;
        if (shot.motion) {
          body.appendChild(h('div', { class: 'sc-info' }, `🏃 움직이는 장면이에요. 그림이 1초에 ${(s.xsheet && s.xsheet.keyRate) || 6}장씩 빠르게 바뀌어서 한 장씩 시간을 고치지 않아도 돼요. (자세히 고치려면 아래 '고급' 을 열어요)`));
          return;
        }
        if (rowsOf(shot).length < 2) {
          body.appendChild(h('div', { class: 'sc-info' }, '그림이 한 장이라 바꿀 시간이 없어요. 이 장면은 한 장을 계속 보여 줘요.'));
          return;
        }
        rowsOf(shot).forEach((r, k) => {
          const img = h('img', { class: 'sc-rimg', alt: '', draggable: 'false' });
          const name = h('span', { class: 'sc-rname' });
          const val = h('output', { class: 'sc-rval', 'aria-live': 'polite' });
          const minus = h('button', { type: 'button', class: 'btn sc-step', 'aria-label': '조금 짧게 (0.25초)', onclick: () => retimeBy(shot.shot, k, -STEP_FR) }, '−');
          const plus = h('button', { type: 'button', class: 'btn sc-step', 'aria-label': '조금 길게 (0.25초)', onclick: () => retimeBy(shot.shot, k, STEP_FR) }, '+');
          const bar = h('i');
          const row = h('div', { class: 'sc-row' }, h('span', { class: 'sc-rthumb' }, img), h('span', { class: 'sc-rtxt' }, name, h('span', { class: 'sc-rbar' }, bar)), h('span', { class: 'sc-stepper' }, minus, val, plus));
          body.appendChild(row);
          rowsEl.push({ img, name, val, minus, plus, bar, row });
        });
      };
      o.patch = (shot, s) => {
        const total = shot.frames || 1;
        const rows = rowsOf(shot);
        setText(foot, shot.motion || rows.length < 2
          ? `장면 길이 ${secText(total)} · 노래 박자에 맞춰져 있어서 그대로예요`
          : `장면 길이 ${secText(total)}는 그대로예요 · 이 그림을 길게 보여 주면 다음 그림이 짧아져요`);
        if (shot.motion || rows.length < 2) return;
        const lock = running() || S.retiming.has(shot.shot);
        rows.forEach((r, k) => {
          const e = rowsEl[k];
          if (!e) return;
          const it = drawingOf(s, shot.shot, r.drawing);
          const v = celView(it);
          setSrc(e.img, v ? url(s, v.rel, it.updatedAt) : '');
          e.img.parentNode.classList.toggle('checker', !!(v && v.checker));
          setText(e.name, `${k + 1}. ${r.drawing === celIds(shot)[0] ? '첫 그림' : '다음 그림'} (${r.drawing})`);
          setText(e.val, secText(r.frames));
          e.bar.style.width = `${(r.frames / total) * 100}%`;
          const other = rows[k + 1 < rows.length ? k + 1 : k - 1];
          const room = r.frames + other.frames - 1;
          e.minus.disabled = lock || r.frames <= MIN_FR;
          e.plus.disabled = lock || r.frames >= room;
          e.minus.title = running() ? '지금은 영상을 만드는 중이에요' : r.frames <= MIN_FR ? '더 짧게 할 수 없어요' : '';
          e.plus.title = running() ? '지금은 영상을 만드는 중이에요' : r.frames >= room ? '다음 그림이 더 짧아질 수 없어요' : '';
        });
      };
      return o;
    }
    async function retimeBy(shotNo, k, delta) {
      const shot = shots().find((x) => x.shot === shotNo);
      if (!shot || S.retiming.has(shotNo)) return;
      const rows = rowsOf(shot);
      const want = Math.max(MIN_FR, rows[k].frames + delta);
      S.retiming.add(shotNo);
      // 바로 눈에 보이게 먼저 바꿔 보이고, 진짜 값은 돌아오는 대로 맞춘다
      const guess = rows.map((r) => ({ ...r }));
      const other = k + 1 < guess.length ? k + 1 : k - 1;
      const v = Math.min(want, guess[k].frames + guess[other].frames - 1);
      guess[other].frames -= v - guess[k].frames; guess[k].frames = v;
      S.expOv.set(shotNo, guess); syncPanel();
      const res = await attempt(() => api.retime(pid(), shotNo, k, want));
      S.retiming.delete(shotNo);
      if (res.ok) { touch(shotNo); if (res.r && Array.isArray(res.r.exposure)) S.expOv.set(shotNo, res.r.exposure.map((r) => ({ ...r }))); else S.expOv.delete(shotNo); } else S.expOv.delete(shotNo);
      syncPanel(); syncStrip();
    }

    // --- 🎥 카메라 ---
    function camSection() {
      const btns = new Map();
      const wrap = h('div', { class: 'sc-cams', role: 'group', 'aria-label': '카메라 움직임' });
      const moves = (window.AMCamera && window.AMCamera.CAMERA_MOVES) || Object.keys(AM.CAMERA_LABEL);
      moves.filter((m) => AM.CAMERA_LABEL[m]).forEach((m) => {
        const lab = splitLabel(AM.CAMERA_LABEL[m]);
        const b = h('button', { type: 'button', class: 'sc-cam', 'aria-pressed': 'false', onclick: () => setCam(m) }, h('span', { class: 'sc-cam-ico', 'aria-hidden': 'true' }, lab.ico), h('span', { class: 'sc-cam-txt' }, lab.txt));
        btns.set(m, b); wrap.appendChild(b);
      });
      const box = h('div', { class: 'sc-sec sc-sec-cam' }, sec('🎥', '카메라', '누르면 위 미리보기에서 바로 움직여 보여요.'), wrap);
      const o = { el: box, key: '' };
      o.struct = () => 'cam';
      o.rebuild = noop;
      o.patch = (shot) => {
        const cur = camMove(shot);
        const lock = running();
        btns.forEach((b, m) => { b.setAttribute('aria-pressed', m === cur ? 'true' : 'false'); b.classList.toggle('sel', m === cur); b.disabled = lock; b.title = lock ? '지금은 영상을 만드는 중이에요' : ''; });
      };
      return o;
    }
    async function setCam(move) {
      const shot = curShot();
      if (!shot) return;
      const had = camMove(shot);
      playCamera(move); // 바로 움직여 보인다
      if (had === move) return;
      S.opt.set(`cam:${shot.shot}`, move); syncPanel();
      const res = await attempt(() => api.setCamera(pid(), shot.shot, move));
      S.opt.delete(`cam:${shot.shot}`);
      if (res.ok) touch(shot.shot); else stopAnim(true);
      syncPanel(); syncStrip();
    }

    // --- ✨ 효과 · 다음 장면으로 ---
    function fxSection() {
      const fxBtns = new Map(); const trBtns = new Map();
      const fxWrap = h('div', { class: 'sc-chips', role: 'group', 'aria-label': '효과' });
      FX_ORDER.filter((k) => AM.FX_LABEL[k]).forEach((k) => {
        const b = h('button', { type: 'button', class: 'sc-chip', 'aria-pressed': 'false', onclick: () => toggleFx(k) }, AM.FX_LABEL[k]);
        fxBtns.set(k, b); fxWrap.appendChild(b);
      });
      const trWrap = h('div', { class: 'sc-chips', role: 'group', 'aria-label': '다음 장면으로 넘어가는 모양' });
      TR_ORDER.filter((k) => TL[k]).forEach((k) => {
        const b = h('button', { type: 'button', class: 'sc-chip', 'aria-pressed': 'false', title: TRANSITION_TIP[k] || '', onclick: () => setTr(k) }, TL[k]);
        trBtns.set(k, b); trWrap.appendChild(b);
      });
      const trLast = h('div', { class: 'sc-info hidden' }, '마지막 장면이라 다음 장면이 없어요.');
      const fxFoot = h('p', { class: 'sc-foot' }, '효과는 한 장면에 3개까지 쓸 수 있어요.');
      const trFoot = h('p', { class: 'sc-foot' });
      const box = h('div', { class: 'sc-sec sc-sec-fx' },
        sec('✨', '효과', '장면이 시작할 때나 끝날 때 반짝 보이는 꾸밈이에요. 누르면 위에서 보여 줘요.'), fxWrap, fxFoot,
        h('div', { class: 'sc-sep' }),
        sec('➡️', '다음 장면으로 넘어갈 때', '이 장면이 끝나고 다음 장면으로 바뀌는 모양이에요.'), trWrap, trLast, trFoot);
      const o = { el: box, key: '' };
      o.struct = () => 'fx';
      o.rebuild = noop;
      o.patch = (shot) => {
        const list = fxList(shot);
        const lock = running();
        fxBtns.forEach((b, k) => { const on = list.includes(k); b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.disabled = lock; b.title = lock ? '지금은 영상을 만드는 중이에요' : ''; });
        const i = shots().indexOf(shot);
        const last = i >= shots().length - 1;
        const cur = trOf(shot);
        trBtns.forEach((b, k) => { b.setAttribute('aria-pressed', k === cur ? 'true' : 'false'); b.disabled = lock; setHidden(b, last); });
        setHidden(trLast, !last);
        setText(trFoot, last ? '' : `지금은 “${(TL[cur] || cur).replace(/^\S+\s/, '')}” 이에요 · ${TRANSITION_TIP[cur] || ''}`);
        setHidden(trFoot, last);
      };
      return o;
    }
    async function toggleFx(type) {
      const shot = curShot();
      if (!shot) return;
      const cur = fxList(shot);
      const has = cur.includes(type);
      if (!has && cur.length >= MAX_FX) { say('효과는 한 장면에 3개까지만 쓸 수 있어요. 하나를 먼저 꺼 주세요.', undefined); return; }
      const next = has ? cur.filter((x) => x !== type) : [...cur, type];
      S.opt.set(`fx:${shot.shot}`, next); syncPanel();
      if (!has) playCamera(camMove(shot)); // 켠 효과를 바로 보여 준다
      const res = await attempt(() => api.setFx(pid(), shot.shot, next));
      S.opt.delete(`fx:${shot.shot}`);
      if (res.ok) touch(shot.shot);
      syncPanel(); syncStrip();
    }
    async function setTr(type) {
      const shot = curShot();
      if (!shot || trOf(shot) === type) return;
      const list = shots();
      const nxt = list[list.indexOf(shot) + 1];
      S.opt.set(`tr:${shot.shot}`, type); syncPanel();
      const res = await attempt(() => api.setTransition(pid(), shot.shot, type));
      S.opt.delete(`tr:${shot.shot}`);
      if (res.ok) touch(shot.shot, nxt && nxt.shot);
      syncPanel(); syncStrip();
    }

    // --- 고급 (영어 그림 주문 글 · 프레임 표) ---
    function advSection() {
      const fold = AM.kit.fold('🔧 고급 — 그림 주문 글 · 프레임 표', null, { lazy: () => advBody(), class: 'sc-fold' });
      const o = { el: h('div', { class: 'sc-sec sc-sec-adv' }, fold), key: '' };
      o.struct = (shot) => `${celIds(shot).join(',')}|${rowsOf(shot).length}|${shot.shot}`;
      o.rebuild = () => { if (fold.refill) fold.refill(); };
      o.patch = (shot, s) => {
        if (!fold.open) return;
        const sc = fold.querySelector('.sc-adv');
        if (!sc || (sc.contains(document.activeElement) && document.activeElement !== sc)) return; // 입력 중인 칸은 건드리지 않는다
        advPatch(sc, shot, s);
      };
      return o;
    }
    function advBody() {
      const shot = curShot(); const s = snap();
      const wrap = h('div', { class: 'sc-adv' });
      if (!shot) return wrap;
      wrap.appendChild(h('h4', null, '그림 주문 글 (영어)'));
      wrap.appendChild(h('p', { class: 'sc-sheet-hint' }, '영어로 쓴 그림 주문 글을 직접 고칠 수 있어요. 고친 뒤 [이 글로 다시 그리기] 를 누르세요. 주인공 설명 부분은 지우지 마세요.'));
      ((isLayered() ? [BG] : []).concat(celIds(shot))).forEach((id) => {
        const it = drawingOf(s, shot.shot, id);
        const ta = h('textarea', { rows: '4', class: 'sc-prompt', 'aria-label': `${id === BG ? '배경' : `그림 ${id}`} 주문 글`, dataset: { id } });
        ta.value = (it && it.prompt) || '';
        ta.dataset.base = ta.value;
        const go = h('button', { type: 'button', class: 'btn sc-tbtn', onclick: () => startRedoPrompt(shot.shot, id, ta.value.trim()) }, '🔄 이 글로 다시 그리기');
        wrap.appendChild(h('div', { class: 'sc-prow', dataset: { id } }, h('b', null, id === BG ? '🏞 배경' : `그림 ${id}`), ta, go));
      });
      wrap.appendChild(h('h4', null, '프레임 표'));
      wrap.appendChild(h('div', { class: 'sc-ftable' }));
      advPatch(wrap, shot, s);
      return wrap;
    }
    function advPatch(wrap, shot, s) {
      wrap.querySelectorAll('.sc-prompt').forEach((ta) => {
        const it = drawingOf(s, shot.shot, ta.dataset.id);
        const base = (it && it.prompt) || '';
        if (ta.value === ta.dataset.base && ta.value !== base) { ta.value = base; ta.dataset.base = base; }
        ta.nextSibling.disabled = running() || !it;
      });
      const host2 = wrap.querySelector('.sc-ftable');
      const rows = rowsOf(shot);
      const sig = rows.map((r) => `${r.drawing}${r.frames}`).join(',') + running();
      if (host2.dataset.sig === sig) return;
      host2.dataset.sig = sig;
      clear(host2);
      let acc = 0;
      const lock = running() || rows.length < 2 || S.retiming.has(shot.shot);
      host2.appendChild(h('table', { class: 'sc-table' },
        h('thead', null, h('tr', null, ['순서', '그림', '보여 주는 길이 (프레임)', '몇 초부터', '초'].map((t) => h('th', null, t)))),
        h('tbody', null, rows.map((r, k) => {
          const start = acc; acc += r.frames;
          const inp = h('input', { type: 'number', min: '1', max: String(shot.frames || 999), value: r.frames, disabled: lock, 'aria-label': `${k + 1}번째 그림 프레임`, onchange: (e) => { advRetime(shot.shot, k, Number(e.target.value)); } });
          return h('tr', null, h('td', null, String(k + 1)), h('td', null, r.drawing), h('td', null, inp), h('td', null, +(start / FPS).toFixed(2)), h('td', null, +(r.frames / FPS).toFixed(2)));
        }))));
      if (rows.length < 2) host2.appendChild(h('p', { class: 'sc-sheet-hint' }, '그림이 한 장뿐이라 바꿀 수 없어요.'));
      else host2.appendChild(h('p', { class: 'sc-sheet-hint' }, `1초 = ${FPS}프레임. 장면 길이(${shot.frames}프레임)는 그대로라서, 다음 칸이 늘거나 줄어 맞춰져요.`));
    }
    async function advRetime(shotNo, k, frames) {
      if (!Number.isFinite(frames) || frames < 1) return;
      const res = await attempt(() => api.retime(pid(), shotNo, k, frames), '시간을 바꿨어요');
      if (res.ok) { touch(shotNo); if (res.r && Array.isArray(res.r.exposure)) S.expOv.set(shotNo, res.r.exposure.map((r) => ({ ...r }))); }
      syncPanel(); syncStrip();
    }
    function startRedoPrompt(shotNo, id, prompt) {
      const key = `${shotNo}:${id}`;
      S.local.add(key); touch(shotNo); syncPanel(); syncStrip();
      say('이 글로 다시 그려 볼게요 🎨', undefined);
      Promise.resolve().then(() => api.regenerate(pid(), 'drawing', shotNo, { id, prompt })).then((r) => {
        if (r && r.error) say(errText(r.error), 'err'); else say(`🎨 장면 ${shotNo}의 새 그림이 왔어요`, 'ok');
      }, (e) => say(errText(e), 'err')).then(() => { S.local.delete(key); schedule(); });
    }

    // ---------- 갱신 ----------
    function tryBuild() {
      const list = shots();
      const has = list.length > 0;
      setHidden(el.empty, has);
      setHidden(el.top, !has);
      setHidden(el.panel, !has);
      if (!has) return;
      if (!S.built) {
        S.built = true;
        syncStrip();
        const want = ctx.focusShot != null && list.find((x) => x.shot === ctx.focusShot);
        const edited = list.find((x) => changedSet().has(x.shot));
        selectScene((want || edited || list[0]).shot, { smooth: false });
        requestAnimationFrame(() => centerCard(S.sel, false));
      }
    }
    function flush() {
      if (S.destroyed) return;
      tryBuild();
      if (!S.built) return;
      const list = shots();
      if (!list.some((x) => x.shot === S.sel)) { selectScene((list.find((x) => x.shot > S.sel) || list[list.length - 1]).shot); return; }
      syncStrip();
      syncStage();
      syncPanel();
      const busy = redrawList().length > 0;
      if (busy !== S.redrawing) { S.redrawing = busy; if (ctx.onBusy) { try { ctx.onBusy(busy); } catch (_) { /* noop */ } } }
    }

    tryBuild();
    if (S.built) flush();

    return {
      update(next) {
        if (S.destroyed || !next) return;
        S.snap = next;
        // 서버 값이 돌아왔으면 눈속임으로 보여 준 값은 놓는다
        for (const [n, ov] of [...S.expOv]) {
          const sh = shots().find((x) => x.shot === n);
          if (!sh || JSON.stringify((sh.exposure || []).map((r) => [r.drawing, r.frames])) === JSON.stringify(ov.map((r) => [r.drawing, r.frames])) || S.retiming.has(n) === false) S.expOv.delete(n);
        }
        schedule();
      },
      destroy() {
        if (S.destroyed) return;
        S.destroyed = true;
        if (S.raf) cancelAnimationFrame(S.raf);
        stopSound();
        stopAnim(false);
        closeHistory();
        releaseVideo();
        if (mq && mq.removeEventListener) mq.removeEventListener('change', onMq);
        window.removeEventListener('resize', onResize);
        if (ro) ro.disconnect();
        if (S.redrawing && ctx.onBusy) { try { ctx.onBusy(false); } catch (_) { /* noop */ } }
        root.remove();
      },
    };
  }

  AM.scenes = { mount };
}(window.AM));
