// 만들기 엔진 진짜 브라우저(Chromium) 시험 — 연습 모드로 끝까지(배경 빼기 일꾼 · 영상 엔진 · 자막) · 뒤로가기 · 콜드 스타트 공유 · 부탁 글 되돌아옴 · 배경 빼기 PC 와 견주기 · 초안
// 이 샌드박스의 Chromium 에는 H.264/AAC 인코더가 없고 VP9/Opus 만 된다 → 영상은 VP9/Opus MP4 로 만들어진다 (폰의 H.264/AAC 는 확인하지 못했다).
// 브라우저: CHROME_PATH → 시스템 Chrome/Chromium → /opt/pw-browsers (없으면 건너뛴다). AM_SHOTS=폴더 를 주면 눈으로 볼 그림(PNG)을 거기에 저장한다.
import test, { before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { sharedFallbackPlugin, TARGET, repoRoot, here } from '../build-lib.mjs';
import { fnv1a } from '../src/engine/util.js';

const require = createRequire(import.meta.url);
const Key = require('../../src/main/media/keyer-core.js');

function findChrome() {
  const cands = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const base of [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', path.join(process.env.HOME || '', '.cache', 'ms-playwright')]) {
    try {
      if (!base) continue;
      for (const d of fs.readdirSync(base).sort().reverse()) if (/^chromium-\d+$/.test(d)) cands.push(path.join(base, d, 'chrome-linux', 'chrome'));
    } catch (_) { /* 없는 폴더 */ }
  }
  return cands.find((c) => c && fs.existsSync(c));
}
const CHROME = findChrome();
const skip = CHROME ? false : 'Chromium/Chrome 이 없음 (CHROME_PATH 로 지정) — 만들기 엔진 브라우저 시험을 건너뜀';
const SHOT_DIR = process.env.AM_SHOTS || '';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.otf': 'font/otf', '.ttf': 'font/ttf', '.txt': 'text/plain' };

let srv;
let browser;
let ctxB;
let page;
let tmp;
let baseUrl;
const errors = [];
const shared = {}; // 시험 사이에 넘기는 값

async function openPage() {
  page = await ctxB.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.goto(baseUrl);
  await page.waitForFunction(() => window.__harnessReady === true, null, { timeout: 30000 });
}

before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-engine-e2e-'));
  const missing = [];
  await build({
    absWorkingDir: here, entryPoints: { harness: 'test/engine-harness/entry.js', 'key.worker': 'src/engine-workers/key.worker.js', 'analyze.worker': 'src/analyze.worker.js' }, bundle: true, format: 'iife', target: TARGET, outdir: tmp,
    sourcemap: 'inline', plugins: [sharedFallbackPlugin(missing)], logLevel: 'warning', define: { __AM_VERSION__: '"e2e"', __AM_DEV__: 'true' },
  });
  assert.deepStrictEqual(missing, [], `아직 없는 공용 코드: ${missing}`);
  fs.copyFileSync(path.join(here, 'test', 'engine-harness', 'index.html'), path.join(tmp, 'index.html'));
  const fontsFrom = path.join(repoRoot, 'src', 'renderer', 'assets', 'fonts');
  fs.mkdirSync(path.join(tmp, 'assets', 'fonts'), { recursive: true });
  for (const f of fs.readdirSync(fontsFrom)) if (/\.(ttf|otf)$/i.test(f)) fs.copyFileSync(path.join(fontsFrom, f), path.join(tmp, 'assets', 'fonts', f));
  srv = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const f = path.join(tmp, u === '/' ? 'index.html' : u);
    if (!f.startsWith(tmp) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${srv.address().port}/`;
  const args = ['--autoplay-policy=no-user-gesture-required'];
  if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
  browser = await chromium.launch({ executablePath: CHROME, args });
  ctxB = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, locale: 'ko-KR' });
  await ctxB.addInitScript(() => {
    window.__enc = [];
    for (const name of ['VideoEncoder', 'AudioEncoder']) {
      const Orig = window[name];
      if (!Orig) continue;
      window[name] = class extends Orig { constructor(init) { super(init); window.__enc.push(this); } };
    }
  });
  await openPage();
});

after(async () => {
  if (ctxB) await ctxB.close();
  if (browser) await browser.close();
  if (srv) srv.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const ev = (fn, arg) => page.evaluate(fn, arg);
const save = (name, b64) => {
  if (!SHOT_DIR) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.writeFileSync(path.join(SHOT_DIR, `${name}.png`), Buffer.from(b64, 'base64'));
};
const FRAME = 1 / 24;

test('연습 모드 에피소드 한 편: 만들기 → 영상 → 자막 → 저장 (진짜 일꾼 · 진짜 영상 엔진). 프레임 수 = 순서표 합계, 오디오+비디오, 자막은 완성본에만', { skip, timeout: 420000 }, async (t) => {
  await ev(() => H.engine('main'));
  const r = await ev(() => H.fullEpisode({ aspect: '16:9', seconds: 20, quality: '480p' }));
  shared.ep = r;
  t.diagnostic(`연습 에피소드 ${r.ms}ms · 컷 ${r.tracks} · 그림 ${r.items}장(배경 뺀 셀 ${r.keyed}, 전체 그림 ${r.unkeyed}) · 총 ${r.totalFrames}프레임 · 일꾼: ${r.ingestMode} · 완성본 ${(r.finalSize / 1024).toFixed(0)}KB / 원본 ${(r.cleanSize / 1024).toFixed(0)}KB`);
  assert.strictEqual(r.status, 'done');
  for (const [s, st] of Object.entries(r.steps)) assert.strictEqual(st, 'done', s);
  assert.strictEqual(r.ingestMode, 'worker', '진짜 Worker 에서 배경을 뺀다');
  assert.ok(r.keyed >= 4 && r.unkeyed === 0, `배경 뺀 셀 ${r.keyed}장, 못 뺀 그림 ${r.unkeyed}장`);
  assert.deepStrictEqual(r.outSize, { w: 854, h: 480 });
  const fin = await ev(() => H.readVideo('ep.final'));
  const cln = await ev(() => H.readVideo('ep.clean'));
  t.diagnostic(`완성본: ${JSON.stringify(fin)}`);
  for (const v of [fin, cln]) {
    assert.strictEqual(v.packets, r.totalFrames, `프레임 수 ${v.packets} == 순서표 ${r.totalFrames} (±0)`);
    assert.ok(Math.abs(v.vdur - r.totalFrames / 24) <= FRAME * 1.01, `길이 ${v.vdur}`);
    assert.ok(v.acodec, '오디오 트랙이 있다');
    assert.ok(v.abytes > 1000, '소리가 실제로 들어 있다');
    assert.ok(Math.abs(v.adur - v.vdur) < 0.15, `소리/영상 길이 ${v.adur}/${v.vdur}`);
    assert.deepStrictEqual([v.w, v.h], [854, 480]);
    assert.strictEqual(v.tags.comment, 'Made with AI (AnimeMaker V2)');
  }
  // 자막: 가사 줄이 나오는 시각에는 완성본에만 글씨가 있다 (안전 영역 안 · 아래쪽)
  const line = r.lines.find((l) => l.end - l.start >= 1.2 && l.end < r.totalFrames / 24 - 0.5) || r.lines[0];
  const tMid = line.start + Math.min(0.9, (line.end - line.start) / 2);
  const d = await ev((a) => H.diffFrames('ep.clean', 'ep.final', a), tMid);
  t.diagnostic(`자막 시각 ${tMid.toFixed(2)}s "${line.text}": 달라진 픽셀 ${d.count}, 상자 ${JSON.stringify(d.bbox)}`);
  assert.ok(d.count > 300, `완성본에 글씨가 있어야 해요 (${d.count})`);
  assert.ok(d.bbox.y0 > d.h * 0.55 && d.bbox.y1 < d.h * 0.96, `글씨는 화면 아래쪽 안전 영역 안: ${JSON.stringify(d.bbox)}`);
  assert.ok(d.bbox.x0 > d.w * 0.04 && d.bbox.x1 < d.w * 0.96);
  // 가사가 없는 시각에는 두 영상이 같다 (다시 인코딩한 잡음만)
  const lines = [...r.lines].sort((a, b) => a.start - b.start);
  let gap = null;
  for (let i = 0; i < lines.length - 1; i++) if (lines[i + 1].start - lines[i].end > 0.6) { gap = (lines[i].end + lines[i + 1].start) / 2; break; }
  if (gap == null && lines[0].start > 0.8) gap = lines[0].start / 2;
  if (gap != null) {
    const g = await ev((a) => H.diffFrames('ep.clean', 'ep.final', a), gap);
    assert.ok(g.count < d.count / 20, `가사 없는 시각은 거의 같다 (${g.count} vs ${d.count})`);
    assert.ok(g.mean < 4, `평균 차이 ${g.mean}`);
  } else t.diagnostic('가사 없는 시각을 못 찾아서 건너뜀');
  save('engine-final-16x9', await ev((a) => H.framePng('ep.final', a), tMid));
  save('engine-clean-16x9', await ev((a) => H.framePng('ep.clean', a), tMid));
  save('engine-final-first', await ev(() => H.framePng('ep.final', 1.0)));
  // 자막 파일 · 순서표 · 저장된 그림
  assert.match(r.srt, /-->/);
  assert.match(r.lrc, /\[\d\d:\d\d\.\d\d\]/);
  assert.ok(r.output.burned && r.output.video !== r.output.clean && r.output.srt && r.output.lrc);
  assert.strictEqual(r.subsFallback, false);
  const info = await ev(async () => {
    const e = H.eng();
    const s = await e.projects.get((await e.projects.list())[0].id);
    const cel = s.drawings.find((d) => d.kind === 'cel' && d.keyed);
    const bg = s.drawings.find((d) => d.kind === 'bg');
    return { cel: await H.pictureInfo('main', s.id, cel.key), bg: await H.pictureInfo('main', s.id, bg.key), blobKeys: (await H.db.listFileKeys(`${s.id}/`)).length };
  });
  assert.ok(info.cel.cel && info.cel.cel.type === 'image/webp', '셀은 WebP');
  assert.deepStrictEqual(info.cel.cel.corners, [0, 0, 0, 0], '모서리는 투명');
  assert.ok(info.cel.cel.opaqueFraction > 0.01 && info.cel.cel.opaqueFraction < 0.6, `불투명 비율 ${info.cel.cel.opaqueFraction}`);
  assert.ok(Math.max(info.cel.w, info.cel.h) <= 1536 && Math.max(info.bg.w, info.bg.h) <= 1536, '원본은 긴 변 1536px 이하');
  assert.strictEqual(info.bg.picType, 'image/webp');
  assert.strictEqual(info.bg.cel, undefined, '배경 판은 셀이 없다');
});

test('뒤로가기(D1): 영상 만드는 중 "계속 하기" → 끝난 영상이 저장되고 목록에 나온다 · "그만두기" → 멈춤, 파일 없음, 인코더 모두 닫힘', { skip, timeout: 300000 }, async () => {
  await ev(() => H.engine('back'));
  const id = await ev(() => H.startEpisode({ name: 'back', aspect: '9:16', seconds: 10, quality: '480p' }));
  const g = await ev((a) => H.guardBackDuringRender(a), { name: 'back', id, choice: 'continue' });
  assert.strictEqual(g, 'continue');
  const fin = await ev(() => H.finishFill());
  assert.deepStrictEqual(fin, { ok: true, status: 'done' });
  const rows = await ev(() => H.listProjects('back'));
  const row = rows.find((x) => x.id === id);
  assert.ok(row && row.hasVideo && row.status === 'done' && row.burned);
  assert.ok((await ev((a) => H.outputSize('back', a), id)) > 10000, '완성본이 저장돼 있다');
  // 그만두기
  const id2 = await ev(() => H.startEpisode({ name: 'back', aspect: '9:16', seconds: 10, quality: '480p' }));
  const g2 = await ev((a) => H.guardBackDuringRender(a), { name: 'back', id: id2, choice: 'stop' });
  assert.strictEqual(g2, 'cancelled');
  const fin2 = await ev(() => H.finishFill());
  assert.strictEqual(fin2.ok, false);
  assert.strictEqual(fin2.error, 'AbortError');
  const st = await ev((a) => H.eng('back').projects.get(a).then((s) => ({ status: s.status, render: s.steps.render.status, clean: s.output.clean, out: null })), id2);
  assert.deepStrictEqual([st.status, st.render, st.clean], ['stopped', 'stopped', null]);
  assert.deepStrictEqual(await ev((a) => H.db.listFileKeys(`${a}/out/`), id2), [], '멈춘 영상은 파일을 남기지 않는다');
  const enc = await ev(() => H.encoders());
  assert.ok(enc.length >= 2 && enc.every((s) => s === 'closed'), `인코더가 모두 닫혀야 해요: ${enc}`);
  // 이어서 만들면 끝까지 간다
  const done = await ev((a) => H.eng('back').demo.fill(a).then((s) => s.status), id2);
  assert.strictEqual(done, 'done');
});

test('부탁 글이 되돌아오는 사고(D3): 클립보드에 남은 부탁 글을 붙여넣으면 거절 · 번호 없음/다름도 거절 · 번호가 맞으면 받는다', { skip, timeout: 120000 }, async () => {
  await ev(() => H.engine('echo'));
  const id = await ev(() => H.aiProject('echo', { seconds: 10 }));
  await ev((a) => H.eng('echo').run(a), id);
  const r = await ev((a) => H.echo('echo', a), id);
  assert.deepStrictEqual({ ...r, planBefore: r.planBefore === null }, { kind: 'plan', clipIsPrompt: true, echo: 'echo', noNonce: 'noNonce', stale: 'noNonce', planBefore: true, ok: true, applied: 'plan', after: true });
});

test('배경 빼기 일꾼 vs PC 계산: 같은 그림의 알파·색·통계·해시가 같고, PC 의 processCel(ffmpeg)과도 같다 · 큰 그림은 1536px 로 줄인다', { skip, timeout: 180000 }, async (t) => {
  const big = await ev(() => H.bigImage());
  assert.strictEqual(Math.max(big.w, big.h), 1536);
  assert.ok(Math.abs(big.w / big.h - 3000 / 1800) < 0.01);
  assert.strictEqual(big.origType, 'image/webp');
  const par = await ev(() => H.keyParity({ keyColor: '#00ff00', W: 640, H: 360 }));
  assert.strictEqual(par.mode, 'worker');
  assert.ok(par.keyed);
  const n = par.w * par.h;
  const input = new Uint8ClampedArray(Buffer.from(par.inputB64, 'base64'));
  assert.strictEqual(input.length, n * 4);
  const k = Key.keyCel(input, par.w, par.h, { expect: '#00ff00' });
  assert.ok(k.ok);
  assert.strictEqual(par.source, Key.rgbToHex(k.key));
  assert.strictEqual(par.hash, fnv1a(k.rgba), '일꾼의 결과 바이트 = PC 의 keyCel 결과');
  const st = Key.colorStats(k.rgba, n);
  for (let c = 0; c < 3; c++) {
    assert.ok(Math.abs(par.stats.mean[c] - st.mean[c]) < 1e-9 && Math.abs(par.stats.std[c] - st.std[c]) < 1e-9);
  }
  assert.strictEqual(par.stats.n, st.n);
  // 저장된 셀(무손실 WebP)을 다시 읽으면: 알파는 정확히, 불투명한 곳의 색도 정확히
  const cel = new Uint8ClampedArray(Buffer.from(par.celB64, 'base64'));
  let alphaDiff = 0; let opaqueDiff = 0; let soft = 0; let softErr = 0;
  for (let i = 0; i < n; i++) {
    const a = k.rgba[i * 4 + 3];
    if (cel[i * 4 + 3] !== a) alphaDiff++;
    if (a === 255) { if (cel[i * 4] !== k.rgba[i * 4] || cel[i * 4 + 1] !== k.rgba[i * 4 + 1] || cel[i * 4 + 2] !== k.rgba[i * 4 + 2]) opaqueDiff++; }
    else if (a > 0) { soft++; softErr += Math.abs(cel[i * 4] - k.rgba[i * 4]) + Math.abs(cel[i * 4 + 1] - k.rgba[i * 4 + 1]) + Math.abs(cel[i * 4 + 2] - k.rgba[i * 4 + 2]); }
  }
  t.diagnostic(`저장된 셀 vs 계산: 알파 다른 픽셀 ${alphaDiff}, 불투명 색 다른 픽셀 ${opaqueDiff}, 반투명 ${soft}개 평균 오차 ${soft ? (softErr / soft / 3).toFixed(2) : 0}`);
  assert.strictEqual(alphaDiff, 0, '알파 채널은 정확히 같다');
  assert.strictEqual(opaqueDiff, 0, '불투명한 곳의 색도 정확히 같다');
  if (soft) assert.ok(softErr / soft / 3 < 12, '반투명 가장자리는 캔버스가 곱했다 나누는 오차만');
  // 가장자리가 흐린(안티앨리어싱) 그림: 알파는 여전히 정확히, 반투명 가장자리의 색은 캔버스가 곱했다 나누는 오차만
  const sp = await ev(() => H.keyParity({ keyColor: '#00ff00', W: 640, H: 360, soft: true }));
  const sIn = new Uint8ClampedArray(Buffer.from(sp.inputB64, 'base64'));
  const sk = Key.keyCel(sIn, sp.w, sp.h, { expect: '#00ff00' });
  assert.ok(sk.ok && sp.keyed);
  assert.strictEqual(sp.hash, fnv1a(sk.rgba), '흐린 가장자리 그림도 일꾼의 결과 바이트 = PC 의 keyCel 결과');
  const sCel = new Uint8ClampedArray(Buffer.from(sp.celB64, 'base64'));
  let sAlphaDiff = 0; let sOpaqueDiff = 0; let sSoft = 0; let sErr = 0; let sMax = 0;
  for (let i = 0; i < sp.w * sp.h; i++) {
    const a = sk.rgba[i * 4 + 3];
    if (sCel[i * 4 + 3] !== a) sAlphaDiff++;
    if (a === 255) { if (sCel[i * 4] !== sk.rgba[i * 4] || sCel[i * 4 + 1] !== sk.rgba[i * 4 + 1] || sCel[i * 4 + 2] !== sk.rgba[i * 4 + 2]) sOpaqueDiff++; }
    else if (a > 0) { sSoft++; const e = Math.max(Math.abs(sCel[i * 4] - sk.rgba[i * 4]), Math.abs(sCel[i * 4 + 1] - sk.rgba[i * 4 + 1]), Math.abs(sCel[i * 4 + 2] - sk.rgba[i * 4 + 2])); sErr += e; if (e > sMax) sMax = e; }
  }
  t.diagnostic(`흐린 가장자리: 반투명 ${sSoft}개, 알파 다른 픽셀 ${sAlphaDiff}, 불투명 색 다른 픽셀 ${sOpaqueDiff}, 반투명 색 오차 평균 ${sSoft ? (sErr / sSoft).toFixed(2) : 0} 최대 ${sMax}`);
  assert.ok(sSoft > 100, `흐린 가장자리에 반투명 픽셀이 있어야 해요 (${sSoft})`);
  assert.strictEqual(sAlphaDiff, 0);
  assert.strictEqual(sOpaqueDiff, 0);
  assert.ok(sErr / sSoft < 12, `반투명 가장자리 색 오차 ${(sErr / sSoft).toFixed(2)}`);
  // 한 장 정리하는 데 걸리는 시간 (이 샌드박스; 폰은 더 느리다고 가정해야 한다)
  const tm = await ev(() => H.keyTiming());
  t.diagnostic(`1536×864 한 장 정리(일꾼): 셀 ${tm.cel.join('/')}ms · 배경 판 ${tm.pic}ms · plate ${tm.plate}ms`);
  assert.ok(tm.cel.every((x) => x < 5000));
  // 배경색 위에 얹은 그림(plate)
  const plate = Buffer.from(par.plateB64, 'base64');
  const expect = Key.overKey(k.rgba, n, '#00ff00');
  let perr = 0;
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) perr += Math.abs(plate[i * 4 + c] - expect[i * 3 + c]);
  assert.ok(perr / (n * 3) < 1.5, `plate 평균 오차 ${(perr / (n * 3)).toFixed(3)}`);
  // PC 의 processCel (ffmpeg 로 읽고 쓴다)
  let KE = null;
  try { KE = require('../../src/main/media/keyer.js'); } catch (e) { t.diagnostic(`PC keyer.js 를 못 불러와서 ffmpeg 견주기는 건너뜀: ${e.message}`); }
  if (KE) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-parity-'));
    try {
      fs.writeFileSync(path.join(dir, 'in.png'), Buffer.from(par.pngB64, 'base64'));
      const res = await KE.processCel(path.join(dir, 'in.png'), { celOut: path.join(dir, 'cel.png'), plateOut: path.join(dir, 'plate.png'), keyColor: '#00ff00', refStats: null });
      assert.ok(res.keyed);
      assert.strictEqual(res.source, par.source);
      const dcel = await KE.readRgba(path.join(dir, 'cel.png'));
      assert.strictEqual(fnv1a(dcel.data), par.hash, 'PC 가 쓴 셀 PNG 를 다시 읽은 바이트 = 일꾼의 결과');
      for (let c = 0; c < 3; c++) assert.ok(Math.abs(res.stats.mean[c] - par.stats.mean[c]) < 1e-9);
      t.diagnostic('PC processCel(ffmpeg) 와 일꾼의 셀 해시 일치');
    } catch (e) {
      if (/ffmpeg|ENOENT|spawn/i.test(String(e && e.message))) t.diagnostic(`ffmpeg 를 쓸 수 없어서 PC processCel 견주기는 건너뜀: ${e.message}`);
      else throw e;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('초안(애니매틱): 그림 두 장만 받은 채로 영상을 따로 만든다 — 없는 그림은 카드, 프레임 수 = 순서표 합계, 작품 상태는 그대로', { skip, timeout: 240000 }, async (t) => {
  await ev(() => H.engine('draft'));
  const id = await ev(() => H.aiProject('draft', { seconds: 10, aspect: '9:16' }));
  const d = await ev((a) => H.drive('draft', a), id);
  assert.strictEqual(d.waiting, `image:${d.nextKey}`);
  const placed = await ev((a) => H.place('draft', a.id, a.keys), { id, keys: d.queue.slice(0, 2) });
  assert.strictEqual(placed.placed.length, 2);
  assert.strictEqual(placed.failed, 0);
  await ev((a) => H.eng('draft').whenIdle(a), id);
  const out = await ev((a) => H.drawDraft('draft', a), id);
  assert.ok(out.missing === d.total - 2, `없는 그림 ${out.missing}`);
  const v = await ev(() => H.readVideo('draft'));
  const snap = await ev((a) => H.eng('draft').projects.get(a).then((s) => ({ frames: s.xsheet.totalFrames, status: s.status, clean: s.output.clean, w: s.outSize.w })), id);
  t.diagnostic(`초안 ${JSON.stringify(v)}`);
  assert.strictEqual(v.packets, snap.frames);
  assert.ok(v.acodec, '초안에도 노래가 들어 있다');
  assert.ok(Math.max(v.w, v.h) <= 640);
  assert.strictEqual(snap.status, 'waiting');
  assert.strictEqual(snap.clean, null);
  save('engine-draft-9x16', await ev(() => H.framePng('draft', 3.0)));
});

test('콜드 스타트 공유(D2): 프로세스가 죽은 뒤 공유로 켜지면 그림이 기다리던 칸으로 · 자리를 못 찾으면 받은 함에 · 네이티브 복사본은 저장 뒤에 지움 · 끝난 영상은 그대로 남아 있다', { skip, timeout: 240000 }, async (t) => {
  await ev(() => H.engine('cold'));
  const id = await ev(() => H.aiProject('cold', { seconds: 10, aspect: '9:16' }));
  const d = await ev((a) => H.drive('cold', a), id);
  const req = await ev((a) => H.eng('cold').handoff.request(a).then((r) => ({ kind: r.kind, key: r.key, nonce: r.nonce })), id);
  assert.ok(req.key && req.nonce);
  // --- 프로세스가 죽었다 (페이지를 새로 읽는다: 메모리는 사라지고 IndexedDB 만 남는다)
  await page.close();
  await openPage();
  assert.strictEqual(await ev(() => Object.keys(H.E).length), 0, '메모리는 비었다 (엔진이 없다)');
  const blobSpec = { kind: req.kind, shot: Number(req.key.split(':')[0]), W: 576, H: 1024 };
  const out = await ev(async (a) => {
    const blob = await H.coldBlob(a.spec);
    const entry = (idn, b) => ({ id: idn, receivedAt: Date.now(), text: '', items: [{ path: `/cache/shared/${idn}.png`, name: `${idn}.png`, mime: 'image/png', size: b.size, blob: b }] });
    H.engine('cold', { inbox: [entry('cold1', blob)] });
    const e = H.eng('cold');
    await e.start();
    const ok = await H.untilDone('cold', a.id, a.key);
    const s = await e.projects.get(a.id);
    const d0 = s.drawings.find((x) => x.key === a.key);
    return { ok, acked: H.E.cold.native.acked, keyed: d0.keyed, info: await H.pictureInfo('cold', a.id, a.key), db: await H.dbStats(), tray: (await e.handoff.tray(a.id)).length, status: s.status, waiting: s.waiting && s.waiting.key, exp: await H.db.getExpecting() };
  }, { id, key: req.key, spec: blobSpec });
  assert.ok(out.ok, '기다리던 칸에 그림이 들어갔다');
  assert.deepStrictEqual(out.acked, ['cold1']);
  assert.deepStrictEqual(out.db, { inbox: 0, inboxFiles: 0 }, '쓴 것은 받은 함에서 빠진다');
  assert.strictEqual(out.tray, 0);
  assert.strictEqual(out.status, 'waiting', '이어서 다음 부탁으로');
  assert.notStrictEqual(out.waiting, `image:${req.key}`);
  assert.ok(out.info.picType === 'image/webp' && Math.max(out.info.w, out.info.h) <= 1536);
  if (req.kind === 'cel') assert.strictEqual(out.info.keyed, true);
  // --- 기다리는 칸이 없는데 그림이 오면: 받은 함에 남는다 (아무것도 버리지 않는다)
  const late = await ev(async (a) => {
    await H.db.clearExpecting();
    const blob = await H.coldBlob({ kind: 'bg', shot: 1, W: 576, H: 1024 });
    const entry = (idn, b) => ({ id: idn, receivedAt: Date.now(), text: '', items: [{ path: `/cache/shared/${idn}.png`, name: `${idn}.png`, mime: 'image/png', size: b.size, blob: b }] });
    H.engine('late', { inbox: [entry('late1', blob), entry('late2', blob)] });
    const e = H.eng('late');
    await e.start();
    for (let i = 0; i < 200 && H.E.late.native.acked.length < 2; i++) await H.sleep(20);
    const tray = await e.handoff.tray(a);
    return { acked: H.E.late.native.acked.sort(), tray: tray.map((x) => ({ kind: x.kind, suggest: !!(x.suggest && x.suggest.key) })), db: await H.dbStats() };
  }, id);
  assert.deepStrictEqual(late.acked, ['late1', 'late2']);
  assert.strictEqual(late.tray.length, 2);
  assert.ok(late.tray.every((x) => x.kind === 'image' && x.suggest));
  assert.strictEqual(late.db.inbox, 2);
  // --- 앞에서 끝낸 연습 에피소드(다른 프로세스에서 만든 것)도 그대로 열린다
  const kept = await ev(async (a) => {
    const e = H.eng('late');
    const rows = await e.projects.list();
    const ep = rows.find((x) => x.id === a);
    const blob = await e.render.output(a, 'video');
    return { ep: ep && { hasVideo: ep.hasVideo, status: ep.status, progress: ep.progress }, size: blob && blob.size, total: rows.length };
  }, shared.ep.id);
  assert.ok(kept.ep && kept.ep.hasVideo && kept.ep.status === 'done' && kept.ep.progress.done === 7);
  assert.strictEqual(kept.size, shared.ep.finalSize, '프로세스가 죽었다 켜져도 완성본이 그대로');
  t.diagnostic(`저장된 작품 ${kept.total}개`);
});

test('콘솔 오류 · 페이지 오류가 없었다', { skip }, () => {
  assert.deepStrictEqual(errors.filter((e) => !/Failed to load resource: the server responded with a status of 404.*favicon/.test(e)), []);
});
