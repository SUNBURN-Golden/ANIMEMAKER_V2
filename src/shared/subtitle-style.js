'use strict';
/*
 * 가사 자막 스타일 공용 모듈 (UMD) — DESIGN §2.1
 *   - Node(CommonJS): require('../shared/subtitle-style')
 *   - 브라우저 <script>: window.AMSubtitleStyle
 *   - esbuild 묶음(안드로이드): import / require
 * 화면 없이도 계산되는 순수 함수만 있다 (document·canvas 를 쓰지 않는다).
 *
 * ── 정규화된 스타일 (normalizeStyle 의 결과) ─────────────────────────────
 *   { enabled:true,
 *     preset:'basic'|'yellow'|'box'|'storybook'|'pop'|'shorts'|'minimal'|'custom',  // 겉모습이 프리셋과 같으면 그 이름, 아니면 'custom'
 *     size:'s'|'m'|'l'|'xl',  sizeScale:1,          // 글자 크기: 단계 × 배율(0.6~2, 고급)
 *     position:'top'|'middle'|'bottom',  marginPct:null,   // marginPct null = 안전영역 자동, 숫자 = 화면 높이의 % (위/아래 가장자리에서)
 *     color:'#ffffff', outline:'none'|'thin'|'normal'|'thick', outlineColor:'#000000',
 *     box:'none'|'soft'|'solid', boxColor:'#000000',
 *     font:'pretendard'|'jua'|'dohyeon'|'gaegu'|'blackhan'|'system',
 *     shadow:true, fade:0.15, maxLines:2, safeArea:'auto'|'off' }
 *
 * ── 크기 ───────────────────────────────────────────────────────────
 *   글자 크기(px) = min(W,H) × 비율(가로 16:9 4.6% · 1:1 4.8% · 4:5 5.0% · 9:16 5.6%) × 단계(s .82 · m 1 · l 1.22 · xl 1.5) × sizeScale
 *   (720p 가로 영상이면 33px — 예전 기본값과 같다)
 *
 * ── 내보내는 것 (API) ────────────────────────────────────────────────
 *   표      PRESETS[{id,label,emoji,desc,style}] · PRESET_BY_ID · FONTS[{id,label,family,file,format,weight,stack,ass}] · FONT_BY_ID · SIZES · POSITIONS ·
 *           OUTLINES · BOXES · SAFE_AREAS · COLOR_SWATCHES(8) · LOOK_KEYS · SAMPLE_LINES · DEFAULT_STYLE · SYSTEM_STACK · FALLBACK_FAMILY · BASE_SIZE_PCT · ASPECTS
 *   정규화  normalizeStyle(raw, {w,h,aspect}) → 정규화 스타일 · fromLegacy(old, ctx) · isLegacy(raw) · matchPreset(style) → 프리셋 id | 'custom'
 *           applyPreset(style, presetId, ctx)  프리셋 고르기(켜기·위치·여백은 그대로)
 *           mergeStyle(base, patch, ctx)       일부 칸만 덮어쓰기 (틀린 값은 건너뛰고 지금 값 유지, patch.preset 이 새 프리셋이면 겉모습을 그 프리셋으로)
 *   크기    sizeFor(style, w, h) → px · layoutMetrics(style, w, h[, px]) · layoutBox(=layoutMetrics) · placeBox(style, w, h, boxW, boxH) → {x,y} ·
 *           safeRect(style, w, h) → {x,y,w,h,margin,vertical} · outlineWidth(style, px) · outlineAlpha(style) · boxAlpha(style) ·
 *           outputAspect(w, h) → '16:9'|'1:1'|'4:5'|'9:16' · outputSize(aspect, quality) → {w,h} (assemble.outputSize 와 같다)
 *   글꼴    fontStack(id) · fontCss(idOrStyle, px) → canvas font 문자열 · fontFaceCss(baseUrl) → @font-face 규칙 모음 · fontFamiliesFor(style)
 *   그 밖   styleSig(style) → 캐시 키 문자열 · normColor(v, fallback) · rgba(hex, a) · luminance(hex) · describe(style) → '기본 · 보통 · 아래 · 깔끔한 고딕'
 *
 * ── 옛 형식 ────────────────────────────────────────────────────────
 *   예전 project.json / 워크플로우의 { enabled, sizePct, color:'white'|'yellow', box:boolean, marginPct } 도 그대로 받는다.
 *   - preset 이 없는 옛 형식(= 이미 만든 에피소드): 예전 코드와 같은 글자 크기(화면 높이의 sizePct %)·여백·모양으로 입힌다 (글꼴은 'system').
 *   - preset 이 같이 있는 섞인 형식(= 새 워크플로우 + 옛 입력칸): 새 프리셋 위에 옛 값(기본값이 아닌 것만)을 덮어쓴다.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AMSubtitleStyle = api;
}(typeof self !== 'undefined' ? self : this, () => {
  // ---------- 표 ----------
  const ASPECTS = ['16:9', '1:1', '4:5', '9:16'];
  const ASPECT_RATIO = { '16:9': 16 / 9, '1:1': 1, '4:5': 4 / 5, '9:16': 9 / 16 };
  /** 글자 크기 기준: min(W,H) 의 % */
  const BASE_SIZE_PCT = { '16:9': 4.6, '1:1': 4.8, '4:5': 5.0, '9:16': 5.6 };
  /** 화질별 짧은 변 (assemble.outputSize 와 같다) */
  const QUALITY_SHORT = { '480p': 480, '720p': 720, '1080p': 1080 };
  const OLD_YELLOW = '#ffe14d';

  const SIZES = [
    { id: 's', label: '작게', mult: 0.82 },
    { id: 'm', label: '보통', mult: 1 },
    { id: 'l', label: '크게', mult: 1.22 },
    { id: 'xl', label: '아주 크게', mult: 1.5 },
  ];
  const POSITIONS = [
    { id: 'top', label: '위' },
    { id: 'middle', label: '가운데' },
    { id: 'bottom', label: '아래' },
  ];
  /** 테두리: 굵기 = max(min, 글자크기 × k) px (캔버스 lineWidth, 바깥으로는 절반) */
  const OUTLINES = [
    { id: 'none', label: '없음', k: 0, min: 0 },
    { id: 'thin', label: '얇게', k: 0.1, min: 2.5 },
    { id: 'normal', label: '보통', k: 0.16, min: 3 },
    { id: 'thick', label: '굵게', k: 0.26, min: 4 },
  ];
  /** 글자 바탕 상자의 진하기 */
  const BOXES = [
    { id: 'none', label: '없음', alpha: 0 },
    { id: 'soft', label: '은은하게', alpha: 0.55 },
    { id: 'solid', label: '진하게', alpha: 0.85 },
  ];
  const SAFE_AREAS = [
    { id: 'auto', label: '자동' },
    { id: 'off', label: '끄기' },
  ];
  /** 글자 색 견본 8개 */
  const COLOR_SWATCHES = ['#ffffff', OLD_YELLOW, '#fff3d6', '#ff9ec9', '#8fdcff', '#a8f0c6', '#ffb766', '#111111'];

  const SYSTEM_STACK = '"Malgun Gothic","맑은 고딕","Apple SD Gothic Neo","Noto Sans KR","Noto Sans CJK KR",sans-serif';
  const FALLBACK_FAMILY = 'AM Pretendard'; // 한글 전부를 가진 글꼴 — 다른 글꼴에 없는 글자는 이 글꼴이 채운다
  /**
   * 글꼴 표. file 은 src/renderer/assets/fonts/ 안의 파일 (전부 SIL OFL, 고치지 않은 원본).
   * family 는 @font-face 별칭 (fontFaceCss 로 만든다). ass 는 libass 대체 경로용: 글꼴 이름 · 굵게 여부 · 크기 보정 비율 k
   * (libass 의 글자 크기는 글꼴의 줄 높이(ascender-descender) 기준이라, em 크기에 k 를 곱해야 캔버스와 같은 크기로 보인다 — 실측).
   * 구글 한글 글꼴 4개는 흔한 한글 약 2,350~2,580자만 담고 있어서, 없는 글자는 스택의 다음 글꼴(Pretendard → 내 컴퓨터)로 채워진다.
   */
  const FONTS = [
    { id: 'pretendard', label: '깔끔한 고딕', family: 'AM Pretendard', file: 'Pretendard-Bold.otf', format: 'opentype', weight: 700, ass: { name: 'Pretendard', bold: true, k: 1.193 } },
    { id: 'jua', label: '동글동글', family: 'AM Jua', file: 'Jua-Regular.ttf', format: 'truetype', weight: 400, ass: { name: 'Jua', bold: false, k: 1.113 } },
    { id: 'dohyeon', label: '굵은 예능체', family: 'AM Do Hyeon', file: 'DoHyeon-Regular.ttf', format: 'truetype', weight: 400, ass: { name: 'Do Hyeon', bold: false, k: 1 } },
    { id: 'gaegu', label: '손글씨', family: 'AM Gaegu', file: 'Gaegu-Bold.ttf', format: 'truetype', weight: 700, ass: { name: 'Gaegu', bold: true, k: 1.004 } },
    { id: 'blackhan', label: '아주 굵게', family: 'AM Black Han Sans', file: 'BlackHanSans-Regular.ttf', format: 'truetype', weight: 400, ass: { name: 'Black Han Sans', bold: false, k: 1.02 } },
    { id: 'system', label: '내 컴퓨터 기본', family: null, file: null, format: null, weight: 700, ass: { name: null, bold: true, k: 1.3 } },
  ].map((f) => ({
    ...f,
    stack: f.family
      ? `"${f.family}",${f.family === FALLBACK_FAMILY ? '' : `"${FALLBACK_FAMILY}",`}${SYSTEM_STACK}`
      : SYSTEM_STACK,
  }));
  const FONT_BY_ID = {};
  FONTS.forEach((f) => { FONT_BY_ID[f.id] = f; });

  /** 겉모습을 이루는 칸들 (프리셋이 정한다) / 프리셋이 건드리지 않는 칸들 */
  const LOOK_KEYS = ['size', 'sizeScale', 'color', 'outline', 'outlineColor', 'box', 'boxColor', 'font', 'shadow', 'fade', 'maxLines', 'safeArea'];
  const KEEP_KEYS = ['enabled', 'position', 'marginPct'];

  const BASIC_LOOK = {
    size: 'm', sizeScale: 1, color: '#ffffff', outline: 'normal', outlineColor: '#000000', box: 'none', boxColor: '#000000',
    font: 'pretendard', shadow: true, fade: 0.15, maxLines: 2, safeArea: 'auto',
  };
  /**
   * 프리셋 7개. style 은 LOOK_KEYS 전부를 가진다.
   * basic 은 예전 기본값(흰 글씨 + 검은 테두리, 720p 에서 33px, 아래 8%)과 같은 모양이다.
   */
  const PRESETS = [
    { id: 'basic', label: '기본', emoji: '💬', desc: '흰 글씨 + 검은 테두리, 깔끔한 고딕', style: { ...BASIC_LOOK } },
    { id: 'yellow', label: '예능 노랑', emoji: '📺', desc: '노란 글씨 + 굵은 테두리, 굵은 예능체', style: { ...BASIC_LOOK, size: 'l', color: OLD_YELLOW, outline: 'thick', font: 'dohyeon' } },
    { id: 'box', label: '상자', emoji: '🔲', desc: '흰 글씨 + 반투명 검정 상자', style: { ...BASIC_LOOK, outline: 'none', box: 'soft' } },
    { id: 'storybook', label: '동화책', emoji: '📖', desc: '크림색 글씨 + 갈색 테두리, 손글씨체', style: { ...BASIC_LOOK, size: 'xl', color: '#fff3d6', outline: 'thick', outlineColor: '#5a3a1e', font: 'gaegu' } },
    { id: 'pop', label: '통통', emoji: '🍭', desc: '분홍 글씨 + 흰 굵은 테두리, 둥근체', style: { ...BASIC_LOOK, size: 'l', color: '#ff6fb5', outline: 'thick', outlineColor: '#ffffff', font: 'jua', shadow: false } },
    { id: 'shorts', label: '숏폼 큰 글씨', emoji: '📱', desc: '아주 크게, 굵은 체, 최대 2줄 (버튼에 안 가려지게 안전 영역)', style: { ...BASIC_LOOK, size: 'xl', outline: 'thick', font: 'blackhan' } },
    { id: 'minimal', label: '은은하게', emoji: '🌫', desc: '작은 흰 글씨 + 얇은 테두리', style: { ...BASIC_LOOK, size: 's', outline: 'thin', fade: 0.3 } },
  ];
  const PRESET_BY_ID = {};
  PRESETS.forEach((p) => { PRESET_BY_ID[p.id] = p; });

  /** 안전영역(%) — 9:16 은 쇼츠·릴스·틱톡 버튼 자리를 비운다 */
  const SAFE_VERTICAL = { top: 12, bottom: 24, left: 4, right: 12 };
  const SAFE_NORMAL = { top: 8, bottom: 8, left: 4, right: 4 };

  const SAMPLE_LINES = ['가사 글씨가 이렇게 보여요', '함께라면 두렵지 않아 우리의 노래가 돼'];

  // ---------- 작은 도구 ----------
  const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
  function num(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '') return Number(v);
    return NaN;
  }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function round(v, d) { const k = 10 ** d; return Math.round(v * k) / k; }
  const has = (list, id) => list.some((x) => x.id === id);

  /** 색 → '#rrggbb' (white·yellow·black 이름, #rgb, #rrggbb, #rrggbbaa, rgb() 허용). 틀리면 fallback */
  function normColor(v, fallback) {
    if (typeof v !== 'string') return fallback;
    const s = v.trim().toLowerCase();
    if (s === 'white') return '#ffffff';
    if (s === 'yellow') return OLD_YELLOW;
    if (s === 'black') return '#000000';
    let m = /^#([0-9a-f]{3})$/.exec(s);
    if (m) return `#${m[1].split('').map((c) => c + c).join('')}`;
    m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(s);
    if (m) return `#${m[1]}`;
    m = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(s);
    if (m) return `#${[m[1], m[2], m[3]].map((n) => clamp(Number(n), 0, 255).toString(16).padStart(2, '0')).join('')}`;
    return fallback;
  }
  /** 색의 밝기 0(검정)~1(흰색) */
  function luminance(hex) {
    const c = normColor(hex, '#000000');
    return (0.2126 * parseInt(c.slice(1, 3), 16) + 0.7152 * parseInt(c.slice(3, 5), 16) + 0.0722 * parseInt(c.slice(5, 7), 16)) / 255;
  }
  /** '#rrggbb' + 투명도 → 'rgba(r,g,b,a)' */
  function rgba(hex, a) {
    const c = normColor(hex, '#000000');
    return `rgba(${parseInt(c.slice(1, 3), 16)},${parseInt(c.slice(3, 5), 16)},${parseInt(c.slice(5, 7), 16)},${a})`;
  }

  // ---------- 화면 비율 · 출력 크기 ----------
  /** 가로·세로 → 가장 가까운 화면 비율 ('16:9' | '1:1' | '4:5' | '9:16') */
  function outputAspect(w, h) {
    const W = Number(w);
    const H = Number(h);
    if (!(W > 0) || !(H > 0)) return '16:9';
    const r = W / H;
    let best = '16:9';
    let bd = Infinity;
    for (const a of ASPECTS) {
      const d = Math.abs(Math.log(r / ASPECT_RATIO[a]));
      if (d < bd) { bd = d; best = a; }
    }
    return best;
  }
  /** 화면 비율 + 화질 → 출력 해상도 (src/main/media/assemble.js outputSize 와 같은 값) */
  function outputSize(aspect, quality = '720p') {
    const short = QUALITY_SHORT[quality] || 720;
    const long = Math.round((short * 16) / 9 / 2) * 2;
    switch (aspect) {
      case '16:9': return { w: long, h: short };
      case '1:1': return { w: short, h: short };
      case '4:5': return { w: short, h: Math.round((short * 5) / 4 / 2) * 2 };
      case '9:16':
      default: return { w: short, h: long };
    }
  }
  /** ctx 정리: { w, h, aspect } (w·h 가 없으면 화면 비율의 720p 크기, 아무것도 없으면 1280×720) */
  function resolveCtx(ctx) {
    const c = isObj(ctx) ? ctx : {};
    let w = Number(c.w);
    let h = Number(c.h);
    let aspect = ASPECTS.includes(c.aspect) ? c.aspect : null;
    if (!(w > 0) || !(h > 0)) {
      const o = outputSize(aspect || '16:9', '720p');
      w = o.w; h = o.h; aspect = aspect || '16:9';
    } else if (!aspect) {
      aspect = outputAspect(w, h);
    }
    return { w, h, aspect };
  }

  // ---------- 옛 형식 ----------
  /** 옛 형식인가: sizePct 가 있거나 box 가 true/false */
  function isLegacy(raw) {
    return isObj(raw) && (raw.sizePct !== undefined || typeof raw.box === 'boolean');
  }

  /**
   * 옛 형식 → 새 형식의 일부 칸 (normalizeStyle 이 마저 채운다).
   * @param {object} old
   * @param {{w:number,h:number,aspect:string}} c
   * @param {boolean} pure true = preset 이 없는 옛 형식(이미 만든 에피소드) → 예전과 똑같이
   */
  function legacyPartial(old, c, pure) {
    const out = {};
    if (old.enabled !== undefined) out.enabled = old.enabled;
    if (!pure) {
      // 섞인 형식: 새 칸은 그대로 두고 옛 값만 덮어쓴다
      out.preset = old.preset;
      for (const k of ['size', 'sizeScale', 'position', 'outline', 'outlineColor', 'boxColor', 'font', 'shadow', 'fade', 'maxLines', 'safeArea']) if (old[k] !== undefined) out[k] = old[k];
    } else {
      Object.assign(out, { preset: 'custom', font: 'system', safeArea: 'off', maxLines: 3, size: 'm', outline: 'normal', position: 'bottom', marginPct: 8 });
    }
    const base = BASE_SIZE_PCT[c.aspect] * Math.min(c.w, c.h);
    const sp = num(old.sizePct);
    // 섞인 형식에서 예전 기본값(4.6)은 '건드리지 않음' 으로 보고 새 크기 기준을 따른다
    if (sp > 0 && (pure || Math.abs(sp - 4.6) > 1e-9)) { out.size = 'm'; out.sizeScale = round((sp * c.h) / base, 4); } else if (pure) { out.size = 'm'; out.sizeScale = round((4.6 * c.h) / base, 4); }
    if (typeof old.color === 'string') out.color = old.color;
    if (typeof old.box === 'boolean') {
      out.box = old.box ? 'soft' : 'none';
      if (old.box) out.outline = 'none'; // 예전에는 상자가 있으면 테두리를 그리지 않았다
    } else if (typeof old.box === 'string') out.box = old.box;
    const mp = num(old.marginPct);
    if (mp > 0) {
      if (pure || Math.abs(mp - 8) > 1e-9) out.marginPct = clamp(mp, 0.5, 40); // 섞인 형식의 8 은 예전 기본값 → 안전영역 자동
    }
    return out;
  }

  // ---------- 정규화 ----------
  /** 칸마다 '쓸 수 있는 값인가' (mergeStyle 이 틀린 값을 걸러 낼 때 쓴다) */
  const VALID = {
    enabled: (v) => v !== undefined,
    size: (v) => has(SIZES, v),
    sizeScale: (v) => Number.isFinite(num(v)),
    position: (v) => has(POSITIONS, v),
    marginPct: (v) => v === null || v === '' || Number.isFinite(num(v)),
    color: (v) => normColor(v, null) !== null,
    outline: (v) => has(OUTLINES, v),
    outlineColor: (v) => normColor(v, null) !== null,
    box: (v) => has(BOXES, v),
    boxColor: (v) => normColor(v, null) !== null,
    font: (v) => !!FONT_BY_ID[v],
    shadow: (v) => typeof v === 'boolean',
    fade: (v) => Number.isFinite(num(v)),
    maxLines: (v) => Number.isFinite(num(v)),
    safeArea: (v) => v === 'auto' || v === 'off',
  };

  /** 겉모습(LOOK_KEYS)이 같은 프리셋의 이름, 없으면 'custom' */
  function matchPreset(style) {
    if (!isObj(style)) return 'custom';
    for (const p of PRESETS) {
      let same = true;
      for (const k of LOOK_KEYS) {
        const a = style[k];
        const b = p.style[k];
        if (typeof b === 'number' ? !(typeof a === 'number' && Math.abs(a - b) < 1e-6) : a !== b) { same = false; break; }
      }
      if (same) return p.id;
    }
    return 'custom';
  }

  /**
   * 어떤 모양 값이 와도 완성된 새 형식 스타일로 만든다 (모르는 값·틀린 값은 기본값, 숫자는 범위 안으로).
   * 같은 입력이면 같은 결과이고, 결과를 다시 넣어도 그대로다.
   * @param {object} [raw] 새 형식 · 옛 형식 · 섞인 형식 · 일부 칸만 있는 것 · 비어 있는 것
   * @param {{w?:number,h?:number,aspect?:string}} [ctx] 영상 크기 (옛 형식의 글자 크기를 화면에 맞춰 바꿀 때만 쓰인다)
   */
  function normalizeStyle(raw, ctx) {
    const c = resolveCtx(ctx);
    let src = isObj(raw) ? raw : {};
    if (isLegacy(src)) {
      const pure = !(typeof src.preset === 'string' && src.preset !== '');
      src = legacyPartial(src, c, pure);
    }
    const preset = PRESET_BY_ID[src.preset] ? PRESET_BY_ID[src.preset] : PRESET_BY_ID.basic;
    const out = { enabled: true, position: 'bottom', marginPct: null, ...preset.style };
    if (src.enabled !== undefined) out.enabled = !(src.enabled === false || src.enabled === 0 || src.enabled === 'false' || src.enabled === '0');
    if (has(SIZES, src.size)) out.size = src.size;
    const ss = num(src.sizeScale);
    if (Number.isFinite(ss)) out.sizeScale = round(clamp(ss, 0.6, 2), 4);
    if (has(POSITIONS, src.position)) out.position = src.position;
    if (src.marginPct === null) out.marginPct = null;
    else if (src.marginPct !== undefined) {
      const mp = num(src.marginPct);
      out.marginPct = Number.isFinite(mp) ? round(clamp(mp, 0, 40), 2) : null;
    }
    out.color = normColor(src.color, out.color);
    out.outlineColor = normColor(src.outlineColor, out.outlineColor);
    out.boxColor = normColor(src.boxColor, out.boxColor);
    if (has(OUTLINES, src.outline)) out.outline = src.outline;
    if (has(BOXES, src.box)) out.box = src.box;
    if (FONT_BY_ID[src.font]) out.font = src.font;
    if (typeof src.shadow === 'boolean') out.shadow = src.shadow;
    const fd = num(src.fade);
    if (Number.isFinite(fd)) out.fade = round(clamp(fd, 0, 0.6), 2);
    const ml = num(src.maxLines);
    if (Number.isFinite(ml)) out.maxLines = clamp(Math.round(ml), 1, 3);
    if (src.safeArea === 'auto' || src.safeArea === 'off') out.safeArea = src.safeArea;
    return {
      enabled: out.enabled,
      preset: matchPreset(out),
      size: out.size, sizeScale: out.sizeScale,
      position: out.position, marginPct: out.marginPct,
      color: out.color, outline: out.outline, outlineColor: out.outlineColor,
      box: out.box, boxColor: out.boxColor,
      font: out.font, shadow: out.shadow, fade: out.fade, maxLines: out.maxLines, safeArea: out.safeArea,
    };
  }

  /** 옛 형식 → 새 형식 (예전과 같은 크기·여백·모양, 글꼴은 'system'). normalizeStyle 이 알아서 부르지만 따로도 쓸 수 있다 */
  function fromLegacy(old, ctx) {
    const c = resolveCtx(ctx);
    return normalizeStyle(legacyPartial(isObj(old) ? old : {}, c, true), c);
  }

  /**
   * 스타일에 일부 칸을 덮어쓴 새 스타일(정규화됨).
   * patch.preset 이 지금과 다른 프리셋이면 그 프리셋의 겉모습으로 바꾼 뒤 patch 의 다른 칸을 덮어쓴다
   * (enabled · position · marginPct 는 프리셋이 바꾸지 않는다).
   */
  function mergeStyle(base, patch, ctx) {
    const c = resolveCtx(ctx);
    const cur = normalizeStyle(base, c);
    let p = isObj(patch) ? patch : {};
    if (isLegacy(p)) p = legacyPartial(p, c, !(typeof p.preset === 'string' && p.preset !== ''));
    const next = { ...cur };
    if (PRESET_BY_ID[p.preset] && p.preset !== cur.preset) for (const k of LOOK_KEYS) next[k] = PRESET_BY_ID[p.preset].style[k];
    // 틀린 값은 건너뛴다 (지금 값을 그대로 둔다). 모르는 칸도 무시.
    for (const k of Object.keys(p)) if (k !== 'preset' && VALID[k] && VALID[k](p[k])) next[k] = p[k];
    return normalizeStyle(next, c);
  }

  /** 프리셋 고르기: 지금 스타일에서 겉모습만 그 프리셋으로 (켜기·위치·여백은 그대로) */
  function applyPreset(style, presetId, ctx) {
    if (!PRESET_BY_ID[presetId]) return normalizeStyle(style, ctx);
    const c = resolveCtx(ctx);
    const cur = normalizeStyle(style, c);
    const next = { ...cur };
    for (const k of LOOK_KEYS) next[k] = PRESET_BY_ID[presetId].style[k];
    return normalizeStyle(next, c);
  }

  /** 어떤 스타일이 와도 정규화해서 쓴다 (정규화는 값싸고, 이미 정규화된 것을 다시 넣어도 그대로다) */
  function ensure(style, w, h) {
    return normalizeStyle(style, { w, h });
  }

  // ---------- 크기 · 위치 ----------
  const stepOf = (id) => (SIZES.find((s) => s.id === id) || SIZES[1]).mult;

  /** 글자 크기(px, 정수) */
  function sizeFor(style, w, h) {
    const st = ensure(style, w, h);
    const aspect = outputAspect(w, h);
    return Math.max(10, Math.round(((BASE_SIZE_PCT[aspect] / 100) * Math.min(w, h)) * stepOf(st.size) * st.sizeScale));
  }

  /** 테두리 굵기(px, 캔버스 lineWidth) */
  function outlineWidth(style, px) {
    const o = OUTLINES.find((x) => x.id === (style && style.outline)) || OUTLINES[2];
    return o.k ? Math.max(o.min, px * o.k) : 0;
  }
  /** 테두리 투명도: 어두운 테두리는 예전처럼 0.9, 밝은(흰색 등) 테두리는 또렷하게 1 */
  const outlineAlpha = (style) => (luminance(style && style.outlineColor) > 0.6 ? 1 : 0.9);
  const boxAlpha = (style) => (BOXES.find((x) => x.id === (style && style.box)) || BOXES[0]).alpha;

  /**
   * 한 줄을 놓을 자리 계산에 필요한 값들 (글자 크기를 px 로 따로 주면 그 크기로, 줄이기에 쓴다)
   * @returns {{W:number,H:number,aspect:string,fontPx:number,lineHeight:number,padX:number,padY:number,extraW:number,
   *   strokePx:number,shadowBlur:number,boxRadius:number,maxTextW:number,position:string,
   *   area:{x:number,y:number,w:number,h:number}, margin:{top:number,bottom:number,left:number,right:number},
   *   topPx:number,bottomPx:number,midY:number, vertical:boolean,
   *   maxW:number, marginTop:number, marginBottom:number, safe:{x:number,y:number,w:number,h:number}}}
   *   maxW · marginTop · marginBottom · safe 는 DESIGN §2.1 의 이름 (maxTextW · topPx · bottomPx · area 와 같은 값)
   */
  function layoutMetrics(style, w, h, px) {
    const st = ensure(style, w, h);
    const aspect = outputAspect(w, h);
    const fontPx = Math.max(8, Math.round(px || sizeFor(st, w, h)));
    const vertical = aspect === '9:16' && st.safeArea !== 'off';
    const safe = vertical ? SAFE_VERTICAL : SAFE_NORMAL;
    const left = Math.round((w * safe.left) / 100);
    const right = Math.round((w * safe.right) / 100);
    const autoTop = Math.round((h * safe.top) / 100);
    const autoBottom = Math.round((h * safe.bottom) / 100);
    const custom = st.marginPct != null ? Math.round((h * st.marginPct) / 100) : null;
    const topPx = st.position === 'top' && custom != null ? custom : autoTop;
    const bottomPx = st.position === 'bottom' && custom != null ? custom : autoBottom;
    const padX = Math.round(fontPx * 0.6);
    const padY = Math.round(fontPx * 0.35);
    const extraW = Math.round(fontPx * 0.4);
    const area = { x: left, y: topPx, w: Math.max(40, w - left - right), h: Math.max(20, h - topPx - bottomPx) };
    return {
      W: w, H: h, aspect, fontPx, lineHeight: Math.round(fontPx * 1.3), padX, padY, extraW,
      strokePx: outlineWidth(st, fontPx), shadowBlur: fontPx * 0.15, boxRadius: Math.round(fontPx * 0.35),
      maxTextW: Math.max(20, area.w - padX * 2 - extraW),
      position: st.position, area, margin: { top: topPx, bottom: bottomPx, left, right },
      topPx, bottomPx, midY: Math.round((autoTop + (h - autoBottom)) / 2), vertical,
      maxW: Math.max(20, area.w - padX * 2 - extraW), marginTop: topPx, marginBottom: bottomPx, safe: area,
    };
  }

  /** 글자 상자(가로 boxW, 세로 boxH) 를 놓을 왼쪽 위 좌표 — 안전영역 가운데, 위/가운데/아래 */
  function placeBox(style, w, h, boxW, boxH) {
    const st = ensure(style, w, h);
    const m = layoutMetrics(st, w, h);
    const x = clamp(Math.round(m.area.x + (m.area.w - boxW) / 2), 0, Math.max(0, w - boxW));
    let y;
    if (st.position === 'top') y = m.topPx;
    else if (st.position === 'middle') y = Math.round(m.midY - boxH / 2);
    else y = h - m.bottomPx - boxH;
    return { x, y: clamp(y, 0, Math.max(0, h - boxH)) };
  }

  /** "버튼이 가릴 수 있어요" 안내선용: 글자를 놓아도 되는 안쪽 사각형과 비워 둔 가장자리 (px) */
  function safeRect(style, w, h) {
    const m = layoutMetrics(style, w, h);
    return { x: m.margin.left, y: m.margin.top, w: w - m.margin.left - m.margin.right, h: h - m.margin.top - m.margin.bottom, margin: m.margin, vertical: m.vertical };
  }
  /** layoutMetrics 의 다른 이름 (DESIGN §2.1 의 layoutBox) */
  const layoutBox = layoutMetrics;

  // ---------- 글꼴 ----------
  /** 글꼴 id → CSS font-family 스택 (끝에 시스템 글꼴이 붙어 있어서 글꼴 파일이 없어도 한글이 그려진다) */
  function fontStack(id) {
    return (FONT_BY_ID[id] || FONT_BY_ID.pretendard).stack;
  }
  /** 캔버스 font 문자열: fontCss('jua', 40) → '400 40px "AM Jua","AM Pretendard",...' (스타일 객체도 받는다) */
  function fontCss(fontOrStyle, px) {
    const id = isObj(fontOrStyle) ? fontOrStyle.font : fontOrStyle;
    const f = FONT_BY_ID[id] || FONT_BY_ID.pretendard;
    return `${f.weight} ${px}px ${f.stack}`;
  }
  /**
   * @font-face 규칙 모음. baseUrl 은 글꼴 파일이 있는 폴더 주소 (끝에 / 포함, 예: '../renderer/assets/fonts/').
   * 숨은 창·미리보기·모바일이 같은 규칙을 쓰도록 한 곳에서 만든다.
   */
  function fontFaceCss(baseUrl = '') {
    return FONTS.filter((f) => f.file).map((f) => (
      `@font-face{font-family:"${f.family}";src:url("${baseUrl}${f.file}") format("${f.format}");font-weight:${f.weight};font-style:normal;font-display:block;}`
    )).join('\n');
  }
  /** 스타일이 쓰는 @font-face 별칭들 (이 글꼴들이 로드된 뒤에 재야 정확하다) */
  function fontFamiliesFor(style) {
    const f = FONT_BY_ID[style && style.font] || FONT_BY_ID.pretendard;
    return f.family ? [...new Set([f.family, FALLBACK_FAMILY])] : [];
  }

  // ---------- 서명 ----------
  /** 그려지는 모양을 가르는 칸들만 묶은 문자열 (enabled · preset 이름 · fade 는 뺀다). 레이아웃 캐시 키에 쓴다 */
  function styleSig(style, ctx) {
    const c = isObj(ctx) ? ctx : {};
    const s = ensure(style, c.w, c.h);
    return [s.font, s.size, s.sizeScale, s.position, s.marginPct == null ? 'a' : s.marginPct, s.color, s.outline, s.outlineColor,
      s.box, s.boxColor, s.shadow ? 1 : 0, s.maxLines, s.safeArea].join('|');
  }

  /** 화면에 보여 줄 한 줄 요약: '기본 · 보통 · 아래 · 깔끔한 고딕' */
  function describe(style) {
    const s = normalizeStyle(style);
    const p = PRESET_BY_ID[s.preset];
    const size = SIZES.find((x) => x.id === s.size);
    const pos = POSITIONS.find((x) => x.id === s.position);
    const font = FONT_BY_ID[s.font];
    return `${p ? p.label : '내 모양'} · ${size.label} · ${pos.label} · ${font.label}`;
  }

  return {
    VERSION: 1,
    ASPECTS, BASE_SIZE_PCT, SIZES, POSITIONS, OUTLINES, BOXES, SAFE_AREAS, COLOR_SWATCHES,
    FONTS, FONT_BY_ID, SYSTEM_STACK, FALLBACK_FAMILY, PRESETS, PRESET_BY_ID, LOOK_KEYS, KEEP_KEYS, SAMPLE_LINES,
    DEFAULT_STYLE: normalizeStyle({}),
    normalizeStyle, fromLegacy, isLegacy, mergeStyle, applyPreset, matchPreset,
    outputAspect, outputSize,
    sizeFor, layoutMetrics, layoutBox, placeBox, safeRect, outlineWidth, outlineAlpha, boxAlpha,
    fontStack, fontCss, fontFaceCss, fontFamiliesFor,
    styleSig, normColor, rgba, luminance, describe,
  };
}));
