// 가사 자막 스튜디오의 줄 계산(substudio-core.js) 단위 시험 — 브라우저 없이. PC 앱 substudio 의 줄 계산과 같은 규칙을 지키는지 본다.
import test from 'node:test';
import assert from 'node:assert';
import * as C from '../src/screens/substudio-core.js';

const mk = (rows) => C.recompute(rows.map(([text, start, extra]) => C.mkLine({ text, start, ...(extra || {}) }, true)), 30);

test('recompute: 시간 순 · 끝은 다음 줄 직전 · 끝을 정한 줄은 그 끝을 지킨다', () => {
  const ls = mk([['b', 6], ['a', 1], ['c', 12, { end: 14, endLocked: true }]]);
  assert.deepStrictEqual(ls.map((l) => l.text), ['a', 'b', 'c']);
  assert.ok(Math.abs(ls[0].end - 5.95) < 1e-9 && Math.abs(ls[1].end - 11.95) < 1e-9);
  assert.strictEqual(ls[2].end, 14);
  assert.ok(ls[1].end - ls[1].start <= C.MAX_HOLD + 1e-9, '끝을 안 정한 줄은 7초까지만');
});

test('setStart · nudgeEnd · shiftAll: 경계 안에서만 움직인다', () => {
  const ls = mk([['a', 1], ['b', 5], ['c', 9]]);
  C.setStart(ls, 1, 100, 30);
  assert.ok(ls[1].start <= ls[2].start - C.MIN_GAP + 1e-9, '다음 줄을 넘지 않는다');
  C.setStart(ls, 1, -5, 30);
  assert.ok(ls[1].start >= ls[0].start + C.MIN_GAP - 1e-9, '앞 줄 앞으로 못 간다');
  assert.ok(ls[1]._tapped, '직접 맞춘 것으로 표시');
  const t = mk([['a', 1], ['b', 5]]);
  const moved = C.nudgeEnd(t, 0, -0.1, 30);
  assert.ok(Math.abs(moved + 0.1) < 1e-6 && t[0].endLocked, '끝 −0.1초는 정한 끝이 된다');
  assert.strictEqual(C.nudgeEnd(mk([['a', 1], ['b', 2]]), 0, 0.5, 30), 0, '다음 줄 직전에서는 더 늘릴 수 없다');
  const k = C.shiftAll(ls, -50, 30);
  assert.ok(Math.abs(ls[0].start) < 1e-9 && k < 0, '맨 앞은 0 아래로 안 간다');
});

test('splitLine · mergeNext · addLine: 줄 수와 시간이 맞게 바뀐다', () => {
  const ls = mk([['별빛이 쏟아지는 밤하늘', 2], ['하', 8]]);
  const b = C.splitLine(ls, 0, 4, 30);
  assert.deepStrictEqual(ls.map((l) => l.text), ['별빛이', '쏟아지는 밤하늘', '하']);
  assert.ok(b.start > ls[0].start && b.start < ls[2].start, '뒤쪽 줄의 시작은 두 시간 사이');
  const back = C.mergeNext(ls, 0, 30);
  assert.strictEqual(back.text, '별빛이 쏟아지는 밤하늘');
  assert.strictEqual(ls.length, 2);
  assert.strictEqual(C.splitLine(ls, 1, 0, 30), null, '한 글자는 나눌 수 없다');
  const nl = C.addLine(ls, 0, 5, 30);
  assert.strictEqual(ls.length, 3);
  assert.ok(nl._new && nl.text === '' && nl.start > ls[0].start && nl.start < ls[2].start);
});

test('lineWarnings · sig · save 줄: 막지 않는 경고 · 바뀜 검사 · 보낼 모양', () => {
  const long = C.mkLine({ text: '가'.repeat(20), start: 0, end: 1.5 }, false);
  assert.ok(C.lineWarnings(long).some((w) => /16자/.test(w)) && C.lineWarnings(long).some((w) => /빨리/.test(w)));
  assert.deepStrictEqual(C.lineWarnings(C.mkLine({ text: '짧음', start: 0, end: 0.4 })), ['0.8초보다 짧아요']);
  assert.deepStrictEqual(C.lineWarnings(C.mkLine({ text: '숨김', start: 0, end: 0.1, hidden: true })), []);
  const a = mk([['a', 1], ['b', 5]]);
  const sig = C.sigLines(a);
  a[0].text = 'a2';
  assert.notStrictEqual(C.sigLines(a), sig);
  a[0].text = 'a';
  assert.strictEqual(C.sigLines(a), sig, '글을 되돌리면 바뀐 게 없다');
  assert.deepStrictEqual(C.toSaveLine(C.mkLine({ text: 'x', start: 1.234, end: 3, endLocked: true }, true)), { text: 'x', start: 1.23, hidden: false, end: 3, endLocked: true });
  assert.deepStrictEqual(C.toSaveLine(C.mkLine({ text: 'x', start: 1 }, true)), { text: 'x', start: 1, hidden: false }, '끝을 안 정했으면 끝을 보내지 않는다');
});

test('mergeTap · autoOutline · fitRect', () => {
  const ls = mk([['a', 1], ['b', 5], ['c', 9]]);
  C.mergeTap(ls, [ls[0], ls[2]], [{ start: 2, end: 4 }, { start: 10, end: 12 }], [true, false], 30);
  assert.deepStrictEqual([ls[0].start, ls[2].start, ls[0]._tapped, ls[2]._tapped], [2, 10, true, true], '두 번째는 원래도 맞춘 줄이라 true 가 남는다');
  assert.strictEqual(C.autoOutline('#ffffff'), '#000000');
  assert.strictEqual(C.autoOutline('#111111'), '#ffffff');
  const f = C.fitRect(400, 300, 16, 9);
  assert.ok(Math.abs(f.w - 400) < 1e-9 && Math.abs(f.h - 225) < 1e-9 && Math.abs(f.y - 37.5) < 1e-9);
});
