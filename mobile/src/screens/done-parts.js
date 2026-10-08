// 완성 화면 · 가사 자막 스튜디오 · 장면 고치기가 함께 쓰는 작은 부품들 (C3b)
//   fmt* 시간 글 · createUrlBox(blob 주소 만들고 놓기) · runApply(고친 것 반영하기 한 번) · createApplyBar(맨 아래 고정 줄) · go(다른 화면으로)
// 영상 만들기·자막 입히기는 엔진이 jobs.runJob(modal·foreground) 아래에서 돌리므로 [그만두기] 와 진행 막대는 덮개가 알아서 보여 준다.
// 여기서는 "시작하고 → 끝날 때까지 기다리고 → 결과를 쉬운 말로 알리기" 만 한다 (화면이 닫혀도 알림은 간다).
import { h, toast as toastDefault } from '../ui.js';
import { ensureNotify } from './handoff.js';

export const FPS = 24;
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const round2 = (x) => Math.round(x * 100) / 100;

export function vibrate(ms = 15) {
  try { if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(ms); } catch (_) { /* 진동이 없는 기기 */ }
}

/** 0:32 */
export function fmtClock(t) {
  const x = Math.max(0, Math.floor(Number(t) || 0));
  return `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`;
}
/** 0:32.4 */
export function fmtTenth(t) {
  const x = Math.round(Math.max(0, Number(t) || 0) * 10) / 10;
  const m = Math.floor(x / 60);
  return `${m}:${(x - m * 60).toFixed(1).padStart(4, '0')}`;
}
/** 3분 20초 / 45초 */
export function fmtLen(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s}초`;
  return `${Math.floor(s / 60)}분${s % 60 ? ` ${s % 60}초` : ''}`;
}
/** 약 40초 / 약 3분 (걸리는 시간 어림) */
export function etaText(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return '약 1분';
  if (s < 45) return `약 ${Math.max(10, Math.round(s / 5) * 5)}초`;
  return `약 ${Math.max(1, Math.round(s / 60))}분`;
}

/** 자막을 영상에 입히는 데 걸릴 시간(초) 어림: 지난번 시간이 있으면 그것, 없으면 노래 길이 × 0.45 (+ 영상을 다시 만들어야 하면 그 시간) */
export function estimateApplySec(snap, { subs = true, render = false } = {}) {
  const ss = (snap.steps && snap.steps.subtitles) || {};
  const rs = (snap.steps && snap.steps.render) || {};
  const song = Number(snap.durationSec) || 60;
  let sec = 0;
  if (subs) sec += ss.lastMs > 0 ? ss.lastMs / 1000 : Math.max(10, song * 0.45);
  if (render) sec += rs.lastMs > 0 ? rs.lastMs / 1000 : (snap.xsheet && snap.xsheet.totalFrames ? snap.xsheet.totalFrames : song * FPS) * 0.067 * 2.5;
  return sec;
}

/** 오류를 사용자에게 보일 한국어 한 줄로 */
export function friendly(e) {
  const m = (e && e.message) || String(e || '');
  return /[가-힣]/.test(m) ? m : `문제가 생겼어요: ${m.slice(0, 120)}`;
}

/** 이름 붙인 blob 주소 보관함: 같은 열쇠면 그대로, 열쇠가 바뀌면 옛 주소를 놓고(revoke) 새로 만든다 */
export function createUrlBox() {
  const made = new Map();
  return {
    get(name, key, blob) {
      const cur = made.get(name);
      if (cur && cur.key === key) return cur.url;
      if (cur) { try { URL.revokeObjectURL(cur.url); } catch (_) { /* 이미 놓음 */ } made.delete(name); }
      if (!blob) return '';
      const url = URL.createObjectURL(blob);
      made.set(name, { key, url });
      return url;
    },
    has: (name) => made.has(name),
    drop(name) {
      const cur = made.get(name);
      if (cur) { try { URL.revokeObjectURL(cur.url); } catch (_) { /* 무시 */ } made.delete(name); }
    },
    dispose() {
      for (const { url } of made.values()) { try { URL.revokeObjectURL(url); } catch (_) { /* 무시 */ } }
      made.clear();
    },
  };
}

/** 영상 맨 처음 그림(배경) 한 장: 완성 화면의 포스터 · 영상이 아직 없을 때의 자막 미리보기 바탕 */
export async function firstPicture(engine, id, snap) {
  const ds = ((snap && snap.drawings) || []).filter((d) => d && d.hasPicture);
  const d = ds.find((x) => x.kind === 'bg' && x.shot === 1) || ds.find((x) => x.kind === 'bg') || ds[0];
  if (!d) return null;
  try { return await engine.drawings.blob(id, d.key, d.kind === 'bg' ? 'current' : 'plate'); } catch (_) { return null; }
}

/**
 * 다른 화면으로 가기. project.js 의 ctx 약속: open('subs'|'scenes'|'tapsync') · nextEpisode() · app.go('settings').
 * target: 'subs' | 'scenes' | 'tap' | 'next-episode' | 'settings'
 */
export function go(ctx, target, arg) {
  const say = (ctx && ctx.toast) || toastDefault;
  try {
    if (target === 'next-episode' && typeof ctx.nextEpisode === 'function') return ctx.nextEpisode(arg);
    if (target === 'settings' && ctx.app && typeof ctx.app.go === 'function') return ctx.app.go('settings');
    const mode = target === 'tap' ? 'tapsync' : target;
    const fn = ctx.open || ctx.go || ctx.navigate;
    if (typeof fn === 'function') return fn.call(ctx, mode, arg);
  } catch (e) { say(friendly(e), 'err'); return undefined; }
  say('지금은 그 화면으로 갈 수 없어요', 'warn');
  return undefined;
}

const applying = new Map(); // 작품 id → 진행 중인 약속 (같은 작품에 두 번 누르지 않게)

/**
 * 고친 것 반영하기: 엔진에 시작하라고 하고 끝날 때까지 기다린다 (덮개의 [그만두기] 로 멈출 수 있다).
 * 결과 알림(토스트)은 여기서 한다 → 이 화면이 그 사이 닫혀도 알림은 간다.
 * @returns {Promise<{ok:boolean, none?:boolean, cancelled?:boolean, error?:string, snap?:object}>}
 */
export function runApply(ctx, { okMsg = '✅ 반영했어요', quiet = false } = {}) {
  const { engine, id } = ctx;
  if (applying.has(id)) return applying.get(id);
  const say = ctx.toast || toastDefault;
  const p = (async () => {
    try {
      // 첫 긴 일 전에 한 번: "화면을 꺼도 계속 만들 수 있게 알림을 켤게요" (어느 쪽을 골라도 이어서 한다)
      if (ctx.app && ctx.app.prefs) { try { await ensureNotify(ctx.app); } catch (_) { /* 알림 설명이 실패해도 영상은 만든다 */ } }
      const r = await engine.applyChanges(id);
      if (!r || !r.from) {
        if (!quiet) say('반영할 것이 없어요', 'warn');
        return { ok: false, none: true };
      }
      await engine.whenIdle(id);
      const snap = await engine.projects.get(id);
      if (snap.status === 'done') {
        if (!quiet) say(okMsg, 'ok');
        return { ok: true, snap };
      }
      if (snap.status === 'stopped') {
        say('그만뒀어요. 고친 것은 그대로 남아 있어요. 다시 누르면 이어서 해요.', 'warn', 5000);
        return { ok: false, cancelled: true, snap };
      }
      const msg = snap.error || '영상을 만들지 못했어요. 고친 것은 그대로 남아 있어요.';
      say(msg, 'err', 6500);
      return { ok: false, error: msg, snap };
    } catch (e) {
      const msg = friendly(e);
      say(msg, 'err', 6500);
      return { ok: false, error: msg };
    }
  })().finally(() => { applying.delete(id); });
  applying.set(id, p);
  return p;
}

export const isApplying = (id) => applying.has(id);

/**
 * 맨 아래에 붙어 있는 [✨ 고친 것 반영하기 (약 M분)] 줄. snap.changes.count > 0 일 때만 보인다.
 * @param {object} ctx  C3 마운트 약속의 ctx
 * @param {{onDone?:(res:object)=>void}} [o]
 * @returns {{el:HTMLElement, update:(snap:object)=>void}}
 */
export function createApplyBar(ctx, { onDone } = {}) {
  const info = h('div', { class: 'sk-apply-info' });
  const sub = h('div', { class: 'sk-apply-sub' });
  const btn = h('button', { type: 'button', class: 'btn primary sk-apply-btn', onclick: async () => {
    vibrate();
    btn.disabled = true;
    const res = await runApply(ctx);
    if (onDone) { try { onDone(res); } catch (_) { /* 화면이 이미 닫힘 */ } }
    update(ctx.getSnap());
  } });
  const el = h('div', { class: 'sk-apply', hidden: true, role: 'region', 'aria-label': '고친 것 반영하기' }, info, btn, sub);

  function update(snap) {
    const c = (snap && snap.changes) || { count: 0 };
    const show = c.count > 0;
    el.hidden = !show;
    if (!show) return;
    const parts = [];
    if (c.render) parts.push(c.shots && c.shots.length ? `바뀐 장면 ${c.shots.length}곳` : '그림이 바뀌었어요');
    if (c.subs) parts.push('자막이 바뀌었어요');
    info.textContent = `✏️ ${parts.join(' · ')}`;
    sub.textContent = c.render ? '폰에서는 영상을 처음부터 다시 만들어서 시간이 걸려요. 만드는 동안 화면을 꺼도 괜찮아요.' : '자막만 새로 입혀요. 그림은 다시 만들지 않아요.';
    const busy = !!snap.running || isApplying(snap.id);
    btn.textContent = `✨ 고친 것 반영하기 (${etaText(c.etaSec)})`;
    btn.disabled = busy || !snap.canApply;
    btn.title = busy ? '지금 만드는 중이에요' : (!snap.canApply ? 'AI 앱에 부탁한 그림을 먼저 받아 주세요' : '');
  }
  update(ctx.getSnap ? ctx.getSnap() : null);
  return { el, update };
}
