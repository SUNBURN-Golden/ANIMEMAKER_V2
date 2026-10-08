// 연습 모드(engine.demo): 글 답장과 그림을 연습용으로 자동으로 채워서, 오프라인에서 한 번에 에피소드 하나를 끝까지 만든다.
// 진짜 AI 앱을 거치는 길과 똑같은 문(acceptText · acceptFiles · continueReview)으로 들어가서, 번호(nonce) 검사·그림 정리(배경 빼기)·저장까지 모두 시험된다.
import { DD, SC, CC } from './shared.js';
import { buildXsheetContext } from './workflows.js';
import { demoPicture } from './pipeline.js';
import { abortError } from './util.js';

/**
 * @param {{db:object, services:object, now:()=>number, loadRuntime:Function, whenIdle:Function, run:Function, continueReview:Function, handoff:object}} engine 엔진의 공개 입구들
 */
export function createDemoApi(engine) {
  const { db } = engine;

  /** 기다리는 것을 연습용 답으로 하나 채운다. 채웠으면 true */
  async function answerOnce(id, rt) {
    const w = rt.p.waiting;
    if (!w) return false;
    const req = w.kind === 'review' ? null : await engine.handoff.request(id);
    if (w.kind === 'review') return engine.continueReview(id);
    if (w.kind === 'plan') {
      const r = await engine.handoff.acceptText(id, JSON.stringify({ ...DD.demoPlan(rt.p.topic, rt.wf, rt.series), request_id: req.nonce }));
      if (!r.ok) throw new Error(r.message);
      return true;
    }
    if (w.kind === 'xsheet') {
      const raw = DD.demoXsheet(buildXsheetContext(rt.p, rt.series));
      const r = await engine.handoff.acceptText(id, JSON.stringify({ ...raw, request_id: req.nonce }));
      if (!r.ok) throw new Error(r.message);
      return true;
    }
    if (w.kind === 'bg' || w.kind === 'cel') {
      const it = rt.drawings.get(w.itemKey);
      const blob = await demoPicture(rt, it);
      const r = await engine.handoff.acceptFiles(id, [{ name: `${it.key.replace(':', '_')}.png`, mime: 'image/png', blob }], { slotKey: it.key });
      if (!r.placed.length) throw new Error(r.failed[0] ? r.failed[0].message : '연습 그림을 넣지 못했어요.');
      return true;
    }
    return false;
  }

  return {
    /**
     * 작품을 끝까지 만든다 (이야기 · 그림 순서표 · 그림 · 영상 · 자막). 이미 만든 단계는 건너뛴다. 끝나면 snapshot 을 돌려준다.
     * @param {string} id
     * @param {{maxRounds?:number}} [o]
     */
    async fill(id, { maxRounds = 400 } = {}) {
      const rt = await engine.loadRuntime(id);
      let started = false; // 이 호출이 이미 무언가를 시작/이어 갔는가 (그 뒤에 '중지됨' 이면 사용자가 멈춘 것)
      for (let round = 0; round < maxRounds; round++) {
        await engine.whenIdle(id);
        const { p } = rt;
        if (p.status === 'done') return rt.snapshot();
        if (p.status === 'error') throw new Error(p.error || '만들다가 문제가 생겼어요.');
        if (p.status === 'stopped' && started) throw abortError('만들기를 멈췄어요');
        started = true;
        if (p.status === 'waiting') {
          if (!(await answerOnce(id, rt))) throw new Error('연습 모드가 채울 수 없는 부탁이에요.');
        } else {
          await engine.run(id);
        }
      }
      throw new Error('연습 모드가 끝나지 않았어요.');
    },

    /**
     * 연습용 시리즈(주인공 '하루' 한 명, 잠긴 상태, 기준 그림 1장)를 저장소에 만든다. 이미 있으면 그대로 돌려준다.
     * @returns {Promise<string>} 시리즈 id
     */
    async ensureSeries() {
      const found = (await db.listSeries()).find((s) => s.name === '연습 시리즈');
      if (found) return found.id;
      const cid = db.newId('char');
      const sheet = await engine.services.demo.ref({ kind: 'turnaround', palette: DD.DEMO_CHARACTER.palette });
      const key = `char/${cid}/1`;
      await db.putFile(key, sheet);
      const base = CC.normalizeCharacter({ ...DD.DEMO_CHARACTER, id: cid, lockedAt: engine.now() });
      await db.putCharacter({ ...base, refs: [{ kind: 'turnaround', label: '앞·옆·뒤', mime: sheet.type || 'image/png', blobKey: key }] });
      const sid = SC.newSeriesId();
      await db.putSeries(SC.normalizeSeries({ id: sid, name: '연습 시리즈', emoji: '🧪', characterIds: [cid] }));
      return sid;
    },
  };
}
