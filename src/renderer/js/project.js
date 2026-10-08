'use strict';
/* 영상 하나 화면 (쉬운 V2)
 *  모드(cur.mode): watch(보기 · 진행) · scenes(장면 고치기, js/scenes.js) · subs(가사 자막 고치기, js/substudio.js) · details(고급 보기: 단계 칸 + 탭 6개)
 *  - 만드는 중이면 큰 진행 카드 한 장, 도움이 필요하면 그 위에 도움 카드. 완성이면 큰 영상 + 단추 4개.
 *  - 고친 것이 있으면 아래 고정 바 '✨ 고친 것 반영하기' (자막 스튜디오는 자기 저장 단추가 있어서 바를 숨긴다)
 *  - 업데이트마다 통째로 다시 그리지 않는다: 칸마다 서명을 비교해서 바뀐 곳만 고친다. 재생 중인 <video> 는 다시 만들지 않는다.
 *  - 영상 만들기가 render/subtitles 단계에 있으면 output 폴더의 영상 파일이 지워지고 다시 써진다(윈도우는 열린 파일을 못 지운다)
 *    → 그 동안 <video> 를 놓아 주고(마지막 화면을 그림으로 남김) 끝나면 새 파일로 다시 만든다.
 */
(function (AM) {
  const { h, clear, toast } = AM;
  AM.views = AM.views || {};

  let cur = null; // 열려 있는 영상 화면의 상태 { id, snap, mode, root, els, ctl, view, dv, bar, ... }
  const DCOLORS = ['#7c3aed', '#ff5e62', '#0ea5e9', '#16a34a', '#f59e0b', '#db2777', '#4f46e5', '#0d9488', '#ea580c', '#65a30d', '#9333ea', '#0891b2'];

  const TABS = [
    { id: 'timing', label: '🎵 노래·가사·장면' },
    { id: 'plan', label: '📝 이야기' },
    { id: 'xsheet', label: '📋 그림 순서표' },
    { id: 'drawings', label: '🎨 그림' },
    { id: 'final', label: '🎬 완성 영상' },
    { id: 'log', label: '📜 진행 기록' },
  ];
  const STEP_IDS = AM.STEP_META.map((m) => m.id);
  const EARLY = ['music', 'plan', 'timing', 'xsheet', 'drawings']; // 영상 만들기(render) 앞 단계들
  const STEP_W = { music: 4, plan: 10, timing: 4, xsheet: 8, drawings: 50, render: 18, subtitles: 6 }; // 전체 막대에서 차지하는 몫
  const STATE_WORD = { done: '끝났어요', running: '하는 중이에요', waiting: '도움을 기다려요', error: '문제가 생겼어요', stopped: '멈췄어요', pending: '아직이에요' };
  const SHAPE_OF = { '16:9': '가로 영상', '9:16': '세로 영상', '1:1': '네모 영상', '4:5': '조금 세로인 영상' };
  const MODE_KO = { ghibli: '🌿 신나는 부분만 움직여요', full: '🏃 계속 움직여요', limited: '🖼 조금만 움직여요' };

  function tabForStep(step, status) {
    if (status === 'done') return 'final';
    return { music: 'timing', plan: 'plan', timing: 'timing', xsheet: 'xsheet', drawings: 'drawings', render: 'final', subtitles: 'final' }[step] || 'timing';
  }

  // ---------- 공용 도우미 (장면 고치기 · 가사 자막 스튜디오도 AM.proj 로 같이 쓴다) ----------
  function abs(snap, rel) { return AM.joinPath(snap.dir, rel); }
  function url(snap, rel, v) { return AM.fileUrl(abs(snap, rel), v); }
  function aspectCss(a) { return ({ '9:16': '9 / 16', '16:9': '16 / 9', '1:1': '1 / 1', '4:5': '4 / 5' })[a] || '16 / 9'; }
  function dcolor(id) { return DCOLORS[Math.max(0, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.indexOf(String(id).slice(-1))) % DCOLORS.length]; }
  function drawingOf(snap, shotNo, id) { return (snap.drawings || []).find((d) => d.shot === shotNo && d.id === id); }
  function shotOf(snap, shotNo) { return ((snap.xsheet && snap.xsheet.shots) || []).find((s) => s.shot === shotNo) || null; }
  /** 초 → "1:05" (tenths 이면 "1:05.3") */
  function fmtTime(sec, tenths) {
    const t = Math.max(0, Number(sec) || 0);
    const m = Math.floor(t / 60);
    return tenths ? `${m}:${(t % 60).toFixed(1).padStart(4, '0')}` : `${m}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  }
  /** render/subtitles 단계가 돌고 있으면 output 폴더의 영상 파일이 지워지고 다시 써진다 → 그 파일을 연 <video> 는 놓아 줘야 한다 */
  function mediaLocked(snap) { return !!(snap && snap.running && ['render', 'subtitles'].includes(snap.currentStep)); }
  function releaseVideo(v) {
    try { v.pause(); } catch (_) { /* noop */ }
    v.removeAttribute('src');
    try { v.load(); } catch (_) { /* noop */ }
  }
  function releaseVideosIn(root) { if (root && root.querySelectorAll) root.querySelectorAll('video').forEach(releaseVideo); }
  AM.proj = { url, abs, aspectCss, drawingOf, shotOf, fmtTime, mediaLocked, releaseVideo, releaseVideosIn };

  const isLocked = (snap) => mediaLocked(snap) || !!(cur && cur.starting);
  const hasMovie = (snap) => !!(snap.output && snap.output.video);
  const hasClean = (snap) => !!(snap.output && snap.output.clean);
  const isEarly = (snap) => EARLY.includes(snap.currentStep);
  /** 'done' = 보여 줄 영상이 있다(완성 화면) · 'progress' = 만드는 중이거나 아직 영상이 없다(진행 카드) */
  function kindOf(snap) { return hasMovie(snap) && (snap.status === 'done' || !isEarly(snap)) ? 'done' : 'progress'; }
  const busyNow = (snap) => !!(snap.running || (snap.redrawing && snap.redrawing.length));

  const stepOf = (snap, id) => (snap.steps && snap.steps[id]) || {};
  function stateOf(snap, id) {
    let st = stepOf(snap, id).status || 'pending';
    if (st === 'running' && !snap.running) st = 'stopped';
    if (st === 'running' && snap.waiting && snap.currentStep === id) st = 'waiting';
    return st;
  }
  function currentMeta(snap) {
    let id = snap.currentStep;
    if (!STEP_IDS.includes(id)) id = STEP_IDS.find((x) => stepOf(snap, x).status !== 'done') || 'subtitles';
    return AM.STEP_META.find((m) => m.id === id);
  }
  function stepFrac(s) { const p = s && s.progress; return p && p.total > 0 ? Math.max(0, Math.min(1, p.done / p.total)) : null; }
  function overallPct(snap) {
    let acc = 0;
    let tot = 0;
    for (const id of STEP_IDS) {
      const w = STEP_W[id];
      tot += w;
      const s = stepOf(snap, id);
      if (s.status === 'done') acc += w;
      else if (['running', 'waiting', 'error', 'stopped'].includes(s.status)) { const f = stepFrac(s); if (f != null) acc += w * f; }
    }
    return Math.round((acc / tot) * 100);
  }
  /** 반영하기(영상 다시 만들기 + 자막) 진행률: 영상 만들기 80 + 자막 20 (자막만이면 자막이 100) */
  function applyPct(snap) {
    const fr = (s) => (s.status === 'done' ? 1 : s.status === 'running' ? (stepFrac(s) || 0) : 0);
    const rs = stepOf(snap, 'render');
    const ss = stepOf(snap, 'subtitles');
    const withRender = cur && cur.applyFrom ? cur.applyFrom !== 'subtitles' : snap.currentStep === 'render';
    return Math.round((withRender ? fr(rs) * 0.8 + fr(ss) * 0.2 : fr(ss)) * 100);
  }
  /** "12/29장" · "장면 3/9" · "45%" */
  function countText(snap, meta) {
    const p = stepOf(snap, meta.id).progress;
    if (!p || !(p.total > 0)) return '';
    if (meta.id === 'drawings') return `${Math.min(p.total, Math.floor(p.done))}/${p.total}장`;
    if (meta.id === 'render') { const n = p.total - 1; const k = Math.floor(p.done); return k >= n ? '장면을 이어 붙이는 중' : `장면 ${k + 1}/${n}`; }
    if (meta.id === 'subtitles') return `${Math.round((p.done / p.total) * 100)}%`;
    return '';
  }
  /** 지금 단계가 끝나기까지 남은 초 (모르면 null) */
  function remainingSec(snap, meta) {
    const s = stepOf(snap, meta.id);
    if (!s.startedAt || s.status !== 'running') return null;
    const el = (Date.now() - s.startedAt) / 1000;
    const f = stepFrac(s);
    if (f != null && f >= 0.04 && el >= 6) return (el * (1 - f)) / f;
    if (f == null && s.lastMs && s.lastMs / 1000 - el > 5) return s.lastMs / 1000 - el;
    return null;
  }
  function minutesWords(min) {
    const m = Math.round(Number(min));
    if (!(m > 0)) return '';
    if (m < 60) return `약 ${m}분`;
    const hr = Math.floor(m / 60);
    const rest = Math.round((m % 60) / 5) * 5;
    return rest && rest < 60 ? `약 ${hr}시간 ${rest}분` : `약 ${hr}시간`;
  }
  function etaWords(sec) {
    if (sec == null) return '';
    if (sec < 25) return '곧 끝나요';
    if (sec < 90) return '1분쯤 남았어요';
    return `${minutesWords(sec / 60)} 남았어요`;
  }
  /** 백엔드가 보낸 안내 글에 남은 옛 말을 쉬운 말로 (프롬프트 → 그림 주문 글, 컷 → 장면 …) */
  function plainText(t) {
    return String(t == null ? '' : t)
      .replace(/\[프롬프트 복사\]/g, '[📋 그림 주문 글 복사]')
      .replace(/프롬프트/g, '그림 주문 글')
      .replace(/컷\s?(\d+)/g, '장면 $1')
      .replace(/컷/g, '장면')
      .replace(/타임시트/g, '그림 순서표')
      .replace(/렌더링/g, '영상 만들기');
  }
  function splitDoing(doing) { const m = /^(\S+)\s+(.*)$/.exec(String(doing || '')); return m ? [m[1], m[2]] : ['🎬', String(doing || '')]; }

  // ---------- 화면 ----------
  AM.views.project = async function project(id) {
    const snap = await window.api.getProject(id);
    AM.state.projects.set(id, snap);
    if (AM.state.view !== 'project' || AM.state.projectId !== id) return h('div'); // 기다리는 사이 다른 화면으로 갔다
    teardown();
    const root = h('div', { class: 'pv-page' });
    cur = {
      id, snap, mode: 'watch', root, els: {}, sigs: {}, tab: tabForStep(snap.currentStep, snap.status), userTab: false,
      ctl: null, view: null, dv: null, bar: null, timers: new Set(), starting: 0, sawRunning: false, applyFrom: null, applyToast: false, buildSeen: false,
      helpBusy: false, editorBusy: false, focusShot: null,
    };
    cur.buildSeen = !!(snap.running && kindOf(snap) === 'progress'); // 만드는 중에 이 화면을 연 것도 끝나면 '완성' 알림을 낸다
    cur.els.head = h('div', { class: 'pv-head' });
    cur.els.top = h('div', { class: 'pv-top' });
    cur.els.alert = h('div', { class: 'pv-alerts' });
    cur.els.main = h('div', { class: 'pv-main' });
    root.append(cur.els.head, cur.els.top, cur.els.alert, cur.els.main);
    renderAll(snap);
    return root;
  };

  function teardown() {
    if (!cur) return;
    const c = cur;
    cur = null;
    c.timers.forEach((t) => clearTimeout(t));
    if (c.ctl) { try { c.ctl.destroy(); } catch (e) { console.error(e); } if (c.mode === 'subs') AM.leaveGuard = null; }
    releaseVideosIn(c.root); // 열어 둔 영상 파일을 놓아 준다 (윈도우는 열린 파일을 못 지운다)
  }
  AM.views.projectLeave = teardown;

  AM.views.projectUpdate = function (snap) {
    if (!cur || cur.id !== snap.id) return;
    const prev = cur.snap;
    cur.snap = snap;
    if (cur.starting) { // '반영 시작' 표시는 돌기 시작했다가 끝나면(또는 오래 안 돌면) 거둔다
      if (snap.running) cur.sawRunning = true;
      else if (cur.sawRunning || Date.now() - cur.starting > 12000) cur.starting = 0;
    }
    renderHead(snap);
    if (cur.mode === 'watch' || cur.mode === 'details') renderTop(snap);
    renderAlert(snap);
    if (cur.mode === 'watch') patchWatch(snap);
    else if (cur.mode === 'details') patchDetails(snap, prev);
    renderBar(snap);
    if (snap.running && kindOf(snap) === 'progress') cur.buildSeen = true;
    if (prev.running && !snap.running && snap.status === 'done') {
      if (cur.applyToast) toast('✅ 반영했어요. 새 영상으로 바뀌었어요.', 'ok');
      else if (cur.buildSeen) toast('🎉 완성했어요! 영상을 확인해 보세요.', 'ok');
      cur.buildSeen = false;
    }
    if (!snap.running) { cur.applyToast = false; cur.applyFrom = null; }
    if (cur.ctl) { try { cur.ctl.update(snap); } catch (e) { console.error(e); } }
  };

  AM.views.projectLog = function (line) {
    if (!cur || cur.mode !== 'details' || cur.tab !== 'log' || !cur.els.logbox) return;
    const box = cur.els.logbox;
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    box.appendChild(document.createTextNode(`${line}\n`));
    if (atBottom) box.scrollTop = box.scrollHeight;
  };

  function renderAll(snap) {
    cur.headSig = '';
    cur.alertSig = '';
    cur.topSig = '';
    renderHead(snap);
    renderTop(snap);
    renderAlert(snap);
    buildMain(snap);
    renderBar(snap);
  }

  // ---------- 모드 바꾸기 ----------
  /** 모드를 바꾼다. 저장하지 않은 변경이 있는 편집 화면(AM.leaveGuard)은 한 번 물어본다. opts.force: 편집 화면이 스스로 닫을 때 */
  async function setMode(mode, opts = {}) {
    const c = cur;
    if (!c) return false;
    if (c.mode === mode) {
      if (opts.tab) { c.tab = opts.tab; c.userTab = true; c.sigs = {}; if (mode === 'details') { renderTabs(c.snap); renderBody(c.snap, true); } }
      return true;
    }
    if (!opts.force && AM.leaveGuard) {
      const g = AM.leaveGuard;
      let ok = true;
      try { ok = await g(); } catch (_) { ok = true; }
      if (ok === false) return false;
      if (AM.leaveGuard === g) AM.leaveGuard = null;
      if (cur !== c) return false;
    }
    leaveMode();
    c.mode = mode;
    if (opts.tab) { c.tab = opts.tab; c.userTab = true; c.sigs = {}; }
    c.focusShot = opts.focusShot == null ? null : opts.focusShot;
    renderAll(c.snap);
    const main = document.getElementById('main');
    if (main) main.scrollTop = 0;
    return true;
  }

  function leaveMode() {
    if (cur.ctl) {
      try { cur.ctl.destroy(); } catch (e) { console.error(e); }
      cur.ctl = null;
      if (cur.mode === 'subs') AM.leaveGuard = null; // 스튜디오가 닫히면 경고도 같이 없어진다
    }
    releaseVideosIn(cur.els.main);
    cur.dv = null;
    cur.view = null;
    cur.editorBusy = false;
  }

  function openDetails(tab) { return setMode('details', { tab }); }

  function buildMain(snap) {
    releaseVideosIn(cur.els.main);
    const main = clear(cur.els.main);
    cur.view = null;
    cur.dv = null;
    cur.els.top.classList.toggle('hidden', cur.mode !== 'watch');
    if (cur.mode === 'watch') {
      const kind = kindOf(snap);
      cur.view = kind === 'done' ? buildDone(snap) : buildProgress();
      main.appendChild(cur.view.el);
      if (kind === 'done') syncDone(snap); else patchProgress(cur.view, snap);
    } else if (cur.mode === 'details') {
      cur.els.stepper = h('div', { class: 'stepper' });
      cur.els.tabs = h('div', { class: 'tabs' });
      cur.els.body = h('div');
      main.append(
        h('div', { class: 'pv-details-top' },
          h('button', { class: 'btn', onclick: () => setMode('watch') }, '← 돌아가기'),
          h('span', { class: 'muted small' }, '고급 보기예요. 처음이라면 안 봐도 괜찮아요.')),
        cur.els.stepper, cur.els.tabs, cur.els.body);
      renderStepper(snap);
      renderTabs(snap);
      renderBody(snap, true);
    } else {
      mountEditor(main);
    }
  }

  function makeCtx() {
    const c = cur;
    const ctx = {
      id: c.id,
      getSnap: () => (cur === c ? c.snap : window.AM.state.projects.get(c.id)),
      api: window.api,
      toast: AM.toast,
      onClose: () => { if (cur === c && c.mode !== 'watch') setMode('watch', { force: true }); },
      onBusy: (b) => { if (cur === c) { c.editorBusy = !!b; renderBar(c.snap); } },
    };
    if (c.mode === 'scenes' && c.focusShot != null) ctx.focusShot = c.focusShot;
    return ctx;
  }

  function mountEditor(main) {
    const c = cur;
    const mode = c.mode;
    const lib = mode === 'scenes' ? AM.scenes : AM.substudio;
    const host = h('div', { class: `pv-editor pv-editor-${mode}` });
    main.appendChild(host);
    const fail = (msg) => host.appendChild(h('div', { class: 'notice warn' }, msg, ' ', h('button', { class: 'btn small', onclick: () => setMode('watch', { force: true }) }, '← 돌아가기')));
    if (!lib || typeof lib.mount !== 'function') { fail('이 화면은 아직 준비 중이에요.'); return; }
    try {
      const ret = lib.mount(host, makeCtx());
      if (ret && typeof ret.then === 'function') {
        ret.then((ctl) => { if (cur === c && c.mode === mode) c.ctl = ctl; else if (ctl && ctl.destroy) ctl.destroy(); }, (e) => { console.error(e); fail(`화면을 여는 중 문제가 생겼어요: ${e.message || e}`); });
      } else c.ctl = ret;
    } catch (e) {
      console.error(e);
      fail(`화면을 여는 중 문제가 생겼어요: ${e.message || e}`);
    }
  }

  // ---------- 머리 ----------
  function chipState(snap) { return snap.running ? (snap.waiting ? 'waiting' : (snap.status === 'limited' ? 'limited' : 'running')) : snap.status; }
  function metaLine(snap) {
    const s = snap.series;
    const wf = snap.workflow || {};
    const bits = [];
    if (s && s.characters && s.characters.length) bits.push(`주인공 ${s.characters.map((c) => AM.niceTitle(c.name)).join(', ')}`);
    bits.push(SHAPE_OF[wf.aspect] || '가로 영상');
    if (AM.MOTION_LABEL[wf.motionMode]) bits.push(AM.MOTION_LABEL[wf.motionMode]);
    return bits.join(' · ');
  }
  const titleOf = (snap) => AM.niceTitle((snap.plan && snap.plan.title) || snap.title) || '이름 없는 영상';

  function renderHead(snap) {
    const title = titleOf(snap);
    const st = chipState(snap);
    const s = snap.series;
    const redrawOnly = !snap.running && !!(snap.redrawing && snap.redrawing.length);
    const meta = metaLine(snap);
    const sig = JSON.stringify([title, st, s && [s.id, s.name, s.emoji, s.episode], meta, busyNow(snap), redrawOnly, cur.mode]);
    if (cur.headSig === sig) return;
    cur.headSig = sig;
    const el = clear(cur.els.head);
    const crumb = { scenes: '✏️ 장면 고치기', subs: '💬 가사 자막 고치기', details: '🛠 자세히 보기' }[cur.mode];
    const editorMode = cur.mode === 'scenes' || cur.mode === 'subs'; // 편집 화면에서는 제목 줄을 접어서 자리를 넓힌다
    el.append(...[
      h('div', { class: 'pv-nav' },
        h('button', { class: 'btn ghost pv-back', onclick: () => AM.go('projects') }, '← 내 영상'),
        crumb ? h('span', { class: 'pv-crumb' }, '›', h('button', { type: 'button', class: 'pv-link', onclick: () => setMode('watch') }, title), '›', h('b', null, crumb)) : null,
        h('span', { class: 'grow' }),
        busyNow(snap) ? h('button', { class: 'btn danger pv-stopbtn', onclick: stopNow }, redrawOnly ? '■ 그림 그리기 멈추기' : '■ 멈추기') : null,
        AM.kit.menu(menuItems, { title: '더 보기' })),
      editorMode ? null : h('div', { class: 'pv-titlebar' },
        h('h1', { class: 'pv-title' }, title),
        h('span', { class: `status-pill st-${st}` }, AM.STATUS_LABEL[st] || st),
        s ? h('button', { type: 'button', class: 'chip pri pv-series', title: '주인공 화면으로', onclick: () => AM.go('hero', s.id) }, `${s.emoji || '📺'} ${AM.niceTitle(s.name)} · ${s.episode}화`) : null),
      cur.mode === 'watch' ? h('div', { class: 'pv-meta' }, meta) : null,
    ].filter(Boolean));
  }

  function menuItems() {
    const s = cur.snap;
    const busy = busyNow(s);
    return [
      { label: '📂 저장 폴더 열기', onClick: () => window.api.openPath(s.dir) },
      { label: '↻ 단계 다시 하기', disabled: busy, onClick: () => redoDialog(cur.snap) },
      { label: '🔧 담당 AI 바꾸기', disabled: busy, onClick: () => providersDialog(cur.snap) },
      { label: '🛠 자세히 보기 (고급)', onClick: () => openDetails() },
      { label: busy ? '🗑 이 영상 지우기 (만드는 중에는 안 돼요)' : '🗑 이 영상 지우기', danger: true, disabled: busy, onClick: deleteNow },
    ];
  }

  function stopNow() { return AM.safe(() => window.api.stopProject(cur.id), '멈췄어요'); }

  async function deleteNow() {
    const c = cur;
    const s = c.snap;
    if (!await AM.confirmBox('영상을 지울까요?', `"${titleOf(s)}" 영상과 작업 폴더를 통째로 지워요.\n되돌릴 수 없어요.`, '🗑 지우기', 'danger')) return;
    if (cur !== c) return;
    if (!await setMode('watch')) return;
    releaseVideosIn(c.root);
    if (await AM.safe(() => window.api.deleteProject(s.id), '지웠어요')) AM.go('projects');
  }

  /** 처음 만든 연습 영상 위에 "진짜 그림으로 만들어 볼까요?" 안내 */
  function renderTop(snap) {
    const want = cur.mode === 'watch' && kindOf(snap) === 'done' && snap.status === 'done' && AM.isAllDemo(snap);
    const sig = want ? '1' : '';
    if (cur.topSig === sig) return;
    cur.topSig = sig;
    const el = clear(cur.els.top);
    if (!want) return;
    el.appendChild(h('div', { class: 'mk-invite pv-invite' },
      h('div', { class: 'grow' },
        h('div', { class: 'mk-invite-t' }, '🎉 연습 영상이 완성됐어요!'),
        h('div', { class: 'mk-invite-d' }, '진짜 그림으로 만들어 볼까요? 가지고 있는 구독을 연결하면 돼요.')),
      h('button', { class: 'btn primary big', onclick: () => AM.go('settings') }, '🔌 내 AI 연결하기')));
  }

  // ---------- 진행 카드 ----------
  function progressVM(snap) {
    const meta = currentMeta(snap);
    const [icon, doing] = splitDoing(meta.doing);
    const running = !!snap.running;
    const dots = AM.STEP_META.map((m) => stateOf(snap, m.id));
    const vm = { tone: 'run', emoji: icon, title: doing, sub: '', pct: overallPct(snap), indet: false, dots, canStop: running, stepNo: STEP_IDS.indexOf(meta.id) + 1 };
    const count = countText(snap, meta);
    const w = snap.waiting;
    if (running && w) {
      vm.tone = 'wait';
      vm.sub = w.key === 'review:drawings' ? '👆 위에서 골라 주세요' : '👆 위 카드에서 할 일을 해 주세요';
    } else if (running && snap.status === 'limited') {
      vm.tone = 'wait';
      vm.emoji = '⏸';
      vm.title = '잠깐 쉬고 있어요';
      vm.sub = `${count ? `${count}까지 했어요 · ` : ''}쉬었다가 저절로 이어서 해요`; // 몇 시에 이어서 하는지는 위 안내 줄이 알려 줘요
    } else if (running) {
      vm.sub = [count, etaWords(remainingSec(snap, meta))].filter(Boolean).join(' · ');
      const noCount = !stepFrac(stepOf(snap, meta.id));
      vm.indet = noCount && ['music', 'plan', 'timing', 'xsheet'].includes(meta.id);
    } else if (snap.status === 'error' || snap.status === 'limited') {
      vm.tone = 'err';
      vm.emoji = snap.status === 'limited' ? '⏸' : '😢';
      vm.title = snap.status === 'limited' ? '오늘은 여기까지 했어요' : '여기서 멈췄어요';
      vm.sub = `${meta.label} 단계${count ? ` · ${count}` : ''}`;
    } else if (snap.status === 'stopped') {
      vm.tone = 'stop';
      vm.emoji = '⏹';
      vm.title = '멈춰 있어요';
      vm.sub = `${meta.label} 단계${count ? ` · ${count}` : ''}`;
    } else {
      vm.tone = 'stop';
      vm.emoji = '🎬';
      vm.title = '아직 시작하지 않았어요';
      vm.sub = '';
    }
    return vm;
  }

  function buildProgress() {
    const emoji = h('div', { class: 'pv-prog-emoji', 'aria-hidden': 'true' });
    const title = h('h2', { class: 'pv-prog-title' });
    const sub = h('div', { class: 'pv-prog-sub' });
    const bar = AM.kit.progressBar(0);
    const dots = AM.STEP_META.map(() => h('span', { class: 'pv-dot' }));
    const dotsLbl = h('span', { class: 'pv-dots-lbl' });
    const stop = h('button', { class: 'btn danger', onclick: stopNow }, '■ 멈추기');
    const more = h('button', { type: 'button', class: 'pv-link', onclick: () => openDetails() }, '자세히 보기');
    const edScenes = h('button', { class: 'btn', onclick: () => setMode('scenes') }, '✏️ 장면 고치기');
    const edSubs = h('button', { class: 'btn', onclick: () => setMode('subs') }, '💬 가사 자막 고치기');
    const edNote = h('span', { class: 'pv-ed-note' });
    const el = h('section', { class: 'pv-card pv-prog t-run', 'aria-live': 'polite' },
      h('div', { class: 'pv-prog-top' }, emoji, h('div', { class: 'pv-prog-main' }, title, sub)),
      bar,
      h('div', { class: 'pv-prog-foot' },
        h('div', { class: 'pv-dots', role: 'img' }, dots, dotsLbl),
        h('div', { class: 'pv-prog-acts' }, stop, more)),
      h('div', { class: 'pv-prog-ed' }, edScenes, edSubs, edNote));
    return { kind: 'progress', el, emoji, title, sub, bar, dots, dotsLbl, stop, edScenes, edSubs, edNote, last: {} };
  }

  function patchProgress(v, snap) {
    const vm = progressVM(snap);
    const L = v.last;
    const set = (key, val, fn) => { if (L[key] !== val) { L[key] = val; fn(val); } };
    set('tone', vm.tone, (t) => { v.el.className = `pv-card pv-prog t-${t}`; });
    set('emoji', vm.emoji, (t) => { v.emoji.textContent = t; });
    set('title', vm.title, (t) => { v.title.textContent = t; });
    set('sub', vm.sub, (t) => { v.sub.textContent = t; v.sub.classList.toggle('hidden', !t); });
    set('pct', `${vm.indet ? 'i' : vm.pct}`, () => v.bar.set(vm.indet ? null : vm.pct));
    vm.dots.forEach((st, i) => set(`d${i}`, st, (s) => {
      v.dots[i].className = `pv-dot s-${s}`;
      v.dots[i].title = `${i + 1}. ${AM.STEP_META[i].label} · ${STATE_WORD[s] || s}`;
    }));
    set('dl', vm.stepNo, (n) => { v.dotsLbl.textContent = `${n} / ${STEP_IDS.length} 단계`; });
    set('stop', vm.canStop, (b) => v.stop.classList.toggle('hidden', !b));
    // 장면은 영상(가사 글씨 없는 영상)이 만들어진 뒤에 고친다. 자막 모양·글자는 영상이 없어도 스튜디오가 첫 그림 위에서 보여 주므로 자막을 입히는 동안만 막는다
    const scenesOk = hasClean(snap) && !mediaLocked(snap);
    const subsOk = !(snap.running && snap.currentStep === 'subtitles');
    set('ed', `${scenesOk}|${subsOk}`, () => {
      v.edScenes.disabled = !scenesOk;
      v.edSubs.disabled = !subsOk;
      v.edScenes.title = scenesOk ? '' : '영상이 만들어지면 고칠 수 있어요';
      v.edSubs.title = subsOk ? '' : '자막을 입히는 중이에요. 끝나면 고칠 수 있어요.';
      v.edNote.textContent = scenesOk ? '' : '장면은 영상이 만들어지면 고칠 수 있어요';
    });
  }

  // ---------- 완성 화면 ----------
  function aspectNum(a) { const m = /^(\d+):(\d+)$/.exec(String(a || '16:9')); return m ? [Number(m[1]), Number(m[2])] : [16, 9]; }
  function posterOf(snap) {
    const d = (snap.drawings || []).find((x) => x.file && x.status !== 'running' && x.status !== 'error');
    return d ? url(snap, d.file, d.updatedAt) : '';
  }
  const videoKey = (snap) => `${snap.output && snap.output.video}|${(snap.output && snap.output.madeAt) || ''}`;

  function buildDone(snap) {
    const [aw, ah] = aspectNum(snap.workflow && snap.workflow.aspect);
    const tall = ah > aw;
    const stage = h('div', { class: 'pv-stage' });
    const note = h('div', { class: 'pv-stage-note hidden' }, AM.kit.spinner(), h('span', null, '새 영상을 만드는 중이에요'));
    const err = h('div', { class: 'pv-stage-err hidden' }, h('div', { class: 'col', style: { alignItems: 'center' } },
      h('div', null, '영상을 열 수 없어요. 파일이 지워졌을 수 있어요.'),
      h('button', { class: 'btn primary', onclick: () => startRun(() => window.api.runProject(cur.id, 'render')) }, '🎬 영상 다시 만들기')));
    stage.append(note, err);
    const title = h('h2', { class: 'pv-done-title' });
    const bScenes = h('button', { class: 'btn primary xl pv-act', onclick: () => setMode('scenes') }, '✏️ 장면 고치기');
    const bSubs = h('button', { class: 'btn primary xl pv-act', onclick: () => setMode('subs') }, '💬 가사 자막 고치기');
    const bFolder = h('button', { class: 'btn xl pv-act', onclick: () => showFile() }, '📂 저장 위치');
    const bNext = snap.series ? h('button', { class: 'btn xl pv-act', onclick: () => AM.go('home', cur.snap.series.id) }, '🎬 다음 화 만들기') : null;
    const fileLine = h('div', { class: 'pv-fine' });
    const el = h('section', { class: `pv-done${tall ? ' tall' : ''}` },
      h('div', { class: 'pv-done-stage' }, stage),
      h('div', { class: 'pv-done-side' },
        title,
        h('div', { class: 'pv-actions' }, bScenes, bSubs, bFolder, bNext),
        fileLine,
        h('div', { class: 'pv-fine' }, '📌 AI 로 만든 영상이에요. 올릴 때 AI 로 만들었다고 알려 주세요. (파일 정보에도 AI 생성 표시를 넣어 두었어요)')));
    el.style.setProperty('--ar', String(aw / ah));
    cur.dv = { stage, note, err, video: null, still: null, key: '', resumeAt: 0 };
    return { kind: 'done', el, title, bScenes, bSubs, fileLine, last: {} };
  }

  function showFile() {
    const s = cur.snap;
    if (s.output && s.output.video) window.api.showItem(abs(s, s.output.video));
  }

  function mountVideo(snap) {
    const dv = cur.dv;
    if (dv.still) { dv.still.remove(); dv.still = null; }
    dv.err.classList.add('hidden');
    const o = snap.output;
    const v = h('video', { class: 'pv-video', controls: true, preload: 'metadata', playsinline: true });
    const poster = posterOf(snap);
    if (poster) v.poster = poster;
    v.addEventListener('error', () => { if (dv.video === v) dv.err.classList.remove('hidden'); });
    v.src = AM.fileUrl(abs(snap, o.video), o.madeAt);
    if (dv.resumeAt > 0.5) {
      const at = dv.resumeAt;
      v.addEventListener('loadedmetadata', () => { try { v.currentTime = Math.min(at, Math.max(0, (v.duration || at) - 0.1)); } catch (_) { /* noop */ } }, { once: true });
    }
    dv.resumeAt = 0;
    dv.stage.insertBefore(v, dv.stage.firstChild);
    dv.video = v;
    dv.key = videoKey(snap);
  }

  /** 영상 파일을 놓아 준다. 마지막으로 보던 화면은 그림으로 남겨 둔다 */
  function lockVideo(snap) {
    const dv = cur.dv;
    const v = dv.video;
    if (!v) return;
    let still = null;
    try {
      if (v.readyState >= 2 && v.videoWidth && (v.currentTime > 0.3 || !posterOf(snap))) { // 처음 자리면 첫 그림으로 충분하다
        still = document.createElement('canvas');
        still.width = v.videoWidth;
        still.height = v.videoHeight;
        still.getContext('2d').drawImage(v, 0, 0);
      }
    } catch (_) { still = null; }
    dv.resumeAt = v.currentTime || 0;
    releaseVideo(v);
    v.remove();
    dv.video = null;
    dv.key = '';
    showStill(snap, still);
  }

  function showStill(snap, canvas) {
    const dv = cur.dv;
    if (dv.still) dv.still.remove();
    const poster = posterOf(snap);
    const el = canvas || (poster ? h('img', { src: poster, alt: '' }) : h('div'));
    el.classList.add('pv-still');
    dv.stage.insertBefore(el, dv.stage.firstChild);
    dv.still = el;
  }

  function syncVideo(snap) {
    const dv = cur.dv;
    const locked = isLocked(snap);
    dv.note.classList.toggle('hidden', !(locked || snap.running));
    if (locked) {
      if (dv.video) lockVideo(snap);
      else if (!dv.still) showStill(snap, null);
      return;
    }
    if (dv.video && dv.key === videoKey(snap)) return;
    if (dv.video) { dv.resumeAt = dv.video.currentTime || 0; releaseVideo(dv.video); dv.video.remove(); dv.video = null; }
    mountVideo(snap);
  }

  function syncDone(snap) {
    const v = cur.view;
    const L = v.last;
    const o = snap.output || {};
    const dur = AM.fmtDur(snap.durationSec || (snap.song && snap.song.duration));
    const t = `🎉 ${snap.series ? `${snap.series.episode}화 ` : ''}완성!${dur ? ` · ${dur}` : ''}`;
    if (L.title !== t) { L.title = t; v.title.textContent = t; }
    const f = (o.video || '').split('/').pop();
    if (L.file !== f) { L.file = f; v.fileLine.textContent = f ? `파일 이름: ${f}` : ''; }
    const dis = isLocked(snap);
    const reason = dis ? '새 영상을 만드는 중이에요. 끝나면 고칠 수 있어요.' : '';
    const key = `${dis}|${!!snap.xsheet}`;
    if (L.dis !== key) {
      L.dis = key;
      v.bScenes.disabled = dis || !snap.xsheet;
      v.bSubs.disabled = dis;
      v.bScenes.title = reason;
      v.bSubs.title = reason;
    }
    syncVideo(snap);
  }

  function patchWatch(snap) {
    const kind = kindOf(snap);
    if (!cur.view || cur.view.kind !== kind) { buildMain(snap); return; }
    if (kind === 'done') syncDone(snap); else patchProgress(cur.view, snap);
  }

  // ---------- 도움 카드 (진행 카드 위) ----------
  function lateNow(w) {
    if (!w.since) return 0;
    const left = 60000 - (Date.now() - w.since);
    if (left <= 0) return 1;
    const k = `${w.key}|${w.since}`;
    if (cur.lateKey !== k) { // 60초 뒤에 '받은 파일이 안 보이면' 줄이 나오도록 한 번 다시 그린다
      cur.lateKey = k;
      clearTimeout(cur.lateTimer);
      cur.timers.delete(cur.lateTimer);
      cur.lateTimer = setTimeout(() => { if (cur) { cur.alertSig = ''; renderAlert(cur.snap); } }, left + 50);
      cur.timers.add(cur.lateTimer);
    }
    return 0;
  }

  function alertModel(snap) {
    const w = snap.waiting;
    const redraw = !!(snap.redrawing && snap.redrawing.length); // 그림 한 장 다시 그리기도 도우미 모드면 도움을 기다린다
    let m = null;
    if (w && snap.running && w.kind === 'review' && w.key === 'review:lyrics') m = { kind: 'review', sig: `lyrics|${w.key}`, build: lyricsReviewCard };
    else if (w && snap.running && w.kind === 'review' && w.key === 'review:drawings') {
      const e = w.estimate || {};
      const a = w.alt || {};
      m = { kind: 'review', sig: `drawings|${e.pictures}|${e.minutes}|${a.pictures}|${a.minutes}|${!!w.busy}|${cur.helpBusy}`, build: drawingsReviewCard };
    } else if (w && snap.running && w.kind === 'review') m = { kind: 'review', sig: `review|${w.key}|${w.message}`, build: genericReviewCard };
    else if (w && (snap.running || redraw) && w.kind === 'bot') m = { kind: 'bot', sig: `bot|${w.key}|${w.title}|${w.message}`, build: botCard };
    else if (w && (snap.running || redraw)) m = { kind: 'helper', sig: `helper|${w.key}|${(w.images || []).length}|${w.message}|${lateNow(w)}`, build: helperCard };
    else if (snap.status === 'limited' && snap.running && snap.limitUntil) m = { kind: 'limit', sig: `limit|${snap.limitUntil}`, build: limitNotice };
    else if (!snap.running) {
      if (snap.status === 'error' || snap.status === 'limited') m = { kind: 'error', sig: `error|${snap.status}|${snap.error}`, build: errorCard };
      else if (snap.status === 'stopped') m = { kind: 'stopped', sig: 'stopped', build: stoppedCard };
      else if (snap.status !== 'done' && !hasMovie(snap)) m = { kind: 'idle', sig: 'idle', build: idleCard };
    }
    // 장면 고치기 · 자막 스튜디오 안에서는 도움이 필요한 카드(도우미 · 자동 클릭)만 위에 보여 준다
    if (m && (cur.mode === 'scenes' || cur.mode === 'subs') && m.kind !== 'helper' && m.kind !== 'bot') return null;
    return m;
  }

  function renderAlert(snap) {
    const m = alertModel(snap);
    const sig = m ? m.sig : '';
    if (cur.alertSig === sig) return;
    cur.alertSig = sig;
    const el = clear(cur.els.alert);
    if (m) el.appendChild(m.build(snap));
  }

  function resumeNow() { return startRun(() => window.api.runProject(cur.id)); }

  function card(cls, ...kids) { return h('section', { class: `pv-card pv-help ${cls || ''}` }, ...kids); }

  function lyricsReviewCard(snap) {
    const later = h('button', {
      class: 'btn xl',
      onclick: async () => {
        later.disabled = true;
        const r = await AM.safe(() => window.api.continueReview(snap.id));
        if (r === undefined) later.disabled = false;
      },
    }, '나중에 하기 ▶');
    return card('',
      h('h3', null, '🎤 가사가 노래에 맞게 나오려면 시간을 맞춰야 해요'),
      h('p', null, '노래를 들으면서, 가사 줄이 시작될 때 버튼을 누르면 돼요. 1~2분이면 끝나요.'),
      h('div', { class: 'pv-help-acts' }, h('button', { class: 'btn primary xl', onclick: () => lyricSyncModal() }, '🎤 지금 맞추기'), later),
      h('p', { class: 'pv-note' }, "'나중에 하기'를 누르면 자동으로 맞춰 줄게요. 영상이 끝난 뒤 '가사 자막 고치기'에서 정확하게 맞출 수 있어요."));
  }

  /** 가사 시간 맞추기 (큰 창). 저장하면 시간이 바뀌고, 가사 확인 단계에서 열었다면 이어서 만든다. 취소는 그냥 닫기만 한다 */
  function lyricSyncModal() {
    const snap = cur.snap;
    const t = snap.timing;
    const lines = (t && t.lyrics) || [];
    if (!lines.length || !snap.music || !snap.music.analysis || !snap.music.song) { toast('가사가 아직 없어요.', 'err'); return; }
    const root = document.getElementById('modal-root');
    const ls = window.AMLyricSync.mount({
      lines,
      duration: snap.music.analysis.duration,
      src: url(snap, snap.music.song),
      confirmed: ['tap', 'lrc', 'srt'].includes(t.lyricsSource),
      isActive: () => !!root.lastElementChild && root.lastElementChild.contains(ls.el), // 다른 창이 위에 뜨면 키보드 쉬기
    });
    AM.kit.sheet('🎤 가사 시간 맞추기', ls.el, [
      { label: '취소' },
      {
        label: '💾 저장', kind: 'primary',
        onClick: async () => {
          const s = cur ? cur.snap : snap;
          const ok = await AM.safe(() => window.api.updateLyrics(snap.id, ls.result()));
          if (ok === undefined) return true; // 저장 못 함: 창을 그대로 둔다
          if (s.running && s.waiting && s.waiting.key === 'review:lyrics') {
            await AM.safe(() => window.api.continueReview(snap.id));
            toast('✅ 가사 시간을 저장했어요. 이어서 만들어요.', 'ok');
          } else toast('✅ 가사 시간을 저장했어요.', 'ok');
          return false;
        },
      },
    ], { width: 'min(940px, 96vw)', sticky: true, onClose: () => ls.destroy() });
  }

  function drawingsReviewCard(snap) {
    const w = snap.waiting;
    const xe = (snap.xsheet && snap.xsheet.estimate) || {};
    const est = w.estimate || { pictures: xe.images, minutes: xe.minutes };
    const alt = w.alt;
    const busy = !!(w.busy || cur.helpBusy);
    const choice = (cls, head, subText, onclick) => h('button', { class: `btn xl pv-choice ${cls}`, disabled: busy, onclick }, h('span', null, head), h('small', null, subText));
    const num = (x) => (x ? `그림 ${x.pictures}장${minutesWords(x.minutes) ? ` · ${minutesWords(x.minutes)}` : ''}` : '');
    const go = choice('primary', '이대로 그리기', num(est), async (e) => {
      e.currentTarget.disabled = true;
      const r = await AM.safe(() => window.api.continueReview(snap.id));
      if (r === undefined && cur) { cur.alertSig = ''; renderAlert(cur.snap); }
    });
    const less = alt ? choice('', '그림 줄여서 빨리', `약 ${alt.pictures}장${minutesWords(alt.minutes) ? ` · ${minutesWords(alt.minutes)}` : ''}`, () => reduceNow(alt)) : null;
    return card('',
      h('h3', null, '🎨 그림을 그리기 전에 확인해 주세요'),
      h('p', null, est.pictures ? `이 영상은 그림이 ${est.pictures}장쯤 필요해요. 그림은 AI 가 한 장씩 그려서, 많을수록 오래 걸리고 구독 사용량도 많이 써요.` : '그림을 그리기 전에 확인해 주세요.'),
      h('div', { class: 'pv-help-acts' }, go, less),
      busy ? h('p', { class: 'pv-note' }, AM.kit.spinner(), ' 그림 순서를 다시 짜는 중이에요. 잠깐만 기다려 주세요…') : null,
      h('p', { class: 'pv-note' }, h('button', { type: 'button', class: 'pv-link', onclick: () => openDetails('xsheet') }, '📋 그림 순서표 자세히 보기')));
  }

  async function reduceNow(alt) {
    const c = cur;
    c.helpBusy = true;
    c.alertSig = '';
    renderAlert(c.snap);
    try {
      const patch = { motionMode: alt.motionMode };
      if (alt.drawingBudget != null) patch.drawingBudget = alt.drawingBudget;
      await window.api.setMotion(c.id, patch);
      toast('✅ 그림을 줄였어요. 숫자를 한 번 더 확인해 주세요.', 'ok');
    } catch (e) { toast(e.message || String(e), 'err'); }
    if (cur === c) { c.helpBusy = false; c.alertSig = ''; renderAlert(c.snap); }
  }

  function genericReviewCard(snap) {
    const w = snap.waiting;
    const go = h('button', {
      class: 'btn primary xl',
      onclick: async () => { go.disabled = true; const r = await AM.safe(() => window.api.continueReview(snap.id)); if (r === undefined) go.disabled = false; },
    }, '계속 ▶');
    return card('',
      h('h3', null, '👀 확인해 주세요'),
      h('p', null, plainText(w.message)),
      h('div', { class: 'pv-help-acts' }, go, h('button', { type: 'button', class: 'pv-link', onclick: () => openDetails() }, '자세히 보기')));
  }

  function botCard(snap) {
    const w = snap.waiting;
    return card('',
      h('h3', null, `🤖 ${plainText(w.title)}`),
      h('p', null, plainText(w.message)),
      h('p', { class: 'pv-note' }, '저절로 열린 브라우저 창(작업 표시줄의 Edge/Chrome)을 한 번 봐 주세요. 해결되면 저절로 이어서 해요.'));
  }

  function noteKo(note) {
    if (/previous drawing/.test(note)) return '같은 장면의 앞 그림 (배경·구도 이어서)';
    if (/turnaround/.test(note)) return `${note.split(' — ')[0]} 앞·옆·뒤 모습`;
    if (/expression/.test(note)) return `${note.split(' — ')[0]} 표정 모음`;
    if (/full-body/.test(note)) return `${note.split(' — ')[0]} 전신`;
    return note ? note.split(' — ')[0] : '기준 그림';
  }

  /** 도우미 카드: ① 주문 글 복사 ② 사이트에서 만들기 ③ 받은 파일 넣기 */
  function helperCard(snap) {
    const w = snap.waiting;
    const kindName = { music: '노래', image: '그림' }[w.kind] || '파일';
    const stepBox = (n, head, ...kids) => h('div', { class: 'pv-step' },
      h('span', { class: 'pv-step-n' }, String(n)),
      h('div', { class: 'pv-step-body' }, h('div', { class: 'pv-step-t' }, head), h('div', { class: 'pv-step-acts' }, ...kids)));
    const drop = h('div', { class: 'dropzone' }, `받은 ${kindName} 파일을 여기에 끌어다 놓아도 돼요`);
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      const f = e.dataTransfer.files[0];
      if (f) window.api.provideFile(snap.id, w.key, window.api.pathForFile(f));
    });
    const pick = h('button', {
      class: 'btn big',
      onclick: async () => {
        const f = await window.api.pickFile({ filters: [{ name: kindName, extensions: w.kind === 'image' ? ['png', 'jpg', 'jpeg', 'webp'] : ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'mp4', 'webm', 'mov'] }] });
        if (f) window.api.provideFile(snap.id, w.key, f);
      },
    }, '📁 파일 직접 고르기');
    const steps = [];
    let n = 0;
    const orderName = w.kind === 'music' ? '노래 주문 글' : '그림 주문 글';
    if (w.copyText) {
      steps.push(stepBox(++n, `${orderName}을 복사해요`,
        h('button', { class: 'btn primary big', onclick: () => AM.safe(() => window.api.copyText(w.copyText), '복사했어요. 사이트 입력창에 Ctrl+V 로 붙여넣으세요.') }, `📋 ${orderName} 복사`),
        AM.kit.fold('글 보기', h('div', { class: 'copybox' }, w.copyText))));
    }
    if (w.siteUrl) steps.push(stepBox(++n, `${w.siteName} 에 붙여넣고 ${kindName}을 만들어 받아요`, h('button', { class: 'btn big', onclick: () => window.api.openExternal(w.siteUrl) }, `🌐 ${w.siteName} 열기`)));
    steps.push(stepBox(++n, `받은 ${kindName} 파일을 넣어요 (다운로드 폴더에 생기면 저절로 가져와요)`, drop, pick));
    const refs = (w.images || []).length ? w.images : (w.image ? [{ file: w.image, note: '' }] : []);
    const refBox = refs.length ? h('div', { class: 'helper-refs' },
      h('div', { class: 'small', style: { fontWeight: 700, marginBottom: '6px' } }, '📎 아래 기준 그림도 사이트에 함께 붙여 주세요 (같은 주인공으로 그리게 해요)'),
      h('div', { class: 'row', style: { gap: '8px', alignItems: 'flex-start' } }, refs.map((r, i) => h('div', { class: 'helper-ref' },
        h('img', { src: url(snap, r.file) }),
        h('div', { class: 'small muted' }, `${i + 1}. ${noteKo(r.note)}`),
        h('div', { class: 'row', style: { gap: '4px' } },
          h('button', { class: 'btn small', onclick: () => AM.safe(() => window.api.copyImage(abs(snap, r.file)), '그림을 복사했어요. 사이트에 Ctrl+V 로 붙여넣으세요.') }, '🖼️ 복사'),
          h('button', { class: 'btn small', onclick: () => window.api.showItem(abs(snap, r.file)) }, '📂')))))) : null;
    const late = w.since && Date.now() - w.since >= 60000;
    return card('pv-helper',
      h('h3', null, `🙋 도와주세요: ${plainText(w.title)}`),
      /①/.test(w.message || '') ? null : h('p', null, plainText(w.message)), // 번호 안내는 아래 1·2·3 단계가 대신해요
      h('div', { class: 'pv-steps' }, steps),
      refBox,
      h('div', { class: 'pv-help-acts' },
        h('span', { class: 'watching' }, '받은 파일이 생기면 저절로 가져와요'),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn ghost', onclick: async () => { if (await AM.confirmBox('건너뛸까요?', `이 ${kindName} 없이 이어서 해요. 같은 장면의 다른 그림으로 대신 보여 주고, 나중에 다시 그릴 수 있어요.`, '건너뛰기')) window.api.skipWaiting(snap.id, w.key); } }, '건너뛰기')),
      late ? h('p', { class: 'pv-note' }, `받은 파일이 안 보이면: 다운로드 폴더(${AM.state.info.paths.downloads})에 파일이 있는지 확인하고, [📁 파일 직접 고르기]로 골라 주세요.`) : null);
  }

  function limitNotice(snap) {
    const t = new Date(snap.limitUntil);
    return h('div', { class: 'notice warn pv-notice' }, `⏸ 오늘 쓸 수 있는 만큼 다 썼어요. ${t.getHours()}시 ${String(t.getMinutes()).padStart(2, '0')}분쯤 저절로 이어서 해요. (그냥 두셔도 돼요)`);
  }

  function errorCard(snap) {
    const msg = snap.error || '';
    const fe = AM.kit.friendlyError(msg);
    const limited = snap.status === 'limited';
    const lead = limited ? '오늘 쓸 수 있는 만큼 다 썼어요. 조금 쉬었다가 이어서 해요.'
      : fe.kind === 'other' ? '잠깐 문제가 생겨서 멈췄어요.' : fe.text;
    const acts = [h('button', { class: 'btn primary xl', onclick: () => resumeNow() }, '▶ 이어서 하기')];
    if (!limited && (fe.kind === 'login' || fe.kind === 'install')) acts.push(h('button', { class: 'btn xl', onclick: () => AM.go('settings') }, '🔌 설정에서 연결하기'));
    if (/그림 .*장을 그리지 못했/.test(msg)) acts.push(h('button', { class: 'btn xl', onclick: () => openDetails('drawings') }, '🎨 그림 보러 가기'));
    return card('pv-err',
      h('h3', null, limited ? '⏸ 오늘은 여기까지 했어요' : '😢 문제가 생겼어요'),
      h('p', null, lead),
      h('div', { class: 'pv-help-acts' }, acts),
      h('p', { class: 'pv-note' }, '이미 만든 것은 저장되어 있어요. 이어서 하면 남은 부분만 만들어요.'),
      msg ? AM.kit.fold('자세한 내용 보기', h('div', { class: 'logbox pv-rawerr' }, msg)) : null);
  }

  function stoppedCard() {
    return card('pv-stopped',
      h('h3', null, '⏹ 멈춰 있어요'),
      h('p', null, "[▶ 이어서 하기]를 누르면 멈춘 곳부터 계속해요. 이미 만든 것은 그대로 있어요."),
      h('div', { class: 'pv-help-acts' }, h('button', { class: 'btn primary xl', onclick: () => resumeNow() }, '▶ 이어서 하기')));
  }

  function idleCard() {
    return card('',
      h('h3', null, '🎬 아직 만들지 않았어요'),
      h('p', null, '아래 버튼을 누르면 영상을 만들기 시작해요.'),
      h('div', { class: 'pv-help-acts' }, h('button', { class: 'btn primary xl', onclick: () => resumeNow() }, '▶ 만들기 시작')));
  }

  // ---------- 아래 고정 바: ✨ 고친 것 반영하기 ----------
  function barModel(snap) {
    if (!cur || cur.mode === 'subs') return null; // 자막 스튜디오에는 자기 저장 단추가 있다
    if (kindOf(snap) !== 'done') return null;
    if (cur.starting || snap.running) return { working: true };
    const c = snap.changes;
    return c && c.count > 0 ? { working: false, c } : null;
  }

  function ensureBar() {
    if (cur.bar) return cur.bar;
    const title = h('div', { class: 'pv-bar-title' });
    const sub = h('div', { class: 'pv-bar-sub' });
    const prog = AM.kit.progressBar(0);
    const pct = h('span', { class: 'pv-bar-pct' });
    const progWrap = h('div', { class: 'pv-bar-prog' }, prog, pct);
    const btn = h('button', { class: 'btn primary xl pv-bar-btn', onclick: () => applyNow() });
    const el = AM.kit.stickyBar([h('div', { class: 'pv-bar-info' }, title, sub), progWrap, btn], { class: 'pv-bar' });
    cur.bar = { el, title, sub, prog, pct, progWrap, btn, last: {} };
    return cur.bar;
  }

  function etaButtonWords(sec) {
    if (sec == null) return '';
    return sec < 50 ? '1분 안에' : minutesWords(sec / 60);
  }

  function renderBar(snap) {
    const m = barModel(snap);
    if (!m) { if (cur.bar && cur.bar.el.isConnected) cur.bar.el.remove(); return; }
    const b = ensureBar();
    if (!b.el.isConnected) cur.root.appendChild(b.el);
    const L = b.last;
    const set = (key, val, fn) => { if (L[key] !== val) { L[key] = val; fn(val); } };
    if (m.working) {
      const st = snap.running ? snap.currentStep : null;
      const text = st === 'render' ? '🎬 바뀐 장면을 영상으로 만들고 있어요' : st === 'subtitles' ? '💬 가사 자막을 영상에 입히고 있어요' : snap.running ? currentMeta(snap).doing : '✨ 반영을 시작하고 있어요';
      const p = snap.running ? applyPct(snap) : null;
      set('title', text, (t) => { b.title.textContent = t; });
      set('sub', '내 컴퓨터가 하는 중이에요 · 끝나면 영상이 저절로 바뀌어요', (t) => { b.sub.textContent = t; });
      set('pct', `${p}`, () => { b.prog.set(p); b.pct.textContent = p == null ? '' : `${p}%`; });
      set('mode', 'working', () => { b.progWrap.classList.remove('hidden'); b.btn.classList.add('hidden'); b.el.classList.add('is-working'); });
      return;
    }
    const c = m.c;
    const parts = [];
    if (c.shots && c.shots.length) parts.push(`바뀐 장면 ${c.shots.length}곳`);
    if (c.subs) parts.push('가사/자막 바뀜');
    if (!parts.length) parts.push('바뀐 곳이 있어요');
    const redraw = snap.redrawing && snap.redrawing.length;
    const can = !!snap.canApply && !cur.editorBusy;
    const reason = redraw ? '그림을 다시 그리는 중이에요. 끝나면 누를 수 있어요.' : (!snap.canApply ? '잠깐 뒤에 다시 눌러 주세요.' : '');
    set('title', `✏️ ${parts.join(' · ')}`, (t) => { b.title.textContent = t; });
    set('sub', reason || '영상을 다시 만들어요 · 내 컴퓨터가 해요 · 무료', (t) => { b.sub.textContent = t; });
    const eta = etaButtonWords(c.etaSec);
    set('btn', `${eta}|${can}`, () => { b.btn.textContent = `✨ 고친 것 반영하기${eta ? ` (${eta})` : ''}`; b.btn.disabled = !can; });
    set('mode', 'ready', () => { b.progWrap.classList.add('hidden'); b.btn.classList.remove('hidden'); b.el.classList.remove('is-working'); });
  }

  /**
   * 영상을 새로 만드는 일(반영하기 · 단계 다시 하기 · 이어서 하기)을 시작한다.
   * 완성 영상의 <video> 는 영상 파일이 지워지기 전에 먼저 놓아 준다 (백엔드가 render/subtitles 에 닿기 전에).
   */
  async function startRun(fn, o = {}) {
    const c = cur;
    if (!c) return undefined;
    if (hasMovie(c.snap)) {
      c.starting = Date.now();
      c.applyToast = true; // 끝나면 '반영했어요' 알림
      c.sawRunning = !!c.snap.running;
      if (c.ctl && typeof c.ctl.release === 'function') { try { c.ctl.release(); } catch (_) { /* noop */ } }
      syncNow();
    }
    try {
      const r = await fn();
      if (c.starting && o.isApply && (!r || r.from == null)) { c.starting = 0; c.applyToast = false; if (cur === c) syncNow(); }
      return r === undefined ? true : r;
    } catch (e) {
      c.starting = 0;
      c.applyToast = false;
      if (cur === c) syncNow();
      toast(e.message || String(e), 'err');
      return undefined;
    }
  }

  function syncNow() {
    if (!cur) return;
    const snap = cur.snap;
    if (cur.mode === 'watch') patchWatch(snap);
    else if (cur.mode === 'details' && cur.tab === 'final') renderBody(snap, true);
    renderBar(snap);
  }

  async function applyNow() {
    const c = cur;
    if (!c || c.starting) return;
    const r = await startRun(() => window.api.applyChanges(c.id), { isApply: true });
    if (r && r.from) c.applyFrom = r.from; else if (r && r.from == null) toast('지금은 반영할 것이 없어요.');
  }

  // ---------- 고급 보기: 단계 칸 ----------
  function renderStepper(snap) {
    const el = clear(cur.els.stepper);
    AM.STEP_META.forEach((m, i) => {
      const s = (snap.steps && snap.steps[m.id]) || {};
      const status = s.status || 'pending';
      const prog = status === 'done' ? 100 : (s.progress && s.progress.total ? Math.round((s.progress.done / s.progress.total) * 100) : 0);
      const who = m.who(snap.providers);
      el.appendChild(h('div', { class: `stp ${status}`, title: s.message || '' },
        h('div', { class: 'top' }, h('span', { class: 'dot' }), `${i + 1}. ${m.icon} ${m.label}`),
        h('div', { class: 'msg' }, status === 'pending' ? `대기 · ${who.short}` : (s.message || '')),
        h('div', { class: 'bar', style: { width: `${status === 'running' || status === 'waiting' ? Math.max(prog, 4) : prog}%` } })));
    });
  }

  function patchDetails(snap, prev) {
    if (!cur.userTab && (snap.currentStep !== prev.currentStep || snap.status === 'done')) cur.tab = tabForStep(snap.currentStep, snap.status);
    renderStepper(snap);
    renderTabs(snap);
    renderBody(snap, false);
  }

  // ---------- 탭 ----------
  function renderTabs(snap) {
    const el = clear(cur.els.tabs);
    TABS.forEach((t) => el.appendChild(h('button', {
      class: `tab ${cur.tab === t.id ? 'active' : ''}`,
      onclick: () => { cur.tab = t.id; cur.userTab = true; cur.sigs = {}; renderTabs(cur.snap); renderBody(cur.snap, true); },
    }, t.label, t.id === 'final' && snap.changes && snap.changes.count > 0 && snap.output ? ' •' : '')));
  }

  function renderBody(snap, force) {
    const fns = { plan: planTab, timing: timingTab, xsheet: xsheetTab, drawings: drawingsTab, final: finalTab, log: logTab };
    const sigFns = {
      plan: () => JSON.stringify([snap.plan, snap.running]),
      timing: () => JSON.stringify([snap.music && snap.music.analysis && snap.music.analysis.bpm, snap.song, snap.lyricsInput && snap.lyricsInput.raw, snap.timing, snap.running, snap.waiting && snap.waiting.key, snap.steps.music && snap.steps.music.status, snap.xsheet && snap.xsheet.transitions]),
      xsheet: () => JSON.stringify([snap.xsheet, snap.drawings, snap.running, snap.renderStale, snap.inbetweens, snap.render]),
      drawings: () => JSON.stringify([snap.drawings, snap.running]),
      final: () => JSON.stringify([snap.output, isLocked(snap), snap.running, snap.changes && snap.changes.count, snap.redrawing && snap.redrawing.length]),
      log: () => 'log',
    };
    const sig = sigFns[cur.tab]();
    if (!force && cur.sigs[cur.tab] === sig) return;
    // 입력 중이면 다시 그리지 않는다
    const active = document.activeElement;
    if (!force && active && cur.els.body.contains(active) && /INPUT|TEXTAREA|SELECT/.test(active.tagName)) return;
    cur.sigs = { [cur.tab]: sig };
    releaseVideosIn(cur.els.body); // 지우기 전에 영상 파일을 놓아 준다
    const body = clear(cur.els.body);
    Promise.resolve(fns[cur.tab](snap)).then((node) => { if (node && cur && cur.els.body === body) { clear(body); body.appendChild(node); } });
  }

  // ---------- 기획 탭 ----------
  function planTab(snap) {
    const plan = snap.plan;
    if (!plan) return h('div', { class: 'section muted' }, snap.running ? '🧠 가사와 지난 이야기를 보고 이번 이야기를 쓰는 중이에요… (보통 1~3분)' : '아직 이야기가 없어요. 노래 분석이 끝나면 만들어요.');
    return h('div', null,
      h('div', { class: 'section' },
        h('h3', null, plan.title),
        h('p', { class: 'desc' }, plan.logline),
        h('p', null, plan.concept),
        plan.episode_summary_ko ? h('div', { class: 'notice info small' }, h('b', null, '📚 이번 이야기 요약 (시리즈 기록에 남아요): '), plan.episode_summary_ko) : null,
        plan.music && (plan.music.genre || plan.music.mood) ? h('div', { class: 'small muted' }, `🎵 ${plan.music.genre || ''} ${plan.music.mood ? `· ${plan.music.mood}` : ''}`) : null,
        h('div', { class: 'grid2', style: { marginTop: '10px' } },
          h('div', null, h('b', null, '🎭 등장인물'), plan.characters.length
            ? h('ul', null, plan.characters.map((c) => h('li', null, h('b', null, c.name),
              c.fixed ? h('span', { class: 'chip ok', style: { marginLeft: '6px' } }, '🔒 고정') : c.role === 'guest' ? h('span', { class: 'chip', style: { marginLeft: '6px' } }, '이번 화 손님') : null,
              c.description_ko ? ` - ${c.description_ko}` : '', h('div', { class: 'small muted' }, c.appearance_en))))
            : h('p', { class: 'muted small' }, '(인물 없이 풍경 위주)')),
          h('div', null, h('b', null, '📖 시나리오 (노래 순서대로)'), h('ol', null, plan.story.map((st) => h('li', null,
            st.sections && st.sections.length ? h('span', { class: 'chip', style: { marginRight: '6px' } }, st.sections.join(', ')) : null,
            st.summary_ko)))))),
      h('div', { class: 'small muted' }, '이야기를 바꾸고 싶으면 맨 위 [⋯] 메뉴의 [↻ 단계 다시 하기] 에서 "이야기부터" 를 고르세요. 만들기 화면의 "이야기" 칸에 원하는 방향을 적으면 반영돼요.'));
  }

  // ---------- 노래·가사·장면 탭 ----------
  function timingTab(snap) {
    const m = snap.music;
    const a = m && m.analysis;
    const t = snap.timing;
    const inLyricReview = !!(snap.waiting && snap.waiting.key === 'review:lyrics');
    const kids = [];

    // 노래
    const songAbs = snap.song ? abs(snap, snap.song.file) : null;
    const audio = h('audio', { controls: true, src: songAbs ? AM.fileUrl(songAbs) : '', preload: 'auto', style: { width: '100%' } });
    const bpmIn = h('input', { type: 'number', value: a ? Math.round(a.bpm) : 120, min: 40, max: 220, style: { width: '90px' }, disabled: snap.running || !a });
    const bpmFold = a ? AM.kit.fold('박자가 이상해요?', h('div', { class: 'col' },
      h('p', { class: 'small muted', style: { margin: 0 } }, `컴퓨터는 이 노래를 1분에 ${Math.round(a.bpm)}박(BPM)으로 읽었어요. 박자가 두 배나 절반으로 잘못 잡혔다면 숫자를 고쳐서 다시 분석하세요.`),
      h('div', { class: 'row' }, bpmIn, h('button', {
        class: 'btn small', disabled: snap.running,
        onclick: async () => {
          const r = await AM.safe(() => window.api.setBpm(snap.id, Number(bpmIn.value)), '다시 분석했어요');
          if (r && snap.timing && await AM.confirmBox('장면을 다시 나눌까요?', '박자가 바뀌었으니 장면 나누기부터 다시 하는 게 좋아요. 이미 그린 그림은 장면이 같으면 그대로 써요.', '장면 나누기부터 다시')) {
            startRun(() => window.api.runProject(snap.id, 'timing'));
          }
        },
      }, '이 박자로 다시 분석')))) : null;
    if (bpmFold) bpmFold.style.marginTop = '12px';
    kids.push(h('div', { class: 'section' },
      h('div', { class: 'row' },
        h('div', { class: 'grow' },
          h('h3', null, snap.song ? `🎵 ${snap.song.name}` : '🎵 노래 파일이 아직 없어요'),
          h('p', { class: 'desc' }, a
            ? `길이 ${AM.fmtSec(a.duration)} · 마디 ${a.downbeats.length}개 (내 컴퓨터가 알아서 분석했어요)`
            : (snap.song ? '분석을 기다리는 중이에요.' : 'Suno 등에서 만든 노래 파일을 넣어 주세요.'))),
        h('button', {
          class: 'btn small', disabled: snap.running,
          onclick: async () => {
            const f = await window.api.pickFile({ filters: [{ name: '노래', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'mp4', 'webm', 'mov', 'm4v'] }] });
            if (!f) return;
            if (snap.song && !await AM.confirmBox('노래를 바꿀까요?', '노래가 바뀌면 박자 분석과 장면 나누기, 그림 순서표를 다시 해요. 이야기는 그대로 둬요.', '바꾸기')) return;
            if (await AM.safe(() => window.api.replaceSong(snap.id, f), '노래를 바꿨어요. 아래 [✨ 고친 것 반영하기] 를 눌러 주세요.')) AM.go('project', snap.id);
          },
        }, snap.song ? '🎵 노래 바꾸기' : '🎵 노래 넣기')),
      songAbs ? audio : null,
      bpmFold));

    // 가사
    const li = snap.lyricsInput || { raw: '', lines: [] };
    const editable = !snap.running || inLyricReview;
    const ta = h('textarea', { rows: 8, disabled: !editable, placeholder: '가사가 없으면 연주곡으로 만들어요.' });
    ta.value = li.raw || '';
    let fname = '';
    const cutsFixed = !!(snap.steps.timing && snap.steps.timing.status === 'done' && t && t.segments);
    // 글을 저장한다. 맞춰 둔 시간이 사라질 때만 한 번 묻는다 (dryRun 으로 미리 알아본다)
    const saveLyrics = async () => {
      const raw = ta.value;
      const dry = await AM.safe(() => window.api.updateLyricsText(snap.id, raw, fname, { dryRun: true }));
      if (dry === undefined) return;
      if (dry && dry.lost > 0 && !await AM.confirmBox('맞춰 둔 시간이 사라져요', `맞춰 둔 시간 ${dry.lost}줄이 사라져요. 계속할까요?`, '계속')) return;
      const r = await AM.safe(() => window.api.updateLyricsText(snap.id, raw, fname));
      if (r === undefined) return;
      if (inLyricReview) toast('✅ 가사를 저장했어요. 위 카드에서 [🎤 지금 맞추기] 나 [나중에 하기 ▶] 를 눌러 주세요.', 'ok');
      else if (cutsFixed && snap.output && snap.output.clean) toast('✅ 가사를 저장했어요. 아래 [✨ 고친 것 반영하기] 로 영상에 넣어요.', 'ok');
      else toast('✅ 가사를 저장했어요.', 'ok');
    };
    kids.push(h('div', { class: 'section' },
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('h3', null, `📝 가사 ${li.lines.length}줄 ${li.timed ? '(시간 포함 ✔)' : ''}`),
          h('p', { class: 'desc' }, cutsFixed
            ? '장면이 이미 정해졌어요. 가사를 고치면 자막만 다시 입혀요 (그림은 그대로라 빨라요).'
            : 'Suno 가사를 그대로 붙여넣어도 돼요. [Verse] [Chorus] 같은 구간 표시는 자막에 나오지 않고, 장면을 나누고 하이라이트를 찾을 때 써요.')),
        h('button', {
          class: 'btn small', disabled: !editable,
          onclick: async () => {
            const f = await window.api.pickFile({ filters: [{ name: '가사', extensions: ['txt', 'lrc', 'srt'] }] });
            if (!f) return;
            const text = await AM.safe(() => window.api.readTextFile(f));
            if (text != null) { ta.value = text; fname = f.split(/[\\/]/).pop(); }
          },
        }, '📄 가사 파일 불러오기'),
        h('button', { class: 'btn small primary', disabled: !editable, onclick: saveLyrics }, '💾 가사 저장')),
      ta));

    if (t && (t.segments || (t.lyrics && t.lyrics.length))) {
      const canTap = (!snap.running || inLyricReview) && t.lyrics && t.lyrics.length;
      const srcLabel = { tap: '(직접 맞춤 ✔)', lrc: '(가사 파일 시간 ✔)', srt: '(자막 파일 시간 ✔)', auto: '(자동 추정 - 직접 맞추면 정확해져요)' }[t.lyricsSource] || '';
      kids.push(h('div', { class: 'section' },
        h('div', { class: 'row' },
          h('div', { class: 'grow' }, h('h3', null, `${t.segments ? `✂ 장면 ${t.segments.length}개 · ` : ''}가사 자막 ${t.lyrics.length}줄 ${srcLabel}`),
            h('p', { class: 'desc' }, '보라색 세로줄 = 마디 시작, 회색 = 박자. 장면 경계는 모두 박자 위에 있어요. ⭐ = 하이라이트 장면(그림을 많이 써서 활기차게). 장면을 누르면 그 위치부터 재생돼요.')),
          h('button', { class: 'btn primary', disabled: !canTap, onclick: () => lyricSyncModal() }, '🎤 탭으로 가사 맞추기')),
        a ? timeline(snap, audio) : null,
        t.segments ? segTable(snap) : null));
    }
    return h('div', null, kids);
  }

  function timeline(snap, audio) {
    const a = snap.music.analysis;
    const t = snap.timing;
    const D = a.duration;
    const pct = (x) => `${(x / D) * 100}%`;
    const colors = ['#7c3aed', '#ff5e62', '#0ea5e9', '#16a34a', '#f59e0b', '#db2777', '#4f46e5', '#0d9488'];
    const hl = t.highlights || [];
    const trsList = (snap.xsheet && snap.xsheet.transitions) || [];
    const beats = h('div', { class: 'tl-row small' }, a.beats.map((b) => h('div', { class: `tl-beat ${a.downbeats.some((d) => Math.abs(d - b) < 0.02) ? 'down' : ''}`, style: { left: pct(b) } })));
    const segs = h('div', { class: 'tl-row' }, (t.segments || []).map((s, i) => h('div', {
      class: 'tl-seg', title: `장면 ${s.index}: ${s.start.toFixed(2)}~${s.end.toFixed(2)}초 (${s.beats}박)${hl[i] ? ' ⭐ 하이라이트' : ''}`,
      style: { left: pct(s.start), width: pct(s.duration), background: colors[i % colors.length] },
      onclick: () => { audio.currentTime = s.start; audio.play(); },
    }, `${hl[i] ? '⭐' : ''}${s.index}`)));
    const trs = h('div', { class: 'tl-row small' }, (t.segments ? trsList : []).map((tr, i) => (tr.type === 'cut' || !t.segments[i] ? null : h('div', { class: 'tl-tr', style: { left: pct(t.segments[i].end) }, title: tr.type }, trIcon(tr.type)))));
    const lyr = h('div', { class: 'tl-row' }, t.lyrics.map((l) => h('div', { class: 'tl-lyr', style: { left: pct(l.start), width: pct(Math.max(0.3, l.end - l.start)) }, title: `${l.start.toFixed(2)}s ${l.text}` }, l.text)));
    const head = h('div', { class: 'tl-head', style: { left: '0%' } });
    const wrap = h('div', { class: 'timeline' }, h('div', { class: 'tl-label' }, '박자'), beats, h('div', { class: 'tl-label' }, '장면 / 넘기기'), trs, segs, h('div', { class: 'tl-label' }, '가사 자막'), lyr, head);
    audio.addEventListener('timeupdate', () => { head.style.left = `calc(10px + (100% - 20px) * ${audio.currentTime / D})`; });
    return wrap;
  }

  function trIcon(type) {
    return ({ fade: '◐ 페이드', dissolve: '◌ 디졸브', fadeblack: '■ 암전', flash: '✦ 플래시', slideleft: '⇐ 슬라이드', slideup: '⇑ 슬라이드', wipeleft: '▤ 와이프', zoomin: '⊕ 줌', circleopen: '◯ 원형', pixelize: '▦ 픽셀', smoothleft: '⇐ 스무스' })[type] || type;
  }

  function segTable(snap) {
    const t = snap.timing;
    const xs = snap.xsheet;
    return h('table', { class: 'prov-table small', style: { marginTop: '12px' } },
      h('tbody', null, t.segments.map((s, i) => {
        const shot = xs && xs.shots[i];
        const tr = xs && xs.transitions[i];
        return h('tr', null,
          h('td', { style: { width: '120px' } }, `${(t.highlights || [])[i] ? '⭐ ' : ''}장면 ${s.index}`, h('div', { class: 'muted' }, `${s.start.toFixed(2)}~${s.end.toFixed(2)}초`)),
          h('td', { style: { width: '110px' } }, `${s.duration.toFixed(2)}초`, h('div', { class: 'muted' }, `${(t.frames || [])[i] || '-'}프레임 · ${s.beats}박 · ${({ high: '강', mid: '중', low: '약' })[s.energy]}`)),
          h('td', null, shot ? `그림 ${shot.drawings.length}장 · ${AM.CAMERA_LABEL[shot.camera.move] || shot.camera.move}` : '', h('div', { class: 'muted' }, s.lyrics.map((k) => t.lyrics[k] && t.lyrics[k].text).filter(Boolean).join(' / ') || '(간주)')),
          h('td', { style: { width: '110px' } }, tr ? (tr.type === 'cut' ? '컷' : `${trIcon(tr.type)} ${tr.frames}프레임`) : (i < t.segments.length - 1 ? '' : '끝')));
      })));
  }

  // ---------- 그림 순서표 탭 ----------
  function xsheetTab(snap) {
    const xs = snap.xsheet;
    if (!xs) return h('div', { class: 'section muted' }, snap.running && snap.currentStep === 'xsheet' ? '📋 AI 가 장면마다 그림 장수·보여 주는 시간·카메라를 짜는 중이에요… (보통 1~3분)' : '장면 나누기가 끝나면 그림 순서표를 짜요.');
    const hl = xs.shots.filter((s) => s.highlight);
    const ar = aspectCss(snap.workflow.aspect);
    return h('div', null,
      snap.changes && snap.changes.count > 0 && !snap.running ? h('div', { class: 'notice warn' }, '✏️ 바뀐 그림·시간·카메라가 있어요. 아래 [✨ 고친 것 반영하기] 를 누르면 바뀐 장면만 새로 만들어요. (내 컴퓨터가 해요 · 무료)') : null,
      h('div', { class: 'section' },
        h('div', { class: 'row' },
          h('div', { class: 'grow' },
            h('h3', null, `📋 그림 순서표 · 장면 ${xs.shots.length}개 · 그림 ${xs.totalDrawings}장 (예산 ${xs.budget}장)`),
            h('p', { class: 'desc' }, xs.mode && xs.mode !== 'limited'
              ? `1초 = 24프레임. ${MODE_KO[xs.mode]}: 🏃 움직이는 장면은 AI 가 1초에 ${xs.keyRate}장(${24 / xs.keyRate}프레임씩) 그리고, 그 사이 그림은 내 PC 가 만들어 부드럽게 이어요. 나머지 컷은 그림 몇 장을 길게 보여 주며 카메라가 움직여요.${xs.layers ? ' 배경 판과 인물 셀을 따로 그려서 겹쳐요.' : ''} 총 ${xs.totalFrames}프레임 = ${AM.fmtSec(xs.totalFrames / 24)}`
              : `1초 = 24프레임. 보통 장면은 그림 몇 장을 길게 보여 주며 카메라가 움직이고, ⭐ 하이라이트 장면(${hl.length}개)은 그림을 많이 써서 2프레임마다 넘겨요. 총 ${xs.totalFrames}프레임 = ${AM.fmtSec(xs.totalFrames / 24)}`),
            xs.estimate ? estimatePanel(xs, snap.render && snap.render.inbetween) : null),
          h('button', { class: 'btn small', onclick: () => window.api.openPath(AM.joinPath(snap.dir, 'output')) }, '📂 timesheet.json')),
        xs.notes && xs.notes.length ? h('details', { class: 'adv' }, h('summary', null, `🔧 PC 가 고친 것 ${xs.notes.length}개 (프레임 합계 맞추기 등)`),
          h('ul', { class: 'small muted' }, xs.notes.map((n) => h('li', null, n)))) : null),
      xs.shots.map((s, i) => shotCard(snap, s, xs.transitions[i], ar)));
  }

  function shotCard(snap, s, tr, ar) {
    const total = s.frames;
    const used = new Map();
    for (const e of s.exposure) used.set(e.drawing, (used.get(e.drawing) || 0) + e.frames);
    // 바꾼 뒤에는 칸에서 손을 떼야(blur) 화면이 새 내용으로 다시 그려진다
    const camSel = h('select', { class: 'cam-sel', disabled: snap.running, onchange: (e) => { e.target.blur(); AM.safe(() => window.api.setCamera(snap.id, s.shot, e.target.value), '카메라를 바꿨어요. 아래 [✨ 고친 것 반영하기] 로 영상에 넣어요.'); } },
      (AM.state.info.cameraMoves || Object.keys(AM.CAMERA_LABEL)).map((m) => h('option', { value: m }, AM.CAMERA_LABEL[m] || m)));
    camSel.value = s.camera.move;
    const xs = snap.xsheet;
    const bgIt = xs.layers ? drawingOf(snap, s.shot, 'bg') : null;
    const bgThumb = bgIt ? h('div', { class: 'xs-draw bg', title: (s.bg && s.bg.prompt_en) || '' },
      h('div', { class: 'thumb', style: { aspectRatio: ar } },
        bgIt.file && bgIt.status !== 'running' ? h('img', { src: url(snap, bgIt.file, bgIt.updatedAt), loading: 'lazy', onclick: () => bigImage(snap, bgIt.file, bgIt.updatedAt) })
          : h('div', { class: 'ph' }, bgIt.status === 'running' ? '그리는 중…' : bgIt.status === 'error' ? '⚠ 실패' : '대기'),
        h('span', { class: 'badge', style: { background: '#475569' } }, '🏞 배경')),
      h('div', { class: 'acts' },
        h('button', { class: 'btn small', disabled: snap.running, onclick: () => editPromptDialog(snap, bgIt) }, '✏️'),
        h('button', { class: 'btn small', disabled: snap.running, onclick: () => replaceDrawing(snap, bgIt) }, '📁'))) : null;
    const thumbs = h('div', { class: `xs-drawings ${s.drawings.length > 8 ? 'many' : ''}` }, bgThumb, s.drawings.map((d) => {
      const it = drawingOf(snap, s.shot, d.id);
      const v = it && it.updatedAt;
      const show = it && celView(it);
      return h('div', { class: 'xs-draw', title: d.prompt_en },
        h('div', { class: `thumb ${show && show.checker ? 'checker' : ''}`, style: { aspectRatio: ar, borderColor: dcolor(d.id) } },
          show && it.status !== 'running' ? h('img', { src: url(snap, show.rel, v), loading: 'lazy', onclick: () => bigImage(snap, show.rel, v, show.checker) })
            : h('div', { class: 'ph' }, it && it.status === 'running' ? '그리는 중…' : it && it.status === 'error' ? '⚠ 실패' : '대기'),
          h('span', { class: 'badge', style: { background: dcolor(d.id) } }, d.id),
          h('span', { class: 'badge r' }, `${used.get(d.id) || 0}f`)),
        h('div', { class: 'acts' },
          h('button', { class: 'btn small', disabled: snap.running || !it, onclick: () => editPromptDialog(snap, it) }, '✏️'),
          h('button', { class: 'btn small', disabled: snap.running || !it, onclick: () => replaceDrawing(snap, it) }, '📁')));
    }));
    const rs = ((snap.render && snap.render.shots) || []).find((r) => r.shot === s.shot);
    const ibs = Object.values(snap.inbetweens || {}).filter((r) => r.shot === s.shot);
    const ibDone = ibs.filter((r) => r.status === 'done');
    const ibEngines = [...new Set(ibDone.map((r) => (r.engine === 'rife' ? 'RIFE' : 'ffmpeg')))].join('+');
    const ibInfo = s.motion ? h('span', { class: 'small muted' }, ibs.length
      ? `사이 그림 ${ibDone.length}장${ibEngines ? ` (${ibEngines})` : ''}${ibs.length > ibDone.length ? ` · 그대로 넘김 ${ibs.length - ibDone.length}곳` : ''}`
      : rs ? '사이 그림 없음' : '사이 그림은 영상을 만들 때 만들어요') : null;
    // 노출 띠 (X-sheet 를 가로로 펼친 모양)
    const strip = h('div', { class: 'xs-strip' }, s.exposure.map((e) => h('div', {
      class: 'xs-cell', title: `${e.drawing} · ${e.frames}프레임`,
      style: { flexGrow: e.frames, background: dcolor(e.drawing) },
    }, e.frames >= 6 ? `${e.drawing}${e.frames >= 10 ? ` ${e.frames}` : ''}` : '')));
    let acc = 0;
    const table = h('table', { class: 'xs-table small' },
      h('thead', null, h('tr', null, h('th', null, '순서'), h('th', null, '그림'), h('th', null, '프레임 (보여 주는 길이)'), h('th', null, '시작 프레임'), h('th', null, '초'))),
      h('tbody', null, s.exposure.map((e, k) => {
        const start = acc;
        acc += e.frames;
        const inp = h('input', {
          type: 'number', value: e.frames, min: 1, max: total, disabled: snap.running || s.exposure.length < 2, style: { width: '80px' },
          onchange: (ev) => { ev.target.blur(); AM.safe(() => window.api.retime(snap.id, s.shot, k, Number(ev.target.value)), '시간을 바꿨어요. 장면 길이는 그대로라 다음 칸이 맞춰 줄어들거나 늘어나요. 아래 [✨ 고친 것 반영하기] 로 영상에 넣어요.'); },
        });
        return h('tr', null, h('td', null, String(k + 1)), h('td', null, h('span', { class: 'dchip', style: { background: dcolor(e.drawing) } }, e.drawing)), h('td', null, inp), h('td', null, String(start)), h('td', null, (e.frames / 24).toFixed(2)));
      })));
    return h('div', { class: `section shot-card ${s.highlight ? 'hl' : ''}` },
      h('div', { class: 'row' },
        h('div', { class: 'grow' },
          h('div', { class: 'row', style: { gap: '8px' } },
            h('b', null, `장면 ${s.shot}`),
            s.motion ? h('span', { class: 'chip motion' }, `🏃 움직임: 1초 ${xs.keyRate || 6}장 + 사이 그림`)
              : s.highlight && (!xs.mode || xs.mode === 'limited') ? h('span', { class: 'chip warn' }, '⭐ 하이라이트 · 2프레임씩')
                : h('span', { class: 'chip' }, '멈춤 · 길게 보여 주기 + 카메라'),
            s.highlight && s.motion ? h('span', { class: 'chip warn' }, '⭐') : null,
            ibInfo,
            h('span', { class: 'small muted' }, `${AM.fmtSec(s.start)}~${AM.fmtSec(s.end)} · ${total}프레임 · ${xs.layers ? `배경 1 + 인물 ${s.drawings.length}장` : `그림 ${s.drawings.length}장`}`),
            s.fx.map((f) => h('span', { class: 'chip pri' }, AM.FX_LABEL[f] || f)),
            tr ? h('span', { class: 'small muted' }, `→ 다음 장면: ${tr.type === 'cut' ? '컷' : trIcon(tr.type)}`) : null),
          h('div', { class: 'small muted', style: { marginTop: '3px' } }, `🏞 ${s.scene_en}${s.framing_en ? ` · ${s.framing_en}` : ''}`)),
        h('div', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'small muted' }, '카메라'), camSel,
          h('button', { class: 'btn small', onclick: () => flipbook(snap, s) }, '▶ 넘겨보기'))),
      thumbs,
      strip,
      h('details', { class: 'adv', style: { marginTop: '8px' } }, h('summary', null, '📋 노출표 자세히 (프레임 바꾸기)'), table));
  }

  /** 그림만 넘겨 보는 미리보기 (24fps, 카메라 없이). 배경 판 위에 인물 셀, 사이 그림도 함께 */
  function flipbook(snap, s) {
    const srcs = new Map(s.drawings.map((d) => { const it = drawingOf(snap, s.shot, d.id); const v = it && celView(it); return [d.id, v ? url(snap, v.rel, it.updatedAt) : '']; }));
    const ib = new Map(Object.values(snap.inbetweens || {}).filter((r) => r.shot === s.shot && r.status === 'done').map((r) => [r.pair, url(snap, r.file)]));
    const seq = expandExposure(s, (a, b) => ib.has(pairKey(a, b)));
    const bgIt = snap.xsheet.layers ? drawingOf(snap, s.shot, 'bg') : null;
    const ar = aspectCss(snap.workflow.aspect);
    const img = h('img', { class: 'flip-cel' });
    const stage = h('div', { class: 'flip-stage', style: { aspectRatio: ar } },
      bgIt && bgIt.file ? h('img', { class: 'flip-bg', src: url(snap, bgIt.file, bgIt.updatedAt) }) : null, img);
    const label = h('div', { class: 'small muted mono' });
    let f = 0;
    let timer = null;
    const tick = () => {
      let n = 1;
      while (f + n < seq.length && seq[f + n] === seq[f]) n++;
      const id = seq[f];
      img.src = id.includes('~') ? ib.get(id) : srcs.get(id) || '';
      label.textContent = `${id.includes('~') ? `사이 그림 ${id.replace('~', '→')}` : `그림 ${id}`} · ${f + 1}/${s.frames} 프레임`;
      f = (f + n) % seq.length;
      timer = setTimeout(tick, (n * 1000) / 24);
    };
    tick();
    AM.modal(`▶ 장면 ${s.shot} 넘겨보기`, h('div', { class: 'col', style: { alignItems: 'center' } }, stage, label,
      h('div', { class: 'small muted' }, '그림만 순서대로 넘겨요. 카메라 움직임과 필름 느낌은 완성된 영상에서 볼 수 있어요.')),
    [{ label: '닫기' }], { width: 'min(900px, 94vw)', onClose: () => clearTimeout(timer) });
  }

  // 사이 그림 순서 (main 의 xsheet.expandExposure 와 같은 규칙: A 를 앞 절반, A~B 를 뒤 절반)
  function pairKey(a, b) { return a < b ? `${a}~${b}` : `${b}~${a}`; }
  function expandExposure(s, has) {
    const out = [];
    s.exposure.forEach((e, i) => {
      const nx = s.exposure[i + 1];
      if (s.motion && nx && nx.drawing !== e.drawing && e.frames >= 2 && has(e.drawing, nx.drawing)) {
        const a = Math.ceil(e.frames / 2);
        for (let k = 0; k < e.frames; k++) out.push(k < a ? e.drawing : pairKey(e.drawing, nx.drawing));
      } else for (let k = 0; k < e.frames; k++) out.push(e.drawing);
    });
    return out;
  }

  /** 셀은 배경을 뺀 투명 그림을 체크무늬 위에, 못 뺐거나 배경 판이면 원래 그림 */
  function celView(it) {
    if (!it || !it.file) return null;
    if (it.kind !== 'bg' && it.keyed && it.cel) return { rel: it.cel, checker: true };
    return { rel: it.file, checker: false };
  }

  /** 그릴 장수·시간 예상 */
  function estimatePanel(xs, ibRun) {
    const e = xs.estimate;
    const time = e.minutes >= 60 ? `약 ${(e.minutes / 60).toFixed(1)}시간` : `약 ${Math.max(1, e.minutes)}분`;
    return h('div', { class: 'est-panel' },
      h('div', { class: 'est-big' }, `🎨 그림 약 ${e.images}장`),
      h('div', { class: 'est-items' },
        xs.layers ? h('span', { class: 'chip' }, `🏞 배경 ${e.bg}장`) : null,
        h('span', { class: 'chip' }, `${xs.layers ? '🧍 인물' : '🖼 그림'} ${e.cels}장`),
        h('span', { class: 'chip warn' }, `⏱ 예상 ${time}`),
        e.motionShots ? h('span', { class: 'chip motion' }, `🏃 움직이는 장면 ${e.motionShots}개 (${e.motionSeconds}초)`) : null,
        e.inbetweens ? h('span', { class: 'chip ok' }, `✨ 사이 그림 약 ${e.inbetweens}장 (내 PC, 무료)`) : null,
        ibRun && ibRun.count != null ? h('span', { class: 'chip pri' }, `만든 사이 그림 ${ibRun.count}장${ibRun.used && ibRun.used.length ? ` · ${ibRun.used.join(', ')}` : ibRun.engine ? ` · ${ibRun.engine === 'rife' ? 'RIFE' : 'ffmpeg'}` : ''}`) : null),
      h('div', { class: 'small muted' }, `그림 한 장에 ${e.secPerImage}초쯤으로 셈했어요. 구독 사용량 한도에 걸리면 기다렸다가 이어서 해요.`));
  }

  // ---------- 그림 탭 ----------
  function drawingsTab(snap) {
    const ds = snap.drawings || [];
    if (!ds.length) return h('div', { class: 'section muted' }, '그림 순서표가 끝나면 그림을 한 장씩 그려요.');
    const ar = aspectCss(snap.workflow.aspect);
    const s = snap.series;
    const refCards = s ? s.characters.flatMap((c) => c.refs.map((r) => h('div', { class: 'media-card' },
      h('div', { class: 'thumb', style: { aspectRatio: '4 / 3' } }, h('img', { src: url(snap, r.file), onclick: () => bigImage(snap, r.file) }), h('span', { class: 'badge' }, `🔒 ${c.name} · ${(AM.state.info.refKinds || {})[r.kind] || r.kind}`))))) : [];
    const done = ds.filter((d) => d.status === 'done').length;
    return h('div', null,
      refCards.length ? h('div', { class: 'section' },
        h('h3', null, '🔒 기준 그림 (캐릭터 파일)'),
        h('p', { class: 'desc' }, '그림을 그릴 때마다 이 그림들과 고정 설명·색·규칙을 함께 보내서, 주인공이 늘 똑같이 나오게 해요. 같은 장면의 앞 그림도 첫 번째로 붙여서 "조금만 고쳐 줘" 라고 부탁하니 자세가 자연스럽게 이어져요. 인물은 단색 배경으로 그린 뒤 내 PC 가 배경을 빼요 (체크무늬 = 투명).'),
        h('div', { class: 'media-grid ref-grid' }, refCards)) : null,
      h('p', { class: 'muted small' }, `${done}/${ds.length}장 완료 · 마음에 안 드는 그림은 [✏️ 다시] 를 누르거나 직접 그린 파일로 [📁 교체] 할 수 있어요. 바꾼 뒤 아래 [✨ 고친 것 반영하기] 를 누르면 바뀐 장면만 다시 만들어요.`),
      h('div', { class: 'media-grid' }, ds.map((d) => drawingCard(snap, d, ar))));
  }

  function drawingCard(snap, it, ar) {
    const v = it.updatedAt || 0;
    const show = celView(it);
    let media;
    if (show && it.status !== 'running') media = h('img', { src: url(snap, show.rel, v), loading: 'lazy', onclick: () => bigImage(snap, show.rel, v, show.checker) });
    else if (it.status === 'running') media = h('div', { class: 'col', style: { alignItems: 'center' } }, h('div', { class: 'spinner' }), h('div', { class: 'ph' }, '그리는 중…'));
    else media = h('div', { class: 'ph' }, it.status === 'error' ? '⚠ 실패' : it.status === 'skipped' ? '건너뜀' : '대기 중');
    const shot = snap.xsheet && snap.xsheet.shots.find((x) => x.shot === it.shot);
    const d = shot && shot.drawings.find((x) => x.id === it.id);
    return h('div', { class: 'media-card' },
      h('div', { class: `thumb ${show && show.checker ? 'checker' : ''}`, style: { aspectRatio: ar } }, media,
        h('span', { class: 'badge', style: { background: it.kind === 'bg' ? '#475569' : dcolor(it.id) } }, it.kind === 'bg' ? `장면 ${it.shot} · 🏞 배경` : `장면 ${it.shot} · ${it.id}`),
        shot && shot.motion && it.kind !== 'bg' ? h('span', { class: 'badge r' }, '🏃') : shot && shot.highlight ? h('span', { class: 'badge r' }, '⭐') : null),
      h('div', { class: 'body' },
        it.error ? h('div', { class: 'small', style: { color: 'var(--err)' } }, it.error) : null,
        it.kind !== 'bg' && it.keyed === false && snap.xsheet && snap.xsheet.layers ? h('div', { class: 'small', style: { color: 'var(--warn)' } }, '배경을 뺄 수 없어서 전체 그림으로 써요') : null,
        h('div', { class: 'p', title: it.prompt }, it.kind === 'bg' ? ((shot && shot.bg && shot.bg.prompt_en) || it.prompt) : (d && d.prompt_en) || it.prompt),
        h('div', { class: 'acts' },
          h('button', { class: 'btn small', disabled: snap.running, onclick: () => editPromptDialog(snap, it) }, '✏️ 다시'),
          h('button', { class: 'btn small', disabled: snap.running, onclick: () => replaceDrawing(snap, it) }, '📁 교체'),
          h('button', { class: 'btn small', onclick: () => AM.safe(() => window.api.copyText(it.prompt), '그림 주문 글을 복사했어요') }, '📋'))));
  }

  async function replaceDrawing(snap, it) {
    const f = await window.api.pickFile({ filters: [{ name: '그림', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    if (f) AM.safe(() => window.api.replaceItem(snap.id, 'drawing', it.shot, f, it.id), '바꿨어요. 아래 [✨ 고친 것 반영하기] 로 영상에 넣어요.');
  }

  function editPromptDialog(snap, it) {
    const ta = h('textarea', { rows: 10 });
    ta.value = it.prompt;
    AM.modal(`그림 장면${it.shot}-${it.id} 다시 그리기`, h('div', null,
      h('p', { class: 'muted small' }, '그림 주문 글(영어 권장)을 고친 뒤 [다시 그리기] 를 누르세요. 고치지 않고 그냥 눌러도 새로 그려요. 캐릭터 기준 그림은 자동으로 함께 보내요. (캐릭터 설명 부분은 지우지 마세요)'),
      ta), [
      { label: '취소' },
      {
        label: '🔄 다시 그리기', kind: 'primary',
        onClick: () => {
          AM.safe(() => window.api.regenerate(snap.id, 'drawing', it.shot, { id: it.id, prompt: ta.value.trim() }), '다시 그렸어요. 아래 [✨ 고친 것 반영하기] 로 영상에 넣어요.');
        },
      },
    ], { width: 'min(820px, 94vw)' });
  }

  function bigImage(snap, rel, v, checker) {
    AM.modal('크게 보기', h('img', { class: checker ? 'checker' : '', src: url(snap, rel, v), style: { maxWidth: '100%', maxHeight: '72vh', display: 'block', margin: '0 auto', borderRadius: '10px' } }),
      [{ label: '📂 위치 열기', onClick: () => { window.api.showItem(abs(snap, rel)); return true; } }, { label: '닫기' }], { width: 'min(980px, 94vw)' });
  }

  // ---------- 완성 탭 ----------
  function finalTab(snap) {
    const o = snap.output || {};
    const busy = busyNow(snap);
    const rerender = h('button', { class: 'btn', disabled: busy || !snap.xsheet, onclick: () => startRun(() => window.api.runProject(snap.id, 'render')) }, '🎬 영상 다시 만들기 (바뀐 장면만)');
    const resub = h('button', { class: 'btn', disabled: busy || !o.clean, onclick: () => startRun(() => window.api.runProject(snap.id, 'subtitles')) }, '💬 자막만 다시 입히기');
    if (!o.video) {
      const s = snap.steps.render && snap.steps.render.status === 'running' ? snap.steps.render : snap.steps.subtitles;
      return h('div', { class: 'section' }, h('h3', null, '🎬 아직 완성 전이에요'),
        h('p', { class: 'desc' }, s && s.status === 'running' ? s.message : '그림이 다 그려지면 내 PC 가 그림 순서표대로 그림을 넘기고 카메라를 움직여 가사 글씨 없는 영상을 만들고, 마지막에 가사 자막을 입혀요.'),
        h('div', { class: 'row' }, snap.xsheet ? rerender : null, o.clean ? resub : null));
    }
    if (isLocked(snap)) {
      return h('div', { class: 'section' }, h('h3', null, '🎬 새 영상을 만드는 중이에요'),
        h('p', { class: 'desc' }, '끝나면 여기에 새 영상이 나와요. 만드는 동안에는 영상 파일을 열어 둘 수 없어서 잠깐 숨겨 둬요. 진행 상황은 아래 막대에서 볼 수 있어요.'));
    }
    const file = abs(snap, o.video);
    const clean = o.clean ? abs(snap, o.clean) : null;
    return h('div', null,
      snap.changes && snap.changes.count > 0 && !snap.running ? h('div', { class: 'notice warn' }, '✏️ 바뀐 곳이 있어요. 아래 [✨ 고친 것 반영하기] 를 누르면 한 번에 반영돼요. (내 컴퓨터가 해요 · 무료)') : null,
      h('div', { class: 'section' },
        h('div', { class: 'final-wrap' },
          h('video', {
            src: AM.fileUrl(file, o.madeAt), controls: true, preload: 'metadata',
            style: snap.workflow.aspect === '16:9'
              ? { width: '100%', maxWidth: '760px', flex: '1 1 480px', height: 'auto' }
              : { height: 'min(68vh, 640px)', width: 'auto', flex: 'none' },
          }),
          h('div', { class: 'col', style: { minWidth: '260px' } },
            h('h3', null, snap.series ? `🎉 ${snap.series.episode}화 완성!` : '🎉 완성!'),
            h('div', { class: 'small muted' }, o.video.split('/').pop()),
            h('button', { class: 'btn primary', onclick: () => window.api.showItem(file) }, '📂 파일 위치 열기'),
            clean ? h('button', { class: 'btn', onclick: () => window.api.showItem(clean) }, '🎞 가사 글씨 없는 영상') : null,
            rerender, resub,
            h('div', { class: 'small muted' }, '같은 폴더에 가사 자막 파일(lyrics.srt / lyrics.lrc), 스토리보드(storyboard.md), 그림 순서표(timesheet.json)도 있어요.'),
            snap.series ? h('div', { class: 'notice ok small' }, `📚 이번 이야기 요약이 "${AM.niceTitle(snap.series.name)}" 기록에 남았어요. 다음 화는 이 이야기에서 이어져요.`,
              h('div', { style: { marginTop: '6px' } }, h('button', { class: 'btn small', onclick: () => AM.go('home', snap.series.id) }, `🎬 ${snap.series.episode + 1}화 만들기`))) : null,
            h('div', { class: 'notice info small' }, '📌 AI 로 만든 영상이에요. 올릴 때는 플랫폼의 "AI 생성 콘텐츠" 표시 규정을 확인하세요. (파일 정보에도 AI 생성 표시를 넣어 두었어요)')))));
  }

  async function logTab(snap) {
    const box = h('div', { class: 'logbox' });
    let text = '';
    try { text = await window.api.readLog(snap.id); } catch (_) { text = (AM.state.logs.get(snap.id) || []).join('\n'); }
    box.textContent = text;
    cur.els.logbox = box;
    setTimeout(() => { box.scrollTop = box.scrollHeight; }, 0);
    return h('div', null, h('div', { class: 'row', style: { marginBottom: '8px' } },
      h('span', { class: 'muted small grow' }, '문제가 생기면 이 기록을 캡처해서 물어보세요. AI 프로그램 원본 출력은 작업 폴더의 work 폴더에 있어요.'),
      h('button', { class: 'btn small', onclick: () => window.api.openPath(AM.joinPath(snap.dir, 'work')) }, '📂 work 폴더')), box);
  }

  // ---------- 대화상자 ----------
  function redoDialog(snap) {
    const sel = h('select', null, AM.STEP_META.map((m, i) => h('option', { value: m.id }, `${i + 1}. ${m.label} 부터`)));
    sel.value = 'render';
    AM.kit.sheet('↻ 단계 다시 하기', h('div', { class: 'col' },
      h('p', null, '고른 단계부터 다시 해요. 이미 그린 그림은 같은 주문이면 그대로 써서 AI 사용량을 아껴요.'),
      sel,
      h('ul', { class: 'small muted' },
        h('li', null, '노래·가사부터: 박자를 다시 분석해요 (노래를 바꾸려면 [자세히 보기] 의 [노래·가사·장면] 탭에서 [노래 바꾸기])'),
        h('li', null, '이야기부터: 이번 이야기를 새로 써요'),
        h('li', null, '장면 나누기부터: 장면 경계와 하이라이트를 다시 정해요'),
        h('li', null, '그림 순서표부터: 그림 장수·보여 주는 시간·카메라를 AI 가 다시 짜요'),
        h('li', null, '영상 만들기부터: 바뀐 장면만 다시 만들고 자막도 다시 입혀요 (무료)'),
        h('li', null, '가사 자막부터: 자막만 다시 입혀요 (무료, 빠름)'))), [
      { label: '취소' },
      { label: '다시 하기', kind: 'primary', onClick: async () => { await startRun(() => window.api.runProject(snap.id, sel.value)); } },
    ]);
  }

  function providersDialog(snap) {
    const sels = {};
    const rows = ['text', 'image'].map((k) => {
      sels[k] = h('select', null, AM.PROVIDERS[k].map((p) => h('option', { value: p.id }, p.label)));
      sels[k].value = snap.providers[k];
      return h('label', { class: 'field' }, ({ text: '이야기 쓰는 AI', image: '그림 그리는 AI' })[k], sels[k]);
    });
    AM.kit.sheet('🔧 이 영상을 맡을 AI', h('div', { class: 'col' }, h('p', { class: 'muted small' }, '이 영상에만 적용돼요. 처음 정하는 값은 [설정]에서 바꿔요.'), rows), [
      { label: '취소' },
      { label: '저장', kind: 'primary', onClick: async () => { await AM.safe(() => window.api.setProviders(snap.id, Object.fromEntries(Object.entries(sels).map(([k, s]) => [k, s.value]))), '바꿨어요. 멈춰 있다면 [이어서 하기]를 눌러 주세요.'); } },
    ]);
  }

  // 화면 확인용 (Playwright): 가짜 스냅샷을 그려 보거나 모드를 바꿔 본다
  AM.proj._test = {
    get cur() { return cur; },
    setMode: (m, o) => setMode(m, o),
    render: (snap) => AM.views.projectUpdate(snap),
  };
}(window.AM));
