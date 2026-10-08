// AI 앱에 부탁하고 답을 받아 오는 길 (PC 앱의 '도우미 모드' 를 폰에 맞게). V1 의 세 가지 결함을 고친다:
//  D2 콜드 스타트  기다리는 칸(expecting)을 저장소에 적어 두고(db.setExpecting), 앱이 꺼졌다 켜져도 공유로 온 그림이 맞는 칸으로 간다. 자리를 못 찾은 건 '받은 함'(tray)에 남는다.
//  D3 부탁 글 되돌아옴  글 부탁에는 번호(nonce)를 붙이고 답장에 "request_id" 가 같이 와야 받는다. 부탁 글 그대로·예시 칸("...")·종류가 다른 답장은 거절한다.
//  그림 받기  칸 이름이 있으면 그 칸, 없으면 기다리던 칸, 없으면 우선순위 다음 빈 칸. 여러 장은 이어지는 칸에 차례로. 넘치는 건 받은 함으로 (아무것도 조용히 버리지 않는다).
import { X, P, EC, L, J } from './shared.js';
import { BG_ID, drawingKey } from './keys.js';
import { MSG } from './model.js';
import { buildQueue } from './queue.js';
import { buildXsheetContext } from './workflows.js';
import { drawingRefs, applyPicture, shotOf } from './drawings.js';
import { applyPlan, applyXsheet, itemTitle } from './pipeline.js';
import { squash } from './util.js';

// ───────────────────────── 부탁 글 · 답장 검사 (순수) ─────────────────────────

/** 부탁 글 끝에 붙이는 번호 안내 */
export function nonceBlock(nonce) {
  return `\n\n---\nIMPORTANT: add this exact field at the top level of your JSON answer, written as-is: "request_id": "${nonce}"`;
}

/** 그림 부탁 글: 붙인 기준 그림 설명 + 본 주문 글 + 한 장만 */
export function imageText({ prompt, refs, aspect }) {
  const lines = [];
  if (refs.length) {
    lines.push('Reference images attached to this message (in this order):');
    refs.forEach((r, i) => lines.push(`${i + 1}. ${r.note}`));
    lines.push('');
  }
  lines.push(prompt);
  lines.push('', `Output: ONE single image, aspect ratio ${aspect}. Do not add any text or border.`);
  return lines.join('\n');
}

/** 부탁 글이 그대로(또는 거의 그대로) 되돌아온 것인가 — 클립보드에 남은 부탁 글을 답장으로 착각하는 사고(D3)를 막는다 */
export function isEcho(text, prompt) {
  const t = squash(text);
  const pr = squash(prompt);
  if (!pr) return false;
  if (t === pr || t.includes(pr)) return true;
  if (t.includes('return only this json shape') || t.includes('# task:')) return true; // 부탁 글에만 있는 문장
  const n = 110;
  const probes = [0.05, 0.3, 0.55, 0.8].map((f) => pr.slice(Math.floor(pr.length * f), Math.floor(pr.length * f) + n)).filter((s) => s.length >= 60);
  return probes.filter((a) => t.includes(a)).length >= 2;
}

/** "..." 같은 예시 칸이 그대로 남은 값이 있으면 그 자리를 돌려준다 */
export function findPlaceholder(obj) {
  let found = null;
  const walk = (v, path) => {
    if (found) return;
    if (typeof v === 'string') { if (/^\s*(\.{3,}|…+)\s*$/.test(v)) found = path || '(값)'; return; }
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], path ? `${path}.${k}` : k);
  };
  walk(obj, '');
  return found;
}

const sameNonce = (a, b) => String(a == null ? '' : a).trim().toLowerCase() === String(b == null ? '' : b).trim().toLowerCase();
const fail = (reason, message) => ({ ok: false, reason, message });

/**
 * 답장 글 검사 (순수). 맞으면 { ok:true, obj } 아니면 { ok:false, reason, message }.
 * reason: echo(부탁 글 그대로) · placeholder(예시 칸 그대로) · noNonce(요청 번호 없음/다름 — force 로 받을 수 있다) · invalid(JSON 이 아니거나 모양이 틀림) · wrongKind(다른 종류의 답장)
 * @param {'plan'|'xsheet'|'describe'} kind
 */
export function checkReply({ text, prompt, nonce, kind, force = false }) {
  const t = String(text == null ? '' : text);
  if (!t.trim()) return fail('invalid', '붙여넣은 글이 비어 있어요. AI 앱의 답장을 복사해서 붙여넣어 주세요.');
  if (isEcho(t, prompt)) return fail('echo', '방금 보낸 부탁 글이 그대로 들어왔어요. AI 앱이 쓴 답장을 복사해서 붙여넣어 주세요.');
  const accept = kind === 'plan' ? P.validPlan : kind === 'xsheet' ? X.validXsheet : P.validCharacterDescription;
  const obj = J.extractJson(t, accept);
  if (!obj) {
    const other = J.extractJson(t, kind === 'plan' ? X.validXsheet : P.validPlan);
    if (other && kind !== 'describe') return fail('wrongKind', kind === 'plan' ? '그림 순서표 답장이에요. 지금은 이야기(기획) 답장이 필요해요.' : '이야기(기획) 답장이에요. 지금은 그림 순서표 답장이 필요해요.');
    const any = J.extractJson(t, () => true);
    return fail('invalid', any ? '답장의 모양이 부탁한 것과 달라요. AI 앱에 다시 부탁해 주세요.' : '답장에서 JSON(중괄호로 된 글)을 찾지 못했어요. AI 앱의 답장 전체를 붙여넣어 주세요.');
  }
  const ph = findPlaceholder(obj);
  if (ph) return fail('placeholder', `AI 가 예시 칸("...")을 채우지 않고 돌려보낸 것 같아요 (${ph}). 다시 부탁해 주세요.`);
  const got = obj.request_id ?? obj.requestId ?? obj.nonce;
  if (!force) {
    if (got == null || got === '') return fail('noNonce', '답장에 요청 번호(request_id)가 없어요. 방금 보낸 부탁의 답장이 맞다면 [그래도 쓰기] 를 눌러 주세요.');
    if (!sameNonce(got, nonce)) return fail('noNonce', '이전 부탁의 답장 같아요 (요청 번호가 달라요). 방금 부탁한 답장이 맞다면 [그래도 쓰기] 를 눌러 주세요.');
  }
  return { ok: true, obj };
}

// ───────────────────────── 지금 부탁할 것 ─────────────────────────

const kindOfItem = (it) => (it.kind === 'bg' ? 'bg' : 'cel');

/** 지금 AI 앱에 부탁할 것: 방금 정한 다시 그리기 → 파이프라인이 기다리는 것 → 다시 그리기 줄의 맨 앞. 없으면 null */
export function currentTarget(rt) {
  const { p } = rt;
  const redrawOf = (key) => (p.redraws || []).find((r) => r.key === key);
  if (p.handoff && p.handoff.redraw) {
    const r = redrawOf(p.handoff.key);
    const it = r && rt.drawings.get(r.key);
    if (it) return { kind: kindOfItem(it), key: r.key, redraw: r };
  }
  const w = p.waiting;
  if (p.status === 'waiting' && w) {
    if (w.kind === 'plan' || w.kind === 'xsheet') return { kind: w.kind, key: null };
    if ((w.kind === 'bg' || w.kind === 'cel') && w.itemKey) {
      const it = rt.drawings.get(w.itemKey);
      if (it && it.status !== 'done') return { kind: kindOfItem(it), key: it.key, redraw: redrawOf(it.key) || null };
    }
  }
  for (const r of p.redraws || []) {
    const it = rt.drawings.get(r.key);
    if (it) return { kind: kindOfItem(it), key: r.key, redraw: r };
  }
  return null;
}

/** 보낼 수 있는 AI 앱 목록 (글 부탁은 글을 받는 앱, 그림 부탁은 그림을 만드는 앱) — 마지막에 쓴 앱을 앞에 */
async function targetApps(rt, textKind) {
  const apps = (rt.engine.native && rt.engine.native.AI_APPS) || {};
  let pref = null;
  try { const s = await rt.db.getMeta('settings', null); pref = s && (textKind ? s.textApp : s.imageApp); } catch (_) { /* 설정이 없어도 된다 */ }
  const list = Object.entries(apps)
    .filter(([, a]) => (a.good || []).includes(textKind ? 'text' : 'image'))
    .map(([id, a]) => ({ id, name: a.name, pkg: a.pkg, preferred: id === pref }));
  return list.sort((a, b) => Number(b.preferred) - Number(a.preferred));
}

async function buildImageRequest(rt, it, redraw) {
  const { xs } = rt;
  const shot = shotOf(rt, it.shot);
  const isBg = it.kind === 'bg';
  const note = redraw && redraw.note ? redraw.note : '';
  const base = (redraw && redraw.prompt) || it.prompt;
  const editSelf = note && it.file ? it : null;
  const { refs, prev } = await drawingRefs(rt, shot, it.id, { editSelf });
  const def = shot.drawings.find((d) => d.id === it.id) || { prompt_en: '' };
  const keyColor = xs.layers ? xs.keyColor : null;
  let prompt;
  if (note) prompt = EC.notePrompt({ base, note, kind: isBg ? 'bg' : xs.layers ? 'cel' : 'full', keyColor });
  else prompt = prev ? P.celEditPrefix(def, keyColor) + base : base;
  const text = imageText({ prompt, refs, aspect: rt.wf.aspect });
  return { text, refs, title: `${itemTitle(it)}${redraw ? ' 다시 그리기' : ''}` };
}

/**
 * 지금 부탁할 것 하나를 요청서로 만든다 (여러 번 불러도 같은 번호). 기다리는 칸을 저장소에 적는다.
 * @returns {Promise<null|{kind:'plan'|'xsheet'|'bg'|'cel', key:string|null, title:string, prompt:string, files:{name:string,blob:Blob,note:string}[], nonce:string,
 *   targetApps:{id:string,name:string,pkg:string,preferred:boolean}[], expectsText:boolean, expectsImages:number, redraw:boolean, hint:string}>}
 */
export async function request(rt) {
  // 이어서 만드는 짧은 단계(이야기·가사·순서표·그림 목록)가 도는 중이면 곧 다음 부탁이 정해지니 잠깐 기다린다 (영상·자막처럼 긴 단계는 기다리지 않는다)
  if (rt.running && rt.runPromise && ['music', 'plan', 'timing', 'xsheet', 'drawings'].includes(rt.p.currentStep)) await rt.runPromise.catch(() => {});
  const target = currentTarget(rt);
  const { p } = rt;
  if (!target) {
    if (p.handoff) { p.handoff = null; rt.saveSoon(); }
    return null;
  }
  const { kind, key } = target;
  let exp = await rt.db.getExpecting();
  if (!(exp && exp.projectId === rt.id && exp.kind === kind && (exp.key || null) === (key || null))) exp = await rt.db.setExpecting({ projectId: rt.id, kind, key });
  const cur = p.handoff;
  if (!cur || cur.nonce !== exp.nonce || cur.kind !== kind || (cur.key || null) !== (key || null)) {
    p.handoff = { kind, key, nonce: exp.nonce, requestedAt: exp.requestedAt, redraw: !!target.redraw };
    rt.saveSoon();
  }
  return buildRequest(rt, target, exp.nonce);
}

async function buildRequest(rt, target, nonce) {
  const { p } = rt;
  const { kind, key } = target;
  if (kind === 'plan') {
    const prompt = P.planPrompt(p.topic, L.sectionSummary(p.lyricsInput), p.music.analysis, rt.wf, rt.series) + nonceBlock(nonce);
    return {
      kind, key: null, title: '이야기 짜기 부탁하기', prompt, files: [], nonce, targetApps: await targetApps(rt, true), expectsText: true, expectsImages: 0, redraw: false,
      hint: 'AI 앱이 답장하면 글 전체를 복사해서 이 앱에 붙여넣거나, AI 앱의 [공유] 로 AnimeMaker V2 에 보내 주세요.',
    };
  }
  if (kind === 'xsheet') {
    const prompt = X.xsheetPrompt(buildXsheetContext(p, rt.series)) + nonceBlock(nonce);
    return {
      kind, key: null, title: '그림 순서표 부탁하기', prompt, files: [], nonce, targetApps: await targetApps(rt, true), expectsText: true, expectsImages: 0, redraw: false,
      hint: 'AI 앱이 답장하면 글 전체를 복사해서 붙여넣어 주세요. 답장이 너무 길거나 어려우면 [AI 없이 폰이 짜기] 를 눌러도 돼요.',
    };
  }
  const it = rt.drawings.get(key);
  const r = await buildImageRequest(rt, it, target.redraw);
  return {
    kind, key, title: r.title, prompt: r.text, files: r.refs, nonce, targetApps: await targetApps(rt, false), expectsText: false, expectsImages: 1, redraw: !!target.redraw,
    hint: 'AI 앱이 그림을 만들어 주면 그림을 길게 눌러 [공유] → AnimeMaker V2 로 보내 주세요. 여러 장을 한꺼번에 보내도 순서대로 들어가요.',
  };
}

/** 요청서를 AI 앱으로 보낸다 (부탁 글은 클립보드에도 복사된다). 보내기 직전에 기다리는 칸이 저장돼 있다 */
export async function send(rt, appId) {
  const req = await request(rt);
  if (!req) throw new Error(MSG.nothingToSend);
  const apps = (rt.engine.native && rt.engine.native.AI_APPS) || {};
  if (!apps[appId]) throw new Error('알 수 없는 AI 앱이에요.');
  const r = await rt.engine.native.sendToApp(appId, { text: req.prompt, files: req.files.map((f) => ({ blob: f.blob, name: f.name })) });
  if (rt.p.handoff) { rt.p.handoff.sentAt = rt.now(); rt.p.handoff.app = appId; rt.saveSoon(); }
  return { ...(r || {}), copied: true, request: req };
}

// ───────────────────────── 글 답장 받기 ─────────────────────────

/**
 * AI 앱의 글 답장(붙여넣기 또는 공유)을 받는다.
 * @returns {Promise<{ok:boolean, reason?:'echo'|'placeholder'|'noNonce'|'invalid'|'wrongKind'|'noRequest', message:string, applied?:'plan'|'xsheet'|'describe', summary?:object}>}
 */
export async function acceptText(rt, text, { force = false } = {}) {
  const target = currentTarget(rt);
  if (!target || !['plan', 'xsheet'].includes(target.kind)) return fail('noRequest', '지금은 받을 글 답장이 없어요. 먼저 AI 앱에 부탁해 주세요.');
  const req = await request(rt);
  const res = checkReply({ text, prompt: req.prompt, nonce: req.nonce, kind: target.kind, force });
  if (!res.ok) return res;
  const { p } = rt;
  let summary;
  try {
    if (target.kind === 'plan') {
      const plan = applyPlan(rt, res.obj, 'reply');
      summary = { title: plan.title, acts: plan.story.length };
    } else {
      const xs = await applyXsheet(rt, res.obj, 'llm');
      summary = { shots: xs.shots.length, images: xs.estimate.images, minutes: xs.estimate.minutes, text: xs.estimate.text };
    }
  } catch (e) {
    return fail('invalid', `답장을 읽는 중에 문제가 생겼어요. AI 앱에 다시 부탁해 주세요. (${String((e && e.message) || e).split('\n')[0].slice(0, 100)})`);
  }
  await closeRequest(rt, null);
  p.waiting = null;
  await rt.save();
  rt.engine.continueRun(rt);
  return { ok: true, applied: target.kind, summary, message: target.kind === 'plan' ? `이야기를 받았어요: "${summary.title}"` : `그림 순서표를 받았어요. ${summary.text}` };
}

/** 이 작품의 기다림(expecting)만 지운다 (다른 작품이 기다리는 것은 건드리지 않는다). 지웠으면 true */
async function clearMyExpecting(rt, onlyKey = null) {
  const exp = await rt.db.getExpecting({ maxAgeMs: 0 });
  if (!exp || exp.projectId !== rt.id) return false;
  if (onlyKey && exp.key !== onlyKey) return false;
  return rt.db.clearExpecting(exp.nonce).catch(() => false);
}

/** 부탁을 마친 뒤 기다림(expecting)과 현재 부탁 표시를 지운다 */
async function closeRequest(rt, key = null) {
  if (rt.p.handoff && (!key || rt.p.handoff.key === key)) rt.p.handoff = null;
  await clearMyExpecting(rt, key);
}

// ───────────────────────── 그림 받기 ─────────────────────────

const isImage = (f) => !!f && !!f.blob && (/^image\//.test(f.mime || f.blob.type || '') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name || ''));

/** 이 그림 칸이 채워져야 하는가 (아직 못 받음 / 건너뜀) */
const isOpen = (it) => !!it && (it.status === 'pending' || it.status === 'skipped' || it.status === 'error');

/** 그림 n 장이 들어갈 칸들: 칸 이름 → 기다리던 칸 → 우선순위 다음 빈 칸 (이어지는 칸에 차례로) */
export function planSlots(rt, n, slotKey = null) {
  const queue = buildQueue(rt.xs, (rt.p.timing && rt.p.timing.segments) || []).map((q) => q.key);
  const first = (() => {
    if (slotKey) return rt.drawings.has(slotKey) ? { key: slotKey, explicit: true } : null;
    const t = currentTarget(rt);
    if (t && (t.kind === 'bg' || t.kind === 'cel')) {
      const it = rt.drawings.get(t.key);
      if (it && (isOpen(it) || t.redraw)) return { key: t.key, explicit: true };
    }
    return null;
  })();
  const at = first ? queue.indexOf(first.key) : -1;
  const ordered = at >= 0 ? [...queue.slice(at + 1), ...queue.slice(0, at)] : queue;
  const pending = ordered.filter((k) => { const it = rt.drawings.get(k); return it && it.status === 'pending'; });
  const skipped = ordered.filter((k) => { const it = rt.drawings.get(k); return it && (it.status === 'skipped' || it.status === 'error'); });
  const out = [];
  if (first) out.push(first.key);
  for (const k of [...pending, ...skipped]) if (k !== (first && first.key)) out.push(k);
  return out.slice(0, n);
}

/**
 * AI 앱이 만든 그림(들)을 받는다. 파일 하나하나가 정리(줄이기 · 배경 빼기)를 거쳐 칸에 들어간다.
 * @param {{name?:string, mime?:string, blob:Blob}[]} files
 * @param {{slotKey?:string, trayOnPending?:boolean}} [o] slotKey: 이 칸에 넣기(첫 장) · trayOnPending=false 면 못 넣은 건 받은 함에 새로 넣지 않고 돌려만 준다 (받은 함에서 다시 보내는 길)
 * @returns {Promise<{placed:object[], pending:object[], failed:object[], message:string}>}
 */
export async function acceptFiles(rt, files, { slotKey = null, trayOnPending = true } = {}) {
  const list = (files || []).filter((f) => f && f.blob);
  const images = list.filter(isImage);
  const others = list.filter((f) => !isImage(f));
  const slots = rt.xs ? planSlots(rt, images.length, slotKey) : [];
  const placed = [];
  const pending = [...others];
  const failed = [];
  const work = images.slice(0, slots.length);
  pending.push(...images.slice(slots.length));
  if (work.length) {
    await rt.exclusive('pic', () => rt.heavy('key', { title: '받은 그림 정리하는 중', modal: false, foreground: work.length >= 4 }, async ({ signal, progress }) => {
      for (let i = 0; i < work.length; i++) {
        const f = work[i];
        const it = rt.drawings.get(slots[i]);
        const red = (rt.p.redraws || []).find((r) => r.key === it.key) || null;
        const mode = it.file && it.status === 'done' ? 'redraw' : 'initial';
        if (red) { red.status = 'running'; rt.emit(); }
        try {
          const r = await applyPicture(rt, it, f.blob, { mode, note: red && red.note, prompt: red && red.prompt, signal });
          placed.push({ ...r, name: f.name || '', title: itemTitle(it), kind: it.kind });
          if (red) rt.p.redraws = rt.p.redraws.filter((x) => x.key !== it.key);
          if (rt.p.handoff && rt.p.handoff.key === it.key) rt.p.handoff = null;
        } catch (e) {
          if (red) red.status = 'queued';
          if (e && e.name === 'AbortError') throw e;
          failed.push({ name: f.name || '', key: it.key, message: (e && e.message) || MSG.badImage });
          pending.push(f);
        }
        progress((i + 1) / work.length, `받은 그림 ${i + 1}/${work.length}장 정리했어요`);
      }
    }));
    await rt.save();
    const exp = await rt.db.getExpecting({ maxAgeMs: 0 });
    if (exp && exp.projectId === rt.id && placed.some((x) => x.key === exp.key)) await rt.db.clearExpecting(exp.nonce).catch(() => {});
  }
  let trayItems = [];
  if (pending.length && trayOnPending) trayItems = await addToTray(rt.db, pending, rt.now());
  const w = rt.p.waiting;
  if (placed.length && rt.p.status === 'waiting' && w && (w.kind === 'bg' || w.kind === 'cel')) rt.engine.continueRun(rt);
  rt.emit();
  rt.engine.emit('tray', {});
  const parts = [];
  if (placed.length) parts.push(`그림 ${placed.length}장을 넣었어요`);
  if (pending.length) parts.push(`${pending.length}개는 자리를 못 찾아서 ${trayOnPending ? '받은 함에 두었어요' : '그대로 두었어요'}`);
  if (failed.length) parts.push(`${failed.length}개는 읽지 못했어요`);
  return { placed, pending: trayOnPending ? trayItems : pending, failed, message: parts.join(' · ') || '넣을 그림이 없어요' };
}

// ───────────────────────── 받은 함 (tray) ─────────────────────────

const kindOfFile = (it) => {
  const mime = String((it && it.mime) || '').toLowerCase();
  const name = String((it && it.name) || '').toLowerCase();
  if (mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/.test(name)) return 'image';
  if (mime === 'text/plain' || /\.(txt|json)$/.test(name)) return 'text';
  if (mime.startsWith('audio/')) return 'audio';
  return 'other';
};

/** 파일들을 받은 함(inbox 창고)에 넣는다. 반환: tray 항목들 */
export async function addToTray(db, files, now = Date.now()) {
  if (!files.length) return [];
  const id = db.newId('tray');
  const items = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const key = `inbox/${id}/${i}`;
    await db.putFile(key, f.blob);
    items.push({ name: f.name || `파일 ${i + 1}`, mime: f.mime || f.blob.type || '', size: f.blob.size, key });
  }
  const entry = { id, receivedAt: now, text: '', items };
  await db.putInbox(entry);
  return items.map((it) => ({ itemId: `${id}#${it.key.split('/').pop()}`, entryId: id, name: it.name, mime: it.mime, size: it.size, kind: kindOfFile(it), receivedAt: now }));
}

/**
 * 받은 함 목록 (받은 순서). 그림은 어느 칸에 넣을지 제안(suggest)을 붙인다.
 * @param {{suggest?:(i:number)=>object|null}} [o]
 */
export async function listTray(db, { suggest = null } = {}) {
  const out = [];
  let imageIndex = 0;
  for (const rec of await db.listInbox()) {
    for (const it of rec.items || []) {
      const n = it.key.split('/').pop();
      const kind = kindOfFile(it);
      const row = { itemId: `${rec.id}#${n}`, entryId: rec.id, name: it.name, mime: it.mime, size: it.size, kind, receivedAt: rec.receivedAt };
      if (kind === 'image' && suggest) row.suggest = suggest(imageIndex++);
      out.push(row);
    }
    if (rec.text) out.push({ itemId: `${rec.id}#text`, entryId: rec.id, name: '받은 글', mime: 'text/plain', size: rec.text.length, kind: 'text', text: rec.text.slice(0, 300), receivedAt: rec.receivedAt });
  }
  return out;
}

/** tray 항목 하나의 내용: 그림/파일 → Blob, 글 → string */
export async function readTrayItem(db, itemId) {
  const [entryId, n] = String(itemId).split('#');
  const rec = await db.getInbox(entryId);
  if (!rec) return null;
  if (n === 'text') return rec.text ? { text: rec.text, entry: rec } : null;
  const it = (rec.items || []).find((x) => x.key.split('/').pop() === n);
  if (!it) return null;
  const blob = await db.getFile(it.key);
  return blob ? { blob, item: it, entry: rec } : null;
}

/** tray 항목 하나를 지운다 (파일도). 항목이 다 없어지면 받은 함 기록도 지운다 */
export async function removeTrayItem(db, itemId) {
  const [entryId, n] = String(itemId).split('#');
  const rec = await db.getInbox(entryId);
  if (!rec) return false;
  if (n === 'text') {
    rec.text = '';
  } else {
    const it = (rec.items || []).find((x) => x.key.split('/').pop() === n);
    if (!it) return false;
    await db.deleteFile(it.key);
    rec.items = rec.items.filter((x) => x !== it);
  }
  if (!(rec.items && rec.items.length) && !rec.text) await db.deleteInbox(entryId);
  else await db.putInbox(rec);
  return true;
}

/** 받은 함의 항목을 이 작품의 칸에 넣는다 (그림은 칸 이름, 글은 지금 기다리는 답장으로) */
export async function placeTrayItem(rt, itemId, key, o = {}) {
  const got = await readTrayItem(rt.db, itemId);
  if (!got) throw new Error('받은 항목을 찾을 수 없어요.');
  if (got.text != null) {
    const r = await acceptText(rt, got.text, { force: !!(o && o.force) });
    if (r.ok) await removeTrayItem(rt.db, itemId);
    return { text: r };
  }
  const r = await acceptFiles(rt, [{ name: got.item.name, mime: got.item.mime, blob: got.blob }], { slotKey: key || null, trayOnPending: false });
  if (r.placed.length) await removeTrayItem(rt.db, itemId);
  return r;
}

// ───────────────────────── 콜드 스타트: 받은 공유를 맞는 칸으로 ─────────────────────────

/**
 * 받은 함(inbox 창고)에 쌓인 항목을 기다리던 칸으로 보낸다. 앱을 켤 때·공유를 받을 때 부른다.
 * 기다리는 칸(expecting)이 저장돼 있고 아직 유효하면 거기로, 아니면 받은 함에 그대로 남긴다. 조용히 버리는 건 없다.
 * @param {object} engine
 * @returns {Promise<{routed:number, kept:number}>}
 */
export async function routeInbox(engine) {
  let routed = 0;
  const left = async () => (await engine.db.listInbox()).length;
  const exp = await engine.db.getExpecting();
  if (!exp || String(exp.projectId).startsWith('char:')) return { routed, kept: await left() };
  const rt = await engine.loadRuntime(exp.projectId).catch(() => null);
  if (!rt) { await engine.db.clearExpecting(exp.nonce).catch(() => {}); return { routed, kept: await left() }; }
  const textKind = exp.kind === 'plan' || exp.kind === 'xsheet';
  const imageKind = exp.kind === 'bg' || exp.kind === 'cel';
  let slotKey = null;
  if (imageKind && exp.key) {
    const it = rt.drawings.get(exp.key);
    const red = (rt.p.redraws || []).some((r) => r.key === exp.key);
    if (it && (isOpen(it) || red)) slotKey = exp.key; // 기다리던 칸이 이미 채워졌으면 다음 빈 칸으로
  }
  for (const rec of await engine.db.listInbox()) {
    if (textKind && currentTarget(rt)) {
      const texts = rec.text ? [{ id: `${rec.id}#text`, text: rec.text }] : [];
      for (const it of rec.items || []) {
        if (kindOfFile(it) !== 'text') continue;
        const blob = await engine.db.getFile(it.key);
        if (blob) texts.push({ id: `${rec.id}#${it.key.split('/').pop()}`, text: await blob.text() });
      }
      for (const t of texts) {
        const r = await acceptText(rt, t.text, {});
        if (r.ok) { await removeTrayItem(engine.db, t.id); routed++; break; }
      }
    } else if (imageKind) {
      const imgs = [];
      for (const it of rec.items || []) {
        if (kindOfFile(it) !== 'image') continue;
        const blob = await engine.db.getFile(it.key);
        if (blob) imgs.push({ name: it.name, mime: it.mime, blob, itemId: `${rec.id}#${it.key.split('/').pop()}` });
      }
      if (!imgs.length) continue;
      const r = await acceptFiles(rt, imgs, { slotKey, trayOnPending: false });
      slotKey = null; // 첫 묶음만 기다리던 칸에, 나머지는 이어지는 빈 칸에
      const names = r.placed.map((x) => x.name);
      for (const f of imgs) {
        const at = names.indexOf(f.name);
        if (at >= 0) { names.splice(at, 1); await removeTrayItem(engine.db, f.itemId); routed++; }
      }
    }
  }
  engine.emit('tray', {});
  return { routed, kept: await left() };
}

// ───────────────────────── 건너뛰기 · 확인 ─────────────────────────

/**
 * 기다리는 것을 건너뛴다.
 *  - 'xsheet' 그림 순서표: AI 없이 폰이 PC 방식으로 짠다 (AI 없이 만들기)
 *  - 그림 칸 키('3:A' 또는 'image:3:A'): 그 그림은 건너뛰고(가까운 다른 그림으로 대신 보여 준다) 다음 그림으로
 *  - 'review:…' 확인: 계속하기와 같다
 * @returns {Promise<boolean>} 건너뛰었으면 true
 */
export async function skipWaiting(rt, key) {
  const { p } = rt;
  const k = String(key == null ? '' : key);
  if (k === 'xsheet' || k === 'handoff:xsheet') {
    if (!(p.status === 'waiting' && p.waiting && p.waiting.kind === 'xsheet')) return false;
    await applyXsheet(rt, null, 'fallback');
    await closeRequest(rt, null);
    p.waiting = null;
    await rt.save();
    rt.engine.continueRun(rt);
    return true;
  }
  if (k.startsWith('review:')) return continueReview(rt);
  const itemKey = k.startsWith('image:') ? k.slice(6) : k;
  const it = rt.drawings.get(itemKey);
  if (!it) return false;
  if ((p.redraws || []).some((r) => r.key === itemKey)) {
    p.redraws = p.redraws.filter((r) => r.key !== itemKey); // 다시 그리기를 그만둔다 (지금 그림은 그대로)
  } else if (it.status !== 'done') {
    it.status = 'skipped';
    await rt.saveItem(it);
  } else {
    return false;
  }
  if (p.handoff && p.handoff.key === itemKey) p.handoff = null;
  await clearMyExpecting(rt, itemKey);
  if (p.status === 'waiting' && p.waiting && p.waiting.itemKey === itemKey) p.waiting = null;
  await rt.save();
  if (p.status === 'waiting') rt.engine.continueRun(rt);
  rt.emit();
  return true;
}

/** '확인' 카드에서 [계속] */
export async function continueReview(rt) {
  const { p } = rt;
  const w = p.waiting;
  if (!w || w.kind !== 'review' || p.status !== 'waiting') return false;
  if (rt._planning) throw new Error(MSG.planning);
  if (w.key === 'review:lyrics') p.approvals = { ...(p.approvals || {}), lyrics: true };
  else if (w.key === 'review:drawings') p.drawingsApproved = true;
  p.waiting = null;
  await rt.save();
  rt.engine.continueRun(rt);
  return true;
}

// ───────────────────────── 다시 그리기 (한 장 · 한 장면) ─────────────────────────

/**
 * 그림 한 장 다시 그리기를 줄에 넣는다 (영상 만들기와 따로: 다른 고치기를 막지 않는다). 새 그림은 AI 앱에서 받아야 하므로 요청서를 돌려준다.
 * 옛 그림은 새 그림이 들어올 때 '예전 그림' 으로 옮겨진다.
 * @param {{note?:string, prompt?:string}} [o] note: 한국어로 '웃는 얼굴로' 같은 요청 · prompt: 영어 주문 글을 직접 고침(고급)
 */
export async function regenerate(rt, shotNo, id, { note, prompt } = {}) {
  const { p } = rt;
  if (rt.running && ['render', 'subtitles'].includes(p.currentStep)) throw new Error(MSG.runningNoRedraw);
  if (rt._planning) throw new Error(MSG.planning);
  const it = typeof id === 'string' ? rt.itemOf(shotNo, id) : null;
  if (!it || !rt.xs) throw new Error(MSG.noItem);
  const n = EC.normalizeNote(note);
  const pr = typeof prompt === 'string' && prompt.trim() && prompt !== it.prompt ? prompt : null;
  const dup = (p.redraws || []).find((r) => r.key === it.key);
  if (dup) {
    if (dup.status === 'queued') { dup.note = n; dup.prompt = pr; }
  } else {
    p.redraws = [...(p.redraws || []), { key: it.key, note: n, prompt: pr, requestedAt: rt.now(), status: 'queued' }];
  }
  p.handoff = { kind: kindOfItem(it), key: it.key, nonce: (p.handoff && p.handoff.key === it.key && p.handoff.nonce) || null, requestedAt: rt.now(), redraw: true };
  await rt.save();
  rt.emit();
  return request(rt);
}

/** 이 장면의 그림 전부 다시 그리기: 배경 판 → 열쇠 그림 차례로 (앞 그림을 고쳐서 다음 그림을 그려서 이어짐이 유지된다) */
export async function regenerateCut(rt, shotNo) {
  const { p, xs } = rt;
  if (rt.running && ['render', 'subtitles'].includes(p.currentStep)) throw new Error(MSG.runningNoRedraw);
  const shot = xs && shotOf(rt, shotNo);
  if (!shot) throw new Error(xs ? MSG.noShot : MSG.noXsheet);
  const keys = [];
  if (xs.layers) {
    const leader = xs.bgOf && xs.bgOf[shotNo] != null ? xs.bgOf[shotNo] : shotNo;
    if (rt.itemOf(leader, BG_ID)) keys.push(drawingKey(leader, BG_ID));
  }
  for (const d of shot.drawings) if (rt.itemOf(shotNo, d.id)) keys.push(drawingKey(shotNo, d.id));
  if (!keys.length) throw new Error(MSG.noItem);
  const have = new Set((p.redraws || []).map((r) => r.key));
  const add = keys.filter((k) => !have.has(k)).map((key) => ({ key, note: '', prompt: null, requestedAt: rt.now(), status: 'queued' }));
  p.redraws = [...(p.redraws || []), ...add];
  p.handoff = { kind: kindOfItem(rt.drawings.get(keys[0])), key: keys[0], nonce: null, requestedAt: rt.now(), redraw: true };
  await rt.save();
  rt.emit();
  return request(rt);
}

/** 다시 그리기 요청을 취소한다 (지금 그림은 그대로) */
export async function cancelRedraw(rt, key) {
  const { p } = rt;
  const before = (p.redraws || []).length;
  p.redraws = (p.redraws || []).filter((r) => r.key !== key);
  if (p.handoff && p.handoff.key === key && p.handoff.redraw) await closeRequest(rt, key);
  if (p.redraws.length === before) return false;
  await rt.save();
  rt.emit();
  return true;
}

// ───────────────────────── 캐릭터 만들기용 부탁 (기준 그림 3장 · 설명 정리) ─────────────────────────
// 캐릭터는 작품이 아니라서 id 를 'char:<캐릭터 id>' 로 쓴다. 엔진은 요청서와 검사만 하고, 결과(설명 · 그림)는 부른 쪽(캐릭터 화면)이 저장한다.

const charKey = (scopeId) => `handoff:${scopeId}`;

/**
 * @param {object} engine
 * @param {string} scopeId 'char:<id>'
 * @param {{kind:'describe', draft:{name?:string, description_ko?:string, personality_ko?:string}}|{kind:'ref', refKind:'turnaround'|'expressions'|'fullbody', character:object, art:string, attach?:Blob}} spec
 */
export async function requestCharacter(engine, scopeId, spec) {
  if (!String(scopeId).startsWith('char:')) throw new Error('캐릭터 id 는 char: 로 시작해야 해요.');
  const saved = spec.kind === 'ref' ? { kind: 'ref', refKind: spec.refKind, character: spec.character, art: spec.art } : { kind: 'describe', draft: spec.draft || {} };
  await engine.db.setMeta(charKey(scopeId), saved);
  let exp = await engine.db.getExpecting();
  if (!(exp && exp.projectId === scopeId && exp.kind === saved.kind)) exp = await engine.db.setExpecting({ projectId: scopeId, kind: saved.kind, key: scopeId });
  const apps = (engine.native && engine.native.AI_APPS) || {};
  const list = (text) => Object.entries(apps).filter(([, a]) => (a.good || []).includes(text ? 'text' : 'image')).map(([id, a]) => ({ id, name: a.name, pkg: a.pkg, preferred: false }));
  if (saved.kind === 'describe') {
    const prompt = P.describeCharacterPrompt(saved.draft) + nonceBlock(exp.nonce);
    return { kind: 'describe', key: scopeId, title: '캐릭터 설명 정리 부탁하기', prompt, files: [], nonce: exp.nonce, targetApps: list(true), expectsText: true, expectsImages: 0, redraw: false, hint: 'AI 앱의 답장 글 전체를 복사해서 붙여넣어 주세요.' };
  }
  const prompt = P.characterSheetPrompt(saved.refKind, saved.character, saved.art);
  const files = spec.attach ? [{ name: '01_reference.png', blob: spec.attach, note: 'the first character sheet: match it exactly' }] : [];
  return { kind: 'ref', key: scopeId, title: `캐릭터 기준 그림 부탁하기 (${saved.refKind})`, prompt: imageText({ prompt, refs: files, aspect: '1:1' }), files, nonce: exp.nonce, targetApps: list(false), expectsText: false, expectsImages: 1, redraw: false, hint: '만든 그림을 AnimeMaker V2 로 공유해 주세요.' };
}

/** 캐릭터 설명 답장 검사: 맞으면 { ok:true, applied:'describe', value:{locked,palette,rules} } (저장은 부른 쪽이) */
export async function acceptCharacterText(engine, scopeId, text, { force = false } = {}) {
  const exp = await engine.db.getExpecting();
  const saved = await engine.db.getMeta(charKey(scopeId), null);
  if (!exp || exp.projectId !== scopeId || !saved || saved.kind !== 'describe') return fail('noRequest', '지금은 받을 캐릭터 설명 답장이 없어요.');
  const prompt = P.describeCharacterPrompt(saved.draft) + nonceBlock(exp.nonce);
  const res = checkReply({ text, prompt, nonce: exp.nonce, kind: 'describe', force });
  if (!res.ok) return res;
  await engine.db.clearExpecting(exp.nonce).catch(() => {});
  const { request_id: _r, requestId: _q, nonce: _n, ...value } = res.obj; // eslint-disable-line no-unused-vars
  return { ok: true, applied: 'describe', value, message: '캐릭터 설명을 받았어요.' };
}

/** 캐릭터 기준 그림 받기: 그림을 줄여서(1536px) 돌려준다 — 저장은 부른 쪽이 */
export async function acceptCharacterFiles(engine, scopeId, files) {
  const exp = await engine.db.getExpecting();
  const img = (files || []).find(isImage);
  if (!img) return { placed: [], pending: files || [], failed: [], message: '그림 파일이 없어요.' };
  const r = await engine.services.ingest(img.blob, { kind: 'pic' });
  if (exp && exp.projectId === scopeId) await engine.db.clearExpecting(exp.nonce).catch(() => {});
  return { placed: [{ key: scopeId, kind: 'ref', blob: r.orig, name: img.name || '', w: r.w, h: r.h }], pending: [], failed: [], message: '기준 그림을 받았어요.' };
}

