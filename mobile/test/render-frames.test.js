// 영상 엔진의 프레임 산수: 컷 길이 · 화면전환 · lead/tail 이 PC 앱(runner.step_render + assemble.assembleAnimation)과 프레임 단위로 같은지.
// 아래 simulate() 는 PC 앱의 계산을 그대로 옮겨 적은 것이다 (lead = 앞 전환/2, tail = 뒤 전환/2, 조각 = lead + N + tail, xfade 오프셋 = 지금까지 길이 - 전환 길이).
import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { buildLayout, frameInfo, shotsForFrame, shotsForRange, transitionFrames, defaultBitrate, FPS } from '../src/engine/render/frames.js';
import { createMeter, fmtDuration, fmtEta } from '../src/engine/render/progress.js';

const require = createRequire(import.meta.url);
const X = require('../../src/main/pipeline/xsheet.js');
const TL = require('../../src/main/media/timeline.js');

/** PC 앱: step_render 의 lead/tail + assembleAnimation 의 이어붙이기 → 출력 프레임마다 어떤 조각의 몇 번째 프레임이 어떻게 섞이는가 */
function simulate(xs) {
  const n = xs.shots.length;
  const clips = xs.shots.map((s, i) => {
    const lead = i > 0 ? xs.transitions[i - 1].frames / 2 : 0;
    const tail = i < xs.transitions.length ? xs.transitions[i].frames / 2 : 0;
    return { lead, tail, N: s.frames, frames: lead + s.frames + tail };
  });
  const E = [0];
  const trans = [];
  let curLen = clips[0].frames;
  for (let i = 1; i < n; i++) {
    const tr = xs.transitions[i - 1] || { xfade: null, frames: 0 };
    if (tr.xfade && tr.frames > 0) {
      E[i] = curLen - tr.frames;
      trans.push({ off: curLen - tr.frames, T: tr.frames, a: i - 1, b: i });
      curLen += clips[i].frames - tr.frames;
    } else {
      E[i] = curLen;
      curLen += clips[i].frames;
    }
  }
  const out = [];
  for (let R = 0; R < xs.totalFrames; R++) {
    const t = trans.find((x) => R >= x.off && R < x.off + x.T);
    const part = (i) => { const r = R - E[i]; return { i, r, f: Math.min(clips[i].N - 1, Math.max(0, r - clips[i].lead)) }; };
    if (t) out.push({ kind: 'transition', a: part(t.a), b: part(t.b), p: (R - t.off) / t.T });
    else {
      let c = -1;
      for (let i = 0; i < n; i++) if (R >= E[i] && R < E[i] + clips[i].frames) c = i;
      out.push({ kind: 'single', a: part(c) });
    }
  }
  return { clips, E, out, curLen };
}

function makeXs(frames, trs) {
  const shots = frames.map((N, i) => ({ shot: i + 1, frames: N }));
  const transitions = trs.map(([xfade, f]) => ({ type: xfade || 'cut', xfade, duration: f / 24, frames: xfade ? f : 0 }));
  return { fps: 24, totalFrames: frames.reduce((a, b) => a + b, 0), shots, transitions };
}

function compare(xs) {
  const layout = buildLayout(xs);
  const sim = simulate(xs);
  assert.strictEqual(sim.curLen, xs.totalFrames, 'PC 앱 이어붙인 길이 = 노래 프레임 수');
  assert.strictEqual(layout.sum, xs.totalFrames);
  for (let R = 0; R < xs.totalFrames; R++) {
    const fi = frameInfo(layout, R);
    const s = sim.out[R];
    assert.strictEqual(fi.kind, s.kind, `R=${R} 종류`);
    assert.deepStrictEqual([fi.a.i, fi.a.r, fi.a.f], [s.a.i, s.a.r, s.a.f], `R=${R} 앞 조각`);
    if (s.kind === 'transition') {
      assert.deepStrictEqual([fi.b.i, fi.b.r, fi.b.f], [s.b.i, s.b.r, s.b.f], `R=${R} 뒤 조각`);
      assert.ok(Math.abs(fi.tr.p - s.p) < 1e-12, `R=${R} 진행도 ${fi.tr.p} vs ${s.p}`);
    }
  }
}

test('3컷: 컷 · 디졸브(12) · 페이드블랙(8) — 프레임마다 PC 앱 이어붙이기와 같다', () => {
  const xs = makeXs([96, 72, 120], [['dissolve', 12], ['fadeblack', 8]]);
  compare(xs);
  const L = buildLayout(xs);
  // 구간표 직접 확인 (손으로 센 값)
  assert.deepStrictEqual(L.spans.map((s) => [s.start, s.frames, s.lead, s.tail, s.clipStart, s.clipFrames]), [
    [0, 96, 0, 6, 0, 102], [96, 72, 6, 4, 90, 82], [168, 120, 4, 0, 164, 124],
  ]);
  assert.deepStrictEqual(L.trs.map((t) => [t.j, t.frames, t.cut, t.from, t.to]), [[0, 12, 96, 90, 102], [1, 8, 168, 164, 172]]);
  // 경계 프레임은 정확히 절반, 첫 장은 앞 컷 그대로, 끝 장은 (T-1)/T
  assert.strictEqual(frameInfo(L, 96).tr.p, 0.5);
  assert.strictEqual(frameInfo(L, 90).tr.p, 0);
  assert.strictEqual(frameInfo(L, 101).tr.p, 11 / 12);
  assert.strictEqual(frameInfo(L, 102).kind, 'single');
  // 앞 컷은 경계 뒤에 마지막 구도를 붙든다 / 뒤 컷은 경계 앞에 첫 구도를 붙든다
  assert.strictEqual(frameInfo(L, 100).a.f, 95);
  assert.strictEqual(frameInfo(L, 92).b.f, 0);
});

test('컷(전환 없음) 이 섞인 경우와 맨 처음 · 맨 끝 · 아주 짧은 컷', () => {
  compare(makeXs([24, 24, 24, 24], [[null, 0], ['fade', 2], [null, 0]]));
  compare(makeXs([10, 3, 50, 1, 40], [['wipeleft', 4], ['slideleft', 2], [null, 0], ['pixelize', 2]]));
  compare(makeXs([200], []));
});

test('무작위 타임시트 200개 (정규화 규칙: 전환은 짝수 · 짧은 쪽 컷의 60% 이하)', () => {
  let seed = 12345;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let k = 0; k < 200; k++) {
    const n = 1 + Math.floor(rnd() * 8);
    const frames = Array.from({ length: n }, () => 8 + Math.floor(rnd() * 300));
    const trs = [];
    for (let i = 0; i + 1 < n; i++) {
      const want = rnd() < 0.35 ? 0 : 2 * (1 + Math.floor(rnd() * 14));
      const cap = Math.floor((Math.min(frames[i], frames[i + 1]) * 0.6) / 2) * 2;
      const f = Math.min(want, cap);
      trs.push(f >= 2 ? ['dissolve', f] : [null, 0]);
    }
    compare(makeXs(frames, trs));
  }
});

test('실제 normalizeXsheet 결과(데모 타임시트)로도 맞다', () => {
  const segments = [3.1, 2.6, 4.2, 3.3, 2.8, 3.5, 3.0].map((d, i, a) => { const start = a.slice(0, i).reduce((x, y) => x + y, 0); return { index: i + 1, start, end: start + d, duration: d, lyrics: [], energy: i === 1 ? 'high' : 'mid', level: 0.5 }; });
  const frames = X.shotFrames(segments);
  const ctx = { segments, frames, highlights: [false, true, false, false, false, true, false], budget: 40, plan: { characters: [], story: [{ visual_en: 'x' }] }, analysis: { beats: [], beatPeriod: 0.5 }, layers: true };
  ctx.alloc = X.allocateDrawings(frames, ctx.highlights, 40);
  const xs = X.normalizeXsheet(null, ctx);
  assert.strictEqual(xs.fps, FPS);
  compare(xs);
  assert.ok(xs.transitions.some((t) => t.xfade), '전환이 하나는 있다');
  for (const t of xs.transitions) assert.strictEqual(transitionFrames(xs, xs.transitions.indexOf(t)), t.xfade ? t.frames : 0);
});

test('컷이 필요로 하는 그림: 한 장 · 전환 중 두 컷 · 구간', () => {
  const L = buildLayout(makeXs([96, 72, 120], [['dissolve', 12], ['fadeblack', 8]]));
  assert.deepStrictEqual(shotsForFrame(L, 0), [0]);
  assert.deepStrictEqual(shotsForFrame(L, 93), [0, 1]);
  assert.deepStrictEqual(shotsForFrame(L, 130), [1]);
  assert.deepStrictEqual(shotsForFrame(L, 166), [1, 2]);
  assert.deepStrictEqual(shotsForRange(L, 0, 40), [0]);
  assert.deepStrictEqual(shotsForRange(L, 80, 100), [0, 1]);
  assert.deepStrictEqual(shotsForRange(L, 0, 287), [0, 1, 2]);
  // 범위 밖 · 소수 입력은 안으로
  assert.strictEqual(frameInfo(L, -5).R, 0);
  assert.strictEqual(frameInfo(L, 99999).R, 287);
  assert.strictEqual(frameInfo(L, 12.7).R, 12);
});

test('totalFrames 가 컷 합계보다 길면 마지막 장면을 붙든다 (assemble 의 tpad)', () => {
  const xs = makeXs([48, 48], [[null, 0]]);
  xs.totalFrames = 100;
  const L = buildLayout(xs);
  assert.strictEqual(L.total, 100);
  const fi = frameInfo(L, 99);
  assert.deepStrictEqual([fi.kind, fi.a.i, fi.a.f], ['single', 1, 47]);
});

test('기본 비트레이트: 1080p 9M · 720p 5M · 540p 3M · 480p 이하 2M', () => {
  assert.strictEqual(defaultBitrate(1920, 1080), 9e6);
  assert.strictEqual(defaultBitrate(1280, 720), 5e6);
  assert.strictEqual(defaultBitrate(720, 1280), 5e6);
  assert.strictEqual(defaultBitrate(960, 540), 3e6);
  assert.strictEqual(defaultBitrate(854, 480), 2e6);
  assert.strictEqual(defaultBitrate(480, 480), 2e6);
});

test('진행률 · 남은 시간: 처음에는 모르고, 속도가 일정하면 맞게 어림한다', () => {
  let t = 0;
  const m = createMeter(1000, () => t);
  assert.strictEqual(m.update(0).etaMs, null);
  t = 400;
  assert.strictEqual(m.update(10).etaMs, null, '1초가 지나기 전에는 모른다');
  for (let s = 1; s <= 10; s++) { t = s * 1000; m.update(s * 20); }
  const p = m.update(200);
  assert.strictEqual(p.fraction, 0.2);
  assert.ok(Math.abs(p.fps - 20) < 0.5, `fps ${p.fps}`);
  assert.ok(Math.abs(p.etaMs - 40000) < 1500, `eta ${p.etaMs}`);
  t = 60000;
  assert.strictEqual(m.update(1000).etaMs, 0);
  assert.strictEqual(m.update(1000).fraction, 1);
  // 처음엔 빠르다가 느려지면 남은 시간이 천천히 따라간다 (갑자기 뛰지 않는다)
  let t2 = 0;
  const m2 = createMeter(2000, () => t2);
  let done = 0;
  for (let i = 0; i < 5; i++) { t2 += 1000; done += 100; m2.update(done); }
  const fast = m2.update(done).etaMs;
  t2 += 1000; done += 20;
  const slower = m2.update(done).etaMs;
  assert.ok(slower > fast && slower < fast * 2.5, `${fast} → ${slower}`);
});

test('시간 글자 (해요체)', () => {
  assert.strictEqual(fmtDuration(45000), '45초');
  assert.strictEqual(fmtDuration(65000), '1분 05초');
  assert.strictEqual(fmtDuration(3720000), '1시간 2분');
  assert.match(fmtEta(null), /계산하는 중/);
  assert.match(fmtEta(2000), /곧 끝나요/);
  assert.match(fmtEta(32000), /약 \d+초 남았어요/);
  assert.match(fmtEta(150000), /약 3분 남았어요/);
  assert.match(fmtEta(5400000), /약 1시간 30분 남았어요/);
});

test('화면전환 길이는 PC 앱 resolveTransitions 가 정한다 — 이름이 모두 엔진에 있다', async () => {
  const { TRANSITION_NAMES } = await import('../src/engine/render/transitions.js');
  for (const [name, t] of Object.entries(TL.TRANSITIONS)) if (t.xfade) assert.ok(TRANSITION_NAMES.includes(t.xfade), `${name} → ${t.xfade}`);
});
