// 엔진 묶음 시험 (Node + esbuild): 엔진 전체가 브라우저용으로 묶이는지(Node 내장 모듈 없이) · 일꾼 묶음 · PC 쪽 공용 코드 순수성 · 공개 입구가 약속한 이름을 모두 가졌는지
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { sharedFallbackPlugin, TARGET, here, repoRoot, buildApp } from '../build-lib.mjs';
import { newEngine } from './engine-fixtures.js';

const require = createRequire(import.meta.url);
const NODE_BUILTIN = /require\(["'](?:node:)?(?:fs|path|os|crypto|child_process|events|stream|util|zlib|worker_threads|electron)["']\)/;

test('엔진(src/engine/index.js)이 브라우저용으로 묶인다: Node 내장 모듈 없음 · 빠진 공용 코드 없음', async (t) => {
  const missing = [];
  const r = await build({
    absWorkingDir: here, entryPoints: [path.join(here, 'src/engine/index.js')], bundle: true, platform: 'browser', target: TARGET, format: 'iife', globalName: '__E', write: false, logLevel: 'silent',
    define: { __AM_VERSION__: '"t"', __AM_DEV__: 'true' }, plugins: [sharedFallbackPlugin(missing)], minify: true,
  });
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(missing, []);
  const code = r.outputFiles[0].text;
  assert.ok(!NODE_BUILTIN.test(code), 'Node 내장 모듈이 따라 들어왔어요');
  t.diagnostic(`엔진 묶음(줄임): ${(code.length / 1024).toFixed(0)}KB`);
  const m = require('node:module');
  assert.ok(m);
});

test('앱 묶음 만들기에 배경 빼기 일꾼(engine-workers/key.worker)이 들어 있고 화면 기능을 안 쓴다', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'am-eng-bundle-'));
  try {
    const r = await buildApp({ dev: false, out });
    assert.deepStrictEqual(r.missing, []);
    const code = fs.readFileSync(path.join(out, 'key.worker.js'), 'utf8');
    assert.ok(code.length > 5000, `일꾼 크기 ${code.length}`);
    assert.ok(!/\b(document|window|localStorage)\b/.test(code));
    assert.ok(/ingest/.test(code) && /plate/.test(code));
    // 일꾼에 받은 일을 보내 보면 모르는 일은 한국어 오류로 답한다
    const posted = [];
    const ctx = vm.createContext({ self: { postMessage: (m) => posted.push(m) }, console, setTimeout, createImageBitmap: undefined, OffscreenCanvas: undefined });
    vm.runInContext(code, ctx);
    await ctx.self.onmessage({ data: { id: 7, type: 'nope' } });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(posted[0])), { id: 7, type: 'nope', ok: false, code: 'failed', error: '알 수 없는 일이에요' });
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('PC 쪽 edits-core.js 는 순수하다(공용 목록에 넣어도 순수성 검사를 통과한다) — 목록에 넣어 달라는 요청의 근거', () => {
  const SHARED = require('../../scripts/shared-modules.js');
  const { checkSharedModules } = require('../../test/fixtures/shared-purity-check.js');
  const list = [...SHARED, { file: 'src/main/pipeline/edits-core.js' }];
  const bad = checkSharedModules(repoRoot, list);
  assert.deepStrictEqual(bad, [], bad.map((v) => `${v.file}:${v.line} ${v.rule}`).join('\n'));
});

test('공개 입구: 약속한 이름이 모두 있다 (C3 가 기대는 표면)', () => {
  const { engine } = newEngine();
  const names = {
    top: ['projects', 'run', 'stop', 'continueReview', 'skipWaiting', 'applyChanges', 'whenIdle', 'handoff', 'drawings', 'edits', 'render', 'demo', 'start', 'on', 'dispose'],
    projects: ['create', 'get', 'peek', 'list', 'delete', 'rename', 'on'],
    handoff: ['request', 'send', 'acceptText', 'acceptFiles', 'tray', 'place', 'discard', 'routeInbox', 'requestCharacter'],
    drawings: ['regenerate', 'regenerateCut', 'cancelRedraw', 'replace', 'restoreVersion', 'skip', 'unskip', 'finishEarly', 'queue', 'blob'],
    edits: ['retime', 'setCamera', 'setFx', 'setTransition', 'setMotion', 'estimateMotion', 'setSubtitleStyle', 'setLyricLines', 'saveSubtitles', 'updateLyricsText', 'updateLyrics', 'updatePlan', 'replaceSong', 'setBpm', 'setBarNudge', 'applyChanges'],
    render: ['run', 'createCompositor', 'output', 'fileName'],
    demo: ['fill', 'ensureSeries'],
  };
  for (const [k, list] of Object.entries(names)) {
    const obj = k === 'top' ? engine : engine[k];
    for (const n of list) assert.strictEqual(typeof obj[n] === 'function' || (obj[n] && typeof obj[n] === 'object'), true, `${k}.${n}`);
  }
});
