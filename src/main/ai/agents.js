'use strict';
// 구독형 AI 연결 (공식 CLI 만 사용).
//  - ChatGPT 구독  → Codex CLI (codex)      : 글쓰기 + 그림($imagegen, gpt-image, 기준 그림은 --image 로 첨부)
//  - SuperGrok     → Grok Build CLI (grok)  : 글쓰기 + 그림(image_gen, 기준 그림은 작업 폴더에 복사)
//  - Google AI Pro → Antigravity CLI (agy)  : 글쓰기 (+ 그림: 실험적)
//  - Claude Pro/Max→ Claude Code (claude)   : 글쓰기
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveBinary, runCli, failureFrom, classifyFailure, LimitError, NotInstalledError } = require('./cli');
const { extractJson, collectJsonLinesText } = require('./json');

const FILE_INSTRUCTION = 'Read the file PROMPT.md in the current working directory and follow its instructions exactly. Do not ask questions.';

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp'];

const AGENTS = {
  codex: {
    id: 'codex',
    name: 'ChatGPT (Codex CLI)',
    subscription: 'ChatGPT Plus / Pro / Business',
    bins: ['codex'],
    caps: { text: true, image: true },
    install: { win: 'npm install -g @openai/codex', other: 'npm install -g @openai/codex', note: 'Node.js(https://nodejs.org) 가 먼저 설치되어 있어야 합니다.' },
    login: 'codex login',
    loginNote: '창이 뜨면 "Sign in with ChatGPT" 를 선택하세요. (API key 로그인은 종량제 과금이라 쓰지 마세요)',
    textArgs: (c) => ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never',
      '-C', c.dir, '-o', c.outFile, ...(c.model ? ['-m', c.model] : []), ...c.extra, '-'],
    imageArgs: (c) => ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '--color', 'never',
      '-C', c.dir, ...(c.model ? ['-m', c.model] : []), ...c.extra, '-', ...c.refs.flatMap((r) => ['--image', r])],
    promptVia: 'stdin',
    mediaDirs: () => [path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'generated_images')],
  },
  grok: {
    id: 'grok',
    name: 'Grok (SuperGrok, grok CLI)',
    subscription: 'SuperGrok / X Premium+',
    bins: ['grok'],
    caps: { text: true, image: true },
    install: { win: 'irm https://x.ai/cli/install.ps1 | iex', other: 'curl -fsSL https://x.ai/cli/install.sh | bash' },
    login: 'grok',
    loginNote: '처음 실행하면 브라우저가 열립니다. SuperGrok 계정으로 로그인한 뒤 창을 닫으세요.',
    textArgs: (c) => ['-p', FILE_INSTRUCTION, '--always-approve', '--output-format', 'json', ...(c.model ? ['-m', c.model] : []), ...c.extra],
    imageArgs: (c) => ['-p', FILE_INSTRUCTION, '--always-approve', '--output-format', 'json', ...c.extra],
    promptVia: 'file',
    mediaDirs: () => [path.join(os.homedir(), '.grok', 'sessions')],
  },
  agy: {
    id: 'agy',
    name: 'Gemini (Google AI Pro/Ultra, Antigravity CLI)',
    subscription: 'Google AI Pro / Ultra',
    bins: ['agy', 'antigravity'],
    caps: { text: true, image: 'experimental' },
    install: { win: 'irm https://antigravity.google/cli/install.ps1 | iex', other: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' },
    login: 'agy',
    loginNote: '처음 실행하면 Google 로그인이 뜹니다. 구독 중인 Google 계정으로 로그인한 뒤 창을 닫으세요. (Gemini CLI 개인 로그인은 2026년 6월 종료되어 Antigravity CLI 를 씁니다)',
    textArgs: (c) => ['-p', FILE_INSTRUCTION, '--output-format', 'json', '--dangerously-skip-permissions', ...(c.model ? ['--model', c.model] : []), ...c.extra],
    imageArgs: (c) => ['-p', FILE_INSTRUCTION, '--output-format', 'json', '--dangerously-skip-permissions', ...c.extra],
    promptVia: 'file',
    mediaDirs: () => [],
  },
  claude: {
    id: 'claude',
    name: 'Claude (Pro/Max, Claude Code)',
    subscription: 'Claude Pro / Max',
    bins: ['claude'],
    caps: { text: true, image: false },
    install: { win: 'irm https://claude.ai/install.ps1 | iex', other: 'curl -fsSL https://claude.ai/install.sh | bash' },
    login: 'claude',
    loginNote: '처음 실행하면 로그인 방법을 묻습니다. "Claude 구독 계정" 으로 로그인하세요.',
    textArgs: (c) => ['-p', '--output-format', 'json', ...(c.model ? ['--model', c.model] : []), ...c.extra],
    promptVia: 'stdin',
    mediaDirs: () => [],
  },
};

function agentSettings(settings, id) {
  return (settings && settings.agents && settings.agents[id]) || {};
}

function splitArgs(s) {
  if (!s) return [];
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

function findBin(id, settings) {
  const a = AGENTS[id];
  if (!a) throw new Error(`알 수 없는 AI: ${id}`);
  const bin = resolveBinary(a.bins, agentSettings(settings, id).path);
  if (!bin) {
    throw new NotInstalledError(`${a.name} 프로그램을 찾지 못했습니다. 설정 > AI 연결에서 '설치하기' 를 누르거나 실행 파일 위치를 지정해 주세요.`);
  }
  return bin;
}

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); return d; }

/** 디렉터리 안 미디어 파일 스냅샷 (최대 깊이 4) */
function snapshotMedia(dirs, exts, depth = 4) {
  const map = new Map();
  const walk = (d, lv) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (lv < depth) walk(p, lv + 1); continue; }
      if (!exts.includes(path.extname(e.name).toLowerCase())) continue;
      try { const st = fs.statSync(p); map.set(p, `${st.size}:${st.mtimeMs}`); } catch (_) { /* noop */ }
    }
  };
  dirs.forEach((d) => walk(d, 0));
  return map;
}

function newMedia(before, after, minBytes = 2000) {
  const out = [];
  for (const [p, sig] of after) {
    if (before.get(p) === sig) continue;
    const size = Number(sig.split(':')[0]);
    if (size < minBytes) continue;
    out.push({ p, mtime: Number(sig.split(':')[1]) });
  }
  return out.sort((a, b) => b.mtime - a.mtime).map((x) => x.p);
}

/** 출력 텍스트에 나온 절대경로 중 새로 생긴 미디어 파일 */
function pathsInText(text, exts, sinceMs) {
  const re = /([A-Za-z]:[\\/][^\s"'<>|*?]+|\/[^\s"'<>|*?]+)/g;
  const found = [];
  let m;
  while ((m = re.exec(text))) {
    const p = m[1].replace(/[),.;:]+$/, '');
    if (!exts.includes(path.extname(p).toLowerCase())) continue;
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.mtimeMs >= sinceMs - 2000 && st.size > 2000) found.push(p);
    } catch (_) { /* 없음 */ }
  }
  return found;
}

function aspectToSize(aspect) {
  switch (aspect) {
    case '16:9': return '1536x1024';
    case '1:1': return '1024x1024';
    case '4:5': return '1024x1280';
    default: return '1024x1536';
  }
}

function aspectWords(aspect) {
  switch (aspect) {
    case '16:9': return 'landscape 16:9';
    case '1:1': return 'square 1:1';
    case '4:5': return 'portrait 4:5';
    default: return 'vertical portrait 9:16';
  }
}

async function exec(id, kind, ctx) {
  const a = AGENTS[id];
  const s = agentSettings(ctx.settings, id);
  const bin = findBin(id, ctx.settings);
  const builder = a[`${kind}Args`];
  if (!builder) throw new Error(`${a.name} 는 이 작업(${kind})을 지원하지 않습니다.`);
  const extra = splitArgs(s.extraArgs);
  const args = builder({ dir: ctx.dir, outFile: ctx.outFile, model: kind === 'text' ? s.model : '', refs: ctx.refs || [], extra });
  let stdin = null;
  if (a.promptVia === 'stdin') stdin = ctx.prompt;
  else fs.writeFileSync(path.join(ctx.dir, 'PROMPT.md'), ctx.prompt, 'utf8');
  ctx.onLog && ctx.onLog(`▶ ${a.name} 실행 (${kind})`);
  const result = await runCli({
    bin, args, cwd: ctx.dir, stdin, signal: ctx.signal, timeoutMs: ctx.timeoutMs,
    onLine: ctx.onLog ? (l) => ctx.onLog(`  ${l.slice(0, 300)}`) : undefined,
  });
  fs.writeFileSync(path.join(ctx.dir, `${kind}-stdout.log`), result.stdout);
  fs.writeFileSync(path.join(ctx.dir, `${kind}-stderr.log`), result.stderr);
  return result;
}

const COMMON_RULES = [
  'You are running non-interactively inside the AnimeMaker V2 app. Never ask questions; make reasonable creative decisions yourself.',
  'Do not use any paid API key, SDK script or external web service. Use only your own built-in capabilities.',
];

/**
 * 글쓰기 작업 → JSON 객체
 * @param {(o:any)=>boolean} accept 결과 모양 검사
 */
async function agentText(id, { prompt, dir, settings, signal, onLog, accept, timeoutMs }) {
  ensureDir(dir);
  const outFile = path.join(dir, 'last-message.txt');
  const resultFile = path.join(dir, 'result.json');
  try { fs.unlinkSync(resultFile); } catch (_) { /* noop */ }
  const full = [
    ...COMMON_RULES,
    AGENTS[id].promptVia === 'file'
      ? 'When finished, write ONLY the final JSON object to a file named result.json in the current working directory, and also print the same JSON as your final answer.'
      : 'Your final answer must be ONLY the JSON object (no markdown, no explanation).',
    '',
    prompt,
  ].join('\n');
  const r = await exec(id, 'text', { prompt: full, dir, outFile, settings, signal, onLog, timeoutMs: timeoutMs || 15 * 60 * 1000 });
  const sources = [];
  if (fs.existsSync(resultFile)) sources.push(fs.readFileSync(resultFile, 'utf8'));
  if (fs.existsSync(outFile)) sources.push(fs.readFileSync(outFile, 'utf8'));
  sources.push(r.stdout, collectJsonLinesText(r.stdout));
  for (const src of sources) {
    const obj = extractJson(src, accept);
    if (obj) return obj;
  }
  if (r.code !== 0) throw failureFrom(r, AGENTS[id].name);
  const kind = classifyFailure(`${r.stdout}\n${r.stderr}`.slice(-3000));
  if (kind === 'limit') throw new LimitError(`${AGENTS[id].name}: 구독 사용량 한도에 도달한 것 같습니다.`);
  throw new Error(`${AGENTS[id].name} 의 답변에서 결과(JSON)를 찾지 못했습니다. 작업 폴더의 로그를 확인하세요: ${dir}`);
}

function pickMedia(dir, before, beforeExt, extDirs, exts, r, since) {
  const local = newMedia(before, snapshotMedia([dir], exts, 1));
  const preferred = local.find((p) => /output\./i.test(path.basename(p))) || local[0];
  if (preferred) return preferred;
  const fromText = pathsInText(`${r.stdout}\n${r.stderr}`, exts, since);
  if (fromText.length) return fromText[0];
  const ext = newMedia(beforeExt, snapshotMedia(extDirs, exts));
  return ext[0] || null;
}

/**
 * 기준 그림 설명 줄: 몇 번째 그림이 무엇인지 알려 준다 (캐릭터 시트 = 똑같이, 앞 그림 = 배경·구도 이어서).
 * @param {string[]} names 작업 폴더 안 파일 이름 (codex 는 --image 첨부 순서와 같다)
 * @param {string[]} notes 그림마다 설명
 */
function refLines(names, notes, attached) {
  if (!names.length) return [];
  const where = attached ? 'Attached reference images, in order' : `Reference image files in the current working directory (use them as image references / image edit inputs)`;
  return [
    `${where}:`,
    ...names.map((n, i) => `${i + 1}) ${n}${notes[i] ? ` — ${notes[i]}` : ''}`),
    'Treat character model sheets as a strict design reference: copy the character design exactly. Do not copy their white background or their layout.',
  ];
}

/** 이미지 1장 생성 → dir 안의 파일 경로 */
async function agentImage(id, { prompt, aspect, refs = [], refNotes = [], dir, settings, signal, onLog, timeoutMs }) {
  const a = AGENTS[id];
  if (!a.caps.image) throw new Error(`${a.name} 는 이미지를 만들 수 없습니다.`);
  ensureDir(dir);
  const notes = [];
  const localRefs = [];
  refs.forEach((r, i) => {
    if (!r || !fs.existsSync(r)) return;
    const dst = path.join(dir, `ref${localRefs.length + 1}${path.extname(r) || '.png'}`);
    fs.copyFileSync(r, dst);
    localRefs.push(dst);
    notes.push(refNotes[i] || '');
  });
  const refNames = localRefs.map((r) => path.basename(r));
  let text;
  if (id === 'codex') {
    text = [
      '$imagegen',
      ...COMMON_RULES,
      'Generate exactly ONE image with your built-in image generation tool (image_gen). Do not write code or call scripts.',
      `Size: ${aspectToSize(aspect)} (${aspectWords(aspect)}).`,
      ...refLines(refNames, notes, true),
      'Image prompt:',
      prompt,
      '',
      'After the image is generated, copy the generated image file into the current working directory with the file name output.png (use a shell copy command). Then reply DONE.',
    ].filter(Boolean).join('\n');
  } else {
    text = [
      ...COMMON_RULES,
      'Use your built-in image generation tool (image_gen) to generate exactly ONE image.',
      `aspect_ratio: ${aspect || '16:9'}`,
      ...refLines(refNames, notes, false),
      'Image prompt:',
      prompt,
      '',
      'Save the generated image into the current working directory as output.png (keep the original extension if it is not PNG, e.g. output.jpg). Then list the directory to confirm the file exists. Do nothing else.',
    ].filter(Boolean).join('\n');
  }
  const exts = IMAGE_EXT;
  const extDirs = a.mediaDirs();
  const before = snapshotMedia([dir], exts, 1);
  const beforeExt = snapshotMedia(extDirs, exts);
  const since = Date.now();
  const r = await exec(id, 'image', { prompt: text, dir, refs: localRefs, settings, signal, onLog, timeoutMs: timeoutMs || 8 * 60 * 1000 });
  const picked = pickMedia(dir, new Map([...before, ...localRefs.map((p) => [p, sigOf(p)])]), beforeExt, extDirs, exts, r, since);
  if (picked && !localRefs.includes(picked)) return picked;
  if (r.code !== 0) throw failureFrom(r, a.name);
  const kind = classifyFailure(`${r.stdout}\n${r.stderr}`.slice(-3000));
  if (kind === 'limit') throw new LimitError(`${a.name}: 이미지 생성 한도에 도달한 것 같습니다.`);
  throw new Error(`${a.name} 가 이미지를 저장하지 않았습니다. 작업 폴더 로그를 확인하세요: ${dir}`);
}

function sigOf(p) {
  try { const st = fs.statSync(p); return `${st.size}:${st.mtimeMs}`; } catch (_) { return ''; }
}

/** 설치/로그인 상태 확인 (구독 로그인인지, API 키 로그인인지) */
async function agentStatus(id, settings) {
  const a = AGENTS[id];
  const bin = resolveBinary(a.bins, agentSettings(settings, id).path);
  if (!bin) return { id, installed: false, message: '설치되어 있지 않습니다.' };
  const status = { id, installed: true, path: bin, loggedIn: null, mode: 'unknown', message: '' };
  try {
    const v = await runCli({ bin, args: ['--version'], cwd: os.tmpdir(), timeoutMs: 20000 });
    status.version = `${v.stdout}${v.stderr}`.trim().split(/\r?\n/)[0] || '';
  } catch (_) { /* noop */ }
  if (id === 'codex') {
    try {
      const r = await runCli({ bin, args: ['login', 'status'], cwd: os.tmpdir(), timeoutMs: 20000 });
      const t = `${r.stdout}\n${r.stderr}`;
      if (/chatgpt/i.test(t) && !/not logged/i.test(t)) { status.loggedIn = true; status.mode = 'subscription'; status.message = 'ChatGPT 구독으로 로그인되어 있습니다.'; }
      else if (/api key/i.test(t)) { status.loggedIn = true; status.mode = 'apikey'; status.message = 'API 키(종량제)로 로그인되어 있습니다. 구독 전용으로 쓰려면 codex logout 후 ChatGPT 로 다시 로그인하세요.'; }
      else if (/not logged/i.test(t)) { status.loggedIn = false; status.message = '로그인이 필요합니다.'; }
    } catch (_) { /* noop */ }
  } else {
    status.message = '설치됨. "연결 테스트" 로 로그인 상태를 확인하세요.';
  }
  return status;
}

/** 아주 짧은 질문으로 실제 연결 확인 */
async function agentTest(id, settings, dir) {
  const obj = await agentText(id, {
    prompt: 'Return exactly this JSON object: {"ok": true, "hello": "안녕하세요"}',
    dir, settings, accept: (o) => o && o.ok === true, timeoutMs: 4 * 60 * 1000,
  });
  return !!obj;
}

module.exports = {
  AGENTS, agentText, agentImage, agentStatus, agentTest, findBin,
  snapshotMedia, newMedia, pathsInText, aspectToSize, IMAGE_EXT,
};
