// 필름 느낌 마무리 (Canvas2D): PC 앱 assemble.finishFilters 의 근사.
//   순서는 PC 와 같다: 종이 질감(곱하기) → 따뜻한 색 → 비네팅(가장자리 어둡게) → 필름 알갱이.  화면전환까지 섞은 한 장 위에 한 번만 입힌다.
//   - 비네팅: ffmpeg vignette=angle=0.5 → 가운데에서 모서리까지(반지름 = 화면 대각선의 절반) 밝기에 cos⁴(0.5·d) 를 곱한다(모서리 ×0.59).
//     ffmpeg 는 이것을 방송용 범위(16~235)의 밝기 값 Y 에 곱해서, RGB 로 보면 곱한 뒤 0.073·255(=18.6)×(1-곱한 값) 만큼 더 어두워진다
//     (흰색 모서리 255 → 143, 곱하기만 하면 151). 그래서 곱하기(방사형 그라디언트)에 같은 모양의 빼기를 더한다. ffmpeg 와의 차이: 곱하기만 하면 4.4단계 → 이 방식 1.9단계.
//   - 따뜻한 색: ffmpeg colorbalance+eq 는 3D LUT 로 재 보면 거의 "파랑 -9, 초록 -1" 이다 (17³ LUT 을 직선(3×3 + 더하기)으로 맞춘 오차 평균 1.2단계,
//     상수 더하기만으로는 2.5단계, 아무것도 안 하면 4.5단계). 캔버스에는 '빼기'가 없어서 색 반전 → 더하기 → 색 반전(difference·lighter)으로 뺀다.
//     0 아래로는 내려가지 않아서 ffmpeg 처럼 어두운 곳이 막히지 않는다. 3D LUT(정밀)는 쓰지 않는다 (WebGL 이 필요해서 — 이 파일은 어디서나 돈다).
//     따뜻한 색과 비네팅은 반전한 상태에서 한꺼번에 한다 (반전 → 곱하기에 해당하는 흰색 덮기 → 따뜻한 색 + 비네팅 빼기를 더하기 → 반전: 칠하기 4번).
//     ffmpeg 필터 체인(colorbalance+eq → 비네팅)과 비교(1280×720 장면 3장): 따뜻한 색만 2.3~2.7 · 비네팅만 1.8 · 둘 다 2.5~2.6단계 (4:2:0 왕복만으로도 1.4단계, 아무것도 안 하면 24~26).
//   - 알갱이(grain)·종이(paper)는 기본으로 꺼져 있다 (알갱이는 압축을 어렵게 한다).
// 모두 캔버스 전체 칠하기 몇 번이라 getImageData 가 없고 GPU 캔버스에서 빠르다.

export const DEFAULT_FINISH = Object.freeze({ boil: true, vignette: true, warm: true, grain: false, paper: false });

/** 폰 기본 마무리 (boil/vignette/warm 켬, grain/paper 끔). 모르는 칸은 버리고 불리언으로 */
export function normalizeFinish(f) {
  const out = { ...DEFAULT_FINISH };
  if (f && typeof f === 'object') for (const k of Object.keys(DEFAULT_FINISH)) if (k in f) out[k] = !!f[k];
  return out;
}

export const VIGNETTE_ANGLE = 0.5;
/** 가운데에서 모서리까지의 거리 d(0~1) 에서 밝기에 곱하는 값 */
export const vignetteFactor = (d) => Math.cos(VIGNETTE_ANGLE * d) ** 4;
/** 방송용 범위(16~235) 의 밝기에 곱한 것을 RGB 로 보면 더 빼지는 양: 255 × 16 / 219 */
export const VIGNETTE_LIFT = (255 * 16) / 219;
/** 빼는 양 (0~255): 따뜻한 색 = 파랑 -9, 초록 -1 */
export const WARM_SUBTRACT = Object.freeze({ r: 0, g: 1, b: 9 });
/** 필름 알갱이: 타일 크기 · 섞는 세기 */
const GRAIN_TILE = 256;
const GRAIN_ALPHA = 0.14;
const PAPER_ALPHA = 0.22;

/** 같은 입력이면 같은 값이 나오는 난수 (0~1) */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function noiseTile(makeCanvas, size, seed, amp) {
  const c = makeCanvas(size, size);
  const cx = c.getContext('2d');
  const img = cx.createImageData(size, size);
  const rnd = mulberry32(seed);
  for (let i = 0; i < size * size; i++) {
    const v = Math.round(128 + (rnd() * 2 - 1) * amp);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  cx.putImageData(img, 0, 0);
  return c;
}

/** 은은한 종이 질감 한 장 (PC 앱 makePaperTexture 근사: 크림색 바탕 + 퍼진 알갱이, 대비를 낮춤) */
export function makePaper(makeCanvas, W, H, seed = 7) {
  const tile = 256;
  const base = makeCanvas(tile, tile);
  const bx = base.getContext('2d');
  const img = bx.createImageData(tile, tile);
  const rnd = mulberry32(seed);
  const clamp = (v) => Math.max(0, Math.min(255, v));
  for (let i = 0; i < tile * tile; i++) {
    const n = (rnd() * 2 - 1) * 38;
    img.data[i * 4] = clamp(0xf7 + n);
    img.data[i * 4 + 1] = clamp(0xf0 + n);
    img.data[i * 4 + 2] = clamp(0xe2 + n);
    img.data[i * 4 + 3] = 255;
  }
  bx.putImageData(img, 0, 0);
  const c = makeCanvas(W, H);
  const cx = c.getContext('2d');
  // 타일을 반복해 깔고(이음새는 흐림으로 가린다) 흐리게(blur 1.6px) · 대비를 낮춘다
  cx.fillStyle = cx.createPattern(base, 'repeat');
  cx.fillRect(0, 0, W, H);
  const soft = makeCanvas(W, H);
  const sx = soft.getContext('2d');
  sx.filter = 'blur(1.6px) contrast(0.55) brightness(1.03)';
  sx.drawImage(c, 0, 0);
  sx.filter = 'none';
  return soft;
}

/**
 * 마무리 도구 하나. apply(ctx, r) 가 W×H 컨텍스트에 있는 완성된 한 장 위에 효과를 입힌다.
 * @param {{W:number,H:number,finish?:object,seed?:number,makeCanvas:(w:number,h:number)=>any}} o
 * @returns {{active:boolean, flags:object, apply:(ctx:any, r:number)=>void, dispose:()=>void}}
 */
export function createFinish({ W, H, finish, seed = 1, makeCanvas }) {
  const flags = normalizeFinish(finish);
  const active = flags.warm || flags.vignette || flags.grain || flags.paper;
  const gradients = new WeakMap();
  let grain = null;
  let grainPattern = null; // 컨텍스트마다 다르게 만들어야 해서 매번 만들되 타일은 하나를 쓴다
  let paper = null;
  const rnd = (k, ch) => {
    // 프레임 번호와 채널로 정해지는 난수 (render-core.rand 와 같은 모양, 알갱이 위치용)
    let x = (Math.imul(seed | 0, 374761393) + Math.imul(k | 0, 668265263) + Math.imul(ch | 0, 2147483647)) | 0;
    x = Math.imul(x ^ (x >>> 13), 1274126177);
    x ^= x >>> 16;
    return (x >>> 0) / 4294967296;
  };

  /**
   * 방사형 그라디언트 둘 (반전한 상태에서 쓴다): dark = 흰색을 (1-f) 만큼 덮기(= x 에 f 곱하기),
   * lift = 더하기(= 빼기). 따뜻한 색(w)까지 합치면 f·(x-w) - 18.6(1-f) = f·x - (f·w + 18.6(1-f)) 라서 곱한 뒤 한 번에 뺀다.
   */
  function vignetteGradients(ctx) {
    let g = gradients.get(ctx);
    if (g) return g;
    const w = flags.warm ? WARM_SUBTRACT : { r: 0, g: 0, b: 0 };
    const R = Math.hypot(W / 2, H / 2);
    const dark = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, R);
    const lift = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, R);
    const STOPS = 16;
    for (let i = 0; i <= STOPS; i++) {
      const d = i / STOPS;
      const k = 1 - vignetteFactor(d);
      const f = 1 - k;
      const base = VIGNETTE_LIFT * k;
      dark.addColorStop(d, `rgba(255,255,255,${k.toFixed(5)})`);
      lift.addColorStop(d, `rgb(${Math.round(f * w.r + base)},${Math.round(f * w.g + base)},${Math.round(f * w.b + base)})`);
    }
    g = { dark, lift };
    gradients.set(ctx, g);
    return g;
  }

  return {
    active,
    flags,
    apply(ctx, r = 0) {
      if (!active) return;
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      if (flags.paper) {
        if (!paper) paper = makePaper(makeCanvas, W, H, 7 + (seed | 0));
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = PAPER_ALPHA;
        ctx.drawImage(paper, 0, 0, W, H);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
      if (flags.warm || flags.vignette) {
        // 반전한 상태(y = 255 - x)에서: 빼기 = 더하기, x 에 f 를 곱하기 = 흰색을 (1-f) 만큼 덮기
        ctx.globalCompositeOperation = 'difference';
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, W, H);
        if (flags.vignette) {
          const g = vignetteGradients(ctx);
          ctx.globalCompositeOperation = 'source-over';
          ctx.fillStyle = g.dark;
          ctx.fillRect(0, 0, W, H);
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = g.lift; // 따뜻한 색의 빼기도 이 안에 들어 있다
          ctx.fillRect(0, 0, W, H);
        } else {
          const s = WARM_SUBTRACT;
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = `rgb(${s.r},${s.g},${s.b})`;
          ctx.fillRect(0, 0, W, H);
        }
        ctx.globalCompositeOperation = 'difference';
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, W, H);
        ctx.globalCompositeOperation = 'source-over';
      }
      if (flags.grain) {
        if (!grain) grain = noiseTile(makeCanvas, GRAIN_TILE, 31 + (seed | 0), 25);
        const ox = Math.floor(rnd(r, 21) * GRAIN_TILE);
        const oy = Math.floor(rnd(r, 22) * GRAIN_TILE);
        grainPattern = ctx.createPattern(grain, 'repeat');
        ctx.globalCompositeOperation = 'overlay';
        ctx.globalAlpha = GRAIN_ALPHA;
        ctx.translate(-ox, -oy);
        ctx.fillStyle = grainPattern;
        ctx.fillRect(ox, oy, W, H);
      }
      ctx.restore();
    },
    dispose() {
      grain = null;
      paper = null;
    },
  };
}
