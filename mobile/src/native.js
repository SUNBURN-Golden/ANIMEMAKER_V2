// 안드로이드 기능 연결 (AnimeMakerV2Native 플러그인). 컴퓨터 브라우저에서 열면 비슷한 웹 기능으로 대신한다.
// 플러그인 이름은 Java 의 @CapacitorPlugin(name = "AnimeMakerV2Native") 와 같아야 한다.
import { Capacitor, registerPlugin, SystemBars, SystemBarsStyle, SystemBarType } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Clipboard } from '@capacitor/clipboard';
import { App } from '@capacitor/app';

export const PLUGIN_NAME = 'AnimeMakerV2Native';
let Native = registerPlugin(PLUGIN_NAME);
let AppPlugin = App;
let BarsPlugin = SystemBars;
let FsPlugin = Filesystem;
export let isNative = Capacitor.isNativePlatform();

/**
 * 구독 중인 AI 앱들 (요금은 각 앱의 구독 안에서만).
 * 이 표가 기준이다: android/app/src/main/AndroidManifest.xml 의 <queries> 패키지 목록이 pkg 들과 같아야 한다 (test/native.test.js 가 확인).
 * 앱을 더하거나 패키지 이름이 바뀌면 이 표와 매니페스트를 같이 고친다.
 */
export const AI_APPS = {
  chatgpt: { name: 'ChatGPT', pkg: 'com.openai.chatgpt', url: 'https://chatgpt.com/', good: ['text', 'image'] },
  gemini: { name: 'Gemini', pkg: 'com.google.android.apps.bard', url: 'https://gemini.google.com/app', good: ['text', 'image'] },
  grok: { name: 'Grok', pkg: 'ai.x.grok', url: 'https://grok.com/', good: ['text', 'image'] },
  claude: { name: 'Claude', pkg: 'com.anthropic.claude', url: 'https://claude.ai/new', good: ['text'] },
};

/** 시험용: 플러그인(우리 것·App)과 '안드로이드 안인가' 를 바꿔 끼운다 */
export const _test = {
  use({ plugin, native, app, bars, fs } = {}) {
    if (plugin !== undefined) Native = plugin;
    if (native !== undefined) isNative = native;
    if (app !== undefined) AppPlugin = app;
    if (bars !== undefined) BarsPlugin = bars;
    if (fs !== undefined) FsPlugin = fs;
  },
};

// ───────────────────────── 클립보드 ─────────────────────────

export async function copyText(text) {
  try {
    if (isNative) await Clipboard.write({ string: text });
    else await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    return false;
  }
}

export async function readClipboard() {
  try {
    if (isNative) return (await Clipboard.read()).value || '';
    return await navigator.clipboard.readText();
  } catch (_) {
    return '';
  }
}

// ───────────────────────── 앱 정보 ─────────────────────────

function chromeVersionFromUA(ua = typeof navigator !== 'undefined' ? navigator.userAgent : '') {
  const m = /Chrome\/([\d.]+)/.exec(ua || '');
  return m ? m[1] : '';
}

/**
 * 앱·폰 정보 (능력 점검에 쓴다)
 * @returns {Promise<{versionName:string, versionCode:number, sdkInt:number, webViewVersion:string, web?:boolean}>}
 */
export async function getAppInfo() {
  const web = {
    versionName: typeof __AM_VERSION__ !== 'undefined' ? __AM_VERSION__ : 'dev',
    versionCode: 0,
    sdkInt: 0,
    webViewVersion: chromeVersionFromUA(),
    web: true,
  };
  if (!isNative) return web;
  try {
    const r = await Native.getAppInfo();
    return { ...r, webViewVersion: r.webViewVersion || chromeVersionFromUA() };
  } catch (_) {
    return web;
  }
}

/** AI 앱이 폰에 깔려 있나 */
export async function isInstalled(appId) {
  const app = AI_APPS[appId];
  if (!app || !isNative) return false;
  try { return !!(await Native.isInstalled({ pkg: app.pkg })).installed; } catch (_) { return false; }
}

/** { chatgpt: true, gemini: false, … } */
export async function installedApps() {
  const ids = Object.keys(AI_APPS);
  const flags = await Promise.all(ids.map((id) => isInstalled(id)));
  return Object.fromEntries(ids.map((id, i) => [id, flags[i]]));
}

// ───────────────────────── 보내기 ─────────────────────────

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Blob → 앱 캐시 폴더(am/)의 파일 (조각조각 써서 큰 영상도 메모리를 덜 쓴다). 실제 경로를 돌려준다. */
export async function blobToCacheFile(blob, name) {
  const path = `am/${name}`;
  const CHUNK = 3 * 1024 * 1024;
  for (let off = 0; off < blob.size || off === 0; off += CHUNK) {
    const data = await blobToBase64(blob.slice(off, off + CHUNK));
    if (off === 0) await Filesystem.writeFile({ path, data, directory: Directory.Cache, recursive: true });
    else await Filesystem.appendFile({ path, data, directory: Directory.Cache });
    if (blob.size === 0) break;
  }
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}

/**
 * AI 앱으로 프롬프트(+참고 그림 여러 장)를 보낸다. 글은 클립보드에도 복사해 둔다(앱이 글을 안 받는 경우 붙여넣기용).
 * @param {string} appId AI_APPS 의 키
 * @param {{text?:string, files?:{blob:Blob, name:string}[]}} o
 * @returns {Promise<{direct:boolean, web?:boolean}>}
 */
export async function sendToApp(appId, { text = '', files = [] } = {}) {
  const app = AI_APPS[appId] || {};
  await copyText(text);
  if (!isNative) {
    window.open(app.url || 'about:blank', '_blank');
    return { direct: false, web: true };
  }
  const paths = [];
  for (const f of files) if (f && f.blob) paths.push(await blobToCacheFile(f.blob, f.name));
  return Native.shareTo({ pkg: app.pkg || '', text, files: paths });
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

function cacheName(name) {
  return `out/${Date.now()}_${name.replace(/[^\w.\-가-힣 ]/g, '_')}`;
}

/** 완성 영상·그림을 갤러리(동영상|사진/AnimeMaker V2)에 저장. 오래된 안드로이드는 '공유' 창으로 대신. */
export async function saveToGallery(blob, name) {
  if (!isNative) { download(blob, name); return { saved: true, folder: '다운로드' }; }
  const path = await blobToCacheFile(blob, cacheName(name));
  const r = await Native.saveToGallery({ path, name });
  if (!r.saved) {
    await Native.shareTo({ pkg: '', text: '', files: [path] });
    return { saved: false, shared: true };
  }
  return r;
}

/** 파일 하나를 다른 앱으로 공유 (유튜브·인스타·카톡 등) */
export async function shareFile(blob, name, text = '') {
  if (!isNative) { download(blob, name); return; }
  const path = await blobToCacheFile(blob, cacheName(name));
  await Native.shareTo({ pkg: '', text, files: [path] });
}

/** 파일 여러 개를 한 번에 공유 (캐릭터 파일 + 설명 등) */
export async function shareFiles(files, text = '') {
  if (!isNative) { for (const f of files) download(f.blob, f.name); return; }
  const paths = [];
  for (const f of files) paths.push(await blobToCacheFile(f.blob, cacheName(f.name)));
  await Native.shareTo({ pkg: '', text, files: paths });
}

// ───────────────────────── 받은 함 (다른 앱에서 '공유 → AnimeMaker V2') ─────────────────────────
// 받은 것은 네이티브가 cache/shared 에 복사하고 inbox.json 에 적어 둔다. 웹이 앱 저장소에 넣고 ackInbox 로 알려 줄 때까지 남는다.
// entry = { id, receivedAt, items:[{path,name,mime,size}], text, failed? }

/** 아직 확인(ack)하지 않은 받은 함 항목 전부 */
export async function takeInbox() {
  if (!isNative) return [];
  const r = await Native.takeInbox();
  return Array.isArray(r && r.entries) ? r.entries : [];
}

/** 앱 저장소에 넣은 항목을 받은 함에서 지운다 (캐시 복사본도 함께). 지운 개수를 돌려준다. */
export async function ackInbox(ids) {
  if (!isNative || !ids || !ids.length) return 0;
  const r = await Native.ackInbox({ ids: [...ids] });
  return (r && r.removed) || 0;
}

/**
 * 공유로 들어온 항목을 받는다. 지금 남아 있는 것(앱이 꺼져 있다 공유로 켜진 경우)을 먼저 주고, 이후 새로 오는 것과
 * 앱으로 돌아올 때(resume) 놓친 것도 준다. 같은 항목(id)은 한 번만 주고, cb 가 false 를 돌려주면(못 받음) 다음 resume 에 다시 준다.
 * 받은 쪽이 저장한 뒤 ackInbox 를 부를 책임이 있다.
 * @param {(entry:object)=>any} cb
 * @returns {()=>void} 받기를 끄는 함수
 */
export function onShared(cb) {
  if (!isNative) return () => {};
  const seen = new Set();
  let off = false;
  const deliver = (entry) => {
    if (off || !entry || !entry.id || seen.has(entry.id)) return;
    seen.add(entry.id);
    // cb 가 false 를 돌려주거나 오류를 내면 '못 받았다' 로 보고, 다음에 앱으로 돌아올 때(resume) 같은 항목을 다시 준다.
    // (오류는 그대로 다시 던져서 전역 오류 알림으로 간다)
    Promise.resolve().then(() => cb(entry)).then((r) => { if (r === false) seen.delete(entry.id); }, (e) => { seen.delete(entry.id); throw e; });
  };
  const drain = () => takeInbox().then((list) => list.forEach(deliver)).catch(() => {});
  const handles = [];
  const listen = (plugin, name, fn) => {
    try {
      Promise.resolve(plugin.addListener(name, fn)).then((hd) => { if (off) hd.remove(); else handles.push(hd); }).catch(() => {});
    } catch (_) { /* 이 신호는 못 받아도 takeInbox 로 받는다 */ }
  };
  listen(Native, 'shared', deliver);
  listen(AppPlugin, 'resume', drain);
  drain();
  return () => { off = true; handles.forEach((hd) => { try { hd.remove(); } catch (_) { /* 이미 꺼짐 */ } }); };
}

function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: type || '' });
}

/**
 * 공유로 받은 파일(캐시 경로) → Blob.
 * 먼저 웹 주소(convertFileSrc)로 읽고, 안 되면 Filesystem 플러그인으로 캐시 폴더에서 읽는다 (큰 파일은 메모리를 더 쓰는 대체 길).
 */
export async function sharedItemToBlob(item) {
  let blob = null;
  try {
    const res = await fetch(Capacitor.convertFileSrc(item.path));
    if (res.ok) blob = await res.blob();
  } catch (_) { /* 아래 대체 길로 */ }
  if (!blob) {
    const m = /\/cache\/(.+)$/.exec(item.path || '');
    if (!m) throw new Error(`받은 파일을 읽지 못했어요 (${item.name || item.path})`);
    try {
      const r = await FsPlugin.readFile({ path: m[1], directory: Directory.Cache });
      blob = typeof r.data === 'string' ? base64ToBlob(r.data, item.mime) : r.data;
    } catch (_) {
      throw new Error(`받은 파일을 읽지 못했어요 (${item.name || item.path})`);
    }
  }
  return item.mime && blob.type !== item.mime ? new Blob([blob], { type: item.mime }) : blob;
}

// ───────────────────────── 화면 켜 두기 · 오래 걸리는 일 서비스 ─────────────────────────

export async function keepAwake(on) {
  if (!isNative) return;
  try { await Native.keepAwake({ on }); } catch (_) { /* noop */ }
}

/**
 * 안드로이드 13+ 알림 권한 묻기 (왜 필요한지 설명 화면은 호출하는 쪽 몫). 거절해도 일은 돌고 알림줄만 안 보인다.
 * @returns {Promise<{granted:boolean}>}
 */
export async function requestNotificationPermission() {
  if (!isNative) return { granted: typeof Notification !== 'undefined' && Notification.permission === 'granted' };
  try {
    const r = await Native.requestNotificationPermission();
    return { granted: !!(r && r.granted) };
  } catch (_) {
    return { granted: false };
  }
}

/**
 * 알림줄 진행 서비스 켜기 (영상 만들기 등 몇 분 걸리는 일 동안 앱이 멈추지 않게).
 * @returns {Promise<{started:boolean, notifications:boolean}>} started=false 면 서비스 없이 계속한다 (예: 앱이 뒤에 있을 때)
 */
export async function startJobService({ title = 'AnimeMaker V2', text = '' } = {}) {
  if (!isNative) return { started: false, notifications: false };
  try {
    const r = await Native.startJobService({ title, text });
    return { started: !!(r && r.started), notifications: !!(r && r.notifications) };
  } catch (_) {
    return { started: false, notifications: false };
  }
}

/** 알림줄 글과 진행(0~1, 생략하면 빙글빙글) 바꾸기 */
export async function updateJobService({ text, progress } = {}) {
  if (!isNative) return;
  try {
    await Native.updateJobService({ text: text || '', ...(typeof progress === 'number' ? { progress: Math.round(Math.max(0, Math.min(1, progress)) * 100) } : {}) });
  } catch (_) { /* 알림줄은 없어도 일은 된다 */ }
}

export async function stopJobService() {
  if (!isNative) return;
  try { await Native.stopJobService(); } catch (_) { /* noop */ }
}

// ───────────────────────── 시스템 바(상태줄·내비게이션 줄) 글씨 색 ─────────────────────────

/**
 * 상태줄은 하늘색→보라 머리글 위라서 흰 글씨(Dark), 아래 내비게이션 줄은 밝은 화면 위라서 어두운 글씨(Light).
 * 오래된 WebView(140 미만)는 시스템 바 자리를 따로 띄우고 그 뒤를 창 배경색(인디고)으로 채우므로 아래 줄도 흰 글씨로 한다.
 * @param {{webViewVersion?:string}} [o]
 */
export async function applySystemBars({ webViewVersion = '' } = {}) {
  if (!isNative) return;
  const major = Number.parseInt(webViewVersion, 10);
  const padded = Number.isFinite(major) && major < 140;
  try {
    await BarsPlugin.setStyle({ style: SystemBarsStyle.Dark, bar: SystemBarType.StatusBar });
    await BarsPlugin.setStyle({ style: padded ? SystemBarsStyle.Dark : SystemBarsStyle.Light, bar: SystemBarType.NavigationBar });
  } catch (_) { /* 글씨 색만 기본값으로 남는다 */ }
}

// ───────────────────────── 앱 신호 ─────────────────────────

export function onBackButton(cb) {
  if (!isNative) return;
  AppPlugin.addListener('backButton', cb);
}

export function onResume(cb) {
  if (!isNative) return;
  AppPlugin.addListener('resume', cb);
}

export function exitApp() {
  if (isNative) AppPlugin.exitApp();
}
