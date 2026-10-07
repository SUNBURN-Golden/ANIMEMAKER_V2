'use strict';
// 체험(demo) 모드로 V2 전체 7단계를 끝까지 돌려 본다 (무료 · 오프라인)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/main/store');
const { ProjectRunner, STEPS } = require('../src/main/pipeline/runner');
const { probe, countFrames } = require('../src/main/media/ffmpeg');
const demo = require('../src/main/ai/demo');
const { scaledCutRange } = require('../src/main/media/timeline');

function newStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'animemaker2-'));
  const store = new Store({ userDataDir: path.join(root, 'ud'), documentsDir: path.join(root, 'docs'), downloadsDir: path.join(root, 'dl') });
  return { root, store };
}

const sum = (a) => a.reduce((x, y) => x + y, 0);

test('demo pipeline (지브리식): series episode → lyric tap → motion timesheet → BG plates + keyed cels → in-betweens → layered render → subtitles; then subtitles-only and one-shot re-render', { timeout: 900000 }, async () => {
  const { store } = newStore();
  const { series, character } = await demo.createDemoSeries(store);
  assert.ok(character.isLocked && character.refs.length === 3);
  const wf = { ...store.getWorkflow('builtin-cel-wide'), minClips: 18, maxClips: 24, minClipSec: 2, maxClipSec: 10, quality: '480p' };
  const project = store.createProject('', wf, {}, { seriesId: series.id });
  project.demoSongSeconds = 30;
  store.saveProject(project);
  const runner = new ProjectRunner({ store, projectId: project.id });
  const logs = [];
  runner.on('log', (l) => logs.push(l.line));
  const running = runner.run();
  // 가사 맞추기 대기 → 탭으로 맞춘 것처럼 저장하고 계속
  for (let i = 0; i < 600 && !(runner.p.waiting && runner.p.waiting.key === 'review:lyrics'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(runner.p.waiting && runner.p.waiting.key, 'review:lyrics', logs.join('\n'));
  assert.strictEqual(runner.p.steps.plan.status, 'done');
  const est = runner.p.timing.lyrics;
  const tapped = est.map((l, i) => ({ text: l.text, part: 1, start: 2 + i * 1.4, end: 2 + i * 1.4 + 1.3 }));
  runner.updateLyrics(tapped);
  assert.ok(runner.continueReview());
  await running;
  let p = runner.snapshot();
  assert.strictEqual(p.status, 'done', `status=${p.status} error=${p.error}\n${logs.join('\n')}`);
  for (const s of STEPS) assert.strictEqual(p.steps[s].status, 'done', s);

  // 기획: 고정 주인공
  assert.strictEqual(p.plan.characters[0].name, '하루');
  assert.ok(p.plan.characters[0].fixed);
  // 타이밍 · 타임시트
  assert.strictEqual(p.timing.lyricsSource, 'tap');
  // 30초 노래라서 3~4분 기준 컷 수(18~24)를 길이에 맞춰 줄인다
  const range = scaledCutRange(18, 24, p.music.analysis.duration);
  assert.ok(range.minClips >= 3 && range.maxClips <= 5, JSON.stringify(range));
  assert.ok(p.timing.segments.length >= range.minClips && p.timing.segments.length <= range.maxClips, `segments ${p.timing.segments.length}`);
  assert.ok(logs.some((l) => /짧은 노래라서 컷 수를/.test(l)));
  const xs = p.xsheet;
  assert.strictEqual(xs.fps, 24);
  assert.strictEqual(xs.totalFrames, Math.round(p.music.analysis.duration * 24));
  xs.shots.forEach((s, i) => assert.strictEqual(sum(s.exposure.map((e) => e.frames)), p.timing.frames[i], `shot ${s.shot} exact frames`));
  assert.ok(xs.totalDrawings <= xs.budget);
  assert.strictEqual(xs.mode, 'ghibli');
  assert.strictEqual(xs.keyRate, 6);
  assert.ok(xs.layers);
  assert.ok(xs.shots.some((s) => s.highlight), 'at least one highlight');
  // 지브리식: 노래의 40~50% 정도만 움직이고 (하이라이트 먼저), 나머지는 멈춘 그림 + 카메라
  const motionFrames = sum(xs.shots.filter((s) => s.motion).map((s) => s.frames));
  assert.ok(motionFrames / xs.totalFrames >= 0.3 && motionFrames / xs.totalFrames <= 0.6, `motion share ${motionFrames / xs.totalFrames}`);
  assert.ok(xs.shots.some((s) => !s.motion), 'some shots are held');
  for (const s of xs.shots.filter((x) => x.motion)) assert.ok(s.exposure.slice(0, -1).every((e) => e.frames === 4), `shot ${s.shot}: keys on 4s`);
  assert.ok(xs.shots.every((s) => s.bg && s.bg.prompt_en), 'every shot has a background plate');
  assert.match(logs.join('\n'), /🧮 그림 약 \d+장 \(배경 \d+장 \+ 인물 \d+장\)/);
  // 그림: 배경 판 + 인물 셀 (초록 배경을 빼서 투명하게)
  assert.strictEqual(p.drawings.length, xs.totalDrawings);
  assert.strictEqual(p.drawings.filter((d) => d.kind === 'bg').length, xs.shots.length);
  assert.ok(p.drawings.every((d) => d.status === 'done' && fs.existsSync(path.join(p.dir, d.file))));
  assert.ok(p.drawings.filter((d) => d.kind === 'cel').every((d) => d.prompt.includes('long red knitted scarf') || !/하루|Haru/.test(d.prompt)), 'locked design in every character cel');
  assert.ok(p.drawings.filter((d) => d.kind === 'bg').every((d) => /Paint ONLY the place/.test(d.prompt) && !d.prompt.includes('LOCKED DESIGN')), 'background plates: place only');
  const cels = p.drawings.filter((d) => d.kind === 'cel');
  assert.ok(cels.every((d) => d.keyed && d.keySource && fs.existsSync(path.join(p.dir, d.cel))), 'every demo cel keyed');
  // 사이 그림 + 멀티플레인 렌더링
  const ib = p.render.inbetween;
  assert.ok(ib.count >= 1, JSON.stringify(ib));
  assert.ok(logs.some((l) => /🎞 사이 그림: /.test(l)));
  assert.ok(Object.values(p.inbetweens).every((r) => r.status === 'hold' || fs.existsSync(path.join(p.dir, r.file))));
  assert.ok(p.render.shots.every((r) => r.layered));
  assert.ok(p.render.shots.filter((r) => r.motion).every((r) => r.inbetweens >= 1));
  // 렌더링: 깨끗한 원본 (자막 없음) + 노래
  const clean = path.join(p.dir, p.output.clean);
  assert.strictEqual(p.output.clean, 'output/animation_clean.mp4');
  const ci = await probe(clean);
  assert.ok(ci.hasVideo && ci.hasAudio, 'clean master has video + song');
  assert.strictEqual(ci.width, 854);
  assert.ok(Math.abs((await countFrames(clean)) - xs.totalFrames) <= 1, 'clean frames exact');
  // 자막 입힌 완성본
  const final = path.join(p.dir, p.output.video);
  const fi = await probe(final);
  assert.ok(fi.hasVideo && fi.hasAudio);
  assert.ok(Math.abs(fi.duration - p.music.analysis.duration) < 0.15, `final ${fi.duration} vs song ${p.music.analysis.duration}`);
  assert.match(path.basename(final), /EP1/);
  assert.match(fs.readFileSync(path.join(p.dir, 'output', 'lyrics.srt'), 'utf8'), /00:00:02,000 -->/);
  assert.ok(fs.existsSync(path.join(p.dir, 'output', 'timesheet.json')));
  assert.match(fs.readFileSync(path.join(p.dir, 'output', 'storyboard.md'), 'utf8'), /타임시트/);
  // 시리즈 기록
  const ser = store.series.get(series.id);
  assert.strictEqual(ser.episodes.length, 1);
  assert.strictEqual(ser.episodes[0].number, 1);
  assert.ok(ser.episodes[0].summary_ko.length > 10);
  const next = store.createProject('', wf, {}, { seriesId: series.id });
  assert.strictEqual(next.series.episode, 2);
  assert.strictEqual(next.series.previous[0].summary_ko, ser.episodes[0].summary_ko, 'next episode sees the summary');

  // ---- 가사만 고치면 자막 단계만 다시 (렌더링은 하지 않음) ----
  const cleanMtime = fs.statSync(clean).mtimeMs;
  const madeAt = p.output.madeAt;
  runner.updateLyrics(tapped.map((l) => ({ ...l, start: l.start + 1, end: l.end + 1 })));
  assert.strictEqual(runner.p.steps.subtitles.status, 'pending');
  assert.strictEqual(runner.p.steps.render.status, 'done');
  logs.length = 0;
  await runner.run({ from: 'subtitles' });
  p = runner.snapshot();
  assert.strictEqual(p.status, 'done', p.error);
  assert.ok(logs.some((l) => /자막 입히기 시작/.test(l)));
  assert.ok(!logs.some((l) => /렌더링 .* 시작|그림 그리기 시작|타임시트 .* 시작/.test(l)), logs.join('\n'));
  assert.strictEqual(fs.statSync(clean).mtimeMs, cleanMtime, 'clean master not re-rendered');
  assert.ok(p.output.madeAt > madeAt);
  assert.match(fs.readFileSync(path.join(p.dir, 'output', 'lyrics.srt'), 'utf8'), /00:00:03,000 -->/);
  assert.strictEqual(store.series.get(series.id).episodes.length, 1, 'same episode, not logged twice');

  // ---- 그림 한 칸 노출만 바꾸면 그 컷만 다시 렌더링 ----
  const target = p.xsheet.shots.find((s) => s.exposure.length > 1) || p.xsheet.shots[0];
  const shotFile = (no) => path.join(p.dir, 'work', 'render', `shot${String(no).padStart(2, '0')}.mp4`);
  const others = p.xsheet.shots.filter((s) => s.shot !== target.shot).map((s) => [s.shot, fs.statSync(shotFile(s.shot)).mtimeMs]);
  if (target.exposure.length > 1) {
    runner.retime(target.shot, 0, target.exposure[0].frames + 2);
    assert.ok(runner.p.renderStale);
    assert.strictEqual(sum(runner.p.xsheet.shots.find((s) => s.shot === target.shot).exposure.map((e) => e.frames)), target.frames);
  } else {
    runner.setCamera(target.shot, 'pan_right');
  }
  await runner.run({ from: 'render' });
  p = runner.snapshot();
  assert.strictEqual(p.status, 'done', p.error);
  assert.strictEqual(p.renderStale, false);
  for (const [no, m] of others) assert.strictEqual(fs.statSync(shotFile(no)).mtimeMs, m, `shot ${no} reused from cache`);
  assert.ok(Math.abs((await countFrames(clean)) - p.xsheet.totalFrames) <= 1);
});

test('uploaded song with .lrc lyrics uses its timing without pausing (no series: characters from the plan)', { timeout: 600000 }, async () => {
  const { root, store } = newStore();
  const song = path.join(root, 'my suno song.mp3');
  await demo.demoMusic({ part: 1, seconds: 20, bpm: 100, out: song });
  const lrc = ['[00:03.00]첫 줄 가사', '[00:06.50]둘째 줄', '[00:10.00]셋째 줄 노래', '[00:14.20]넷째 줄', '[00:17.00]마지막 줄'].join('\n');
  const wf = { ...store.getWorkflow('builtin-storybook'), minClips: 3, maxClips: 4, quality: '480p' };
  const project = store.createProject('', wf, { songPath: song, lyricsText: lrc, lyricsFilename: 'song.lrc' });
  assert.strictEqual(project.song.name, 'my suno song.mp3');
  assert.strictEqual(project.lyricsInput.source, 'lrc');
  assert.strictEqual(project.series, null);
  const runner = new ProjectRunner({ store, projectId: project.id });
  const logs = [];
  runner.on('log', (l) => logs.push(l.line));
  await runner.run();
  const p = runner.snapshot();
  assert.strictEqual(p.status, 'done', `${p.error}\n${logs.join('\n')}`);
  assert.strictEqual(p.timing.lyricsSource, 'lrc');
  assert.strictEqual(p.timing.lyrics[2].start, 10);
  assert.ok(p.plan.characters.length >= 1);
  assert.ok(Math.abs(p.music.analysis.duration - 20) < 0.5);
  const info = await probe(path.join(p.dir, p.output.video));
  assert.strictEqual(info.width, 480, '1:1 storybook');
  assert.ok(Math.abs(info.duration - p.music.analysis.duration) < 0.15);
});
