'use strict';
// 편집 IPC (DESIGN §3.3). main.js 의 registerIpc 안에서 한 줄로 등록된다.
module.exports = function registerEditIpc(h, { getRunner }) {
  h('proj:restoreVersion', (id, shot, drawingId, index) => getRunner(id).restoreVersion(shot, drawingId, index));
  h('proj:regenerateCut', (id, shot) => getRunner(id).regenerateCut(shot));
  h('proj:setTransition', (id, shot, type) => getRunner(id).setTransition(shot, type));
  h('proj:setFx', (id, shot, fx) => getRunner(id).setFx(shot, fx));
  h('proj:previewShot', (id, shot) => getRunner(id).previewShot(shot));
  h('proj:applyChanges', (id) => getRunner(id).applyChanges());
  h('proj:setMotion', (id, patch) => getRunner(id).setMotion(patch || {}));
};
