// 번들 가드: 데스크톱과 폰이 함께 쓰는 공용 모듈(scripts/shared-modules.js)이 브라우저(WebView)용으로 묶이는지,
// Node 전용 기능(fs · path · Buffer · process …)에 기대지 않는지 확인하고 크기를 알려 준다. 폰 앱 묶음 자체도 만들어 본다.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildApp, sharedFallbackPlugin, TARGET, ENTRIES, repoRoot } from '../build-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** scripts/shared-modules.js 가 아직 없을 때(다른 작업이 만드는 중) 쓰는, 지금 순수한 것으로 알려진 목록 */
const FALLBACK = [
  'src/main/pipeline/xsheet.js', 'src/main/media/timeline.js', 'src/main/media/lyrics.js', 'src/main/defaults.js', 'src/main/ai/json.js',
  'src/main/pipeline/subs-core.js', 'src/shared/subtitle-style.js', 'src/shared/subtitle-render.js', 'src/shared/camera.js',
].map((file) => ({ file })).concat([{ file: 'src/renderer/js/lyricsync.js', dom: true }]);

function sharedList() {
  const p = path.join(repoRoot, 'scripts', 'shared-modules.js');
  if (!fs.existsSync(p)) return { source: '(scripts/shared-modules.js 가 아직 없어 기본 목록 사용)', list: FALLBACK };
  const raw = require(p);
  return { source: 'scripts/shared-modules.js', list: raw.map((e) => (typeof e === 'string' ? { file: e } : { file: e.file, dom: !!(e.dom || e.browserOnly) })) };
}

const NODE_BUILTIN = /\brequire\(\s*["'](?:node:)?(?:fs|path|os|crypto|child_process|electron|stream|util|zlib|worker_threads|http|https|net|url|events|buffer|process)["']\s*\)/;
const kb = (n) => `${(n / 1024).toFixed(1)}KB`;

async function bundle(abs, extra = {}) {
  return build({
    entryPoints: [abs], bundle: true, platform: 'browser', target: TARGET, format: 'iife', globalName: '__M',
    write: false, logLevel: 'silent', metafile: true, absWorkingDir: repoRoot, ...extra,
  });
}

const { source, list } = sharedList();

test(`공용 모듈 목록을 읽는다 (${source})`, (t) => {
  assert.ok(list.length >= 9, `공용 모듈이 너무 적어요: ${list.length}`);
  for (const e of list) assert.ok(/^src\/.*\.js$/.test(e.file), `경로 모양: ${e.file}`);
  t.diagnostic(`${list.length}개: ${list.map((e) => path.basename(e.file)).join(', ')}`);
});

for (const entry of list) {
  const abs = path.join(repoRoot, entry.file);
  test(`브라우저용 번들: ${entry.file}${entry.dom ? ' (화면 부품)' : ''}`, async (t) => {
    if (!fs.existsSync(abs)) { t.skip('파일이 아직 없어요'); return; }
    const dev = await bundle(abs);
    assert.deepStrictEqual(dev.errors, []);
    assert.deepStrictEqual(dev.warnings, []);
    const code = dev.outputFiles[0].text;
    assert.ok(!NODE_BUILTIN.test(code), 'Node 내장 모듈을 불러오면 안 돼요');
    // 묶음에 들어간 파일은 전부 저장소 src/ 안의 것 (node_modules 나 데스크톱 전용 파일이 따라 들어오지 않게)
    for (const input of Object.keys(dev.metafile.inputs)) {
      assert.ok(input.startsWith('src/'), `src/ 밖의 파일이 들어왔어요: ${input}`);
      assert.ok(!/(^|\/)(ffmpeg|runner|store|main|preload|cli|agents|helper)\.js$/.test(input), `데스크톱 전용 파일이 따라 들어왔어요: ${input}`);
    }
    const min = await bundle(abs, { minify: true });
    const files = Object.keys(dev.metafile.inputs).length;
    t.diagnostic(`${entry.file}: 묶음 ${kb(dev.outputFiles[0].contents.length)} → 줄이면 ${kb(min.outputFiles[0].contents.length)} (파일 ${files}개)`);
    if (entry.dom) return; // 화면 부품은 document 가 있어야 불러올 수 있다 — Node 에서는 묶이는 것까지만 본다
    // Node 가 아닌 곳처럼: require · module · process · Buffer 가 없는 깨끗한 환경에서 불러와 본다
    const ctx = vm.createContext({ console });
    const api = vm.runInContext(`${code}\n__M`, ctx);
    assert.ok(api && typeof api === 'object' && Object.keys(api).length > 0, '내보내는 것이 있어야 해요');
  });
}

test('폰 앱 묶음(src/main.js · 일꾼 2개)이 만들어지고, 필요한 공용 코드가 모두 있다', async (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'am-bundle-'));
  try {
    const r = await buildApp({ dev: false, out });
    assert.deepStrictEqual(r.missing, [], `아직 없는 공용 코드가 있어요: ${r.missing.join(', ')}`);
    const sizes = {};
    for (const name of Object.keys(ENTRIES)) {
      const f = path.join(out, `${name}.js`);
      assert.ok(fs.existsSync(f), `${name}.js`);
      sizes[name] = fs.statSync(f).size;
    }
    t.diagnostic(`배포용 묶음 크기: ${Object.entries(sizes).map(([k, v]) => `${k} ${kb(v)}`).join(' · ')}`);
    // 일꾼은 화면(DOM)을 쓰지 않는다
    for (const w of ['analyze.worker', 'key.worker']) {
      const code = fs.readFileSync(path.join(out, `${w}.js`), 'utf8');
      assert.ok(!/\b(document|window|localStorage)\b/.test(code), `${w} 는 화면 기능을 쓰면 안 돼요`);
    }
    // 앱 묶음에도 Node 내장 모듈 불러오기가 없다
    assert.ok(!NODE_BUILTIN.test(fs.readFileSync(path.join(out, 'app.js'), 'utf8')));
    // 배포용 묶음에는 개발용 흔적(소스맵)이 없다
    assert.ok(!/sourceMappingURL/.test(fs.readFileSync(path.join(out, 'app.js'), 'utf8')));
    assert.ok(sizes.app < 1.5 * 1024 * 1024, `app.js 가 너무 커요: ${kb(sizes.app)}`);
    assert.ok(fs.existsSync(path.join(out, 'index.html')) && fs.existsSync(path.join(out, 'styles.css')) && fs.existsSync(path.join(out, 'icon.png')));
    assert.ok(fs.existsSync(path.join(out, 'assets', 'fonts', 'Pretendard-Bold.otf')), '번들 글꼴이 www/assets/fonts 에 복사돼요');
    assert.ok(r.fonts >= 5);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('개발용 묶음(AM_DEV)은 www-dev 로 가고 배포용 www 와 섞이지 않는다', async () => {
  const { outDir } = await import('../build-lib.mjs');
  assert.strictEqual(path.basename(outDir(true)), 'www-dev');
  assert.strictEqual(path.basename(outDir(false)), 'www');
  const capacitor = JSON.parse(fs.readFileSync(path.join(here, '..', 'capacitor.config.json'), 'utf8'));
  assert.strictEqual(capacitor.webDir, 'www', 'cap sync 는 배포용 www 만 앱에 넣는다');
  const gi = fs.readFileSync(path.join(here, '..', '.gitignore'), 'utf8');
  assert.match(gi, /^www\/$/m);
  assert.match(gi, /^www-dev\/$/m);
});

test('폰 소스(src/*.js) 파일 하나하나가 브라우저용으로 묶인다 (화면에 아직 안 붙인 tap.js · transitions.js · demo.js 포함)', async (t) => {
  const srcDir = path.join(here, '..', 'src');
  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js')).sort();
  assert.ok(files.length >= 15, `폰 소스 파일 수: ${files.length}`);
  const missing = [];
  for (const f of files) {
    const r = await build({
      entryPoints: [path.join(srcDir, f)], bundle: true, platform: 'browser', target: TARGET, format: 'iife', write: false, logLevel: 'silent',
      define: { __AM_VERSION__: '"test"', __AM_DEV__: 'true' }, plugins: [sharedFallbackPlugin(missing)],
    });
    assert.deepStrictEqual(r.errors, [], f);
    assert.ok(!NODE_BUILTIN.test(r.outputFiles[0].text), `${f}: Node 내장 모듈`);
  }
  assert.deepStrictEqual(missing, [], `아직 없는 공용 코드: ${missing.join(', ')}`);
  t.diagnostic(`묶인 폰 소스: ${files.join(' ')}`);
});
