// C3b 화면 진짜 브라우저(Chromium 412×915) 시험 — 완성 화면 · 가사 자막 스튜디오 · 가사 시간 맞추기 창 · 장면 고치기.
// 진짜 앱 묶음(buildApp dev)을 띄우고 window.AnimeMaker.mountForTest 로 화면 하나씩 올려서 진짜 손가락 동작(Playwright 클릭)으로 눌러 본다.
// 연습 모드(providers:'demo')로 만든 짧은 영상(16:9 · 9:16)을 먼저 엔진으로 끝까지 만들어 둔다 (진짜 일꾼 · 진짜 영상 엔진).
// 이 샌드박스의 Chromium 에는 H.264/AAC 인코더가 없고 VP9/Opus 만 된다 → 영상은 VP9/Opus MP4. 실기기·네이티브 저장은 못 해 봤고 native 는 가짜로 끼운다.
// AM_SHOTS=폴더 를 주면 눈으로 볼 그림(PNG)을 저장한다.
import test, { before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { chromium } from 'playwright-core';
import { buildApp } from '../build-lib.mjs';

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
const skip = CHROME ? false : 'Chromium/Chrome 이 없음 (CHROME_PATH 로 지정) — C3b 화면 브라우저 시험을 건너뜀';
const SHOT_DIR = process.env.AM_SHOTS || '';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.otf': 'font/otf', '.ttf': 'font/ttf', '.txt': 'text/plain' };
const LYRICS = [
  '함께 걸어가요 오늘도', '별빛이 쏟아지는 밤하늘 아래', '손을 잡고 달려가요 우리', '바람이 전해 주는 노래를 따라',
  '두렵지 않아 너와 함께라면', '웃음이 번지는 이 길 위에서', '꿈을 향해 날아올라요', '반짝이는 내일이 기다려요',
].join('\n');

let srv; let browser; let ctxB; let page; let tmp; let baseUrl;
const errors = [];
const fx = {}; // 만들어 둔 연습 영상 { wide, tall }

async function openPage() {
  page = await ctxB.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.goto(baseUrl);
  await page.evaluate(() => window.AnimeMaker.ready);
}

before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-studio-e2e-'));
  const built = await buildApp({ dev: true, out: tmp });
  assert.deepStrictEqual(built.missing, [], `아직 없는 공용 코드: ${built.missing}`);
  srv = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const f = path.join(tmp, u === '/' ? 'index.html' : u);
    if (!f.startsWith(tmp) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'accept-ranges': 'bytes' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${srv.address().port}/`;
  const args = ['--autoplay-policy=no-user-gesture-required'];
  if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
  browser = await chromium.launch({ executablePath: CHROME, args });
  ctxB = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, locale: 'ko-KR', hasTouch: true, isMobile: true, acceptDownloads: true });
  await openPage();
  // 연습 영상 두 편 (가로 18초 · 세로 12초, 480p) — 시험 사이에 IndexedDB 에 남는다
  for (const [key, aspect, seconds, lyr] of [['wide', '16:9', 18, LYRICS], ['tall', '9:16', 12, LYRICS], ['bare', '16:9', 8, '']]) {
    fx[key] = await page.evaluate(async ({ aspect: a, seconds: s, lyrics }) => {
      const e = window.AnimeMaker.engine;
      const songBlob = await e.services.demo.song({ seconds: s, bpm: 120 });
      const id = await e.projects.create({ workflow: 'demo', aspect: a, quality: '480p', songBlob, songName: '연습.wav', lyricsText: lyrics });
      const snap = await e.demo.fill(id);
      return { id, status: snap.status, lines: snap.timing.lyrics.length, out: snap.output.hasVideo, burned: snap.output.burned, size: snap.outSize };
    }, { aspect, seconds, lyrics: lyr });
    assert.strictEqual(fx[key].status, 'done', `${key} 연습 영상이 끝까지 만들어져야 해요`);
  }
});

after(async () => {
  if (ctxB) await ctxB.close();
  if (browser) await browser.close();
  if (srv) srv.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const ev = (fn, arg) => page.evaluate(fn, arg);
async function shot(name) {
  if (!SHOT_DIR) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
}
/** 화면 하나 올리기 (가짜 native 를 끼운다) */
async function mount(name, id) {
  await unmount();
  await ev(() => { document.querySelectorAll('.test-host, .sheet-back, .busy').forEach((e) => e.remove()); document.documentElement.classList.remove('ss-open'); });
  await ev(async ({ name: n, id: i }) => {
    window.__native = {
      saved: [], shared: [],
      async saveToGallery(blob, nm) { window.__native.saved.push({ size: blob.size, name: nm, type: blob.type }); return { saved: true, folder: 'Movies/AnimeMaker V2' }; },
      async shareFile(blob, nm, text) { window.__native.shared.push({ size: blob.size, name: nm, text }); },
    };
    window.__closed = [];
    window.__mt = await window.AnimeMaker.mountForTest(n, i, { native: window.__native, onClose: (r) => window.__closed.push(r || {}) });
  }, { name, id });
}
async function unmount() {
  await ev(() => { if (window.__mt) { window.__mt.ctx.onClose(); window.__mt = null; } });
  await page.waitForTimeout(100);
}
const box = (sel) => page.locator(sel).first().boundingBox();

test('완성 화면(가로): 영상이 열리고 단추가 48px 이상 · 저장/공유가 영상 덩어리를 넘긴다 · 연습 안내', { skip, timeout: 120000 }, async () => {
  await mount('done', fx.wide.id);
  await page.waitForFunction(() => { const v = document.querySelector('.dn-video'); return v && v.videoWidth > 0 && v.readyState >= 2; }, null, { timeout: 30000 });
  const v = await ev(() => { const el = document.querySelector('.dn-video'); return { w: el.videoWidth, h: el.videoHeight, dur: el.duration, src: el.currentSrc.startsWith('blob:') }; });
  assert.deepStrictEqual([v.w, v.h], [854, 480]);
  assert.ok(v.src && v.dur > 15, `영상 길이 ${v.dur}`);
  for (const sel of ['.dn-save', '.dn-share', '.dn-row2 .btn:nth-child(1)', '.dn-row2 .btn:nth-child(2)']) {
    const b = await box(sel);
    assert.ok(b && b.height >= 48, `${sel} 높이 ${b && b.height}`);
  }
  assert.ok(await page.locator('.dn-practice').isVisible(), '연습 모드 안내 카드');
  assert.ok(!(await page.locator('.dn-next').isVisible()), '시리즈가 없으면 다음 화 단추를 숨긴다');
  assert.match(await page.locator('.dn-note').innerText(), /AI 로 만든 영상/);
  await shot('done-wide');
  await page.locator('.dn-save').tap();
  await page.waitForFunction(() => window.__native.saved.length === 1);
  const sv = await ev(() => window.__native.saved[0]);
  assert.ok(sv.size > 20000 && /\.mp4$/.test(sv.name), JSON.stringify(sv));
  await expectToast(/갤러리에 저장했어요/);
  await page.locator('.dn-share').tap();
  await page.waitForFunction(() => window.__native.shared.length === 1);
  assert.match(await ev(() => window.__native.shared[0].text), /AI 로 만든/);
  await unmount();
});

/** 첫 긴 일 앞의 알림 설명 창(C3a 의 ensureNotify): 어느 쪽을 골라도 이어서 한다 */
async function answerNotify(which = 'screen') {
  try { await page.waitForSelector('.sheet-back', { timeout: 4000 }); } catch (_) { return false; }
  const sh = page.locator('.sheet-back').last();
  if (!/알림을 켤까요/.test(await sh.innerText())) return false;
  await sh.locator('.btn', { hasText: which === 'on' ? '알림 켜기' : '화면 켜 둔 채로' }).click();
  return true;
}

async function expectToast(re) {
  await page.waitForFunction((src) => [...document.querySelectorAll('.toast')].some((t) => new RegExp(src).test(t.textContent)), re.source, { timeout: 8000 });
}

test('완성 화면(세로 9:16): 영상이 높이에 맞고 단추가 화면 안에 있다', { skip, timeout: 120000 }, async () => {
  await mount('done', fx.tall.id);
  await page.waitForFunction(() => { const v = document.querySelector('.dn-video'); return v && v.videoWidth > 0; }, null, { timeout: 30000 });
  const st = await box('.dn-stage');
  assert.ok(st.height > st.width, `세로 영상 ${st.width}x${st.height}`);
  assert.ok(st.height <= 915 * 0.46, `영상이 너무 커요 ${st.height}`);
  const save = await box('.dn-save');
  assert.ok(save.y + save.height <= 915, '저장 단추가 첫 화면 안에 있다');
  await shot('done-tall');
  await unmount();
});


// ───────────────────────── 가사 자막 스튜디오 ─────────────────────────
/** 자막 그림판(.ss-ov)에 그려진 것의 통계: 칠한 점 수 · 바깥 상자 · 노랑 점 수 · 흰 점 수 · 지문 */
const ovStats = () => ev(() => {
  const c = document.querySelector('.ss-ov');
  const { width: w, height: h } = c;
  const d = c.getContext('2d').getImageData(0, 0, w, h).data;
  let n = 0; let x0 = w; let y0 = h; let x1 = -1; let y1 = -1; let yellow = 0; let white = 0; let hash = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = d[i + 3];
      if (!a) continue;
      n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      hash = (hash * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7 + a * 13) | 0;
      if (a > 230 && d[i] > 200 && d[i + 1] > 180 && d[i + 2] < 140) yellow++;
      if (a > 230 && d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) white++;
    }
  }
  return { n, x0, y0, x1, y1, w, h, yellow, white, hash };
});
const waitDraw = () => page.waitForTimeout(220);
async function openStudio(key) {
  await mount('substudio', fx[key].id);
  await page.waitForFunction(() => { const v = document.querySelector('.ss-video'); return v && v.videoWidth > 0 && v.readyState >= 2; }, null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('.ss-pthumb').length === 7 && [...document.querySelectorAll('.ss-pthumb')].every((c) => { const g = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < g.length; i += 97) s += g[i] + g[i + 1] + g[i + 2]; return s > 0; }), null, { timeout: 30000 });
  await waitDraw();
}
const tab = (name) => page.locator(`.ss-tab[data-t="${name}"]`).click();

test('자막 스튜디오(가로): 꾸밈 모음 7개 · 크기/위치/색/글꼴이 자막을 바꾼다 · 처음 모양으로', { skip, timeout: 120000 }, async () => {
  await openStudio('wide');
  await shot('studio-look');
  const tiles = await page.locator('.ss-ptile').count();
  assert.strictEqual(tiles, 7);
  const t0 = await box('.ss-ptile');
  assert.ok(t0.width >= 90, `꾸밈 칸 너비 ${t0.width}`);
  for (const sel of ['.ss-play', '.ss-tab', '.ss-save', '.ss-opt', '.ss-ftile']) { const b = await box(sel); assert.ok(b.height >= 48 - 0.5, `${sel} 높이 ${b.height}`); }
  const first = await ovStats();
  assert.ok(first.n > 500, `첫 가사가 영상 위에 그려져야 해요 (${first.n})`);
  assert.ok(first.white > 100, '기본 모양은 흰 글씨');
  // 크기: 작게 → 아주 크게
  await page.locator('.ss-seg.cols4 .ss-opt[data-v="s"]').first().click(); await waitDraw();
  const small = await ovStats();
  await page.locator('.ss-seg.cols4 .ss-opt[data-v="xl"]').first().click(); await waitDraw();
  const big = await ovStats();
  assert.ok(big.n > small.n * 1.6, `아주 크게 ${big.n} > 작게 ${small.n}`);
  // 위치
  await page.locator('.ss-seg.cols3 .ss-opt[data-v="top"]').first().click(); await waitDraw();
  const up = await ovStats();
  assert.ok(up.y1 < up.h * 0.5, `위쪽 ${up.y1}/${up.h}`);
  await page.locator('.ss-seg.cols3 .ss-opt[data-v="bottom"]').first().click(); await waitDraw();
  const down = await ovStats();
  assert.ok(down.y0 > down.h * 0.5, `아래쪽 ${down.y0}/${down.h}`);
  // 글자 색 (노랑)
  await page.locator('.ss-sw[data-c="#ffe14d"]').click(); await waitDraw();
  const yel = await ovStats();
  assert.ok(yel.yellow > 100 && yel.white < big.white / 3, `노랑 ${yel.yellow} 흰 ${yel.white}`);
  // 글꼴
  const before = await ovStats();
  await page.locator('.ss-ftile[data-f="jua"]').click();
  await page.waitForTimeout(800);
  const after = await ovStats();
  assert.notStrictEqual(after.hash, before.hash, '글꼴을 바꾸면 글자 모양이 달라진다');
  assert.strictEqual(await page.locator('.ss-ftile[data-f="jua"]').getAttribute('aria-pressed'), 'true');
  // 꾸밈 모음 하나 고르기
  await page.locator('.ss-ptile[data-p="storybook"]').click(); await waitDraw();
  assert.strictEqual(await page.locator('.ss-ptile[data-p="storybook"]').getAttribute('aria-pressed'), 'true');
  assert.ok(await page.locator('.ss-dirty').isVisible(), '바뀐 곳이 있다는 표시');
  assert.match(await page.locator('.ss-save').innerText(), /저장하고 영상에 입히기 \(약/);
  await shot('studio-look-changed');
  // 처음 모양으로
  await page.locator('.ss-reset').click(); await waitDraw();
  const reset = await ovStats();
  assert.strictEqual(reset.hash, first.hash, '처음 모양으로 되돌리면 처음과 같은 그림');
  assert.ok(!(await page.locator('.ss-dirty').isVisible()));
  await unmount();
});

const secOf = (txt) => { const m = /(\d+):(\d+(?:\.\d+)?)/.exec(txt); return Number(m[1]) * 60 + Number(m[2]); };
const rowsText = () => page.locator('.ss-row').count();

test('자막 스튜디오: 글자 탭 — 글 고치기 · 경고 · 나누기/합치기/숨기기/지우기/되돌리기 · 줄 추가', { skip, timeout: 120000 }, async () => {
  await openStudio('wide');
  await tab('text');
  assert.strictEqual(await rowsText(), 8);
  const ta = page.locator('.ss-row').first().locator('textarea');
  await ta.click();
  await waitDraw();
  const o1 = await ovStats();
  await ta.fill('새로운 가사로 바꿨어요');
  await waitDraw();
  const o2 = await ovStats();
  assert.ok(o2.n > 200 && o2.hash !== o1.hash, '글을 고치면 영상 위 자막이 바로 바뀐다');
  await ta.fill('이 줄은 아주아주 길어서 열여섯 글자를 훌쩍 넘어가는 가사예요 정말로');
  await waitDraw();
  assert.match(await page.locator('.ss-row').first().locator('.ss-warn').innerText(), /보다 길어요/);
  await ta.fill('짧은 글');
  const warnNow = await page.locator('.ss-row').first().locator('.ss-warn').innerText(); // 첫 줄은 0.45초만 떠 있어서 '너무 짧아요' 경고는 맞다
  assert.ok(!/16자/.test(warnNow), `짧은 글에는 '16자보다 길어요' 경고가 없다 (${warnNow})`);
  assert.strictEqual(await page.locator('.ss-row').first().locator('.ss-ico').nth(1).evaluate((b) => b.getBoundingClientRect().height >= 47.5), true, '⋯ 단추 48px');
  // 나누기 → 합치기
  const row2 = page.locator('.ss-row').nth(1);
  const ta2 = row2.locator('textarea');
  const orig2 = await ta2.inputValue();
  await ta2.click();
  await ta2.evaluate((el) => el.setSelectionRange(4, 4));
  await row2.locator('.ss-ico').nth(1).click();
  await shot('studio-line-menu');
  await page.locator('.ss-menu-btn', { hasText: '나누기' }).click();
  assert.strictEqual(await rowsText(), 9);
  assert.strictEqual(await ta2.inputValue(), '별빛이');
  assert.strictEqual(await page.locator('.ss-row').nth(2).locator('textarea').inputValue(), '쏟아지는 밤하늘 아래');
  await page.locator('.ss-row').nth(1).locator('.ss-ico').nth(1).click();
  await page.locator('.ss-menu-btn', { hasText: '합치기' }).click();
  assert.strictEqual(await rowsText(), 8);
  assert.strictEqual(await page.locator('.ss-row').nth(1).locator('textarea').inputValue(), orig2);
  // 숨기기 → 다시 보이기
  await page.locator('.ss-row').nth(2).locator('.ss-ico').nth(1).click();
  await page.locator('.ss-menu-btn', { hasText: '숨기기' }).click();
  assert.strictEqual(await page.locator('.ss-row.hid').count(), 1);
  assert.ok(await page.locator('.ss-row.hid .ss-hidden-badge').isVisible());
  await page.locator('.ss-row.hid .ss-ico').nth(1).click();
  await page.locator('.ss-menu-btn', { hasText: '다시 보이기' }).click();
  assert.strictEqual(await page.locator('.ss-row.hid').count(), 0);
  // 지우기 → ↩ 되돌리기
  await page.locator('.ss-row').last().locator('.ss-ico').nth(1).click();
  await page.locator('.ss-menu-btn', { hasText: '지우기' }).click();
  assert.strictEqual(await rowsText(), 7);
  await page.locator('.ss-undo').click();
  assert.strictEqual(await rowsText(), 8);
  // 줄 추가 → 새 줄에 글자 커서
  await page.locator('.ss-add').click();
  assert.strictEqual(await rowsText(), 9);
  assert.strictEqual(await ev(() => document.activeElement && document.activeElement.classList.contains('ss-ta') && document.activeElement.value === ''), true, '새 줄에 커서가 간다');
  await shot('studio-text');
  assert.ok(await ev(() => window.__mt.handle.isDirty()), '고친 것이 있다');
  await unmount();
});

test('자막 스튜디오: 시간 탭 — 0.1초 단추 · 끝 단추 · 지금 여기가 시작 · 모두 미루기', { skip, timeout: 120000 }, async () => {
  await openStudio('wide');
  await tab('time');
  assert.strictEqual(await page.locator('.ss-trow').count(), 8);
  const row = page.locator('.ss-trow').nth(2);
  const start = async (r = row) => secOf(await r.locator('.ss-tval').first().innerText());
  const end = async (r = row) => r.locator('.ss-tval').nth(1).innerText();
  const s0 = await start();
  await row.locator('.ss-tbtn', { hasText: '＋ 0.1초' }).click();
  assert.ok(Math.abs((await start()) - (s0 + 0.1)) < 0.06, '+0.1초');
  await row.locator('.ss-tbtn', { hasText: '− 0.1초' }).click();
  await row.locator('.ss-tbtn', { hasText: '− 0.1초' }).click();
  assert.ok(Math.abs((await start()) - (s0 - 0.1)) < 0.06, '−0.1초');
  const e0 = secOf(await end());
  await row.locator('.ss-tbtn', { hasText: '끝 ＋' }).click(); // 이어지는 줄은 다음 줄 시작에서 끝나서 더 늘릴 수 없다
  await expectToast(/더 늘릴 수 없어요/);
  await row.locator('.ss-tbtn', { hasText: '끝 −' }).click();
  assert.ok(Math.abs(secOf(await end()) - (e0 - 0.1)) < 0.06 && /🔒/.test(await end()), `끝 −0.1초 (정한 끝 표시) ${e0} → ${await end()}`);
  // 지금 여기가 시작: 조절줄을 눌러 이 줄이 떠 있던 한가운데로 간 뒤
  const lyr = await ev(({ id }) => window.AnimeMaker.engine.projects.peek(id).timing.lyrics.map((l) => [l.start, l.end]), { id: fx.wide.id });
  const mid = (lyr[3][0] + lyr[3][1]) / 2;
  const row4 = page.locator('.ss-trow').nth(3);
  const bb = await box('.ss-bar');
  await page.locator('.ss-bar').click({ position: { x: (mid / 18) * bb.width, y: bb.height / 2 } });
  await page.waitForTimeout(250);
  const cur = await ev(() => document.querySelector('.ss-video').currentTime);
  await row4.locator('.ss-tbtn.here').click();
  assert.ok(Math.abs((await start(row4)) - cur) < 0.12, `지금 위치 ${cur} → 시작 ${await start(row4)}`);
  // 모두 미루기
  const f0 = await start(page.locator('.ss-trow').first());
  await page.locator('.ss-shift', { hasText: '미루기' }).click();
  assert.ok(Math.abs((await start(page.locator('.ss-trow').first())) - (f0 + 0.1)) < 0.06, '모두 0.1초 미루기');
  await shot('studio-time');
  await unmount();
});

test('자막 스튜디오: 탭으로 맞추기 창이 열리고 저장하면 시간이 바뀐다 · 취소는 그대로', { skip, timeout: 120000 }, async () => {
  await openStudio('wide');
  await tab('time');
  const row = page.locator('.ss-trow').first();
  const s0 = secOf(await row.locator('.ss-tval').first().innerText());
  // 취소
  await page.locator('.ss-tapbtn').click();
  await page.waitForSelector('.sheet-back.ts-full .ls');
  const sh = await box('.sheet-back.ts-full .sheet');
  assert.ok(sh.height > 915 * 0.9, `창이 화면을 거의 채운다 ${sh.height}`);
  const hasStage = await ev(() => !!document.querySelector('.sheet-back.ts-full .ls-stage'));
  assert.ok(hasStage);
  await page.waitForTimeout(500);
  await shot('tapsync-open');
  await page.locator('.sheet-back.ts-full .sheet-btns .btn').first().click();
  await page.waitForSelector('.sheet-back.ts-full', { state: 'detached' });
  assert.ok(Math.abs(secOf(await row.locator('.ss-tval').first().innerText()) - s0) < 0.01, '취소하면 그대로');
  // 맞추기: 노래 틀고 세 번 [지금!]
  await page.locator('.ss-tapbtn').click();
  await page.waitForSelector('.sheet-back.ts-full .ls-big');
  const big = page.locator('.sheet-back.ts-full .ls-big');
  await big.click();
  for (let i = 0; i < 3; i++) { await page.waitForTimeout(600); await big.click(); }
  await page.waitForTimeout(300);
  await shot('tapsync-tapped');
  await page.locator('.sheet-back.ts-full .sheet-btns .btn.primary').click();
  // 다 안 맞췄다는 확인 → 그대로 저장
  await page.waitForSelector('.sheet-back.top .btn.primary, .sheet-back:last-child .btn.primary');
  await page.locator('.sheet-back').last().locator('.btn.primary').click();
  await page.waitForSelector('.sheet-back', { state: 'detached' });
  const s1 = secOf(await row.locator('.ss-tval').first().innerText());
  assert.ok(s1 < 2.5 && s1 !== s0, `첫 줄이 탭한 시간(약 0.5초)으로 ${s0} → ${s1}`);
  assert.strictEqual(await page.locator('.ss-trow').count(), 8);
  assert.ok(await ev(() => window.__mt.handle.isDirty()));
  await unmount();
});

test('자막 스튜디오: 저장하고 영상에 입히기 — 덮개 · 완성본이 깨끗한 원본과 자막 자리만 다르다 · 새 모양이 들어간다', { skip, timeout: 240000 }, async () => {
  await openStudio('wide');
  await tab('text');
  const ta = page.locator('.ss-row').first().locator('textarea');
  await ta.fill('반짝반짝 별빛');
  await tab('look');
  await page.locator('.ss-ptile[data-p="yellow"]').click();
  await waitDraw();
  assert.match(await page.locator('.ss-save').innerText(), /저장하고 영상에 입히기/);
  await page.locator('.ss-save').click();
  assert.ok(await answerNotify('screen'), '첫 긴 일 앞에 알림 설명이 한 번 나온다');
  await page.waitForSelector('.busy');
  await shot('studio-saving');
  await page.waitForFunction(() => window.__closed.length === 1, null, { timeout: 200000 });
  const closed = await ev(() => window.__closed[0]);
  assert.strictEqual(closed.applied, true);
  const snap = await ev(({ id }) => { const s = window.AnimeMaker.engine.projects.peek(id); return { preset: s.subtitleStyle.preset, text: s.timing.lyrics[0].text, burned: s.output.burned, changes: s.changes.count, status: s.status, t0: s.timing.lyrics[0].start, t1: s.timing.lyrics[0].end }; }, { id: fx.wide.id });
  assert.deepStrictEqual([snap.preset, snap.text, snap.burned, snap.changes, snap.status], ['yellow', '반짝반짝 별빛', true, 0, 'done']);
  await expectToast(/자막을 입혔어요/);
  const t = snap.t0 + Math.min(0.9, (snap.t1 - snap.t0) / 2);
  const d = await ev(async ({ id, t: tt }) => {
    const e = window.AnimeMaker.engine;
    const grab = async (blob, at) => {
      const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.src = URL.createObjectURL(blob);
      await new Promise((r, j) => { v.addEventListener('loadeddata', r, { once: true }); v.addEventListener('error', () => j(new Error('video error')), { once: true }); });
      v.currentTime = at; await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
      const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
      const g = c.getContext('2d'); g.drawImage(v, 0, 0); URL.revokeObjectURL(v.src);
      return g.getImageData(0, 0, c.width, c.height);
    };
    const fin = await e.render.output(id, 'video'); const cln = await e.render.output(id, 'clean');
    const cmp = async (at) => {
      const A = await grab(cln, at); const B = await grab(fin, at);
      let n = 0; let x0 = 1e9; let y0 = 1e9; let x1 = -1; let y1 = -1; let sum = 0; let yellow = 0;
      for (let y = 0; y < A.height; y++) for (let x = 0; x < A.width; x++) {
        const i = (y * A.width + x) * 4; const dd = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]));
        sum += dd;
        if (dd > 40) { n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); if (B.data[i] > 200 && B.data[i + 1] > 170 && B.data[i + 2] < 150) yellow++; }
      }
      return { n, x0, y0, x1, y1, yellow, mean: sum / (A.width * A.height), w: A.width, h: A.height };
    };
    return { on: await cmp(tt), off: await cmp(0.4), srt: await (await e.render.output(id, 'srt')).text() };
  }, { id: fx.wide.id, t });
  assert.ok(d.on.n > 300, `자막 시각에 달라진 점 ${d.on.n}`);
  assert.ok(d.on.y0 > d.on.h * 0.55 && d.on.y1 < d.on.h * 0.97, `자막은 아래쪽 ${JSON.stringify(d.on)}`);
  assert.ok(d.on.yellow > 60, `노란 글씨 ${d.on.yellow}`);
  assert.ok(d.off.n < d.on.n / 20, `자막이 없는 시각은 거의 같다 (${d.off.n} vs ${d.on.n})`);
  assert.match(d.srt, /반짝반짝 별빛/);
});

test('자막 스튜디오: 저장 안 하고 나가면 한 번만 묻는다 (↩ 계속 고치기 / 나가기)', { skip, timeout: 120000 }, async () => {
  await openStudio('wide');
  assert.strictEqual(await ev(() => window.__mt.handle.isDirty()), false);
  await page.locator('.ss-ptile[data-p="pop"]').click();
  assert.strictEqual(await ev(() => window.__mt.handle.isDirty()), true);
  await page.locator('.ss-back').click();
  await page.waitForSelector('.sheet-back');
  assert.match(await page.locator('.sheet-back').innerText(), /저장하지 않은 변경이 있어요/);
  await page.locator('.sheet-back .btn.primary').click(); // 계속 고치기 (눈에 띄는 쪽)
  await page.waitForSelector('.sheet-back', { state: 'detached' });
  assert.ok(await page.locator('.ss').isVisible());
  await page.locator('.ss-back').click();
  await page.waitForSelector('.sheet-back');
  await page.locator('.sheet-back .btn.danger').click(); // 나가기
  await page.waitForFunction(() => window.__closed.length === 1);
  assert.strictEqual(await ev(() => window.__closed[0].cancelled), true);
  assert.strictEqual(await page.locator('.ss').count(), 0);
});

test('자막 스튜디오(세로 9:16): 안전 영역이 처음 한 번 켜지고 자막은 그 안에 든다', { skip, timeout: 120000 }, async () => {
  await openStudio('tall');
  assert.strictEqual(await page.locator('.ss-guide').getAttribute('aria-pressed'), 'true', '세로 영상은 안전 영역을 켜 준다');
  await shot('studio-tall');
  const stage = await box('.ss-vbox');
  assert.ok(stage.height > stage.width && stage.height >= 150, `세로 미리보기 ${stage.width}x${stage.height}`);
  await page.locator('.ss-guide').click(); // 끄고 자막만 잰다
  await page.locator('.ss-ptile[data-p="shorts"]').click();
  await waitDraw();
  const st = await ovStats();
  assert.ok(st.n > 300 && st.y1 < st.h * 0.8 && st.x1 < st.w * 0.9, `안전 영역 안 ${JSON.stringify(st)}`);
  await unmount();
});

test('자막 스튜디오: 가사가 없으면 안내와 붙여넣기 칸 → 가사를 넣으면 줄이 생긴다', { skip, timeout: 120000 }, async () => {
  await mount('substudio', fx.bare.id);
  await page.waitForFunction(() => { const v = document.querySelector('.ss-video'); return v && v.videoWidth > 0; }, null, { timeout: 30000 });
  await waitDraw();
  const sample = await ovStats();
  assert.ok(sample.n > 100, '가사가 없어도 모양 탭에서 보기 글자로 꾸며 볼 수 있다');
  assert.ok(await page.locator('.ss-save').isDisabled(), '가사가 없으면 저장은 막힌다');
  await tab('text');
  assert.match(await page.locator('.ss-pane[data-t="text"] .ss-empty').innerText(), /가사를 넣으면 여기서 자막을 꾸밀 수 있어요/);
  await shot('studio-empty');
  await page.locator('.ss-pane[data-t="text"] .ss-empty .btn', { hasText: '가사 붙여넣기' }).click();
  await page.locator('.ss-pane[data-t="text"] .ss-paste').fill('첫 번째 줄이에요\n두 번째 줄이에요\n세 번째 줄이에요');
  await page.locator('.ss-pane[data-t="text"] .ss-empty .btn', { hasText: '이 가사로 시작하기' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.ss-row').length === 3, null, { timeout: 15000 });
  assert.strictEqual(await page.locator('.ss-pane[data-t="text"] .ss-empty').count(), 0);
  await unmount();
});


// ───────────────────────── 장면 고치기 ─────────────────────────
function pngSolid(w, h, [r, g, b]) {
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (buf) => { let c = -1; for (const x of buf) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const cvHash = (sel) => ev((q) => { const c = document.querySelector(q); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; let nz = 0; for (let i = 0; i < d.length; i += 4) { h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) | 0; if (d[i] + d[i + 1] + d[i + 2] > 30) nz++; } return { h, nz, w: c.width, hh: c.height }; }, sel);
const peekSnap = (fn) => ev(({ id, src }) => { const s = window.AnimeMaker.engine.projects.peek(id); return new Function('s', `return (${src})(s)`)(s); }, { id: fx.wide.id, src: fn.toString() });

test('장면 고치기: 장면 띠(72px↑) · 미리보기 · 카메라 누르면 움직여 보이고 고친 표시 · 시간 · 효과', { skip, timeout: 180000 }, async () => {
  await mount('scenes', fx.wide.id);
  await page.waitForFunction(() => document.querySelectorAll('.sc-th').length >= 2 && document.querySelectorAll('.sc-th .sc-thc.ready').length === document.querySelectorAll('.sc-th').length, null, { timeout: 90000 });
  const n = await page.locator('.sc-th').count();
  const t1 = await box('.sc-th');
  assert.ok(t1.width >= 72 && t1.height >= 40, `장면 띠 칸 ${t1.width}x${t1.height}`);
  const pv = await cvHash('.sc-cv');
  assert.ok(pv.nz > pv.w * pv.hh * 0.2, `미리보기가 그려졌다 (${pv.nz}/${pv.w * pv.hh})`);
  await shot('scenes-draw');
  // 장면 2 고르기 (연습 영상은 장면이 둘뿐이다)
  await page.locator('.sc-th[data-shot="2"]').click();
  assert.strictEqual(await page.locator('.sc-th[data-shot="2"]').getAttribute('aria-selected'), 'true');
  assert.match(await page.locator('.sc-info').innerText(), /장면 2/);
  // 카메라: 다가가기 → 엔진에 적히고, 미리보기가 움직인다 (두 장이 다르다), 고친 표시와 반영하기 줄
  await page.locator('.sc-tab[data-t="cam"]').click();
  assert.strictEqual(await page.locator('.sc-cam').count(), 10);
  const cb = await box('.sc-cam');
  assert.ok(cb.height >= 48 && cb.width >= 48, `카메라 단추 ${cb.width}x${cb.height}`);
  await page.locator('.sc-cam[data-move="zoom_in"]').click();
  await page.waitForFunction(() => document.querySelector('.sc-play').textContent.includes('멈추기'), null, { timeout: 15000 });
  const a = await cvHash('.sc-cv'); await page.waitForTimeout(500); const b = await cvHash('.sc-cv');
  assert.notStrictEqual(a.h, b.h, '카메라가 움직이는 동안 그림이 바뀐다');
  await shot('scenes-camera');
  assert.strictEqual(await peekSnap((s) => s.xsheet.shots.find((x) => x.shot === 2).camera.move), 'zoom_in');
  assert.ok(await page.locator('.sc-th[data-shot="2"].edited').count(), '고친 장면에 ✏️');
  assert.match(await page.locator('.sc-th[data-shot="2"] .sc-thn').innerText(), /✏️/);
  assert.ok(await page.locator('.sk-apply').isVisible(), '고친 것 반영하기 줄');
  assert.match(await page.locator('.sk-apply-btn').innerText(), /고친 것 반영하기 \(약/);
  assert.match(await page.locator('.sk-apply-sub').innerText(), /처음부터 다시 만들어서/);
  await page.locator('.sc-play').click(); // 멈추기
  // 시간: 그림이 2~8장인 (멈춘) 장면에서 0.25초 늘리기. 움직이는 장면은 한 장씩 고치지 않는다는 안내가 나온다
  const multi = await peekSnap((s) => { const m = s.xsheet.shots.find((x) => x.exposure.length >= 2 && x.exposure.length <= 8); return m ? m.shot : 0; });
  const mover = await peekSnap((s) => { const m = s.xsheet.shots.find((x) => x.exposure.length > 8); return m ? m.shot : 0; });
  if (mover) {
    await page.locator(`.sc-th[data-shot="${mover}"]`).click();
    await page.locator('.sc-tab[data-t="time"]').click();
    assert.match(await page.locator('.sc-moving').innerText(), /움직이는 장면/);
  }
  assert.ok(multi, '멈춘 장면이 하나는 있다');
  await page.locator(`.sc-th[data-shot="${multi}"]`).click();
  await page.locator('.sc-tab[data-t="time"]').click();
  const rowsOf = (m) => peekSnap(new Function('s', `return JSON.stringify(s.xsheet.shots.find((x) => x.shot === ${m}).exposure.map((e) => e.frames))`));
  const before = await rowsOf(multi);
  await page.locator('.sc-trow').first().locator('.sc-step').nth(1).click();
  await page.waitForTimeout(400);
  const after = await rowsOf(multi);
  const [b0, a0] = [JSON.parse(before), JSON.parse(after)];
  assert.strictEqual(a0[0], b0[0] + 6, `노출 ${before} → ${after}`);
  assert.strictEqual(a0.reduce((x, y) => x + y, 0), b0.reduce((x, y) => x + y, 0), '장면 전체 길이는 그대로');
  assert.match(await page.locator('.sc-trow').first().locator('.sc-tv').innerText(), /초/);
  await shot('scenes-time');
  // 효과 · 다음 장면으로 (첫 장면: 마지막 장면에는 다음 장면이 없다)
  await page.locator('.sc-th[data-shot="1"]').click();
  await page.locator('.sc-tab[data-t="fx"]').click();
  await page.locator('.sc-chip.fx', { hasText: '번쩍' }).click();
  await page.waitForTimeout(300);
  assert.ok(await peekSnap((s) => s.xsheet.shots.find((x) => x.shot === 1).fx.includes('flash')));
  await page.locator('.sc-chip.tr', { hasText: '스르륵' }).click();
  await page.waitForTimeout(300);
  assert.strictEqual(await peekSnap((s) => s.xsheet.transitions[0].type), 'dissolve');
  await shot('scenes-fx');
  assert.ok(n >= 2, `장면 ${n}개`);
  await unmount();
});

test('장면 고치기: 다시 부탁하기(메모 → 부탁 글) · 내 그림으로 · 이전 그림', { skip, timeout: 180000 }, async () => {
  await mount('scenes', fx.wide.id);
  await page.waitForFunction(() => document.querySelectorAll('.sc-th').length >= 2, null, { timeout: 60000 });
  await page.locator('.sc-th[data-shot="2"]').click();
  await page.waitForSelector('.sc-tile');
  assert.ok((await page.locator('.sc-tile').count()) >= 1);
  await shot('scenes-draw-tiles');
  for (const sel of ['.sc-redo', '.sc-mine']) { const bx = await box(sel); assert.ok(bx.height >= 48 - 0.5, `${sel} ${bx.height}`); }
  // 내 그림으로: 배경(첫 칸)을 단색 그림으로 (파일 고르기 창에 파일을 건넨다)
  const bgTile = page.locator('.sc-tile[data-key$=":bg"]').first();
  assert.ok(await bgTile.count(), '배경 칸');
  const bgKey = await bgTile.getAttribute('data-key');
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), bgTile.locator('.sc-mine').click()]);
  await fc.setFiles({ name: 'mine.png', mimeType: 'image/png', buffer: pngSolid(160, 90, [250, 20, 120]) });
  await page.waitForFunction((k) => { const t = document.querySelector(`.sc-tile[data-key="${k}"]`); return t && /내가 바꿈/.test(t.textContent) && t.querySelector('.sc-back-pic'); }, bgKey, { timeout: 60000 });
  const mine = await peekSnap((s) => 0) ?? 0;
  assert.strictEqual(mine, 0);
  const d = await ev(({ id, key }) => { const s = window.AnimeMaker.engine.projects.peek(id); const x = s.drawings.find((q) => q.key === key); return { custom: x.custom, source: x.source, hist: x.history.length }; }, { id: fx.wide.id, key: bgKey });
  assert.deepStrictEqual([d.custom, d.source, d.hist >= 1], [true, 'user', true]);
  await page.waitForTimeout(800);
  const pink = await cvHash('.sc-cv');
  assert.ok(pink.nz > 0);
  // 이전 그림 고르기 → 되돌리기
  await bgTile.locator('.sc-back-pic').click();
  await page.waitForSelector('.sc-old');
  await page.waitForTimeout(400);
  await shot('scenes-history');
  await page.locator('.sc-old .btn.primary').first().click();
  await page.waitForFunction((k) => { const t = document.querySelector(`.sc-tile[data-key="${k}"]`); return t && t.querySelector('.sc-back-pic'); }, bgKey, { timeout: 60000 });
  await page.waitForTimeout(500);
  // 다시 부탁하기 (움직이지 않는 장면의 인물 그림 하나 · 없으면 배경)
  const cel = page.locator('.sc-tile:not([data-key$=":bg"])').first();
  const target = (await cel.count()) ? cel : page.locator('.sc-tile').first();
  const key = await target.getAttribute('data-key');
  await target.locator('.sc-redo').click();
  await page.waitForSelector('.sc-note');
  await page.locator('.sc-chip', { hasText: '표정 바꾸기' }).click();
  assert.strictEqual(await page.locator('.sc-note').inputValue(), '활짝 웃는 얼굴로');
  await page.waitForTimeout(400);
  await shot('scenes-redo');
  await page.locator('.sheet-back .btn.primary').click();
  await page.waitForFunction(() => window.__closed.length === 1);
  assert.strictEqual(await ev(() => window.__closed[0].redraw), key);
  const rq = await ev(async ({ id }) => { const e = window.AnimeMaker.engine; const s = e.projects.peek(id); const r = await e.handoff.request(id); return { redrawing: s.redrawing.map((x) => [x.key, x.note]), kind: r && r.kind, redraw: r && r.redraw, hasNote: !!(r && /웃는 얼굴/.test(r.prompt)), next: s.next.kind }; }, { id: fx.wide.id });
  assert.deepStrictEqual(rq.redrawing, [[key, '활짝 웃는 얼굴로']]);
  assert.ok(rq.redraw === true && rq.hasNote, `부탁 글에 메모가 들어간다 ${JSON.stringify(rq)}`);
  await ev(async ({ id, key: k }) => { await window.AnimeMaker.engine.drawings.cancelRedraw(id, k); }, { id: fx.wide.id, key });
  await unmount();
});

test('장면 고치기 → 고친 것 반영하기: 영상 전체를 다시 만들어 영상이 바뀌고 완성 화면의 줄도 사라진다', { skip, timeout: 420000 }, async () => {
  const pre = await ev(async ({ id }) => { const e = window.AnimeMaker.engine; const s = e.projects.peek(id); return { madeAt: s.output.madeAt, count: s.changes.count, bytes: (await e.render.output(id, 'video')).size }; }, { id: fx.wide.id });
  assert.ok(pre.count > 0, `앞 시험에서 고친 것이 남아 있다 (${pre.count})`);
  await mount('done', fx.wide.id);
  await page.waitForSelector('.sk-apply-btn');
  assert.ok(await page.locator('.sk-apply').isVisible());
  assert.match(await page.locator('.dn .sk-apply-info').innerText(), /바뀐 장면 \d+곳/);
  await shot('done-apply-bar');
  await page.locator('.sk-apply-btn').click();
  await page.waitForSelector('.busy');
  await page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 400000 });
  await page.waitForFunction(({ id, madeAt }) => { const s = window.AnimeMaker.engine.projects.peek(id); return s.status === 'done' && s.output.madeAt > madeAt && s.changes.count === 0; }, { id: fx.wide.id, madeAt: pre.madeAt }, { timeout: 60000 });
  await expectToast(/반영했어요/);
  // 영상이 새로 걸렸다 (blob 주소가 바뀌고 다시 열린다) · 반영하기 줄이 사라진다
  await page.waitForFunction(() => !document.querySelector('.sk-apply') || document.querySelector('.sk-apply').hidden, null, { timeout: 10000 });
  await page.waitForFunction(() => { const v = document.querySelector('.dn-video'); return v && v.videoWidth > 0 && v.readyState >= 2; }, null, { timeout: 30000 });
  const post = await ev(async ({ id }) => { const e = window.AnimeMaker.engine; const s = e.projects.peek(id); return { bytes: (await e.render.output(id, 'video')).size, burned: s.output.burned, status: s.status }; }, { id: fx.wide.id });
  assert.ok(post.bytes !== pre.bytes && post.burned && post.status === 'done', `새 영상 ${pre.bytes} → ${post.bytes}`);
  await unmount();
});


test('가사 시간 맞추기(엔진 판): 확인 단계에 진짜 영상 + 자막 그림판 · 저장하면 updateLyrics 로 돌아간다 · 취소는 그대로', { skip, timeout: 120000 }, async () => {
  await mount('tapsync', fx.wide.id);
  await page.waitForSelector('.sheet-back.ts-full .ls');
  await page.waitForTimeout(500);
  const stageInfo = await ev(() => ({ canvas: !!document.querySelector('.ts-full .ls-vbox canvas'), video: !!document.querySelector('.ts-full .ls-vbox video'), check: document.querySelector('.ts-full .ls').classList.contains('ls-check') || !!document.querySelector('.ts-full .ls-modes .on') }));
  assert.ok(stageInfo.canvas && stageInfo.video, `진짜 영상 + 자막 그림판 ${JSON.stringify(stageInfo)}`);
  await shot('tapsync-engine');
  const lines0 = await ev(({ id }) => window.AnimeMaker.engine.projects.peek(id).timing.lyrics.map((l) => [l.text, l.start]), { id: fx.wide.id });
  await page.locator('.sheet-back.ts-full .sheet-btns .btn').first().click(); // 취소
  await page.waitForFunction(() => window.__closed.length === 1);
  assert.strictEqual(await ev(() => window.__closed[0].saved), false);
  await mount('tapsync', fx.wide.id);
  await page.waitForSelector('.sheet-back.ts-full .ls');
  await page.locator('.sheet-back.ts-full .sheet-btns .btn.primary').click(); // 이대로 쓰기 (이미 맞춰 둔 시간)
  await page.waitForFunction(() => window.__closed.length === 1, null, { timeout: 15000 });
  assert.strictEqual(await ev(() => window.__closed[0].saved), true);
  const lines1 = await ev(({ id }) => window.AnimeMaker.engine.projects.peek(id).timing.lyrics.map((l) => [l.text, l.start]), { id: fx.wide.id });
  assert.deepStrictEqual(lines1.map((l) => l[0]), lines0.map((l) => l[0]), '줄 글은 그대로');
  assert.ok(lines1.every((l, i) => Math.abs(l[1] - lines0[i][1]) < 0.06), '시간도 그대로 저장');
});


test('영상이 아직 없는 작품: 완성 화면은 영상 칸을 숨기고 · 장면 고치기는 안내 · 자막 스튜디오는 노래와 보기 글자로 연다', { skip, timeout: 120000 }, async () => {
  const idNew = await ev(async () => {
    const e = window.AnimeMaker.engine;
    const song = await e.services.demo.song({ seconds: 6, bpm: 120 });
    return e.projects.create({ workflow: 'demo', aspect: '16:9', quality: '480p', songBlob: song, songName: 'x.wav', lyricsText: '' });
  });
  await mount('done', idNew);
  assert.ok(!(await page.locator('.dn-stage').isVisible()));
  assert.ok(await page.locator('.dn-save').isDisabled() && await page.locator('.dn-share').isDisabled());
  await mount('scenes', idNew);
  assert.match(await page.locator('.sc-msg').innerText(), /아직 장면이 없어요/);
  await mount('substudio', idNew);
  await page.waitForFunction(() => document.querySelectorAll('.ss-pthumb').length === 7 && [...document.querySelectorAll('.ss-pthumb')].every((c) => { const g = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < g.length; i += 97) s += g[i] + g[i + 1] + g[i + 2]; return s > 0; }), null, { timeout: 30000 });
  await waitDraw();
  const o = await ovStats();
  assert.ok(o.n > 100, '보기 글자가 그려진다');
  assert.ok(await page.locator('.ss-save').isDisabled());
  assert.ok(await ev(() => document.querySelector('.ss-video').src.startsWith('blob:')), '영상이 없으면 노래를 건다');
  await shot('studio-no-video');
  await unmount();
});


test('진짜 영상 화면(C3a)에서: 완성 화면 → [💬 가사 자막 고치기] → ← → [✏️ 장면 고치기] → ← (ctx.open 약속)', { skip, timeout: 120000 }, async () => {
  await unmount();
  await ev(() => document.querySelectorAll('.test-host, .sheet-back, .busy').forEach((e) => e.remove()));
  await ev(async ({ id }) => { await window.AnimeMaker.app.open(id); }, { id: fx.wide.id });
  await page.waitForSelector('.dn .dn-video', { timeout: 30000 });
  await page.waitForFunction(() => { const v = document.querySelector('.dn-video'); return v && v.videoWidth > 0; }, null, { timeout: 30000 });
  await page.waitForTimeout(600);
  await shot('integration-done');
  await page.locator('.dn-row2 .btn').first().click();
  await page.waitForSelector('.sub-host .ss', { timeout: 15000 });
  await shot('integration-studio');
  await page.locator('.ss-back').click(); // 바꾼 게 없으니 바로 나온다
  await page.waitForSelector('.sub-host', { state: 'detached', timeout: 10000 });
  await page.locator('.dn-row2 .btn').nth(1).click();
  await page.waitForSelector('.sub-host .sc', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('.sc-th').length >= 2, null, { timeout: 60000 });
  await page.locator('.sc-back').click();
  await page.waitForSelector('.sub-host', { state: 'detached', timeout: 10000 });
  assert.ok(await page.locator('.dn').first().isVisible(), '완성 화면으로 돌아온다');
  await ev(() => window.AnimeMaker.app.go('home'));
});

test('콘솔 오류 0 (지금까지)', { skip }, () => {
  assert.deepStrictEqual(errors, []);
});
