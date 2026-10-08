'use strict';
// 셀(인물 그림) 배경 빼기 · 색 맞추기 (내 PC, 앱 안의 코드) — 파일을 읽고 쓰는 부분.
//  - 순수 계산(keyCel, stabilizeColors, overKey, celDifference …)은 keyer-core.js 로 옮겨 폰 앱과 같은 파일을 쓴다.
//    여기서는 그 이름을 그대로 다시 내보내므로 `require('./media/keyer')` 는 예전과 똑같이 쓸 수 있다.
//  - 여기에 남은 것: readRgba · writePng (ffmpeg 로 그림 ↔ RGBA), processCel (읽기 → 배경 빼기 → 색 맞추기 → 쓰기), exists (fs).
const fs = require('fs');
const { runFfmpeg, ffmpegWriter, probe } = require('./ffmpeg');
const core = require('./keyer-core');

const { rgbToHex, keyCel, hasRealAlpha, colorStats, stabilizeColors, overKey } = core;

/** 그림 파일 → RGBA 픽셀 */
async function readRgba(file, { signal, width } = {}) {
  const info = await probe(file);
  if (!info.width) throw new Error(`그림을 읽을 수 없어요: ${file}`);
  let w = info.width;
  let h = info.height;
  const args = ['-i', file, '-frames:v', '1'];
  if (width && width < w) {
    h = Math.max(1, Math.round((h * width) / w));
    w = width;
    args.push('-vf', `scale=${w}:${h}:flags=area`);
  }
  args.push('-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1');
  const { stdout } = await runFfmpeg(args, { capture: 'stdout', signal });
  if (stdout.length < w * h * 4) throw new Error(`그림을 읽을 수 없어요: ${file}`);
  return { data: new Uint8ClampedArray(stdout.buffer, stdout.byteOffset, w * h * 4), width: w, height: h };
}

/** RGBA(또는 RGB) 픽셀 → PNG */
async function writePng(file, data, w, h, { rgb = false, signal } = {}) {
  const enc = ffmpegWriter(['-y', '-f', 'rawvideo', '-pix_fmt', rgb ? 'rgb24' : 'rgba', '-s', `${w}x${h}`, '-i', 'pipe:0', '-frames:v', '1', file], { signal });
  await enc.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  await enc.end();
  return file;
}

/**
 * AI 가 그린 셀 한 장 처리: 배경 빼기 → (기준이 있으면) 색 맞추기 → 투명 PNG + 배경색 판 PNG.
 * 배경을 뺄 수 없는 그림(가장자리가 단색이 아님)은 keyed:false → 전체 화면 그림으로 쓴다.
 * @param {{celOut:string, plateOut:string, keyColor:string, refStats?:object, strength?:number, exactKey?:boolean, signal?:AbortSignal}} o
 */
async function processCel(file, o) {
  const img = await readRgba(file, { signal: o.signal });
  const n = img.width * img.height;
  let rgba;
  let source;
  if (hasRealAlpha(img.data, n)) {
    rgba = new Uint8ClampedArray(img.data);
    source = 'alpha';
  } else {
    const k = keyCel(img.data, img.width, img.height, o.exactKey ? { keyColor: o.keyColor, spill: true, global: true } : { expect: o.keyColor });
    if (!k.ok) return { keyed: false, reason: k.reason, width: img.width, height: img.height };
    rgba = k.rgba;
    source = rgbToHex(k.key);
  }
  const stats = o.refStats ? stabilizeColors(rgba, n, o.refStats, o.strength ?? 0.6) : colorStats(rgba, n);
  await writePng(o.celOut, rgba, img.width, img.height, { signal: o.signal });
  await writePng(o.plateOut, overKey(rgba, n, o.keyColor), img.width, img.height, { rgb: true, signal: o.signal });
  return { keyed: true, source, stats, width: img.width, height: img.height, cel: o.celOut, plate: o.plateOut };
}

function exists(f) { try { return fs.statSync(f).size > 0; } catch (_) { return false; } }

module.exports = {
  ...core,
  readRgba, writePng, processCel, exists,
};
