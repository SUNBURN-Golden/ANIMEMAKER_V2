'use strict';
// 편집 IPC (DESIGN §3.3). main.js 의 registerIpc 안에서 한 줄로 등록된다.
//  proj:regenerate / proj:replace / proj:retime / proj:setCamera 는 main.js 에 있다 (이름은 그대로, 인자만 늘었다).
//  모두 { ok, data } 로 돌려주고, 진행은 'project:update' 이벤트(스냅샷)로 알린다.
module.exports = function registerEditIpc(h, { getRunner }) {
  // 예전 그림으로 되돌리기: index = 이전 그림 번호 (0 = 가장 최근) → 바뀐 그림 항목
  h('proj:restoreVersion', (id, shot, drawingId, index) => getRunner(id).restoreVersion(shot, drawingId, index));
  // 이 장면의 그림 전부 다시 그리기 (배경 → 열쇠 그림 차례로) → 끝나면 { shot, drawings, cancelled? }
  h('proj:regenerateCut', (id, shot) => getRunner(id).regenerateCut(shot));
  // 다음 장면으로 넘어가는 모양 (timeline.TRANSITIONS 의 이름) → 새 전환 {type, xfade, duration, frames}
  h('proj:setTransition', (id, shot, type) => getRunner(id).setTransition(shot, type));
  // 장면 효과 (xsheet.FX_TYPES, 최대 3개) → 고친 장면
  h('proj:setFx', (id, shot, fx) => getRunner(id).setFx(shot, fx));
  // 장면 하나만 미리보기 → { file(절대 경로), seconds, from, to, hasAudio, cached }
  h('proj:previewShot', (id, shot) => getRunner(id).previewShot(shot));
  // 고친 것 반영하기 → { from } (오래 걸려서 바로 돌려주고 진행은 update 이벤트로. 할 일이 없으면 from:null)
  h('proj:applyChanges', (id) => getRunner(id).applyChanges());
  // 그림 줄여서 빨리: 이 영상의 움직임 방식 · 그림 장수 예산 바꾸기 → 새 예상
  h('proj:setMotion', (id, patch) => getRunner(id).setMotion(patch || {}));
  // 그렇게 바꾸면 몇 장·몇 분인지 어림만 해 본다 (아무것도 바꾸지 않는다) → { ready, pictures, minutes, text, ... }
  h('proj:estimateMotion', (id, patch) => getRunner(id).estimateMotion(patch || {}));
};
