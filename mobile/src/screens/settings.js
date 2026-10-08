// ⚙ 설정: 어떤 구독이 있나요? · 내 폰 점검 · 저장 공간 · 고급 (알림 · 화질 · AI 앱 따로 고르기) · 도움말 · 앱 정보 · 글꼴/라이선스
import { h, clear, toast, bottomSheet, fmtSize } from '../ui.js';
import * as db from '../db.js';
import { probeCard } from '../probe-card.js';
import { QUALITIES } from '../settings.js';
import { ensureNotify } from './handoff.js';
import { buzz } from './projects-util.js';

const VERSION = typeof __AM_VERSION__ !== 'undefined' ? __AM_VERSION__ : 'dev';
const SUB_NOTE = { chatgpt: '글과 그림', gemini: '글과 그림', grok: '글과 그림', claude: '글만 (그림은 다른 앱에)' };
const QUALITY_LABEL = { '480p': '가볍게 480p', '720p': '보통 720p (추천)', '1080p': '선명하게 1080p' };
const FONTS = ['Pretendard', 'Jua', 'Do Hyeon', 'Gaegu', 'Black Han Sans', 'Nanum Pen Script'];

/** 설치 안 된 AI 앱: 스토어 쪽지로 (앱 안에서는 외부 앱으로 열려요) */
export function openStore(app, appId) {
  const a = app.native.AI_APPS[appId];
  if (!a) return;
  const url = app.native.isNative ? `https://play.google.com/store/apps/details?id=${a.pkg}` : a.url;
  window.open(url, '_blank');
}

/** @returns {Promise<{el:HTMLElement, destroy:()=>void}>} */
export async function settingsScreen(app, params = {}) {
  const el = h('div', { class: 'settings' }, h('h1', { class: 'page-title' }, '⚙ 설정'));
  app.installed = await app.native.installedApps().catch(() => app.installed || {});

  // ── 어떤 구독이 있나요? ──
  const subs = h('div', { class: 'card', id: 'card-subs' });
  function paintSubs() {
    clear(subs);
    const connected = !!app.prefs.connected;
    subs.appendChild(h('h3', null, '어떤 구독이 있나요?'));
    subs.appendChild(h('p', { class: 'small muted' }, '이미 쓰고 있는 AI 앱을 골라 주세요. 그림과 글을 그 앱에 부탁해요. 추가 요금은 없어요.'));
    const grid = h('div', { class: 'sub-grid' });
    for (const [id, a] of Object.entries(app.native.AI_APPS)) {
      const on = connected && (app.settings.textApp === id || app.settings.imageApp === id);
      const inst = app.installed && app.installed[id];
      const status = !app.native.isNative ? '폰에서 쓸 수 있어요' : (inst ? '✓ 설치돼 있어요' : '앱을 설치해 주세요');
      grid.appendChild(h('div', { class: `sub-card${on ? ' on' : ''}`, 'data-app': id },
        h('div', { class: 'sub-name' }, a.name, on ? h('span', { class: 'tag' }, '쓰는 중') : null),
        h('div', { class: 'small muted' }, SUB_NOTE[id]),
        h('div', { class: `small ${inst ? 'ok-text' : 'muted'}` }, status),
        h('div', { class: 'row tight' },
          h('button', { class: `btn small${on ? '' : ' primary'}`, 'data-act': 'use', onclick: async () => {
            buzz();
            if (a.good.includes('text')) app.setSetting('textApp', id);
            if (a.good.includes('image')) app.setSetting('imageApp', id);
            await app.setPref('connected', true);
            toast(`${a.name} 로 부탁할게요`, 'ok');
            paintSubs();
          } }, on ? '다시 고르기' : '이 앱 쓰기'),
          app.native.isNative && !inst ? h('button', { class: 'btn small', 'data-act': 'install', onclick: () => openStore(app, id) }, '⬇ 설치하기') : null)));
    }
    subs.appendChild(grid);
    subs.appendChild(h('button', { class: `btn big${connected ? '' : ' on'}`, id: 'btn-none', 'aria-pressed': !connected, onclick: async () => { buzz(); await app.setPref('connected', false); toast('연습 모드로 바꿨어요 (가짜 그림)', 'ok'); paintSubs(); } },
      connected ? '아직 없어요 → 연습 모드로 해요' : '✓ 연습 모드로 쓰는 중이에요 (가짜 그림)'));
  }
  paintSubs();
  el.appendChild(subs);

  // ── 내 폰 점검 ──
  el.appendChild(probeCard());

  // ── 저장 공간 ──
  const usageEl = h('p', { class: 'small muted', id: 'usage-text' }, '저장 공간을 확인하는 중…');
  const persistBtn = h('button', { class: 'btn small', id: 'btn-persist', style: { display: 'none' } }, '🔒 더 안전하게 저장하기');
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
  el.appendChild(h('div', { class: 'card', id: 'card-storage' }, h('h3', null, '💾 저장 공간'), usageEl, persistBtn,
    h('p', { class: 'small' }, '영상은 이 앱 안에만 저장돼요. 앱을 지우면 함께 지워지니, 완성한 영상은 갤러리에 저장해 두세요.')));

  // ── 고급 ──
  const chipRow = (kind) => {
    const row = h('div', { class: 'chips', 'data-kind': kind });
    const paint = () => {
      clear(row);
      for (const [id, a] of Object.entries(app.native.AI_APPS)) {
        if (!a.good.includes(kind)) continue;
        row.appendChild(h('button', { class: `chip${app.settings[`${kind}App`] === id ? ' on' : ''}`, 'data-app': id, onclick: () => { app.setSetting(`${kind}App`, id); paint(); paintSubs(); } }, a.name));
      }
    };
    paint();
    return row;
  };
  const qualityRow = h('div', { class: 'chips', 'data-kind': 'quality' });
  const paintQuality = () => {
    clear(qualityRow);
    for (const q of QUALITIES) qualityRow.appendChild(h('button', { class: `chip${app.settings.quality === q ? ' on' : ''}`, 'data-quality': q, onclick: () => { app.setSetting('quality', q); paintQuality(); } }, QUALITY_LABEL[q] || q));
  };
  paintQuality();
  const notifyText = h('p', { class: 'small', id: 'notify-state' });
  const paintNotify = () => { notifyText.textContent = { on: '🔔 알림이 켜져 있어요. 화면을 꺼도 계속 만들어요.', denied: '🔕 알림이 꺼져 있어요. 만드는 동안 화면을 켜 둬 주세요.', screen: '화면을 켜 둔 채로 만들기로 했어요.' }[app.prefs.notify] || '아직 정하지 않았어요. 처음 영상을 만들 때 물어봐요.'; };
  paintNotify();
  el.appendChild(h('details', { class: 'card fold', id: 'dev-adv', open: params.focus === 'adv' },
    h('summary', null, '⚙ 고급 설정'),
    h('div', { class: 'lbl' }, '글을 부탁할 AI 앱'), chipRow('text'),
    h('div', { class: 'lbl' }, '그림을 부탁할 AI 앱'), chipRow('image'),
    h('div', { class: 'lbl' }, '🎞 영상 화질'), qualityRow,
    h('p', { class: 'small muted' }, '화질이 높을수록 만드는 데 오래 걸리고 저장 공간도 더 써요. 폰이 느리면 [가볍게] 로 해 보세요.'),
    h('div', { class: 'lbl' }, '🔔 알림'), notifyText,
    h('button', { class: 'btn small', id: 'btn-notify', onclick: async () => { app.prefs.notify = null; await app.setPref('notify', null); await ensureNotify(app); paintNotify(); } }, '알림 다시 설정하기')));

  // ── 도움말 · 앱 정보 · 라이선스 ──
  const info = h('p', { class: 'small muted', id: 'app-info' }, `AnimeMaker V2 ${VERSION}`);
  app.native.getAppInfo().then((a) => {
    info.textContent = `AnimeMaker V2 ${a.versionName || VERSION}${a.versionCode ? ` (빌드 ${a.versionCode})` : ''}${a.sdkInt ? ` · 안드로이드 SDK ${a.sdkInt}` : ''}${a.webViewVersion ? ` · WebView ${a.webViewVersion}` : ''}`;
  }).catch(() => {});
  el.appendChild(h('div', { class: 'card', id: 'card-about' },
    h('button', { class: 'btn', id: 'btn-help', onclick: () => app.go('help') }, '❓ 도움말'),
    h('button', { class: 'btn', id: 'btn-licenses', onclick: () => bottomSheet({
      title: '오픈소스 글꼴 · 라이선스',
      body: h('div', null,
        h('p', { class: 'small' }, `자막에 쓰는 글꼴은 모두 SIL Open Font License 1.1 (오픈소스) 예요: ${FONTS.join(' · ')}. 글꼴 파일은 이 앱 안에 들어 있어서 인터넷이 없어도 돼요.`),
        h('p', { class: 'small' }, '이 앱은 오픈소스 부품(Capacitor, Mediabunny 등)을 써요. 자세한 내용은 앱 안 licenses 파일에 있어요.'),
        h('p', { class: 'small muted' }, 'AI 로 만든 영상이라는 표시(메타데이터)가 영상 파일에 들어가요.')),
    }) }, '📜 오픈소스 글꼴 · 라이선스'),
    info,
    h('p', { class: 'note' }, '💳 AI 는 이미 구독 중인 ChatGPT · Gemini · Grok · Claude 앱 안에서만 써요. 이 앱은 따로 돈을 받거나 API 키를 쓰지 않아요.')));

  if (params.focus === 'subs') setTimeout(() => subs.scrollIntoView({ block: 'start' }), 50);
  return { el, destroy() {} };
}
