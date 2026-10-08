'use strict';
// 전체 자동화 진행자 (오케스트레이션) — 그림을 이어 보여 주는 셀 애니메이션 뮤직비디오
//  1 music     노래·가사: 올린 노래(Suno 등) → BPM·박자·마디 분석                 (내 PC)
//  2 plan      기획: 시리즈 약속 + 지난 이야기 + 가사에 맞춘 스토리보드          (구독 LLM)
//  3 timing    타이밍: 가사 싱크 · 박자에 맞춘 컷 나누기 · 하이라이트 찾기       (내 PC)
//  4 xsheet    타임시트: 움직일 컷 · 열쇠 그림 · 노출 프레임 · 카메라 · 효과 · 배경  (구독 LLM 이 짜고 PC 가 검사)
//  5 drawings  그림: 배경 판 + 인물 셀(단색 배경 → PC 가 빼서 투명하게), 기준 그림 붙여서  (구독 AI)
//  6 render    렌더링: 사이 그림(RIFE/ffmpeg) → 배경·인물 겹치기(멀티플레인) → 깨끗한 원본  (내 PC, 무료)
//  7 subtitles 자막: 깨끗한 원본 위에 가사 자막을 나중에 입히기                   (내 PC, 무료)
const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { agentText, agentImage, AGENTS } = require('../ai/agents');
const { LimitError } = require('../ai/cli');
const demo = require('../ai/demo');
const { waitForNewDownload, SITES, EXTS } = require('../ai/helper');
const { NeedsUserError } = require('../ai/webbot/engine');
const { analyzeSong } = require('../media/audio');
const { estimateLyricTiming, scaledCutRange, segmentSong, toSrt, toLrc } = require('../media/timeline');
const { outputSize, buildAss, assFont, assembleAnimation, burnSubtitles, makePaperTexture } = require('../media/assemble');
const { renderShot } = require('../media/render');
const { processCel, keyColorFor, writePng } = require('../media/keyer');
const IB = require('../media/inbetween');
const { parseLyrics, sectionSummary } = require('../media/lyrics');
const SubStyle = require('../../shared/subtitle-style');
const SubCore = require('./subs-core');
const EC = require('./edits-core');
const P = require('./prompts');
const X = require('./xsheet');

const STEPS = ['music', 'plan', 'timing', 'xsheet', 'drawings', 'render', 'subtitles'];
const STEP_LABELS = {
  music: '노래·가사 분석 (BPM·박자)',
  plan: '기획 (이야기·스토리보드)',
  timing: '타이밍 (가사 싱크·컷 나누기)',
  xsheet: '타임시트 (그림 장수·프레임·카메라)',
  drawings: '그림 그리기',
  render: '렌더링 (깨끗한 원본)',
  subtitles: '자막 입히기',
};
const RENDER_VERSION = 3; // 합성 방식이 바뀌면 올려서 예전 컷 영상을 다시 만들게 한다
const BG_ID = 'bg'; // 배경 판의 id (그림 id 는 늘 대문자라 겹치지 않는다)
const REF_NOTE = {
  turnaround: 'character turnaround model sheet (front / side / back): copy this design exactly',
  expressions: 'character expression sheet: same face, use for expressions',
  fullbody: 'character full-body reference: same proportions and outfit',
  other: 'character reference drawing',
};
const PREV_NOTE = 'the previous drawing of this same shot: keep the same background, framing, lighting and line style; change only the pose / expression';
const PREV_CEL_NOTE = 'the previous drawing of this same shot — EDIT this image: change only what the prompt says, keep everything else identical';

function pad2(n) { return String(n).padStart(2, '0'); }
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('사용자가 중지했습니다.'); e.name = 'AbortError'; reject(e); }, { once: true });
  });
}
function safeName(s) { return String(s || 'video').replace(/[\\/:*?"<>|\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'video'; }
/** 깨끗한 원본을 완성본 이름으로 하드링크 (안 되면 복사). 100MB 가 넘는 복사를 피한다 */
function linkOrCopy(src, dst) {
  try { fs.rmSync(dst, { force: true }); } catch (_) { /* noop */ }
  try { fs.linkSync(src, dst); return 'link'; } catch (_) { fs.copyFileSync(src, dst); return 'copy'; }
}
function hardStop(e) { return e.name === 'AbortError' || e instanceof LimitError || ['limit', 'auth', 'notInstalled'].includes(e.kind); }

class ProjectRunner extends EventEmitter {
  /**
   * @param {{store: import('../store').Store, projectId: string, bot?: import('../ai/webbot/manager').BotManager,
   *          renderSubtitles?: Function, maxRetries?: number}} o
   */
  constructor(o) {
    super();
    this.store = o.store;
    this.bot = o.bot || null;
    this.renderSubtitles = o.renderSubtitles || null;
    this.maxRetries = o.maxRetries ?? 2;
    this.p = this.store.loadProject(o.projectId);
    if (!this.p) throw new Error('프로젝트를 찾을 수 없습니다.');
    this.dir = this.store.projectDir(this.p.id);
    // 앱이 작업 도중에 꺼졌다면 '진행 중' 으로 남아 있다 → '중지됨' 으로 바로잡는다
    if (this.p.status === 'running' || this.p.status === 'limited' || this.p.waiting) {
      if (this.p.status === 'running' || this.p.status === 'limited') this.p.status = 'stopped';
      this.p.waiting = null;
      this.p.limitUntil = null;
      for (const st of Object.values(this.p.steps || {})) {
        if (st.status === 'running' || st.status === 'waiting') { st.status = 'stopped'; st.message = '중지됨 (앱이 꺼졌어요)'; }
      }
      this.store.saveProject(this.p);
    }
    // 앱이 그림 한 장을 다시 그리는 도중에 꺼졌을 수도 있다 (진행 중 표시가 없어도) → 어떤 상태로 열리든 '그리는 중' 은 이전 상태로
    if (this.settleDrawings()) this.store.saveProject(this.p);
    this.running = false;
    this.abort = null;
    this.waiters = new Map();
    this.reviewWaiter = null;
    this.redrawQueue = []; // 낱장 다시 그리기 대기열 (한 번에 하나씩, 앱을 다시 켜면 비어 있다) → edits.js
    this._redrawPump = null;
    this._planning = false; // 그림 순서표를 다시 짜는 중 (setMotion)
    this._planCtl = null;
    this._previews = new Map(); // 장면 미리보기 만드는 중: 장면 번호 → Promise
    this._previewCtls = new Set();
  }

  /**
   * 그리는 중('running')으로 남은 그림을 이전 상태로: 파일이 있으면 'done', 없으면 'pending'.
   * 인물 셀은 배경 빼기를 중간에 멈췄을 수 있으니 다음 렌더링 때 다시 하도록 표시한다.
   * @returns {boolean} 바꾼 것이 있는지
   */
  settleDrawings() {
    let changed = false;
    for (const it of this.p.drawings || []) {
      if (it.status !== 'running') continue;
      if (it.file && fs.existsSync(path.join(this.dir, it.file))) {
        it.status = 'done';
        if (it.kind !== 'bg') Object.assign(it, { keyed: null, cel: null, plate: null, stats: null });
      } else {
        it.status = 'pending';
        it.file = null;
      }
      changed = true;
    }
    if (changed) {
      try { fs.rmSync(path.join(this.dir, 'work', 'redraw'), { recursive: true, force: true }); } catch (_) { /* noop */ }
    }
    return changed;
  }

  // ---------- 공통 ----------
  abs(rel) { return rel ? path.join(this.dir, rel) : null; }
  rel(abs) { return path.relative(this.dir, abs).split(path.sep).join('/'); }
  exists(rel) { return !!rel && fs.existsSync(this.abs(rel)); }
  get wf() { return this.p.workflow; }
  get settings() { return this.store.getSettings(); }
  get series() { return this.p.series || null; }
  get mode() { return X.MODES.includes(this.wf.motionMode) ? this.wf.motionMode : 'ghibli'; }
  get layers() { return this.wf.layers !== false; }
  get keyRate() { return Number(this.wf.keyRate) === 8 ? 8 : 6; }

  log(msg) {
    const d = new Date();
    const line = `[${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}] ${msg}`;
    try { fs.appendFileSync(path.join(this.dir, 'log.txt'), `${line}\n`); } catch (_) { /* noop */ }
    this.emit('log', { projectId: this.p.id, line });
  }

  save() {
    this.store.saveProject(this.p);
    this.emit('update', this.snapshot());
  }

  /** 저장하지 않고 화면에만 알린다 (그림 다시 그리기 대기열이 바뀔 때) */
  emitUpdate() {
    this.emit('update', this.snapshot());
  }

  /**
   * 화면에 보내는 프로젝트 상태: 저장된 프로젝트 + 지금 상태.
   *  running      영상 만들기(파이프라인)가 돌고 있는지 (그림 한 장 다시 그리기는 running 이 아니다)
   *  redrawing    다시 그리는 그림 [{shot, id, status:'queued'|'running'}] (한가하면 [])
   *  changes      고친 것 {render, subs, shots[], count, etaSec}  → 맨 아래 '✨ 고친 것 반영하기' 줄
   *  subtitleStyle / outSize / canApply / durationSec
   */
  snapshot() {
    const p = this.p;
    const changes = this.changes();
    return {
      ...p, dir: this.dir, running: this.running,
      redrawing: this.redrawingList(),
      changes,
      subtitleStyle: this._subtitleStyle(),
      outSize: this._subsSize(),
      canApply: this.canApply(changes),
      durationSec: this.songSeconds(),
    };
  }

  setStep(step, patch) {
    this.p.steps[step] = { ...(this.p.steps[step] || {}), ...patch };
    this.p.currentStep = step;
    this.save();
  }

  /** ctl: 중지 신호. 파이프라인은 this.abort, 그림 다시 그리기·미리보기는 저마다 따로 가진다 */
  checkAbort(ctl = this.abort) {
    if (ctl && ctl.signal.aborted) {
      const e = new Error('사용자가 중지했습니다.');
      e.name = 'AbortError';
      throw e;
    }
  }

  /** 영상 만들기(파이프라인)가 돌고 있거나, 그림을 다시 그리는 중 */
  get busy() { return this.running || this.redrawQueue.length > 0; }

  /** 영상 만들기를 새로 시작할 수 있는지 (그림을 다시 그리는 중이거나 순서표를 다시 짜는 중이면 막는다) */
  assertRunnable() {
    if (this.redrawQueue.length) throw new Error(EC.MSG.redrawing);
    if (this._planning) throw new Error(EC.MSG.planning);
  }

  // ---------- 실행 제어 ----------
  async run({ from } = {}) {
    if (this.running) return;
    this.assertRunnable();
    this.running = true;
    this.abort = new AbortController();
    this.p.status = 'running';
    this.p.error = null;
    this.save();
    const startIdx = from ? Math.max(0, STEPS.indexOf(from)) : 0;
    if (from) {
      // 지정한 단계부터 다시: 그 단계 이후 상태 초기화
      for (const s of STEPS.slice(startIdx)) if (this.p.steps[s]) this.p.steps[s].status = 'pending';
    }
    let limitWaitedMs = 0;
    try {
      for (let i = startIdx; i < STEPS.length; i++) {
        const step = STEPS[i];
        if (this.p.steps[step] && this.p.steps[step].status === 'done') continue;
        this.checkAbort();
        try {
          this.setStep(step, { status: 'running', message: '진행 중…', startedAt: Date.now(), progress: null });
          this.log(`▶ ${STEP_LABELS[step]} 시작`);
          await this[`step_${step}`]();
          this.setStep(step, { status: 'done', message: '완료', finishedAt: Date.now() });
          this.log(`✔ ${STEP_LABELS[step]} 완료`);
        } catch (e) {
          if (e instanceof LimitError || e.kind === 'limit') {
            const s = this.settings;
            const waitMs = (s.limitWaitMinutes || 20) * 60 * 1000;
            if (s.onLimit === 'wait' && limitWaitedMs + waitMs <= (s.limitMaxHours || 6) * 3600 * 1000) {
              limitWaitedMs += waitMs;
              this.p.status = 'limited';
              this.p.limitUntil = Date.now() + waitMs;
              this.setStep(step, { status: 'waiting', message: `구독 사용량 한도에 걸렸습니다. ${s.limitWaitMinutes}분 기다렸다가 자동으로 이어서 합니다.` });
              this.log(`⏸ 사용량 한도: ${e.message.split('\n')[0]} → ${s.limitWaitMinutes}분 대기`);
              await sleep(waitMs, this.abort.signal);
              this.p.status = 'running';
              this.p.limitUntil = null;
              i--; // 같은 단계 다시
              continue;
            }
          }
          throw e;
        }
      }
      this.p.status = 'done';
      this.p.waiting = null;
      this.log('🎉 모든 단계가 끝났습니다!');
    } catch (e) {
      const step = this.p.currentStep;
      if (e.name === 'AbortError') {
        this.p.status = 'stopped';
        if (step) this.p.steps[step] = { ...(this.p.steps[step] || {}), status: 'stopped', message: '중지됨' };
        this.log('■ 중지했습니다.');
      } else {
        this.p.status = e instanceof LimitError ? 'limited' : 'error';
        this.p.error = e.message;
        if (step) this.p.steps[step] = { ...(this.p.steps[step] || {}), status: 'error', message: e.message.split('\n')[0] };
        this.log(`✖ 오류: ${e.message}`);
      }
      this.p.waiting = null;
    } finally {
      this.running = false;
      this.save();
      this.emit('finished', this.snapshot());
    }
  }

  stop() {
    if (this.abort) this.abort.abort();
    for (const w of this.waiters.values()) w.reject(Object.assign(new Error('사용자가 중지했습니다.'), { name: 'AbortError' }));
    this.waiters.clear();
    if (this.reviewWaiter) { this.reviewWaiter.reject(Object.assign(new Error('사용자가 중지했습니다.'), { name: 'AbortError' })); this.reviewWaiter = null; }
    this.cancelRedraws(); // 그림 다시 그리기: 그리던 것은 멈추고 이전 그림으로, 기다리던 것은 없앤다
    if (this._planCtl) this._planCtl.abort();
    for (const c of this._previewCtls) c.abort();
  }

  /** 도우미 대기 중인 항목에 파일을 넣는다 */
  provideFile(key, file) {
    const w = this.waiters.get(key);
    if (w) { w.resolve(file); return true; }
    return false;
  }

  skipWaiting(key) {
    const w = this.waiters.get(key);
    if (w) { w.resolve(null); return true; }
    return false;
  }

  continueReview() {
    if (this._planning) throw new Error(EC.MSG.planning); // 순서표를 다시 짜는 동안에는 이어갈 수 없다
    if (this.reviewWaiter) { this.reviewWaiter.resolve(); this.reviewWaiter = null; return true; }
    return false;
  }

  /**
   * 사용자 확인을 기다린다. 부른 쪽으로 돌려주는 값: 보통 undefined(계속), 'redo' = 확인 중에 설정이 바뀌어서 다시 계산해야 해요.
   * @param {string} stage @param {string} message @param {object} [extra] 화면에 같이 보낼 값 (p.waiting 에 합친다)
   */
  async review(stage, message, extra = {}) {
    this.p.waiting = { key: `review:${stage}`, kind: 'review', title: '확인 후 계속', message, ...extra };
    this.setStep(this.p.currentStep, { status: 'waiting', message });
    const answer = await new Promise((resolve, reject) => { this.reviewWaiter = { resolve, reject }; });
    this.p.waiting = null;
    this.setStep(this.p.currentStep, { status: 'running', message: '진행 중…' });
    return answer;
  }

  /**
   * 사용자가 웹사이트에서 직접 만들어 다운로드할 때까지 기다린다.
   * 다운로드 폴더 감시 + 자동 클릭 브라우저 다운로드 + '파일 넣기' 버튼 중 먼저 오는 것.
   */
  async waitForUser(w, ctl = this.abort) {
    this.checkAbort(ctl);
    const exts = EXTS[w.kind] || [];
    const since = Date.now();
    const site = w.site && SITES[w.site];
    this.p.waiting = {
      key: w.key, kind: w.kind, title: w.title, message: w.message,
      site: w.site || null, siteName: site ? site.name : null, siteUrl: site ? site.url : null,
      copyText: w.copyText || '', image: w.image ? this.rel(w.image) : null,
      images: (w.images || []).map((x, i) => ({ file: this.rel(x), note: (w.imageNotes || [])[i] || '' })), since,
    };
    this.save();
    this.log(`🙋 도우미: ${w.title} - 사용자 작업을 기다리는 중`);
    const local = new AbortController();
    const onAbort = () => local.abort();
    ctl.signal.addEventListener('abort', onAbort, { once: true });
    const tmpDir = path.join(this.dir, 'work', 'downloads');
    fs.mkdirSync(tmpDir, { recursive: true });
    let unwatchBot = () => {};
    try {
      const result = await new Promise((resolve, reject) => {
        this.waiters.set(w.key, { resolve, reject });
        waitForNewDownload({ dir: this.store.downloadsDir(), exts, sinceMs: since, signal: local.signal })
          .then(resolve).catch(() => {});
        if (this.bot) {
          unwatchBot = this.bot.watchDownloads(async (dl) => {
            try {
              const target = path.join(tmpDir, `${Date.now()}_${dl.suggestedFilename()}`);
              await dl.saveAs(target);
              resolve(target);
            } catch (_) { /* noop */ }
          });
        }
      });
      if (result) this.log(`📥 파일을 받았습니다: ${path.basename(result)}`);
      return result;
    } finally {
      local.abort();
      unwatchBot();
      ctl.signal.removeEventListener('abort', onAbort);
      this.waiters.delete(w.key);
      this.p.waiting = null;
      this.save();
    }
  }

  // ---------- 1. 노래·가사 ----------
  async step_music() {
    fs.mkdirSync(path.join(this.dir, 'music'), { recursive: true });
    if (!this.p.song || !this.exists(this.p.song.file)) {
      let file;
      if (this.p.providers.text === 'demo') {
        this.setStep('music', { message: '연습용 예시 노래를 만드는 중…' });
        fs.mkdirSync(path.join(this.dir, 'work'), { recursive: true });
        file = await demo.demoMusic({ part: 1, seconds: this.p.demoSongSeconds || 60, bpm: 120, out: path.join(this.dir, 'work', 'demo_song.mp3'), signal: this.abort.signal });
        if (!this.p.lyricsInput || !this.p.lyricsInput.lines.length) this.p.lyricsInput = parseLyrics(demo.DEMO_LYRICS);
        this.log('🎵 노래 파일이 없어서 연습용 예시 노래(박자만 있는 음악)를 썼어요.');
      } else {
        file = await this.waitForUser({ key: 'music:song', kind: 'music', title: '노래 파일 넣기', site: null,
          message: 'Suno 등에서 만든 노래 파일(mp3, wav, m4a, mp4 등)을 넣어 주세요.' });
        if (!file) throw new Error('노래 파일이 없습니다. 노래를 넣고 [이어서 하기] 를 눌러 주세요.');
      }
      this.setSong(file);
    }
    this.setStep('music', { message: '노래의 박자를 분석하는 중…' });
    const songAbs = this.abs(this.p.song.file);
    const prior = this.p.music && this.p.music.bpmOverride;
    const analysis = await analyzeSong(songAbs, { priorBpm: prior, signal: this.abort.signal });
    this.p.music = {
      song: this.p.song.file,
      bpmOverride: prior || null,
      analysis,
      partRanges: [{ index: 1, start: 0, end: analysis.duration }],
    };
    this.p.song.duration = analysis.duration;
    const li = this.p.lyricsInput || { lines: [] };
    this.log(`🎵 노래 ${P.fmtTime(analysis.duration)} · BPM ${analysis.bpm} · 마디 ${analysis.downbeats.length}개 · 가사 ${li.lines.length}줄${li.timed ? ' (시간 포함 가사)' : ''}`);
    this.save();
  }

  /** 노래 파일을 작업 폴더로 복사해 등록 */
  setSong(file) {
    const ext = path.extname(file).toLowerCase() || '.mp3';
    const dst = path.join(this.dir, 'music', `song${ext}`);
    for (const f of fs.readdirSync(path.join(this.dir, 'music'))) {
      if (/^song\./.test(f) && path.join(this.dir, 'music', f) !== dst) { try { fs.unlinkSync(path.join(this.dir, 'music', f)); } catch (_) { /* noop */ } }
    }
    if (path.resolve(file) !== path.resolve(dst)) fs.copyFileSync(file, dst);
    this.p.song = { file: this.rel(dst), name: path.basename(file) };
    this.save();
  }

  // ---------- 2. 기획 ----------
  async step_plan() {
    const prov = this.p.providers.text;
    const analysis = this.p.music.analysis;
    let plan;
    if (prov === 'demo') {
      plan = P.normalizePlan(demo.demoPlan(this.p.topic, this.wf, this.series), this.wf, this.series);
    } else {
      const raw = await this.withRetry('기획', () => agentText(prov, {
        prompt: P.planPrompt(this.p.topic, sectionSummary(this.p.lyricsInput), analysis, this.wf, this.series),
        dir: path.join(this.dir, 'work', 'plan'),
        settings: this.settings,
        signal: this.abort.signal,
        onLog: (l) => this.log(l),
        accept: P.validPlan,
      }));
      plan = P.normalizePlan(raw, this.wf, this.series);
    }
    this.p.plan = plan;
    this.p.title = plan.title;
    if (this.series) this.log(`📺 ${this.series.name} EP${this.series.episode}: 주인공 ${this.series.characters.map((c) => c.name).join(', ')} (고정)`);
    this.writeStoryboard();
    this.save();
    if (this.wf.reviewAfterPlan) await this.review('plan', '기획안(이야기·스토리보드)을 확인하고 [계속] 을 눌러 주세요.');
  }

  writeStoryboard() {
    const plan = this.p.plan;
    if (!plan) return;
    const a = this.p.music && this.p.music.analysis;
    const s = this.series;
    const lines = [
      `# ${s ? `${s.name} EP${s.episode}. ` : ''}${plan.title}`, '', `> ${plan.logline}`, '', plan.concept, '',
      plan.episode_summary_ko ? `**이번 이야기 요약**: ${plan.episode_summary_ko}` : '', '',
      a ? `노래: ${(this.p.song && this.p.song.name) || ''} · ${P.fmtTime(a.duration)} · ${a.bpm} BPM · ${plan.music.genre || ''} ${plan.music.mood || ''}` : '', '',
      '## 등장인물', ...plan.characters.map((c) => `- **${c.name}**${c.fixed ? ' (고정 주인공 🔒)' : c.role === 'guest' ? ' (이번 화 손님)' : ''}: ${c.description_ko} _(${c.appearance_en})_`), '',
      '## 시나리오', ...plan.story.map((st) => `${st.act}. ${st.sections.length ? `[${st.sections.join(', ')}] ` : ''}${st.summary_ko}`), '',
      '## 가사', '', sectionSummary(this.p.lyricsInput), '',
    ];
    const xs = this.p.xsheet;
    if (xs) {
      const MODE_KO = { ghibli: '지브리식', full: '전체 움직임', limited: '리미티드' };
      const mode = xs.mode || 'limited';
      lines.push('## 타임시트 (컷마다 그림 장수 · 카메라)', '',
        `움직임 방식: ${MODE_KO[mode] || mode}${mode === 'limited' ? '' : ` (움직이는 컷은 1초 ${xs.keyRate}장 + 사이 그림)`}${xs.layers ? ' · 배경 판 + 인물 셀' : ''}`,
        `총 ${xs.shots.length}컷 · 그림 ${xs.totalDrawings}장 (예산 ${xs.budget}장) · ${xs.totalFrames}프레임 (24fps)`,
        xs.estimate ? `예상: ${X.estimateText(xs.estimate)}` : '', '');
      xs.shots.forEach((sh, i) => {
        const tr = xs.transitions[i];
        lines.push(`- 컷 ${sh.shot} (${sh.start.toFixed(2)}~${sh.end.toFixed(2)}초, ${sh.frames}프레임)${sh.highlight ? ' ⭐하이라이트' : ''}${sh.motion ? ' 🏃움직임' : ''}: ${xs.layers && sh.bg ? '배경 1장 + ' : ''}${xs.layers ? '인물 ' : '그림 '}${sh.drawings.length}장 · 카메라 ${sh.camera.move}${sh.fx.length ? ` · 효과 ${sh.fx.join(', ')}` : ''} → ${tr ? tr.type : '끝'}`);
        lines.push(`  - 노출: ${sh.exposure.map((e) => `${e.drawing}×${e.frames}`).join(' ')}`);
      });
    }
    fs.mkdirSync(path.join(this.dir, 'output'), { recursive: true });
    fs.writeFileSync(path.join(this.dir, 'output', 'storyboard.md'), lines.join('\n'));
  }

  // ---------- 3. 타이밍 ----------
  async step_timing() {
    const analysis = this.p.music.analysis;
    const parts = this.p.music.partRanges;
    const prevTiming = this.p.timing || {};
    let lyrics;
    if (prevTiming.lyricsSource === 'tap' && Array.isArray(prevTiming.lyrics) && prevTiming.lyrics.length) {
      lyrics = prevTiming.lyrics;
      this.log('⌨ 직접 맞춘(탭) 가사 타이밍을 사용합니다.');
    } else {
      const c = this.computeLyrics();
      this.p.timing = { ...prevTiming, lyrics: c.lyrics, lyricsSource: c.source };
      lyrics = c.lyrics;
      if (c.source !== 'auto' && lyrics.length) this.log(`⏱ 가사 파일(${c.source})의 시간을 그대로 사용합니다.`);
      this.save();
      if (c.source === 'auto' && lyrics.length && this.wf.lyricSyncPause !== false) {
        await this.review('lyrics', '가사 자막 시간을 맞출 차례예요. [⌨ 탭으로 가사 맞추기] 를 누르고 노래를 들으며 줄이 시작될 때마다 스페이스바를 누르면 정확해져요. (컷도 가사에 맞춰 나눠요) 건너뛰려면 [자동 추정으로 계속] 을 누르세요.');
        lyrics = this.p.timing.lyrics; // 그 사이 탭으로 맞췄거나 가사를 고쳤을 수 있다
      }
    }
    const range = scaledCutRange(this.wf.minClips, this.wf.maxClips, analysis.duration);
    if (range.minClips !== this.wf.minClips) this.log(`ℹ 3분보다 짧은 노래라서 컷 수를 ${range.minClips}~${range.maxClips}개로 줄였어요. (워크플로우의 컷 수는 3~4분 노래 기준)`);
    const segments = segmentSong(analysis, lyrics, parts, {
      minClips: range.minClips, maxClips: range.maxClips, minLen: this.wf.minClipSec, maxLen: this.wf.maxClipSec, pace: this.wf.pace,
    });
    this.p.timing.segments = segments;
    this.p.timing.frames = X.shotFrames(segments);
    this.p.timing.highlights = X.markHighlights(segments, lyrics);
    const hl = this.p.timing.highlights.filter(Boolean).length;
    this.log(`✂ 컷 ${segments.length}개로 나눴습니다 (하이라이트 ${hl}개): ${segments.map((s) => s.duration.toFixed(1)).join('s, ')}s`);
    this.writeStoryboard();
    this.save();
    if (this.wf.reviewAfterTiming) await this.review('timing', '타이밍(가사 싱크·컷)을 확인하고 [계속] 을 눌러 주세요. 가사 싱크는 [탭으로 맞추기] 로 다듬을 수 있습니다.');
  }

  /** 올린 가사 → 자막 줄 + 시간 (시간이 든 가사 파일이면 그대로, 아니면 자동 추정) */
  computeLyrics() {
    const li = this.p.lyricsInput || { lines: [] };
    const analysis = this.p.music.analysis;
    const withSection = (arr) => arr.map((t, i) => ({
      ...t, part: 1,
      section: (li.lines[i] && li.lines[i].section) || t.section || '',
      sectionStart: li.lines[i] ? !!li.lines[i].sectionStart : !!t.sectionStart,
      ...((li.lines[i] && li.lines[i].hidden) || t.hidden ? { hidden: true } : {}),
    }));
    if (li.timed && li.timed.length) return { lyrics: withSection(li.timed), source: li.source };
    const est = estimateLyricTiming(li.lines.map((l) => ({ ...l, part: 1 })), this.p.music.partRanges, analysis, { trailingGaps: li.trailingGaps });
    return { lyrics: withSection(est), source: 'auto' };
  }

  // ---------- 4. 타임시트 ----------
  /**
   * 타임시트를 짜는 데 필요한 값들.
   * @param {{motionMode?:string, drawingBudget?:number}} [over] 지금 설정 대신 이 값으로 계산해 본다 (그림 줄이기 예상용, 프로젝트는 바꾸지 않는다)
   */
  xsheetContext(over = null) {
    const t = this.p.timing;
    const analysis = this.p.music.analysis;
    const frames = t.frames || X.shotFrames(t.segments);
    const highlights = t.highlights || X.markHighlights(t.segments, t.lyrics);
    const wf = over ? { ...this.wf, ...over } : this.wf;
    const mode = X.MODES.includes(wf.motionMode) ? wf.motionMode : 'ghibli';
    const keyRate = Number(wf.keyRate) === 8 ? 8 : 6;
    const layers = wf.layers !== false;
    const motion = X.assignMotion(t.segments, frames, highlights, mode);
    const budget = X.resolveBudget(wf, analysis.duration, t.segments.length, { mode, frames, motion, keyRate, layers });
    return {
      plan: this.p.plan, series: this.series, segments: t.segments, lyrics: t.lyrics, analysis, wf,
      frames, highlights, mode, keyRate, layers, motion, budget,
      alloc: X.allocateDrawings(frames, highlights, Math.max(t.segments.length, budget - (layers ? t.segments.length : 0))),
    };
  }

  /** 셀 배경색: 시리즈 캐릭터 팔레트에 초록이 있으면 마젠타 */
  keyColor() {
    const pal = this.series ? this.series.characters.flatMap((c) => c.palette || []) : [];
    return keyColorFor(pal);
  }

  async step_xsheet(ctl = this.abort) {
    const prov = this.p.providers.text;
    const ctx = this.xsheetContext();
    let raw = null;
    if (prov === 'demo') {
      raw = demo.demoXsheet(ctx);
    } else {
      this.setStep('xsheet', { message: `컷 ${ctx.segments.length}개의 타임시트를 짜는 중… (그림 예산 ${ctx.budget}장)` });
      try {
        raw = await this.withRetry('타임시트', () => agentText(prov, {
          prompt: X.xsheetPrompt(ctx),
          dir: path.join(this.dir, 'work', 'xsheet'),
          settings: this.settings,
          signal: ctl.signal,
          onLog: (l) => this.log(l),
          accept: X.validXsheet,
          timeoutMs: 20 * 60 * 1000,
        }), ctl);
      } catch (e) {
        if (hardStop(e)) throw e;
        this.log(`⚠ AI 타임시트를 받지 못해서 PC 가 기본 타임시트를 짭니다: ${e.message.split('\n')[0]}`);
      }
    }
    const xs = X.normalizeXsheet(raw, ctx);
    xs.keyColor = this.keyColor();
    for (const n of xs.notes.slice(0, 30)) this.log(`🔧 ${n}`);
    this.p.xsheet = xs;
    this.p.drawingsApproved = false;
    this.buildDrawings();
    const MODE_KO = { ghibli: '지브리식', full: '전체 움직임', limited: '리미티드' };
    const e = xs.estimate;
    this.log(`📋 타임시트 (${MODE_KO[xs.mode]}${xs.mode === 'limited' ? '' : ` · 1초 ${xs.keyRate}장`}): 컷 ${xs.shots.length}개 · 움직이는 컷 ${e.motionShots}개(${e.motionSeconds}초) · 예산 ${xs.budget}장`);
    this.log(`🧮 ${X.estimateText(e)}`);
    this.persistXsheet();
    this.save();
  }

  /** output/timesheet.json 과 storyboard.md 를 지금 타임시트로 다시 쓴다 (타임시트 단계 · 길이/카메라/효과/전환 고친 뒤 · 그림 줄이기 뒤) */
  persistXsheet() {
    const xs = this.p.xsheet;
    if (!xs) return;
    fs.mkdirSync(path.join(this.dir, 'output'), { recursive: true });
    fs.writeFileSync(path.join(this.dir, 'output', 'timesheet.json'), JSON.stringify({ fps: xs.fps, mode: xs.mode, keyRate: xs.keyRate, layers: xs.layers, keyColor: xs.keyColor, budget: xs.budget, totalFrames: xs.totalFrames, estimate: xs.estimate, shots: xs.shots, transitions: xs.transitions }, null, 1));
    this.writeStoryboard();
  }

  /**
   * 타임시트 → 그림 작업 목록 (컷마다 배경 판 1장 + 인물 셀).
   * 프롬프트가 같거나 내가 바꾼 그림(custom: 내 그림 · 한국어로 고쳐 달라고 한 그림 · 주문 글을 직접 고친 그림)은 이미 있는 그림을 그대로 쓴다.
   * 주문 글이 바뀌어서 다시 그리게 되는 그림은 옛 그림을 '이전 그림' 기록으로 옮겨 두어서 되돌릴 수 있다.
   */
  buildDrawings() {
    const xs = this.p.xsheet;
    const old = new Map((this.p.drawings || []).map((d) => [d.key, d]));
    this.p.drawings = [];
    const keep = (key, kind, shot, id, prompt) => {
      const o = old.get(key);
      if (o && (o.prompt === prompt || o.custom) && this.exists(o.file)) {
        const kept = { ...o, kind };
        // 그림은 지키되, 직접 고친 주문 글이 아니면 주문 글은 새 타임시트 것으로 (나중에 다시 그리면 지금 장면 설명대로 그린다). 옛 기록(source 없음)은 그대로
        if (o.custom && o.prompt !== prompt && o.source !== undefined && !o.promptEdited) kept.prompt = prompt;
        this.p.drawings.push(kept);
        return;
      }
      const fresh = { key, kind, shot: shot.shot, id, prompt, status: 'pending', file: null };
      if (o) {
        // 버려지는 그림: 기록은 이어받고, 그림 파일은 기록으로 옮긴다
        Object.assign(fresh, this._carryHistory(o));
      }
      this.p.drawings.push(fresh);
    };
    for (const shot of xs.shots) {
      if (xs.layers && shot.bg) keep(`${shot.shot}:${BG_ID}`, 'bg', shot, BG_ID, P.composeBgPrompt({ plan: this.p.plan, series: this.series, shot, wf: this.wf }));
      for (const d of shot.drawings) {
        const prompt = xs.layers
          ? P.composeCelPrompt({ plan: this.p.plan, series: this.series, shot, drawing: d, wf: this.wf, keyColor: xs.keyColor })
          : P.composeDrawingPrompt({ plan: this.p.plan, series: this.series, shot, drawing: d, wf: this.wf });
        keep(`${shot.shot}:${d.id}`, 'cel', shot, d.id, prompt);
      }
    }
  }

  itemOf(shotNo, id) { return (this.p.drawings || []).find((x) => x.key === `${shotNo}:${id}`); }

  // ---------- 5. 그림 ----------
  async step_drawings() {
    fs.mkdirSync(path.join(this.dir, 'drawings'), { recursive: true });
    let items;
    let todo;
    let xs;
    // 그리기 전에 예상 장수·시간을 보여 주고 멈춘다 (연습 모드는 공짜라 멈추지 않음).
    // 멈춰 있는 동안 [그림 줄여서 빨리](setMotion)를 누르면 타임시트를 다시 짜고 ('redo') 새 예상으로 다시 묻는다.
    for (;;) {
      items = this.p.drawings || [];
      todo = items.filter((it) => !(it.status === 'done' && this.exists(it.file)));
      xs = this.p.xsheet;
      if (todo.length && !this.p.drawingsApproved && this.wf.reviewBeforeDrawings !== false && this.p.providers.image !== 'demo') {
        const answer = await this.review('drawings',
          `그림을 그리기 전에 확인해 주세요. ${X.estimateText(xs.estimate)}. 괜찮으면 [계속] 을 눌러 주세요. 너무 많으면 [그림 줄여서 빨리] 로 장수를 줄일 수 있어요.`,
          this.drawingsReviewExtra());
        if (answer === 'redo') continue;
      }
      break;
    }
    const total = items.length;
    this.p.drawingsApproved = true;
    const prov = this.p.providers.image || '';
    const conc = prov === 'helper' || prov.startsWith('bot:') ? 1 : Math.max(1, this.settings.concurrency.image || 1);
    // 같은 컷의 그림은 순서대로 (앞 그림을 다음 그림의 기준으로 붙이기 위해), 다른 컷끼리는 동시에
    const groups = [];
    for (const it of todo) {
      const g = groups.find((x) => x.shot === it.shot);
      if (g) g.items.push(it); else groups.push({ shot: it.shot, items: [it] });
    }
    const failures = [];
    const progress = () => {
      const done = items.filter((x) => x.status === 'done').length;
      this.setStep('drawings', { message: `${done}/${total}장 완료`, progress: { done, total } });
    };
    progress();
    let gi = 0;
    const worker = async () => {
      while (gi < groups.length) {
        const g = groups[gi++];
        for (const it of g.items) {
          this.checkAbort();
          if (it.status === 'done' && this.exists(it.file)) continue; // 기다리는 사이에 내 그림으로 바꾼 그림은 그대로 둔다
          it.status = 'running';
          it.error = null;
          this.save();
          try {
            const rel = await this.withRetry(`${it.kind === 'bg' ? '배경' : '그림'} 컷${it.shot}-${it.id}`, () => this.drawOne(it));
            if (rel) { it.file = rel; it.status = 'done'; it.updatedAt = Date.now(); } else it.status = 'skipped';
          } catch (e) {
            if (hardStop(e)) { it.status = 'pending'; this.save(); throw e; }
            it.status = 'error';
            it.error = e.message.split('\n')[0];
            failures.push(it);
            this.log(`✖ 그림 컷${it.shot}-${it.id}: ${e.message}`);
          }
          progress();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(conc, Math.max(1, groups.length)) }, worker));
    if (failures.length) {
      throw new Error(`그림 ${failures.length}장을 그리지 못했습니다. [그림] 탭에서 [다시 그리기] 또는 [파일 넣기] 후 [이어서 하기] 를 눌러 주세요.`);
    }
    const skipped = items.filter((x) => x.status === 'skipped').length;
    if (skipped) this.log(`ℹ 건너뛴 그림 ${skipped}장은 같은 컷의 다른 그림으로 대신 보여 줍니다.`);
  }

  shotOf(no) { return this.p.xsheet.shots.find((s) => s.shot === no); }

  /**
   * 이 그림에 붙일 기준 그림.
   *  - 배경 판: 없음 (인물이 들어가면 안 되므로)
   *  - 인물 셀: 같은 컷의 바로 앞 셀이 있으면 그걸 '첫 번째' 로 붙이고 고치기(edit)로 부탁 + 고정 캐릭터 시트
   *  - editSelf(한국어로 고쳐 달라고 할 때): 지금 이 그림 자신을 '고칠 그림' 으로 첫 번째에 붙인다 (배경 판은 배경 고치기 설명으로)
   */
  drawingRefs(shot, id, { editSelf = null } = {}) {
    const refs = [];
    const notes = [];
    if (id === BG_ID && !editSelf) return { refs, notes, prev: null };
    const layers = this.p.xsheet && this.p.xsheet.layers;
    const idx = shot.drawings.findIndex((x) => x.id === id);
    let prev = null;
    if (editSelf) {
      refs.push(this.abs(layers && editSelf.keyed && this.exists(editSelf.plate) ? editSelf.plate : editSelf.file));
      notes.push(id === BG_ID ? EC.CUR_NOTE.bg : layers ? EC.CUR_NOTE.cel : EC.CUR_NOTE.full);
      prev = editSelf;
    } else {
      for (let k = idx - 1; k >= 0; k--) {
        const it = this.itemOf(shot.shot, shot.drawings[k].id);
        if (it && it.status === 'done' && this.exists(it.file)) { prev = it; break; }
      }
      if (prev) {
        refs.push(this.abs(layers && prev.keyed && this.exists(prev.plate) ? prev.plate : prev.file));
        notes.push(layers ? PREV_CEL_NOTE : PREV_NOTE);
      }
    }
    const s = this.series;
    if (s && id !== BG_ID) {
      const d = shot.drawings.find((x) => x.id === id) || {};
      const cast = P.charactersInShot(this.p.plan, shot, d).filter((c) => c.fixed);
      const perChar = cast.length > 1 ? 2 : 3;
      for (const c of cast) {
        const sc = s.characters.find((x) => x.name === c.name);
        if (!sc) continue;
        const order = ['turnaround', 'expressions', 'fullbody', 'other'];
        const picked = sc.refs.slice().sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)).slice(0, perChar);
        for (const r of picked) {
          if (!this.exists(r.file) || refs.length >= 4) continue;
          refs.push(this.abs(r.file));
          notes.push(`${sc.name} — ${REF_NOTE[r.kind] || REF_NOTE.other}`);
        }
      }
    }
    return { refs, notes, prev };
  }

  /**
   * 그림 한 장 그리기 → 작업 폴더 안 상대 경로 (셀이면 배경까지 빼 둔다)
   * @param {object} it 그림 항목
   * @param {AbortController} [ctl] 중지 신호 (영상 만들기는 this.abort, 낱장 다시 그리기는 자기 것)
   * @param {{note?:string, variant?:number}} [o] note: 한국어 요청 (지금 그림을 고쳐 달라고 한다) · variant: 연습 모드 그림이 달라 보이게 하는 번호
   */
  async drawOne(it, ctl = this.abort, o = {}) {
    const shot = this.shotOf(it.shot);
    const xs = this.p.xsheet;
    const isBg = it.kind === 'bg';
    const { refs, notes, prev } = this.drawingRefs(shot, it.id, { editSelf: o.note ? it : null });
    const index = shot.drawings.findIndex((d) => d.id === it.id);
    const def = shot.drawings[index] || { prompt_en: '' };
    let prompt;
    if (o.note) prompt = EC.notePrompt({ base: it.prompt, note: o.note, kind: isBg ? 'bg' : xs.layers ? 'cel' : 'full', keyColor: xs.layers ? xs.keyColor : null });
    else prompt = prev ? P.celEditPrefix(def, xs.layers ? xs.keyColor : null) + it.prompt : it.prompt;
    const file = await this.genImage({
      key: `image:${it.shot}:${it.id}`, prompt, refs, refNotes: notes,
      title: isBg ? `배경 컷${it.shot}` : `그림 컷${it.shot}-${it.id}`,
      demo: { kind: isBg ? 'bg' : xs.layers ? 'cel' : 'full', shot: it.shot, index, count: shot.drawings.length, highlight: shot.highlight, motion: !!shot.motion, keyColor: xs.keyColor, variant: o.variant || 0 },
    }, `s${pad2(it.shot)}_${it.id}`, ctl);
    if (!file) return null;
    const dst = path.join(this.dir, 'drawings', `shot${pad2(it.shot)}_${it.id}${path.extname(file).toLowerCase() || '.png'}`);
    this.removeOld(it.file, dst);
    fs.copyFileSync(file, dst);
    it.file = this.rel(dst);
    if (!isBg && xs.layers) await this.processCelItem(it, shot, ctl);
    return it.file;
  }

  /**
   * 셀 배경 빼기 + 색 맞추기 (같은 컷 첫 셀 기준).
   * 색 맞추기는 AI 가 그린 그림에는 켜고, 내가 넣은 그림(source 'user')에는 끈다 (고르면 켤 수 있다: it.matchColors).
   */
  async processCelItem(it, shot, ctl = this.abort, o = {}) {
    const xs = this.p.xsheet;
    const first = shot.drawings[0] && this.itemOf(shot.shot, shot.drawings[0].id);
    const match = o.matchColors !== undefined ? !!o.matchColors : it.source === 'user' ? !!it.matchColors : true;
    const refStats = match && first && first !== it && first.keyed ? first.stats : null;
    const base = path.join(this.dir, 'drawings', 'cels', `shot${pad2(shot.shot)}_${it.id}`);
    fs.mkdirSync(path.dirname(base), { recursive: true });
    const r = await processCel(this.abs(it.file), { celOut: `${base}.png`, plateOut: `${base}_plate.png`, keyColor: xs.keyColor, refStats, signal: ctl && ctl.signal });
    if (r.keyed) {
      Object.assign(it, { keyed: true, cel: this.rel(r.cel), plate: this.rel(r.plate), stats: r.stats, keySource: r.source });
    } else {
      Object.assign(it, { keyed: false, cel: null, plate: null, stats: null, keySource: null });
      this.log(`ℹ 컷${it.shot}-${it.id}: 배경이 단색이 아니라 뺄 수 없어서 전체 그림으로 씁니다.`);
    }
  }

  async genImage({ key, prompt, refs, refNotes, title, demo: dm }, tag, ctl = this.abort) {
    const prov = this.p.providers.image;
    const work = path.join(this.dir, 'work', 'images', `${tag}_${Date.now()}`);
    fs.mkdirSync(work, { recursive: true });
    const signal = ctl && ctl.signal;
    if (prov === 'demo') {
      // 연습 그림은 화면보다 조금 크게 (카메라가 움직일 여유)
      const { w, h } = outputSize(this.wf.aspect, this.wf.quality);
      const size = { w: Math.round(w * 1.2), h: Math.round(h * 1.2) };
      const pal = this.series && this.series.characters[0] ? this.series.characters[0].palette : demo.DEMO_CHARACTER.palette;
      const out = path.join(work, 'demo.png');
      const d = dm || {};
      // 다시 그릴 때마다 연습 그림이 눈에 띄게 달라지도록 자세(번호)·배경색(컷 번호)을 한 칸씩 옮긴다
      const v = Number(d.variant) || 0;
      if (d.kind === 'bg') return demo.demoBg({ ...size, shot: d.shot + v, out, signal });
      if (d.kind === 'cel') return demo.demoCel({ ...size, ...d, index: (d.index || 0) + v, palette: pal, out, signal });
      return demo.demoDrawing({ ...size, ...d, index: (d.index || 0) + v, palette: pal, out, signal });
    }
    if (AGENTS[prov]) {
      return agentImage(prov, { prompt, aspect: this.wf.aspect, refs, refNotes, dir: work, settings: this.settings, signal, onLog: (l) => this.log(l) });
    }
    const copy = `${prompt}\n(${this.wf.aspect})`;
    if (prov.startsWith('bot:')) {
      const site = prov.slice(4);
      const got = await this.tryBot(`${site}.image`, { prompt, aspect: this.wf.aspect, reference: refs[0] || '' }, work, title, ctl);
      if (got) return got;
      return this.waitForUser({ key, kind: 'image', title, site, copyText: copy, image: refs[0], images: refs, imageNotes: refNotes,
        message: '자동 클릭이 막혀서 직접 마무리가 필요합니다. 열린 브라우저 창에서 그림을 만든 뒤 다운로드하면 자동으로 가져옵니다.' }, ctl);
    }
    const site = this.p.helperSites.image || 'gemini';
    return this.waitForUser({ key, kind: 'image', title, site, copyText: copy, image: refs[0], images: refs, imageNotes: refNotes,
      message: `① 아래 기준 그림(앞 그림·캐릭터 시트)을 [${(SITES[site] || {}).name || '사이트'}] 에 첨부 → ② [프롬프트 복사] 후 붙여넣고 생성 → ③ 다운로드. 자동으로 가져옵니다.` }, ctl);
  }

  /** 자동 클릭 시도. 막히면 null (→ 도우미 모드) */
  async tryBot(taskId, params, outDir, title, ctl = this.abort) {
    const s = this.settings.bot;
    if (!this.bot || !s.enabled || !s.acceptedRisk) {
      this.log('ℹ 자동 클릭이 꺼져 있어 도우미 모드로 진행합니다. (설정에서 켤 수 있습니다)');
      return null;
    }
    try {
      this.log(`🤖 자동 클릭: ${title}`);
      return await this.bot.run(taskId, params, {
        outDir, signal: ctl.signal,
        onStatus: (st) => {
          if (st.state === 'login' || st.state === 'captcha') {
            this.p.waiting = { key: `bot:${taskId}`, kind: 'bot', title, message: st.message };
            this.save();
          } else if (this.p.waiting && this.p.waiting.kind === 'bot') {
            this.p.waiting = null;
            this.save();
          }
          this.log(`  🤖 ${st.message}`);
        },
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      this.log(`⚠ 자동 클릭 실패 → 도우미 모드로 전환: ${e.message.split('\n')[0]}`);
      if (this.p.waiting && this.p.waiting.kind === 'bot') this.p.waiting = null;
      if (!(e instanceof NeedsUserError)) this.log(String(e.stack || e).split('\n').slice(0, 3).join(' | '));
      return null;
    }
  }

  async withRetry(label, fn, ctl = this.abort) {
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      this.checkAbort(ctl);
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (hardStop(e)) throw e;
        if (attempt < this.maxRetries) {
          this.log(`↻ ${label} 재시도 (${attempt + 1}/${this.maxRetries}): ${e.message.split('\n')[0]}`);
          await sleep(3000 * (attempt + 1), ctl && ctl.signal);
        }
      }
    }
    throw lastErr;
  }

  // ---------- 6. 렌더링 ----------
  /**
   * 컷에 쓸 그림 재료. 셀은 배경을 뺀 투명 그림(못 뺐으면 전체 그림),
   * 없는 그림은 같은 컷(없으면 앞 컷)의 그림으로 대신한다.
   * @returns {Map<string, {file:string, raw:string, plate:string|null, keyed:boolean}|null>}
   */
  shotMaterials(shotIdx, quiet = false) {
    const xs = this.p.xsheet;
    const shot = xs.shots[shotIdx];
    const look = (no, id) => {
      const d = this.itemOf(no, id);
      if (!d || !d.file || !this.exists(d.file)) return null;
      if (xs.layers && d.keyed && this.exists(d.cel) && this.exists(d.plate)) return { file: this.abs(d.cel), raw: this.abs(d.file), plate: this.abs(d.plate), keyed: true };
      return { file: this.abs(d.file), raw: this.abs(d.file), plate: null, keyed: false };
    };
    const map = new Map();
    let fallback = null;
    for (const d of shot.drawings) fallback = fallback || look(shot.shot, d.id);
    for (let k = shotIdx - 1; !fallback && k >= 0; k--) {
      const s = xs.shots[k];
      for (const d of s.drawings) fallback = fallback || look(s.shot, d.id);
    }
    for (const d of shot.drawings) {
      const m = look(shot.shot, d.id);
      if (!m && !quiet) this.log(`ℹ 컷 ${shot.shot}: 그림 ${d.id} 가 없어서 다른 그림으로 대신합니다.`);
      map.set(d.id, m || fallback);
    }
    return map;
  }

  /** 배경 판: 이 컷 → 없으면 가까운 컷의 배경 → 그래도 없으면 빈 종이색 */
  async shotBg(shotIdx, work, ctl = this.abort, quiet = false) {
    const xs = this.p.xsheet;
    const order = [shotIdx];
    for (let k = 1; k < xs.shots.length; k++) order.push(shotIdx - k, shotIdx + k);
    for (const k of order) {
      const s = xs.shots[k];
      const it = s && this.itemOf(s.shot, BG_ID);
      if (it && it.file && this.exists(it.file)) {
        if (k !== shotIdx && !quiet) this.log(`ℹ 컷 ${xs.shots[shotIdx].shot}: 배경 판이 없어서 컷 ${s.shot} 의 배경을 씁니다.`);
        return this.abs(it.file);
      }
    }
    const blank = path.join(work, 'blank_bg.png');
    if (!fs.existsSync(blank)) {
      const px = new Uint8ClampedArray(64 * 36 * 3);
      for (let i = 0; i < px.length; i += 3) { px[i] = 0xf4; px[i + 1] = 0xec; px[i + 2] = 0xd8; }
      await writePng(blank, px, 64, 36, { rgb: true, signal: ctl && ctl.signal });
    }
    return blank;
  }

  /**
   * 셀 배경 빼기를 아직 안 한 그림(직접 넣은 파일 등)은 렌더링 전에 처리
   * @param {AbortController} [ctl] @param {{shot?:number}} [only] 이 컷만
   * @returns {Promise<number>} 처리한 그림 수
   */
  async ensureCelsProcessed(ctl = this.abort, only = {}) {
    const xs = this.p.xsheet;
    if (!xs.layers) return 0;
    let n = 0;
    for (const it of this.p.drawings || []) {
      if (it.kind === 'bg' || it.status !== 'done' || !this.exists(it.file)) continue;
      if (only.shot !== undefined && it.shot !== only.shot) continue;
      if (it.keyed === undefined || it.keyed === null || (it.keyed && !(this.exists(it.cel) && this.exists(it.plate)))) {
        this.checkAbort(ctl);
        const shot = this.shotOf(it.shot);
        if (shot) { await this.processCelItem(it, shot, ctl); n++; }
      }
    }
    return n;
  }

  /**
   * 움직이는 컷의 사이 그림 (이웃한 열쇠 그림 A·B 사이 한 장). 이미 만든 건 그대로.
   * @returns {Promise<Map<string, object>>} pairKey → 기록
   */
  async inbetweensFor(shot, mats, eng, tally) {
    const xs = this.p.xsheet;
    const got = new Map();
    const pairs = X.motionPairs(shot);
    if (!pairs.length || !eng.engine) return got;
    const signal = this.abort && this.abort.signal;
    const dir = path.join(this.dir, 'drawings', 'inbetweens');
    this.p.inbetweens = this.p.inbetweens || {};
    for (const pk of pairs) {
      this.checkAbort();
      const [ia, ib] = pk.split('~');
      const A = mats.get(ia);
      const B = mats.get(ib);
      if (!A || !B || A.raw === B.raw) continue; // 같은 그림으로 대신한 칸 → 사이 그림 없음
      const keyed = A.keyed && B.keyed;
      const inA = keyed ? A.plate : A.raw;
      const inB = keyed ? B.plate : B.raw;
      const keyColor = keyed ? xs.keyColor : null;
      const sig = IB.inbetweenHash(inA, inB, eng.setting, keyColor);
      const key = `${shot.shot}:${pk}`;
      const old = this.p.inbetweens[key];
      if (old && old.sig === sig && (old.status === 'hold' || (old.status === 'done' && this.exists(old.file)))) {
        got.set(pk, old);
        tally[old.status === 'done' ? old.engine : 'hold'] = (tally[old.status === 'done' ? old.engine : 'hold'] || 0) + 1;
        continue;
      }
      this.setStep('render', { message: `사이 그림 만드는 중… 컷 ${shot.shot} (${pk})` });
      const rec = { key, shot: shot.shot, pair: pk, sig, status: 'hold', file: null, plate: null, engine: null, device: null };
      const diff = await IB.tooDifferent(keyed ? A.file : A.raw, keyed ? B.file : B.raw, { signal });
      rec.score = diff.score;
      if (diff.different) {
        rec.reason = 'different';
      } else {
        const engines = eng.engine === 'rife' && !eng.rifeBroken ? ['rife', 'ffmpeg'] : ['ffmpeg'];
        for (const engine of engines) {
          try {
            const r = await IB.makeInbetween({ a: inA, b: inB, outDir: dir, engine, rife: eng.rife, keyColor, signal });
            Object.assign(rec, { status: 'done', file: this.rel(r.file), plate: this.rel(r.plate), engine, device: r.device });
            break;
          } catch (e) {
            if (e.name === 'AbortError') throw e;
            if (engine === 'rife') {
              eng.rifeBroken = true;
              this.log(`⚠ RIFE 가 이 PC 에서 잘 안 돼서 ffmpeg 로 바꿉니다: ${e.message.split('\n')[0]}`);
            } else {
              rec.reason = 'error';
              this.log(`⚠ 컷 ${shot.shot} 사이 그림(${pk})을 만들지 못해서 그대로 넘깁니다: ${e.message.split('\n')[0]}`);
            }
          }
        }
      }
      if (rec.status === 'done' && rec.device !== 'cache') tally.made = (tally.made || 0) + 1;
      if (rec.status === 'done' && rec.device && rec.device !== 'cache') eng.devices.add(`${rec.engine === 'rife' ? 'RIFE' : 'ffmpeg'}${rec.engine === 'rife' ? `·${rec.device === 'gpu' ? '그래픽카드' : 'CPU'}` : ''}`);
      tally[rec.status === 'done' ? rec.engine : 'hold'] = (tally[rec.status === 'done' ? rec.engine : 'hold'] || 0) + 1;
      this.p.inbetweens[key] = rec;
      got.set(pk, rec);
    }
    return got;
  }

  async step_render() {
    const xs = this.p.xsheet;
    if (!xs) throw new Error('타임시트가 없습니다. 타임시트 단계부터 다시 해 주세요.');
    const startedMs = Date.now();
    let shotsRendered = 0;
    let shotMsTotal = 0;
    const kinds = { motion: { n: 0, ms: 0 }, hold: { n: 0, ms: 0 } }; // 움직이는 장면 / 멈춘 장면 따로 평균
    const { w, h } = outputSize(this.wf.aspect, this.wf.quality);
    const fin = this.wf.finish || {};
    const work = path.join(this.dir, 'work', 'render');
    fs.mkdirSync(work, { recursive: true });
    const prev = (this.p.render && this.p.render.shots) || [];
    const shots = [];
    const n = xs.shots.length;
    const layered = !!xs.layers;
    await this.ensureCelsProcessed();
    // 사이 그림 엔진 고르기 (움직이는 컷이 있을 때만)
    const setting = ['auto', 'rife', 'ffmpeg', 'off'].includes(this.wf.inbetween) ? this.wf.inbetween : 'auto';
    const hasMotion = xs.shots.some((s) => X.motionPairs(s).length);
    const eng = hasMotion ? { ...IB.resolveEngine(setting), setting, rifeBroken: false, devices: new Set() } : { engine: null, setting, devices: new Set() };
    if (hasMotion) this.log(`🎞 사이 그림: ${eng.engine ? eng.note : '끔 (열쇠 그림만 넘김)'}`);
    const tally = {};
    // 지금 타임시트에 없는 사이 그림 기록은 지운다
    const live = new Set(xs.shots.flatMap((s) => X.motionPairs(s).map((pk) => `${s.shot}:${pk}`)));
    this.p.inbetweens = Object.fromEntries(Object.entries(this.p.inbetweens || {}).filter(([k]) => live.has(k)));
    const sigOf = (f) => {
      if (!f) return '-';
      try { const st = fs.statSync(f); return `${this.rel(f)}:${st.size}:${Math.round(st.mtimeMs)}`; } catch (_) { return `${f}:-`; }
    };
    for (let i = 0; i < n; i++) {
      this.checkAbort();
      const shot = xs.shots[i];
      const lead = i > 0 ? xs.transitions[i - 1].frames / 2 : 0;
      const tail = i < xs.transitions.length ? xs.transitions[i].frames / 2 : 0;
      const mats = this.shotMaterials(i);
      const ibStart = Date.now();
      const ibs = await this.inbetweensFor(shot, mats, eng, tally);
      const ibMs = Date.now() - ibStart; // 이 컷의 사이 그림을 새로 만드는 데 걸린 시간 (다 있으면 거의 0)
      const done = (a, b) => { const r = ibs.get(X.pairKey(a, b)); return !!(r && r.status === 'done'); };
      const table = X.expandExposure(shot, done);
      const layers = new Map();
      for (const id of new Set(table)) {
        if (id.includes('~')) layers.set(id, this.abs(ibs.get(id).file));
        else layers.set(id, mats.get(id) ? mats.get(id).file : null);
      }
      const bg = layered ? await this.shotBg(i, work) : null;
      const sig = [...layers.entries()].map(([id, f]) => `${id}=${sigOf(f)}`);
      const parallax = 0.8;
      const key = crypto.createHash('sha1').update(JSON.stringify([RENDER_VERSION, w, h, lead, tail, !!fin.boil, shot.frames, table, shot.camera, shot.fx, sig, layered ? sigOf(bg) : null, parallax])).digest('hex');
      const out = path.join(work, `shot${pad2(shot.shot)}.mp4`);
      const old = prev.find((r) => r.shot === shot.shot);
      const ibCount = [...ibs.values()].filter((r) => r.status === 'done').length;
      const held = [...ibs.values()].filter((r) => r.status === 'hold').length;
      const engines = [...new Set([...ibs.values()].filter((r) => r.status === 'done').map((r) => r.engine))];
      const meta = { motion: !!shot.motion, inbetweens: ibCount, held, engine: engines.join('+') || null, layered };
      if (old && old.key === key && fs.existsSync(out)) {
        shots.push({ ...old, ...meta, shot: shot.shot, key, file: this.rel(out) });
        continue;
      }
      this.setStep('render', { message: `컷 ${i + 1}/${n} 그리는 중 (배경·인물 겹치기·카메라)`, progress: { done: i, total: n + 1 } });
      const shotStart = Date.now();
      const r = await renderShot({
        shot, table, bg, layers, parallax, W: w, H: h, lead, tail, boil: !!fin.boil, seed: 1, out, signal: this.abort.signal,
        onProgress: (fr) => this.setStep('render', { message: `컷 ${i + 1}/${n} 그리는 중 ${Math.round(fr * 100)}%`, progress: { done: i + fr, total: n + 1 } }),
      });
      const cost = Date.now() - shotStart + ibMs; // 장면 하나를 새로 만드는 데 드는 시간 = 사이 그림 + 합성
      shotsRendered++;
      shotMsTotal += cost;
      kinds[shot.motion ? 'motion' : 'hold'].n++;
      kinds[shot.motion ? 'motion' : 'hold'].ms += cost;
      shots.push({ shot: shot.shot, key, file: this.rel(out), frames: r.frames, ...meta });
      this.p.render = { ...(this.p.render || {}), shots: [...shots, ...prev.filter((x) => !shots.some((y) => y.shot === x.shot))] };
      this.save();
    }
    const ibTotal = shots.reduce((a, s) => a + (s.inbetweens || 0), 0);
    const heldTotal = shots.reduce((a, s) => a + (s.held || 0), 0);
    const used = [...eng.devices];
    this.p.render = { ...(this.p.render || {}), shots, inbetween: { setting, engine: eng.rifeBroken ? 'ffmpeg' : eng.engine, used, count: ibTotal, held: heldTotal } };
    if (hasMotion && eng.engine) {
      this.log(`🎞 사이 그림 ${ibTotal}장 (새로 ${tally.made || 0}장${used.length ? `, ${used.join(' · ')}` : ''})${heldTotal ? ` · 너무 달라서 그대로 넘긴 곳 ${heldTotal}군데` : ''}`);
    }
    const outDir = path.join(this.dir, 'output');
    fs.mkdirSync(outDir, { recursive: true });
    const paper = fin.paper ? await makePaperTexture(w, h, path.join(work, 'paper.png'), { signal: this.abort.signal }) : null;
    const clean = path.join(outDir, 'animation_clean.mp4');
    this.setStep('render', { message: '컷을 잇고 필름 느낌·노래를 입히는 중…', progress: { done: n, total: n + 1 } });
    const assembleStart = Date.now();
    await assembleAnimation({
      shots: shots.map((s) => ({ file: this.abs(s.file), frames: s.frames })),
      transitions: xs.transitions,
      song: this.abs(this.p.music.song),
      totalFrames: xs.totalFrames, w, h, finish: fin, paperFile: paper, out: clean,
      signal: this.abort.signal,
      onProgress: (f) => this.setStep('render', { message: `깨끗한 원본 만드는 중 ${Math.round(f * 100)}%`, progress: { done: n + f, total: n + 1 } }),
    });
    this.p.output = { ...(this.p.output || {}), clean: this.rel(clean), cleanAt: Date.now() };
    this.p.renderStale = false;
    this.p.dirtyShots = []; // 지금까지 고친 장면이 모두 영상에 들어갔다
    this.p.subsStale = true;
    // 다음 '고친 것 반영하기' 에서 걸릴 시간을 어림하려고 이번에 잰 시간을 남긴다 (장면 하나 평균 · 이어 붙이기 · 전체)
    const prevRender = this.p.steps.render || {};
    this.p.steps.render = {
      ...prevRender,
      lastMs: Date.now() - startedMs,
      shotsRendered, shotsTotal: n,
      shotMs: shotsRendered ? Math.round(shotMsTotal / shotsRendered) : prevRender.shotMs || null,
      motionShotMs: kinds.motion.n ? Math.round(kinds.motion.ms / kinds.motion.n) : prevRender.motionShotMs || null,
      holdShotMs: kinds.hold.n ? Math.round(kinds.hold.ms / kinds.hold.n) : prevRender.holdShotMs || null,
      assembleMs: Date.now() - assembleStart,
    };
    this.log(`🎬 깨끗한 원본 (자막 없음): ${this.rel(clean)} · ${xs.totalFrames}프레임`);
    this.save();
  }

  // ---------- 7. 자막 ----------
  async step_subtitles() {
    const out = this.p.output || {};
    if (!this.exists(out.clean)) throw new Error('깨끗한 원본 영상이 없습니다. [렌더링] 부터 다시 해 주세요.');
    const startedMs = Date.now();
    const { w, h } = outputSize(this.wf.aspect, this.wf.quality);
    const t = this.p.timing;
    const xs = this.p.xsheet;
    const total = xs.totalFrames / X.FPS;
    const outDir = path.join(this.dir, 'output');
    const style = SubStyle.normalizeStyle(this.wf.subtitles, { w, h }); // 옛 형식도 같은 모양으로 읽는다
    // 숨긴 줄은 영상에도 SRT/LRC 에도 넣지 않는다
    const shown = (t.lyrics || []).filter((l) => !l.hidden && l.text);
    const lyrics = shown.filter((l) => l.start < total).map((l) => ({ ...l, end: Math.min(l.end, total) }));
    const s = this.series;
    const name = `${safeName(`${s ? `${s.name} EP${s.episode} ` : ''}${this.p.plan.title}`)}.mp4`;
    const finalPath = path.join(outDir, name);
    let burned = false;
    if (style.enabled && lyrics.length) {
      let subtitlePngs = null;
      let assFile = null;
      let assFonts = [];
      if (this.renderSubtitles) {
        try {
          subtitlePngs = await this.renderSubtitles(lyrics, { w, h, style, outDir: path.join(this.dir, 'work', 'subs'), log: (m) => this.log(m) });
        } catch (e) {
          this.log(`⚠ 자막 이미지 생성 실패, 기본 자막으로 대체: ${e.message}`);
        }
      }
      // 대체 경로(libass)를 쓰면 화면에 알린다 (p.subsFallback) — 모양이 미리 본 것과 조금 다를 수 있다
      this.p.subsFallback = !subtitlePngs;
      if (!subtitlePngs) {
        assFile = path.join(this.dir, 'work', 'lyrics.ass');
        fs.mkdirSync(path.dirname(assFile), { recursive: true });
        fs.writeFileSync(assFile, buildAss(lyrics, { w, h, style }));
        const fontsDir = path.join(__dirname, '..', '..', 'renderer', 'assets', 'fonts');
        assFonts = assFont(style.font).files.map((f) => path.join(fontsDir, f));
        this.log('⚠ 자막을 기본 방식으로 입혀요. 글꼴과 모양이 미리 본 것과 조금 다를 수 있어요.');
      }
      this.setStep('subtitles', { message: '가사 자막을 입히는 중…' });
      await burnSubtitles({
        video: this.abs(out.clean), total, w, h, out: finalPath, subtitlePngs, assFile, assFonts, signal: this.abort.signal,
        onProgress: (f) => this.setStep('subtitles', { message: `가사 자막 입히는 중 ${Math.round(f * 100)}%`, progress: { done: Math.round(f * 100), total: 100 } }),
      });
      burned = true;
    } else {
      // 자막이 없는 완성본: 100MB 가 넘는 파일을 복사하지 않고 같은 파일에 이름만 하나 더 붙인다 (안 되면 복사)
      this.p.subsFallback = false;
      const how = linkOrCopy(this.abs(out.clean), finalPath);
      this.log(`ℹ 자막이 꺼져 있거나 보여 줄 가사가 없어서 깨끗한 원본을 그대로 완성본으로 써요${how === 'link' ? '' : ' (복사)'}.`);
    }
    fs.writeFileSync(path.join(outDir, 'lyrics.srt'), toSrt(shown));
    fs.writeFileSync(path.join(outDir, 'lyrics.lrc'), toLrc(shown, this.p.plan.title));
    this.writeStoryboard();
    if (out.video && out.video !== this.rel(finalPath)) this.removeOld(out.video, finalPath);
    this.p.output = {
      ...out, video: this.rel(finalPath), srt: 'output/lyrics.srt', lrc: 'output/lyrics.lrc',
      storyboard: 'output/storyboard.md', timesheet: 'output/timesheet.json', madeAt: Date.now(),
    };
    this.p.subsStale = false;
    // 다음에 '지난번 1분 38초' 처럼 보여 줄 걸리는 시간 (자막을 실제로 입혔을 때만)
    if (burned) this.p.steps.subtitles = { ...this.p.steps.subtitles, lastMs: Date.now() - startedMs };
    if (s) {
      // 시리즈 기록에 이번 에피소드 요약을 남긴다 (다음 에피소드 기획에 쓰인다)
      try {
        this.store.series.recordEpisode(s.id, { number: s.episode, projectId: this.p.id, title: this.p.plan.title, summary_ko: this.p.plan.episode_summary_ko, madeAt: Date.now() });
        this.log(`📚 ${s.name} 기록에 EP${s.episode} 요약을 남겼습니다.`);
      } catch (e) {
        this.log(`⚠ 시리즈 기록 실패: ${e.message}`);
      }
    }
    this.save();
  }

  // ---------- 개별 수정 ----------
  // 그림 한 장 다시 그리기(regenerate) · 장면 그림 전부 다시 그리기(regenerateCut) · 내 그림으로 바꾸기(replaceItem) · 예전 그림으로 되돌리기(restoreVersion) 와
  // 장면 넘기기 · 효과 · 미리보기 · 고친 것 반영하기 · 그림 줄이기는 pipeline/edits.js 에 있다.

  /** 타임시트에서 그림 한 칸의 노출 프레임 바꾸기 (컷 길이는 그대로). 그림을 다시 그리는 중에도 할 수 있다 */
  retime(shotNo, index, frames) {
    if (this.running) throw new Error(EC.MSG.runningNoEdit);
    const xs = this.p.xsheet;
    const i = xs ? xs.shots.findIndex((s) => s.shot === shotNo) : -1;
    if (i < 0) throw new Error(EC.MSG.noShot);
    xs.shots[i] = X.retimeExposure(xs.shots[i], index, frames);
    this.markDirty(shotNo);
    this.persistXsheet();
    this.save();
    return xs.shots[i];
  }

  /** 컷의 카메라 움직임 바꾸기. 그림을 다시 그리는 중에도 할 수 있다 */
  setCamera(shotNo, move) {
    if (this.running) throw new Error(EC.MSG.runningNoEdit);
    const xs = this.p.xsheet;
    const shot = xs && xs.shots.find((s) => s.shot === shotNo);
    if (!shot) throw new Error(EC.MSG.noShot);
    if (!X.CAMERA_MOVES.includes(move)) throw new Error('알 수 없는 카메라 움직임이에요.');
    shot.camera = X.normalizeCamera({ move }, shot.fx);
    this.markDirty(shotNo);
    this.persistXsheet();
    this.save();
    return shot;
  }

  removeOld(rel, dst) {
    if (rel && this.abs(rel) !== dst) { try { fs.unlinkSync(this.abs(rel)); } catch (_) { /* noop */ } }
  }

  /** 기획안 수정 */
  updatePlan(plan) {
    this.p.plan = P.normalizePlan(plan, this.wf, this.series);
    this.writeStoryboard();
    this.save();
  }

  /** 노래 파일 바꾸기 → 분석부터 다시 (기획은 유지) */
  replaceSong(file) {
    if (this.running) throw new Error('진행 중에는 바꿀 수 없습니다.');
    fs.mkdirSync(path.join(this.dir, 'music'), { recursive: true });
    this.setSong(file);
    this.p.music = null;
    this.p.timing = null;
    for (const s of ['music', 'timing', 'xsheet', 'drawings', 'render', 'subtitles']) if (this.p.steps[s]) this.p.steps[s].status = 'pending';
    this.p.renderStale = true;
    this.save();
  }

  /** 컷이 이미 정해졌는지 (그 뒤의 가사 수정은 자막만 다시 입힌다) */
  get cutsFixed() { return !!(this.p.steps.timing && this.p.steps.timing.status === 'done' && this.p.timing && this.p.timing.segments); }

  /**
   * 가사 글 바꾸기 (붙여넣기 또는 .txt/.lrc/.srt 파일).
   *  - 줄 수가 같으면 맞춰 둔 시간은 그대로 두고 글자만 바꾼다.
   *  - 줄 수가 달라져도 직접 맞춘(탭) 시간은 지킨다: 글이 같은(또는 조금 고친) 줄은 시간을 그대로 쓰고,
   *    새 줄은 이웃 줄 사이로 나눠서 가장 가까운 박자에 맞춘다. 하나라도 같은 줄이 있으면 '직접 맞춤' 이 유지된다.
   *  - 시간이 들어 있는 .lrc/.srt 이거나 맞춘 시간이 없으면 예전처럼 새로 계산한다.
   * 7단계(자막 입히기)가 돌고 있을 때는 막힌다. 그림 그리는 중에도(컷이 정해진 뒤) 고칠 수 있다.
   * @param {string} raw @param {string} [filename]
   * @param {{dryRun?:boolean}} [opts] dryRun: 적용하지 않고 사라질 줄 수만 알려 준다
   * @returns {{lost:number, kept:number, added:number, mode:'same'|'merge'|'recompute'|'timed'|'none'}} lost = 사라지는 '맞춘 시간' 줄 수
   */
  updateLyricsText(raw, filename, opts = {}) {
    const st7 = this.p.steps && this.p.steps.subtitles;
    if (this.running && st7 && st7.status === 'running') throw new Error('지금 자막을 영상에 입히는 중이에요. 끝난 뒤에 고쳐 주세요.');
    if (this.running && !(this.p.waiting && this.p.waiting.key === 'review:lyrics') && !this.cutsFixed) throw new Error('진행 중에는 바꿀 수 없습니다.');
    const prev = (this.p.timing && this.p.timing.lyrics) || [];
    const prevSource = this.p.timing && this.p.timing.lyricsSource;
    const li = parseLyrics(raw, filename);
    const hasAnalysis = !!(this.p.music && this.p.music.analysis);
    let next = null; // { lyrics, source }
    let info = { lost: 0, kept: 0, added: 0, mode: 'none' };
    if (hasAnalysis) {
      if (!li.timed && prev.length && li.lines.length === prev.length && (this.cutsFixed || prevSource === 'tap')) {
        // 줄 수가 같으면 맞춰 둔 시간은 그대로 두고 글자만 바꾼다 (글이 바뀐 줄만 숨김 여부를 새로 읽는다)
        const lyrics = prev.map((l, i) => {
          const nl = li.lines[i];
          const same = SubCore.normText(l.text) === SubCore.normText(nl.text);
          const o = { ...l, text: nl.text, section: nl.section || l.section };
          if (!same) { delete o.words; if (nl.hidden) o.hidden = true; else delete o.hidden; }
          return o;
        });
        next = { lyrics, source: prevSource };
        info = { lost: 0, kept: prev.length, added: 0, mode: 'same' };
      } else if (!li.timed && prev.length && prevSource === 'tap') {
        const m = SubCore.mergeLyricLines(prev, li.lines, { beats: this.p.music.analysis.beats, duration: this.p.music.analysis.duration });
        if (m.matched > 0) {
          next = { lyrics: m.lyrics, source: 'tap' };
          info = { lost: m.lost, kept: m.matched, added: m.added, mode: 'merge' };
        }
      }
      // 새로 계산하면 직접 맞춘 시간은 모두 사라진다
      if (!next) info = { lost: prevSource === 'tap' ? prev.length : 0, kept: 0, added: 0, mode: li.timed ? 'timed' : 'recompute' };
    }
    if (opts && opts.dryRun) return info;
    this.p.lyricsInput = li;
    if (hasAnalysis) {
      if (next) {
        this.p.timing = { ...(this.p.timing || {}), lyrics: next.lyrics, lyricsSource: next.source };
      } else {
        // 바뀐 가사로 자막 줄을 바로 다시 계산 (가사 맞추기 대기 중이면 그 화면에 바로 반영)
        const c = this.computeLyrics();
        this.p.timing = { ...(this.p.timing || {}), lyrics: c.lyrics, lyricsSource: c.source };
      }
      SubCore.relinkSegments(this.p.timing.segments, this.p.timing.lyrics);
    }
    if (!this.running) {
      if (this.cutsFixed) { if (this.p.steps.subtitles) this.p.steps.subtitles.status = 'pending'; } else if (this.p.steps.timing) this.p.steps.timing.status = 'pending';
    } else if (this.cutsFixed && this.p.steps.subtitles) this.p.steps.subtitles.status = 'pending';
    this.p.subsStale = true;
    this.writeStoryboard();
    this.save();
    return info;
  }

  /**
   * 탭으로 맞춘 가사 타이밍 저장 (구간 정보는 같은 순서의 기존 줄에서 가져온다).
   * 숨긴 줄(hidden) · 끝을 직접 정한 줄(endLocked) · 단어 시간(words)은 글이 같은 기존 줄에서 이어받는다.
   */
  updateLyrics(lyrics) {
    if (!this.p.timing) throw new Error('타이밍 단계가 아직 없습니다.');
    const prev = this.p.timing.lyrics || [];
    const pairs = SubCore.matchLines(prev.map((l) => l.text), lyrics.map((l) => String(l.text)));
    const from = new Map(pairs.map((pr) => [pr.n, { old: prev[pr.o], exact: pr.exact }]));
    const matchedOld = new Set(pairs.map((pr) => pr.o));
    // 숨긴 줄은 탭 화면에 안 보여 줄 수도 있다 → 받은 목록에 없으면 원래 시간 그대로 다시 넣는다 (줄이 사라지지 않게)
    const keptHidden = prev.filter((l, i) => l.hidden && !matchedOld.has(i));
    this.p.timing.lyrics = [...lyrics.map((l, i) => {
      const m = from.get(i);
      const old = m ? m.old : null;
      const same = !!(prev[i] && prev[i].text === l.text);
      const line = {
        text: String(l.text), part: l.part || 1, start: Number(l.start), end: Number(l.end),
        section: (same ? prev[i].section : l.section) || '',
        sectionStart: !!(same ? prev[i].sectionStart : l.sectionStart),
      };
      if (typeof l.hidden === 'boolean') line.hidden = l.hidden;
      else if (old && old.hidden !== undefined && m.exact) line.hidden = old.hidden;
      if (old && m.exact && old.words) line.words = old.words;
      // 끝을 직접 정한 줄(endLocked)은 그 끝을 지킨다: 새로 받은 줄이 잠갔으면 그 끝 그대로,
      // 기존 줄이 잠가 둔 것이면 시작이 조금 바뀌어도 기존 끝을 이어받는다 (시작보다 뒤일 때만)
      if (l.endLocked === true) line.endLocked = true;
      else if (old && old.endLocked && old.end > line.start + 0.1) { line.end = old.end; line.endLocked = true; }
      return line;
    }), ...keptHidden.map((l) => ({ ...l }))].filter((l) => l.text && l.end > l.start).sort((a, b) => a.start - b.start);
    this.p.timing.lyricsSource = 'tap';
    SubCore.relinkSegments(this.p.timing.segments, this.p.timing.lyrics);
    this.p.subsStale = true;
    if (!this.running && this.cutsFixed && this.p.steps.subtitles) this.p.steps.subtitles.status = 'pending';
    this.save();
  }

  /** BPM 직접 지정 후 다시 분석 */
  async setBpm(bpm) {
    if (!this.p.music || !this.p.music.song) throw new Error('노래가 아직 없습니다.');
    this.p.music.bpmOverride = bpm;
    this.p.music.analysis = await analyzeSong(this.abs(this.p.music.song), { priorBpm: bpm });
    if (this.p.steps.timing) this.p.steps.timing.status = 'pending';
    this.save();
    return this.p.music.analysis;
  }
}

ProjectRunner.RENDER_VERSION = RENDER_VERSION; // edits.js 의 장면 미리보기가 같은 캐시 규칙을 쓴다

// 편집 · 가사 자막 메서드는 별도 파일에서 섞어 넣는다 (DESIGN §3.1)
Object.assign(ProjectRunner.prototype, require('./edits'), require('./subs'));

module.exports = { ProjectRunner, STEPS, STEP_LABELS };
