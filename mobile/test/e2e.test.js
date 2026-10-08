// 폰 앱 화면을 진짜 브라우저(Chromium, 412×915)로 열어 껍데기가 뜨고 안전장치가 일하는지 확인한다.
// 개발용 묶음(www-dev)으로 만들어서 쓴다 (배포용 www 는 건드리지 않는다).
// 브라우저: CHROME_PATH → 시스템 Chrome/Chromium → Playwright 가 받아 둔 chromium (/opt/pw-browsers 등) 순서로 찾는다.
import test, { before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
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
const skip = CHROME ? false : 'Chromium/Chrome 이 없음 (CHROME_PATH 로 지정)';
const SHOT_DIR = process.env.AM_SHOTS || '';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.txt': 'text/plain', '.json': 'application/json', '.otf': 'font/otf', '.ttf': 'font/ttf', '.map': 'application/json' };

let srv;
let browser;
let base;
let outDir;

before(async () => {
  if (skip) return;
  const r = await buildApp({ dev: true });
  outDir = r.out;
  srv = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const f = path.join(outDir, u === '/' ? 'index.html' : u);
    if (!f.startsWith(outDir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${srv.address().port}/`;
  const args = typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : [];
  browser = await chromium.launch({ executablePath: CHROME, args });
});

after(async () => {
  if (browser) await browser.close();
  if (srv) srv.close();
});

async function open(t, { path: p = '', init } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, locale: 'ko-KR' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('requestfailed', (r) => { const f = r.failure(); if (f && /ERR_ABORTED/.test(f.errorText)) return; errors.push(`요청 실패 ${r.url()} ${f ? f.errorText : ''}`); }); // 새로고침으로 끊긴 요청(ERR_ABORTED)은 오류가 아니다
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  if (init) await page.addInitScript(init);
  await page.goto(base + p);
  await page.evaluate(() => window.AnimeMaker.ready);
  t.after(() => ctx.close());
  return { page, errors };
}

async function shot(page, name) {
  if (!SHOT_DIR) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: true });
}

const noErrors = (errors) => assert.deepStrictEqual(errors, []);

/** 안드로이드 뒤로가기 버튼처럼: 결과를 기다리지 않는다 (질문 창이 뜨면 app.back() 은 대답을 받을 때까지 끝나지 않는다) */
const pressBack = (page) => page.evaluate(() => { window.AnimeMaker.app.back(); });

test('시작: 앱이 뜨고 "AnimeMaker V2" 시작 화면, 저장소 열림, 점검 카드, 콘솔 오류 0', { skip, timeout: 60000 }, async (t) => {
  const { page, errors } = await open(t);
  assert.strictEqual(await page.title(), 'AnimeMaker V2');
  assert.strictEqual(await page.textContent('header.top .top-title'), 'AnimeMaker V2');
  assert.strictEqual(await page.textContent('main .hero h1'), 'AnimeMaker V2');
  assert.match(await page.textContent('#btn-new'), /만들기/);
  assert.ok(await page.evaluate(() => document.querySelector('header .logo').naturalWidth > 0), '로고(V2 아이콘)가 보여요');
  assert.ok(await page.evaluate(() => document.querySelector('main .hero img').naturalWidth > 0));
  // 저장소: 이름 animemaker-v2, 일곱 개 창고
  const dbs = await page.evaluate(() => indexedDB.databases());
  assert.deepStrictEqual(dbs.map((d) => [d.name, d.version]), [['animemaker-v2', 1]]);
  const stores = await page.evaluate(async () => { const c = await window.AnimeMaker.db.open(); return [...c.objectStoreNames].sort(); });
  assert.deepStrictEqual(stores, ['characters', 'drawings', 'files', 'inbox', 'meta', 'projects', 'series']);
  // 처음 켰을 때 저장 공간 보호를 한 번 요청해서 결과를 적어 둔다
  const persist = await page.evaluate(() => window.AnimeMaker.db.getMeta('persist'));
  assert.strictEqual(typeof persist.granted, 'boolean');
  // 내 폰 점검 카드
  await page.waitForSelector('.probe-card[data-state="done"]', { timeout: 20000 });
  assert.match(await page.textContent('.probe-card h3'), /내 폰 점검/);
  assert.match(await page.getAttribute('.probe-card', 'data-level'), /^(good|warn|bad)$/);
  assert.ok(await page.locator('.probe-card .probe-head').count() === 1);
  const saved = await page.evaluate(() => window.AnimeMaker.db.getMeta('probe'));
  assert.strictEqual(saved.version, 1);
  assert.strictEqual(typeof saved.decision.level, 'string');
  // 한 줄 폭에 맞고 가로로 밀리지 않는다
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), '가로 스크롤이 생겼어요');
  await shot(page, '01_home');
  // 번들 글꼴 @font-face 가 등록돼 있다 (파일은 www/assets/fonts)
  const families = await page.evaluate(() => [...document.fonts].map((f) => f.family.replace(/"/g, '')));
  for (const f of ['AM Pretendard', 'AM Jua', 'AM Do Hyeon', 'AM Gaegu', 'AM Black Han Sans']) assert.ok(families.includes(f), `${f} 가 등록돼야 해요: ${families}`);
  assert.ok(await page.evaluate(() => window.AnimeMaker.fonts.loadFont('jua', 32)), 'Jua 글꼴 파일을 내려받아 쓸 수 있어요');
  noErrors(errors);
});

test('배포용(줄인) 묶음도 똑같이 뜬다: 제목 · 점검 카드 · 저장소, 콘솔 오류 0', { skip, timeout: 60000 }, async (t) => {
  const prodDir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-prod-'));
  await buildApp({ dev: false, out: prodDir });
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const f = path.join(prodDir, u === '/' ? 'index.html' : u);
    if (!f.startsWith(prodDir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); fs.rmSync(prodDir, { recursive: true, force: true }); });
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 } });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(() => window.AnimeMaker.ready);
  assert.strictEqual(await page.textContent('header.top .top-title'), 'AnimeMaker V2');
  await page.waitForSelector('.probe-card[data-state="done"]', { timeout: 20000 });
  assert.deepStrictEqual((await page.evaluate(() => indexedDB.databases())).map((d) => d.name), ['animemaker-v2']);
  assert.ok(!(await page.evaluate(() => document.querySelector('script[src="app.js"]') === null)));
  assert.ok((fs.statSync(path.join(prodDir, 'app.js')).size) < 200 * 1024, '배포용 app.js 는 줄여져 있다');
  noErrors(errors);
});

test('설정: AI 앱·화질을 바꾸면 localStorage(am2.settings)와 저장소 meta 에 남고, 뒤로가기로 돌아온다', { skip, timeout: 60000 }, async (t) => {
  const { page, errors } = await open(t);
  await page.click('header .icon-btn[aria-label="설정"]');
  await page.waitForSelector('.chips[data-kind="text"]');
  await page.click('.chips[data-kind="text"] .chip[data-app="gemini"]');
  await page.click('.chips[data-kind="quality"] .chip[data-quality="1080p"]');
  const ls = await page.evaluate(() => JSON.parse(localStorage.getItem('am2.settings')));
  assert.deepStrictEqual(ls, { textApp: 'gemini', imageApp: 'chatgpt', quality: '1080p' });
  assert.strictEqual(await page.evaluate(() => localStorage.getItem('am.settings')), null, 'V1 키는 쓰지 않는다');
  await page.waitForFunction(() => window.AnimeMaker.db.getMeta('settings').then((s) => s && s.textApp === 'gemini'));
  assert.ok(await page.locator('.probe-card').count() === 1, '설정에도 점검 카드가 있다');
  assert.match(await page.textContent('#app-info'), /AnimeMaker V2 2\.0\.0/);
  await shot(page, '02_settings');
  await pressBack(page);
  await page.waitForSelector('#btn-new');
  // 새로고침해도 설정이 그대로
  await page.reload();
  await page.evaluate(() => window.AnimeMaker.ready);
  assert.strictEqual(await page.evaluate(() => window.AnimeMaker.app.settings.textApp), 'gemini');
  // localStorage 가 지워져도 저장소에서 되살린다
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(() => window.AnimeMaker.ready);
  assert.strictEqual(await page.evaluate(() => window.AnimeMaker.app.settings.quality), '1080p');
  noErrors(errors);
});

test('작품 만들기 → 마지막 작품 기억 → 새로고침해도 목록·기다림(expecting)이 남는다', { skip, timeout: 60000 }, async (t) => {
  const { page, errors } = await open(t);
  await page.click('#btn-new');
  await page.waitForSelector('#project-placeholder');
  const id = await page.evaluate(() => window.AnimeMaker.app.params.id);
  assert.strictEqual(await page.evaluate(() => window.AnimeMaker.db.getLastProject()), id);
  // 앱을 다시 켜도 남는 '다음에 받을 것'
  const exp = await page.evaluate((pid) => window.AnimeMaker.db.setExpecting({ projectId: pid, kind: 'cel', key: 'cel3_a' }), id);
  await page.reload();
  await page.evaluate(() => window.AnimeMaker.ready);
  assert.strictEqual(await page.locator('.pitem').count(), 1);
  assert.deepStrictEqual(await page.evaluate(() => window.AnimeMaker.db.getExpecting()), exp);
  await page.click('.pitem');
  await page.waitForSelector('#expecting-card');
  assert.match(await page.textContent('#expecting-card'), /cel · cel3_a/);
  await shot(page, '03_project');
  // 지우기: 확인 창 → 작품 사라짐
  await page.evaluate(() => window.AnimeMaker.app.go('home'));
  await page.click('.pitem .icon-btn[aria-label="지우기"]');
  await page.waitForSelector('.sheet');
  await page.click('.sheet-btns .btn.primary');
  await page.waitForSelector('#empty-list');
  assert.strictEqual(await page.evaluate(() => window.AnimeMaker.db.listProjects().then((l) => l.length)), 0);
  assert.strictEqual(await page.evaluate(() => window.AnimeMaker.db.getLastProject()), null, '지운 작품은 마지막으로 연 작품에서도 빠진다');
  noErrors(errors);
});

/** 작품 하나를 만들어 그 화면을 연다 (화면 안쪽 UI 에 기대지 않고 저장소와 길 찾기 함수로) */
async function openNewProject(page) {
  return page.evaluate(async () => {
    const { db, app } = window.AnimeMaker;
    const p = await db.putProject({ id: db.newId('p'), title: '시험 작품', createdAt: Date.now() });
    await app.open(p.id);
    return p.id;
  });
}
/** 오래 걸리는 시험 일을 시작한다 (기다리지 않는다) */
const startJob = (page, id, opts) => page.evaluate(([i, o]) => { window.__job = window.AnimeMaker.devJob(i, o); }, [id, opts]);

test('D1 회귀: 일하는 중 뒤로가기 → "그만둘까요, 계속 할까요?" → 계속 하기면 일이 끝까지 가서 결과가 저장된다', { skip, timeout: 60000 }, async (t) => {
  const { page, errors } = await open(t);
  const id = await openNewProject(page);
  await page.waitForSelector('#project-placeholder');
  await startJob(page, id, { steps: 6, stepMs: 400 });
  await page.waitForSelector('.busy');
  assert.ok(await page.locator('.busy .busy-stop').count() === 1, '덮개에 [그만두기] 가 있다');
  await shot(page, '04_busy');
  await pressBack(page); // 안드로이드 뒤로가기 버튼
  await page.waitForSelector('.sheet-back.top');
  assert.strictEqual(await page.textContent('.sheet-back.top .sheet-title'), '그만둘까요, 계속 할까요?');
  assert.deepStrictEqual(await page.locator('.sheet-back.top .sheet-btns .btn').allTextContents(), ['그만두기', '계속 하기']);
  await shot(page, '05_ask');
  // 질문이 떠 있는 동안 뒤로가기를 또 누르면 질문만 닫힌다 (= 계속 하기)
  await pressBack(page);
  await page.waitForSelector('.sheet-back.top', { state: 'detached' });
  assert.ok(await page.locator('.busy').count() === 1, '일은 계속 돌고 있다');
  // 다시 물어서 이번에는 [계속 하기] 를 직접 누른다
  await pressBack(page);
  await page.click('.sheet-back.top .btn.primary');
  assert.ok(await page.locator('.busy').count() === 1);
  const res = await page.evaluate(() => window.__job);
  assert.strictEqual(res.status, 'done');
  await page.waitForSelector('.busy', { state: 'detached' });
  const p = await page.evaluate((pid) => window.AnimeMaker.db.getProject(pid), id);
  assert.strictEqual(p.devResult.steps, 6, '끝난 일의 결과가 작품 id 로 저장됐다');
  assert.ok(await page.locator('.toast').filter({ hasText: '시험 일을 마쳤어요' }).count() >= 1);
  await page.waitForSelector('#dev-result', { state: 'attached' }); // 같은 작품을 보고 있으면 화면이 다시 그려진다 (접힌 칸 안이라 보이지는 않는다)
  assert.match(await page.textContent('#dev-result'), /6단계/);
  noErrors(errors);
});

test('D1 회귀: [그만두기] 를 고르면 일이 멈추고 덮개가 사라지며, 화면은 그대로이고 오류가 없다', { skip, timeout: 60000 }, async (t) => {
  const { page, errors } = await open(t);
  const id = await openNewProject(page);
  await startJob(page, id, { steps: 20, stepMs: 400 });
  await page.waitForSelector('.busy');
  await pressBack(page);
  await page.click('.sheet-back.top .btn.danger'); // 그만두기
  const res = await page.evaluate(() => window.__job);
  assert.strictEqual(res.status, 'cancelled');
  await page.waitForSelector('.busy', { state: 'detached' });
  assert.strictEqual(await page.evaluate(() => window.AnimeMaker.app.route), 'project', '그만두기를 눌러도 화면은 그대로 (이번 뒤로가기는 그만두기로 끝)');
  assert.strictEqual(await page.evaluate(() => window.AnimeMaker.jobs.isJobRunning()), false);
  const p = await page.evaluate((pid) => window.AnimeMaker.db.getProject(pid), id);
  assert.ok(!p.devResult, '그만둔 일은 결과를 저장하지 않는다');
  assert.ok(await page.locator('.toast').filter({ hasText: '그만뒀어요' }).count() >= 1);
  // 일이 없을 때 뒤로가기는 평소처럼 한 단계 돌아간다
  await pressBack(page);
  await page.waitForSelector('#btn-new');
  noErrors(errors);
});

test('D1 회귀: 일하는 중 화면이 바뀌어도(작품 변수가 사라져도) 일은 id 로 결과를 저장하고 오류가 없다', { skip, timeout: 60000 }, async (t) => {
  const { page, errors } = await open(t);
  const id = await openNewProject(page);
  await startJob(page, id, { steps: 4, stepMs: 120 });
  await page.waitForSelector('.busy');
  await page.evaluate(() => window.AnimeMaker.app.go('home')); // 가림막 뒤에서 화면이 바뀐다 (V1 의 뒤로가기 사고와 같은 상황)
  const res = await page.evaluate(() => window.__job);
  assert.strictEqual(res.status, 'done');
  const p = await page.evaluate((pid) => window.AnimeMaker.db.getProject(pid), id);
  assert.strictEqual(p.devResult.steps, 4);
  assert.strictEqual(await page.evaluate(() => window.AnimeMaker.app.route), 'home');
  assert.strictEqual(await page.locator('.busy').count(), 0);
  noErrors(errors);
});

test('진짜 IndexedDB(Chromium)에서도 저장소 규칙이 같다: 그림 기록 범위 · 앞글자 파일 지우기 · 작품 지우기 · Blob', { skip, timeout: 60000 }, async (t) => {
  const { page, errors } = await open(t);
  const r = await page.evaluate(async () => {
    const { db } = window.AnimeMaker;
    const out = {};
    await db.putProject({ id: 'p1', title: '지울 것' });
    await db.putProject({ id: 'p10', title: '남을 것' });
    await db.putDrawings([{ projectId: 'p1', key: 'bg1' }, { projectId: 'p1', key: 'cel1_a' }, { projectId: 'p10', key: 'bg1' }, { projectId: 'p2', key: 'bg1' }]);
    out.drawings = (await db.listDrawings('p1')).map((d) => d.key);
    await db.putFile('p1/song', new Blob(['노래'], { type: 'audio/wav' }));
    await db.putFile('p1/out/final.mp4', new Blob(['mp4'], { type: 'video/mp4' }));
    await db.putFile('p10/song', new Blob(['다른'], { type: 'audio/wav' }));
    await db.putFile('char/c1/ref0', new Blob(['ref'], { type: 'image/png' }));
    const song = await db.getFile('p1/song');
    out.blob = [song.type, await song.text()];
    out.keysBefore = (await db.listFileKeys()).sort();
    await db.deleteProject('p1');
    out.project = await db.getProject('p1');
    out.drawingsAfter = [(await db.listDrawings('p1')).length, (await db.listDrawings('p10')).length, (await db.listDrawings('p2')).length];
    out.keysAfter = (await db.listFileKeys()).sort();
    out.keysP10 = await db.listFileKeys('p10/');
    try { await db.deleteFiles(''); out.emptyPrefix = 'no error'; } catch (e) { out.emptyPrefix = e.message; }
    out.expectNonce = (await db.setExpecting({ projectId: 'p10', kind: 'bg', key: '3' })).nonce.length;
    out.cleared = [await db.clearExpecting('틀린번호'), await db.clearExpecting()];
    return out;
  });
  assert.deepStrictEqual(r.drawings, ['bg1', 'cel1_a']);
  assert.deepStrictEqual(r.blob, ['audio/wav', '노래']);
  assert.deepStrictEqual(r.keysBefore, ['char/c1/ref0', 'p1/out/final.mp4', 'p1/song', 'p10/song']);
  assert.strictEqual(r.project, null);
  assert.deepStrictEqual(r.drawingsAfter, [0, 1, 1]);
  assert.deepStrictEqual(r.keysAfter, ['char/c1/ref0', 'p10/song']);
  assert.deepStrictEqual(r.keysP10, ['p10/song']);
  assert.match(r.emptyPrefix, /앞글자/);
  assert.strictEqual(r.expectNonce, 16);
  assert.deepStrictEqual(r.cleared, [false, true]);
  noErrors(errors);
});

test('시작 화면에서 뒤로가기는 앱을 끝내라는 신호를 보내고, 일하는 중이거나 창이 열려 있으면 보내지 않는다', { skip, timeout: 60000 }, async (t) => {
  const { page, errors } = await open(t);
  await page.evaluate(() => {
    window.__exits = 0;
    window.AnimeMaker.N._test.use({ native: true, app: { exitApp: () => { window.__exits++; }, addListener: async () => ({ remove() {} }) } });
  });
  const exits = () => page.evaluate(() => window.__exits);
  // 창이 열려 있으면 창만 닫는다
  await page.evaluate(() => { window.AnimeMaker.ui.bottomSheet({ title: '창', body: 'x' }); });
  await page.evaluate(async () => { await window.AnimeMaker.app.back(); });
  assert.strictEqual(await exits(), 0);
  assert.strictEqual(await page.locator('.sheet-back').count(), 0);
  // 일하는 중이면 묻고, 계속 하기면 끝내지 않는다
  const id = await openNewProject(page);
  await page.evaluate(() => window.AnimeMaker.app.go('home'));
  await startJob(page, id, { steps: 3, stepMs: 150 });
  await page.waitForSelector('.busy');
  await pressBack(page);
  await page.click('.sheet-back.top .btn.primary');
  assert.strictEqual(await exits(), 0);
  await page.evaluate(() => window.__job);
  // 아무 일도 없는 시작 화면에서는 끝낸다
  await page.evaluate(async () => { await window.AnimeMaker.app.back(); });
  assert.strictEqual(await exits(), 1);
  // 다른 화면에서는 시작 화면으로만 돌아간다
  await page.evaluate(() => window.AnimeMaker.app.go('settings'));
  await page.evaluate(async () => { await window.AnimeMaker.app.back(); });
  assert.strictEqual(await page.evaluate(() => window.AnimeMaker.app.route), 'home');
  assert.strictEqual(await exits(), 1);
  noErrors(errors);
});

test('아래에서 올라오는 창은 [닫기] 와 ✕ 로 닫히고, 뒤로가기도 맨 위 창부터 닫는다. 기다림 덮개의 그만두기는 signal 을 abort 한다', { skip, timeout: 60000 }, async (t) => {
  const { page, errors } = await open(t);
  await page.evaluate(() => { window.AnimeMaker.ui.bottomSheet({ title: '시험 창', body: '내용' }); });
  assert.strictEqual(await page.textContent('.sheet .sheet-close'), '닫기');
  assert.strictEqual(await page.getAttribute('.sheet .sheet-x', 'aria-label'), '닫기');
  await page.click('.sheet .sheet-close');
  assert.strictEqual(await page.locator('.sheet-back').count(), 0);
  await page.evaluate(() => { window.AnimeMaker.ui.bottomSheet({ title: '창 둘', body: 'b', sticky: true }); });
  await page.mouse.click(200, 20); // 바깥 (sticky 라 안 닫힌다)
  assert.strictEqual(await page.locator('.sheet-back').count(), 1);
  await pressBack(page);
  assert.strictEqual(await page.locator('.sheet-back').count(), 0, '뒤로가기가 창을 닫는다 (화면은 그대로)');
  assert.strictEqual(await page.evaluate(() => window.AnimeMaker.app.route), 'home');
  // 버튼이 있는 창: 값이 돌아온다
  const v = page.evaluate(async () => window.AnimeMaker.ui.sheet('고르기', 'x', [{ label: '아니요', value: 'no' }, { label: '네', kind: 'primary', value: 'yes' }]));
  await page.click('.sheet-btns .btn.primary');
  assert.strictEqual(await v, 'yes');
  // busy: 그만두기 → onCancel + signal abort
  await page.evaluate(() => {
    window.__cancelled = 0;
    window.__b = window.AnimeMaker.ui.busy({ message: '만드는 중', progress: 0.25, onCancel: () => { window.__cancelled++; } });
  });
  assert.strictEqual(await page.getAttribute('.busy [role=progressbar]', 'aria-valuenow'), '25');
  await page.click('.busy .busy-stop');
  assert.strictEqual(await page.evaluate(() => [window.__cancelled, window.__b.signal.aborted, window.__b.cancelled]).then((x) => x.join()), '1,true,true');
  await page.evaluate(() => window.__b.done());
  assert.strictEqual(await page.locator('.busy').count(), 0);
  noErrors(errors);
});

test('공유로 받은 것(가짜 네이티브)이 앱 저장소로 옮겨지고, 새로고침(앱 재시작)해도 남는다', { skip, timeout: 60000 }, async (t) => {
  const { page, errors } = await open(t);
  const result = await page.evaluate(async () => {
    const { N, inbox, db } = window.AnimeMaker;
    const acked = [];
    const entry = { id: 'share-1', receivedAt: Date.now(), text: '답장 글', items: [{ path: '/icon.png', name: 'icon.png', mime: 'image/png', size: 1 }] };
    N._test.use({
      native: true,
      plugin: {
        takeInbox: async () => ({ entries: acked.length ? [] : [entry] }),
        ackInbox: async ({ ids }) => { acked.push(...ids); return { removed: ids.length }; },
        addListener: async () => ({ remove() {} }),
      },
      app: { addListener: async () => ({ remove() {} }) },
    });
    const got = [];
    const off = inbox.startReceiving({ onReceived: (s) => got.push(s.label) });
    await new Promise((r) => setTimeout(r, 400));
    off();
    N._test.use({ native: false });
    const rec = await db.getInbox('share-1');
    const blob = await db.getFile(rec.items[0].key);
    return { got, acked, items: rec.items.map((i) => [i.name, i.mime, i.size > 100]), blobType: blob.type, text: rec.text };
  });
  assert.deepStrictEqual(result.got, ['그림 1장 · 글']);
  assert.deepStrictEqual(result.acked, ['share-1']);
  assert.deepStrictEqual(result.items, [['icon.png', 'image/png', true]]);
  assert.strictEqual(result.blobType, 'image/png');
  await page.reload(); // 프로세스가 죽었다 켜진 것과 같다
  await page.evaluate(() => window.AnimeMaker.ready);
  const after = await page.evaluate(async () => (await window.AnimeMaker.inbox.listReceived()).map((r) => [r.id, r.text, r.items.length]));
  assert.deepStrictEqual(after, [['share-1', '답장 글', 1]]);
  noErrors(errors);
});

test('전역 오류는 알기 쉬운 알림으로 보이고, 같은 오류가 연달아 와도 한 번만 보인다', { skip, timeout: 60000 }, async (t) => {
  const { page, errors } = await open(t);
  await page.evaluate(() => { for (let i = 0; i < 3; i++) setTimeout(() => { throw new Error('시험 오류 123'); }, i); Promise.reject(new Error('시험 약속 실패')); });
  await page.waitForSelector('.toast.err');
  await page.waitForTimeout(100);
  const texts = await page.locator('.toast.err').allTextContents();
  assert.deepStrictEqual(texts.filter((x) => x.includes('시험 오류 123')).length, 1);
  assert.ok(texts.some((x) => x.includes('시험 약속 실패')));
  assert.ok(texts.every((x) => x.startsWith('문제가 생겼어요: ')));
  // 그만둔 일(AbortError)은 알리지 않는다
  await page.evaluate(() => { Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' })); });
  await page.waitForTimeout(100);
  assert.ok(!(await page.locator('.toast.err').allTextContents()).some((x) => x.includes('AbortError')));
  // 우리가 일부러 낸 오류만 있어야 한다
  assert.ok(errors.every((e) => /시험 (오류 123|약속 실패)|AbortError|^Uncaught/.test(e) || /x$/.test(e)), errors.join('\n'));
});
