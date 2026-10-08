// AnimeMaker V2 폰 앱 — 껍데기: 시작 화면 · 설정 · 작품 자리(placeholder), 뒤로가기, 공유 받기, 오류 알림.
// 작품 화면 안쪽(지금 할 일 · 이야기 · 그림 받기 · 영상 만들기 …)은 이 틀 위에 C2(엔진)·C3(화면)가 채운다.
import * as db from './db.js';
import * as N from './native.js';
import * as ui from './ui.js';
import { h, clear, toast, confirmBox, closeTopSheet, busyCount, createJobUi, fmtSize } from './ui.js';
import * as jobs from './jobs.js';
import { probeCard } from './probe-card.js';
import * as fonts from './fonts.js';
import * as probeApi from './probe.js';
import * as inboxApi from './inbox.js';
import { installFonts } from './fonts.js';
import { loadSettings, saveSettings, restoreSettings, normalizeSettings, QUALITIES } from './settings.js';
import { startReceiving, listReceived, describeReceived } from './inbox.js';
import { runDevJob } from './dev-tools.js';

const VERSION = typeof __AM_VERSION__ !== 'undefined' ? __AM_VERSION__ : 'dev';

// ───────────────────────── 앱 상태 · 길 찾기 ─────────────────────────

const app = {
  route: 'home', // home | settings | project
  params: {},
  settings: loadSettings(globalThis.localStorage, N.AI_APPS),
  renderToken: 0,

  setSetting(key, value) {
    this.settings = normalizeSettings({ ...this.settings, [key]: value }, N.AI_APPS);
    saveSettings(this.settings, { db });
  },

  go(route, params = {}) {
    this.route = route;
    this.params = params;
    this.render();
    window.scrollTo(0, 0);
  },

  /** 작품 열기. 마지막으로 연 작품을 저장소에 적어 둔다 (앱을 다시 켜도 이어서 열 수 있게) */
  async open(id) {
    const p = await db.getProject(id);
    if (!p) throw new Error('작품을 찾지 못했어요');
    await db.setLastProject(id);
    this.go('project', { id });
  },

  /** 작품 지우기: 그 작품 id 로 도는 일이 있으면 먼저 그만두고 끝나기를 기다린다 (지운 작품에 결과가 되살아나지 않게) */
  async deleteProject(id) {
    if (jobs.cancelJob(id)) await jobs.waitForJob(id);
    await db.deleteProject(id);
    if ((await db.getLastProject()) === id) await db.setLastProject(null);
  },

  render() {
    const token = ++this.renderToken;
    const root = document.getElementById('app');
    clear(root);
    const title = h('div', { class: 'top-title' }, this.route === 'settings' ? '설정' : 'AnimeMaker V2');
    root.appendChild(h('header', { class: 'top' },
      this.route === 'home'
        ? h('img', { class: 'logo', src: 'icon.png', alt: '' })
        : h('button', { class: 'icon-btn', onclick: () => this.back(), 'aria-label': '뒤로' }, '←'),
      title,
      this.route === 'settings' ? null : h('button', { class: 'icon-btn', onclick: () => this.go('settings'), 'aria-label': '설정' }, '⚙')));
    const main = h('main', null);
    root.appendChild(main);
    const view = { home: homeView, settings: settingsView, project: projectView }[this.route] || homeView;
    Promise.resolve()
      .then(() => view({ setTitle: (t) => { if (token === this.renderToken) title.textContent = t; } }))
      .then((el) => { if (token === this.renderToken) main.appendChild(el); })
      .catch((e) => { if (token === this.renderToken) main.appendChild(h('div', { class: 'card' }, h('h3', null, '화면을 열지 못했어요'), h('p', { class: 'muted small' }, (e && e.message) || String(e)))); });
  },

  /**
   * 안드로이드 뒤로가기. 일하는 중이면 먼저 "그만둘까요, 계속 할까요?" 를 묻고(하던 일을 잃지 않게),
   * 그다음 열린 창을 닫고, 마지막으로 화면을 한 단계 돌아간다. 시작 화면에서는 앱을 끝낸다.
   */
  async back() {
    const g = await jobs.guardBack();
    if (g !== 'none') return;
    if (closeTopSheet()) return;
    if (busyCount() > 0) return; // 덮개가 떠 있는데 등록된 일이 없는 경우: 뒤 화면을 움직이지 않는다
    if (this.route === 'home') N.exitApp(); else this.go('home');
  },
};

// ───────────────────────── 시작 화면 ─────────────────────────

async function newProject() {
  const p = await db.putProject({ id: db.newId('p'), title: '새 영상', createdAt: Date.now(), stage: 'new' });
  await app.open(p.id);
}

async function homeView() {
  const list = await db.listProjects();
  return h('div', null,
    h('div', { class: 'hero' },
      h('img', { src: 'icon.png', alt: '' }),
      h('div', null, h('h1', null, 'AnimeMaker V2'), h('p', null, '노래만 있으면 옛날 손그림 애니 느낌의 뮤직비디오를 폰에서 만들어요.'))),
    h('button', { class: 'btn primary big', id: 'btn-new', onclick: () => newProject().catch((e) => toast(e.message, 'err')) }, '🎬 만들기'),
    h('h2', null, '내 영상'),
    list.length
      ? h('div', { class: 'plist' }, list.map((p) => h('div', { class: 'pitem', 'data-id': p.id, onclick: () => app.open(p.id).catch((e) => toast(e.message, 'err')) },
        h('div', { class: 'grow' },
          h('div', { class: 'ptitle' }, p.title || '(이름 없음)'),
          h('div', { class: 'muted small' }, `${new Date(p.updatedAt || p.createdAt || Date.now()).toLocaleDateString('ko-KR')}${p.output ? ' · ✔ 완성' : ''}`)),
        h('button', {
          class: 'icon-btn',
          'aria-label': '지우기',
          onclick: async (e) => {
            e.stopPropagation();
            if (await confirmBox('영상을 지울까요?', `"${p.title || '(이름 없음)'}" 와 안에 든 노래·그림·영상을 이 앱에서 지워요. (갤러리에 저장한 영상은 남아요)`, '지우기')) {
              await app.deleteProject(p.id);
              app.render();
            }
          },
        }, '🗑'))))
      : h('p', { class: 'muted', id: 'empty-list' }, '아직 영상이 없어요. 위의 [만들기] 로 시작해 보세요!'),
    probeCard(),
    h('p', { class: 'note' }, '💳 AI 는 이미 구독 중인 ChatGPT · Gemini · Grok · Claude 앱 안에서만 써요. 이 앱은 따로 돈을 받거나 API 키를 쓰지 않아요.'));
}

// ───────────────────────── 설정 ─────────────────────────

function aiAppRow(kind, label, installedMap) {
  const row = h('div', { class: 'card' }, h('h3', null, label), h('div', { class: 'chips', 'data-kind': kind }));
  const chips = row.querySelector('.chips');
  const paint = () => {
    clear(chips);
    for (const [id, a] of Object.entries(N.AI_APPS)) {
      if (!a.good.includes(kind)) continue;
      const note = installedMap && installedMap[id] === false && N.isNative ? ' (안 깔려 있어요)' : '';
      chips.appendChild(h('button', {
        class: `chip ${app.settings[`${kind}App`] === id ? 'on' : ''}`,
        'data-app': id,
        onclick: () => { app.setSetting(`${kind}App`, id); paint(); },
      }, a.name, note ? h('small', null, note) : null));
    }
  };
  paint();
  return row;
}

async function settingsView() {
  const installed = await N.installedApps().catch(() => null);
  const usageEl = h('p', { class: 'small muted' }, '저장 공간을 확인하는 중…');
  const persistBtn = h('button', { class: 'btn small', id: 'btn-persist', style: { display: 'none' } }, '🔒 저장 공간 지켜 달라고 요청');
  const showUsage = async () => {
    const u = await db.usage();
    if (!u) { usageEl.textContent = '저장 공간 정보를 알 수 없어요.'; return; }
    usageEl.textContent = `이 앱이 쓰는 저장 공간: ${fmtSize(u.used)} (쓸 수 있는 한도 ${fmtSize(u.quota)})${u.persisted === true ? ' · 🔒 지켜지고 있어요' : (u.persisted === false ? ' · 폰 공간이 모자라면 지워질 수 있어요' : '')}`;
    persistBtn.style.display = u.persisted === false ? '' : 'none';
  };
  persistBtn.onclick = async () => {
    const ok = await db.requestPersist();
    toast(ok ? '🔒 저장 공간을 지키도록 허락받았어요' : '이 폰은 허락해 주지 않았어요. 완성한 영상은 갤러리에 저장해 두세요.', ok ? 'ok' : 'warn', 5000);
    showUsage();
  };
  showUsage();
  const info = h('p', { class: 'small muted', id: 'app-info' }, `AnimeMaker V2 ${VERSION}`);
  N.getAppInfo().then((a) => {
    info.textContent = `AnimeMaker V2 ${a.versionName || VERSION}${a.versionCode ? ` (빌드 ${a.versionCode})` : ''}${a.sdkInt ? ` · 안드로이드 SDK ${a.sdkInt}` : ''}${a.webViewVersion ? ` · WebView ${a.webViewVersion}` : ''}`;
  }).catch(() => {});
  return h('div', null,
    aiAppRow('text', '📝 이야기 쓰기를 부탁할 AI 앱', installed),
    aiAppRow('image', '🖼 그림 그리기를 부탁할 AI 앱', installed),
    h('div', { class: 'card' },
      h('h3', null, '🎞 영상 화질'),
      h('div', { class: 'chips', 'data-kind': 'quality' }, QUALITIES.map((q) => h('button', {
        class: `chip ${app.settings.quality === q ? 'on' : ''}`,
        'data-quality': q,
        onclick: () => { app.setSetting('quality', q); app.render(); },
      }, q))),
      h('p', { class: 'small muted' }, '화질이 높을수록 만드는 데 오래 걸리고 저장 공간도 더 써요.')),
    probeCard(),
    h('div', { class: 'card' },
      h('h3', null, '💾 저장 공간'),
      usageEl,
      persistBtn,
      h('p', { class: 'small' }, '작품은 이 앱 안에만 저장돼요. 앱을 지우면 함께 지워지니, 완성한 영상은 갤러리에 저장해 두세요.')),
    h('div', { class: 'card' },
      h('h3', null, '💳 요금 안내'),
      h('p', { class: 'small' }, '이 앱은 AI 회사의 유료 API 를 쓰지 않아요. 내 폰에 설치된 AI 앱으로 부탁 글을 보내고 결과를 받아 오기만 해요. 그래서 이미 내고 있는 구독 요금 안에서만 써요.')),
    h('div', { class: 'card' }, h('h3', null, 'ℹ️ 앱 정보'), info));
}

// ───────────────────────── 작품 자리 (C3 가 채운다) ─────────────────────────

async function projectView({ setTitle }) {
  const id = app.params.id;
  const p = await db.getProject(id);
  if (!p) return h('div', { class: 'card' }, h('h3', null, '작품을 찾을 수 없어요'), h('button', { class: 'btn', onclick: () => app.go('home') }, '처음으로'));
  setTitle(p.title || '새 영상');
  const [expecting, received] = await Promise.all([db.getExpecting(), listReceived()]);
  return h('div', null,
    h('div', { class: 'card', id: 'project-placeholder' },
      h('h3', null, p.title || '새 영상'),
      h('p', null, '🚧 여기에 "지금 할 일" 큰 버튼과 진행 막대가 들어와요.'),
      h('p', { class: 'small muted' }, `작품 번호 ${p.id}`)),
    expecting && expecting.projectId === id
      ? h('div', { class: 'card', id: 'expecting-card' }, h('b', null, '⏳ 답장을 기다리고 있어요'), h('p', { class: 'small' }, `${expecting.kind}${expecting.key ? ` · ${expecting.key}` : ''} — 앱이 꺼졌다 켜져도 공유로 받은 것은 여기로 와요.`))
      : null,
    received.length
      ? h('div', { class: 'card', id: 'received-card' }, h('b', null, `📥 받은 함 ${received.length}개`), h('ul', { class: 'small' }, received.map((r) => h('li', null, describeReceived(r)))))
      : null,
    h('details', { class: 'card fold', id: 'dev-fold' },
      h('summary', null, '개발용 도구'),
      h('div', { class: 'row' }, h('button', { class: 'btn', id: 'dev-job', onclick: () => runDevJob(id) }, '⏱ 일 지킴이 시험 (3초)')),
      p.devResult ? h('p', { class: 'small', id: 'dev-result' }, `마지막 시험 결과: ${p.devResult.steps}단계 · ${new Date(p.devResult.at).toLocaleTimeString('ko-KR')}`) : null));
}

// ───────────────────────── 공유 받기 · 오래 걸리는 일 · 오류 알림 ─────────────────────────

function onReceived(s) {
  if (s.duplicate) return;
  window.dispatchEvent(new CustomEvent('am:inbox', { detail: s })); // 화면(작품 화면 등)이 받은 함을 다시 읽을 수 있게
  toast(`📥 받았어요: ${s.label}${s.failed ? ` (읽지 못한 것 ${s.failed}개)` : ''}`, s.stored || s.text ? 'ok' : 'warn', 4500);
  // 기다리던 작품이 있으면 그 작품으로 (콜드 스타트로 켜졌을 때도 기다림은 저장소에 남아 있다). 일하는 중이면 방해하지 않는다.
  db.getExpecting().then((e) => {
    if (!e) return;
    if (jobs.isJobRunning() || busyCount() > 0) return;
    if (app.route === 'project' && app.params.id === e.projectId) app.render();
    else app.open(e.projectId).catch(() => {});
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
  N.onResume(() => { window.dispatchEvent(new CustomEvent('am:resume')); });
  try {
    await db.open();
  } catch (e) {
    document.getElementById('app').appendChild(h('main', null, h('div', { class: 'card' }, h('h3', null, '저장소를 열 수 없어요'), h('p', { class: 'small' }, (e && e.message) || String(e)), h('p', { class: 'small muted' }, '폰을 다시 켜거나 앱을 지우고 다시 설치해 보세요.'))));
    throw e;
  }
  app.settings = await restoreSettings({ db, apps: N.AI_APPS });
  db.ensurePersistOnce().catch(() => {}); // 처음 켰을 때 한 번: 저장 공간을 지켜 달라고 요청
  startReceiving({
    onReceived,
    onError: (e) => toast(e && e.quota ? '저장 공간이 부족해서 받은 것을 넣지 못했어요. 공간을 만든 뒤 앱을 다시 열어 주세요.' : `받은 것을 넣지 못했어요: ${(e && e.message) || e}`, 'err', 6000),
  });
  app.render();
}

// 일이 끝났을 때 그 작품 화면을 보고 있으면 다시 그린다 (화면을 떠났으면 아무것도 안 한다 — 결과는 이미 id 로 저장됐다)
window.addEventListener('am:job-done', (e) => {
  if (app.route === 'project' && app.params.id === e.detail.id) app.render();
});

// 시험·문제 확인용 (브라우저 콘솔과 e2e 가 쓴다). 화면이 보내는 신호: am:inbox(공유로 받음) · am:resume(앱으로 돌아옴) · am:job-done(일 끝남)
window.AnimeMaker = { app, db, N, jobs, ui, fonts, probe: probeApi, inbox: inboxApi, version: VERSION, devJob: runDevJob, ready: boot() };
