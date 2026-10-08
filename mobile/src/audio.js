// 노래 파일 읽기 + 박자 분석 (폰 안에서, 무료)
const ANALYSIS_SR = 22050; // 공용 audio-analysis.js 의 SR 과 같아야 한다 (test/audio.test.js 가 확인)
export { ANALYSIS_SR };

async function decode(blob, sampleRate, channels) {
  const buf = await blob.arrayBuffer();
  const ctx = new OfflineAudioContext(channels, 1, sampleRate);
  try {
    return await ctx.decodeAudioData(buf);
  } catch (e) {
    throw new Error('노래 파일을 읽지 못했어요. mp3, m4a, wav 파일인지 확인해 주세요.');
  }
}

/** 최종 영상에 넣을 노래 (48kHz) */
export function decodeSong(blob) {
  return decode(blob, 48000, 2);
}

/** 분석용 모노 22050Hz 소리 데이터 */
export async function decodeForAnalysis(blob) {
  const ab = await decode(blob, ANALYSIS_SR, 1);
  const n = ab.length;
  const out = new Float32Array(n);
  for (let c = 0; c < ab.numberOfChannels; c++) {
    const d = ab.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / ab.numberOfChannels;
  }
  return out;
}

/** 박자 분석은 오래 걸리니 따로(Worker) 돌려 화면이 멈추지 않게 한다 */
export async function analyzeSong(blob, { priorBpm } = {}) {
  const samples = await decodeForAnalysis(blob);
  if (samples.length < ANALYSIS_SR * 3) throw new Error('노래가 너무 짧아요 (3초 이상이어야 해요).');
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker('analyze.worker.js');
    } catch (e) {
      reject(new Error('노래 분석을 시작하지 못했어요.'));
      return;
    }
    worker.onmessage = (ev) => {
      worker.terminate();
      if (ev.data && ev.data.error) reject(new Error(ev.data.error));
      else resolve(ev.data.analysis);
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(`노래 분석 중 문제가 생겼어요: ${e.message || e}`));
    };
    worker.postMessage({ samples, priorBpm }, [samples.buffer]);
  });
}
