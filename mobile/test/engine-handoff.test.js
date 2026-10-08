// AI 앱에 부탁하기·받기 시험 (Node): 답장 검사 표(D3) · 요청서 모양 · 기다리는 칸 저장(D2) · 콜드 스타트 공유 · 그림 놓기 · 우선순위·건너뛰기·이웃 그림 · 다시 그리기
import test, { beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  newEngine, fakeNative, fakeServices, resetDb, db, songBlob, imgBlob, aiProject, driveToDrawings, DD,
} from './engine-fixtures.js';
import { checkReply, isEcho, findPlaceholder, nonceBlock } from '../src/engine/handoff.js';

beforeEach(async () => { await resetDb(); });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('기다리던 일이 일어나지 않았어요');
    await wait(10);
  }
}
const planReply = (wf, nonce, extra = {}) => ({ ...DD.demoPlan('t', wf, null), ...(nonce ? { request_id: nonce } : {}), ...extra });
const file = (label, name = `${label}.png`, mime = 'image/png') => ({ name, mime, blob: imgBlob(label, mime) });

test('답장 검사 표(순수): 부탁 글 그대로 · 예시 칸 · 번호 없음/다름(force) · 종류 다름 · 모양 틀림 · 받는 것', () => {
  const prompt = `# Task: storyboard\n${'긴 설명 '.repeat(120)}\nReturn ONLY this JSON shape:\n{"title": "..."}${nonceBlock('abc123')}`;
  const ok = JSON.stringify({ title: '제목', story: [{ act: 1, summary_ko: '가', visual_en: 'x' }], request_id: 'abc123' });
  const run = (text, o = {}) => checkReply({ text, prompt, nonce: 'abc123', kind: 'plan', ...o });
  assert.strictEqual(run(prompt).reason, 'echo');
  assert.strictEqual(run(`AI 에게 보낸 글\n${prompt}\n끝`).reason, 'echo');
  assert.strictEqual(run('# Task: x').reason, 'echo');
  assert.strictEqual(run('{"title": "...", "story": [{"act": 1}]}').reason, 'placeholder');
  assert.strictEqual(run(JSON.stringify({ title: '...', story: [{ act: 1 }], request_id: 'abc123' })).reason, 'placeholder');
  assert.strictEqual(run('').reason, 'invalid');
  assert.strictEqual(run('안녕하세요').reason, 'invalid');
  assert.strictEqual(run('{"a":1}').reason, 'invalid');
  assert.strictEqual(run(ok.replace('abc123', 'zzz')).reason, 'noNonce');
  assert.strictEqual(run(ok.replace(',"request_id":"abc123"', '')).reason, 'noNonce');
  assert.strictEqual(run(ok.replace(',"request_id":"abc123"', ''), { force: true }).ok, true, 'force 는 번호 없는 올바른 답장을 받는다');
  assert.strictEqual(run(ok.replace('abc123', 'zzz'), { force: true }).ok, true);
  const xs = JSON.stringify({ shots: [{ shot: 1, drawings: [{ id: 'A', prompt_en: 'x' }], exposure: [{ drawing: 'A', frames: 24 }] }], request_id: 'abc123' });
  assert.strictEqual(run(xs).reason, 'wrongKind');
  assert.strictEqual(checkReply({ text: ok, prompt, nonce: 'abc123', kind: 'xsheet' }).reason, 'wrongKind');
  // 받는 것: 코드 블록 · 앞뒤 설명 · 스마트 따옴표 · 끝 쉼표
  const fenced = `네, 여기 있어요!\n\`\`\`json\n${ok}\n\`\`\`\n도움이 되었으면 좋겠어요.`;
  assert.strictEqual(run(fenced).ok, true);
  assert.strictEqual(run('{"title": "제목", "story": [{"act": 1,}], "request_id": "ABC123",}').ok, true, '끝 쉼표 · 번호 대소문자는 너그럽게');
  assert.strictEqual(isEcho('그냥 짧은 답', prompt), false);
  assert.strictEqual(findPlaceholder({ a: [{ b: ' ... ' }] }), 'a[0].b');
  assert.strictEqual(findPlaceholder({ a: '말줄임표 ...를 쓴 글' }), null, '문장 속 말줄임표는 예시 칸이 아니다');
});

test('엔진: 클립보드에 남은 부탁 글을 붙여넣으면 거절된다 (D3) — 상태는 그대로, 번호 없는 올바른 답장은 force 로만', async () => {
  const { engine } = newEngine();
  const id = await aiProject(engine);
  await engine.run(id);
  const req = await engine.handoff.request(id);
  assert.strictEqual(req.kind, 'plan');
  assert.match(req.prompt, new RegExp(`"request_id": "${req.nonce}"`));
  assert.strictEqual(req.expectsText, true);
  assert.deepStrictEqual(req.files, []);
  const wf = (await engine.projects.get(id)).workflow;
  const rej = async (text, reason, opt) => {
    const r = await engine.handoff.acceptText(id, text, opt);
    assert.strictEqual(r.ok, false, text.slice(0, 40));
    assert.strictEqual(r.reason, reason, `${reason}: ${r.message}`);
    assert.ok(/[가-힣]/.test(r.message), '사용자에게 보이는 안내는 한국어');
  };
  await rej(req.prompt, 'echo');
  await rej(`보낸 글:\n${req.prompt}`, 'echo');
  await rej(req.prompt.slice(0, 1400), 'echo');
  await rej('{"title":"...","story":[{"act":1,"summary_ko":"..."}]}', 'placeholder');
  await rej('고마워요', 'invalid');
  await rej(JSON.stringify({ shots: [{ shot: 1, drawings: [{ id: 'A', prompt_en: 'p' }], exposure: [] }] }), 'wrongKind');
  await rej(JSON.stringify(planReply(wf, null)), 'noNonce');
  await rej(JSON.stringify(planReply(wf, '0000000000000000')), 'noNonce');
  let s = await engine.projects.get(id);
  assert.strictEqual(s.plan, null);
  assert.strictEqual(s.status, 'waiting');
  const forced = await engine.handoff.acceptText(id, JSON.stringify(planReply(wf, null)), { force: true });
  assert.ok(forced.ok, forced.message);
  assert.strictEqual(forced.applied, 'plan');
  await engine.whenIdle(id);
  s = await engine.projects.get(id);
  assert.ok(s.plan && s.plan.title);
  assert.strictEqual(s.waiting.key, 'review:lyrics');
  assert.strictEqual(await db.getExpecting(), null, '받은 뒤에는 기다리는 칸을 지운다');
  // 받을 게 없을 때
  const none = await engine.handoff.acceptText(id, JSON.stringify(planReply(wf, req.nonce)));
  assert.strictEqual(none.reason, 'noRequest');
});

test('요청서 모양: 이야기·순서표(번호 · 폰 안내) · 배경(첨부 없음) · 첫 인물 그림(배경색 지시) · 다음 그림(앞 그림 첫 번째 + 고치기)', async () => {
  const { engine, services } = newEngine();
  const id = await aiProject(engine);
  let s = await driveToDrawings(engine, id, { approve: false });
  assert.strictEqual(s.waiting.key, 'review:drawings');
  assert.ok(s.estimate.requests >= s.estimate.images);
  assert.strictEqual(await engine.handoff.request(id), null, '확인 카드에서는 AI 앱에 부탁할 게 없다');
  await engine.continueReview(id);
  await engine.whenIdle(id);
  s = await engine.projects.get(id);
  assert.match(s.waiting.key, /^image:/);
  const bg = await engine.handoff.request(id);
  assert.strictEqual(bg.kind, 'bg');
  assert.strictEqual(bg.key, s.nextKey);
  assert.deepStrictEqual(bg.files, []);
  assert.match(bg.prompt, /Background painting \(BG plate\)/);
  assert.match(bg.prompt, /aspect ratio 9:16/);
  assert.ok(bg.expectsImages === 1 && !bg.expectsText);
  assert.ok(bg.targetApps.length >= 2 && bg.targetApps.every((a) => a.id !== 'claude'), '그림은 그림을 만드는 앱만');
  assert.match(bg.title, /배경/);
  const r0 = await engine.handoff.acceptFiles(id, [file('bg1')]);
  assert.strictEqual(r0.placed.length, 1);
  assert.strictEqual(r0.placed[0].kind, 'bg');
  await engine.whenIdle(id);
  const cel = await engine.handoff.request(id);
  assert.strictEqual(cel.kind, 'cel');
  assert.deepStrictEqual(cel.files, [], '장면의 첫 인물 그림은 앞 그림이 없다');
  assert.match(cel.prompt, /plain flat solid green #00FF00 background/);
  // 같은 장면에 그림이 둘 이상이면: 다음 그림은 앞 그림(배경색 위 plate)을 첫 번째 첨부로 + EDIT MODE
  let edit = null;
  let cur = cel;
  for (let i = 0; i < 30 && !edit; i++) {
    await engine.handoff.acceptFiles(id, [file(`c${i}`)]);
    await engine.whenIdle(id);
    cur = await engine.handoff.request(id);
    if (!cur) break;
    if (cur.kind === 'cel' && cur.files.length) edit = cur;
  }
  assert.ok(edit, '같은 장면의 다음 그림 요청을 찾아야 해요');
  assert.match(edit.files[0].note, /EDIT this image/);
  assert.match(edit.files[0].name, /^01_previous\./);
  assert.match(edit.prompt, /EDIT MODE: Edit the first attached image/);
  assert.match(edit.prompt, /Reference images attached to this message \(in this order\):\n1\. /);
  assert.ok(services.calls.plate >= 1, '셀은 투명해서 배경색 위에 얹은 plate 로 붙인다');
  assert.ok(edit.files[0].blob.size > 0 && edit.nonce);
});

test('순서표 요청서: 번호 안내 · 폰 안내문 · 컷 목록 — AI 없이 폰이 짜기(fallback)도 된다', async () => {
  const { engine } = newEngine();
  const id = await aiProject(engine);
  await engine.run(id);
  const rq = await engine.handoff.request(id);
  const wf = (await engine.projects.get(id)).workflow;
  await engine.handoff.acceptText(id, JSON.stringify(planReply(wf, rq.nonce)));
  await engine.whenIdle(id);
  await engine.continueReview(id);
  await engine.whenIdle(id);
  const x = await engine.handoff.request(id);
  assert.strictEqual(x.kind, 'xsheet');
  assert.match(x.prompt, /animation timesheet/);
  assert.match(x.prompt, /PHONE MODE/);
  assert.match(x.prompt, new RegExp(`"request_id": "${x.nonce}"`));
  assert.match(x.prompt, /exactly \d+ shots/);
  assert.ok(x.targetApps.some((a) => a.id === 'claude'), '글 부탁은 글만 되는 앱도 괜찮다');
  const snap = await engine.projects.get(id);
  assert.strictEqual(snap.waiting.canFallback, true);
  assert.strictEqual(await engine.skipWaiting(id, 'xsheet'), true);
  await engine.whenIdle(id);
  const after = await engine.projects.get(id);
  assert.strictEqual(after.xsheet.source, 'fallback');
  assert.strictEqual(after.waiting.key, 'review:drawings');
  assert.ok(after.xsheet.estimate.images >= 8, 'PC 방식 순서표가 그림 목록까지 만들었다');
  assert.strictEqual(after.drawings.length, after.xsheet.estimate.images);
  assert.strictEqual(await db.getExpecting(), null);
});

test('기다리는 칸 저장(D2): 부탁하면 expecting 이 저장소에 적히고, 앱을 다시 켜도 같은 번호이며, 받으면 지워진다', async () => {
  const a = newEngine();
  const id = await aiProject(a.engine);
  await driveToDrawings(a.engine, id);
  const req = await a.engine.handoff.request(id);
  const exp = await db.getExpecting();
  assert.deepStrictEqual({ projectId: exp.projectId, kind: exp.kind, key: exp.key, nonce: exp.nonce }, { projectId: id, kind: req.kind, key: req.key, nonce: req.nonce });
  assert.ok(exp.requestedAt > 0);
  assert.strictEqual((await a.engine.handoff.request(id)).nonce, req.nonce, '여러 번 불러도 같은 번호');
  const b = newEngine();
  const req2 = await b.engine.handoff.request(id);
  assert.strictEqual(req2.nonce, req.nonce);
  assert.strictEqual(req2.key, req.key);
  const sent = await b.engine.handoff.send(id, 'gemini');
  assert.ok(sent.copied && b.native.sent.length === 1 && b.native.sent[0].appId === 'gemini');
  assert.strictEqual(b.native.sent[0].text, req.prompt);
  await assert.rejects(() => b.engine.handoff.send(id, 'nope'), /알 수 없는 AI 앱/);
  await b.engine.handoff.acceptFiles(id, [file('p1')]);
  assert.strictEqual((await db.getExpecting()), null, '받은 칸의 기다림은 지운다');
});

test('콜드 스타트 공유(D2): 앱이 꺼진 사이에 온 그림은 기다리던 칸으로 · 자리를 못 찾으면 받은 함에 남는다 · 네이티브 복사본은 저장한 뒤에만 지운다', async () => {
  const a = newEngine();
  const id = await aiProject(a.engine);
  await driveToDrawings(a.engine, id);
  const req = await a.engine.handoff.request(id);
  // 프로세스가 죽었다 → 공유로 앱이 켜짐: 새 엔진 + 네이티브 받은 함에 그림 한 장
  const native = fakeNative();
  native.inbox.push({ id: 'e1', receivedAt: Date.now(), text: '', items: [{ path: '/cache/shared/1_a.png', name: 'a.png', mime: 'image/png', size: 9, blob: imgBlob('shared-bg') }] });
  const b = newEngine({ native });
  await b.engine.start();
  await until(async () => native.acked.includes('e1') && (await b.engine.projects.get(id)).drawings.find((d) => d.key === req.key).status === 'done');
  const s = await b.engine.projects.get(id);
  assert.strictEqual(s.drawings.find((d) => d.key === req.key).hasPicture, true);
  assert.deepStrictEqual(await db.listInbox(), [], '쓴 건 받은 함에서 빠진다');
  assert.deepStrictEqual(await b.engine.handoff.tray(), []);
  b.engine.dispose();
  // 기다리는 칸이 없으면(또는 오래됐으면) 받은 함에 그대로 — 조용히 버리지 않는다
  await db.clearExpecting();
  const native2 = fakeNative();
  native2.inbox.push({ id: 'e2', receivedAt: Date.now(), text: '', items: [{ path: '/c/2.png', name: 'b.png', mime: 'image/png', size: 9, blob: imgBlob('late') }, { path: '/c/3.png', name: 'c.png', mime: 'image/png', size: 9, blob: imgBlob('late2') }] });
  const c = newEngine({ native: native2 });
  await c.engine.start();
  await until(() => native2.acked.includes('e2'));
  const tray = await c.engine.handoff.tray(id);
  assert.strictEqual(tray.length, 2);
  assert.ok(tray.every((t) => t.kind === 'image' && t.suggest && t.suggest.projectId === id && t.suggest.key), '한 번 눌러 넣을 칸을 제안한다');
  assert.notStrictEqual(tray[0].suggest.key, tray[1].suggest.key);
  // 한 번 눌러 놓기 · 버리기
  const placed = await c.engine.handoff.place(id, tray[0].itemId, tray[0].suggest.key);
  assert.strictEqual(placed.placed.length, 1);
  await c.engine.handoff.discard(id, tray[1].itemId);
  assert.deepStrictEqual(await c.engine.handoff.tray(id), []);
  assert.deepStrictEqual(await db.listInbox(), []);
  assert.deepStrictEqual(await db.listFileKeys('inbox/'), [], '받은 함 파일도 함께 지운다');
  // 12시간 넘은 기다림은 없는 것으로 본다
  await db.setMeta('expecting', { projectId: id, kind: 'cel', key: '1:A', requestedAt: Date.now() - 13 * 3600 * 1000, nonce: 'old' });
  const native3 = fakeNative();
  native3.inbox.push({ id: 'e3', receivedAt: Date.now(), text: '', items: [{ path: '/c/4.png', name: 'd.png', mime: 'image/png', size: 9, blob: imgBlob('old') }] });
  const d = newEngine({ native: native3 });
  await d.engine.start();
  await until(() => native3.acked.includes('e3'));
  assert.strictEqual((await d.engine.handoff.tray(id)).length, 1);
});

test('콜드 스타트 공유: 글 답장도 기다리던 부탁으로 — 번호가 맞으면 받고, 안 맞으면 받은 함에 남는다', async () => {
  const a = newEngine();
  const id = await aiProject(a.engine);
  await a.engine.run(id);
  const req = await a.engine.handoff.request(id);
  const wf = (await a.engine.projects.get(id)).workflow;
  const native = fakeNative();
  native.inbox.push({ id: 't1', receivedAt: Date.now(), text: JSON.stringify(planReply(wf, '1111111111111111')), items: [] });
  const b = newEngine({ native });
  await b.engine.start();
  await until(() => native.acked.includes('t1'));
  await wait(50);
  assert.strictEqual((await b.engine.handoff.tray(id)).filter((t) => t.kind === 'text').length, 1, '번호가 다른 답장은 받은 함에 남는다');
  assert.strictEqual((await b.engine.projects.get(id)).plan, null);
  const tray = await b.engine.handoff.tray(id);
  const forced = await b.engine.handoff.place(id, tray[0].itemId, null, { force: true });
  assert.ok(forced.text.ok, forced.text.message);
  await b.engine.whenIdle(id);
  assert.ok((await b.engine.projects.get(id)).plan);
  assert.deepStrictEqual(await b.engine.handoff.tray(id), []);
  // 번호가 맞는 답장은 바로 받는다
  const c = newEngine();
  const id2 = await aiProject(c.engine);
  await c.engine.run(id2);
  const rq2 = await c.engine.handoff.request(id2);
  const native2 = fakeNative();
  native2.inbox.push({ id: 't2', receivedAt: Date.now(), text: JSON.stringify(planReply(wf, rq2.nonce)), items: [] });
  const d = newEngine({ native: native2 });
  await d.engine.start();
  await until(async () => (await d.engine.projects.get(id2)).plan);
  assert.ok(req.nonce !== rq2.nonce);
});

test('그림 놓기: 칸 이름 > 기다리던 칸 > 우선순위 다음 빈 칸 · 여러 장은 이어지는 칸에 차례로 · 넘치면 받은 함 · 못 읽는 파일은 알려 주고 남긴다', async () => {
  const { engine } = newEngine();
  const id = await aiProject(engine);
  const s0 = await driveToDrawings(engine, id);
  const q = s0.queue.map((x) => x.key);
  assert.ok(q.length >= 10);
  // 칸 이름이 있으면 그 칸 (우선순위와 상관없이)
  const r1 = await engine.handoff.acceptFiles(id, [file('x')], { slotKey: q[3] });
  assert.deepStrictEqual(r1.placed.map((x) => x.key), [q[3]]);
  await engine.whenIdle(id);
  // 기다리던 칸 (request 로 정해진 칸)
  const req = await engine.handoff.request(id);
  assert.strictEqual(req.key, q[0]);
  const r2 = await engine.handoff.acceptFiles(id, [file('y')]);
  assert.deepStrictEqual(r2.placed.map((x) => x.key), [q[0]]);
  await engine.whenIdle(id);
  // 여러 장 = 이어지는 빈 칸에 차례로 (q[3] 은 이미 찼으니 건너뛴다)
  await engine.handoff.request(id);
  const r3 = await engine.handoff.acceptFiles(id, [file('a'), file('b'), file('c')]);
  assert.deepStrictEqual(r3.placed.map((x) => x.key), [q[1], q[2], q[4]]);
  assert.deepStrictEqual(r3.placed.map((x) => x.name), ['a.png', 'b.png', 'c.png']);
  await engine.whenIdle(id);
  // 아무 부탁도 없을 때: 우선순위 다음 빈 칸
  await db.clearExpecting();
  const rt = await engine._runtime(id);
  rt.p.handoff = null;
  rt.p.waiting = null;
  rt.p.status = 'stopped';
  const r4 = await engine.handoff.acceptFiles(id, [file('d')]);
  assert.deepStrictEqual(r4.placed.map((x) => x.key), [q[5]]);
  // 못 읽는 파일 · 그림이 아닌 파일 · 넘치는 파일
  const bad = await engine.handoff.acceptFiles(id, [{ name: 'broken.png', mime: 'image/png', blob: imgBlob('BAD') }, { name: 'memo.txt', mime: 'text/plain', blob: new Blob(['메모']) }]);
  assert.strictEqual(bad.placed.length, 0);
  assert.strictEqual(bad.failed.length, 1);
  assert.match(bad.failed[0].message, /읽지 못했어요/);
  assert.strictEqual(bad.pending.length, 2, '못 읽은 파일도 문서도 받은 함에 남는다');
  const left = (await engine.projects.get(id)).drawings.filter((d) => d.status === 'pending').length;
  const many = await engine.handoff.acceptFiles(id, Array.from({ length: left + 2 }, (_, i) => file(`m${i}`)));
  assert.strictEqual(many.placed.length, left);
  assert.strictEqual(many.pending.length, 2);
  assert.strictEqual((await engine.handoff.tray(id)).length, 4);
  assert.match(many.message, /받은 함/);
  // 이미 찬 칸에 칸 이름을 주면 바꿔 넣는다 (옛 그림은 예전 그림으로)
  const again = await engine.handoff.acceptFiles(id, [file('new')], { slotKey: q[0] });
  assert.strictEqual(again.placed[0].replaced, true);
  const d0 = (await engine.projects.get(id)).drawings.find((d) => d.key === q[0]);
  assert.strictEqual(d0.history.length, 1);
  assert.strictEqual(d0.history[0].kind, 'ai');
});

test('그림 정리 결과: 배경 뺀 셀 · 못 빼면 전체 그림(같은 한국어 안내) · 첫 셀 색에 맞추기(처음 셀은 기준) · 원본은 따로', async () => {
  const { engine, services } = newEngine();
  const id = await aiProject(engine);
  const s0 = await driveToDrawings(engine, id);
  const bgKey = s0.queue.find((x) => x.kind === 'bg').key;
  const cels = s0.queue.filter((x) => x.kind === 'cel');
  const shotNo = cels[0].shot;
  const sameShot = cels.filter((x) => x.shot === shotNo);
  await engine.handoff.acceptFiles(id, [file('bg')], { slotKey: bgKey });
  await engine.handoff.acceptFiles(id, [file('first')], { slotKey: sameShot[0].key });
  const rt = await engine._runtime(id);
  const first = rt.drawings.get(sameShot[0].key);
  assert.strictEqual(first.keyed, true);
  assert.strictEqual(services.calls.ingest.at(-1).refStats, null, '장면의 첫 셀은 색 맞추기 기준이다');
  assert.ok(await db.getFile(first.cel) && await db.getFile(first.file));
  if (sameShot[1]) {
    await engine.handoff.acceptFiles(id, [file('second')], { slotKey: sameShot[1].key });
    assert.deepStrictEqual(services.calls.ingest.at(-1).refStats, first.stats, '두 번째 셀은 첫 셀 색에 맞춘다');
  }
  const other = cels.find((x) => x.shot !== shotNo);
  const logs = [];
  engine.on('log', (e) => logs.push(e.line));
  await engine.handoff.acceptFiles(id, [file('NOKEY')], { slotKey: other.key });
  const nk = rt.drawings.get(other.key);
  assert.strictEqual(nk.keyed, false);
  assert.strictEqual(nk.cel, null);
  assert.ok(logs.some((l) => l.includes(`컷${nk.shot}-${nk.id}: 배경이 단색이 아니라 뺄 수 없어서 전체 그림으로 씁니다.`)));
  assert.strictEqual(services.calls.ingest.filter((c) => c.kind === 'pic').length, 1, '배경 판은 배경을 빼지 않는다');
  assert.ok(services.calls.ingest.filter((c) => c.kind === 'cel').every((c) => /^#[0-9a-f]{6}$/i.test(c.keyColor)));
});

test('우선순위 줄 · 건너뛰기 · 이웃 그림: 오래·세게 나오는 장면부터, 같은 장면은 이어서, 배경은 한 번만 — 건너뛴 그림은 가까운 그림으로 대신해 언제든 영상이 된다', async () => {
  const { engine, services } = newEngine();
  const id = await aiProject(engine);
  const s0 = await driveToDrawings(engine, id);
  const q = s0.queue;
  // 장면별로 이어져 있다 (한 장면의 항목이 흩어지지 않는다)
  const celQ = q.filter((x) => x.kind === 'cel');
  const shotsInOrder = [...new Set(celQ.map((x) => x.shot))];
  const lastAt = (sh) => celQ.map((x) => x.shot).lastIndexOf(sh);
  const firstAt = (sh) => celQ.map((x) => x.shot).indexOf(sh);
  for (const sh of shotsInOrder) assert.strictEqual(lastAt(sh) - firstAt(sh) + 1, celQ.filter((x) => x.shot === sh).length, '같은 장면의 인물 그림은 이어서');
  const ws = shotsInOrder.map((sh) => celQ.find((x) => x.shot === sh).weight);
  assert.deepStrictEqual(ws, [...ws].sort((a, b) => b - a), '무게(시간×에너지) 내림차순');
  assert.ok(ws[0] > ws.at(-1) || ws.length < 2);
  const bgs = q.filter((x) => x.kind === 'bg');
  assert.strictEqual(new Set(bgs.map((x) => x.key)).size, bgs.length);
  assert.ok(bgs.length >= 1 && bgs.length <= 4, '배경은 막마다 하나로 묶인다 (연습 이야기는 4막)');
  assert.ok(q[0].kind === 'bg' && q[1].kind === 'cel', '배경이 그 장면 그림보다 먼저');
  // 건너뛰기: 첫 그림을 건너뛰면 다음 그림이 부탁 차례가 된다
  const r0 = await engine.handoff.request(id);
  assert.strictEqual(await engine.drawings.skip(id, r0.key), true);
  await engine.whenIdle(id);
  const r1 = await engine.handoff.request(id);
  assert.strictEqual(r1.key, q[1].key);
  let s = await engine.projects.get(id);
  assert.strictEqual(s.drawings.find((d) => d.key === q[0].key).status, 'skipped');
  assert.strictEqual(s.work.skipped, 1);
  // 그림 두 장만 받고 나머지는 모두 건너뛰고 영상으로: 이웃 그림으로 대신해서 끝까지 만들어진다
  await engine.handoff.acceptFiles(id, [file('cel-only')], { slotKey: q[1].key });
  const n = await engine.drawings.finishEarly(id);
  assert.ok(n > 5);
  await engine.whenIdle(id);
  s = await engine.projects.get(id);
  assert.strictEqual(s.status, 'done');
  const mats = services.calls.exports.at(-1).shots;
  assert.strictEqual(mats.length, s.xsheet.shots.length);
  for (const m of mats) for (const [, v] of m.layers) assert.ok(v && v.token.startsWith('CEL:'), '모든 칸에 그림이 있다(이웃 그림으로 대신)');
  assert.ok(mats.every((m) => m.bg === null), '배경이 하나도 없으면 종이색(null)');
  // 건너뛴 그림은 다시 부탁할 수 있다
  assert.strictEqual(await engine.drawings.unskip(id, q[0].key), true);
  s = await engine.projects.get(id);
  assert.strictEqual(s.drawings.find((d) => d.key === q[0].key).status, 'pending');
});

test('초안(애니매틱): 지금 있는 그림만으로 작은 영상을 따로 — 없는 그림은 카드, 작품 상태는 그대로', async () => {
  const { engine, services } = newEngine();
  const id = await aiProject(engine);
  const s0 = await driveToDrawings(engine, id);
  await engine.handoff.acceptFiles(id, [file('bg')], { slotKey: s0.queue[0].key });
  await engine.whenIdle(id);
  const before = await engine.projects.get(id);
  const out = await engine.render.run(id, { draft: true });
  assert.ok(out.missing > 5 && out.key.endsWith('/out/draft'));
  assert.ok((await engine.render.output(id, 'draft')).size > 0);
  const comp = services.calls.compositors.at(-1);
  assert.ok(comp.W <= 640 && comp.H <= 640 && comp.quality === 'low');
  const mats = services.calls.exports.at(-1).shots;
  assert.ok(mats.some((m) => [...m.layers.values()].some((v) => v && v.placeholder)), '없는 그림은 카드');
  assert.ok(mats.some((m) => m.bg && m.bg.token.startsWith('ORIG:')), '있는 배경은 그대로');
  const after = await engine.projects.get(id);
  assert.strictEqual(after.status, before.status);
  assert.strictEqual(after.output.clean, null);
  assert.strictEqual(after.renderStale, before.renderStale);
  assert.ok(after.output.draft && after.output.draft.missing === out.missing);
});

test('캐릭터 만들기용 부탁(설명 정리 · 기준 그림): 번호·검사는 같고, 저장은 부른 쪽이 한다', async () => {
  const { engine } = newEngine();
  const draft = { name: '하루', description_ko: '노란 우비를 입은 아이', personality_ko: '씩씩해요' };
  const req = await engine.handoff.requestCharacter('char:c1', { kind: 'describe', draft });
  assert.strictEqual(req.kind, 'describe');
  assert.ok(req.expectsText && req.nonce && req.prompt.includes(req.nonce));
  assert.strictEqual((await engine.handoff.acceptText('char:c1', req.prompt)).reason, 'echo');
  const value = { locked: { summary: 'a cheerful girl', hair: 'brown bob', outfit: 'yellow raincoat' }, palette: [{ name: 'coat', hex: '#f4c430' }], rules: { must: ['coat'], never: ['hair'] } };
  assert.strictEqual((await engine.handoff.acceptText('char:c1', JSON.stringify(value))).reason, 'noNonce');
  const ok = await engine.handoff.acceptText('char:c1', JSON.stringify({ ...value, request_id: req.nonce }));
  assert.ok(ok.ok && ok.applied === 'describe');
  assert.deepStrictEqual(ok.value.locked, value.locked);
  assert.strictEqual(ok.value.request_id, undefined);
  assert.strictEqual(await db.getExpecting(), null);
  const ref = await engine.handoff.requestCharacter('char:c1', { kind: 'ref', refKind: 'expressions', character: { name: '하루', locked: value.locked, palette: value.palette, rules: value.rules }, art: 'cel look', attach: imgBlob('sheet1') });
  assert.strictEqual(ref.kind, 'ref');
  assert.strictEqual(ref.files.length, 1);
  assert.match(ref.prompt, /Expression sheet/);
  const got = await engine.handoff.acceptFiles('char:c1', [file('sheet2')]);
  assert.strictEqual(got.placed.length, 1);
  assert.ok(got.placed[0].blob.size > 0 && got.placed[0].kind === 'ref');
});
