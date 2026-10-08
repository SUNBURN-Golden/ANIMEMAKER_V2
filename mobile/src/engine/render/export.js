// 깨끗한 원본 영상 만들기 (자막 없음): 합성기가 그린 한 장씩 → WebCodecs(Mediabunny) → MP4, 24fps 정확히.
//   const r = await exportClean({ compositor, audio, onProgress, signal, tags });  // → { blob, codecs:{video,audio}, seconds, frames, … }
//
// 약속
//   - 장면 시간 r/24 (frameRate 24 고정), 영상 길이 = compositor.totalFrames / 24 (노래는 이 길이로 자르거나 무음으로 채우고, 끝 min(2, 길이/10)초 페이드아웃).
//   - 코덱은 먼저 알아본다(probeEncoders): avc → vp9 → av1 / aac → opus. 영상 압축이 하나도 없으면 무거운 일 전에 한국어 오류(NoEncoderError, error.probe).
//   - 목표(target): 기본 BufferTarget + fastStart:'in-memory' (MP4 전체가 메모리에 → 3.5분 · 6Mbps 약 160MB, Blob 으로 만들 때 잠깐 2배).
//     options.target 에 Mediabunny Target(예: StreamTarget)을 주면 그쪽으로 쓰고 blob 은 null — 스트리밍 목표는 나중에 끼울 수 있게 열어 둔 자리다.
//   - 멈추기: signal(AbortSignal)이 울리면 출력을 취소하고(blob 없음) 읽어 둔 그림을 닫고 AbortError 를 던진다.
//   - 진행: onProgress({stage:'video'|'finalize', frame, total, fraction, elapsedMs, etaMs, fps}) — 6장마다.
//   - 화면이 멈추지 않게 createPacer 로 틈틈이 양보한다(yieldToUI).
//   - AI 메타데이터: comment 'Made with AI (AnimeMaker V2)', description 'AI-generated content' (tags 로 title 등을 더할 수 있다).
import { Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource } from 'mediabunny';
import { probeEncoders, assertVideoEncoder } from './codecs.js';
import { createMeter } from './progress.js';
import { makeCanvas, frameContext, createPacer, throwIfAborted, abortError, isAbortError, nowMs } from './util.js';
import { defaultBitrate } from './frames.js';

export const AI_TAGS = Object.freeze({ comment: 'Made with AI (AnimeMaker V2)', description: 'AI-generated content' });

/** 노래(AudioBuffer)를 1초씩 잘라 영상과 번갈아 넣는 도우미: 길이를 seconds 로 맞추고(자르기 · 무음 채우기) 끝에 페이드아웃을 건다 */
export function createAudioFeeder(audio, asrc, seconds) {
  const sr = audio.sampleRate;
  const chans = Math.min(2, audio.numberOfChannels);
  const totalSamples = Math.round(seconds * sr);
  const fadeOut = Math.min(2, seconds / 10);
  const fadeStart = (seconds - fadeOut) * sr; // 이 샘플부터 줄어든다 (ffmpeg afade=t=out 의 직선)
  const fadeLen = Math.max(1, fadeOut * sr);
  const data = [];
  for (let c = 0; c < chans; c++) data.push(audio.getChannelData(c));
  let at = 0;
  return {
    totalSamples,
    get position() { return at; },
    async feed(untilSec) {
      while (at < totalSamples && at / sr < untilSec) {
        const len = Math.min(sr, totalSamples - at);
        const part = new AudioBuffer({ length: len, numberOfChannels: chans, sampleRate: sr });
        for (let c = 0; c < chans; c++) {
          const dst = new Float32Array(len);
          const have = Math.max(0, Math.min(len, audio.length - at));
          if (have > 0) dst.set(data[c].subarray(at, at + have));
          if (at + len > fadeStart) {
            for (let i = Math.max(0, Math.floor(fadeStart - at)); i < len; i++) dst[i] *= Math.max(0, Math.min(1, 1 - (at + i - fadeStart) / fadeLen));
          }
          part.copyToChannel(dst, c);
        }
        at += len;
        await asrc.add(part);
      }
    },
  };
}

/**
 * @param {object} o
 * @param {ReturnType<import('./compositor.js').createCompositor>} o.compositor
 * @param {AudioBuffer|null} [o.audio] 노래 (48kHz). 없으면 소리 없는 영상
 * @param {number} [o.W] @param {number} [o.H] @param {number} [o.fps] 기본은 합성기 값 (fps 는 24 로 두자: 장 시각 = r / fps)
 * @param {number} [o.bitrate] bps. 기본: 1080p 9M · 720p 5M · 540p 3M · 그 아래 2M
 * @param {(p:object)=>void} [o.onProgress] @param {AbortSignal} [o.signal] @param {object} [o.tags]
 * @param {object} [o.target] Mediabunny Target (기본 BufferTarget)
 * @param {boolean} [o.trial=true] 고른 압축으로 3장 만들어 보고 시작한다
 * @param {boolean} [o.keepCompositor=false] true 면 끝난 뒤에도 합성기를 닫지(release) 않는다
 * @param {(ctx:any, r:number, t:number)=>void} [o.overlay] 한 장마다 합성 직후에 얹을 것 (자막을 한 번에 입히는 대체 경로용)
 * @returns {Promise<{blob:Blob|null, codecs:{video:string,audio:string|null}, seconds:number, frames:number, bytes:number, mime:string,
 *   ms:number, msPerFrame:number, fallback:{video:boolean,audio:boolean}, probe:object, reusedFrames:number, audioDropped:boolean}>}
 */
export async function exportClean(o) {
  const { compositor, audio = null, onProgress, signal, tags } = o;
  const W = o.W || compositor.W;
  const H = o.H || compositor.H;
  const fps = o.fps || compositor.fps || 24;
  const total = compositor.totalFrames;
  const seconds = total / fps;
  const bitrate = o.bitrate || defaultBitrate(W, H);
  const t0 = nowMs();
  throwIfAborted(signal, '영상 만들기를 멈췄어요');

  // 1) 무거운 일 전에 압축 방식을 알아본다
  const chans = audio ? Math.min(2, audio.numberOfChannels) : 2;
  const probe = await probeEncoders({ W, H, fps, bitrate, sampleRate: audio ? audio.sampleRate : 48000, channels: chans, wantAudio: !!audio, trial: o.trial !== false });
  assertVideoEncoder(probe);
  throwIfAborted(signal, '영상 만들기를 멈췄어요');

  // 2) 출력 · 영상 · 소리
  const customTarget = !!o.target;
  const target = o.target || new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: customTarget ? false : 'in-memory' }), target });
  const canvas = makeCanvas(W, H);
  const ctx = frameContext(canvas);
  // 합성기 크기와 내보낼 크기가 다르면(예: 작은 미리보기용 합성기) 합성한 장을 늘려서 넣는다
  const inter = W !== compositor.W || H !== compositor.H ? frameContext(makeCanvas(compositor.W, compositor.H)) : null;
  const vsrc = new CanvasSource(canvas, { codec: probe.video, bitrate, keyFrameInterval: 2 });
  output.addVideoTrack(vsrc, { frameRate: fps });
  let feeder = null;
  if (audio && probe.audio) {
    const asrc = new AudioBufferSource({ codec: probe.audio, bitrate: 192e3 });
    output.addAudioTrack(asrc);
    feeder = createAudioFeeder(audio, asrc, seconds);
  }
  output.setMetadataTags({ ...AI_TAGS, ...(tags || {}) });

  const meter = createMeter(total);
  const pacer = createPacer();
  let done = 0;
  const report = (stage) => {
    if (!onProgress) return;
    try { onProgress({ stage, ...meter.update(done), frame: done }); } catch (_) { /* 화면 쪽 오류가 영상 만들기를 멈추면 안 된다 */ }
  };
  try {
    await output.start();
    for (let r = 0; r < total; r++) {
      throwIfAborted(signal, '영상 만들기를 멈췄어요');
      await compositor.prepare(r);
      if (r % 12 === 0 && compositor.prefetch) compositor.prefetch(r);
      if (inter) {
        compositor.frameAt(r, inter);
        ctx.drawImage(inter.canvas, 0, 0, W, H);
      } else compositor.frameAt(r, ctx);
      if (o.overlay) o.overlay(ctx, r, r / fps);
      await vsrc.add(r / fps, 1 / fps);
      if (feeder) await feeder.feed(r / fps + 1);
      done = r + 1;
      if (r % 6 === 0 || done === total) report('video');
      await pacer.tick();
    }
    if (feeder) await feeder.feed(Infinity);
    report('finalize');
    await output.finalize();
  } catch (e) {
    try { await output.cancel(); } catch (_) { /* 이미 닫힘 */ }
    if (!o.keepCompositor) compositor.release();
    if (isAbortError(e) || (signal && signal.aborted)) throw abortError('영상 만들기를 멈췄어요');
    throw e;
  }
  if (!o.keepCompositor) compositor.release();
  let blob = null;
  let bytes = 0;
  if (!customTarget) {
    bytes = target.buffer ? target.buffer.byteLength : 0;
    blob = new Blob([target.buffer], { type: 'video/mp4' });
    target.buffer = null; // 메모리 두 배로 들고 있지 않게
  }
  const ms = nowMs() - t0;
  return {
    blob, codecs: { video: probe.video, audio: feeder ? probe.audio : null }, seconds, frames: total, bytes, mime: 'video/mp4',
    ms, msPerFrame: ms / Math.max(1, total), fallback: { video: probe.fallbackVideo, audio: !!feeder && probe.fallbackAudio }, probe,
    reusedFrames: compositor.stats ? compositor.stats.reused : 0,
    audioDropped: !!audio && !feeder, // 소리를 넣을 압축(aac/opus)이 없어서 소리 없이 만들었다
  };
}
