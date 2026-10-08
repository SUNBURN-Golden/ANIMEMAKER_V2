'use strict';
// 박자 분석 · 컷 나누기 · 가사 타이밍 · JSON 추출 단위 테스트
const test = require('node:test');
const assert = require('node:assert');
const { analyzeSamples, SR } = require('../src/main/media/audio');
const T = require('../src/main/media/timeline');
const { extractJson } = require('../src/main/ai/json');
const P = require('../src/main/pipeline/prompts');
const X = require('../src/main/pipeline/xsheet');
const { BUILTIN_WORKFLOWS } = require('../src/main/defaults');
const { DEMO_CHARACTER } = require('../src/main/ai/demo');

function synth(bpm, dur, offset = 0.37) {
  const n = Math.floor(dur * SR);
  const s = new Float32Array(n);
  const p = 60 / bpm;
  let k = 0;
  for (let i = 0; i < n; i++) s[i] = 0.05 * Math.sin((2 * Math.PI * 220 * i) / SR);
  for (let t = offset; t < dur; t += p, k++) {
    const st = Math.floor(t * SR);
    const acc = k % 4 === 0 ? 1 : 0.6;
    for (let i = 0; i < SR * 0.25 && st + i < n; i++) {
      const tt = i / SR;
      s[st + i] += acc * 0.8 * Math.exp(-tt * 18) * Math.sin(2 * Math.PI * (60 + 80 * Math.exp(-tt * 30)) * tt);
    }
  }
  return s;
}

test('tempo and beat phase are detected', () => {
  for (const bpm of [92, 120, 128]) {
    const a = analyzeSamples(synth(bpm, 40), bpm);
    assert.ok(Math.abs(a.bpm - bpm) < 2, `bpm ${a.bpm} vs ${bpm}`);
    const p = 60 / bpm;
    for (const b of a.beats.slice(3, 12)) {
      const r = (((b - 0.37) % p) + p) % p;
      assert.ok(Math.min(r, p - r) < 0.04, `beat phase ${b}`);
    }
    assert.ok(Math.abs(a.downbeats[0] - 0.37) < 0.05 || Math.abs(((a.downbeats[0] - 0.37) % (4 * p))) < 0.05, `downbeat ${a.downbeats[0]}`);
  }
});

test('segmentation respects beats, clip count and lengths', () => {
  const a = analyzeSamples(synth(110, 60), 110);
  const parts = [{ index: 1, start: 0, end: 30 }, { index: 2, start: 29, end: a.duration }];
  const lyrics = T.estimateLyricTiming(
    ['하나', '둘셋넷', '다섯 여섯', '일곱', '여덟 아홉', '열', '열하나', '열둘'].map((text, i) => ({ text, part: i < 4 ? 1 : 2 })), parts, a);
  assert.strictEqual(lyrics.length, 8);
  for (let i = 1; i < lyrics.length; i++) assert.ok(lyrics[i].start > lyrics[i - 1].start);
  const segs = T.segmentSong(a, lyrics, parts, { minClips: 10, maxClips: 15, maxLen: 14 });
  assert.ok(segs.length >= 10 && segs.length <= 15, `count ${segs.length}`);
  assert.ok(Math.abs(segs[0].start) < 1e-6 && Math.abs(segs[segs.length - 1].end - a.duration) < 1e-3);
  for (const s of segs) assert.ok(s.duration >= 1 && s.duration <= 14.001);
  for (const s of segs.slice(1)) assert.ok(a.beats.some((b) => Math.abs(b - s.start) < 1e-3));
  const shots = segs.map(() => ({ transition_out: { type: 'flash', beats: 1 } }));
  const tr = T.resolveTransitions(segs, shots, a.beatPeriod);
  assert.strictEqual(tr.length, segs.length - 1);
  assert.ok(tr.every((t) => t.duration <= 0.6 * 14 && (t.type === 'cut') === (t.duration === 0)));
  assert.ok(segs.every((s) => typeof s.level === 'number'), 'numeric energy level for highlight ranking');
});

test('cut counts are for 3-4 minute songs; shorter songs get proportionally fewer cuts', () => {
  assert.deepStrictEqual(T.scaledCutRange(16, 28, 210), { minClips: 16, maxClips: 28 });
  assert.deepStrictEqual(T.scaledCutRange(16, 28, 180), { minClips: 16, maxClips: 28 });
  assert.deepStrictEqual(T.scaledCutRange(16, 28, 90), { minClips: 8, maxClips: 14 });
  assert.deepStrictEqual(T.scaledCutRange(16, 28, 10), { minClips: 2, maxClips: 2 });
});

test('srt/lrc formatting', () => {
  const srt = T.toSrt([{ text: '안녕', start: 1.234, end: 3.5 }]);
  assert.match(srt, /00:00:01,234 --> 00:00:03,500/);
  assert.match(T.toLrc([{ text: 'hi', start: 61.5, end: 63 }], 't'), /\[01:01\.50\]hi/);
});

test('JSON extraction from messy LLM output', () => {
  const o = extractJson('blah ```json\n{"a": 1, "b": [1,2,],}\n``` end', (x) => x.a === 1);
  assert.deepStrictEqual(o, { a: 1, b: [1, 2] });
  const env = extractJson(JSON.stringify({ result: 'ok here {"shots": [{"shot": 1, "drawings": ["Haru runs"], "exposure": ["A:12"]}]} done' }), X.validXsheet);
  assert.strictEqual(env.shots[0].drawings[0], 'Haru runs');
  assert.ok(!X.validXsheet({ shots: [{ action: 'run' }] }), 'a V1 shot list is not a timesheet');
  assert.strictEqual(extractJson('no json here'), undefined);
});

test('plan keeps the series protagonist fixed; drawing prompt carries the locked design verbatim', () => {
  const wf = BUILTIN_WORKFLOWS[0];
  const series = {
    id: 's1', name: '하루의 여름', episode: 3, bible: { art_en: 'hand-drawn cel animation, watercolor backgrounds', notes_en: 'always summer' },
    characters: [{ ...DEMO_CHARACTER, id: 'c1', role: 'protagonist', refs: [] }],
    previous: [{ number: 1, title: '첫 만남', summary_ko: '하루가 바다에서 반디를 만났다.' }, { number: 2, title: '등대', summary_ko: '둘이 등대에 올랐다.' }],
  };
  const raw = {
    title: '세 번째 여름', story: [{ sections: ['Verse 1'], summary_ko: '시작' }],
    guest_characters: [{ name: '하루', appearance_en: 'an adult man with blue hair' }, { name: '반디', appearance_en: 'a glowing firefly' }],
    episode_summary_ko: '하루가 섬으로 간다.', music: { genre: 'pop' },
  };
  const plan = P.normalizePlan(raw, wf, series);
  assert.strictEqual(plan.characters[0].name, '하루');
  assert.ok(plan.characters[0].fixed);
  assert.match(plan.characters[0].appearance_en, /short brown bob/, 'protagonist look comes from the character file, not the LLM');
  assert.ok(!plan.characters.some((c) => /blue hair/.test(c.appearance_en)), 'LLM redesign ignored');
  assert.strictEqual(plan.characters[1].role, 'guest');
  assert.strictEqual(plan.visual_style, series.bible.art_en);
  assert.strictEqual(plan.episode_summary_ko, '하루가 섬으로 간다.');
  assert.ok(P.validPlan({ title: 'x', story: [{}] }) && !P.validPlan({ title: 'x' }));

  const pp = P.planPrompt('', '[Chorus]\n달려가', { duration: 215.4, bpm: 118, downbeats: new Array(105), bars: [{ energy: 0.3 }, { energy: 0.9 }] }, wf, series);
  assert.match(pp, /3:35/);
  assert.match(pp, /\[Chorus\]/);
  assert.match(pp, /You do NOT write lyrics/);
  assert.match(pp, /episode 3/);
  assert.match(pp, /EP2 "등대": 둘이 등대에 올랐다/, 'previous episode summaries for continuity');
  assert.match(pp, /Never rename them/);

  const shot = { shot: 4, characters: ['하루'], scene_en: 'a harbor at dusk', framing_en: 'wide shot', drawings: [{ id: 'A', prompt_en: 'Haru waves' }] };
  const dp = P.composeDrawingPrompt({ plan, series, shot, drawing: shot.drawings[0], wf });
  assert.ok(dp.includes(DEMO_CHARACTER.locked.outfit), 'locked outfit verbatim');
  assert.ok(dp.includes('scarf red #d7263d'), 'palette with hex');
  assert.ok(dp.includes('MUST: always wears the long red scarf'), 'rules');
  assert.ok(dp.includes('NEVER: never change hair color'), 'never rules');
  assert.match(dp, /look EXACTLY like the attached character reference sheets/);
  assert.match(dp, /Haru waves/);
  assert.match(dp, /hand-drawn cel animation, watercolor backgrounds/);
  assert.match(dp, /No text/);
  const scenery = P.composeDrawingPrompt({ plan, series, shot: { ...shot, characters: [] }, drawing: { id: 'A', prompt_en: 'empty beach at dawn' }, wf });
  assert.ok(!scenery.includes('LOCKED DESIGN'), 'no character block for a scenery drawing');
});

test('lyrics: Suno tags, LRC and SRT', () => {
  const { parseLyrics, sectionSummary } = require('../src/main/media/lyrics');
  const a = parseLyrics('[Intro]\n\n[Verse 1]\n비가 내리던 밤\n**우산** 없이\n(oh oh)\n[Chorus]\n달려가\n[Instrumental Break]\n[Bridge]\n브릿지\n[Outro]');
  assert.strictEqual(a.source, 'text');
  assert.deepStrictEqual(a.lines.map((l) => l.text), ['비가 내리던 밤', '우산 없이', '(oh oh)', '달려가', '브릿지']);
  assert.strictEqual(a.lines[0].gapBefore, 1, 'intro before first line');
  assert.strictEqual(a.lines[4].gapBefore, 1, 'instrumental break before bridge');
  assert.strictEqual(a.trailingGaps, 1, 'outro at the end');
  assert.ok(a.lines[3].sectionStart && !a.lines[1].sectionStart);
  assert.match(sectionSummary(a), /\[Chorus\]\n달려가/);
  const b = parseLyrics('[ar:x]\n[00:12.30]첫 줄\n[00:15.8]둘째 줄', 'x.lrc');
  assert.strictEqual(b.source, 'lrc');
  assert.deepStrictEqual(b.timed.map((t) => t.start), [12.3, 15.8]);
  const c = parseLyrics('1\n00:00:01,000 --> 00:00:03,500\n안녕\n\n2\n00:00:04,000 --> 00:00:06,000\n<i>하이</i>\n');
  assert.strictEqual(c.source, 'srt');
  assert.deepStrictEqual(c.timed[1], { text: '하이', start: 4, end: 6 });
  assert.strictEqual(parseLyrics('').source, 'none');
});

test('3-4 minute song → 10-15 cuts of 1-30s on beats', () => {
  const { parseLyrics } = require('../src/main/media/lyrics');
  const lyr = parseLyrics(`[Intro]\n[Verse 1]\n${Array.from({ length: 8 }, (_, i) => `벌스 가사 ${i}`).join('\n')}\n[Chorus]\n${Array.from({ length: 6 }, (_, i) => `후렴 ${i}`).join('\n')}\n[Verse 2]\n${Array.from({ length: 8 }, (_, i) => `둘째 벌스 ${i}`).join('\n')}\n[Chorus]\n${Array.from({ length: 6 }, (_, i) => `후렴 ${i}`).join('\n')}\n[Outro]`);
  for (const [bpm, dur] of [[100, 210], [128, 240]]) {
    const a = analyzeSamples(synth(bpm, dur), bpm);
    const parts = [{ index: 1, start: 0, end: a.duration }];
    const lyrics = T.estimateLyricTiming(lyr.lines, parts, a, { trailingGaps: lyr.trailingGaps })
      .map((l, i) => ({ ...l, sectionStart: lyr.lines[i].sectionStart }));
    assert.ok(lyrics[0].start > 4, 'intro left empty');
    assert.ok(lyrics[lyrics.length - 1].end < a.duration - 4, 'outro left empty');
    for (const pace of ['fast', 'normal', 'slow']) {
      const segs = T.segmentSong(a, lyrics, parts, { minClips: 10, maxClips: 15, minLen: 1, maxLen: 30, pace });
      assert.ok(segs.length >= 10 && segs.length <= 15, `${pace} count ${segs.length}`);
      for (const s of segs) assert.ok(s.duration >= 1 && s.duration <= 30.001, `${pace} len ${s.duration}`);
      for (const s of segs.slice(1)) assert.ok(a.beats.some((b) => Math.abs(b - s.start) < 1e-3));
    }
  }
});
