// 안드로이드 연결(native.js): AI 앱 표 ↔ 매니페스트, 플러그인 이름·메서드 ↔ Java, 받은 함 받기 규칙을 시험한다
import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as N from '../src/native.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const main = path.join(here, '..', 'android', 'app', 'src', 'main');
const read = (...p) => fs.readFileSync(path.join(main, ...p), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 가짜 플러그인: 부른 것을 기록하고, 대답을 미리 정해 둔다 */
function fakePlugin(answers = {}) {
  const calls = [];
  const listeners = new Map();
  const p = new Proxy({}, {
    get(_, name) {
      if (name === 'then') return undefined;
      if (name === 'addListener') return (ev, fn) => { listeners.set(ev, fn); return Promise.resolve({ remove: () => listeners.delete(ev) }); };
      return async (args) => {
        calls.push([name, args]);
        const a = answers[name];
        if (a instanceof Error) throw a;
        return typeof a === 'function' ? a(args) : a;
      };
    },
  });
  return { p, calls, listeners };
}

beforeEach(() => N._test.use({ native: true }));
after(() => N._test.use({ native: false }));

test('AI 앱 표: 네 앱의 패키지 이름과 쓰임새', () => {
  const pk = Object.fromEntries(Object.entries(N.AI_APPS).map(([id, a]) => [id, a.pkg]));
  assert.deepStrictEqual(pk, { chatgpt: 'com.openai.chatgpt', gemini: 'com.google.android.apps.bard', grok: 'ai.x.grok', claude: 'com.anthropic.claude' });
  for (const a of Object.values(N.AI_APPS)) {
    assert.ok(a.name && a.url.startsWith('https://') && Array.isArray(a.good) && a.good.length);
  }
  assert.deepStrictEqual(N.AI_APPS.claude.good, ['text'], 'Claude 는 글만');
  assert.ok(N.AI_APPS.chatgpt.good.includes('image'));
  assert.ok(!Object.values(N.AI_APPS).some((a) => a.good.includes('video')), 'V2 는 AI 영상을 부탁하지 않는다');
});

test('매니페스트 <queries> 패키지 목록 = AI 앱 표 (안 쓰는 패키지 없음)', () => {
  const manifest = read('AndroidManifest.xml');
  const q = manifest.match(/<queries>([\s\S]*?)<\/queries>/)[1];
  const pkgs = [...q.matchAll(/<package android:name="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(pkgs, Object.values(N.AI_APPS).map((a) => a.pkg).sort());
  assert.ok(!manifest.includes('com.openai.sora'));
});

test('플러그인 이름: JS registerPlugin 이름 = Java @CapacitorPlugin 이름 = AnimeMakerV2Native, MainActivity 가 등록', () => {
  assert.strictEqual(N.PLUGIN_NAME, 'AnimeMakerV2Native');
  const java = read('java', 'com', 'animemaker', 'v2', 'AnimeMakerV2NativePlugin.java');
  assert.match(java, /@CapacitorPlugin\(\s*name = "AnimeMakerV2Native"/);
  assert.match(read('java', 'com', 'animemaker', 'v2', 'MainActivity.java'), /registerPlugin\(AnimeMakerV2NativePlugin\.class\)/);
  assert.match(fs.readFileSync(path.join(here, '..', 'src', 'native.js'), 'utf8'), /registerPlugin\(PLUGIN_NAME\)/);
});

test('JS 가 부르는 플러그인 메서드는 전부 Java 에 @PluginMethod 로 있다 (그리고 안 쓰는 Java 메서드도 없다)', () => {
  const js = fs.readFileSync(path.join(here, '..', 'src', 'native.js'), 'utf8');
  const used = new Set([...js.matchAll(/\bNative\.([a-zA-Z]+)\(/g)].map((m) => m[1]).filter((n) => n !== 'addListener'));
  const java = read('java', 'com', 'animemaker', 'v2', 'AnimeMakerV2NativePlugin.java');
  const defined = new Set([...java.matchAll(/@PluginMethod\s+public void (\w+)\(PluginCall/g)].map((m) => m[1]));
  assert.deepStrictEqual([...used].sort(), [...defined].sort());
  for (const m of ['shareTo', 'saveToGallery', 'keepAwake', 'isInstalled', 'getAppInfo', 'takeInbox', 'ackInbox', 'startJobService', 'updateJobService', 'stopJobService', 'requestNotificationPermission']) {
    assert.ok(defined.has(m), `${m} 가 Java 에 있어야 한다`);
  }
  assert.ok(!defined.has('openApp') && !defined.has('takePendingShare'), '죽은 코드·단일 슬롯 공유는 없다');
  // 이벤트 이름도 같아야 한다: Java notifyListeners("shared", …) ↔ JS addListener('shared', …)
  assert.match(java, /notifyListeners\("shared", /);
  assert.match(js, /listen\(Native, 'shared', deliver\)/);
  assert.match(java, /IntentCompat\.getParcelableExtra\(intent, Intent\.EXTRA_STREAM, Uri\.class\)/);
  assert.ok(!/\bintent\.getParcelable(Array)?(List)?Extra\(/.test(java), '옛(deprecated) getParcelableExtra 를 쓰지 않는다');
});

test('getAppInfo: 안드로이드면 플러그인 값, 아니면 웹 값 (WebView 버전은 UserAgent 에서 보충)', async () => {
  const f = fakePlugin({ getAppInfo: { versionName: '2.0.0', versionCode: 7, sdkInt: 34, webViewVersion: '130.0.6723.58' } });
  N._test.use({ plugin: f.p });
  assert.deepStrictEqual(await N.getAppInfo(), { versionName: '2.0.0', versionCode: 7, sdkInt: 34, webViewVersion: '130.0.6723.58' });
  N._test.use({ native: false });
  const web = await N.getAppInfo();
  assert.strictEqual(web.web, true);
  assert.strictEqual(web.versionCode, 0);
  assert.strictEqual(typeof web.versionName, 'string');
  // 플러그인이 실패하면 웹 값
  N._test.use({ native: true, plugin: fakePlugin({ getAppInfo: new Error('x') }).p });
  assert.strictEqual((await N.getAppInfo()).web, true);
});

test('isInstalled · installedApps', async () => {
  const f = fakePlugin({ isInstalled: ({ pkg }) => ({ installed: pkg === 'com.openai.chatgpt' }) });
  N._test.use({ plugin: f.p });
  assert.strictEqual(await N.isInstalled('chatgpt'), true);
  assert.strictEqual(await N.isInstalled('gemini'), false);
  assert.strictEqual(await N.isInstalled('없는앱'), false);
  assert.deepStrictEqual(await N.installedApps(), { chatgpt: true, gemini: false, grok: false, claude: false });
  N._test.use({ native: false });
  assert.deepStrictEqual(await N.installedApps(), { chatgpt: false, gemini: false, grok: false, claude: false });
});

test('sendToApp: 앱 패키지와 글을 shareTo 로 넘긴다 (파일 없이)', async () => {
  const f = fakePlugin({ shareTo: { direct: true } });
  N._test.use({ plugin: f.p });
  assert.deepStrictEqual(await N.sendToApp('gemini', { text: '안녕' }), { direct: true });
  assert.deepStrictEqual(f.calls, [['shareTo', { pkg: 'com.google.android.apps.bard', text: '안녕', files: [] }]]);
});

test('받은 함: takeInbox / ackInbox 는 플러그인 모양을 그대로 쓴다', async () => {
  const entries = [{ id: 'a', receivedAt: 1, items: [], text: 'x' }];
  const f = fakePlugin({ takeInbox: { entries }, ackInbox: { removed: 2 } });
  N._test.use({ plugin: f.p });
  assert.deepStrictEqual(await N.takeInbox(), entries);
  assert.strictEqual(await N.ackInbox(['a', 'b']), 2);
  assert.deepStrictEqual(f.calls[1], ['ackInbox', { ids: ['a', 'b'] }]);
  assert.strictEqual(await N.ackInbox([]), 0, '빈 목록이면 부르지 않는다');
  assert.strictEqual(f.calls.length, 2);
  N._test.use({ plugin: fakePlugin({ takeInbox: {} }).p });
  assert.deepStrictEqual(await N.takeInbox(), []);
});

test('onShared: 남아 있던 것을 먼저, 새 이벤트와 resume 때 놓친 것도, 같은 id 는 한 번만, 못 받은(false) 것은 다시', async () => {
  const inbox = [{ id: 'e1', items: [], text: 'a' }];
  const f = fakePlugin({ takeInbox: () => ({ entries: [...inbox] }) });
  const appF = fakePlugin();
  N._test.use({ plugin: f.p, app: appF.p });
  const got = [];
  let failOnce = true;
  const off = N.onShared((e) => { got.push(e.id); if (e.id === 'e3' && failOnce) { failOnce = false; return false; } return true; });
  await sleep(10);
  assert.deepStrictEqual(got, ['e1'], '앱이 꺼져 있다 켜졌을 때 남아 있던 것');
  f.listeners.get('shared')({ id: 'e1' }); // 같은 항목이 이벤트로도 오면 무시
  f.listeners.get('shared')({ id: 'e2' });
  await sleep(5);
  assert.deepStrictEqual(got, ['e1', 'e2']);
  inbox.push({ id: 'e2' }, { id: 'e3' });
  appF.listeners.get('resume')(); // 앱으로 돌아왔을 때 놓친 것
  await sleep(10);
  assert.deepStrictEqual(got, ['e1', 'e2', 'e3']);
  appF.listeners.get('resume')(); // e3 는 못 받았다(false) → 다시 준다
  await sleep(10);
  assert.deepStrictEqual(got, ['e1', 'e2', 'e3', 'e3']);
  appF.listeners.get('resume')();
  await sleep(10);
  assert.deepStrictEqual(got, ['e1', 'e2', 'e3', 'e3'], '받은 뒤에는 더 주지 않는다');
  off();
  assert.ok(!f.listeners.has('shared') && !appF.listeners.has('resume'), '끄면 이벤트도 끊긴다');
  N._test.use({ native: false });
  const none = [];
  N.onShared((e) => none.push(e))();
  assert.deepStrictEqual(none, []);
});

test('오래 걸리는 일 서비스: 안드로이드가 아니면 아무 일도 안 한다 / 진행은 0~1 → 0~100', async () => {
  const f = fakePlugin({ startJobService: { started: true, notifications: false }, requestNotificationPermission: { granted: true } });
  N._test.use({ plugin: f.p });
  assert.deepStrictEqual(await N.startJobService({ title: '영상 만드는 중', text: '시작' }), { started: true, notifications: false });
  await N.updateJobService({ text: '절반', progress: 0.5 });
  await N.updateJobService({ text: '모름' });
  await N.updateJobService({ text: '넘침', progress: 7 });
  await N.stopJobService();
  assert.deepStrictEqual(await N.requestNotificationPermission(), { granted: true });
  assert.deepStrictEqual(f.calls.map((c) => c[0]), ['startJobService', 'updateJobService', 'updateJobService', 'updateJobService', 'stopJobService', 'requestNotificationPermission']);
  assert.deepStrictEqual(f.calls[0][1], { title: '영상 만드는 중', text: '시작' });
  assert.deepStrictEqual(f.calls[1][1], { text: '절반', progress: 50 });
  assert.deepStrictEqual(f.calls[2][1], { text: '모름' });
  assert.deepStrictEqual(f.calls[3][1], { text: '넘침', progress: 100 });
  // 플러그인 오류는 일을 막지 않는다
  const bad = fakePlugin({ startJobService: new Error('x'), requestNotificationPermission: new Error('y') });
  N._test.use({ plugin: bad.p });
  assert.deepStrictEqual(await N.startJobService(), { started: false, notifications: false });
  assert.deepStrictEqual(await N.requestNotificationPermission(), { granted: false });
  await N.updateJobService({ text: 'x' });
  await N.stopJobService();
  N._test.use({ native: false });
  assert.deepStrictEqual(await N.startJobService(), { started: false, notifications: false });
});

test('시스템 바 글씨 색: 상태줄은 흰 글씨(DARK), 내비게이션 줄은 어두운 글씨(LIGHT) — 오래된 WebView(140 미만)는 아래 줄도 흰 글씨', async () => {
  const calls = [];
  N._test.use({ bars: { setStyle: async (o) => { calls.push(o); } } });
  await N.applySystemBars({ webViewVersion: '141.0.7390.122' });
  assert.deepStrictEqual(calls, [{ style: 'DARK', bar: 'StatusBar' }, { style: 'LIGHT', bar: 'NavigationBar' }]);
  calls.length = 0;
  await N.applySystemBars({ webViewVersion: '120.0.6099.230' });
  assert.deepStrictEqual(calls, [{ style: 'DARK', bar: 'StatusBar' }, { style: 'DARK', bar: 'NavigationBar' }]);
  calls.length = 0;
  await N.applySystemBars({}); // 버전을 모르면 새 WebView 로 본다
  assert.strictEqual(calls[1].style, 'LIGHT');
  N._test.use({ bars: { setStyle: async () => { throw new Error('x'); } } });
  await N.applySystemBars({ webViewVersion: '141.0.0.0' }); // 오류가 나도 앱은 계속
  N._test.use({ native: false });
  calls.length = 0;
  N._test.use({ bars: { setStyle: async (o) => { calls.push(o); } } });
  await N.applySystemBars({});
  assert.deepStrictEqual(calls, [], '안드로이드가 아니면 아무 일도 안 한다');
});

test('sharedItemToBlob: 웹 주소로 읽고, 안 되면 Filesystem 으로 캐시 폴더에서 읽는다 (그것도 안 되면 알기 쉬운 오류)', async () => {
  const realFetch = globalThis.fetch;
  const item = { path: '/data/user/0/com.animemaker.v2/cache/shared/123_a.png', name: 'a.png', mime: 'image/png' };
  try {
    globalThis.fetch = async () => new Response(new Blob(['웹'], { type: 'application/octet-stream' }), { status: 200 });
    const viaWeb = await N.sharedItemToBlob(item);
    assert.strictEqual(viaWeb.type, 'image/png', '받은 종류(mime)를 붙인다');
    assert.strictEqual(await viaWeb.text(), '웹');
    // 웹 주소가 실패하면 Filesystem 으로
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    const calls = [];
    N._test.use({ fs: { readFile: async (o) => { calls.push(o); return { data: Buffer.from('파일').toString('base64') }; } } });
    const viaFs = await N.sharedItemToBlob(item);
    assert.strictEqual(await viaFs.text(), '파일');
    assert.strictEqual(viaFs.type, 'image/png');
    assert.deepStrictEqual(calls, [{ path: 'shared/123_a.png', directory: 'CACHE' }]);
    // 응답이 404 여도 같은 길
    globalThis.fetch = async () => new Response('', { status: 404 });
    assert.strictEqual(await (await N.sharedItemToBlob(item)).text(), '파일');
    // 둘 다 안 되면 오류
    N._test.use({ fs: { readFile: async () => { throw new Error('없음'); } } });
    await assert.rejects(() => N.sharedItemToBlob(item), /받은 파일을 읽지 못했어요 \(a\.png\)/);
    await assert.rejects(() => N.sharedItemToBlob({ path: '/etc/passwd', name: 'x' }), /읽지 못했어요/, '캐시 밖 경로는 대체 길도 없다');
  } finally {
    globalThis.fetch = realFetch;
  }
});
