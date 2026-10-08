// 그림 한 장 받아서 정리하기 — 줄이기 → (인물 셀이면) 배경 빼기 → 색 맞추기 → 저장할 모양(WebP)으로.
// 화면 없이 돈다: 배경 빼기 일꾼(key.worker.js) 안에서 쓰고, 일꾼을 못 쓰는 폰에서는 앱 쪽에서 같은 코드를 그대로 쓴다.
// 판단(keyDecision)은 PC 앱의 keyer.processCel 과 똑같다: 이미 투명하면 그대로 → 아니면 keyCel(부탁한 배경색 기준) → 첫 셀 색에 맞추기(기본 0.6).
import Key from '../../../src/main/media/keyer-core.js';
import { fnv1a } from '../engine/util.js';

export const MAX_SIDE = 1536;

/**
 * 배경 빼기 판단 (순수 계산)
 * @param {Uint8ClampedArray} px RGBA (알파를 안 곱한 색: getImageData 가 주는 그대로)
 * @param {{keyColor:string, refStats?:object|null, strength?:number, exactKey?:boolean}} o
 * @returns {{keyed:false, reason:string}|{keyed:true, rgba:Uint8ClampedArray, source:string, stats:object|null}}
 */
export function keyDecision(px, w, h, { keyColor, refStats = null, strength = 0.6, exactKey = false } = {}) {
  const n = w * h;
  let rgba;
  let source;
  if (Key.hasRealAlpha(px, n)) {
    rgba = new Uint8ClampedArray(px);
    source = 'alpha';
  } else {
    const k = Key.keyCel(px, w, h, exactKey ? { keyColor, spill: true, global: true } : { expect: keyColor });
    if (!k.ok) return { keyed: false, reason: k.reason };
    rgba = k.rgba;
    source = Key.rgbToHex(k.key);
  }
  const stats = refStats ? Key.stabilizeColors(rgba, n, refStats, strength) : Key.colorStats(rgba, n);
  return { keyed: true, rgba, source, stats };
}

/** Blob → 비트맵. 긴 변이 maxSide 보다 길면 그 크기로 줄여서 읽는다 */
export async function loadScaled(blob, maxSide = MAX_SIDE) {
  let bmp = await createImageBitmap(blob);
  const long = Math.max(bmp.width, bmp.height);
  if (long > maxSide) {
    const s = maxSide / long;
    const w = Math.max(1, Math.round(bmp.width * s));
    const h = Math.max(1, Math.round(bmp.height * s));
    bmp.close();
    bmp = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
  }
  return bmp;
}

async function rgbaToBlob(rgba, w, h, type, quality) {
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
  return c.convertToBlob({ type, quality });
}

/**
 * 받은 그림 한 장 정리하기
 * @param {{blob:Blob, kind:'cel'|'pic', keyColor?:string, refStats?:object|null, strength?:number, exactKey?:boolean, maxSide?:number, wantHash?:boolean, skipOrig?:boolean}} o
 *   kind 'cel' = 인물 셀(배경 빼기) · 'pic' = 배경 판·전체 그림(줄이기만)
 * @returns {Promise<{ok:true, w:number, h:number, orig:Blob, keyed:boolean|null, cel?:Blob, source?:string, stats?:object|null, reason?:string, hash?:number}>}
 *   orig = 줄인 원본(손실 WebP), cel = 배경을 뺀 셀(무손실 WebP, 투명). 읽지 못하면 오류(code 'badImage')를 던진다
 */
export async function ingestImage(o) {
  let bmp;
  try {
    bmp = await loadScaled(o.blob, o.maxSide || MAX_SIDE);
  } catch (e) {
    const err = new Error('그림 파일을 읽지 못했어요. 다른 파일로 해 보세요.');
    err.code = 'badImage';
    throw err;
  }
  try {
    const w = bmp.width;
    const h = bmp.height;
    const canvas = new OffscreenCanvas(w, h);
    const g = canvas.getContext('2d', { willReadFrequently: o.kind === 'cel' });
    g.drawImage(bmp, 0, 0);
    const out = { ok: true, w, h, keyed: null };
    if (o.kind === 'cel') {
      const img = g.getImageData(0, 0, w, h);
      const d = keyDecision(img.data, w, h, o);
      out.keyed = d.keyed;
      if (d.keyed) {
        out.source = d.source;
        out.stats = d.stats;
        out.cel = await rgbaToBlob(d.rgba, w, h, 'image/webp', 1); // 품질 1 = 무손실
        if (o.wantHash) out.hash = fnv1a(d.rgba);
      } else {
        out.reason = d.reason;
      }
    }
    if (!o.skipOrig) out.orig = await canvas.convertToBlob({ type: 'image/webp', quality: 0.92 }); // skipOrig: 이미 저장된 원본에서 셀만 다시 만들 때
    return out;
  } finally {
    bmp.close();
  }
}

/** 셀을 배경색 위에 얹은 그림(PNG) — AI 에게 '이 그림을 고쳐 줘' 로 붙일 때 쓴다 (셀 자체는 투명이라 AI 가 알아보기 어렵다) */
export async function plateOf({ blob, keyColor }) {
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none' });
  try {
    const w = bmp.width;
    const h = bmp.height;
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    const img = g.getImageData(0, 0, w, h);
    const n = w * h;
    const rgb = Key.overKey(img.data, n, keyColor);
    const out = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      out[i * 4] = rgb[i * 3];
      out[i * 4 + 1] = rgb[i * 3 + 1];
      out[i * 4 + 2] = rgb[i * 3 + 2];
      out[i * 4 + 3] = 255;
    }
    return await rgbaToBlob(out, w, h, 'image/png');
  } finally {
    bmp.close();
  }
}
