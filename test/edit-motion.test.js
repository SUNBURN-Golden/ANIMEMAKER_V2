'use strict';
// 그림 줄여서 빨리(setMotion · estimateMotion) 와 새 영상의 영상 모양 덮어쓰기(workflowOverrides), 1:1 · 9:16 · 4:5 영상이 끝까지 되는지 (DESIGN §3.3)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/main/store');
const { ProjectRunner } = require('../src/main/pipeline/runner');
const { probe } = require('../src/main/media/ffmpeg');
const { BUILTIN_WORKFLOWS } = require('../src/main/defaults');
const demo = require('../src/main/ai/demo');
const EC = require('../src/main/pipeline/edits-core');
const { copyFixture } = require('./helpers/edit-fixture');

function newStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am2-motion-'));
  const store = new Store({ userDataDir: path.join(root, 'ud'), documentsDir: path.join(root, 'docs'), downloadsDir: path.join(root, 'dl') });
  return { root, store, cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* noop */ } } };
}

const wait = async (cond, ms = 15000, step = 50) => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('기다리다 시간이 지났어요'); await new Promise((r) => setTimeout(r, step)); }
};

const BASE = { minClips: 6, maxClips: 7, minClipSec: 3, maxClipSec: 10, lyricSyncPause: false, reviewBeforeDrawings: false, quality: '480p' };

test('workflowOverrides: 허용된 6개 칸만 얕게 덮어쓴다 (틀린 값 · 다른 칸은 조용히 무시), 내장 워크플로우는 그대로', () => {
  const { store, cleanup } = newStore();
  try {
    const base = store.getWorkflow('builtin-cel-wide');
    const snap = JSON.stringify(BUILTIN_WORKFLOWS);
    const p = store.createProject('테스트', base, {}, { workflowOverrides: { aspect: '1:1', quality: '480p', motionMode: 'limited', keyRate: 8, drawingBudget: 40, pace: 'fast', name: '해킹', subtitles: { enabled: false }, id: 'x', providers: {} } });
    assert.strictEqual(p.workflow.aspect, '1:1');
    assert.strictEqual(p.workflow.quality, '480p');
    assert.strictEqual(p.workflow.motionMode, 'limited');
    assert.strictEqual(p.workflow.keyRate, 8);
    assert.strictEqual(p.workflow.drawingBudget, 40);
    assert.strictEqual(p.workflow.pace, 'fast');
    assert.strictEqual(p.workflow.name, base.name, '허용되지 않은 칸은 무시');
    assert.strictEqual(p.workflow.id, 'builtin-cel-wide');
    assert.deepStrictEqual(p.workflow.subtitles, base.subtitles);
    assert.strictEqual(JSON.stringify(BUILTIN_WORKFLOWS), snap, '내장 워크플로우는 바뀌지 않았다');
    assert.strictEqual(store.getWorkflow('builtin-cel-wide').aspect, '16:9');
    // 디스크에도
    assert.strictEqual(store.loadProject(p.id).workflow.aspect, '1:1');
    // 틀린 값은 조용히 무시
    const q = store.createProject('두번째', base, {}, { workflowOverrides: { aspect: '3:2', quality: '8k', motionMode: 'turbo', keyRate: 7, drawingBudget: -5, pace: 'warp' } });
    assert.strictEqual(q.workflow.aspect, '16:9');
    assert.strictEqual(q.workflow.quality, '720p');
    assert.strictEqual(q.workflow.motionMode, 'ghibli');
    assert.strictEqual(q.workflow.keyRate, 6);
    assert.strictEqual(q.workflow.drawingBudget, 0);
    assert.strictEqual(q.workflow.pace, 'normal');
    // 없거나 이상한 값
    for (const bad of [undefined, null, 'x', 5, [], {}]) {
      const z = store.createProject('세번째', base, {}, { workflowOverrides: bad });
      assert.strictEqual(z.workflow.aspect, '16:9');
    }
    // 세로 내장 워크플로우 + 네모 덮어쓰기
    const v = store.createProject('세로', store.getWorkflow('builtin-cel-vertical'), {}, { workflowOverrides: { aspect: '1:1' } });
    assert.strictEqual(v.workflow.aspect, '1:1');
    assert.strictEqual(v.workflow.subtitles.preset, 'shorts');
    // 기존 호출(덮어쓰기 없음)은 그대로
    assert.strictEqual(store.createProject('옛 방식', base, {}).workflow.aspect, '16:9');
  } finally { cleanup(); }
});

test('store.listProjects 는 노래 길이(durationSec)도 준다 (분석 전이면 null)', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const fresh = fx.store.createProject('아직 안 만든 영상', fx.store.getWorkflow('builtin-cel-wide'), {});
  const list = fx.store.listProjects();
  const done = list.find((x) => x.id === fx.projectId);
  const empty = list.find((x) => x.id === fresh.id);
  assert.strictEqual(done.durationSec, 24);
  assert.strictEqual(empty.durationSec, null);
  assert.ok(done.final && done.thumb);
});

test('estimateMotion: 이렇게 바꾸면 몇 장 · 몇 분 (프로젝트는 바꾸지 않는다), 틀린 값은 쉬운 말로 거절', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  const json = fs.readFileSync(path.join(fx.dir, 'project.json'));
  const cur = r.p.xsheet.estimate;
  const same = r.estimateMotion({});
  assert.strictEqual(same.ready, true);
  assert.strictEqual(same.pictures, cur.images, '지금과 같은 설정이면 지금 예상과 같다');
  assert.strictEqual(same.minutes, cur.minutes);
  assert.strictEqual(typeof same.text, 'string');
  const limited = r.estimateMotion({ motionMode: 'limited' });
  assert.strictEqual(limited.motionMode, 'limited');
  assert.ok(limited.pictures >= 1 && limited.pictures <= cur.images, `조금만 움직이면 ${limited.pictures}장 ≤ 지금 ${cur.images}장`);
  assert.strictEqual(limited.inbetweens, 0, '조금만 움직이면 사이 그림이 없다');
  assert.match(limited.text, /^그림 약 \d+장 \(배경 \d+장 \+ 인물 \d+장\), 예상 약 \d+분/);
  const full = r.estimateMotion({ motionMode: 'full' });
  assert.ok(full.pictures > cur.images, `계속 움직이면 더 많다 (${full.pictures} > ${cur.images})`);
  assert.strictEqual(full.source, 'pc');
  const cheap = r.estimateMotion({ drawingBudget: 14 });
  assert.ok(cheap.pictures <= 14, `예산 14장: ${cheap.pictures}`);
  assert.strictEqual(cheap.drawingBudget, 14);
  assert.ok(cheap.minutes <= same.minutes);
  // 아무것도 바뀌지 않았다
  assert.ok(fs.readFileSync(path.join(fx.dir, 'project.json')).equals(json));
  assert.strictEqual(r.p.workflow.motionMode, 'ghibli');
  assert.strictEqual(r.p.xsheet.estimate, cur);
  assert.deepStrictEqual(r.snapshot().redrawing, []);
  // 틀린 값
  assert.throws(() => r.estimateMotion({ motionMode: 'turbo' }), /알 수 없는 움직임 방식이에요/);
  assert.throws(() => r.estimateMotion({ drawingBudget: -1 }), /그림 장수는 0\(자동\) 또는 3000 이하의 숫자로/);
  assert.throws(() => r.estimateMotion({ drawingBudget: 'abc' }), /그림 장수는/);
  assert.throws(() => r.estimateMotion({ drawingBudget: 99999 }), /그림 장수는/);
  // 타임시트를 짤 수 있기 전(가사·컷 나누기 전)에는 아직 몰라요
  const fresh = fx.store.createProject('새 영상', fx.store.getWorkflow('builtin-cel-wide'), {});
  const r2 = fx.runner({ projectId: fresh.id });
  assert.deepStrictEqual(r2.estimateMotion({ motionMode: 'limited' }), { ready: false, pictures: null, minutes: null, text: '' });
});

test('setMotion: 타임시트를 짜기 전에는 이 영상의 설정만 바꾼다 (내장 워크플로우는 그대로) → 이어서 만들면 새 설정으로 짠다', async (t) => {
  const { root, store, cleanup } = newStore();
  t.after(cleanup);
  const { series } = await demo.createDemoSeries(store);
  const wf = { ...store.getWorkflow('builtin-cel-wide'), ...BASE };
  const project = store.createProject('', wf, {}, { seriesId: series.id });
  project.demoSongSeconds = 12;
  store.saveProject(project);
  const r = new ProjectRunner({ store, projectId: project.id, maxRetries: 0 });
  const res = await r.setMotion({ motionMode: 'limited', drawingBudget: 24 });
  assert.strictEqual(res.motionMode, 'limited');
  assert.strictEqual(res.drawingBudget, 24);
  assert.strictEqual(res.replanned, false);
  assert.strictEqual(res.pictures, null, '아직 컷을 나누기 전이라 몇 장인지는 몰라요');
  assert.strictEqual(store.loadProject(project.id).workflow.motionMode, 'limited', '저장됐다');
  assert.strictEqual(store.getWorkflow('builtin-cel-wide').motionMode, 'ghibli');
  await r.run();
  const p = r.snapshot();
  assert.strictEqual(p.status, 'done', p.error);
  assert.strictEqual(p.xsheet.mode, 'limited');
  assert.ok(p.xsheet.totalDrawings <= 24 + p.xsheet.shots.length, `예산 안: ${p.xsheet.totalDrawings}`);
  assert.strictEqual(p.xsheet.shots.filter((s) => s.motion).length, 0);
  // 틀린 값 · 바꿀 것 없음
  await assert.rejects(() => r.setMotion({ motionMode: 'turbo' }), /알 수 없는 움직임 방식이에요/);
  await assert.rejects(() => r.setMotion({}), /^Error: 바꿀 내용이 없어요\.$/);
  await assert.rejects(() => r.setMotion({ drawingBudget: '' }), /바꿀 내용이 없어요/);
  // 다 그린 뒤에는 바꿀 수 없다
  await assert.rejects(() => r.setMotion({ motionMode: 'full' }), /이미 그림을 다 그린 뒤에는 바꿀 수 없어요/);
  assert.strictEqual(r.p.workflow.motionMode, 'limited', '거절당하면 아무것도 안 바뀐다');
  assert.ok(root);
});

test('setMotion: "그림 수 확인" 에서 기다리는 중이면 타임시트를 다시 짜고 새 예상으로 다시 묻는다 (카드에는 [그림 줄여서 빨리] 값도 같이 온다)', async (t) => {
  const { store, cleanup } = newStore();
  t.after(cleanup);
  const { series } = await demo.createDemoSeries(store);
  store.saveSettings({ providers: { text: 'demo', image: 'helper' } }); // 그림은 '연습'이 아니라서 확인 단계에서 멈춘다
  const wf = { ...store.getWorkflow('builtin-cel-wide'), ...BASE, reviewBeforeDrawings: true };
  const project = store.createProject('', wf, {}, { seriesId: series.id });
  project.demoSongSeconds = 60;
  store.saveProject(project);
  const r = new ProjectRunner({ store, projectId: project.id, maxRetries: 0 });
  const logs = [];
  r.on('log', (l) => logs.push(l.line));
  const running = r.run();
  await wait(() => r.p.waiting && r.p.waiting.key === 'review:drawings');
  const w1 = r.p.waiting;
  assert.strictEqual(w1.kind, 'review');
  assert.match(w1.message, /그림을 그리기 전에 확인해 주세요\. 그림 약 \d+장/);
  assert.match(w1.message, /\[그림 줄여서 빨리\]/, '옛 안내([중지] 후 워크플로우에서…)는 사라졌다');
  assert.ok(!/워크플로우/.test(w1.message));
  assert.strictEqual(w1.estimate.pictures, r.p.xsheet.estimate.images);
  assert.strictEqual(w1.estimate.motionMode, 'ghibli');
  assert.ok(w1.alt && w1.alt.pictures < w1.estimate.pictures && typeof w1.alt.text === 'string' && w1.alt.minutes <= w1.estimate.minutes, `더 가벼운 방법: ${JSON.stringify(w1.alt)}`);
  const before = r.p.xsheet.estimate.images;
  assert.ok(r.estimateMotion({ motionMode: w1.alt.motionMode, drawingBudget: w1.alt.drawingBudget }).pictures === w1.alt.pictures, 'estimateMotion 으로 같은 값을 미리 알 수 있다');
  // 기다리는 동안 그림을 다시 그릴 수는 없다 (영상 만들기 중)
  await assert.rejects(() => r.regenerate('drawing', 1, { id: 'A' }), /지금은 영상을 만드는 중이에요/);
  // 줄여서 빨리
  assert.throws(() => { r._planning = true; r.continueReview(); }, /그림 순서표를 다시 짜는 중이에요/);
  r._planning = false;
  const res = await r.setMotion({ motionMode: w1.alt.motionMode, drawingBudget: w1.alt.drawingBudget });
  assert.strictEqual(res.replanned, true);
  assert.strictEqual(res.pictures, w1.alt.pictures);
  assert.ok(res.pictures < before);
  assert.strictEqual(res.motionMode, w1.alt.motionMode);
  assert.strictEqual(res.text, w1.alt.text);
  assert.strictEqual(r.p.workflow.drawingBudget, w1.alt.drawingBudget);
  assert.strictEqual(r.p.xsheet.estimate.images, res.pictures);
  assert.strictEqual(r._planning, false);
  // 새 예상으로 다시 묻는다 (이전 기다림은 끝났고 새 기다림이 생긴다)
  await wait(() => r.p.waiting && r.p.waiting.key === 'review:drawings' && r.p.waiting.estimate.pictures === res.pictures && !r.p.waiting.busy);
  assert.match(r.p.waiting.message, new RegExp(`그림 약 ${res.pictures}장`));
  assert.strictEqual(r.p.currentStep, 'drawings');
  assert.strictEqual(r.p.steps.drawings.status, 'waiting');
  assert.strictEqual(r.p.steps.xsheet.status, 'done');
  assert.strictEqual(r.running, true);
  assert.ok(logs.some((l) => /움직임 설정을 바꿔서 그림 순서표를 다시 짰어요/.test(l)));
  assert.ok(r.p.drawings.length === r.p.xsheet.totalDrawings);
  // 다 그린 뒤가 아니라 확인 단계라서 바꿀 수 있었다. 이제 멈춘다
  r.stop();
  await running;
  assert.strictEqual(r.p.status, 'stopped');
  // 멈춘 상태(그림은 하나도 안 그림)에서도 한 번 더 줄일 수 있고, 이어서 하면 다시 묻는다
  const again = await r.setMotion({ drawingBudget: Math.max(r.p.xsheet.shots.length * 2, res.pictures - 4) });
  assert.strictEqual(again.replanned, true);
  assert.strictEqual(r.p.steps.drawings.status, 'pending');
  assert.strictEqual(r.p.drawingsApproved, false, '다시 확인을 받는다');
  assert.strictEqual(r.p.status, 'stopped');
});

test('setMotion 은 영상을 만드는 다른 단계 중에는 거절한다 · 순서표를 못 짜면 설정을 되돌린다', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  r.running = true;
  await assert.rejects(() => r.setMotion({ motionMode: 'limited' }), /^Error: 지금은 바꿀 수 없어요\. 그림 수를 확인하는 단계에서만 바꿀 수 있어요\.$/);
  r.running = false;
  assert.strictEqual(r.p.workflow.motionMode, 'ghibli');
  // 그림을 다시 그리는 중에도 거절
  let release;
  const gate = new Promise((res) => { release = res; });
  const orig = r.genImage.bind(r);
  r.genImage = async (a, tag, ctl) => { await gate; return orig(a, tag, ctl); };
  const p = r.regenerate('drawing', 1, { id: 'A' });
  await assert.rejects(() => r.setMotion({ motionMode: 'limited' }), /그림을 다시 그리는 중이에요/);
  release();
  await p;
  // 순서표를 못 짜면(그림 단계에서 멈춘 상태 흉내) 원래대로
  r.p.steps.drawings.status = 'stopped';
  const xs = r.p.xsheet;
  const drawings = r.p.drawings;
  const origCtx = r.step_xsheet;
  r.step_xsheet = async () => { throw new Error('LLM 이 대답하지 않아요'); };
  await assert.rejects(() => r.setMotion({ motionMode: 'limited', drawingBudget: 20 }), /^Error: 그림 순서표를 다시 짜지 못했어요\. 잠시 뒤에 다시 눌러 주세요\. \(LLM 이 대답하지 않아요\)$/);
  assert.strictEqual(r.p.workflow.motionMode, 'ghibli');
  assert.strictEqual(r.p.workflow.drawingBudget, 0);
  assert.strictEqual(r.p.xsheet, xs);
  assert.strictEqual(r.p.drawings, drawings);
  assert.strictEqual(r._planning, false);
  r.step_xsheet = origCtx;
});

// ---------------------------------------------------------------- 영상 모양: 네모(1:1) · 세로(9:16) · 4:5 가 연습 모드로 끝까지 된다

async function runShape(aspect, workflowId = 'builtin-cel-wide') {
  const { store, cleanup } = newStore();
  const { series } = await demo.createDemoSeries(store);
  const wf = { ...store.getWorkflow(workflowId), ...BASE, inbetween: 'off' };
  const project = store.createProject('', wf, {}, { seriesId: series.id, workflowOverrides: { aspect, quality: '480p', motionMode: 'limited' } });
  project.demoSongSeconds = 12;
  store.saveProject(project);
  const r = new ProjectRunner({ store, projectId: project.id, maxRetries: 0 });
  await r.run();
  return { r, store, cleanup, p: r.snapshot() };
}

const SHAPES = [
  { aspect: '1:1', w: 480, h: 480, big: [576, 576], prompt: /Composition for a 1:1 frame/ },
  { aspect: '9:16', w: 480, h: 854, big: [576, 1025], prompt: /Composition for a 9:16 frame/ },
  { aspect: '4:5', w: 480, h: 600, big: [576, 720], prompt: /Composition for a 4:5 frame/ },
];

for (const sh of SHAPES) {
  test(`영상 모양 ${sh.aspect}: 연습 모드로 끝까지 — 영상 크기 ${sh.w}×${sh.h}, 그림은 그 비율, 자막까지 입힘`, { timeout: 300000 }, async (t) => {
    const { r, p, cleanup } = await runShape(sh.aspect, sh.aspect === '9:16' ? 'builtin-cel-vertical' : 'builtin-cel-wide');
    t.after(cleanup);
    assert.strictEqual(p.status, 'done', p.error);
    assert.strictEqual(p.workflow.aspect, sh.aspect);
    assert.deepStrictEqual(p.outSize, { w: sh.w, h: sh.h }, 'snapshot.outSize');
    assert.strictEqual(p.xsheet.mode, 'limited');
    const info = await probe(path.join(p.dir, p.output.video));
    assert.strictEqual(info.width, sh.w, `${sh.aspect} 가로`);
    assert.strictEqual(info.height, sh.h, `${sh.aspect} 세로`);
    assert.ok(info.hasVideo && info.hasAudio);
    assert.ok(Math.abs(info.duration - 12) < 0.3, `길이 ${info.duration}`);
    const clean = await probe(path.join(p.dir, p.output.clean));
    assert.strictEqual(clean.width, sh.w);
    assert.strictEqual(clean.height, sh.h);
    // 그림도 같은 비율 (연습 그림은 화면보다 1.2배 크게)
    const pic = await probe(path.join(p.dir, p.drawings.find((d) => d.kind === 'bg').file));
    assert.ok(Math.abs(pic.width - sh.big[0]) <= 1 && Math.abs(pic.height - sh.big[1]) <= 2, `그림 ${pic.width}×${pic.height}`);
    // 그림 주문 글에 화면 비율이 들어 있다
    for (const d of p.drawings) assert.match(d.prompt, sh.prompt, `${d.key}`);
    assert.ok(p.drawings.every((d) => d.status === 'done'));
    // 자막이 입혀졌다 (화면 모양에 맞는 크기로)
    assert.strictEqual(p.subsStale, false);
    assert.ok(p.subtitleStyle && p.subtitleStyle.enabled);
    assert.ok(fs.statSync(path.join(p.dir, p.output.video)).size > 0);
    assert.notStrictEqual(fs.statSync(path.join(p.dir, p.output.video)).ino, fs.statSync(path.join(p.dir, p.output.clean)).ino, '가사가 있으니 원본과 다른 파일 (자막을 입혔다)');
    // 장면 미리보기도 같은 크기
    const pv = await r.previewShot(p.xsheet.shots[0].shot);
    const pvi = await probe(pv.file);
    assert.strictEqual(pvi.width, sh.w);
    assert.strictEqual(pvi.height, sh.h);
  });
}

test('lighterCandidates: 지금보다 가벼운 후보를 앞에서부터 (계속 → 신나는 부분만 → 조금만, 그 다음엔 장수 줄이기)', () => {
  assert.deepStrictEqual(EC.lighterCandidates('full', 100, 6, true).map((c) => `${c.motionMode}${c.drawingBudget ? `/${c.drawingBudget}` : ''}`), ['ghibli', 'limited', 'ghibli/60']);
  assert.deepStrictEqual(EC.lighterCandidates('ghibli', 100, 6, true).map((c) => `${c.motionMode}${c.drawingBudget ? `/${c.drawingBudget}` : ''}`), ['limited', 'ghibli/60', 'limited/60']);
  assert.deepStrictEqual(EC.lighterCandidates('limited', 100, 6, true).map((c) => `${c.motionMode}${c.drawingBudget ? `/${c.drawingBudget}` : ''}`), ['limited/60']);
  // 이미 최소에 가까우면 장수 줄이기 후보가 없다 (장면 수 × 2 아래로는 안 간다)
  assert.deepStrictEqual(EC.lighterCandidates('limited', 12, 6, true), []);
  assert.deepStrictEqual(EC.lighterCandidates('limited', 8, 8, false), []);
});

test('EC.MSG 의 문장은 화면에 그대로 나가도 되는 쉬운 한국어 (영어 · 전문 용어 없음)', () => {
  for (const [k, v] of Object.entries(EC.MSG)) {
    assert.ok(/[가-힣]/.test(v), k);
    assert.ok(!/프레임|RIFE|렌더링|ffmpeg|Error|undefined/i.test(v), `${k}: ${v}`);
    assert.ok(/(요|세요)[.!]?$|요\./.test(v), `해요체: ${k}: ${v}`);
  }
});
