'use strict';
// 전체 자동화 진행자 (오케스트레이션) — 그림을 이어 보여 주는 셀 애니메이션 뮤직비디오
//  1 music     노래·가사: 올린 노래(Suno 등) → BPM·박자·마디 분석                 (내 PC)
//  2 plan      기획: 시리즈 약속 + 지난 이야기 + 가사에 맞춘 스토리보드          (구독 LLM)
//  3 timing    타이밍: 가사 싱크 · 박자에 맞춘 컷 나누기 · 하이라이트 찾기       (내 PC)
//  4 xsheet    타임시트: 컷마다 그림 목록 · 노출 프레임 · 카메라 · 효과           (구독 LLM 이 짜고 PC 가 검사)
//  5 drawings  그림: 캐릭터 파일의 기준 그림을 붙여서 한 장씩                      (구독 AI)
//  6 render    렌더링: 타임시트대로 그림을 넘기고 카메라를 움직여 깨끗한 원본     (내 PC, 무료)
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
const { estimateLyricTiming, segmentSong, toSrt, toLrc } = require('../media/timeline');
const { outputSize, buildAss, assembleAnimation, burnSubtitles, makePaperTexture } = require('../media/assemble');
const { renderShot } = require('../media/render');
const { parseLyrics, sectionSummary } = require('../media/lyrics');
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
const RENDER_VERSION = 1; // 합성 방식이 바뀌면 올려서 예전 컷 영상을 다시 만들게 한다
const REF_NOTE = {
  turnaround: 'character turnaround model sheet (front / side / back): copy this design exactly',
  expressions: 'character expression sheet: same face, use for expressions',
  fullbody: 'character full-body reference: same proportions and outfit',
  other: 'character reference drawing',
};
const PREV_NOTE = 'the previous drawing of this same shot: keep the same background, framing, lighting and line style; change only the pose / expression';

function pad2(n) { return String(n).padStart(2, '0'); }
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('사용자가 중지했습니다.'); e.name = 'AbortError'; reject(e); }, { once: true });
  });
}
function safeName(s) { return String(s || 'video').replace(/[\\/:*?"<>|\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'video'; }
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
      for (const it of this.p.drawings || []) if (it.status === 'running') it.status = 'pending';
      this.store.saveProject(this.p);
    }
    this.running = false;
    this.abort = null;
    this.waiters = new Map();
    this.reviewWaiter = null;
  }

  // ---------- 공통 ----------
  abs(rel) { return rel ? path.join(this.dir, rel) : null; }
  rel(abs) { return path.relative(this.dir, abs).split(path.sep).join('/'); }
  exists(rel) { return !!rel && fs.existsSync(this.abs(rel)); }
  get wf() { return this.p.workflow; }
  get settings() { return this.store.getSettings(); }
  get series() { return this.p.series || null; }

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

  snapshot() {
    return { ...this.p, dir: this.dir, running: this.running };
  }

  setStep(step, patch) {
    this.p.steps[step] = { ...(this.p.steps[step] || {}), ...patch };
    this.p.currentStep = step;
    this.save();
  }

  checkAbort() {
    if (this.abort && this.abort.signal.aborted) {
      const e = new Error('사용자가 중지했습니다.');
      e.name = 'AbortError';
      throw e;
    }
  }

  // ---------- 실행 제어 ----------
  async run({ from } = {}) {
    if (this.running) return;
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
    if (this.reviewWaiter) { this.reviewWaiter.resolve(); this.reviewWaiter = null; return true; }
    return false;
  }

  async review(stage, message) {
    this.p.waiting = { key: `review:${stage}`, kind: 'review', title: '확인 후 계속', message };
    this.setStep(this.p.currentStep, { status: 'waiting', message });
    await new Promise((resolve, reject) => { this.reviewWaiter = { resolve, reject }; });
    this.p.waiting = null;
    this.setStep(this.p.currentStep, { status: 'running', message: '진행 중…' });
  }

  /**
   * 사용자가 웹사이트에서 직접 만들어 다운로드할 때까지 기다린다.
   * 다운로드 폴더 감시 + 자동 클릭 브라우저 다운로드 + '파일 넣기' 버튼 중 먼저 오는 것.
   */
  async waitForUser(w) {
    this.checkAbort();
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
    this.abort.signal.addEventListener('abort', onAbort, { once: true });
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
      this.abort.signal.removeEventListener('abort', onAbort);
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
        this.setStep('music', { message: '체험용 예시 노래를 만드는 중…' });
        fs.mkdirSync(path.join(this.dir, 'work'), { recursive: true });
        file = await demo.demoMusic({ part: 1, seconds: this.p.demoSongSeconds || 60, bpm: 120, out: path.join(this.dir, 'work', 'demo_song.mp3'), signal: this.abort.signal });
        if (!this.p.lyricsInput || !this.p.lyricsInput.lines.length) this.p.lyricsInput = parseLyrics(demo.DEMO_LYRICS);
        this.log('🎵 노래 파일이 없어서 체험용 예시 노래(박자만 있는 음악)를 썼습니다.');
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
      lines.push('## 타임시트 (컷마다 그림 장수 · 카메라)', '', `총 ${xs.shots.length}컷 · 그림 ${xs.totalDrawings}장 (예산 ${xs.budget}장) · ${xs.totalFrames}프레임 (24fps)`, '');
      xs.shots.forEach((sh, i) => {
        const tr = xs.transitions[i];
        lines.push(`- 컷 ${sh.shot} (${sh.start.toFixed(2)}~${sh.end.toFixed(2)}초, ${sh.frames}프레임)${sh.highlight ? ' ⭐하이라이트' : ''}: 그림 ${sh.drawings.length}장 · 카메라 ${sh.camera.move}${sh.fx.length ? ` · 효과 ${sh.fx.join(', ')}` : ''} → ${tr ? tr.type : '끝'}`);
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
    const segments = segmentSong(analysis, lyrics, parts, {
      minClips: this.wf.minClips, maxClips: this.wf.maxClips, minLen: this.wf.minClipSec, maxLen: this.wf.maxClipSec, pace: this.wf.pace,
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
    }));
    if (li.timed && li.timed.length) return { lyrics: withSection(li.timed), source: li.source };
    const est = estimateLyricTiming(li.lines.map((l) => ({ ...l, part: 1 })), this.p.music.partRanges, analysis, { trailingGaps: li.trailingGaps });
    return { lyrics: withSection(est), source: 'auto' };
  }

  // ---------- 4. 타임시트 ----------
  xsheetContext() {
    const t = this.p.timing;
    const analysis = this.p.music.analysis;
    const budget = X.resolveBudget(this.wf, analysis.duration, t.segments.length);
    return {
      plan: this.p.plan, series: this.series, segments: t.segments, lyrics: t.lyrics, analysis, wf: this.wf,
      frames: t.frames || X.shotFrames(t.segments), highlights: t.highlights || X.markHighlights(t.segments, t.lyrics),
      alloc: X.allocateDrawings(t.frames || X.shotFrames(t.segments), t.highlights || [], budget), budget,
    };
  }

  async step_xsheet() {
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
          signal: this.abort.signal,
          onLog: (l) => this.log(l),
          accept: X.validXsheet,
          timeoutMs: 20 * 60 * 1000,
        }));
      } catch (e) {
        if (hardStop(e)) throw e;
        this.log(`⚠ AI 타임시트를 받지 못해서 PC 가 기본 타임시트를 짭니다: ${e.message.split('\n')[0]}`);
      }
    }
    const xs = X.normalizeXsheet(raw, ctx);
    for (const n of xs.notes.slice(0, 30)) this.log(`🔧 ${n}`);
    this.p.xsheet = xs;
    this.buildDrawings();
    const hl = xs.shots.filter((s) => s.highlight);
    this.log(`📋 타임시트: 컷 ${xs.shots.length}개 · 그림 ${xs.totalDrawings}장 (예산 ${xs.budget}장) · 하이라이트 ${hl.length}컷에 ${hl.reduce((a, s) => a + s.drawings.length, 0)}장`);
    fs.mkdirSync(path.join(this.dir, 'output'), { recursive: true });
    fs.writeFileSync(path.join(this.dir, 'output', 'timesheet.json'), JSON.stringify({ fps: xs.fps, budget: xs.budget, totalFrames: xs.totalFrames, shots: xs.shots, transitions: xs.transitions }, null, 1));
    this.writeStoryboard();
    this.save();
    if (this.wf.reviewAfterXsheet) await this.review('xsheet', `타임시트를 확인해 주세요. 그림 ${xs.totalDrawings}장을 그릴 거예요. 괜찮으면 [계속] 을 눌러 주세요.`);
  }

  /** 타임시트 → 그림 작업 목록. 프롬프트가 같으면 이미 그린 그림을 그대로 쓴다. */
  buildDrawings() {
    const xs = this.p.xsheet;
    const old = new Map((this.p.drawings || []).map((d) => [d.key, d]));
    this.p.drawings = [];
    for (const shot of xs.shots) {
      for (const d of shot.drawings) {
        const prompt = P.composeDrawingPrompt({ plan: this.p.plan, series: this.series, shot, drawing: d, wf: this.wf });
        const key = `${shot.shot}:${d.id}`;
        const o = old.get(key);
        this.p.drawings.push(o && (o.prompt === prompt || o.custom) && this.exists(o.file)
          ? o : { key, shot: shot.shot, id: d.id, prompt, status: 'pending', file: null });
      }
    }
  }

  // ---------- 5. 그림 ----------
  async step_drawings() {
    fs.mkdirSync(path.join(this.dir, 'drawings'), { recursive: true });
    const items = this.p.drawings || [];
    const todo = items.filter((it) => !(it.status === 'done' && this.exists(it.file)));
    const total = items.length;
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
          it.status = 'running';
          it.error = null;
          this.save();
          try {
            const rel = await this.withRetry(`그림 컷${it.shot}-${it.id}`, () => this.drawOne(it));
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

  /** 이 그림에 붙일 기준 그림: 컷에 나오는 고정 캐릭터의 시트 + 같은 컷의 앞 그림 */
  drawingRefs(shot, id) {
    const refs = [];
    const notes = [];
    const s = this.series;
    if (s) {
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
    const idx = shot.drawings.findIndex((x) => x.id === id);
    for (let k = idx - 1; k >= 0; k--) {
      const prev = (this.p.drawings || []).find((x) => x.key === `${shot.shot}:${shot.drawings[k].id}`);
      if (prev && prev.status === 'done' && this.exists(prev.file)) {
        refs.push(this.abs(prev.file));
        notes.push(PREV_NOTE);
        break;
      }
    }
    return { refs, notes };
  }

  /** 그림 한 장 그리기 → 작업 폴더 안 상대 경로 */
  async drawOne(it) {
    const shot = this.shotOf(it.shot);
    const { refs, notes } = this.drawingRefs(shot, it.id);
    const index = shot.drawings.findIndex((d) => d.id === it.id);
    const file = await this.genImage({
      key: `image:${it.shot}:${it.id}`, prompt: it.prompt, refs, refNotes: notes,
      title: `그림 컷${it.shot}-${it.id}`,
      demo: { shot: it.shot, index, count: shot.drawings.length, highlight: shot.highlight },
    }, `s${pad2(it.shot)}_${it.id}`);
    if (!file) return null;
    const dst = path.join(this.dir, 'drawings', `shot${pad2(it.shot)}_${it.id}${path.extname(file).toLowerCase() || '.png'}`);
    this.removeOld(it.file, dst);
    fs.copyFileSync(file, dst);
    return this.rel(dst);
  }

  async genImage({ key, prompt, refs, refNotes, title, demo: dm }, tag) {
    const prov = this.p.providers.image;
    const work = path.join(this.dir, 'work', 'images', `${tag}_${Date.now()}`);
    fs.mkdirSync(work, { recursive: true });
    const { w, h } = outputSize(this.wf.aspect, '720p');
    if (prov === 'demo') {
      const pal = this.series && this.series.characters[0] ? this.series.characters[0].palette : demo.DEMO_CHARACTER.palette;
      return demo.demoDrawing({ ...(dm || {}), palette: pal, w: Math.round(w * 1.2), h: Math.round(h * 1.2), out: path.join(work, 'demo.png'), signal: this.abort.signal });
    }
    if (AGENTS[prov]) {
      return agentImage(prov, { prompt, aspect: this.wf.aspect, refs, refNotes, dir: work, settings: this.settings, signal: this.abort.signal, onLog: (l) => this.log(l) });
    }
    const copy = `${prompt}\n(${this.wf.aspect})`;
    if (prov.startsWith('bot:')) {
      const site = prov.slice(4);
      const got = await this.tryBot(`${site}.image`, { prompt, aspect: this.wf.aspect, reference: refs[0] || '' }, work, title);
      if (got) return got;
      return this.waitForUser({ key, kind: 'image', title, site, copyText: copy, image: refs[0], images: refs, imageNotes: refNotes,
        message: '자동 클릭이 막혀서 직접 마무리가 필요합니다. 열린 브라우저 창에서 그림을 만든 뒤 다운로드하면 자동으로 가져옵니다.' });
    }
    const site = this.p.helperSites.image || 'gemini';
    return this.waitForUser({ key, kind: 'image', title, site, copyText: copy, image: refs[0], images: refs, imageNotes: refNotes,
      message: `① 아래 기준 그림(캐릭터 시트 등)을 [${(SITES[site] || {}).name || '사이트'}] 에 첨부 → ② [프롬프트 복사] 후 붙여넣고 생성 → ③ 다운로드. 자동으로 가져옵니다.` });
  }

  /** 자동 클릭 시도. 막히면 null (→ 도우미 모드) */
  async tryBot(taskId, params, outDir, title) {
    const s = this.settings.bot;
    if (!this.bot || !s.enabled || !s.acceptedRisk) {
      this.log('ℹ 자동 클릭이 꺼져 있어 도우미 모드로 진행합니다. (설정에서 켤 수 있습니다)');
      return null;
    }
    try {
      this.log(`🤖 자동 클릭: ${title}`);
      return await this.bot.run(taskId, params, {
        outDir, signal: this.abort.signal,
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

  async withRetry(label, fn) {
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      this.checkAbort();
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (hardStop(e)) throw e;
        if (attempt < this.maxRetries) {
          this.log(`↻ ${label} 재시도 (${attempt + 1}/${this.maxRetries}): ${e.message.split('\n')[0]}`);
          await sleep(3000 * (attempt + 1), this.abort.signal);
        }
      }
    }
    throw lastErr;
  }

  // ---------- 6. 렌더링 ----------
  /** 컷에 쓸 그림 파일들. 없는 그림은 같은 컷(없으면 앞 컷)의 그림으로 대신한다. */
  drawingFilesFor(shotIdx) {
    const xs = this.p.xsheet;
    const shot = xs.shots[shotIdx];
    const good = (no, id) => {
      const d = (this.p.drawings || []).find((x) => x.key === `${no}:${id}`);
      return d && d.file && this.exists(d.file) ? this.abs(d.file) : null;
    };
    const map = new Map();
    const inShot = shot.drawings.map((d) => good(shot.shot, d.id)).filter(Boolean);
    let fallback = inShot[0] || null;
    for (let k = shotIdx - 1; !fallback && k >= 0; k--) {
      const s = xs.shots[k];
      for (const d of s.drawings) { fallback = fallback || good(s.shot, d.id); }
    }
    for (const d of shot.drawings) {
      const f = good(shot.shot, d.id);
      if (!f) this.log(`ℹ 컷 ${shot.shot}: 그림 ${d.id} 가 없어서 다른 그림으로 대신합니다.`);
      map.set(d.id, f || fallback);
    }
    return map;
  }

  async step_render() {
    const xs = this.p.xsheet;
    if (!xs) throw new Error('타임시트가 없습니다. 타임시트 단계부터 다시 해 주세요.');
    const { w, h } = outputSize(this.wf.aspect, this.wf.quality);
    const fin = this.wf.finish || {};
    const work = path.join(this.dir, 'work', 'render');
    fs.mkdirSync(work, { recursive: true });
    const prev = (this.p.render && this.p.render.shots) || [];
    const shots = [];
    const n = xs.shots.length;
    for (let i = 0; i < n; i++) {
      this.checkAbort();
      const shot = xs.shots[i];
      const lead = i > 0 ? xs.transitions[i - 1].frames / 2 : 0;
      const tail = i < xs.transitions.length ? xs.transitions[i].frames / 2 : 0;
      const files = this.drawingFilesFor(i);
      const sig = [...files.entries()].map(([id, f]) => {
        if (!f) return `${id}:-`;
        const st = fs.statSync(f);
        return `${id}:${this.rel(f)}:${st.size}:${Math.round(st.mtimeMs)}`;
      });
      const key = crypto.createHash('sha1').update(JSON.stringify([RENDER_VERSION, w, h, lead, tail, !!fin.boil, shot.frames, shot.exposure, shot.camera, shot.fx, sig])).digest('hex');
      const out = path.join(work, `shot${pad2(shot.shot)}.mp4`);
      const old = prev.find((r) => r.shot === shot.shot);
      if (old && old.key === key && fs.existsSync(out)) {
        shots.push({ shot: shot.shot, key, file: this.rel(out), frames: old.frames });
        continue;
      }
      this.setStep('render', { message: `컷 ${i + 1}/${n} 그리는 중 (그림 넘기기·카메라)`, progress: { done: i, total: n + 1 } });
      const r = await renderShot({
        shot, files, W: w, H: h, lead, tail, boil: !!fin.boil, seed: 1, out, signal: this.abort.signal,
        onProgress: (fr) => this.setStep('render', { message: `컷 ${i + 1}/${n} 그리는 중 ${Math.round(fr * 100)}%`, progress: { done: i + fr, total: n + 1 } }),
      });
      shots.push({ shot: shot.shot, key, file: this.rel(out), frames: r.frames });
      this.p.render = { ...(this.p.render || {}), shots: [...shots, ...prev.filter((x) => !shots.some((y) => y.shot === x.shot))] };
      this.save();
    }
    this.p.render = { ...(this.p.render || {}), shots };
    const outDir = path.join(this.dir, 'output');
    fs.mkdirSync(outDir, { recursive: true });
    const paper = fin.paper ? await makePaperTexture(w, h, path.join(work, 'paper.png'), { signal: this.abort.signal }) : null;
    const clean = path.join(outDir, 'animation_clean.mp4');
    this.setStep('render', { message: '컷을 잇고 필름 느낌·노래를 입히는 중…', progress: { done: n, total: n + 1 } });
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
    this.p.subsStale = true;
    this.log(`🎬 깨끗한 원본 (자막 없음): ${this.rel(clean)} · ${xs.totalFrames}프레임`);
    this.save();
  }

  // ---------- 7. 자막 ----------
  async step_subtitles() {
    const out = this.p.output || {};
    if (!this.exists(out.clean)) throw new Error('깨끗한 원본 영상이 없습니다. [렌더링] 부터 다시 해 주세요.');
    const { w, h } = outputSize(this.wf.aspect, this.wf.quality);
    const t = this.p.timing;
    const xs = this.p.xsheet;
    const total = xs.totalFrames / X.FPS;
    const outDir = path.join(this.dir, 'output');
    const subs = this.wf.subtitles || {};
    const lyrics = (t.lyrics || []).filter((l) => l.start < total);
    const s = this.series;
    const name = `${safeName(`${s ? `${s.name} EP${s.episode} ` : ''}${this.p.plan.title}`)}.mp4`;
    const finalPath = path.join(outDir, name);
    if (subs.enabled !== false && lyrics.length) {
      let subtitlePngs = null;
      let assFile = null;
      if (this.renderSubtitles) {
        try {
          subtitlePngs = await this.renderSubtitles(lyrics, { w, h, style: subs, outDir: path.join(this.dir, 'work', 'subs') });
        } catch (e) {
          this.log(`⚠ 자막 이미지 생성 실패, 기본 자막으로 대체: ${e.message}`);
        }
      }
      if (!subtitlePngs) {
        assFile = path.join(this.dir, 'work', 'lyrics.ass');
        fs.mkdirSync(path.dirname(assFile), { recursive: true });
        fs.writeFileSync(assFile, buildAss(lyrics, { w, h, style: subs }));
      }
      this.setStep('subtitles', { message: '가사 자막을 입히는 중…' });
      await burnSubtitles({
        video: this.abs(out.clean), total, w, h, out: finalPath, subtitlePngs, assFile, signal: this.abort.signal,
        onProgress: (f) => this.setStep('subtitles', { message: `가사 자막 입히는 중 ${Math.round(f * 100)}%`, progress: { done: Math.round(f * 100), total: 100 } }),
      });
    } else {
      fs.copyFileSync(this.abs(out.clean), finalPath);
      this.log('ℹ 자막이 꺼져 있거나 가사가 없어서 깨끗한 원본을 그대로 완성본으로 씁니다.');
    }
    fs.writeFileSync(path.join(outDir, 'lyrics.srt'), toSrt(t.lyrics));
    fs.writeFileSync(path.join(outDir, 'lyrics.lrc'), toLrc(t.lyrics, this.p.plan.title));
    this.writeStoryboard();
    if (out.video && out.video !== this.rel(finalPath)) this.removeOld(out.video, finalPath);
    this.p.output = {
      ...out, video: this.rel(finalPath), srt: 'output/lyrics.srt', lrc: 'output/lyrics.lrc',
      storyboard: 'output/storyboard.md', timesheet: 'output/timesheet.json', madeAt: Date.now(),
    };
    this.p.subsStale = false;
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
  /** 그림 한 장만 다시 그리기 (진행 중이 아닐 때) */
  async regenerate(kind, shotNo, { id, prompt } = {}) {
    if (kind !== 'drawing') throw new Error('알 수 없는 항목입니다.');
    if (this.running) throw new Error('진행 중에는 다시 그릴 수 없습니다. 먼저 중지하세요.');
    const it = (this.p.drawings || []).find((x) => x.shot === shotNo && x.id === id);
    if (!it) throw new Error('그림을 찾을 수 없습니다.');
    this.running = true;
    this.abort = new AbortController();
    this.save();
    try {
      if (prompt && prompt !== it.prompt) { it.prompt = prompt; it.custom = true; }
      it.status = 'running';
      this.save();
      const rel = await this.drawOne(it);
      if (rel) { Object.assign(it, { file: rel, status: 'done', error: null, updatedAt: Date.now() }); this.p.renderStale = true; } else it.status = it.file ? 'done' : 'pending';
      this.log(`✔ 그림 컷${shotNo}-${id} 다시 그리기 완료`);
    } catch (e) {
      it.status = 'error';
      it.error = e.message.split('\n')[0];
      this.log(`✖ 다시 그리기 실패: ${e.message}`);
      throw e;
    } finally {
      this.running = false;
      this.p.waiting = null;
      this.save();
    }
  }

  /** 사용자가 고른 그림 파일로 교체 */
  replaceItem(kind, shotNo, file, id) {
    if (kind !== 'drawing') throw new Error('알 수 없는 항목입니다.');
    const it = (this.p.drawings || []).find((x) => x.shot === shotNo && x.id === id);
    if (!it) throw new Error('그림을 찾을 수 없습니다.');
    const dst = path.join(this.dir, 'drawings', `shot${pad2(shotNo)}_${id}${path.extname(file).toLowerCase() || '.png'}`);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    this.removeOld(it.file, dst);
    fs.copyFileSync(file, dst);
    Object.assign(it, { file: this.rel(dst), status: 'done', error: null, updatedAt: Date.now() });
    this.p.renderStale = true;
    this.save();
  }

  /** 타임시트에서 그림 한 칸의 노출 프레임 바꾸기 (컷 길이는 그대로) */
  retime(shotNo, index, frames) {
    if (this.running) throw new Error('진행 중에는 바꿀 수 없습니다.');
    const xs = this.p.xsheet;
    const i = xs ? xs.shots.findIndex((s) => s.shot === shotNo) : -1;
    if (i < 0) throw new Error('컷을 찾을 수 없습니다.');
    xs.shots[i] = X.retimeExposure(xs.shots[i], index, frames);
    this.p.renderStale = true;
    this.writeStoryboard();
    this.save();
    return xs.shots[i];
  }

  /** 컷의 카메라 움직임 바꾸기 */
  setCamera(shotNo, move) {
    if (this.running) throw new Error('진행 중에는 바꿀 수 없습니다.');
    const xs = this.p.xsheet;
    const shot = xs && xs.shots.find((s) => s.shot === shotNo);
    if (!shot) throw new Error('컷을 찾을 수 없습니다.');
    shot.camera = X.normalizeCamera({ move }, shot.fx);
    this.p.renderStale = true;
    this.writeStoryboard();
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

  /** 가사 글 바꾸기 (붙여넣기 또는 .txt/.lrc/.srt 파일) */
  updateLyricsText(raw, filename) {
    if (this.running && !(this.p.waiting && this.p.waiting.key === 'review:lyrics')) throw new Error('진행 중에는 바꿀 수 없습니다.');
    const prev = (this.p.timing && this.p.timing.lyrics) || [];
    this.p.lyricsInput = parseLyrics(raw, filename);
    if (this.p.music && this.p.music.analysis) {
      const li = this.p.lyricsInput;
      if (this.cutsFixed && !li.timed && prev.length && li.lines.length === prev.length) {
        // 줄 수가 같으면 맞춰 둔 시간은 그대로 두고 글자만 바꾼다
        this.p.timing.lyrics = prev.map((l, i) => ({ ...l, text: li.lines[i].text, section: li.lines[i].section || l.section }));
      } else {
        // 바뀐 가사로 자막 줄을 바로 다시 계산 (가사 맞추기 대기 중이면 그 화면에 바로 반영)
        const c = this.computeLyrics();
        this.p.timing = { ...(this.p.timing || {}), lyrics: c.lyrics, lyricsSource: c.source };
      }
    }
    if (!this.running) {
      if (this.cutsFixed) { if (this.p.steps.subtitles) this.p.steps.subtitles.status = 'pending'; } else if (this.p.steps.timing) this.p.steps.timing.status = 'pending';
    }
    this.p.subsStale = true;
    this.writeStoryboard();
    this.save();
  }

  /** 탭으로 맞춘 가사 타이밍 저장 (구간 정보는 같은 순서의 기존 줄에서 가져온다) */
  updateLyrics(lyrics) {
    if (!this.p.timing) throw new Error('타이밍 단계가 아직 없습니다.');
    const prev = this.p.timing.lyrics || [];
    this.p.timing.lyrics = lyrics.map((l, i) => ({
      text: String(l.text), part: l.part || 1, start: Number(l.start), end: Number(l.end),
      section: (prev[i] && prev[i].text === l.text ? prev[i].section : l.section) || '',
      sectionStart: !!(prev[i] && prev[i].text === l.text ? prev[i].sectionStart : l.sectionStart),
    })).filter((l) => l.text && l.end > l.start).sort((a, b) => a.start - b.start);
    this.p.timing.lyricsSource = 'tap';
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

module.exports = { ProjectRunner, STEPS, STEP_LABELS };
