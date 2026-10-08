// ✏️ 장면 고치기 (간단) — 폰 판. 위: 장면 미리보기(합성기가 영상과 같은 그림으로 그린다) · 가운데: 장면 띠 · 아래: 네 가지 고치기
//   🎨 그림 (다시 부탁하기 · 내 그림으로 · 이전 그림) | ⏱ 시간 (0.25초씩) | 🎥 카메라 (10개) | ✨ 효과 · 다음 장면으로
//   mountScenes(host, ctx) → { update(snap), destroy(), isDirty(), confirmLeave() }   ctx = { id, engine, getSnap(), toast, onClose(info?), ui, native? }
//   고친 것은 바로 엔진에 적히고(고친 장면에 ✏️), 영상에는 [✨ 고친 것 반영하기] 를 눌러야 들어간다. 폰은 영상을 처음부터 다시 만든다(장면별 캐시 없음) — 시간 어림에 그대로 적는다.
import { h, clear, toast as toastDefault, bottomSheet, busy, pickFile } from '../ui.js';
import { createPreview, renderStill, buildLayout, FPS } from '../engine/render/index.js';
import { X, T } from '../engine/shared.js';
import { createUrlBox, createApplyBar, vibrate, fmtClock, friendly } from './done-parts.js';

const BG = 'bg';
const STEP_FR = 6; // 0.25초
const MIN_FR = 6;
const CAMERA_LABEL = {
  hold: '📷 가만히', pan_left: '⬅️ 왼쪽으로 훑기', pan_right: '➡️ 오른쪽으로 훑기', pan_up: '⬆️ 위로 훑기', pan_down: '⬇️ 아래로 훑기',
  zoom_in: '🔍 다가가기', zoom_out: '🔭 멀어지기', truck_in: '🚀 확 다가가기', truck_out: '🌌 확 멀어지기', shake: '💥 흔들기',
};
const FX_LABEL = { fade_in: '🌅 서서히 밝게', fade_out: '🌙 서서히 어둡게', flash: '⚡ 번쩍', sparkle: '✨ 반짝반짝', shake: '💥 쿵', dissolve_in: '🌫 스르륵' };
const FX_ORDER = ['fade_in', 'fade_out', 'flash', 'sparkle', 'shake', 'dissolve_in'];
const TR_LABEL = {
  cut: '✂️ 컷', dissolve: '🌫 스르륵', fade: '◐ 페이드', fadeblack: '🌑 암전', flash: '⚡ 번쩍', slideleft: '⬅️ 밀어내기', slideup: '⬆️ 위로 밀기',
  wipeleft: '🧹 닦아내기', zoomin: '🔎 쑥 들어가기', circleopen: '⭕ 동그랗게', pixelize: '🔳 모자이크', smoothleft: '〰️ 부드럽게',
};
const TR_ORDER = ['cut', 'dissolve', 'fade', 'fadeblack', 'flash', 'slideleft', 'slideup', 'wipeleft', 'zoomin', 'circleopen', 'pixelize', 'smoothleft'];
const NOTE_CHIPS = [['😊 표정 바꾸기', '활짝 웃는 얼굴로'], ['🙌 자세 바꾸기', '두 손을 번쩍 든 자세로'], ['✨ 그냥 새로 그리기', '']];
const secText = (fr) => `${+(fr / FPS).toFixed(2)}초`;

export function mountScenes(host, ctx) {
  const { engine, id } = ctx;
  const say = ctx.toast || toastDefault;
  let snap = (ctx.getSnap && ctx.getSnap()) || {};
  let destroyed = false;
  let sel = null; // 고른 장면 번호 (shot.shot)
  let tab = 'draw';
  let comp = null; // { compositor, width, height }
  let layout = null;
  let pv = null;
  let stopPlay = null;
  let thumbGen = 0;
  const touched = new Set(); // 이 화면에서 고친 장면
  const urls = createUrlBox();
  const thumbs = new Map(); // shot → canvas
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; }; // 합성기는 한 번에 하나만 쓴다

  const xs = () => (snap.xsheet) || null;
  const shots = () => (xs() && xs().shots) || [];
  const shotOf = (n) => shots().find((s) => s.shot === n) || null;
  const idx = (n) => shots().findIndex((s) => s.shot === n);
  const dirty = () => new Set([...(snap.dirtyShots || []), ...touched]);
  const locked = () => !!snap.running && ['render', 'subtitles'].includes(snap.currentStep);

  // ───── 뼈대 ─────
  const cv = h('canvas', { class: 'sc-cv', 'aria-label': '장면 미리보기' });
  const playBtn = h('button', { type: 'button', class: 'sc-play', 'aria-label': '이 장면 영상으로 미리 보기', onclick: () => { vibrate(); if (stopPlay) stopPlay(); else playScene(); } }, '▶ 이 장면 보기');
  const stage = h('div', { class: 'sc-stage' }, h('div', { class: 'sc-vbox' }, cv), playBtn);
  const strip = h('div', { class: 'sc-strip', role: 'listbox', 'aria-label': '장면 띠' });
  const info = h('div', { class: 'sc-info' });
  const body = h('div', { class: 'sc-body' });
  const TABS = [['draw', '🎨 그림'], ['time', '⏱ 시간'], ['cam', '🎥 카메라'], ['fx', '✨ 효과']];
  const tabBtns = TABS.map(([k, label]) => h('button', { type: 'button', class: 'sc-tab', role: 'tab', 'data-t': k, onclick: () => { vibrate(); setTab(k); } }, label));
  const lockNote = h('div', { class: 'sc-lock', hidden: true }, '지금은 영상을 만드는 중이에요. 끝난 뒤에 고쳐 주세요.');
  const bar = createApplyBar(ctx, { onDone: (r) => { if (r && r.ok) { touched.clear(); markEdited(); } } });
  const top = h('header', { class: 'sc-top' },
    h('button', { type: 'button', class: 'sc-back', 'aria-label': '나가기', onclick: () => { vibrate(); if (ctx.onClose) ctx.onClose({ cancelled: true }); } }, '←'),
    h('div', { class: 'sc-title' }, '✏️ 장면 고치기'));
  const msg = h('div', { class: 'sc-msg', hidden: true });
  const root = h('div', { class: 'sc', role: 'dialog', 'aria-label': '장면 고치기' }, top, msg, stage, strip, info,
    h('section', { class: 'sc-dock' }, h('div', { class: 'sc-tabs', role: 'tablist' }, tabBtns), lockNote, body), bar.el);
  host.appendChild(root);
  document.documentElement.classList.add('ss-open');

  function setTab(t) {
    tab = t;
    tabBtns.forEach((b) => { const on = b.dataset.t === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
    paintBody();
  }

  // ───── 합성기 · 미리보기 ─────
  async function openComposer() {
    try {
      const o = snap.outSize || { w: 854, h: 480 };
      const scale = Math.min(1, 560 / Math.max(o.w, o.h));
      comp = await engine.render.createCompositor(id, { quality: 'low', scale });
      if (destroyed) { comp.compositor.release(); comp = null; return; }
      layout = buildLayout(xs());
      cv.width = comp.width; cv.height = comp.height;
      pv = createPreview({ compositor: comp.compositor, canvas: cv });
      pv.on('error', (e) => say(friendly(e), 'err'));
      const first = shots()[0];
      if (first) select(first.shot, true);
      makeThumbs();
    } catch (e) {
      msg.hidden = false;
      msg.textContent = friendly(e);
    }
  }
  const midFrame = (n) => { const sp = layout && layout.spans[idx(n)]; return sp ? Math.floor((sp.start + sp.end - 1) / 2) : 0; };
  /** 고른 장면의 가운데 한 장을 큰 미리보기에 */
  function showStill(n) {
    if (!pv) return Promise.resolve();
    return serial(() => (destroyed || !pv ? null : pv.seekFrame(midFrame(n))));
  }
  function playScene() {
    if (!pv || !layout || stopPlay) return Promise.resolve();
    const sp = layout.spans[idx(sel)];
    if (!sp) return Promise.resolve();
    playBtn.textContent = '■ 멈추기';
    return serial(() => new Promise((resolve) => {
      let off = null;
      const finish = () => {
        if (!stopPlay) return;
        stopPlay = null;
        if (off) off();
        try { pv.pause(); } catch (_) { /* 이미 멈춤 */ }
        playBtn.textContent = '▶ 이 장면 보기';
        if (destroyed) { resolve(); return; }
        pv.seekFrame(midFrame(sel)).then(resolve, resolve); // 다시 가운데 한 장으로 (다음 합성기 일은 이게 끝난 뒤에)
      };
      stopPlay = finish;
      off = pv.on('frame', ({ frame }) => { if (frame >= sp.end - 1) finish(); });
      pv.seekFrame(sp.start).then(() => { if (stopPlay) return pv.play(); return null; }).catch(finish);
    }));
  }
  /** 장면 띠의 작은 그림들 (한 장씩 차례로: 합성기가 한 번에 한 장면만 읽게) */
  function makeThumbs() {
    const gen = ++thumbGen;
    for (const s of shots()) {
      serial(async () => {
        if (destroyed || gen !== thumbGen || !comp) return;
        try {
          const c = await renderStill(comp.compositor, midFrame(s.shot), { width: thumbW() * 2, as: 'canvas' });
          const t = thumbs.get(s.shot);
          if (t && !destroyed) { t.width = c.width; t.height = c.height; t.getContext('2d').drawImage(c, 0, 0); t.classList.add('ready'); }
        } catch (_) { /* 그림이 없으면 빈 칸 */ }
      });
    }
  }
  const thumbW = () => ((snap.outSize && snap.outSize.h > snap.outSize.w) ? 72 : 112);
  function refreshThumb(n) {
    serial(async () => {
      if (destroyed || !comp) return;
      comp.compositor.invalidate();
      try {
        const c = await renderStill(comp.compositor, midFrame(n), { width: thumbW() * 2, as: 'canvas' });
        const t = thumbs.get(n);
        if (t) { t.width = c.width; t.height = c.height; t.getContext('2d').drawImage(c, 0, 0); }
      } catch (_) { /* 무시 */ }
      if (n === sel && pv && !destroyed) await pv.seekFrame(midFrame(n));
    });
  }

  // ───── 장면 띠 ─────
  function paintStrip() {
    const d = dirty();
    clear(strip);
    thumbs.clear();
    shots().forEach((s, i) => {
      const w = thumbW();
      const c = h('canvas', { class: 'sc-thc', width: w, height: Math.round((w * (snap.outSize ? snap.outSize.h / snap.outSize.w : 0.5625))) });
      thumbs.set(s.shot, c);
      const sp = layout && layout.spans[i];
      strip.appendChild(h('button', { type: 'button', class: `sc-th${s.shot === sel ? ' on' : ''}${d.has(s.shot) ? ' edited' : ''}`, role: 'option', 'aria-selected': String(s.shot === sel), 'data-shot': s.shot, 'aria-label': `장면 ${i + 1}`, style: { width: `${w}px` }, onclick: () => { vibrate(); select(s.shot); } },
        c, h('span', { class: 'sc-thn' }, `${i + 1}${d.has(s.shot) ? ' ✏️' : ''}`), h('span', { class: 'sc-tht' }, sp ? fmtClock(sp.start / FPS) : '')));
    });
    if (comp) makeThumbs();
  }
  /** 고친 장면 표시(✏️)만 제자리에서 고친다 (작은 그림은 다시 그리지 않는다) */
  function markEdited() {
    const d = dirty();
    shots().forEach((s, i) => {
      const b = strip.querySelector(`[data-shot="${s.shot}"]`);
      if (!b) return;
      b.classList.toggle('edited', d.has(s.shot));
      const t = b.querySelector('.sc-thn');
      if (t) t.textContent = `${i + 1}${d.has(s.shot) ? ' ✏️' : ''}`;
    });
  }
  function select(n, first) {
    if (stopPlay) stopPlay();
    sel = n;
    for (const b of strip.children) { const on = Number(b.dataset.shot) === n; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); }
    const el = strip.querySelector(`[data-shot="${n}"]`);
    if (el && !first) el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    paintInfo();
    paintBody();
    showStill(n);
  }
  function lyricsOf(i) {
    const t = snap.timing;
    const seg = t && t.segments && t.segments[i];
    if (!seg || !Array.isArray(seg.lyrics)) return '';
    return seg.lyrics.map((k) => (t.lyrics || [])[k]).filter((l) => l && !l.hidden && l.text).map((l) => l.text).join(' / ');
  }
  function paintInfo() {
    const i = idx(sel);
    const sp = layout && layout.spans[i];
    clear(info);
    if (i < 0) return;
    info.append(h('b', null, `장면 ${i + 1}`), ` · ${sp ? `${fmtClock(sp.start / FPS)}~${fmtClock(sp.end / FPS)}` : ''}`, h('span', { class: 'sc-lyr' }, lyricsOf(i) ? ` · “${lyricsOf(i)}”` : ' · (간주)'));
  }

  // ───── 아래 고치기 ─────
  async function run(fn, okMsg) {
    if (locked()) { say('지금은 영상을 만드는 중이에요. 끝난 뒤에 고쳐 주세요.', 'warn'); return false; }
    try {
      await fn();
      touched.add(sel);
      snap = (await engine.projects.get(id)) || snap;
      markEdited();
      refreshThumb(sel);
      paintBody();
      bar.update(snap);
      if (okMsg) say(okMsg, 'ok', 1800);
      return true;
    } catch (e) { say(friendly(e), 'err', 5500); return false; }
  }
  function paintBody() {
    clear(body);
    lockNote.hidden = !locked();
    const s = shotOf(sel);
    if (!s) return;
    if (tab === 'cam') body.append(camPane(s));
    else if (tab === 'time') body.append(timePane(s));
    else if (tab === 'fx') body.append(fxPane(s));
    else body.append(drawPane(s));
  }
  const chipBtn = (label, on, fn, cls = '') => h('button', { type: 'button', class: `sc-chip ${cls}`, 'aria-pressed': String(!!on), onclick: () => { vibrate(); fn(); } }, label);

  function camPane(s) {
    const cur = (s.camera && s.camera.move) || 'hold';
    return h('div', null, h('p', { class: 'small muted' }, '누르면 바로 움직여 보여요.'),
      h('div', { class: 'sc-grid cam' }, (X.CAMERA_MOVES || Object.keys(CAMERA_LABEL)).filter((m) => CAMERA_LABEL[m]).map((m) => {
        const [ico, ...rest] = CAMERA_LABEL[m].split(' ');
        return h('button', { type: 'button', class: 'sc-cam', 'data-move': m, 'aria-pressed': String(m === cur), onclick: async () => {
          vibrate();
          const n = sel;
          if (await run(() => engine.edits.setCamera(id, n, m))) { if (stopPlay) stopPlay(); playScene(); }
        } }, h('span', { class: 'sc-cam-i' }, ico), h('span', { class: 'sc-cam-t' }, rest.join(' ')));
      })));
  }
  function timePane(s) {
    const rows = s.exposure || [];
    if (rows.length < 2) return h('p', { class: 'small muted' }, '이 장면은 그림이 한 장이라 시간을 나눌 수 없어요. (장면 길이 = 노래 박자)');
    if (rows.length > 8) return h('p', { class: 'sc-moving' }, `🏃 움직이는 장면이에요. 그림 ${rows.length}장이 1초에 ${Math.round(FPS / Math.max(1, Math.round(s.frames / rows.length)))}번쯤 빠르게 바뀌어서, 한 장씩 시간을 고치지 않아도 돼요.`);
    const one = (r, i) => {
      const step = (d) => run(() => engine.edits.retime(id, sel, i, Math.max(MIN_FR, r.frames + d)), null);
      return h('div', { class: 'sc-trow', 'data-i': i },
        h('span', { class: 'sc-tl' }, r.drawing === BG ? '🏞 배경' : `🖼 그림 ${r.drawing}`),
        h('button', { type: 'button', class: 'sc-step', 'aria-label': '0.25초 줄이기', onclick: () => { vibrate(); step(-STEP_FR); } }, '−'),
        h('b', { class: 'sc-tv' }, secText(r.frames)),
        h('button', { type: 'button', class: 'sc-step', 'aria-label': '0.25초 늘리기', onclick: () => { vibrate(); step(STEP_FR); } }, '＋'));
    };
    return h('div', null, h('p', { class: 'small muted' }, '그림마다 보여 주는 시간이에요. 장면 전체 길이는 그대로라서 이웃 그림이 시간을 나눠 가져요.'), rows.map(one));
  }
  function fxPane(s) {
    const i = idx(sel);
    const fx = s.fx || [];
    const tr = (xs().transitions && xs().transitions[i] && xs().transitions[i].type) || 'cut';
    const last = i >= shots().length - 1;
    const keys = TR_ORDER.filter((k) => !T || !T.TRANSITIONS || T.TRANSITIONS[k]);
    return h('div', null,
      h('div', { class: 'sc-h' }, '✨ 이 장면의 효과 (3개까지)'),
      h('div', { class: 'sc-chips' }, FX_ORDER.map((k) => chipBtn(FX_LABEL[k], fx.includes(k), () => {
        const next = fx.includes(k) ? fx.filter((x) => x !== k) : [...fx, k];
        run(() => engine.edits.setFx(id, sel, next)).then((ok) => { if (ok) playScene(); });
      }, 'fx'))),
      h('div', { class: 'sc-h' }, '➡️ 다음 장면으로 넘어갈 때'),
      last ? h('p', { class: 'small muted' }, '마지막 장면은 다음 장면이 없어요.')
        : h('div', { class: 'sc-chips' }, keys.map((k) => chipBtn(TR_LABEL[k] || k, tr === k, () => { run(() => engine.edits.setTransition(id, sel, k), '장면 넘기기를 바꿨어요'); }, 'tr'))));
  }
  // 그림: 장면에 쓰이는 그림 칸 (배경 + 인물) 하나씩
  function drawingsOf(n) {
    const leader = xs() && xs().bgOf && xs().bgOf[n] != null ? xs().bgOf[n] : n;
    const out = [];
    for (const d of snap.drawings || []) if ((d.shot === n && d.kind !== 'bg') || (d.kind === 'bg' && d.shot === leader && xs().layers)) out.push(d);
    return out.sort((a, b) => (a.kind === 'bg' ? -1 : b.kind === 'bg' ? 1 : a.id < b.id ? -1 : 1));
  }
  function drawPane(s) {
    const list = drawingsOf(s.shot);
    if (!list.length) return h('p', { class: 'small muted' }, '이 장면에는 아직 그림이 없어요.');
    const redo = new Set((snap.redrawing || []).map((r) => r.key));
    return h('div', { class: 'sc-tiles' }, list.map((d) => {
      const img = h('img', { class: 'sc-timg', alt: '' });
      engine.drawings.blob(id, d.key, d.kind === 'bg' ? 'current' : 'plate').then((b) => { if (b && !destroyed) img.src = urls.get(`t:${d.key}`, `${d.key}|${d.redraws}|${d.updatedAt}`, b); }).catch(() => {});
      const name = d.kind === 'bg' ? '🏞 배경' : `🖼 그림 ${d.id}`;
      return h('div', { class: 'sc-tile', 'data-key': d.key },
        h('div', { class: 'sc-tmain' }, img, h('div', { class: 'sc-tname' }, h('b', null, name), d.custom ? h('span', { class: 'sc-tag' }, '내가 바꿈') : null, redo.has(d.key) ? h('span', { class: 'sc-tag wait' }, '다시 그리는 중') : null, !d.hasPicture ? h('span', { class: 'sc-tag wait' }, '그림 없음') : null)),
        h('div', { class: 'sc-tbtns' },
          h('button', { type: 'button', class: 'btn sc-redo', onclick: () => { vibrate(); askRedo(d); } }, '🔄 다시 부탁하기'),
          h('button', { type: 'button', class: 'btn sc-mine', onclick: () => { vibrate(); pickMine(d); } }, '🖼 내 그림으로'),
          d.history && d.history.length ? h('button', { type: 'button', class: 'btn sc-back-pic', onclick: () => { vibrate(); pickOld(d); } }, `↩ 이전 그림 (${d.history.length})`) : null));
    }));
  }
  /** 🔄 다시 부탁하기: 어떻게 바꿀지 한 줄 + 빠른 칩 → 부탁 글을 만들고 영상 화면의 '지금 할 일' 로 */
  function askRedo(d) {
    if (locked()) { say('지금은 영상을 만드는 중이에요. 끝난 뒤에 눌러 주세요.', 'warn'); return; }
    const input = h('input', { type: 'text', class: 'sc-note', maxlength: '120', placeholder: '예: 웃는 얼굴로, 우산을 들고', 'aria-label': '어떻게 바꿀까요?', autocomplete: 'off' });
    const chips = NOTE_CHIPS.map(([label, phrase]) => h('button', { type: 'button', class: 'sc-chip', 'aria-pressed': 'false', onclick: () => { input.value = phrase; input.focus(); } }, label));
    const sh = bottomSheet({
      title: `🔄 ${d.kind === 'bg' ? '배경' : `그림 ${d.id}`} 다시 부탁하기`,
      body: h('div', { class: 'sc-redo' }, h('p', { class: 'sc-q' }, '어떻게 바꿀까요?'), input, h('div', { class: 'sc-chips' }, chips),
        h('p', { class: 'small muted' }, '지금 그림은 저장돼요. 마음에 안 들면 ↩ 이전 그림으로 돌아갈 수 있어요. AI 앱에 부탁하는 글을 만들어서 [지금 할 일] 에 보여 드려요.')),
      buttons: [{ label: '취소', value: false }, { label: '🔄 부탁 글 만들기', kind: 'primary', value: true }], closeLabel: null,
    });
    sh.result.then(async (ok) => {
      if (!ok || destroyed) return;
      try {
        await engine.drawings.regenerate(id, d.shot, d.id, input.value.trim() ? { note: input.value.trim() } : {});
        say('🔄 부탁 글을 만들었어요. [지금 할 일] 에서 AI 앱에 부탁해 주세요.', 'ok', 4500);
        if (ctx.onClose) ctx.onClose({ redraw: d.key });
      } catch (e) { say(friendly(e), 'err', 5500); }
    });
  }
  async function pickMine(d) {
    if (locked()) { say('지금은 영상을 만드는 중이에요. 끝난 뒤에 눌러 주세요.', 'warn'); return; }
    const file = await pickFile('image/png,image/jpeg,image/webp');
    if (!file || destroyed) return;
    const b = busy('그림을 바꾸는 중…');
    try {
      await engine.drawings.replace(id, d.shot, d.id, file, {});
      touched.add(sel);
      snap = (await engine.projects.get(id)) || snap;
      say('🖼 내 그림으로 바꿨어요', 'ok', 2200);
      markEdited(); paintBody(); bar.update(snap); refreshThumb(sel);
    } catch (e) { say(friendly(e), 'err', 5500); } finally { b.done(); }
  }
  function pickOld(d) {
    const hist = d.history || [];
    const boxUrls = createUrlBox();
    let sh;
    const items = hist.map((e) => {
      const img = h('img', { class: 'sc-timg', alt: '' });
      engine.drawings.blob(id, d.key, e.index).then((b) => { if (b) img.src = boxUrls.get(`h${e.index}`, `h${e.index}`, b); }).catch(() => {});
      return h('div', { class: 'sc-old' }, img, h('div', { class: 'grow' }, h('b', null, `예전 그림 ${e.index + 1}`), h('div', { class: 'small muted' }, `${e.kind === 'user' ? '내가 넣은 그림' : 'AI 가 그린 그림'}${e.note ? ` · ${e.note}` : ''}`)),
        h('button', { type: 'button', class: 'btn primary small', onclick: async () => { sh.close(); const ok = await run(() => engine.drawings.restoreVersion(id, d.shot, d.id, e.index), '↩ 이전 그림으로 되돌렸어요'); if (ok) refreshThumb(sel); } }, '이 그림으로'));
    });
    sh = bottomSheet({ title: '↩ 이전 그림 고르기', body: h('div', { class: 'sc-olds' }, items), onClose: () => boxUrls.dispose() });
  }

  // ───── 새 소식 · 시작 ─────
  function update(next) {
    if (destroyed || !next) return;
    const wasXs = xs();
    snap = next;
    if (!comp && xs() && !wasXs) openComposer();
    bar.update(snap);
    lockNote.hidden = !locked();
    markEdited();
  }
  paintStrip();
  setTab('draw');
  if (xs()) openComposer();
  else {
    msg.hidden = false;
    msg.textContent = '아직 장면이 없어요. 영상을 만든 뒤에 장면을 고칠 수 있어요.';
    if (!snap.id) engine.projects.get(id).then((s) => { if (s && !destroyed) { snap = s; if (xs()) { msg.hidden = true; paintStrip(); openComposer(); } } }).catch(() => {});
  }
  const off = engine.on ? engine.on('update', (s) => { if (s && s.id === id) update(s); }) : null;

  return {
    update,
    isDirty: () => false, // 고친 것은 바로 엔진에 저장돼 있다 (영상에 넣는 것만 남는다)
    confirmLeave: async () => true,
    destroy() {
      destroyed = true;
      if (off) off();
      if (stopPlay) stopPlay();
      thumbGen++;
      try { if (pv) pv.dispose(); } catch (_) { /* 무시 */ }
      serial(() => { try { if (comp) comp.compositor.release(); } catch (_) { /* 무시 */ } comp = null; });
      urls.dispose();
      document.documentElement.classList.remove('ss-open');
      root.remove();
    },
  };
}
