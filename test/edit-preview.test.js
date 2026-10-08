'use strict';
// 장면 하나만 미리보기 (previewShot, DESIGN §3.3): 파일 · 같은 입력이면 지난번 파일 · 프로젝트 상태는 그대로 · 새 사이 그림을 만들지 않는다
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { copyFixture } = require('./helpers/edit-fixture');
const EC = require('../src/main/pipeline/edits-core');
const { probe, countFrames } = require('../src/main/media/ffmpeg');

const projectJson = (fx) => fs.readFileSync(path.join(fx.dir, 'project.json'));
const listAll = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

test('previewShot: 그 장면 하나만 mp4 로 (절대 경로 · 길이 · 노래 소리 · 영상 크기), 같은 입력이면 그대로 다시 쓴다', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  const shot = r.shotOf(2); // 움직이는 장면 (그림 6장 + 사이 그림)
  assert.ok(shot.motion);
  const t0 = Date.now();
  const pv = await r.previewShot(2);
  const firstMs = Date.now() - t0;
  assert.ok(path.isAbsolute(pv.file));
  assert.strictEqual(pv.file, path.join(fx.dir, 'work', 'preview', 'shot02.mp4'));
  assert.ok(fs.existsSync(pv.file));
  assert.strictEqual(pv.seconds, shot.frames / 24);
  assert.strictEqual(pv.from, shot.start);
  assert.strictEqual(pv.to, shot.end);
  assert.strictEqual(pv.hasAudio, true);
  assert.strictEqual(pv.cached, false);
  const info = await probe(pv.file);
  assert.ok(info.hasVideo && info.hasAudio, '영상 + 이 구간의 노래');
  assert.strictEqual(info.width, 854);
  assert.strictEqual(info.height, 480);
  assert.ok(Math.abs(info.duration - pv.seconds) < 0.15, `길이 ${info.duration} vs ${pv.seconds}`);
  assert.ok(Math.abs((await countFrames(pv.file)) - shot.frames) <= 1, '프레임 수 = 장면 프레임 수');
  // 같은 입력 → 지난번 파일을 그대로 (다시 만들지 않는다)
  const mt = fs.statSync(pv.file).mtimeMs;
  const t1 = Date.now();
  const pv2 = await r.previewShot(2);
  const cacheMs = Date.now() - t1;
  assert.strictEqual(pv2.cached, true);
  assert.strictEqual(pv2.file, pv.file);
  assert.strictEqual(fs.statSync(pv2.file).mtimeMs, mt);
  assert.ok(cacheMs < 500, '캐시는 바로');
  // 동시에 두 번 눌러도 한 번만 만든다
  r.setCamera(2, 'zoom_out');
  const [a, b] = await Promise.all([r.previewShot(2), r.previewShot(2)]);
  assert.strictEqual(a.file, b.file);
  assert.strictEqual(a.cached, false);
  assert.strictEqual(r._previews.size, 0, '끝나면 목록에서 빠진다');
  t.diagnostic(`장면 미리보기(8초 장면, 480p): 처음 ${firstMs}ms, 같은 입력 다시 ${cacheMs}ms`);
});

test('previewShot 은 프로젝트 상태를 바꾸지 않는다: 고친 표시 · 단계 · 영상 기록 · project.json 그대로', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  r.setCamera(1, 'pan_right'); // 고친 것이 있는 상태에서 미리본다
  const json = projectJson(fx);
  const snap = JSON.parse(JSON.stringify({ renderStale: r.p.renderStale, dirtyShots: r.p.dirtyShots, shots: r.p.render.shots, steps: r.p.steps, status: r.p.status, output: r.p.output, subsStale: r.p.subsStale, inbetweens: r.p.inbetweens, drawings: r.p.drawings }));
  const events = [];
  r.on('update', () => events.push(1));
  const pv = await r.previewShot(1);
  assert.ok(fs.existsSync(pv.file));
  await r.previewShot(2);
  await r.previewShot(3);
  const after = JSON.parse(JSON.stringify({ renderStale: r.p.renderStale, dirtyShots: r.p.dirtyShots, shots: r.p.render.shots, steps: r.p.steps, status: r.p.status, output: r.p.output, subsStale: r.p.subsStale, inbetweens: r.p.inbetweens, drawings: r.p.drawings }));
  assert.deepStrictEqual(after, snap);
  assert.deepStrictEqual(r.p.dirtyShots, [1], '미리보기가 고친 것으로 치지도 지우지도 않는다');
  assert.strictEqual(r.p.renderStale, true);
  assert.ok(projectJson(fx).equals(json), 'project.json 도 그대로');
  assert.strictEqual(events.length, 0, '화면 갱신(update)도 없다');
  // 컷 영상(work/render) 도 그대로
  assert.ok(!fs.readdirSync(path.join(fx.dir, 'work', 'render')).some((n) => /preview/.test(n)));
});

test('고치면 다시 만들고(입력이 달라졌다), 안 고쳤으면 그대로: 카메라 · 효과 · 노출 · 그림 · 노래', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  const first = await r.previewShot(1);
  assert.strictEqual((await r.previewShot(1)).cached, true);
  r.setCamera(1, 'truck_in');
  const afterCam = await r.previewShot(1);
  assert.strictEqual(afterCam.cached, false);
  assert.strictEqual((await r.previewShot(1)).cached, true);
  r.setFx(1, ['sparkle']);
  assert.strictEqual((await r.previewShot(1)).cached, false);
  const hold = r.shotOf(1);
  r.retime(1, 0, hold.exposure[0].frames + 12);
  assert.strictEqual((await r.previewShot(1)).cached, false);
  await r.regenerate('drawing', 1, { id: 'A' });
  assert.strictEqual((await r.previewShot(1)).cached, false);
  const last = await r.previewShot(1);
  assert.strictEqual(last.cached, true);
  assert.strictEqual(last.file, first.file, '같은 파일 이름');
  // 다른 장면의 미리보기는 따로 쓰인다
  const other = await r.previewShot(3);
  assert.notStrictEqual(other.file, first.file);
});

test('새 사이 그림을 만들지 않는다: 이미 있는 것만 쓰고 없으면 앞 그림을 그대로 (그림을 바꿨는데 낡은 사이 그림이면 쓰지 않는다)', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  const ibDir = path.join(fx.dir, 'drawings', 'inbetweens');
  const ibBefore = listAll(ibDir);
  assert.ok(ibBefore.length > 0, '움직이는 장면이라 사이 그림이 있다');
  const recs = JSON.stringify(r.p.inbetweens);
  // 1) 그림 한 장을 다시 그려서 그 사이 그림이 낡아졌다 → 쓰지 않고 앞 그림 그대로 (새로 만들지도 않는다)
  await r.regenerate('drawing', 2, { id: 'B' });
  const pv = await r.previewShot(2);
  assert.ok(fs.existsSync(pv.file));
  assert.deepStrictEqual(listAll(ibDir), ibBefore, '사이 그림 폴더가 그대로 (새로 만들지 않았다)');
  assert.strictEqual(JSON.stringify(r.p.inbetweens), recs, '사이 그림 기록도 그대로');
  assert.ok(!r.p.steps.render.message || !/사이 그림 만드는 중/.test(r.p.steps.render.message));
  // 2) 사이 그림 기록을 모두 지워도 (없음) 미리보기는 된다
  r.p.inbetweens = {};
  r.setCamera(2, 'shake'); // 입력이 달라지게
  const pv2 = await r.previewShot(2);
  assert.strictEqual(pv2.cached, false);
  assert.ok(fs.existsSync(pv2.file));
  assert.deepStrictEqual(r.p.inbetweens, {}, '새 기록을 만들지 않는다');
  assert.deepStrictEqual(listAll(ibDir), ibBefore);
  // 3) 그림 파일이 아예 없어도 (다른 그림으로 대신) 미리보기는 된다
  const it = r.itemOf(2, 'C');
  fs.unlinkSync(path.join(fx.dir, it.file));
  r.setCamera(2, 'pan_down');
  const pv3 = await r.previewShot(2);
  assert.ok(fs.existsSync(pv3.file));
});

test('영상을 만드는 중이거나 그 장면을 다시 그리는 중이면 쉬운 말로 거절한다. 틀린 장면 번호도', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  // 영상 만들기(렌더링) 중
  r.running = true;
  r.p.steps.render.status = 'running';
  await assert.rejects(() => r.previewShot(2), /^Error: 지금 영상을 만드는 중이라서 장면 미리보기를 잠깐 못 해요\. 끝나면 다시 눌러 주세요\.$/);
  // 다른 단계(그림 그리는 중)에는 미리볼 수 있다
  r.p.steps.render.status = 'done';
  r.p.steps.drawings.status = 'running';
  const ok = await r.previewShot(2);
  assert.ok(fs.existsSync(ok.file));
  r.running = false;
  r.p.steps.drawings.status = 'done';
  // 그 장면 그림을 다시 그리는 중
  let release;
  const gate = new Promise((res) => { release = res; });
  const orig = r.genImage.bind(r);
  r.genImage = async (a, tag, ctl) => { await gate; return orig(a, tag, ctl); };
  const p = r.regenerate('drawing', 3, { id: 'A' });
  await assert.rejects(() => r.previewShot(3), /이 장면의 그림을 다시 그리는 중이에요\. 끝나면 미리 볼 수 있어요\./);
  const other = await r.previewShot(1); // 다른 장면은 된다
  assert.ok(fs.existsSync(other.file));
  release();
  await p;
  await assert.rejects(() => r.previewShot(9), /장면을 찾을 수 없어요/);
  assert.strictEqual(EC.MSG.previewBusy, '지금 영상을 만드는 중이라서 장면 미리보기를 잠깐 못 해요. 끝나면 다시 눌러 주세요.');
});

test('노래 파일이 없으면 소리 없이 영상만, 직접 넣은 그림(배경 빼기 전)도 먼저 처리해서 보여 준다', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  r.p.music.song = 'music/missing.mp3';
  const pv = await r.previewShot(1);
  assert.strictEqual(pv.hasAudio, false);
  const info = await probe(pv.file);
  assert.ok(info.hasVideo && !info.hasAudio);
  // 배경 빼기가 안 끝난 그림이 있어도 미리보기 전에 처리한다
  const it = r.itemOf(3, 'A');
  Object.assign(it, { keyed: null, cel: null, plate: null, stats: null });
  const saved = [];
  r.on('update', (s) => saved.push(s));
  const pv3 = await r.previewShot(3);
  assert.ok(fs.existsSync(pv3.file));
  assert.strictEqual(it.keyed, true, '배경을 뺐다');
  assert.ok(saved.length >= 1, '그림 항목이 바뀌었으니 저장하고 알린다');
});
