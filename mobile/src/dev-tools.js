// 개발·시험용 도구 (화면 안쪽을 새로 만들 때 지워도 되지만, e2e 의 '일 지킴이' 시험이 window.AnimeMaker.devJob 으로 쓴다)
import * as db from './db.js';
import * as jobs from './jobs.js';
import { toast } from './ui.js';

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) {
    const onAbort = () => { clearTimeout(t); reject(signal.reason || Object.assign(new Error('그만뒀어요'), { name: 'AbortError' })); };
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  }
});

/**
 * 오래 걸리는 일 시험: 작품 id 를 붙들고 일하고, 끝나면 그 id 로 결과(devResult)를 저장한다 (화면을 떠났어도 결과가 남는다).
 * 진짜 일(영상 만들기·배경 빼기)도 같은 방식으로 jobs.runJob 에 꽂는다. 끝나면 window 에 'am:job-done' 신호를 보낸다.
 * @returns {Promise<{id:string,status:string,...}>} runJob 의 결과
 */
export async function runDevJob(projectId, { steps = 6, stepMs = 500, title = '시험 일 하는 중…' } = {}) {
  const res = await jobs.runJob(projectId, async ({ signal, progress }) => {
    for (let i = 1; i <= steps; i++) {
      await sleep(stepMs, signal);
      progress(i / steps, `${i} / ${steps} 단계`);
    }
    const p = await db.getProject(projectId); // 시작할 때 받은 id 로 읽고 쓴다 (화면의 '지금 작품' 변수를 쓰지 않는다)
    if (p) { p.devResult = { at: Date.now(), steps }; await db.putProject(p); }
    return { steps };
  }, { title });
  if (res.status === 'done') toast('✅ 시험 일을 마쳤어요');
  else if (res.status === 'cancelled') toast('시험 일을 그만뒀어요', 'warn');
  else toast(`시험 일이 실패했어요: ${res.error && res.error.message}`, 'err');
  window.dispatchEvent(new CustomEvent('am:job-done', { detail: { id: projectId, status: res.status } }));
  return res;
}
