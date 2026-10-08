'use strict';
// 편집 메서드 모음: ProjectRunner.prototype 에 섞인다 (runner.js 맨 아래 Object.assign). DESIGN §3
//  - 그림 한 장/한 장면 다시 그리기 (낱장 대기열: 영상 만들기(running)와 따로 돈다) · 한국어로 고쳐 달라고 하기
//  - 이전 그림(history) 보관 · 되돌리기 · 내 그림으로 바꾸기
//  - 장면 넘기기 · 효과 · 장면 하나만 미리보기
//  - 고친 것 반영하기 (applyChanges) · 바뀐 장면 기록 (dirtyShots) · 스냅샷에 싣는 changes / canApply
//  - 그림 줄여서 빨리 (setMotion) · 예상 (estimateMotion)
// 순수 계산은 edits-core.js 에 있다. 이 파일의 `_` 로 시작하는 것은 안쪽 도우미다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EC = require('./edits-core');
const X = require('./xsheet');
const IB = require('../media/inbetween');
const { renderShot } = require('../media/render');
const { outputSize } = require('../media/assemble');
const { runFfmpeg } = require('../media/ffmpeg');

const FPS = 24;
const BG_ID = 'bg'; // 배경 판의 id (runner.js 와 같다)
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'];

function pad2(n) { return String(n).padStart(2, '0'); }
function sha1(x) { return crypto.createHash('sha1').update(JSON.stringify(x)).digest('hex'); }
function clone(x) { return JSON.parse(JSON.stringify(x)); }
function unlinkQuiet(f) { try { fs.unlinkSync(f); } catch (_) { /* 없으면 괜찮다 */ } }

module.exports = {
  // ================================================================ 낱장 다시 그리기 대기열

  /** 화면에 보내는 '다시 그리는 중' 목록: [{shot, id, status:'queued'|'running'}] (한가하면 []) */
  redrawingList() {
    const out = [];
    for (const job of this.redrawQueue) {
      for (const t of job.targets) {
        if (t.state === 'done') continue;
        out.push({ shot: job.shot, id: t.id, status: t.state === 'running' ? 'running' : 'queued' });
      }
    }
    return out;
  },

  /** 그림 항목을 화면에 돌려줄 모양으로 (복사본) */
  _view(it) { return it ? { ...it } : null; },

  _findJob(shot, id) {
    return this.redrawQueue.find((j) => !j.cancelled && j.shot === shot && j.targets.some((t) => t.id === id && t.state !== 'done')) || null;
  },

  _newJob(o) {
    const job = {
      kind: o.kind, shot: o.shot, note: o.note || '', prompt: o.prompt || null,
      targets: o.ids.map((id) => ({ id, state: 'queued' })),
      status: 'queued', cancelled: false, ctl: null,
    };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    job.promise.catch(() => {}); // 아무도 기다리지 않아도 '처리 안 된 거절' 이 되지 않게
    return job;
  },

  /**
   * 그림 한 장 다시 그리기. 영상 만들기(running)와 따로 도는 '낱장 대기열' 에 줄을 선다 (한 번에 하나씩, 들어온 순서대로).
   * 끝나면(또는 멈추면) 그림 항목을 돌려준다. 그림을 다시 그리는 중에도 카메라·시간·효과·자막은 고칠 수 있다.
   * @param {'drawing'} kind
   * @param {number} shotNo 컷 번호
   * @param {{id:string, prompt?:string, note?:string}} o id: 그림 id('A'…, 배경 판은 'bg') · note: 한국어 요청 ('웃는 얼굴로') · prompt: 영어 주문 글을 직접 고침(고급)
   * @returns {Promise<object>} 그림 항목 (+ cancelled:true 멈춤 / skipped:true 직접 넣기를 건너뜀). 못 그리면 쉬운 한국어 문장의 오류
   */
  async regenerate(kind, shotNo, { id, prompt, note } = {}) {
    if (kind !== 'drawing') throw new Error('알 수 없는 항목이에요.');
    if (this.running) throw new Error(EC.MSG.runningNoRedraw);
    if (this._planning) throw new Error(EC.MSG.planning);
    const it = typeof id === 'string' ? this.itemOf(shotNo, id) : null;
    if (!it || !this.p.xsheet || !this.shotOf(shotNo)) throw new Error(EC.MSG.noItem);
    const n = EC.normalizeNote(note);
    const pr = typeof prompt === 'string' && prompt.trim() && prompt !== it.prompt ? prompt : null;
    const dup = this._findJob(shotNo, id);
    if (dup) {
      // 이미 줄 서 있거나 그리는 중: 두 번 그리지 않는다. 아직 시작 전이면 마지막 부탁으로 바꿔 준다
      if (dup.status === 'queued' && dup.kind === 'one') { dup.note = n; dup.prompt = pr; }
      return dup.promise;
    }
    const job = this._newJob({ kind: 'one', shot: shotNo, ids: [id], note: n, prompt: pr });
    this.redrawQueue.push(job);
    this.emitUpdate();
    this._pumpRedraws();
    return job.promise;
  },

  /**
   * 이 장면의 그림 전부 다시 그리기: 배경 판 → 열쇠 그림 차례로 (앞 그림을 고쳐서 다음 그림을 그려서 이어짐이 유지된다).
   * 대기열에서는 일 하나로 돈다. 장면 안의 그림마다 redrawing 에 따로 보이고, 그림 항목의 status 도 하나씩 바뀐다. 그리기 전에 옛 그림은 모두 '이전 그림' 으로 남는다.
   * @returns {Promise<{shot:number, drawings:object[], cancelled?:boolean}>}
   */
  async regenerateCut(shotNo) {
    if (this.running) throw new Error(EC.MSG.runningNoRedraw);
    if (this._planning) throw new Error(EC.MSG.planning);
    const xs = this.p.xsheet;
    const shot = xs && this.shotOf(shotNo);
    if (!shot) throw new Error(xs ? EC.MSG.noShot : EC.MSG.noXsheet);
    const ids = [];
    if (xs.layers && this.itemOf(shotNo, BG_ID)) ids.push(BG_ID);
    for (const d of shot.drawings) if (this.itemOf(shotNo, d.id)) ids.push(d.id);
    if (!ids.length) throw new Error(EC.MSG.noItem);
    const mine = this.redrawQueue.find((j) => j.kind === 'cut' && j.shot === shotNo);
    if (mine) return mine.promise;
    if (this.redrawQueue.some((j) => j.shot === shotNo)) throw new Error('이 장면의 그림을 지금 다시 그리는 중이에요. 끝난 뒤에 눌러 주세요.');
    const job = this._newJob({ kind: 'cut', shot: shotNo, ids });
    this.redrawQueue.push(job);
    this.emitUpdate();
    this._pumpRedraws();
    return job.promise;
  },

  /** 대기열을 차례로 돌린다 (한 번에 하나). 끝난 일은 대기열에서 뺀 뒤에 부른 쪽에 알린다 */
  _pumpRedraws() {
    if (this._redrawPump) return;
    this._redrawPump = (async () => {
      try {
        while (this.redrawQueue.length) {
          const job = this.redrawQueue[0];
          let result = null;
          let error = null;
          try { result = await this._runRedrawJob(job); } catch (e) { error = e; }
          this.redrawQueue.shift();
          this.emitUpdate();
          if (error) job.reject(error); else job.resolve(result);
        }
      } finally {
        this._redrawPump = null;
      }
    })();
  },

  async _runRedrawJob(job) {
    const ctl = new AbortController(); // 이 일만의 중지 신호 (영상 만들기의 this.abort 와 따로)
    job.ctl = ctl;
    const finish = (extra = {}) => {
      const drawings = job.targets.map((t) => this._view(this.itemOf(job.shot, t.id))).filter(Boolean);
      return job.kind === 'cut' ? { shot: job.shot, drawings, ...extra } : { ...(drawings[0] || {}), ...extra };
    };
    if (job.cancelled || ctl.signal.aborted) return finish({ cancelled: true });
    job.status = 'running';
    let skipped = false;
    for (const t of job.targets) {
      if (job.cancelled || ctl.signal.aborted) { for (const x of job.targets) x.state = 'done'; return finish({ cancelled: true }); }
      const it = this.itemOf(job.shot, t.id);
      if (!it) { t.state = 'done'; continue; } // 그 사이 순서표가 바뀌어서 사라진 그림
      if (this.running) { for (const x of job.targets) x.state = 'done'; throw new Error(EC.MSG.runningNoRedraw); }
      t.state = 'running';
      this.emitUpdate();
      let r;
      try {
        r = await this._redrawItem(it, { note: job.kind === 'one' ? job.note : '', prompt: job.kind === 'one' ? job.prompt : null }, ctl);
      } catch (e) {
        for (const x of job.targets) x.state = 'done';
        if (job.kind === 'cut' && job.targets.length > 1) {
          const label = t.id === BG_ID ? '배경' : `그림 ${t.id}`;
          throw new Error(`컷 ${job.shot} 그림 전부 다시 그리기가 ${label}에서 멈췄어요. 앞에서 그린 그림은 새 그림으로 바뀌었어요. ${e.message}`);
        }
        throw e;
      }
      t.state = 'done';
      if (r && r.cancelled) { for (const x of job.targets) x.state = 'done'; return finish({ cancelled: true }); }
      if (r && r.skipped) skipped = true;
    }
    return finish(skipped ? { skipped: true } : {});
  },

  /**
   * 대기열에 줄 선 일을 모두 취소한다: 그리던 것은 멈추고 이전 그림으로, 기다리던 것은 없앤다 (stop() 이 부른다).
   * @returns {number} 취소한 일 수
   */
  cancelRedraws() {
    if (!this.redrawQueue.length) return 0;
    let n = 0;
    for (const job of [...this.redrawQueue]) {
      job.cancelled = true;
      n++;
      if (job.status === 'running') {
        // 멈추는 중: 화면(redrawing)에서는 바로 빼고, 이전 그림으로 되돌리는 일이 끝날 때까지만 대기열에 남겨 둔다 (그동안 영상 만들기는 시작되지 않는다)
        for (const t of job.targets) t.state = 'done';
        if (job.ctl) job.ctl.abort();
      } else {
        this.redrawQueue.splice(this.redrawQueue.indexOf(job), 1);
        for (const t of job.targets) t.state = 'done';
        const drawings = job.targets.map((t) => this._view(this.itemOf(job.shot, t.id))).filter(Boolean);
        job.resolve(job.kind === 'cut' ? { shot: job.shot, drawings, cancelled: true } : { ...(drawings[0] || {}), cancelled: true });
      }
    }
    this.log('■ 그림 다시 그리기를 멈췄어요.');
    this.emitUpdate();
    return n;
  },

  // ================================================================ 그림 한 장 다시 그리기 (실제 일)

  /** 되돌리기용으로 그림 항목의 칸들을 복사해 둔다 */
  _itemState(it) { return clone(it); },

  /** 이 그림의 파일들(원본 · 배경 뺀 셀 · 배경색 판)을 작업 폴더에 복사해 둔다 → { 칸이름: {rel, bak} } */
  _backupFiles(it) {
    const dir = path.join(this.dir, 'work', 'redraw', `${pad2(it.shot)}_${it.id}`);
    fs.mkdirSync(dir, { recursive: true });
    const out = {};
    for (const k of ['file', 'cel', 'plate']) {
      if (!it[k] || !this.exists(it[k])) continue;
      const bak = path.join(dir, `${k}${path.extname(it[k])}`);
      fs.copyFileSync(this.abs(it[k]), bak);
      out[k] = { rel: it[k], bak };
    }
    return { dir, files: out };
  },

  _dropBackup(backup) {
    if (backup) { try { fs.rmSync(backup.dir, { recursive: true, force: true }); } catch (_) { /* noop */ } }
  },

  /** 다시 그리다 실패/중지: 파일과 칸을 시작하기 전 상태로 되돌린다 (기록에 넣어 둔 복사본은 지운다) */
  _rollbackItem(it, before, backup, entry) {
    // 새로 만든 파일 중 옛 상태에 없던 것 지우기
    for (const k of ['file', 'cel', 'plate']) {
      if (it[k] && it[k] !== before[k]) unlinkQuiet(this.abs(it[k]));
    }
    // 옛 파일 되살리기
    if (backup) for (const { rel, bak } of Object.values(backup.files)) { try { fs.mkdirSync(path.dirname(this.abs(rel)), { recursive: true }); fs.copyFileSync(bak, this.abs(rel)); } catch (_) { /* noop */ } }
    for (const k of ['cel', 'plate']) if (!before[k] && it[k]) unlinkQuiet(this.abs(it[k]));
    if (entry) unlinkQuiet(this.abs(entry.file));
    for (const k of Object.keys(it)) if (!(k in before)) delete it[k];
    Object.assign(it, before);
  },

  /**
   * 지금 그림을 '이전 그림' 기록 맨 앞에 넣는다 (파일은 history 폴더로 복사 · move 면 옮김).
   * @param {{move?:boolean, withPrompt?:boolean, trim?:boolean}} [o] withPrompt: 이 그림을 그린 주문 글도 같이 적는다 (주문 글을 바꾸기 직전) · trim: 6개를 넘으면 가장 오래된 것부터 지운다
   * @returns {object|null} 기록 한 줄 (그림 파일이 없으면 null)
   */
  _archivePicture(it, { move = false, withPrompt = false, trim = false } = {}) {
    if (!it.file || !this.exists(it.file)) return null;
    const src = this.abs(it.file);
    const k = EC.nextVersion(it);
    const ext = path.extname(it.file).toLowerCase() || '.png';
    const dst = path.join(this.dir, 'drawings', 'history', EC.historyName(it.shot, it.id, k, ext));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (move) {
      try { fs.renameSync(src, dst); } catch (_) { fs.copyFileSync(src, dst); unlinkQuiet(src); }
    } else {
      fs.copyFileSync(src, dst);
    }
    const entry = { file: this.rel(dst), at: it.updatedAt || Date.now(), kind: it.source === 'user' ? 'user' : 'ai' };
    if (it.note) entry.note = it.note;
    if (withPrompt) { entry.prompt = it.prompt; if (it.promptEdited) entry.promptEdited = true; }
    if (it.source === 'user' && it.matchColors) entry.matchColors = true;
    it.vseq = k;
    it.history = EC.pushHistory(it.history, entry, Number.MAX_SAFE_INTEGER).history;
    if (trim) this._trimHistory(it);
    return entry;
  },

  /** 기록이 6개를 넘으면 가장 오래된 것부터 지운다 (파일도) */
  _trimHistory(it) {
    const list = it.history || [];
    if (list.length <= EC.HISTORY_MAX) return [];
    const dropped = list.splice(EC.HISTORY_MAX);
    for (const h of dropped) unlinkQuiet(this.abs(h.file));
    return dropped;
  },

  /** 타임시트를 다시 짜면서 버려지는 그림: 파일은 기록으로 옮기고, 새 항목이 이어받을 칸들을 돌려준다 (buildDrawings 가 쓴다) */
  _carryHistory(o) {
    const tmp = { shot: o.shot, id: o.id, file: o.file, history: Array.isArray(o.history) ? [...o.history] : [], vseq: o.vseq, updatedAt: o.updatedAt, source: o.source, note: o.note, matchColors: o.matchColors, prompt: o.prompt };
    if (o.file && this.exists(o.file)) {
      try { this._archivePicture(tmp, { move: true, withPrompt: true, trim: true }); } catch (_) { /* 옮기지 못해도 새 그림은 그려야 한다 */ }
    }
    const out = {};
    if (tmp.history.length) { out.history = tmp.history; out.vseq = tmp.vseq; }
    if (o.redraws) out.redraws = o.redraws;
    return out;
  },

  /**
   * 그림 한 장을 실제로 다시 그린다 (대기열 일꾼). 그리기 전에 지금 그림을 기록에 넣고, 실패하거나 멈추면 모든 것을 이전 상태로 되돌린다.
   * @returns {Promise<{ok?:true, cancelled?:true, skipped?:true}>}
   */
  async _redrawItem(it, { note, prompt }, ctl) {
    const label = it.kind === 'bg' ? `배경 컷${it.shot}` : `그림 컷${it.shot}-${it.id}`;
    const hadFile = this.exists(it.file);
    const before = this._itemState(it);
    const backup = hadFile ? this._backupFiles(it) : null;
    const promptChanged = !!(prompt && prompt !== it.prompt);
    // 지금 그림을 '이전 그림' 으로 (복사본: 앱이 꺼져도 잃지 않는다). 6개 정리는 새 그림이 성공한 뒤에
    const entry = hadFile ? this._archivePicture(it, { withPrompt: promptChanged }) : null;
    if (promptChanged) { it.prompt = prompt; it.custom = true; it.promptEdited = true; }
    if (note) { it.note = note; it.custom = true; }
    it.status = 'running';
    it.error = null;
    this.log(`🔄 ${label} 다시 그리기${note ? ` — "${note}"` : ''}`);
    this.save();
    try {
      const rel = await this.withRetry(label, () => this.drawOne(it, ctl, { note, variant: (it.redraws || 0) + 1 }), ctl);
      if (!rel) {
        // 도우미 모드에서 '건너뛰기' 를 눌렀다 → 아무것도 바꾸지 않는다
        this._rollbackItem(it, before, backup, entry);
        this.log(`ℹ ${label} 다시 그리기를 건너뛰었어요.`);
        this.save();
        return { skipped: true };
      }
      Object.assign(it, { file: rel, status: 'done', error: null, updatedAt: Date.now(), source: 'ai', redraws: (it.redraws || 0) + 1 });
      delete it.matchColors;
      if (note) it.note = note; else delete it.note;
      this._trimHistory(it);
      this.markDirty(it.shot);
      this.log(`✔ ${label} 다시 그리기 완료`);
      this.save();
      return { ok: true };
    } catch (e) {
      this._rollbackItem(it, before, backup, entry);
      if (e.name === 'AbortError') {
        this.log(`■ ${label} 다시 그리기를 멈췄어요. 이전 그림 그대로예요.`);
        this.save();
        return { cancelled: true };
      }
      const msg = EC.friendlyDrawError(e, it.kind === 'bg' ? '배경' : '그림');
      it.error = msg;
      if (!hadFile) it.status = 'error';
      this.log(`✖ ${label} 다시 그리기 실패: ${e.message}`);
      this.save();
      const err = new Error(msg);
      err.kind = e.kind;
      throw err;
    } finally {
      this._dropBackup(backup);
    }
  },

  // ================================================================ 내 그림으로 바꾸기 · 되돌리기

  /**
   * 내가 고른 그림 파일로 바꾼다 (인물 셀이면 배경 빼기까지). 옛 그림은 '이전 그림' 으로 남고, 이 그림은 custom(내가 바꿈)이 되어서
   * 나중에 타임시트를 다시 짜도 사라지지 않는다.
   * @param {{matchColors?:boolean}} [opts] matchColors: 같은 컷 첫 그림의 색에 맞춰 줄지 (기본 끔)
   * @returns {Promise<object>} 바뀐 그림 항목
   */
  async replaceItem(kind, shotNo, file, id, opts = {}) {
    if (kind !== 'drawing') throw new Error('알 수 없는 항목이에요.');
    const it = typeof id === 'string' ? this.itemOf(shotNo, id) : null;
    if (!it) throw new Error(EC.MSG.noItem);
    if (this._findJob(shotNo, id)) throw new Error(EC.MSG.itemBusy);
    if (it.status === 'running') throw new Error(EC.MSG.itemDrawing);
    this._assertNotRendering();
    if (!file || !fs.existsSync(file)) throw new Error(EC.MSG.noFile);
    const ext = path.extname(file).toLowerCase() || '.png';
    if (!IMAGE_EXTS.includes(ext)) throw new Error('그림 파일(png, jpg, webp)을 골라 주세요.');
    const dst = path.join(this.dir, 'drawings', `shot${pad2(shotNo)}_${id}${ext}`);
    if (path.resolve(file) === path.resolve(dst)) return this._view(it); // 이미 쓰고 있는 파일
    const matchColors = !!(opts && opts.matchColors);
    const before = this._itemState(it);
    const entry = this._archivePicture(it);
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(file, dst);
    } catch (e) {
      // 옛 그림이 같은 자리였다면 기록에 둔 복사본으로 되살린다
      if (entry && before.file) { try { fs.copyFileSync(this.abs(entry.file), this.abs(before.file)); } catch (_) { /* noop */ } }
      if (entry) unlinkQuiet(this.abs(entry.file));
      for (const k of Object.keys(it)) if (!(k in before)) delete it[k];
      Object.assign(it, before);
      throw new Error('그림 파일을 가져오지 못했어요. 다른 파일로 해 보세요.');
    }
    this.removeOld(before.file, dst);
    Object.assign(it, { file: this.rel(dst), status: 'done', error: null, updatedAt: Date.now(), keyed: null, cel: null, plate: null, stats: null, keySource: null, custom: true, source: 'user' });
    if (matchColors) it.matchColors = true; else delete it.matchColors;
    delete it.note;
    this._trimHistory(it);
    await this._rekey(it, { matchColors });
    this.markDirty(shotNo);
    this.log(`🖼 ${it.kind === 'bg' ? '배경' : `그림 컷${shotNo}-${id}`} 을 내 그림으로 바꿨어요.`);
    this.save();
    return this._view(it);
  },

  /** 영상을 이어 붙이는 중(렌더링·자막)에 그림을 바꾸면 '고친 표시' 가 사라질 수 있어서 막는다. 그림을 그리는 중에는 괜찮다 */
  _assertNotRendering() {
    if (this.running && ['render', 'subtitles'].includes(this.p.currentStep)) throw new Error(EC.MSG.runningNoEdit);
  },

  /** 인물 셀의 배경 빼기를 다시 한다 (바꾸거나 되돌린 뒤). 못 해도 렌더링 때 다시 해 보니 오류로 두지 않는다 */
  async _rekey(it, o = {}) {
    const xs = this.p.xsheet;
    const shot = xs && this.shotOf(it.shot);
    if (!(xs && xs.layers && it.kind !== 'bg' && shot)) return;
    try {
      await this.processCelItem(it, shot, new AbortController(), o);
    } catch (e) {
      Object.assign(it, { keyed: null, cel: null, plate: null, stats: null });
      this.log(`⚠ 컷${it.shot}-${it.id} 배경 빼기 실패 (렌더링 때 다시 해 볼게요): ${String(e.message).split('\n')[0]}`);
    }
  },

  /**
   * 예전 그림으로 되돌린다. 지금 그림은 '이전 그림' 맨 앞으로 가서 다시 돌아올 수 있다 (둘이 자리를 바꾼다).
   * @param {number} shotNo @param {string} id 그림 id @param {number} index 이전 그림 번호 (0 = 가장 최근)
   * @returns {Promise<object>} 바뀐 그림 항목
   */
  async restoreVersion(shotNo, id, index) {
    const it = typeof id === 'string' ? this.itemOf(shotNo, id) : null;
    if (!it) throw new Error(EC.MSG.noItem);
    if (this._findJob(shotNo, id)) throw new Error('이 그림은 지금 다시 그리는 중이에요. 끝난 뒤에 되돌려 주세요.');
    if (it.status === 'running') throw new Error(EC.MSG.itemDrawing);
    this._assertNotRendering();
    const taken = EC.takeHistory(it.history, index);
    if (!taken || !taken.entry.file || !this.exists(taken.entry.file)) throw new Error(EC.MSG.noVersion);
    const { entry, rest } = taken;
    const curExists = this.exists(it.file);
    const ext = path.extname(entry.file).toLowerCase() || '.png';
    const dst = path.join(this.dir, 'drawings', `shot${pad2(shotNo)}_${id}${ext}`);
    const before = this._itemState(it);
    // 1) 지금 그림 → 기록 (파일을 옮긴다)
    let curEntry = null;
    if (curExists) {
      const k = EC.nextVersion(it);
      const curExt = path.extname(it.file).toLowerCase() || '.png';
      const to = path.join(this.dir, 'drawings', 'history', EC.historyName(shotNo, id, k, curExt));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      try { fs.renameSync(this.abs(it.file), to); } catch (_) { fs.copyFileSync(this.abs(it.file), to); unlinkQuiet(this.abs(it.file)); }
      curEntry = { file: this.rel(to), at: it.updatedAt || Date.now(), kind: it.source === 'user' ? 'user' : 'ai' };
      if (it.note) curEntry.note = it.note;
      if (it.source === 'user' && it.matchColors) curEntry.matchColors = true;
      it.vseq = k;
    }
    // 2) 고른 예전 그림 → 지금 그림 자리
    try {
      fs.copyFileSync(this.abs(entry.file), dst);
    } catch (e) {
      if (curEntry) { try { fs.renameSync(this.abs(curEntry.file), this.abs(before.file)); } catch (_) { /* noop */ } }
      for (const k of Object.keys(it)) if (!(k in before)) delete it[k];
      Object.assign(it, before);
      throw new Error('예전 그림을 되돌리지 못했어요. 잠시 뒤에 다시 해 주세요.');
    }
    unlinkQuiet(this.abs(entry.file));
    if (curExists && before.file && this.abs(before.file) !== dst) unlinkQuiet(this.abs(before.file));
    // 3) 항목 칸 바꾸기: 그림 · 만든 방법 · 요청 글 (주문 글을 직접 고쳤던 그림이면 그 글도)
    const curPrompt = it.prompt;
    Object.assign(it, { file: this.rel(dst), status: 'done', error: null, updatedAt: Date.now(), keyed: null, cel: null, plate: null, stats: null, keySource: null, custom: true, source: entry.kind === 'user' ? 'user' : 'ai' });
    if (entry.note) it.note = entry.note; else delete it.note;
    if (entry.kind === 'user' && entry.matchColors) it.matchColors = true; else delete it.matchColors;
    if (entry.prompt && entry.prompt !== curPrompt) {
      // 주문 글을 직접 고쳐서 그린 그림이었다면 그 글도 함께 (되돌아올 수 있게 지금 글도 이전 그림 쪽에 적어 둔다)
      if (curEntry) { curEntry.prompt = curPrompt; if (before.promptEdited) curEntry.promptEdited = true; }
      it.prompt = entry.prompt;
      if (entry.promptEdited) it.promptEdited = true; else delete it.promptEdited;
    }
    it.history = curEntry ? EC.pushHistory(rest, curEntry, Number.MAX_SAFE_INTEGER).history : rest;
    this._trimHistory(it);
    await this._rekey(it, { matchColors: it.source === 'user' ? !!it.matchColors : true });
    this.markDirty(shotNo);
    this.log(`↩ ${it.kind === 'bg' ? '배경' : `그림 컷${shotNo}-${id}`} 을 예전 그림으로 되돌렸어요.`);
    this.save();
    return this._view(it);
  },

  // ================================================================ 장면 넘기기 · 효과

  _shotIndex(shotNo) {
    const xs = this.p.xsheet;
    if (!xs) throw new Error(EC.MSG.noXsheet);
    const i = xs.shots.findIndex((s) => s.shot === shotNo);
    if (i < 0) throw new Error(EC.MSG.noShot);
    return i;
  },

  /**
   * 이 장면에서 다음 장면으로 넘어가는 모양을 바꾼다. 길이(frames)는 지금 것을 지키고, 컷(바로 전환)이었다면 알맞은 길이를 정한다.
   * 두 장면 모두 '바뀐 장면' 이 된다. 영상을 만드는 중에는 바꿀 수 없다.
   * @param {number} shotNo 컷 번호 (마지막 컷은 다음이 없어서 안 된다)
   * @param {string} type timeline.TRANSITIONS 의 이름 ('cut' · 'fade' · 'dissolve' · 'fadeblack' · 'flash' …)
   * @returns {object} 새 전환 {type, xfade, duration, frames}
   */
  setTransition(shotNo, type) {
    if (this.running) throw new Error(EC.MSG.runningNoEdit);
    const xs = this.p.xsheet;
    const i = this._shotIndex(shotNo);
    if (i >= xs.shots.length - 1) throw new Error('마지막 장면은 다음 장면이 없어서 바꿀 수 없어요.');
    const { TRANSITIONS } = require('../media/timeline');
    if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(TRANSITIONS, type)) throw new Error(`알 수 없는 장면 넘기기예요: ${String(type).slice(0, 30)}`);
    const beatPeriod = (this.p.music && this.p.music.analysis && this.p.music.analysis.beatPeriod) || 0.5;
    const tr = EC.makeTransition(type, { prev: xs.transitions[i], framesA: xs.shots[i].frames, framesB: xs.shots[i + 1].frames, beatPeriod });
    if (tr.tooShort) throw new Error('장면이 너무 짧아서 이 모양으로는 넘길 수 없어요. 다른 모양을 골라 주세요.');
    xs.transitions[i] = tr;
    xs.shots[i].transition_out = EC.transitionOut(tr, beatPeriod);
    this.markDirty(xs.shots[i].shot, xs.shots[i + 1].shot); // 앞뒤 두 장면이 모두 다시 만들어진다
    this.persistXsheet();
    this.log(`✨ 컷 ${shotNo} 다음 장면으로 넘어가는 모양: ${TRANSITIONS[type].label}`);
    this.save();
    return tr;
  },

  /**
   * 장면의 효과를 바꾼다 (최대 3개). 이름은 xsheet.FX_TYPES(별칭 포함)만. 영상을 만드는 중에는 바꿀 수 없다.
   * @param {number} shotNo @param {string[]} fxArray 예: ['fade_in', 'sparkle'] ([] = 효과 없음)
   * @returns {object} 고친 장면(shot)
   */
  setFx(shotNo, fxArray) {
    if (this.running) throw new Error(EC.MSG.runningNoEdit);
    const i = this._shotIndex(shotNo);
    const xs = this.p.xsheet;
    const chk = EC.checkFx(fxArray);
    if (chk.error) throw new Error(chk.error);
    const shot = xs.shots[i];
    shot.fx = chk.fx;
    shot.camera = X.normalizeCamera(shot.camera, shot.fx); // 흔들기 효과는 확대 여유가 필요하다
    const dirty = [shot.shot];
    // 앞 장면에서 스르륵 넘어오는 효과(dissolve_in)는 타임시트를 짤 때처럼 앞 전환으로 바꾼다
    if (i > 0 && shot.fx.includes('dissolve_in') && xs.transitions[i - 1] && xs.transitions[i - 1].type === 'cut') {
      const beatPeriod = (this.p.music && this.p.music.analysis && this.p.music.analysis.beatPeriod) || 0.5;
      const tr = EC.makeTransition('dissolve', { prev: xs.transitions[i - 1], framesA: xs.shots[i - 1].frames, framesB: shot.frames, beatPeriod });
      if (!tr.tooShort) {
        xs.transitions[i - 1] = tr;
        xs.shots[i - 1].transition_out = EC.transitionOut(tr, beatPeriod);
        dirty.push(xs.shots[i - 1].shot);
      }
    }
    this.markDirty(...dirty);
    this.persistXsheet();
    this.save();
    return shot;
  },

  // ================================================================ 고친 것 기록 · 고친 것 반영하기

  /** 바뀐 장면을 적어 둔다 (다음 영상 만들기가 끝나면 지워진다). 영상이 오래된 것이 된다 */
  markDirty(...shots) {
    const set = new Set(this.p.dirtyShots || []);
    for (const s of shots) if (Number.isFinite(s)) set.add(s);
    this.p.dirtyShots = [...set].sort((a, b) => a - b);
    this.p.renderStale = true;
  },

  /** 노래 길이(초). 아직 분석 전이면 null */
  songSeconds() {
    const p = this.p;
    return (p.music && p.music.analysis && p.music.analysis.duration) || (p.song && p.song.duration) || null;
  },

  /** 스냅샷에 싣는 '고친 것': {render, subs, shots, count, etaSec} */
  changes() {
    const p = this.p;
    const shots = Array.isArray(p.dirtyShots) ? [...p.dirtyShots] : [];
    const render = !!(p.renderStale || shots.length);
    const subs = !!p.subsStale;
    const count = (shots.length || (render ? 1 : 0)) + (subs ? 1 : 0);
    const motionOf = (no) => !!(p.xsheet && (p.xsheet.shots.find((s) => s.shot === no) || {}).motion);
    const etaSec = EC.applyEta({
      render, subs, shots: shots.map((no) => ({ motion: motionOf(no) })), nChanged: shots.length,
      nShots: p.xsheet ? p.xsheet.shots.length : 0, songSec: this.songSeconds() || 0, steps: p.steps || {},
    });
    return { render, subs, shots, count, etaSec };
  },

  /** 고친 것 반영하기를 시작한다면 어느 단계부터인지 (할 일이 없으면 null) */
  applyFrom() {
    const p = this.p;
    return EC.decideApplyFrom({
      steps: p.steps || {}, renderStale: p.renderStale, dirtyShots: p.dirtyShots, subsStale: p.subsStale,
      hasClean: this.exists(p.output && p.output.clean),
    });
  },

  /** 지금 [고친 것 반영하기] 를 누를 수 있는지 */
  canApply() {
    if (this.running || this.redrawQueue.length || this._planning) return false;
    return this.applyFrom() !== null;
  },

  /**
   * 고친 것 반영하기: 끝나지 않은 단계가 있으면 그 단계부터, 아니면 그림·카메라·시간·효과·전환이 바뀌었으면 영상 만들기(바뀐 장면만 새로 + 이어 붙이기 + 자막),
   * 자막만 바뀌었으면 자막 입히기만. 완성(done)된 프로젝트에서도 시작한다. 오래 걸려서 기다리지 않고 바로 돌려준다 (진행은 update 이벤트로).
   * 이미 영상을 만드는 중이면 아무것도 하지 않는다. 그림을 다시 그리는 중이면 알려 준다.
   * @returns {{from: string|null}} from = 시작한 단계 (할 일이 없으면 null)
   */
  applyChanges() {
    if (this.running) return { from: null };
    this.assertRunnable();
    const from = this.applyFrom();
    if (!from) return { from: null };
    this.log(`✨ 고친 것 반영하기 시작 (${from} 단계부터)`);
    this.run({ from }).catch((e) => this.log(`✖ 오류: ${e.message}`));
    return { from };
  },

  // ================================================================ 장면 하나만 미리보기

  /**
   * 장면 하나만 지금 상태(카메라 · 효과 · 노출 포함)로 영상을 만들어서 미리 본다. 이미 있는 그림·사이 그림만 쓰고(없는 사이 그림은 앞 그림을 그대로),
   * 프로젝트 상태(고친 표시 · 단계 · 영상 기록)는 바꾸지 않는다. 같은 입력이면 지난번 파일을 그대로 쓴다.
   * 파일은 그 구간의 노래 소리가 들어 있는 mp4 이다 (노래가 없으면 소리 없음).
   * @returns {Promise<{file:string, seconds:number, from:number, to:number, hasAudio:boolean, cached:boolean}>} file = 절대 경로, from/to = 이 장면의 노래 속 시간(초)
   */
  async previewShot(shotNo) {
    const i = this._shotIndex(shotNo);
    const rs = this.p.steps && this.p.steps.render;
    if (this.running && rs && rs.status === 'running') throw new Error(EC.MSG.previewBusy);
    if (this.redrawQueue.some((j) => j.shot === shotNo)) throw new Error(EC.MSG.previewRedraw);
    if (this._previews.has(shotNo)) return this._previews.get(shotNo);
    const ctl = new AbortController();
    this._previewCtls.add(ctl);
    const job = this._renderPreview(i, ctl).finally(() => { this._previews.delete(shotNo); this._previewCtls.delete(ctl); });
    this._previews.set(shotNo, job);
    return job;
  },

  async _renderPreview(i, ctl) {
    const { RENDER_VERSION } = this.constructor;
    const xs = this.p.xsheet;
    const shot = xs.shots[i];
    const fin = this.wf.finish || {};
    const { w, h } = outputSize(this.wf.aspect, this.wf.quality === '1080p' ? '720p' : this.wf.quality); // 미리보기는 720p 까지만 (빨리)
    const dir = path.join(this.dir, 'work', 'preview');
    fs.mkdirSync(dir, { recursive: true });
    const layered = !!xs.layers;
    if (await this.ensureCelsProcessed(ctl, { shot: shot.shot })) this.save(); // 직접 넣은 그림의 배경 빼기가 남아 있었다면 먼저
    const mats = this.shotMaterials(i, true);
    // 사이 그림: 이미 만들어 둔 것 중 지금 그림과 맞는 것만. 없으면 앞 그림을 그대로 (새로 만들지 않는다)
    const setting = ['auto', 'rife', 'ffmpeg', 'off'].includes(this.wf.inbetween) ? this.wf.inbetween : 'auto';
    const ibFile = (a, b) => {
      const pk = X.pairKey(a, b);
      const [ia, ib] = pk.split('~');
      const A = mats.get(ia);
      const B = mats.get(ib);
      if (!A || !B || A.raw === B.raw) return null;
      const keyed = A.keyed && B.keyed;
      const sig = IB.inbetweenHash(keyed ? A.plate : A.raw, keyed ? B.plate : B.raw, setting, keyed ? xs.keyColor : null);
      const rec = (this.p.inbetweens || {})[`${shot.shot}:${pk}`];
      return rec && rec.sig === sig && rec.status === 'done' && this.exists(rec.file) ? this.abs(rec.file) : null;
    };
    const table = X.expandExposure(shot, (a, b) => !!ibFile(a, b));
    const layers = new Map();
    for (const id of new Set(table)) {
      if (id.includes('~')) { const [ia, ib] = id.split('~'); layers.set(id, ibFile(ia, ib)); } else layers.set(id, mats.get(id) ? mats.get(id).file : null);
    }
    const bg = layered ? await this.shotBg(i, dir, ctl, true) : null;
    const sigOf = (f) => {
      if (!f) return '-';
      try { const st = fs.statSync(f); return `${this.rel(f)}:${st.size}:${Math.round(st.mtimeMs)}`; } catch (_) { return `${f}:-`; }
    };
    const song = this.p.music && this.p.music.song && this.exists(this.p.music.song) ? this.abs(this.p.music.song) : null;
    const seconds = Math.round((shot.frames / FPS) * 1000) / 1000;
    const from = shot.startFrame != null ? shot.startFrame / FPS : shot.start;
    const parallax = 0.8;
    const key = sha1([RENDER_VERSION, 'preview', w, h, !!fin.boil, shot.frames, table, shot.camera, shot.fx,
      [...layers.entries()].map(([id, f]) => `${id}=${sigOf(f)}`), layered ? sigOf(bg) : null, parallax, song ? sigOf(song) : null, from]);
    const out = path.join(dir, `shot${pad2(shot.shot)}.mp4`);
    const keyFile = path.join(dir, `shot${pad2(shot.shot)}.key`);
    const result = (file, cached) => ({ file, seconds, from: shot.start, to: shot.end, hasAudio: !!song, cached, frames: shot.frames, width: w, height: h });
    let known = '';
    try { known = fs.readFileSync(keyFile, 'utf8'); } catch (_) { /* 없음 */ }
    const [knownKey, knownFile] = known.split('\n');
    if (knownKey === key && knownFile && fs.existsSync(knownFile)) return result(knownFile, true); // 같은 입력 → 지난번 파일 그대로
    const tmpVideo = path.join(dir, `shot${pad2(shot.shot)}.video.tmp.mp4`);
    const tmpOut = path.join(dir, `shot${pad2(shot.shot)}.tmp.mp4`);
    const t0 = Date.now();
    try {
      await renderShot({
        shot, table, bg, layers, parallax, W: w, H: h, lead: 0, tail: 0, boil: !!fin.boil, seed: 1, out: tmpVideo, signal: ctl.signal,
      });
      if (song) {
        await runFfmpeg(['-y', '-i', tmpVideo, '-ss', String(from), '-t', String(seconds), '-i', song, '-map', '0:v:0', '-map', '1:a:0',
          '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', tmpOut], { signal: ctl.signal });
        unlinkQuiet(tmpVideo);
      } else {
        fs.renameSync(tmpVideo, tmpOut);
      }
    } catch (e) {
      unlinkQuiet(tmpVideo);
      unlinkQuiet(tmpOut);
      if (e.name === 'AbortError') throw new Error('장면 미리보기를 멈췄어요.');
      throw new Error(`장면 미리보기를 만들지 못했어요. 잠시 뒤에 다시 눌러 주세요. (${String(e.message).split('\n')[0].slice(0, 120)})`);
    }
    // 같은 이름의 지난 미리보기가 어딘가에서 열려 있어서(윈도우) 바꿔치기가 안 되면 키가 들어간 이름으로 둔다
    let file = out;
    try {
      unlinkQuiet(out);
      fs.renameSync(tmpOut, out);
    } catch (_) {
      file = path.join(dir, `shot${pad2(shot.shot)}.${key.slice(0, 8)}.mp4`);
      fs.renameSync(tmpOut, file);
    }
    fs.writeFileSync(keyFile, `${key}\n${file}`);
    this.log(`👀 컷 ${shot.shot} 미리보기를 만들었어요 (${seconds}초 장면, ${((Date.now() - t0) / 1000).toFixed(1)}초 걸림)`);
    return result(file, false);
  },

  // ================================================================ 그림 줄여서 빨리

  /** setMotion / estimateMotion 에 들어온 값 검사 → 바꿀 값만 */
  _motionPatch(o) {
    const out = {};
    const raw = o && typeof o === 'object' ? o : {};
    if (raw.motionMode !== undefined && raw.motionMode !== null && raw.motionMode !== '') {
      if (!X.MODES.includes(raw.motionMode)) throw new Error('알 수 없는 움직임 방식이에요. 신나는 부분만 · 계속 · 조금만 중에서 골라 주세요.');
      out.motionMode = raw.motionMode;
    }
    if (raw.drawingBudget !== undefined && raw.drawingBudget !== null && raw.drawingBudget !== '') {
      const b = EC.checkBudget(raw.drawingBudget);
      if (b === null) throw new Error('그림 장수는 0(자동) 또는 3000 이하의 숫자로 적어 주세요.');
      out.drawingBudget = b;
    }
    return out;
  },

  /**
   * 움직임 방식 · 그림 장수 예산을 이렇게 바꾸면 그림이 몇 장, 몇 분이 걸릴지 어림한다 (프로젝트는 바꾸지 않는다).
   * 지금 타임시트가 있고 더 가벼운 쪽으로 가는 예상이면 그 타임시트를 다시 맞춰 세고, 아니면 PC 가 짜는 기본 타임시트로 센다.
   * @param {{motionMode?:string, drawingBudget?:number}} [o]
   * @returns {{ready:boolean, pictures:number|null, minutes:number|null, text:string, bg?:number, cels?:number, inbetweens?:number, motionMode?:string, drawingBudget?:number, source?:string}}
   */
  estimateMotion(o = {}) {
    const patch = this._motionPatch(o);
    const t = this.p.timing;
    if (!(t && t.segments && this.p.music && this.p.music.analysis && this.p.plan)) return { ready: false, pictures: null, minutes: null, text: '' };
    const ctx = this.xsheetContext(patch);
    const cur = this.p.xsheet;
    const rank = { limited: 0, ghibli: 1, full: 2 };
    const lighter = !!cur && rank[ctx.mode] <= rank[cur.mode];
    let xs;
    let source = 'pc';
    if (lighter) {
      // 지금 타임시트를 새 설정에 다시 맞춰 본다 (움직임 표시는 새 설정의 PC 규칙에 맡긴다)
      const raw = clone(cur.shots).map((s) => (ctx.mode === cur.mode ? s : { ...s, motion: undefined }));
      xs = X.normalizeXsheet(raw, ctx);
      source = 'current';
    } else {
      xs = X.normalizeXsheet(null, ctx);
    }
    const e = xs.estimate;
    return {
      ready: true, pictures: e.images, minutes: e.minutes, text: X.estimateText(e),
      bg: e.bg, cels: e.cels, inbetweens: e.inbetweens, motionShots: e.motionShots,
      motionMode: ctx.mode, drawingBudget: Number(ctx.wf.drawingBudget) || 0, source,
    };
  },

  /**
   * 지금보다 가벼운 방법 하나 (없으면 null): {motionMode, drawingBudget?, pictures, minutes, text}.
   * 후보를 앞에서부터 세어 보고 15% 넘게 줄어드는 첫 번째를 고른다. 없으면 가장 많이 줄어드는 것(조금이라도 줄어들 때만).
   */
  lighterAlternative() {
    const xs = this.p.xsheet;
    if (!xs || !xs.estimate) return null;
    const now = xs.estimate.images;
    const cands = EC.lighterCandidates(xs.mode, now, xs.shots.length, xs.layers);
    let best = null;
    for (const c of cands) {
      let est;
      try { est = this.estimateMotion(c); } catch (_) { continue; }
      if (!est.ready || est.pictures >= now) continue;
      const alt = { ...c, pictures: est.pictures, minutes: est.minutes, text: est.text };
      if (est.pictures <= now * 0.85) return alt;
      if (!best || alt.pictures < best.pictures) best = alt;
    }
    return best;
  },

  /** '그림 수 확인' 카드에 같이 보내는 값: 지금 예상 + [그림 줄여서 빨리] 를 누르면 되는 값 */
  drawingsReviewExtra() {
    const xs = this.p.xsheet;
    const e = xs.estimate;
    let alt = null;
    try { alt = this.lighterAlternative(); } catch (_) { /* 예상이 안 돼도 카드는 보인다 */ }
    return {
      estimate: { pictures: e.images, minutes: e.minutes, text: X.estimateText(e), motionMode: xs.mode, drawingBudget: Number(this.wf.drawingBudget) || 0 },
      alt,
    };
  },

  /**
   * 이 영상만 움직임 방식 · 그림 장수 예산을 바꾸고 그림 순서표(타임시트)를 다시 짠다 ('그림 줄여서 빨리').
   * 타임시트를 짜기 전이거나 '그림 수 확인' 에서 기다리는 중(또는 그 단계에서 멈춘 상태)에만 된다. 이미 그린 그림은 주문이 같으면 그대로 쓴다.
   * 기다리는 중이었다면 새 예상으로 다시 확인을 받는다.
   * @param {{motionMode?:'ghibli'|'full'|'limited', drawingBudget?:number}} o
   * @returns {Promise<{motionMode:string, drawingBudget:number, replanned:boolean, pictures:number|null, minutes:number|null, text:string, estimate:object|null}>}
   */
  async setMotion(o = {}) {
    const patch = this._motionPatch(o);
    if (!Object.keys(patch).length) throw new Error(EC.MSG.noMotionChange);
    if (this._planning) throw new Error(EC.MSG.planning);
    if (this.redrawQueue.length) throw new Error(EC.MSG.redrawing);
    const p = this.p;
    const planned = !!(p.xsheet && p.steps.xsheet && p.steps.xsheet.status === 'done');
    const atReview = !!(this.running && p.waiting && p.waiting.key === 'review:drawings' && this.reviewWaiter);
    if (this.running && !atReview) throw new Error(EC.MSG.motionBusy);
    if (!this.running && planned && p.steps.drawings && p.steps.drawings.status === 'done') throw new Error(EC.MSG.motionLate);
    const prev = { motionMode: p.workflow.motionMode, drawingBudget: p.workflow.drawingBudget };
    Object.assign(p.workflow, patch);
    const summary = () => ({ motionMode: this.mode, drawingBudget: Number(this.wf.drawingBudget) || 0 });
    if (!planned) {
      // 아직 타임시트를 짜기 전: 설정만 바꾸면 된다 (다음에 타임시트를 짤 때 쓰인다)
      this.log(`🎛 이 영상의 움직임 설정을 바꿨어요 (${p.workflow.motionMode}${patch.drawingBudget !== undefined ? `, 그림 예산 ${p.workflow.drawingBudget || '자동'}` : ''}).`);
      this.save();
      let est = null;
      try { est = this.estimateMotion({}); } catch (_) { /* noop */ }
      return { ...summary(), replanned: false, pictures: est && est.ready ? est.pictures : null, minutes: est && est.ready ? est.minutes : null, text: est ? est.text : '', estimate: null };
    }
    // 타임시트를 다시 짠다
    const saved = { xsheet: p.xsheet, drawings: p.drawings, drawingsApproved: p.drawingsApproved, currentStep: p.currentStep, waiting: p.waiting };
    const ctl = atReview ? this.abort : new AbortController();
    this._planning = true;
    if (!atReview) this._planCtl = ctl;
    if (atReview) {
      p.waiting = { ...p.waiting, busy: true, message: '그림 순서표를 다시 짜는 중이에요…' };
      this.save();
    }
    try {
      await this.step_xsheet(ctl);
    } catch (e) {
      // 그대로 되돌린다
      p.workflow.motionMode = prev.motionMode;
      if (prev.drawingBudget === undefined) delete p.workflow.drawingBudget; else p.workflow.drawingBudget = prev.drawingBudget;
      Object.assign(p, { xsheet: saved.xsheet, drawings: saved.drawings, drawingsApproved: saved.drawingsApproved, currentStep: saved.currentStep, waiting: saved.waiting });
      this.save();
      if (e.name === 'AbortError') throw new Error('그림 순서표 다시 짜기를 멈췄어요.');
      throw new Error(`그림 순서표를 다시 짜지 못했어요. 잠시 뒤에 다시 눌러 주세요. (${String(e.message).split('\n')[0].slice(0, 120)})`);
    } finally {
      this._planning = false;
      this._planCtl = null;
    }
    p.currentStep = saved.currentStep;
    p.steps.xsheet = { ...p.steps.xsheet, status: 'done', message: '완료' };
    if (!atReview && p.steps.drawings) p.steps.drawings = { ...p.steps.drawings, status: 'pending' };
    this.log(`🎛 움직임 설정을 바꿔서 그림 순서표를 다시 짰어요 → ${X.estimateText(p.xsheet.estimate)}`);
    this.save();
    if (atReview && this.reviewWaiter) {
      const w = this.reviewWaiter;
      this.reviewWaiter = null;
      w.resolve('redo'); // 기다리던 영상 만들기가 새 예상으로 다시 확인을 받는다
    }
    const e = p.xsheet.estimate;
    return { ...summary(), replanned: true, pictures: e.images, minutes: e.minutes, text: X.estimateText(e), estimate: e };
  },
};
