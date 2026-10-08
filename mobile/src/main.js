// AnimeMaker V2 폰 앱 — 껍데기: 아래 탭 4개 (🎬 만들기 · 📂 내 영상 · 🧒 주인공 · ⚙ 설정), 길 찾기, 뒤로가기, 공유 받기, 오류 알림.
// 화면 안쪽은 src/screens/*.js, 만들기 엔진은 src/engine/index.js.
import * as db from './db.js';
import { withJosa } from './josa.js';
import * as N from './native.js';
import * as ui from './ui.js';
import { h, clear, toast, closeTopSheet, busyCount, createJobUi } from './ui.js';
import * as jobs from './jobs.js';
import * as fonts from './fonts.js';
import * as probeApi from './probe.js';
import * as inboxApi from './inbox.js';
import { installFonts } from './fonts.js';
import { loadSettings, saveSettings, restoreSettings, normalizeSettings } from './settings.js';
import { startReceiving } from './inbox.js';
import { runDevJob } from './dev-tools.js';
import { createEngine } from './engine/index.js';
import { mountForTest } from './screens/project-mount.js';
import { homeScreen, welcomeScreen, loadDraft } from './screens/home.js';
import { projectsScreen } from './screens/projects.js';
import { heroScreen } from './screens/hero.js';
import { settingsScreen } from './screens/settings.js';
import { helpScreen } from './screens/help.js';
import { projectScreen } from './screens/project.js';
import { forgetThumb } from './screens/projects-util.js';

const VERSION = typeof __AM_VERSION__ !== 'undefined' ? __AM_VERSION__ : 'dev';
const TABS = [
  { id: 'home', emoji: '🎬', label: '만들기' },
  { id: 'projects', emoji: '📂', label: '내 영상' },
  { id: 'hero', emoji: '🧒', label: '주인공' },
  { id: 'settings', emoji: '⚙', label: '설정' },
];
/** 엔진과 화면이 쓰는 안드로이드 기능 묶음 (복사본이라 시험에서 하나씩 바꿔 끼울 수 있다: window.AnimeMaker.native.sendToApp = …) */
const NA = { ...N };

// ───────────────────────── 앱 상태 · 길 찾기 ─────────────────────────

const app = {
  route: 'home', // welcome | home | projects | hero | settings | help | project
  params: {},
  settings: loadSettings(globalThis.localStorage, N.AI_APPS),
  prefs: {}, // 저장소 meta('prefs'): welcomed · connected · notify · qualityInit
  probe: null,
  engine: null,
  native: NA,
  installed: {},
  practiceSeconds: 0, // 시험용: 연습 노래 길이(초)를 줄인다 (0 = 기본 60초)
  renderToken: 0,
  screen: null,
  backStack: [],
  prev: 'home',

  setSetting(key, value) {
    this.settings = normalizeSettings({ ...this.settings, [key]: value }, N.AI_APPS);
    saveSettings(this.settings, { db });
  },
  async setPref(key, value) {
    this.prefs = { ...this.prefs, [key]: value };
    await db.setMeta('prefs', this.prefs).catch(() => {});
  },

  go(route, params = {}) {
    if (this.route !== route) this.prev = this.route;
    this.route = route;
    this.params = params;
    this.render();
    window.scrollTo(0, 0);
  },

  /** 영상 열기. 마지막으로 연 영상을 저장소에 적어 둔다 (앱을 다시 켜도 이어서 열 수 있게) */
  async open(id, opts = {}) {
    const p = await db.getProject(id);
    if (!p) throw new Error('영상을 찾지 못했어요');
    await db.setLastProject(id);
    this.go('project', { id, from: opts.from || 'projects', autorun: !!opts.autorun });
  },

  /** 영상 지우기: 엔진이 일을 멈추고 기록 · 그림 · 파일을 모두 지운다 */
  async deleteProject(id) {
    if (this.engine) await this.engine.projects.delete(id);
    else {
      if (jobs.cancelJob(id)) await jobs.waitForJob(id);
      await db.deleteProject(id);
    }
    forgetThumb(id);
    if ((await db.getLastProject()) === id) await db.setLastProject(null);
  },

  /** 화면 안쪽 한 단계(전체 화면 칸 · 편집기)가 안드로이드 뒤로가기를 먼저 받는다. 돌려주는 함수로 해제 */
  pushBack(fn) {
    this.backStack.push(fn);
    return () => { const i = this.backStack.lastIndexOf(fn); if (i >= 0) this.backStack.splice(i, 1); };
  },

  async render() {
    const token = ++this.renderToken;
    const route = this.route;
    const root = document.getElementById('app');
    if (this.screen && this.screen.destroy) { try { this.screen.destroy(); } catch (e) { console.error(e); } }
    this.screen = null;
    this.backStack = [];
    clear(root);
    document.body.classList.toggle('has-tabs', TABS.some((t) => t.id === route));
    document.body.dataset.route = route;
    const isTab = TABS.some((t) => t.id === route);
    if (route !== 'project' && route !== 'welcome') {
      root.appendChild(h('header', { class: 'top' },
        route === 'help'
          ? h('button', { class: 'icon-btn', id: 'top-back', 'aria-label': '뒤로', onclick: () => this.back() }, '←')
          : h('img', { class: 'logo', src: 'icon.png', alt: '' }),
        h('div', { class: 'top-title' }, route === 'help' ? '도움말' : 'AnimeMaker V2'),
        route === 'help' ? null : h('button', { class: 'icon-btn', id: 'top-help', 'aria-label': '도움말', onclick: () => this.go('help') }, '❓')));
    }
    const main = h('main', { class: route === 'project' ? 'proj-main' : '', id: 'main' });
    root.appendChild(main);
    if (isTab) {
      root.appendChild(h('nav', { class: 'tabs', 'aria-label': '메뉴' }, TABS.map((t) => h('button', {
        class: `tab${t.id === route ? ' on' : ''}`, 'data-tab': t.id, 'aria-current': t.id === route ? 'page' : null,
        onclick: () => { try { navigator.vibrate && navigator.vibrate(15); } catch (_) { /* 진동 없음 */ } if (t.id !== route || Object.keys(this.params).length) this.go(t.id); },
      }, h('span', { class: 'ti', 'aria-hidden': 'true' }, t.emoji), h('span', { class: 'tl' }, t.label)))));
    }
    try {
      const make = { welcome: welcomeScreen, home: homeScreen, projects: projectsScreen, hero: heroScreen, settings: settingsScreen, help: helpScreen, project: projectScreen }[route] || homeScreen;
      const screen = await make(this, this.params);
      if (token !== this.renderToken) { if (screen.destroy) screen.destroy(); return; }
      this.screen = screen;
      main.appendChild(screen.el);
    } catch (e) {
      if (token !== this.renderToken) return;
      console.error(e);
      main.appendChild(h('div', { class: 'card' }, h('h3', null, '화면을 열지 못했어요'), h('p', { class: 'small muted' }, (e && e.message) || String(e)), h('button', { class: 'btn', onclick: () => this.go('home') }, '처음으로')));
    }
  },

  /**
   * 안드로이드 뒤로가기. 순서: 일하는 중이면 "그만둘까요, 계속 할까요?" → 열린 창 닫기 → 화면 안쪽 한 단계(전체 화면 칸 · 편집기) → 영상 화면 → 다른 탭 → 만들기 → 앱 끝내기
   */
  async back() {
    const g = await jobs.guardBack();
    if (g !== 'none') return;
    if (closeTopSheet()) return;
    if (busyCount() > 0) return; // 덮개가 떠 있는데 등록된 일이 없는 경우: 뒤 화면을 움직이지 않는다
    const top = this.backStack[this.backStack.length - 1];
    if (top) { const used = await top(); if (used) return; }
    if (this.route === 'project') {
      const from = this.params.from;
      this.go(from === 'home' ? 'home' : 'projects');
    } else if (this.route === 'help') this.go(this.prev && this.prev !== 'help' && this.prev !== 'project' ? this.prev : 'settings');
    else if (this.route === 'hero' && this.params.id) this.go('hero', {});
    else if (this.route !== 'home' && this.route !== 'welcome') this.go('home');
    else N.exitApp();
  },
};

// ───────────────────────── 공유 받기 · 오래 걸리는 일 · 오류 알림 ─────────────────────────

async function onReceived(s) {
  if (s.duplicate) return;
  window.dispatchEvent(new CustomEvent('am:inbox', { detail: s })); // 화면이 받은 함을 다시 읽을 수 있게
  const onlyPics = (s.record.items || []).length && (s.record.items || []).every((i) => /^image\//.test(i.mime || '')) && !s.text;
  let r = { routed: 0, kept: 0 };
  try { r = await app.engine.handoff.routeInbox(); } catch (e) { errorToast((e && e.message) || String(e)); }
  const what = onlyPics ? `그림 ${(s.record.items || []).length}장을` : withJosa(s.label, '을/를');
  toast(`📥 ${what} 받았어요${r.routed ? ' — 알맞은 자리에 넣었어요' : (r.kept ? ' — 어디에 쓸지 골라 주세요' : '')}`, s.stored || s.text ? 'ok' : 'warn', 4500);
  if (s.failed) toast(`읽지 못한 것이 ${s.failed}개 있어요`, 'warn', 4500);
  // 기다리던 영상이 있으면 그 영상으로 (콜드 스타트로 켜졌을 때도 기다림은 저장소에 남아 있다). 일하는 중이면 방해하지 않는다.
  db.getExpecting().then((e) => {
    if (!e || jobs.isJobRunning() || busyCount() > 0) return;
    if (String(e.projectId).startsWith('char:')) { if (!(app.route === 'hero' && app.params.id)) app.go('hero', { id: String(e.projectId).slice(5) }); return; }
    if (app.route === 'project' && app.params.id === e.projectId) return; // 열려 있는 화면은 엔진 신호로 스스로 고친다
    app.open(e.projectId, { from: 'projects' }).catch(() => {});
  }).catch(() => {});
}

let fgJobs = 0;
let lastServiceUpdate = 0;
jobs.setJobUi(createJobUi());
jobs.setJobHooks({
  start(job) {
    if (!job.foreground) return;
    if (fgJobs++ === 0) { N.keepAwake(true); N.startJobService({ title: job.title, text: job.message || '작업하는 중이에요' }); }
  },
  progress(job) {
    if (!job.foreground) return;
    const now = Date.now();
    if (now - lastServiceUpdate < 500) return; // 알림줄은 너무 자주 고치지 않는다
    lastServiceUpdate = now;
    N.updateJobService({ text: job.message || job.title, progress: job.progress == null ? undefined : job.progress });
  },
  end(job) {
    if (!job.foreground) return;
    if (--fgJobs <= 0) { fgJobs = 0; N.stopJobService(); N.keepAwake(false); }
  },
});

const recentErrors = new Map(); // 오류 글 → 마지막으로 알린 시각
function errorToast(msg) {
  const now = Date.now();
  const last = recentErrors.get(msg);
  if (last !== undefined && now - last < 4000) return; // 같은 오류가 섞여서 연달아 쏟아져도 한 번만
  recentErrors.set(msg, now);
  if (recentErrors.size > 30) for (const [k, t] of recentErrors) if (now - t >= 4000) recentErrors.delete(k);
  toast(`문제가 생겼어요: ${msg}`, 'err', 6000);
}
window.addEventListener('error', (e) => {
  if (/ResizeObserver loop/.test(e.message || '')) return;
  errorToast(e.message || '알 수 없는 오류');
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  if (r && r.name === 'AbortError') return; // 그만둔 일
  errorToast((r && r.message) || String(r));
});

// ───────────────────────── 시작 ─────────────────────────

async function boot() {
  installFonts();
  N.getAppInfo().then((a) => N.applySystemBars(a)).catch(() => {});
  N.onBackButton(() => { app.back(); });
  N.onResume(() => {
    N.installedApps().then((m) => { app.installed = m; }).catch(() => {});
    window.dispatchEvent(new CustomEvent('am:resume'));
  });
  try {
    await db.open();
  } catch (e) {
    document.getElementById('app').appendChild(h('main', null, h('div', { class: 'card' }, h('h3', null, '저장소를 열 수 없어요'), h('p', { class: 'small' }, (e && e.message) || String(e)), h('p', { class: 'small muted' }, '폰을 다시 켜거나 앱을 지우고 다시 설치해 보세요.'))));
    throw e;
  }
  app.settings = await restoreSettings({ db, apps: N.AI_APPS });
  app.prefs = (await db.getMeta('prefs', {}).catch(() => ({}))) || {};
  db.ensurePersistOnce().catch(() => {}); // 처음 켰을 때 한 번: 저장 공간을 지켜 달라고 요청
  try { app.probe = await probeApi.loadProbe({ store: db, appInfo: await N.getAppInfo() }); } catch (_) { app.probe = null; }
  if (!app.prefs.qualityInit) { // 메모리가 적은 폰은 처음부터 가볍게
    if (app.probe && app.probe.decision && app.probe.decision.suggestedQuality === '480p') app.setSetting('quality', '480p');
    await app.setPref('qualityInit', true);
  }
  app.engine = createEngine({ db, native: NA, probe: app.probe });
  app.engine.on('error', (e) => errorToast((e && e.message) || String(e)));
  app.installed = await N.installedApps().catch(() => ({}));
  await loadDraft();
  startReceiving({
    native: NA,
    onReceived,
    onError: (e) => toast(e && e.quota ? '저장 공간이 부족해서 받은 것을 넣지 못했어요. 공간을 만든 뒤 앱을 다시 열어 주세요.' : `받은 것을 넣지 못했어요: ${(e && e.message) || e}`, 'err', 6000),
  });
  app.engine.handoff.routeInbox().catch((e) => errorToast((e && e.message) || String(e))); // 앱이 꺼진 사이 받은 것을 기다리던 칸으로
  const first = !app.prefs.welcomed && (await db.listProjects()).length === 0;
  app.route = first ? 'welcome' : 'home';
  await app.render();
}

// 시험·문제 확인용 (브라우저 콘솔과 e2e 가 쓴다). 화면이 보내는 신호: am:inbox(공유로 받음) · am:resume(앱으로 돌아옴) · am:job-done(일 끝남)
window.addEventListener('am:job-done', () => { if (app.route === 'project' && app.screen && app.screen.legacy) app.render(); });
window.AnimeMaker = {
  app, db, N, native: NA, jobs, ui, fonts, probe: probeApi, inbox: inboxApi, version: VERSION, devJob: runDevJob, mountForTest,
  get engine() { return app.engine; },
  ready: boot(),
};
