// 폰 안 저장소 (IndexedDB 'animemaker-v2', 버전 1)
//
//   meta        설정 · 화면 상태 · expecting(다음에 받을 것) · lastProject …   키(글자) → 값
//   characters  캐릭터                 keyPath id      normalizeCharacter 결과 + refs[{kind,label,mime,blobKey}]
//   series      시리즈                 keyPath id
//   projects    영상(에피소드) 하나 = 레코드 하나   keyPath id.   그림은 넣지 않는다 → drawings 로 따로 (프로젝트 JSON 을 작게 유지)
//   drawings    배경·인물 그림 하나 = 레코드 하나   keyPath [projectId, key], 색인 projectId
//   files       덩어리(Blob), 키는 글자:  '<projectId>/…' 작품 것 · 'char/<characterId>/…' 캐릭터 기준 그림(작품의 시리즈 사본이 같이 쓴다)
//               · 'inbox/<shareId>/<n>' 받은 것.   앞글자(prefix)로 한꺼번에 지울 수 있다
//   inbox       공유로 받았지만 아직 자리를 못 찾은 항목
//
// 전부 비동기(약속). 저장소가 꽉 차면 StorageError(quota:true) 로 알기 쉬운 한국어 메시지를 준다.

export const DB_NAME = 'animemaker-v2';
export const DB_VERSION = 1;
export const STORES = Object.freeze(['meta', 'characters', 'series', 'projects', 'drawings', 'files', 'inbox']);

/** 작품 레코드가 이보다 커지면 경고 (그림·그림 주문 글이 작품에 섞여 들어간 것일 수 있다) */
export const PROJECT_SOFT_LIMIT = 512 * 1024;

/** 기다리는 슬롯 종류: 이야기 답장 · 그림 순서표 답장 · 배경 그림 · 인물 그림 · 캐릭터 기준 그림 · 캐릭터 설명 */
export const EXPECTING_KINDS = Object.freeze(['plan', 'xsheet', 'bg', 'cel', 'ref', 'describe']);
/** 이보다 오래된 expecting 은 없는 것으로 본다 (앱이 꺼진 채 하루 지난 공유를 엉뚱한 곳에 넣지 않게) */
export const EXPECTING_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export class StorageError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'StorageError';
    this.cause = cause;
    this.quota = false;
  }
}

function storageError(err, msg) {
  if (err instanceof StorageError) return err;
  if (err && err.name === 'QuotaExceededError') {
    const e = new StorageError('저장 공간이 부족해요. 안 쓰는 작품을 지우거나 폰 저장 공간을 비워 주세요.', err);
    e.quota = true;
    return e;
  }
  return new StorageError(msg || `저장하지 못했어요${err && err.message ? ` (${err.message})` : ''}`, err);
}

const idb = () => globalThis.indexedDB;
const KeyRange = () => globalThis.IDBKeyRange;

let dbp = null;

function upgrade(db, oldVersion) {
  if (oldVersion < 1) {
    db.createObjectStore('meta');
    db.createObjectStore('characters', { keyPath: 'id' });
    db.createObjectStore('series', { keyPath: 'id' });
    db.createObjectStore('projects', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
    db.createObjectStore('drawings', { keyPath: ['projectId', 'key'] }).createIndex('projectId', 'projectId');
    db.createObjectStore('files');
    db.createObjectStore('inbox', { keyPath: 'id' });
  }
  // 다음 버전은 여기에 if (oldVersion < 2) { … } 로 이어 붙인다 (기존 데이터는 그대로 열려야 한다)
}

/** 저장소 열기 (여러 번 불러도 한 번만 연다) */
export function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    let req;
    try {
      req = idb().open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(storageError(e, '이 폰에서는 저장소를 쓸 수 없어요'));
      return;
    }
    req.onupgradeneeded = (ev) => upgrade(req.result, ev.oldVersion);
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbp = null; };
      db.onclose = () => { dbp = null; };
      resolve(db);
    };
    req.onerror = () => reject(storageError(req.error, '저장소를 열지 못했어요'));
  });
  dbp.catch(() => { dbp = null; }); // 실패하면 다음에 다시 열어 본다
  return dbp;
}

/** 시험용: 연결 닫기 */
export async function close() {
  const p = dbp;
  dbp = null;
  if (p) { const db = await p.catch(() => null); if (db) db.close(); }
}

/** 시험용: 저장소 통째로 지우기 */
export async function deleteDatabase() {
  await close();
  await new Promise((resolve, reject) => {
    const r = idb().deleteDatabase(DB_NAME);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
    r.onblocked = () => resolve();
  });
}

/**
 * 한 번의 거래. work(t) 가 돌려준 것이
 *   요청(IDBRequest)이면 → 그 요청의 결과를,  함수이면 → 거래가 끝난 뒤 그 함수가 돌려주는 값을,  그 밖이면 → 그 값을 결과로 한다
 */
function tx(stores, mode, work) {
  return open().then((db) => new Promise((resolve, reject) => {
    let t;
    try {
      t = db.transaction(stores, mode);
    } catch (e) {
      reject(storageError(e));
      return;
    }
    let result;
    let final = null;
    t.oncomplete = () => resolve(final ? final() : result);
    t.onerror = () => reject(storageError(t.error));
    t.onabort = () => reject(storageError(t.error, '저장하지 못했어요 (저장 공간이 부족할 수 있어요)'));
    try {
      const r = work(t);
      if (typeof r === 'function') final = r;
      else if (r && typeof r === 'object' && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
      else result = r;
    } catch (e) {
      reject(e && e.name === 'QuotaExceededError' ? storageError(e) : e);
      try { t.abort(); } catch (_) { /* 이미 끝남 */ }
    }
  }));
}

const byUpdatedDesc = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);

function needString(v, what) {
  if (typeof v !== 'string' || !v) throw new Error(`${what} 가 필요해요`);
}

/** 새 id: '<접두>_<시각36진수><무작위 6글자>' */
export function newId(prefix = 'p') {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  const rnd = [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 6);
  return `${prefix}_${Date.now().toString(36)}${rnd}`;
}

function newNonce() {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ───────────────────────── meta ─────────────────────────

export async function getMeta(key, fallback = null) {
  needString(key, 'getMeta: 키');
  const v = await tx('meta', 'readonly', (t) => t.objectStore('meta').get(key));
  return v === undefined ? fallback : v;
}

export async function setMeta(key, value) {
  needString(key, 'setMeta: 키');
  return tx('meta', 'readwrite', (t) => t.objectStore('meta').put(value, key)).then(() => undefined);
}

export async function deleteMeta(key) {
  needString(key, 'deleteMeta: 키');
  return tx('meta', 'readwrite', (t) => t.objectStore('meta').delete(key)).then(() => undefined);
}

/** 마지막으로 연 작품 id (앱을 다시 켰을 때 이어서 열 수 있게) */
export const getLastProject = () => getMeta('lastProject', null);
export const setLastProject = (id) => (id ? setMeta('lastProject', id) : deleteMeta('lastProject'));

// ───────────────────────── expecting: 다음에 공유로 받을 것 ─────────────────────────
// AI 앱에 부탁하러 갔다가 앱이 꺼져도(콜드 스타트) 돌아오는 공유가 어디로 가야 하는지 알 수 있게 저장소에 적어 둔다.
// { projectId, kind: 'plan'|'xsheet'|'bg'|'cel'|'ref'|'describe', key, requestedAt, nonce }
//   key   = 어느 칸인지 (배경이면 장면 번호, 인물 그림이면 그림 키, 캐릭터면 캐릭터 id …)
//   nonce = 이 부탁의 번호. 부탁 글에 넣어 두었다가 답장에 같이 와야 받아 준다 (클립보드에 남은 부탁 글을 답장으로 착각하지 않게)

export async function setExpecting({ projectId, kind, key = null } = {}) {
  needString(projectId, 'setExpecting: projectId');
  if (!EXPECTING_KINDS.includes(kind)) throw new Error(`setExpecting: kind 는 ${EXPECTING_KINDS.join(' · ')} 중 하나여야 해요 (받은 값: ${kind})`);
  const rec = { projectId, kind, key, requestedAt: Date.now(), nonce: newNonce() };
  await setMeta('expecting', rec);
  return rec;
}

/** 지금 기다리는 것. 없거나 너무 오래됐으면 null */
export async function getExpecting({ maxAgeMs = EXPECTING_MAX_AGE_MS } = {}) {
  const e = await getMeta('expecting', null);
  if (!e || typeof e !== 'object') return null;
  if (maxAgeMs > 0 && Date.now() - (e.requestedAt || 0) > maxAgeMs) return null;
  return e;
}

/** 기다림 지우기. nonce 를 주면 그 부탁일 때만 지운다 (그 사이 새 부탁이 생겼으면 그대로 둔다). 지웠으면 true */
export async function clearExpecting(nonce) {
  return tx('meta', 'readwrite', (t) => {
    const s = t.objectStore('meta');
    const r = s.get('expecting');
    let removed = false;
    r.onsuccess = () => {
      const cur = r.result;
      if (cur && (!nonce || cur.nonce === nonce)) { s.delete('expecting'); removed = true; }
    };
    return () => removed;
  });
}

// ───────────────────────── projects ─────────────────────────

/** 작품 저장. 지금 시각을 updatedAt 에 넣는다. (그림은 putDrawing 으로 따로 — 작품에 drawings 가 들어 있으면 오류) */
export async function putProject(p) {
  if (!p || typeof p !== 'object') throw new Error('putProject: 작품이 필요해요');
  needString(p.id, 'putProject: id');
  if ('drawings' in p) throw new Error('putProject: 그림은 작품 레코드에 넣지 않아요 (putDrawing 으로 따로 저장해요)');
  p.updatedAt = Date.now();
  const json = JSON.stringify(p); // 함수·Blob 같은 것이 섞이지 않게 글자를 거쳐 복사한다
  if (json.length > PROJECT_SOFT_LIMIT) console.warn(`작품 ${p.id} 레코드가 ${Math.round(json.length / 1024)}KB 예요. 그림·긴 글은 drawings/files 로 따로 저장하세요.`);
  await tx('projects', 'readwrite', (t) => t.objectStore('projects').put(JSON.parse(json)));
  return p;
}

export async function getProject(id) {
  needString(id, 'getProject: id');
  return tx('projects', 'readonly', (t) => t.objectStore('projects').get(id)).then((v) => v || null);
}

/** 최근에 고친 순서 */
export async function listProjects() {
  const all = (await tx('projects', 'readonly', (t) => t.objectStore('projects').getAll())) || [];
  return all.sort(byUpdatedDesc);
}

/** 작품과 그 그림 기록, '<id>/' 로 시작하는 파일을 한 번에 지운다 (중간에 실패하면 아무것도 안 지워진다) */
export async function deleteProject(id) {
  needString(id, 'deleteProject: id');
  return tx(['projects', 'drawings', 'files'], 'readwrite', (t) => {
    t.objectStore('projects').delete(id);
    t.objectStore('drawings').delete(drawingRange(id));
    t.objectStore('files').delete(prefixRange(`${id}/`));
  }).then(() => undefined);
}

// ───────────────────────── drawings ─────────────────────────

const drawingRange = (projectId) => KeyRange().bound([projectId], [projectId, []]);

function checkDrawing(d) {
  if (!d || typeof d !== 'object') throw new Error('그림 기록이 필요해요');
  needString(d.projectId, '그림 기록의 projectId');
  needString(d.key, '그림 기록의 key');
}

export async function putDrawing(d) {
  checkDrawing(d);
  d.updatedAt = Date.now();
  return tx('drawings', 'readwrite', (t) => t.objectStore('drawings').put(d)).then(() => d);
}

/** 여러 장을 한 번에 (하나라도 실패하면 모두 취소) */
export async function putDrawings(list) {
  for (const d of list) checkDrawing(d);
  const now = Date.now();
  return tx('drawings', 'readwrite', (t) => {
    const s = t.objectStore('drawings');
    for (const d of list) { d.updatedAt = now; s.put(d); }
  }).then(() => list);
}

export async function getDrawing(projectId, key) {
  needString(projectId, 'getDrawing: projectId');
  needString(key, 'getDrawing: key');
  return tx('drawings', 'readonly', (t) => t.objectStore('drawings').get([projectId, key])).then((v) => v || null);
}

/** 한 작품의 그림 기록 전부 (key 순서) */
export async function listDrawings(projectId) {
  needString(projectId, 'listDrawings: projectId');
  return (await tx('drawings', 'readonly', (t) => t.objectStore('drawings').getAll(drawingRange(projectId)))) || [];
}

export async function deleteDrawing(projectId, key) {
  needString(projectId, 'deleteDrawing: projectId');
  needString(key, 'deleteDrawing: key');
  return tx('drawings', 'readwrite', (t) => t.objectStore('drawings').delete([projectId, key])).then(() => undefined);
}

// ───────────────────────── files (Blob) ─────────────────────────

const prefixRange = (prefix) => KeyRange().bound(prefix, `${prefix}￿`);

export async function putFile(key, blob) {
  needString(key, 'putFile: 키');
  return tx('files', 'readwrite', (t) => t.objectStore('files').put(blob, key)).then(() => undefined);
}

export async function getFile(key) {
  if (!key) return Promise.resolve(null);
  return tx('files', 'readonly', (t) => t.objectStore('files').get(key)).then((v) => (v === undefined ? null : v));
}

export async function hasFile(key) {
  if (!key) return Promise.resolve(false);
  return tx('files', 'readonly', (t) => t.objectStore('files').count(key)).then((n) => n > 0);
}

export async function deleteFile(key) {
  if (!key) return Promise.resolve();
  return tx('files', 'readwrite', (t) => t.objectStore('files').delete(key)).then(() => undefined);
}

/** 앞글자가 prefix 인 파일 전부 지우기 (예: deleteFiles(`${projectId}/`)). prefix 가 비어 있으면 거부한다 */
export async function deleteFiles(prefix) {
  needString(prefix, 'deleteFiles: 앞글자(prefix)');
  return tx('files', 'readwrite', (t) => t.objectStore('files').delete(prefixRange(prefix))).then(() => undefined);
}

/** 앞글자가 prefix 인 파일 키 목록 */
export async function listFileKeys(prefix = '') {
  return tx('files', 'readonly', (t) => t.objectStore('files').getAllKeys(prefix ? prefixRange(prefix) : undefined)).then((k) => k || []);
}

// ───────────────────────── characters · series ─────────────────────────
// (캐릭터 기준 그림 파일은 files 의 'char/<id>/…' 에 둔다. 레코드를 지워도 파일은 그대로다 — 작품의 시리즈 사본이 같은 파일을 쓸 수 있어서,
//  더 아무도 안 쓰는지 확인한 뒤 deleteFiles('char/<id>/') 로 지운다)

function recordApi(store, label) {
  const check = (r) => {
    if (!r || typeof r !== 'object') throw new Error(`${label}이(가) 필요해요`);
    needString(r.id, `${label}의 id`);
  };
  return {
    async put(r) {
      check(r);
      r.updatedAt = Date.now();
      return tx(store, 'readwrite', (t) => t.objectStore(store).put(JSON.parse(JSON.stringify(r)))).then(() => r);
    },
    async get(id) {
      needString(id, `${label} id`);
      return tx(store, 'readonly', (t) => t.objectStore(store).get(id)).then((v) => v || null);
    },
    async list() {
      return ((await tx(store, 'readonly', (t) => t.objectStore(store).getAll())) || []).sort(byUpdatedDesc);
    },
    async delete(id) {
      needString(id, `${label} id`);
      return tx(store, 'readwrite', (t) => t.objectStore(store).delete(id)).then(() => undefined);
    },
  };
}

const chars = recordApi('characters', '캐릭터');
export const putCharacter = chars.put;
export const getCharacter = chars.get;
export const listCharacters = chars.list;
export const deleteCharacter = chars.delete;

const seriesApi = recordApi('series', '시리즈');
export const putSeries = seriesApi.put;
export const getSeries = seriesApi.get;
export const listSeries = seriesApi.list;
export const deleteSeries = seriesApi.delete;

// ───────────────────────── inbox: 받았지만 아직 자리를 못 찾은 공유 ─────────────────────────
// { id, receivedAt, text, items:[{name, mime, size, key}], failed? }  파일 본체는 files 의 'inbox/<id>/<n>'

export async function putInbox(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('받은 항목이 필요해요');
  needString(entry.id, '받은 항목의 id');
  return tx('inbox', 'readwrite', (t) => t.objectStore('inbox').put(JSON.parse(JSON.stringify(entry)))).then(() => entry);
}

export async function getInbox(id) {
  needString(id, 'getInbox: id');
  return tx('inbox', 'readonly', (t) => t.objectStore('inbox').get(id)).then((v) => v || null);
}

/** 받은 순서 (오래된 것부터) */
export async function listInbox() {
  const all = (await tx('inbox', 'readonly', (t) => t.objectStore('inbox').getAll())) || [];
  return all.sort((a, b) => (a.receivedAt || 0) - (b.receivedAt || 0));
}

/** 받은 항목과 그 파일을 지운다 */
export async function deleteInbox(id) {
  needString(id, 'deleteInbox: id');
  return tx(['inbox', 'files'], 'readwrite', (t) => {
    t.objectStore('inbox').delete(id);
    t.objectStore('files').delete(prefixRange(`inbox/${id}/`));
  }).then(() => undefined);
}

// ───────────────────────── 저장 공간 ─────────────────────────

/**
 * 저장 공간 사용량. 알 수 없으면 null.
 * @returns {Promise<{used:number, quota:number, persisted:boolean|null}|null>}
 */
export async function usage(nav = globalThis.navigator) {
  try {
    const st = nav && nav.storage;
    if (!st || !st.estimate) return null;
    const e = await st.estimate();
    const persisted = st.persisted ? await st.persisted() : null;
    return { used: e.usage || 0, quota: e.quota || 0, persisted };
  } catch (_) {
    return null;
  }
}

/** 저장 공간을 "함부로 지우지 말아 줘" 로 요청. 허락되면 true */
export async function requestPersist(nav = globalThis.navigator) {
  try {
    const st = nav && nav.storage;
    if (!st || !st.persist) return false;
    return !!(await st.persist());
  } catch (_) {
    return false;
  }
}

/** 처음 켰을 때 한 번만 persist 를 요청하고 결과를 meta('persist') 에 적는다. 이미 했으면 적어 둔 결과를 그대로 준다 */
export async function ensurePersistOnce(nav = globalThis.navigator) {
  const prev = await getMeta('persist', null);
  if (prev && typeof prev.granted === 'boolean') return prev;
  const granted = await requestPersist(nav);
  const rec = { asked: Date.now(), granted };
  await setMeta('persist', rec);
  return rec;
}
