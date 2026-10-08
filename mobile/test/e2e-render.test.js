// 영상 엔진 진짜 브라우저(Chromium) 시험: 합성 · 24fps 내보내기 · 자막 입히기 · 멈추기 · 미리보기 · 연습용 그림.
// 이 샌드박스의 Chromium 에는 H.264/AAC 인코더가 없고 VP9/Opus 만 된다 → 아래 시험은 VP9/Opus MP4 로 돈다 (폰의 H.264/AAC 는 확인하지 못했다).
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

const require = createRequire(import.meta.url);
const X = require('../../src/main/pipeline/xsheet.js');
const DD = require('../../src/main/ai/demo-data.js');

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
const skip = CHROME ? false : 'Chromium/Chrome 이 없음 (CHROME_PATH 로 지정) — 영상 엔진 브라우저 시험을 건너뜀';
const SHOT_DIR = process.env.AM_SHOTS || '';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.otf': 'font/otf', '.ttf': 'font/ttf', '.txt': 'text/plain' };

let srv;
let browser;
let ctxB;
let page;
let tmp;
const errors = [];

before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-render-e2e-'));
  const missing = [];
  await build({
    absWorkingDir: here, entryPoints: { harness: 'test/render-harness/entry.js' }, bundle: true, format: 'iife', target: TARGET, outdir: tmp,
    sourcemap: 'inline', plugins: [sharedFallbackPlugin(missing)], logLevel: 'warning',
  });
  assert.deepStrictEqual(missing, [], `아직 없는 공용 코드: ${missing}`);
  fs.copyFileSync(path.join(here, 'test', 'render-harness', 'index.html'), path.join(tmp, 'index.html'));
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
  const args = ['--autoplay-policy=no-user-gesture-required'];
  if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
  browser = await chromium.launch({ executablePath: CHROME, args });
  ctxB = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, locale: 'ko-KR' });
  // 만들어진 인코더가 취소 뒤에 모두 닫혔는지 보려고 세어 둔다
  await ctxB.addInitScript(() => {
    window.__enc = [];
    for (const name of ['VideoEncoder', 'AudioEncoder']) {
      const Orig = window[name];
      if (!Orig) continue;
      window[name] = class extends Orig { constructor(init) { super(init); window.__enc.push(this); } };
    }
  });
  page = await ctxB.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.goto(`http://127.0.0.1:${srv.address().port}/`);
  await page.waitForFunction(() => window.__harnessReady === true, null, { timeout: 30000 });
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

/** 데모 타임시트: 컷 3개 (가운데는 움직이는 하이라이트), 컷 사이 전환 fade · dissolve 각 1박(12프레임) */
function buildXs({ seconds, bounds, layers = true }) {
  const edges = [0, ...bounds, seconds];
  const segments = edges.slice(0, -1).map((s, i) => ({ index: i + 1, start: s, end: edges[i + 1], duration: edges[i + 1] - s, lyrics: [], energy: i === 1 ? 'high' : 'mid', level: i === 1 ? 0.9 : 0.5 }));
  const frames = X.shotFrames(segments);
  const highlights = segments.map((s, i) => i === 1);
  const motion = segments.map((s, i) => i === 1);
  const budget = 40;
  const ctx = {
    segments, frames, highlights, motion, mode: 'ghibli', keyRate: 6, layers, budget,
    plan: { characters: [{ name: '하루' }], story: [{ visual_en: 'a rainy town' }, { visual_en: 'flying over rooftops' }, { visual_en: 'sunrise' }] },
    analysis: { beats: [], beatPeriod: 0.5, duration: seconds },
  };
  ctx.alloc = X.allocateDrawings(frames, highlights, Math.max(segments.length, budget - (layers ? segments.length : 0)));
  const raw = DD.demoXsheet(ctx);
  raw.shots[0].transition_out = { type: 'fade', beats: 1 };
  raw.shots[1].transition_out = { type: 'dissolve', beats: 1 };
  return X.normalizeXsheet(raw, ctx);
}

// ---------- ① 합성이 PC 앱과 같은 그림을 만드는가 ----------
const SCENARIOS = [
  { move: 'hold' },
  { move: 'pan_right' },
  { move: 'zoom_in' },
  { move: 'truck_in', frames: [0, 20, 47] },
  { move: 'shake', fx: ['shake'], frames: [0, 5, 13, 40] },
  { move: 'hold', boil: true, frames: [0, 1, 2, 31] },
  { move: 'pan_right', boil: true, frames: [3, 24, 46] },
  { move: 'zoom_out', fx: ['sparkle', 'flash', 'fade_in'], boil: true, frames: [0, 3, 12, 47] },
];

test('합성 ↔ PC 앱(sampleFrame+composite+applyFx): 정지·팬·줌·흔들기·보일·효과, 1280×720 과 720×1280 에서 평균 오차 1단계 이하', { skip, timeout: 300000 }, async (t) => {
  const rows = [];
  for (const [W, H] of [[1280, 720], [720, 1280]]) {
    for (const sc of SCENARIOS) {
      const r = await ev((o) => window.T.parity(o), { W, H, ...sc });
      rows.push(r);
      t.diagnostic(`${W}x${H} ${sc.move}${sc.boil ? '+보일' : ''}${sc.fx ? `+${sc.fx.join('/')}` : ''}: 평균 오차 ${r.mae.toFixed(3)} (장면별 최대 ${Math.max(...r.frames.map((f) => f.max))}, 8단계 넘는 점 ${(Math.max(...r.frames.map((f) => f.bigFrac)) * 100).toFixed(3)}%)`);
      assert.ok(r.mae <= 1, `${W}x${H} ${sc.move}: 평균 오차 ${r.mae}`);
      assert.strictEqual(r.open, 0, '비트맵을 모두 닫았다');
    }
  }
  const all = rows.map((r) => r.mae);
  t.diagnostic(`전체: 평균 ${(all.reduce((a, b) => a + b, 0) / all.length).toFixed(3)}, 최대 ${Math.max(...all).toFixed(3)}`);
});

// ---------- ② 화면전환 ----------
test('화면전환: 경계 프레임은 정확히 반반, 처음은 앞 컷 그대로, 한 방향으로만 바뀐다 (컷 사이 겹침은 읽은 컷 2개까지)', { skip, timeout: 60000 }, async () => {
  const r = await ev(() => window.T.transitionProbe({ xfade: 'fade', T: 12 }));
  const by = Object.fromEntries(r.px.map((p) => [p.r, p]));
  const cut = r.cut;
  assert.deepStrictEqual(by[cut - 6 - 3].rgb, [255, 0, 0]);
  assert.strictEqual(by[cut - 6 - 3].kind, 'single');
  assert.deepStrictEqual(by[cut - 6].rgb, [255, 0, 0], 'k=0 은 앞 컷 그대로');
  assert.strictEqual(by[cut - 6].kind, 'transition');
  assert.ok(Math.abs(by[cut].rgb[0] - 127.5) <= 2 && Math.abs(by[cut].rgb[2] - 127.5) <= 2, `경계 ${by[cut].rgb}`);
  const reds = [];
  for (let k = 0; k < 12; k++) reds.push(by[cut - 6 + k].rgb[0]);
  for (let i = 1; i < reds.length; i++) assert.ok(reds[i] < reds[i - 1], `빨강이 계속 줄어야 해요: ${reds}`);
  assert.ok(Math.abs(reds[1] - 255 * (1 - 1 / 12)) <= 2 && Math.abs(reds[11] - 255 / 12) <= 2, `k=1 · k=11: ${reds[1]} ${reds[11]}`);
  assert.deepStrictEqual(by[cut + 6].rgb, [0, 0, 255], '전환이 끝나면 뒤 컷 그대로');
  assert.strictEqual(by[cut + 6].kind, 'single');
  assert.strictEqual(r.open, 0);
  // 다른 이름들도 한 장은 그려진다 (화면이 안 덮인 곳 없이)
  const probe = await ev(() => window.T.drawTransitionProbe());
  for (const [name, res] of Object.entries(probe)) {
    for (const p of Object.keys(res)) assert.strictEqual(res[p].green, 0, `${name} p=${p}: 안 덮인 곳이 있어요`);
    assert.ok(res[0].r > 250 && res[0].b < 5, `${name} p=0 은 앞 장면`);
    assert.ok(res[1].b > 250 && res[1].r < 5, `${name} p=1 은 뒤 장면`);
  }
  assert.ok(probe.fade[0.5].r > 100 && probe.fade[0.5].b > 100, 'fade 가운데는 섞임');
  assert.ok(probe.slideleft[0.5].r > 60 && probe.slideleft[0.5].b > 60, 'slide 는 반반');
  assert.ok(probe.fadeblack[0.5].r < 5 && probe.fadeblack[0.5].b < 5, 'fadeblack 가운데는 검정');
  assert.ok(probe.fadewhite[0.5].r > 250 && probe.fadewhite[0.5].b > 250, 'fadewhite 가운데는 하양');
});

// ---------- ③ 같은 장은 다시 그리지 않는다 ----------
test('같은 상태는 다시 그리지 않고 재사용 (픽셀은 새로 그린 것과 같다)', { skip, timeout: 60000 }, async () => {
  const still = await ev(() => window.T.reuseProbe({ boil: false }));
  assert.strictEqual(still.reusedCount, 47, '정지 컷 + 보일 끔: 첫 장 빼고 모두 재사용');
  assert.strictEqual(still.mismatch, 0);
  const boil = await ev(() => window.T.reuseProbe({ boil: true }));
  assert.ok(boil.reusedCount >= 20 && boil.reusedCount <= 24, `보일은 2프레임마다 바뀐다: 재사용 ${boil.reusedCount}`);
  assert.strictEqual(boil.mismatch, 0);
  assert.ok(boil.distinct >= 20, '보일이 켜지면 장이 실제로 달라진다');
});

test('노출표: 사이 그림(A~B)이 있으면 그 칸에 쓰고 없으면 앞 그림을 붙든다 · 없는 그림은 셀이면 배경만, 통째 그림이면 빈 카드 · 객체/Map 둘 다', { skip, timeout: 60000 }, async () => {
  const r = await ev(() => window.T.tableProbe());
  assert.deepStrictEqual(r.table.slice(0, 10), ['A', 'A', 'A~B', 'A~B', 'B', 'B', 'A~B', 'A~B', 'A', 'A']);
  const RED = [255, 0, 0];
  const GREEN = [0, 255, 0];
  const BLUE = [0, 0, 255];
  const exp = r.table.map((id) => ({ A: RED, B: GREEN, 'A~B': BLUE }[id]));
  assert.deepStrictEqual(r.withInbetween, exp, '사이 그림이 있으면 그 칸은 사이 그림');
  // 사이 그림이 없으면: 이 시점의 표는 A~B 칸이 모두 앞 그림 (A 4프레임 → A, B 4프레임 → B) 으로 붙든다
  assert.deepStrictEqual(r.without.slice(0, 10), [RED, RED, RED, RED, GREEN, GREEN, GREEN, GREEN, RED, RED]);
  assert.deepStrictEqual(r.missingCel[4], [200, 200, 200], '없는 셀은 투명 → 배경만');
  assert.deepStrictEqual(r.missingCel[0], RED);
  assert.deepStrictEqual(r.pictures[4], [42, 36, 64], '레이어 없는 타임시트의 없는 그림은 빈 카드');
  assert.deepStrictEqual(r.pictures[0], RED);
  assert.deepStrictEqual(r.objectLayers.slice(0, 8), [RED, RED, RED, RED, GREEN, GREEN, GREEN, GREEN], '객체 모양 layers 도 된다');
});

test('필름 알갱이 · 종이(기본은 꺼짐): 켜면 조금 달라지고, 같은 장은 늘 같고, 알갱이는 장마다 다르다', { skip, timeout: 60000 }, async () => {
  const r = await ev(() => window.T.grainPaperProbe());
  assert.ok(r.grainVsBase > 0.5 && r.grainVsBase < 6, `알갱이 세기 ${r.grainVsBase}`);
  assert.strictEqual(r.grainSame, 0, '같은 장 같은 알갱이');
  assert.ok(r.grainNextFrame > 0.5, '다음 장은 알갱이가 다르다');
  assert.ok(Math.abs(r.grainMeanShift) < 2, `알갱이는 밝기를 거의 안 바꾼다 ${r.grainMeanShift}`);
  assert.ok(r.paperVsBase > 3 && r.paperMeanShift < -3, `종이는 곱하기라 어두워진다 ${r.paperVsBase} ${r.paperMeanShift}`);
  assert.strictEqual(r.paperSame, 0);
});

// ---------- ④ 내보내기 · 자막 ----------
const SECONDS = 26;
const XS = skip ? null : buildXs({ seconds: SECONDS, bounds: [8, 17] });

test('깨끗한 원본 내보내기(960×540, 26초 · 3컷 · 연습용 그림과 노래): 프레임 수 정확히, 소리, 메타데이터, 컷 2개 메모리', { skip, timeout: 300000 }, async (t) => {
  assert.strictEqual(XS.totalFrames, SECONDS * 24);
  assert.deepStrictEqual(XS.transitions.map((x) => [x.xfade, x.frames]), [['fade', 12], ['dissolve', 12]]);
  const r = await ev((o) => window.T.exportDemo(o), { xs: XS, W: 960, H: 540, seconds: SECONDS, bpm: 120, name: 'clean' });
  assert.ok(r.ok, JSON.stringify(r.error));
  t.diagnostic(`코덱 ${r.codecs.video}/${r.codecs.audio} · ${(r.bytes / 1e6).toFixed(2)}MB · ${r.ms.toFixed(0)}ms (${r.msPerFrame.toFixed(1)}ms/장) · 재사용 ${r.reused}장 · 동시에 읽은 컷 최대 ${r.maxLoaded}`);
  assert.strictEqual(r.frames, XS.totalFrames);
  assert.ok(['vp9', 'av1', 'avc'].includes(r.codecs.video) && ['opus', 'aac'].includes(r.codecs.audio));
  assert.ok(r.maxLoaded <= 2, `동시에 읽은 컷 ${r.maxLoaded}`);
  assert.strictEqual(r.open, 0, '모든 비트맵을 닫았다');
  assert.deepStrictEqual([...new Set(r.calls)].sort(), [0, 1, 2]);
  assert.strictEqual(r.calls.length, 3, '컷마다 한 번씩만 읽었다');
  assert.ok(r.progress.count > 50 && r.progress.last.fraction >= 0.99 && r.progress.last.stage === 'finalize', JSON.stringify(r.progress.last));
  assert.deepStrictEqual(r.warnings, []);
  const v = await ev(() => window.T.readVideo('clean'));
  assert.strictEqual(v.packets, XS.totalFrames, `영상 프레임 ${v.packets} = ${XS.totalFrames}`);
  assert.ok(Math.abs(v.vdur - XS.totalFrames / 24) <= 1 / 24 + 1e-6, `영상 길이 ${v.vdur}`);
  assert.ok(Math.abs(v.fps - 24) < 0.01, `프레임 속도 ${v.fps}`);
  assert.strictEqual(v.first, 0);
  assert.deepStrictEqual([v.w, v.h], [960, 540]);
  assert.ok(v.acodec, '소리 길');
  assert.ok(Math.abs(v.adur - XS.totalFrames / 24) <= 0.05, `소리 길이 ${v.adur}`);
  assert.strictEqual(v.sr, 48000);
  assert.strictEqual(v.ch, 1, '연습용 노래는 모노 — 모노는 모노로 넣는다');
  assert.strictEqual(v.tags.comment, 'Made with AI (AnimeMaker V2)');
  assert.strictEqual(v.tags.description, 'AI-generated content');
  assert.strictEqual(v.tags.title, '시험 영상');
  // 눈으로 볼 장: 배경 + 인물, 카메라 움직임, 전환 중간, 페이드 인, 효과
  const times = [
    { name: 'clean', t: 0.2, label: '0.2s fade_in' }, { name: 'clean', t: 4, label: '4s 정지 컷' },
    { name: 'clean', t: 8, label: '8s 전환 fade 한가운데' }, { name: 'clean', t: 9, label: '9s 움직임 컷' }, { name: 'clean', t: 12, label: '12s 움직임 컷' },
    { name: 'clean', t: 17, label: '17s 전환 dissolve 한가운데' }, { name: 'clean', t: 20, label: '20s' }, { name: 'clean', t: 25.5, label: '25.5s 끝' },
  ];
  save('clean-sheet', await ev(([it, c, w]) => window.T.sheet(it, c, w), [times, 4, 480]));
  // 배경(해 · 노란 비옷)과 인물이 겹쳐서 보인다: 정지 컷 한가운데에 비옷 노랑(따뜻한 색을 거친)이 있고 해 색도 있다
  const coat = await ev(() => window.T.countColor('clean', 4, [236, 186, 46], 40));
  assert.ok(coat.n > 800, `인물(노란 비옷)이 보여야 해요: ${coat.n}`);
  const sun = await ev(() => window.T.countColor('clean', 4, [247, 235, 185], 30));
  assert.ok(sun.n > 200, `배경(해)이 보여야 해요: ${sun.n}`);
  // 카메라가 움직인다 (같은 컷의 두 시각이 다르다), 처음 장은 페이드 인으로 어둡다, 전환 중간은 두 컷의 섞임
  const move = await ev(() => window.T.diffFrames('clean', 'clean', 9, 25, 12));
  assert.ok(move.mean > 4, `움직임 컷의 두 장이 달라야 해요: ${move.mean}`);
  const f0 = await ev(() => window.T.meanColor('clean', 0));
  const f1 = await ev(() => window.T.meanColor('clean', 1));
  assert.ok(f0[0] + f0[1] + f0[2] < (f1[0] + f1[1] + f1[2]) * 0.6, `fade_in: 첫 장이 어둡다 ${f0} < ${f1}`);
  // 자막은 아직 없다 (깨끗한 원본): 줄이 나올 시각과 아닌 시각의 장이 같은 영상에서 글자 흔적이 없다는 것은 아래 자막 시험에서 final 과 비교한다
});

const LINES = [
  { text: '작은 불빛 하나 따라', start: 2.0, end: 5.5 },
  { text: '낯선 길을 걸어가', start: 6.0, end: 9.0 },
  { text: '날아올라 저 하늘로 멈추지 마 지금 이대로', start: 10.0, end: 14.0 },
  { text: '숨긴 줄', start: 15.0, end: 17.0, hidden: true },
  { text: '반짝이는 우리 꿈이 세상을 물들여', start: 18.0, end: 23.0 },
];

test('자막 입히기(16:9): 소리는 그대로 복사, 프레임 수 같음, 자막 있는 곳만 바뀌고 안전영역 안, 숨긴 줄·줄 없는 시각은 깨끗한 원본과 같음', { skip, timeout: 300000 }, async (t) => {
  const style = { preset: 'basic' };
  const r = await ev((o) => window.T.burnDemo(o), { lines: LINES, style, W: 960, H: 540 });
  assert.ok(r.ok, JSON.stringify(r.error));
  t.diagnostic(`자막 입히기 ${r.ms.toFixed(0)}ms · ${r.codecs.video}/${r.codecs.audio} · 글꼴 대체 ${r.subsFallback}`);
  assert.strictEqual(r.burned, true);
  assert.strictEqual(r.subsFallback, false, '번들 글꼴을 읽었다');
  assert.strictEqual(r.same, false);
  const a = await ev(() => window.T.readVideo('clean'));
  const b = await ev(() => window.T.readVideo('final'));
  assert.strictEqual(b.packets, a.packets, '프레임 수가 같다');
  assert.ok(Math.abs(b.vdur - a.vdur) < 1 / 24 + 1e-6);
  assert.strictEqual(b.acodec, a.acodec);
  assert.strictEqual(b.apackets, a.apackets);
  assert.strictEqual(b.abytes, a.abytes, '소리 패킷을 다시 압축하지 않고 그대로 복사했다');
  assert.strictEqual(b.tags.comment, 'Made with AI (AnimeMaker V2)');
  assert.strictEqual(b.tags.description, 'AI-generated content');
  const safe = await ev(() => window.T.safeRect({ preset: 'basic' }, 960, 540));
  // 줄이 한참 보이는 시각: 바뀐 곳이 있고, 그 바깥 상자가 안전영역 안이다
  for (const [t0, label] of [[4.0, '1번 줄'], [7.5, '2번 줄'], [12.0, '3번 줄(긴 줄)'], [20.5, '5번 줄']]) {
    const d = await ev(([x]) => window.T.diffFrames('clean', 'final', x, 60), [t0]);
    assert.ok(d.count > 150, `${label}: 글자가 보여야 해요 (${d.count})`);
    assert.ok(d.bbox.x0 >= safe.x - 2 && d.bbox.x1 <= safe.x + safe.w + 2 && d.bbox.y0 >= safe.y - 2 && d.bbox.y1 <= safe.y + safe.h + 2, `${label}: 글자 상자 ${JSON.stringify(d.bbox)} 가 안전영역 ${JSON.stringify([safe.x, safe.y, safe.w, safe.h])} 안`);
    // 글자는 아래쪽에 앉는다
    assert.ok(d.bbox.y0 > 540 * 0.6, `${label}: 아래쪽 ${d.bbox.y0}`);
  }
  // 줄이 없는 시각(5.8초 · 숨긴 줄 16초 · 24초)은 깨끗한 원본과 거의 같다
  for (const t0 of [1.0, 5.8, 16.0, 24.5]) {
    const d = await ev(([x]) => window.T.diffFrames('clean', 'final', x, 60), [t0]);
    assert.strictEqual(d.count, 0, `${t0}초에는 글자가 없어야 해요 (${d.count})`);
    assert.ok(d.mean < 3, `${t0}초 다시 압축한 차이 ${d.mean}`);
  }
  // 페이드: 시작 순간은 아직 안 보이고, 0.5초 뒤에는 보인다
  const dStart = await ev(() => window.T.diffFrames('clean', 'final', 2.0, 60));
  const dFull = await ev(() => window.T.diffFrames('clean', 'final', 2.6, 60));
  assert.ok(dStart.count < dFull.count * 0.05, `페이드 인: ${dStart.count} < ${dFull.count}`);
  const sheet = [
    { name: 'final', t: 4, label: '자막 1' }, { name: 'final', t: 12, label: '자막 3 (긴 줄)' }, { name: 'final', t: 20.5, label: '자막 5' },
    { name: 'clean', t: 4, label: '깨끗한 원본 4s' },
  ];
  save('final-16x9-sheet', await ev(([it, c, w]) => window.T.sheet(it, c, w), [sheet, 2, 640]));
});

test('자막 입히기를 끄거나 줄이 없으면 아무것도 다시 만들지 않는다 (깨끗한 원본이 곧 완성본)', { skip, timeout: 60000 }, async () => {
  const off = await ev(() => window.T.burnDemo({ lines: [{ text: 'x', start: 1, end: 2 }], style: { enabled: false }, W: 960, H: 540, name: 'off' }));
  assert.ok(off.ok && off.burned === false && off.same === true);
  const none = await ev(() => window.T.burnDemo({ lines: [{ text: '숨김', start: 1, end: 2, hidden: true }, { text: '', start: 3, end: 4 }], style: { preset: 'basic' }, W: 960, H: 540, name: 'none' }));
  assert.ok(none.ok && none.burned === false && none.same === true);
  assert.strictEqual(none.codecs.audio !== null, true);
});

test('세로(9:16) 영상: 540×960 내보내기와 자막(shorts 모양)이 안전영역(아래 24%)을 지킨다', { skip, timeout: 300000 }, async (t) => {
  const xs = buildXs({ seconds: 6, bounds: [2, 4] });
  const r = await ev((o) => window.T.exportDemo(o), { xs, W: 540, H: 960, seconds: 6, name: 'tall' });
  assert.ok(r.ok, JSON.stringify(r.error));
  t.diagnostic(`9:16 ${r.msPerFrame.toFixed(1)}ms/장 · ${r.codecs.video}`);
  const v = await ev(() => window.T.readVideo('tall'));
  assert.deepStrictEqual([v.w, v.h, v.packets], [540, 960, 144]);
  const lines = [{ text: '날아올라 저 하늘로 멈추지 마 지금 이대로', start: 0.8, end: 5.5 }];
  const style = { preset: 'shorts' };
  const b = await ev((o) => window.T.burnDemo(o), { clean: 'tall', name: 'tallfinal', lines, style, W: 540, H: 960 });
  assert.ok(b.ok && b.burned, JSON.stringify(b.error));
  const safe = await ev(() => window.T.safeRect({ preset: 'shorts' }, 540, 960));
  assert.ok(safe.y + safe.h <= 960 * 0.77, `안전영역 아래 여백 ${safe.y + safe.h}`);
  const d = await ev(() => window.T.diffFrames('tall', 'tallfinal', 3, 60));
  assert.ok(d.count > 150);
  assert.ok(d.bbox.x0 >= safe.x - 2 && d.bbox.x1 <= safe.x + safe.w + 2 && d.bbox.y0 >= safe.y - 2 && d.bbox.y1 <= safe.y + safe.h + 2, `글자 상자 ${JSON.stringify(d.bbox)} 가 안전영역 ${JSON.stringify([safe.x, safe.y, safe.w, safe.h])} 안`);
  const bb = await ev(() => window.T.readVideo('tallfinal'));
  assert.strictEqual(bb.packets, v.packets);
  const sheet = [
    { name: 'tall', t: 0.5, label: '9:16 0.5s' }, { name: 'tall', t: 2.5, label: '9:16 2.5s 움직임' },
    { name: 'tallfinal', t: 3, label: '9:16 자막' }, { name: 'tallfinal', t: 5, label: '9:16 5s' },
  ];
  save('final-9x16-sheet', await ev(([it, c, w]) => window.T.sheet(it, c, w), [sheet, 4, 270]));
});

test('스트리밍 목표(StreamTarget)로도 내보낼 수 있다 (blob 은 null, 조각을 모으면 같은 MP4)', { skip, timeout: 120000 }, async () => {
  const xs = buildXs({ seconds: 4, bounds: [1.5, 3] });
  const r = await ev((o) => window.T.exportStream(o), { xs, W: 320, H: 180 });
  assert.strictEqual(r.blob, null);
  assert.ok(r.chunks >= 1 && r.size > 1000, `조각 ${r.chunks}개, ${r.size}바이트`);
  assert.strictEqual(r.open, 0);
  const v = await ev(() => window.T.readVideo('stream'));
  assert.strictEqual(v.packets, 96);
  assert.strictEqual(v.vcodec !== null, true);
});

// ---------- ⑤ 멈추기 ----------
test('내보내기 멈추기: AbortError, blob 없음, 읽은 그림을 모두 닫고 인코더도 닫힌다 — 멈춘 뒤 다시 해도 된다', { skip, timeout: 120000 }, async () => {
  const xs = buildXs({ seconds: 6, bounds: [2, 4] });
  await ev(() => { window.__enc.length = 0; });
  const r = await ev((o) => window.T.exportDemo(o), { xs, W: 480, H: 270, seconds: 6, name: 'cancelled', cancelAt: 40 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.name, 'AbortError');
  assert.match(r.error.message, /멈췄어요/);
  assert.strictEqual(r.blob, false, 'blob 이 남지 않는다');
  assert.ok(r.progress.last.frame >= 40 && r.progress.last.frame < 144, `중간에 멈췄다: ${r.progress.last.frame}`);
  assert.strictEqual(r.open, 0, '읽은 그림을 모두 닫았다');
  const states = await ev(() => window.__enc.map((e) => e.state));
  assert.ok(states.length >= 1 && states.every((s) => s === 'closed'), `인코더 상태 ${states}`);
  // 멈춘 뒤 같은 조건으로 다시 하면 끝까지 된다
  const again = await ev((o) => window.T.exportDemo(o), { xs, W: 480, H: 270, seconds: 6, name: 'again' });
  assert.ok(again.ok);
  assert.strictEqual(again.frames, 144);
  assert.strictEqual(again.open, 0);
});

test('자막 입히기 멈추기: AbortError, 인코더 닫힘', { skip, timeout: 120000 }, async () => {
  await ev(() => { window.__enc.length = 0; });
  const r = await ev(() => window.T.burnDemo({ clean: 'clean', name: 'burn-cancelled', lines: [{ text: '멈춰 보기', start: 0.2, end: 5 }], style: { preset: 'basic' }, W: 960, H: 540, cancelAt: 30 }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.name, 'AbortError');
  assert.match(r.error.message, /멈췄어요/);
  const states = await ev(() => window.__enc.map((e) => e.state));
  assert.ok(states.every((s) => s === 'closed'), `인코더 상태 ${states}`);
  const has = await ev(() => !!window.T.blobs['burn-cancelled']);
  assert.strictEqual(has, false);
});

test('인코더가 없으면 무거운 일 전에 한국어 오류 (probe 가 실린다)', { skip, timeout: 60000 }, async () => {
  const p2 = await ctxB.newPage();
  await p2.addInitScript(() => { delete window.VideoEncoder; delete window.AudioEncoder; });
  await p2.goto(`http://127.0.0.1:${srv.address().port}/`);
  await p2.waitForFunction(() => window.__harnessReady === true, null, { timeout: 30000 });
  const r = await p2.evaluate(() => window.T.noEncoderProbe());
  await p2.close();
  assert.strictEqual(r.threw, true);
  assert.strictEqual(r.name, 'NoEncoderError');
  assert.match(r.message, /영상을 만들 수 없어요/);
  assert.strictEqual(r.probe.video, null);
  assert.strictEqual(r.probe.webcodecs, false);
  assert.strictEqual(r.open, 0, '그림은 읽기 전에 멈췄다');
});

// ---------- ⑥ 미리보기 ----------
test('미리보기: 시계를 따라 재생, 느리면 건너뜀(시각은 안 늦어짐), 이동·끝·작은 그림, 소리와 맞춤', { skip, timeout: 120000 }, async (t) => {
  const r = await ev(() => window.T.previewProbe());
  t.diagnostic(`조용히: ${JSON.stringify(r.silent)}\n느리게: ${JSON.stringify(r.slow)}\n소리: ${JSON.stringify(r.audio)}`);
  assert.ok(r.silent.monotonic);
  assert.ok(Math.abs(r.silent.last - r.silent.elapsed * 24) <= 6, `조용한 재생이 시계를 따라가요: 장 ${r.silent.last} vs ${r.silent.elapsed * 24}`);
  assert.ok(r.silent.states.includes('playing') && r.silent.states.includes('paused'));
  assert.ok(r.slow.dropped >= 5, `느리면 건너뛴다: ${r.slow.dropped}`);
  assert.ok(r.slow.drawn <= r.slow.expected * 0.6, `그린 장 ${r.slow.drawn} 은 시간이 지난 장수 ${r.slow.expected} 보다 훨씬 적다`);
  assert.ok(Math.abs(r.slow.last - r.slow.expected) <= 8, `그래도 시각은 맞다: ${r.slow.last} vs ${r.slow.expected}`);
  assert.strictEqual(r.seek.frame, 100);
  assert.strictEqual(r.seek2, 36);
  assert.strictEqual(r.still2.type, 'image/jpeg');
  assert.ok(r.still2.size > 300);
  assert.strictEqual(r.still.type, 'image/jpeg');
  assert.deepStrictEqual([r.still.w, r.still.h], [160, 90]);
  assert.ok(r.still.size > 800);
  assert.strictEqual(r.end.ended.length, 1, '끝나면 end 한 번');
  assert.strictEqual(r.end.frame, 119);
  assert.notStrictEqual(r.end.state, 'playing');
  if (r.audio.silent) t.diagnostic('소리 재생이 막혀서 소리 시계 시험은 건너뜀');
  else {
    assert.ok(r.audio.audioTime > 0.8 && r.audio.drift < 0.2, `소리와 화면: ${r.audio.audioTime} vs 장 ${r.audio.frame} (차이 ${r.audio.drift})`);
    assert.strictEqual(r.audio.pausedAfterDispose, true);
  }
  assert.strictEqual(r.open, 0);
});

// ---------- ⑦ 연습용 그림 · 글꼴 ----------
test('연습용 그림: 크기 · 같은 입력 같은 결과 · 컷마다 다름 · 셀은 단색 배경이라 배경 빼기가 된다 · 기준 그림', { skip, timeout: 60000 }, async () => {
  const r = await ev(() => window.T.demoProbe());
  assert.strictEqual(r.bg.type, 'image/png');
  assert.deepStrictEqual(r.bg.size, [640, 360]);
  assert.ok(r.bg.same && r.bg.differsByShot);
  assert.deepStrictEqual(r.cel.key, [0, 255, 0], '초록 배경');
  assert.ok(r.cel.ok && r.cel.bgFraction > 0.8, `배경이 빠진다 ${r.cel.bgFraction}`);
  assert.strictEqual(r.cel.distinct, 4, '자세가 그림마다 다르다');
  assert.deepStrictEqual(r.cel.magentaKey, [255, 0, 255], '팔레트에 초록이 있으면 마젠타');
  assert.deepStrictEqual(r.drawing.size, [640, 360]);
  for (const kind of ['turnaround', 'expressions', 'fullbody']) assert.ok(r.refs[kind].type === 'image/png' && r.refs[kind].size > 1000, kind);
});

test('자막 글꼴: 번들 글꼴을 읽을 때까지 기다리고, 못 읽으면 대체로 알린다', { skip, timeout: 60000 }, async () => {
  const r = await ev(() => window.T.fontProbe());
  assert.deepStrictEqual([r.jua.ok, r.jua.fallback], [true, false]);
  assert.deepStrictEqual([r.pretendard.ok, r.system.ok], [true, true]);
  assert.deepStrictEqual([r.failed.ok, r.failed.fallback], [false, true]);
});

test('시험 중 브라우저 콘솔 오류 0', { skip }, () => {
  assert.deepStrictEqual(errors, []);
});
