'use strict';
// 가사 자막 스튜디오(substudio.js)의 줄 계산: 화면 없이 부를 수 있는 순수 함수들 (나누기 · 합치기 · 시간 옮기기 · 경고 · 저장 모양)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', 'src');
const SubsCore = require('../src/main/pipeline/subs-core');

/** 브라우저 파일을 <script> 로 읽은 것처럼 불러온다 (window.AM 만 있으면 된다) */
function loadStudio() {
  const window = { AM: {} };
  window.AMSubtitleStyle = require('../src/shared/subtitle-style');
  window.AMSubtitleRender = require('../src/shared/subtitle-render');
  const ctx = vm.createContext({ window, console });
  for (const f of ['renderer/js/ui.js', 'renderer/js/substudio.js']) vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
  return window.AM.substudio.util;
}
const U = loadStudio();
const L = (text, start, extra = {}) => U.mkLine({ text, start, end: start + 2, ...extra }, false);
const W = (l, lay) => [...U.lineWarnings(l, lay)]; // 다른 영역에서 만든 배열은 비교 전에 복사
const set = (...rows) => U.recompute(rows.map(([t, s, x]) => L(t, s, x)), 60);

test('끝 시간: 백엔드가 줄을 정리할 때와 똑같이 정해서 미리 본 대로 영상에 나온다', () => {
  const rows = [['가', 1], ['나', 4], ['다', 4.2], ['라', 12], ['마', 30], ['바', 58.5]];
  const mine = U.recompute(rows.map(([t, s]) => L(t, s)), 60);
  // 끝을 따로 안 정한 줄은 start 만 보낸다 → 백엔드가 같은 규칙으로 끝을 정한다
  const sent = mine.map(U.toSaveLine);
  assert.ok(sent.every((l) => !('end' in l)));
  const back = SubsCore.cleanLyricLines(sent, { duration: 60 });
  assert.strictEqual(back.length, mine.length);
  back.forEach((b, i) => assert.ok(Math.abs(b.end - mine[i].end) <= 0.011, `line ${i}: ${b.end} vs ${mine[i].end}`));
  // 끝을 정한 줄(endLocked)은 그 끝을 보내고 다음 줄 직전을 넘지 않는다
  const locked = set(['가', 1], ['나', 5]);
  locked[0].endLocked = true;
  locked[0].end = 9;
  U.recompute(locked, 60);
  assert.ok(Math.abs(locked[0].end - 4.95) < 1e-9);
  const sent2 = locked.map(U.toSaveLine);
  assert.strictEqual(sent2[0].endLocked, true);
  assert.ok(!('end' in sent2[1]));
  const back2 = SubsCore.cleanLyricLines(sent2, { duration: 60 });
  assert.ok(Math.abs(back2[0].end - locked[0].end) <= 0.011);
});

test('줄 정렬 · 서명: 열쇠나 맞춘 표시가 달라도 같고, 글·시간·숨김·정한 끝이 달라지면 달라진다', () => {
  const a = set(['가', 1], ['나', 5]);
  const b = a.map((l) => ({ ...l, _k: `x${l._k}`, _tapped: true }));
  assert.strictEqual(U.sigLines(a), U.sigLines(b));
  const c = a.map((l) => ({ ...l }));
  c[1].hidden = true;
  assert.notStrictEqual(U.sigLines(a), U.sigLines(c));
  const d = a.map((l) => ({ ...l }));
  d[0].start = 1.2;
  assert.notStrictEqual(U.sigLines(a), U.sigLines(d));
  const e = [...a.map((l) => ({ ...l })), L('  ', 9)]; // 빈 줄은 저장 때 버려지니 같은 것으로 본다
  assert.strictEqual(U.sigLines(a), U.sigLines(e));
  assert.deepStrictEqual(U.realLines(e).map((l) => l.text), ['가', '나']);
});

test('시작 옮기기: 앞뒤 줄 사이를 넘지 않고, 맞춘 시간으로 바뀐다', () => {
  const rows = set(['가', 2], ['나', 6], ['다', 10]);
  assert.ok(Math.abs(U.setStart(rows, 1, 6.1, 60) - 0.1) < 1e-9);
  assert.strictEqual(rows[1].start, 6.1);
  assert.strictEqual(rows[1]._tapped, true);
  assert.strictEqual(rows[0]._tapped, false);
  U.setStart(rows, 1, 99, 60); // 뒤 줄 앞에서 멈춘다
  assert.ok(Math.abs(rows[1].start - (10 - 0.2)) < 1e-9);
  U.setStart(rows, 1, -5, 60); // 앞 줄 뒤에서 멈춘다
  assert.ok(Math.abs(rows[1].start - 2.2) < 1e-9);
  const last = U.setStart(rows, 2, 999, 60); // 맨 뒤 줄은 노래 끝 전
  assert.ok(rows[2].start <= 60 - 0.3 + 1e-9);
  assert.ok(last > 0);
  U.setStart(rows, 0, -3, 60);
  assert.strictEqual(rows[0].start, 0);
});

test('끝 옮기기: 끝을 사람이 정한 것으로 표시하고, 시작보다 앞·다음 줄 뒤로는 못 간다', () => {
  const rows = set(['가', 2], ['나', 20]);
  const before = rows[0].end; // 자동: 시작 + 7초
  U.nudgeEnd(rows, 0, 0.5, 60);
  assert.strictEqual(rows[0].endLocked, true);
  assert.ok(Math.abs(rows[0].end - (before + 0.5)) < 1e-9);
  U.nudgeEnd(rows, 0, 50, 60);
  assert.ok(Math.abs(rows[0].end - 19.95) < 1e-9, 'stops just before the next line');
  U.nudgeEnd(rows, 0, -50, 60);
  assert.ok(Math.abs(rows[0].end - 2.2) < 1e-9, 'at least 0.2 s long');
});

test('모두 옮기기: 함께 움직이고 맨 앞은 0 아래로, 맨 뒤는 노래 밖으로 못 나간다', () => {
  const rows = set(['가', 2], ['나', 6], ['다', 57]);
  assert.ok(Math.abs(U.shiftAll(rows, -0.1, 60) + 0.1) < 1e-9);
  assert.deepStrictEqual(rows.map((l) => l.start), [1.9, 5.9, 56.9]);
  assert.ok(Math.abs(U.shiftAll(rows, -50, 60) + 1.9) < 1e-9);
  assert.strictEqual(rows[0].start, 0);
  U.shiftAll(rows, 100, 60);
  assert.ok(Math.abs(rows[2].start - 59.7) < 1e-9);
  assert.strictEqual(U.shiftAll([], 1, 60), 0);
});

test('나누기: 캐럿 자리에서 둘로, 뒤 줄 시작은 두 시간 사이 · 캐럿이 끝이면 가운데 띄어쓰기 · 나눌 수 없으면 null', () => {
  const rows = set(['함께라면 두렵지 않아', 10], ['우리의 노래가 돼', 20]);
  rows[0].end = 14;
  const b = U.splitLine(rows, 0, 5, 60); // '함께라면' | '두렵지 않아'
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].text, '함께라면');
  assert.strictEqual(b.text, '두렵지 않아');
  assert.ok(b.start > rows[0].start && b.start < 20);
  assert.strictEqual(rows[0].endLocked, false);
  assert.strictEqual(rows[1], b);
  assert.notStrictEqual(rows[0]._k, b._k);
  assert.ok(rows[0].end < b.start, 'first half ends before the second starts');
  const r2 = set(['하나 둘 셋 넷', 3]);
  const c = U.splitLine(r2, 0, 0, 60); // 캐럿이 맨 앞 → 가운데에서 가장 가까운 띄어쓰기
  assert.ok(c && r2[0].text.length > 0 && c.text.length > 0);
  assert.strictEqual(`${r2[0].text} ${c.text}`, '하나 둘 셋 넷');
  assert.strictEqual(U.splitLine(set(['하나', 3]), 0, 1, 60) && 1, 1, 'two syllables split in the middle');
  assert.strictEqual(U.splitLine(set(['한']), 0, 1, 60), null);
  assert.strictEqual(U.splitLine([], 0, 1, 60), null);
});

test('합치기: 글을 이어 붙이고 끝은 아래 줄의 끝, 둘 다 숨김일 때만 숨김, 맞춘 표시는 하나라도 있으면 유지', () => {
  const rows = set(['가나', 3, { hidden: true }], ['다라', 6, { hidden: true }], ['마', 9]);
  rows[1]._tapped = true;
  const a = U.mergeNext(rows, 0, 60);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(a.text, '가나 다라');
  assert.strictEqual(a.hidden, true);
  assert.strictEqual(a._tapped, true);
  const b = U.mergeNext(rows, 0, 60);
  assert.strictEqual(b.text, '가나 다라 마');
  assert.strictEqual(b.hidden, false);
  assert.strictEqual(U.mergeNext(rows, 0, 60), null, 'last line has no line below');
});

test('줄 추가: 재생 위치가 두 줄 사이면 거기, 아니면 앞 줄이 끝난 바로 뒤, 맨 뒤에도 넣을 수 있다', () => {
  const rows = set(['가', 2], ['나', 20]);
  const a = U.addLine(rows, 0, 8, 60);
  assert.strictEqual(a.start, 8);
  assert.strictEqual(a.text, '');
  assert.deepStrictEqual(rows.map((l) => l.text), ['가', '', '나']);
  const rows2 = set(['가', 2], ['나', 20]);
  const b = U.addLine(rows2, 0, 40, 60); // 재생 위치가 칸 밖 → 앞 줄이 끝난 직후
  assert.ok(Math.abs(b.start - (rows2[0].end + 0.1)) < 1e-6 || b.start > rows2[0].start);
  assert.ok(b.start < 20 && b.start > 2);
  const rows3 = set(['가', 2]);
  const c = U.addLine(rows3, -1, 30, 60);
  assert.strictEqual(rows3.length, 2);
  assert.strictEqual(rows3[1], c);
  assert.strictEqual(c.start, 30);
  const empty = [];
  const d = U.addLine(empty, -1, 0, 60);
  assert.strictEqual(empty.length, 1);
  assert.ok(d.start >= 0);
});

test('찾아 바꾸기: 바뀐 줄 수를 돌려준다', () => {
  const rows = set(['하늘을 날아', 1], ['하늘 높이', 5], ['바다', 9]);
  assert.strictEqual(U.replaceAll(rows, '하늘', '구름'), 2);
  assert.deepStrictEqual(rows.map((l) => l.text), ['구름을 날아', '구름 높이', '바다']);
  assert.strictEqual(U.replaceAll(rows, '', 'x'), 0);
  assert.strictEqual(U.replaceAll(rows, '없는글', 'x'), 0);
});

test('탭으로 맞춘 결과 섞기: 시작은 새 값, 끝을 정한 줄은 그 끝을 지키고, 숨긴 줄은 그대로', () => {
  const rows = set(['가', 2], ['나', 6, { hidden: true }], ['다', 10], ['라', 14]);
  rows[2].endLocked = true;
  rows[2].end = 12;
  const shown = [rows[0], rows[2], rows[3]];
  const result = [{ start: 2.5, end: 5 }, { start: 10.4, end: 13 }, { start: 14.3, end: 20 }];
  U.mergeTap(rows, shown, result, [true, false, true], 60);
  assert.strictEqual(rows[0].start, 2.5);
  assert.strictEqual(rows[0]._tapped, true);
  assert.strictEqual(rows[1].start, 6, 'hidden line keeps its time');
  assert.strictEqual(rows[2].start, 10.4);
  assert.strictEqual(rows[2].end, 12, 'locked end kept');
  assert.strictEqual(rows[2]._tapped, false);
  assert.strictEqual(rows[3]._tapped, true);
});

test('경고: 16자 · 3줄 · 0.8초보다 짧음 · 7초보다 긺 · 너무 빠름, 숨긴 줄은 경고 없음', () => {
  const ok = L('짧은 글', 0);
  ok.end = 3;
  assert.deepStrictEqual(W(ok, { lineCount: 1 }), []);
  const long = L('가나다라마바사아자차카타파하가나다', 0);
  long.end = 6;
  assert.ok(W(long, { lineCount: 2 }).some((w) => /16자/.test(w)));
  const forced = L('가나다라마바사아\n자차카타파하가나', 0);
  forced.end = 6;
  assert.ok(!W(forced, { lineCount: 2 }).some((w) => /16자/.test(w)), 'forced breaks split the segments');
  assert.ok(W(ok, { lineCount: 3 }).includes('3줄이 돼요'));
  const quick = L('아주 짧아요', 0);
  quick.end = 0.5;
  assert.ok(W(quick, { lineCount: 1 }).includes('0.8초보다 짧아요'));
  const slow = L('느린 줄', 0);
  slow.end = 9;
  slow.endLocked = true;
  assert.ok(W(slow, { lineCount: 1 }).includes('7초보다 길어요'));
  const fast = L('가나다라마바사아자차카타', 0);
  fast.end = 1.2; // 12자 / 1.2초 = 10자/초
  assert.ok(W(fast, { lineCount: 1 }).includes('너무 빨리 지나가요'));
  const hid = L('가나다라마바사아자차카타파하가나다', 0);
  hid.end = 0.3;
  hid.hidden = true;
  assert.deepStrictEqual(W(hid, { lineCount: 3 }), []);
  assert.deepStrictEqual(W(L('   ', 0), null), []);
});

test('도우미: 테두리 자동 색, 영상 자리, 시간 글자', () => {
  assert.strictEqual(U.autoOutline('#ffffff'), '#000000');
  assert.strictEqual(U.autoOutline('#ffe14d'), '#000000');
  assert.strictEqual(U.autoOutline('#111111'), '#ffffff');
  assert.strictEqual(U.autoOutline('nope'), '#000000');
  const r = U.fitRect(400, 400, 1280, 720);
  assert.ok(Math.abs(r.w - 400) < 1e-9 && Math.abs(r.h - 225) < 1e-9 && Math.abs(r.y - 87.5) < 1e-9 && r.x === 0);
  assert.deepStrictEqual({ ...U.fitRect(300, 200, 0, 0) }, { x: 0, y: 0, w: 300, h: 200 });
  assert.strictEqual(U.fmtClock(65.9), '1:05');
  assert.strictEqual(U.fmtTenth(65.04), '1:05.0');
  assert.strictEqual(U.fmtTenth(59.96), '1:00.0');
  assert.strictEqual(U.lastTimeLabel(98000), '1분 38초');
  assert.strictEqual(U.lastTimeLabel(0), '약 2분');
  assert.strictEqual(U.lastTimeLabel(null), '약 2분');
});
