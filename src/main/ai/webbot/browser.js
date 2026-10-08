'use strict';
// 자동 클릭 모드용 브라우저.
// 사용자의 PC 에 설치된 Edge/Chrome 을 'AnimeMaker 전용 프로필' 로 띄우고 CDP 로 연결한다.
// (로그인은 사용자가 그 창에서 직접 한 번만 하면 쿠키가 프로필에 남는다)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let chromium = null;
function pw() {
  if (!chromium) chromium = require('playwright-core').chromium;
  return chromium;
}

function candidatesFor(pref) {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const edge = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    '/usr/bin/microsoft-edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  const chrome = [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return pref === 'chrome' ? [...chrome, ...edge] : [...edge, ...chrome];
}

function findBrowser(pref, customPath) {
  if (customPath && fs.existsSync(customPath)) return customPath;
  if (process.env.ANIMEMAKER_BOT_BROWSER && fs.existsSync(process.env.ANIMEMAKER_BOT_BROWSER)) return process.env.ANIMEMAKER_BOT_BROWSER;
  return candidatesFor(pref).find((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } }) || null;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('timeout')));
  });
}

class BotBrowser {
  constructor() {
    this.proc = null;
    this.browser = null;
    this.context = null;
    this.port = 0;
  }

  isAlive() {
    return !!(this.browser && this.browser.isConnected() && this.proc && this.proc.exitCode === null);
  }

  /**
   * @param {{browserPath?:string, prefer?:string, profileDir:string, headless?:boolean, startUrl?:string}} o
   */
  async ensure(o) {
    if (this.isAlive()) return this;
    await this.close();
    const exe = findBrowser(o.prefer, o.browserPath);
    if (!exe) throw new Error('Edge 또는 Chrome 브라우저를 찾지 못했습니다. 설정에서 브라우저 위치를 지정해 주세요.');
    fs.mkdirSync(o.profileDir, { recursive: true });
    // 포트는 브라우저가 직접 고르게 하고(0), 준비되면 프로필 폴더에 쓰는 DevToolsActivePort 파일에서 읽는다.
    // (미리 빈 포트를 골라 두면 그 사이 다른 프로그램이 가져갈 수 있다)
    const portFile = path.join(o.profileDir, 'DevToolsActivePort');
    try { fs.unlinkSync(portFile); } catch (_) { /* 없으면 그만 */ }
    const args = [
      '--remote-debugging-port=0',
      `--user-data-dir=${o.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--window-size=1280,900',
    ];
    if (o.headless) args.push('--headless=new');
    if (o.extraArgs) args.push(...o.extraArgs);
    args.push(o.startUrl || 'about:blank');
    this.proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: false, detached: false });
    // 브라우저가 남기는 메시지는 마지막 부분만 들고 있다가, 안 켜질 때 원인을 알 수 있게 오류에 붙인다
    this.log = '';
    this.proc.stderr.on('data', (d) => { this.log = (this.log + d).slice(-4000); });
    this.port = 0;
    const until = Date.now() + (o.startTimeoutMs || 60000);
    let ok = false;
    while (Date.now() < until) {
      if (!this.port) {
        try {
          const port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
          if (port > 0) this.port = port;
        } catch (_) { /* 아직 준비 전 */ }
      }
      if (this.port) {
        try { await getJson(`http://127.0.0.1:${this.port}/json/version`); ok = true; break; } catch (_) { /* 아직 준비 전 */ }
      }
      if (this.proc.exitCode !== null) break;
      await sleep(300);
    }
    if (!ok) {
      const exited = this.proc.exitCode !== null;
      try { if (!exited) this.proc.kill(); } catch (_) { /* noop */ }
      const e = new Error(exited
        ? '자동 클릭용 브라우저를 열지 못했습니다. 같은 프로필의 브라우저 창이 이미 열려 있다면 닫고 다시 시도하세요.'
        : '자동 클릭용 브라우저가 1분 안에 준비되지 않았습니다. 컴퓨터가 바쁘면 잠시 뒤 다시 시도하세요.');
      e.browserLog = this.log;
      throw e;
    }
    this.browser = await pw().connectOverCDP(`http://127.0.0.1:${this.port}`);
    this.context = this.browser.contexts()[0] || await this.browser.newContext();
    return this;
  }

  async page() {
    const pages = this.context.pages().filter((p) => !p.isClosed());
    const p = pages[pages.length - 1] || await this.context.newPage();
    await p.bringToFront().catch(() => {});
    return p;
  }

  async close() {
    const p = this.proc;
    try { if (this.browser) await this.browser.close(); } catch (_) { /* noop */ }
    try { if (p && p.exitCode === null) p.kill(); } catch (_) { /* noop */ }
    // 같은 프로필로 바로 다시 열 수 있게, 브라우저가 완전히 끝날 때까지 잠깐(최대 5초) 기다린다
    if (p && p.exitCode === null && p.signalCode === null) {
      await new Promise((r) => { const t = setTimeout(r, 5000); p.once('exit', () => { clearTimeout(t); r(); }); });
    }
    this.browser = null;
    this.context = null;
    this.proc = null;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { BotBrowser, findBrowser };
