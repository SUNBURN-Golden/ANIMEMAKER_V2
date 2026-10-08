// 고치기 시험 (Node): 다시 그리기 · 예전 그림 ≤ 6 · 되돌리기 · 내 그림 · 고친 것 반영하기 표 · 영상 만드는 중 막기 · PC 앱과 같은 결과(자막·시간) · 폰 가볍게 숫자
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import {
  newEngine, fakeServices, resetDb, db, songBlob, imgBlob, aiProject, driveToDrawings, DD,
} from './engine-fixtures.js';
import * as jobs from '../src/jobs.js';
import { estimateHandoffs, makeWorkflow, WORKFLOW_INFO } from '../src/engine/workflows.js';
import { cutsFixed } from '../src/engine/edits.js';

const require = createRequire(import.meta.url);
const EC = require('../../src/main/pipeline/edits-core.js');
const X = require('../../src/main/pipeline/xsheet.js');

beforeEach(async () => { await resetDb(); });
afterEach(() => { jobs.setJobHooks({}); });

const file = (label, name = `${label}.png`, mime = 'image/png') => ({ name, mime, blob: imgBlob(label, mime) });
const text = async (key) => (await db.getFile(key)).text();

/** AI 앱 모드로 에피소드 하나를 끝까지 (그림은 모두 직접 넣는다) */
async function finishEpisode(engine, o = {}) {
  const id = await aiProject(engine, o);
  const s0 = await driveToDrawings(engine, id, o);
  await engine.handoff.acceptFiles(id, s0.queue.map((q, i) => file(`p${i}`)));
  await engine.whenIdle(id);
  const s = await engine.projects.get(id);
  assert.strictEqual(s.status, 'done');
  return { id, s, q: s0.queue };
}

test('다시 그리기: 요청서(지금 그림 첫 번째 + USER CHANGE REQUEST) · 줄에 서는 동안 다른 고치기는 막히지 않는다 · 같은 그림 두 번은 하나로 · 취소', async () => {
  const { engine } = newEngine();
  const { id, s, q } = await finishEpisode(engine);
  const c = q.find((x) => x.kind === 'cel');
  const req = await engine.drawings.regenerate(id, c.shot, c.id, { note: '  웃는\n얼굴로  ' });
  assert.strictEqual(req.redraw, true);
  assert.strictEqual(req.kind, 'cel');
  assert.match(req.files[0].note, /the current drawing of this same shot — EDIT this image/);
  assert.match(req.prompt, /EDIT MODE: Edit the first attached image \(the current drawing of this shot\)/);
  assert.match(req.prompt, /USER CHANGE REQUEST: 웃는 얼굴로 \(keep the character design, palette and everything else identical\)/);
  assert.match(req.prompt, /plain flat solid #00FF00 background/i);
  let snap = await engine.projects.get(id);
  assert.deepStrictEqual(snap.redrawing.map((r) => [r.shot, r.id, r.status]), [[c.shot, c.id, 'queued']]);
  assert.strictEqual(snap.next.kind, 'handoff');
  assert.strictEqual(snap.next.handoffKind, 'redraw');
  // 다시 그리는 중에도 카메라·자막은 고칠 수 있다
  await engine.edits.setCamera(id, c.shot, 'zoom_in');
  await engine.edits.setSubtitleStyle(id, { preset: 'yellow' });
  // 같은 그림을 또 부탁하면 하나로 (마지막 요청 글로)
  await engine.drawings.regenerate(id, c.shot, c.id, { note: '두 번째 요청' });
  snap = await engine.projects.get(id);
  assert.strictEqual(snap.redrawing.length, 1);
  assert.strictEqual(snap.redrawing[0].note, '두 번째 요청');
  assert.strictEqual(await engine.drawings.cancelRedraw(id, c.shot + ':' + c.id), true);
  snap = await engine.projects.get(id);
  assert.deepStrictEqual(snap.redrawing, []);
  assert.strictEqual(await db.getExpecting(), null);
  assert.strictEqual(snap.drawings.find((d) => d.key === c.key).history.length, 0, '취소하면 지금 그림 그대로');
  await assert.rejects(() => engine.drawings.regenerate(id, 99, 'Z', {}), /그림을 찾을 수 없어요/);
});

test('다시 그리기 7번: 예전 그림은 최대 6개(가장 최근이 앞), 가장 오래된 파일은 지워진다 · 받은 새 그림은 custom · 요청 글이 남는다', async () => {
  const { engine } = newEngine();
  const { id, q } = await finishEpisode(engine);
  const c = q.find((x) => x.kind === 'cel');
  for (let i = 1; i <= 7; i++) {
    await engine.drawings.regenerate(id, c.shot, c.id, { note: `요청 ${i}` });
    const r = await engine.handoff.acceptFiles(id, [file(`redo${i}`)]);
    assert.strictEqual(r.placed[0].mode, 'redraw');
  }
  const s = await engine.projects.get(id);
  const d = s.drawings.find((x) => x.key === c.key);
  assert.strictEqual(d.history.length, 6);
  assert.strictEqual(d.note, '요청 7');
  assert.strictEqual(d.custom, true);
  assert.strictEqual(d.redraws, 7);
  assert.deepStrictEqual(d.history.map((h) => h.note), ['요청 6', '요청 5', '요청 4', '요청 3', '요청 2', '요청 1'], '가장 최근이 앞, 그림마다 그 그림을 그릴 때의 요청');
  assert.deepStrictEqual(d.history.map((h) => h.kind), Array(6).fill('ai'));
  const histKeys = (await db.listFileKeys(`${id}/hist/`)).filter((k) => k.includes(`_${c.id}.v`));
  assert.strictEqual(histKeys.length, 6, '7번째에서 가장 오래된 파일이 지워졌다');
  assert.strictEqual(await text(`${id}/pic/${String(c.shot).padStart(2, '0')}_${c.id}`), 'ORIG:IMG:redo7');
  assert.ok(s.dirtyShots.includes(c.shot) && s.renderStale);
  assert.deepStrictEqual(s.redrawing, []);
  assert.deepStrictEqual(s.changes.shots.includes(c.shot), true);
});

test('되돌리기: 예전 그림과 지금 그림이 자리를 바꾼다(앞뒤로 오갈 수 있다), 배경 빼기도 다시 한다 · 없는 번호는 쉬운 한국어 오류', async () => {
  const { engine, services } = newEngine();
  const { id, q } = await finishEpisode(engine);
  const c = q.find((x) => x.kind === 'cel');
  const pic = `${id}/pic/${String(c.shot).padStart(2, '0')}_${c.id}`;
  const cel = `${id}/cel/${String(c.shot).padStart(2, '0')}_${c.id}`;
  for (const n of ['a', 'b']) {
    await engine.drawings.regenerate(id, c.shot, c.id, {});
    await engine.handoff.acceptFiles(id, [file(n)]);
  }
  assert.strictEqual(await text(pic), 'ORIG:IMG:b');
  const before = services.calls.ingest.length;
  const r = await engine.drawings.restoreVersion(id, c.shot, c.id, 0);
  assert.strictEqual(await text(pic), 'ORIG:IMG:a');
  assert.strictEqual(await text(cel), 'CEL:ORIG:IMG:a', '셀도 되돌린 그림으로 다시');
  assert.strictEqual(services.calls.ingest.length, before + 1);
  assert.strictEqual(services.calls.ingest.at(-1).skipOrig, true, '이미 저장된 원본에서 셀만 다시 만든다');
  assert.strictEqual(r.history.length, 2, '개수는 그대로: 지금 그림이 예전 그림 맨 앞으로');
  assert.match((await (await engine._runtime(id)).drawings.get(c.key)).history[0].file, /\.v3\.img$/, '새 번호가 붙는다');
  assert.strictEqual(await text((await engine._runtime(id)).drawings.get(c.key).history[0].file), 'ORIG:IMG:b', '지금 그림은 예전 그림 맨 앞으로');
  await engine.drawings.restoreVersion(id, c.shot, c.id, 0); // 다시 되돌려 원래대로
  assert.strictEqual(await text(pic), 'ORIG:IMG:b');
  const s = await engine.projects.get(id);
  const d = s.drawings.find((x) => x.key === c.key);
  assert.strictEqual(d.history.length, 2);
  assert.ok(d.custom && s.dirtyShots.includes(c.shot));
  await assert.rejects(() => engine.drawings.restoreVersion(id, c.shot, c.id, 9), /그 예전 그림을 찾을 수 없어요/);
});

test('내 그림으로 바꾸기: custom · 옛 그림은 예전 그림에 · 색 맞추기 기본 끔 · 두 번 바꾸면 내 그림도 기록에 · 순서표를 다시 짜도 내 그림은 남고 바뀐 AI 그림은 기록으로', async () => {
  const { engine, services } = newEngine();
  const { id, q } = await finishEpisode(engine);
  const cels = q.filter((x) => x.kind === 'cel');
  const c = cels.find((x) => cels.some((y) => y !== x && y.shot === x.shot && y.id < x.id)) || cels[1]; // 같은 장면 둘째 그림(색 맞추기 기준이 따로 있는)
  const r1 = await engine.drawings.replace(id, c.shot, c.id, imgBlob('mine1'));
  assert.ok(r1.custom && r1.source === 'user' && r1.history.length === 1 && r1.history[0].kind === 'ai');
  assert.strictEqual(services.calls.ingest.at(-1).refStats, null, '내 그림은 색 맞추기 기본 끔');
  await engine.drawings.replace(id, c.shot, c.id, imgBlob('mine2'), { matchColors: true });
  assert.notStrictEqual(services.calls.ingest.at(-1).refStats, undefined);
  const s = await engine.projects.get(id);
  const d = s.drawings.find((x) => x.key === c.key);
  assert.strictEqual(d.history.length, 2);
  assert.strictEqual(d.history[0].kind, 'user', '두 번 바꾸면 내 그림도 기록에');
  await assert.rejects(() => engine.drawings.replace(id, c.shot, c.id, new Blob(['x'], { type: 'text/plain' })), /그림 파일\(png, jpg, webp\)을 골라 주세요/);
  await assert.rejects(() => engine.drawings.replace(id, c.shot, c.id, null), /고른 그림 파일을 찾을 수 없어요/);
  // 순서표를 PC 방식으로 다시 짠다 → 내 그림(custom)은 남는다
  const keepKey = c.key;
  const beforeText = await text(d.history.length ? `${id}/pic/${String(c.shot).padStart(2, '0')}_${c.id}` : '');
  await engine.run(id, { from: 'xsheet' });
  assert.strictEqual((await engine.projects.get(id)).waiting.key, 'handoff:xsheet');
  await engine.skipWaiting(id, 'xsheet');
  await engine.whenIdle(id);
  const s2 = await engine.projects.get(id);
  const kept = s2.drawings.find((x) => x.key === keepKey);
  if (kept) {
    assert.strictEqual(kept.status, 'done');
    assert.strictEqual(kept.custom, true);
    assert.strictEqual(await text(`${id}/pic/${String(c.shot).padStart(2, '0')}_${c.id}`), beforeText);
  }
  // 바뀐 주문 글 때문에 다시 받아야 하는 AI 그림은 사라지지 않고 예전 그림으로 옮겨진다
  const archived = s2.drawings.filter((x) => x.status === 'pending' && x.history.length > 0);
  assert.ok(archived.length > 0, '다시 받아야 하는 그림이 있고, 옛 그림은 기록에 있다');
  for (const a of archived) assert.ok(await db.getFile(`${id}/hist/${String(a.shot).padStart(2, '0')}_${a.id}.v1.img`));
  // 순서표에서 사라진 그림의 덩어리는 지워진다 (고아 파일 없음)
  const live = new Set(s2.drawings.map((x) => `${String(x.shot).padStart(2, '0')}_${x.id}`));
  for (const k of await db.listFileKeys(`${id}/pic/`)) assert.ok(live.has(k.split('/').pop()), `고아 파일: ${k}`);
  for (const k of await db.listFileKeys(`${id}/cel/`)) assert.ok(live.has(k.split('/').pop()), `고아 파일: ${k}`);
});

test('배경 판 다시 그리기: 지금 배경이 첫 번째 첨부(인물 없음 안내) · 그 배경을 같이 쓰는 모든 장면이 바뀐 장면 · 한 장면 전부 다시(배경 → 그림 차례로)', async () => {
  const { engine } = newEngine();
  const { id, s, q } = await finishEpisode(engine);
  const bg = q.find((x) => x.kind === 'bg');
  const group = s.xsheet.bgGroups.find((g) => g.leader === bg.shot);
  const req = await engine.drawings.regenerate(id, bg.shot, 'bg', { note: '노을 지는 하늘로' });
  assert.strictEqual(req.kind, 'bg');
  assert.match(req.files[0].note, /current background painting/);
  assert.match(req.prompt, /EDIT MODE: Edit the first attached image \(the current background painting of this shot\)/);
  assert.match(req.prompt, /Do not add any characters/);
  await engine.handoff.acceptFiles(id, [file('sunset')]);
  const s1 = await engine.projects.get(id);
  assert.deepStrictEqual(s1.dirtyShots, group.shots);
  // 한 장면 전부 다시: 배경 → 열쇠 그림 차례로, 각 그림은 앞(새) 그림을 고쳐서
  const shotNo = s.xsheet.shots.find((x) => x.drawings.length >= 2).shot;
  const first = await engine.drawings.regenerateCut(id, shotNo);
  const snap = await engine.projects.get(id);
  assert.ok(snap.redrawing.length >= 3 && snap.redrawing[0].id === 'bg');
  assert.strictEqual(first.key, snap.redrawing[0].key);
  const seen = [first.key];
  for (let i = 0; i < 10; i++) {
    const r = await engine.handoff.acceptFiles(id, [file(`cut${i}`)]);
    assert.strictEqual(r.placed.length, 1);
    const n = await engine.handoff.request(id);
    if (!n) break;
    seen.push(n.key);
    if (n.kind === 'cel' && seen.length >= 3) assert.match(n.prompt, /EDIT MODE: Edit the first attached image \(the previous drawing of this same shot/);
  }
  assert.deepStrictEqual((await engine.projects.get(id)).redrawing, []);
  assert.ok(seen.length >= 3);
});

test('고친 것 반영하기 표: (a) 끝나지 않은 단계 → (b) 영상 → (c) 자막 → (d) 할 일 없음 · 깨끗한 원본이 없으면 영상부터 · 기다리는 중/만드는 중이면 시작하지 않는다', async () => {
  // 순수 표
  const steps = (o = {}) => Object.fromEntries(['music', 'plan', 'timing', 'xsheet', 'drawings', 'render', 'subtitles'].map((s) => [s, { status: o[s] || 'done' }]));
  const d = ({ steps: st, ...o }) => EC.decideApplyFrom({ steps: steps(st), renderStale: false, dirtyShots: [], subsStale: false, hasClean: true, ...o });
  assert.strictEqual(d({ steps: { drawings: 'pending' } }), 'drawings');
  assert.strictEqual(d({ steps: { subtitles: 'pending' }, subsStale: true }), 'subtitles');
  assert.strictEqual(d({ dirtyShots: [2] }), 'render');
  assert.strictEqual(d({ renderStale: true, subsStale: true }), 'render');
  assert.strictEqual(d({ subsStale: true }), 'subtitles');
  assert.strictEqual(d({ subsStale: true, hasClean: false }), 'render');
  assert.strictEqual(d({}), null);
  // 엔진
  const { engine, services } = newEngine();
  const { id, s } = await finishEpisode(engine);
  assert.deepStrictEqual(s.changes, { render: false, subs: false, shots: [], count: 0, etaSec: null });
  assert.strictEqual(s.canApply, false);
  assert.deepStrictEqual(await engine.applyChanges(id), { from: null }, '할 일이 없다');
  const shotNo = s.xsheet.shots[1].shot;
  await engine.edits.setCamera(id, shotNo, 'pan_left');
  let snap = await engine.projects.get(id);
  assert.deepStrictEqual(snap.changes.shots, [shotNo]);
  assert.strictEqual(snap.changes.count, 1);
  assert.ok(snap.changes.etaSec > 0);
  assert.strictEqual(snap.canApply, true);
  assert.strictEqual(snap.next.kind, 'apply');
  const exportsBefore = services.calls.exports.length;
  const burnsBefore = services.calls.burns.length;
  assert.deepStrictEqual(await engine.applyChanges(id), { from: 'render' });
  await engine.whenIdle(id);
  snap = await engine.projects.get(id);
  assert.strictEqual(snap.status, 'done');
  assert.strictEqual(services.calls.exports.length, exportsBefore + 1, '영상을 다시 만들었다');
  assert.strictEqual(services.calls.burns.length, burnsBefore + 1);
  assert.deepStrictEqual(snap.dirtyShots, []);
  assert.strictEqual(snap.renderStale, false);
  assert.strictEqual(snap.subsStale, false);
  // 자막만 고치면 자막 입히기만
  await engine.edits.setSubtitleStyle(id, { preset: 'box' });
  snap = await engine.projects.get(id);
  assert.deepStrictEqual([snap.changes.render, snap.changes.subs, snap.changes.count], [false, true, 1]);
  assert.strictEqual(snap.steps.subtitles.status, 'pending');
  assert.deepStrictEqual(await engine.applyChanges(id), { from: 'subtitles' });
  await engine.whenIdle(id);
  assert.strictEqual(services.calls.exports.length, exportsBefore + 1, '영상은 그대로');
  assert.strictEqual(services.calls.burns.length, burnsBefore + 2);
  assert.strictEqual(services.calls.burns.at(-1).style.preset, 'box');
  // 깨끗한 원본이 지워졌다면 영상부터
  await engine.edits.setSubtitleStyle(id, { preset: 'basic' });
  const rt = await engine._runtime(id);
  rt.p.output.clean = null;
  assert.deepStrictEqual(await engine.applyChanges(id), { from: 'render' });
  await engine.whenIdle(id);
  // 기다리는 부탁이 있으면 시작하지 않는다 (그 부탁부터)
  await engine.run(id, { from: 'xsheet' });
  assert.strictEqual((await engine.projects.get(id)).canApply, false);
  assert.deepStrictEqual(await engine.applyChanges(id), { from: null });
});

test('고치기 검사와 영상 만드는 중 막기: 알 수 없는 값은 쉬운 한국어로, 만드는 중에는 바꿀 수 없다(자막·가사 글은 허용)', async () => {
  const sv = fakeServices({ exportDelay: 40 });
  const { engine } = newEngine({ services: sv });
  const { id, s } = await finishEpisode(engine);
  const n = s.xsheet.shots.length;
  const last = s.xsheet.shots[n - 1].shot;
  await assert.rejects(() => engine.edits.setCamera(id, s.xsheet.shots[0].shot, 'spin'), /알 수 없는 카메라 움직임이에요/);
  await assert.rejects(() => engine.edits.setCamera(id, 99, 'zoom_in'), /장면을 찾을 수 없어요/);
  await assert.rejects(() => engine.edits.setFx(id, s.xsheet.shots[0].shot, ['magic']), /알 수 없는 효과예요: magic/);
  await assert.rejects(() => engine.edits.setFx(id, s.xsheet.shots[0].shot, ['flash', 'shake', 'sparkle', 'fade_in']), /3개까지만/);
  await assert.rejects(() => engine.edits.setTransition(id, last, 'fade'), /마지막 장면은 다음 장면이 없어서/);
  await assert.rejects(() => engine.edits.setTransition(id, s.xsheet.shots[0].shot, 'warp'), /알 수 없는 장면 넘기기예요: warp/);
  const tr = await engine.edits.setTransition(id, s.xsheet.shots[0].shot, 'dissolve');
  assert.strictEqual(tr.type, 'dissolve');
  assert.ok(tr.frames % 2 === 0 && tr.frames > 0);
  const snap = await engine.projects.get(id);
  assert.deepStrictEqual(snap.dirtyShots, [s.xsheet.shots[0].shot, s.xsheet.shots[1].shot], '앞뒤 두 장면이 바뀐 장면');
  const fx = await engine.edits.setFx(id, s.xsheet.shots[2].shot, ['shake', 'flash']);
  assert.deepStrictEqual(fx.fx.slice().sort(), ['flash', 'shake']);
  const multi = s.xsheet.shots.find((x) => x.exposure.length >= 2);
  const rt0 = await engine.edits.retime(id, multi.shot, 0, multi.exposure[0].frames + 2);
  assert.strictEqual(rt0.exposure.reduce((a, e) => a + e.frames, 0), multi.frames, '프레임 합계는 그대로');
  const single = s.xsheet.shots.find((x) => x.exposure.length === 1);
  if (single) await assert.rejects(() => engine.edits.retime(id, single.shot, 0, 6), /노출이 한 칸뿐인 컷/);
  // 만드는 중에는 막힌다
  const run = engine.run(id, { from: 'render' });
  for (let i = 0; i < 400; i++) { const p = engine.projects.peek(id); if (p && p.currentStep === 'render' && p.status === 'running') break; await new Promise((r) => setTimeout(r, 5)); }
  const sh = s.xsheet.shots[0].shot;
  await assert.rejects(() => engine.edits.setCamera(id, sh, 'zoom_in'), /지금은 영상을 만드는 중이에요\. 끝난 뒤에 바꿔 주세요/);
  await assert.rejects(() => engine.edits.retime(id, sh, 0, 6), /영상을 만드는 중/);
  await assert.rejects(() => engine.edits.setFx(id, sh, []), /영상을 만드는 중/);
  await assert.rejects(() => engine.edits.setTransition(id, sh, 'fade'), /영상을 만드는 중/);
  await assert.rejects(() => engine.drawings.replace(id, sh, 'A', imgBlob('z')), /영상을 만드는 중/);
  await assert.rejects(() => engine.drawings.regenerate(id, sh, 'A', {}), /영상을 만드는 중이에요\. 끝난 뒤에 그림을 다시 그려 주세요/);
  await engine.edits.setSubtitleStyle(id, { size: 'l' }); // 자막 모양은 영상 만드는 중에도
  await run;
  assert.strictEqual((await engine.projects.get(id)).status, 'done');
});

test('PC 앱과 같은 결과: 가사 글·줄·탭 시간·자막 모양·길이·카메라 — 같은 입력을 PC 러너 메서드와 폰 엔진에 넣어 견준다', async (t) => {
  let ProjectRunner;
  try { ({ ProjectRunner } = require('../../src/main/pipeline/runner.js')); } catch (e) { t.skip(`PC 러너를 불러올 수 없어요: ${e.message}`); return; }
  const { engine } = newEngine();
  const id = await engine.projects.create({ workflow: 'demo', aspect: '16:9' });
  const base = await engine.demo.fill(id);
  const rt = await engine._runtime(id);
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const snapshotOf = (p) => ({ lyrics: p.timing.lyrics, source: p.timing.lyricsSource, input: p.lyricsInput, sub: p.workflow.subtitles, stale: !!p.subsStale, subStep: p.steps.subtitles && p.steps.subtitles.status, segLy: p.timing.segments.map((s) => s.lyrics), dirty: p.dirtyShots || [], renderStale: !!p.renderStale });
  const desktop = (p) => {
    const r = Object.create(ProjectRunner.prototype);
    Object.assign(r, { p, store: { series: { save() {} } }, running: false, redrawQueue: [], log() {}, save() {}, emit() {}, writeStoryboard() {}, persistXsheet() {}, dir: '/tmp/none' });
    return r;
  };
  const start = clone(rt.p);
  const reset = () => { rt.p = clone(start); rt.drawings = new Map([...rt.drawings]); };
  const lines = start.timing.lyrics;
  const rawSame = lines.map((l, i) => (i === 1 ? `${l.text} 요` : l.text)).join('\n');
  const rawInsert = [lines[0].text, '새로 끼워 넣은 줄', ...lines.slice(1).map((l) => l.text)].join('\n');
  const rawNew = '완전히 새 가사 하나\n둘째 줄\n셋째 줄';
  // 탭으로 맞춘 상태에서 시작해야 줄 끼워 넣기가 시간을 지킨다
  const tapped = clone(start);
  tapped.timing.lyricsSource = 'tap';
  for (const [name, raw, filename] of [['같은 줄 수', rawSame, 'a.txt'], ['줄 끼워 넣기', rawInsert, 'a.txt'], ['몽땅 새 가사', rawNew, 'a.txt']]) {
    for (const from of [start, tapped]) {
      rt.p = clone(from);
      const mine = await engine.edits.updateLyricsText(id, raw, filename, { dryRun: true });
      const r = desktop(clone(from));
      const theirs = r.updateLyricsText(raw, filename, { dryRun: true });
      assert.deepStrictEqual(mine, theirs, `${name} dryRun`);
      rt.p = clone(from);
      const m2 = await engine.edits.updateLyricsText(id, raw, filename, {});
      const t2 = r.updateLyricsText(raw, filename, {});
      assert.deepStrictEqual(m2, t2, `${name} 적용 결과`);
      const a = snapshotOf(rt.p);
      const b = snapshotOf(r.p);
      assert.deepStrictEqual(a, b, `${name} 상태`);
    }
  }
  // 줄 전체 교체 · 한꺼번에 저장 · 자막 모양
  const edit = clone(start.timing.lyrics).map((l, i) => ({ text: l.text, start: l.start + (i === 2 ? 0.2 : 0), end: l.end, ...(i === 3 ? { hidden: true } : {}), ...(i === 4 ? { endLocked: true } : {}) }));
  edit.push({ text: '추가한 줄', start: 40, end: 45 });
  rt.p = clone(start);
  const rr = desktop(clone(start));
  assert.deepStrictEqual(await engine.edits.setLyricLines(id, clone(edit)), rr.setLyricLines(clone(edit)));
  assert.deepStrictEqual(snapshotOf(rt.p), snapshotOf(rr.p), 'setLyricLines');
  rt.p = clone(start);
  const r3 = desktop(clone(start));
  const o = { style: { preset: 'yellow', size: 'xl', position: 'top' }, lines: clone(edit.slice(0, 5)) };
  assert.deepStrictEqual(await engine.edits.saveSubtitles(id, clone(o)), r3.saveSubtitles(clone(o)));
  assert.deepStrictEqual(snapshotOf(rt.p), snapshotOf(r3.p), 'saveSubtitles');
  rt.p = clone(start);
  const r4 = desktop(clone(start));
  assert.deepStrictEqual(await engine.edits.setSubtitleStyle(id, { color: '#ffd400', box: 'dark', font: 'jua' }), r4.setSubtitleStyle({ color: '#ffd400', box: 'dark', font: 'jua' }));
  assert.deepStrictEqual(snapshotOf(rt.p), snapshotOf(r4.p), 'setSubtitleStyle');
  await assert.rejects(() => engine.edits.saveSubtitles(id, { style: { preset: 'basic' }, lines: 'x' }), /가사 줄 목록이 올바르지 않아요/);
  // 탭 시간 저장: 숨김 · endLocked · words 이어받기
  const withExtras = clone(start);
  withExtras.timing.lyrics[1].hidden = true;
  withExtras.timing.lyrics[2].endLocked = true;
  withExtras.timing.lyrics[3].words = [{ text: 'a', start: 1, end: 2 }];
  const tapIn = withExtras.timing.lyrics.map((l, i) => ({ text: l.text, start: l.start + 0.05, end: l.end, part: 1, section: l.section, sectionStart: l.sectionStart, ...(i === 1 ? {} : {}) }));
  rt.p = clone(withExtras);
  const r5 = desktop(clone(withExtras));
  await engine.edits.updateLyrics(id, clone(tapIn));
  r5.updateLyrics(clone(tapIn));
  assert.deepStrictEqual(snapshotOf(rt.p), snapshotOf(r5.p), 'updateLyrics');
  // 길이 · 카메라
  rt.p = clone(start);
  const r6 = desktop(clone(start));
  const sh0 = start.xsheet.shots[0];
  const a1 = await engine.edits.retime(id, sh0.shot, 0, 9);
  const b1 = r6.retime(sh0.shot, 0, 9);
  assert.deepStrictEqual(a1.exposure, b1.exposure);
  const a2 = await engine.edits.setCamera(id, sh0.shot, 'truck_in');
  const b2 = r6.setCamera(sh0.shot, 'truck_in');
  assert.deepStrictEqual(a2.camera, b2.camera);
  assert.deepStrictEqual(snapshotOf(rt.p).dirty, snapshotOf(r6.p).dirty);
  assert.strictEqual(base.status, 'done');
  assert.strictEqual(cutsFixed(rt.p), cutsFixed(r6.p));
});

test('폰 가볍게 숫자(3~4분 연습 노래, PC 방식 순서표): 그림 34~50장 · 움직이는 장면 2개 이하 · 멈춘 장면 그림 2장 이하 · 배경은 막마다 1장 — 부탁 횟수·분은 가정', async () => {
  const lyrics = DD.DEMO_LYRICS;
  const out = [];
  for (const aspect of ['16:9', '9:16']) {
    for (const sec of [180, 210, 240]) {
      const { engine } = newEngine();
      const id = await aiProject(engine, { songBlob: songBlob(sec), aspect, lyricsText: lyrics });
      const s = await driveToDrawings(engine, id, { fallback: true, approve: false });
      const e = s.xsheet.estimate;
      const holds = s.xsheet.shots.filter((x) => !x.motion);
      out.push(`${aspect} ${sec}s: 컷 ${s.xsheet.shots.length} 그림 ${e.images} (배경 ${e.bg}+인물 ${e.cels}) 움직임 ${e.motionShots} 부탁 ${e.requests}번 ${e.minutes}분`);
      assert.ok(e.images >= 34 && e.images <= 50, `${aspect} ${sec}s: 그림 ${e.images}장`);
      assert.ok(e.motionShots <= 2, '움직이는 장면은 2개까지');
      assert.ok(holds.every((x) => x.drawings.length <= 2), '멈춘 장면 그림은 2장까지');
      assert.ok(e.bg <= 4 && e.bg >= 1, '배경은 막마다 한 장 (연습 이야기는 4막)');
      assert.strictEqual(e.requests, e.images + 2);
      assert.strictEqual(e.minutes, Math.ceil(e.requests * 1.25));
      assert.ok(e.minutesLow < e.minutes && e.minutes < e.minutesHigh);
      assert.match(e.assumption, /어림한 값/);
      assert.strictEqual(s.drawings.length, e.images);
      assert.ok(s.xsheet.shots.every((x) => x.exposure.reduce((a, v) => a + v.frames, 0) === x.frames));
      assert.strictEqual(s.xsheet.totalFrames, s.xsheet.shots.reduce((a, x) => a + x.frames, 0));
      assert.strictEqual(s.waiting.estimate.pictures, e.images);
    }
  }
  console.log(out.join('\n'));
  // 폰 지브리식은 훨씬 많고 시간 경고가 뜬다
  const { engine } = newEngine();
  const id = await aiProject(engine, { workflow: 'phone-ghibli', songBlob: songBlob(210), aspect: '16:9', lyricsText: lyrics });
  const g = await driveToDrawings(engine, id, { fallback: true, approve: false });
  assert.ok(g.xsheet.estimate.images > 80 && g.xsheet.estimate.minutes >= 120);
  assert.ok(g.xsheet.estimate.warning && WORKFLOW_INFO['phone-ghibli'].warning);
  assert.ok(g.xsheet.estimate.motionShots > 2);
  assert.ok(g.waiting.alt && g.waiting.alt.pictures < g.xsheet.estimate.images, '[그림 줄여서 빨리] 후보');
  assert.strictEqual(WORKFLOW_INFO['phone-lite'].warning, null);
  // 연습 노래 길이 · 워크플로우 모양
  const wf = makeWorkflow('phone-lite', { aspect: '9:16' });
  assert.deepStrictEqual([wf.motionMode, wf.inbetween, wf.layers, wf.quality, wf.finish.grain, wf.phone.maxMotionShots, wf.phone.maxHoldCels], ['ghibli', 'off', true, '720p', false, 2, 2]);
  assert.ok(estimateHandoffs({ layers: true, shots: [{ drawings: [{}, {}], frames: 48, motion: false }], bgGroups: [{ leader: 1, shots: [1] }] }).images === 3);
});

test('그림 줄여서 빨리(setMotion): 어림 → 바꾸기 → 카드 갱신 · 이미 받은 그림은 주문이 같으면 유지 · 잘못된 값/늦은 변경은 쉬운 한국어 오류', async () => {
  const { engine } = newEngine();
  const id = await aiProject(engine, { workflow: 'phone-ghibli', songBlob: songBlob(120), aspect: '16:9', lyricsText: DD.DEMO_LYRICS });
  const s0 = await driveToDrawings(engine, id, { fallback: true, approve: false });
  assert.strictEqual(s0.waiting.key, 'review:drawings');
  const est = await engine.edits.estimateMotion(id, { motionMode: 'limited' });
  assert.ok(est.ready && est.pictures < s0.xsheet.estimate.images && est.source === 'current');
  assert.strictEqual((await engine.projects.get(id)).xsheet.mode, 'ghibli', '어림은 작품을 바꾸지 않는다');
  await assert.rejects(() => engine.edits.setMotion(id, {}), /바꿀 내용이 없어요/);
  await assert.rejects(() => engine.edits.setMotion(id, { motionMode: 'turbo' }), /알 수 없는 움직임 방식이에요/);
  await assert.rejects(() => engine.edits.setMotion(id, { drawingBudget: 99999 }), /그림 장수는 0\(자동\) 또는 3000 이하/);
  // 한 장 받아 두고 줄이기: 같은 주문이면 그림이 남는다
  const first = s0.queue[0].key;
  await engine.handoff.acceptFiles(id, [file('keep')], { slotKey: first });
  const r = await engine.edits.setMotion(id, { motionMode: 'limited' });
  assert.strictEqual(r.replanned, true);
  assert.strictEqual(r.motionMode, 'limited');
  const s1 = await engine.projects.get(id);
  assert.strictEqual(s1.waiting.key, 'review:drawings', '카드는 그대로 열려 있고 새 예상으로 바뀐다');
  assert.strictEqual(s1.waiting.estimate.pictures, s1.xsheet.estimate.images);
  assert.ok(s1.xsheet.estimate.images < s0.xsheet.estimate.images);
  assert.strictEqual(s1.workflow.motionMode, 'limited');
  assert.strictEqual(s1.drawingsApproved, false);
  assert.strictEqual(s1.status, 'waiting');
  // 다 모은 뒤에는 바꿀 수 없다
  await engine.continueReview(id);
  await engine.whenIdle(id);
  await engine.drawings.finishEarly(id);
  await engine.whenIdle(id);
  await assert.rejects(() => engine.edits.setMotion(id, { motionMode: 'full' }), /이미 그림을 다 모은 뒤에는 바꿀 수 없어요/);
});

test('노래 고치기: BPM 다시 분석(가사 맞추기부터 다시) · 마디 시작 ±1박(저장된 박으로, 되돌리면 정확히 원래) · 노래 바꾸기', async () => {
  const { engine, services } = newEngine();
  const id = await engine.projects.create({ workflow: 'demo', aspect: '16:9' });
  await engine.demo.fill(id);
  const a0 = structuredClone((await engine.projects.get(id)).music.analysis);
  const calls = services.calls.analyze;
  const a1 = await engine.edits.setBarNudge(id, 1);
  assert.strictEqual(services.calls.analyze, calls, '박자 분석을 다시 하지 않는다');
  const beats = a0.beats;
  const phase0 = beats.findIndex((b) => b === a0.downbeats[0]) % 4;
  assert.deepStrictEqual(a1.downbeats, beats.filter((_, i) => i % 4 === (phase0 + 1) % 4));
  assert.strictEqual(a1.bars.length > 5 && a1.bars.every((b) => b.energy >= 0 && b.energy <= 1 && ['low', 'mid', 'high'].includes(b.level)), true);
  let s = await engine.projects.get(id);
  assert.strictEqual(s.music.barNudge, 1);
  assert.strictEqual(s.steps.timing.status, 'pending');
  assert.strictEqual(s.xsheet.shots.length > 0, true);
  assert.strictEqual(s.status, 'stopped');
  const a2 = await engine.edits.setBarNudge(id, -1);
  assert.deepStrictEqual(a2.downbeats, a0.downbeats);
  assert.deepStrictEqual(a2.bars, a0.bars, '되돌리면 정확히 원래');
  await assert.rejects(() => engine.edits.setBarNudge(id, 0), /바꿀 내용이 없어요/);
  // BPM 직접 지정 → 다시 분석
  await assert.rejects(() => engine.edits.setBpm(id, 5), /BPM 은 30에서 300 사이/);
  const a3 = await engine.edits.setBpm(id, 100);
  assert.strictEqual(services.calls.analyze, calls + 1);
  assert.strictEqual(services.calls.priors.at(-1), 100, '지정한 BPM 을 힌트로 넘겨 다시 분석한다');
  assert.ok(a3.bpm > 0);
  s = await engine.projects.get(id);
  assert.strictEqual(s.music.bpmOverride, 100);
  // 다시 열어도 다시 분석하지 않는다 (지정한 BPM 그대로)
  const b = newEngine();
  const s2 = await b.engine.demo.fill(id);
  assert.strictEqual(b.services.calls.analyze, 0);
  assert.strictEqual(s2.status, 'done');
  // 노래 바꾸기: 번호가 올라가고 분석부터 다시
  const r = await b.engine.edits.replaceSong(id, songBlob(45, 110), '새 노래.wav');
  assert.strictEqual(r.rev, 1);
  const s3 = await b.engine.projects.get(id);
  assert.strictEqual(s3.music, null);
  assert.strictEqual(s3.steps.music.status, 'pending');
  assert.strictEqual(s3.song.name, '새 노래.wav');
  await b.engine.demo.fill(id);
  assert.strictEqual(b.services.calls.analyze, 1);
  assert.strictEqual((await b.engine.projects.get(id)).durationSec, 45);
});

test('오래 걸리는 일 지킴이: 영상·자막은 foreground 로 · 받은 그림 정리는 4장부터 foreground · 실패/그만둬도 끝 알림은 늘 온다 · 같은 작품의 정리 일은 한 줄로', async () => {
  const log = [];
  jobs.setJobHooks({ start: (j) => log.push(['start', j.id.split(':')[1] || 'main', j.foreground, j.modal]), end: (j, st) => log.push(['end', j.id.split(':')[1] || 'main', st]) });
  const sv = fakeServices();
  const { engine } = newEngine({ services: sv });
  const id = await engine.projects.create({ workflow: 'demo', aspect: '9:16' });
  await engine.demo.fill(id);
  const heavy = log.filter((e) => e[0] === 'start' && e[2]);
  assert.ok(heavy.length >= 3, '영상 · 자막 · 연습 그림 정리 모두 foreground');
  assert.deepStrictEqual(heavy.filter((e) => e[1] === 'main').map((e) => e[3]), [true, true], '영상 · 자막은 덮개(modal)가 있다');
  assert.strictEqual(log.filter((e) => e[0] === 'start').length, log.filter((e) => e[0] === 'end').length, '시작마다 끝이 있다');
  // 실패해도 끝 알림
  log.length = 0;
  const bad = fakeServices();
  bad.render.exportClean = async () => { throw new Error('인코더가 없어요'); };
  const e2 = newEngine({ services: bad });
  const id2 = await e2.engine.projects.create({ workflow: 'demo', aspect: '9:16' });
  await assert.rejects(() => e2.engine.demo.fill(id2), /인코더가 없어요/);
  assert.strictEqual((await e2.engine.projects.get(id2)).status, 'error');
  assert.strictEqual((await e2.engine.projects.get(id2)).next.kind, 'error');
  assert.strictEqual(log.filter((e) => e[0] === 'start').length, log.filter((e) => e[0] === 'end').length);
  assert.ok(log.some((e) => e[0] === 'end' && e[2] === 'failed'));
  // 두 묶음이 동시에 와도 둘 다 처리된다 (같은 id 의 일은 하나로 합쳐지므로 우리가 줄을 세운다)
  const e3 = newEngine();
  const id3 = await aiProject(e3.engine);
  const s3 = await driveToDrawings(e3.engine, id3);
  const keys = s3.queue.map((q) => q.key);
  const [x, y] = await Promise.all([
    e3.engine.handoff.acceptFiles(id3, [file('a1'), file('a2')], { slotKey: keys[0] }),
    e3.engine.handoff.acceptFiles(id3, [file('b1'), file('b2'), file('b3')], { slotKey: keys[6] }),
  ]);
  assert.strictEqual(x.placed.length + y.placed.length, 5);
  assert.strictEqual(new Set([...x.placed, ...y.placed].map((p) => p.key)).size, 5, '같은 칸에 겹쳐 놓지 않는다');
  assert.strictEqual(e3.services.calls.ingest.length, 5);
  void X;
});

test('고급: 영어 주문 글을 직접 고쳐 다시 그리기 — 요청서는 고친 글로, 받으면 주문 글이 바뀌고(custom · promptEdited) 예전 그림에 옛 주문 글이 남아 되돌리면 같이 돌아온다 · 이름 바꾸기', async () => {
  const { engine } = newEngine();
  const { id, q } = await finishEpisode(engine);
  const c = q.find((x) => x.kind === 'cel');
  const before = (await engine.projects.get(id)).drawings.find((d) => d.key === c.key).prompt;
  const mine = `${before}\nAlso: she holds a red umbrella.`;
  const req = await engine.drawings.regenerate(id, c.shot, c.id, { prompt: mine });
  assert.ok(req.prompt.includes('she holds a red umbrella'));
  assert.ok(!req.files.length || !/current drawing/.test(req.files[0].note), '한국어 요청이 없으면 지금 그림을 첫 첨부로 붙이지 않는다');
  await engine.handoff.acceptFiles(id, [file('umbrella')]);
  let d = (await engine.projects.get(id)).drawings.find((x) => x.key === c.key);
  assert.strictEqual(d.prompt, mine);
  assert.ok(d.promptEdited && d.custom);
  assert.strictEqual((await engine._runtime(id)).drawings.get(c.key).history[0].prompt, before, '예전 그림에는 그때의 주문 글');
  await engine.drawings.restoreVersion(id, c.shot, c.id, 0);
  d = (await engine.projects.get(id)).drawings.find((x) => x.key === c.key);
  assert.strictEqual(d.prompt, before, '되돌리면 주문 글도 같이');
  assert.strictEqual(await engine.projects.rename(id, '  새 이름   입니다 '), '새 이름 입니다');
  await assert.rejects(() => engine.projects.rename(id, '   '), /이름을 적어 주세요/);
  assert.strictEqual((await engine.projects.list())[0].title, '새 이름 입니다');
});

test('캐릭터 기준 그림은 받은 함에서도 놓을 수 있다 (id = char:…): 줄여서 돌려주고 받은 함에서 뺀다', async () => {
  const { engine } = newEngine();
  const entry = { id: 'tr1', receivedAt: Date.now(), text: '', items: [{ name: 's.png', mime: 'image/png', size: 5, key: 'inbox/tr1/0' }] };
  await db.putFile('inbox/tr1/0', imgBlob('sheet'));
  await db.putInbox(entry);
  const tray = await engine.handoff.tray();
  assert.strictEqual(tray.length, 1);
  const r = await engine.handoff.place('char:c9', tray[0].itemId);
  assert.strictEqual(r.placed.length, 1);
  assert.strictEqual(r.placed[0].kind, 'ref');
  assert.deepStrictEqual(await engine.handoff.tray(), []);
});
