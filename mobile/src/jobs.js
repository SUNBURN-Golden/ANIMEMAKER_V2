// 오래 걸리는 일 지킴이 — 일하는 중에 화면을 떠나도, 뒤로가기를 눌러도 하던 일과 결과를 잃지 않게 한다.
//
// V1 에서 재현된 문제(D1): 영상 만드는 중 뒤로가기 → 화면이 닫히며 '지금 열린 작품' 변수가 null 이 되고, 일은 계속 돌다가
// 끝난 뒤 그 변수를 읽다 오류가 나서 완성 영상이 버려졌다. 그래서 V2 는
//   1) 일은 시작할 때 받은 작품 id 만 붙들고 (화면의 전역 변수를 읽지 않고), 결과를 그 id 로 저장소에 쓴다.
//   2) 일하는 중 뒤로가기는 "그만둘까요, 계속 할까요?" 를 먼저 묻는다. 계속 하면 아무 일도 없고, 그만두면 취소 신호(AbortSignal)를 보낸다.
//   3) runJob 은 절대 reject 하지 않고 { status:'done'|'cancelled'|'failed' } 로 끝나서, 처리 안 된 오류가 일을 지우지 않는다.
//
// 이 파일은 화면(DOM)을 직접 만지지 않는다. 화면 부품은 setJobUi(createJobUi()) 로 꽂고(ui.js), 알림줄·화면 켜 두기는 setJobHooks 로 꽂는다.
// (그래서 Node 에서 바로 시험할 수 있다)

const running = new Map(); // id → job
const listeners = new Set();
let ui = null; // { begin(job)→{update,cancelling,end}|null, ask(q)→Promise<boolean>, dismissAsk() }
let hooks = {}; // { start(job), progress(job), end(job, status) }
let asking = null; // 뒤로가기 질문이 떠 있는 동안의 약속

export const BACK_QUESTION = '그만둘까요, 계속 할까요?';

export function setJobUi(next) {
  ui = next || null;
}

export function setJobHooks(next) {
  hooks = next || {};
}

function safe(fn) {
  try { return fn(); } catch (_) { return undefined; }
}

function isAbort(e) {
  return !!e && (e.name === 'AbortError' || e.code === 20);
}

function abortError() {
  return typeof DOMException === 'function' ? new DOMException('그만뒀어요', 'AbortError') : Object.assign(new Error('그만뒀어요'), { name: 'AbortError' });
}

function snapshot(j) {
  return {
    id: j.id,
    title: j.title,
    modal: j.modal,
    foreground: j.foreground,
    cancelable: j.cancelable,
    progress: j.progress,
    message: j.message,
    startedAt: j.startedAt,
    cancelRequested: j.cancelRequested,
  };
}

function emit() {
  const list = listJobs();
  for (const cb of [...listeners]) safe(() => cb(list));
}

/**
 * 오래 걸리는 일을 지킴이 아래에서 돌린다.
 * @param {string} id 일의 주인(보통 작품 id). 같은 id 로 이미 도는 일이 있으면 새로 시작하지 않고 그 일의 결과를 같이 기다린다.
 * @param {(ctx:{id:string, signal:AbortSignal, progress:(frac?:number, message?:string)=>void, isCancelled:()=>boolean})=>Promise<any>} fn
 *        결과는 id 로 저장소에 쓴다 (화면 변수를 읽지 말 것). signal 이 abort 되면 중간에 멈추고 AbortError 를 던지면 된다.
 * @param {object} [opts]
 * @param {string} [opts.title='일하는 중…'] 덮개와 알림줄에 보일 이름 (예: '영상 만드는 중')
 * @param {boolean} [opts.modal=true] true 면 덮개를 띄우고 뒤로가기 때 묻는다. false 는 조용히 도는 일(예: 받은 그림 배경 빼기)
 * @param {boolean} [opts.foreground=false] true 면 알림줄 서비스·화면 켜 두기를 쓴다 (hooks 로 연결)
 * @param {boolean} [opts.cancelable=true] false 면 [그만두기] 가 없고 뒤로가기는 그냥 무시된다
 * @param {(job)=>void} [opts.onCancel] 그만둘 때 불린다 (Worker 끝내기 등 signal 을 못 읽는 일을 멈추는 곳). signal 이 먼저 abort 된다.
 * @param {number} [opts.cancelTimeoutMs=10000] 그만두라고 한 뒤 이만큼 지나도 일이 안 끝나면 기다림을 풀고 'cancelled'(abandoned) 로 끝낸다. 0 이면 끝까지 기다린다.
 * @returns {Promise<{id:string, status:'done'|'cancelled'|'failed', value?:any, error?:Error, cancelRequested:boolean, abandoned?:boolean}>}
 */
export function runJob(id, fn, opts = {}) {
  if (typeof fn !== 'function') throw new TypeError('runJob: 두 번째 인자는 함수여야 해요');
  const existing = running.get(id);
  if (existing) return existing.promise;

  const job = {
    id,
    title: opts.title || '일하는 중…',
    modal: opts.modal !== false,
    foreground: !!opts.foreground,
    cancelable: opts.cancelable !== false,
    onCancel: typeof opts.onCancel === 'function' ? opts.onCancel : null,
    cancelTimeoutMs: opts.cancelTimeoutMs == null ? 10000 : opts.cancelTimeoutMs,
    startedAt: Date.now(),
    progress: null,
    message: '',
    cancelRequested: false,
    controller: new AbortController(),
    uiHandle: null,
    timer: null,
    promise: null,
    cancel: () => cancelJob(id),
  };
  running.set(id, job);

  let finished = false;
  let settle;
  job.promise = new Promise((r) => { settle = r; });
  const finish = (status, extra = {}) => {
    if (finished) return;
    finished = true;
    if (job.timer) clearTimeout(job.timer);
    if (running.get(id) === job) running.delete(id);
    safe(() => job.uiHandle && job.uiHandle.end && job.uiHandle.end(job));
    safe(() => hooks.end && hooks.end(job, status));
    emit();
    settle({ id, status, cancelRequested: job.cancelRequested, ...extra });
  };
  job.abandon = () => finish('cancelled', { abandoned: true });

  const progress = (frac, message) => {
    if (finished) return;
    if (typeof frac === 'number' && Number.isFinite(frac)) job.progress = Math.max(0, Math.min(1, frac));
    if (message) job.message = message;
    safe(() => job.uiHandle && job.uiHandle.update && job.uiHandle.update(job));
    safe(() => hooks.progress && hooks.progress(job));
    emit();
  };

  job.uiHandle = safe(() => (ui && ui.begin ? ui.begin(job) : null)) || null;
  safe(() => hooks.start && hooks.start(job));
  emit();

  (async () => {
    try {
      const value = await fn({ id, signal: job.controller.signal, progress, isCancelled: () => job.cancelRequested });
      finish('done', { value }); // 그만두라고 했어도 이미 끝난 일은 버리지 않는다 (cancelRequested 로 알 수 있다)
    } catch (error) {
      finish(job.cancelRequested || isAbort(error) ? 'cancelled' : 'failed', { error });
    }
  })();

  return job.promise;
}

/** 도는 일 그만두기. 도는 일이 없으면 false */
export function cancelJob(id) {
  const job = running.get(id);
  if (!job) return false;
  if (job.cancelRequested) return true;
  job.cancelRequested = true;
  safe(() => job.controller.abort(abortError()));
  safe(() => job.onCancel && job.onCancel(snapshot(job)));
  safe(() => job.uiHandle && job.uiHandle.cancelling && job.uiHandle.cancelling(job));
  if (job.cancelTimeoutMs > 0) job.timer = setTimeout(() => job.abandon(), job.cancelTimeoutMs);
  emit();
  return true;
}

/** 그 id 의 일이 끝날 때까지 기다리는 약속 (도는 일이 없으면 바로 null). 결과는 runJob 이 돌려주는 것과 같다 */
export function waitForJob(id) {
  const job = running.get(id);
  return job ? job.promise : Promise.resolve(null);
}

export function cancelAll() {
  let n = 0;
  for (const id of [...running.keys()]) if (cancelJob(id)) n++;
  return n;
}

/** id 를 주면 그 일이, 안 주면 아무 일이든 도는 중인가 */
export function isJobRunning(id) {
  return id === undefined ? running.size > 0 : running.has(id);
}

export function listJobs() {
  return [...running.values()].map(snapshot);
}

/** 도는 일 목록이 바뀔 때(시작·진행·그만둠·끝) 불린다. 끄는 함수를 돌려준다. */
export function onJobsChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * 뒤로가기 버튼이 눌렸을 때 먼저 부른다.
 *   'none'      덮개가 필요한 일이 없다 → 호출한 쪽이 평소처럼 뒤로가기를 처리한다
 *   'continue'  일이 계속된다 (계속 하기를 골랐거나, 이미 그만두는 중이거나, 그만둘 수 없는 일) → 뒤로가기는 여기서 끝
 *   'cancelled' 그만두기를 골라 일을 멈췄다 → 이번 뒤로가기는 그것으로 끝 (화면은 그대로)
 * 질문이 떠 있는 동안 뒤로가기를 또 누르면 질문을 닫고(= 계속 하기) 'continue'.
 * @param {{ask?:(q:object)=>Promise<boolean>, dismiss?:()=>void}} [o] 시험용으로 질문 창을 바꿔 끼울 수 있다
 */
export function guardBack(o = {}) {
  if (asking) {
    safe(o.dismiss || (ui && ui.dismissAsk));
    return Promise.resolve('continue');
  }
  const targets = [...running.values()].filter((j) => j.modal);
  if (!targets.length) return Promise.resolve('none');
  if (targets.some((j) => !j.cancelable) || targets.every((j) => j.cancelRequested)) return Promise.resolve('continue');
  const askFn = o.ask || (ui && ui.ask);
  if (!askFn) return Promise.resolve('continue'); // 물어볼 수 없으면 일을 지키는 쪽으로
  const first = targets[0];
  const more = targets.length > 1 ? ` 외 ${targets.length - 1}개` : '';
  asking = (async () => {
    let stop = false;
    try {
      stop = (await askFn({
        title: BACK_QUESTION,
        text: `지금 '${first.title}'${more} 하는 중이에요.\n그만두면 하던 일이 멈춰요. 지금까지 끝난 것은 그대로 남아요.`,
        stopLabel: '그만두기',
        keepLabel: '계속 하기',
        jobs: targets.map(snapshot),
      })) === true;
    } catch (_) {
      stop = false;
    }
    if (!stop) return 'continue';
    const still = targets.filter((j) => running.get(j.id) === j);
    if (!still.length) return 'none'; // 묻는 사이에 일이 끝났다 (결과는 이미 저장됐다)
    await Promise.all(still.map((j) => { cancelJob(j.id); return j.promise; }));
    return 'cancelled';
  })().finally(() => { asking = null; });
  return asking;
}

/** 뒤로가기 질문이 떠 있는가 */
export function isAsking() {
  return asking !== null;
}

/** 시험용: 모든 상태 지우기 (일은 취소하지 않고 목록만 비운다) */
export function _resetForTests() {
  for (const j of running.values()) if (j.timer) clearTimeout(j.timer);
  running.clear();
  listeners.clear();
  ui = null;
  hooks = {};
  asking = null;
}
