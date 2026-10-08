'use strict';
// 고친 것 반영하기 (DESIGN §3.4 · §1.6): 어느 단계부터 · changes 스냅샷 · 바뀐 장면 기록(dirtyShots) · 걸릴 시간 · 완성된 프로젝트에서도 시작 ·
// 바뀐 장면만 새로 만든다 · 장면 넘기기/효과 · timesheet.json 과 storyboard.md 가 같이 고쳐진다
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { copyFixture } = require('./helpers/edit-fixture');
const EC = require('../src/main/pipeline/edits-core');
const { probe } = require('../src/main/media/ffmpeg');

const mtime = (f) => Math.round(fs.statSync(f).mtimeMs);
const shotFile = (fx, no) => path.join(fx.dir, 'work', 'render', `shot${String(no).padStart(2, '0')}.mp4`);
const finished = (r) => new Promise((res) => r.once('finished', res));

test('순수 함수: 어느 단계부터 (a) 끝나지 않은 단계 → (b) 영상 → (c) 자막 → (d) 없음', () => {
  const done = Object.fromEntries(EC.STEP_ORDER.map((s) => [s, { status: 'done' }]));
  const f = (o = {}) => EC.decideApplyFrom({ steps: done, renderStale: false, dirtyShots: [], subsStale: false, hasClean: true, ...o });
  assert.strictEqual(f(), null, '(d) 할 일 없음');
  assert.strictEqual(f({ renderStale: true }), 'render');
  assert.strictEqual(f({ dirtyShots: [2] }), 'render');
  assert.strictEqual(f({ subsStale: true }), 'subtitles', '(c) 자막만');
  assert.strictEqual(f({ subsStale: true, renderStale: true }), 'render', '둘 다면 영상부터 (자막은 따라온다)');
  assert.strictEqual(f({ subsStale: true, hasClean: false }), 'render', '깨끗한 원본이 없으면 영상부터');
  // (a) 끝나지 않은 단계가 가장 먼저
  assert.strictEqual(f({ steps: { ...done, subtitles: { status: 'pending' } } }), 'subtitles', '(a) 자막 단계만 대기');
  assert.strictEqual(f({ steps: { ...done, subtitles: { status: 'pending' } }, renderStale: true }), 'render', '자막 모양도 바꾸고 장면도 고쳤으면 영상부터 (자막 단계가 대기여도)');
  assert.strictEqual(f({ steps: { ...done, subtitles: { status: 'pending' } }, hasClean: false }), 'render', '(a) 로 자막부터 해야 하는데 원본이 없으면 영상부터');
  assert.strictEqual(f({ steps: { ...done, render: { status: 'pending' }, subtitles: { status: 'pending' } } }), 'render');
  assert.strictEqual(f({ steps: { ...done, drawings: { status: 'error' }, render: { status: 'pending' } }, dirtyShots: [1] }), 'drawings');
  assert.strictEqual(f({ steps: { ...done, xsheet: { status: 'stopped' } } }), 'xsheet');
  assert.strictEqual(f({ steps: {} }), 'music', '새 프로젝트는 처음부터');
  assert.strictEqual(f({ steps: { ...done, plan: undefined } }), 'plan');
});

test('순수 함수: 걸릴 시간 — 지난번에 잰 값이 있으면 그것으로, 없으면 노래 길이 × 0.9 + 자막 어림', () => {
  assert.strictEqual(EC.applyEta({ render: false, subs: false }), null);
  // 재 둔 값: 장면 하나 평균 + 이어 붙이기 + 자막
  const steps = { render: { lastMs: 40000, shotMs: 5000, assembleMs: 15000, shotsRendered: 3, shotsTotal: 3 }, subtitles: { lastMs: 4000 } };
  assert.strictEqual(EC.applyEta({ render: true, subs: true, nChanged: 1, nShots: 3, songSec: 24, steps }), Math.round((5 + 15 + 4)), '1×5 + 15 + 4');
  assert.strictEqual(EC.applyEta({ render: true, subs: false, nChanged: 3, nShots: 3, songSec: 24, steps }), 15 + 15 + 4);
  assert.strictEqual(EC.applyEta({ render: false, subs: true, nChanged: 0, nShots: 3, songSec: 24, steps }), 4, '자막만이면 자막 시간만');
  // 움직이는 장면과 멈춘 장면의 평균 시간이 따로 있으면 바뀐 장면의 종류대로 센다
  const kinds = { render: { shotMs: 5000, motionShotMs: 12000, holdShotMs: 2000, assembleMs: 15000 }, subtitles: { lastMs: 4000 } };
  assert.strictEqual(EC.applyEta({ render: true, subs: false, shots: [{ motion: true }, { motion: false }], nShots: 9, songSec: 60, steps: kinds }), 12 + 2 + 15 + 4);
  assert.strictEqual(EC.applyEta({ render: true, subs: false, shots: [{ motion: false }], nShots: 9, songSec: 60, steps: kinds }), 2 + 15 + 4, '멈춘 장면 하나는 빨리');
  assert.strictEqual(EC.applyEta({ render: true, subs: false, shots: [{ motion: true }], nShots: 3, songSec: 24, steps }), 5 + 15 + 4, '종류별 값이 없으면 평균(shotMs)으로');
  // 장면별로 잰 값이 없고 전체 시간만 있으면: 바뀐 장면 비율로 나눈다
  const old = { render: { lastMs: 60000 }, subtitles: {} };
  assert.strictEqual(EC.applyEta({ render: true, subs: false, nChanged: 1, nShots: 4, songSec: 100, steps: old }), Math.round(60 / 4 + 45), '60초×1/4 + 자막 어림 max(10, 100×0.45)');
  // 아무것도 잰 적이 없으면 노래 길이로
  assert.strictEqual(EC.applyEta({ render: true, subs: true, nChanged: 1, nShots: 4, songSec: 200, steps: {} }), Math.round(200 * 0.9 + 200 * 0.45));
  assert.strictEqual(EC.applyEta({ render: false, subs: true, songSec: 4, steps: {} }), 10, '자막은 아무리 짧아도 10초 이상으로 어림');
  assert.strictEqual(EC.applyEta({ render: true, subs: false, nChanged: 0, nShots: 0, songSec: 0, steps: {} }), Math.round(60 * 0.9 + Math.max(10, 60 * 0.45)), '노래 길이를 모르면 60초로');
});

test('순수 함수: 장면 넘기기 만들기 · 효과 검사 · 영상 모양 덮어쓰기 검사', () => {
  const tr = EC.makeTransition('fade', { prev: { frames: 0 }, framesA: 100, framesB: 100, beatPeriod: 0.5 });
  assert.deepStrictEqual(tr, { type: 'fade', xfade: 'fade', duration: 0.5, frames: 12 });
  assert.deepStrictEqual(EC.makeTransition('dissolve', { prev: { type: 'fade', frames: 20 }, framesA: 100, framesB: 100 }).frames, 20, '지금 길이를 지킨다');
  assert.deepStrictEqual(EC.makeTransition('cut', { prev: { frames: 20 }, framesA: 100, framesB: 100 }), { type: 'cut', xfade: null, duration: 0, frames: 0 });
  assert.strictEqual(EC.makeTransition('flash', { prev: null, framesA: 100, framesB: 100, beatPeriod: 0.5 }).frames, 6, '플래시는 짧게');
  assert.strictEqual(EC.makeTransition('fade', { prev: { frames: 40 }, framesA: 30, framesB: 100 }).frames, 18, '짧은 장면의 60% 까지');
  assert.strictEqual(EC.makeTransition('fade', { prev: null, framesA: 3, framesB: 100 }).tooShort, true);
  assert.strictEqual(EC.makeTransition('bogus', { prev: null, framesA: 100, framesB: 100 }), null);
  assert.deepStrictEqual(EC.transitionOut({ type: 'fade', frames: 12 }, 0.5), { type: 'fade', beats: 1 });
  assert.deepStrictEqual(EC.transitionOut({ type: 'cut', frames: 0 }), { type: 'cut', beats: 0 });
  assert.deepStrictEqual(EC.checkFx(['fadein', 'sparkle', 'sparkle']).fx, ['fade_in', 'sparkle']);
  assert.deepStrictEqual(EC.checkFx([]).fx, []);
  assert.deepStrictEqual(EC.checkFx(null).fx, []);
  assert.match(EC.checkFx(['sparkle', 'explosion']).error, /알 수 없는 효과예요: explosion/);
  assert.match(EC.checkFx(['fade_in', 'fade_out', 'flash', 'sparkle']).error, /3개까지/);
  assert.deepStrictEqual(EC.normalizeOverrides({ aspect: '1:1', quality: '480p', motionMode: 'limited', keyRate: '8', drawingBudget: '40', pace: 'fast', hack: 1, name: 'x', subtitles: {} }),
    { aspect: '1:1', quality: '480p', motionMode: 'limited', keyRate: 8, drawingBudget: 40, pace: 'fast' });
  assert.deepStrictEqual(EC.normalizeOverrides({ aspect: '3:2', quality: '4k', motionMode: 'x', keyRate: 7, drawingBudget: -3, pace: 'warp' }), {}, '틀린 값은 조용히 버린다');
  assert.deepStrictEqual(EC.normalizeOverrides({ drawingBudget: 0 }), { drawingBudget: 0 }, '0 = 자동');
  assert.deepStrictEqual(EC.normalizeOverrides(null), {});
  assert.deepStrictEqual(EC.normalizeOverrides([1]), {});
  assert.strictEqual(EC.checkBudget('abc'), null);
  assert.strictEqual(EC.checkBudget(3001), null);
  assert.strictEqual(EC.checkBudget(12.6), 13);
});

test('changes · canApply 스냅샷: 고친 것이 없으면 비어 있고, 고치면 장면 번호와 걸릴 시간이 보인다', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  let s = r.snapshot();
  assert.deepStrictEqual(s.changes, { render: false, subs: false, shots: [], count: 0, etaSec: null });
  assert.strictEqual(s.canApply, false);
  assert.strictEqual(s.durationSec, 24, '노래 길이');
  assert.deepStrictEqual(s.outSize, { w: 854, h: 480 });
  assert.strictEqual(s.subtitleStyle.preset, 'basic');
  assert.ok(Array.isArray(s.redrawing) && s.redrawing.length === 0);
  assert.deepStrictEqual(r.applyChanges(), { from: null }, '(d) 할 일이 없으면 아무것도 안 한다');
  assert.strictEqual(r.running, false);
  // 카메라 → 영상 쪽 변화
  r.setCamera(2, 'truck_in');
  s = r.snapshot();
  assert.strictEqual(s.changes.render, true);
  assert.deepStrictEqual(s.changes.shots, [2]);
  assert.strictEqual(s.changes.count, 1);
  assert.ok(s.changes.etaSec > 0);
  assert.strictEqual(s.canApply, true, '완성(done)된 영상에서도 반영할 수 있다');
  assert.strictEqual(s.status, 'done');
  // 자막 모양 → 자막 쪽 변화
  r.setSubtitleStyle({ preset: 'yellow' });
  s = r.snapshot();
  assert.strictEqual(s.changes.subs, true);
  assert.strictEqual(s.changes.count, 2, '바뀐 장면 1곳 + 자막');
  assert.strictEqual(r.applyFrom(), 'render');
  // 걸릴 시간은 지난번에 잰 값으로 (장면 1곳이면 그 장면 시간 + 이어 붙이기 + 자막)
  const rs = r.p.steps.render;
  const ss = r.p.steps.subtitles;
  assert.ok(rs.lastMs > 0 && rs.shotMs > 0 && rs.assembleMs > 0 && ss.lastMs > 0, '지난번 시간을 기록해 두었다');
  const perShot = r.shotOf(2).motion ? rs.motionShotMs : rs.holdShotMs; // 컷 2 는 움직이는 장면
  assert.ok(perShot > 0, '움직이는/멈춘 장면 평균 시간도 기록해 둔다');
  assert.ok(Math.abs(s.changes.etaSec - (perShot + rs.assembleMs + ss.lastMs) / 1000) <= 1, `장면 1곳: ${s.changes.etaSec}초 ≈ (${perShot} + ${rs.assembleMs} + ${ss.lastMs})ms`);
  // 영상 만들기 중에는 반영 버튼이 꺼진다
  r.running = true;
  assert.strictEqual(r.snapshot().canApply, false);
  assert.deepStrictEqual(r.applyChanges(), { from: null }, '이미 돌고 있으면 무시');
  r.running = false;
});

test('끝나지 않은 단계가 있으면 그 단계부터: 자막 단계가 대기면 subtitles, 영상 단계가 멈췄으면 render — 완성 상태여도 막히지 않는다', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  r.p.steps.subtitles.status = 'pending';
  assert.strictEqual(r.snapshot().canApply, true);
  assert.strictEqual(r.applyFrom(), 'subtitles');
  r.p.steps.render.status = 'stopped';
  r.p.steps.subtitles.status = 'pending';
  assert.strictEqual(r.applyFrom(), 'render');
  r.p.steps.drawings.status = 'error';
  assert.strictEqual(r.applyFrom(), 'drawings');
  // 새 프로젝트(아직 아무것도 안 함)도 처음부터 시작할 수 있다고 본다
  const fresh = fx.store.createProject('새 영상', { ...fx.store.getWorkflow('builtin-cel-wide') }, {});
  const r2 = fx.runner({ projectId: fresh.id });
  assert.strictEqual(r2.applyFrom(), 'music');
  assert.strictEqual(r2.snapshot().canApply, true);
  assert.strictEqual(r2.snapshot().durationSec, null);
});

test('고친 장면만 새로 만든다: 카메라 한 곳 → 그 장면 영상만 다시, 나머지는 그대로. dirtyShots 는 끝나면 비고 영상·자막이 새로 만들어진다', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  const mt0 = [1, 2, 3].map((n) => mtime(shotFile(fx, n)));
  const keys0 = r.p.render.shots.map((x) => x.key);
  const clean = path.join(fx.dir, r.p.output.clean);
  const finalBefore = path.join(fx.dir, r.p.output.video);
  const madeAt0 = r.p.output.madeAt;
  const cleanMt0 = mtime(clean);
  r.setCamera(1, 'pan_left');
  assert.deepStrictEqual(r.p.dirtyShots, [1]);
  assert.strictEqual(r.p.renderStale, true);
  // timesheet.json · storyboard.md 도 바로 고쳐졌다
  const ts = JSON.parse(fs.readFileSync(path.join(fx.dir, 'output', 'timesheet.json'), 'utf8'));
  assert.strictEqual(ts.shots[0].camera.move, 'pan_left');
  assert.match(fs.readFileSync(path.join(fx.dir, 'output', 'storyboard.md'), 'utf8'), /컷 1 .*카메라 pan_left/);
  const logs = [];
  r.on('log', (l) => logs.push(l.line));
  const updates = [];
  r.on('update', (snap) => updates.push({ running: snap.running, step: snap.currentStep, canApply: snap.canApply, changes: snap.changes.count }));
  const t0 = Date.now();
  const fin = finished(r);
  const res = r.applyChanges();
  assert.deepStrictEqual(res, { from: 'render' });
  assert.strictEqual(r.running, true, '바로 돌려주고 뒤에서 만든다');
  assert.strictEqual(r.snapshot().canApply, false);
  assert.deepStrictEqual(r.applyChanges(), { from: null }, '돌고 있는 동안 또 눌러도 무시');
  await fin;
  const secs = (Date.now() - t0) / 1000;
  const p = r.snapshot();
  assert.strictEqual(p.status, 'done', p.error);
  assert.deepStrictEqual(p.dirtyShots, []);
  assert.strictEqual(p.renderStale, false);
  assert.strictEqual(p.subsStale, false);
  assert.deepStrictEqual(p.changes, { render: false, subs: false, shots: [], count: 0, etaSec: null });
  assert.strictEqual(p.canApply, false);
  // 바뀐 장면만 다시 만들었다 (컷 영상 파일 시간으로 확인)
  const mt1 = [1, 2, 3].map((n) => mtime(shotFile(fx, n)));
  assert.notStrictEqual(mt1[0], mt0[0], '컷 1 은 새로 만들었다');
  assert.strictEqual(mt1[1], mt0[1], '컷 2 는 그대로');
  assert.strictEqual(mt1[2], mt0[2], '컷 3 은 그대로');
  assert.notStrictEqual(p.render.shots[0].key, keys0[0]);
  assert.strictEqual(p.render.shots[1].key, keys0[1]);
  assert.strictEqual(p.render.shots[2].key, keys0[2]);
  assert.notStrictEqual(mtime(clean), cleanMt0, '깨끗한 원본은 다시 이었다');
  assert.ok(p.output.madeAt > madeAt0, '완성본(자막 입힌 영상)도 새로');
  assert.ok(fs.existsSync(path.join(fx.dir, p.output.video)));
  assert.strictEqual(path.join(fx.dir, p.output.video), finalBefore);
  const info = await probe(path.join(fx.dir, p.output.video));
  assert.ok(info.hasVideo && info.hasAudio && Math.abs(info.duration - 24) < 0.2);
  assert.ok(logs.some((l) => /고친 것 반영하기 시작/.test(l)));
  assert.ok(!logs.some((l) => /그림 그리기 시작|타임시트 .* 시작/.test(l)), '그림은 다시 그리지 않았다');
  assert.ok(updates.some((u) => u.running && u.step === 'render'), '진행 상황이 update 로 나갔다');
  assert.ok(updates.some((u) => u.running && u.step === 'subtitles'));
  // 이번에 잰 시간 (장면 하나만 새로 만들었으니 1/3)
  assert.strictEqual(p.steps.render.shotsRendered, 1);
  assert.strictEqual(p.steps.render.shotsTotal, 3);
  assert.ok(p.steps.render.lastMs > 0 && p.steps.render.assembleMs > 0);
  t.diagnostic(`장면 1곳만 고쳐서 반영: ${secs.toFixed(1)}초 (24초 노래, 480p, 장면 3개; 영상 ${p.steps.render.lastMs}ms + 자막 ${p.steps.subtitles.lastMs}ms)`);
});

test('자막만 고쳤으면 자막 입히기만: 깨끗한 원본과 컷 영상은 그대로, 완성본만 새로', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  const clean = path.join(fx.dir, r.p.output.clean);
  const cleanMt = mtime(clean);
  const mt0 = [1, 2, 3].map((n) => mtime(shotFile(fx, n)));
  const madeAt0 = r.p.output.madeAt;
  const out = r.saveSubtitles({ style: { preset: 'yellow' } });
  assert.strictEqual(out.style.preset, 'yellow');
  const snap = r.snapshot();
  assert.deepStrictEqual(snap.changes.shots, []);
  assert.strictEqual(snap.changes.subs, true);
  assert.strictEqual(snap.changes.render, false);
  assert.strictEqual(snap.changes.count, 1);
  assert.strictEqual(snap.canApply, true);
  assert.strictEqual(snap.subtitleStyle.preset, 'yellow');
  const fin = finished(r);
  const t0 = Date.now();
  assert.deepStrictEqual(r.applyChanges(), { from: 'subtitles' });
  await fin;
  const p = r.snapshot();
  assert.strictEqual(p.status, 'done', p.error);
  assert.strictEqual(p.subsStale, false);
  assert.strictEqual(mtime(clean), cleanMt, '깨끗한 원본은 그대로');
  assert.deepStrictEqual([1, 2, 3].map((n) => mtime(shotFile(fx, n))), mt0);
  assert.ok(p.output.madeAt > madeAt0);
  assert.strictEqual(p.changes.count, 0);
  t.diagnostic(`자막만 반영: ${((Date.now() - t0) / 1000).toFixed(1)}초`);
});

test('자막만 바뀌었는데 깨끗한 원본이 지워졌다면 영상부터 다시 만든다', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  r.setSubtitleStyle({ preset: 'box' });
  fs.unlinkSync(path.join(fx.dir, r.p.output.clean));
  assert.strictEqual(r.applyFrom(), 'render');
});

test('장면 넘기기(setTransition) · 효과(setFx): 검사 · 양쪽 장면이 바뀐 장면 · timesheet.json 과 storyboard.md 갱신 · 컷 영상 다시 만들기', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  const xs = r.p.xsheet;
  const before = JSON.parse(JSON.stringify(xs.transitions));
  assert.ok(before.every((x) => x.type === 'cut' || x.frames > 0));
  // 알 수 없는 것 · 마지막 컷 · 없는 컷
  assert.throws(() => r.setTransition(1, 'bogus'), /알 수 없는 장면 넘기기예요: bogus/);
  assert.throws(() => r.setTransition(1, '__proto__'), /알 수 없는 장면 넘기기예요/);
  assert.throws(() => r.setTransition(3, 'fade'), /마지막 장면은 다음 장면이 없어서/);
  assert.throws(() => r.setTransition(9, 'fade'), /장면을 찾을 수 없어요/);
  assert.throws(() => r.setFx(1, ['explosion']), /알 수 없는 효과예요: explosion/);
  assert.throws(() => r.setFx(1, ['fade_in', 'fade_out', 'flash', 'sparkle']), /3개까지/);
  assert.deepStrictEqual(r.p.dirtyShots || [], [], '틀린 요청은 아무것도 바꾸지 않는다');
  assert.deepStrictEqual(r.p.xsheet.transitions, before);
  // 전환
  const tr = r.setTransition(2, 'fadeblack');
  assert.strictEqual(tr.type, 'fadeblack');
  assert.strictEqual(tr.xfade, 'fadeblack');
  assert.ok(tr.frames >= 2 && tr.frames % 2 === 0);
  assert.strictEqual(tr.duration, Math.round((tr.frames / 24) * 1000) / 1000);
  assert.deepStrictEqual(r.p.xsheet.transitions[1], tr);
  assert.strictEqual(r.shotOf(2).transition_out.type, 'fadeblack');
  assert.deepStrictEqual(r.p.dirtyShots, [2, 3], '앞뒤 두 장면');
  // 길이를 지킨 채 다른 모양으로
  const tr2 = r.setTransition(2, 'dissolve');
  assert.strictEqual(tr2.frames, tr.frames, '길이(frames)는 그대로');
  const cut = r.setTransition(2, 'cut');
  assert.deepStrictEqual(cut, { type: 'cut', xfade: null, duration: 0, frames: 0 });
  assert.deepStrictEqual(r.shotOf(2).transition_out, { type: 'cut', beats: 0 });
  r.setTransition(2, 'flash');
  // 효과
  const sh = r.setFx(1, ['fadein', 'shake']);
  assert.deepStrictEqual(sh.fx, ['fade_in', 'shake']);
  assert.ok(sh.camera.start.zoom >= 1.06 && sh.camera.end.zoom >= 1.06, '흔들기 효과는 확대 여유가 필요하다');
  assert.deepStrictEqual(r.p.dirtyShots, [1, 2, 3]);
  const none = r.setFx(3, []);
  assert.deepStrictEqual(none.fx, []);
  // 파일이 같이 고쳐졌다
  const ts = JSON.parse(fs.readFileSync(path.join(fx.dir, 'output', 'timesheet.json'), 'utf8'));
  assert.strictEqual(ts.transitions[1].type, 'flash');
  assert.deepStrictEqual(ts.shots[0].fx, ['fade_in', 'shake']);
  const sbText = fs.readFileSync(path.join(fx.dir, 'output', 'storyboard.md'), 'utf8');
  assert.match(sbText, /컷 1 .*효과 fade_in, shake/);
  assert.match(sbText, /컷 2 .* → flash/);
  // 디스크에도 저장됐다
  assert.strictEqual(fx.store.loadProject(fx.projectId).xsheet.transitions[1].type, 'flash');
  assert.deepStrictEqual(fx.store.loadProject(fx.projectId).dirtyShots, [1, 2, 3]);
  // 실제로 영상에 반영: 장면 1, 2, 3 이 모두 바뀐 장면이라 모두 새로 (넘기기 길이가 앞뒤 장면 영상에 들어간다)
  const mt0 = [1, 2, 3].map((n) => mtime(shotFile(fx, n)));
  const fin = finished(r);
  assert.deepStrictEqual(r.applyChanges(), { from: 'render' });
  await fin;
  assert.strictEqual(r.p.status, 'done', r.p.error);
  assert.deepStrictEqual(r.p.dirtyShots, []);
  const mt1 = [1, 2, 3].map((n) => mtime(shotFile(fx, n)));
  assert.ok(mt1.every((m, i) => m !== mt0[i]), '효과·전환이 바뀐 세 장면 모두 새로');
  assert.strictEqual(fx.store.loadProject(fx.projectId).xsheet.transitions[1].type, 'flash');
});

test('길이 · 카메라를 고치면 timesheet.json 과 storyboard.md 가 같이 고쳐진다 (예전엔 낡은 채로 남았다)', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  const hold = r.p.xsheet.shots.find((s) => !s.motion && s.exposure.length > 1);
  r.retime(hold.shot, 0, hold.exposure[0].frames + 12);
  const ts = JSON.parse(fs.readFileSync(path.join(fx.dir, 'output', 'timesheet.json'), 'utf8'));
  assert.strictEqual(ts.shots.find((s) => s.shot === hold.shot).exposure[0].frames, hold.exposure[0].frames + 12);
  assert.match(fs.readFileSync(path.join(fx.dir, 'output', 'storyboard.md'), 'utf8'), new RegExp(`노출: A×${hold.exposure[0].frames + 12}`));
  assert.throws(() => r.setCamera(hold.shot, 'zigzag'), /알 수 없는 카메라 움직임이에요/);
  assert.throws(() => r.setCamera(77, 'pan_left'), /장면을 찾을 수 없어요/);
  assert.throws(() => r.retime(77, 0, 5), /장면을 찾을 수 없어요/);
  assert.deepStrictEqual(r.p.dirtyShots, [hold.shot]);
});

test('step_render 가 끝나면 고친 장면 기록이 지워진다 (예전 projects: renderStale 만 있어도)', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  // 옛 프로젝트: dirtyShots 없이 renderStale 만 켜진 채 저장됨
  r.p.renderStale = true;
  delete r.p.dirtyShots;
  const s = r.snapshot();
  assert.strictEqual(s.changes.render, true);
  assert.deepStrictEqual(s.changes.shots, []);
  assert.strictEqual(s.changes.count, 1, '장면을 몰라도 고친 것이 있다고 센다');
  assert.ok(s.changes.etaSec > 0);
  assert.strictEqual(s.canApply, true);
  assert.strictEqual(r.applyFrom(), 'render');
});
