'use strict';
// 가사 자막 메서드 모음: ProjectRunner.prototype 에 섞인다 (runner.js 맨 아래 Object.assign). DESIGN §2.2
//  - setSubtitleStyle(style, {applyToSeries})  자막 모양 바꾸기
//  - setLyricLines(lines)                      가사 줄 전체 교체 (글 · 시간 · 숨기기 · 나누기 · 합치기 · 추가)
//  - saveSubtitles({style, lines, applyToSeries})  위 둘을 한 번에 (질문 없이 '고침' 표시만)
// 줄 계산(합치기 · 정리)은 pipeline/subs-core.js 에 있다. 이 파일의 `_` 로 시작하는 것은 안쪽 도우미다.
const S = require('../../shared/subtitle-style');
const L = require('../media/lyrics');
const C = require('./subs-core');
const { outputSize } = require('../media/assemble');

module.exports = {
  /** 영상 출력 크기 { w, h } */
  _subsSize() {
    return outputSize(this.wf.aspect, this.wf.quality);
  },

  /** 7단계(자막 입히기)가 지금 돌고 있으면 고칠 수 없다 */
  _assertSubsIdle() {
    const st = this.p.steps && this.p.steps.subtitles;
    if (this.running && st && st.status === 'running') throw new Error('지금 자막을 영상에 입히는 중이에요. 끝난 뒤에 고쳐 주세요.');
  },

  /** 자막이 바뀌었다고 표시: 다음에 자막 단계가 다시 돈다 (컷이 정해진 뒤라면 단계를 '대기'로) */
  _markSubsStale() {
    this.p.subsStale = true;
    if (this.cutsFixed && this.p.steps.subtitles) this.p.steps.subtitles.status = 'pending';
  },

  /** 지금 프로젝트의 자막 모양(정규화본) */
  _subtitleStyle() {
    return S.normalizeStyle(this.wf.subtitles, this._subsSize());
  },

  /** 시리즈 전체의 기본 모양으로 저장 (enabled 는 에피소드마다 따로 정하므로 뺀다) */
  _saveSeriesStyle(style) {
    const s = this.series;
    if (!s || !s.id) return false;
    try {
      const { enabled, ...look } = style; // eslint-disable-line no-unused-vars
      this.store.series.save({ id: s.id, subtitleStyle: look });
      this.log('📺 이 모양을 이야기 모음(시리즈) 전체의 기본 자막으로 저장했어요.');
      return true;
    } catch (e) {
      this.log(`⚠ 시리즈에 자막 모양을 저장하지 못했어요: ${e.message}`);
      return false;
    }
  },

  /** 줄 목록을 검사해 정리하고, 사라지는 맞춘 줄 수를 센다 (아직 적용하지 않는다) */
  _prepareLines(lines) {
    const duration = (this.p.song && this.p.song.duration) || (this.p.music && this.p.music.analysis && this.p.music.analysis.duration) || 0;
    const prev = (this.p.timing && this.p.timing.lyrics) || [];
    const clean = C.cleanLyricLines(lines, { duration, prev });
    const timed = this.p.timing && this.p.timing.lyricsSource && this.p.timing.lyricsSource !== 'auto';
    const lost = timed && prev.length ? C.lostCount(prev, clean) : 0;
    return { clean, lost: Math.max(0, lost) };
  },

  /** 정리한 줄을 적용: timing.lyrics · 원문(lyricsInput) · 컷의 가사 번호 · '고침' 표시 */
  _commitLines(clean) {
    if (!this.p.timing) this.p.timing = {};
    this.p.timing.lyrics = clean;
    this.p.timing.lyricsSource = 'tap'; // 사용자가 직접 정한 시간 → 다시 계산하지 않고 그대로 쓴다
    const li = this.p.lyricsInput || {};
    this.p.lyricsInput = {
      raw: L.linesToRaw(clean),
      source: 'text',
      lines: clean.map((l) => ({ text: l.text, section: l.section, sectionStart: l.sectionStart, gapBefore: 0, ...(l.hidden ? { hidden: true } : {}) })),
      timed: null,
      sections: [...new Set(clean.map((l) => l.section).filter(Boolean))],
      trailingGaps: li.trailingGaps || 0,
    };
    C.relinkSegments(this.p.timing.segments, clean);
    this._markSubsStale();
    this.writeStoryboard();
  },

  /**
   * 자막 모양 바꾸기. style 은 일부 칸만 있어도, 옛 형식이어도 된다 (AMSubtitleStyle.mergeStyle 규칙).
   * 7단계가 돌고 있지 않으면 언제든 가능하다 (그림 그리는 중에도). 영상에는 다음에 자막 단계가 돌 때 반영된다.
   * @param {object} style
   * @param {{applyToSeries?:boolean}} [opts] applyToSeries: 이 모양을 시리즈 전체의 기본값으로도 저장
   * @returns {object} 정규화된 새 스타일 (AMSubtitleStyle.normalizeStyle 의 결과)
   */
  setSubtitleStyle(style, opts = {}) {
    this._assertSubsIdle();
    const next = S.mergeStyle(this.wf.subtitles, style, this._subsSize());
    this.wf.subtitles = next; // 새 객체로 바꾼다 (내장 워크플로우와 객체를 같이 쓰고 있을 수 있다)
    this._markSubsStale();
    if (opts && opts.applyToSeries) this._saveSeriesStyle(next);
    this.log(`💬 자막 모양을 바꿨어요 (${S.describe(next)})${next.enabled ? '' : ' · 자막 끔'}`);
    this.save();
    return next;
  },

  /**
   * 가사 줄 전체 교체 (글 고치기 · 나누기 · 합치기 · 숨기기 · 줄 추가/삭제 · 시간 고치기).
   * 줄 하나: { text, start, end, hidden?, endLocked?, section?, sectionStart? } (text 안의 '\n' 은 억지 줄바꿈).
   * 빈 글은 버리고 시작 시간 순으로 세운다. 끝 > 시작이 아니거나 없으면 다음 줄 직전까지(최대 7초)로 정하고,
   * endLocked:true 인 끝은 사용자가 정한 값이라 그대로 둔다. 노래 길이 밖은 안으로 자른다.
   * 원문(lyricsInput.raw)도 줄에서 다시 만들어 텍스트 칸과 어긋나지 않게 하고, 컷의 가사 번호도 다시 계산한다.
   * 시간은 '직접 맞춤'(lyricsSource 'tap')이 된다. 7단계가 돌고 있을 때만 막힌다.
   * @param {object[]} lines
   * @returns {object[]} 새 timing.lyrics
   */
  setLyricLines(lines) {
    this._assertSubsIdle();
    const { clean } = this._prepareLines(lines);
    this._commitLines(clean);
    this.log(`✏️ 가사 자막 ${clean.length}줄을 저장했어요.`);
    this.save();
    return this.p.timing.lyrics;
  },

  /**
   * 자막 모양과 가사 줄을 한 번에 저장 (질문 없이 '고침' 표시만 한다. 영상에 입히는 것은 부른 쪽이 이어서 시킨다).
   * 둘 다 검사를 통과해야 적용된다.
   * @param {{style?:object, lines?:object[], applyToSeries?:boolean}} [o]
   * @returns {{style:object, lines:object[], lost:number}} lost = 사라진 '맞춘 시간' 줄 수
   */
  saveSubtitles(o = {}) {
    this._assertSubsIdle();
    const has = (v) => v && typeof v === 'object' && !Array.isArray(v);
    if (o.lines !== undefined && o.lines !== null && !Array.isArray(o.lines)) throw new Error('가사 줄 목록이 올바르지 않아요.');
    let next = null;
    let prepared = null;
    if (has(o.style)) next = S.mergeStyle(this.wf.subtitles, o.style, this._subsSize());
    if (Array.isArray(o.lines)) prepared = this._prepareLines(o.lines);
    if (next) {
      this.wf.subtitles = next;
      this._markSubsStale();
      if (o.applyToSeries) this._saveSeriesStyle(next);
    }
    if (prepared) {
      this._commitLines(prepared.clean);
      this.log(`✏️ 가사 자막 ${prepared.clean.length}줄을 저장했어요.`);
    }
    if (next) this.log(`💬 자막 모양을 바꿨어요 (${S.describe(next)})${next.enabled ? '' : ' · 자막 끔'}`);
    if (next || prepared) this.save();
    return { style: this._subtitleStyle(), lines: (this.p.timing && this.p.timing.lyrics) || [], lost: prepared ? prepared.lost : 0 };
  },
};
