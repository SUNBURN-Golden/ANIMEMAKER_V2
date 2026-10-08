// 폰 앱 웹 부분 묶기 (esbuild). build.mjs 와 시험(test/*.test.js)이 같이 쓴다.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..');
/** 묶음 하나 = 파일 하나 (IIFE). app 은 화면, 나머지는 Worker 일꾼 */
export const ENTRIES = { app: 'src/main.js', 'analyze.worker': 'src/analyze.worker.js', 'key.worker': 'src/engine-workers/key.worker.js' };
/** WebCodecs 가 들어온 Chrome 94 (src/probe.js 의 MIN_CHROME 과 같다) */
export const TARGET = ['chrome94'];

/** 개발용 묶음(AM_DEV=1 / --dev)은 www-dev 에 쓴다: 시험 직후 cap sync 를 해도 개발용 묶음이 앱에 들어가지 못하게 (www 는 늘 배포용) */
export function outDir(dev) {
  return path.join(here, dev ? 'www-dev' : 'www');
}

/**
 * 데스크톱 쪽 공용 코드(../src/**)가 아직 없을 때(다른 작업이 만드는 중) 빌드가 멈추지 않게 한다:
 * 없는 파일은 "쓰는 순간 알기 쉬운 오류가 나는" 빈 껍데기로 대신하고 missing 에 적는다. 파일이 생기면 저절로 진짜가 쓰인다.
 */
export function sharedFallbackPlugin(missing = []) {
  const srcRoot = path.join(repoRoot, 'src') + path.sep;
  return {
    name: 'am-shared-fallback',
    setup(b) {
      b.onResolve({ filter: /^(\.\.\/)+src\// }, (args) => {
        const abs = path.resolve(args.resolveDir, args.path);
        if (!abs.startsWith(srcRoot)) return null;
        if (fs.existsSync(abs)) return null;
        const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
        if (!missing.includes(rel)) missing.push(rel);
        return { path: rel, namespace: 'am-missing' };
      });
      b.onLoad({ filter: /.*/, namespace: 'am-missing' }, (args) => ({
        contents: `module.exports = new Proxy({}, { get(_, k) { if (typeof k === 'symbol' || k === '__esModule' || k === 'then') return undefined; throw new Error(${JSON.stringify(`공용 코드 ${args.path} 가 아직 없어요`)} + ' (' + String(k) + ')'); } });`,
        loader: 'js',
      }));
    },
  };
}

function copyFonts(out) {
  const from = path.join(repoRoot, 'src', 'renderer', 'assets', 'fonts');
  const to = path.join(out, 'assets', 'fonts');
  if (!fs.existsSync(from)) return 0;
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(from)) {
    if (!/\.(ttf|otf|woff2?)$/i.test(f) && !/^OFL.*\.txt$/i.test(f)) continue;
    fs.copyFileSync(path.join(from, f), path.join(to, f));
    n++;
  }
  return n;
}

/**
 * @param {{dev?:boolean, out?:string}} [o]
 * @returns {Promise<{out:string, dev:boolean, version:string, missing:string[], fonts:number}>}
 */
export async function buildApp({ dev = false, out = outDir(dev) } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const missing = [];
  await build({
    absWorkingDir: here,
    entryPoints: ENTRIES,
    bundle: true,
    format: 'iife',
    target: TARGET,
    outdir: out,
    minify: !dev,
    sourcemap: dev ? 'inline' : false,
    legalComments: 'linked',
    define: { __AM_VERSION__: JSON.stringify(pkg.version), __AM_DEV__: dev ? 'true' : 'false' },
    plugins: [sharedFallbackPlugin(missing)],
    logLevel: 'warning',
  });
  fs.copyFileSync(path.join(here, 'src', 'index.html'), path.join(out, 'index.html'));
  fs.copyFileSync(path.join(here, 'src', 'styles.css'), path.join(out, 'styles.css'));
  const icon = path.join(repoRoot, 'build', 'icon.png'); // V2 아이콘 (런처 아이콘도 이것으로 만든다: tools/make-icons.py)
  if (!fs.existsSync(icon)) throw new Error(`V2 아이콘이 없어요: ${icon}`);
  fs.copyFileSync(icon, path.join(out, 'icon.png'));
  const fonts = copyFonts(out);
  return { out, dev, version: pkg.version, missing, fonts };
}
