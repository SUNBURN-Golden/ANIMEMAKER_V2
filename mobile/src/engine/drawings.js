// 그림 모으기의 속살: 그림 목록 만들기(buildDrawings) · 받은 그림 넣기(applyPicture) · 예전 그림 보관(history ≤ 6) · 기준 그림 고르기(drawingRefs)
// PC 앱 runner.js 의 buildDrawings / drawingRefs / processCelItem 과 edits.js 의 _archivePicture / _trimHistory / _carryHistory 를 폰 저장소에 맞게 옮긴 것.
import { P, EC } from './shared.js';
import { BK, BG_ID, drawingKey } from './keys.js';
import { newItem } from './model.js';
import { buildQueue } from './queue.js';

export const REF_NOTE = {
  turnaround: 'character turnaround model sheet (front / side / back): copy this design exactly',
  expressions: 'character expression sheet: same face, use for expressions',
  fullbody: 'character full-body reference: same proportions and outfit',
  other: 'character reference drawing',
};
export const PREV_NOTE = 'the previous drawing of this same shot: keep the same background, framing, lighting and line style; change only the pose / expression';
export const PREV_CEL_NOTE = 'the previous drawing of this same shot — EDIT this image: change only what the prompt says, keep everything else identical';

const extOf = (blob) => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' })[blob && blob.type] || 'png';

export const shotOf = (rt, no) => (rt.xs ? rt.xs.shots.find((s) => s.shot === no) : null);

/** 이 그림이 바뀌면 영상을 다시 만들어야 하는 장면들 (배경 판은 그 배경을 같이 쓰는 모든 장면) */
export function affectedShots(rt, it) {
  const xs = rt.xs;
  if (it.kind === 'bg' && xs && xs.bgGroups) {
    const g = xs.bgGroups.find((x) => x.leader === it.shot);
    if (g) return [...g.shots];
  }
  return [it.shot];
}

// ───────────────────────── 예전 그림 (history) ─────────────────────────

/** 기록이 6개를 넘으면 가장 오래된 것부터 지운다 (덩어리도) */
export async function trimHistory(rt, it) {
  const list = it.history || [];
  if (list.length <= EC.HISTORY_MAX) return [];
  const dropped = list.splice(EC.HISTORY_MAX);
  for (const h of dropped) await rt.delBlob(h.file);
  return dropped;
}

/**
 * 지금 그림을 '예전 그림' 맨 앞에 넣는다 (덩어리를 history 열쇠로 복사 · move 면 옮김).
 * @param {{move?:boolean, withPrompt?:boolean, trim?:boolean}} [o] withPrompt: 이 그림을 그린 주문 글도 같이 적는다 · trim: 6개를 넘으면 가장 오래된 것부터 지운다
 * @returns {Promise<object|null>} 기록 한 줄 (그림이 없으면 null)
 */
export async function archivePicture(rt, it, { move = false, withPrompt = false, trim = false } = {}) {
  if (!it.file) return null;
  const blob = await rt.getBlob(it.file);
  if (!blob) return null;
  const k = EC.nextVersion(it);
  const hk = BK.hist(rt.id, it.shot, it.id, k);
  await rt.putBlob(hk, blob);
  if (move) await rt.delBlob(it.file);
  const entry = { file: hk, at: it.updatedAt || rt.now(), kind: it.source === 'user' ? 'user' : 'ai' };
  if (it.note) entry.note = it.note;
  if (withPrompt) { entry.prompt = it.prompt; if (it.promptEdited) entry.promptEdited = true; }
  if (it.source === 'user' && it.matchColors) entry.matchColors = true;
  it.vseq = k;
  it.history = EC.pushHistory(it.history, entry, Number.MAX_SAFE_INTEGER).history;
  if (trim) await trimHistory(rt, it);
  return entry;
}

/** 순서표를 다시 짜면서 버려지는 그림: 그림은 기록으로 옮기고, 새 항목이 이어받을 칸들을 돌려준다 */
async function carryHistory(rt, o) {
  const tmp = { shot: o.shot, id: o.id, file: o.file, history: Array.isArray(o.history) ? [...o.history] : [], vseq: o.vseq, updatedAt: o.updatedAt, source: o.source, note: o.note, matchColors: o.matchColors, prompt: o.prompt, promptEdited: o.promptEdited };
  if (o.file) {
    try { await archivePicture(rt, tmp, { move: true, withPrompt: true, trim: true }); } catch (_) { /* 옮기지 못해도 새 그림은 받아야 한다 */ }
  }
  if (o.cel) await rt.delBlob(o.cel);
  const out = {};
  if (tmp.history.length) { out.history = tmp.history; out.vseq = tmp.vseq; }
  if (o.redraws) out.redraws = o.redraws;
  return out;
}

// ───────────────────────── 그림 목록 만들기 ─────────────────────────

/**
 * 그림 순서표 → 그림 목록 (배경 판은 묶음마다 1장 + 인물 셀). 주문 글이 같거나 내가 바꾼(custom) 그림은 이미 받은 그림을 그대로 쓰고,
 * 주문 글이 바뀌어 다시 받아야 하는 그림은 옛 그림을 '예전 그림' 으로 옮겨 둔다. 순서표에서 사라진 그림은 덩어리까지 지운다.
 */
export async function buildDrawings(rt) {
  const { xs } = rt;
  const plan = rt.p.plan;
  const { series, wf } = rt;
  const old = new Map(rt.drawings);
  const next = [];
  const wanted = new Set();
  const keep = async (kind, shot, id, prompt) => {
    const key = drawingKey(shot.shot, id);
    wanted.add(key);
    const o = old.get(key);
    if (o && (o.prompt === prompt || o.custom) && o.file) {
      const kept = { ...o, kind };
      // 그림은 지키되, 직접 고친 주문 글이 아니면 주문 글은 새 순서표 것으로 (나중에 다시 그리면 지금 장면 설명대로)
      if (o.custom && o.prompt !== prompt && o.source !== undefined && !o.promptEdited) kept.prompt = prompt;
      next.push(kept);
      return;
    }
    const fresh = newItem(rt.id, kind, shot.shot, id, prompt);
    if (o) Object.assign(fresh, await carryHistory(rt, o));
    next.push(fresh);
  };
  if (xs.layers) {
    for (const g of xs.bgGroups || []) {
      const shot = xs.shots.find((s) => s.shot === g.leader);
      await keep('bg', shot, BG_ID, P.composeBgPrompt({ plan, series, shot, wf }));
    }
  }
  for (const shot of xs.shots) {
    for (const d of shot.drawings) {
      const prompt = xs.layers
        ? P.composeCelPrompt({ plan, series, shot, drawing: d, wf, keyColor: xs.keyColor })
        : P.composeDrawingPrompt({ plan, series, shot, drawing: d, wf });
      await keep('cel', shot, d.id, prompt);
    }
  }
  for (const key of [...old.keys()]) if (!wanted.has(key)) await rt.removeItem(key); // 순서표에서 사라진 그림
  rt.drawings = new Map();
  await rt.saveItems(next);
  return next;
}

/** 다음에 부탁할 그림 (줄 순서대로 아직 안 받은 첫 그림). 없으면 null */
export function nextPending(rt) {
  for (const q of buildQueue(rt.xs, (rt.p.timing && rt.p.timing.segments) || [])) {
    const it = rt.drawings.get(q.key);
    if (it && it.status === 'pending') return it;
  }
  return null;
}

// ───────────────────────── 받은 그림 넣기 ─────────────────────────

/**
 * 받은 그림 한 장을 이 칸에 넣는다: 줄이기 → (인물 셀이면) 배경 빼기 + 첫 셀 색에 맞추기 → 저장.
 * @param {object} it 그림 기록
 * @param {Blob} blob 받은 파일
 * @param {{mode?:'initial'|'redraw'|'replace', note?:string, prompt?:string, matchColors?:boolean, signal?:AbortSignal}} [o]
 *   initial = 처음 받음 · redraw = AI 가 다시 그린 것(옛 그림은 예전 그림으로) · replace = 내가 고른 그림(custom, 색 맞추기는 기본 끔)
 * @returns {Promise<{key:string, keyed:boolean|null, reason:string|null, mode:string, replaced:boolean}>}
 */
export async function applyPicture(rt, it, blob, o = {}) {
  const mode = o.mode || 'initial';
  const { xs } = rt;
  const isCel = rt.layers && it.kind !== 'bg';
  const shot = shotOf(rt, it.shot);
  const first = shot && shot.drawings[0] && rt.itemOf(shot.shot, shot.drawings[0].id);
  const source = mode === 'replace' ? 'user' : 'ai';
  const match = o.matchColors !== undefined ? !!o.matchColors : source === 'user' ? !!it.matchColors : true;
  const refStats = isCel && match && first && first !== it && first.keyed ? first.stats : null;
  const prevStatus = it.status;
  const hadPicture = !!(it.file && prevStatus === 'done');
  it.status = 'running';
  it.error = null;
  await rt.saveItem(it);
  let r;
  try {
    r = await rt.services.ingest(blob, { kind: isCel ? 'cel' : 'pic', keyColor: xs.keyColor, refStats, signal: o.signal });
  } catch (e) {
    it.status = prevStatus === 'running' ? (it.file ? 'done' : 'pending') : prevStatus;
    it.error = e && e.code === 'badImage' ? e.message : null;
    await rt.saveItem(it);
    throw e;
  }
  const promptChanged = !!(o.prompt && o.prompt !== it.prompt);
  if (hadPicture) await archivePicture(rt, it, { withPrompt: promptChanged });
  const picKey = BK.pic(rt.id, it.shot, it.id);
  const celKey = BK.cel(rt.id, it.shot, it.id);
  await rt.putBlob(picKey, r.orig);
  if (isCel && r.keyed) await rt.putBlob(celKey, r.cel); else await rt.delBlob(celKey);
  if (promptChanged) { it.prompt = o.prompt; it.custom = true; it.promptEdited = true; }
  Object.assign(it, {
    status: 'done', error: null, file: picKey, cel: isCel && r.keyed ? celKey : null, keyed: isCel ? !!r.keyed : null,
    stats: r.stats || null, keySource: r.source || null, keyReason: r.reason || null, w: r.w, h: r.h, source,
  });
  if (mode === 'redraw') {
    it.redraws = (it.redraws || 0) + 1;
    delete it.matchColors;
    if (o.note) { it.note = o.note; it.custom = true; } else delete it.note;
  } else if (mode === 'replace') {
    it.custom = true;
    if (o.matchColors) it.matchColors = true; else delete it.matchColors;
    delete it.note;
  }
  await trimHistory(rt, it);
  if (isCel && !r.keyed) rt.log(`ℹ 컷${it.shot}-${it.id}: 배경이 단색이 아니라 뺄 수 없어서 전체 그림으로 씁니다.`);
  if (mode !== 'initial' || (rt.p.output && rt.p.output.clean)) rt.markDirty(...affectedShots(rt, it));
  await rt.saveItem(it);
  await rt.save();
  rt.emit();
  return { key: it.key, keyed: it.keyed, reason: it.keyReason, mode, replaced: hadPicture };
}

/** 인물 셀의 배경 빼기를 저장된 원본에서 다시 한다 (되돌리기 · 바꾼 뒤 · 앱이 꺼지는 바람에 못 끝낸 그림). 못 해도 오류로 두지 않는다 */
export async function rekey(rt, it, o = {}) {
  if (!(rt.layers && it.kind !== 'bg') || !it.file) return it;
  const pic = await rt.getBlob(it.file);
  if (!pic) return it;
  const { xs } = rt;
  const shot = shotOf(rt, it.shot);
  const first = shot && shot.drawings[0] && rt.itemOf(shot.shot, shot.drawings[0].id);
  const match = o.matchColors !== undefined ? !!o.matchColors : it.source === 'user' ? !!it.matchColors : true;
  const refStats = match && first && first !== it && first.keyed ? first.stats : null;
  const celKey = BK.cel(rt.id, it.shot, it.id);
  try {
    const r = await rt.services.ingest(pic, { kind: 'cel', keyColor: xs.keyColor, refStats, skipOrig: true, signal: o.signal });
    if (r.keyed) {
      await rt.putBlob(celKey, r.cel);
      Object.assign(it, { cel: celKey, keyed: true, stats: r.stats || null, keySource: r.source || null, keyReason: null });
    } else {
      await rt.delBlob(celKey);
      Object.assign(it, { cel: null, keyed: false, stats: null, keySource: null, keyReason: r.reason || null });
      rt.log(`ℹ 컷${it.shot}-${it.id}: 배경이 단색이 아니라 뺄 수 없어서 전체 그림으로 씁니다.`);
    }
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    Object.assign(it, { keyed: null, cel: null, stats: null });
    rt.log(`⚠ 컷${it.shot}-${it.id} 배경 빼기 실패 (영상 만들 때 다시 해 볼게요): ${String((e && e.message) || e).split('\n')[0]}`);
  }
  await rt.saveItem(it);
  return it;
}

/** 배경 빼기를 아직 안 한 인물 그림(직접 넣은 파일 · 앱이 꺼져서 못 끝낸 것)을 영상 만들기 전에 처리. 처리한 수를 돌려준다 */
export async function ensureCelsKeyed(rt, signal) {
  if (!rt.layers) return 0;
  let n = 0;
  for (const it of rt.items()) {
    if (it.kind === 'bg' || it.status !== 'done' || !it.file) continue;
    if (it.keyed === undefined || it.keyed === null || (it.keyed && !it.cel)) {
      await rekey(rt, it, { signal });
      n++;
    }
  }
  return n;
}

// ───────────────────────── 기준 그림 ─────────────────────────

/**
 * 이 그림을 부탁할 때 붙일 기준 그림 (최대 4장).
 *  - 배경 판: 없음 (인물이 들어가면 안 되므로)
 *  - 인물 셀: 같은 장면의 바로 앞 셀(있으면)을 첫 번째로 붙이고 '고치기(edit)' 로 부탁 + 고정 캐릭터 기준 그림(인물마다 3장, 둘 이상이면 2장씩)
 *  - editSelf(한국어로 고쳐 달라고 할 때): 지금 이 그림 자신을 '고칠 그림' 으로 첫 번째에 붙인다
 * 셀은 투명이라 AI 가 알아보기 어려워서 배경색 위에 얹은 그림(plate)으로 붙인다.
 * @returns {Promise<{refs:{name:string, blob:Blob, note:string}[], prev:object|null}>}
 */
export async function drawingRefs(rt, shot, id, { editSelf = null } = {}) {
  const refs = [];
  if (id === BG_ID && !editSelf) return { refs, prev: null };
  const layers = rt.layers;
  const idx = shot.drawings.findIndex((x) => x.id === id);
  let prev = null;
  const attach = async (it, note, slug) => {
    let blob = null;
    if (layers && it.keyed && it.cel) {
      const cel = await rt.getBlob(it.cel);
      if (cel) blob = await rt.services.plate(cel, rt.xs.keyColor);
    }
    if (!blob) blob = await rt.getBlob(it.file);
    if (blob) refs.push({ name: `${String(refs.length + 1).padStart(2, '0')}_${slug}.${extOf(blob)}`, blob, note });
    return !!blob;
  };
  if (editSelf) {
    prev = editSelf;
    await attach(editSelf, id === BG_ID ? EC.CUR_NOTE.bg : layers ? EC.CUR_NOTE.cel : EC.CUR_NOTE.full, 'current');
  } else {
    for (let k = idx - 1; k >= 0; k--) {
      const it = rt.itemOf(shot.shot, shot.drawings[k].id);
      if (it && it.status === 'done' && it.file) { prev = it; break; }
    }
    if (prev && !(await attach(prev, layers ? PREV_CEL_NOTE : PREV_NOTE, 'previous'))) prev = null;
  }
  const s = rt.series;
  if (s && id !== BG_ID) {
    const d = shot.drawings.find((x) => x.id === id) || {};
    const cast = P.charactersInShot(rt.p.plan, shot, d).filter((c) => c.fixed);
    const perChar = cast.length > 1 ? 2 : 3;
    const order = ['turnaround', 'expressions', 'fullbody', 'other'];
    for (const c of cast) {
      const sc = s.characters.find((x) => x.name === c.name);
      if (!sc) continue;
      const picked = sc.refs.slice().sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)).slice(0, perChar);
      for (const r of picked) {
        if (refs.length >= 4) continue;
        const blob = await rt.getBlob(r.blobKey);
        if (!blob) continue;
        refs.push({ name: `${String(refs.length + 1).padStart(2, '0')}_${sc.id || 'char'}_${r.kind}.${extOf(blob)}`, blob, note: `${sc.name} — ${REF_NOTE[r.kind] || REF_NOTE.other}` });
      }
    }
  }
  return { refs, prev };
}
