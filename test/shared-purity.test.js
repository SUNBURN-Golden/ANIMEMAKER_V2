'use strict';
// 순수성 검사: scripts/shared-modules.js 에 적힌 '데스크톱과 안드로이드가 같이 쓰는' 모듈이 정말 순수한지 소스를 읽어서 확인한다 (새 npm 패키지 없음).
//   (a) Node 내장 모듈·electron·외부 패키지를 require 하지 않는다 (fs, path, os, crypto, child_process, electron, stream, util, zlib, worker_threads, http(s), net, url …)
//   (b) 코드에 Buffer · __dirname · __filename · process. 가 없다 (주석과 글자 안은 빼고 본다).
//       정말 필요한 한 줄만 줄 끝에 `// shared-ok: 이유` 를 적어 예외로 둘 수 있다 (이유가 비어 있으면 예외가 아니다).
//   (c) 상대 경로(`./…`)로 불러오는 파일은 모두 같은 목록 안에 있다 (순수하지 않은 것이 몰래 따라 들어오지 못하게).
// 검사 도구 자체도 시험한다: 일부러 순수하지 않게 만든 가짜 모듈에서는 반드시 실패해야 한다.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHARED = require('../scripts/shared-modules');
const { scan, checkSharedModules } = require('./fixtures/shared-purity-check');

const show = (vs) => vs.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.detail}`).join('\n');

// ---------------------------------------------------------------- 진짜 목록

test('shared-modules list: well-formed, files exist, no duplicates, expected modules present', () => {
  assert.ok(Array.isArray(SHARED) && SHARED.length >= 17);
  const seen = new Set();
  for (const m of SHARED) {
    assert.strictEqual(typeof m, 'object', 'entries are objects {file, dom?}');
    assert.strictEqual(typeof m.file, 'string');
    assert.ok(!m.file.includes('\\') && !m.file.startsWith('/') && !m.file.split('/').includes('..'), `repo-relative with forward slashes: ${m.file}`);
    assert.ok(fs.statSync(path.join(ROOT, m.file)).isFile(), `${m.file} exists`);
    assert.ok(!seen.has(m.file), `no duplicate ${m.file}`);
    seen.add(m.file);
    if ('dom' in m) assert.strictEqual(typeof m.dom, 'boolean');
  }
  const expected = [
    'src/main/pipeline/xsheet.js', 'src/main/media/timeline.js', 'src/main/media/lyrics.js', 'src/main/defaults.js', 'src/main/ai/json.js',
    'src/main/pipeline/prompts.js', 'src/main/characters-core.js', 'src/main/series-core.js', 'src/main/media/keyer-core.js', 'src/main/media/render-core.js',
    'src/main/media/audio-analysis.js', 'src/main/ai/demo-data.js', 'src/main/pipeline/subs-core.js', 'src/shared/subtitle-style.js', 'src/shared/subtitle-render.js',
    'src/shared/camera.js', 'src/renderer/js/lyricsync.js',
  ];
  for (const f of expected) assert.ok(seen.has(f), `${f} is shared`);
  const widget = SHARED.find((m) => m.file === 'src/renderer/js/lyricsync.js');
  assert.ok(widget.dom && widget.browserOnly, 'the lyric-sync widget is the DOM (browser-only) entry');
  for (const m of SHARED.filter((x) => x.dom)) assert.ok(m.file.startsWith('src/renderer/'), `${m.file}: only renderer widgets are dom`);
  for (const m of SHARED.filter((x) => x.file.startsWith('src/main/') || x.file.startsWith('src/shared/'))) assert.ok(!m.dom, `${m.file} must run without a DOM`);
  // 옛 파일(ffmpeg · fs 를 쓰는 쪽)은 목록에 들어가면 안 된다
  for (const f of ['characters.js', 'series.js', 'media/keyer.js', 'media/render.js', 'media/audio.js', 'ai/demo.js']) assert.ok(!seen.has(`src/main/${f}`), `${f} (IO shell) is not shared`);
});

test('every shared module is pure: no Node built-ins / electron, no Buffer / __dirname / process, closed under relative requires', () => {
  const violations = checkSharedModules(ROOT, SHARED);
  assert.deepStrictEqual(violations, [], `\n${show(violations)}`);
});

test('the reader understands every shared module (nothing left open, brackets balance after stripping)', () => {
  for (const { file } of SHARED) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const { skel, errors } = scan(src);
    assert.deepStrictEqual(errors, [], file);
    assert.strictEqual(skel.length, src.length, `${file}: same length`);
    const count = (ch) => skel.split(ch).length - 1;
    for (const [o, c] of [['(', ')'], ['[', ']'], ['{', '}']]) assert.strictEqual(count(o), count(c), `${file}: ${o}${c} balance`);
  }
});

test('the IO shells would be refused if someone added them to the list (the split is not a no-op)', () => {
  for (const f of ['characters.js', 'series.js', 'media/keyer.js', 'media/render.js', 'media/audio.js', 'ai/demo.js']) {
    const vs = checkSharedModules(ROOT, [...SHARED, { file: `src/main/${f}` }]).filter((v) => v.file === `src/main/${f}`);
    assert.ok(vs.length > 0, `src/main/${f} still holds the IO part`);
  }
});

// ---------------------------------------------------------------- 검사 도구 시험 (일부러 순수하지 않은 가짜 모듈)

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am2-purity-'));
  for (const [name, src] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), src);
  }
  return root;
}
const rulesOf = (vs) => vs.map((v) => v.rule).sort();

test('guard: a pure module passes; words inside comments, strings, regexes and templates do not count', () => {
  const root = fixture({
    'a.js': `'use strict';
// Buffer __dirname process.env require('fs') are only words in a comment
/* require("child_process"); Buffer.alloc(1); */
const text = "require('fs') Buffer __filename process.platform // not a comment";
const text2 = 'http://example.com/Buffer';
const re = /['"\`]Buffer|process\\.x/g; const half = 10 / 2 / 5;
const tpl = \`Buffer \${1 + 1} process.env require('os')\`;
const lazy = i => i++ / 2;
const b = require('./b');
module.exports = { text, text2, re, half, tpl, lazy, b };
`,
    'b.js': 'module.exports = { y: 2 };\n',
  });
  const list = [{ file: 'a.js' }, { file: 'b.js' }];
  assert.deepStrictEqual(checkSharedModules(root, list), []);
});

test('guard: Node built-ins, electron, node: prefix and external packages are refused', () => {
  const root = fixture({
    'fs.js': "const fs = require('fs'); module.exports = fs;\n",
    'prefixed.js': 'const p = require("node:path"); module.exports = p;\n',
    'sub.js': "const p = require('fs/promises'); module.exports = p;\n",
    'electron.js': "const { app } = require('electron'); module.exports = app;\n",
    'cp.js': "const cp = require('child_process'); const c = require('crypto'); module.exports = [cp, c];\n",
    'pkg.js': "const x = require('left-pad'); module.exports = x;\n",
  });
  for (const f of ['fs', 'prefixed', 'sub', 'electron', 'cp', 'pkg']) {
    const vs = checkSharedModules(root, [{ file: `${f}.js` }]);
    assert.ok(vs.length >= 1 && vs.every((v) => v.rule === 'builtin-require'), `${f}: ${show(vs)}`);
  }
  assert.strictEqual(checkSharedModules(root, [{ file: 'cp.js' }]).length, 2);
  assert.match(checkSharedModules(root, [{ file: 'pkg.js' }])[0].detail, /외부 패키지/);
  assert.match(checkSharedModules(root, [{ file: 'electron.js' }])[0].detail, /Node 내장 모듈/);
});

test('guard: Buffer, __dirname, __filename, process. in code fail; `// shared-ok: reason` opts one line out', () => {
  const root = fixture({
    'tokens.js': `const a = Buffer.alloc(4);
const b = __dirname + __filename;
const c = process.env.HOME;
const d = process['env'];
const e = \`\${Buffer.from([1])}\`;
module.exports = { a, b, c, d, e };
`,
    'ok.js': `const a = typeof process !== 'undefined';
const b = process.platform; // shared-ok: only labels a debug message
module.exports = { a, b };
`,
    'noreason.js': `const b = process.platform; // shared-ok:
const c = process.env; // shared-ok no colon
module.exports = { b, c };
`,
    'member.js': `const o = {};
module.exports = [o.Buffer, o.process, o.__dirname, 'x'.Buffer];
`,
  });
  const vs = checkSharedModules(root, [{ file: 'tokens.js' }]);
  assert.deepStrictEqual(rulesOf(vs), ['token', 'token', 'token', 'token', 'token', 'token']);
  assert.deepStrictEqual(vs.map((v) => v.line).sort(), [1, 2, 2, 3, 4, 5], 'lines are reported, template expressions are code');
  assert.deepStrictEqual(checkSharedModules(root, [{ file: 'ok.js' }]), [], 'typeof process is only a probe; the opted-out line passes');
  assert.strictEqual(checkSharedModules(root, [{ file: 'noreason.js' }]).length, 2, 'an opt-out needs a reason');
  assert.deepStrictEqual(checkSharedModules(root, [{ file: 'member.js' }]), [], 'property names are not the globals');
});

test('guard: ES module syntax and global.process / globalThis.Buffer cannot hide a Node dependency', () => {
  const root = fixture({
    'esm.js': "import fs from 'fs';\nexport const x = fs;\n",
    'esm2.js': "import 'fs';\nmodule.exports = 1;\n",
    'esm3.js': "export default function f() {}\n",
    'dyn.js': "module.exports = () => import('fs');\n",
    'g.js': "const a = globalThis.process.env; const b = global.Buffer; module.exports = [a, b];\n",
    'fine.js': "// import fs from 'fs'; export const x = 1\nconst s = \"import x from 'y'\"; const o = { import: 1, export: 2 };\nmodule.exports = [s, o.import, o.export, typeof globalThis];\n",
  });
  assert.deepStrictEqual(rulesOf(checkSharedModules(root, [{ file: 'esm.js' }])), ['esm', 'esm'], 'import + export are both caught');
  assert.deepStrictEqual(rulesOf(checkSharedModules(root, [{ file: 'esm2.js' }])), ['esm']);
  assert.deepStrictEqual(rulesOf(checkSharedModules(root, [{ file: 'esm3.js' }])), ['esm']);
  assert.deepStrictEqual(rulesOf(checkSharedModules(root, [{ file: 'dyn.js' }])), ['esm']);
  assert.deepStrictEqual(rulesOf(checkSharedModules(root, [{ file: 'g.js' }])), ['token', 'token']);
  assert.deepStrictEqual(checkSharedModules(root, [{ file: 'fine.js' }]), [], 'words in comments / strings / property names are fine');
});

test('guard: relative requires must resolve and must be listed (transitive impurity cannot sneak in)', () => {
  const root = fixture({
    'main.js': "const h = require('./helper'); const d = require('./dir'); module.exports = [h, d];\n",
    'helper.js': "const fs = require('fs'); module.exports = fs;\n", // 목록에 없음 → 따라 들어오면 안 됨
    'dir/index.js': 'module.exports = 1;\n',
    'gone.js': "module.exports = require('./nope');\n",
    'dyn.js': "const n = 'fs'; module.exports = require(n);\n",
  });
  const vs = checkSharedModules(root, [{ file: 'main.js' }]);
  assert.deepStrictEqual(rulesOf(vs), ['not-in-list', 'not-in-list']);
  assert.match(vs[0].detail, /helper\.js/);
  assert.deepStrictEqual(checkSharedModules(root, [{ file: 'main.js' }, { file: 'dir/index.js' }, { file: 'helper.js' }]).map((v) => `${v.file}:${v.rule}`), ['helper.js:builtin-require'], 'once listed it is checked too');
  assert.deepStrictEqual(rulesOf(checkSharedModules(root, [{ file: 'gone.js' }])), ['unresolved']);
  assert.deepStrictEqual(rulesOf(checkSharedModules(root, [{ file: 'dyn.js' }])), ['dynamic-require']);
  assert.deepStrictEqual(rulesOf(checkSharedModules(root, [{ file: 'missing.js' }])), ['missing']);
});

test('guard: a module made impure after the fact is caught (copy of a real core with one fs line added)', () => {
  const root = fixture({
    'keyer-core.js': `${fs.readFileSync(path.join(ROOT, 'src/main/media/keyer-core.js'), 'utf8')}\nconst fs = require('fs'); // 몰래 들어온 줄\nvoid fs;\n`,
    'render-core.js': fs.readFileSync(path.join(ROOT, 'src/main/media/render-core.js'), 'utf8').replace('new Uint8Array(cw * ch * 3)', 'Buffer.alloc(cw * ch * 3)'),
  });
  const k = checkSharedModules(root, [{ file: 'keyer-core.js' }]);
  assert.deepStrictEqual(rulesOf(k), ['builtin-require']);
  const r = checkSharedModules(root, [{ file: 'render-core.js' }]);
  assert.ok(r.some((v) => v.rule === 'token' && /Buffer/.test(v.detail)), show(r));
  assert.ok(r.some((v) => v.rule === 'unresolved' || v.rule === 'not-in-list'), 'its ../pipeline/xsheet import is outside the fixture root / list');
});
