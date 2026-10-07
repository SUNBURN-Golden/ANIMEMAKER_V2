'use strict';
// 셀 배경 빼기 · 색 맞추기 테스트 (순수 계산 + PNG 읽고 쓰기)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const K = require('../src/main/media/keyer');

/**
 * 가짜 셀: AI 가 그린 듯한 살짝 다른 초록 배경 + 빨간 몸통(가장자리 반쯤 섞임) + 몸통 안에 갇힌 초록 점
 * 몸통은 x 40.5~80.5, y 20.5~70.5 (가장자리 픽셀은 50% 섞임)
 */
function fakeCel(w = 120, h = 90, bgc = [12, 236, 24]) {
  const px = new Uint8ClampedArray(w * h * 4);
  const red = [210, 30, 40];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cx = Math.max(0, Math.min(1, Math.min(x + 1 - 40.5, 80.5 - x)));
      const cy = Math.max(0, Math.min(1, Math.min(y + 1 - 20.5, 70.5 - y)));
      const a = cx * cy;
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) px[i + c] = Math.round(red[c] * a + bgc[c] * (1 - a) + ((x * 7 + y * 3 + c) % 5) - 2);
      px[i + 3] = 255;
    }
  }
  // 갇힌 초록 점 (5×5, 눈동자 같은 것)
  for (let y = 43; y < 48; y++) for (let x = 58; x < 63; x++) { const i = (y * w + x) * 4; px[i] = 0; px[i + 1] = 255; px[i + 2] = 0; }
  return { px, w, h };
}
const at = (r, w, x, y) => { const i = (y * w + x) * 4; return [r[i], r[i + 1], r[i + 2], r[i + 3]]; };

test('keyer: border-median key, flood fill keeps the enclosed green dot, soft edges un-mixed', () => {
  const { px, w, h } = fakeCel();
  const k = K.keyCel(px, w, h, { expect: K.KEY_GREEN });
  assert.ok(k.ok, k.reason);
  assert.ok(Math.abs(k.key[1] - 236) <= 3 && k.key[0] < 20, `key from the border, not the requested colour: ${k.key}`);
  assert.strictEqual(at(k.rgba, w, 5, 5)[3], 0, 'background removed');
  assert.strictEqual(at(k.rgba, w, 110, 80)[3], 0, 'background removed (far corner)');
  const body = at(k.rgba, w, 50, 30);
  assert.strictEqual(body[3], 255, 'body opaque');
  assert.ok(body[0] > 190 && body[1] < 60, `body red ${body}`);
  const dot = at(k.rgba, w, 60, 45);
  assert.strictEqual(dot[3], 255, 'enclosed green kept');
  assert.ok(dot[1] > 200 && dot[0] < 30, `dot stays green ${dot}`);
  // 가장자리(50% 섞인 픽셀) → 반투명, 색은 빨강으로 되돌림
  const edge = at(k.rgba, w, 40, 45);
  assert.ok(edge[3] > 20 && edge[3] < 235, `soft edge alpha ${edge[3]}`);
  assert.ok(edge[0] > 150 && edge[1] < 110, `edge un-mixed toward red ${edge}`);
  assert.ok(k.bgFraction > 0.5);
});

test('keyer: magenta for green palettes, unkeyable pictures stay full-frame', () => {
  assert.strictEqual(K.keyColorFor([{ hex: '#d7263d' }, { hex: '#7a4a2a' }]), K.KEY_GREEN);
  assert.strictEqual(K.keyColorFor([{ hex: '#d7263d' }, { hex: '#2e8b57' }]), K.KEY_MAGENTA, 'sea green in the palette → magenta');
  assert.strictEqual(K.keyColorFor([{ hex: '#1f3d2a' }]), K.KEY_MAGENTA, 'dark green too');
  assert.strictEqual(K.keyColorFor([{ hex: '#888888' }, { hex: 'oops' }]), K.KEY_GREEN);
  // 마젠타 배경 + 초록 옷 → 초록은 그대로
  const w = 60;
  const h = 40;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const x = i % w;
    const y = Math.floor(i / w);
    const inBody = x >= 20 && x < 40 && y >= 10 && y < 30;
    px.set(inBody ? [40, 180, 60, 255] : [250, 5, 248, 255], i * 4);
  }
  const m = K.keyCel(px, w, h, { expect: K.KEY_MAGENTA });
  assert.ok(m.ok);
  assert.strictEqual(at(m.rgba, w, 2, 2)[3], 0);
  assert.deepStrictEqual(at(m.rgba, w, 30, 20), [40, 180, 60, 255]);
  // 가장자리가 제각각(전체 그림) → 빼지 않음
  const noisy = new Uint8ClampedArray(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 7919) % 251));
  assert.strictEqual(K.keyCel(noisy, w, h).ok, false);
  // 하늘처럼 단색이지만 부탁한 초록이 아님 → 빼지 않음
  const sky = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) sky.set(i % w > 20 && i % w < 40 && i > w * 10 ? [200, 60, 40, 255] : [120, 180, 230, 255], i * 4);
  const r = K.keyCel(sky, w, h, { expect: K.KEY_GREEN });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'notkey');
});

test('keyer: in-between smears connected to the background become see-through (spill)', () => {
  const w = 40;
  const h = 30;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const x = i % w;
    const y = Math.floor(i / w);
    let c = [0, 255, 0];
    if (x >= 10 && x < 20 && y >= 5 && y < 25) c = [240, 200, 40]; // 몸
    else if (x >= 20 && x < 31 && y >= 7 && y < 16) c = [120, 228, 20]; // 팔이 지나간 얼룩 (노랑+초록 반쯤)
    px.set([...c, 255], i * 4);
  }
  const plain = K.keyCel(px, w, h, { keyColor: K.KEY_GREEN });
  const spill = K.keyCel(px, w, h, { keyColor: K.KEY_GREEN, spill: true });
  assert.ok(at(plain.rgba, w, 25, 11)[3] === 255, 'without spill the smear far from the edge stays solid');
  const a = at(spill.rgba, w, 25, 11)[3];
  assert.ok(a > 60 && a < 200, `smear half transparent ${a}`);
  assert.strictEqual(at(spill.rgba, w, 15, 15)[3], 255, 'body solid');
  // 사이 그림: 섞인 색에 입구가 막힌 다리 사이 틈(정확한 배경색)도 지운다. 보통 셀에서는 갇힌 초록을 남긴다.
  for (let y = 18; y < 25; y++) for (let x = 13; x < 16; x++) px.set([0, 255, 0, 255], (y * w + x) * 4);
  for (let x = 13; x < 16; x++) px.set([150, 140, 60, 255], (24 * w + x) * 4);
  assert.strictEqual(at(K.keyCel(px, w, h, { keyColor: K.KEY_GREEN, spill: true, global: true }).rgba, w, 14, 20)[3], 0, 'closed-off gap removed in in-betweens');
  assert.strictEqual(at(K.keyCel(px, w, h, { expect: K.KEY_GREEN }).rgba, w, 14, 20)[3], 255, 'enclosed green kept in AI cels');
});

test('colour stabilization pulls a drifting cel toward the first cel of the shot (~60%)', () => {
  const n = 400;
  const mk = (off, gain) => {
    const r = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      const v = 60 + (i % 100);
      r.set([v * gain + off, (v * gain + off) * 0.8, 90 + off, i < 300 ? 255 : 0], i * 4);
    }
    return r;
  };
  const ref = K.colorStats(mk(0, 1), n);
  const cel = mk(40, 1.1);
  const before = K.colorStats(cel, n);
  const keep = cel.slice(300 * 4);
  const after = K.stabilizeColors(cel, n, ref, 0.6);
  for (let c = 0; c < 3; c++) {
    const d0 = before.mean[c] - ref.mean[c];
    const d1 = after.mean[c] - ref.mean[c];
    assert.ok(Math.abs(d1) < Math.abs(d0) * 0.5 && Math.abs(d1) > Math.abs(d0) * 0.25, `channel ${c}: ${d0.toFixed(1)} → ${d1.toFixed(1)}`);
  }
  assert.ok(Math.abs(after.std[0] - ref.std[0]) < Math.abs(before.std[0] - ref.std[0]), 'contrast moves toward the reference');
  assert.deepStrictEqual(Array.from(cel.slice(300 * 4)), Array.from(keep), 'transparent pixels untouched');
  for (let i = 0; i < 300; i++) assert.strictEqual(cel[i * 4 + 3], 255, 'alpha untouched');
});

test('processCel: PNG in → transparent cel + plate on the exact key colour; real alpha is used as-is', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am2-key-'));
  const { px, w, h } = fakeCel();
  const src = path.join(dir, 'cel.png');
  await K.writePng(src, px, w, h);
  const r = await K.processCel(src, { celOut: path.join(dir, 'c.png'), plateOut: path.join(dir, 'p.png'), keyColor: K.KEY_GREEN });
  assert.ok(r.keyed);
  assert.match(r.source, /^#/);
  const cel = await K.readRgba(r.cel);
  assert.strictEqual(at(cel.data, w, 3, 3)[3], 0);
  assert.strictEqual(at(cel.data, w, 50, 30)[3], 255);
  const plate = await K.readRgba(r.plate);
  assert.deepStrictEqual(at(plate.data, w, 3, 3), [0, 255, 0, 255], 'plate background is exactly #00ff00');
  // 이미 투명한 PNG
  const alpha = path.join(dir, 'alpha.png');
  await K.writePng(alpha, cel.data, w, h);
  const r2 = await K.processCel(alpha, { celOut: path.join(dir, 'c2.png'), plateOut: path.join(dir, 'p2.png'), keyColor: K.KEY_MAGENTA });
  assert.strictEqual(r2.source, 'alpha');
  const plate2 = await K.readRgba(r2.plate);
  assert.deepStrictEqual(at(plate2.data, w, 3, 3), [255, 0, 255, 255]);
  // 단색 배경이 아닌 그림
  const full = path.join(dir, 'full.png');
  await K.writePng(full, new Uint8ClampedArray(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 7919) % 251)), w, h);
  const r3 = await K.processCel(full, { celOut: path.join(dir, 'c3.png'), plateOut: path.join(dir, 'p3.png'), keyColor: K.KEY_GREEN });
  assert.strictEqual(r3.keyed, false);
  // 셀 차이: 같으면 0, 다르면 큼
  const a = await K.readRgba(r.cel, { width: 64 });
  assert.strictEqual(K.celDifference(a, a), 0);
  const shifted = new Uint8ClampedArray(a.data.length);
  shifted.set(a.data.subarray(16 * 4));
  assert.ok(K.celDifference(a, { ...a, data: shifted }) > 0.05);
});
