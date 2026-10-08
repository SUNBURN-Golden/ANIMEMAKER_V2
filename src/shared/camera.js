'use strict';
/* 카메라 움직임 공용 모듈 (UMD): 자리 표시. A2 작업에서 xsheet.js 의 순수 함수를 꺼내 채운다 (DESIGN §3.5). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AMCamera = api;
}(typeof self !== 'undefined' ? self : this, () => ({})));
