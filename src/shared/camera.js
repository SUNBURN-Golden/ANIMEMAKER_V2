'use strict';
/*
 * 카메라 움직임 공용 모듈 (UMD) — DESIGN §2.1 · §3.5
 *   - Node(CommonJS): require('../shared/camera')   (pipeline/xsheet.js 가 여기서 가져와 그대로 다시 내보낸다)
 *   - 브라우저 <script>: window.AMCamera            (장면 고치기 화면의 카메라 미리보기가 쓴다)
 *   - esbuild 묶음(안드로이드): import / require
 * 화면 없이도 계산되는 순수 함수만 있다 (document · canvas · fs 를 쓰지 않는다).
 *
 * ── 카메라란 ───────────────────────────────────────────────────────────
 *   cam = { move, start:{zoom,x,y}, end:{zoom,x,y}, ease, shake? }
 *   구도 {zoom, x, y}: zoom 1 = 그림 전체, 2 = 가로세로 절반만 보임. x·y 는 -1~1 = 보이는 창이 그림 안에서 어디에 앉는지
 *   (-1 = 왼쪽/위 가장자리에 붙임, 0 = 가운데, 1 = 오른쪽/아래 가장자리에 붙임).
 *
 * ── 내보내는 것 (API) ───────────────────────────────────────────────────
 *   표      CAMERA_MOVES · CAMERA_PRESETS{move:{start,end,ease}} · EASES · ZOOM_MIN · ZOOM_MAX
 *   정리    normalizeCamera(raw, fx=[]) → cam   (모르는 움직임은 'hold', 빠진 구도는 미리 정한 값, 범위 밖은 안으로, 팬은 확대 여유 확보)
 *           normMove(name) → 움직임 이름 | null (별칭 'dollyin' · 'Pan Right' 도 알아본다)
 *   계산    easeP(p, ease) → 0~1 · cameraAt(cam, p) → {zoom,x,y}  (p = 컷 안 진행도 0~1)
 *   창      frameRect(fr, {cw,ch,W,H,dx,dy}) → {x0,y0,w,h,cx,cy}   크게 펼친 그림(cw×ch) 안에서 이 구도가 자르는 사각형 (소수점 그대로)
 *           cameraRect(cam, p, opts) = frameRect(cameraAt(cam,p), opts)
 *           parallaxFraming(fr, parallax=0.8) → 배경 판의 구도 (카메라보다 parallax 배만큼만 다가가고 x·y 는 그대로)
 *           unitRect(fr) → {x,y,w,h}  그림 전체를 0~1 로 본 창 (CSS 로 미리 움직일 때: 그림을 w 의 역수만큼 키우고 x·y 로 옮긴다)
 *   media/render.js 의 sampleFrame 이 쓰는 수식과 똑같다 (test/camera.test.js 가 기울기 그림으로 맞춰 본다).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AMCamera = api;
}(typeof self !== 'undefined' ? self : this, () => {
  const CAMERA_MOVES = ['hold', 'pan_left', 'pan_right', 'pan_up', 'pan_down', 'zoom_in', 'zoom_out', 'truck_in', 'truck_out', 'shake'];
  const EASES = ['linear', 'in', 'out', 'inout'];
  const ZOOM_MIN = 1;
  const ZOOM_MAX = 1.6;

  const f = (zoom, x = 0, y = 0) => ({ zoom, x, y });
  const CAMERA_PRESETS = {
    hold: { start: f(1.04), end: f(1.04), ease: 'linear' },
    pan_left: { start: f(1.25, 0.8), end: f(1.25, -0.8), ease: 'inout' },
    pan_right: { start: f(1.25, -0.8), end: f(1.25, 0.8), ease: 'inout' },
    pan_up: { start: f(1.25, 0, 0.8), end: f(1.25, 0, -0.8), ease: 'inout' },
    pan_down: { start: f(1.25, 0, -0.8), end: f(1.25, 0, 0.8), ease: 'inout' },
    zoom_in: { start: f(1.0), end: f(1.2, 0, -0.1), ease: 'inout' },
    zoom_out: { start: f(1.2, 0, -0.1), end: f(1.0), ease: 'inout' },
    truck_in: { start: f(1.0), end: f(1.45, 0, -0.15), ease: 'inout' },
    truck_out: { start: f(1.45, 0, -0.15), end: f(1.0), ease: 'inout' },
    shake: { start: f(1.08), end: f(1.08), ease: 'linear' },
  };

  const MOVE_ALIASES = {
    static: 'hold', still: 'hold', none: 'hold', fixed: 'hold', locked: 'hold', hold: 'hold',
    pan: 'pan_right', panleft: 'pan_left', panright: 'pan_right', panup: 'pan_up', pandown: 'pan_down',
    tiltup: 'pan_up', tiltdown: 'pan_down', tilt: 'pan_up',
    zoom: 'zoom_in', zoomin: 'zoom_in', zoomout: 'zoom_out', pushin: 'zoom_in', pullout: 'zoom_out', pullback: 'zoom_out',
    truck: 'truck_in', truckin: 'truck_in', truckout: 'truck_out', dollyin: 'truck_in', dollyout: 'truck_out', dolly: 'truck_in',
    shake: 'shake', camerashake: 'shake', rumble: 'shake',
  };

  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
  function key(s) { return String(s || '').toLowerCase().replace(/[^a-z]/g, ''); }

  function normMove(m) {
    const k = key(m);
    if (CAMERA_MOVES.includes(String(m || '').toLowerCase())) return String(m).toLowerCase();
    return MOVE_ALIASES[k] || null;
  }

  function normFraming(o, d) {
    const src = o && typeof o === 'object' ? o : {};
    return {
      zoom: Math.round(clamp(num(src.zoom ?? src.z ?? src.scale, d.zoom), ZOOM_MIN, ZOOM_MAX) * 1000) / 1000,
      x: Math.round(clamp(num(src.x, d.x), -1, 1) * 1000) / 1000,
      y: Math.round(clamp(num(src.y, d.y), -1, 1) * 1000) / 1000,
    };
  }

  /** 카메라 정리: 모르는 움직임은 'hold', 빠진 구도는 미리 정한 값으로 */
  function normalizeCamera(raw, fx = []) {
    const src = raw && typeof raw === 'object' ? raw : { move: raw };
    const move = normMove(src.move || src.type || src.name) || 'hold';
    const preset = CAMERA_PRESETS[move];
    const start = normFraming(src.start || src.from, preset.start);
    const end = normFraming(src.end || src.to, preset.end);
    if (move.startsWith('pan_')) {
      // 팬은 움직일 여유(확대)가 있어야 한다
      start.zoom = Math.max(start.zoom, 1.15);
      end.zoom = Math.max(end.zoom, 1.15);
    }
    if (move === 'shake' || fx.includes('shake')) {
      start.zoom = Math.max(start.zoom, 1.06);
      end.zoom = Math.max(end.zoom, 1.06);
    }
    const ease = EASES.includes(src.ease) ? src.ease : preset.ease;
    const cam = { move, start, end, ease };
    if (move === 'shake') cam.shake = clamp(num(src.shake ?? src.amount, 0.012), 0.002, 0.03);
    return cam;
  }

  function easeP(p, ease) {
    const t = clamp(p, 0, 1);
    if (ease === 'in') return t * t;
    if (ease === 'out') return 1 - (1 - t) * (1 - t);
    if (ease === 'inout') return t * t * (3 - 2 * t);
    return t;
  }

  /** 진행도 p(0~1) 에서의 카메라 구도 */
  function cameraAt(cam, p) {
    const e = easeP(p, cam.ease);
    const lerp = (a, b) => a + (b - a) * e;
    return { zoom: lerp(cam.start.zoom, cam.end.zoom), x: lerp(cam.start.x, cam.end.x), y: lerp(cam.start.y, cam.end.y) };
  }

  /**
   * 크게 펼친 그림(cw×ch) 안에서 이 구도가 자르는 사각형. media/render.js sampleFrame 의 윗부분 수식과 똑같다.
   * dx·dy 는 출력(W×H) 기준 픽셀 단위 흔들림 (카메라 흔들기 · 손그림 보일).
   * @param {{zoom:number,x:number,y:number}} fr
   * @param {{cw:number,ch:number,W?:number,H?:number,dx?:number,dy?:number}} o  W·H 를 안 주면 cw·ch (= 흔들림을 그림 픽셀로 센다)
   * @returns {{x0:number,y0:number,w:number,h:number,cx:number,cy:number}} x0·y0 = 왼쪽 위, w·h = 창 크기, cx·cy = 창 가운데
   */
  function frameRect(fr, o) {
    const { cw, ch } = o;
    const W = o.W || cw;
    const H = o.H || ch;
    const dx = o.dx || 0;
    const dy = o.dy || 0;
    const winW = cw / fr.zoom;
    const winH = ch / fr.zoom;
    const cx = cw / 2 + fr.x * (cw - winW) / 2 + dx * (winW / W);
    const cy = ch / 2 + fr.y * (ch - winH) / 2 + dy * (winH / H);
    return { x0: cx - winW / 2, y0: cy - winH / 2, w: winW, h: winH, cx, cy };
  }

  /** 컷 안 진행도 p 에서 카메라가 자르는 사각형 */
  function cameraRect(cam, p, o) { return frameRect(cameraAt(cam, p), o); }

  /** 배경 판의 구도: 카메라보다 parallax 배만큼만 다가가고 움직인다 (같은 x·y 로 정확히 parallax 배 이동). media/render.js parallaxFraming 과 같다 */
  function parallaxFraming(fr, parallax = 0.8) {
    return { zoom: 1 + (fr.zoom - 1) * parallax, x: fr.x, y: fr.y };
  }

  /** 그림 전체를 0~1 로 본 창. 화면에 CSS 로 흉내 낼 때: 그림을 1/w 배로 키우고 왼쪽 위를 (x, y) 에 맞춘다 */
  function unitRect(fr) {
    const r = frameRect(fr, { cw: 1, ch: 1 });
    return { x: r.x0, y: r.y0, w: r.w, h: r.h };
  }

  return {
    VERSION: 1,
    CAMERA_MOVES, CAMERA_PRESETS, EASES, ZOOM_MIN, ZOOM_MAX,
    normMove, normalizeCamera, easeP, cameraAt,
    frameRect, cameraRect, parallaxFraming, unitRect,
  };
}));
