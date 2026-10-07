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
  assert.match(p, /at most 60 unique drawings/);
  assert.match(p, /never redesign or rename them/);
});
