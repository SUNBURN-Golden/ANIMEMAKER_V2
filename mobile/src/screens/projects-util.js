// 화면들이 같이 쓰는 작은 도구: 시간 · 제목 · 상태 칩 · 목록 읽기 · 그림 미리보기
import { h } from '../ui.js';
import * as db from '../db.js';
import { fmtMinutes, fmtSeconds } from '../engine/util.js';

export { fmtMinutes, fmtSeconds };

/** 받침 있으면 '을/이', 없으면 '를/가' */
export function josa(word, withFinal, without) {
  const s = String(word || '');
  const c = s.charCodeAt(s.length - 1);
  if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 ? withFinal : without;
  return without;
}

export const isEngineRecord = (rec) => !!(rec && rec.workflow && rec.steps);

/** "하루 이야기 EP2" → "하루 이야기 2화", 파일 이름 끝 확장자 지우기 */
export function niceTitle(title, series) {
  let t = String(title || '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/\(체험\)/g, '(연습)').trim();
  t = t.replace(/\bEP\s*(\d+)\b/i, '$1화').trim();
  if (!t && series) t = `${series.name} ${series.episode}화`;
  return t || '이름 없는 영상';
}

/** 상태 → { key, label, emoji } : 완성 / 만드는 중 / 도움이 필요해요 / 멈춤 */
export function statusOf(row) {
  if (row.status === 'done') return { key: 'done', label: '완성', emoji: '✅' };
  if (row.status === 'running') return { key: 'busy', label: '만드는 중', emoji: '⏳' };
  if (row.status === 'waiting' || row.status === 'error') return { key: 'help', label: '도움이 필요해요', emoji: '🙋' };
  return { key: 'stopped', label: '멈춤', emoji: '⏸' };
}

/** 영상 목록 줄 (엔진 목록. 엔진 기록이 아닌 옛 시험 기록이 섞여 있어도 목록이 깨지지 않게 한다) */
export async function loadRows(engine) {
  try {
    return await engine.projects.list();
  } catch (_) {
    const rows = [];
    for (const rec of await db.listProjects()) {
      rows.push({
        id: rec.id, title: rec.title, status: rec.status || 'idle', createdAt: rec.createdAt, updatedAt: rec.updatedAt || rec.createdAt,
        aspect: rec.workflow && rec.workflow.aspect, durationSec: null, progress: { done: 0, total: 7 }, hasVideo: !!(rec.output && rec.output.video), series: null, waiting: null, legacy: true,
      });
    }
    return rows;
  }
}

/** 영상의 대표 그림 (첫 배경, 없으면 첫 인물 그림) 을 object URL 로. 없으면 null. 쓴 URL 은 revokeThumbs 로 치운다 */
const thumbs = new Map();
export async function thumbUrl(engine, id) {
  if (thumbs.has(id)) return thumbs.get(id);
  let url = null;
  try {
    const snap = await engine.projects.get(id);
    const d = (snap.drawings || []).find((x) => x.hasPicture && x.kind === 'bg') || (snap.drawings || []).find((x) => x.hasPicture);
    const blob = d ? await engine.drawings.blob(id, d.key, 'current') : null;
    if (blob) url = URL.createObjectURL(blob);
  } catch (_) { url = null; }
  thumbs.set(id, url);
  return url;
}
export function forgetThumb(id) {
  const u = thumbs.get(id);
  if (u) URL.revokeObjectURL(u);
  thumbs.delete(id);
}
export function revokeThumbs() {
  for (const u of thumbs.values()) if (u) URL.revokeObjectURL(u);
  thumbs.clear();
}

/** 부모 칸에 자식들을 붙인다 (null · false 는 건너뛴다. DOM 의 append(null) 은 'null' 글자를 넣어 버려서) */
export function put(el, ...kids) {
  for (const k of kids) if (k != null && k !== false) el.append(k);
  return el;
}

/** 작은 둥근 알약 */
export const pill = (text, cls = '') => h('span', { class: `pill ${cls}` }, text);

/** 짧게 진동 (되는 폰에서만) */
export function buzz(ms = 15) {
  try { if (navigator.vibrate) navigator.vibrate(ms); } catch (_) { /* 진동 없는 기기 */ }
}

/** 버튼 눌림 반응: 진동 + 잠깐 눌린 모양. 누르면 fn 이 불리고, 오류는 알림 글로 */
export function onTap(fn, toastFn) {
  return async (e) => {
    buzz();
    try { await fn(e); } catch (err) { if (!(err && err.name === 'AbortError') && toastFn) toastFn((err && err.message) || String(err), 'err'); }
  };
}
