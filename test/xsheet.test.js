'use strict';
// 타임시트(X-sheet) 검사·고치기 테스트: 프레임 합계, 그림 장수 예산, 하이라이트, 망가진 LLM 결과
const test = require('node:test');
const assert = require('node:assert');
const X = require('../src/main/pipeline/xsheet');

/** 길이 목록으로 가짜 컷 만들기 (120 BPM → 0.5초마다 박자) */
function makeCtx(durs, { highlight = [], budget = 60, energy = [] } = {}) {
  let t = 0;
  const segments = durs.map((d, i) => {
    const s = { index: i + 1, start: t, end: t + d, duration: d, beats: Math.round(d * 2), lyrics: [], energy: energy[i] || 'mid', level: 0.5 };
    t += d;
    return s;
  });
  const beats = [];
  for (let b = 0.25; b < t; b += 0.5) beats.push(Math.round(b * 1000) / 1000);
  const frames = X.shotFrames(segments);
  const highlights = segments.map((_, i) => highlight.includes(i + 1));
  const plan = { title: 't', characters: [{ name: '하루', role: 'protagonist', fixed: true }], story: [{ act: 1, visual_en: 'a harbor town' }], world_en: 'harbor' };
  return { segments, frames, highlights, budget, plan, analysis: { beats, beatPeriod: 0.5, duration: t }, alloc: X.allocateDrawings(frames, highlights, budget) };
}

const sum = (a) => a.reduce((x, y) => x + y, 0);
function checkTotals(xs, ctx) {
  xs.shots.forEach((s, i) => {
    assert.strictEqual(sum(s.exposure.map((e) => e.frames)), ctx.frames[i], `shot ${s.shot} frames add up exactly`);
    assert.ok(s.exposure.every((e) => Number.isInteger(e.frames) && e.frames >= 1), `shot ${s.shot} integer frames`);
    assert.ok(s.exposure.every((e) => s.drawings.some((d) => d.id === e.drawing)), `shot ${s.shot} exposures point to real drawings`);
    assert.strictEqual(X.frameTable(s).length, ctx.frames[i]);
  });
  assert.strictEqual(xs.totalFrames, sum(ctx.frames));
}

test('frame totals: cumulative rounding covers the whole song at 24 fps', () => {
  const ctx = makeCtx([3.37, 5.11, 2.93, 7.2]);
  assert.strictEqual(sum(ctx.frames), Math.round(18.61 * 24));
  assert.deepStrictEqual(X.autoBudget(180), 68);
  assert.deepStrictEqual(X.autoBudget(240), 90);
  assert.strictEqual(X.resolveBudget({ drawingBudget: 5 }, 200, 12), 12, 'budget never below one drawing per shot');
  assert.strictEqual(X.resolveBudget({ drawingBudget: 40 }, 200, 12), 40);
});

test('LLM frames that do not add up are fixed exactly (over, under, seconds, cycles, strings)', () => {
  const ctx = makeCtx([4, 6, 3, 5], { highlight: [2] });
  const raw = {
    shots: [
      { shot: 1, drawings: [{ id: 'A', prompt_en: 'a' }, { id: 'B', prompt_en: 'b' }], exposure: [{ drawing: 'A', frames: 80 }, { drawing: 'B', frames: 70 }] },
      { shot: 2, highlight: true, drawings: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'], exposure: [{ cycle: ['A', 'B', 'C', 'D', 'E', 'F'], each: 2, repeat: 2 }] },
      { shot: 3, drawings: [{ id: '1', pose: 'x' }, { id: '2', pose: 'y' }], exposure: ['1:20', ['2', 7]] },
      { shot: 4, drawings: [{ id: 'A', prompt: 'z' }], exposure: [{ drawing: 'A', seconds: 2.2 }] },
    ],
  };
  const xs = X.normalizeXsheet(raw, ctx);
  checkTotals(xs, ctx);
  const hl = xs.shots[1];
  assert.ok(hl.exposure.slice(0, -1).every((e) => e.frames % 2 === 0), 'highlight on 2s');
  assert.strictEqual(hl.drawings.length, 6);
  assert.deepStrictEqual(xs.shots[2].drawings.map((d) => d.id), ['A', 'B'], 'ids renamed to letters');
  assert.ok(xs.shots[0].exposure[0].frames > xs.shots[0].exposure[1].frames, 'proportions kept when scaling');
});

test('a short highlight pattern repeats on 2s instead of being stretched into holds', () => {
  const ctx = makeCtx([4, 4], { highlight: [2], budget: 3 });
  const raw = { shots: [
    { shot: 1, drawings: ['a'], exposure: ['A:96'] },
    { shot: 2, highlight: true, drawings: ['run 1', 'run 2'], exposure: ['A:2', 'B:3'] },
  ] };
  const xs = X.normalizeXsheet(raw, ctx);
  checkTotals(xs, ctx);
  const hl = xs.shots[1];
  assert.strictEqual(hl.drawings.length, 2, 'budget 3 leaves no room for in-betweens');
  assert.strictEqual(hl.exposure.length, 48, 'A-B-A-B… for the whole shot');
  assert.ok(hl.exposure.every((e, i) => e.frames === 2 && e.drawing === (i % 2 ? 'B' : 'A')));
});

test('highlight shots get more drawings than normal shots, and the budget is a hard cap', () => {
  const durs = [6, 4, 8, 5, 6, 4, 7, 5];
  const ctx = makeCtx(durs, { highlight: [2, 4, 6], budget: 22 });
  // LLM 이 보통 컷에도 그림을 잔뜩, 하이라이트에는 2장만 준 경우
  const raw = {
    shots: durs.map((_, i) => {
      const isHl = [2, 4, 6].includes(i + 1);
      const n = isHl ? 2 : 9;
      const ids = Array.from({ length: n }, (__, k) => String.fromCharCode(65 + k));
      return {
        shot: i + 1, highlight: isHl,
        drawings: ids.map((id) => ({ id, prompt_en: `pose ${id}` })),
        exposure: ids.map((id) => ({ drawing: id, frames: 10 })),
      };
    }),
  };
  const xs = X.normalizeXsheet(raw, ctx);
  checkTotals(xs, ctx);
  assert.ok(xs.totalDrawings <= 22, `budget ${xs.totalDrawings} <= 22`);
  const hl = xs.shots.filter((s) => s.highlight);
  const nm = xs.shots.filter((s) => !s.highlight);
  assert.ok(nm.every((s) => s.drawings.length <= X.NORMAL_MAX), 'normal shots 4 drawings max');
  assert.ok(Math.min(...hl.map((s) => s.drawings.length)) > Math.max(...nm.map((s) => s.drawings.length)), 'every highlight has more drawings than any normal shot');
  assert.ok(xs.notes.some((n) => /예산/.test(n)), 'budget trimming is reported');

  // 예산이 넉넉하면 하이라이트는 사이 그림을 더해 6장이 된다
  const roomy = makeCtx(durs, { highlight: [2, 4, 6], budget: 80 });
  const xs2 = X.normalizeXsheet(raw, roomy);
  checkTotals(xs2, roomy);
  for (const s of xs2.shots.filter((x) => x.highlight)) {
    assert.ok(s.drawings.length >= X.HIGHLIGHT_MIN, `highlight ${s.shot} has ${s.drawings.length}`);
    assert.ok(s.drawings.some((d) => /in-between/.test(d.prompt_en)), 'in-betweens added');
  }
  // 추천 장수: 보통 1~4, 하이라이트 6~12
  const alloc = X.allocateDrawings([24 * 4, 24 * 16, 24 * 6], [false, false, true], 100);
  assert.deepStrictEqual(alloc, [1, 4, 9]);
  assert.deepStrictEqual(X.fitCountsToBudget([4, 4, 9], [false, false, true], 10), [1, 1, 8]);
});

test('garbage and partial LLM output falls back to a PC timesheet', () => {
  const ctx = makeCtx([5, 3, 6], { highlight: [2] });
  for (const raw of [null, undefined, 'oops', {}, { shots: 'x' }, { shots: [] }, [null, 5]]) {
    const xs = X.normalizeXsheet(raw, ctx);
    checkTotals(xs, ctx);
    assert.ok(xs.shots.every((s) => s.source === 'fallback'));
    assert.ok(xs.shots[1].highlight && xs.shots[1].drawings.length >= 6, 'fallback highlight has many drawings on 2s');
    assert.ok(xs.shots[0].drawings.length <= 4);
  }
  assert.ok(!X.validXsheet({ title: 'plan' }) && !X.validXsheet(null) && X.validXsheet([{ drawings: [] }]));
  // 컷 2 가 빠지고, 없는 그림을 가리키고, 카메라·효과 이름이 제멋대로
  const raw = {
    shots: [
      { shot: 1, drawings: ['look up', 'smile'], exposure: [{ drawing: 'A', frames: 60 }, { drawing: 'Z', frames: 60 }], camera: { move: 'Pan Left' }, fx: ['Fade In', 'glitter', 'nonsense'], transition_out: { type: 'wipe-it', beats: 9 } },
      { shot: 3, drawings: [{ id: 'A', prompt_en: 'wave' }], camera: 'dolly in', fx: 'dissolve' },
    ],
  };
  const xs = X.normalizeXsheet(raw, ctx);
  checkTotals(xs, ctx);
  assert.strictEqual(xs.shots[1].source, 'fallback');
  assert.ok(xs.notes.some((n) => /컷 2/.test(n)));
  assert.strictEqual(xs.shots[0].camera.move, 'pan_left');
  assert.ok(xs.shots[0].camera.start.zoom >= 1.15, 'pans get room to move');
  assert.deepStrictEqual(xs.shots[0].fx, ['fade_in', 'sparkle']);
  assert.strictEqual(xs.shots[2].camera.move, 'truck_in');
  assert.deepStrictEqual(xs.shots[2].fx, ['dissolve_in']);
  assert.strictEqual(xs.transitions[1].type, 'dissolve', 'dissolve_in becomes the previous transition');
  assert.ok(xs.transitions.every((t) => t.frames % 2 === 0), 'transition frames are even (split between shots)');
  assert.strictEqual(xs.transitions[0].type, 'cut', 'unknown transition becomes a cut');
});

test('drawing changes snap to the beat; single held drawing gets a slow push-in', () => {
  const ctx = makeCtx([6]);
  const raw = { shots: [{ shot: 1, drawings: ['a', 'b'], exposure: [{ drawing: 'A', frames: 68 }, { drawing: 'B', frames: 76 }] }] };
  const xs = X.normalizeXsheet(raw, ctx);
  const beatFrames = X.beatFramesIn(ctx.segments[0], ctx.analysis, 0);
  assert.ok(beatFrames.includes(xs.shots[0].exposure[0].frames), `change at ${xs.shots[0].exposure[0].frames} is on a beat (${beatFrames.join(',')})`);
  const one = X.normalizeXsheet({ shots: [{ shot: 1, drawings: ['still'], exposure: ['A:144'], camera: 'static' }] }, ctx);
  assert.strictEqual(one.shots[0].camera.move, 'zoom_in');
  const cam = X.normalizeCamera({ move: 'zoom_in' });
  assert.deepStrictEqual(X.cameraAt(cam, 0), cam.start);
  assert.deepStrictEqual(X.cameraAt(cam, 1), cam.end);
});

test('editing one drawing hold keeps the shot length', () => {
  const ctx = makeCtx([4]);
  const xs = X.normalizeXsheet({ shots: [{ shot: 1, drawings: ['a', 'b', 'c'], exposure: ['A:32', 'B:32', 'C:32'] }] }, ctx);
  const s = X.retimeExposure(xs.shots[0], 0, 50);
  assert.strictEqual(s.exposure[0].frames, 50);
  assert.strictEqual(sum(s.exposure.map((e) => e.frames)), 96);
  const s2 = X.retimeExposure(s, 2, 500);
  assert.strictEqual(sum(s2.exposure.map((e) => e.frames)), 96, 'cannot grow past the shot');
  assert.ok(s2.exposure.every((e) => e.frames >= 1));
  assert.throws(() => X.retimeExposure({ ...s, exposure: [{ drawing: 'A', frames: 96 }] }, 0, 10), /한 칸뿐/);
});

test('highlights: chorus or high energy, capped, at least one', () => {
  const segs = Array.from({ length: 10 }, (_, i) => ({ index: i + 1, lyrics: [i], energy: i < 7 ? 'high' : 'low', level: i / 10 }));
  const lyr = segs.map((_, i) => ({ section: i === 8 ? 'Chorus' : 'Verse' }));
  const hl = X.markHighlights(segs, lyr);
  assert.ok(hl.filter(Boolean).length <= 5, 'at most 45%');
  assert.ok(hl[8], 'chorus ranks first');
  const calm = X.markHighlights(segs.map((s) => ({ ...s, energy: 'low' })), []);
  assert.strictEqual(calm.filter(Boolean).length, 1, 'one highlight even in a calm song');
  const p = X.xsheetPrompt({ ...makeCtx([4, 4], { highlight: [2] }), lyrics: [], wf: { transitionStyle: 'mixed' }, series: { name: 's', episode: 2, characters: [{ name: '하루' }] } });
  assert.match(p, /- shot 2: .*= 96 frames.*HIGHLIGHT/);
  assert.match(p, /at most 60 unique images/);
  assert.match(p, /never redesign or rename them/);
});

// ---------- 움직임 방식 (지브리식 / 전체 움직임 / 리미티드) ----------
function motionCtx(durs, { mode = 'ghibli', keyRate = 6, layers = true, drawingBudget = 0, energy = [], highlight = [] } = {}) {
  const base = makeCtx(durs, { highlight, energy });
  const motion = X.assignMotion(base.segments, base.frames, base.highlights, mode);
  const wf = { drawingBudget };
  const budget = X.resolveBudget(wf, base.analysis.duration, base.segments.length, { mode, frames: base.frames, motion, keyRate, layers });
  const alloc = X.allocateDrawings(base.frames, base.highlights, Math.max(base.segments.length, budget - (layers ? base.segments.length : 0)));
  return { ...base, mode, keyRate, layers, motion, budget, alloc, wf: { transitionStyle: 'mixed' }, lyrics: [] };
}

test('motion keys: 1초 6장 → 4프레임, 1초 8장 → 3프레임; cycles counted once; totals exact', () => {
  assert.strictEqual(X.keyFrames(6), 4);
  assert.strictEqual(X.keyFrames(8), 3);
  assert.strictEqual(X.motionSlots(96, 6), 24);
  assert.strictEqual(X.motionSlots(96, 8), 32);
  for (const keyRate of [6, 8]) {
    const unit = X.keyFrames(keyRate);
    const ctx = motionCtx([4.1, 3.3], { mode: 'full', keyRate });
    // LLM 이 2프레임씩(틀림) + 합계도 틀리게 줌 → PC 가 열쇠 그림 칸(4/3프레임)으로 바로잡는다
    const raw = { shots: [
      { shot: 1, motion: true, bg: { prompt_en: 'a harbor' }, drawings: ['a', 'b', 'c', 'd'], exposure: [{ cycle: ['A', 'B', 'C', 'D'], each: 2, repeat: 5 }] },
      { shot: 2, motion: true, drawings: ['x', 'y', 'z'], exposure: ['A:7', 'B:5', 'C:999'] },
    ] };
    const xs = X.normalizeXsheet(raw, ctx);
    checkTotals(xs, ctx);
    for (const s of xs.shots) {
      assert.ok(s.motion);
      assert.ok(s.exposure.slice(0, -1).every((e) => e.frames === unit), `keyRate ${keyRate}: every key ${unit} frames (${s.exposure.map((e) => e.frames)})`);
      assert.ok(s.exposure[s.exposure.length - 1].frames <= unit * 2 && s.exposure[s.exposure.length - 1].frames >= 1);
      for (let k = 1; k < s.exposure.length; k++) assert.notStrictEqual(s.exposure[k].drawing, s.exposure[k - 1].drawing, 'neighbouring slots merged into one exposure when the same');
    }
    assert.strictEqual(xs.shots[0].drawings.length, 4, 'a cycle draws its keys once');
    assert.strictEqual(xs.shots[0].bg.prompt_en, 'a harbor');
    assert.strictEqual(xs.shots[1].bg.prompt_en.length > 0, true, 'missing bg → scene');
    assert.strictEqual(xs.totalDrawings, 4 + 3 + 2, 'cels + one background per shot');
    assert.strictEqual(xs.keyRate, keyRate);
  }
});

test('지브리식: about 40-50% of the song moves (highlights and energetic shots first); full = all; limited = none', () => {
  const durs = [6, 5, 8, 7, 6, 9, 5, 7, 6, 8, 7, 6];
  const energy = ['low', 'mid', 'high', 'low', 'mid', 'high', 'low', 'high', 'mid', 'high', 'low', 'mid'];
  const highlight = [3, 6, 10];
  const g = motionCtx(durs, { energy, highlight });
  const total = sum(g.frames);
  const share = sum(g.frames.filter((_, i) => g.motion[i])) / total;
  assert.ok(share >= 0.35 && share <= 0.55, `motion share ${share.toFixed(2)}`);
  for (const i of [2, 5, 9]) assert.ok(g.motion[i], `highlight shot ${i + 1} moves`);
  assert.ok(g.motion.every((m, i) => !m || energy[i] !== 'low' || g.highlights[i]), 'calm low-energy shots are held');
  const xs = X.normalizeXsheet(null, g); // AI 없이 PC 기본 타임시트
  checkTotals(xs, g);
  const xshare = sum(xs.shots.filter((s) => s.motion).map((s) => s.frames)) / total;
  assert.ok(xshare >= 0.35 && xshare <= 0.55, `timesheet motion share ${xshare.toFixed(2)}`);
  assert.ok(xs.shots.filter((s) => !s.motion).every((s) => s.drawings.length >= 1 && s.drawings.length <= 4), 'held shots: 1-4 cels');
  assert.ok(xs.totalDrawings <= xs.budget);
  assert.ok(xs.shots.every((s) => s.bg));
  assert.ok(X.assignMotion(g.segments, g.frames, g.highlights, 'full').every(Boolean));
  assert.ok(!X.assignMotion(g.segments, g.frames, g.highlights, 'limited').some(Boolean));
  // 리미티드: 예전 방식 (움직이는 컷 없음, 하이라이트는 2프레임씩)
  const l = motionCtx(durs, { energy, highlight, mode: 'limited', layers: false });
  const lx = X.normalizeXsheet(null, l);
  checkTotals(lx, l);
  assert.ok(lx.shots.every((s) => !s.motion && !s.bg));
  assert.ok(lx.shots.filter((s) => s.highlight).every((s) => s.exposure.every((e) => e.frames === 2)));
  // LLM 이 예산 안에서 움직임을 바꿀 수 있다
  const flip = X.normalizeXsheet({ shots: g.segments.map((s, i) => ({ shot: s.index, motion: i === 0, drawings: ['a', 'b'], exposure: ['A:4', 'B:4'] })) }, g);
  assert.ok(flip.shots[0].motion, 'LLM switched shot 1 to motion');
  assert.ok(!flip.shots[2].motion, 'LLM switched shot 3 to hold');
});

test('motion budget: auto = motion seconds × keyRate + holds + backgrounds; a set budget is a hard cap', () => {
  const durs = [6, 8, 6, 8];
  const g = motionCtx(durs, { energy: ['low', 'high', 'low', 'high'], highlight: [2, 4] });
  const motionSec = sum(g.frames.filter((_, i) => g.motion[i])) / 24;
  assert.ok(g.budget >= Math.round(motionSec * 6) + 4, `auto budget ${g.budget} covers ${motionSec}s × 6 + 4 backgrounds`);
  const full8 = motionCtx(durs, { mode: 'full', keyRate: 8 });
  assert.strictEqual(full8.budget, sum(full8.frames.map((n) => X.motionSlots(n, 8))) + 4);
  // 상한선 30장: 그래도 프레임 합계는 정확, 장수는 30장 이하
  const capped = motionCtx(durs, { energy: ['low', 'high', 'low', 'high'], highlight: [2, 4], drawingBudget: 30 });
  assert.strictEqual(capped.budget, 30);
  const raw = { shots: capped.segments.map((s, i) => ({
    shot: s.index, motion: capped.motion[i],
    drawings: Array.from({ length: capped.motion[i] ? 40 : 3 }, (_, k) => `pose ${k}`),
    exposure: capped.motion[i] ? Array.from({ length: 40 }, (_, k) => [String.fromCharCode(65 + (k % 26)), 4]) : ['A:48', 'B:48', 'C:999'],
  })) };
  const xs = X.normalizeXsheet(raw, capped);
  checkTotals(xs, capped);
  assert.ok(xs.totalDrawings <= 30, `total ${xs.totalDrawings}`);
  assert.ok(xs.notes.some((n) => /예산\(30장\)/.test(n)));
  // 아주 작은 예산 → 움직이는 컷도 멈춤 그림으로 (그래도 컷마다 배경 1 + 셀 1)
  const tiny = motionCtx(durs, { drawingBudget: 8 });
  const tx = X.normalizeXsheet(null, tiny);
  checkTotals(tx, tiny);
  assert.strictEqual(tx.totalDrawings, 8);
  assert.ok(tx.shots.every((s) => s.drawings.length === 1));
});

test('estimate: unique images, backgrounds vs cels, ~30 s each, in-betweens made on the PC', () => {
  const g = motionCtx([6, 8, 6, 8], { energy: ['low', 'high', 'low', 'high'], highlight: [2, 4] });
  const xs = X.normalizeXsheet(null, g);
  const e = X.estimateWork(xs);
  assert.strictEqual(e.bg, 4);
  assert.strictEqual(e.cels, sum(xs.shots.map((s) => s.drawings.length)));
  assert.strictEqual(e.images, e.bg + e.cels);
  assert.strictEqual(e.images, xs.totalDrawings);
  assert.strictEqual(e.minutes, Math.ceil((e.images * 30) / 60));
  assert.strictEqual(e.inbetweens, sum(xs.shots.map((s) => X.motionPairs(s).length)));
  assert.ok(e.motionShots >= 1 && e.motionSeconds > 0);
  assert.deepStrictEqual(xs.estimate, e);
  const t = X.estimateText({ ...e, images: 260, bg: 20, cels: 240, minutes: 130 });
  assert.match(t, /^그림 약 260장 \(배경 20장 \+ 인물 240장\), 예상 약 2\.2시간/);
  assert.match(X.estimateText({ ...e, images: 9, bg: 4, cels: 5, minutes: 5, inbetweens: 0 }), /예상 약 5분/);
});

test('in-between schedule: A for ceil(n/2) frames then A~B for floor(n/2); too different or off → A held', () => {
  const shot = { motion: true, frames: 15, exposure: [{ drawing: 'A', frames: 4 }, { drawing: 'B', frames: 4 }, { drawing: 'A', frames: 3 }, { drawing: 'C', frames: 4 }] };
  assert.deepStrictEqual(X.motionPairs(shot), ['A~B', 'A~C'], 'unordered pairs, each once');
  const all = X.expandExposure(shot, () => true);
  assert.deepStrictEqual(all, ['A', 'A', 'A~B', 'A~B', 'B', 'B', 'A~B', 'A~B', 'A', 'A', 'A~C', 'C', 'C', 'C', 'C']);
  assert.strictEqual(all.length, shot.frames);
  const someHeld = X.expandExposure(shot, (a, b) => X.pairKey(a, b) !== 'A~C');
  assert.deepStrictEqual(someHeld.slice(8, 11), ['A', 'A', 'A'], 'too different → A held for all 3 frames');
  assert.deepStrictEqual(X.expandExposure(shot, () => false), X.frameTable(shot), 'off → plain exposure');
  const held = { ...shot, motion: false };
  assert.deepStrictEqual(X.motionPairs(held), []);
  assert.deepStrictEqual(X.expandExposure(held, () => true), X.frameTable(held), 'held shots get no in-betweens');
});

test('motion prompt: MOTION/HOLD markers, small deltas, layers, budget in images, no studio names', () => {
  const g = motionCtx([6, 8, 6, 8], { energy: ['low', 'high', 'low', 'high'], highlight: [2, 4] });
  const p = X.xsheetPrompt({ ...g, series: { name: 's', episode: 1, characters: [{ name: '하루' }] } });
  assert.match(p, /- shot 2: .*= 192 frames.* MOTION: 48 key slots of 4 frames/);
  assert.match(p, /- shot 1: .* HOLD: 1-4 cels/);
  assert.match(p, /SMALL change from the previous key/);
  assert.match(p, /ONE background plate/);
  assert.match(p, new RegExp(`at most ${g.budget} unique images`));
  assert.match(p, /"bg": \{"prompt_en"/);
  assert.ok(!/ghibli|disney|pixar/i.test(p), 'descriptive style words only');
  const p8 = X.xsheetPrompt({ ...motionCtx([6, 8], { mode: 'full', keyRate: 8 }), series: null });
  assert.match(p8, /key slots of 3 frames/);
  assert.match(p8, /every shot moves/);
});
