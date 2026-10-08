// 엔진이 바깥 일(노래 읽기 · 그림 정리 · 영상 만들기 · 연습 그림)을 맡기는 곳 — 진짜 브라우저(WebView)용 기본 구현.
// 시험에서는 createEngine({ services }) 로 이 중 일부 또는 전부를 가짜로 바꿔 끼운다 (Node 에는 OffscreenCanvas · WebCodecs 가 없으므로).
import { decodeForAnalysis, decodeSong, ANALYSIS_SR } from '../audio.js';
import { abortError, throwIfAborted } from './util.js';
import { createIngestor } from './ingest.js';
import {
  createCompositor, exportClean, burnSubtitles, makeSrt, makeLrc, probeEncoders,
  demoBg, demoCel, demoDrawing, demoCharacterRef, demoSong,
} from './render/index.js';

/** 노래 분석 (../audio.js 의 analyzeSong 과 같은 일인데, 멈추라는 신호가 오면 일꾼을 끝낸다 — 멈추기가 분석 중에도 듣도록) */
async function analyzeSongAbortable(blob, { priorBpm, signal } = {}) {
  throwIfAborted(signal, '노래 분석을 멈췄어요');
  const samples = await decodeForAnalysis(blob);
  throwIfAborted(signal, '노래 분석을 멈췄어요');
  if (samples.length < ANALYSIS_SR * 3) throw new Error('노래가 너무 짧아요 (3초 이상이어야 해요).');
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker('analyze.worker.js');
    } catch (_) {
      reject(new Error('노래 분석을 시작하지 못했어요.'));
      return;
    }
    const done = (fn, v) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      worker.terminate();
      fn(v);
    };
    const onAbort = () => done(reject, abortError('노래 분석을 멈췄어요'));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (ev) => (ev.data && ev.data.error ? done(reject, new Error(ev.data.error)) : done(resolve, ev.data.analysis));
    worker.onerror = (e) => done(reject, new Error(`노래 분석 중 문제가 생겼어요: ${(e && e.message) || e}`));
    worker.postMessage({ samples, priorBpm }, [samples.buffer]);
  });
}

async function placeholderCard({ w, h, label }) {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = '#2b2b3a';
  g.fillRect(0, 0, w, h);
  g.strokeStyle = '#7c7ca0';
  g.lineWidth = Math.max(2, Math.round(Math.min(w, h) / 120));
  g.setLineDash([g.lineWidth * 4, g.lineWidth * 3]);
  g.strokeRect(g.lineWidth * 3, g.lineWidth * 3, w - g.lineWidth * 6, h - g.lineWidth * 6);
  g.setLineDash([]);
  g.fillStyle = '#e8e8f4';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `bold ${Math.round(Math.min(w, h) / 14)}px system-ui, sans-serif`;
  g.fillText(label, w / 2, h / 2, w * 0.9);
  return c.transferToImageBitmap();
}

/**
 * @param {{workerUrl?:string, inlineIngest?:boolean}} [o]
 * @returns {object} services — ingest(blob,opts) · plate(celBlob,keyColor) · analyzeSong(blob,{priorBpm,signal}) · decodeSong(blob) · decodeImage(blob,{premultiply}) · placeholder({w,h,label}) · demo{bg,cel,drawing,ref,song} · render{…} · dispose()
 */
export function defaultServices({ workerUrl = 'key.worker.js', inlineIngest = false } = {}) {
  const ingestor = createIngestor({ workerUrl, inline: inlineIngest });
  return {
    ingest: (blob, o) => ingestor.ingest(blob, o),
    plate: (cel, keyColor, o) => ingestor.plate(cel, keyColor, o),
    analyzeSong: analyzeSongAbortable,
    decodeSong: (blob) => decodeSong(blob),
    decodeImage: (blob, { premultiply = false } = {}) => createImageBitmap(blob, premultiply ? { premultiplyAlpha: 'premultiply' } : undefined),
    placeholder: placeholderCard,
    demo: { bg: demoBg, cel: demoCel, drawing: demoDrawing, ref: demoCharacterRef, song: demoSong },
    render: { createCompositor, exportClean, burnSubtitles, makeSrt, makeLrc, probeEncoders },
    ingestMode: () => ingestor.mode,
    dispose: () => ingestor.dispose(),
  };
}
