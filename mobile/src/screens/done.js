// 완성 화면: 큰 영상 + [갤러리에 저장] [공유] [가사 자막 고치기] [장면 고치기] [다음 화 만들기] (+ 고친 것 반영하기 고정 줄)
//   mountDone(host, ctx) → { update(snap), destroy(), isDirty() }
//   ctx = { id, engine, getSnap(), toast, onClose(), ui, go(target,arg)?, native? }
//   go('subs'|'scenes'|'next-episode'|'settings', arg) 는 project.js 가 받아서 화면을 바꾼다 (없으면 안내만 한다)
import { h, clear, toast as toastDefault, busy, fmtSize } from '../ui.js';
import * as nativeDefault from '../native.js';
import { createUrlBox, firstPicture, createApplyBar, fmtLen, vibrate, go, friendly } from './done-parts.js';

const SHARE_TEXT = 'AI 로 만든 영상이에요 (AnimeMaker V2)';

export function mountDone(host, ctx) {
  const { engine, id } = ctx;
  const N = ctx.native || nativeDefault;
  const say = ctx.toast || toastDefault;
  let snap = (ctx.getSnap && ctx.getSnap()) || {};
  let destroyed = false;
  let loadedKey = '';
  let fileName = '';
  let fileBytes = 0;
  const urls = createUrlBox();

  // ───── 뼈대 (한 번만 만든다. 영상은 update 때 다시 만들지 않는다) ─────
  const video = h('video', { class: 'dn-video', controls: true, playsinline: true, preload: 'metadata', 'aria-label': '완성한 영상' });
  const waitMsg = h('div', { class: 'dn-wait' }, '영상을 불러오는 중이에요…');
  const stage = h('div', { class: 'dn-stage' }, video, waitMsg);
  const meta = h('div', { class: 'dn-meta' });
  video.addEventListener('loadeddata', () => { waitMsg.hidden = true; });
  video.addEventListener('error', () => {
    waitMsg.hidden = false;
    waitMsg.textContent = '이 폰에서는 영상을 미리 볼 수 없어요. [갤러리에 저장하기] 를 눌러 갤러리에서 봐 주세요.';
  });

  const btn = (cls, label, fn, extra) => h('button', { type: 'button', class: `btn ${cls}`, onclick: (e) => { vibrate(); fn(e); }, ...(extra || {}) }, label);
  const bSave = btn('primary big dn-save', '💾 갤러리에 저장하기', () => saveVideo());
  const bShare = btn('big dn-share', '📤 공유하기', () => shareVideo());
  const bSubs = btn('dn-half', '💬 가사 자막 고치기', () => go(ctx, 'subs'));
  const bScenes = btn('dn-half', '✏️ 장면 고치기', () => go(ctx, 'scenes'));
  const bNext = btn('big dn-next', '🎬 다음 화 만들기', () => go(ctx, 'next-episode', { seriesId: snap.series && snap.series.id }));
  const practice = h('div', { class: 'card dn-practice', hidden: true },
    h('b', null, '🎈 연습 모드로 만든 영상이에요'),
    h('p', { class: 'small' }, '가짜 그림으로 흐름만 보여 드렸어요. 진짜 그림으로 만들어 볼까요?'),
    btn('primary', '🔌 내 AI 앱 연결하기', () => go(ctx, 'settings')));
  const fold = h('details', { class: 'fold dn-fold' },
    h('summary', null, '고급'),
    h('div', { class: 'dn-fold-body' },
      btn('small', '📄 자막 파일 공유 (.srt)', () => shareText('srt')),
      btn('small', '📄 가사 시간 파일 공유 (.lrc)', () => shareText('lrc')),
      h('p', { class: 'small muted' }, '.srt · .lrc 는 영상 편집 앱이나 노래방 앱에서 자막으로 쓸 수 있는 글 파일이에요.')));
  const note = h('p', { class: 'dn-note' }, '🤖 AI 로 만든 영상이에요. 인터넷에 올릴 때 AI 로 만들었다고 알려 주세요.');
  const bar = createApplyBar(ctx, { onDone: () => { update(ctx.getSnap ? ctx.getSnap() : snap); } });
  // 위: 영상(남는 칸 가운데) · 아래: 큰 단추들 (엄지가 닿는 아래쪽)
  const root = h('div', { class: 'dn' },
    h('div', { class: 'dn-top' }, stage, meta),
    h('div', { class: 'dn-bottom' },
      h('div', { class: 'dn-actions' }, bSave, bShare, h('div', { class: 'dn-row2' }, bSubs, bScenes), bNext),
      practice, note, fold),
    bar.el);
  host.appendChild(root);

  // ───── 영상 읽기 ─────
  async function loadVideo() {
    const out = snap.output || {};
    const key = out.video ? `${out.video}|${out.madeAt || 0}` : '';
    if (!key || key === loadedKey) return;
    loadedKey = key;
    try {
      const [blob, name, posterBlob] = await Promise.all([
        engine.render.output(id, 'video'), engine.render.fileName(id, 'video'), firstPicture(engine, id, snap).catch(() => null),
      ]);
      if (destroyed || key !== loadedKey) return;
      if (!blob) { waitMsg.hidden = false; waitMsg.textContent = '영상 파일을 찾을 수 없어요. 고친 것 반영하기로 다시 만들어 주세요.'; return; }
      fileName = name;
      fileBytes = blob.size;
      // 영상이 바뀌었으면 재생 중이던 옛 영상을 놓고(주소 revoke) 새로 건다
      const was = video.currentSrc ? video.currentTime : 0;
      try { video.pause(); } catch (_) { /* 무시 */ }
      video.removeAttribute('src');
      video.load();
      video.poster = posterBlob ? urls.get('poster', `${key}|p`, posterBlob) : '';
      waitMsg.hidden = false;
      waitMsg.textContent = '영상을 불러오는 중이에요…';
      video.src = urls.get('video', key, blob);
      if (was > 0) video.addEventListener('loadedmetadata', () => { try { video.currentTime = Math.min(was, (video.duration || was) - 0.1); } catch (_) { /* 무시 */ } }, { once: true });
      paintMeta();
    } catch (e) {
      loadedKey = '';
      waitMsg.hidden = false;
      waitMsg.textContent = friendly(e);
    }
  }

  function paintMeta() {
    clear(meta);
    const out = snap.output || {};
    meta.appendChild(h('div', { class: 'dn-name' }, fileName || snap.title || '내 영상'));
    const bits = [];
    const sec = out.seconds || snap.durationSec;
    if (sec) bits.push(fmtLen(sec));
    if (fileBytes) bits.push(fmtSize(fileBytes));
    if (snap.outSize) bits.push(`${snap.outSize.w}×${snap.outSize.h}`);
    if (out.burned === false) bits.push('자막 없음');
    if (bits.length) meta.appendChild(h('div', { class: 'small muted' }, bits.join(' · ')));
  }

  // ───── 저장 · 공유 ─────
  let working = false;
  async function withBlob(fn, busyMsg) {
    if (working) return;
    working = true;
    const b = busy(busyMsg);
    try {
      const blob = await engine.render.output(id, 'video');
      if (!blob) throw new Error('영상 파일을 찾을 수 없어요. 고친 것 반영하기로 다시 만들어 주세요.');
      await fn(blob, fileName || await engine.render.fileName(id, 'video'));
    } catch (e) {
      say(friendly(e), 'err', 5500);
    } finally {
      b.done();
      working = false;
    }
  }
  function saveVideo() {
    return withBlob(async (blob, name) => {
      const r = await N.saveToGallery(blob, name);
      if (r && r.saved === false && r.shared) say('이 폰은 갤러리에 바로 넣을 수 없어서 공유 창을 열었어요. 저장할 곳을 골라 주세요.', 'warn', 5500);
      else say(`✅ 갤러리에 저장했어요 · "${/AnimeMaker/.test((r && r.folder) || '') ? r.folder : 'AnimeMaker V2'}" 폴더`, 'ok', 4500);
    }, '갤러리에 저장하는 중…');
  }
  function shareVideo() {
    return withBlob(async (blob, name) => { await N.shareFile(blob, name, SHARE_TEXT); }, '공유할 준비를 하는 중…');
  }
  async function shareText(which) {
    if (working) return;
    try {
      const blob = await engine.render.output(id, which);
      if (!blob) { say('아직 자막 파일이 없어요. 가사를 넣고 영상을 만들면 생겨요.', 'warn'); return; }
      await N.shareFile(blob, await engine.render.fileName(id, which), '');
    } catch (e) { say(friendly(e), 'err'); }
  }

  // ───── 새 소식 ─────
  function update(next) {
    if (destroyed || !next) return;
    snap = next;
    const ow = snap.outSize && snap.outSize.w;
    const oh = snap.outSize && snap.outSize.h;
    if (ow && oh) {
      stage.style.setProperty('--ar', `${ow} / ${oh}`);
      stage.style.setProperty('--arn', String(ow / oh));
      stage.classList.toggle('tall', oh > ow);
    }
    const hasVideo = !!(snap.output && snap.output.video);
    stage.hidden = !hasVideo;
    for (const b of [bSave, bShare, bSubs, bScenes]) b.disabled = !hasVideo && (b === bSave || b === bShare);
    bNext.hidden = !(snap.series && snap.series.id);
    practice.hidden = !(snap.providers && snap.providers.image === 'demo');
    paintMeta();
    bar.update(snap);
    loadVideo();
  }
  const off = engine.on ? engine.on('update', (s) => { if (s && s.id === id) update(s); }) : null;
  update(snap);
  if (!snap.id) engine.projects.get(id).then(update).catch(() => {});

  return {
    update,
    isDirty: () => false,
    confirmLeave: async () => true,
    destroy() {
      destroyed = true;
      if (off) off();
      try { video.pause(); } catch (_) { /* 무시 */ }
      video.removeAttribute('src');
      try { video.load(); } catch (_) { /* 무시 */ }
      urls.dispose();
      root.remove();
    },
  };
}
