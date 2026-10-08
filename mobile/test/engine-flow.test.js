// 엔진 흐름 시험 (Node, 진짜 db.js on fake-indexeddb, 가짜 services): 연습 모드로 끝까지 · 기다림 저장 · 다시 시작 복구 · 뒤로가기/멈춤
import test, { beforeEach } from 'node:test';
import assert from 'node:assert';
import { newEngine, fakeServices, resetDb, db, songBlob, imgBlob } from './engine-fixtures.js';
import * as jobs from '../src/jobs.js';
import { createRequire } from 'node:module';

const DD = createRequire(import.meta.url)('../../src/main/ai/demo-data.js');

beforeEach(async () => { await resetDb(); });

test('연습 모드: 한 번에 끝까지 → 일곱 단계 모두 완료, 영상·자막 파일이 저장소에 있다', async () => {
  const { engine, services } = newEngine();
  const id = await engine.projects.create({ workflow: 'demo', aspect: '16:9' });
  const snap = await engine.demo.fill(id);
  assert.strictEqual(snap.status, 'done');
  for (const s of snap.stepOrder) assert.strictEqual(snap.steps[s].status, 'done', s);
  assert.ok(snap.output.hasVideo && snap.output.burned);
  assert.ok(await db.getFile(snap.output.clean), '깨끗한 원본');
  assert.ok(await db.getFile(snap.output.video), '완성본');
  assert.ok((await db.getFile(snap.output.srt)).size > 0);
  assert.ok((await db.getFile(snap.output.lrc)).size > 0);
  assert.strictEqual(snap.renderStale, false);
  assert.deepStrictEqual(snap.dirtyShots, []);
  assert.ok(snap.work.total > 0 && snap.work.done === snap.work.total);
  assert.strictEqual(services.calls.exports.length, 1);
  // 합성기에 건넨 재료: 모든 컷에 배경이 있고, 인물 그림은 배경 뺀 셀(곱한 알파)
  const mats = services.calls.exports[0].shots;
  assert.strictEqual(mats.length, snap.xsheet.shots.length);
  assert.ok(mats.every((m) => m.bg && m.bg.token.startsWith('ORIG:IMG:bg')));
  assert.ok([...mats[0].layers.values()].every((l) => l && l.premultiply && l.token.startsWith('CEL:')));
  // 화면에 보내는 상태: 지금 할 일 = 완성
  assert.strictEqual(snap.next.kind, 'done');
  assert.strictEqual(snap.canApply, false);
});

test('연습 모드: 프레임 수 = 순서표 합계, 영상 크기는 선택한 화면 비율 (9:16 720p = 720×1280)', async () => {
  const { engine, services } = newEngine();
  const id = await engine.projects.create({ workflow: 'demo', aspect: '9:16' });
  const snap = await engine.demo.fill(id);
  const c = services.calls.exports[0].compositor;
  assert.strictEqual(c.totalFrames, snap.xsheet.totalFrames);
  assert.deepStrictEqual([c.W, c.H], [720, 1280]);
  assert.deepStrictEqual(snap.outSize, { w: 720, h: 1280 });
});

test('AI 앱 모드: 답장이 올 때까지 "기다리는 중"으로 저장되고, 앱을 다시 켜도(새 엔진) 그대로 이어진다', async () => {
  const a = newEngine();
  const id = await a.engine.projects.create({ workflow: 'phone-lite', aspect: '9:16', songBlob: songBlob(60), songName: 's.wav', lyricsText: '[Verse]\n가나다\n라마바\n[Chorus]\n사아자\n차카타', providers: { text: 'chatgpt', image: 'chatgpt' } });
  const s1 = await a.engine.run(id);
  assert.strictEqual(s1.status, 'waiting');
  assert.strictEqual(s1.waiting.key, 'handoff:plan');
  assert.strictEqual(s1.steps.music.status, 'done');
  assert.strictEqual(s1.steps.plan.status, 'waiting');
  assert.strictEqual(s1.next.kind, 'handoff');
  const req = await a.engine.handoff.request(id);
  assert.strictEqual(req.kind, 'plan');
  // 앱이 꺼졌다 켜진 것처럼 새 엔진
  const b = newEngine();
  const s2 = await b.engine.projects.get(id);
  assert.strictEqual(s2.status, 'waiting');
  assert.strictEqual(s2.waiting.key, 'handoff:plan');
  assert.strictEqual(b.services.calls.analyze, 0, '다시 열어도 노래를 다시 분석하지 않는다');
  const req2 = await b.engine.handoff.request(id);
  assert.strictEqual(req2.nonce, req.nonce, '같은 부탁은 같은 번호');
  const reply = JSON.stringify({ ...DD.demoPlan('t', s2.workflow, null), request_id: req2.nonce });
  const r = await b.engine.handoff.acceptText(id, reply);
  assert.ok(r.ok, r.message);
  await b.engine.whenIdle(id);
  const s3 = await b.engine.projects.get(id);
  // 가사에 시간이 없으니 컷을 나누기 전에 가사 맞추기 확인
  assert.strictEqual(s3.status, 'waiting');
  assert.strictEqual(s3.waiting.key, 'review:lyrics');
  assert.strictEqual(s3.steps.plan.status, 'done');
  assert.ok(await b.engine.continueReview(id));
  await b.engine.whenIdle(id);
  const s4 = await b.engine.projects.get(id);
  assert.strictEqual(s4.waiting.key, 'handoff:xsheet');
  assert.strictEqual(s4.steps.timing.status, 'done');
  assert.ok(s4.timing.segments.length >= 3);
});

test('앱이 영상 만드는 도중 꺼진 경우: 실행 중이던 단계는 "중지됨", 받다 만 그림은 이전 상태로', async () => {
  const { engine } = newEngine();
  const id = await engine.projects.create({ workflow: 'demo', aspect: '9:16' });
  await engine.demo.fill(id);
  // 저장소를 직접 망가뜨려 강제 종료를 흉내 낸다
  const p = await db.getProject(id);
  p.status = 'running';
  p.steps.render.status = 'running';
  await db.putProject(p);
  const ds = await db.listDrawings(id);
  const cel = ds.find((d) => d.kind === 'cel');
  cel.status = 'running';
  const fresh = ds.find((d) => d.kind === 'bg');
  fresh.status = 'running';
  fresh.file = null;
  await db.putDrawings([cel, fresh]);
  const b = newEngine();
  const s = await b.engine.projects.get(id);
  assert.strictEqual(s.status, 'stopped');
  assert.strictEqual(s.steps.render.status, 'stopped');
  const rows = Object.fromEntries(s.drawings.map((d) => [d.key, d]));
  assert.strictEqual(rows[cel.key].status, 'done');
  assert.strictEqual(rows[cel.key].keyed, null, '배경 빼기는 다음 영상 만들기 때 다시');
  assert.strictEqual(rows[fresh.key].status, 'pending');
  assert.strictEqual((await b.engine.projects.list())[0].status, 'stopped');
});

test('뒤로가기 사고(D1): 영상 만드는 중 화면을 떠나도 끝난 영상은 저장되고 목록에 나온다', async () => {
  const sv = fakeServices({ exportDelay: 15 });
  const { engine } = newEngine({ services: sv });
  const id = await engine.projects.create({ workflow: 'demo', aspect: '9:16' });
  const running = engine.demo.fill(id);
  // 영상 만들기가 시작되길 기다렸다가 "뒤로가기 → 계속 하기"
  for (let i = 0; i < 400 && !(jobs.isJobRunning(id) && engine._runtimeSync); i++) {
    const snap = engine.projects.peek(id);
    if (snap && snap.currentStep === 'render' && snap.status === 'running') break;
    await new Promise((r) => setTimeout(r, 5));
  }
  const g = await jobs.guardBack({ ask: async () => false }); // 계속 하기
  assert.ok(['continue', 'none'].includes(g));
  const snap = await running;
  assert.strictEqual(snap.status, 'done');
  const rows = await engine.projects.list();
  assert.strictEqual(rows[0].hasVideo, true);
  assert.ok((await db.getFile(snap.output.video)).size > 0);
});

test('멈추기: 영상 만드는 중 stop → 중지됨, 파일은 안 남고, 합성기는 닫힌다', async () => {
  const sv = fakeServices({ exportDelay: 30 });
  const { engine } = newEngine({ services: sv });
  const id = await engine.projects.create({ workflow: 'demo', aspect: '9:16' });
  const running = engine.demo.fill(id).catch((e) => e);
  for (let i = 0; i < 600; i++) {
    const s = engine.projects.peek(id);
    if (s && s.currentStep === 'render' && s.status === 'running') break;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.strictEqual(await engine.stop(id), true);
  const r = await running;
  assert.ok(r instanceof Error, '연습 모드 채우기는 멈춘 상태를 오류로 알린다');
  const s = await engine.projects.get(id);
  assert.strictEqual(s.status, 'stopped');
  assert.strictEqual(s.steps.render.status, 'stopped');
  assert.strictEqual(s.output.clean, null);
  assert.strictEqual((await db.listFileKeys(`${id}/out/`)).length, 0);
  // 다시 이어서 만들면 끝까지 간다
  const done = await engine.demo.fill(id);
  assert.strictEqual(done.status, 'done');
});

test('작품 지우기: 기록·그림·파일이 모두 사라지고 기다리던 칸도 지운다', async () => {
  const { engine } = newEngine();
  const id = await engine.projects.create({ workflow: 'phone-lite', songBlob: songBlob(60), songName: 's.wav', providers: { text: 'chatgpt', image: 'chatgpt' } });
  await engine.run(id);
  await engine.handoff.request(id).catch(() => null);
  await db.setExpecting({ projectId: id, kind: 'plan', key: null });
  await engine.projects.delete(id);
  assert.strictEqual(await db.getProject(id), null);
  assert.deepStrictEqual(await db.listFileKeys(`${id}/`), []);
  assert.strictEqual(await db.getExpecting(), null);
  assert.strictEqual((await engine.projects.list()).length, 0);
});
