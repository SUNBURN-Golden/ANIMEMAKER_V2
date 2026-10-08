// 영상 엔진(render/compositor)에 그림을 건네는 곳: materials.shot(i) → { bg, layers }
//  - 인물 셀: 배경을 뺀 투명 그림(곱한 알파 RGBA), 못 뺐으면 전체 그림. 배경 판: 불투명 그림. 못 읽으면 null (오류를 던지지 않는다)
//  - 합성기가 돌려받은 비트맵을 닫는다 → 부를 때마다 새로 읽는다
//  - 없는 그림은 같은 장면(없으면 앞 장면)의 다른 그림으로 대신하고, 배경은 가까운 장면의 배경으로 대신한다 (PC 앱의 shotMaterials / shotBg 와 같다).
//    (그림은 앞·뒤 가까운 장면에서 찾는다: 폰은 우선순위로 그림을 받아서 앞 장면이 비어 있을 수 있다.) 그래서 그림이 몇 장 없어도 언제든 영상을 만들 수 있다.
//  - 초안(draft): 없는 그림을 이웃 그림으로 대신하지 않고 '그림 기다리는 카드' 로 보여 줘서 어디가 비었는지 알 수 있게 한다 (배경 없음 = 종이색)
import { X } from './shared.js';
import { BG_ID } from './keys.js';
import { bgLeaderOf, outSizeOf } from './workflows.js';

/**
 * @param {import('./runtime.js').ProjectRuntime} rt
 * @param {{draft?:boolean}} [o]
 */
export function createMaterials(rt, { draft = false } = {}) {
  const { xs } = rt;
  const stats = { substituted: [], missingBg: [], placeholders: 0 };
  const size = outSizeOf(rt.wf);

  /** 이 그림 기록이 합성기에 줄 덩어리 { blob, keyed } 또는 null */
  const pictureOf = async (shotNo, id) => {
    const d = rt.itemOf(shotNo, id);
    if (!d || d.status !== 'done' || !d.file) return null;
    if (xs.layers && d.keyed && d.cel) {
      const blob = await rt.getBlob(d.cel);
      if (blob) return { blob, keyed: true };
    }
    const blob = await rt.getBlob(d.file);
    return blob ? { blob, keyed: false } : null;
  };

  const decode = (m) => rt.services.decodeImage(m.blob, { premultiply: m.keyed }).catch(() => null);

  const bgBlobFor = async (i) => {
    const order = [i];
    for (let k = 1; k < xs.shots.length; k++) order.push(i - k, i + k);
    for (const k of draft ? [i] : order) {
      const s = xs.shots[k];
      if (!s) continue;
      const it = rt.itemOf(bgLeaderOf(xs, s.shot), BG_ID);
      if (it && it.status === 'done' && it.file) {
        const blob = await rt.getBlob(it.file);
        if (blob) {
          if (k !== i) stats.substituted.push(`bg:${xs.shots[i].shot}<-${s.shot}`);
          return blob;
        }
      }
    }
    stats.missingBg.push(xs.shots[i].shot);
    return null;
  };

  return {
    stats,
    async shot(i) {
      const shot = xs.shots[i];
      const ids = [...new Set(X.frameTable(shot))];
      let bg = null;
      if (xs.layers) {
        const blob = await bgBlobFor(i);
        bg = blob ? await rt.services.decodeImage(blob, { premultiply: false }).catch(() => null) : null;
      }
      const found = new Map();
      for (const id of ids) found.set(id, await pictureOf(shot.shot, id));
      let fallback = null;
      if (!draft && ids.some((id) => !found.get(id))) {
        // 같은 장면의 다른 그림 → 가까운 장면(앞 · 뒤 번갈아)의 그림. (PC 앱은 앞 장면만 보지만, 폰은 우선순위로 그림을 받아서 앞 장면이 비어 있을 수 있다)
        const order = [i];
        for (let k = 1; k < xs.shots.length; k++) order.push(i - k, i + k);
        for (const k of order) {
          const s = xs.shots[k];
          if (!s) continue;
          for (const d of s.drawings) { fallback = await pictureOf(s.shot, d.id); if (fallback) break; }
          if (fallback) break;
        }
      }
      const layers = new Map();
      for (const id of ids) {
        const m = found.get(id);
        if (m) { layers.set(id, await decode(m)); continue; }
        if (draft) {
          stats.placeholders++;
          layers.set(id, await rt.services.placeholder({ w: size.w, h: size.h, label: `컷 ${shot.shot} · 그림 ${id} 기다리는 중` }).catch(() => null));
        } else if (fallback) {
          stats.substituted.push(`${shot.shot}:${id}`);
          layers.set(id, await decode(fallback));
        } else {
          layers.set(id, null); // 그림이 하나도 없다: 합성기가 어두운 카드(전체 그림) 또는 투명(셀)로 보여 준다
        }
      }
      return { bg, layers };
    },
    close() { /* 합성기가 비트맵을 닫는다 */ },
  };
}
