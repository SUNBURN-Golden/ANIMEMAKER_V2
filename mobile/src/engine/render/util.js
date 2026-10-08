// 영상 엔진 공용 도구: 멈춤 신호 · 캔버스 만들기 · 화면이 숨 쉴 틈(yieldToUI) · 시각
//   yieldToUI()  오래 걸리는 반복문 사이에 불러 주면 화면이 다시 그려지고 [그만두기] 버튼이 눌린다.
//   createPacer() 프레임마다 pacer.tick() 만 부르면 알아서 적당히 쉰다 (일정 시간마다 쉬고, 가끔은 화면이 실제로 그려질 때까지 기다린다).

/** 이미 멈춘 일에서 던지는 오류. jobs.js 의 runJob 이 name === 'AbortError' 로 "그만뒀어요" 를 알아본다 */
export function abortError(msg = '그만뒀어요') {
  const e = new Error(msg);
  e.name = 'AbortError';
  return e;
}
export const isAbortError = (e) => !!e && (e.name === 'AbortError' || e.code === 20);
export function throwIfAborted(signal, msg) {
  if (signal && signal.aborted) throw abortError(msg);
}

export const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/** 캔버스 한 장. 기본은 OffscreenCanvas(화면 밖), dom:true 면 <canvas> (미리보기·SVG 필터가 필요한 곳) */
export function makeCanvas(w, h, { dom = false } = {}) {
  if (!dom && typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  throw new Error('이 환경에서는 그림판(canvas)을 쓸 수 없어요. 안드로이드 시스템 WebView 를 최신으로 업데이트해 주세요.');
}

/** 영상 한 장 그리는 컨텍스트: 불투명 · 읽기 최적화 끔(GPU 에 두기) · 고품질 보간 */
export function frameContext(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
  if (!ctx) throw new Error('그림판을 열지 못했어요. 안드로이드 시스템 WebView 를 최신으로 업데이트해 주세요.');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

export async function canvasToBlob(canvas, type = 'image/png', quality) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('그림을 파일로 만들지 못했어요'))), type, quality);
  });
}

// ---------- 화면이 숨 쉴 틈 ----------
let channel = null;
const waiters = [];

/**
 * 다음 작업 차례로 한 번 양보한다. setTimeout(0) 은 연달아 쓰면 4ms 이상 기다리고 숨은 화면(백그라운드)에서는 1초에 한 번으로 느려지지만,
 * MessageChannel 은 그렇지 않아서 화면을 닫고 다른 앱에 가 있어도 영상 만들기가 계속 돈다.
 */
export function yieldToUI() {
  if (typeof MessageChannel === 'undefined') {
    return new Promise((resolve) => (typeof setImmediate === 'function' ? setImmediate(resolve) : setTimeout(resolve, 0)));
  }
  if (typeof window === 'undefined' && typeof setImmediate === 'function') return new Promise((resolve) => setImmediate(resolve)); // Node 시험
  if (!channel) {
    channel = new MessageChannel();
    channel.port1.onmessage = () => {
      const list = waiters.splice(0);
      for (const f of list) f();
    };
  }
  return new Promise((resolve) => {
    waiters.push(resolve);
    channel.port2.postMessage(0);
  });
}

/** 화면이 실제로 한 번 그려질 때까지 기다린다 (숨은 화면이면 기다리지 않는다, timeoutMs 가 지나면 그냥 간다) */
export function nextPaint(timeoutMs = 80) {
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  if (typeof requestAnimationFrame !== 'function' || hidden) return yieldToUI();
  return new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(fin);
    setTimeout(fin, timeoutMs);
  });
}

/**
 * 반복문 한가운데에서 `await pacer.tick()`. sliceMs 마다 한 번 양보하고, paintMs 마다 화면이 그려질 때까지 기다린다.
 * @param {{sliceMs?:number, paintMs?:number, now?:()=>number}} [o]
 */
export function createPacer({ sliceMs = 24, paintMs = 250, now = nowMs } = {}) {
  let lastYield = now();
  let lastPaint = lastYield;
  return {
    async tick() {
      const t = now();
      if (t - lastPaint >= paintMs) {
        await nextPaint();
        lastPaint = lastYield = now();
      } else if (t - lastYield >= sliceMs) {
        await yieldToUI();
        lastYield = now();
      }
    },
  };
}
