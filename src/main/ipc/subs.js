'use strict';
// 가사 자막 IPC (DESIGN §2.2). main.js 의 registerIpc 안에서 한 줄로 등록된다.
module.exports = function registerSubsIpc(h, { getRunner }) {
  h('proj:setSubtitleStyle', (id, style, opts) => getRunner(id).setSubtitleStyle(style, opts || {}));
  h('proj:setLyricLines', (id, lines) => getRunner(id).setLyricLines(lines));
  h('proj:saveSubtitles', (id, o) => getRunner(id).saveSubtitles(o || {}));
};
