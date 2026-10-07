'use strict';
// 사이 그림 테스트: ffmpeg 가운데 그림, 너무 다른 그림은 그대로 넘기기, 캐시, RIFE (있을 때만)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const K = require('../src/main/media/keyer');
const IB = require('../src/main/media/inbetween');

/** 초록 배경(또는 투명) 위 빨간 상자 (x 위치만 다름) */
async function boxCel(file, x, { w = 320, h = 180, bw = 50, bh = 90, clear = false } = {}) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const cx = i % w;
    const cy = Math.floor(i / w);
    const inBox = cx >= x && cx < x + bw && cy >= 45 && cy < 45 + bh;
    // 상자 안에 반복되지 않는 무늬 몇 개 (움직임을 찾기 쉽게)
    const u = cx - x;
    const v = cy - 45;
    let c = [0, 255, 0];
    if (inBox) c = u < 18 && v < 18 ? [250, 200, 60] : u > 30 && v > 60 && v < 75 ? [60, 40, 30] : [220, 40, 50];
    px.set(clear && !inBox ? [0, 0, 0, 0] : [...c, 255], i * 4);
  }
  await K.writePng(file, px, w, h, { rgb: false });
  return file;
}

/** 인물(초록이 아니고 불투명한 부분)의 무게중심 x */
async function centroidX(file) {
  const img = await K.readRgba(file);
  let sx = 0;
  let sa = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    const d = img.data;
    const green = d[i * 4] < 60 && d[i * 4 + 1] > 200 && d[i * 4 + 2] < 60;
    const a = green ? 0 : d[i * 4 + 3];
    sx += (i % img.width) * a;
    sa += a;
  }
  return sx / sa;
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'am2-ib-'));

test('ffmpeg engine: the middle drawing sits half way, is re-keyed to a transparent cel, and is cached', { timeout: 120000 }, async () => {
  const dir = tmp();
  const a = await boxCel(path.join(dir, 'a.png'), 100);
  const b = await boxCel(path.join(dir, 'b.png'), 140);
  const r = await IB.makeInbetween({ a, b, outDir: path.join(dir, 'ib'), engine: 'ffmpeg', keyColor: K.KEY_GREEN });
  assert.strictEqual(r.engine, 'ffmpeg');
  assert.ok(fs.existsSync(r.file) && fs.existsSync(r.plate));
  const [ca, cm, cb] = [await centroidX(a), await centroidX(r.file), await centroidX(b)];
  assert.ok(Math.abs(cm - (ca + cb) / 2) < 6, `midpoint ${ca.toFixed(1)} → ${cm.toFixed(1)} → ${cb.toFixed(1)}`);
  const cel = await K.readRgba(r.file);
  assert.strictEqual(cel.data[3], 0, 'background transparent');
  const again = await IB.makeInbetween({ a, b, outDir: path.join(dir, 'ib'), engine: 'ffmpeg', keyColor: K.KEY_GREEN });
  assert.ok(again.cached && again.file === r.file, 'same inputs → cached');
  assert.notStrictEqual(IB.inbetweenHash(a, b, 'ffmpeg', K.KEY_GREEN), IB.inbetweenHash(a, b, 'rife', K.KEY_GREEN), 'engine is part of the cache key');
  // 너무 다른 두 셀 → 사이 그림 없이 그대로 넘긴다 (투명 셀로 비교)
  const ta = await boxCel(path.join(dir, 'ta.png'), 100, { clear: true });
  const near = await IB.tooDifferent(ta, await boxCel(path.join(dir, 'tb.png'), 140, { clear: true }));
  assert.strictEqual(near.different, false, `near score ${near.score}`);
  assert.strictEqual((await IB.tooDifferent(ta, ta)).score, 0);
  const far = await IB.tooDifferent(ta, await boxCel(path.join(dir, 'tc.png'), 250, { bw: 60, bh: 120, clear: true }));
  assert.strictEqual(far.different, true, `moved far and grew: score ${far.score}`);
  const big = await IB.tooDifferent(ta, await boxCel(path.join(dir, 'td.png'), 90, { bw: 110, bh: 130, clear: true }));
  assert.strictEqual(big.different, true, `much bigger: score ${big.score}`);
});

test('engine choice: off / ffmpeg / auto falls back to ffmpeg when RIFE is missing', () => {
  assert.strictEqual(IB.resolveEngine('off').engine, null);
  assert.strictEqual(IB.resolveEngine('ffmpeg').engine, 'ffmpeg');
  const saved = process.env.ANIMEMAKER_RIFE_DIR;
  process.env.ANIMEMAKER_RIFE_DIR = path.join(os.tmpdir(), 'no-rife-here');
  try {
    const auto = IB.resolveEngine('auto');
    if (!IB.findRife()) {
      assert.strictEqual(auto.engine, 'ffmpeg');
      assert.match(IB.resolveEngine('rife').note, /RIFE 를 찾지 못해서 ffmpeg/);
    } else assert.strictEqual(auto.engine, 'rife', 'bundled RIFE found');
  } finally {
    if (saved === undefined) delete process.env.ANIMEMAKER_RIFE_DIR; else process.env.ANIMEMAKER_RIFE_DIR = saved;
  }
  assert.strictEqual(IB.rifeBinName('win32'), 'rife-ncnn-vulkan.exe');
  assert.strictEqual(IB.rifeBinName('linux'), 'rife-ncnn-vulkan');
});

const rife = process.env.ANIMEMAKER_RIFE_DIR ? IB.findRife() : null;
// 윈도우의 RIFE 는 vulkan-1.dll(그래픽 드라이버)이 있어야 켜진다. 윈도우가 DLL 을 찾는 곳: 실행 파일 옆 → System32 → Windows → PATH
const winDir = process.env.SystemRoot || 'C:\\Windows';
const vulkanDll = process.platform !== 'win32' || [rife && rife.dir, path.join(winDir, 'System32'), winDir,
  ...(process.env.PATH || process.env.Path || '').split(';')].some((d) => d && fs.existsSync(path.join(d, 'vulkan-1.dll')));
// ANIMEMAKER_REQUIRE_RIFE=1 이면 건너뛰지 않는다 (CI 에서 RIFE 가 정말 돌았는지 확인용)
const rifeSkip = process.env.ANIMEMAKER_REQUIRE_RIFE ? false
  : !rife ? 'ANIMEMAKER_RIFE_DIR 에 RIFE 가 없어서 건너뜀'
    : !vulkanDll ? 'vulkan-1.dll 이 없는 윈도우 (아래 테스트가 대신 확인)' : false;

test('RIFE without Vulkan (Windows): stops with a clear message so the pipeline switches to ffmpeg', { skip: rife && !vulkanDll ? false : 'vulkan-1.dll 이 없는 윈도우에서만', timeout: 60000 }, async () => {
  const dir = tmp();
  const a = await boxCel(path.join(dir, 'a.png'), 100);
  const b = await boxCel(path.join(dir, 'b.png'), 140);
  await assert.rejects(IB.makeInbetween({ a, b, outDir: path.join(dir, 'ib'), engine: 'rife', rife, keyColor: K.KEY_GREEN }),
    /Vulkan\(vulkan-1\.dll\)이 없어서/);
});

test('RIFE engine: middle drawing half way (GPU, else CPU)', { skip: rifeSkip, timeout: 300000 }, async () => {
  const dir = tmp();
  const a = await boxCel(path.join(dir, 'a.png'), 100);
  const b = await boxCel(path.join(dir, 'b.png'), 140);
  const r = await IB.makeInbetween({ a, b, outDir: path.join(dir, 'ib'), engine: 'rife', rife, keyColor: K.KEY_GREEN });
  assert.strictEqual(r.engine, 'rife');
  assert.ok(['gpu', 'cpu'].includes(r.device));
  const [ca, cm, cb] = [await centroidX(a), await centroidX(r.file), await centroidX(b)];
  assert.ok(Math.abs(cm - (ca + cb) / 2) < 5, `midpoint ${ca.toFixed(1)} → ${cm.toFixed(1)} → ${cb.toFixed(1)}`);
  assert.strictEqual(IB.resolveEngine('auto').engine, 'rife');
});
