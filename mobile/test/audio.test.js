// 노래 읽기·분석 연결(audio.js · analyze.worker.js): 공용 박자 분석 코드와 같은 값을 쓰고, 일꾼이 같은 결과를 돌려주는지
import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { ANALYSIS_SR } from '../src/audio.js';

const require = createRequire(import.meta.url);
const A = require('../../src/main/media/audio-analysis.js');

/** 120 BPM 킥이 있는 가짜 노래 */
function clickTrack(seconds = 40) {
  const n = A.SR * seconds;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k = (i / A.SR) % 0.5;
    s[i] = 0.8 * Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-30 * k)) * k) * Math.exp(-9 * k);
  }
  return s;
}

test('분석용 표본 속도는 공용 audio-analysis.js 의 SR 과 같다', () => {
  assert.strictEqual(ANALYSIS_SR, A.SR);
});

test('analyze.worker.js: 메시지를 받으면 공용 코드로 분석해 { analysis } 를 돌려준다 (오류는 { error })', async () => {
  const sent = [];
  globalThis.self = { postMessage: (m) => sent.push(m) };
  await import('../src/analyze.worker.js');
  assert.strictEqual(typeof globalThis.self.onmessage, 'function');
  globalThis.self.onmessage({ data: { samples: clickTrack(), priorBpm: 120 } });
  assert.strictEqual(sent.length, 1);
  const a = sent[0].analysis;
  assert.ok(Math.abs(a.bpm - 120) < 1.5, `bpm ${a.bpm}`);
  assert.strictEqual(a.duration, 40);
  assert.ok(a.beats.length >= 78);
  assert.deepStrictEqual(a, A.analyzeSamples(clickTrack(), 120), 'PC 앱과 같은 계산 결과');
  globalThis.self.onmessage({ data: { samples: null } });
  assert.match(sent[1].error, /노래 분석 실패/);
  delete globalThis.self;
});

test('key.worker.js: C2 가 채울 자리표 — 지금은 "아직 안 만들어졌어요" 로 답한다', async () => {
  const sent = [];
  globalThis.self = { postMessage: (m) => sent.push(m) };
  await import('../src/key.worker.js');
  globalThis.self.onmessage({ data: { id: 7, type: 'key' } });
  assert.deepStrictEqual(sent[0], { id: 7, type: 'key', ok: false, error: '배경 빼기 일꾼이 아직 만들어지지 않았어요' });
  delete globalThis.self;
});
