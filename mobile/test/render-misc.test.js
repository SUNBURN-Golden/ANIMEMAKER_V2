// 영상 엔진의 순수 부분: SRT/LRC 글, 코덱 고르기, 노래 자르기·페이드, 반짝임 점, 연습용 노래·인물, 마무리 설정, 틈 주기
import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const TL = require('../../src/main/media/timeline.js');
const RC = require('../../src/main/media/render-core.js');
const A = require('../../src/main/media/audio-analysis.js');
const DD = require('../../src/main/ai/demo-data.js');

// ---------- SRT / LRC ----------
globalThis.document = undefined;
const { makeSrt, makeLrc } = await import('../src/engine/render/burn.js');

test('SRT/LRC: PC 앱(runner.step_subtitles)과 같은 글 — 숨긴 줄 · 빈 줄은 뺀다', () => {
  const lines = [
    { text: '작은 불빛 하나 따라', start: 4.5, end: 7.25 },
    { text: '숨긴 줄', start: 7.3, end: 8, hidden: true },
    { text: '', start: 8, end: 9 },
    { text: '낯선 길을 걸어가', start: 7.5, end: 10.123 },
    { text: 'x'.repeat(3), start: 3725.5, end: 3726 },
  ];
  const shown = lines.filter((l) => !l.hidden && l.text); // runner.step_subtitles 의 shown
  assert.strictEqual(makeSrt(lines), TL.toSrt(shown));
  assert.strictEqual(makeLrc(lines, '하루의 노래'), TL.toLrc(shown, '하루의 노래'));
  assert.strictEqual(makeLrc(lines), TL.toLrc(shown, undefined));
  // 모양 확인
  assert.ok(makeSrt(lines).startsWith('1\n00:00:04,500 --> 00:00:07,250\n작은 불빛 하나 따라\n\n2\n00:00:07,500 --> 00:00:10,123\n'));
  assert.ok(makeSrt(lines).includes('01:02:05,500 --> 01:02:06,000'));
  assert.ok(makeLrc(lines, '하루의 노래').startsWith('[ti:하루의 노래]\n[00:04.50]작은 불빛 하나 따라\n[00:07.50]낯선 길을 걸어가\n'));
  assert.strictEqual(makeSrt([]), '');
});

// ---------- 코덱 고르기 ----------
const { probeEncoders, assertVideoEncoder, NoEncoderError } = await import('../src/engine/render/codecs.js');

test('코덱 고르기: avc → vp9 → av1, aac → opus. 하나도 없으면 한국어 오류에 probe 가 실린다', async () => {
  const mk = (v, a) => ({ video: async (c) => v.includes(c), audio: async (c) => a.includes(c) });
  let p = await probeEncoders({ W: 1280, H: 720, can: mk(['avc', 'vp9'], ['aac', 'opus']) });
  assert.deepStrictEqual([p.video, p.audio, p.fallbackVideo, p.fallbackAudio], ['avc', 'aac', false, false]);
  p = await probeEncoders({ W: 1280, H: 720, can: mk(['vp9', 'av1'], ['opus']) });
  assert.deepStrictEqual([p.video, p.audio, p.fallbackVideo, p.fallbackAudio], ['vp9', 'opus', true, true]);
  assert.deepStrictEqual(p.tried.video, { avc: false, vp9: true });
  p = await probeEncoders({ W: 1280, H: 720, can: mk(['av1'], []) });
  assert.deepStrictEqual([p.video, p.audio], ['av1', null]);
  p = await probeEncoders({ W: 1280, H: 720, wantAudio: false, can: mk(['avc'], ['aac']) });
  assert.strictEqual(p.audio, null);
  p = await probeEncoders({ W: 1280, H: 720, can: { video: async () => { throw new Error('boom'); }, audio: async () => false } });
  assert.strictEqual(p.video, null);
  assert.throws(() => assertVideoEncoder(p), (e) => e instanceof NoEncoderError && /영상을 만들 수 없어요/.test(e.message) && e.probe && e.probe.tried.video.avc === false);
});

// ---------- 노래 자르기 · 페이드 ----------
class FakeAudioBuffer {
  constructor({ length, numberOfChannels, sampleRate }) { this.length = length; this.numberOfChannels = numberOfChannels; this.sampleRate = sampleRate; this.ch = Array.from({ length: numberOfChannels }, () => new Float32Array(length)); }
  getChannelData(c) { return this.ch[c]; }
  copyToChannel(src, c) { this.ch[c].set(src); }
}
globalThis.AudioBuffer = FakeAudioBuffer;
const { createAudioFeeder } = await import('../src/engine/render/export.js');

async function feedAll(audio, seconds) {
  const parts = [];
  const f = createAudioFeeder(audio, { add: async (b) => { parts.push(b); } }, seconds);
  await f.feed(Infinity);
  const n = parts.reduce((a, b) => a + b.length, 0);
  const out = [new Float32Array(n), new Float32Array(n)];
  let o = 0;
  for (const p of parts) { for (let c = 0; c < p.numberOfChannels; c++) out[c].set(p.getChannelData(c), o); o += p.length; }
  return { parts, n, out, f };
}

test('노래 이어 넣기: 길이를 정확히 맞추고(자르기 · 무음 채우기), 1초씩 나누고, 끝에서 min(2, 길이/10)초 페이드아웃', async () => {
  const sr = 48000;
  const loud = new FakeAudioBuffer({ length: sr * 30, numberOfChannels: 2, sampleRate: sr });
  loud.ch.forEach((c) => c.fill(0.5));
  // 12초 영상 = 288프레임에 30초 노래: 자른다
  let r = await feedAll(loud, 12);
  assert.strictEqual(r.n, 12 * sr);
  assert.ok(r.parts.every((p) => p.length <= sr));
  assert.strictEqual(r.parts.length, 12);
  assert.strictEqual(r.out[0][0], 0.5);
  const fadeOut = Math.min(2, 12 / 10); // 1.2초
  const fadeStart = Math.round((12 - fadeOut) * sr);
  assert.ok(Math.abs(r.out[0][fadeStart - 5] - 0.5) < 1e-6, '페이드 전에는 그대로');
  assert.ok(r.out[0][fadeStart + Math.round(0.6 * sr)] > 0.2 && r.out[0][fadeStart + Math.round(0.6 * sr)] < 0.3, '가운데는 절반쯤');
  assert.ok(Math.abs(r.out[0][r.n - 1]) < 1e-3, '마지막은 거의 0');
  // 긴 영상은 2초 페이드
  r = await feedAll(loud, 30);
  assert.ok(Math.abs(r.out[0][28 * sr - 5] - 0.5) < 1e-6 && r.out[0][29 * sr] < 0.26);
  // 짧은 노래는 무음으로 채운다
  const shortSong = new FakeAudioBuffer({ length: sr * 3, numberOfChannels: 1, sampleRate: sr });
  shortSong.ch[0].fill(0.4);
  r = await feedAll(shortSong, 5);
  assert.strictEqual(r.n, 5 * sr);
  assert.strictEqual(r.parts[0].numberOfChannels, 1, '모노는 모노로');
  assert.ok(Math.abs(r.out[0][2 * sr] - 0.4) < 1e-6);
  assert.strictEqual(r.out[0][4 * sr], 0);
  // 1초 앞까지만 넣는다 (영상과 번갈아)
  const parts = [];
  const f = createAudioFeeder(loud, { add: async (b) => { parts.push(b); } }, 12);
  await f.feed(0.5);
  assert.strictEqual(parts.length, 1);
  await f.feed(3.2);
  assert.strictEqual(parts.length, 4);
});

// ---------- 반짝임 · 장면 ----------
const { sparkleList } = await import('../src/engine/render/compositor.js');

test('반짝임 점: render-core.drawSparkles 와 같은 계산 (같은 점 · 같은 세기)', () => {
  for (const [W, H, seed, r] of [[1280, 720, 7920, 5], [720, 1280, 7921, 40], [960, 540, 7922, 123]]) {
    const a = new Uint8Array(W * H * 3).fill(60);
    RC.drawSparkles(a, W, H, seed, r);
    const b = new Uint8Array(W * H * 3).fill(60);
    const list = sparkleList(W, H, seed, r);
    assert.ok(list.length > 30, '별이 있다');
    for (let q = 0; q < list.length; q += 3) {
      const p = (list[q + 1] * W + list[q]) * 3;
      const a2 = list[q + 2];
      b[p] = b[p] + (255 - b[p]) * a2;
      b[p + 1] = b[p + 1] + (250 - b[p + 1]) * a2;
      b[p + 2] = b[p + 2] + (210 - b[p + 2]) * a2;
    }
    assert.ok(Buffer.from(a).equals(Buffer.from(b)), `${W}x${H} r=${r}`);
  }
});

// ---------- 마무리 설정 ----------
const FIN = await import('../src/engine/render/finish.js');

test('마무리: 기본은 보일 · 비네팅 · 따뜻함 켜고 알갱이 · 종이 끔, 비네팅 모서리는 ×0.59', () => {
  assert.deepStrictEqual(FIN.normalizeFinish(null), { boil: true, vignette: true, warm: true, grain: false, paper: false });
  assert.deepStrictEqual(FIN.normalizeFinish({ warm: false, grain: 1, zzz: 1 }), { boil: true, vignette: true, warm: false, grain: true, paper: false });
  assert.ok(Math.abs(FIN.vignetteFactor(1) - 0.5934) < 1e-3);
  assert.strictEqual(FIN.vignetteFactor(0), 1);
  assert.ok(FIN.vignetteFactor(0.5) > 0.86 && FIN.vignetteFactor(0.5) < 0.9);
  const rnd = FIN.mulberry32(5);
  const a = [rnd(), rnd(), rnd()];
  const rnd2 = FIN.mulberry32(5);
  assert.deepStrictEqual(a, [rnd2(), rnd2(), rnd2()]);
});

// ---------- 연습용 그림 · 노래 ----------
const DC = await import('../src/engine/render/demo-canvas.js');

test('연습용 인물: 공용 figureBoxes 와 같은 상자 · 자세는 그림마다 다르고 항상 같다', () => {
  const pal = DD.DEMO_CHARACTER.palette;
  const boxes = DD.figureBoxes(600, 250, 100, pal, { arm: 0.5, scarf: 0.3, leg: -0.2 });
  const rects = DC.figureRects(600, 250, 100, pal, { arm: 0.5, scarf: 0.3, leg: -0.2 });
  assert.strictEqual(rects.length, boxes.length);
  assert.deepStrictEqual(rects[0], { x: 550, y: 250, w: 100, h: 190, color: '#f4c430' });
  const poses = [0, 1, 2, 3, 4, 5].map((index) => JSON.stringify(DC.celPose({ W: 1280, H: 720, shot: 2, index, count: 6, motion: true })));
  assert.strictEqual(new Set(poses).size, 6, '열쇠 그림마다 자세가 다르다');
  assert.strictEqual(poses[3], JSON.stringify(DC.celPose({ W: 1280, H: 720, shot: 2, index: 3, count: 6, motion: true })));
  const hold = [0, 1].map((index) => JSON.stringify(DC.celPose({ W: 1280, H: 720, shot: 1, index, count: 2 })));
  assert.notStrictEqual(hold[0], hold[1]);
});

test('연습용 노래: 같은 입력 → 같은 소리, 박자가 또렷해서 박자 분석이 BPM 을 찾는다', async () => {
  const s1 = DC.demoSongSamples({ seconds: 24, bpm: 120 });
  const s2 = DC.demoSongSamples({ seconds: 24, bpm: 120 });
  const h = (x) => crypto.createHash('sha1').update(Buffer.from(x.samples.buffer)).digest('hex');
  assert.strictEqual(h(s1), h(s2), '결정적');
  assert.notStrictEqual(h(s1), h(DC.demoSongSamples({ seconds: 24, bpm: 120, seed: 2 })), 'seed 가 화음을 바꾼다');
  assert.strictEqual(s1.sampleRate, A.SR);
  assert.strictEqual(s1.samples.length, 24 * A.SR);
  const peak = s1.samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(peak > 0.3 && peak <= 1, `소리 크기 ${peak}`);
  for (const bpm of [120, 96]) {
    const a = A.analyzeSamples(DC.demoSongSamples({ seconds: 30, bpm }).samples, bpm);
    assert.ok(Math.abs(a.bpm - bpm) < 1.5, `${bpm} → ${a.bpm}`);
    assert.ok(a.beats.length >= (30 * bpm) / 60 - 3, `박 ${a.beats.length}`);
  }
  // 우리 분석은 앞 정보 없이도 찾는다
  const free = A.analyzeSamples(DC.demoSongSamples({ seconds: 30, bpm: 100 }).samples);
  assert.ok(Math.abs(free.bpm - 100) < 2 || Math.abs(free.bpm - 200) < 3 || Math.abs(free.bpm - 50) < 2, `자동 ${free.bpm}`);
  // WAV 파일 모양
  const blob = await DC.demoSong({ seconds: 2, bpm: 120 });
  const buf = Buffer.from(await blob.arrayBuffer());
  assert.strictEqual(blob.type, 'audio/wav');
  assert.strictEqual(buf.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(buf.toString('ascii', 8, 12), 'WAVE');
  assert.strictEqual(buf.readUInt32LE(24), A.SR);
  assert.strictEqual(buf.length, 44 + 2 * A.SR * 2);
});

// ---------- 틈 주기 ----------
const U = await import('../src/engine/render/util.js');

test('틈 주기: pacer 는 정해진 시간이 지났을 때만 양보하고, 멈춤 오류는 AbortError', async () => {
  let t = 0;
  const pacer = U.createPacer({ sliceMs: 24, paintMs: 1e9, now: () => t });
  let macrotasks = 0;
  const mark = () => setImmediate(() => { macrotasks++; });
  mark();
  t = 10;
  await pacer.tick(); // 24ms 가 안 지났다: 마이크로태스크만
  assert.strictEqual(macrotasks, 0, '아직 양보하지 않는다');
  t = 30;
  await pacer.tick(); // 지났다: 다음 작업 차례까지 양보한다
  assert.strictEqual(macrotasks, 1, '양보했다');
  t = 40;
  await pacer.tick();
  assert.strictEqual(macrotasks, 1, '방금 양보해서 또 하지 않는다');
  assert.strictEqual(U.abortError().name, 'AbortError');
  assert.ok(U.isAbortError(U.abortError()));
  assert.throws(() => U.throwIfAborted({ aborted: true }), (e) => e.name === 'AbortError');
  assert.doesNotThrow(() => U.throwIfAborted({ aborted: false }));
  assert.doesNotThrow(() => U.throwIfAborted(undefined));
  await U.yieldToUI();
});
