'use strict';
// 가사 자막 편집 (러너): 줄 수가 바뀌어도 맞춘 시간 지키기 · 줄 전체 바꾸기 · 모양 바꾸기 · 한꺼번에 저장 · 7단계(자막 입히기)
// 파이프라인 전체를 돌리지 않고, '컷이 정해진 뒤' 상태를 직접 만들어서 확인한다.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/main/store');
const { ProjectRunner } = require('../src/main/pipeline/runner');
const { parseLyrics } = require('../src/main/media/lyrics');
const { runFfmpeg, countFrames } = require('../src/main/media/ffmpeg');
const K = require('../src/main/media/keyer');
const demo = require('../src/main/ai/demo');
const SC = require('../src/main/pipeline/subs-core');
const S = require('../src/shared/subtitle-style');

const LYRICS = '[Verse 1]\n첫 번째 줄이에요\n두 번째 줄이에요\n세 번째 줄이에요\n[Chorus]\n후렴 첫 줄\n후렴 둘째 줄';
const TAPS = [[4, 7.5], [8.5, 12], [13, 17.5], [20.5, 24], [25, 29]];
const DURATION = 60;

function newStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am2-subs-'));
  const store = new Store({ userDataDir: path.join(root, 'ud'), documentsDir: path.join(root, 'docs'), downloadsDir: path.join(root, 'dl') });
  return { root, store };
}

/** 파이프라인을 돌리지 않고 '컷이 정해진 뒤' 상태를 만든다 */
function makeProject({ source = 'tap', lyricsText = LYRICS, taps = TAPS, workflow } = {}) {
  const { root, store } = newStore();
  const wf = { ...store.getWorkflow('builtin-cel-wide'), quality: '480p', ...(workflow || {}) };
  const p = store.createProject('테스트', wf, { lyricsText });
  const beats = Array.from({ length: 119 }, (_, i) => 0.5 + i * 0.5);
  p.song = { file: 'music/song.mp3', name: 'song.mp3', duration: DURATION };
  p.music = { song: 'music/song.mp3', analysis: { duration: DURATION, bpm: 120, beatPeriod: 0.5, beats, downbeats: beats.filter((_, i) => i % 4 === 0), bars: [] }, partRanges: [{ index: 1, start: 0, end: DURATION }] };
  const li = p.lyricsInput;
  p.timing = {
    lyrics: li.lines.map((l, i) => ({ text: l.text, part: 1, start: taps[i][0], end: taps[i][1], section: l.section, sectionStart: l.sectionStart })),
    lyricsSource: source,
    segments: [{ index: 1, start: 0, end: 10, lyrics: [0, 1] }, { index: 2, start: 10, end: 20, lyrics: [2] }, { index: 3, start: 20, end: 30, lyrics: [3, 4] }, { index: 4, start: 30, end: 60, lyrics: [] }],
  };
  p.steps = {};
  for (const s of ['music', 'plan', 'timing', 'xsheet', 'drawings', 'render', 'subtitles']) p.steps[s] = { status: 'done' };
  p.status = 'done';
  store.saveProject(p);
  const runner = new ProjectRunner({ store, projectId: p.id });
  return { root, store, p, runner };
}

const isBeat = (t) => Math.abs(t / 0.5 - Math.round(t / 0.5)) < 1e-9;

test('가사 글에서 줄을 하나 끼워 넣어도 맞춘 시간은 그대로, 새 줄은 이웃 사이 박자에', () => {
  const { runner } = makeProject();
  const before = JSON.parse(JSON.stringify(runner.p.timing.lyrics));
  const raw = '[Verse 1]\n첫 번째 줄이에요\n두 번째 줄이에요\n새로 끼워 넣은 줄이에요\n세 번째 줄이에요\n[Chorus]\n후렴 첫 줄\n후렴 둘째 줄';
  const r = runner.updateLyricsText(raw);
  assert.deepStrictEqual({ lost: r.lost, kept: r.kept, added: r.added, mode: r.mode }, { lost: 0, kept: 5, added: 1, mode: 'merge' });
  const lyr = runner.p.timing.lyrics;
  assert.strictEqual(lyr.length, 6);
  assert.deepStrictEqual(lyr.map((l) => l.text), ['첫 번째 줄이에요', '두 번째 줄이에요', '새로 끼워 넣은 줄이에요', '세 번째 줄이에요', '후렴 첫 줄', '후렴 둘째 줄']);
  // 맞춘 줄은 시작·끝 그대로
  for (const [bi, ni] of [[0, 0], [1, 1], [2, 3], [3, 4], [4, 5]]) {
    assert.strictEqual(lyr[ni].start, before[bi].start, `${lyr[ni].text} 시작`);
    assert.strictEqual(lyr[ni].end, before[bi].end, `${lyr[ni].text} 끝`);
  }
  // 새 줄: 두 번째(8.5)와 세 번째(13) 시작 사이, 박자 위, 겹치지 않는 끝
  assert.ok(lyr[2].start > 8.5 && lyr[2].start < 13, `사이: ${lyr[2].start}`);
  assert.ok(isBeat(lyr[2].start), `박자: ${lyr[2].start}`);
  assert.ok(lyr[2].end > lyr[2].start && lyr[2].end <= lyr[3].start - 0.05 + 1e-9, `끝: ${lyr[2].end}`);
  assert.ok(lyr[1].end <= lyr[2].start - 0.05 + 1e-9, '앞 줄 끝은 새 줄 시작 직전까지');
  for (let i = 1; i < lyr.length; i++) assert.ok(lyr[i].start > lyr[i - 1].start, '시작 시간 순');
  assert.strictEqual(runner.p.timing.lyricsSource, 'tap', '맞춘 줄이 있으니 직접 맞춤 유지');
  assert.strictEqual(runner.p.lyricsInput.raw, raw);
  assert.strictEqual(runner.p.lyricsInput.lines.length, 6);
  assert.strictEqual(runner.p.subsStale, true);
  assert.strictEqual(runner.p.steps.subtitles.status, 'pending', '컷은 그대로, 자막만 다시');
  assert.strictEqual(runner.p.steps.timing.status, 'done');
  // 구간 정보는 새 글 기준
  assert.deepStrictEqual(lyr.map((l) => l.section), ['Verse 1', 'Verse 1', 'Verse 1', 'Verse 1', 'Chorus', 'Chorus']);
  // 컷이 가리키는 가사 줄 번호도 다시 계산 (끼워 넣은 줄 때문에 한 칸씩 밀린다)
  assert.deepStrictEqual(runner.p.timing.segments.map((s) => s.lyrics), [[0, 1], [1, 2, 3], [4, 5], []], '두 번째 줄(8.5~12초)은 10~20초 컷에도 걸쳐 있다');
  // 디스크에도 저장됐다
  assert.strictEqual(runner.store.loadProject(runner.p.id).timing.lyrics.length, 6);
});

test('줄을 지우거나(lost 알림) 고쳐 쓰면서 동시에 늘려도(닮은 줄 묶기) 시간을 지킨다', () => {
  const { runner } = makeProject();
  const before = JSON.parse(JSON.stringify(runner.p.timing.lyrics));
  // 가운데 줄 지우기
  const del = '[Verse 1]\n첫 번째 줄이에요\n세 번째 줄이에요\n[Chorus]\n후렴 첫 줄\n후렴 둘째 줄';
  assert.deepStrictEqual(runner.updateLyricsText(del, null, { dryRun: true }), { lost: 1, kept: 4, added: 0, mode: 'merge' });
  assert.strictEqual(runner.p.timing.lyrics.length, 5, 'dryRun 은 아무것도 바꾸지 않는다');
  assert.strictEqual(runner.p.lyricsInput.raw, LYRICS);
  const r = runner.updateLyricsText(del);
  assert.strictEqual(r.lost, 1);
  const lyr = runner.p.timing.lyrics;
  assert.strictEqual(lyr.length, 4);
  assert.deepStrictEqual(lyr.map((l) => [l.start, l.end]), [before[0], before[2], before[3], before[4]].map((l) => [l.start, l.end]));
  assert.strictEqual(runner.p.timing.lyricsSource, 'tap');

  // 오타를 고치면서 끝에 한 줄 더 붙이기 → 고친 줄은 같은 줄로 묶여 시간이 남는다
  const { runner: r2 } = makeProject();
  const raw2 = '[Verse 1]\n첫 번째 줄이에요\n두 번째 줄입니다\n세 번째 줄이에요\n[Chorus]\n후렴 첫 줄\n후렴 둘째 줄\n마지막에 붙인 줄';
  const res = r2.updateLyricsText(raw2);
  assert.deepStrictEqual({ lost: res.lost, kept: res.kept, added: res.added }, { lost: 0, kept: 5, added: 1 });
  const l2 = r2.p.timing.lyrics;
  assert.strictEqual(l2[1].text, '두 번째 줄입니다');
  assert.strictEqual(l2[1].start, 8.5, '고친 줄도 시간을 지킨다');
  assert.strictEqual(l2[1].end, 12);
  assert.ok(l2[5].start > 25, '끝에 붙인 줄은 마지막 줄 뒤');
  assert.ok(l2[5].end > l2[5].start && l2[5].end <= DURATION);
  assert.ok(isBeat(l2[5].start));

  // 맨 앞에 끼워 넣기
  const { runner: r3 } = makeProject();
  r3.updateLyricsText(`[Intro] 맨 앞 줄\n${LYRICS}`);
  const l3 = r3.p.timing.lyrics;
  assert.strictEqual(l3[0].text, '맨 앞 줄');
  assert.ok(l3[0].start >= 0 && l3[0].start < 4, `맨 앞: ${l3[0].start}`);
  assert.strictEqual(l3[1].start, 4);
  assert.ok(l3[0].end <= l3[1].start);
});

test('글을 몽땅 바꾸면 새로 계산(자동 추정), 시간 든 .lrc 를 넣으면 그 시간', () => {
  const { runner } = makeProject();
  const r = runner.updateLyricsText('[Verse]\n완전히 다른 노래\n전혀 다른 가사\n아무 관계 없는 줄');
  assert.strictEqual(r.mode, 'recompute');
  assert.strictEqual(r.lost, 5, '직접 맞춘 5줄의 시간은 모두 사라진다');
  assert.strictEqual(runner.p.timing.lyricsSource, 'auto');
  assert.strictEqual(runner.p.timing.lyrics.length, 3);
  assert.ok(runner.p.timing.lyrics.every((l) => l.end > l.start));
  const { runner: r2 } = makeProject();
  const lrc = '[00:03.00]첫 줄\n[00:06.50]둘째 줄\n[00:10.00]셋째 줄';
  const res = r2.updateLyricsText(lrc, 'x.lrc');
  assert.strictEqual(res.mode, 'timed');
  assert.strictEqual(res.lost, 5);
  assert.strictEqual(r2.p.timing.lyricsSource, 'lrc');
  assert.deepStrictEqual(r2.p.timing.lyrics.map((l) => l.start), [3, 6.5, 10]);
  // 맞춘 시간이 없으면(자동 추정) 줄 수가 달라질 때 예전처럼 새로 계산
  const { runner: r3 } = makeProject({ source: 'auto' });
  const auto = r3.updateLyricsText(`${LYRICS}\n한 줄 더`);
  assert.deepStrictEqual({ mode: auto.mode, lost: auto.lost }, { mode: 'recompute', lost: 0 }, '맞춘 적 없으면 잃을 것도 없다');
  assert.strictEqual(r3.p.timing.lyricsSource, 'auto');
  assert.strictEqual(r3.p.timing.lyrics.length, 6);
});

test('줄 수가 같으면 시간은 그대로, 글만 바뀐다 (숨김 여부는 글이 바뀐 줄만 새로 읽는다)', () => {
  const { runner } = makeProject();
  const r = runner.updateLyricsText('[Verse 1]\n첫 번째 줄이었어요\n두 번째 줄이에요\n(세 번째)\n[Chorus]\n후렴 첫 줄\n후렴 둘째 줄');
  assert.strictEqual(r.mode, 'same');
  const lyr = runner.p.timing.lyrics;
  assert.deepStrictEqual(lyr.map((l) => l.start), TAPS.map((t) => t[0]));
  assert.strictEqual(lyr[0].text, '첫 번째 줄이었어요');
  assert.strictEqual(lyr[2].hidden, true, '(…) 만 있는 줄은 숨김');
  assert.ok(!lyr[0].hidden);
  assert.strictEqual(runner.p.timing.lyricsSource, 'tap');
  // 다시 보이게 되도록 글을 고치면 숨김이 풀린다
  runner.updateLyricsText('[Verse 1]\n첫 번째 줄이었어요\n두 번째 줄이에요\n세 번째 줄이 되었어요\n[Chorus]\n후렴 첫 줄\n후렴 둘째 줄');
  assert.ok(!runner.p.timing.lyrics[2].hidden);
});

test('직접 숨긴 줄과 직접 정한 끝(endLocked)은 가사 글을 다시 저장해도 · 줄을 끼워 넣어도 남는다', () => {
  const { runner } = makeProject();
  const lines = runner.p.timing.lyrics.map((l) => ({ ...l }));
  lines[1].hidden = true;
  lines[3].endLocked = true;
  lines[3].end = 22;
  runner.setLyricLines(lines);
  // 원문 그대로 다시 저장 (같은 줄 수)
  runner.updateLyricsText(runner.p.lyricsInput.raw);
  assert.strictEqual(runner.p.timing.lyrics[1].hidden, true, '글이 그대로인 줄은 숨김을 지킨다');
  assert.strictEqual(runner.p.timing.lyrics[3].endLocked, true);
  assert.strictEqual(runner.p.timing.lyrics[3].end, 22);
  // 줄을 끼워 넣어도
  const raw = runner.p.lyricsInput.raw.replace('세 번째 줄이에요', '끼워 넣은 줄\n세 번째 줄이에요');
  const r = runner.updateLyricsText(raw);
  assert.strictEqual(r.mode, 'merge');
  const lyr = runner.p.timing.lyrics;
  assert.strictEqual(lyr[1].hidden, true);
  const idx = lyr.findIndex((l) => l.text === '후렴 첫 줄');
  assert.strictEqual(lyr[idx].endLocked, true);
  assert.strictEqual(lyr[idx].end, 22);
});

test('진행 중에는: 그림 그리는 중에도(컷이 정해진 뒤) 고칠 수 있고, 자막 입히는 중에는 막힌다', () => {
  const { runner } = makeProject();
  runner.running = true;
  runner.p.steps.drawings.status = 'running';
  runner.p.currentStep = 'drawings';
  assert.doesNotThrow(() => runner.updateLyricsText(`${LYRICS}\n한 줄 더`), '그림 그리는 중');
  assert.doesNotThrow(() => runner.setLyricLines(runner.p.timing.lyrics.map((l) => ({ ...l }))));
  assert.strictEqual(runner.p.steps.subtitles.status, 'pending');
  runner.p.steps.subtitles.status = 'running';
  assert.throws(() => runner.updateLyricsText(LYRICS), /자막을 영상에 입히는 중/);
  assert.throws(() => runner.setLyricLines([]), /자막을 영상에 입히는 중/);
  assert.throws(() => runner.setSubtitleStyle({ preset: 'pop' }), /자막을 영상에 입히는 중/);
  assert.throws(() => runner.saveSubtitles({ style: { preset: 'pop' } }), /자막을 영상에 입히는 중/);
  // 컷이 아직 안 정해졌고 가사 맞추기 대기도 아니면 예전처럼 막힌다
  const { runner: r2 } = makeProject();
  r2.running = true;
  r2.p.steps.timing.status = 'running';
  assert.throws(() => r2.updateLyricsText(LYRICS), /진행 중에는/);
  r2.p.waiting = { key: 'review:lyrics' };
  assert.doesNotThrow(() => r2.updateLyricsText(`${LYRICS}\n한 줄 더`), '가사 맞추기 대기 중에는 고칠 수 있다');
});

test('setLyricLines: 검사 · 시간 순 · 끝 > 시작 · 노래 길이 안 · 원문 다시 만들기 · 컷 번호', () => {
  const { runner } = makeProject();
  const out = runner.setLyricLines([
    { text: '  세 번째  줄  ', start: 30, end: 33, section: 'Chorus', sectionStart: true },
    { text: '   ', start: 5, end: 6 }, // 빈 글은 버린다
    { text: '첫 줄\n이어서 둘째 줄', start: 4, end: 7, hidden: false, section: 'Verse 1', sectionStart: true },
    { text: '끝을 직접 정한 줄', start: 10, end: 14, endLocked: true },
    { text: '끝이 시작보다 빠른 줄', start: 20, end: 15 },
    { text: '끝이 없는 줄', start: 40 },
    { text: '노래 밖으로 나간 줄', start: 999, end: 1000 },
    null,
    { text: '숨긴 줄', start: 50, end: 52, hidden: true },
  ]);
  assert.strictEqual(out, runner.p.timing.lyrics);
  assert.deepStrictEqual(out.map((l) => l.text), ['첫 줄\n이어서 둘째 줄', '끝을 직접 정한 줄', '끝이 시작보다 빠른 줄', '세 번째 줄', '끝이 없는 줄', '숨긴 줄', '노래 밖으로 나간 줄']);
  for (let i = 0; i < out.length; i++) {
    assert.ok(out[i].end > out[i].start, `${out[i].text}: 끝 > 시작`);
    assert.ok(out[i].end <= DURATION && out[i].start < DURATION, `${out[i].text}: 노래 길이 안`);
    if (i) assert.ok(out[i].start >= out[i - 1].start, '시간 순');
    if (i) assert.ok(out[i - 1].end <= out[i].start + 1e-9, `${out[i - 1].text} 은(는) 다음 줄 시작 전에 끝난다`);
  }
  assert.strictEqual(out[1].end, 14, '직접 정한 끝은 그대로');
  assert.strictEqual(out[1].endLocked, true);
  assert.ok(out[2].end > 20 && out[2].end <= 30 - 0.05 + 1e-9, `끝이 시작보다 빠르면 다음 줄 직전까지: ${out[2].end}`);
  assert.ok(out[4].end - out[4].start <= 7.0001, '끝이 없으면 최대 7초');
  assert.strictEqual(out[5].hidden, true);
  assert.strictEqual(out[0].hidden, false, '직접 보이게 한 줄은 false 로 남는다');
  assert.ok(!('hidden' in out[1]));
  assert.ok(out[6].start <= DURATION - 0.1 + 1e-9);
  assert.ok(out.every((l) => l.part === 1 && typeof l.section === 'string' && typeof l.sectionStart === 'boolean'));
  // 구간: 안 적은 줄은 앞 줄 구간을 이어받는다
  assert.deepStrictEqual(out.map((l) => l.section), ['Verse 1', 'Verse 1', 'Verse 1', 'Chorus', 'Chorus', 'Chorus', 'Chorus']);
  // 직접 맞춤 + 원문을 줄에서 다시 만들었다 (텍스트 칸과 어긋나지 않게)
  assert.strictEqual(runner.p.timing.lyricsSource, 'tap');
  assert.strictEqual(runner.p.lyricsInput.raw, `[Verse 1]\n첫 줄⏎이어서 둘째 줄\n끝을 직접 정한 줄\n끝이 시작보다 빠른 줄\n\n[Chorus]\n세 번째 줄\n끝이 없는 줄\n숨긴 줄\n노래 밖으로 나간 줄`);
  assert.strictEqual(runner.p.lyricsInput.lines.length, out.length);
  assert.deepStrictEqual(parseLyrics(runner.p.lyricsInput.raw).lines.map((l) => l.text), out.map((l) => l.text), '다시 읽어도 같은 줄');
  assert.strictEqual(runner.p.lyricsInput.source, 'text');
  assert.strictEqual(runner.p.lyricsInput.timed, null);
  assert.strictEqual(runner.p.subsStale, true);
  assert.strictEqual(runner.p.steps.subtitles.status, 'pending');
  // 컷의 가사 번호도 다시 계산: 겹치는 시간이 0.25초보다 길어야 하고, 숨긴 줄(5번)은 뺀다
  assert.deepStrictEqual(runner.p.timing.segments.map((s) => s.lyrics), [[0], [1], [2], [3, 4]]);
  // 디스크에 저장됐다
  const disk = runner.store.loadProject(runner.p.id);
  assert.strictEqual(disk.timing.lyrics.length, out.length);
  assert.strictEqual(disk.lyricsInput.raw, runner.p.lyricsInput.raw);
  // 잘못된 입력
  assert.throws(() => runner.setLyricLines('abc'), /올바르지/);
  assert.throws(() => runner.setLyricLines(undefined), /올바르지/);
  // 빈 목록 = 모두 지움
  assert.deepStrictEqual(runner.setLyricLines([]), []);
  assert.strictEqual(runner.p.lyricsInput.raw, '');
});

test('setLyricLines: 시작만 주면 앞 줄 끝에서 이어붙이고, 단어 시간(words)은 글·시작이 그대로일 때만 이어받는다', () => {
  const { runner } = makeProject();
  runner.p.timing.lyrics[0].words = [{ text: '첫', start: 4, end: 5 }];
  const out = runner.setLyricLines([
    { text: '첫 번째 줄이에요', start: 4, end: 7.5 },
    { text: '시작이 없는 줄', end: 12 }, // start 없음 → 앞 줄 끝(7.5)
    { text: '두 번째 줄이에요', start: 8.5, end: 12 },
  ]);
  assert.deepStrictEqual(out[0].words, [{ text: '첫', start: 4, end: 5 }]);
  assert.strictEqual(out[1].start, 7.5);
  const out2 = runner.setLyricLines([{ text: '첫 번째 줄이에요(고침)', start: 4, end: 7.5 }]);
  assert.ok(!('words' in out2[0]), '글이 바뀌면 단어 시간은 버린다');
});

test('setSubtitleStyle: 정규화해서 합치고, 고침 표시, 7단계만 대기, 시리즈에도 저장', () => {
  const { runner, store } = makeProject();
  runner.p.steps.subtitles.status = 'done';
  const style = runner.setSubtitleStyle({ preset: 'yellow' });
  assert.strictEqual(style.preset, 'yellow');
  assert.strictEqual(style.font, 'dohyeon');
  assert.deepStrictEqual(style, S.normalizeStyle(style), '돌려주는 것은 정규화된 스타일');
  assert.deepStrictEqual(runner.p.workflow.subtitles, style, 'workflow.subtitles 에 저장');
  assert.strictEqual(runner.p.subsStale, true);
  assert.strictEqual(runner.p.steps.subtitles.status, 'pending');
  assert.strictEqual(runner.p.steps.render.status, 'done', '다른 단계는 건드리지 않는다');
  assert.deepStrictEqual(store.loadProject(runner.p.id).workflow.subtitles, style, '디스크에도');
  // 일부 칸만: 나머지는 지금 값 그대로
  const top = runner.setSubtitleStyle({ position: 'top', size: 'xl' });
  assert.strictEqual(top.position, 'top');
  assert.strictEqual(top.size, 'xl');
  assert.strictEqual(top.color, '#ffe14d');
  assert.strictEqual(top.preset, 'custom');
  // 프리셋을 바꿔도 위치는 그대로
  assert.strictEqual(runner.setSubtitleStyle({ preset: 'pop' }).position, 'top');
  assert.strictEqual(runner.setSubtitleStyle({ enabled: false }).enabled, false);
  assert.strictEqual(runner.setSubtitleStyle({ enabled: true, marginPct: 12 }).marginPct, 12);
  // 엉터리 값은 기본값으로
  const bad = runner.setSubtitleStyle({ font: 'comic', sizeScale: 99, color: 'zzz', size: 'huge', bogus: 1 });
  assert.strictEqual(bad.font, 'jua', '틀린 글꼴은 지금 글꼴을 유지');
  assert.strictEqual(bad.sizeScale, 2, '숫자는 범위 안으로');
  assert.strictEqual(bad.color, '#ff6fb5', '틀린 색은 지금 색을 유지');
  assert.strictEqual(bad.size, 'l');
  assert.ok(!('bogus' in bad) && !('bogus' in runner.p.workflow.subtitles));
  // 파이프라인이 다른 단계를 돌고 있어도 가능
  runner.running = true;
  runner.p.steps.drawings.status = 'running';
  assert.doesNotThrow(() => runner.setSubtitleStyle({ preset: 'basic' }));
});

test('setSubtitleStyle: 옛 형식 프로젝트(예전 workflow.subtitles) 위에서 바꾸면 옛 칸이 사라지고 새 형식이 된다', () => {
  const { runner } = makeProject();
  runner.p.workflow.subtitles = { enabled: true, sizePct: 4.6, color: 'yellow', box: false, marginPct: 8 };
  const cur = runner._subtitleStyle();
  assert.strictEqual(cur.color, '#ffe14d');
  assert.strictEqual(cur.font, 'system', '예전 모양 그대로');
  assert.strictEqual(S.sizeFor(cur, 854, 480), Math.round(0.046 * 480));
  const next = runner.setSubtitleStyle({ size: 'l' });
  assert.ok(!('sizePct' in runner.p.workflow.subtitles) && !('box' in runner.p.workflow.subtitles && typeof runner.p.workflow.subtitles.box === 'boolean'));
  assert.strictEqual(next.color, '#ffe14d', '다른 칸은 그대로');
  assert.strictEqual(next.font, 'system');
  assert.strictEqual(next.size, 'l');
});

test('applyToSeries: series.subtitleStyle 에 저장하고, 새 에피소드는 그 모양을 자기 사본으로 시작한다', async () => {
  const { store } = newStore();
  const { series } = await demo.createDemoSeries(store);
  const wf = { ...store.getWorkflow('builtin-cel-wide'), quality: '480p' };
  const ep1 = store.createProject('', wf, { lyricsText: LYRICS }, { seriesId: series.id });
  assert.deepStrictEqual(ep1.workflow.subtitles, { enabled: true, preset: 'basic' }, '시리즈 모양이 없으면 워크플로우 것 그대로');
  assert.strictEqual(store.series.get(series.id).subtitleStyle, null);
  const runner = new ProjectRunner({ store, projectId: ep1.id });
  runner.p.steps = { timing: { status: 'done' }, subtitles: { status: 'done' } };
  runner.p.timing = { lyrics: [], segments: [] };
  // 이 에피소드만
  runner.setSubtitleStyle({ preset: 'box' });
  assert.strictEqual(store.series.get(series.id).subtitleStyle, null, 'applyToSeries 가 없으면 시리즈는 그대로');
  // 시리즈 전체에
  runner.setSubtitleStyle({ preset: 'storybook', enabled: false }, { applyToSeries: true });
  const saved = store.series.get(series.id).subtitleStyle;
  assert.strictEqual(saved.preset, 'storybook');
  assert.strictEqual(saved.font, 'gaegu');
  assert.ok(!('enabled' in saved), '켜기/끄기는 에피소드마다');
  assert.deepStrictEqual(saved, S.normalizeStyle(saved, {}) && (({ enabled, ...r }) => r)(S.normalizeStyle(saved)), '정규화된 모양');
  // 다음 에피소드는 시리즈 모양으로 시작 (자기 사본)
  const ep2 = store.createProject('', wf, { lyricsText: LYRICS }, { seriesId: series.id });
  assert.strictEqual(ep2.workflow.subtitles.preset, 'storybook');
  assert.strictEqual(ep2.workflow.subtitles.enabled, true);
  assert.notStrictEqual(ep2.workflow.subtitles, saved);
  assert.strictEqual(S.normalizeStyle(ep2.workflow.subtitles).font, 'gaegu');
  // 워크플로우에서 자막을 끈 설정은 존중
  const ep3 = store.createProject('', { ...wf, subtitles: { enabled: false, preset: 'basic' } }, { lyricsText: LYRICS }, { seriesId: series.id });
  assert.strictEqual(ep3.workflow.subtitles.enabled, false);
  assert.strictEqual(ep3.workflow.subtitles.preset, 'storybook');
  // 에피소드 사본을 고쳐도 시리즈는 그대로
  const r3 = new ProjectRunner({ store, projectId: ep3.id });
  r3.p.steps = { timing: { status: 'done' }, subtitles: { status: 'done' } };
  r3.p.timing = { lyrics: [], segments: [] };
  r3.setSubtitleStyle({ preset: 'minimal' });
  assert.strictEqual(store.series.get(series.id).subtitleStyle.preset, 'storybook');
  // 시리즈 없는 작업에서 applyToSeries 를 켜도 오류가 아니다
  const { runner: lone } = makeProject();
  assert.doesNotThrow(() => lone.setSubtitleStyle({ preset: 'pop' }, { applyToSeries: true }));
});

test('saveSubtitles: 모양 + 줄을 한꺼번에, 질문 없이 고침 표시만 (lost = 사라진 맞춘 줄)', () => {
  const { runner } = makeProject();
  const lines = runner.p.timing.lyrics.map((l) => ({ ...l }));
  lines.splice(2, 1); // 한 줄 지움
  lines[0].text = '고친 첫 줄';
  const res = runner.saveSubtitles({ style: { preset: 'pop', position: 'middle' }, lines });
  assert.strictEqual(res.style.preset, 'pop');
  assert.strictEqual(res.style.position, 'middle');
  assert.strictEqual(res.lost, 1, '지운 줄의 맞춘 시간');
  assert.strictEqual(res.lines.length, 4);
  assert.strictEqual(res.lines[0].text, '고친 첫 줄');
  assert.strictEqual(res.lines, runner.p.timing.lyrics);
  assert.deepStrictEqual(runner.p.workflow.subtitles, res.style);
  assert.strictEqual(runner.p.subsStale, true);
  assert.strictEqual(runner.p.steps.subtitles.status, 'pending');
  assert.strictEqual(runner.p.timing.lyricsSource, 'tap');
  assert.strictEqual(runner.p.status, 'done', '프로젝트 상태는 건드리지 않는다 (다시 만들기는 부른 쪽이)');
  // 글만 고치면 lost 0
  const same = runner.saveSubtitles({ lines: runner.p.timing.lyrics.map((l) => ({ ...l, text: `${l.text}!` })) });
  assert.strictEqual(same.lost, 0);
  // 모양만
  const onlyStyle = runner.saveSubtitles({ style: { size: 'xl' } });
  assert.strictEqual(onlyStyle.style.size, 'xl');
  assert.strictEqual(onlyStyle.lines.length, 4);
  // 아무것도 없으면 지금 상태만 돌려준다
  runner.p.subsStale = false;
  const none = runner.saveSubtitles({});
  assert.strictEqual(runner.p.subsStale, false);
  assert.strictEqual(none.style.size, 'xl');
  assert.strictEqual(runner.saveSubtitles().lost, 0);
  // 시리즈 전체에도
  const { runner: r2 } = makeProject();
  assert.doesNotThrow(() => r2.saveSubtitles({ style: { preset: 'box' }, applyToSeries: true }));
});

test('saveSubtitles: 하나라도 잘못되면 아무것도 바꾸지 않는다', () => {
  const { runner } = makeProject();
  const before = JSON.stringify([runner.p.workflow.subtitles, runner.p.timing.lyrics, runner.p.lyricsInput.raw]);
  assert.throws(() => runner.saveSubtitles({ style: { preset: 'pop' }, lines: 'abc' }), /올바르지/);
  assert.strictEqual(JSON.stringify([runner.p.workflow.subtitles, runner.p.timing.lyrics, runner.p.lyricsInput.raw]), before);
  assert.strictEqual(runner.p.subsStale, undefined);
});

test('updateLyrics(탭 저장): 같은 글인 줄의 hidden · endLocked · words 를 이어받는다', () => {
  const { runner } = makeProject();
  const cur = runner.p.timing.lyrics;
  cur[1].hidden = true;
  cur[2].endLocked = true;
  cur[2].end = 18;
  cur[3].words = [{ text: '세', start: 20.5, end: 21 }];
  // 탭 화면은 text/part/section/sectionStart/start/end 만 돌려준다
  const tapped = cur.map((l, i) => ({ text: l.text, part: 1, section: l.section, sectionStart: l.sectionStart, start: l.start + 0.2, end: (i === 2 ? l.start + 3 : l.end) + 0.2 }));
  runner.updateLyrics(tapped);
  const lyr = runner.p.timing.lyrics;
  assert.strictEqual(lyr[1].hidden, true);
  assert.strictEqual(lyr[0].hidden, undefined);
  assert.strictEqual(lyr[2].endLocked, true);
  assert.strictEqual(lyr[2].end, 18, '직접 정한 끝은 시작이 조금 바뀌어도 지킨다');
  assert.deepStrictEqual(lyr[3].words, [{ text: '세', start: 20.5, end: 21 }]);
  assert.strictEqual(lyr[0].start, 4.2);
  assert.strictEqual(runner.p.timing.lyricsSource, 'tap');
  assert.strictEqual(runner.p.subsStale, true);
  assert.deepStrictEqual(runner.p.timing.segments[0].lyrics, [0, 1].filter((i) => i !== 1), '숨긴 줄은 컷 번호에서 빠진다');
  // 시작이 직접 정한 끝보다 뒤로 밀리면 끝은 새로 정한 값
  const moved = lyr.map((l, i) => ({ text: l.text, part: 1, start: i === 2 ? 19 : l.start, end: i === 2 ? 22 : l.end }));
  runner.updateLyrics(moved);
  assert.strictEqual(runner.p.timing.lyrics[2].end, 22);
  // 이전 같은 순서 줄의 구간 정보(예전 동작)
  assert.strictEqual(runner.p.timing.lyrics[3].section, 'Chorus');
  // 탭 화면에 숨긴 줄을 안 보여 주고 보이는 줄만 보내도, 숨긴 줄은 원래 시간으로 남는다
  const hidBefore = { ...runner.p.timing.lyrics.find((l) => l.hidden) };
  const visibleOnly = runner.p.timing.lyrics.filter((l) => !l.hidden).map((l) => ({ text: l.text, part: 1, start: l.start + 0.1, end: l.end + 0.1 }));
  assert.strictEqual(visibleOnly.length, 4);
  runner.updateLyrics(visibleOnly);
  assert.strictEqual(runner.p.timing.lyrics.length, 5, '숨긴 줄이 사라지지 않는다');
  const hid = runner.p.timing.lyrics.find((l) => l.hidden);
  assert.deepStrictEqual([hid.text, hid.start, hid.end], [hidBefore.text, hidBefore.start, hidBefore.end], '원래 시간 그대로');
  assert.deepStrictEqual(runner.p.timing.lyrics.map((l) => l.start), [...runner.p.timing.lyrics.map((l) => l.start)].sort((a, b) => a - b), '시간 순');
});

test('IPC 연결: proj:setSubtitleStyle · setLyricLines · saveSubtitles (인자를 그대로 넘긴다)', () => {
  const handlers = {};
  const calls = [];
  const runner = {
    setSubtitleStyle: (...a) => { calls.push(['style', ...a]); return 'S'; },
    setLyricLines: (...a) => { calls.push(['lines', ...a]); return 'L'; },
    saveSubtitles: (...a) => { calls.push(['save', ...a]); return 'V'; },
  };
  require('../src/main/ipc/subs')((ch, fn) => { handlers[ch] = fn; }, { store: null, getRunner: (id) => { calls.push(['id', id]); return runner; } });
  assert.deepStrictEqual(Object.keys(handlers).sort(), ['proj:saveSubtitles', 'proj:setLyricLines', 'proj:setSubtitleStyle']);
  assert.strictEqual(handlers['proj:setSubtitleStyle']('p1', { preset: 'pop' }, { applyToSeries: true }), 'S');
  assert.strictEqual(handlers['proj:setSubtitleStyle']('p1', { preset: 'pop' }), 'S');
  assert.strictEqual(handlers['proj:setLyricLines']('p1', [{ text: 'a' }]), 'L');
  assert.strictEqual(handlers['proj:saveSubtitles']('p1', { style: {} }), 'V');
  assert.strictEqual(handlers['proj:saveSubtitles']('p1'), 'V');
  assert.deepStrictEqual(calls.filter((c) => c[0] !== 'id'), [
    ['style', { preset: 'pop' }, { applyToSeries: true }], ['style', { preset: 'pop' }, {}], ['lines', [{ text: 'a' }]], ['save', { style: {} }], ['save', {}]]);
});

// ---------- 7단계 (자막 입히기) ----------

/** 짧은 깨끗한 원본 + 7단계 입력을 갖춘 프로젝트 (480p 가로 = 854x480, 3초) */
async function makeBurnable(extra = {}) {
  const made = makeProject(extra);
  const { runner } = made;
  const p = runner.p;
  const dir = runner.dir;
  fs.mkdirSync(path.join(dir, 'output'), { recursive: true });
  const clean = path.join(dir, 'output', 'animation_clean.mp4');
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=0x5c9a55:s=854x480:d=3:r=24', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clean]);
  p.output = { clean: 'output/animation_clean.mp4' };
  p.xsheet = { totalFrames: 72, fps: 24, mode: 'limited', keyRate: 6, layers: false, shots: [], transitions: [], totalDrawings: 0, budget: 0 };
  p.plan = { title: '테스트 영상', logline: '한 줄', concept: '개념', episode_summary_ko: '요약', characters: [], story: [], music: { genre: '', mood: '' } };
  p.timing.lyrics = [
    { text: '보이는 첫 줄', part: 1, start: 0.3, end: 1.2, section: 'Verse', sectionStart: true },
    { text: '(후렴)', part: 1, start: 1.3, end: 1.8, section: 'Verse', sectionStart: false, hidden: true },
    { text: '보이는 둘째 줄', part: 1, start: 1.9, end: 2.8, section: 'Verse', sectionStart: false },
    { text: '3초 뒤에 시작하는 줄', part: 1, start: 3.5, end: 4.5, section: 'Verse', sectionStart: false },
  ];
  made.store.saveProject(p);
  runner.abort = new AbortController();
  runner.p.steps.subtitles = { status: 'running' };
  made.clean = clean;
  return made;
}
const pngFile = async (dir, name = 'sub.png') => {
  const file = path.join(dir, name);
  const px = new Uint8ClampedArray(120 * 40 * 4);
  for (let i = 0; i < 120 * 40; i++) px.set([255, 255, 255, 255], i * 4);
  await K.writePng(file, px, 120, 40);
  return file;
};

test('7단계: 숨긴 줄은 영상 · SRT · LRC 에서 빠지고, 정규화한 스타일과 log 를 렌더러에 넘기고, 걸린 시간을 기록한다', { timeout: 120000 }, async () => {
  const { runner, clean } = await makeBurnable();
  const sub = await pngFile(runner.dir);
  let call = null;
  runner.renderSubtitles = async (lyrics, o) => {
    call = { lyrics, o };
    return lyrics.map((l, i) => ({ file: sub, start: l.start, end: l.end, x: 100 + i * 50, y: 300, fade: o.style.fade }));
  };
  runner.p.workflow.subtitles = { enabled: true, preset: 'yellow' };
  const logs = [];
  runner.on('log', (l) => logs.push(l.line));
  await runner.step_subtitles();
  assert.deepStrictEqual(call.lyrics.map((l) => l.text), ['보이는 첫 줄', '보이는 둘째 줄'], '숨긴 줄 · 영상보다 뒤에 시작하는 줄 제외');
  assert.deepStrictEqual({ w: call.o.w, h: call.o.h }, { w: 854, h: 480 });
  assert.deepStrictEqual(call.o.style, S.normalizeStyle({ preset: 'yellow' }), '정규화된 스타일');
  assert.strictEqual(typeof call.o.log, 'function');
  assert.ok(call.o.outDir.endsWith(path.join('work', 'subs')));
  const out = runner.p.output;
  assert.ok(out.video.endsWith('테스트 영상.mp4'));
  const final = path.join(runner.dir, out.video);
  assert.ok(Math.abs((await countFrames(final)) - 72) <= 1, '길이는 그대로');
  assert.ok(fs.statSync(final).ino !== fs.statSync(clean).ino, '자막을 입힌 영상은 다른 파일');
  const srt = fs.readFileSync(path.join(runner.dir, out.srt), 'utf8');
  assert.match(srt, /보이는 첫 줄/);
  assert.match(srt, /3초 뒤에 시작하는 줄/, 'SRT 에는 영상 밖 줄도 보이는 줄이면 들어간다');
  assert.doesNotMatch(srt, /후렴/);
  assert.doesNotMatch(fs.readFileSync(path.join(runner.dir, out.lrc), 'utf8'), /후렴/);
  assert.strictEqual(runner.p.subsStale, false);
  assert.strictEqual(runner.p.subsFallback, false);
  assert.ok(Number.isFinite(runner.p.steps.subtitles.lastMs) && runner.p.steps.subtitles.lastMs > 0, `lastMs ${runner.p.steps.subtitles.lastMs}`);
  assert.ok(!logs.some((l) => /기본 방식/.test(l)));
});

test('7단계: 옛 형식 스타일도 같은 모양으로 읽고, 렌더러가 없으면 ASS 대체 + p.subsFallback + 눈에 띄는 알림', { timeout: 120000 }, async () => {
  const { runner } = await makeBurnable();
  const legacy = { enabled: true, sizePct: 4.6, color: 'yellow', box: false, marginPct: 8 };
  runner.p.workflow.subtitles = legacy;
  let style = null;
  const sub = await pngFile(runner.dir);
  runner.renderSubtitles = async (lyrics, o) => { style = o.style; return lyrics.map((l) => ({ file: sub, start: l.start, end: l.end, x: 10, y: 10 })); };
  await runner.step_subtitles();
  assert.deepStrictEqual(style, S.normalizeStyle(legacy, { w: 854, h: 480 }));
  assert.strictEqual(style.font, 'system');
  assert.strictEqual(style.color, '#ffe14d');
  assert.strictEqual(S.sizeFor(style, 854, 480), Math.round(0.046 * 480), '예전과 같은 글자 크기');
  assert.strictEqual(runner.p.subsFallback, false);
  // 렌더러 없음 → ASS
  runner.renderSubtitles = null;
  runner.p.steps.subtitles = { status: 'running' };
  const logs = [];
  runner.on('log', (l) => logs.push(l.line));
  await runner.step_subtitles();
  assert.strictEqual(runner.p.subsFallback, true);
  assert.ok(logs.some((l) => /기본 방식으로 입혀요/.test(l)), logs.join('\n'));
  const ass = fs.readFileSync(path.join(runner.dir, 'work', 'lyrics.ass'), 'utf8');
  assert.match(ass, /PlayResX: 854/);
  assert.match(ass, /&H004DE1FF/, '노랑 #ffe14d');
  assert.doesNotMatch(ass, /후렴/, '숨긴 줄은 ASS 에도 없다');
  assert.ok(!fs.existsSync(path.join(runner.dir, 'work', 'fonts')), '내 컴퓨터 기본 글꼴이면 번들 글꼴을 복사하지 않는다');
  assert.ok(Math.abs((await countFrames(path.join(runner.dir, runner.p.output.video))) - 72) <= 1);
  // 렌더러가 오류를 내도 ASS 로 대체 — 이번에는 번들 글꼴(Do Hyeon + 빈 글자 채우기 Pretendard)을 자막 폴더에 복사해서 쓴다
  runner.renderSubtitles = async () => { throw new Error('창을 못 열었어요'); };
  runner.p.workflow.subtitles = { enabled: true, preset: 'yellow' };
  runner.p.steps.subtitles = { status: 'running' };
  await runner.step_subtitles();
  assert.strictEqual(runner.p.subsFallback, true);
  assert.ok(logs.some((l) => /자막 이미지 생성 실패/.test(l)));
  assert.deepStrictEqual(fs.readdirSync(path.join(runner.dir, 'work', 'fonts')).sort(), ['DoHyeon-Regular.ttf', 'Pretendard-Bold.otf']);
  assert.match(fs.readFileSync(path.join(runner.dir, 'work', 'lyrics.ass'), 'utf8'), /Style: Lyric,Do Hyeon,/);
});

test('7단계: 자막을 끄면 깨끗한 원본을 하드링크(복사 안 함), 다시 켜도 원본은 멀쩡하다', { timeout: 120000 }, async () => {
  const { runner, clean } = await makeBurnable();
  runner.renderSubtitles = null;
  runner.p.workflow.subtitles = { enabled: false, preset: 'basic' };
  await runner.step_subtitles();
  const final = path.join(runner.dir, runner.p.output.video);
  assert.strictEqual(fs.statSync(final).size, fs.statSync(clean).size);
  assert.strictEqual(fs.statSync(final).ino, fs.statSync(clean).ino, '같은 파일에 이름만 하나 더 (하드링크)');
  assert.strictEqual(runner.p.subsFallback, false);
  assert.strictEqual(runner.p.steps.subtitles.lastMs, undefined, '입히지 않았으면 시간을 기록하지 않는다');
  assert.ok(fs.existsSync(path.join(runner.dir, 'output', 'lyrics.srt')), 'SRT 는 그래도 만든다');
  // 가사가 없어도 같다
  const cleanSize = fs.statSync(clean).size;
  const cleanMtime = fs.statSync(clean).mtimeMs;
  // 다시 켜기: 자막을 입힌 영상은 새 파일이어야 하고 깨끗한 원본이 손상되면 안 된다
  runner.p.workflow.subtitles = { enabled: true, preset: 'basic' };
  runner.p.steps.subtitles = { status: 'running' };
  await runner.step_subtitles();
  assert.strictEqual(runner.p.subsFallback, true, 'ASS 대체로 입혔다');
  assert.ok(fs.statSync(final).ino !== fs.statSync(clean).ino, '이제는 다른 파일');
  assert.strictEqual(fs.statSync(clean).size, cleanSize, '깨끗한 원본 크기 그대로');
  assert.strictEqual(fs.statSync(clean).mtimeMs, cleanMtime, '깨끗한 원본은 건드리지 않았다');
  assert.ok(Math.abs((await countFrames(clean)) - 72) <= 1, '깨끗한 원본이 그대로 재생된다');
  assert.ok(runner.p.steps.subtitles.lastMs > 0);
  // 가사가 하나도 안 보이면(전부 숨김) 다시 하드링크
  for (const l of runner.p.timing.lyrics) l.hidden = true;
  runner.p.steps.subtitles = { status: 'running' };
  await runner.step_subtitles();
  assert.strictEqual(fs.statSync(final).ino, fs.statSync(clean).ino);
  assert.doesNotMatch(fs.readFileSync(path.join(runner.dir, 'output', 'lyrics.srt'), 'utf8'), /보이는/);
});
