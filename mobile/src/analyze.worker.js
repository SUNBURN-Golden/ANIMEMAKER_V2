// 박자 분석 일꾼 (PC 앱과 같은 계산 코드: src/main/media/audio-analysis.js)
import A from '../../src/main/media/audio-analysis.js';

self.onmessage = (ev) => {
  try {
    const { samples, priorBpm } = ev.data;
    self.postMessage({ analysis: A.analyzeSamples(samples, priorBpm) });
  } catch (e) {
    self.postMessage({ error: `노래 분석 실패: ${e.message || e}` });
  }
};
