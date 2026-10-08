// 공유로 받은 것(네이티브 받은 함) → 앱 저장소(IndexedDB 의 inbox + files)로 옮기기
//
// 흐름:  다른 앱에서 '공유 → AnimeMaker V2'  →  (네이티브) cache/shared 에 복사 + inbox.json 에 기록
//        →  (여기) 파일을 앱 저장소 files('inbox/<id>/<n>') 에, 목록을 inbox 에 넣고  →  ackInbox 로 네이티브 쪽을 지움
// 옮기는 도중 앱이 꺼져도 네이티브 쪽에는 ack 하기 전까지 그대로 남아 있어서 다음에 다시 옮긴다 (이미 옮긴 항목은 ack 만 한다).
// 어느 작품·칸으로 보낼지는 db.getExpecting() 으로 화면 쪽이 정한다 (콜드 스타트 공유도 같은 길).
import * as db from './db.js';
import * as N from './native.js';

/** 받은 파일 한 개의 종류: image | audio | text | amchar | json | other */
export function kindOf(item) {
  const mime = String((item && item.mime) || '').toLowerCase();
  const name = String((item && item.name) || '').toLowerCase();
  if (/\.amchar$/.test(name)) return 'amchar';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'text/plain' || /\.(txt|lrc|srt)$/.test(name)) return 'text';
  if (mime === 'application/json') return 'json';
  return 'other';
}

/** 받은 것 요약 → '그림 2장 · 글' 같은 한국어 */
export function describeReceived(rec) {
  const n = { image: 0, audio: 0, text: 0, amchar: 0, json: 0, other: 0 };
  for (const it of rec.items || []) n[kindOf(it)]++;
  const parts = [];
  if (n.image) parts.push(`그림 ${n.image}장`);
  if (n.audio) parts.push(`노래 ${n.audio}개`);
  if (n.amchar) parts.push(`캐릭터 파일 ${n.amchar}개`);
  if (n.text) parts.push(`글 파일 ${n.text}개`);
  if (n.json + n.other) parts.push(`파일 ${n.json + n.other}개`);
  if (rec.text) parts.push('글');
  return parts.join(' · ') || '(비어 있음)';
}

function summary(rec, duplicate) {
  return { id: rec.id, stored: (rec.items || []).length, failed: rec.failed || 0, text: rec.text || '', duplicate, record: rec, label: describeReceived(rec) };
}

/** 받은 파일 읽기. 일시적인 실패에 대비해 한 번 더 해 본다 */
async function readWithRetry(native, item) {
  try {
    return await native.sharedItemToBlob(item);
  } catch (_) {
    await new Promise((r) => setTimeout(r, 250));
    return native.sharedItemToBlob(item);
  }
}

/**
 * 네이티브 받은 함 항목 하나를 앱 저장소로 옮긴다.
 * 저장 공간이 모자라 못 옮기면(StorageError.quota) ack 하지 않고 오류를 던진다 — 파일은 네이티브에 남아 있어 공간을 만든 뒤 다시 옮길 수 있다.
 * @returns {Promise<{id:string, stored:number, failed:number, text:string, duplicate:boolean, record:object, label:string}>}
 */
export async function ingestEntry(entry, { native = N, store = db } = {}) {
  if (!entry || !entry.id) throw new Error('받은 항목에 id 가 없어요');
  const id = entry.id;
  const existing = await store.getInbox(id);
  if (existing) {
    await native.ackInbox([id]);
    return summary(existing, true);
  }
  const items = [];
  let failed = Number(entry.failed) || 0;
  const list = Array.isArray(entry.items) ? entry.items : [];
  try {
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      let blob;
      try {
        blob = await readWithRetry(native, it);
      } catch (_) {
        failed++; // 파일을 못 읽었다 (지워졌거나 권한) — 나머지는 계속 옮긴다
        continue;
      }
      const key = `inbox/${id}/${i}`;
      await store.putFile(key, blob);
      items.push({ name: it.name || `받은 파일 ${i + 1}`, mime: it.mime || blob.type || '', size: blob.size, key });
    }
    const rec = { id, receivedAt: entry.receivedAt || Date.now(), text: entry.text || '', items };
    if (failed) rec.failed = failed;
    if (rec.items.length || rec.text) await store.putInbox(rec); // 옮길 게 하나도 없으면 목록에 남기지 않는다 (failed 는 돌려주는 요약으로 알린다)
    await native.ackInbox([id]);
    return summary(rec, false);
  } catch (e) {
    await store.deleteFiles(`inbox/${id}/`).catch(() => {}); // 반쯤 옮긴 파일은 치운다
    throw e;
  }
}

/**
 * 공유 받기를 시작한다. 받은 항목은 한 줄로 차례차례 옮긴다.
 * @param {{native?:object, store?:object, onReceived?:(s:object)=>void, onError?:(e:Error)=>void}} o
 * @returns {()=>void} 끄는 함수
 */
export function startReceiving({ native = N, store = db, onReceived, onError } = {}) {
  let chain = Promise.resolve();
  return native.onShared((entry) => {
    const run = chain.then(async () => {
      try {
        const s = await ingestEntry(entry, { native, store });
        if (onReceived) onReceived(s);
        return true;
      } catch (e) {
        if (onError) onError(e);
        return false; // 못 받았다 → 네이티브에 그대로 남아 있고, 다음에 앱으로 돌아올 때 다시 시도한다
      }
    });
    chain = run;
    return run;
  });
}

/** 받았지만 아직 자리를 못 찾은 항목들 (받은 순서) */
export const listReceived = () => db.listInbox();

/** 받은 항목의 n 번째 파일 */
export async function readReceivedBlob(entryId, index) {
  const rec = await db.getInbox(entryId);
  const it = rec && rec.items && rec.items[index];
  return it ? db.getFile(it.key) : null;
}

/** 다 쓴(작품에 넣었거나 버릴) 받은 항목 지우기 — 파일도 함께 */
export const discardReceived = (entryId) => db.deleteInbox(entryId);
