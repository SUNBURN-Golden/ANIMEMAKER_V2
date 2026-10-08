// 영상 하나 화면 ↔ C3b 화면(완성 · 가사 자막 스튜디오 · 장면 고치기 · 가사 시간 맞추기) 사이의 약속.
//
//   mountDone(host, ctx) · mountSubStudio(host, ctx) · mountScenes(host, ctx) · mountTapSync(host, ctx)
//        → { update(snap), destroy(), isDirty?() }          (update 는 작품 상태가 바뀔 때마다, 같은 host 에 다시 그리지 말고 안쪽만 고친다)
//
//   ctx = {
//     id,                          작품 id (화면이 바뀌어도 이 id 로 일한다)
//     engine,                      mobile/src/engine (createEngine 결과)
//     getSnap(),                   지금 작품 상태(snapshot, 읽기 전용) — 늘 최신
//     toast(msg, kind, ms),        알림 글
//     onClose(result?),            이 화면을 닫고 영상 화면으로 (tap-sync 는 { saved:true } 로 닫으면 가사 확인이 이어진다)
//     ui,                          mobile/src/ui.js 전체 (h, bottomSheet, confirmBox, busy, pickFile …)
//     // 아래는 있으면 쓰는 덤 (없어도 된다)
//     app, native, db, runJob,     앱 상태 · 안드로이드 기능 · 저장소 · 일 지킴이
//     open(mode, extra?),          'scenes' | 'subs' | 'tapsync' 으로 바꾸기 (openScenes() openSubStudio() openTapSync(extra) 도 같다)
//     nextEpisode(),               같은 주인공으로 다음 화 만들기 (만들기 탭으로)
//     goHome(), goProjects(),      탭 옮기기
//     setBackHandler(fn|null),     안드로이드 뒤로가기를 이 화면이 먼저 받고 싶을 때 (fn() 이 true 를 돌려주면 처리한 것)
//     mode,                        지금 화면 이름
//   }
//
// 시험용: window.AnimeMaker.mountForTest(name, id) → { host, handle, ctx } — name = 'done' | 'substudio' | 'scenes' | 'tapsync'
import * as ui from '../ui.js';
import * as N from '../native.js';
import * as db from '../db.js';
import * as jobs from '../jobs.js';
import * as DoneMod from './done.js';
import * as SubMod from './substudio.js';
import * as ScenesMod from './scenes.js';
import * as TapMod from './tap-sync.js';

const { h, toast } = ui;

const TABLE = {
  done: { mod: DoneMod, fn: 'mountDone', label: '완성 화면' },
  substudio: { mod: SubMod, fn: 'mountSubStudio', label: '가사 자막 고치기' },
  scenes: { mod: ScenesMod, fn: 'mountScenes', label: '장면 고치기' },
  tapsync: { mod: TapMod, fn: 'mountTapSync', label: '가사 시간 맞추기' },
};
const ALIAS = { subs: 'substudio', subtitles: 'substudio', 'sub-studio': 'substudio', 'tap-sync': 'tapsync', tap: 'tapsync', scene: 'scenes' };

export const canonical = (name) => ALIAS[name] || name;

/** 화면 이름 → 마운트 함수 (없으면 null) */
export function mounterOf(name) {
  const t = TABLE[canonical(name)];
  if (!t) return null;
  let fn = null;
  try { fn = t.mod[t.fn] || t.mod.mount || null; } catch (_) { fn = null; }
  return typeof fn === 'function' ? fn : null;
}

/** ctx 만들기. extra 로 덮어쓸 수 있다 (open · onClose · mode …) */
export function makeCtx({ id, engine, app, onClose, open, nextEpisode, mode = 'main', extra = {} }) {
  const ctx = {
    id,
    engine,
    app,
    native: N,
    db,
    runJob: jobs.runJob,
    ui,
    toast,
    mode,
    getSnap: () => engine.projects.peek(id),
    onClose: (res) => { if (onClose) onClose(res); },
    open: (m, x) => (open ? open(canonical(m), x) : undefined),
    openScenes: (x) => ctx.open('scenes', x),
    openSubStudio: (x) => ctx.open('substudio', x),
    openSubtitles: (x) => ctx.open('substudio', x),
    openTapSync: (x) => ctx.open('tapsync', x),
    nextEpisode: () => (nextEpisode ? nextEpisode() : app && app.go('home')),
    goHome: () => app && app.go('home'),
    goProjects: () => app && app.go('projects'),
    _backHook: null,
    setBackHandler: (fn) => { ctx._backHook = typeof fn === 'function' ? fn : null; },
    ...extra,
  };
  return ctx;
}

/** 화면 하나를 host 에 올린다. 모듈이 없거나 그리다 실패하면 알기 쉬운 안내를 그리고 { update(){}, destroy(){} } 를 돌려준다 */
export function mountModule(name, host, ctx) {
  const key = canonical(name);
  const info = TABLE[key];
  const fn = mounterOf(key);
  const fallback = (msg) => {
    host.replaceChildren(h('div', { class: 'card sub-missing' },
      h('h3', null, info ? info.label : '화면'),
      h('p', { class: 'muted' }, msg),
      h('button', { class: 'btn', onclick: () => ctx.onClose() }, '돌아가기')));
    return { update() {}, destroy() { host.replaceChildren(); }, missing: true };
  };
  if (!fn) return fallback('이 화면은 아직 준비 중이에요.');
  try {
    const handle = fn(host, ctx) || {};
    return {
      update: typeof handle.update === 'function' ? (s) => handle.update(s) : () => {},
      destroy: () => { try { if (typeof handle.destroy === 'function') handle.destroy(); } finally { host.replaceChildren(); } },
      isDirty: typeof handle.isDirty === 'function' ? () => !!handle.isDirty() : () => false,
      raw: handle,
    };
  } catch (e) {
    return fallback(`화면을 열지 못했어요 (${(e && e.message) || e})`);
  }
}

/** 시험용: 영상 화면을 거치지 않고 C3b 화면 하나를 전체 화면 칸에 바로 올린다 */
export async function mountForTest(name, id, extra = {}) {
  const A = window.AnimeMaker || {};
  if (!A.engine) throw new Error('앱이 아직 준비되지 않았어요');
  const host = h('div', { class: 'sub-host test-host', id: 'test-host', 'data-mode': canonical(name) });
  document.body.appendChild(host);
  let handle = null;
  const { onClose: userClose, open: userOpen, ...rest } = extra;
  const ctx = makeCtx({
    id, engine: A.engine, app: A.app, mode: canonical(name),
    onClose: (res) => { if (handle) handle.destroy(); host.remove(); if (userClose) userClose(res); },
    open: (m, x) => { if (userOpen) userOpen(m, x); },
    extra: rest,
  });
  handle = mountModule(name, host, ctx);
  const snap = A.engine.projects.peek(id) || await A.engine.projects.get(id);
  if (snap && handle.update) handle.update(snap);
  return { host, handle, ctx };
}
