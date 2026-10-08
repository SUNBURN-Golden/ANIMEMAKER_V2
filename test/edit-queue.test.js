'use strict';
// 그림 한 장 다시 그리기는 '영상 만들기' 가 아니다: 자기만의 대기열(한 번에 하나씩), 다른 편집은 막지 않는다 (DESIGN §3.1b)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { copyFixture } = require('./helpers/edit-fixture');
const EC = require('../src/main/pipeline/edits-core');
const K = require('../src/main/media/keyer');

const abs = (fx, rel) => path.join(fx.dir, rel);
const bytes = (fx, rel) => fs.readFileSync(abs(fx, rel));
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** genImage 를 감싸서 부른 순서·동시에 도는 수를 센다. gate 가 있으면 풀어 줄 때까지 기다린다(중지 신호가 오면 AbortError) */
function spy(r, { gate = null } = {}) {
  const log = { order: [], max: 0, now: 0, calls: [] };
  const orig = r.genImage.bind(r);
  r.genImage = async (args, tag, ctl) => {
    log.order.push(args.title);
    log.calls.push(args);
    log.now++;
    log.max = Math.max(log.max, log.now);
    try {
      if (gate) {
        await new Promise((resolve, reject) => {
          const g = gate.get(args.title);
          if (!g) return resolve();
          g.then(resolve);
          ctl.signal.addEventListener('abort', () => reject(Object.assign(new Error('사용자가 중지했습니다.'), { name: 'AbortError' })), { once: true });
          return undefined;
        });
      }
      return await orig(args, tag, ctl);
    } finally {
      log.now--;
    }
  };
  return log;
}

test('여러 장을 줄 세우면 들어온 순서대로 한 번에 하나씩: running 은 건드리지 않고 redrawing 에 보이고 update 가 계속 나온다', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  const log = spy(r);
  const seen = [];
  r.on('update', (s) => seen.push({ running: s.running, redrawing: s.redrawing.map((x) => `${x.shot}${x.id}:${x.status}`).join(',') }));
  const ps = [r.regenerate('drawing', 1, { id: 'A' }), r.regenerate('drawing', 1, { id: 'B' }), r.regenerate('drawing', 3, { id: 'A' })];
  let s = r.snapshot();
  assert.deepStrictEqual(s.redrawing, [{ shot: 1, id: 'A', status: 'running' }, { shot: 1, id: 'B', status: 'queued' }, { shot: 3, id: 'A', status: 'queued' }]);
  assert.strictEqual(s.running, false, '영상 만들기가 아니다');
  assert.strictEqual(r.running, false);
  assert.strictEqual(s.canApply, false, '그림을 다시 그리는 동안은 반영할 수 없다');
  assert.strictEqual(r.itemOf(1, 'A').status, 'running');
  assert.strictEqual(r.itemOf(1, 'B').status, 'done', '줄 서 있는 그림은 아직 옛 그림 그대로');
  const done = await Promise.all(ps);
  assert.deepStrictEqual(done.map((d) => d.id), ['A', 'B', 'A']);
  assert.deepStrictEqual(done.map((d) => d.status), ['done', 'done', 'done']);
  assert.deepStrictEqual(log.order, ['그림 컷1-A', '그림 컷1-B', '그림 컷3-A'], '들어온 순서');
  assert.strictEqual(log.max, 1, '동시에 둘 이상 그리지 않는다');
  assert.deepStrictEqual(r.snapshot().redrawing, []);
  assert.ok(seen.every((x) => x.running === false));
  assert.ok(seen.length >= 6, `update ${seen.length}번`);
  const states = [...new Set(seen.map((x) => x.redrawing))];
  assert.ok(states.includes('1A:running,1B:queued,3A:queued') && states.includes('1B:running,3A:queued') && states.includes('3A:running') && states.includes(''), states.join(' | '));
  assert.deepStrictEqual(r.p.dirtyShots, [1, 3]);
});

test('같은 그림을 두 번 누르면 한 번만 그린다 (줄 서 있는 동안엔 마지막 부탁으로 바뀐다)', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  let release;
  const gate = new Map([['그림 컷1-A', new Promise((res) => { release = res; })]]);
  const log = spy(r, { gate });
  const a = r.regenerate('drawing', 1, { id: 'A' });
  const b1 = r.regenerate('drawing', 1, { id: 'B', note: '첫 번째 부탁' });
  const a2 = r.regenerate('drawing', 1, { id: 'A', note: '그리는 중에 또 누름' }); // 이미 그리는 중 → 조용히 합친다
  const b2 = r.regenerate('drawing', 1, { id: 'B', note: '마지막 부탁' }); // 아직 시작 전 → 마지막 부탁으로
  assert.strictEqual(r.redrawQueue.length, 2, '일은 2개뿐');
  assert.strictEqual(r.snapshot().redrawing.length, 2);
  release();
  const [da, db1, da2, db2] = await Promise.all([a, b1, a2, b2]);
  assert.deepStrictEqual(log.order, ['그림 컷1-A', '그림 컷1-B'], '두 번 그리지 않았다');
  assert.strictEqual(da.redraws, 1);
  assert.strictEqual(da2.redraws, 1);
  assert.strictEqual(da.note, undefined, '그리는 중에 또 누른 부탁은 쓰지 않았다');
  assert.strictEqual(db1.note, '마지막 부탁');
  assert.strictEqual(db2.note, '마지막 부탁');
  assert.match(log.calls[1].prompt, /USER CHANGE REQUEST: 마지막 부탁/);
  assert.ok(!/첫 번째 부탁/.test(log.calls[1].prompt));
});

test('줄 서 있는 동안 run() · applyChanges() · 영상 만들기 시작은 쉬운 한국어로 거절, 끝나면 다시 된다', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  let release;
  const gate = new Map([['그림 컷1-A', new Promise((res) => { release = res; })]]);
  spy(r, { gate });
  const p = r.regenerate('drawing', 1, { id: 'A' });
  await tick();
  r.setCamera(1, 'pan_right'); // 반영할 것이 있어도
  assert.throws(() => r.applyChanges(), /^Error: 그림을 다시 그리는 중이에요\. 끝나면 다시 눌러 주세요\.$/);
  await assert.rejects(() => r.run(), /그림을 다시 그리는 중이에요\. 끝나면 다시 눌러 주세요\./);
  await assert.rejects(() => r.run({ from: 'render' }), /그림을 다시 그리는 중이에요/);
  assert.throws(() => r.assertRunnable(), /그림을 다시 그리는 중이에요/);
  assert.strictEqual(r.running, false, '거절당한 run 이 running 을 켜지 않았다');
  assert.strictEqual(r.p.status, 'done');
  assert.strictEqual(r.busy, true);
  release();
  await p;
  assert.strictEqual(r.busy, false);
  assert.doesNotThrow(() => r.assertRunnable());
  assert.strictEqual(r.snapshot().canApply, true, '다 그린 뒤엔 반영할 수 있다');
  assert.strictEqual(r.applyFrom(), 'render');
  assert.strictEqual(EC.MSG.redrawing, '그림을 다시 그리는 중이에요. 끝나면 다시 눌러 주세요.');
});

test('영상을 만드는 중(running)에는 그림을 다시 그릴 수 없다: 지금은 영상을 만드는 중이에요', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  r.running = true;
  await assert.rejects(() => r.regenerate('drawing', 1, { id: 'A' }), /^Error: 지금은 영상을 만드는 중이에요\. 끝난 뒤에 그림을 다시 그려 주세요\.$/);
  await assert.rejects(() => r.regenerateCut(2), /지금은 영상을 만드는 중이에요/);
  assert.deepStrictEqual(r.snapshot().redrawing, []);
  assert.throws(() => r.setCamera(1, 'pan_left'), /지금은 영상을 만드는 중이에요/);
  assert.throws(() => r.setTransition(1, 'fade'), /지금은 영상을 만드는 중이에요/);
  assert.throws(() => r.setFx(1, ['sparkle']), /지금은 영상을 만드는 중이에요/);
  r.running = false;
});

test('그림을 다시 그리는 중에도 카메라 · 시간 · 효과 · 전환 · 자막 · 다른 그림 되돌리기/바꾸기는 된다 (같은 그림만 막힌다)', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  // 먼저 B 를 한 번 다시 그려 두어야 되돌릴 것이 생긴다
  await r.regenerate('drawing', 1, { id: 'B' });
  let release;
  const gate = new Map([['그림 컷1-A', new Promise((res) => { release = res; })]]);
  spy(r, { gate });
  const p = r.regenerate('drawing', 1, { id: 'A' });
  await tick();
  assert.strictEqual(r.snapshot().redrawing[0].status, 'running');
  // 카메라 · 시간 · 효과 · 전환
  r.setCamera(2, 'truck_in');
  assert.strictEqual(r.shotOf(2).camera.move, 'truck_in');
  const tgt = r.p.xsheet.shots.find((s) => s.exposure.length > 1 && !s.motion);
  r.retime(tgt.shot, 0, tgt.exposure[0].frames + 6);
  r.setFx(3, ['fade_out']);
  const tr = r.setTransition(2, 'dissolve');
  assert.strictEqual(tr.type, 'dissolve');
  // 자막
  r.setSubtitleStyle({ preset: 'yellow' });
  assert.strictEqual(r.p.subsStale, true);
  r.saveSubtitles({ style: { position: 'top' } });
  // 다른 그림: 되돌리기 · 내 그림으로 바꾸기
  const back = await r.restoreVersion(1, 'B', 0);
  assert.strictEqual(back.status, 'done');
  const png = path.join(fx.root, 'mine.png');
  const px = new Uint8ClampedArray(320 * 180 * 4);
  for (let i = 0; i < px.length; i += 4) { px[i] = 200; px[i + 3] = i % 7 ? 255 : 0; }
  await K.writePng(png, px, 320, 180);
  const rep = await r.replaceItem('drawing', 3, png, 'A');
  assert.strictEqual(rep.custom, true);
  // 같은 그림은 막힌다
  await assert.rejects(() => r.restoreVersion(1, 'A', 0), /이 그림은 지금 다시 그리는 중이에요/);
  await assert.rejects(() => r.replaceItem('drawing', 1, png, 'A'), /이 그림은 지금 다시 그리는 중이에요\. 끝난 뒤에 해 주세요\./);
  // 장면 미리보기도 그 장면만 막힌다
  await assert.rejects(() => r.previewShot(1), /이 장면의 그림을 다시 그리는 중이에요/);
  assert.strictEqual(r.running, false);
  release();
  await p;
  // 고친 것이 모두 기록됐다
  assert.ok([1, 2, 3, tgt.shot].every((s) => r.p.dirtyShots.includes(s)), JSON.stringify(r.p.dirtyShots));
  const ch = r.snapshot().changes;
  assert.strictEqual(ch.subs, true);
  assert.strictEqual(ch.render, true);
});

test('stop() 은 대기열도 멈춘다: 그리던 것은 이전 그림 그대로, 기다리던 것은 없어진다, 기록에 찌꺼기가 없다', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  const first = r.itemOf(1, 'A');
  const before = bytes(fx, first.file);
  const cel = bytes(fx, first.cel);
  const histBefore = fs.existsSync(path.join(fx.dir, 'drawings', 'history')) ? fs.readdirSync(path.join(fx.dir, 'drawings', 'history')) : [];
  const never = new Promise(() => {});
  const gate = new Map([['그림 컷1-A', never]]);
  const log = spy(r, { gate });
  const events = [];
  r.on('update', (s) => events.push(s.redrawing.length));
  const p1 = r.regenerate('drawing', 1, { id: 'A', note: '멈출 요청' });
  const p2 = r.regenerate('drawing', 1, { id: 'B' });
  const p3 = r.regenerateCut(2);
  await tick();
  assert.strictEqual(r.snapshot().redrawing.length, 2 + 7);
  assert.strictEqual(first.status, 'running');
  r.stop();
  const [d1, d2, d3] = await Promise.all([p1, p2, p3]);
  assert.strictEqual(d1.cancelled, true);
  assert.strictEqual(d2.cancelled, true);
  assert.strictEqual(d3.cancelled, true);
  assert.deepStrictEqual(r.snapshot().redrawing, [], '대기열이 비었다');
  assert.strictEqual(r.redrawQueue.length, 0);
  assert.deepStrictEqual(log.order, ['그림 컷1-A'], '기다리던 것은 시작도 안 했다');
  assert.strictEqual(first.status, 'done', '이전 상태로');
  assert.strictEqual(first.error, null);
  assert.ok(bytes(fx, first.file).equals(before));
  assert.ok(bytes(fx, first.cel).equals(cel));
  assert.strictEqual(first.note, undefined);
  assert.strictEqual(first.custom, undefined);
  assert.ok(!first.history || first.history.length === 0);
  const histAfter = fs.existsSync(path.join(fx.dir, 'drawings', 'history')) ? fs.readdirSync(path.join(fx.dir, 'drawings', 'history')) : [];
  assert.deepStrictEqual(histAfter, histBefore);
  assert.ok(r.p.drawings.every((d) => d.status === 'done'));
  assert.ok(!r.p.dirtyShots || r.p.dirtyShots.length === 0, '멈춘 것은 고친 것이 아니다');
  assert.strictEqual(events[events.length - 1], 0);
  // 멈춘 뒤에도 새로 줄 설 수 있다
  gate.delete('그림 컷1-A');
  const again = await r.regenerate('drawing', 1, { id: 'A' });
  assert.strictEqual(again.status, 'done');
  assert.strictEqual(again.redraws, 1);
});

test('멈추는 중에 같은 그림을 또 부탁하면 멈춘 일에 합쳐지지 않고 새 일로 줄을 선다 (멈춘 일이 끝나기 전에는 영상 만들기도 시작하지 않는다)', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  const gate = new Map([['그림 컷1-A', new Promise(() => {})]]);
  const log = spy(r, { gate });
  const p1 = r.regenerate('drawing', 1, { id: 'A' });
  await tick();
  r.stop();
  assert.deepStrictEqual(r.snapshot().redrawing, [], '멈추는 즉시 화면에서는 빠진다');
  assert.throws(() => r.assertRunnable(), /그림을 다시 그리는 중이에요/, '이전 그림으로 되돌리는 일이 끝날 때까지는 영상 만들기를 시작하지 않는다');
  gate.delete('그림 컷1-A');
  const p2 = r.regenerate('drawing', 1, { id: 'A' });
  assert.deepStrictEqual(r.snapshot().redrawing, [{ shot: 1, id: 'A', status: 'queued' }]);
  const c = await p1;
  assert.strictEqual(c.cancelled, true);
  const d = await p2;
  assert.strictEqual(d.cancelled, undefined);
  assert.strictEqual(d.status, 'done');
  assert.strictEqual(d.redraws, 1);
  assert.deepStrictEqual(log.order, ['그림 컷1-A', '그림 컷1-A']);
  assert.deepStrictEqual(r.snapshot().redrawing, []);
  assert.doesNotThrow(() => r.assertRunnable());
});

test('앱이 꺼졌다 켜지면: 그리는 중이던 그림은 이전 상태로(파일 있으면 done, 없으면 pending), redrawing 은 비고, 프로젝트 상태는 그대로', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  // 다시 그리다가 꺼진 것처럼 project.json 을 만든다 (프로젝트는 'done' 인 채로)
  const p = fx.store.loadProject(fx.projectId);
  const a = p.drawings.find((d) => d.key === '1:A');
  const b = p.drawings.find((d) => d.key === '1:B');
  a.status = 'running';
  b.status = 'running';
  const missingFile = b.file;
  fs.unlinkSync(abs(fx, missingFile));
  fx.store.saveProject(p);
  const r = fx.runner();
  assert.strictEqual(r.itemOf(1, 'A').status, 'done');
  assert.strictEqual(r.itemOf(1, 'A').keyed, null, '배경 빼기를 다시 하도록 표시');
  assert.strictEqual(r.itemOf(1, 'B').status, 'pending');
  assert.strictEqual(r.itemOf(1, 'B').file, null);
  assert.strictEqual(r.p.status, 'done', '프로젝트 상태는 건드리지 않는다');
  assert.deepStrictEqual(r.snapshot().redrawing, []);
  assert.strictEqual(r.running, false);
  assert.strictEqual(fx.store.loadProject(fx.projectId).drawings.find((d) => d.key === '1:A').status, 'done', '저장도 됐다');
  // 영상 만들기 도중에 꺼진 경우(running)도 같다
  const p2 = fx.store.loadProject(fx.projectId);
  p2.status = 'running';
  p2.steps.drawings.status = 'running';
  p2.drawings.find((d) => d.key === '2:A').status = 'running';
  fx.store.saveProject(p2);
  const r2 = fx.runner();
  assert.strictEqual(r2.p.status, 'stopped');
  assert.strictEqual(r2.itemOf(2, 'A').status, 'done');
  // 그 셀은 다음 렌더링 때 다시 배경이 빠진다
  const n = await r2.ensureCelsProcessed();
  assert.ok(n >= 1);
  assert.strictEqual(r2.itemOf(2, 'A').keyed, true);
});

test('컷 전부 다시 그리기: 일 하나로 돌고 배경 → 열쇠 그림 차례로, 앞 그림을 고쳐서 다음 그림을 그린다. 장면 그림마다 redrawing 에 보인다', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  const log = spy(r);
  const shot2 = r.shotOf(2);
  assert.ok(shot2.motion && shot2.drawings.length === 6);
  const olds = Object.fromEntries(['bg', ...shot2.drawings.map((d) => d.id)].map((id) => [id, bytes(fx, r.itemOf(2, id).file)]));
  const lens = [];
  r.on('update', (s) => lens.push(s.redrawing.map((x) => `${x.id}:${x.status}`).join(',')));
  const p = r.regenerateCut(2);
  assert.strictEqual(r.redrawQueue.length, 1, '일 하나');
  assert.deepStrictEqual(r.snapshot().redrawing.map((x) => x.id), ['bg', 'A', 'B', 'C', 'D', 'E', 'F']);
  assert.strictEqual(r.snapshot().redrawing[0].status, 'running');
  assert.ok(r.snapshot().redrawing.slice(1).every((x) => x.status === 'queued'));
  const res = await p;
  assert.strictEqual(res.shot, 2);
  assert.deepStrictEqual(res.drawings.map((d) => d.id), ['bg', 'A', 'B', 'C', 'D', 'E', 'F']);
  assert.deepStrictEqual(log.order, ['배경 컷2', '그림 컷2-A', '그림 컷2-B', '그림 컷2-C', '그림 컷2-D', '그림 컷2-E', '그림 컷2-F'], '차례대로');
  for (const d of res.drawings) {
    assert.strictEqual(d.status, 'done');
    assert.strictEqual(d.history.length, 1, `${d.id}: 옛 그림이 이전 그림으로`);
    assert.ok(bytes(fx, d.history[0].file).equals(olds[d.id]), `${d.id}: 이전 그림 = 옛 그림`);
    assert.ok(!bytes(fx, d.file).equals(olds[d.id]), `${d.id}: 새 그림은 다르다`);
    assert.strictEqual(d.note, undefined);
  }
  // 이어짐: B 는 새로 그린 A 의 셀(배경 뺀 판)을 고쳐서 그린다
  const cB = log.calls[2];
  assert.strictEqual(cB.refs[0], abs(fx, r.itemOf(2, 'A').plate));
  assert.match(cB.refNotes[0], /EDIT this image/);
  assert.ok(/EDIT MODE/.test(cB.prompt));
  assert.strictEqual(log.calls[0].refs.length, 0, '배경은 기준 그림 없음');
  assert.ok(!log.calls[1].prompt.startsWith('EDIT MODE'), '첫 열쇠 그림은 새로 그린다');
  // 진행: 줄어들며 끝난다
  assert.strictEqual(lens[lens.length - 1], '');
  assert.ok(lens.some((x) => x === 'D:running,E:queued,F:queued'));
  assert.deepStrictEqual(r.p.dirtyShots, [2]);
  // 같은 장면을 줄 서 있는 동안 또 누르면 조용히 합친다
  const p1 = r.regenerateCut(2);
  const p2 = r.regenerateCut(2);
  await Promise.all([p1, p2]);
  assert.strictEqual(r.itemOf(2, 'A').redraws, 2, '두 번 눌렀지만 한 번만');
  await assert.rejects(() => r.regenerateCut(9), /장면을 찾을 수 없어요/);
});

test('컷 전부 다시 그리기 도중 한 장이 실패하면: 거기서 멈추고, 앞에서 그린 그림은 새 그림으로, 못 그린 그림은 이전 그림 그대로', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  const orig = r.genImage.bind(r);
  r.genImage = async (args, tag, ctl) => {
    if (args.title === '그림 컷2-C') throw new Error('network down');
    return orig(args, tag, ctl);
  };
  const oldC = bytes(fx, r.itemOf(2, 'C').file);
  await assert.rejects(() => r.regenerateCut(2), /컷 2 그림 전부 다시 그리기가 그림 C에서 멈췄어요\. 앞에서 그린 그림은 새 그림으로 바뀌었어요\. 그림을 다시 그리지 못했어요/);
  assert.strictEqual(r.itemOf(2, 'A').redraws, 1);
  assert.strictEqual(r.itemOf(2, 'B').redraws, 1);
  assert.strictEqual(r.itemOf(2, 'C').redraws, undefined);
  assert.ok(bytes(fx, r.itemOf(2, 'C').file).equals(oldC));
  assert.strictEqual(r.itemOf(2, 'D').redraws, undefined, '뒤 그림은 시작도 안 했다');
  assert.deepStrictEqual(r.snapshot().redrawing, []);
  assert.match(r.itemOf(2, 'C').error, /그림을 다시 그리지 못했어요/);
  assert.deepStrictEqual(r.p.dirtyShots, [2], '새로 바뀐 그림이 있으니 고친 장면');
});

test('낱장 그리기는 자기만의 중지 신호를 쓴다: 영상 만들기(this.abort)를 만들지도 덮어쓰지도 않는다', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  assert.strictEqual(r.abort, null);
  const log = spy(r);
  const sentinel = new AbortController();
  r.abort = sentinel; // 영상 만들기가 쓰는 신호가 있다고 치자
  let seen = null;
  const orig = r.genImage;
  r.genImage = async (args, tag, ctl) => { seen = ctl; return orig(args, tag, ctl); };
  await r.regenerate('drawing', 1, { id: 'A' });
  assert.strictEqual(r.abort, sentinel, '건드리지 않았다');
  assert.ok(seen && seen !== sentinel && !sentinel.signal.aborted);
  assert.ok(log.order.length === 1);
  // stop() 은 영상 만들기 신호도 멈추고 대기열도 멈춘다 (둘이 따로)
  r.stop();
  assert.strictEqual(sentinel.signal.aborted, true);
});

test('도우미(직접 만들어 넣기) 모드: 다시 그리기도 기다리는 카드를 띄우고, 파일을 넣으면 이어지고, 건너뛰면 이전 그림 그대로, 중지하면 기다림이 풀린다', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  r.p.providers = { ...r.p.providers, image: 'helper' };
  const it = r.itemOf(1, 'A');
  const before = bytes(fx, it.file);
  // 1) 파일을 넣어 준다
  const mine = path.join(fx.root, 'from-site.png');
  const px = new Uint8ClampedArray(640 * 360 * 4);
  for (let i = 0; i < px.length; i += 4) { px[i] = 0; px[i + 1] = 255; px[i + 2] = 0; px[i + 3] = 255; }
  for (let y = 80; y < 300; y++) for (let x = 250; x < 400; x++) { const o = (y * 640 + x) * 4; px[o] = 200; px[o + 1] = 40; px[o + 2] = 40; }
  await K.writePng(mine, px, 640, 360);
  const p1 = r.regenerate('drawing', 1, { id: 'A', note: '손을 흔들며' });
  await tick(50);
  assert.ok(r.p.waiting && r.p.waiting.key === 'image:1:A' && r.p.waiting.kind === 'image', JSON.stringify(r.p.waiting && r.p.waiting.key));
  assert.match(r.p.waiting.copyText, /USER CHANGE REQUEST: 손을 흔들며/);
  assert.strictEqual(r.running, false);
  assert.strictEqual(r.provideFile('image:1:A', mine), true);
  const d = await p1;
  assert.strictEqual(d.status, 'done');
  assert.ok(!bytes(fx, d.file).equals(before));
  assert.strictEqual(r.p.waiting, null, '기다림이 끝났다');
  assert.strictEqual(d.history.length, 1);
  // 2) 건너뛰기: 아무것도 바뀌지 않는다
  const cur = bytes(fx, d.file);
  const p2 = r.regenerate('drawing', 1, { id: 'A' });
  await tick(50);
  assert.ok(r.p.waiting && r.p.waiting.key === 'image:1:A');
  assert.strictEqual(r.skipWaiting('image:1:A'), true);
  const s = await p2;
  assert.strictEqual(s.skipped, true);
  assert.ok(bytes(fx, s.file).equals(cur));
  assert.strictEqual(s.history.length, 1, '건너뛴 것은 기록에 남기지 않는다');
  assert.strictEqual(r.itemOf(1, 'A').redraws, 1);
  // 3) 기다리는 중 중지
  const p3 = r.regenerate('drawing', 1, { id: 'A' });
  await tick(50);
  assert.ok(r.p.waiting);
  r.stop();
  const c = await p3;
  assert.strictEqual(c.cancelled, true);
  assert.ok(bytes(fx, c.file).equals(cur));
  assert.strictEqual(r.p.waiting, null);
  assert.deepStrictEqual(r.snapshot().redrawing, []);
});
