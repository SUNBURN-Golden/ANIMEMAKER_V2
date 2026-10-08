// 인물 그림 배경 빼기 일꾼 (공용 keyer-core 로 PC 앱과 똑같이 계산한다)
//
// 받는 것   { id, type:'ingest', blob, kind:'cel'|'pic', keyColor, refStats, strength, maxSide, wantHash }
//           { id, type:'plate', blob, keyColor }
// 돌려주는 것  { id, type, ok:true, ...결과 }  또는  { id, type, ok:false, code, error:'한국어 메시지' }
// 큰 덩어리(Blob)는 복사 없이 구조화 복제로 주고받는다. 일은 한 번에 하나씩 보내 달라고 약속한다 (앱 쪽 ingest.js 가 줄을 세운다).
import { ingestImage, plateOf } from './key-core.js';

self.onmessage = async (ev) => {
  const { id, type } = ev.data || {};
  try {
    if (type === 'ingest') {
      self.postMessage({ id, type, ...(await ingestImage(ev.data)) });
    } else if (type === 'plate') {
      self.postMessage({ id, type, ok: true, plate: await plateOf(ev.data) });
    } else {
      throw new Error('알 수 없는 일이에요');
    }
  } catch (e) {
    self.postMessage({ id, type, ok: false, code: (e && e.code) || 'failed', error: (e && e.message) || '그림을 정리하지 못했어요' });
  }
};
