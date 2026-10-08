// 🧒 주인공: 목록 + 간단 편집기 (이름 · 어떻게 생겼나요? · 그림 느낌 · AI 앱에 부탁해서 그리기 · 그림 3장 · 이 모습으로 정하기)
// 주인공 한 명당 시리즈("<이름> 이야기")가 정할 때 저절로 생긴다. 편집 내용은 멈추면 저절로 저장돼요.
import { h, clear, toast, confirmBox, pickFile } from '../ui.js';
import * as db from '../db.js';
import { CC, SC, D } from '../engine/shared.js';
import { createHandoffCard } from './handoff.js';
import { josa, buzz, put } from './projects-util.js';

const KINDS = ['turnaround', 'expressions', 'fullbody'];
const KIND_NAME = { turnaround: '앞·옆·뒤 모습', expressions: '표정 모음', fullbody: '전신' };
const KIND_ICON = { turnaround: '🧍', expressions: '😊', fullbody: '🕺' };
const ART_FRIENDLY = [
  { emoji: '🌿', name: '손그림 극장 애니', desc: '또렷한 선, 포근한 색' },
  { emoji: '🏰', name: '동화 장편 애니', desc: '반짝이는 배경, 동화책 느낌' },
  { emoji: '🧸', name: '수채화 그림책', desc: '물감 번짐, 종이 질감' },
  { emoji: '🌃', name: '90년대 TV 만화', desc: '굵은 선, 진한 색' },
];
const NAME_EMPTY = '새 주인공';

/** .amchar 는 PNG/JPEG 만 담는다. 앱 안의 기준 그림은 줄인 WebP 라서 내보낼 때 PNG 로 바꾼다 */
async function pngBytes(blob) {
  const raw = new Uint8Array(await blob.arrayBuffer());
  const png = raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47;
  const jpg = raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff;
  if (png || jpg) return raw;
  const bmp = await createImageBitmap(blob);
  const cv = document.createElement('canvas');
  cv.width = bmp.width; cv.height = bmp.height;
  cv.getContext('2d').drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
  const out = await new Promise((res) => cv.toBlob(res, 'image/png'));
  return new Uint8Array(await out.arrayBuffer());
}

// ───────────────────────── 읽기 도우미 (만들기 화면도 쓴다) ─────────────────────────

/** 주인공 목록: [{ c: 캐릭터, s: 시리즈|null, locked, practice }] (최근 순) */
export async function loadHeroes() {
  const [chars, series] = await Promise.all([db.listCharacters(), db.listSeries()]);
  return chars.map((c) => {
    const s = series.find((x) => x.characterIds[0] === c.id) || series.find((x) => x.characterIds.includes(c.id)) || null;
    return { c, s, locked: !!c.lockedAt, practice: !!(s && s.name === '연습 시리즈') };
  });
}
/** 영상에 쓸 수 있는 주인공 (잠겨 있고 시리즈가 있는 것) */
export const readyHeroes = (list) => list.filter((x) => x.locked && x.s);

/** 대표 그림 한 장 (전신 > 앞·옆·뒤 > 표정 > 그 밖) → Blob | null */
export async function heroThumb(c) {
  for (const k of ['fullbody', 'turnaround', 'expressions', 'other']) {
    const r = (c.refs || []).find((x) => x.kind === k && x.blobKey);
    if (r) { const b = await db.getFile(r.blobKey); if (b) return b; }
  }
  return null;
}
const heroName = (c) => (c && c.name && c.name !== NAME_EMPTY ? c.name : '');
const hasEnglish = (c) => !!(c && c.locked && Object.values(c.locked).some(Boolean));

async function ensureSeriesFor(c, artIdx) {
  const all = await db.listSeries();
  const found = all.find((s) => s.characterIds[0] === c.id);
  const art = (D.ART_PRESETS[artIdx] || D.ART_PRESETS[0])[1];
  if (found) {
    found.name = `${heroName(c) || '주인공'} 이야기`;
    found.bible = { ...found.bible, art_en: art };
    return db.putSeries(found);
  }
  return db.putSeries(SC.normalizeSeries({ id: SC.newSeriesId(), name: `${heroName(c) || '주인공'} 이야기`, emoji: '🌻', characterIds: [c.id], bible: { art_en: art } }));
}

async function deleteHero(c) {
  for (const s of await db.listSeries()) {
    if (s.characterIds[0] === c.id) await db.deleteSeries(s.id);
    else if (s.characterIds.includes(c.id)) { s.characterIds = s.characterIds.filter((x) => x !== c.id); await db.putSeries(s); }
  }
  await db.deleteCharacter(c.id);
  await db.deleteFiles(`char/${c.id}/`).catch(() => {});
}

// ───────────────────────── 화면 ─────────────────────────

/** @returns {Promise<{el:HTMLElement, destroy:()=>void}>} */
export async function heroScreen(app, params = {}) {
  const urls = [];
  const url = (b) => { const u = URL.createObjectURL(b); urls.push(u); return u; };
  const root = h('div', { class: 'hero-screen' });
  let cleanup = () => {};
  const destroy = () => { cleanup(); urls.forEach((u) => URL.revokeObjectURL(u)); };

  if (params.id) { cleanup = await editor(app, root, params, url); } else { await list(app, root, url); }
  return { el: root, destroy };
}

async function list(app, root, url) {
  const heroes = (await loadHeroes()).sort((a, b) => (b.c.updatedAt || 0) - (a.c.updatedAt || 0));
  root.appendChild(h('h1', { class: 'page-title' }, '🧒 주인공'));
  if (!heroes.length) {
    root.appendChild(h('div', { class: 'card empty', id: 'hero-empty' }, h('p', null, '아직 주인공이 없어요.'), h('p', { class: 'small muted' }, '주인공은 내 영상에 계속 나오는 인물이에요. 한 번 정해 두면 다음 영상에서도 똑같이 그려요.')));
  }
  const grid = h('div', { class: 'hero-list' });
  for (const x of heroes) {
    const thumb = h('div', { class: 'hero-thumb' }, '🧒');
    heroThumb(x.c).then((b) => { if (b) thumb.replaceChildren(h('img', { src: url(b), alt: `${heroName(x.c) || '주인공'} 그림` })); }).catch(() => {});
    grid.appendChild(h('button', { class: 'card hero-card', 'data-id': x.c.id, onclick: () => app.go('hero', { id: x.c.id }) },
      thumb,
      h('div', { class: 'grow tl' },
        h('div', { class: 'hero-name' }, `${heroName(x.c) || '이름 없는 주인공'} ${x.locked ? '🔒' : ''}`),
        h('div', { class: 'small muted' }, x.locked ? `지난 이야기 ${x.s ? (x.s.episodes || []).length : 0}편` : '만드는 중이에요 (아직 안 정했어요)'),
        x.practice ? h('span', { class: 'pill' }, '연습용') : null)));
  }
  root.appendChild(grid);
  root.appendChild(h('button', { class: 'btn primary big', id: 'btn-new-hero', onclick: () => { buzz(); app.go('hero', { id: 'new' }); } }, '＋ 새 주인공'));
  if (!heroes.some((x) => x.practice)) {
    root.appendChild(h('button', { class: 'btn ghost', id: 'btn-practice-hero', onclick: async () => { await app.engine.demo.ensureSeries(); toast('연습용 주인공 "하루" 가 생겼어요', 'ok'); app.go('hero', {}); } }, '☔ 연습용 주인공 만들기'));
  }
}

async function editor(app, root, params, url) {
  const { engine } = app;
  const N = app.native;
  let c = params.id !== 'new' ? await db.getCharacter(params.id) : null;
  if (params.id !== 'new' && !c) { root.appendChild(h('div', { class: 'card' }, h('h3', null, '주인공을 찾을 수 없어요'), h('button', { class: 'btn', onclick: () => app.go('hero', {}) }, '목록으로'))); return () => {}; }
  let ser = c ? (await db.listSeries()).find((s) => s.characterIds[0] === c.id) || null : null;
  let artIdx = ser ? Math.max(0, D.ART_PRESETS.findIndex(([, v]) => v === ser.bible.art_en)) : (c && Number.isInteger(c.artIdx) ? c.artIdx : 0);
  let flow = null; // { steps, i, card }
  let saveTimer = 0;
  let dead = false;
  const initial = { name: params.name || '', desc: params.desc || '' };
  const pop = app.pushBack(() => { app.go('hero', {}); return true; });
  const locked = () => !!(c && c.lockedAt);

  const saved = h('span', { class: 'saved', 'aria-live': 'polite', id: 'hero-saved' }, '');
  const nameIn = h('input', { type: 'text', id: 'hero-name', maxlength: 40, placeholder: '예: 하루', 'aria-label': '이름', value: c ? heroName(c) : initial.name });
  const descIn = h('textarea', { id: 'hero-desc', rows: 4, maxlength: 600, placeholder: '예: 짧은 갈색 머리, 노란 우비와 빨간 목도리, 갈색 장화를 신은 씩씩한 열두 살 여자아이', 'aria-label': '어떻게 생겼나요?' });
  descIn.value = c ? (c.description_ko || '') : initial.desc;
  const hint = h('div', { class: 'ho-msg err', role: 'status', id: 'hero-hint', style: { display: 'none' } });
  const setHint = (t) => { hint.textContent = t || ''; hint.style.display = t ? '' : 'none'; };
  const slotsBox = h('div', { class: 'hero-slots', id: 'hero-slots' });
  const flowBox = h('div', { class: 'hero-flow', id: 'hero-flow' });
  const actions = h('div', { class: 'hero-actions' });
  const advanced = h('div');

  /** 처음 의미 있는 입력이 생기면 기록을 만든다 (빈 '새 주인공' 은 만들지 않는다) */
  async function ensureRecord() {
    if (c) return c;
    const base = CC.normalizeCharacter({ id: db.newId('char'), name: nameIn.value.trim() || NAME_EMPTY, description_ko: descIn.value.trim() });
    c = { ...base, refs: [], artIdx };
    await db.putCharacter(c);
    return c;
  }
  async function saveFields() {
    if (locked()) return;
    const name = nameIn.value.trim();
    const desc = descIn.value.trim();
    if (!c && !name && !desc) return;
    await ensureRecord();
    c.name = name || NAME_EMPTY;
    c.description_ko = desc;
    c.artIdx = artIdx;
    await db.putCharacter(c);
    saved.textContent = '저장됨 ✓';
  }
  const later = () => { saved.textContent = '저장하는 중…'; clearTimeout(saveTimer); saveTimer = setTimeout(() => saveFields().catch((e) => toast(e.message, 'err')), 600); };
  nameIn.addEventListener('input', later);
  descIn.addEventListener('input', later);

  // ── 그림 3칸 ──
  async function putRef(kind, blob) {
    await ensureRecord();
    const old = (c.refs || []).filter((r) => r.kind === kind);
    const key = `char/${c.id}/${Date.now().toString(36)}${Math.floor(Math.random() * 1e3)}`;
    await db.putFile(key, blob);
    c.refs = [...(c.refs || []).filter((r) => r.kind !== kind), { kind, label: KIND_NAME[kind] || kind, mime: blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', blobKey: key }];
    c.refs.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
    await db.putCharacter(c);
    for (const r of old) if (r.blobKey) await db.deleteFile(r.blobKey).catch(() => {});
  }
  const fillEnglish = () => {
    if (!hasEnglish(c) && c.description_ko) c.locked = { ...c.locked, summary: c.description_ko }; // 정리를 건너뛰면 쓴 글을 그대로 쓴다
  };
  async function ownPicture(kind) {
    const f = await pickFile('image/*');
    if (!f) return;
    await ensureRecord();
    const r = await engine.handoff.acceptFiles(`char:${c.id}`, [{ name: f.name, mime: f.type, blob: f }]);
    if (!r.placed.length) { toast(r.message || '그림을 읽지 못했어요', 'warn'); return; }
    await putRef(kind, r.placed[0].blob);
    toast('그림을 넣었어요', 'ok');
    paint();
  }

  // ── AI 앱에 부탁해서 그리기 (설명 정리 → 그림 3장, 한 번에 하나씩) ──
  const specOf = async (step) => {
    const art = (D.ART_PRESETS[artIdx] || D.ART_PRESETS[0])[1];
    if (step === 'describe') return { kind: 'describe', draft: { name: c.name, description_ko: c.description_ko, personality_ko: c.personality_ko || '' } };
    fillEnglish();
    const first = (c.refs || []).find((r) => r.kind === 'turnaround' && r.blobKey);
    const attach = step !== 'turnaround' && first ? await db.getFile(first.blobKey) : null;
    return { kind: 'ref', refKind: step, character: { ...c, refs: [] }, art, ...(attach ? { attach } : {}) };
  };
  function showStep() {
    if (flow && flow.card) flow.card.destroy();
    clear(flowBox);
    if (!flow) return;
    const step = flow.steps[flow.i];
    const total = flow.steps.length;
    const label = step === 'describe' ? '설명 정리 받기' : `${KIND_NAME[step]} 그림 받기`;
    const card = createHandoffCard({
      app, engine, id: `char:${c.id}`,
      stepLabel: `${flow.i + 1}/${total} ${label}`,
      request: async () => ({ ...(await engine.handoff.requestCharacter(`char:${c.id}`, await specOf(step))), title: step === 'describe' ? '생김새 설명 정리 부탁하기' : `${KIND_NAME[step]} 그림 부탁하기` }),
      send: (appId, req) => N.sendToApp(appId, { text: req.prompt, files: (req.files || []).map((f) => ({ blob: f.blob, name: f.name })) }),
      skip: step === 'describe' ? async () => advance() : undefined,
      onAccepted: async (r) => {
        if (step === 'describe') {
          const v = r.value || {};
          c.locked = v.locked || c.locked; c.palette = v.palette || c.palette; c.rules = v.rules || c.rules;
          c = { ...CC.normalizeCharacter(c), refs: c.refs, artIdx };
          await db.putCharacter(c);
        } else if (r.placed && r.placed[0]) await putRef(step, r.placed[0].blob);
        await advance();
      },
    });
    flow.card = card;
    put(flowBox, 
      h('div', { class: 'card flow-head' }, h('b', null, '🎨 AI 앱에 부탁해서 그리고 있어요'), h('div', { class: 'small muted' }, `${flow.i + 1}/${total} · 한 번에 하나씩 부탁해요`), h('button', { class: 'btn small', id: 'flow-stop', onclick: () => { stopFlow(); } }, '그만두기')),
      card.el);
  }
  async function advance() {
    if (!flow) return;
    flow.i++;
    if (flow.i >= flow.steps.length) { stopFlow(); toast('다 그렸어요! 그림을 보고 [이 모습으로 정하기] 를 눌러요', 'ok', 5000); return; }
    showStep();
    paint();
  }
  function stopFlow() {
    if (flow && flow.card) flow.card.destroy();
    flow = null;
    clear(flowBox);
    db.clearExpecting().catch(() => {});
    paint();
  }
  async function startFlow(steps) {
    setHint('');
    const name = nameIn.value.trim();
    const desc = descIn.value.trim();
    if (!name) { setHint('이름을 적어 주세요.'); nameIn.focus(); return; }
    if (!desc) { setHint('"어떻게 생겼나요?" 를 적어 주세요. 몇 줄이면 돼요.'); descIn.focus(); return; }
    buzz();
    await saveFields();
    flow = { steps, i: 0, card: null };
    showStep();
    paint();
    flowBox.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  // ── 정하기 · 고치기 ──
  async function lockNow() {
    setHint('');
    if (!c || !(c.refs || []).length) { setHint('그림이 한 장도 없어요. 먼저 AI 앱에 부탁해서 그리거나 [📁 내 그림으로] 넣어 주세요.'); return; }
    if (!nameIn.value.trim()) { setHint('이름을 적어 주세요.'); nameIn.focus(); return; }
    await saveFields();
    if (!hasEnglish(c) && !c.description_ko) { setHint('"어떻게 생겼나요?" 를 적어 주세요. AI 가 그림을 그릴 때 이 설명을 읽어요.'); descIn.focus(); return; }
    fillEnglish();
    c.lockedAt = Date.now();
    c.artIdx = artIdx;
    await db.putCharacter(c);
    ser = await ensureSeriesFor(c, artIdx);
    toast(`✅ ${heroName(c)}${josa(heroName(c), '이', '가')} 정해졌어요!`, 'ok');
    if (params.returnTo === 'home') { app.go('home'); return; }
    paint();
  }
  async function unlockNow() {
    if (!(await confirmBox('모습을 고칠까요?', '고치는 동안에는 영상에 쓸 수 없어요.\n다 고친 뒤 [이 모습으로 정하기] 를 다시 누르면 돼요.\n이미 만든 영상은 예전 모습 그대로 남아요.', '✏️ 고치기'))) return;
    c.lockedAt = null;
    await db.putCharacter(c);
    paint();
  }

  // ── 그리기 ──
  function slot(kind) {
    const ref = c && (c.refs || []).find((r) => r.kind === kind);
    const frame = h('div', { class: 'hb-frame' }, ref ? '…' : h('span', { class: 'muted' }, KIND_ICON[kind]));
    if (ref && ref.blobKey) db.getFile(ref.blobKey).then((b) => { if (b && !dead) frame.replaceChildren(h('img', { src: url(b), alt: KIND_NAME[kind] })); }).catch(() => {});
    return h('div', { class: 'hb-slot', 'data-kind': kind },
      frame, h('div', { class: 'small' }, `${KIND_ICON[kind]} ${KIND_NAME[kind]}`),
      locked() ? null : h('div', { class: 'row tight' },
        h('button', { class: 'btn small', 'data-act': 'redo', disabled: !!flow, onclick: () => startFlow([kind]).catch((e) => toast(e.message, 'err')) }, '🔄 다시 부탁하기'),
        h('button', { class: 'btn small', 'data-act': 'own', onclick: () => ownPicture(kind).catch((e) => toast(e.message, 'err')) }, '📁 내 그림으로')));
  }
  function paint() {
    if (dead) return;
    const lk = locked();
    nameIn.disabled = lk; descIn.disabled = lk;
    clear(slotsBox);
    put(slotsBox, h('div', { class: 'hero-pics' }, KINDS.map(slot)));
    clear(actions);
    if (lk) {
      put(actions, h('div', { class: 'card ok-card' }, h('b', null, `🔒 ${heroName(c)}${josa(heroName(c), '은', '는')} 정해졌어요`), h('p', { class: 'small' }, '이제 [🎬 만들기] 에서 이 주인공으로 영상을 만들 수 있어요.')),
        h('button', { class: 'btn primary big', id: 'hero-make', onclick: () => app.go('home', { seriesId: ser && ser.id }) }, '🎬 이 주인공으로 영상 만들기'),
        h('button', { class: 'btn', id: 'hero-unlock', onclick: () => unlockNow().catch((e) => toast(e.message, 'err')) }, '✏️ 모습 고치기'));
    } else {
      const n = (c && (c.refs || []).length) || 0;
      put(actions, 
        h('div', { class: 'card' },
          h('b', null, '🎨 그림은 어떻게 만들까요?'),
          h('p', { class: 'small muted' }, 'AI 앱에 부탁해서 주인공 그림 3장을 받아요. 부탁은 모두 4번이에요 (설명 정리 1번 + 그림 3번). 설명 정리는 건너뛸 수도 있어요.'),
          h('button', { class: 'btn primary big', id: 'hero-draw', disabled: !!flow, onclick: () => startFlow(['describe', ...KINDS]).catch((e) => toast(e.message, 'err')) }, '🎨 AI 앱에 부탁해서 그리기'),
          h('button', { class: 'btn small', id: 'hero-draw3', disabled: !!flow, onclick: () => startFlow(KINDS.slice()).catch((e) => toast(e.message, 'err')) }, '설명 정리는 건너뛰고 그림 3장만 부탁하기')),
        hint,
        h('button', { class: 'btn primary big', id: 'hero-lock', onclick: () => { buzz(); lockNow().catch((e) => toast(e.message, 'err')); } }, '✅ 이 모습으로 정하기'),
        n ? null : h('p', { class: 'small muted' }, '그림이 한 장이라도 있어야 정할 수 있어요.'));
    }
    clear(advanced);
    put(advanced, h('details', { class: 'card fold', id: 'hero-adv' }, h('summary', null, '고급'),
      h('div', { class: 'row' },
        c && lk ? h('button', { class: 'btn small', id: 'hero-export', onclick: () => exportAmchar().catch((e) => toast(e.message, 'err')) }, '📤 캐릭터 파일로 내보내기') : null,
        h('button', { class: 'btn small', id: 'hero-import', onclick: () => importAmchar().catch((e) => toast(e.message, 'err')) }, '📥 캐릭터 파일 가져오기'),
        c ? h('button', { class: 'btn small danger', id: 'hero-delete', onclick: () => removeHero().catch((e) => toast(e.message, 'err')) }, '🗑 이 주인공 지우기') : null)));
  }
  async function exportAmchar() {
    const refs = c.refs || [];
    const bufs = [];
    for (const r of refs) bufs.push(await pngBytes(await db.getFile(r.blobKey)));
    const json = CC.toAmchar({ ...c, refs: refs.map((r) => ({ file: '', kind: r.kind, label: r.label, mime: r.mime })) }, bufs);
    await N.shareFile(new Blob([JSON.stringify(json)], { type: 'application/json' }), `${heroName(c) || '주인공'}.amchar`, 'AnimeMaker V2 캐릭터 파일');
  }
  async function importAmchar() {
    const f = await pickFile('.amchar,application/json,*/*');
    if (!f) return;
    const got = CC.fromAmchar(await f.text());
    const id = db.newId('char');
    const refs = [];
    for (let i = 0; i < got.refs.length; i++) {
      const key = `char/${id}/${i}`;
      await db.putFile(key, new Blob([got.refs[i].buffer], { type: got.refs[i].mime }));
      refs.push({ kind: got.refs[i].kind, label: got.refs[i].label, mime: got.refs[i].mime, blobKey: key });
    }
    const nc = { ...got.character, id, refs, artIdx: 0 };
    await db.putCharacter(nc);
    if (nc.lockedAt) await ensureSeriesFor(nc, 0);
    toast(`"${heroName(nc)}" 를 가져왔어요`, 'ok');
    app.go('hero', { id });
  }
  async function removeHero() {
    if (!(await confirmBox('주인공을 지울까요?', `"${heroName(c) || '이름 없는 주인공'}"${josa(heroName(c) || '이름 없는 주인공', '을', '를')} 지워요.\n지난 이야기 기록도 함께 사라져요. 이미 만든 영상은 그대로 남아요.`, '🗑 지우기'))) return;
    await deleteHero(c);
    toast('지웠어요', 'ok');
    app.go('hero', {});
  }

  // ── 그림 느낌 ──
  const artChips = h('div', { class: 'art-chips', id: 'hero-art' }, ART_FRIENDLY.map((a, i) => h('button', {
    class: `art-chip${i === artIdx ? ' on' : ''}`, 'data-i': i, type: 'button',
    onclick: () => {
      if (locked()) return;
      artIdx = i;
      artChips.querySelectorAll('.art-chip').forEach((b, j) => b.classList.toggle('on', j === i));
      later();
    },
  }, h('b', null, `${a.emoji} ${a.name}`), h('span', { class: 'small muted' }, a.desc))));

  put(root, 
    h('button', { class: 'btn small back-link', id: 'hero-back', onclick: () => app.go('hero', {}) }, '← 주인공 목록'),
    h('h1', { class: 'page-title' }, '🧒 주인공 만들기'),
    h('div', { class: 'card' },
      h('label', { class: 'lbl', for: 'hero-name' }, '이름'), nameIn,
      h('label', { class: 'lbl', for: 'hero-desc' }, '어떻게 생겼나요?'), descIn,
      h('div', { class: 'lbl' }, '그림 느낌'), artChips,
      saved),
    flowBox, h('h2', null, '그림 3장'), slotsBox, actions, advanced);
  paint();
  if (params.startDraw && nameIn.value.trim() && descIn.value.trim() && !locked()) startFlow(['describe', ...KINDS]).catch((e) => toast(e.message, 'err'));

  return () => { dead = true; clearTimeout(saveTimer); pop(); if (flow && flow.card) flow.card.destroy(); };
}
