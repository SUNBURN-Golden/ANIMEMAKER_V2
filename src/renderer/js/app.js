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
    series: () => AM.views.series(AM.state.viewArg),
    characters: () => AM.views.characters(AM.state.viewArg),
    projects: () => AM.views.projects(),
    project: () => AM.views.project(AM.state.projectId),
    workflows: () => AM.views.workflows(),
    settings: () => AM.views.settings(),
    help: () => AM.views.help(),
  };

  AM.go = function go(view, arg) {
    if (AM.state.view === 'project' && view !== 'project' && AM.views.projectLeave) AM.views.projectLeave();
    AM.state.view = view;
    AM.state.viewArg = arg == null ? null : arg;
    if (view === 'project') AM.state.projectId = arg;
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === (view === 'project' ? 'projects' : view)));
    const main = clear(document.getElementById('main'));
    main.scrollTop = 0;
    main.appendChild(h('div', { class: 'muted' }, '불러오는 중…'));
    Promise.resolve(views[view]()).then((node) => {
      if (AM.state.view !== view) return;
      clear(main);
      if (node) main.appendChild(node);
    }).catch((e) => {
      clear(main);
      main.appendChild(h('div', { class: 'notice err' }, `화면을 여는 중 오류: ${e.message}`));
    });
  };

  AM.refreshSettings = async function () {
    AM.state.settings = await window.api.getSettings();
    return AM.state.settings;
  };

  function renderSideRunning() {
    const box = clear(document.getElementById('side-running'));
    for (const p of AM.state.projects.values()) {
      if (!p.running && p.status !== 'limited') continue;
      const step = AM.STEP_META.find((s) => s.id === p.currentStep);
      box.appendChild(h('button', { class: 'run-chip', onclick: () => AM.go('project', p.id) },
        `${p.waiting ? '🙋 ' : '⏳ '}${(p.plan && p.plan.title) || p.title}`, h('br'),
        h('span', { style: { opacity: 0.8 } }, p.waiting ? '내 도움이 필요해요' : step ? `${step.label} 진행 중` : '진행 중')));
    }
  }

  window.api.onProjectUpdate((snap) => {
    const prev = AM.state.projects.get(snap.id);
    AM.state.projects.set(snap.id, snap);
    renderSideRunning();
    if (AM.state.view === 'project' && AM.state.projectId === snap.id && AM.views.projectUpdate) AM.views.projectUpdate(snap);
    // 사용자 도움이 새로 필요해지면 알림
    if (snap.waiting && (!prev || !prev.waiting || prev.waiting.key !== snap.waiting.key)) {
      if (document.hidden || AM.state.view !== 'project' || AM.state.projectId !== snap.id) {
        try { new Notification('AnimeMaker V2: 도움이 필요해요', { body: snap.waiting.title }); } catch (_) { /* noop */ }
      }
    }
    if (prev && prev.status !== 'done' && snap.status === 'done') {
      try { new Notification('AnimeMaker V2: 완성!', { body: `${(snap.plan && snap.plan.title) || snap.title} 에피소드가 완성됐어요.` }); } catch (_) { /* noop */ }
    }
  });
  window.api.onProjectLog(({ projectId, line }) => {
    const arr = AM.state.logs.get(projectId) || [];
    arr.push(line);
    if (arr.length > 2000) arr.splice(0, arr.length - 2000);
    AM.state.logs.set(projectId, arr);
    if (AM.state.view === 'project' && AM.state.projectId === projectId && AM.views.projectLog) AM.views.projectLog(line);
  });

  document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => AM.go(b.dataset.view)));

  // 파일을 창에 떨어뜨렸을 때 브라우저가 열어버리지 않도록
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  async function boot() {
    AM.state.info = await window.api.appInfo();
    await AM.refreshSettings();
    AM.state.workflows = await window.api.listWorkflows();
    AM.go('home');
    if (!AM.state.settings.firstRunDone) AM.views.welcome();
  }
  boot();
}(window.AM));
