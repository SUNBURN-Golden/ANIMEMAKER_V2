'use strict';
// 순수 코어 분리(M0)가 동작을 하나도 바꾸지 않았는지 확인한다.
//  - 옛 파일(characters.js · series.js · media/keyer.js · media/render.js · media/audio.js · ai/demo.js)은 예전과 똑같은 이름을 모두 내보낸다.
//  - 같은 입력의 결과(sha1)가 분리 *전* 코드로 만든 값(fixtures/shared-golden.json)과 같다: keyCel · stabilizeColors · overKey · celDifference ·
//    processCel · sampleFrame(멈춤/팬/줌/흔들기/보일, 1280x720 · 720x1280) · composite · applyFx · renderShot 프레임 · analyzeSamples(30초 박자 소리) ·
//    analyzeSong(같은 WAV) · normalizeCharacter · toAmchar → fromAmchar · normalizeSeries · demoPlan/demoXsheet · 프롬프트 조립.
//  - 입력은 fixtures/shared-golden.js 가 시드 고정 난수로 만든다 (ffmpeg 가 만든 그림·소리 출력에 기대지 않는다). 골든을 다시 만들 일은 거의 없다:
//    코드가 바뀌어 값이 달라졌다면 먼저 왜 달라졌는지부터 본다 (비트 단위로 같아야 하는 약속이다).
//    동작을 일부러 바꾼 경우에만 `node test/fixtures/regen-shared-golden.js` 로 다시 만든다.
const ff = require('../src/main/media/ffmpeg');
const G = require('./fixtures/shared-golden');
const sinkState = G.installFrameSink(ff); // render.js 를 불러오기 전에 (인코더에 들어가는 프레임을 받아 보려고)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const GOLDEN = require('./fixtures/shared-golden.json');
const K = require('../src/main/media/keyer');
const KC = require('../src/main/media/keyer-core');
const R = require('../src/main/media/render');
const RC = require('../src/main/media/render-core');
const A = require('../src/main/media/audio');
const AC = require('../src/main/media/audio-analysis');
const C = require('../src/main/characters');
const CC = require('../src/main/characters-core');
const S = require('../src/main/series');
const SC = require('../src/main/series-core');
const D = require('../src/main/ai/demo');
const DD = require('../src/main/ai/demo-data');
const P = require('../src/main/pipeline/prompts');
const X = require('../src/main/pipeline/xsheet');

const m = { K, R, A, C, S, D, P };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am2-shared-eq-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// ---------------------------------------------------------------- 이름 · 코어 연결

// 분리 전 module.exports 에 있던 이름 전부 (예전 코드를 쓰는 곳이 깨지지 않는다)
const OLD_EXPORTS = [
  [C, ['FORMAT', 'FORMAT_VERSION', 'LOCKED_FIELDS', 'REF_KINDS', 'REF_KIND_LABEL', 'MAX_REFS', 'sniffImage', 'normalizeHex', 'normalizeCharacter', 'validateCharacter', 'lockedText', 'paletteText', 'characterBlock', 'toAmchar', 'fromAmchar', 'CharacterStore']],
  [S, ['SeriesStore', 'normalizeSeries', 'normalizeEpisode', 'normalizeSubtitleStyle']],
  [K, ['KEY_GREEN', 'KEY_MAGENTA', 'HARD', 'SOFT', 'KEY_DRIFT', 'hexToRgb', 'rgbToHex', 'keyColorFor', 'keyName', 'keyCel', 'hasRealAlpha', 'colorStats', 'stabilizeColors', 'overKey', 'readRgba', 'writePng', 'processCel', 'celDifference', 'exists']],
  [R, ['renderShot', 'sampleFrame', 'decodeCover', 'fxState', 'rand', 'parallaxFraming', 'composite']],
  [A, ['analyzeSong', 'analyzeSamples', 'estimateTempo', 'fixOctave', 'SR']],
  [D, ['DEMO_LYRICS', 'DEMO_CHARACTER', 'demoPlan', 'demoXsheet', 'demoDrawing', 'demoBg', 'demoCel', 'demoCharacterRef', 'demoImage', 'demoMusic', 'createDemoSeries']],
];

test('old modules still export every name they exported before the split', () => {
  for (const [mod, names] of OLD_EXPORTS) for (const n of names) assert.notStrictEqual(mod[n], undefined, `${n} is still exported`);
});

test('the pure names of the old modules are the very same objects as in the cores (re-exported, not copied)', () => {
  const pairs = [
    [K, KC, ['KEY_GREEN', 'KEY_MAGENTA', 'HARD', 'SOFT', 'KEY_DRIFT', 'hexToRgb', 'rgbToHex', 'hsv', 'keyColorFor', 'keyName', 'median', 'keyCel', 'hasRealAlpha', 'colorStats', 'stabilizeColors', 'overKey', 'celDifference']],
    [R, RC, ['rand', 'parallaxFraming', 'coverSize', 'cameraRect', 'cameraWindow', 'blankImage', 'sampleFrame', 'fxState', 'drawSparkles', 'applyFx', 'composite']],
    [A, AC, ['analyzeSamples', 'estimateTempo', 'fixOctave', 'SR', 'fftInPlace', 'onsetFeatures', 'normalizeEnv', 'trackBeats', 'fillBeatGrid']],
    [C, CC, ['FORMAT', 'FORMAT_VERSION', 'LOCKED_FIELDS', 'REF_KINDS', 'REF_KIND_LABEL', 'MAX_REFS', 'sniffImage', 'normalizeHex', 'cleanText', 'cleanList', 'newId', 'normalizeCharacter', 'validateCharacter', 'lockedText', 'paletteText', 'characterBlock', 'toAmchar']],
    [S, SC, ['clean', 'normalizeEpisode', 'normalizeSubtitleStyle', 'normalizeSeries', 'newSeriesId']],
    [D, DD, ['PALETTE', 'DEMO_LYRICS', 'DEMO_CHARACTER', 'DEMO_PLACES', 'demoPlan', 'demoXsheet', 'hex', 'figureBoxes']],
  ];
  for (const [old, core, names] of pairs) for (const n of names) assert.strictEqual(old[n], core[n], `${n}: same object in the old file and its core`);
  assert.notStrictEqual(C.fromAmchar, CC.fromAmchar, 'characters.fromAmchar is the Buffer adapter of the core function');
});

test('cores export the documented API; audio-analysis has every name of the V1 mobile audio-analysis', () => {
  const have = (mod, names) => { for (const n of names) assert.notStrictEqual(mod[n], undefined, n); };
  have(KC, ['KEY_GREEN', 'KEY_MAGENTA', 'HARD', 'SOFT', 'KEY_DRIFT', 'hexToRgb', 'rgbToHex', 'hsv', 'keyColorFor', 'keyName', 'median', 'keyCel', 'hasRealAlpha', 'colorStats', 'stabilizeColors', 'overKey', 'celDifference']);
  have(RC, ['rand', 'parallaxFraming', 'coverSize', 'cameraRect', 'cameraWindow', 'blankImage', 'sampleFrame', 'fxState', 'drawSparkles', 'applyFx', 'composite']);
  have(AC, ['fftInPlace', 'onsetFeatures', 'normalizeEnv', 'normEnv', 'estimateTempo', 'fixOctave', 'trackBeats', 'fillBeatGrid', 'analyzeSamples', 'SR']);
  have(AC, ['analyzeSamples', 'estimateTempo', 'fixOctave', 'SR']); // V1: module.exports = { analyzeSamples, estimateTempo, fixOctave, SR }
  assert.strictEqual(AC.normEnv, AC.normalizeEnv);
  have(CC, ['sniffImage', 'normalizeHex', 'cleanText', 'cleanList', 'normalizeCharacter', 'validateCharacter', 'lockedText', 'paletteText', 'characterBlock', 'toAmchar', 'fromAmchar', 'b64encode', 'b64decode', 'newId']);
  have(SC, ['normalizeSeries', 'normalizeEpisode', 'clean', 'newSeriesId']);
  have(DD, ['demoPlan', 'demoXsheet', 'DEMO_LYRICS', 'DEMO_CHARACTER', 'figureBoxes']);
  assert.strictEqual(typeof AC.analyzeSong, 'undefined', 'the decoding half stays in audio.js');
  assert.strictEqual(typeof KC.readRgba, 'undefined');
  assert.strictEqual(typeof RC.renderShot, 'undefined');
});

// ---------------------------------------------------------------- 골든 (분리 전 코드의 값)

test('golden: keyCel / stabilizeColors / overKey / celDifference / colour helpers are bit-identical to the pre-split keyer', () => {
  assert.deepStrictEqual(G.computeKeyer(m), GOLDEN.keyer);
});

test('golden: processCel (PNG in → key → stabilize → cel + plate PNG) is identical', { timeout: 120000 }, async () => {
  assert.deepStrictEqual(await G.computeProcessCel(m, tmp), GOLDEN.processCel);
});

test('golden: sampleFrame (hold/pan/zoom/shake/boil, 1280x720 and 720x1280), composite, applyFx (fade/flash/sparkle) are identical', () => {
  assert.deepStrictEqual(G.computeRender(m), GOLDEN.render);
});

test('golden: renderShot hands the encoder the identical frames (layered + boil, flat + shake, zoom-out)', { timeout: 180000 }, async () => {
  assert.deepStrictEqual(await G.computeRenderShot(m, tmp, sinkState), GOLDEN.renderShot);
});

test('golden: analyzeSamples on a 30 s click track, and analyzeSong on the same WAV, are identical to the pre-split result', { timeout: 120000 }, async () => {
  const got = await G.computeAudio(m, tmp);
  assert.deepStrictEqual(got, GOLDEN.audio);
  assert.strictEqual(got.fileEqualsSamples, true, 'analyzeSong = decode + analyzeSamples');
  assert.ok(Math.abs(got.samples120.bpm - 120) < 1 && got.samples120.beats >= 58, 'and it really finds the 120 BPM click track');
});

test('golden: normalizeCharacter, toAmchar → fromAmchar round trip (strings, objects, BOM, bytes, wrapped base64) and the Korean error messages are identical', () => {
  assert.deepStrictEqual(G.frozen(() => G.computeCharacters(m)), GOLDEN.characters);
});

test('golden: normalizeSeries / normalizeEpisode are identical', () => {
  assert.deepStrictEqual(G.frozen(() => G.computeSeries(m)), GOLDEN.series);
});

test('golden: demoPlan / demoXsheet / figureBoxes deep-equal the pre-split output, and prompt assembly is byte-identical', () => {
  assert.deepStrictEqual(G.computeDemo(m), GOLDEN.demo);
  assert.deepStrictEqual(G.computePrompts(m), GOLDEN.prompts);
});

// ---------------------------------------------------------------- 새로 생긴 순수 도우미 확인

test('base64 helpers equal Buffer for every length, big payloads, and lenient decoding', () => {
  const r = G.rng(99);
  const bytes = (n) => Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
  for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 57, 58, 59, 76, 255, 256, 257, 1000, 1001, 1002, 65535, 65536]) {
    const b = bytes(n);
    const enc = CC.b64encode(b);
    assert.strictEqual(enc, Buffer.from(b).toString('base64'), `encode ${n}`);
    assert.deepStrictEqual(Buffer.from(CC.b64decode(enc)), Buffer.from(enc, 'base64'), `decode ${n}`);
    assert.deepStrictEqual(Buffer.from(CC.b64decode(enc)), Buffer.from(b), `round trip ${n}`);
  }
  const big = bytes(3 * 1024 * 1024 + 2);
  const bigEnc = CC.b64encode(big);
  assert.strictEqual(bigEnc, Buffer.from(big).toString('base64'));
  assert.ok(Buffer.from(CC.b64decode(bigEnc)).equals(Buffer.from(big)));
  // 너그러운 읽기: 공백·줄바꿈·알 수 없는 글자는 건너뛰고, '=' 에서 끝, URL 글자 '-' '_' 도 받는다 — Buffer.from(s, 'base64') 와 같다
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/-_';
  const noise = ' \n\r\t=*.!@#가ŁŁĀé';
  for (let t = 0; t < 4000; t++) {
    const len = Math.floor(r() * 90);
    let str = '';
    for (let i = 0; i < len; i++) str += r() < 0.8 ? alphabet[Math.floor(r() * alphabet.length)] : noise[Math.floor(r() * noise.length)];
    assert.deepStrictEqual(Buffer.from(CC.b64decode(str)), Buffer.from(str, 'base64'), `lenient decode of ${JSON.stringify(str)}`);
  }
  for (const str of ['', '=', '====', 'QQ', 'QQ=', 'QQ==', 'QUI', 'QUJD', 'QUJDR', 'QUJD\nREVG\n', ' Q U J D ', 'QUJD=REVG', 'QUJD-_8=']) {
    assert.deepStrictEqual(Buffer.from(CC.b64decode(str)), Buffer.from(str, 'base64'), JSON.stringify(str));
  }
});

test('toAmchar / fromAmchar accept plain Uint8Array data, and the PC adapter returns Node Buffers', () => {
  const n = CC.normalizeCharacter({ ...G.sampleCharacter(), refs: G.sampleCharacter().refs.slice(0, 2) });
  const u8 = [G.fakeRef('png', 1234, 5), G.fakeRef('jpg', 999, 6)];
  const asBuffers = u8.map((b) => Buffer.from(b));
  assert.strictEqual(JSON.stringify(CC.toAmchar(n, u8)), JSON.stringify(CC.toAmchar(n, asBuffers)), 'Uint8Array = Buffer');
  const text = JSON.stringify(CC.toAmchar(n, u8));
  const core = CC.fromAmchar(text);
  const pc = C.fromAmchar(text);
  assert.ok(core.refs.every((r) => r.buffer instanceof Uint8Array && !Buffer.isBuffer(r.buffer)), 'core: Uint8Array');
  assert.ok(pc.refs.every((r) => Buffer.isBuffer(r.buffer)), 'PC adapter: Buffer');
  assert.deepStrictEqual(pc.character, core.character);
  assert.deepStrictEqual(pc.refs.map((r) => Array.from(r.buffer)), u8.map((b) => Array.from(b)));
  // 바이트(Uint8Array) 로 받은 파일 — BOM 이 있어도
  assert.deepStrictEqual(CC.fromAmchar(new TextEncoder().encode(`\uFEFF${text}`)).character, core.character);
});

test('new ids keep the old shape: char-<time36><6 hex>, ser-<time36><4 hex>, random, from globalThis.crypto', () => {
  const chars = new Set();
  const seriesIds = new Set();
  for (let i = 0; i < 2000; i++) {
    const c = CC.newId();
    assert.match(c, /^char-[0-9a-z]+[0-9a-f]{6}$/);
    chars.add(c);
  }
  for (let i = 0; i < 300; i++) {
    const s = SC.newSeriesId();
    assert.match(s, /^ser-[0-9a-z]+[0-9a-f]{4}$/);
    seriesIds.add(s);
  }
  assert.ok(chars.size >= 1990, `character ids are random enough (${chars.size} / 2000)`); // 한 밀리초 안에 많이 뽑으면 우연히 겹칠 수 있다 (6자리 = 1600만 가지)
  assert.ok(seriesIds.size >= 290, `series ids are random enough (${seriesIds.size} / 300)`); // 4자리 = 65536 가지
  assert.ok(/^[\w.-]+$/.test(CC.newId()) && /^[\w.-]+$/.test(SC.newSeriesId()), 'safe as folder / file names (CharacterStore.charDir, SeriesStore.file)');
});

test('Uint8Array, not Uint8ClampedArray: results keep Buffer\'s truncating assignment (a clamped array would round)', () => {
  const kind = (v) => Object.prototype.toString.call(v);
  assert.strictEqual(kind(K.overKey(new Uint8ClampedArray([10, 20, 30, 128]), 1, '#00ff00')), '[object Uint8Array]');
  assert.strictEqual(kind(R.blankImage(2, 2)), '[object Uint8Array]');
  assert.strictEqual(kind(R.sampleFrame(new Uint8Array(4 * 4 * 3), 4, 4, 2, 2, { zoom: 1, x: 0, y: 0 })), '[object Uint8Array]');
  assert.strictEqual(kind(R.composite(new Uint8Array(4), new Uint8Array(3), 1)), '[object Uint8Array]');
  // 100 + (255 - 100) * 0.5 = 177.5 → Buffer 처럼 177 (Uint8ClampedArray 였다면 178)
  const px = new Uint8Array([100, 100, 100]);
  R.applyFx(px, { fade: 1, flash: 0.5, sparkle: false, shake: 0 }, 1, 1, 1, 0);
  assert.deepStrictEqual(Array.from(px), [177, 177, 177]);
  // composite 는 반올림 (Uint8ClampedArray 로 쓴다): 셀 알파 0 이면 배경을 그대로, 반투명이면 반올림
  assert.deepStrictEqual(Array.from(R.composite(Uint8Array.from([0, 0, 0, 0]), Uint8Array.from([9, 8, 7]), 1)), [9, 8, 7]);
  assert.deepStrictEqual(Array.from(R.composite(Uint8Array.from([10, 20, 30, 128]), Uint8Array.from([100, 100, 100]), 1)), [60, 70, 80]);
});

// ---------------------------------------------------------------- 카메라 창 (Canvas2D 합성기가 같이 쓰는 식)

// 분리 전 sampleFrame 안에 들어 있던 식 그대로
function legacyWindow(cw, ch, W, H, fr, dx, dy) {
  const winW = cw / fr.zoom;
  const winH = ch / fr.zoom;
  const cx = cw / 2 + fr.x * (cw - winW) / 2 + dx * (winW / W);
  const cy = ch / 2 + fr.y * (ch - winH) / 2 + dy * (winH / H);
  const stx = winW / W;
  const sty = winH / H;
  const x0 = cx - winW / 2;
  const y0 = cy - winH / 2;
  return { winW, winH, cx, cy, x0, y0, stx, sty };
}

test('cameraRect is the exact source-window math of sampleFrame (strictly equal on thousands of random camera states)', () => {
  const r = G.rng(7);
  for (let t = 0; t < 3000; t++) {
    const W = 16 + Math.floor(r() * 1900);
    const H = 16 + Math.floor(r() * 1900);
    const S = 1 + r() * 1.5;
    const cw = Math.round(W * S);
    const ch = Math.round(H * S);
    const fr = { zoom: 1 + r() * 1.5, x: r() * 2 - 1, y: r() * 2 - 1 };
    const dx = (r() - 0.5) * 40;
    const dy = (r() - 0.5) * 40;
    assert.deepStrictEqual(RC.cameraRect(cw, ch, W, H, fr, dx, dy), legacyWindow(cw, ch, W, H, fr, dx, dy));
  }
  assert.deepStrictEqual(RC.cameraRect(200, 100, 50, 25, { zoom: 1.5, x: 0.2, y: -0.1 }), legacyWindow(200, 100, 50, 25, { zoom: 1.5, x: 0.2, y: -0.1 }, 0, 0), 'dx, dy default to 0');
});

test('cameraRect picks the right window; sampleFrame at 1:1 scale equals the plain crop of that window (what drawImage(srcRect) does)', () => {
  const cw = 200;
  const ch = 100;
  const src = G.randomRgb(cw, ch, 5);
  const crop = (x0, y0, w, h) => {
    const out = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) out.set(src.subarray(((y0 + y) * cw + x0) * 3, ((y0 + y) * cw + x0 + w) * 3), y * w * 3);
    return out;
  };
  // (창이 그림의 오른쪽·아래 끝에 닿으면 sampleFrame 은 마지막 줄을 cw-1.001 에서 멈춰 섞으므로 끝에 닿지 않는 구도만 정확히 비교한다)
  for (const [fr, x0, y0] of [[{ zoom: 2, x: -1, y: -1 }, 0, 0], [{ zoom: 2, x: 0, y: 0 }, 50, 25], [{ zoom: 2, x: 0.5, y: 0 }, 75, 25], [{ zoom: 2, x: -0.5, y: -1 }, 25, 0]]) {
    const w = RC.cameraRect(cw, ch, 100, 50, fr);
    assert.deepStrictEqual([w.x0, w.y0, w.winW, w.winH, w.stx, w.sty], [x0, y0, 100, 50, 1, 1]);
    assert.deepStrictEqual(RC.sampleFrame(src, cw, ch, 100, 50, fr), crop(x0, y0, 100, 50), `zoom 2 at (${fr.x}, ${fr.y})`);
  }
  const whole = RC.cameraRect(cw, ch, 50, 25, { zoom: 1, x: 0.7, y: -0.3 });
  assert.deepStrictEqual([whole.x0, whole.y0, whole.winW, whole.winH], [0, 0, cw, ch], 'zoom 1 shows the whole drawing wherever x, y point');
  // 흔들림 dx 는 '출력 기준 픽셀': 출력 1픽셀 = stx 원본 픽셀
  const shaken = RC.cameraRect(cw, ch, 50, 25, { zoom: 2, x: 0, y: 0 }, 3, -2);
  assert.strictEqual(shaken.x0, 50 + 3 * shaken.stx);
  assert.strictEqual(shaken.y0, 25 - 2 * shaken.sty);
});

test('coverSize / cameraWindow: the cover size of renderShot and the window of cameraAt(cam, p), with optional background parallax', () => {
  const cam = { move: 'zoom_in', ease: 'inout', start: { zoom: 1, x: 0, y: 0 }, end: { zoom: 1.4, x: 0.5, y: -0.25 } };
  assert.deepStrictEqual(RC.coverSize(cam, 1280, 720), { S: 1.4, cw: Math.round(1280 * 1.4), ch: Math.round(720 * 1.4) });
  assert.deepStrictEqual(RC.coverSize({ start: { zoom: 0.8 }, end: { zoom: 1 } }, 720, 1280), { S: 1, cw: 720, ch: 1280 }, 'never smaller than the frame');
  for (const p of [0, 0.25, 0.5, 1]) {
    const cel = RC.cameraWindow(cam, p, { W: 1280, H: 720, dx: 2, dy: -1 });
    const { cw, ch } = RC.coverSize(cam, 1280, 720);
    const fr = X.cameraAt(cam, p);
    assert.deepStrictEqual(cel, { fr, cw, ch, ...legacyWindow(cw, ch, 1280, 720, fr, 2, -1) });
    const bg = RC.cameraWindow(cam, p, { W: 1280, H: 720, parallax: 0.8, cw, ch });
    const bfr = RC.parallaxFraming(fr, 0.8);
    assert.deepStrictEqual(bg, { fr: bfr, cw, ch, ...legacyWindow(cw, ch, 1280, 720, bfr, 0, 0) });
    assert.ok(bg.winW >= cel.winW, 'the background moves less than the character layer');
  }
});

test('self-contained cores load and run with nothing but plain JS globals (no require / Buffer / process / __dirname)', () => {
  const vm = require('vm');
  const crypto = require('crypto');
  const run = (rel) => {
    const file = path.join(__dirname, '..', rel);
    // 브라우저 같은 환경: 자바스크립트 기본 객체 + TextDecoder/TextEncoder + crypto.getRandomValues 만 있다
    const sandbox = vm.createContext({ TextDecoder, TextEncoder, crypto: crypto.webcrypto });
    const mod = { exports: {} };
    vm.runInContext(`(function (module, exports) {${fs.readFileSync(file, 'utf8')}\n})`, sandbox, { filename: file })(mod, mod.exports);
    return mod.exports;
  };
  const kc = run('src/main/media/keyer-core.js');
  assert.strictEqual(kc.keyColorFor([{ hex: '#2e8b57' }]), '#ff00ff');
  assert.strictEqual(Array.from(kc.overKey(Uint8ClampedArray.of(255, 0, 0, 0), 1, '#00ff00')).join(), '0,255,0');
  const ac = run('src/main/media/audio-analysis.js');
  assert.strictEqual(ac.SR, 22050);
  assert.ok(Math.abs(ac.analyzeSamples(G.clickTrack(100, 12, 0.2), 100).bpm - 100) < 2);
  const cc = run('src/main/characters-core.js');
  assert.match(cc.newId(), /^char-/);
  assert.strictEqual(cc.b64encode(Uint8Array.of(1, 2, 3, 4)), 'AQIDBA==');
  assert.deepStrictEqual(Array.from(cc.b64decode('AQIDBA==')), [1, 2, 3, 4]);
});
