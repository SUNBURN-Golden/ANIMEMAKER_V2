'use strict';
/* 화면 전환 · 전역 상태 */
(function (AM) {
  const { h, clear } = AM;

  AM.state = {
    view: 'home',
    viewArg: null, // 화면에 넘길 값 (예: 고른 시리즈·캐릭터 id)
    projectId: null,
    settings: null,
    info: null,
    workflows: [],
    projects: new Map(), // id → snapshot
    logs: new Map(), // id → lines
  };

  const views = {
    home: () => AM.views.home(AM.state.viewArg),
    hero: () => AM.views.hero(AM.state.viewArg),
    series: () => AM.views.series(AM.state.viewArg),
    characters: () => AM.views.characters(AM.state.viewArg),
    projects: () => AM.views.projects(),
    project: () => AM.views.project(AM.state.projectId),
    workflows: () => AM.views.workflows(),
    settings: () => AM.views.settings(),
    help: () => AM.views.help(),
  };

  // 사이드바에서 켜 둘 칸. 옛 화면(시리즈·캐릭터·워크플로우)은 사이드바에서 빠졌지만 '고급' 링크로 들어오면 가까운 칸을 켠다.
  const NAV_OF = {
    home: 'home', projects: 'projects', project: 'projects', hero: 'hero', series: 'hero', characters: 'hero', settings: 'settings', workflows: 'settings', help: 'help',
  };

  let navSeq = 0;

  /**
   * 화면이 "저장하지 않은 변경이 있어요. 나갈까요?" 같은 물음을 하고 싶을 때 함수를 넣어 둔다.
   * 함수는 (Promise 가능) true 면 이동, false 면 지금 화면에 머문다. 한 번 물은 뒤에는 자동으로 비워진다.
   */
  AM.leaveGuard = null;

  AM.go = function go(view, arg) {
    if (AM.leaveGuard) {
      const guard = AM.leaveGuard;
      Promise.resolve().then(() => guard()).then((ok) => {
        if (ok === false) return;
        if (AM.leaveGuard === guard) AM.leaveGuard = null;
        go(view, arg);
      }, () => { if (AM.leaveGuard === guard) AM.leaveGuard = null; go(view, arg); });
      return;
    }
    if (!views[view]) view = 'home';
    if (AM.state.view === 'project' && view !== 'project' && AM.views.projectLeave) AM.views.projectLeave();
    AM.state.view = view;
    AM.state.viewArg = arg == null ? null : arg;
    if (view === 'project') AM.state.projectId = arg;
    const navView = NAV_OF[view];
    document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === navView));
    const main = clear(document.getElementById('main'));
    main.scrollTop = 0;
    main.appendChild(h('div', { class: 'muted' }, '불러오는 중…'));
    const token = ++navSeq;
    // 아직 저장 안 된 입력(자동 저장)이 있으면 먼저 끝낸 뒤 새 화면을 연다. 없으면 바로 연다.
    const pending = AM.kit && AM.kit.flushAll ? AM.kit.flushAll() : null;
    let opened;
    if (pending) opened = pending.then(() => views[view]());
    else { try { opened = Promise.resolve(views[view]()); } catch (e) { opened = Promise.reject(e); } }
    opened.then((node) => {
      if (token !== navSeq) return;
      clear(main);
      if (node) main.appendChild(node);
    }).catch((e) => {
      if (token !== navSeq) return;
      clear(main);
      main.appendChild(h('div', { class: 'notice err' }, `화면을 여는 중 문제가 생겼어요: ${e.message}`));
    });
  };

  AM.refreshSettings = async function () {
    AM.state.settings = await window.api.getSettings();
    return AM.state.settings;
  };

  /** 사이드바 칸에 '일하는 중' 점 (예: 주인공을 그리는 동안) */
  AM.navBusy = function navBusy(view, on) {
    const b = document.querySelector(`#nav [data-view="${view}"]`);
    if (b) b.classList.toggle('busy', !!on);
  };

  function renderSideRunning() {
    const box = clear(document.getElementById('side-running'));
    for (const p of AM.state.projects.values()) {
      const redrawing = !p.running && p.redrawing && p.redrawing.length > 0; // 그림 한 장 다시 그리기는 '만드는 중' 이 아니다
      if (!p.running && p.status !== 'limited' && !redrawing) continue;
      const step = AM.STEP_META.find((s) => s.id === p.currentStep);
      const title = AM.niceTitle((p.plan && p.plan.title) || p.title);
      box.appendChild(h('button', { class: 'run-chip', title, onclick: () => AM.go('project', p.id) },
        h('span', { class: 'rc-ico' }, p.waiting ? '🙋' : '⏳'),
        h('span', { class: 'rc-txt' },
          h('b', null, title),
          h('span', { class: 'rc-sub' }, redrawing ? '그림 다시 그리는 중' : p.waiting ? '내 도움이 필요해요' : p.status === 'limited' ? '잠깐 쉬는 중이에요' : step ? step.chip : '만드는 중'))));
    }
  }

  window.api.onProjectUpdate((snap) => {
    const prev = AM.state.projects.get(snap.id);
    AM.state.projects.set(snap.id, snap);
    renderSideRunning();
    if (AM.state.view === 'project' && AM.state.projectId === snap.id && AM.views.projectUpdate) AM.views.projectUpdate(snap);
    if (AM.state.view === 'projects' && AM.views.projectsUpdate) AM.views.projectsUpdate(snap, prev);
    // 사용자 도움이 새로 필요해지면 알림
    if (snap.waiting && (!prev || !prev.waiting || prev.waiting.key !== snap.waiting.key)) {
      if (document.hidden || AM.state.view !== 'project' || AM.state.projectId !== snap.id) {
        try { new Notification('AnimeMaker V2: 도움이 필요해요', { body: snap.waiting.title }); } catch (_) { /* noop */ }
      }
    }
    if (prev && prev.status !== 'done' && snap.status === 'done') {
      try { new Notification('AnimeMaker V2: 완성!', { body: `영상이 완성됐어요: ${AM.niceTitle((snap.plan && snap.plan.title) || snap.title)}` }); } catch (_) { /* noop */ }
    }
  });
  window.api.onProjectLog(({ projectId, line }) => {
    const arr = AM.state.logs.get(projectId) || [];
    arr.push(line);
    if (arr.length > 2000) arr.splice(0, arr.length - 2000);
    AM.state.logs.set(projectId, arr);
    if (AM.state.view === 'project' && AM.state.projectId === projectId && AM.views.projectLog) AM.views.projectLog(line);
  });

  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => AM.go(b.dataset.view)));

  // 파일을 창에 떨어뜨렸을 때 브라우저가 열어버리지 않도록
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  // 스크롤 막대 너비 → 아래 고정 바가 막대를 가리지 않게 (css 변수 --sbw)
  const mainEl = document.getElementById('main');
  const fitScrollbar = () => document.documentElement.style.setProperty('--sbw', `${Math.max(0, mainEl.offsetWidth - mainEl.clientWidth)}px`);
  if (window.ResizeObserver) new ResizeObserver(fitScrollbar).observe(mainEl);
  window.addEventListener('resize', fitScrollbar);
  fitScrollbar();

  async function boot() {
    AM.state.info = await window.api.appInfo();
    await AM.refreshSettings();
    AM.state.workflows = await window.api.listWorkflows();
    AM.go('home');
    if (!AM.state.settings.firstRunDone) AM.views.welcome();
  }
  boot();
}(window.AM));
