// 영상·소리 압축 방식(코덱) 고르기. V1 render.js 와 같은 순서: 영상 avc(H.264) → vp9 → av1, 소리 aac → opus.
//   probeEncoders()  영상을 만들기 전에(무거운 일 전에) 한 번 불러서 이 폰이 어떤 압축을 할 수 있는지 본다 — 결과는 오류에도 실려 간다(error.probe).
//   NoEncoderError   쓸 수 있는 영상 압축이 하나도 없을 때. message 는 한국어, probe 는 시도한 결과.
// 이 샌드박스(Chromium)에는 H.264/AAC 인코더가 없고 VP9/Opus 만 된다 — 폰(WebView)에서 H.264/AAC 가 실제로 되는지는 확인하지 못했다.
import { canEncodeVideo, canEncodeAudio, Output, Mp4OutputFormat, NullTarget, CanvasSource } from 'mediabunny';
import { makeCanvas } from './util.js';

export const VIDEO_ORDER = ['avc', 'vp9', 'av1'];
export const AUDIO_ORDER = ['aac', 'opus'];

export class NoEncoderError extends Error {
  constructor(message, probe) {
    super(message);
    this.name = 'NoEncoderError';
    this.probe = probe;
  }
}

const NO_VIDEO = '이 폰에서는 영상을 만들 수 없어요. 영상을 압축하는 부품이 없어요. 안드로이드 시스템 WebView 와 Chrome 을 최신으로 업데이트한 뒤 다시 해 주세요.';

/** 한 가지 압축으로 아주 짧게(3장) 실제로 만들어 본다: 지원한다고 해 놓고 막상 시작하면 실패하는 폰을 걸러 낸다 */
export async function trialEncode({ codec, W, H, fps = 24, bitrate = 1e6 }) {
  let output = null;
  try {
    const canvas = makeCanvas(W, H);
    const ctx = canvas.getContext('2d');
    output = new Output({ format: new Mp4OutputFormat(), target: new NullTarget() });
    const src = new CanvasSource(canvas, { codec, bitrate, keyFrameInterval: 1 });
    output.addVideoTrack(src, { frameRate: fps });
    await output.start();
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = i % 2 ? '#888' : '#ccc';
      ctx.fillRect(0, 0, W, H);
      await src.add(i / fps, 1 / fps);
    }
    await output.finalize();
    return true;
  } catch (_) {
    try { if (output) await output.cancel(); } catch (__) { /* 이미 실패 */ }
    return false;
  }
}

/**
 * @param {{W:number,H:number,fps?:number,bitrate?:number,sampleRate?:number,channels?:number,wantAudio?:boolean,trial?:boolean,
 *          videoOrder?:string[],audioOrder?:string[],can?:{video:Function,audio:Function}}} o
 *   can: 시험할 때 가짜 판별 함수를 넣는다.  trial: 고른 압축으로 3장 만들어 보기(기본 false — exportClean 은 true 로 부른다)
 * @returns {Promise<{video:string|null,audio:string|null,tried:{video:object,audio:object},webcodecs:boolean,fallbackVideo:boolean,fallbackAudio:boolean,W:number,H:number,fps:number}>}
 */
export async function probeEncoders(o) {
  const { W, H, fps = 24, bitrate, sampleRate = 48000, channels = 2, wantAudio = true, trial = false } = o;
  const videoOrder = o.videoOrder || VIDEO_ORDER;
  const audioOrder = o.audioOrder || AUDIO_ORDER;
  const can = o.can || { video: canEncodeVideo, audio: canEncodeAudio };
  const tried = { video: {}, audio: {} };
  const webcodecs = typeof VideoEncoder !== 'undefined' || !!o.can; // 시험할 때는 가짜 판별 함수가 있으면 된다
  let video = null;
  if (webcodecs) {
    for (const c of videoOrder) {
      let ok = false;
      try { ok = !!(await can.video(c, { width: W, height: H, bitrate, frameRate: fps })); } catch (_) { ok = false; }
      if (ok && trial && !o.can) ok = await trialEncode({ codec: c, W, H, fps, bitrate: Math.min(bitrate || 2e6, 2e6) });
      tried.video[c] = ok;
      if (ok) { video = c; break; }
    }
  }
  let audio = null;
  if (wantAudio && webcodecs) {
    for (const c of audioOrder) {
      let ok = false;
      try { ok = !!(await can.audio(c, { numberOfChannels: channels, sampleRate, bitrate: 192e3 })); } catch (_) { ok = false; }
      tried.audio[c] = ok;
      if (ok) { audio = c; break; }
    }
  }
  return { video, audio, tried, webcodecs, fallbackVideo: !!video && video !== videoOrder[0], fallbackAudio: !!audio && audio !== audioOrder[0], W, H, fps };
}

/** 영상 압축이 없으면 한국어 오류 (probe 결과가 error.probe 에 실린다) */
export function assertVideoEncoder(probe) {
  if (!probe.video) throw new NoEncoderError(NO_VIDEO, probe);
  return probe;
}
