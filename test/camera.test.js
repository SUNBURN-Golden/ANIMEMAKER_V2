'use strict';
// 공용 카메라 모듈 (src/shared/camera.js): 옛 xsheet.js 와 똑같은 값 · xsheet 가 그대로 다시 내보냄 · 브라우저(<script>) 로 읽기 · render.js 의 sampleFrame 수식과 같은 사각형
//  - test/fixtures/camera-golden.json 은 함수를 옮기기 '전' 의 xsheet.js 로 찍어 둔 값이다 (normalizeCamera 86가지 입력 · easeP · cameraAt).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Cam = require('../src/shared/camera');
const X = require('../src/main/pipeline/xsheet');
const { sampleFrame, parallaxFraming } = require('../src/main/media/render');

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'camera-golden.json'), 'utf8'));
const PS = [-1, 0, 0.1, 0.25, 0.333, 0.5, 0.75, 0.9, 1, 2];
const close = (a, b, eps = 1e-12) => Math.abs(a - b) <= eps;

test('옛 xsheet.js 에서 찍어 둔 값과 똑같다: 움직임 표 · 구도 표 · 정리(normalizeCamera) 86가지', () => {
  assert.deepStrictEqual(Cam.CAMERA_MOVES, golden.moves);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(Cam.CAMERA_PRESETS)), golden.presets);
  assert.strictEqual(golden.normalize.length, 86);
  for (const g of golden.normalize) {
    const raw = g.raw === '__undefined__' ? undefined : g.raw;
    assert.deepStrictEqual(JSON.parse(JSON.stringify(Cam.normalizeCamera(raw, g.fx))), g.cam, `normalizeCamera: ${g.label}`);
  }
});

test('모든 움직임(프리셋)과 정리된 카메라에서 cameraAt · easeP 가 옛 값과 같다 (p = -1 … 2)', () => {
  for (const g of golden.ease) {
    PS.forEach((p, i) => assert.ok(close(Cam.easeP(p, g.ease === null ? undefined : g.ease), g.values[i]), `easeP(${p}, ${g.ease})`));
  }
  assert.ok(golden.at.length >= 96);
  for (const g of golden.at) {
    PS.forEach((p, i) => {
      const got = Cam.cameraAt(g.cam, p);
      for (const k of ['zoom', 'x', 'y']) assert.ok(close(got[k], g.values[i][k]), `cameraAt ${g.label} p=${p} ${k}: ${got[k]} vs ${g.values[i][k]}`);
    });
  }
  // 프리셋 10개 모두 위 목록에 있다
  for (const m of Cam.CAMERA_MOVES) assert.ok(golden.at.some((g) => g.label === `preset:${m}`), m);
});

test('xsheet.js 는 같은 함수를 그대로 다시 내보낸다 (render.js · main.js 가 xsheet 에서 가져와도 동작이 같다)', () => {
  for (const k of ['normalizeCamera', 'cameraAt', 'easeP']) assert.strictEqual(X[k], Cam[k], k);
  assert.strictEqual(X.CAMERA_MOVES, Cam.CAMERA_MOVES);
  assert.strictEqual(X.CAMERA_PRESETS, Cam.CAMERA_PRESETS);
  // xsheet 안에서 쓰는 곳 (타임시트 정리) 도 같은 카메라를 만든다
  const cam = X.normalizeCamera('dollyin', ['shake']);
  assert.strictEqual(cam.move, 'truck_in');
  assert.ok(cam.start.zoom >= 1.06 && cam.end.zoom >= 1.06, '흔들기 효과가 있으면 확대 여유');
});

test('브라우저 <script> 로 읽으면 window.AMCamera, CommonJS 는 module.exports (vm 가짜 창)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'camera.js'), 'utf8');
  // 1) self 가 있는 창
  const win = {};
  win.self = win;
  vm.createContext(win);
  vm.runInContext(src, win, { filename: 'camera.js' });
  assert.ok(win.AMCamera, 'window.AMCamera');
  assert.strictEqual(typeof win.AMCamera.cameraAt, 'function');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(win.AMCamera.normalizeCamera('pan_left'))), golden.normalize.find((g) => g.label === 'move:pan_left').cam);
  const mid = win.AMCamera.cameraAt(win.AMCamera.normalizeCamera('zoom_in'), 0.5);
  assert.ok(close(mid.zoom, Cam.cameraAt(Cam.normalizeCamera('zoom_in'), 0.5).zoom));
  // 2) self 가 없고 this 가 전역인 곳
  const g2 = vm.createContext({});
  vm.runInContext(src, g2);
  assert.ok(g2.AMCamera && typeof g2.AMCamera.easeP === 'function', 'this 가 전역일 때도');
  // 3) 파일 안에 Node 전용 기능이 없다 (브라우저에서 깨지지 않게)
  assert.ok(!/require\(|process\.|__dirname|Buffer/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'Node 전용 기능을 쓰지 않는다');
});

test('parallaxFraming · frameRect/cameraRect: render.js 와 같은 수식 (기울기 그림으로 맞춰 본다)', () => {
  // render.js 의 parallaxFraming 과 같은 값
  for (const fr of [{ zoom: 1, x: 0, y: 0 }, { zoom: 1.45, x: 0.3, y: -0.15 }, { zoom: 1.2, x: -0.8, y: 0.8 }]) {
    assert.deepStrictEqual(Cam.parallaxFraming(fr, 0.8), parallaxFraming(fr, 0.8));
    assert.deepStrictEqual(Cam.parallaxFraming(fr), parallaxFraming(fr));
  }
  // 가로 값이 x 인 기울기 그림(R=x, G=y). 선형이라 쌍선형 보간의 결과가 사각형 계산과 거의 정확히 맞는다
  const cw = 240;
  const ch = 135;
  const W = 120;
  const H = 68;
  const src = Buffer.alloc(cw * ch * 3);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const o = (y * cw + x) * 3; src[o] = x; src[o + 1] = y; src[o + 2] = 0; }
  const cases = [];
  for (const m of Cam.CAMERA_MOVES) for (const p of [0, 0.3, 0.5, 0.8, 1]) cases.push({ cam: Cam.normalizeCamera(m), p, dx: 0, dy: 0 });
  cases.push({ cam: Cam.normalizeCamera('zoom_in'), p: 0.6, dx: 3.5, dy: -2.25 }, { cam: Cam.normalizeCamera('pan_right'), p: 0.4, dx: -6, dy: 4 });
  for (const c of cases) {
    const fr = Cam.cameraAt(c.cam, c.p);
    const out = sampleFrame(src, cw, ch, W, H, fr, c.dx, c.dy, 3);
    const r = Cam.cameraRect(c.cam, c.p, { cw, ch, W, H, dx: c.dx, dy: c.dy });
    assert.ok(close(r.w, cw / fr.zoom) && close(r.h, ch / fr.zoom));
    for (const [X0, Y0] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1], [W >> 1, H >> 1], [17, 40]]) {
      const sx = Math.min(Math.max(r.x0 + (X0 + 0.5) * (r.w / W) - 0.5, 0), cw - 1.001);
      const sy = Math.min(Math.max(r.y0 + (Y0 + 0.5) * (r.h / H) - 0.5, 0), ch - 1.001);
      const o = (Y0 * W + X0) * 3;
      assert.ok(Math.abs(out[o] - sx) <= 1.01, `${c.cam.move} p=${c.p} (${X0},${Y0}) x: ${out[o]} vs ${sx.toFixed(2)}`);
      assert.ok(Math.abs(out[o + 1] - sy) <= 1.01, `${c.cam.move} p=${c.p} (${X0},${Y0}) y: ${out[o + 1]} vs ${sy.toFixed(2)}`);
    }
  }
});

test('unitRect: 그림 전체를 0~1 로 본 창 (zoom 1 이면 전체, 2 이면 절반, x·y 로 가장자리에 붙인다)', () => {
  assert.deepStrictEqual(Cam.unitRect({ zoom: 1, x: 0, y: 0 }), { x: 0, y: 0, w: 1, h: 1 });
  const half = Cam.unitRect({ zoom: 2, x: 0, y: 0 });
  assert.ok(close(half.x, 0.25) && close(half.y, 0.25) && close(half.w, 0.5) && close(half.h, 0.5));
  const left = Cam.unitRect({ zoom: 2, x: -1, y: 1 });
  assert.ok(close(left.x, 0) && close(left.y, 0.5), 'zoom 2 에서 x=-1 은 왼쪽 끝, y=1 은 아래 끝');
  // 창은 늘 그림 안에 들어간다 (구도가 -1~1 안일 때)
  for (const m of Cam.CAMERA_MOVES) for (const p of [0, 0.5, 1]) {
    const r = Cam.unitRect(Cam.cameraAt(Cam.normalizeCamera(m), p));
    assert.ok(r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9, `${m} p=${p}`);
  }
});
