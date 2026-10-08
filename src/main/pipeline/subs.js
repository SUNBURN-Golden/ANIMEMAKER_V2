'use strict';
// 가사 자막 메서드 모음: ProjectRunner.prototype 에 섞인다 (runner.js 맨 아래 Object.assign).
// 구현 담당: 자막 백엔드 작업 (DESIGN §2).
const notYet = (name) => function notImplemented() { throw new Error(`${name} 은(는) 아직 구현되지 않았어요.`); };

module.exports = {
  setSubtitleStyle: notYet('setSubtitleStyle'), // (style, {applyToSeries})
  setLyricLines: notYet('setLyricLines'), // (lines)
  saveSubtitles: notYet('saveSubtitles'), // ({style, lines, applyToSeries})
};
