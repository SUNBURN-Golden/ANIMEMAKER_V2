'use strict';
// 구독형 AI 의 공식 CLI(코덱스, 그록, 안티그래비티, 클로드 코드)를 실행하는 공통 모듈.
// 중요: 종량제 API 키 환경변수는 모두 지운 상태로 실행해서 '구독 한도 안에서만' 쓰도록 한다.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** 종량제 과금으로 새어나갈 수 있는 환경변수들 */
const PAID_API_ENV = [
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'AZURE_OPENAI_API_KEY',
  'XAI_API_KEY', 'GROK_API_KEY',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'ELEVENLABS_API_KEY',
];

/** 'a;b' 꼴 PATH 여러 개를 순서대로 합치고 겹치는 것은 뺀다 (윈도우는 대소문자 무시) */
function mergePaths(lists, sep = path.delimiter, caseless = process.platform === 'win32') {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const raw of String(list || '').split(sep)) {
      const d = raw.trim().replace(/^"(.*)"$/, '$1');
      if (!d) continue;
      const k = caseless ? d.toLowerCase().replace(/[\\/]+$/, '') : d;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(d);
    }
  }
  return out.join(sep);
}

/** %LOCALAPPDATA% 같은 윈도우 변수 풀기 */
function expandWinVars(s, env = process.env) {
  return String(s || '').replace(/%([^%;]+)%/g, (all, name) => {
    const k = Object.keys(env).find((x) => x.toUpperCase() === name.toUpperCase());
    return k ? env[k] : all;
  });
}

let freshPathCache = { at: 0, value: null };

/**
 * 윈도우: 지금 레지스트리에 저장된 PATH (시스템 + 사용자) 를 읽는다.
 * 프로그램은 켜질 때의 PATH 를 계속 쓰기 때문에, 켜 둔 채 Node.js·Codex 등을 설치하면 찾지 못한다.
 * 그래서 CLI 를 찾거나 실행할 때마다 (30초 캐시) 최신 PATH 를 합쳐 쓴다.
 */
function freshWindowsPath(env = process.env, { force = false } = {}) {
  if (process.platform !== 'win32') return null;
  if (!force && freshPathCache.value && Date.now() - freshPathCache.at < 30000) return freshPathCache.value;
  let machine = '';
  let user = '';
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetEnvironmentVariable('Path','Machine'); '<<<AM>>>'; [Environment]::GetEnvironmentVariable('Path','User')"],
    { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    [machine, user] = out.split('<<<AM>>>').map((x) => x.trim());
  } catch (_) { /* 못 읽으면 지금 PATH 만 쓴다 */ }
  const value = mergePaths([expandWinVars(machine, env), expandWinVars(user, env), env.PATH || env.Path || ''], ';', true);
  freshPathCache = { at: Date.now(), value };
  return value;
}

/** env 의 PATH 를 바꾼다 (윈도우는 Path/PATH 이름이 섞여 있을 수 있어 하나로 정리) */
function withPath(env, value) {
  if (!value) return env;
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k];
  env[process.platform === 'win32' ? 'Path' : 'PATH'] = value;
  return env;
}

function subscriptionOnlyEnv(extra = {}) {
  const env = withPath({ ...process.env }, freshWindowsPath());
  for (const k of Object.keys(env)) {
    if (PAID_API_ENV.includes(k.toUpperCase())) delete env[k];
  }
  // 색상 코드/대화형 프롬프트 끄기
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  return { ...env, ...extra };
}

class LimitError extends Error {
  constructor(msg) { super(msg); this.name = 'LimitError'; this.kind = 'limit'; }
}
class AuthError extends Error {
  constructor(msg) { super(msg); this.name = 'AuthError'; this.kind = 'auth'; }
}
class NotInstalledError extends Error {
  constructor(msg) { super(msg); this.name = 'NotInstalledError'; this.kind = 'notInstalled'; }
}

const LIMIT_RE = /(usage limit|rate.?limit|quota|too many requests|\b429\b|limit (has been )?reached|reached your .*limit|hit your .*limit|exceeded|try again (later|in)|resets? (at|in)|한도|사용량)/i;
const AUTH_RE = /(not logged in|please log ?in|login required|unauthori[sz]ed|\b401\b|authenticat(e|ion) (required|failed|error)|sign in|no credentials|로그인)/i;

function classifyFailure(text) {
  if (LIMIT_RE.test(text)) return 'limit';
  if (AUTH_RE.test(text)) return 'auth';
  return 'other';
}

/** 사용자 PC 에서 CLI 실행 파일 찾기 */
function resolveBinary(names, customPath) {
  if (customPath) {
    if (fs.existsSync(customPath)) return customPath;
  }
  const isWin = process.platform === 'win32';
  const exts = isWin ? ['.exe', '.cmd', '.bat', ''] : [''];
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const dirs = (freshWindowsPath() || process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  const extra = isWin
    ? [
      ...(process.env.CODEX_INSTALL_DIR ? [process.env.CODEX_INSTALL_DIR] : []),
      path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin'), // Codex 공식 설치 프로그램 (install.ps1)
      path.join(home, '.local', 'bin'),
      path.join(home, 'AppData', 'Roaming', 'npm'),
      path.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links'),
      path.join(home, '.grok', 'bin'),
      path.join(home, '.antigravity', 'bin'),
      path.join(home, 'AppData', 'Local', 'Programs', 'grok'),
      path.join(home, 'AppData', 'Local', 'Programs', 'antigravity'),
      path.join(home, 'AppData', 'Local', 'Programs', 'claude'),
      path.join(home, '.claude', 'local'),
    ]
    : [path.join(home, '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin', path.join(home, '.npm-global', 'bin'), path.join(home, '.grok', 'bin')];
  for (const name of names) {
    for (const d of [...dirs, ...extra]) {
      for (const e of exts) {
        const p = path.join(d, name + e);
        try {
          if (fs.statSync(p).isFile()) return p;
        } catch (_) { /* 없음 */ }
      }
    }
  }
  return null;
}

function quoteForCmd(a) {
  if (a === '') return '""';
  if (!/[\s"&|<>^%()!]/.test(a)) return a;
  return `"${a.replace(/"/g, '""')}"`;
}

/**
 * CLI 실행.
 * @param {object} o
 * @param {string} o.bin
 * @param {string[]} o.args  (사용자 텍스트는 절대 args 에 넣지 않는다. stdin 또는 파일로 전달)
 * @param {string} o.cwd
 * @param {string} [o.stdin]
 * @param {number} [o.timeoutMs]
 * @param {AbortSignal} [o.signal]
 * @param {(line:string)=>void} [o.onLine]
 */
function runCli(o) {
  return new Promise((resolve, reject) => {
    const isCmdShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(o.bin);
    const child = isCmdShim
      ? spawn([quoteForCmd(o.bin), ...o.args.map(quoteForCmd)].join(' '), {
        cwd: o.cwd, env: subscriptionOnlyEnv(o.env), shell: true, windowsHide: true,
      })
      : spawn(o.bin, o.args, { cwd: o.cwd, env: subscriptionOnlyEnv(o.env), windowsHide: true });
    let stdout = '';
    let stderr = '';
    let lineBuf = '';
    let done = false;
    const finish = (fn) => { if (!done) { done = true; clearTimeout(timer); fn(); } };
    const timer = setTimeout(() => {
      killTree(child);
      finish(() => reject(new Error(`시간 초과 (${Math.round((o.timeoutMs || 0) / 1000)}초) - AI 가 응답하지 않습니다.`)));
    }, o.timeoutMs || 10 * 60 * 1000);
    const onAbort = () => {
      killTree(child);
      const e = new Error('사용자가 중지했습니다.');
      e.name = 'AbortError';
      finish(() => reject(e));
    };
    if (o.signal) {
      if (o.signal.aborted) return onAbort();
      o.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      if (o.onLine) {
        lineBuf += s;
        const lines = lineBuf.split(/\r?\n/);
        lineBuf = lines.pop();
        lines.forEach((l) => l.trim() && o.onLine(l));
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 400000) stderr = stderr.slice(-200000);
    });
    child.on('error', (e) => finish(() => reject(new NotInstalledError(`프로그램을 실행할 수 없습니다 (${o.bin}): ${e.message}`))));
    child.on('close', (code) => {
      if (o.signal) o.signal.removeEventListener('abort', onAbort);
      finish(() => resolve({ code, stdout, stderr }));
    });
    if (o.stdin != null) {
      child.stdin.on('error', () => { /* 프로세스가 먼저 끝난 경우 무시 */ });
      child.stdin.end(o.stdin, 'utf8');
    } else {
      child.stdin.end();
    }
  });
}

function killTree(child) {
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* noop */ } }, 3000);
    }
  } catch (_) { /* noop */ }
}

/** 실패한 실행 결과를 알맞은 에러로 바꾼다 */
function failureFrom(result, label) {
  const text = `${result.stderr}\n${result.stdout}`.slice(-4000);
  const kind = classifyFailure(text);
  const short = text.split(/\r?\n/).filter((l) => l.trim()).slice(-6).join('\n');
  if (kind === 'limit') return new LimitError(`${label}: 구독 사용량 한도에 도달한 것 같습니다.\n${short}`);
  if (kind === 'auth') return new AuthError(`${label}: 로그인이 필요합니다. 설정 화면에서 '로그인 하기' 를 눌러 주세요.\n${short}`);
  return new Error(`${label} 실행 실패 (코드 ${result.code}).\n${short}`);
}

module.exports = {
  PAID_API_ENV, subscriptionOnlyEnv, resolveBinary, runCli, killTree, classifyFailure, failureFrom,
  mergePaths, expandWinVars, freshWindowsPath,
  LimitError, AuthError, NotInstalledError,
};
