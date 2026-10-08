// 받은 그림 정리하기의 앱 쪽 얼굴: 배경 빼기 일꾼(key.worker.js)에 일을 맡기고 결과를 받는다.
// 일꾼에는 한 번에 한 장씩만 보내고(줄을 세움), 멈추라는 신호(AbortSignal)가 오면 일꾼을 끝내고 다음 일에는 새로 만든다.
// 일꾼을 쓸 수 없는 폰이면 같은 코드(key-core.js)를 앱 쪽에서 그대로 돌린다 (느리지만 된다).
import { ingestImage, plateOf } from '../engine-workers/key-core.js';
import { abortError } from './util.js';

const BAD = '그림 파일을 읽지 못했어요. 다른 파일로 해 보세요.';

/**
 * @param {{workerUrl?:string, createWorker?:(url:string)=>Worker, inline?:boolean}} [o] inline:true 면 일꾼 없이 앱 쪽에서 돈다
 */
export function createIngestor({ workerUrl = 'key.worker.js', createWorker = null, inline = false } = {}) {
  let worker = null;
  let seq = 0;
  let chain = Promise.resolve();
  let useInline = inline || (typeof Worker === 'undefined' && !createWorker);

  function ensure() {
    if (worker) return worker;
    try {
      worker = createWorker ? createWorker(workerUrl) : new Worker(workerUrl);
    } catch (_) {
      useInline = true;
      return null;
    }
    return worker;
  }

  function drop() {
    if (worker) { try { worker.terminate(); } catch (_) { /* 이미 끝남 */ } }
    worker = null;
  }

  function viaWorker(msg, signal) {
    return new Promise((resolve, reject) => {
      const w = ensure();
      if (!w) { reject(Object.assign(new Error('worker'), { fallback: true })); return; }
      const id = ++seq;
      let done = false;
      const finish = (fn, v) => {
        if (done) return;
        done = true;
        w.onmessage = null;
        w.onerror = null;
        if (signal) signal.removeEventListener('abort', onAbort);
        fn(v);
      };
      const onAbort = () => { drop(); finish(reject, abortError('그림 정리를 멈췄어요')); };
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      w.onmessage = (ev) => {
        const r = ev.data || {};
        if (r.id !== id) return;
        if (r.ok === false) finish(reject, Object.assign(new Error(r.error || BAD), { code: r.code }));
        else finish(resolve, r);
      };
      w.onerror = (e) => { drop(); finish(reject, new Error(`그림을 정리하다 문제가 생겼어요: ${(e && e.message) || ''}`)); };
      try {
        w.postMessage({ id, ...msg });
      } catch (e) {
        drop();
        finish(reject, e);
      }
    });
  }

  function run(msg, signal, local) {
    const job = chain.catch(() => {}).then(async () => {
      if (signal && signal.aborted) throw abortError('그림 정리를 멈췄어요');
      if (!useInline) {
        try {
          return await viaWorker(msg, signal);
        } catch (e) {
          if (!e || !e.fallback) throw e;
          useInline = true;
        }
      }
      if (signal && signal.aborted) throw abortError('그림 정리를 멈췄어요');
      return local(msg);
    });
    chain = job.catch(() => {});
    return job;
  }

  return {
    /**
     * @param {Blob} blob 받은 그림
     * @param {{kind:'cel'|'pic', keyColor?:string, refStats?:object|null, strength?:number, maxSide?:number, exactKey?:boolean, wantHash?:boolean, signal?:AbortSignal}} o
     * @returns {Promise<{w:number, h:number, orig:Blob, keyed:boolean|null, cel?:Blob, source?:string, stats?:object|null, reason?:string, hash?:number}>}
     */
    ingest(blob, { signal, ...o } = {}) {
      return run({ type: 'ingest', blob, ...o }, signal, (m) => ingestImage(m));
    },
    /** 셀 + 배경색 = 고쳐 달라고 붙일 그림(PNG Blob) */
    async plate(celBlob, keyColor, { signal } = {}) {
      const r = await run({ type: 'plate', blob: celBlob, keyColor }, signal, async (m) => ({ plate: await plateOf(m) }));
      return r.plate;
    },
    get mode() { return useInline ? 'inline' : 'worker'; },
    dispose: drop,
  };
}
