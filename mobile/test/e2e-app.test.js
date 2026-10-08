// 폰 앱 화면(C3a) 진짜 Chromium(412×915) 시험: 진짜 화면을 눌러서 연습 모드로 끝까지 · 탭 · 뒤로가기 · 만들기 · AI 앱 부탁/받기(가짜 AI 앱) · 주인공 · 설정.
// 개발용 묶음은 임시 폴더에 만든다 (다른 시험이 쓰는 www-dev 를 건드리지 않는다). 사진 확인: AM_SHOTS=/폴더 node --test test/e2e-app.test.js
import test, { before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { buildApp } from '../build-lib.mjs';
import { demoSong } from '../src/engine/render/demo-canvas.js';
import { makeWorkflow } from '../src/engine/workflows.js';

const require = createRequire(import.meta.url);
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
const skip = CHROME ? false : 'Chromium/Chrome 이 없음 (CHROME_PATH 로 지정)';
const SHOT_DIR = process.env.AM_SHOTS || '';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.txt': 'text/plain', '.json': 'application/json', '.otf': 'font/otf', '.ttf': 'font/ttf', '.map': 'application/json' };

let srv; let browser; let base; let outDir;
before(async () => {
  if (skip) return;
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-app-'));
  await buildApp({ dev: true, out: outDir });
  srv = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const f = path.join(outDir, u === '/' ? 'index.html' : u);
    if (!f.startsWith(outDir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}/`;
  browser = await chromium.launch({ executablePath: CHROME, args: typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : [] });
});
after(async () => {
  if (browser) await browser.close();
  if (srv) srv.close();
  if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
});

const PNG_HELPER = () => {
  window.__png = (label, color = '#8ab4f8') => new Promise((res) => {
    const c = document.createElement('canvas'); c.width = 320; c.height = 320;
    const g = c.getContext('2d'); g.fillStyle = '#eef'; g.fillRect(0, 0, 320, 320); g.fillStyle = color; g.beginPath(); g.arc(160, 150, 90, 0, 7); g.fill();
    g.fillStyle = '#222'; g.font = '28px sans-serif'; g.fillText(String(label), 20, 300);
    c.toBlob(res, 'image/png');
  });
};

/** 새 화면 하나. welcome:true 면 처음 켠 환영 화면 그대로, 아니면 환영을 넘기고 만들기 탭에서 시작 */
async function open(t, { welcome = false, quality = '480p', notify = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, locale: 'ko-KR' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.addInitScript(PNG_HELPER);
  await page.goto(base);
  await page.evaluate(() => window.AnimeMaker.ready);
  t.after(() => ctx.close());
  await page.evaluate(async ([q, n, w]) => {
    const { app } = window.AnimeMaker;
    app.setSetting('quality', q);
    app.practiceSeconds = 20;
    if (n) await app.setPref('notify', 'screen');
    if (!w) { await app.setPref('welcomed', true); app.go('home'); }
  }, [quality, notify, welcome]);
  return { page, errors };
}
async function shot(page, name) {
  if (!SHOT_DIR) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
}
const pressBack = (page) => page.evaluate(() => { window.AnimeMaker.app.back(); });
const tab = (page, id) => page.click(`.tabs .tab[data-tab="${id}"]`);
const noErrors = (errors) => assert.deepStrictEqual(errors, []);
const wavBuffer = async (seconds = 12) => Buffer.from(await (await demoSong({ seconds, bpm: 120 })).arrayBuffer());

/** 가짜 AI 앱: 보낸 부탁(__sent)을 모으고, 클립보드(__clip)를 읽게 한다 */
async function stubAiApp(page) {
  await page.evaluate(() => {
    const n = window.AnimeMaker.native;
    window.__sent = []; window.__clip = '';
    n.sendToApp = async (appId, o) => { window.__sent.push({ appId, text: o.text, files: (o.files || []).length }); await n.copyText(o.text); return { direct: true }; };
    n.readClipboard = async () => window.__clip;
  });
}
const nonceOf = (text) => /"request_id": "([^"]+)"/.exec(text)[1];

// ───────────────────────── A. 처음 켜기 → 연습 영상 → 탭 · 뒤로가기 ─────────────────────────

test('처음 켜면 환영 화면 → 먼저 구경하기 → 알림 설명 → 연습 영상이 저절로 완성 → 내 영상 · 주인공 · 설정 탭 · 뒤로가기', { skip, timeout: 240000 }, async (t) => {
  const { page, errors } = await open(t, { welcome: true, notify: false });
  assert.strictEqual(await page.evaluate(() => window.AnimeMaker.app.route), 'welcome');
  assert.strictEqual(await page.textContent('.welcome .hero h1'), 'AnimeMaker V2');
  assert.match(await page.textContent('#btn-tour'), /먼저 구경하기/);
  assert.match(await page.textContent('#btn-connect'), /내 AI 앱 연결하기/);
  assert.strictEqual(await page.locator('.tabs').count(), 0, '환영 화면에는 아래 탭이 없다');
  await shot(page, 'a01_welcome');
  await page.click('#btn-tour');
  await page.waitForSelector('.proj');
  await page.waitForSelector('.sheet-back .sheet-title');
  assert.match(await page.textContent('.sheet-back .sheet-title'), /알림/); // 첫 긴 일 전에 알림 설명 (둘 다 길이 있다)
  await shot(page, 'a02_notify_explainer');
  assert.deepStrictEqual(await page.locator('.sheet-btns .btn').allTextContents(), ['🔔 알림 켜기', '화면 켜 둔 채로 할게요']);
  await page.click('.sheet-btns .btn:has-text("화면 켜 둔 채로")');
  assert.strictEqual(await page.evaluate(() => window.AnimeMaker.app.prefs.notify), 'screen');
  await page.waitForSelector('.proj[data-next="running"]', { timeout: 30000 });
  assert.strictEqual(await page.locator('.tabs').count(), 0, '영상 화면에는 아래 탭이 없다 (자기 위 줄 ← 제목 ⋯)');
  assert.strictEqual(await page.getAttribute('#proj-back', 'aria-label'), '뒤로');
  const bar = await page.evaluate(() => parseFloat(document.querySelector('.pbar i').style.width));
  assert.ok(bar >= 0 && bar <= 100);
  await shot(page, 'a03_working');
  await page.waitForSelector('.proj[data-status="done"]', { timeout: 150000 });
  await page.waitForSelector('#done-host video', { timeout: 20000 });
  await shot(page, 'a04_done');
  // C3b 가 쓰는 시험 문: 영상 화면을 거치지 않고 완성 화면을 전체 화면 칸에 올린다
  const mounted = await page.evaluate(async () => {
    const id = window.AnimeMaker.app.params.id;
    const { host, handle, ctx } = await window.AnimeMaker.mountForTest('done', id);
    const out = { video: !!host.querySelector('video'), mode: ctx.mode, snap: !!ctx.getSnap(), missing: !!handle.missing };
    ctx.onClose();
    out.removed = !document.querySelector('#test-host');
    return out;
  });
  assert.deepStrictEqual(mounted, { video: true, mode: 'done', snap: true, missing: false, removed: true });
  // 뒤로가기: 영상 → 만들기 (이 영상은 만들기에서 시작했다)
  await pressBack(page);
  await page.waitForSelector('.tabs');
  assert.strictEqual(await page.evaluate(() => window.AnimeMaker.app.route), 'home');
  // 탭 이동: 내 영상 (카드 + 완성 칩)
  await tab(page, 'projects');
  await page.waitForSelector('.pj[data-id]');
  assert.strictEqual(await page.locator('.pj').count(), 1);
  assert.match(await page.textContent('.pj .pj-chip'), /완성/);
  assert.match(await page.textContent('.pj [data-role="meta"]'), /1화 · \d+초/);
  await shot(page, 'a05_my_videos');
  await page.evaluate(() => { window.__saved = []; window.AnimeMaker.native.saveToGallery = async (b, name) => { window.__saved.push([name, b.size]); return { saved: true, folder: 'Movies/AnimeMaker V2' }; }; });
  await page.click('.pj .more');
  await page.waitForSelector('.sheet .menu-row');
  assert.deepStrictEqual(await page.locator('.sheet .menu-row').allTextContents(), ['💾 저장하기', '🗑 지우기']);
  await shot(page, 'a06_card_menu');
  await page.click('.sheet .menu-row:has-text("저장하기")');
  await page.waitForFunction(() => window.__saved.length === 1);
  assert.match(await page.evaluate(() => window.__saved[0][0]), /\.mp4$/);
  assert.ok(await page.evaluate(() => window.__saved[0][1]) > 1000, '영상 파일이 갤러리로 넘어갔다');
  await page.waitForSelector('.toast:has-text("AnimeMaker V2")');
  // 주인공: 연습용 주인공 카드
  await tab(page, 'hero');
  await page.waitForSelector('.hero-card');
  assert.match(await page.textContent('.hero-card'), /하루/);
  assert.match(await page.textContent('.hero-card'), /연습용/);
  await shot(page, 'a07_heroes');
  await tab(page, 'settings');
  await page.waitForSelector('.probe-card[data-state="done"]', { timeout: 20000 });
  await shot(page, 'a08_settings');
  // 뒤로가기 순서: 설정 → 만들기 → (끝내기)
  await page.evaluate(() => { window.__exits = 0; window.AnimeMaker.N._test.use({ native: true, app: { exitApp: () => { window.__exits++; }, addListener: async () => ({ remove() {} }) } }); });
  await page.evaluate(async () => { await window.AnimeMaker.app.back(); });
  assert.strictEqual(await page.evaluate(() => window.AnimeMaker.app.route), 'home');
  assert.strictEqual(await page.evaluate(() => window.__exits), 0);
  await page.evaluate(async () => { await window.AnimeMaker.app.back(); });
  assert.strictEqual(await page.evaluate(() => window.__exits), 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), '가로 스크롤이 생겼어요');
  noErrors(errors);
});

// ───────────────────────── B. 만드는 중 뒤로가기 → 그만두기 → 이어서 하기 ─────────────────────────

test('영상 만드는 중 뒤로가기는 "그만둘까요, 계속 할까요?" — 계속 하기 · 그만두기 · [▶ 이어서 하기] 로 끝까지, 끝난 영상은 목록에 남는다', { skip, timeout: 300000 }, async (t) => {
  const { page, errors } = await open(t);
  await page.evaluate(() => window.AnimeMaker.app.setPref('notify', 'screen'));
  await tab(page, 'hero');
  await page.click('#btn-practice-hero');
  await page.waitForSelector('.hero-card');
  await tab(page, 'home');
  await page.waitForSelector('#btn-make:not([disabled])');
  await page.click('#btn-make');
  await page.waitForSelector('.proj[data-next="running"]', { timeout: 30000 });
  await page.waitForFunction(() => /영상을 만들고 있어요/.test((document.querySelector('#busy-title') || {}).textContent || '') && document.querySelector('.busy'), null, { timeout: 90000 }); // 영상 만드는 덮개
  await pressBack(page);
  await page.waitForSelector('.sheet-back.top .sheet-title');
  assert.strictEqual(await page.textContent('.sheet-back.top .sheet-title'), '그만둘까요, 계속 할까요?');
  await shot(page, 'b01_guard');
  await page.click('.sheet-back.top .btn.primary'); // 계속 하기
  assert.ok(await page.locator('.busy').count() === 1, '계속 하기를 누르면 일이 그대로 돈다');
  await pressBack(page);
  await page.click('.sheet-back.top .btn.danger'); // 그만두기
  await page.waitForSelector('.busy', { state: 'detached', timeout: 30000 });
  await page.waitForSelector('.proj[data-status="stopped"]', { timeout: 30000 });
  assert.match(await page.textContent('#btn-resume'), /이어서 하기/);
  await shot(page, 'b02_stopped');
  assert.strictEqual(await page.evaluate(() => window.AnimeMaker.app.route), 'project', '그만두기를 눌러도 화면은 그대로');
  // 멈춘 영상은 목록에 '멈춤' 으로 남는다
  await page.evaluate(() => window.AnimeMaker.app.go('projects'));
  await page.waitForSelector('.pj');
  assert.match(await page.textContent('.pj .pj-chip'), /멈춤/);
  await page.click('.pj');
  await page.waitForSelector('#btn-resume');
  await page.click('#btn-resume');
  await page.waitForSelector('.proj[data-status="done"]', { timeout: 150000 });
  await page.evaluate(() => window.AnimeMaker.app.go('projects'));
  await page.waitForSelector('.pj');
  assert.match(await page.textContent('.pj .pj-chip'), /완성/);
  noErrors(errors);
});

// ───────────────────────── C. 만들기(진짜 파일) → 부탁하기/받기 (가짜 AI 앱) ─────────────────────────

test('만들기: 노래 파일 + 가사 → 부탁 횟수 · 분 어림 · 쓰던 내용 남기기 → 만들기 → AI 앱에 부탁(복사 · 되돌아온 부탁 글 거절 · 빈칸 거절 · 그래도 쓰기) → 확인 멈춤 → 그림 받기 · 받은 함 · 초안 영상', { skip, timeout: 420000 }, async (t) => {
  const { page, errors } = await open(t, { notify: true });
  // 설정에서 AI 앱 고르기 (연습 모드 끄기)
  await tab(page, 'settings');
  await page.click('.sub-card[data-app="chatgpt"] [data-act="use"]');
  assert.deepStrictEqual(await page.evaluate(() => [window.AnimeMaker.app.settings.textApp, window.AnimeMaker.app.settings.imageApp, window.AnimeMaker.app.prefs.connected]), ['chatgpt', 'chatgpt', true]);
  await tab(page, 'hero');
  await page.click('#btn-practice-hero'); // 영상에 쓸 수 있는 (잠긴) 주인공
  await page.waitForSelector('.hero-card');
  await tab(page, 'home');
  await page.waitForSelector('#card-song');
  assert.strictEqual(await page.locator('#practice-banner').count(), 0, 'AI 앱을 골랐으니 연습 모드 배너는 없다');
  assert.match(await page.textContent('#mk-reason'), /먼저 노래를 골라 주세요/);
  assert.ok(await page.isDisabled('#btn-make'));
  const buf = await wavBuffer(12);
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#btn-song')]);
  await fc.setFiles({ name: '우리노래.wav', mimeType: 'audio/wav', buffer: buf });
  await page.waitForSelector('#song-name');
  assert.strictEqual(await page.textContent('#song-name'), '우리노래.wav');
  await page.fill('#lyrics-input', '[Verse]\n작은 불빛 하나 따라\n우리 함께 걸어가\n[Chorus]\n반짝이는 별빛 아래\n손을 꼭 잡고 가요');
  await page.fill('#topic-input', '별빛 아래 산책');
  assert.ok(await page.isEnabled('#btn-make'));
  assert.match(await page.textContent('#mk-estimate'), /AI 앱에 약 36번 부탁해요 · 약 45분/);
  assert.match(await page.textContent('#mk-summary'), /주인공 🔒하루 · 세로 영상 · 가볍게 · 그림은 ChatGPT/);
  await shot(page, 'c01_make_screen');
  await page.click('#btn-change');
  await page.waitForSelector('.cell[data-aspect="16:9"]');
  await page.click('.cell[data-aspect="16:9"]');
  await page.click('.cell[data-preset="lots"]');
  assert.match(await page.textContent('#preset-warn'), /몇 시간/);
  await shot(page, 'c02_change_sheet');
  await page.click('.sheet-btns .btn.primary');
  await page.click('#btn-make'); // '많이' 는 몇 시간 걸린다고 한 번 더 묻는다 (취소하면 아무것도 만들지 않는다)
  await page.waitForSelector('.sheet-back .sheet-title');
  assert.strictEqual(await page.textContent('.sheet-back .sheet-title'), '몇 시간이 걸려요');
  await page.click('.sheet-btns .btn:has-text("다시 고를게요")');
  assert.strictEqual(await page.evaluate(() => window.AnimeMaker.db.listProjects().then((l) => l.length)), 0);
  await page.click('#btn-change');
  await page.click('.cell[data-preset="light"]');
  await page.click('.sheet-btns .btn.primary');
  assert.match(await page.textContent('#mk-estimate'), /약 40번 부탁해요 · 약 50분/);
  assert.match(await page.textContent('#mk-summary'), /가로 영상/);
  await page.click('#btn-change');
  await page.click('.cell[data-aspect="9:16"]');
  await page.click('.sheet-btns .btn.primary');
  // 쓰던 내용은 새로고침(앱이 꺼졌다 켜짐)해도 남는다
  await page.waitForTimeout(500);
  await page.reload();
  await page.evaluate(() => window.AnimeMaker.ready);
  await page.evaluate(() => { window.AnimeMaker.app.practiceSeconds = 20; });
  await page.waitForSelector('#song-name');
  assert.strictEqual(await page.textContent('#song-name'), '우리노래.wav');
  assert.match(await page.inputValue('#lyrics-input'), /작은 불빛 하나 따라/);
  assert.strictEqual(await page.inputValue('#topic-input'), '별빛 아래 산책');
  await page.click('#btn-make');
  await page.waitForSelector('.proj');
  await stubAiApp(page);
  await page.waitForSelector('#ho-title', { timeout: 60000 });
  assert.match(await page.textContent('#ho-title'), /이야기 짜기/);
  assert.match(await page.textContent('.ho-apps .chip.on'), /ChatGPT/);
  await shot(page, 'c03_handoff_plan');
  // 1. 부탁하기: 부탁 글이 AI 앱으로 가고 request_id 가 들어 있다
  await page.click('#ho-send');
  await page.waitForFunction(() => window.__sent.length === 1);
  const sent = await page.evaluate(() => window.__sent[0]);
  assert.strictEqual(sent.appId, 'chatgpt');
  assert.match(sent.text, /"request_id": "/);
  const nonce = nonceOf(sent.text);
  await page.waitForSelector('.ho-ask.done');
  await shot(page, 'c04_sent');
  // 되돌아온 부탁 글(에코)은 거절
  await page.evaluate((x) => { window.__clip = x; }, sent.text);
  await page.click('#ho-paste');
  await page.waitForSelector('#ho-msg.err');
  assert.match(await page.textContent('#ho-msg'), /부탁 글/);
  // 빈칸("...")이 남은 답장은 미리 보고 → 거절
  const wf = makeWorkflow('phone-lite');
  const plan = DD.demoPlan('별빛', wf, null);
  await page.evaluate((x) => { window.__clip = x; }, JSON.stringify({ ...plan, title: '...', request_id: nonce }));
  await page.click('#ho-paste');
  await page.waitForSelector('#ho-preview');
  assert.match(await page.textContent('#ho-preview'), /이 답장을 쓸까요/);
  await shot(page, 'c05_preview');
  await page.click('#ho-use');
  await page.waitForSelector('#ho-msg.err');
  assert.match(await page.textContent('#ho-msg'), /예시 칸/);
  // 요청 번호가 없는 올바른 답장은 [그래도 이 답장 쓰기] 로
  await page.click('#ho-recopy');
  await page.evaluate((x) => { window.__clip = x; }, JSON.stringify(plan));
  await page.click('#ho-paste');
  await page.click('#ho-use');
  await page.waitForSelector('#ho-force');
  assert.match(await page.textContent('#ho-msg'), /request_id/);
  await shot(page, 'c06_force');
  await page.click('#ho-force');
  // 가사 맞추기 확인 멈춤
  await page.waitForSelector('#review-card[data-review="review:lyrics"]', { timeout: 60000 });
  assert.match(await page.textContent('#btn-tapsync'), /지금 맞추기/);
  await shot(page, 'c07_review_lyrics');
  await page.click('#btn-later');
  // 그림 순서표: AI 없이 PC 방식으로
  await page.waitForFunction(() => /그림 순서표/.test((document.querySelector('#ho-title') || {}).textContent || ''), null, { timeout: 60000 });
  assert.match(await page.textContent('#ho-fallback'), /AI 없이 PC 방식/);
  await page.click('#ho-fallback');
  // 그림 수 확인 (이대로 / 줄여서)
  await page.waitForSelector('#review-card[data-review="review:drawings"]', { timeout: 60000 });
  const allText = await page.textContent('#btn-draw-all');
  assert.match(allText, /이대로 그리기/);
  assert.match(allText, /AI 앱에 약 \d+번 · 약 \d+(분|\.\d시간)/);
  await shot(page, 'c08_review_drawings');
  if (await page.locator('#btn-draw-less').count()) {
    const before = await page.textContent('#btn-draw-all');
    await page.click('#btn-draw-less');
    await page.waitForFunction((b) => document.querySelector('#btn-draw-all') && document.querySelector('#btn-draw-all').textContent !== b, before, { timeout: 30000 });
  }
  await page.click('#btn-draw-all');
  // 그림 부탁
  await page.waitForFunction(() => /(배경|인물|그림)/.test((document.querySelector('#ho-title') || {}).textContent || ''), null, { timeout: 60000 });
  const pid = await page.evaluate(() => window.AnimeMaker.app.params.id);
  assert.ok(await page.locator('#btn-draft').isHidden(), '그림이 한 장도 없을 땐 초안 버튼이 없다');
  await page.click('#ho-send');
  await page.waitForFunction(() => window.__sent.length === 2);
  assert.ok((await page.evaluate(() => window.__sent[1].text)).includes('Output: ONE single image'));
  await shot(page, 'c09_handoff_picture');
  // AI 앱이 그림을 공유로 돌려줌 → 자리를 찾아 들어가고 "방금 받은 그림 ✓"
  await page.evaluate(async (id) => {
    const blob = await window.__png('one');
    await window.AnimeMaker.engine.handoff.acceptFiles(id, [{ name: 'one.png', mime: 'image/png', blob }]);
  }, pid);
  await page.waitForSelector('.ho-got', { timeout: 30000 });
  await page.waitForSelector('#btn-draft', { state: 'visible', timeout: 20000 });
  await shot(page, 'c10_got_picture');
  // 콜드 스타트 공유 흉내: 받은 함에 그림 두 장이 쌓인 채 앱이 다시 켜지면 기다리던 칸으로 들어간다
  const before = await page.evaluate(async (id) => (await window.AnimeMaker.engine.projects.get(id)).drawings.filter((d) => d.hasPicture).length, pid);
  await page.evaluate(async () => {
    const { db } = window.AnimeMaker;
    const items = [];
    for (let i = 0; i < 2; i++) { const b = await window.__png(`cold${i}`, '#f4a261'); await db.putFile(`inbox/cold1/${i}`, b); items.push({ name: `cold${i}.png`, mime: 'image/png', size: b.size, key: `inbox/cold1/${i}` }); }
    await db.putInbox({ id: 'cold1', receivedAt: Date.now(), text: '', items });
  });
  await page.reload();
  await page.evaluate(() => window.AnimeMaker.ready);
  await page.waitForFunction(async (id) => (await window.AnimeMaker.engine.projects.get(id)).drawings.filter((d) => d.hasPicture).length >= 3, pid, { timeout: 60000 });
  for (let i = 0; i < 60 && (await page.evaluate(() => window.AnimeMaker.db.listInbox().then((l) => l.length))) > 0; i++) await page.waitForTimeout(250);
  const left = await page.evaluate(() => window.AnimeMaker.db.listInbox().then((l) => l.map((r) => [r.id, r.items.length, r.text.length])));
  assert.deepStrictEqual(left, [], `받은 함이 비었다 (자리에 들어갔다): ${JSON.stringify(left)}`);
  assert.ok(before === 1);
  // 받은 함: 기다리는 칸 없이 쌓인 그림은 목록에 보이고 한 번에 쓸 수 있다
  await page.evaluate(async (id) => {
    const { db, engine } = window.AnimeMaker;
    await db.clearExpecting();
    const b = await window.__png('tray1', '#2a9d8f');
    await db.putFile('inbox/tray1/0', b);
    await db.putInbox({ id: 'tray1', receivedAt: Date.now(), text: '', items: [{ name: 'tray1.png', mime: 'image/png', size: b.size, key: 'inbox/tray1/0' }] });
    await engine.handoff.routeInbox();
    window.dispatchEvent(new CustomEvent('am:inbox', { detail: {} }));
    await window.AnimeMaker.app.open(id, { from: 'projects' });
  }, pid);
  await page.waitForSelector('.tray .tray-item', { timeout: 30000 });
  await shot(page, 'c11_tray');
  assert.match(await page.textContent('.tray .tray-item .btn.primary'), /여기에 쓰기|빈 자리/);
  await page.click('.tray .tray-item .btn.primary');
  await page.waitForFunction(async (id) => (await window.AnimeMaker.engine.projects.get(id)).drawings.filter((d) => d.hasPicture).length >= 4, pid, { timeout: 40000 });
  // 지금까지 그린 걸로 영상 만들기 (초안)
  await page.waitForSelector('#btn-draft', { state: 'visible' });
  await page.click('#btn-draft');
  await page.waitForSelector('#draft-video', { timeout: 120000 });
  await shot(page, 'c12_draft_video');
  assert.ok(await page.evaluate(() => new Promise((r) => { const v = document.querySelector('#draft-video'); if (v.readyState >= 1) r(v.videoWidth > 0); else v.addEventListener('loadedmetadata', () => r(v.videoWidth > 0)); setTimeout(() => r(false), 8000); })), '초안 영상이 열린다');
  // AI 앱이 바로 안 열리는 폰: 보낼 앱을 고르게 하고 안내한다 (기준 그림 저장 안내는 주인공 시험에서 본다)
  await page.click('.sheet .sheet-close');
  await stubAiApp(page); // 앞에서 새로고침했으니 가짜 AI 앱을 다시 꽂는다
  await page.evaluate(() => {
    window.AnimeMaker.native.sendToApp = async (appId, o) => { window.__sent.push({ appId, text: o.text, files: (o.files || []).length }); return { direct: false }; };
  });
  await page.waitForSelector('#ho-send');
  await page.click('#ho-send');
  await page.waitForSelector('#ho-msg', { timeout: 8000 }).catch(async () => { throw new Error(`안내 글이 없어요: ${await page.evaluate(() => document.querySelector('.ho') && document.querySelector('.ho').innerText.slice(0, 600))}`); });
  assert.match(await page.textContent('#ho-msg'), /복사|골라/);
  await shot(page, 'c13_chooser_fallback');
  // 그림이 다 안 와도 언제든: 남은 그림은 이웃 그림으로 대신해서 영상을 완성한다
  await page.evaluate(() => { window.AnimeMaker.native.sendToApp = async () => ({ direct: true }); });
  await page.waitForSelector('#btn-finish', { state: 'visible' });
  await page.click('#btn-finish');
  await page.waitForSelector('.sheet-back .sheet-title');
  assert.strictEqual(await page.textContent('.sheet-back .sheet-title'), '남은 그림은 건너뛸까요?');
  await shot(page, 'c14_finish_early');
  await page.click('.sheet-btns .btn.primary');
  await page.waitForSelector('.proj[data-status="done"]', { timeout: 180000 });
  await page.waitForSelector('#done-host video', { timeout: 20000 });
  await shot(page, 'c15_done_with_missing');
  noErrors(errors);
});

// ───────────────────────── D. 주인공 만들기 (연습 모드, 가짜 AI 앱) ─────────────────────────

test('주인공: 이름 · 생김새 자동 저장 → 그림 0장이면 정하기를 막고 이유를 보여 줌 → AI 앱에 부탁(설명 → 그림) → 받은 함에서 넣기 → 정하기(시리즈 생성) → 고치기', { skip, timeout: 240000 }, async (t) => {
  const { page, errors } = await open(t);
  await stubAiApp(page);
  await tab(page, 'hero');
  await page.waitForSelector('#hero-empty');
  await page.click('#btn-new-hero');
  await page.waitForSelector('#hero-name');
  assert.strictEqual(await page.evaluate(() => window.AnimeMaker.db.listCharacters().then((l) => l.length)), 0, '아무것도 안 적었으면 빈 기록을 만들지 않는다');
  await page.fill('#hero-name', '봄이');
  await page.fill('#hero-desc', '분홍 모자를 쓴 씩씩한 아이');
  await page.waitForFunction(() => /저장됨/.test(document.querySelector('#hero-saved').textContent), null, { timeout: 5000 });
  assert.strictEqual(await page.evaluate(() => window.AnimeMaker.db.listCharacters().then((l) => l.length)), 1);
  await page.click('#hero-lock');
  await page.waitForSelector('#hero-hint', { state: 'visible' });
  assert.match(await page.textContent('#hero-hint'), /그림이 한 장도 없어요/);
  await shot(page, 'd01_lock_blocked');
  // 부탁 1/4: 설명 정리 (글)
  await page.click('#hero-draw');
  await page.waitForSelector('.flow-head');
  await page.waitForSelector('#ho-send');
  assert.match(await page.textContent('.ho-step'), /1\/4/);
  await shot(page, 'd02_flow_describe');
  await page.click('#ho-send');
  await page.waitForFunction(() => window.__sent.length === 1);
  const n1 = nonceOf(await page.evaluate(() => window.__sent[0].text));
  const value = { locked: { summary: 'a cheerful girl', hair: 'short brown bob', outfit: 'pink hat' }, palette: [{ name: 'hat', hex: '#ff8fab' }], rules: { must: ['pink hat'], never: ['long hair'] }, request_id: n1 };
  await page.evaluate((x) => { window.__clip = x; }, JSON.stringify(value));
  await page.click('#ho-paste');
  await page.click('#ho-use');
  // 부탁 2/4: 앞·옆·뒤 그림 → 받은 함으로 도착한 그림을 한 번에 넣기
  await page.waitForFunction(() => /2\/4/.test((document.querySelector('.ho-step') || {}).textContent || ''), null, { timeout: 20000 });
  assert.match(await page.textContent('#ho-title'), /앞·옆·뒤 모습 그림 부탁하기/);
  await page.click('#ho-send');
  await page.waitForFunction(() => window.__sent.length === 2 && window.__sent[1].files === 0);
  await page.evaluate(async () => {
    const { db, engine } = window.AnimeMaker;
    const b = await window.__png('turn', '#ff8fab');
    await db.putFile('inbox/h1/0', b);
    await db.putInbox({ id: 'h1', receivedAt: Date.now(), text: '', items: [{ name: 'turn.png', mime: 'image/png', size: b.size, key: 'inbox/h1/0' }] });
    await engine.handoff.routeInbox();
    window.dispatchEvent(new CustomEvent('am:inbox', { detail: {} })); // 공유로 받았다는 앱 신호
  });
  await page.waitForSelector('.tray .tray-item');
  await page.click('.tray .tray-item .btn.primary');
  // 부탁 3/4: 표정 모음 → [📁 내 사진에서 고르기]
  await page.waitForFunction(() => /3\/4/.test((document.querySelector('.ho-step') || {}).textContent || ''), null, { timeout: 30000 });
  const png = await page.evaluate(async () => Array.from(new Uint8Array(await (await window.__png('mine', '#a0c4ff')).arrayBuffer())));
  // AI 앱이 바로 안 열리는 폰: 보낼 앱을 고르게 하고, 같이 보낼 기준 그림은 갤러리에 저장하라고 안내한다
  await page.evaluate(() => {
    const n = window.AnimeMaker.native;
    window.__saved = [];
    n.sendToApp = async (appId, o) => { window.__sent.push({ appId, text: o.text, files: (o.files || []).length }); return { direct: false }; };
    n.saveToGallery = async (b, name) => { window.__saved.push(name); return { saved: true }; };
  });
  await page.click('#ho-send');
  await page.waitForSelector('.ho-check');
  assert.match(await page.textContent('.ho-check'), /기준 그림을 직접 붙여 주세요/);
  await shot(page, 'd03a_chooser_fallback');
  await page.click('.ho-check .btn');
  await page.waitForFunction(() => window.__saved.length === 1);
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#ho-own')]);
  await fc.setFiles({ name: 'mine.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  // 부탁 4/4: 전신 → 건너뛰기 (이웃 그림으로 충분)
  await page.waitForFunction(() => /4\/4/.test((document.querySelector('.ho-step') || {}).textContent || ''), null, { timeout: 30000 });
  await shot(page, 'd03_flow_fullbody');
  await page.click('#flow-stop');
  await page.waitForFunction(() => document.querySelectorAll('.hb-slot img').length === 2, null, { timeout: 10000 });
  await shot(page, 'd04_two_pictures');
  // 정하기 → 시리즈 "<이름> 이야기"
  await page.click('#hero-lock');
  await page.waitForSelector('#hero-unlock');
  const made = await page.evaluate(async () => ({ series: (await window.AnimeMaker.db.listSeries()).map((s) => s.name), locked: (await window.AnimeMaker.db.listCharacters())[0].lockedAt > 0 }));
  assert.deepStrictEqual(made.series, ['봄이 이야기']);
  assert.ok(made.locked);
  assert.ok(await page.isDisabled('#hero-name'), '잠그면 이름 칸이 잠긴다');
  await shot(page, 'd05_locked');
  // 고급: .amchar 내보내기 → 그 파일을 다시 가져오기 (새 주인공이 하나 더 생긴다)
  await page.evaluate(() => { window.AnimeMaker.native.shareFile = async (blob, name) => { window.__shared = { name, text: await blob.text() }; }; });
  await page.click('#hero-adv summary');
  await page.click('#hero-export');
  await page.waitForFunction(() => window.__shared);
  const shared = await page.evaluate(() => window.__shared);
  assert.strictEqual(shared.name, '봄이.amchar');
  assert.strictEqual(JSON.parse(shared.text).format, 'animemaker.character');
  const origId = await page.evaluate(() => window.AnimeMaker.db.listCharacters().then((l) => l[0].id)); // 편집기 주소는 'new' 로 남아 있다
  const [fc2] = await Promise.all([page.waitForEvent('filechooser'), page.click('#hero-import')]);
  await fc2.setFiles({ name: '봄이.amchar', mimeType: 'application/json', buffer: Buffer.from(shared.text) });
  await page.waitForFunction((id) => window.AnimeMaker.app.params.id !== 'new' && window.AnimeMaker.app.params.id !== id, origId, { timeout: 8000 }).catch(async (e) => { throw new Error(`가져오기가 안 됐어요: ${(await page.locator('.toast').allTextContents()).join(' | ')} / ${e.message}`); });
  await page.waitForSelector('#hero-unlock');
  assert.strictEqual(await page.evaluate(() => window.AnimeMaker.db.listCharacters().then((l) => l.length)), 2);
  await pressBack(page);
  await page.click(`.hero-card[data-id="${origId}"]`);
  await page.waitForSelector('#hero-unlock');
  // 고치기: 확인 → 잠금 풀림
  await page.click('#hero-unlock');
  await page.click('.sheet-btns .btn.primary');
  await page.waitForSelector('#hero-lock');
  assert.ok(await page.isEnabled('#hero-name'));
  // 뒤로가기: 편집기 → 목록
  await pressBack(page);
  await page.waitForSelector('.hero-card');
  noErrors(errors);
});

// ───────────────────────── E. 설정 ─────────────────────────

test('설정: 구독 카드 4개 · 연습 모드 · 고급(화질 · 알림) · 저장 공간 · 점검 카드 · 도움말 · 앱 정보', { skip, timeout: 120000 }, async (t) => {
  const { page, errors } = await open(t, { notify: false });
  await tab(page, 'settings');
  await page.waitForSelector('.sub-card[data-app="gemini"]');
  assert.strictEqual(await page.locator('.sub-card').count(), 4);
  assert.match(await page.textContent('#btn-none'), /연습 모드로 쓰는 중/);
  await page.click('.sub-card[data-app="gemini"] [data-act="use"]');
  const s = await page.evaluate(() => JSON.parse(localStorage.getItem('am2.settings')));
  assert.deepStrictEqual([s.textApp, s.imageApp], ['gemini', 'gemini']);
  await page.waitForFunction(() => window.AnimeMaker.db.getMeta('settings').then((x) => x && x.textApp === 'gemini'));
  await page.click('.sub-card[data-app="claude"] [data-act="use"]'); // 글만 되는 앱: 그림 앱은 그대로
  assert.deepStrictEqual(await page.evaluate(() => [window.AnimeMaker.app.settings.textApp, window.AnimeMaker.app.settings.imageApp]), ['claude', 'gemini']);
  await page.click('#btn-none');
  assert.strictEqual(await page.evaluate(() => window.AnimeMaker.app.prefs.connected), false);
  await page.click('#dev-adv summary');
  await page.click('.chips[data-kind="quality"] .chip[data-quality="1080p"]');
  assert.strictEqual(await page.evaluate(() => window.AnimeMaker.app.settings.quality), '1080p');
  assert.match(await page.textContent('#notify-state'), /아직 정하지 않았어요/);
  await page.click('#btn-notify');
  await page.waitForSelector('.sheet-back .sheet-btns');
  await page.click('.sheet-btns .btn:has-text("화면 켜 둔 채로")');
  await page.waitForFunction(() => /화면을 켜 둔 채로/.test(document.querySelector('#notify-state').textContent));
  // 알림 켜기 길 (허락함 / 거절함 둘 다 이어서 할 수 있다)
  await page.evaluate(() => { window.AnimeMaker.native.requestNotificationPermission = async () => ({ granted: true }); });
  await page.click('#btn-notify');
  await page.click('.sheet-btns .btn:has-text("알림 켜기")');
  await page.waitForFunction(() => /알림이 켜져 있어요/.test(document.querySelector('#notify-state').textContent));
  await page.evaluate(() => { window.AnimeMaker.native.requestNotificationPermission = async () => ({ granted: false }); });
  await page.click('#btn-notify');
  await page.click('.sheet-btns .btn:has-text("알림 켜기")');
  await page.waitForFunction(() => /알림이 꺼져 있어요/.test(document.querySelector('#notify-state').textContent));
  assert.match(await page.textContent('#usage-text'), /저장 공간|쓸 수 있는 한도/);
  assert.ok(await page.locator('.probe-card').count() === 1);
  assert.match(await page.textContent('#app-info'), /AnimeMaker V2 2\.0\.0/);
  await shot(page, 'e01_settings_adv');
  await page.click('#btn-licenses');
  await page.waitForSelector('.sheet .sheet-body');
  assert.match(await page.textContent('.sheet .sheet-body'), /Open Font License/);
  await page.click('.sheet .sheet-close');
  await page.click('#btn-help');
  await page.waitForSelector('.help');
  assert.strictEqual(await page.locator('.help-step').count(), 3);
  await shot(page, 'e02_help');
  await pressBack(page);
  await page.waitForSelector('.settings');
  noErrors(errors);
});

// ───────────────────────── F. 만들기 화면의 여러 모습 ─────────────────────────

test('만들기 화면: 주인공이 없으면 주인공 카드 먼저 → (연습 주인공) → 카드 셋 + 연습 배너 · 노래 없이 만들 수 있음 · 받은 노래/그림 안내', { skip, timeout: 120000 }, async (t) => {
  const { page, errors } = await open(t);
  await page.waitForSelector('#hero-maker');
  assert.strictEqual(await page.locator('#btn-make').count(), 0, '주인공이 없으면 고정 바도 없다');
  await shot(page, 'f01_hero_maker');
  await page.click('#mk-hero-draw');
  assert.ok(await page.locator('.toast').filter({ hasText: '이름과 생김새' }).count() >= 1);
  await page.fill('#mk-hero-name', '구름');
  await page.fill('#mk-hero-desc', '하얀 털의 작은 강아지');
  await page.click('#mk-hero-draw');
  await page.waitForSelector('#hero-name');
  assert.strictEqual(await page.inputValue('#hero-name'), '구름');
  await page.waitForSelector('.flow-head'); // 쓴 내용으로 바로 그리기 시작
  await pressBack(page);
  await page.waitForSelector('.hero-card');
  await tab(page, 'home');
  await page.click('#mk-hero-practice');
  await page.waitForSelector('.proj', { timeout: 30000 });
  await page.waitForSelector('.proj[data-status="done"]', { timeout: 120000 }); // 연습 영상이 끝나면 뒤로 (만드는 중에는 뒤로가기가 먼저 묻는다)
  await pressBack(page);
  await page.waitForSelector('#card-song');
  assert.match(await page.textContent('#practice-banner'), /연습 모드예요/);
  assert.match(await page.textContent('#mk-estimate'), /연습 모드: 가짜 그림 · 무료/);
  assert.ok(await page.isEnabled('#btn-make'), '연습 모드는 노래 없이도 만들 수 있다');
  assert.strictEqual(await page.locator('#mk-reason:visible').count(), 0);
  // 다른 앱에서 공유로 받은 노래 · 그림은 만들기 화면에 보인다
  await page.evaluate(async () => {
    const { db } = window.AnimeMaker;
    const wav = new Blob([new Uint8Array(2000)], { type: 'audio/wav' });
    await db.putFile('inbox/aud1/0', wav);
    await db.putInbox({ id: 'aud1', receivedAt: Date.now(), text: '', items: [{ name: '받은노래.wav', mime: 'audio/wav', size: 2000, key: 'inbox/aud1/0' }] });
    const b = await window.__png('got');
    await db.putFile('inbox/img1/0', b);
    await db.putInbox({ id: 'img1', receivedAt: Date.now(), text: '', items: [{ name: 'got.png', mime: 'image/png', size: b.size, key: 'inbox/img1/0' }] });
    window.dispatchEvent(new CustomEvent('am:inbox', { detail: {} }));
  });
  await page.waitForSelector('#offer-song');
  await page.waitForSelector('.tray .tray-item');
  await shot(page, 'f02_home_inbox');
  await page.click('#offer-song-use');
  await page.waitForSelector('#song-name');
  assert.strictEqual(await page.textContent('#song-name'), '받은노래.wav');
  noErrors(errors);
});

// ───────────────────────── G. 영상 하나 ⋯ 메뉴 ─────────────────────────

test('영상 ⋯ 메뉴: 이름 바꾸기 · 자세히 보기(고급) · 단계 다시 하기 목록 · 지우기 → 내 영상 비어 있음', { skip, timeout: 120000 }, async (t) => {
  const { page, errors } = await open(t);
  const id = await page.evaluate(async () => {
    const { engine } = window.AnimeMaker;
    const seriesId = await engine.demo.ensureSeries();
    const songBlob = await engine.services.demo.song({ seconds: 10, bpm: 120 });
    const pid = await engine.projects.create({ workflow: 'demo', aspect: '9:16', quality: '480p', providers: 'demo', seriesId, songBlob, songName: 'x.wav', lyricsText: '' });
    await window.AnimeMaker.app.open(pid, { from: 'projects' });
    return pid;
  });
  await page.waitForSelector('#run-card');
  assert.match(await page.textContent('#btn-resume'), /만들기 시작/);
  // 오류 카드: 알기 쉬운 글 + [▶ 이어서 하기]
  await page.evaluate(async (pid) => { const rt = await window.AnimeMaker.engine._runtime(pid); rt.p.status = 'error'; rt.p.error = '시험 오류예요. 잠시 뒤에 다시 해 보세요.'; rt.emit(); }, id);
  await page.waitForSelector('#error-card');
  assert.match(await page.textContent('#err-msg'), /시험 오류예요/);
  assert.match(await page.textContent('#btn-resume'), /이어서 하기/);
  await shot(page, 'g00_error_card');
  await page.evaluate(async (pid) => { const rt = await window.AnimeMaker.engine._runtime(pid); rt.p.status = 'idle'; rt.p.error = null; rt.emit(); }, id);
  await page.waitForSelector('#run-card');
  await page.click('#proj-more');
  assert.deepStrictEqual(await page.locator('.sheet .menu-row').allTextContents(), ['✏️ 이름 바꾸기', '🔁 단계 다시 하기', '🔍 자세히 보기 (고급)', '🗑 이 영상 지우기']);
  await shot(page, 'g01_menu');
  await page.click('.sheet .menu-row:has-text("이름 바꾸기")');
  await page.fill('#rename-input', '내 첫 영상');
  await page.click('.sheet-btns .btn.primary');
  await page.waitForFunction(() => document.querySelector('#proj-title').textContent === '내 첫 영상');
  await page.click('#proj-more');
  await page.click('.sheet .menu-row:has-text("자세히 보기")');
  await page.waitForSelector('#detail-log');
  await page.click('.sheet .sheet-close');
  await page.click('#proj-more');
  await page.click('.sheet .menu-row:has-text("단계 다시 하기")');
  await page.waitForSelector('.sheet .menu-row[data-step]');
  assert.strictEqual(await page.locator('.sheet .menu-row[data-step]').count(), 7);
  await page.click('.sheet .sheet-close');
  await page.click('#proj-more');
  await page.click('.sheet .menu-row.danger');
  await page.waitForSelector('.sheet-btns .btn.primary');
  await page.click('.sheet-btns .btn.primary');
  await page.waitForSelector('#empty-list');
  assert.strictEqual(await page.evaluate((pid) => window.AnimeMaker.db.getProject(pid), id), null);
  assert.strictEqual(await page.evaluate(() => window.AnimeMaker.app.route), 'projects');
  noErrors(errors);
});
