'use strict';
// 가사 시간 맞추기 계산: 맞추기·취소·한 줄 고치기·전체 옮기기·확인하기의 지금 줄·저장 결과
const test = require('node:test');
const assert = require('node:assert');
const LS = require('../src/renderer/js/lyricsync');

const LINES = [
  { text: '별빛이 내리는 밤', start: 10, end: 14, part: 1, section: 'Verse 1', sectionStart: true },
  { text: '편지를 들고 달려', start: 14, end: 18, part: 1, section: 'Verse 1', sectionStart: false },
  { text: '하늘 높이 날아올라', start: 30, end: 34, part: 1, section: 'Chorus', sectionStart: true },
  { text: '너에게 닿을 때까지', start: 34, end: 38, part: 1, section: 'Chorus', sectionStart: false },
];

test('처음 상태: 자동 추정이면 1번 줄부터 맞추기, 이미 맞춘 시간이면 모두 ✔', () => {
  const a = LS.create(LINES, 60);
  assert.strictEqual(a.idx, 0);
  assert.strictEqual(LS.untapped(a), 4);
  const b = LS.create(LINES, 60, { confirmed: true });
  assert.strictEqual(b.idx, 4);
  assert.strictEqual(LS.untapped(b), 0);
  // 순서가 꼬인 시간은 앞 줄보다 뒤로 정리
  const c = LS.create([{ text: 'a', start: 5 }, { text: 'b', start: 3 }], 60);
  assert.ok(c.marks[1] >= c.marks[0] + LS.MIN_GAP);
});

test('누른 시간은 반응 시간만큼 앞당기고, 느리게 들으면 그만큼 덜 당긴다', () => {
  assert.strictEqual(LS.tapTime(10, 1), 10 - LS.REACTION);
  assert.strictEqual(LS.tapTime(10, 0.5), 10 - LS.REACTION * 0.5);
  assert.strictEqual(LS.tapTime(0.05, 1), 0);
});

test('맞추기: 차례로 누르면 다음 줄로, 뒤 줄이 더 앞에 있으면 함께 밀린다, 다 하면 -1', () => {
  const s = LS.create(LINES, 60);
  assert.strictEqual(LS.tap(s, 9.5), 0);
  assert.strictEqual(LS.tap(s, 20), 1); // 예상(14초)보다 늦게
  assert.strictEqual(s.idx, 2);
  // 3번 줄을 아주 늦게 → 4번 줄(34초)이 밀려서 순서 유지
  LS.tap(s, 40);
  assert.ok(s.marks[3] >= 40 + LS.MIN_GAP);
  LS.tap(s, 45);
  assert.strictEqual(LS.tap(s, 50), -1);
  assert.strictEqual(LS.untapped(s), 0);
  // 앞 줄보다 먼저 누를 수는 없다
  const t = LS.create(LINES, 60);
  LS.tap(t, 12);
  LS.tap(t, 5);
  assert.ok(t.marks[1] >= 12 + LS.MIN_GAP);
});

test('방금 것 취소: 맞추기·고치기·전체 옮기기를 차례로 되돌린다', () => {
  const s = LS.create(LINES, 60);
  LS.tap(s, 9.5);
  LS.tap(s, 13);
  LS.nudge(s, 0, 0.1);
  LS.shiftAll(s, -0.5);
  assert.ok(LS.undo(s));
  assert.ok(Math.abs(s.marks[0] - 9.6) < 1e-9);
  assert.ok(LS.undo(s));
  assert.ok(Math.abs(s.marks[0] - 9.5) < 1e-9);
  assert.ok(LS.undo(s));
  assert.strictEqual(s.idx, 1);
  assert.strictEqual(s.tapped[1], false);
  assert.strictEqual(s.marks[1], 14);
  assert.ok(LS.undo(s));
  assert.strictEqual(s.idx, 0);
  assert.strictEqual(LS.undo(s), false);
});

test('한 줄 고치기: 0.1초씩, 앞뒤 줄을 넘지 않고, 고친 줄은 ✔', () => {
  const s = LS.create(LINES, 60);
  assert.ok(Math.abs(LS.nudge(s, 2, -0.1) + 0.1) < 1e-9);
  assert.strictEqual(s.tapped[2], true);
  assert.strictEqual(s.tapped[1], false);
  for (let k = 0; k < 300; k++) LS.nudge(s, 1, 0.1);
  assert.ok(Math.abs(s.marks[1] - (s.marks[2] - LS.MIN_GAP)) < 1e-9, 'stops before the next line');
  for (let k = 0; k < 300; k++) LS.nudge(s, 0, -0.1);
  assert.strictEqual(s.marks[0], 0);
  for (let k = 0; k < 300; k++) LS.nudge(s, 3, 0.1);
  assert.ok(s.marks[3] <= 60 - 0.3 + 1e-9, 'last line stays inside the song');
});

test('전체 옮기기: 모든 줄이 함께, 노래 앞뒤를 넘지 않는다', () => {
  const s = LS.create(LINES, 40);
  LS.shiftAll(s, 0.4);
  assert.deepStrictEqual(s.marks.map((m) => Math.round(m * 10) / 10), [10.4, 14.4, 30.4, 34.4]);
  assert.ok(Math.abs(LS.shiftAll(s, -100) + 10.4) < 1e-9);
  assert.strictEqual(s.marks[0], 0);
  LS.shiftAll(s, 100);
  assert.ok(Math.abs(s.marks[3] - (40 - 0.3)) < 1e-9);
});

test('다시 맞출 때 듣기 시작 위치: 맞춘 줄은 2.5초 전, 예상인 줄은 앞 줄 시작부터', () => {
  const s = LS.create(LINES, 60);
  assert.strictEqual(LS.leadIn(s, 0), 0);
  assert.strictEqual(LS.leadIn(s, 2), 14);
  LS.nudge(s, 2, 0);
  assert.strictEqual(LS.leadIn(s, 2), 27.5);
  assert.strictEqual(LS.leadIn(s, 99), 0);
});

test('확인하기: 지금 떠 있는 줄 (간주에는 없음), 저장 결과는 시간 순서·끝 시간 포함', () => {
  const s = LS.create(LINES, 60, { confirmed: true });
  const e = LS.ends(s);
  assert.deepStrictEqual(e.map((x) => Math.round(x * 100) / 100), [13.95, 21, 33.95, 41]);
  assert.strictEqual(LS.activeAt(s, 5), -1);
  assert.strictEqual(LS.activeAt(s, 10), 0);
  assert.strictEqual(LS.activeAt(s, 16.9), 1);
  assert.strictEqual(LS.activeAt(s, 25), -1, 'gap between verse and chorus (7 s max per line)');
  assert.strictEqual(LS.activeAt(s, 35), 3);
  assert.strictEqual(LS.activeAt(s, 50), -1);
  assert.strictEqual(LS.activeAt(s, 13.97), -1, '0.05 s gap before the next line');
  assert.strictEqual(LS.activeAt(s, 13.97, e, 0.1), 0, 'preview holds the line across tiny gaps');
  const out = LS.result(s, LINES);
  assert.deepStrictEqual(Object.keys(out[0]).sort(), ['end', 'part', 'section', 'sectionStart', 'start', 'text']);
  for (let i = 0; i < out.length; i++) {
    assert.ok(out[i].end > out[i].start);
    if (i) assert.ok(out[i].start > out[i - 1].start);
  }
  assert.strictEqual(LS.fmt(65.04), '1:05.0');
  assert.strictEqual(LS.fmt(59.96), '1:00.0');
});
