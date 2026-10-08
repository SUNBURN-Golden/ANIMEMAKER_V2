// 진행률 · 남은 시간 계산 (순수 계산, 화면 없음). 영상 만들기 · 자막 입히기가 같이 쓴다.
//   const meter = createMeter(total);  ...  const p = meter.update(done);  // { done, total, fraction, elapsedMs, etaMs, fps }
//   etaMs 는 처음 몇 장(WARMUP_FRAMES)이나 1초가 지나기 전에는 null — 화면에는 "계산 중…" (fmtEta).

export const WARMUP_FRAMES = 6;
export const WARMUP_MS = 1000;

const defaultNow = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/**
 * 속도는 최근 구간의 장/초를 지수평균(0.3)으로 섞어 구한다: 앞쪽 컷이 빠르고 뒤쪽이 느려도 남은 시간이 천천히 따라간다.
 * @param {number} total 전체 프레임 수
 * @param {()=>number} [now] 시계(ms) — 시험할 때 가짜 시계를 넣는다
 */
export function createMeter(total, now = defaultNow) {
  const t0 = now();
  let lastT = t0;
  let lastDone = 0;
  let rate = 0; // 장/초 (지수평균)
  return {
    update(done) {
      const t = now();
      const dt = t - lastT;
      if (dt >= 250 || done >= total) {
        if (dt > 0 && done > lastDone) {
          const inst = (done - lastDone) / (dt / 1000);
          rate = rate ? rate * 0.7 + inst * 0.3 : inst;
        }
        lastT = t;
        lastDone = done;
      }
      const elapsedMs = Math.max(0, t - t0);
      const overall = elapsedMs > 0 ? done / (elapsedMs / 1000) : 0;
      const fps = rate || overall;
      let etaMs = null;
      if (done >= total) etaMs = 0;
      else if (fps > 0 && done >= WARMUP_FRAMES && elapsedMs >= WARMUP_MS) etaMs = Math.round(((total - done) / fps) * 1000);
      return { done, total, fraction: total > 0 ? Math.min(1, done / total) : 1, elapsedMs, etaMs, fps };
    },
  };
}

/** 1분 05초 · 45초 · 1시간 2분 */
export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분`;
  if (s >= 60) return `${Math.floor(s / 60)}분 ${String(s % 60).padStart(2, '0')}초`;
  return `${s}초`;
}

/** 화면에 보일 남은 시간 한 줄 (해요체) */
export function fmtEta(etaMs) {
  if (etaMs == null) return '남은 시간을 계산하는 중이에요';
  if (etaMs < 5000) return '곧 끝나요';
  if (etaMs < 60000) return `약 ${Math.max(5, Math.round(etaMs / 5000) * 5)}초 남았어요`;
  const min = Math.round(etaMs / 60000);
  if (min >= 60) return `약 ${Math.floor(min / 60)}시간 ${min % 60}분 남았어요`;
  return `약 ${min}분 남았어요`;
}
