// 폰 저장소(db.js)의 계산·규칙을 Node 에서 시험한다 (fake-indexeddb: 진짜 IndexedDB 규칙을 따르는 메모리 구현)
import 'fake-indexeddb/auto';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert';
import * as db from '../src/db.js';

beforeEach(async () => {
  await db.deleteDatabase();
});

test('저장소 이름·버전과 일곱 개 창고가 만들어진다', async () => {
  assert.strictEqual(db.DB_NAME, 'animemaker-v2');
  assert.strictEqual(db.DB_VERSION, 1);
  const conn = await db.open();
  assert.deepStrictEqual([...conn.objectStoreNames].sort(), [...db.STORES].sort());
  assert.deepStrictEqual([...db.STORES].sort(), ['characters', 'drawings', 'files', 'inbox', 'meta', 'projects', 'series']);
  // drawings: keyPath [projectId,key] + 색인 projectId
  const t = conn.transaction('drawings', 'readonly');
  const s = t.objectStore('drawings');
  assert.deepStrictEqual(s.keyPath, ['projectId', 'key']);
  assert.ok(s.indexNames.contains('projectId'));
  await new Promise((r) => { t.oncomplete = r; });
});

test('meta: 값 저장·기본값·지우기', async () => {
  assert.strictEqual(await db.getMeta('settings'), null);
  assert.deepStrictEqual(await db.getMeta('settings', { a: 1 }), { a: 1 });
  await db.setMeta('settings', { textApp: 'gemini' });
  assert.deepStrictEqual(await db.getMeta('settings'), { textApp: 'gemini' });
  await db.deleteMeta('settings');
  assert.strictEqual(await db.getMeta('settings'), null);
  await assert.rejects(() => db.getMeta(''), /키/);
});

test('작품: 저장·읽기·목록(최근 순)·그림은 따로', async () => {
  const a = await db.putProject({ id: 'p_a', title: 'A' });
  assert.ok(a.updatedAt > 0);
  await new Promise((r) => setTimeout(r, 5));
  await db.putProject({ id: 'p_b', title: 'B' });
  assert.strictEqual((await db.getProject('p_a')).title, 'A');
  assert.strictEqual(await db.getProject('없는것'), null);
  assert.deepStrictEqual((await db.listProjects()).map((p) => p.id), ['p_b', 'p_a']);
  // 작품 레코드에 그림 목록을 넣으면 거부 (프로젝트 JSON 을 작게 유지)
  await assert.rejects(() => db.putProject({ id: 'p_c', drawings: [{ key: 'x' }] }), /putDrawing/);
  await assert.rejects(() => db.putProject({ title: 'id 없음' }), /id/);
});

test('그림 기록: [projectId,key] 로 저장·읽기·한 작품 목록·일괄 저장', async () => {
  await db.putDrawing({ projectId: 'p1', key: 'bg3', kind: 'bg', shot: 3, status: 'done' });
  await db.putDrawing({ projectId: 'p1', key: 'cel3_a', kind: 'cel', shot: 3 });
  await db.putDrawing({ projectId: 'p2', key: 'bg1', kind: 'bg', shot: 1 });
  await db.putDrawings([{ projectId: 'p1', key: 'bg4', kind: 'bg' }, { projectId: 'p1', key: 'bg5', kind: 'bg' }]);
  assert.strictEqual((await db.getDrawing('p1', 'bg3')).status, 'done');
  assert.strictEqual(await db.getDrawing('p1', 'nope'), null);
  assert.deepStrictEqual((await db.listDrawings('p1')).map((d) => d.key), ['bg3', 'bg4', 'bg5', 'cel3_a']);
  assert.deepStrictEqual((await db.listDrawings('p2')).map((d) => d.key), ['bg1']);
  // 같은 키를 다시 저장하면 덮어쓴다
  await db.putDrawing({ projectId: 'p1', key: 'bg3', kind: 'bg', shot: 3, status: 'redo' });
  assert.strictEqual((await db.getDrawing('p1', 'bg3')).status, 'redo');
  assert.strictEqual((await db.listDrawings('p1')).length, 4);
  await db.deleteDrawing('p1', 'bg3');
  assert.strictEqual(await db.getDrawing('p1', 'bg3'), null);
  // 일괄 저장은 하나라도 틀리면 아무것도 안 넣는다
  await assert.rejects(() => db.putDrawings([{ projectId: 'p9', key: 'ok' }, { projectId: 'p9' }]), /key/);
  assert.deepStrictEqual(await db.listDrawings('p9'), []);
});

test('파일(Blob): 저장·읽기·앞글자로 지우기 — 다른 작품 파일은 그대로', async () => {
  await db.putFile('p1/song', new Blob(['노래'], { type: 'audio/wav' }));
  await db.putFile('p1/cel/a', new Blob(['aaa'], { type: 'image/webp' }));
  await db.putFile('p10/song', new Blob(['다른 작품'], { type: 'audio/wav' })); // 'p1' 로 시작하지만 'p1/' 는 아님
  await db.putFile('char/c1/ref0', new Blob(['ref'], { type: 'image/png' }));
  const song = await db.getFile('p1/song');
  assert.strictEqual(song.type, 'audio/wav');
  assert.strictEqual(await song.text(), '노래');
  assert.strictEqual(await db.getFile('없음'), null);
  assert.strictEqual(await db.getFile(''), null);
  assert.ok(await db.hasFile('p1/cel/a'));
  assert.deepStrictEqual((await db.listFileKeys('p1/')).sort(), ['p1/cel/a', 'p1/song']);
  await db.deleteFiles('p1/');
  assert.deepStrictEqual(await db.listFileKeys('p1/'), []);
  assert.ok(await db.hasFile('p10/song'), 'p1/ 지우기가 p10/ 을 건드리면 안 된다');
  assert.ok(await db.hasFile('char/c1/ref0'));
  await assert.rejects(() => db.deleteFiles(''), /앞글자/); // 전부 지우는 사고 방지
  await db.deleteFile('p10/song');
  assert.ok(!(await db.hasFile('p10/song')));
});

test('작품 지우기: 작품 · 그림 기록 · "<id>/" 파일을 한꺼번에, 다른 작품·캐릭터 파일은 그대로', async () => {
  await db.putProject({ id: 'p1', title: '지울 것' });
  await db.putProject({ id: 'p10', title: '남을 것' });
  await db.putDrawing({ projectId: 'p1', key: 'bg1' });
  await db.putDrawing({ projectId: 'p10', key: 'bg1' });
  await db.putFile('p1/song', new Blob(['x']));
  await db.putFile('p1/out/final.mp4', new Blob(['y']));
  await db.putFile('p10/song', new Blob(['z']));
  await db.putFile('char/c1/ref0', new Blob(['ref']));
  await db.deleteProject('p1');
  assert.strictEqual(await db.getProject('p1'), null);
  assert.deepStrictEqual(await db.listDrawings('p1'), []);
  assert.deepStrictEqual(await db.listFileKeys('p1/'), []);
  assert.ok(await db.getProject('p10'));
  assert.strictEqual((await db.listDrawings('p10')).length, 1);
  assert.deepStrictEqual((await db.listFileKeys()).sort(), ['char/c1/ref0', 'p10/song']);
});

test('캐릭터 · 시리즈: 저장·읽기·목록·지우기 (기준 그림 파일은 그대로)', async () => {
  await db.putCharacter({ id: 'c1', name: '하루', refs: [{ kind: 'turnaround', label: '앞뒤옆', mime: 'image/png', blobKey: 'char/c1/ref0' }] });
  await db.putFile('char/c1/ref0', new Blob(['png']));
  await db.putSeries({ id: 's1', name: '별빛', characterIds: ['c1'] });
  assert.strictEqual((await db.getCharacter('c1')).name, '하루');
  assert.strictEqual((await db.listCharacters()).length, 1);
  assert.deepStrictEqual((await db.getSeries('s1')).characterIds, ['c1']);
  assert.strictEqual((await db.listSeries()).length, 1);
  await db.deleteCharacter('c1');
  assert.strictEqual(await db.getCharacter('c1'), null);
  assert.ok(await db.hasFile('char/c1/ref0'), '캐릭터 레코드를 지워도 기준 그림 파일은 따로 지운다');
  await db.deleteSeries('s1');
  assert.deepStrictEqual(await db.listSeries(), []);
});

test('받은 함: 항목 저장·받은 순서 목록·지우면 파일도 함께', async () => {
  await db.putInbox({ id: 'sh2', receivedAt: 200, text: '', items: [{ name: 'b.png', mime: 'image/png', size: 3, key: 'inbox/sh2/0' }] });
  await db.putInbox({ id: 'sh1', receivedAt: 100, text: '안녕', items: [] });
  await db.putFile('inbox/sh2/0', new Blob(['png']));
  assert.deepStrictEqual((await db.listInbox()).map((e) => e.id), ['sh1', 'sh2']);
  assert.strictEqual((await db.getInbox('sh1')).text, '안녕');
  await db.deleteInbox('sh2');
  assert.strictEqual(await db.getInbox('sh2'), null);
  assert.ok(!(await db.hasFile('inbox/sh2/0')));
});

test('expecting 는 저장소에 남아서 앱을 다시 켜도(연결을 닫았다 열어도) 읽힌다', async () => {
  assert.strictEqual(await db.getExpecting(), null);
  const e = await db.setExpecting({ projectId: 'p1', kind: 'cel', key: 'cel3_a' });
  assert.deepStrictEqual(Object.keys(e).sort(), ['key', 'kind', 'nonce', 'projectId', 'requestedAt']);
  assert.match(e.nonce, /^[0-9a-f]{16}$/);
  assert.ok(Math.abs(e.requestedAt - Date.now()) < 2000);
  await db.close(); // 프로세스가 죽은 것과 같다 (연결을 버리고 새로 연다)
  assert.deepStrictEqual(await db.getExpecting(), e);
  // 종류가 틀리면 거부
  await assert.rejects(() => db.setExpecting({ projectId: 'p1', kind: 'video' }), /plan/);
  await assert.rejects(() => db.setExpecting({ kind: 'plan' }), /projectId/);
  // 모든 종류를 받는다
  for (const kind of db.EXPECTING_KINDS) assert.strictEqual((await db.setExpecting({ projectId: 'p1', kind })).kind, kind);
  assert.deepStrictEqual([...db.EXPECTING_KINDS], ['plan', 'xsheet', 'bg', 'cel', 'ref', 'describe']);
});

test('expecting: 부탁마다 다른 번호(nonce), 번호가 맞을 때만 지우기, 오래되면 없는 것으로', async () => {
  const a = await db.setExpecting({ projectId: 'p1', kind: 'plan' });
  const b = await db.setExpecting({ projectId: 'p1', kind: 'xsheet' });
  assert.notStrictEqual(a.nonce, b.nonce);
  assert.strictEqual(await db.clearExpecting(a.nonce), false, '옛 부탁 번호로는 새 부탁을 지우지 않는다');
  assert.strictEqual((await db.getExpecting()).nonce, b.nonce);
  assert.strictEqual(await db.clearExpecting(b.nonce), true);
  assert.strictEqual(await db.getExpecting(), null);
  assert.strictEqual(await db.clearExpecting(), false);
  // 오래된 부탁
  await db.setMeta('expecting', { projectId: 'p1', kind: 'bg', key: '1', requestedAt: Date.now() - 13 * 3600 * 1000, nonce: 'old' });
  assert.strictEqual(await db.getExpecting(), null);
  assert.strictEqual((await db.getExpecting({ maxAgeMs: 0 })).nonce, 'old');
});

test('마지막으로 연 작품(lastProject)', async () => {
  assert.strictEqual(await db.getLastProject(), null);
  await db.setLastProject('p7');
  assert.strictEqual(await db.getLastProject(), 'p7');
  await db.setLastProject(null);
  assert.strictEqual(await db.getLastProject(), null);
});

test('usage / requestPersist / ensurePersistOnce: navigator.storage 를 바꿔 끼워 시험', async () => {
  const calls = [];
  const nav = { storage: {
    estimate: async () => ({ usage: 1234, quota: 5e9 }),
    persisted: async () => false,
    persist: async () => { calls.push('persist'); return true; },
  } };
  assert.deepStrictEqual(await db.usage(nav), { used: 1234, quota: 5e9, persisted: false });
  assert.strictEqual(await db.usage({}), null);
  assert.strictEqual(await db.requestPersist(nav), true);
  assert.strictEqual(await db.requestPersist({}), false);
  calls.length = 0;
  const first = await db.ensurePersistOnce(nav);
  assert.strictEqual(first.granted, true);
  const second = await db.ensurePersistOnce(nav);
  assert.deepStrictEqual(second, first);
  assert.deepStrictEqual(calls, ['persist'], '처음 켤 때 한 번만 묻는다');
  // 거절당한 결과도 기억한다 (매번 묻지 않는다)
  await db.deleteMeta('persist');
  calls.length = 0;
  const denied = await db.ensurePersistOnce({ storage: { persist: async () => { calls.push('p'); return false; } } });
  assert.strictEqual(denied.granted, false);
  await db.ensurePersistOnce({ storage: { persist: async () => { calls.push('p'); return true; } } });
  assert.deepStrictEqual(calls, ['p']);
});

test('저장 공간이 꽉 차면 알기 쉬운 한국어 오류(quota)', async () => {
  const conn = await db.open();
  const realTx = conn.transaction.bind(conn);
  const fake = { name: 'QuotaExceededError', message: 'full' };
  conn.transaction = (...a) => {
    const t = realTx(...a);
    const origPut = t.objectStore.bind(t);
    t.objectStore = (n) => {
      const s = origPut(n);
      const put = s.put.bind(s);
      s.put = () => { throw Object.assign(new Error('full'), fake); };
      void put;
      return s;
    };
    return t;
  };
  await assert.rejects(() => db.putFile('x/y', new Blob(['z'])), (e) => e instanceof db.StorageError && e.quota === true && /저장 공간이 부족/.test(e.message));
  conn.transaction = realTx;
});

test('newId: 접두사 + 시각 + 무작위, 겹치지 않는다', () => {
  const ids = new Set(Array.from({ length: 500 }, () => db.newId('p')));
  assert.strictEqual(ids.size, 500);
  for (const id of ids) assert.match(id, /^p_[0-9a-z]+$/);
});
