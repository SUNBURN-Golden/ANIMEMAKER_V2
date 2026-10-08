// 공유로 받은 것 → 앱 저장소 옮기기(inbox.js): 가짜 네이티브 + fake-indexeddb
import 'fake-indexeddb/auto';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert';
import * as db from '../src/db.js';
import { ingestEntry, startReceiving, kindOf, describeReceived, readReceivedBlob, listReceived, discardReceived } from '../src/inbox.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
beforeEach(async () => { await db.deleteDatabase(); });

/** 가짜 네이티브: 받은 함 + 파일 읽기 */
function fakeNative(files = {}) {
  const acked = [];
  const pending = [];
  let handler = null;
  return {
    acked,
    pending,
    ackInbox: async (ids) => { acked.push(...ids); return ids.length; },
    sharedItemToBlob: async (it) => {
      if (!(it.path in files)) throw new Error('없는 파일');
      return new Blob([files[it.path]], { type: it.mime });
    },
    onShared(cb) { handler = cb; for (const e of pending) cb(e); return () => { handler = null; }; },
    emit(e) { return handler && handler(e); },
  };
}

const E1 = { id: 'sh1', receivedAt: 1000, text: '프롬프트 답장', items: [{ path: '/c/1_a.png', name: 'a.png', mime: 'image/png', size: 3 }, { path: '/c/1_b.png', name: 'b.png', mime: 'image/png', size: 3 }] };

test('종류 나누기와 한국어 요약', () => {
  assert.strictEqual(kindOf({ mime: 'image/webp', name: 'x' }), 'image');
  assert.strictEqual(kindOf({ mime: 'audio/mpeg', name: 'x.mp3' }), 'audio');
  assert.strictEqual(kindOf({ mime: 'application/octet-stream', name: '하루.amchar' }), 'amchar');
  assert.strictEqual(kindOf({ mime: 'text/plain', name: 'lyrics.txt' }), 'text');
  assert.strictEqual(kindOf({ mime: 'application/octet-stream', name: 'lyrics.lrc' }), 'text');
  assert.strictEqual(kindOf({ mime: 'application/zip', name: 'z.zip' }), 'other');
  assert.strictEqual(describeReceived({ items: [{ mime: 'image/png' }, { mime: 'image/png' }, { mime: 'audio/wav' }], text: '글' }), '그림 2장 · 노래 1개 · 글');
  assert.strictEqual(describeReceived({ items: [], text: '' }), '(비어 있음)');
});

test('받은 항목 하나 옮기기: 파일은 files 에, 목록은 inbox 에, 네이티브에는 ack', async () => {
  const n = fakeNative({ '/c/1_a.png': 'AAA', '/c/1_b.png': 'BBB' });
  const s = await ingestEntry(E1, { native: n });
  assert.deepStrictEqual({ id: s.id, stored: s.stored, failed: s.failed, text: s.text, duplicate: s.duplicate, label: s.label }, { id: 'sh1', stored: 2, failed: 0, text: '프롬프트 답장', duplicate: false, label: '그림 2장 · 글' });
  assert.deepStrictEqual(n.acked, ['sh1']);
  const rec = await db.getInbox('sh1');
  assert.deepStrictEqual(rec.items.map((i) => [i.name, i.mime, i.size, i.key]), [['a.png', 'image/png', 3, 'inbox/sh1/0'], ['b.png', 'image/png', 3, 'inbox/sh1/1']]);
  assert.strictEqual(await (await db.getFile('inbox/sh1/1')).text(), 'BBB');
  assert.strictEqual(await (await readReceivedBlob('sh1', 0)).text(), 'AAA');
  assert.strictEqual(await readReceivedBlob('sh1', 5), null);
  assert.deepStrictEqual((await listReceived()).map((r) => r.id), ['sh1']);
  // 쓴 뒤에는 파일까지 지운다
  await discardReceived('sh1');
  assert.strictEqual(await db.getInbox('sh1'), null);
  assert.ok(!(await db.hasFile('inbox/sh1/0')));
});

test('같은 항목이 또 오면(ack 가 실패했던 경우) 다시 옮기지 않고 ack 만 한다', async () => {
  const n = fakeNative({ '/c/1_a.png': 'AAA', '/c/1_b.png': 'BBB' });
  await ingestEntry(E1, { native: n });
  n.acked.length = 0;
  const again = await ingestEntry(E1, { native: n });
  assert.strictEqual(again.duplicate, true);
  assert.deepStrictEqual(n.acked, ['sh1']);
  assert.strictEqual((await db.listInbox()).length, 1);
});

test('읽을 수 없는 파일은 세고 나머지는 옮긴다 / 하나도 못 옮기고 글도 없으면 목록에 안 남기고 ack', async () => {
  const n = fakeNative({ '/c/1_a.png': 'AAA' }); // b.png 는 없음
  const s = await ingestEntry({ ...E1, failed: 1 }, { native: n });
  assert.strictEqual(s.stored, 1);
  assert.strictEqual(s.failed, 2, '네이티브가 못 복사한 것(1) + 지금 못 읽은 것(1)');
  assert.deepStrictEqual((await db.getInbox('sh1')).failed, 2);
  const n2 = fakeNative({});
  const none = await ingestEntry({ id: 'sh2', receivedAt: 5, items: [{ path: '/x', name: 'x.png', mime: 'image/png' }], text: '' }, { native: n2 });
  assert.strictEqual(none.stored, 0);
  assert.strictEqual(none.failed, 1);
  assert.strictEqual(await db.getInbox('sh2'), null);
  assert.deepStrictEqual(n2.acked, ['sh2']);
  await assert.rejects(() => ingestEntry({}, { native: n }), /id/);
});

test('저장 공간이 모자라면 ack 하지 않고 오류를 던진다 — 파일은 네이티브에 남아 있고 반쯤 옮긴 것은 치운다', async () => {
  const n = fakeNative({ '/c/1_a.png': 'AAA', '/c/1_b.png': 'BBB' });
  let puts = 0;
  const store = {
    ...db,
    putFile: async (k, b) => { if (++puts === 2) throw Object.assign(new db.StorageError('저장 공간이 부족해요', null), { quota: true }); return db.putFile(k, b); },
    getInbox: db.getInbox, putInbox: db.putInbox, deleteFiles: db.deleteFiles,
  };
  await assert.rejects(() => ingestEntry(E1, { native: n, store }), (e) => e.quota === true);
  assert.deepStrictEqual(n.acked, []);
  assert.strictEqual(await db.getInbox('sh1'), null);
  assert.deepStrictEqual(await db.listFileKeys('inbox/'), [], '첫 파일도 치웠다');
  // 공간이 생긴 뒤 다시 하면 된다
  const ok = await ingestEntry(E1, { native: n });
  assert.strictEqual(ok.stored, 2);
});

test('startReceiving: 항목을 차례로 옮기고, 실패하면 onError 후 다음 항목은 계속, 실패한 것은 false(다시 시도)', async () => {
  const n = fakeNative({ '/c/1_a.png': 'AAA', '/c/1_b.png': 'BBB', '/c/3.png': 'CCC' });
  const got = [];
  const errs = [];
  const bad = { id: 'bad', receivedAt: 2, items: [{ path: '/c/none.png', name: 'n.png', mime: 'image/png' }], text: '' };
  const off = startReceiving({ native: n, onReceived: (s) => got.push(s.id), onError: (e) => errs.push(e.message) });
  const results = await Promise.all([
    n.emit(E1),
    n.emit({ id: 'sh3', receivedAt: 3000, items: [{ path: '/c/3.png', name: 'c.png', mime: 'image/png' }], text: '' }),
    n.emit(bad),
    n.emit({ id: 'sh1', items: [], text: '' }), // 이미 옮긴 것(중복)
  ]);
  assert.deepStrictEqual(results, [true, true, true, true]);
  assert.deepStrictEqual(got, ['sh1', 'sh3', 'bad', 'sh1']);
  assert.deepStrictEqual(errs, []);
  assert.deepStrictEqual((await db.listInbox()).map((r) => r.id), ['sh1', 'sh3']);
  // 저장소 오류 → false
  const brokenStore = { getInbox: async () => { throw new Error('저장소 오류'); } };
  const off2 = startReceiving({ native: n, store: brokenStore, onError: (e) => errs.push(e.message) });
  assert.strictEqual(await n.emit({ id: 'zzz', items: [], text: '' }), false);
  assert.deepStrictEqual(errs, ['저장소 오류']);
  off(); off2();
  await sleep(1);
});

test('콜드 스타트 공유: expecting 이 저장돼 있으면 앱을 다시 켠 뒤(연결을 닫았다 열어도) 받은 것과 기다림을 함께 읽을 수 있다', async () => {
  const exp = await db.setExpecting({ projectId: 'p1', kind: 'cel', key: 'cel3_a' });
  await db.close(); // 프로세스 죽음
  const n = fakeNative({ '/c/1_a.png': 'AAA', '/c/1_b.png': 'BBB' });
  n.pending.push(E1); // 네이티브 받은 함에 남아 있던 공유 (앱이 꺼진 동안 도착)
  const got = [];
  startReceiving({ native: n, onReceived: (s) => got.push(s) })();
  await sleep(30);
  assert.strictEqual(got.length, 1);
  const e = await db.getExpecting();
  assert.deepStrictEqual(e, exp, '기다림이 그대로 남아 있어 받은 그림을 그 칸으로 보낼 수 있다');
  assert.deepStrictEqual((await db.listInbox()).map((r) => r.id), ['sh1']);
});

test('일시적으로 파일을 못 읽어도 한 번 더 해 보고 옮긴다', async () => {
  const n = fakeNative({ '/c/1_a.png': 'AAA', '/c/1_b.png': 'BBB' });
  let tries = 0;
  const real = n.sharedItemToBlob;
  n.sharedItemToBlob = async (it) => { if (it.path === '/c/1_a.png' && ++tries === 1) throw new Error('일시 오류'); return real(it); };
  const s = await ingestEntry(E1, { native: n });
  assert.strictEqual(s.stored, 2);
  assert.strictEqual(s.failed, 0);
  assert.strictEqual(tries, 2);
});
