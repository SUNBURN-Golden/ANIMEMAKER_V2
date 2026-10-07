'use strict';
// 구독 CLI 찾기: 공식 설치 위치, 켜 둔 채 새로 설치한 프로그램(최신 PATH) 찾기
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mergePaths, expandWinVars, freshWindowsPath, resolveBinary, subscriptionOnlyEnv } = require('../src/main/ai/cli');
const { AGENTS } = require('../src/main/ai/agents');

const isWin = process.platform === 'win32';

test('PATH 합치기: 순서 유지, 겹치는 폴더는 한 번만 (윈도우는 대소문자·끝 슬래시 무시)', () => {
  assert.strictEqual(mergePaths(['C:\\A;C:\\B', 'c:\\a\\;C:\\C', ';;C:\\B'], ';', true), 'C:\\A;C:\\B;C:\\C');
  assert.strictEqual(mergePaths(['/a:/b', '/b:/c'], ':', false), '/a:/b:/c');
  assert.strictEqual(mergePaths(['"C:\\Program Files\\X";C:\\Y'], ';', true), 'C:\\Program Files\\X;C:\\Y');
});

test('%변수% 풀기 (대소문자 무시, 모르는 변수는 그대로)', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\kim\\AppData\\Local', SystemRoot: 'C:\\Windows' };
  assert.strictEqual(expandWinVars('%LocalAppData%\\Programs;%SYSTEMROOT%\\system32;%NOPE%\\x', env),
    'C:\\Users\\kim\\AppData\\Local\\Programs;C:\\Windows\\system32;%NOPE%\\x');
});

test('Codex 는 공식 설치 프로그램으로 설치한다 (Node.js 필요 없음)', () => {
  assert.match(AGENTS.codex.install.win, /chatgpt\.com\/codex\/install\.ps1/);
  assert.match(AGENTS.codex.install.other, /chatgpt\.com\/codex\/install\.sh/);
  assert.ok(!AGENTS.codex.install.note, 'Node.js 안내는 더 이상 필요 없음');
});

test('윈도우: 레지스트리의 최신 PATH 를 읽고, 실행 환경에는 PATH 가 하나만 들어간다', { skip: isWin ? false : '윈도우 전용' }, () => {
  const p = freshWindowsPath(process.env, { force: true });
  assert.ok(p && /system32/i.test(p), p);
  const env = subscriptionOnlyEnv();
  const keys = Object.keys(env).filter((k) => k.toUpperCase() === 'PATH');
  assert.deepStrictEqual(keys, ['Path']);
  assert.ok(!('OPENAI_API_KEY' in env));
});

test('윈도우: Codex 공식 설치 위치(%LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin)에서 찾는다', { skip: isWin ? false : '윈도우 전용' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-codex-'));
  const bin = path.join(tmp, 'Programs', 'OpenAI', 'Codex', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'am-test-codex.exe'), 'x');
  const old = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = tmp;
  try {
    assert.strictEqual(resolveBinary(['am-test-codex']), path.join(bin, 'am-test-codex.exe'));
  } finally {
    process.env.LOCALAPPDATA = old;
  }
});

test('리눅스·맥: 공식 설치 위치(~/.local/bin)에서 찾는다', { skip: isWin ? '윈도우가 아님' : false }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-home-'));
  fs.mkdirSync(path.join(tmp, '.local', 'bin'), { recursive: true });
  const exe = path.join(tmp, '.local', 'bin', 'am-test-codex');
  fs.writeFileSync(exe, '#!/bin/sh\n', { mode: 0o755 });
  const old = process.env.HOME;
  process.env.HOME = tmp;
  try {
    assert.strictEqual(resolveBinary(['am-test-codex']), exe);
  } finally {
    process.env.HOME = old;
  }
});
