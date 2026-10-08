// 인물 그림 배경 빼기 일꾼 — 자리만 잡아 둔 것 (C2 가 keyer-core 로 채운다)
//
// 약속(채울 때 지킬 모양):
//   받는 것  { id, type:'key', bitmap: ImageBitmap, keyColor: '#00ff00', ... }
//   돌려주는 것  { id, type:'key', ok: true, ... }  또는  { id, type:'key', ok: false, error: '한국어 메시지' }
// 일은 한 번에 하나씩 하고, 큰 그림은 transfer 로 주고받는다.
self.onmessage = (ev) => {
  const { id, type } = ev.data || {};
  self.postMessage({ id, type, ok: false, error: '배경 빼기 일꾼이 아직 만들어지지 않았어요' });
};
