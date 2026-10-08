// 화면전환 그리기 (PC 앱의 ffmpeg xfade 와 같은 이름·느낌을 canvas 로)
// a = 나가는 장면, b = 들어오는 장면, p = 0→1 진행도

const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - ((-2 * x + 2) ** 2) / 2);

let pixCanvas = null;
function pixelated(ctx, src, w, h, block) {
  const sw = Math.max(1, Math.round(w / block));
  const sh = Math.max(1, Math.round(h / block));
  if (!pixCanvas) pixCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(sw, sh) : document.createElement('canvas');
  pixCanvas.width = sw;
  pixCanvas.height = sh;
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

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} xfade PC 앱 TRANSITIONS 의 xfade 이름 (fade, dissolve, fadeblack, fadewhite, slideleft, ...)
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
      withAlpha(ctx, 1, () => ctx.drawImage(a, (w - w * z) / 2, (h - h * z) / 2, w * z, h * z));
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
