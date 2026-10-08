// 받은 그림 정리 시험 (Node): 배경 빼기 판단(PC 의 processCel 과 같은 규칙) · 일꾼 약속(줄 세우기·멈추기·대체 길) — 진짜 이미지 디코딩은 Chromium 시험(e2e-engine)이 본다
import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { keyDecision } from '../src/engine-workers/key-core.js';
import { createIngestor } from '../src/engine/ingest.js';
import { fnv1a } from '../src/engine/util.js';

const require = createRequire(import.meta.url);
const Key = require('../../src/main/media/keyer-core.js');

/** 초록 배경 위에 노란 사각형(몸) + 갈색 점(눈) 이 있는 RGBA (알파 없음) */
function greenCel(w = 64, h = 48, bg = [0, 255, 0], body = [244, 196, 48]) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inside = x > 16 && x < 48 && y > 8 && y < 40;
      const c = inside ? (x > 28 && x < 32 && y > 18 && y < 22 ? [90, 50, 30] : body) : bg;
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
    }
  }
  return px;
}

test('배경 빼기 판단: 초록 배경은 투명으로, 몸은 그대로 — PC 의 keyCel 결과와 바이트까지 같다', () => {
  const px = greenCel();
  const d = keyDecision(px, 64, 48, { keyColor: '#00ff00' });
  assert.strictEqual(d.keyed, true);
  assert.strictEqual(d.source, '#00ff00');
  assert.strictEqual(d.rgba[3], 0, '모서리는 투명');
  assert.strictEqual(d.rgba[(24 * 64 + 40) * 4 + 3], 255, '몸은 불투명');
  const direct = Key.keyCel(px, 64, 48, { expect: '#00ff00' });
  assert.ok(direct.ok);
  assert.strictEqual(fnv1a(d.rgba), fnv1a(direct.rgba), 'keyCel 직접 호출과 같다');
  assert.deepStrictEqual(d.stats, Key.colorStats(direct.rgba, 64 * 48));
  assert.strictEqual(fnv1a(keyDecision(px, 64, 48, { keyColor: '#00ff00' }).rgba), fnv1a(d.rgba), '같은 입력 → 같은 결과');
});

test('배경 빼기 판단: 이미 투명하면 그대로 · 단색 배경이 아니면 못 뺀다 · 부탁한 배경색과 다르면 못 뺀다', () => {
  const px = greenCel();
  for (let i = 0; i < 64 * 48; i++) if (px[i * 4 + 1] === 255 && px[i * 4] === 0) px[i * 4 + 3] = 0; // 초록 칸을 투명으로
  const alpha = keyDecision(px, 64, 48, { keyColor: '#00ff00' });
  assert.strictEqual(alpha.keyed, true);
  assert.strictEqual(alpha.source, 'alpha');
  assert.strictEqual(fnv1a(alpha.rgba), fnv1a(px), '투명한 그림은 손대지 않는다');
  // 가장자리가 제각각인 그림 (풍경 사진 같은)
  const noisy = new Uint8ClampedArray(64 * 48 * 4);
  for (let i = 0; i < 64 * 48; i++) { noisy[i * 4] = (i * 37) % 256; noisy[i * 4 + 1] = (i * 91) % 256; noisy[i * 4 + 2] = (i * 17) % 256; noisy[i * 4 + 3] = 255; }
  const bad = keyDecision(noisy, 64, 48, { keyColor: '#00ff00' });
  assert.strictEqual(bad.keyed, false);
  assert.ok(bad.reason, '이유가 있다');
  // 부탁은 초록인데 AI 가 마젠타로 그려 줬다
  const mag = keyDecision(greenCel(64, 48, [255, 0, 255]), 64, 48, { keyColor: '#00ff00' });
  assert.strictEqual(mag.keyed, false);
  assert.strictEqual(keyDecision(greenCel(64, 48, [255, 0, 255]), 64, 48, { keyColor: '#ff00ff' }).keyed, true);
});

test('색 맞추기: 첫 셀의 평균·분산 쪽으로 0.6 만큼 (기준이 없으면 자기 통계만)', () => {
  const ref = keyDecision(greenCel(64, 48, [0, 255, 0], [200, 120, 40]), 64, 48, { keyColor: '#00ff00' }).stats;
  const own = keyDecision(greenCel(), 64, 48, { keyColor: '#00ff00' });
  const matched = keyDecision(greenCel(), 64, 48, { keyColor: '#00ff00', refStats: ref });
  assert.ok(matched.keyed);
  for (let c = 0; c < 3; c++) {
    const lo = Math.min(own.stats.mean[c], ref.mean[c]);
    const hi = Math.max(own.stats.mean[c], ref.mean[c]);
    assert.ok(matched.stats.mean[c] >= lo - 1 && matched.stats.mean[c] <= hi + 1, `채널 ${c} 평균이 둘 사이로`);
  }
  const target = own.stats.mean[2] + 0.6 * (ref.mean[2] - own.stats.mean[2]);
  assert.ok(Math.abs(matched.stats.mean[2] - target) < 2, `0.6 만큼: ${matched.stats.mean[2]} ≈ ${target}`);
  const full = keyDecision(greenCel(), 64, 48, { keyColor: '#00ff00', refStats: ref, strength: 1 });
  assert.ok(Math.abs(full.stats.mean[2] - ref.mean[2]) < 3, '세기 1 이면 거의 기준 색');
  assert.notStrictEqual(fnv1a(matched.rgba), fnv1a(own.rgba));
});

function fakeWorkerFactory() {
  const made = [];
  const create = () => {
    const w = {
      sent: [], terminated: false, onmessage: null, onerror: null, mode: 'ok', delay: 5,
      postMessage(m) {
        this.sent.push(m);
        if (this.mode === 'hang') return;
        setTimeout(() => {
          if (this.terminated || !this.onmessage) return;
          if (this.mode === 'fail') this.onmessage({ data: { id: m.id, ok: false, code: 'badImage', error: '그림 파일을 읽지 못했어요. 다른 파일로 해 보세요.' } });
          else if (this.mode === 'crash') this.onerror({ message: '일꾼이 죽었어요' });
          else if (m.type === 'plate') this.onmessage({ data: { id: m.id, type: m.type, ok: true, plate: new Blob(['p']) } });
          else this.onmessage({ data: { id: m.id, type: m.type, ok: true, w: 8, h: 8, orig: new Blob(['o']), keyed: true, cel: new Blob(['c']), hash: m.type } });
        }, this.delay);
      },
      terminate() { this.terminated = true; },
    };
    made.push(w);
    return w;
  };
  return { made, create };
}

test('일꾼 약속: 한 번에 한 장씩 줄을 세워 보내고 · 멈추면 일꾼을 끝내고 다음엔 새로 만든다 · 오류는 한국어로', async () => {
  const f = fakeWorkerFactory();
  const ing = createIngestor({ createWorker: f.create });
  const order = [];
  const jobs = [1, 2, 3].map((n) => ing.ingest(new Blob([`i${n}`]), { kind: 'cel', keyColor: '#00ff00' }).then((r) => order.push(n) && r));
  await Promise.all(jobs);
  assert.deepStrictEqual(order, [1, 2, 3]);
  assert.strictEqual(f.made.length, 1, '일꾼은 하나를 계속 쓴다');
  assert.strictEqual(f.made[0].sent.length, 3);
  assert.deepStrictEqual(f.made[0].sent.map((m) => m.id), [1, 2, 3]);
  assert.strictEqual(f.made[0].sent[0].type, 'ingest');
  assert.strictEqual(f.made[0].sent[0].kind, 'cel');
  assert.strictEqual(ing.mode, 'worker');
  // 멈춤
  f.made[0].mode = 'hang';
  const ctl = new AbortController();
  const p = ing.ingest(new Blob(['x']), { kind: 'pic', signal: ctl.signal });
  await new Promise((r) => setTimeout(r, 10));
  ctl.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  assert.strictEqual(f.made[0].terminated, true);
  const r = await ing.ingest(new Blob(['y']), { kind: 'pic' });
  assert.strictEqual(f.made.length, 2, '멈춘 뒤에는 새 일꾼');
  assert.strictEqual(r.keyed, true);
  // 이미 멈춘 신호로는 시작도 안 한다
  const dead = new AbortController();
  dead.abort();
  await assert.rejects(ing.ingest(new Blob(['z']), { kind: 'pic', signal: dead.signal }), (e) => e.name === 'AbortError');
  assert.strictEqual(f.made[1].sent.length, 1);
  // 일꾼이 오류를 답하면 한국어 메시지와 코드
  f.made[1].mode = 'fail';
  await assert.rejects(ing.ingest(new Blob(['bad']), { kind: 'cel' }), (e) => e.code === 'badImage' && /읽지 못했어요/.test(e.message));
  // 일꾼이 죽으면 오류 + 다음엔 새로
  f.made[1].mode = 'crash';
  await assert.rejects(ing.ingest(new Blob(['c']), { kind: 'cel' }), /문제가 생겼어요/);
  assert.strictEqual(f.made[1].terminated, true);
  // plate 도 같은 길
  const pl = fakeWorkerFactory();
  const ing2 = createIngestor({ createWorker: pl.create });
  const plate = await ing2.plate(new Blob(['cel']), '#00ff00');
  assert.strictEqual(await plate.text(), 'p');
  assert.deepStrictEqual([pl.made[0].sent[0].type, pl.made[0].sent[0].keyColor], ['plate', '#00ff00']);
  ing.dispose();
});

test('일꾼을 못 만들면(오래된 WebView 등) 같은 코드를 앱 쪽에서 돌린다', async () => {
  const ing = createIngestor({ createWorker: () => { throw new Error('no worker'); } });
  // Node 에는 createImageBitmap 이 없어서 '읽지 못했어요' 로 끝나는 것까지가 이 시험의 범위 (대체 길로 들어갔다는 증거)
  await assert.rejects(ing.ingest(new Blob(['x']), { kind: 'pic' }), (e) => e.code === 'badImage');
  assert.strictEqual(ing.mode, 'inline');
  assert.strictEqual(createIngestor({ inline: true }).mode, 'inline');
});
