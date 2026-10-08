'use strict';
// 편집 메서드 모음: ProjectRunner.prototype 에 섞인다 (runner.js 맨 아래 Object.assign).
// 구현 담당: 편집 백엔드 작업 (DESIGN §3). 아직 구현 전에는 부르면 알기 쉬운 오류가 난다.
const notYet = (name) => function notImplemented() { throw new Error(`${name} 은(는) 아직 구현되지 않았어요.`); };

module.exports = {
  restoreVersion: notYet('restoreVersion'), // (shot, drawingId, index) 예전 그림으로 되돌리기
  regenerateCut: notYet('regenerateCut'), // (shot) 이 장면 그림 전부 다시 그리기
  setTransition: notYet('setTransition'), // (shot, type) 다음 장면으로 넘어가는 모양
  setFx: notYet('setFx'), // (shot, fxArray) 효과
  previewShot: notYet('previewShot'), // (shot) 이 장면만 영상으로 미리보기
  applyChanges: notYet('applyChanges'), // () 고친 것 반영하기
  setMotion: notYet('setMotion'), // ({motionMode, drawingBudget}) 그림 줄이기
};
