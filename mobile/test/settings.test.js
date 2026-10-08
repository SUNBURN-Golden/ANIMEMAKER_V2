// 앱 설정(settings.js): localStorage('am2.settings') 와 저장소 meta('settings') 를 오가는 규칙
import 'fake-indexeddb/auto';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert';
import * as db from '../src/db.js';
import { SETTINGS_KEY, DEFAULT_SETTINGS, normalizeSettings, loadSettings, saveSettings, restoreSettings } from '../src/settings.js';

const APPS = { chatgpt: {}, gemini: {}, grok: {}, claude: {} };
const memStorage = (init = {}) => { const m = { ...init }; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, m }; };

beforeEach(async () => { await db.deleteDatabase(); });

test('저장 키는 am2.settings, 기본값은 ChatGPT · 720p', () => {
  assert.strictEqual(SETTINGS_KEY, 'am2.settings');
  assert.deepStrictEqual({ ...DEFAULT_SETTINGS }, { textApp: 'chatgpt', imageApp: 'chatgpt', quality: '720p' });
});

test('normalizeSettings: 틀린 값은 기본값으로, 모르는 칸은 버린다', () => {
  assert.deepStrictEqual(normalizeSettings({ textApp: 'gemini', quality: '1080p', junk: 1 }, APPS), { textApp: 'gemini', imageApp: 'chatgpt', quality: '1080p' });
  assert.deepStrictEqual(normalizeSettings({ textApp: '없는앱', quality: '4k' }, APPS), { textApp: 'chatgpt', imageApp: 'chatgpt', quality: '720p' });
  assert.deepStrictEqual(normalizeSettings(null), { textApp: 'chatgpt', imageApp: 'chatgpt', quality: '720p' });
});

test('loadSettings: 깨진 글자·없는 저장소여도 기본값', () => {
  assert.deepStrictEqual(loadSettings(memStorage()), { ...DEFAULT_SETTINGS });
  assert.deepStrictEqual(loadSettings(memStorage({ [SETTINGS_KEY]: '{깨짐' })), { ...DEFAULT_SETTINGS });
  assert.deepStrictEqual(loadSettings(memStorage({ [SETTINGS_KEY]: '[1,2]' })), { ...DEFAULT_SETTINGS });
  assert.deepStrictEqual(loadSettings(null), { ...DEFAULT_SETTINGS });
  assert.strictEqual(loadSettings(memStorage({ [SETTINGS_KEY]: JSON.stringify({ imageApp: 'grok' }) }), APPS).imageApp, 'grok');
});

test('saveSettings: localStorage 에 저장하고 저장소 meta 에도 적는다 (저장소가 없어도 오류 없음)', async () => {
  const st = memStorage();
  saveSettings({ textApp: 'claude', imageApp: 'gemini', quality: '480p' }, { storage: st, db });
  assert.deepStrictEqual(JSON.parse(st.m[SETTINGS_KEY]), { textApp: 'claude', imageApp: 'gemini', quality: '480p' });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(await db.getMeta('settings'), { textApp: 'claude', imageApp: 'gemini', quality: '480p' });
  assert.doesNotThrow(() => saveSettings({ ...DEFAULT_SETTINGS }, { storage: { setItem() { throw new Error('꽉 참'); } } }));
});

test('restoreSettings: localStorage 가 비었으면 저장소에서 되살리고, 있으면 그대로 쓴다', async () => {
  await db.setMeta('settings', { textApp: 'grok', imageApp: 'grok', quality: '1080p' });
  const empty = memStorage();
  assert.deepStrictEqual(await restoreSettings({ storage: empty, db, apps: APPS }), { textApp: 'grok', imageApp: 'grok', quality: '1080p' });
  assert.deepStrictEqual(JSON.parse(empty.m[SETTINGS_KEY]), { textApp: 'grok', imageApp: 'grok', quality: '1080p' }, 'localStorage 도 채운다');
  const has = memStorage({ [SETTINGS_KEY]: JSON.stringify({ textApp: 'gemini' }) });
  assert.strictEqual((await restoreSettings({ storage: has, db, apps: APPS })).textApp, 'gemini');
  await db.deleteMeta('settings');
  assert.deepStrictEqual(await restoreSettings({ storage: memStorage(), db, apps: APPS }), { ...DEFAULT_SETTINGS });
});
