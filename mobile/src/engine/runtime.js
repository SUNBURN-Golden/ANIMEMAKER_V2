// 작품 하나를 돌리는 곳(런타임): 메모리에 있는 작품 기록 + 그림 기록, 저장, 기록(log), 상태 알림, 오래 걸리는 일 맡기기.
// 모든 일은 '작품 id 로 만든 이 객체'를 붙들고 돈다 — 화면의 전역 변수는 읽지 않는다 (V1 의 뒤로가기 버그 D1 방지).
import { runJob, cancelJob } from '../jobs.js';
import { clone, createChains, abortError, pad2 } from './util.js';
import { LOG_KEEP, STEPS } from './model.js';
import { buildSnapshot } from './snapshot.js';
import { blobKeysOf, drawingKey } from './keys.js';

const stamp = (ms) => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

/**
 * 앱이 작업 도중에 꺼졌다 켜졌을 때 바로잡는다 (저장소에서 읽은 직후 한 번).
 *  - 영상 만드는 중('running')이었으면 '중지됨'. 기다리는 중('waiting': AI 앱 부탁·확인)은 저장돼 있으니 그대로 둔다.
 *  - 받아서 정리하던 그림('running')은 이전 상태로: 그림이 있으면 'done'(배경 빼기는 다음 영상 만들기 때 다시), 없으면 'pending'
 *  - 다시 그리는 중이던 요청은 '줄 서 있음'으로
 * @returns {{project:boolean, items:object[]}} 바뀐 것
 */
export function settleLoaded(p, items) {
  const out = { project: false, items: [] };
  if (p.status === 'running' || p.status === 'limited') {
    p.status = 'stopped';
    p.waiting = null;
    out.project = true;
  }
  for (const step of STEPS) {
    const st = p.steps && p.steps[step];
    if (st && st.status === 'running') { st.status = 'stopped'; st.message = '중지됨 (앱이 꺼졌어요)'; out.project = true; }
    if (st && st.status === 'waiting' && p.status !== 'waiting') { st.status = 'stopped'; st.message = '중지됨'; out.project = true; }
  }
  for (const r of p.redraws || []) if (r.status === 'running') { r.status = 'queued'; out.project = true; }
  for (const it of items) {
    if (it.status !== 'running') continue;
    if (it.file) {
      it.status = 'done';
      if (it.kind !== 'bg') Object.assign(it, { keyed: null, cel: null, stats: null });
    } else {
      it.status = 'pending';
    }
    out.items.push(it);
  }
  return out;
}

export class ProjectRuntime {
  constructor(engine, p, items = []) {
    this.engine = engine;
    this.db = engine.db;
    this.p = p;
    this.drawings = new Map(items.map((d) => [d.key, d]));
    this.running = false; // 영상 만들기(파이프라인)가 돌고 있는가 (AI 앱 답장을 기다리는 동안은 false)
    this.ctl = null; // 지금 도는 파이프라인의 멈춤 신호
    this.runPromise = null;
    this.progressHook = null; // 영상 만들기 진행을 받을 쪽 (engine.render.run 의 onProgress)
    this.deleted = false;
    this._planning = false;
    this._saving = null;
    this._dirty = false;
    this._emitQueued = false;
    this._exclusive = createChains();
  }

  get id() { return this.p.id; }
  get wf() { return this.p.workflow; }
  get series() { return this.p.series || null; }
  get xs() { return this.p.xsheet; }
  get layers() { return !!(this.p.xsheet && this.p.xsheet.layers); }
  now() { return this.engine.now(); }
  get services() { return this.engine.services; }

  // ───── 저장 ─────
  /** 작품 기록 저장 (겹치는 저장은 한 번으로 합친다). 끝나면 그 시점까지의 변경이 저장돼 있다 */
  save() {
    if (this.deleted) return Promise.resolve();
    this._dirty = true;
    if (!this._saving) {
      this._saving = (async () => {
        try {
          while (this._dirty && !this.deleted) {
            this._dirty = false;
            const rec = clone(this.p);
            await this.db.putProject(rec);
            this.p.updatedAt = rec.updatedAt;
          }
        } finally {
          this._saving = null;
        }
      })();
    }
    return this._saving;
  }

  /** 기다리지 않고 저장 (오류는 알림으로) */
  saveSoon() {
    this.save().catch((e) => this.engine.reportError(e));
  }

  async saveItem(it) {
    if (this.deleted) return it;
    this.drawings.set(it.key, it);
    const rec = clone(it);
    await this.db.putDrawing(rec);
    it.updatedAt = rec.updatedAt;
    return it;
  }

  async saveItems(list) {
    if (this.deleted || !list.length) return list;
    for (const it of list) this.drawings.set(it.key, it);
    const recs = list.map((it) => clone(it));
    await this.db.putDrawings(recs);
    list.forEach((it, i) => { it.updatedAt = recs[i].updatedAt; });
    return list;
  }

  /** 그림 기록 한 줄과 그 덩어리들을 지운다 */
  async removeItem(key) {
    const it = this.drawings.get(key);
    this.drawings.delete(key);
    await this.db.deleteDrawing(this.id, key);
    if (it) for (const k of blobKeysOf(it)) await this.db.deleteFile(k);
  }

  getBlob(key) { return key ? this.db.getFile(key) : Promise.resolve(null); }
  putBlob(key, blob) { return this.db.putFile(key, blob); }
  delBlob(key) { return key ? this.db.deleteFile(key) : Promise.resolve(); }

  // ───── 상태 · 기록 ─────
  itemOf(shotNo, id) { return this.drawings.get(drawingKey(shotNo, id)) || null; }
  items() { return [...this.drawings.values()]; }
  busyKeying() { return this.items().some((it) => it.status === 'running') || (this.p.redraws || []).some((r) => r.status === 'running'); }

  log(msg) {
    const line = `[${stamp(this.now())}] ${msg}`;
    const tail = this.p.logTail || (this.p.logTail = []);
    tail.push(line);
    if (tail.length > LOG_KEEP) tail.splice(0, tail.length - LOG_KEEP);
    this.engine.emit('log', { projectId: this.id, line });
  }

  /** 단계 상태 바꾸기 (저장은 안 한다 — 진행 표시가 자주 바뀌므로. 중요한 전환에서는 save() 를 부른다) */
  setStep(step, patch) {
    this.p.steps[step] = { ...(this.p.steps[step] || {}), ...patch };
    this.p.currentStep = step;
    this.emit();
  }

  snapshot() { return buildSnapshot(this); }

  /** 화면에 알림 (같은 순간에 여러 번 바뀌어도 한 번으로 합친다) */
  emit() {
    if (this._emitQueued || this.deleted) return;
    this._emitQueued = true;
    Promise.resolve().then(() => {
      this._emitQueued = false;
      if (!this.deleted) this.engine.emit('update', this.snapshot());
    });
  }

  /** 바뀐 장면을 적어 둔다 (다음 영상 만들기가 끝나면 지워진다). 영상이 오래된 것이 된다 */
  markDirty(...shots) {
    const set = new Set(this.p.dirtyShots || []);
    for (const s of shots) if (Number.isFinite(s)) set.add(s);
    this.p.dirtyShots = [...set].sort((a, b) => a - b);
    this.p.renderStale = true;
  }

  // ───── 일 맡기기 ─────
  /** 같은 이름의 일은 한 줄로 세워 차례로 (같은 작품에서 그림 정리가 겹치지 않게) */
  exclusive(name, fn) { return this._exclusive(name, fn); }

  /**
   * 오래 걸리는 일을 jobs.js 지킴이 아래에서 돌린다. 끝난 값을 돌려주고, 그만뒀으면 AbortError, 실패면 그 오류를 던진다.
   * 파이프라인을 멈추면(stop) 이 일도 같이 그만둔다.
   * @param {string|null} sub 일 이름 뒤붙이: null 이면 작품 id 그대로(노래 분석 · 영상 · 자막), 'key' 면 '<id>:key'(받은 그림 정리)
   */
  async heavy(sub, opts, fn) {
    const jobId = sub ? `${this.id}:${sub}` : this.id;
    const ctl = this.ctl;
    const onAbort = () => cancelJob(jobId);
    if (ctl) {
      if (ctl.signal.aborted) throw abortError();
      ctl.signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const res = await runJob(jobId, fn, opts);
      if (res.status === 'done') return res.value;
      if (res.status === 'cancelled') throw abortError('그만뒀어요');
      throw res.error || new Error('일을 마치지 못했어요');
    } finally {
      if (ctl) ctl.signal.removeEventListener('abort', onAbort);
    }
  }

  /** 멈추기: 파이프라인과 맡긴 일(노래 분석 · 그림 정리 · 영상 · 자막)을 모두 그만두게 한다 */
  stopAll() {
    if (this.ctl) this.ctl.abort();
    cancelJob(this.id);
    cancelJob(`${this.id}:key`);
  }
}
