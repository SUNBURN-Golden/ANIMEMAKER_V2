// 가사 자막 스튜디오의 줄 계산 (화면 없이 쓰는 순수 함수). PC 앱 substudio.js 의 줄 계산과 같은 규칙이다 — 미리 본 대로 영상에 나오게.
//   줄(작업 사본) = { _k, text, start, end, hidden, endLocked, section, sectionStart, _tapped }
import SubStyle from '../../../src/shared/subtitle-style.js';

export const MIN_GAP = 0.2; // 두 줄 시작 사이 최소 간격 (초)
export const MAX_HOLD = 7; // 끝을 따로 정하지 않은 줄이 떠 있는 가장 긴 시간 (엔진과 같다)
export const NUDGE = 0.1;
export const LIMITS = { chars: 16, cps: 9, short: 0.8, long: 7 };
export const round2 = (x) => Math.round(x * 100) / 100;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

let keySeq = 0;
export const newKey = () => `k${++keySeq}`;

/** 엔진 줄 → 작업 줄. tapped: 사람이 맞춘 시간인지 */
export function mkLine(raw, tapped) {
  const start = Number(raw.start) || 0;
  const l = {
    _k: newKey(), text: String(raw.text == null ? '' : raw.text), start, end: Number(raw.end) > start ? Number(raw.end) : start + 0.5,
    hidden: !!raw.hidden, endLocked: raw.endLocked === true, section: raw.section || '', sectionStart: raw.sectionStart === true, _tapped: !!tapped,
  };
  if (raw.part != null) l.part = raw.part;
  if (raw.words) l.words = raw.words;
  return l;
}

/** 작업 줄 → 엔진으로 보낼 줄 (끝은 사람이 정한 줄만 보낸다: 나머지는 엔진이 같은 규칙으로 정한다) */
export function toSaveLine(l) {
  const o = { text: l.text, start: round2(l.start), hidden: !!l.hidden };
  if (l.endLocked) { o.end = round2(l.end); o.endLocked = true; }
  if (l.section) o.section = l.section;
  if (l.sectionStart) o.sectionStart = true;
  return o;
}

/** 시간 순으로 세우고 줄마다 끝 시간을 정한다. 끝이 정해진 줄(endLocked)은 그 끝을 지키되 다음 줄 직전을 넘지 않는다 */
export function recompute(lines, dur) {
  lines.sort((a, b) => a.start - b.start);
  lines.forEach((l, i) => {
    const next = lines[i + 1];
    const limit = next ? next.start - 0.05 : (dur ? dur - 0.05 : Infinity);
    let end;
    if (l.endLocked && l.end > l.start) {
      end = l.end;
      if (end > limit && limit > l.start + 0.1) end = limit;
    } else {
      end = limit - l.start >= 0.3 ? Math.min(limit, l.start + MAX_HOLD) : l.start + 0.3;
    }
    if (dur) end = Math.min(end, dur);
    if (!(end > l.start)) end = l.start + 0.1;
    l.end = end;
  });
  return lines;
}

/** 줄 목록 → 글이 있는 실제 줄 */
export const realLines = (lines) => lines.filter((l) => l.text.trim());

/** 바뀌었는지 비교하는 서명: 글 · 시작 · 숨김 · (정한) 끝 */
export function sigLines(lines) {
  return JSON.stringify(realLines(lines).map((l) => [l.text.trim(), round2(l.start), l.hidden ? 1 : 0, l.endLocked ? round2(l.end) : 0]));
}
export function sigStyle(style) {
  const s = SubStyle.normalizeStyle(style);
  return JSON.stringify(Object.keys(s).sort().map((k) => [k, s[k]]));
}

/** 시작 시간을 옮길 수 있는 칸: 앞 줄보다 MIN_GAP 뒤, 다음 줄보다 MIN_GAP 앞, 정한 끝보다 앞, 노래 안 */
export function startBounds(lines, i, dur) {
  const prev = lines[i - 1];
  const next = lines[i + 1];
  const lo = prev ? prev.start + MIN_GAP : 0;
  let hi = next ? next.start - MIN_GAP : (dur ? dur - 0.3 : Infinity);
  if (lines[i].endLocked) hi = Math.min(hi, lines[i].end - 0.2);
  return [lo, Math.max(lo, hi)];
}

/** i 번째 줄의 시작을 t 초로 (경계 안으로). 바뀐 만큼(초)을 돌려준다 */
export function setStart(lines, i, t, dur) {
  const l = lines[i];
  if (!l) return 0;
  const [lo, hi] = startBounds(lines, i, dur);
  const before = l.start;
  l.start = round2(clamp(t, lo, hi));
  l._tapped = true;
  recompute(lines, dur);
  return l.start - before;
}

/** i 번째 줄의 끝을 d 초 옮기기 (끝을 사람이 정한 것으로 표시) */
export function nudgeEnd(lines, i, d, dur) {
  const l = lines[i];
  if (!l) return 0;
  const next = lines[i + 1];
  const hi = next ? next.start - 0.05 : (dur || Infinity);
  const before = l.end;
  l.end = round2(clamp(before + d, l.start + 0.2, Math.max(l.start + 0.2, hi)));
  l.endLocked = true;
  l._tapped = true;
  recompute(lines, dur);
  return l.end - before;
}

/** 모든 줄을 함께 d 초 옮기기 (맨 앞은 0 아래로, 맨 뒤는 노래 밖으로 못 나감). 옮긴 만큼을 돌려준다 */
export function shiftAll(lines, d, dur) {
  if (!lines.length) return 0;
  const first = Math.min(...lines.map((l) => l.start));
  const last = Math.max(...lines.map((l) => l.start));
  const k = clamp(d, -first, dur ? Math.max(-first, dur - 0.3 - last) : Infinity);
  for (const l of lines) { l.start = round2(l.start + k); if (l.endLocked) l.end = round2(l.end + k); }
  recompute(lines, dur);
  return k;
}

/** 글을 caret 위치에서 둘로 나누기. 뒤쪽 줄의 시작은 두 시간 사이(글자 수 비율)에 둔다. 나눌 수 없으면 null */
export function splitLine(lines, i, caret, dur) {
  const a = lines[i];
  if (!a) return null;
  const full = a.text;
  let pos = Number.isFinite(caret) ? caret : 0;
  if (pos <= 0 || pos >= full.length) { // 커서가 맨 앞·뒤면 가운데에서 가장 가까운 띄어쓰기
    const mid = full.length / 2;
    let best = -1;
    for (let k = 1; k < full.length - 1; k++) if (/\s/.test(full[k]) && (best < 0 || Math.abs(k - mid) < Math.abs(best - mid))) best = k;
    pos = best < 0 ? Math.floor(mid) : best;
  }
  const left = full.slice(0, pos).trim();
  const right = full.slice(pos).trim();
  if (!left || !right) return null;
  const span = Math.max(0.2, a.end - a.start);
  const ratio = clamp(Array.from(left).length / Math.max(1, Array.from(left).length + Array.from(right).length), 0.25, 0.75);
  const b = mkLine({ text: right, start: round2(a.start + span * ratio), end: a.end, hidden: a.hidden, endLocked: a.endLocked, section: a.section, sectionStart: false }, a._tapped);
  b._tapped = a._tapped;
  a.text = left;
  a.endLocked = false; // 앞 줄의 끝은 뒤 줄 시작에서 저절로 정해진다
  lines.splice(i + 1, 0, b);
  recompute(lines, dur);
  return b;
}

/** i 번째 줄과 다음 줄을 하나로. 합친 줄을 돌려준다 (다음 줄이 없으면 null) */
export function mergeNext(lines, i, dur) {
  const a = lines[i];
  const b = lines[i + 1];
  if (!a || !b) return null;
  a.text = `${a.text.trim()} ${b.text.trim()}`.trim();
  a.hidden = a.hidden && b.hidden;
  a.endLocked = b.endLocked;
  a.end = b.end;
  a._tapped = a._tapped || b._tapped;
  lines.splice(i + 1, 1);
  recompute(lines, dur);
  return a;
}

/** 새 줄 하나 끼우기: after(고른 줄 번호, 없으면 -1 = 맨 뒤) 다음에, 재생 위치가 그 칸 안이면 거기, 아니면 앞 줄이 끝난 직후. 글은 비어 있다 */
export function addLine(lines, after, playhead, dur) {
  const i = after >= 0 ? Math.min(after, lines.length - 1) : lines.length - 1;
  const prev = lines[i];
  const next = lines[i + 1];
  const lo = prev ? prev.start + 0.3 : 0;
  const hi = next ? next.start - 0.3 : (dur ? dur - 0.5 : Infinity);
  let t;
  if (Number.isFinite(playhead) && playhead >= lo && playhead <= hi) t = playhead;
  else if (prev && prev.end + 0.1 <= hi) t = prev.end + 0.1;
  else t = Math.min(hi, Math.max(lo, ((prev ? prev.start : 0) + (next ? next.start : (dur || 5))) / 2));
  const l = mkLine({ text: '', start: round2(Math.max(0, t)), end: round2(Math.max(0, t) + 2) }, false);
  l._new = true;
  lines.splice(i + 1, 0, l);
  recompute(lines, dur);
  return l;
}

/** 탭으로 맞춘 결과를 작업 줄에 섞기. shown: 탭 창에 보여 준 줄들(숨기지 않은 줄), result: 탭 창의 결과(같은 순서), flags: 줄마다 맞췄는지 */
export function mergeTap(lines, shown, result, flags, dur) {
  shown.forEach((l, i) => {
    const r = result[i];
    if (!r || !lines.includes(l)) return;
    l.start = round2(r.start);
    if (!l.endLocked) l.end = round2(r.end);
    if (flags && flags[i]) l._tapped = true;
  });
  recompute(lines, dur);
}

/** 줄 하나에 붙는 가벼운 경고들 (막지 않는다). lay: AMSubtitleRender.getLayout 결과 (없어도 됨) */
export function lineWarnings(l, lay) {
  const out = [];
  if (l.hidden || !l.text.trim()) return out;
  if (l.text.split('\n').some((s) => Array.from(s.trim()).length > LIMITS.chars)) out.push(`한 줄이 ${LIMITS.chars}자보다 길어요`);
  if (lay && lay.lineCount >= 3) out.push('3줄이 돼요');
  const d = l.end - l.start;
  const chars = Array.from(l.text.replace(/\s+/g, '')).length;
  if (d < LIMITS.short) out.push(`${LIMITS.short}초보다 짧아요`);
  if (d > LIMITS.long) out.push(`${LIMITS.long}초보다 길어요`);
  if (d > 0 && chars / d > LIMITS.cps) out.push('너무 빨리 지나가요');
  return out;
}

/** 글자 색의 밝기에 맞춰 테두리 색: 밝은 글씨는 검정, 어두운 글씨는 흰색 */
export function autoOutline(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '#000000';
  const n = parseInt(m[1], 16);
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum > 0.5 ? '#000000' : '#ffffff';
}

/** 상자 안에 비율을 지켜 넣었을 때 보이는 영상의 자리 (object-fit: contain) */
export function fitRect(boxW, boxH, vw, vh) {
  if (!(vw > 0 && vh > 0 && boxW > 0 && boxH > 0)) return { x: 0, y: 0, w: boxW, h: boxH };
  const k = Math.min(boxW / vw, boxH / vh);
  const w = vw * k;
  const h = vh * k;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}
