// 오래 걸리는 일 지킴이(jobs.js): V1 의 '뒤로가기로 완성 영상이 사라지는' 문제(D1)를 막는 규칙을 Node 에서 시험한다
import test, { beforeEach } from 'node:test';
import assert from 'node:assert';
import * as jobs from '../src/jobs.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** signal 을 지켜보며 기다리다가 abort 되면 AbortError 를 던지는 일 */
const waitAbortable = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('그만뒀어요'), { name: 'AbortError' })); }, { once: true });
});

beforeEach(() => jobs._resetForTests());

test('일이 끝나면 { status:"done", value } 로 끝나고, 도는 목록에서 빠진다', async () => {
  assert.strictEqual(jobs.isJobRunning(), false);
  const p = jobs.runJob('p1', async () => { await sleep(5); return 42; }, { title: '영상 만드는 중' });
  assert.strictEqual(jobs.isJobRunning('p1'), true);
  assert.deepStrictEqual(jobs.listJobs().map((j) => [j.id, j.title, j.modal]), [['p1', '영상 만드는 중', true]]);
  const r = await p;
  assert.deepStrictEqual({ id: r.id, status: r.status, value: r.value, cancelRequested: r.cancelRequested }, { id: 'p1', status: 'done', value: 42, cancelRequested: false });
  assert.strictEqual(jobs.isJobRunning(), false);
  assert.deepStrictEqual(jobs.listJobs(), []);
});

test('일이 실패해도 reject 하지 않는다 (처리 안 된 오류가 결과를 지우지 못하게)', async () => {
  const r = await jobs.runJob('p1', async () => { throw new Error('인코더 오류'); });
  assert.strictEqual(r.status, 'failed');
  assert.strictEqual(r.error.message, '인코더 오류');
  const sync = await jobs.runJob('p2', () => { throw new TypeError('바로 던짐'); });
  assert.strictEqual(sync.status, 'failed');
  assert.throws(() => jobs.runJob('p3', 'not a function'), /함수/);
});

test('D1 재현 방지: 화면의 "지금 작품" 변수가 사라져도 일은 시작할 때 받은 id 로 결과를 저장한다', async () => {
  // V1: 화면이 닫히면 ctx=null → 일이 끝난 뒤 ctx.p 를 읽다 TypeError → 완성 영상이 버려졌다.
  let ctx = { projectId: 'p1' };
  const store = new Map();
  const p = jobs.runJob('p1', async ({ id, progress }) => {
    await sleep(10);
    progress(0.5, '절반');
    await sleep(10);
    store.set(id, { output: 'final.mp4' }); // 변수 ctx 가 아니라 받은 id 로 쓴다
    return 'saved';
  }, { title: '영상 만드는 중' });
  ctx = null; // 사용자가 화면을 떠났다
  const r = await p;
  assert.strictEqual(ctx, null);
  assert.strictEqual(r.status, 'done');
  assert.deepStrictEqual(store.get('p1'), { output: 'final.mp4' });
});

test('같은 id 로 이미 도는 일이 있으면 새로 시작하지 않고 그 결과를 같이 기다린다', async () => {
  let calls = 0;
  const a = jobs.runJob('p1', async () => { calls++; await sleep(10); return 'x'; });
  const b = jobs.runJob('p1', async () => { calls++; return 'y'; });
  assert.strictEqual(a, b);
  assert.strictEqual((await b).value, 'x');
  assert.strictEqual(calls, 1);
  // 끝난 뒤에는 새로 시작할 수 있다
  assert.strictEqual((await jobs.runJob('p1', async () => 'z')).value, 'z');
});

test('그만두기: signal 이 abort 되고 onCancel 이 한 번 불리고 결과는 cancelled', async () => {
  const seen = [];
  const p = jobs.runJob('p1', ({ signal }) => waitAbortable(1000, signal), { onCancel: (j) => seen.push(j.id) });
  assert.strictEqual(jobs.cancelJob('p1'), true);
  assert.strictEqual(jobs.cancelJob('p1'), true, '두 번 눌러도 안전');
  const r = await p;
  assert.strictEqual(r.status, 'cancelled');
  assert.strictEqual(r.cancelRequested, true);
  assert.deepStrictEqual(seen, ['p1']);
  assert.strictEqual(jobs.cancelJob('p1'), false, '이미 끝난 일은 그만둘 수 없다');
});

test('그만두라고 했어도 이미 끝낸 일은 버리지 않는다 (done + cancelRequested)', async () => {
  const p = jobs.runJob('p1', async () => { await sleep(15); return '끝냄'; }); // signal 을 안 보는 일
  jobs.cancelJob('p1');
  const r = await p;
  assert.strictEqual(r.status, 'done');
  assert.strictEqual(r.value, '끝냄');
  assert.strictEqual(r.cancelRequested, true);
});

test('signal 을 안 보는 일이 그만두라는 말을 못 알아들으면 일정 시간 뒤 기다림을 푼다 (abandoned)', async () => {
  const p = jobs.runJob('p1', () => new Promise(() => {}), { cancelTimeoutMs: 30 }); // 영원히 안 끝나는 일
  jobs.cancelJob('p1');
  const t0 = Date.now();
  const r = await p;
  assert.strictEqual(r.status, 'cancelled');
  assert.strictEqual(r.abandoned, true);
  assert.ok(Date.now() - t0 >= 25);
  assert.strictEqual(jobs.isJobRunning('p1'), false);
});

test('진행·화면·알림줄 연결(ui, hooks)과 목록 알림', async () => {
  const log = [];
  jobs.setJobUi({
    begin: (job) => { log.push(`ui.begin ${job.title}`); return { update: (j) => log.push(`ui.update ${Math.round(j.progress * 100)} ${j.message}`), cancelling: () => log.push('ui.cancelling'), end: () => log.push('ui.end') }; },
  });
  jobs.setJobHooks({
    start: (j) => log.push(`hook.start ${j.foreground}`),
    progress: (j) => log.push(`hook.progress ${j.progress}`),
    end: (j, status) => log.push(`hook.end ${status}`),
  });
  const changes = [];
  const off = jobs.onJobsChange((list) => changes.push(list.length));
  await jobs.runJob('p1', async ({ progress }) => { progress(0.25, '조금'); progress(1, '끝'); }, { title: '일', foreground: true });
  assert.deepStrictEqual(log, [
    'ui.begin 일', 'hook.start true', 'ui.update 25 조금', 'hook.progress 0.25', 'ui.update 100 끝', 'hook.progress 1', 'ui.end', 'hook.end done',
  ]);
  assert.deepStrictEqual(changes, [1, 1, 1, 0], '시작·진행 2번·끝 때 불린다');
  off();
  await jobs.runJob('p2', async () => {});
  assert.deepStrictEqual(changes, [1, 1, 1, 0], '끈 뒤에는 불리지 않는다');
  // 진행값은 0~1 로 잘린다
  let seen = null;
  await jobs.runJob('p3', async ({ progress }) => { progress(7); seen = jobs.listJobs()[0].progress; });
  assert.strictEqual(seen, 1);
});

test('뒤로가기 지킴이: 일이 없으면 "none" (평소처럼 처리)', async () => {
  assert.strictEqual(await jobs.guardBack({ ask: async () => { throw new Error('묻지 않아야 한다'); } }), 'none');
});

test('뒤로가기 지킴이: 일 중에는 "그만둘까요, 계속 할까요?" 를 묻고, 계속 하기를 고르면 일은 그대로 끝까지 간다', async () => {
  assert.strictEqual(jobs.BACK_QUESTION, '그만둘까요, 계속 할까요?');
  const questions = [];
  const p = jobs.runJob('p1', async () => { await sleep(30); return 'done!'; }, { title: '영상 만드는 중' });
  const g = await jobs.guardBack({ ask: async (q) => { questions.push(q); return false; } });
  assert.strictEqual(g, 'continue');
  assert.strictEqual(questions.length, 1);
  assert.strictEqual(questions[0].title, '그만둘까요, 계속 할까요?');
  assert.strictEqual(questions[0].stopLabel, '그만두기');
  assert.strictEqual(questions[0].keepLabel, '계속 하기');
  assert.match(questions[0].text, /영상 만드는 중/);
  assert.strictEqual((await p).status, 'done');
});

test('뒤로가기 지킴이: 그만두기를 고르면 일을 멈추고 "cancelled" (일이 정리된 뒤에 돌아온다)', async () => {
  let stopped = false;
  const p = jobs.runJob('p1', async ({ signal }) => { try { await waitAbortable(1000, signal); } finally { stopped = true; } });
  const g = await jobs.guardBack({ ask: async () => true });
  assert.strictEqual(g, 'cancelled');
  assert.strictEqual(stopped, true, '돌아오기 전에 일이 정리됐다');
  assert.strictEqual((await p).status, 'cancelled');
  assert.strictEqual(jobs.isJobRunning(), false);
});

test('뒤로가기 지킴이: 질문이 떠 있는 동안 또 누르면 질문을 닫고(=계속 하기) 새 질문은 열지 않는다', async () => {
  let dismissed = 0;
  let resolveAsk;
  const p = jobs.runJob('p1', async ({ signal }) => waitAbortable(60, signal).catch(() => 'x'));
  const first = jobs.guardBack({ ask: () => new Promise((r) => { resolveAsk = r; }) });
  await sleep(1);
  assert.strictEqual(jobs.isAsking(), true);
  const second = await jobs.guardBack({ ask: async () => { throw new Error('두 번째 질문은 없다'); }, dismiss: () => { dismissed++; resolveAsk(false); } });
  assert.strictEqual(second, 'continue');
  assert.strictEqual(dismissed, 1);
  assert.strictEqual(await first, 'continue');
  assert.strictEqual(jobs.isAsking(), false);
  await p;
});

test('뒤로가기 지킴이: 조용히 도는 일(modal:false)은 묻지 않고, 그만둘 수 없는 일(cancelable:false)은 뒤로가기를 삼킨다', async () => {
  const noAsk = async () => { throw new Error('묻지 않아야 한다'); };
  const quiet = jobs.runJob('bg', async () => { await sleep(20); }, { modal: false });
  assert.strictEqual(await jobs.guardBack({ ask: noAsk }), 'none');
  await quiet;
  const must = jobs.runJob('must', async () => { await sleep(20); }, { cancelable: false });
  assert.strictEqual(await jobs.guardBack({ ask: noAsk }), 'continue');
  await must;
});

test('뒤로가기 지킴이: 질문하는 사이 일이 끝났으면 "none", 질문 창이 오류를 내도 일은 지킨다', async () => {
  let finish;
  const p = jobs.runJob('p1', () => new Promise((r) => { finish = r; }));
  const g = jobs.guardBack({ ask: async () => { finish('ok'); await p; return true; } });
  assert.strictEqual(await g, 'none');
  assert.strictEqual((await p).status, 'done');
  const p2 = jobs.runJob('p2', async () => { await sleep(10); return 1; });
  assert.strictEqual(await jobs.guardBack({ ask: async () => { throw new Error('창 오류'); } }), 'continue');
  assert.strictEqual((await p2).status, 'done');
});

test('질문 창을 못 쓰는 환경(ui 없음)에서도 일을 지키는 쪽("continue")', async () => {
  const p = jobs.runJob('p1', async () => { await sleep(10); });
  assert.strictEqual(await jobs.guardBack(), 'continue');
  await p;
});

test('cancelAll: 도는 일을 전부 그만둔다', async () => {
  const a = jobs.runJob('a', ({ signal }) => waitAbortable(1000, signal));
  const b = jobs.runJob('b', ({ signal }) => waitAbortable(1000, signal));
  assert.strictEqual(jobs.cancelAll(), 2);
  assert.deepStrictEqual([(await a).status, (await b).status], ['cancelled', 'cancelled']);
});

test('waitForJob: 도는 일이 끝날 때까지 기다리고, 없으면 바로 null (작품을 지우기 전에 그 작품의 일을 그만두고 기다리는 데 쓴다)', async () => {
  assert.strictEqual(await jobs.waitForJob('none'), null);
  const log = [];
  const p = jobs.runJob('p1', async ({ signal }) => { try { await waitAbortable(1000, signal); } finally { log.push('정리 끝'); } });
  assert.strictEqual(jobs.cancelJob('p1'), true);
  const r = await jobs.waitForJob('p1');
  log.push('기다림 끝');
  assert.strictEqual(r.status, 'cancelled');
  assert.deepStrictEqual(log, ['정리 끝', '기다림 끝']);
  assert.strictEqual((await p).status, 'cancelled');
});
