'use strict';
// 편집 테스트용 '다 만든 연습 영상' 한 편 (24초 노래, 컷 3개: 멈춤 · 움직임(그림 6장) · 멈춤, 480p).
// 처음 한 번만 파이프라인을 끝까지 돌려서 임시 폴더에 두고, 이후 테스트는 그 폴더를 통째로 복사해서 쓴다 (테스트 파일끼리도 함께 쓴다).
// 소스 파일이 바뀌면 키가 달라져서 새로 만든다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('../../src/main/store');
const { ProjectRunner } = require('../../src/main/pipeline/runner');
const demo = require('../../src/main/ai/demo');

const SRC = path.join(__dirname, '..', '..', 'src');
const CACHE = path.join(os.tmpdir(), 'animemaker2-edit-fixture');
const SONG_SECONDS = 24;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'assets' && e.name !== 'renderer') walk(f, out); } else if (e.name.endsWith('.js') || e.name.endsWith('.html')) out.push(f);
  }
  return out;
}

function fixtureKey() {
  const h = crypto.createHash('sha1');
  h.update(`${process.version}|${process.env.ANIMEMAKER_RIFE_DIR || ''}|${fs.statSync(__filename).mtimeMs}`);
  for (const f of walk(SRC).sort()) { const st = fs.statSync(f); h.update(`${path.relative(SRC, f)}:${st.size}:${Math.round(st.mtimeMs)}`); }
  return h.digest('hex').slice(0, 12);
}

function newStoreAt(root) {
  return new Store({ userDataDir: path.join(root, 'ud'), documentsDir: path.join(root, 'docs'), downloadsDir: path.join(root, 'dl') });
}

async function build(dest) {
  const root = path.join(dest, 'root');
  const store = newStoreAt(root);
  const { series } = await demo.createDemoSeries(store);
  const wf = { ...store.getWorkflow('builtin-cel-wide'), quality: '480p', minClips: 6, maxClips: 7, minClipSec: 3, maxClipSec: 10, lyricSyncPause: false, reviewBeforeDrawings: false };
  const project = store.createProject('', wf, {}, { seriesId: series.id });
  project.demoSongSeconds = SONG_SECONDS;
  store.saveProject(project);
  const runner = new ProjectRunner({ store, projectId: project.id });
  await runner.run();
  const p = runner.snapshot();
  if (p.status !== 'done') throw new Error(`테스트용 영상을 만들지 못했어요: ${p.error}`);
  fs.writeFileSync(path.join(dest, 'meta.json'), JSON.stringify({ projectId: project.id, seriesId: series.id }));
  fs.writeFileSync(path.join(dest, 'READY'), 'ok');
}

/** 다 만든 영상이 든 캐시 폴더 (없으면 만든다) */
async function ensureFixture() {
  fs.mkdirSync(CACHE, { recursive: true });
  const key = fixtureKey();
  const dir = path.join(CACHE, key);
  if (fs.existsSync(path.join(dir, 'READY'))) return dir;
  const tmp = path.join(CACHE, `${key}.build-${process.pid}-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    await build(tmp);
    try { fs.renameSync(tmp, dir); } catch (_) { fs.rmSync(tmp, { recursive: true, force: true }); } // 다른 테스트가 먼저 만들었다
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  // 예전 키의 폴더는 지운다
  for (const n of fs.readdirSync(CACHE)) {
    if (n === key) continue;
    const f = path.join(CACHE, n);
    try { if (Date.now() - fs.statSync(f).mtimeMs > 6 * 3600 * 1000) fs.rmSync(f, { recursive: true, force: true }); } catch (_) { /* noop */ }
  }
  return dir;
}

/**
 * 다 만든 영상 한 편을 새 임시 폴더에 복사해서 돌려준다 (테스트가 마음대로 고쳐도 된다).
 * @returns {Promise<{root:string, store:Store, projectId:string, seriesId:string, dir:string, runner:()=>ProjectRunner, cleanup:()=>void}>}
 */
async function copyFixture() {
  const src = await ensureFixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am2-edit-'));
  // 파일 시간을 그대로 둔다: 컷 영상 캐시 키에 그림 파일의 수정 시간이 들어 있어서, 시간이 바뀌면 모든 컷을 다시 만든다
  fs.cpSync(path.join(src, 'root'), path.join(root, 'root'), { recursive: true, preserveTimestamps: true });
  const meta = JSON.parse(fs.readFileSync(path.join(src, 'meta.json'), 'utf8'));
  const store = newStoreAt(path.join(root, 'root'));
  return {
    root, store, projectId: meta.projectId, seriesId: meta.seriesId,
    dir: store.projectDir(meta.projectId),
    runner: (o = {}) => new ProjectRunner({ store, projectId: meta.projectId, ...o }),
    cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* noop */ } },
  };
}

module.exports = { copyFixture, ensureFixture, newStoreAt, SONG_SECONDS };
