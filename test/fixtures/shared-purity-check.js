'use strict';
// shared-purity.test.js 가 쓰는 순수성 검사 도구: 소스를 글자 단위로 읽어(주석·글자·정규식·템플릿 처리) require 와 금지 토큰을 찾는다.
// 의존성 없음. 규칙은 shared-purity.test.js 맨 위에 적혀 있다.
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

// ---------------------------------------------------------------- 소스 읽기 (주석 · 글자 · 정규식 · 템플릿 처리)

const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const isWordChar = (c) => /[\w$]/.test(c) || c > '\u007f';

/**
 * 자바스크립트 소스를 한 글자씩 읽어 두 가지 복사본을 만든다 (둘 다 원본과 길이·줄바꿈이 같다).
 *  - code: 주석만 공백으로 지운 것 (require('…') 안의 글자를 읽는 데 쓴다)
 *  - skel: 주석 + 글자(문자열·템플릿 글 부분·정규식) 내용을 지운 것 (코드 토큰만 남는다. 템플릿 `${…}` 안의 코드는 남는다)
 * 정규식과 나눗셈은 앞 토큰으로 가려낸다 (이 저장소 코드에는 충분한 어림 규칙).
 */
function scan(src) {
  const n = src.length;
  const code = new Array(n);
  const skel = new Array(n);
  const comments = [];
  const errors = [];
  const stack = []; // 템플릿 `${ … }` 안의 { } 깊이
  let mode = 'code';
  let prev = { type: 'start', value: '' };
  let i = 0;
  const blank = (c) => (c === '\n' || c === '\r' ? c : ' ');
  const put = (idx, c, s) => { code[idx] = c; skel[idx] = s === undefined ? c : s; };
  while (i < n) {
    const c = src[i];
    if (mode === 'tpl') {
      if (c === '\\') {
        put(i, c, ' ');
        if (i + 1 < n) put(i + 1, src[i + 1], blank(src[i + 1]));
        i += 2;
      } else if (c === '`') {
        put(i, c);
        mode = 'code';
        prev = { type: 'str', value: '' };
        i++;
      } else if (c === '$' && src[i + 1] === '{') {
        put(i, '$');
        put(i + 1, '{');
        stack.push(0);
        mode = 'code';
        prev = { type: 'punct', value: '{' };
        i += 2;
      } else {
        put(i, c, blank(c));
        i++;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      let e = i;
      while (e < n && src[e] !== '\n') e++;
      comments.push({ idx: i, text: src.slice(i, e), block: false });
      for (let k = i; k < e; k++) put(k, ' ', ' ');
      i = e;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let e = src.indexOf('*/', i + 2);
      if (e < 0) { errors.push('닫히지 않은 /* 주석'); e = n; } else e += 2;
      comments.push({ idx: i, text: src.slice(i, e), block: true });
      for (let k = i; k < e; k++) put(k, blank(src[k]), blank(src[k]));
      i = e;
      continue;
    }
    if (c === '"' || c === "'") {
      put(i, c);
      let k = i + 1;
      for (; k < n; k++) {
        const d = src[k];
        if (d === '\\') { put(k, d, ' '); if (k + 1 < n) put(k + 1, src[k + 1], blank(src[k + 1])); k++; continue; }
        if (d === c) break;
        if (d === '\n') { errors.push(`닫히지 않은 글자 ${c}`); break; }
        put(k, d, ' ');
      }
      if (k < n && src[k] === c) put(k, c);
      i = k + 1;
      prev = { type: 'str', value: '' };
      continue;
    }
    if (c === '`') {
      put(i, c);
      mode = 'tpl';
      i++;
      continue;
    }
    if (c === '/') {
      const regexOk = prev.type === 'start'
        || (prev.type === 'punct' && ![')', ']', '}'].includes(prev.value))
        || (prev.type === 'word' && REGEX_AFTER_WORD.has(prev.value));
      if (regexOk) {
        let k = i + 1;
        let inClass = false;
        let closed = false;
        for (; k < n; k++) {
          const d = src[k];
          if (d === '\n') break;
          if (d === '\\') { k++; continue; }
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) { closed = true; break; }
        }
        if (closed) {
          k++;
          while (k < n && /[a-z]/i.test(src[k])) k++;
          for (let m = i; m < k; m++) put(m, src[m], ' ');
          i = k;
          prev = { type: 'str', value: '' };
          continue;
        }
      }
      put(i, c);
      prev = { type: 'punct', value: '/' };
      i++;
      continue;
    }
    if (isWordChar(c) && !/[0-9]/.test(c)) {
      let k = i;
      while (k < n && isWordChar(src[k])) k++;
      for (let m = i; m < k; m++) put(m, src[m]);
      prev = { type: 'word', value: src.slice(i, k) };
      i = k;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let k = i;
      while (k < n && (isWordChar(src[k]) || src[k] === '.')) k++;
      for (let m = i; m < k; m++) put(m, src[m]);
      prev = { type: 'num', value: '' };
      i = k;
      continue;
    }
    if (c === '{' && stack.length) stack[stack.length - 1]++;
    if (c === '}' && stack.length) {
      if (stack[stack.length - 1] === 0) {
        stack.pop();
        put(i, c);
        mode = 'tpl';
        i++;
        continue;
      }
      stack[stack.length - 1]--;
    }
    put(i, c);
    if (!/\s/.test(c)) {
      // i++ / i-- 뒤의 / 는 나눗셈이다
      prev = (c === '+' || c === '-') && src[i - 1] === c ? { type: 'num', value: '' } : { type: 'punct', value: c };
    }
    i++;
  }
  if (mode === 'tpl') errors.push('닫히지 않은 템플릿 글자');
  return { code: code.join(''), skel: skel.join(''), comments, errors };
}

/** 소스 안의 위치 → 줄 번호 (1부터) */
function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return (idx) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= idx) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

// ---------------------------------------------------------------- 검사

const BUILTINS = new Set([...builtinModules, 'electron']);
const isBuiltin = (spec) => {
  const s = spec.replace(/^node:/, '');
  return BUILTINS.has(s) || BUILTINS.has(s.split('/')[0]);
};
const TOKEN_RULES = [
  { token: 'Buffer', re: /(?<![\w$.])Buffer(?![\w$])/g },
  { token: '__dirname', re: /(?<![\w$.])__dirname(?![\w$])/g },
  { token: '__filename', re: /(?<![\w$.])__filename(?![\w$])/g },
  { token: 'process.', re: /(?<![\w$.])process\s*[.[]/g },
  { token: 'global.process / global.Buffer', re: /(?<![\w$.])(?:global|globalThis)\s*\.\s*(?:process|Buffer)(?![\w$])/g },
];
// 공용 모듈은 CommonJS/UMD 이다. import / export 문은 이 도구가 따라가지 못하므로 거절한다 (import 'fs' 가 몰래 들어오지 못하게)
const ESM_RULES = [
  /^[ \t]*import\s*(?:[\w$*{"']|\()/gm,
  /(?<![\w$.])import\s*\(/g,
  /^[ \t]*export\s+(?:default\b|const\b|let\b|var\b|function\b|class\b|async\b|\{|\*)/gm,
];

/** 모듈 한 개를 읽어 위반 목록 [{file, line, rule, detail}] 과 상대 경로로 불러오는 파일들을 돌려준다 */
function checkSource(file, src, resolveRel) {
  const out = [];
  const { code, skel, comments, errors } = scan(src);
  const lineOf = lineIndex(src);
  for (const e of errors) out.push({ file, line: 1, rule: 'scan', detail: `소스를 끝까지 읽지 못했어요: ${e}` });
  const okLines = new Set(comments.filter((c) => !c.block && /^\/\/\s*shared-ok:\s*\S/.test(c.text)).map((c) => lineOf(c.idx)));
  // (b) 금지 토큰
  for (const { token, re } of TOKEN_RULES) {
    re.lastIndex = 0;
    for (let m = re.exec(skel); m; m = re.exec(skel)) {
      const line = lineOf(m.index);
      if (okLines.has(line)) continue;
      out.push({ file, line, rule: 'token', detail: `${token} 를 쓰면 안 돼요 (정말 필요하면 줄 끝에 // shared-ok: 이유)` });
    }
  }
  for (const re of ESM_RULES) {
    re.lastIndex = 0;
    for (let m = re.exec(skel); m; m = re.exec(skel)) {
      out.push({ file, line: lineOf(m.index + m[0].search(/\S/)), rule: 'esm', detail: 'import / export 문은 쓸 수 없어요 (공용 모듈은 CommonJS/UMD: require / module.exports)' });
    }
  }
  // (a) (c) require
  const req = /(?<![\w$.])require\s*\(/g;
  const rels = [];
  for (let m = req.exec(skel); m; m = req.exec(skel)) {
    const line = lineOf(m.index);
    const rest = code.slice(m.index + m[0].length);
    const a = /^\s*(['"])([^'"\\\n]*)\1\s*\)/.exec(rest);
    if (!a) { out.push({ file, line, rule: 'dynamic-require', detail: 'require 의 인자가 글자 하나가 아니에요 (따라가서 검사할 수 없어요)' }); continue; }
    const spec = a[2];
    if (!spec.startsWith('.')) {
      out.push({ file, line, rule: 'builtin-require', detail: `${isBuiltin(spec) ? 'Node 내장 모듈' : '외부 패키지'} ${spec} 를 불러오면 안 돼요` });
      continue;
    }
    rels.push({ spec, line });
  }
  return { violations: out, rels, resolveRel };
}

/**
 * 목록 전체 검사. list 의 file 은 root 기준 상대 경로.
 * @returns {{file:string,line:number,rule:string,detail:string}[]}
 */
function checkSharedModules(root, list) {
  const out = [];
  const norm = (p) => path.relative(root, p).split(path.sep).join('/');
  const inList = new Set(list.map((m) => m.file));
  const resolveRel = (fromFile, spec) => {
    const base = path.resolve(path.dirname(path.join(root, fromFile)), spec);
    for (const cand of [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')]) {
      try { if (fs.statSync(cand).isFile()) return norm(cand); } catch (_) { /* 다음 후보 */ }
    }
    return null;
  };
  for (const { file } of list) {
    let src;
    try { src = fs.readFileSync(path.join(root, file), 'utf8'); } catch (_) { out.push({ file, line: 0, rule: 'missing', detail: '목록에 있는 파일이 없어요' }); continue; }
    const { violations, rels } = checkSource(file, src, resolveRel);
    out.push(...violations);
    for (const { spec, line } of rels) {
      const target = resolveRel(file, spec);
      if (!target) out.push({ file, line, rule: 'unresolved', detail: `${spec} 를 찾을 수 없어요` });
      else if (!inList.has(target)) out.push({ file, line, rule: 'not-in-list', detail: `${spec} → ${target} 가 shared-modules 목록에 없어요 (목록에 넣으려면 먼저 순수하게 만든다)` });
    }
  }
  return out;
}

module.exports = { scan, lineIndex, checkSource, checkSharedModules, isBuiltin };
