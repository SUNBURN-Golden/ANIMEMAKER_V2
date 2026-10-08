// 화면전환 그리기 — PC 앱의 ffmpeg xfade 와 같은 이름 · 비슷한 느낌을 canvas 로 (V1 mobile/src/transitions.js 를 고쳐 옮김).
//   drawTransition(ctx, xfade, a, b, p, w, h)
//   a = 나가는 장면(그려진 w×h 캔버스), b = 들어오는 장면, p = 0→1 진행도 (0 = a 그대로, 1 = b 그대로).
//   p 는 frames.js 의 frameInfo().tr.p = k / T (T = 전환 프레임 수, k = 전환 안 번호) 를 그대로 넣는다 — 첫 장은 p=0, 컷 경계 장은 p=0.5.
// 이름은 media/timeline.js 의 TRANSITIONS[*].xfade 값과 같다. ffmpeg 와 똑같은 픽셀은 아니다:
//   dissolve 는 ffmpeg 가 알갱이로 흩어지듯 섞는 것을 부드러운 교차(ease)로, smoothleft 는 부드러운 경계의 닦기를 부드럽게 밀기(ease)로 대신한다.

export const TRANSITION_NAMES = ['fade', 'dissolve', 'fadeblack', 'fadewhite', 'slideleft', 'smoothleft', 'slideup', 'wipeleft', 'zoomin', 'circleopen', 'pixelize'];

const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - ((-2 * x + 2) ** 2) / 2);

let pixCanvas = null;
function pixelated(ctx, src, w, h, block) {
  const sw = Math.max(1, Math.round(w / block));
  const sh = Math.max(1, Math.round(h / block));
  if (!pixCanvas) pixCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(sw, sh) : document.createElement('canvas');
  if (pixCanvas.width !== sw) pixCanvas.width = sw;
  if (pixCanvas.height !== sh) pixCanvas.height = sh;
  const pc = pixCanvas.getContext('2d');
  pc.imageSmoothingEnabled = true;
  pc.drawImage(src, 0, 0, sw, sh);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(pixCanvas, 0, 0, sw, sh, 0, 0, w, h);
  ctx.restore();
}

function overlay(ctx, w, h, color, alpha) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

function withAlpha(ctx, alpha, fn) {
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  fn();
  ctx.restore();
}

/** 쓸 수 있는 이름인가 (모르는 이름은 'fade' 처럼 섞는다) */
export const isKnownTransition = (name) => TRANSITION_NAMES.includes(name);

/**
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx 결과를 그릴 곳 (w×h)
 * @param {string} xfade 'fade' | 'dissolve' | 'fadeblack' | 'fadewhite' | 'slideleft' | 'smoothleft' | 'slideup' | 'wipeleft' | 'zoomin' | 'circleopen' | 'pixelize'
 * @param {CanvasImageSource} a 나가는 장면 @param {CanvasImageSource} b 들어오는 장면 @param {number} p 0→1
 */
export function drawTransition(ctx, xfade, a, b, p, w, h) {
  p = Math.max(0, Math.min(1, p));
  switch (xfade) {
    case 'fadeblack':
    case 'fadewhite': {
      const color = xfade === 'fadeblack' ? '#000' : '#fff';
      if (p < 0.5) { ctx.drawImage(a, 0, 0, w, h); overlay(ctx, w, h, color, p * 2); } else { ctx.drawImage(b, 0, 0, w, h); overlay(ctx, w, h, color, (1 - p) * 2); }
      return;
    }
    case 'slideleft':
    case 'smoothleft': {
      const e = xfade === 'smoothleft' ? ease(p) : p;
      ctx.drawImage(a, -e * w, 0, w, h);
      ctx.drawImage(b, (1 - e) * w, 0, w, h);
      return;
    }
    case 'slideup': {
      ctx.drawImage(a, 0, -p * h, w, h);
      ctx.drawImage(b, 0, (1 - p) * h, w, h);
      return;
    }
    case 'wipeleft': {
      ctx.drawImage(a, 0, 0, w, h);
      const x = (1 - p) * w;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, 0, w - x, h);
      ctx.clip();
      ctx.drawImage(b, 0, 0, w, h);
      ctx.restore();
      return;
    }
    case 'circleopen': {
      ctx.drawImage(a, 0, 0, w, h);
      ctx.save();
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, ease(p) * Math.hypot(w, h) / 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(b, 0, 0, w, h);
      ctx.restore();
      return;
    }
    case 'zoomin': {
      const z = 1 + ease(p) * 0.6;
      ctx.drawImage(a, (w - w * z) / 2, (h - h * z) / 2, w * z, h * z);
      withAlpha(ctx, ease(p), () => ctx.drawImage(b, 0, 0, w, h));
      return;
    }
    case 'pixelize': {
      const block = 2 + 46 * (1 - Math.abs(p * 2 - 1));
      pixelated(ctx, p < 0.5 ? a : b, w, h, block);
      return;
    }
    case 'dissolve':
    case 'fade':
    default:
      ctx.drawImage(a, 0, 0, w, h);
      withAlpha(ctx, xfade === 'dissolve' ? ease(p) : p, () => ctx.drawImage(b, 0, 0, w, h));
  }
}
