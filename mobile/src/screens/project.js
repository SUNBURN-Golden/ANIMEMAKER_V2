// 영상 하나 화면: 위 줄 [← 제목 ⋯] + "지금 할 일" 카드 하나 + 얇은 진행 막대 + 접힌 "지금까지".
//   만드는 중 → 진행 카드 [그만두기] · AI 앱에 부탁/받기 → handoff.js 카드 · 확인 멈춤(가사 맞추기 · 그림 수) · 오류/멈춤 → [▶ 이어서 하기]
//   완성 → C3b 의 완성 화면(mountDone) 을 올린다. 장면 고치기 · 가사 자막 스튜디오 · 가사 시간 맞추기도 같은 방식으로 전체 화면에 올라온다.
import * as ui from '../ui.js';
import { h, clear, toast, bottomSheet, confirmBox } from '../ui.js';
import * as db from '../db.js';
import { listReceived, describeReceived } from '../inbox.js';
import { runDevJob } from '../dev-tools.js';
import { makeCtx, mountModule } from './project-mount.js';
import { createHandoffCard, ensureNotify } from './handoff.js';
import { fmtMinutes, isEngineRecord, niceTitle, buzz, put } from './projects-util.js';

const STEP_SENTENCE = {
  music: ['🎵', '노래를 듣고 있어요'],
  plan: ['📝', '이야기를 짜고 있어요'],
  timing: ['⏱', '가사에 맞춰 장면을 나누고 있어요'],
  xsheet: ['📋', '그림 순서를 짜고 있어요'],
  drawings: ['🎨', '그림을 정리하고 있어요'],
  render: ['🎞', '영상을 만들고 있어요'],
  subtitles: ['💬', '가사 자막을 입히고 있어요'],
};
const isPracticeSnap = (s) => s.providers && s.providers.text === 'demo' && s.providers.image === 'demo';

/** 전체 진행 0..1 (끝난 단계 + 지금 단계의 진행) */
export function overallProgress(snap) {
  const order = snap.stepOrder || [];
  if (!order.length) return 0;
  let done = 0;
  for (const s of order) if (snap.steps[s] && snap.steps[s].status === 'done') done++;
  const cur = snap.currentStep && snap.steps[snap.currentStep];
  const frac = cur && cur.status !== 'done' && cur.progress && cur.progress.total ? Math.min(1, cur.progress.done / cur.progress.total) : 0;
  return Math.min(1, (done + frac) / order.length);
}

// ───────────────────────── 엔진 기록이 아닌 옛 자리표 (C1 시험용) ─────────────────────────

async function legacyView(app, id) {
  const p = await db.getProject(id);
  if (!p) return h('div', { class: 'card' }, h('h3', null, '작품을 찾을 수 없어요'), h('button', { class: 'btn', onclick: () => app.go('home') }, '처음으로'));
  const [expecting, received] = await Promise.all([db.getExpecting(), listReceived()]);
  return h('div', null,
    h('div', { class: 'card', id: 'project-placeholder' }, h('h3', null, p.title || '새 영상'), h('p', { class: 'small muted' }, `작품 번호 ${p.id}`)),
    expecting && expecting.projectId === id
      ? h('div', { class: 'card', id: 'expecting-card' }, h('b', null, '⏳ 답장을 기다리고 있어요'), h('p', { class: 'small' }, `${expecting.kind}${expecting.key ? ` · ${expecting.key}` : ''} — 앱이 꺼졌다 켜져도 공유로 받은 것은 여기로 와요.`))
      : null,
    received.length ? h('div', { class: 'card', id: 'received-card' }, h('b', null, `📥 받은 함 ${received.length}개`), h('ul', { class: 'small' }, received.map((r) => h('li', null, describeReceived(r))))) : null,
    h('details', { class: 'card fold', id: 'dev-fold' },
      h('summary', null, '개발용 도구'),
      h('div', { class: 'row' }, h('button', { class: 'btn', id: 'dev-job', onclick: () => runDevJob(id) }, '⏱ 일 지킴이 시험 (3초)')),
      p.devResult ? h('p', { class: 'small', id: 'dev-result' }, `마지막 시험 결과: ${p.devResult.steps}단계 · ${new Date(p.devResult.at).toLocaleTimeString('ko-KR')}`) : null));
}

// ───────────────────────── 화면 ─────────────────────────

/**
 * @param {object} app
 * @param {{id:string, from?:string, autorun?:boolean}} params
 * @returns {Promise<{el:HTMLElement, destroy:()=>void, setTitle?:(t:string)=>void}>}
 */
export async function projectScreen(app, params) {
  const { engine } = app;
  const id = params.id;
  const rec = await db.getProject(id);
  if (!rec || !isEngineRecord(rec)) {
    const wrap = h('div', { class: 'proj legacy' }, h('header', { class: 'ptop' }, h('button', { class: 'icon-btn', id: 'proj-back', 'aria-label': '뒤로', onclick: () => app.back() }, '←'), h('div', { class: 'ptitle' }, rec ? (rec.title || '새 영상') : '영상')), h('main', { class: 'pbody' }, await legacyView(app, id)));
    return { el: wrap, destroy() {}, legacy: true };
  }

  let snap;
  try { snap = await engine.projects.get(id); } catch (e) {
    return { el: h('div', { class: 'card' }, h('h3', null, '영상을 열지 못했어요'), h('p', { class: 'small muted' }, e.message), h('button', { class: 'btn', onclick: () => app.go('projects') }, '내 영상으로')), destroy() {} };
  }

  const reportErr = (e) => { if (e && e.name === 'AbortError') return; toast((e && e.message) || String(e), 'err', 6000); };
  const titleEl = h('div', { class: 'ptitle', id: 'proj-title' }, niceTitle(snap.title, snap.series));
  const barFill = h('i', { style: { width: '0%' } });
  const bar = h('div', { class: 'pbar', role: 'progressbar', 'aria-label': '전체 진행', 'aria-valuemin': 0, 'aria-valuemax': 100 }, barFill);
  const body = h('main', { class: 'pbody', id: 'proj-body' });
  const el = h('div', { class: 'proj', 'data-id': id },
    h('header', { class: 'ptop' },
      h('button', { class: 'icon-btn', id: 'proj-back', 'aria-label': '뒤로', onclick: () => app.back() }, '←'),
      titleEl,
      h('button', { class: 'icon-btn', id: 'proj-more', 'aria-label': '더 보기', onclick: () => openMenu() }, '⋯')),
    bar, body);

  let dead = false;
  let sub = null; // 전체 화면으로 올라온 C3b 화면
  const sections = new Map();
  const autoSeen = new Set();

  // ── 화면 조각 만들기 ──
  const make = {
    busy() {
      const emoji = h('div', { class: 'bz-emoji', 'aria-hidden': 'true' }, '⏳');
      const head = h('div', { class: 'bz-title', id: 'busy-title' });
      const msg = h('div', { class: 'small muted', id: 'busy-msg' });
      const fill = h('i', { style: { width: '0%' } });
      const meter = h('div', { class: 'bar on', role: 'progressbar' }, fill);
      const stop = h('button', { class: 'btn', id: 'btn-stop', onclick: async () => { buzz(); const ok = await engine.stop(id); toast(ok ? '멈추는 중이에요…' : '지금은 멈출 일이 없어요', 'warn'); } }, '■ 그만두기');
      const draft = draftButton();
      const card = h('section', { class: 'card now busy-card', id: 'busy-card' }, h('div', { class: 'row-between' }, emoji, h('div', { class: 'grow' }, head, msg)), meter, h('div', { class: 'row' }, stop), draft.el);
      return {
        el: card,
        update(s) {
          const [e, t] = STEP_SENTENCE[s.currentStep] || ['⏳', '만들고 있어요'];
          const st = (s.steps && s.steps[s.currentStep]) || {};
          emoji.textContent = e;
          head.textContent = t;
          msg.textContent = st.message || s.next.label || '';
          const pr = st.progress && st.progress.total ? st.progress.done / st.progress.total : null;
          meter.classList.toggle('indet', pr == null);
          fill.style.width = pr == null ? '40%' : `${Math.round(pr * 100)}%`;
          meter.setAttribute('aria-valuenow', pr == null ? '' : String(Math.round(pr * 100)));
          draft.update(s);
        },
      };
    },

    handoff() {
      const card = createHandoffCard({
        app, engine, id,
        request: () => engine.handoff.request(id),
        send: (appId) => engine.handoff.send(id, appId),
        skip: (req) => (req.redraw ? engine.drawings.cancelRedraw(id, req.key) : engine.drawings.skip(id, req.key)),
        fallbackXsheet: () => engine.skipWaiting(id, 'xsheet'),
      });
      const draft = draftButton();
      const wrap = h('div', { class: 'now-wrap', id: 'handoff-wrap' }, card.el, draft.el);
      return { el: wrap, update(s) { card.update(s); draft.update(s); }, destroy() { card.destroy(); } };
    },

    review() {
      const host = h('section', { class: 'card now review-card', id: 'review-card' });
      let lastKey = '';
      let lastSig = '';
      return {
        el: host,
        update(s) {
          const w = s.waiting;
          if (!w) return;
          const sig = `${w.key}|${w.estimate ? w.estimate.pictures : ''}|${w.alt ? w.alt.pictures : ''}|${w.busy ? 1 : 0}`;
          if (sig === lastSig) return;
          lastSig = sig; lastKey = w.key;
          clear(host);
          host.dataset.review = lastKey;
          if (w.key === 'review:lyrics') {
            put(host, 
              h('h3', null, '🎤 가사를 노래에 맞춰 볼까요?'),
              h('p', { class: 'small' }, '지금은 컴퓨터가 어림잡아 시간을 맞췄어요. 노래를 들으며 줄이 시작될 때마다 톡 눌러 주면 자막이 훨씬 정확해져요.'),
              h('button', { class: 'btn primary big', id: 'btn-tapsync', onclick: () => { buzz(); openSub('tapsync', { after: (res) => { if (res && res.saved) engine.continueReview(id).catch(reportErr); } }); } }, '🎤 지금 맞추기'),
              h('button', { class: 'btn big', id: 'btn-later', onclick: async () => { buzz(); try { await engine.continueReview(id); } catch (e) { reportErr(e); } } }, '나중에 하기 ▶'),
              h('p', { class: 'small muted' }, '나중에 해도 괜찮아요. 영상이 완성된 뒤 [가사 자막 고치기] 에서 정확히 맞출 수 있어요.'));
          } else if (w.key === 'review:drawings' && w.estimate) {
            const e = w.estimate;
            const alt = w.alt;
            const extra = e.requests - e.pictures;
            const go = async (fn) => { buzz(); try { await fn(); } catch (err) { reportErr(err); } };
            put(host, 
              h('h3', null, '🎨 그림을 몇 장 그릴지 확인해요'),
              h('p', { class: 'small' }, `그림 약 ${e.pictures}장을 AI 앱에 부탁해서 받아야 해요.`),
              e.warning ? h('p', { class: 'warn-text small' }, `⚠ ${e.warning}`) : null,
              h('button', { class: 'btn primary big two-line', id: 'btn-draw-all', onclick: () => go(() => engine.continueReview(id)) },
                h('span', null, '이대로 그리기'), h('small', null, `AI 앱에 약 ${e.requests}번 · ${fmtMinutes(e.minutes)}`)),
              alt ? h('button', { class: 'btn big two-line', id: 'btn-draw-less', onclick: () => go(async () => { const r = await engine.edits.setMotion(id, { motionMode: alt.motionMode, drawingBudget: alt.drawingBudget }); toast(`그림을 줄였어요 (약 ${r.pictures}장)`, 'ok'); }) },
                h('span', null, '그림 줄여서 빨리'), h('small', null, `AI 앱에 약 ${alt.pictures + extra}번 · ${fmtMinutes(alt.minutes)}`)) : null,
              h('p', { class: 'small muted' }, e.assumption || '부탁 한 번에 1~1.5분쯤 걸린다고 어림한 값이에요.'));
          } else {
            put(host, h('h3', null, w.title || '확인해 주세요'), h('p', { class: 'small' }, w.message || ''),
              h('button', { class: 'btn primary big', onclick: () => go2(() => engine.continueReview(id)) }, '계속하기 ▶'));
          }
        },
      };
    },

    error() {
      const msg = h('p', { class: 'small pre', id: 'err-msg' });
      const card = h('section', { class: 'card now err-card', id: 'error-card' },
        h('h3', null, '😢 문제가 생겼어요'), msg,
        h('button', { class: 'btn primary big', id: 'btn-resume', onclick: () => startRun() }, '▶ 이어서 하기'),
        h('button', { class: 'btn small', onclick: () => openDetails() }, '자세히 보기'));
      return { el: card, update(s) { msg.textContent = s.error || s.next.label || '알 수 없는 문제가 생겼어요.'; } };
    },

    run() {
      const title = h('h3', null);
      const text = h('p', { class: 'small muted' });
      const btn = h('button', { class: 'btn primary big', id: 'btn-resume', onclick: () => startRun() });
      const card = h('section', { class: 'card now run-card', id: 'run-card' }, title, text, btn);
      return {
        el: card,
        update(s) {
          const stopped = s.status === 'stopped';
          title.textContent = stopped ? '⏸ 멈춰 있어요' : '🎬 만들 준비가 됐어요';
          text.textContent = stopped ? '여기까지 만든 건 그대로 있어요. 이어서 만들 수 있어요.' : '버튼을 누르면 노래부터 차례로 만들어요.';
          btn.textContent = stopped ? '▶ 이어서 하기' : '▶ 만들기 시작';
        },
      };
    },

    done() {
      const host = h('div', { class: 'done-host', id: 'done-host' });
      const ctx = makeCtx({ id, engine, app, mode: 'done', onClose: () => {}, open: (m, x) => openSub(m, x), nextEpisode });
      const handle = mountModule('done', host, ctx);
      return { el: host, update(s) { handle.update(s); }, destroy() { handle.destroy(); } };
    },

    sofar() {
      const sum = h('span', { class: 'muted' });
      const chips = h('div', { class: 'chips' });
      const det = h('details', { class: 'card fold so-far', id: 'so-far' }, h('summary', null, '지금까지 ', sum), chips);
      return {
        el: det,
        update(s) {
          const order = s.stepOrder || [];
          const n = order.filter((k) => s.steps[k] && s.steps[k].status === 'done').length;
          sum.textContent = `(${n}/${order.length})`;
          clear(chips);
          for (const k of order) {
            const st = (s.steps[k] || {}).status || 'pending';
            const mark = st === 'done' ? '✓' : st === 'running' || st === 'waiting' ? '…' : st === 'error' ? '!' : '·';
            chips.appendChild(h('span', { class: `chip static ${st}` }, `${mark} ${(s.stepLabels && s.stepLabels[k]) || k}`));
          }
        },
      };
    },
  };
  const go2 = async (fn) => { buzz(); try { await fn(); } catch (e) { reportErr(e); } };

  /** "지금까지 그린 걸로 영상 만들기"(미리 보기) + "남은 그림은 건너뛰고 영상 완성하기" — 그림이 한 장이라도 있으면 언제든 */
  function draftButton() {
    const btn = h('button', { class: 'btn ghost draft-btn', id: 'btn-draft', style: { display: 'none' }, onclick: () => makeDraft() }, '🎞 지금까지 그린 걸로 영상 만들기');
    const fin = h('button', { class: 'btn ghost draft-btn', id: 'btn-finish', style: { display: 'none' }, onclick: () => finishNow() }, '⏩ 남은 그림은 건너뛰고 영상 완성하기');
    return {
      el: h('div', { class: 'draft-box' }, btn, fin),
      update(s) {
        const have = !!s.xsheet && !s.running && s.status !== 'done' && (s.drawings || []).some((d) => d.hasPicture);
        btn.style.display = have ? '' : 'none';
        fin.style.display = have && s.status === 'waiting' && s.work && s.work.pending + s.work.error > 0 ? '' : 'none';
      },
    };
  }
  async function finishNow() {
    buzz();
    const s = engine.projects.peek(id) || snap;
    const left = (s.work && s.work.pending + s.work.error) || 0;
    if (!(await confirmBox('남은 그림은 건너뛸까요?', `아직 못 받은 그림 ${left}장은 이웃 그림으로 대신해서 영상을 완성해요. 나중에 [장면 고치기] 에서 그림을 다시 부탁할 수 있어요.`, '영상 완성하기', '더 받을게요'))) return;
    await ensureNotify(app);
    try { await engine.drawings.finishEarly(id); } catch (e) { reportErr(e); }
  }
  async function makeDraft() {
    buzz();
    await ensureNotify(app);
    try {
      await engine.render.run(id, { draft: true });
      const blob = await engine.render.output(id, 'draft');
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const v = h('video', { src: url, controls: true, playsinline: true, class: 'draft-video', id: 'draft-video' });
      bottomSheet({ title: '🎞 지금까지 그린 걸로 만든 영상', body: h('div', null, v, h('p', { class: 'small muted' }, '아직 없는 그림은 "그림 기다리는 중" 카드로 보여요. 그림이 다 모이면 진짜 영상을 만들어요.')), onClose: () => URL.revokeObjectURL(url) });
    } catch (e) { reportErr(e); }
  }

  async function startRun(from) {
    buzz();
    await ensureNotify(app);
    engine.run(id, from ? { from } : undefined).catch(reportErr);
  }

  /** 다음 화 만들기: 같은 주인공을 고른 채 만들기 탭으로 */
  function nextEpisode() {
    const s = engine.projects.peek(id);
    app.go('home', { seriesId: s && s.series ? s.series.id : null });
  }

  // ── 전체 화면 칸 (C3b 화면) ──
  function openSub(name, extra = {}) {
    if (sub) closeSub();
    const { after, ...rest } = extra || {};
    const host = h('div', { class: 'sub-host', 'data-mode': name });
    document.body.appendChild(host);
    const ctx = makeCtx({ id, engine, app, mode: name, onClose: (res) => closeSub(res), open: (m, x) => openSub(m, x), nextEpisode, extra: rest });
    const handle = mountModule(name, host, ctx);
    const s = engine.projects.peek(id);
    if (s) handle.update(s);
    sub = { name, host, handle, ctx, after, pop: app.pushBack(backInSub) };
  }
  function closeSub(res) {
    if (!sub) return;
    const cur = sub;
    sub = null;
    try { cur.handle.destroy(); } catch (e) { console.error(e); }
    cur.host.remove();
    cur.pop();
    const s = engine.projects.peek(id);
    if (s && sections.get('done')) sections.get('done').update(s);
    if (cur.after) { try { cur.after(res); } catch (e) { reportErr(e); } }
  }
  async function backInSub() {
    if (!sub) return false;
    if (sub.ctx._backHook) { const r = await sub.ctx._backHook(); if (r) return true; }
    if (sub.handle.isDirty && sub.handle.isDirty()) {
      const ok = await confirmBox('저장하지 않은 변경이 있어요', '나갈까요?', '나가기', '계속 고치기');
      if (!ok) return true;
    }
    closeSub();
    return true;
  }

  // ── ⋯ 메뉴 ──
  function menuRow(label, fn, cls = '') {
    return h('button', { class: `btn menu-row ${cls}`, onclick: () => { sheet.close(); setTimeout(() => fn().catch(reportErr), 0); } }, label);
  }
  let sheet = null;
  function openMenu() {
    sheet = bottomSheet({
      title: '더 보기',
      body: h('div', { class: 'menu-list' },
        menuRow('✏️ 이름 바꾸기', rename),
        menuRow('🔁 단계 다시 하기', redoStep),
        menuRow('🔍 자세히 보기 (고급)', async () => openDetails()),
        menuRow('🗑 이 영상 지우기', removeMe, 'danger')),
    });
  }
  async function rename() {
    const inp = h('input', { type: 'text', value: snap.title || '', maxlength: 40, id: 'rename-input', 'aria-label': '영상 이름' });
    const v = await bottomSheet({ title: '이름 바꾸기', body: inp, buttons: [{ label: '취소', value: false }, { label: '바꾸기', kind: 'primary', value: true }], closeLabel: null }).result;
    if (v) { await engine.projects.rename(id, inp.value); toast('이름을 바꿨어요', 'ok'); }
  }
  async function redoStep() {
    const s = engine.projects.peek(id) || snap;
    if (s.running) { toast('지금은 만드는 중이에요. 끝난 뒤에 눌러 주세요.', 'warn'); return; }
    let pick;
    pick = bottomSheet({
      title: '어느 단계부터 다시 할까요?',
      body: h('div', { class: 'menu-list' }, (s.stepOrder || []).map((k) => h('button', { class: 'btn menu-row', 'data-step': k, onclick: () => pick.close(k) }, `${(s.stepLabels && s.stepLabels[k]) || k} 부터`))),
    });
    const k = await pick.result;
    if (!k) return;
    if (await confirmBox('이 단계부터 다시 만들까요?', '이미 받은 그림은 그대로 쓰고, 이 단계부터 뒤쪽만 다시 만들어요.', '다시 하기')) await startRun(k);
  }
  async function removeMe() {
    if (await confirmBox('이 영상을 지울까요?', `"${niceTitle(snap.title, snap.series)}" 와 안에 든 노래·그림·영상을 이 앱에서 지워요. (갤러리에 저장한 영상은 남아요)`, '지우기')) {
      await app.deleteProject(id);
      toast('지웠어요', 'ok');
      app.go(params.from === 'home' ? 'projects' : (params.from || 'projects'));
    }
  }
  function openDetails() {
    const s = engine.projects.peek(id) || snap;
    const steps = (s.stepOrder || []).map((k) => `${(s.stepLabels && s.stepLabels[k]) || k}: ${(s.steps[k] || {}).status || '-'}${(s.steps[k] || {}).message ? ` · ${s.steps[k].message}` : ''}`).join('\n');
    bottomSheet({
      title: '자세히 보기 (고급)',
      body: h('div', { class: 'details-box' },
        s.estimate ? h('p', { class: 'small' }, s.estimate.text) : null,
        s.work ? h('p', { class: 'small' }, s.work.text) : null,
        h('b', { class: 'small' }, '단계'), h('pre', { class: 'log small' }, steps),
        h('b', { class: 'small' }, '기록'), h('pre', { class: 'log small', id: 'detail-log' }, (s.log || []).slice(-40).join('\n') || '(아직 없어요)'),
        h('p', { class: 'tiny muted' }, `작품 번호 ${s.id}`)),
    });
  }

  // ── 상태에 따라 조각 고르기 ──
  function wanted(s) {
    const k = [];
    const n = s.next.kind;
    if (n === 'handoff') k.push('handoff');
    else if (n === 'review') k.push('review');
    else if (n === 'running') k.push('busy');
    else if (n === 'error') k.push('error');
    else if (n === 'run') k.push('run');
    if (s.status === 'done') k.push('done');
    k.push('sofar');
    return k;
  }
  function render(s) {
    if (dead) return;
    snap = s;
    titleEl.textContent = niceTitle(s.title, s.series);
    const pct = Math.round(overallProgress(s) * 100);
    barFill.style.width = `${s.status === 'done' ? 100 : pct}%`;
    bar.setAttribute('aria-valuenow', String(pct));
    el.dataset.status = s.status;
    el.dataset.next = s.next.kind;
    const keys = wanted(s);
    for (const [k, sec] of [...sections]) {
      if (!keys.includes(k)) { if (sec.destroy) sec.destroy(); sec.el.remove(); sections.delete(k); }
    }
    let prev = null;
    for (const k of keys) {
      let sec = sections.get(k);
      if (!sec) { sec = make[k](); sections.set(k, sec); }
      if (prev ? prev.nextSibling !== sec.el : body.firstChild !== sec.el) body.insertBefore(sec.el, prev ? prev.nextSibling : body.firstChild);
      prev = sec.el;
      sec.update(s);
    }
    if (sub) sub.handle.update(s);
    // 연습 모드는 확인에서 저절로 이어 간다 (가짜 노래·가짜 그림이라 맞출 게 없다)
    if (isPracticeSnap(s) && s.status === 'waiting' && s.waiting && s.waiting.kind === 'review' && !autoSeen.has(s.waiting.key)) {
      autoSeen.add(s.waiting.key);
      engine.continueReview(id).catch(reportErr);
    }
  }

  let raf = 0;
  const offUpdate = engine.on('update', (s) => {
    if (s.id !== id || dead) return;
    snap = s;
    if (raf) return;
    raf = setTimeout(() => { raf = 0; render(engine.projects.peek(id) || snap); }, 120);
  });
  const offDeleted = engine.on('deleted', (e) => { if (e.id === id && !dead) app.go('projects'); });

  render(snap);
  if (params.autorun && snap.next.kind === 'run') startRun();

  return {
    el,
    destroy() {
      dead = true;
      clearTimeout(raf);
      offUpdate(); offDeleted();
      if (sub) closeSub();
      for (const sec of sections.values()) if (sec.destroy) sec.destroy();
      sections.clear();
    },
  };
}
