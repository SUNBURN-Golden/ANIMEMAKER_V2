// AI 앱에 부탁하고 답을 받아 오는 카드 (영상 하나 화면과 주인공 만들기가 같이 쓴다) + 받은 함 + 알림 설명 창.
//
//   createHandoffCard({ app, engine, id, request, send, skip?, fallbackXsheet?, onAccepted?, stepLabel? }) → { el, update(snap), reload(), destroy() }
//     ① 부탁하기: 지금 부탁할 것 하나 · 쓸 AI 앱 · 큰 [1. 부탁하기 ▶]
//     ② 받아 와요: 글 답장은 [📋 복사한 답장 붙여넣기] → 미리 보고 [네 쓸게요], 그림은 AI 앱에서 [공유] → AnimeMaker V2 (받은 그림이 자리를 찾아가요)
//   renderTrayList(...)  받았지만 자리를 못 찾은 것 (그림 미리보기 + 한 번에 넣기 + 지우기)
//   ensureNotify(app)    첫 긴 일 전에 한 번: "화면을 꺼도 계속 만들 수 있게 알림을 켤게요"
import { h, clear, toast, bottomSheet, pickFile } from '../ui.js';
import { withJosa } from '../josa.js';
import * as db from '../db.js';
import { isEcho } from '../engine/index.js';
import { buzz } from './projects-util.js';

const ICON = { plan: '📝', xsheet: '📋', bg: '🏞', cel: '🧒', describe: '📝', ref: '🖼' };
const isTextReq = (r) => !!r && r.expectsText;

export const titleOfDrawing = (d) => (d.kind === 'bg' ? `배경 · 장면 ${d.shot}` : `인물 · 장면 ${d.shot}-${d.id}`);

// ───────────────────────── 알림 설명 (첫 긴 일 전에 한 번) ─────────────────────────

/** 첫 영상 만들기·긴 일 전에 한 번 설명하고 고르게 한다. 어느 쪽을 골라도 이어서 한다 */
export async function ensureNotify(app) {
  if (app.prefs.notify) return app.prefs.notify;
  const sheet = bottomSheet({
    title: '🔔 알림을 켤까요?',
    body: h('div', null,
      h('p', { class: 'pre' }, '영상을 만드는 동안 화면을 꺼도 계속 만들 수 있게 알림을 켤게요.'),
      h('p', { class: 'small muted' }, '알림을 켜면 위쪽 알림줄에 "만드는 중" 이 보이고, 폰이 앱을 멈추지 않아요. 안 켜도 괜찮아요. 그때는 만드는 동안 화면을 켜 둬 주세요.')),
    buttons: [
      { label: '🔔 알림 켜기', kind: 'primary', value: 'on' },
      { label: '화면 켜 둔 채로 할게요', value: 'screen' },
    ],
    closeLabel: null,
    sticky: true,
  });
  const v = await sheet.result;
  if (v === 'on') {
    const r = await app.native.requestNotificationPermission();
    await app.setPref('notify', r.granted ? 'on' : 'denied');
    if (!r.granted) toast('알림이 꺼져 있어요. 만드는 동안 화면을 켜 둬 주세요.', 'warn', 4500);
    return app.prefs.notify;
  }
  if (v === 'screen') { await app.setPref('notify', 'screen'); return 'screen'; }
  return 'later'; // 그냥 닫았으면 이번에는 그냥 이어서 하고 다음에 또 물어본다
}

// ───────────────────────── 받은 함 ─────────────────────────

async function trayBlob(itemId) {
  const [entryId, n] = String(itemId).split('#');
  const rec = await db.getInbox(entryId);
  const it = rec && (rec.items || []).find((x) => String(x.key).split('/').pop() === n);
  return it ? db.getFile(it.key) : null;
}

/**
 * 받은 함 목록 (그림은 작은 미리보기 + [여기에 쓰기]/[어디에 쓸까요?] + [지우기], 글은 [이 글을 답장으로 쓰기]).
 * @param {{app:object, engine:object, id:string|null, items:object[], snap?:object, urls:string[], onChange:()=>void, projects?:object[]}} o
 *   id 가 null 이면 영상을 고르는 시트를 띄운다 (만들기 화면의 "받은 그림")
 */
export function renderTrayList(o) {
  const { app, engine, id, items, snap, onChange } = o;
  if (!items.length) return null;
  const rows = items.map((it) => {
    const thumb = h('div', { class: 'tray-thumb' }, it.kind === 'image' ? '🖼' : it.kind === 'text' ? '📝' : '📄');
    if (it.kind === 'image') {
      trayBlob(it.itemId).then((b) => {
        if (!b) return;
        const u = URL.createObjectURL(b);
        o.urls.push(u);
        thumb.replaceChildren(h('img', { src: u, alt: it.name || '받은 그림' }));
      }).catch(() => {});
    }
    const place = async (key, force) => {
      buzz();
      const target = id || (await pickProject(app, engine));
      if (!target) return;
      const r = await engine.handoff.place(target, it.itemId, key || null, { force: !!force });
      if (r && r.text) {
        if (r.text.ok) toast(r.text.message || '답장을 받았어요', 'ok');
        else if (r.text.reason === 'noNonce') {
          const go = await bottomSheet({ title: '이 답장을 쓸까요?', body: h('p', { class: 'pre' }, r.text.message), buttons: [{ label: '아니요', value: false }, { label: '그래도 이 답장 쓰기', kind: 'primary', value: true }] }).result;
          if (go) return place(key, true);
        } else toast(r.text.message, 'warn', 5000);
      } else if (r && r.placed && r.placed.length) { toast(`그림 ${r.placed.length}장을 넣었어요`, 'ok'); if (o.onPlaced) await o.onPlaced(r); }
      else toast((r && (r.failed && r.failed[0] ? r.failed[0].message : r.message)) || '넣을 자리를 찾지 못했어요', 'warn', 5000);
      onChange();
    };
    const acts = h('div', { class: 'tray-acts' });
    if (it.kind === 'image') {
      if (it.suggest) acts.appendChild(h('button', { class: 'btn primary small', onclick: () => place(it.suggest.key).catch((e) => toast(e.message, 'err')) }, `✔ 여기에 쓰기 · ${it.suggest.title}`));
      else if (id) acts.appendChild(h('button', { class: 'btn primary small', onclick: () => place(null).catch((e) => toast(e.message, 'err')) }, '✔ 다음 빈 자리에 쓰기'));
      else acts.appendChild(h('button', { class: 'btn primary small', onclick: () => place(null).catch((e) => toast(e.message, 'err')) }, '어느 영상에 쓸까요?'));
      if (id && snap) acts.appendChild(h('button', { class: 'btn small', onclick: async () => { const k = await slotSheet(snap); if (k) place(k).catch((e) => toast(e.message, 'err')); } }, '어디에 쓸까요?'));
    } else if (it.kind === 'text') {
      acts.appendChild(h('button', { class: 'btn primary small', onclick: () => place(null).catch((e) => toast(e.message, 'err')) }, '📝 이 글을 답장으로 쓰기'));
    }
    acts.appendChild(h('button', { class: 'btn small danger', onclick: async () => { await engine.handoff.discard(id || '', it.itemId); onChange(); } }, '지우기'));
    return h('li', { class: 'tray-item' }, thumb, h('div', { class: 'grow' }, h('div', { class: 'small' }, it.kind === 'text' ? (it.text || '').slice(0, 70) || '받은 글' : (it.name || '받은 파일')), acts));
  });
  return h('div', { class: 'tray' }, h('div', { class: 'ho-h' }, `📥 받은 것 ${items.length}개 — 어디에 쓸까요?`), h('ul', { class: 'tray-list' }, rows));
}

/** 빈 자리 고르기 시트 → 칸 키 (닫으면 null) */
function slotSheet(snap) {
  const open = (snap.drawings || []).filter((d) => d.status !== 'done');
  if (!open.length) { toast('비어 있는 자리가 없어요.', 'warn', 4000); return Promise.resolve(null); }
  let sheet;
  const list = h('div', { class: 'slot-list' }, open.slice(0, 60).map((d) => h('button', { class: 'btn slot-btn', 'data-key': d.key, onclick: () => sheet.close(d.key) }, `${d.kind === 'bg' ? '🏞' : '🧒'} ${titleOfDrawing(d)}`)));
  sheet = bottomSheet({ title: '어디에 쓸까요?', body: list });
  return sheet.result;
}

/** 어느 영상에 쓸지 고르기 (만들기 화면의 받은 그림용) → 작품 id | null */
async function pickProject(app, engine) {
  const rows = (await engine.projects.list()).filter((r) => r.status !== 'done');
  if (!rows.length) { toast('그림을 받을 영상이 없어요. 먼저 영상을 만들기 시작해 주세요.', 'warn', 5000); return null; }
  if (rows.length === 1) return rows[0].id;
  let sheet;
  sheet = bottomSheet({
    title: '어느 영상에 쓸까요?',
    body: h('div', { class: 'slot-list' }, rows.map((r) => h('button', { class: 'btn slot-btn', onclick: () => sheet.close(r.id) }, `🎬 ${r.title || '이름 없는 영상'}`))),
  });
  return sheet.result;
}

// ───────────────────────── 부탁/받기 카드 ─────────────────────────

/**
 * @param {object} o
 * @param {object} o.app
 * @param {object} o.engine
 * @param {string} o.id 작품 id 또는 'char:<id>'
 * @param {()=>Promise<object|null>} o.request 지금 부탁할 것 (engine.handoff.request 모양)
 * @param {(appId:string, req:object)=>Promise<{direct?:boolean}>} o.send
 * @param {(req:object)=>Promise<any>} [o.skip] 그림 건너뛰기 (없으면 버튼이 없다)
 * @param {()=>Promise<any>} [o.fallbackXsheet] AI 없이 PC 방식으로 짜기
 * @param {(r:object)=>Promise<void>|void} [o.onAccepted] 글/그림을 받았을 때
 * @param {string} [o.stepLabel] 예: '1/4 설명 받기'
 */
export function createHandoffCard(o) {
  const { app, engine, id } = o;
  const N = app.native;
  const el = h('section', { class: 'card ho', 'aria-label': 'AI 앱에 부탁하기' });
  const S = { req: null, sent: false, appId: null, reply: null, result: null, busy: false, recent: [], tray: [], seen: null, snap: null, sig: '', chooser: false, urls: [] };
  let dead = false;
  let loading = Promise.resolve();

  const revoke = () => { S.urls.forEach((u) => URL.revokeObjectURL(u)); S.urls = []; };
  const makeUrl = (blob) => { const u = URL.createObjectURL(blob); S.urls.push(u); return u; };

  async function loadTray() {
    try { S.tray = await engine.handoff.tray(id); } catch (_) { S.tray = []; }
  }
  async function load() {
    try {
      S.req = await o.request();
      const rec = S.req ? await db.getMeta('handoffSent', null) : null;
      S.sent = !!(S.req && rec && rec.nonce === S.req.nonce);
      if (!S.req) S.sent = false;
    } catch (e) {
      S.req = null;
      S.result = { ok: false, message: (e && e.message) || String(e) };
    }
    S.reply = null;
    await loadTray();
    paint();
  }
  const reload = () => { loading = load(); return loading; };

  // ── 동작 ──
  const appChoice = () => {
    const apps = (S.req && S.req.targetApps) || [];
    return S.appId && apps.some((a) => a.id === S.appId) ? S.appId : (apps.find((a) => a.preferred) || apps[0] || {}).id;
  };
  async function doSend() {
    if (S.busy || !S.req) return;
    buzz();
    S.busy = true; S.result = null; paint();
    try {
      const appId = appChoice();
      const r = await o.send(appId, S.req);
      S.sent = true;
      S.chooser = !(r && r.direct);
      await db.setMeta('handoffSent', { nonce: S.req.nonce, at: Date.now() });
      if (S.chooser) S.result = { ok: true, kind: 'info', message: N.isNative ? '보낼 앱을 골라 주세요. 부탁 글은 복사해 두었어요 — 앱에서 붙여넣기 하면 돼요.' : '부탁 글을 복사했어요. AI 앱에 붙여넣어 주세요.' };
    } catch (e) {
      S.result = { ok: false, message: (e && e.message) || String(e) };
    }
    S.busy = false; paint();
  }
  function reaction(r) {
    if (r && r.ok === false) S.result = { ok: false, reason: r.reason, message: r.message || '받지 못했어요' };
    else { S.result = { ok: true, message: (r && r.message) || '받았어요' }; S.reply = null; }
  }
  async function useReply(force) {
    if (S.busy || S.reply == null) return;
    S.busy = true; paint();
    try {
      const r = await engine.handoff.acceptText(id, S.reply, { force: !!force });
      reaction(r);
      if (r.ok) { toast(r.message || '답장을 받았어요', 'ok'); S.reply = null; if (o.onAccepted) await o.onAccepted(r); } else S.pending = S.reply;
    } catch (e) { S.result = { ok: false, message: (e && e.message) || String(e) }; }
    S.busy = false;
    if (S.result && S.result.ok) { await reload(); return; }
    paint();
  }
  async function pasteClipboard(auto) {
    const text = await N.readClipboard();
    if (!text || !text.trim()) {
      if (!auto) { S.result = { ok: false, message: '복사한 글이 없어요. AI 앱에서 답장을 길게 눌러 [복사] 한 뒤 다시 눌러 주세요.' }; paint(); }
      return;
    }
    if (S.req && isEcho(text, S.req.prompt)) {
      if (!auto) { S.result = { ok: false, reason: 'echo', message: '방금 보낸 부탁 글이 그대로 복사돼 있어요. AI 앱이 쓴 답장을 복사해 주세요.' }; paint(); }
      return;
    }
    if (auto && text.trim().length < 30) return;
    S.reply = text; S.result = null; paint();
  }
  async function takeFiles(files) {
    if (!files.length || S.busy) return;
    S.busy = true; S.result = null; paint();
    try {
      const r = await engine.handoff.acceptFiles(id, files.map((f) => ({ name: f.name, mime: f.type, blob: f })), { slotKey: S.req && S.req.key });
      const ok = r.placed && r.placed.length;
      S.result = { ok: !!ok, message: r.message };
      if (ok) { toast(r.message, 'ok'); if (o.onAccepted) await o.onAccepted(r); }
    } catch (e) { S.result = { ok: false, message: (e && e.message) || String(e) }; }
    S.busy = false; await reload();
  }
  async function pickOwn() {
    const f = await pickFile('image/*');
    if (f) await takeFiles([f]);
  }
  async function saveRefs() {
    try {
      let n = 0;
      for (const f of S.req.files) { await N.saveToGallery(f.blob, f.name); n++; }
      toast(`기준 그림 ${n}장을 갤러리(AnimeMaker V2 폴더)에 저장했어요`, 'ok', 4500);
    } catch (e) { toast((e && e.message) || '저장하지 못했어요', 'err'); }
  }

  // ── 그리기 ──
  function paintAsk(req) {
    const apps = req.targetApps || [];
    const cur = appChoice();
    const curName = (N.AI_APPS[cur] || {}).name || 'AI 앱';
    const sec = h('div', { class: `ho-sec ho-ask${S.sent ? ' done' : ''}` });
    sec.appendChild(h('div', { class: 'ho-h' }, S.sent ? `✅ ① ${curName} 에 부탁했어요` : '① AI 앱에 부탁해요'));
    if (!S.sent) {
      sec.appendChild(h('div', { class: 'chips ho-apps', 'aria-label': '쓸 AI 앱' }, apps.map((a) => h('button', {
        class: `chip${a.id === cur ? ' on' : ''}`, 'data-app': a.id,
        onclick: () => { S.appId = a.id; app.setSetting(req.expectsText ? 'textApp' : 'imageApp', a.id); paint(); },
      }, `${a.name}${app.installed && app.installed[a.id] ? ' ✓' : ''}`))));
      if (req.files && req.files.length) {
        sec.appendChild(h('div', { class: 'ho-refs' },
          h('div', { class: 'small muted' }, `같이 보내는 기준 그림 ${req.files.length}장`),
          h('div', { class: 'ho-thumbs' }, req.files.map((f) => h('img', { src: makeUrl(f.blob), alt: f.note || '기준 그림', class: 'ho-thumb' })))));
      }
      sec.appendChild(h('button', { class: 'btn primary big', id: 'ho-send', disabled: S.busy, onclick: doSend }, S.busy ? '보내는 중…' : '1. 부탁하기 ▶'));
      sec.appendChild(h('p', { class: 'small muted' }, `누르면 부탁 글이 복사되고 ${withJosa(curName, '이/가')} 열려요.${req.files && req.files.length ? ' 기준 그림도 함께 보내요.' : ''}`));
    } else {
      sec.appendChild(h('div', { class: 'row' },
        h('button', { class: 'btn small', id: 'ho-resend', onclick: () => { S.sent = false; paint(); } }, '🔄 다시 부탁하기'),
        h('button', { class: 'btn small', onclick: async () => { await N.copyText(req.prompt); toast('부탁 글을 복사했어요', 'ok'); } }, '📋 부탁 글만 복사')));
    }
    if (S.chooser && req.files && req.files.length) {
      sec.appendChild(h('div', { class: 'ho-check' },
        h('b', null, '기준 그림을 직접 붙여 주세요'),
        h('p', { class: 'small' }, `${curName} 에 부탁 글을 붙여넣은 뒤, 기준 그림 ${req.files.length}장도 같이 붙여 주세요. 갤러리에 저장해 두면 찾기 쉬워요.`),
        h('button', { class: 'btn small', onclick: saveRefs }, '🖼 기준 그림을 갤러리에 저장')));
    }
    return sec;
  }

  function paintGet(req) {
    const sec = h('div', { class: `ho-sec ho-get${S.sent ? ' on' : ''}` });
    sec.appendChild(h('div', { class: 'ho-h' }, '② 받아 와요'));
    if (isTextReq(req)) {
      sec.appendChild(h('p', { class: 'small' }, 'AI 앱이 답장하면 글 전체를 길게 눌러 [복사] 한 뒤, 여기로 돌아와서 아래 버튼을 눌러 주세요. (AI 앱의 [공유] → AnimeMaker V2 로 보내도 돼요)'));
      if (S.reply != null) {
        const first = S.reply.trim().split(/\r?\n/).slice(0, 6).join('\n');
        sec.appendChild(h('div', { class: 'ho-preview', id: 'ho-preview' },
          h('b', null, '이 답장을 쓸까요?'),
          h('pre', { class: 'ho-pre' }, first.length > 260 ? `${first.slice(0, 260)}…` : first),
          h('div', { class: 'row' },
            h('button', { class: 'btn primary', id: 'ho-use', disabled: S.busy, onclick: () => useReply(false) }, '네 쓸게요'),
            h('button', { class: 'btn', id: 'ho-recopy', onclick: () => { S.reply = null; S.result = null; paint(); } }, '다시 복사할게요'))));
      } else {
        sec.appendChild(h('button', { class: `btn ${S.sent ? 'primary' : ''} big`, id: 'ho-paste', onclick: () => { buzz(); pasteClipboard(false); } }, '📋 복사한 답장 붙여넣기'));
        const ta = h('textarea', { id: 'ho-manual', rows: 4, placeholder: '여기에 답장을 직접 붙여넣어도 돼요', 'aria-label': '답장 붙여넣기' });
        sec.appendChild(h('details', { class: 'fold' }, h('summary', null, '직접 붙여넣기'), ta,
          h('button', { class: 'btn small', id: 'ho-manual-use', onclick: () => { if (ta.value.trim()) { S.reply = ta.value; S.result = null; paint(); } } }, '이 글 확인하기')));
      }
      if (req.kind === 'xsheet' && o.fallbackXsheet) {
        sec.appendChild(h('button', { class: 'btn ghost', id: 'ho-fallback', onclick: async () => { buzz(); try { await o.fallbackXsheet(); } catch (e) { toast(e.message, 'err'); } } }, '🤖 AI 없이 PC 방식으로 짜기'));
      }
    } else {
      sec.appendChild(h('p', { class: 'small' }, req.hint || 'AI 앱이 그림을 만들어 주면 그림을 길게 눌러 [공유] → AnimeMaker V2 를 골라 주세요.'));
      sec.appendChild(h('div', { class: 'share-hint', 'aria-hidden': 'true' },
        h('span', { class: 'sh-pic' }, '🖼'), h('span', { class: 'sh-hand' }, '👆'), h('span', { class: 'sh-text' }, '꾹 눌러 → 공유 → AnimeMaker V2')));
      sec.appendChild(h('div', { class: 'row' },
        h('button', { class: 'btn', id: 'ho-own', onclick: () => pickOwn().catch((e) => toast(e.message, 'err')) }, '📁 내 사진에서 고르기'),
        o.skip ? h('button', { class: 'btn', id: 'ho-skip', onclick: async () => { buzz(); try { await o.skip(req); } catch (e) { toast(e.message, 'err'); } } }, req.redraw ? '다시 그리기 취소' : '건너뛰기') : null));
    }
    if (S.result) {
      sec.appendChild(h('div', { class: `ho-msg ${S.result.ok === false ? 'err' : (S.result.kind || 'ok')}`, role: 'status', id: 'ho-msg' }, S.result.message));
    }
    if (S.result && S.result.reason === 'noNonce' && S.pending != null) {
      sec.appendChild(h('button', { class: 'btn', id: 'ho-force', onclick: () => { S.reply = S.pending; S.pending = null; useReply(true); } }, '그래도 이 답장 쓰기'));
    }
    if (S.recent.length) {
      sec.appendChild(h('div', { class: 'ho-recent' }, h('div', { class: 'small muted' }, '방금 받은 그림'),
        h('div', { class: 'ho-thumbs' }, S.recent.map((r) => h('div', { class: 'ho-got' }, r.url ? h('img', { src: r.url, alt: r.title, class: 'ho-thumb' }) : h('div', { class: 'ho-thumb ph' }, '🖼'), h('span', { class: 'ho-check-mark' }, '✓'), h('div', { class: 'tiny' }, r.title))))));
    }
    const tray = renderTrayList({ app, engine, id, items: S.tray, snap: S.snap, urls: S.urls, onChange: () => { loadTray().then(paint); }, onPlaced: async (r) => { if (o.onAccepted) await o.onAccepted(r); } });
    if (tray) sec.appendChild(tray);
    return sec;
  }

  function paint() {
    if (dead) return;
    revoke();
    clear(el);
    const req = S.req;
    if (!req) {
      el.appendChild(h('p', { class: 'muted' }, S.result ? S.result.message : '지금 AI 앱에 부탁할 것이 없어요.'));
      return;
    }
    el.dataset.kind = req.kind;
    el.classList.toggle('stage2', S.sent);
    el.appendChild(h('div', { class: 'ho-top' },
      o.stepLabel ? h('div', { class: 'ho-step' }, o.stepLabel) : null,
      h('div', { class: 'ho-title', id: 'ho-title' }, `${ICON[req.kind] || '🎨'} ${req.title}`),
      S.snap && S.snap.work && S.snap.work.remainingRequests ? h('div', { class: 'small muted ho-work' }, S.snap.work.text) : null));
    el.appendChild(paintAsk(req));
    el.appendChild(paintGet(req));
  }

  // ── 바깥에서 부르는 것들 ──
  function update(snap) {
    S.snap = snap;
    // 새로 들어온 그림을 "방금 받은 그림 ✓" 에 올린다
    const doneKeys = new Set((snap.drawings || []).filter((d) => d.hasPicture).map((d) => d.key));
    if (S.seen) {
      for (const d of snap.drawings || []) {
        if (d.hasPicture && !S.seen.has(d.key)) {
          const rec = { key: d.key, title: titleOfDrawing(d), url: '' };
          S.recent.unshift(rec);
          S.recent = S.recent.slice(0, 4);
          engine.drawings.blob(id, d.key, 'current').then((b) => { if (b && !dead) { rec.url = URL.createObjectURL(b); rec.own = true; paint(); } }).catch(() => {});
        }
      }
    }
    S.seen = doneKeys;
    const sig = [snap.status, snap.waiting && snap.waiting.key, snap.handoff && snap.handoff.key, snap.handoff && snap.handoff.requestedAt, snap.redrawing.length, snap.nextKey].join('|');
    if (sig !== S.sig) { S.sig = sig; reload(); return; }
    const w = el.querySelector('.ho-work');
    if (w && snap.work) w.textContent = snap.work.text;
  }
  const onResume = () => {
    if (!S.req) return;
    loadTray().then(() => {
      if (isTextReq(S.req) && S.sent && S.reply == null) pasteClipboard(true).catch(() => {});
      else paint();
    });
  };
  const onTray = () => { loadTray().then(paint); };
  window.addEventListener('am:resume', onResume);
  window.addEventListener('am:inbox', onTray); // 공유로 받음 (기다리는 칸이 없으면 엔진이 'tray' 신호를 안 보내서)
  const offTray = engine.on('tray', onTray);

  reload();
  return {
    el,
    update,
    reload,
    ready: () => loading,
    getRequest: () => S.req,
    destroy() {
      dead = true;
      window.removeEventListener('am:resume', onResume);
      window.removeEventListener('am:inbox', onTray);
      offTray();
      for (const r of S.recent) if (r.own && r.url) URL.revokeObjectURL(r.url);
      revoke();
    },
  };
}
