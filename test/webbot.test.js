'use strict';
// 자동 클릭 엔진을 가짜 AI 웹사이트(로컬)에 대고 시험한다. 브라우저가 없으면 건너뜀.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { BotBrowser, findBrowser } = require('../src/main/ai/webbot/browser');
const { RecipeRunner, NeedsUserError, loadRecipes } = require('../src/main/ai/webbot/engine');
const { ffmpegPath } = require('../src/main/media/ffmpeg');

const PW = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
if (!process.env.ANIMEMAKER_BOT_BROWSER && fs.existsSync(PW)) process.env.ANIMEMAKER_BOT_BROWSER = PW;
const browser = findBrowser('chrome');

const PAGE = `<!doctype html><html><body>
<div id="feed"></div><input type="file" id="f" style="display:none">
<div contenteditable="true" role="textbox" id="box" style="width:400px;height:40px;border:1px solid #000"></div>
<button aria-label="Send message" onclick="go()">↑</button>
<script>
function go(){ const t=document.getElementById('box').innerText; const n=document.getElementById('f').files.length;
  window.lastPrompt=t; window.files=n;
  setTimeout(()=>{ const v=t.includes('video');
    document.getElementById('feed').insertAdjacentHTML('beforeend', v
      ? '<video src="/gen.mp4?'+Date.now()+'" controls width=300></video>'
      : '<img src="/gen.png?'+Date.now()+'" width=300 height=400><button aria-label="Download" onclick="location.href=\\'/dl\\'">dl</button>'); }, 1500); }
</script></body></html>`;

test('recipe runner: upload, fill, submit, wait, save (src + download button)', { skip: browser ? false : '브라우저 없음', timeout: 180000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-bot-'));
  const ff = ffmpegPath();
  execFileSync(ff, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=600x800:d=1', '-frames:v', '1', path.join(dir, 'gen.png')]);
  execFileSync(ff, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=480x640:r=24:d=2', '-pix_fmt', 'yuv420p', path.join(dir, 'gen.mp4')]);
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/gen.png')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(fs.readFileSync(path.join(dir, 'gen.png'))); }
    if (req.url.startsWith('/gen.mp4')) { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end(fs.readFileSync(path.join(dir, 'gen.mp4'))); }
    if (req.url.startsWith('/dl')) { res.writeHead(200, { 'content-type': 'image/png', 'content-disposition': 'attachment; filename="art.png"' }); return res.end(fs.readFileSync(path.join(dir, 'gen.png'))); }
    res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const bb = new BotBrowser();
  try {
    await bb.ensure({ profileDir: path.join(dir, 'profile'), headless: true, extraArgs: ['--no-sandbox'] }).catch((e) => {
      t.diagnostic(`browser: ${browser}\nbrowser stderr (last part):\n${e.browserLog || '(없음)'}`); // 안 켜지면 원인을 남긴다
      throw e;
    });
    const page = await bb.page();
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    const img = await new RecipeRunner(page, { pace: 0.1 }).run({ steps: [
      { do: 'goto', url: base }, { do: 'waitFor' },
      { do: 'upload', file: '{{reference}}', when: 'reference' },
      { do: 'fill', text: 'Generate ({{aspect}}). {{prompt}}' }, { do: 'submit' },
      { do: 'waitResult', kind: 'image', timeout: 20000, stableMs: 1000 }, { do: 'download', ext: '.png' }] },
    { prompt: 'cat "quoted"\nnext line', aspect: '9:16', reference: path.join(dir, 'gen.png') }, out);
    assert.ok(fs.statSync(img).size > 2000);
    assert.strictEqual(await page.evaluate(() => window.files), 1);
    assert.match(await page.evaluate(() => window.lastPrompt), /cat "quoted"/);
    const vid = await new RecipeRunner(page, { pace: 0.1 }).run({ steps: [
      { do: 'goto', url: base }, { do: 'fill', text: 'video {{prompt}}' }, { do: 'submit' },
      { do: 'waitResult', kind: 'video', timeout: 20000, stableMs: 1000 }, { do: 'download', ext: '.mp4' }] }, { prompt: 'zoom' }, out);
    assert.match(vid, /\.mp4$/);
    const dl = await new RecipeRunner(page, { pace: 0.1 }).run({ steps: [
      { do: 'goto', url: base }, { do: 'fill', text: 'img' }, { do: 'submit' },
      { do: 'waitResult', kind: 'image', timeout: 20000, stableMs: 1000 }, { do: 'download', buttonsOnly: true }] }, {}, out);
    assert.ok(fs.statSync(dl).size > 2000);
    // 결과가 안 나오면 사용자에게 넘긴다
    await assert.rejects(() => new RecipeRunner(page, { pace: 0.1 }).run({ steps: [
      { do: 'goto', url: base }, { do: 'click', any: ['#does-not-exist'], timeout: 500 }] }, {}, out), (e) => e instanceof NeedsUserError);
  } finally {
    await bb.close();
    srv.close();
  }
});

test('bundled recipes load and user overrides merge', () => {
  const bundled = path.join(__dirname, '..', 'src', 'main', 'ai', 'webbot', 'recipes.json');
  const r = loadRecipes(null, bundled);
  for (const k of ['gemini.image', 'gemini.video', 'grok.image', 'grok.video', 'chatgpt.image']) assert.ok(r.tasks[k], k);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-rec-'));
  const user = path.join(dir, 'recipes.json');
  fs.writeFileSync(user, JSON.stringify({ version: 99, tasks: { 'gemini.image': { steps: [] } } }));
  const m = loadRecipes(user, bundled);
  assert.deepStrictEqual(m.tasks['gemini.image'].steps, []);
  assert.ok(m.tasks['grok.video']);
});
