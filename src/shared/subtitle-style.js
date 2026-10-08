'use strict';
/* 가사 자막 스타일 공용 모듈 (UMD): 자리 표시. A1 작업에서 구현 (DESIGN §2.1). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AMSubtitleStyle = api;
}(typeof self !== 'undefined' ? self : this, () => ({})));
