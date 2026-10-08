// 그림 부탁 순서(작업 줄): 화면에 오래·세게 나오는 장면부터. 같은 장면의 그림은 이어서(앞 그림을 고쳐서 다음 그림을 그리므로).
// 배경 판은 그 배경을 쓰는 장면 중 처음 차례가 오는 장면 앞에 한 번만 끼워 넣는다.
import { X } from './shared.js';
import { BG_ID, drawingKey } from './keys.js';
import { bgLeaderOf } from './workflows.js';

/** 장면 우선순위 = 화면에 나오는 시간(초) × 에너지(0.5~1.5) × 하이라이트(1.5) × 움직이는 장면(1.2) */
export function shotWeight(shot, segment) {
  const sec = shot.frames / X.FPS;
  const seg = segment || {};
  const level = typeof seg.level === 'number' ? seg.level : seg.energy === 'high' ? 0.85 : seg.energy === 'mid' ? 0.6 : 0.3;
  return Math.round(sec * (0.5 + level) * (shot.highlight ? 1.5 : 1) * (shot.motion ? 1.2 : 1) * 100) / 100;
}

/**
 * @param {object} xs 그림 순서표
 * @param {object[]} segments 컷(구간) 목록 (xs.shots 와 같은 순서)
 * @returns {{key:string, shot:number, id:string, kind:'bg'|'cel', weight:number}[]} 부탁할 차례대로
 */
export function buildQueue(xs, segments = []) {
  if (!xs || !Array.isArray(xs.shots)) return [];
  const order = xs.shots
    .map((s, i) => ({ s, i, w: shotWeight(s, segments[i]) }))
    .sort((a, b) => b.w - a.w || a.i - b.i);
  const out = [];
  const seenBg = new Set();
  for (const { s, w } of order) {
    if (xs.layers && s.bg) {
      const leader = bgLeaderOf(xs, s.shot);
      if (!seenBg.has(leader)) {
        seenBg.add(leader);
        out.push({ key: drawingKey(leader, BG_ID), shot: leader, id: BG_ID, kind: 'bg', weight: w });
      }
    }
    for (const d of s.drawings) out.push({ key: drawingKey(s.shot, d.id), shot: s.shot, id: d.id, kind: 'cel', weight: w });
  }
  return out;
}
