'use strict';
// 가짜 구독 CLI + 도우미 모드로 V2 파이프라인 전체를 돌려 본다.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/main/store');
const { ProjectRunner } = require('../src/main/pipeline/runner');
const { ffmpegPath, probe } = require('../src/main/media/ffmpeg');
const demo = require('../src/main/ai/demo');

const ROOT = path.join(__dirname, '..');
const skipWin = process.platform === 'win32' ? '가짜 CLI 는 유닉스 실행 파일' : false;

const LYRICS = '[Verse 1]\n첫 번째 줄\n두 번째 줄\n[Chorus]\n후렴 첫 줄\n후렴 둘째 줄';

/**
 * @param {object} providers
 * @param {{settings?:object, wf?:object, songSeconds?:number, noSong?:boolean, series?:boolean}} o
 */
async function setup(providers, o = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am2-pipe-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const agents = {};
  for (const n of ['codex', 'grok', 'agy', 'claude']) {
    const p = path.join(bin, n);
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-cli.js'), p);
    fs.chmodSync(p, 0o755);
    agents[n] = { path: p };
  }
  process.env.FAKE_REPO_ROOT = ROOT;
  process.env.FAKE_FFMPEG = ffmpegPath();
  process.env.CODEX_HOME = path.join(root, 'codex-home');
  const store = new Store({ userDataDir: path.join(root, 'ud'), documentsDir: path.join(root, 'docs'), downloadsDir: path.join(root, 'dl') });
  fs.mkdirSync(path.join(root, 'dl'), { recursive: true });
  store.saveSettings({ agents, providers, ...(o.settings || {}) });
  let songPath = null;
  if (!o.noSong) {
    songPath = path.join(root, 'suno.mp3');
    await demo.demoMusic({ part: 1, seconds: o.songSeconds || 16, bpm: 120, out: songPath });
  }
  const seriesId = o.series === false ? null : (await demo.createDemoSeries(store)).series.id;
  const wf = { ...store.getWorkflow('builtin-cel-wide'), minClips: 3, maxClips: 4, minClipSec: 2, quality: '480p', lyricSyncPause: false, reviewBeforeDrawings: false, ...(o.wf || {}) };
  const p = store.createProject('테스트 주제', wf, { songPath, lyricsText: LYRICS }, { seriesId });
  const runner = new ProjectRunner({ store, projectId: p.id, maxRetries: 0 });
  const logs = [];
  runner.on('log', (l) => logs.push(l.line));
  return { root, store, runner, logs };
}

const waitFor = async (pred, logs) => {
  for (let i = 0; i < 900; i++) { if (pred()) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error(`timeout\n${logs.join('\n')}`);
};

function workDirs(p, shot, id) {
  const dir = path.join(p.dir, 'work', 'images');
  return fs.readdirSync(dir).filter((d) => d.startsWith(`s${String(shot).padStart(2, '0')}_${id}_`)).map((d) => path.join(dir, d));
}

test('subscription agents (지브리식): LLM plan + motion timesheet, estimate pause, BG plates + keyed cels, previous cel attached first, in-betweens, render', { skip: skipWin, timeout: 600000 }, async () => {
  const { runner, logs } = await setup({ text: 'codex', image: 'codex' }, { songSeconds: 18, wf: { drawingBudget: 40, reviewBeforeDrawings: true, inbetween: 'ffmpeg' } });
  const running = runner.run();
  // 그리기 전에 예상 장수·시간을 보여 주고 멈춘다
  await waitFor(() => runner.p.waiting && runner.p.waiting.key === 'review:drawings', logs);
  assert.match(runner.p.waiting.message, /그림 약 \d+장 \(배경 \d+장 \+ 인물 \d+장\), 예상 약/);
  assert.strictEqual(runner.p.steps.drawings.status, 'waiting');
  assert.ok(runner.p.drawings.every((d) => d.status === 'pending'), 'nothing drawn before the go-ahead');
  assert.ok(runner.continueReview());
  await running;
  const p = runner.snapshot();
  assert.strictEqual(p.status, 'done', `${p.error}\n${logs.join('\n')}`);
  assert.match(p.plan.title, /codex/);
  // 고정 주인공: LLM 이 '하루' 를 파란 머리 어른으로 바꾸려 했지만 무시
  assert.strictEqual(p.plan.characters[0].name, '하루');
  assert.match(p.plan.characters[0].appearance_en, /short brown bob/);
  assert.ok(!p.plan.characters.some((c) => /blue hair/.test(c.appearance_en)));
  const planPrompt = fs.readFileSync(path.join(p.dir, 'work', 'plan', 'fake-codex-prompt.txt'), 'utf8');
  assert.match(planPrompt, /FIXED MAIN CHARACTERS/);
  assert.match(planPrompt, /this is the first episode/);
  // LLM 타임시트: 움직이는 컷 표시 + 예산, 프레임 합계가 틀렸어도 PC 가 정확히 맞춘다
  const xsPrompt = fs.readFileSync(path.join(p.dir, 'work', 'xsheet', 'fake-codex-prompt.txt'), 'utf8');
  assert.match(xsPrompt, /at most 40 unique images/);
  assert.match(xsPrompt, /MOTION: \d+ key slots of 4 frames/);
  assert.match(xsPrompt, /HOLD: 1-4 cels/);
  assert.ok(!/ghibli/i.test(xsPrompt), 'no studio names in prompts');
  const xs = p.xsheet;
  assert.strictEqual(xs.mode, 'ghibli');
  assert.ok(xs.shots.every((s) => s.source === 'llm'), 'LLM timesheet used');
  xs.shots.forEach((s, i) => assert.strictEqual(s.exposure.reduce((a, e) => a + e.frames, 0), p.timing.frames[i]));
  assert.ok(xs.totalDrawings <= 40);
  assert.ok(xs.shots.some((s) => s.camera.move === 'pan_left'), 'camera alias PAN-LEFT understood');
  const mshot = xs.shots.find((s) => s.motion && s.drawings.length >= 2);
  assert.ok(mshot, 'a motion shot with 2+ keys');
  assert.ok(mshot.exposure.slice(0, -1).every((e) => e.frames === 4), 'motion keys exposed 4 frames each');
  assert.ok(xs.shots.some((s) => !s.motion), 'a held shot too');
  // 그림: 컷마다 배경 판 1장 + 인물 셀 (초록 배경을 PC 가 뺌)
  assert.ok(p.drawings.every((d) => d.status === 'done'));
  assert.strictEqual(p.drawings.filter((d) => d.kind === 'bg').length, xs.shots.length);
  const bgPrompt = p.drawings.find((d) => d.kind === 'bg').prompt;
  assert.match(bgPrompt, /no characters/);
  assert.ok(!bgPrompt.includes('LOCKED DESIGN'));
  const cels = p.drawings.filter((d) => d.kind === 'cel');
  assert.ok(cels.every((d) => d.keyed && fs.existsSync(path.join(p.dir, d.cel)) && fs.existsSync(path.join(p.dir, d.plate))), 'every cel keyed');
  assert.ok(cels.every((d) => /plain flat solid green #00FF00 background/.test(d.prompt)));
  // 같은 컷 두 번째 셀: 앞 셀을 '첫 번째' 로 붙이고 고치기로 부탁 + 캐릭터 시트
  const [dA] = workDirs(p, mshot.shot, 'A');
  const [dB] = workDirs(p, mshot.shot, 'B');
  const callsA = fs.readFileSync(path.join(dA, 'fake-codex-calls.log'), 'utf8');
  const callsB = fs.readFileSync(path.join(dB, 'fake-codex-calls.log'), 'utf8');
  assert.strictEqual((callsA.match(/--image/g) || []).length, 3, 'turnaround + expressions + full body');
  assert.strictEqual((callsB.match(/--image/g) || []).length, 4, 'previous cel + character sheets');
  const argsB = JSON.parse(callsB.trim().split('\n').pop());
  assert.match(argsB[argsB.indexOf('--image') + 1], /ref1\.png$/);
  const itA = p.drawings.find((d) => d.key === `${mshot.shot}:A`);
  assert.ok(fs.readFileSync(path.join(dB, 'ref1.png')).equals(fs.readFileSync(path.join(p.dir, itA.plate))), 'first attached image = previous cel');
  const promptB = fs.readFileSync(path.join(dB, 'fake-codex-prompt.txt'), 'utf8');
  assert.match(promptB, /EDIT MODE: Edit the first attached image/);
  assert.match(promptB, /Keep the character's design, line style, colours, size and position on the frame the same/);
  assert.match(promptB, /1\) ref1\.png — the previous drawing of this same shot/);
  assert.ok(promptB.includes('LOCKED DESIGN'), 'locked description injected');
  assert.ok(promptB.includes('long red knitted scarf'));
  assert.ok(promptB.includes('scarf red #d7263d'));
  assert.match(promptB, /turnaround model sheet/);
  const promptA = fs.readFileSync(path.join(dA, 'fake-codex-prompt.txt'), 'utf8');
  assert.ok(!/EDIT MODE/.test(promptA), 'first cel is drawn fresh');
  // 사이 그림 (ffmpeg) + 렌더링
  assert.ok(p.render.inbetween.count >= 1, JSON.stringify(p.render.inbetween));
  assert.ok(logs.some((l) => /🎞 사이 그림: ffmpeg/.test(l)), logs.join('\n'));
  const ib = Object.values(p.inbetweens).find((r) => r.shot === mshot.shot && r.status === 'done');
  assert.ok(ib && ib.engine === 'ffmpeg' && fs.existsSync(path.join(p.dir, ib.file)));
  const rs = p.render.shots.find((r) => r.shot === mshot.shot);
  assert.ok(rs.layered && rs.inbetweens >= 1);
  const info = await probe(path.join(p.dir, p.output.video));
  assert.ok(info.hasAudio && info.hasVideo);
  assert.ok(Math.abs(info.duration - p.music.analysis.duration) < 0.15);
});

test('limited mode without layers still works like before (full-frame drawings, previous drawing attached first)', { skip: skipWin, timeout: 600000 }, async () => {
  const { runner, logs } = await setup({ text: 'codex', image: 'codex' }, { songSeconds: 14, wf: { drawingBudget: 14, motionMode: 'limited', layers: false } });
  await runner.run();
  const p = runner.snapshot();
  assert.strictEqual(p.status, 'done', `${p.error}\n${logs.join('\n')}`);
  const xsPrompt = fs.readFileSync(path.join(p.dir, 'work', 'xsheet', 'fake-codex-prompt.txt'), 'utf8');
  assert.match(xsPrompt, /at most 14 unique images/);
  assert.ok(!/MOTION:/.test(xsPrompt));
  assert.ok(p.xsheet.shots.every((s) => !s.motion));
  assert.ok(p.drawings.every((d) => d.kind === 'cel' && !d.keyed));
  assert.ok(p.drawings.every((d) => !/#00FF00/.test(d.prompt)), 'full-frame drawings, no key colour');
  assert.ok(!p.inbetweens || !Object.keys(p.inbetweens).length);
  const shot = p.xsheet.shots.find((s) => s.characters.includes('하루') && s.drawings.length >= 2);
  const [dB] = workDirs(p, shot.shot, 'B');
  const promptB = fs.readFileSync(path.join(dB, 'fake-codex-prompt.txt'), 'utf8');
  assert.match(promptB, /1\) ref1\.png — the previous drawing of this same shot/);
  assert.ok(p.render.shots.every((r) => !r.layered));
});

test('broken timesheet JSON from the LLM falls back to a PC timesheet and still finishes', { skip: skipWin, timeout: 600000 }, async () => {
  const { runner, logs } = await setup({ text: 'grok', image: 'demo' }, { songSeconds: 12, series: false, wf: { minClips: 2, maxClips: 3 } });
  process.env.FAKE_BROKEN_XSHEET = '1';
  try { await runner.run(); } finally { delete process.env.FAKE_BROKEN_XSHEET; }
  const p = runner.snapshot();
  assert.strictEqual(p.status, 'done', `${p.error}\n${logs.join('\n')}`);
  assert.ok(logs.some((l) => /PC 가 기본 타임시트/.test(l)), logs.join('\n'));
  assert.ok(p.xsheet.shots.every((s) => s.source === 'fallback'));
  assert.ok(fs.existsSync(path.join(p.dir, p.output.video)));
});

test('helper mode: BG plate then cel, reference sheets shown, downloaded drawing picked up automatically and via provideFile', { timeout: 600000 }, async () => {
  const { root, runner, logs } = await setup({ text: 'demo', image: 'helper' }, { songSeconds: 10, wf: { minClips: 2, maxClips: 2, drawingBudget: 4 } });
  const img = path.join(root, 'made.png');
  await demo.demoImage({ index: 1, w: 640, h: 360, out: img });
  const cel = path.join(root, 'cel.png');
  await demo.demoCel({ shot: 1, index: 0, count: 1, motion: false, keyColor: '#00ff00', palette: demo.DEMO_CHARACTER.palette, w: 640, h: 360, out: cel });
  const running = runner.run();
  // 배경 판 먼저 (인물 없음 → 캐릭터 시트도 안 붙임)
  await waitFor(() => runner.p.waiting && runner.p.waiting.key === 'image:1:bg', logs);
  let w = runner.p.waiting;
  assert.match(w.copyText, /no characters/);
  assert.ok(!w.copyText.includes('LOCKED DESIGN'));
  assert.ok(!w.images || !w.images.length);
  fs.copyFileSync(img, path.join(root, 'dl', 'Gemini_Generated_Image_bg.png'));
  await waitFor(() => runner.p.waiting && runner.p.waiting.key === 'image:1:A', logs);
  w = runner.p.waiting;
  assert.ok(w.copyText.includes('No text'), 'prompt to paste');
  assert.ok(w.copyText.includes('LOCKED DESIGN'), 'locked character design in the helper prompt');
  assert.ok(w.copyText.includes('#00FF00'), 'flat key background requested');
  assert.strictEqual(w.site, 'gemini');
  assert.ok(w.images.length >= 1 && /refs\/characters\//.test(w.images[0].file), 'character sheet offered to attach');
  assert.match(w.images[0].note, /turnaround/);
  // 사용자가 브라우저에서 다운로드한 것처럼 다운로드 폴더에 파일 생성
  fs.copyFileSync(cel, path.join(root, 'dl', 'Gemini_Generated_Image.png'));
  await waitFor(() => runner.p.waiting && runner.p.waiting.key === 'image:2:bg', logs);
  assert.ok(runner.provideFile('image:2:bg', img));
  await waitFor(() => runner.p.waiting && runner.p.waiting.key === 'image:2:A', logs);
  assert.ok(runner.provideFile('image:2:A', img));
  await running;
  const p = runner.snapshot();
  assert.strictEqual(p.status, 'done', `${p.error}\n${logs.join('\n')}`);
  assert.ok(p.drawings.every((k) => k.status === 'done'));
  assert.ok(p.drawings.find((d) => d.key === '1:A').keyed, 'green-background cel keyed');
  assert.strictEqual(p.drawings.find((d) => d.key === '2:A').keyed, false, 'a full picture is used as a full-frame drawing');
  assert.ok(logs.some((l) => /배경이 단색이 아니라 뺄 수 없어서/.test(l)));
});

test('usage limit with onLimit=stop pauses the project as limited, then resumes', { skip: skipWin, timeout: 300000 }, async () => {
  const { runner } = await setup({ text: 'claude', image: 'demo' }, { settings: { onLimit: 'stop' }, songSeconds: 10, series: false });
  process.env.FAKE_LIMIT = 'claude';
  try { await runner.run(); } finally { delete process.env.FAKE_LIMIT; }
  assert.strictEqual(runner.p.status, 'limited');
  assert.strictEqual(runner.p.steps.music.status, 'done', '노래 분석은 AI 없이 끝나 있어야 함');
  await runner.run();
  assert.strictEqual(runner.p.status, 'done', runner.p.error);
});

test('without a song (real AI), it waits for the song file; stop() works', { skip: skipWin, timeout: 120000 }, async () => {
  const { runner } = await setup({ text: 'claude', image: 'demo' }, { noSong: true, series: false });
  const running = runner.run();
  for (let i = 0; i < 300 && !(runner.p.waiting); i++) await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(runner.p.waiting.key, 'music:song');
  runner.stop();
  await running;
  assert.strictEqual(runner.p.status, 'stopped');
});

test('a project left "running" by a crash is shown as stopped and can resume', { timeout: 300000 }, async () => {
  const { store, runner } = await setup({ text: 'demo', image: 'demo' }, { songSeconds: 8, series: false, wf: { minClips: 2, maxClips: 2 } });
  const p = store.loadProject(runner.p.id);
  p.status = 'running';
  p.steps = { music: { status: 'running' } };
  p.waiting = { key: 'review:lyrics', kind: 'review' };
  p.drawings = [{ key: '1:A', shot: 1, id: 'A', status: 'running' }];
  store.saveProject(p);
  const again = new ProjectRunner({ store, projectId: p.id });
  assert.strictEqual(again.p.status, 'stopped');
  assert.strictEqual(again.p.waiting, null);
  assert.strictEqual(again.p.steps.music.status, 'stopped');
  assert.strictEqual(again.p.drawings[0].status, 'pending');
  await again.run();
  assert.strictEqual(again.p.status, 'done', again.p.error);
});
