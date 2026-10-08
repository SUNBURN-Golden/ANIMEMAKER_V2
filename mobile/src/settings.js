// 앱 설정: 어느 AI 앱에 부탁할지, 화질 …
// localStorage('am2.settings') 에 바로 읽을 수 있게 두고, 같은 내용을 저장소 meta('settings') 에도 적어 둔다.
// (둘 중 하나가 지워져도 다른 쪽에서 되살린다)

export const SETTINGS_KEY = 'am2.settings';
export const DEFAULT_SETTINGS = Object.freeze({ textApp: 'chatgpt', imageApp: 'chatgpt', quality: '720p' });
export const QUALITIES = Object.freeze(['480p', '720p', '1080p']);

function parse(raw) {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (_) {
    return {};
  }
}

/** 알려진 칸만 남기고 틀린 값은 기본값으로 */
export function normalizeSettings(raw, apps = null) {
  const s = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  const out = { textApp: s.textApp, imageApp: s.imageApp, quality: s.quality };
  if (apps) {
    if (!apps[out.textApp]) out.textApp = DEFAULT_SETTINGS.textApp;
    if (!apps[out.imageApp]) out.imageApp = DEFAULT_SETTINGS.imageApp;
  }
  if (!QUALITIES.includes(out.quality)) out.quality = DEFAULT_SETTINGS.quality;
  return out;
}

export function loadSettings(storage = globalThis.localStorage, apps = null) {
  try {
    return normalizeSettings(parse(storage.getItem(SETTINGS_KEY)), apps);
  } catch (_) {
    return normalizeSettings({}, apps);
  }
}

/** localStorage 에 저장하고, db 를 주면 meta('settings') 에도 적는다 (실패해도 앱은 계속) */
export function saveSettings(settings, { storage = globalThis.localStorage, db = null } = {}) {
  try { storage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) { /* 저장 못 해도 이번 실행에는 쓴다 */ }
  if (db) db.setMeta('settings', settings).catch(() => {});
}

/**
 * 시작할 때: localStorage 에 설정이 없는데 저장소에 있으면 되살린다. 돌려주는 값은 지금 쓸 설정.
 */
export async function restoreSettings({ storage = globalThis.localStorage, db, apps = null } = {}) {
  try {
    if (storage.getItem(SETTINGS_KEY) != null) return loadSettings(storage, apps);
  } catch (_) { /* 아래에서 저장소를 본다 */ }
  try {
    const saved = await db.getMeta('settings', null);
    if (saved) {
      const s = normalizeSettings(saved, apps);
      saveSettings(s, { storage });
      return s;
    }
  } catch (_) { /* 저장소를 못 읽으면 기본값 */ }
  return normalizeSettings({}, apps);
}
