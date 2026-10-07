'use strict';
// AnimeMaker V2 - Electron 메인 프로세스 (AnimeMaker V1 에서 갈라져 나옴)
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage, Menu } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store } = require('./store');
const { ProjectRunner } = require('./pipeline/runner');
const { AGENTS, agentStatus, agentTest, agentText, findBin } = require('./ai/agents');
const { BotManager } = require('./ai/webbot/manager');
const { SITES } = require('./ai/helper');
const { renderSubtitlePngs } = require('./subtitles');
const { ffmpegPath } = require('./media/ffmpeg');

// 테스트·휴대용 실행을 위한 경로 바꾸기 (일반 사용자는 신경 쓰지 않아도 됨)
if (process.env.ANIMEMAKER_USERDATA) app.setPath('userData', process.env.ANIMEMAKER_USERDATA);
if (process.env.ANIMEMAKER_DOCUMENTS) app.setPath('documents', process.env.ANIMEMAKER_DOCUMENTS);
if (process.env.ANIMEMAKER_DOWNLOADS) app.setPath('downloads', process.env.ANIMEMAKER_DOWNLOADS);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let store = null;
let bot = null;
const runners = new Map();

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function getRunner(id) {
  let r = runners.get(id);
  if (!r) {
    r = new ProjectRunner({ store, projectId: id, bot, renderSubtitles: renderSubtitlePngs });
    r.on('update', (snap) => send('project:update', snap));
    r.on('log', (l) => send('project:log', l));
    runners.set(id, r);
  }
  return r;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    title: 'AnimeMaker V2 - 셀 애니메이션 뮤직비디오 제작기',
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'),
    backgroundColor: '#f6f5fb',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.control && input.shift && input.key.toLowerCase() === 'i') win.webContents.toggleDevTools();
  });
  win.on('close', (e) => {
    const busy = [...runners.values()].some((r) => r.running);
    if (!busy) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['계속 작업하기', '중지하고 종료'],
      defaultId: 0,
      cancelId: 0,
      title: '작업 중',
      message: '영상을 만드는 중입니다. 종료할까요?',
      detail: '지금 종료해도 만든 부분은 저장되어 있어서, 다음에 [이어서 하기] 로 계속할 수 있습니다.',
    });
    if (choice === 0) e.preventDefault();
    else for (const r of runners.values()) r.stop();
  });
}

/** 새 콘솔 창에서 명령 실행 (로그인/설치용) */
function openConsole(title, lines, { powershell = false } = {}) {
  const dir = path.join(app.getPath('userData'), 'scripts');
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    if (powershell) {
      const file = path.join(dir, `${Date.now()}.ps1`);
      const body = [
        '$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8',
        `$host.UI.RawUI.WindowTitle = '${title.replace(/'/g, "''")}'`,
        ...lines,
        "Write-Host ''",
        "Write-Host '끝났습니다. 이 창을 닫고 AnimeMaker V2 에서 [상태 확인] 을 눌러 주세요.'",
      ].join('\r\n');
      fs.writeFileSync(file, `﻿${body}`, 'utf8');
      spawn('cmd.exe', ['/c', 'start', '""', 'powershell.exe', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', file], { detached: true, windowsHide: false });
    } else {
      const file = path.join(dir, `${Date.now()}.cmd`);
      const body = ['@echo off', 'chcp 65001 > nul', `title ${title}`, ...lines, 'echo.', 'echo 끝났습니다. 이 창을 닫고 AnimeMaker V2 에서 [상태 확인] 을 눌러 주세요.', 'pause'].join('\r\n');
      fs.writeFileSync(file, body, 'utf8');
      spawn('cmd.exe', ['/c', 'start', '""', file], { detached: true, windowsHide: false });
    }
    return true;
  }
  const file = path.join(dir, `${Date.now()}.sh`);
  fs.writeFileSync(file, `#!/bin/sh\n${lines.join('\n')}\necho; echo "끝났습니다. 창을 닫으세요."; read _\n`, { mode: 0o755 });
  const term = process.platform === 'darwin' ? ['open', ['-a', 'Terminal', file]] : ['x-terminal-emulator', ['-e', file]];
  try { spawn(term[0], term[1], { detached: true }); } catch (_) { return false; }
  return true;
}

function cleanEnvLine() {
  // 로그인 창에서도 종량제 API 키가 섞이지 않도록
  return process.platform === 'win32'
    ? 'set OPENAI_API_KEY=& set CODEX_API_KEY=& set XAI_API_KEY=& set GEMINI_API_KEY=& set GOOGLE_API_KEY=& set ANTHROPIC_API_KEY='
    : 'unset OPENAI_API_KEY CODEX_API_KEY XAI_API_KEY GEMINI_API_KEY GOOGLE_API_KEY ANTHROPIC_API_KEY';
}

function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; } catch (err) { return { ok: false, error: err.message || String(err) }; }
  });

  // 시스템
  h('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    paths: { projects: store.projectsDir(), downloads: store.downloadsDir(), userData: app.getPath('userData') },
    ffmpeg: ffmpegPath(),
    sites: SITES,
    agents: Object.values(AGENTS).map((a) => ({ id: a.id, name: a.name, subscription: a.subscription, caps: a.caps, install: process.platform === 'win32' ? a.install.win : a.install.other, installNote: a.install.note || '', login: a.login, loginNote: a.loginNote })),
  }));
  h('sys:openPath', (p) => shell.openPath(p));
  h('sys:showItem', (p) => { shell.showItemInFolder(p); return true; });
  h('sys:openExternal', (url) => { if (/^https?:\/\//.test(url)) return shell.openExternal(url); return false; });
  h('sys:copyText', (t) => { clipboard.writeText(String(t || '')); return true; });
  h('sys:copyImage', (p) => {
    const img = nativeImage.createFromPath(p);
    if (img.isEmpty()) throw new Error('이미지를 읽을 수 없습니다.');
    clipboard.writeImage(img);
    return true;
  });
  h('sys:pickFile', async (opts = {}) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: opts.filters || [] });
    return r.canceled ? null : r.filePaths[0];
  });
  h('sys:readTextFile', (p) => {
    const st = fs.statSync(p);
    if (st.size > 2 * 1024 * 1024) throw new Error('파일이 너무 큽니다.');
    return fs.readFileSync(p, 'utf8');
  });
  h('media:probe', async (p) => {
    const { probe } = require('./media/ffmpeg');
    const info = await probe(p);
    if (!info.hasAudio) throw new Error('소리가 없는 파일이에요. 노래 파일(mp3, wav, m4a, mp4 등)을 골라 주세요.');
    return info;
  });
  h('sys:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  // 설정
  h('settings:get', () => store.getSettings());
  h('settings:save', (patch) => store.saveSettings(patch));

  // 워크플로우
  h('wf:list', () => store.listWorkflows());
  h('wf:save', (wf) => store.saveWorkflow(wf));
  h('wf:delete', (id) => store.deleteWorkflow(id));

  // 프로젝트
  h('proj:list', () => store.listProjects());
  h('proj:create', ({ topic, workflowId, songPath, lyricsText, lyricsFilename }) => {
    const wf = store.getWorkflow(workflowId);
    if (songPath && !fs.existsSync(songPath)) throw new Error('노래 파일을 찾을 수 없습니다.');
    const p = store.createProject(String(topic || '').trim(), wf, { songPath, lyricsText, lyricsFilename });
    const r = getRunner(p.id);
    r.run();
    return r.snapshot();
  });
  h('proj:get', (id) => getRunner(id).snapshot());
  h('proj:run', (id, from) => { const r = getRunner(id); r.run({ from }); return true; });
  h('proj:stop', (id) => { getRunner(id).stop(); return true; });
  h('proj:delete', (id) => {
    const r = runners.get(id);
    if (r && r.running) throw new Error('진행 중인 작업은 먼저 중지하세요.');
    runners.delete(id);
    return store.deleteProject(id);
  });
  h('proj:provideFile', (id, key, file) => getRunner(id).provideFile(key, file));
  h('proj:skipWaiting', (id, key) => getRunner(id).skipWaiting(key));
  h('proj:continue', (id) => getRunner(id).continueReview());
  h('proj:regenerate', (id, kind, clip, opts) => getRunner(id).regenerate(kind, clip, opts || {}));
  h('proj:replace', (id, kind, clip, file, slot) => { getRunner(id).replaceItem(kind, clip, file, slot); return true; });
  h('proj:updatePlan', (id, plan) => { getRunner(id).updatePlan(plan); return true; });
  h('proj:updateLyrics', (id, lyrics) => { getRunner(id).updateLyrics(lyrics); return true; });
  h('proj:setBpm', (id, bpm) => getRunner(id).setBpm(bpm));
  h('proj:replaceSong', (id, file) => { getRunner(id).replaceSong(file); return true; });
  h('proj:updateLyricsText', (id, raw, filename) => { getRunner(id).updateLyricsText(raw, filename); return true; });
  h('proj:readLog', (id) => {
    const f = path.join(store.projectDir(id), 'log.txt');
    try {
      const st = fs.statSync(f);
      const fd = fs.openSync(f, 'r');
      const len = Math.min(st.size, 300000);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      fs.closeSync(fd);
      return buf.toString('utf8');
    } catch (_) { return ''; }
  });
  h('proj:setProviders', (id, providers, helperSites) => {
    const r = getRunner(id);
    if (r.running) throw new Error('진행 중에는 바꿀 수 없습니다.');
    r.p.providers = { ...r.p.providers, ...(providers || {}) };
    r.p.helperSites = { ...r.p.helperSites, ...(helperSites || {}) };
    r.save();
    return r.snapshot();
  });

  // 주제 추천 (구독 LLM)
  h('ai:suggestTopics', async (seed) => {
    const s = store.getSettings();
    const prov = s.providers.text;
    if (prov === 'demo' || !AGENTS[prov]) {
      return ['비 오는 도시를 헤매며 잃어버린 친구를 찾는 고양이', '편의점 알바생 로봇의 첫사랑 이야기', '새벽 지하철에서 만난 유령 DJ 와의 하룻밤', '할머니 댁 다락방에서 찾은 마법 지도로 떠나는 여행', '여름 바닷가 마을의 마지막 불꽃놀이'];
    }
    const obj = await agentText(prov, {
      prompt: `Suggest 6 short, original music video concepts (in Korean, one sentence each) for a 3-4 minute AI music video of a song.${seed ? `\nUse this as the basis (user's idea and/or the song lyrics):\n${seed}` : ''}\nReturn JSON: {"topics": ["...", "..."]}`,
      dir: path.join(app.getPath('temp'), 'animemaker-topics', String(Date.now())),
      settings: s,
      accept: (o) => Array.isArray(o.topics) && o.topics.length > 0,
      timeoutMs: 5 * 60 * 1000,
    });
    return obj.topics.map(String).slice(0, 8);
  });

  // 구독 AI 연결
  h('agent:status', (id) => agentStatus(id, store.getSettings()));
  h('agent:test', (id) => agentTest(id, store.getSettings(), path.join(app.getPath('temp'), 'animemaker-test', `${id}-${Date.now()}`)));
  h('agent:login', (id) => {
    const a = AGENTS[id];
    let bin = a.bins[0];
    try { bin = findBin(id, store.getSettings()); } catch (_) { /* PATH 에서 찾기 */ }
    const q = process.platform === 'win32' ? `"${bin}"` : `'${bin}'`;
    const cmd = a.login.replace(/^\S+/, q);
    const note = process.platform === 'win32'
      ? `echo ${a.loginNote.replace(/[&|<>^%]/g, ' ')}`
      : `echo '${a.loginNote.replace(/'/g, "'\\''")}'`;
    return openConsole(`${a.name} 로그인`, [cleanEnvLine(), note, process.platform === 'win32' ? 'echo.' : 'echo', cmd]);
  });
  h('agent:install', (id) => {
    const a = AGENTS[id];
    if (process.platform === 'win32') {
      const cmd = a.install.win;
      if (cmd.startsWith('npm ')) return openConsole(`${a.name} 설치`, [cmd]);
      return openConsole(`${a.name} 설치`, [cmd], { powershell: true });
    }
    return openConsole(`${a.name} 설치`, [a.install.other]);
  });

  // 자동 클릭 브라우저
  h('bot:openSite', (siteId) => {
    const site = SITES[siteId];
    if (!site) throw new Error('알 수 없는 사이트');
    return bot.openSite(site.url);
  });
  h('bot:close', () => bot.close());
  h('bot:isOpen', () => bot.isOpen());
  h('bot:recipes', () => bot.recipes());
  h('bot:saveRecipes', (json) => {
    const obj = typeof json === 'string' ? JSON.parse(json) : json;
    if (!obj || typeof obj.tasks !== 'object') throw new Error('레시피 형식이 올바르지 않습니다 (tasks 가 필요합니다).');
    fs.writeFileSync(store.recipesFile, JSON.stringify(obj, null, 2));
    return true;
  });
  h('bot:resetRecipes', () => { try { fs.unlinkSync(store.recipesFile); } catch (_) { /* noop */ } return true; });
}

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('com.animemaker.v2');
  store = new Store({
    userDataDir: app.getPath('userData'),
    documentsDir: app.getPath('documents'),
    downloadsDir: app.getPath('downloads'),
  });
  bot = new BotManager(store);
  registerIpc();
  createWindow();
});

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.on('window-all-closed', async () => {
  try { if (bot) await bot.close(); } catch (_) { /* noop */ }
  app.quit();
});

process.on('unhandledRejection', (e) => {
  try { fs.appendFileSync(path.join(os.tmpdir(), 'animemaker-v2-error.log'), `${new Date().toISOString()} ${e && e.stack}\n`); } catch (_) { /* noop */ }
});
