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

// ---------- 진짜 영상 + 진짜 자막 (video · styleProvider 옵션) ----------
// 화면 라이브러리(jsdom)가 없어서, mount 가 쓰는 만큼만 흉내 낸 아주 작은 DOM 을 쓴다.
function withFakeDom(fn) {
  class FNode {}
  class FText extends FNode { constructor(t) { super(); this.nodeValue = t; } }
  class FEl extends FNode {
    constructor(tag) {
      super();
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.attrs = {};
      this.style = {};
      this.listeners = {};
      this.className = '';
      this.parentNode = null;
      this.isConnected = true;
      this.scrollTop = 0; this.clientHeight = 100; this.offsetTop = 0; this.offsetHeight = 10;
      const self = this;
      this.classList = {
        has: (c) => self.className.split(/\s+/).includes(c),
        contains: (c) => self.classList.has(c),
        add: (c) => { if (!self.classList.has(c)) self.className = `${self.className} ${c}`.trim(); },
        remove: (c) => { self.className = self.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
        toggle: (c, on) => { if (on === undefined ? !self.classList.has(c) : on) self.classList.add(c); else self.classList.remove(c); },
      };
    }
    get firstChild() { return this.children[0] || null; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== fn); }
    set textContent(v) { this.children = [new FText(String(v))]; }
    get textContent() { return this.children.map((c) => (c instanceof FText ? c.nodeValue : c.textContent)).join(''); }
    contains(n) { return n === this || this.children.some((c) => c.contains && c.contains(n)); }
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 20 }; }
    getContext() { return this.ctx || (this.ctx = { tag: 'ctx' }); }
    pause() { this.paused = true; }
    load() {}
    all(pred, out = []) { for (const c of this.children) { if (c instanceof FEl) { if (pred(c)) out.push(c); c.all(pred, out); } } return out; }
    querySelector(sel) {
      const m = /^\.([\w-]+)\[data-i="(-?\d+)"\]$/.exec(sel);
      if (!m) return null;
      return this.all((e) => e.classList.has(m[1]) && e.attrs['data-i'] === m[2])[0] || null;
    }
    find(cls) { return this.all((e) => e.classList.has(cls))[0] || null; }
  }
  const docListeners = [];
  const doc = {
    head: new FEl('head'),
    createElement: (t) => new FEl(t),
    createTextNode: (t) => new FText(t),
    getElementById: () => null,
    addEventListener: (t, f) => docListeners.push([t, f]),
    removeEventListener: (t, f) => { const i = docListeners.findIndex((x) => x[0] === t && x[1] === f); if (i >= 0) docListeners.splice(i, 1); },
  };
  const saved = { document: global.document, Node: global.Node, raf: global.requestAnimationFrame, caf: global.cancelAnimationFrame };
  global.document = doc; global.Node = FNode; global.requestAnimationFrame = () => 1; global.cancelAnimationFrame = () => {};
  try { return fn({ FEl, docListeners }); } finally {
    global.document = saved.document; global.Node = saved.Node; global.requestAnimationFrame = saved.raf; global.cancelAnimationFrame = saved.caf;
  }
}

function fakeVideo(FEl) {
  const v = new FEl('video');
  Object.assign(v, { currentTime: 0, paused: true, duration: 60, playbackRate: 1, videoWidth: 0, videoHeight: 0 });
  v.play = () => { v.paused = false; (v.listeners.play || []).forEach((f) => f()); return Promise.resolve(); };
  v.pause = () => { v.paused = true; (v.listeners.pause || []).forEach((f) => f()); };
  v.emit = (t) => (v.listeners[t] || []).forEach((f) => f());
  return v;
}

test('영상용 도우미: 그릴 줄(시작·끝·숨김)과 그리개 호출, 그리개가 없으면 조용히 건너뜀, 상자 크기는 영상 비율', () => {
  const s = LS.create(LINES, 60, { confirmed: true });
  const lines = LINES.map((l, i) => ({ ...l, hidden: i === 1 }));
  const cl = LS.checkLines(s, lines);
  assert.deepStrictEqual(cl.map((l) => l.hidden), [false, true, false, false]);
  assert.strictEqual(cl[0].start, 10);
  assert.ok(Math.abs(cl[0].end - 13.95) < 1e-9);
  const calls = [];
  const R = { drawFrame: (...a) => { calls.push(a); return [{ ok: 1 }]; } };
  const ctx = { id: 'c' };
  const drawn = LS.drawCheck(R, ctx, s, lines, 11, { font: 'jua' }, 1280, 720);
  assert.strictEqual(drawn.length, 1);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][0], ctx);
  assert.strictEqual(calls[0][2], 11);
  assert.deepStrictEqual(calls[0][3], { font: 'jua' });
  assert.deepStrictEqual([calls[0][4], calls[0][5]], [1280, 720]);
  assert.deepStrictEqual(LS.drawCheck(null, ctx, s, lines, 11, {}, 1280, 720), []);
  assert.deepStrictEqual(LS.drawCheck({}, ctx, s, lines, 11, {}, 1280, 720), []);
  const wide = LS.stageSize(1280, 720);
  const tall = LS.stageSize(720, 1280);
  assert.strictEqual(wide.aspect, '1280 / 720');
  assert.strictEqual(tall.aspect, '720 / 1280');
  assert.ok(/min\(100%, 560px, 78\.\d+vh\)/.test(wide.width), wide.width);
  assert.ok(/min\(100%, 560px, 24\.\d+vh\)/.test(tall.width), tall.width);
});

test('mount: video · styleProvider 를 안 주면 예전과 같다 (노래 <audio> 를 만들고 글씨 무대를 쓴다)', () => {
  withFakeDom(() => {
    const w = LS.mount({ lines: LINES, duration: 60, src: 'file:///song.mp3', confirmed: true });
    assert.strictEqual(w.audio.tagName, 'AUDIO');
    assert.strictEqual(w.audio.getAttribute('src'), 'file:///song.mp3');
    assert.ok(w.el.find('ls-sub'), 'white-on-dark text stage');
    assert.strictEqual(w.el.find('ls-vbox'), null);
    assert.strictEqual(w.el.find('ls-vcanvas'), null);
    assert.strictEqual(w.untapped(), 0);
    assert.strictEqual(w.tappedFlags().length, 4);
    w.destroy();
    assert.strictEqual(w.audio.getAttribute('src'), null, 'own audio is released');
  });
});

test('mount: video 를 주면 그 영상을 틀고, 확인하기 무대에 영상+자막 그림판이 나온다 (맞추기에서는 그리지 않음)', () => {
  withFakeDom(({ FEl }) => {
    const video = fakeVideo(FEl);
    const calls = [];
    const R = { drawFrame: (ctx, lines, t, style, W, H) => { calls.push({ ctx, lines, t, style, W, H }); return []; } };
    let provided = 0;
    const style = { preset: 'pop' };
    const w = LS.mount({
      lines: LINES, duration: 60, src: 'file:///clean.mp4', confirmed: true,
      video, renderer: R, styleProvider: () => { provided++; return { style, W: 720, H: 1280 }; },
    });
    assert.strictEqual(w.audio, video, 'the given video is the player');
    assert.strictEqual(video.src, 'file:///clean.mp4', 'src fills an empty video');
    assert.strictEqual(w.el.all((e) => e.tagName === 'AUDIO').length, 0, 'no own <audio>');
    assert.ok(w.el.find('ls-vbox') && w.el.find('ls-vbox').children.includes(video), 'video sits in the dark stage');
    assert.strictEqual(w.el.find('ls-sub'), null, 'no white-on-dark text when a video is given');
    const cv = w.el.find('ls-vcanvas');
    assert.strictEqual(cv.width, 720);
    assert.strictEqual(cv.height, 1280);
    assert.strictEqual(w.el.find('ls-vbox').style.aspectRatio, '720 / 1280');
    // 확인하기(confirmed): 12초에 멈춰 있으면 그 순간의 줄들을 모양과 함께 그린다
    video.currentTime = 12;
    video.emit('seeked');
    const last = calls[calls.length - 1];
    assert.ok(provided > 0);
    assert.strictEqual(last.t, 12);
    assert.strictEqual(last.style, style);
    assert.deepStrictEqual([last.W, last.H], [720, 1280]);
    assert.strictEqual(last.lines.length, 4);
    assert.strictEqual(last.lines[0].text, '별빛이 내리는 밤');
    assert.strictEqual(last.lines[0].start, 10);
    assert.strictEqual(last.ctx, cv.ctx);
    // 닫을 때: 귀를 떼고 영상은 부른 쪽 것이라 주소를 지우지 않는다
    const n = calls.length;
    w.destroy();
    assert.strictEqual(video.paused, true);
    assert.strictEqual(video.src, 'file:///clean.mp4');
    video.emit('seeked');
    assert.strictEqual(calls.length, n, 'no more drawing after destroy');
  });
});

test('mount: 처음부터 맞추기(confirmed:false)에서는 그리지 않고, 확인하기로 가면 그린다 / 영상 비슷한 것(Node 아님)과 그리개 없음도 견딘다', () => {
  withFakeDom(({ FEl }) => {
    const video = fakeVideo(FEl);
    const calls = [];
    const w = LS.mount({ lines: LINES, duration: 60, video, renderer: { drawFrame: (...a) => { calls.push(a); return []; } }, styleProvider: () => ({ style: {}, W: 1280, H: 720 }) });
    video.emit('seeked');
    assert.strictEqual(calls.length, 0, 'tap step draws nothing');
    assert.ok(w.el.className.includes('ls-tap'));
    // 모두 누르지 않아도 [👀 2. 확인하기] 로 넘어갈 수 있다
    const tabs = w.el.find('ls-modes').children;
    tabs[1].listeners.click[0]();
    assert.ok(w.el.className.includes('ls-check'));
    assert.ok(calls.length >= 1, 'check step draws');
    w.destroy();
    // Node 가 아닌 영상 비슷한 것, 그리개 없음
    const plain = { currentTime: 3, paused: true, duration: 60, listeners: {}, play() { this.paused = false; }, pause() { this.paused = true; }, addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }, removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f); } };
    const w2 = LS.mount({ lines: LINES, duration: 60, confirmed: true, video: plain });
    assert.strictEqual(w2.audio, plain);
    plain.listeners.seeked.forEach((f) => f());
    w2.destroy();
    assert.strictEqual((plain.listeners.seeked || []).length, 0);
  });
});
