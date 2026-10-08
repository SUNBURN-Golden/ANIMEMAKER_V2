'use strict';
/*
 * 가사 자막 그리기 공용 모듈 (UMD) — DESIGN §2.1
 * 자막 한 줄을 canvas 2D 로 그린다. 같은 코드가 세 곳에서 쓰인다:
 *   ① 메인의 숨은 창 (PNG 로 내보내기, src/main/subtitles.js)  ② 렌더러 미리보기 (<video> 위 <canvas>)  ③ 모바일(안드로이드)
 * 그래서 미리보기와 완성 영상의 줄바꿈·위치가 같다.
 *
 * document 를 쓰지 않는다. canvas 컨텍스트(ctx)나 canvas 만드는 함수(createCanvas)를 바깥에서 넘겨 받는다.
 * 글꼴 파일이 다 읽힌 뒤에(document.fonts.load) 부르는 것은 부르는 쪽 일이다. (읽히기 전에 잰 레이아웃은 캐시 키가 달라서 자동으로 다시 계산된다)
 * 스타일은 AMSubtitleStyle.normalizeStyle 의 결과(또는 어떤 형식이든 — 안에서 정규화한다)를 받는다.
 *
 * 사용 (미리보기): 캔버스 안쪽 크기 = 영상 출력 크기(W×H), CSS 로만 줄인다.
 *   const lay = AMSubtitleRender.getLayout(ctx, text, style, W, H);
 *   ctx.clearRect(0, 0, W, H);
 *   AMSubtitleRender.drawLine(ctx, lay, style, W, H, { alpha: AMSubtitleRender.fadeAlpha(t, start, end, style.fade) });
 * 사용 (PNG): const r = AMSubtitleRender.lineToCanvas(makeCanvas, text, style, W, H);  // r.canvas = 줄 상자 크기의 투명 캔버스, r.x r.y = 영상 위 왼쪽 위
 *
 * ── 내보내는 것 (API) ────────────────────────────────────────────────
 *   layoutLine(ctx, text, style, W, H) → 레이아웃 { lines, lineCount, px, scale, shrunk, tooLong, font, lineHeight, padX, padY, textW, w, h, x, y }
 *       (글이 비면 lines: []). tooLong = 최대 줄 수를 20% 줄여도 못 지켜서 한 줄 더 허용했다는 뜻 (편집기의 ⚠ 표시용), lineCount ≥ 3 도 같은 경고에 쓴다.
 *   getLayout(ctx, text, style, W, H)  layoutLine + 캐시 (키: 글 · 스타일 서명 · W · H · 글꼴 표) · clearLayoutCache() · layoutCacheSize()
 *   drawLine(ctx, layout, style, W, H, {alpha, origin:'frame'|'box'}) → {x,y,w,h}   origin 'frame' = W×H 캔버스의 제자리, 'box' = 줄 상자 크기 캔버스의 (0,0)
 *   lineToCanvas(createCanvas, text, style, W, H, opts) → {canvas, layout, x, y, w, h} | null
 *   drawFrame(ctx, lines, t, style, W, H) → 그린 줄들   (미리보기: 캔버스를 지우고 t초에 보여야 할 줄을 그린다)
 *   activeLines(lines, t) · fadeAlpha(t, start, end, fade) · drawSafeGuide(ctx, style, W, H, {label}) · wrapText(text, maxW, measure) → string[]
 */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./subtitle-style') : root.AMSubtitleStyle);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AMSubtitleRender = api;
}(typeof self !== 'undefined' ? self : this, (S) => {
  if (!S) throw new Error('subtitle-style.js 를 먼저 읽어 주세요.');

  // ---------- 줄바꿈 ----------
  /** 글자 수를 재는 함수에 캐시를 붙인다 */
  function memoMeasure(measure) {
    const cache = new Map();
    return (s) => {
      let v = cache.get(s);
      if (v === undefined) { v = measure(s); cache.set(s, v); }
      return v;
    };
  }

  /** 한 문단을 어절 단위로 나눈다. maxW 보다 긴 어절은 글자 하나씩으로 쪼개 glue(앞 글자에 붙음) 표시를 한다 */
  function tokenize(par, maxW, mw) {
    const out = [];
    for (const word of par.split(/\s+/).filter(Boolean)) {
      if (mw(word) <= maxW) { out.push({ s: word, glue: false }); continue; }
      Array.from(word).forEach((ch, i) => out.push({ s: ch, glue: i > 0 }));
    }
    return out;
  }
  const joinTok = (cur, tok) => (cur ? cur + (tok.glue ? '' : ' ') + tok.s : tok.s);

  /** 앞에서부터 채우는 줄바꿈 */
  function greedy(tokens, maxW, mw) {
    const lines = [];
    let cur = '';
    for (const tok of tokens) {
      const cand = joinTok(cur, tok);
      if (!cur || mw(cand) <= maxW) cur = cand;
      else { lines.push(cur); cur = tok.s; }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  /**
   * 한 문단 줄바꿈: 어절(공백) 단위로 나누고, 줄 수가 정해지면 가장 짧은 폭으로 다시 채워서 줄 길이를 고르게 한다
   * (마지막 줄에 한 어절만 남는 일을 줄인다). maxW 보다 긴 어절만 글자 단위로 자른다.
   * @param {string} par 문단 (줄바꿈 없는 글)
   * @param {number} maxW 한 줄 최대 폭
   * @param {(s:string)=>number} measure 글자 폭 재는 함수
   * @returns {string[]}
   */
  function wrapText(par, maxW, measure) {
    const mw = memoMeasure(measure);
    const text = String(par == null ? '' : par).replace(/\s+/g, ' ').trim();
    if (!text) return [];
    if (mw(text) <= maxW) return [text];
    const tokens = tokenize(text, maxW, mw);
    const first = greedy(tokens, maxW, mw);
    const n = first.length;
    if (n < 2) return first;
    // 같은 줄 수를 지키는 가장 좁은 폭을 이분 탐색
    let hi = Math.ceil(maxW);
    let lo = Math.max(1, Math.floor(Math.max(...tokens.map((t) => mw(t.s)))), Math.floor(mw(text) / n) - 1);
    if (lo > hi) lo = hi;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (greedy(tokens, mid, mw).length <= n) hi = mid; else lo = mid;
    }
    const balanced = greedy(tokens, hi, mw);
    return balanced.length === n && balanced.every((l) => mw(l) <= maxW + 0.5) ? balanced : first;
  }

  // ---------- 레이아웃 ----------
  const SHRINK = [1, 0.95, 0.9, 0.85, 0.8]; // 최대 20% 줄이기
  const SHRINK_MORE = [0.75, 0.7, 0.65, 0.6]; // 한 줄 더 허용해도 안 맞는 아주 긴 줄

  const EMPTY = Object.freeze({ lines: Object.freeze([]), lineCount: 0, w: 0, h: 0, x: 0, y: 0, px: 0, scale: 1, text: '' });

  /**
   * 한 줄 자막의 모양(줄바꿈 · 글자 크기 · 상자 크기 · 영상 위 위치)을 잰다.
   * - 줄바꿈: 공백(어절) 단위, 줄 길이 고르게, 긴 어절만 글자 단위. 글 속의 '\n' 은 억지 줄바꿈.
   * - 최대 maxLines(기본 2)줄. 넘치면 글자를 최대 20% 줄이고, 그래도 넘치면 한 줄 더(기본 3줄) 허용한다.
   * @param {CanvasRenderingContext2D} ctx 재기용 컨텍스트 (font 가 바뀐다)
   * @param {string} text
   * @param {object} style 스타일 (어떤 형식이든)
   * @param {number} W 영상 출력 가로(px)
   * @param {number} H 영상 출력 세로(px)
   * @returns {{text:string, lines:string[], lineCount:number, px:number, scale:number, shrunk:boolean, tooLong:boolean,
   *   font:string, lineHeight:number, padX:number, padY:number, textW:number, w:number, h:number, x:number, y:number}}
   *   w,h = 줄 상자(여백 포함) 크기, x,y = 영상 위 왼쪽 위 (위치·안전영역 반영). 글이 비면 lines 가 빈 배열.
   */
  function layoutLine(ctx, text, style, W, H) {
    const st = S.normalizeStyle(style, { w: W, h: H });
    const paragraphs = String(text == null ? '' : text).replace(/\r/g, '').split('\n').map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (!paragraphs.length) return { ...EMPTY, lines: [], text: '' };
    const base = S.sizeFor(st, W, H);
    const attempt = (scale) => {
      const px = Math.max(8, Math.round(base * scale));
      const m = S.layoutMetrics(st, W, H, px);
      ctx.font = S.fontCss(st, px);
      const measure = (s) => ctx.measureText(s).width;
      const lines = [];
      for (const p of paragraphs) lines.push(...wrapText(p, m.maxTextW, measure));
      return { px, m, lines, measure, scale };
    };
    let pick = null;
    for (const sc of SHRINK) { pick = attempt(sc); if (pick.lines.length <= st.maxLines) break; }
    let tooLong = false;
    if (pick.lines.length > st.maxLines) {
      tooLong = true;
      for (const sc of [0.8, ...SHRINK_MORE]) { pick = attempt(sc); if (pick.lines.length <= st.maxLines + 1) break; }
    }
    const { px, m, lines } = pick;
    ctx.font = S.fontCss(st, px);
    let textW = 0;
    for (const ln of lines) textW = Math.max(textW, ctx.measureText(ln).width);
    const w = Math.ceil(textW + m.padX * 2 + px * 0.4);
    const h = Math.ceil(lines.length * m.lineHeight + m.padY * 2);
    const pos = S.placeBox(st, W, H, w, h);
    return {
      text: paragraphs.join('\n'), lines, lineCount: lines.length, px, scale: px / base, shrunk: px < base, tooLong,
      font: S.fontCss(st, px), lineHeight: m.lineHeight, padX: m.padX, padY: m.padY, textW, w, h, x: pos.x, y: pos.y,
    };
  }

  // ---------- 레이아웃 캐시 ----------
  const CACHE_MAX = 400;
  const cache = new Map();
  /** 글꼴이 실제로 읽혔는지 알아내는 표: 그 글꼴로 잰 폭이 바뀌면 캐시 키도 바뀐다 (document 없이 글꼴 로딩을 알아챈다) */
  function fontTag(ctx, st) {
    ctx.font = S.fontCss(st, 40);
    return Math.round(ctx.measureText('가힣AMg한글').width * 4);
  }
  /** layoutLine + 캐시. 키 = (글, 스타일 서명, W, H, 글꼴 표) */
  function getLayout(ctx, text, style, W, H) {
    const st = S.normalizeStyle(style, { w: W, h: H });
    const key = [text, S.styleSig(st), W, H, fontTag(ctx, st)].join('\u0001');
    let lay = cache.get(key);
    if (lay) { cache.delete(key); cache.set(key, lay); return lay; }
    lay = layoutLine(ctx, text, st, W, H);
    cache.set(key, lay);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return lay;
  }
  function clearLayoutCache() { cache.clear(); }
  function layoutCacheSize() { return cache.size; }

  // ---------- 그리기 ----------
  function roundRectPath(ctx, x, y, w, h, r0) {
    const r = Math.max(0, Math.min(r0, w / 2, h / 2));
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') { ctx.roundRect(x, y, w, h, r); return; }
    // 오래된 WebView 에는 roundRect 가 없다
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  /**
   * 레이아웃대로 한 줄을 그린다 (테두리 → 글자, 상자, 그림자, 색, 투명도).
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} layout layoutLine / getLayout 의 결과
   * @param {object} style
   * @param {number} W 영상 가로 @param {number} H 영상 세로
   * @param {{alpha?:number, origin?:'frame'|'box'}} [opts] alpha 0~1 (페이드), origin 'frame'(기본)=영상 크기 캔버스의 제자리(x,y) / 'box'=줄 상자 크기 캔버스의 (0,0)
   * @returns {{x:number,y:number,w:number,h:number}} 영상 위에서 그려진 줄 상자
   */
  function drawLine(ctx, layout, style, W, H, opts = {}) {
    if (!layout || !layout.lines || !layout.lines.length) return { x: 0, y: 0, w: 0, h: 0 };
    const st = S.normalizeStyle(style, { w: W, h: H });
    const alpha = opts.alpha == null ? 1 : Math.min(1, Math.max(0, Number(opts.alpha)));
    const ox = opts.origin === 'box' ? 0 : layout.x;
    const oy = opts.origin === 'box' ? 0 : layout.y;
    const px = layout.px;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = layout.font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.shadowBlur = 0;
    const ba = S.boxAlpha(st);
    if (ba > 0) {
      ctx.fillStyle = S.rgba(st.boxColor, ba);
      roundRectPath(ctx, ox, oy, layout.w, layout.h, Math.round(px * 0.35));
      ctx.fill();
    }
    const stroke = S.outlineWidth(st, px);
    layout.lines.forEach((ln, i) => {
      const cx = ox + layout.w / 2;
      const cy = oy + layout.padY + layout.lineHeight * i + layout.lineHeight / 2;
      if (stroke > 0) {
        ctx.lineJoin = 'round';
        ctx.lineWidth = stroke;
        ctx.strokeStyle = S.rgba(st.outlineColor, S.outlineAlpha(st));
        ctx.strokeText(ln, cx, cy);
      }
      if (st.shadow) { ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = px * 0.15; }
      ctx.fillStyle = st.color;
      ctx.fillText(ln, cx, cy);
      ctx.shadowBlur = 0;
    });
    ctx.restore();
    return { x: layout.x, y: layout.y, w: layout.w, h: layout.h };
  }

  /**
   * 한 줄을 투명한 캔버스 한 장으로 만든다 (PNG 로 내보내기용).
   * @param {(w:number,h:number)=>any} createCanvas 예: (w,h)=>{const c=document.createElement('canvas');c.width=w;c.height=h;return c;}
   * @returns {{canvas:any, layout:object, x:number, y:number, w:number, h:number}|null} 글이 비었으면 null
   */
  const probes = new WeakMap();
  function lineToCanvas(createCanvas, text, style, W, H, opts = {}) {
    let probe = probes.get(createCanvas);
    if (!probe) { probe = createCanvas(1, 1).getContext('2d'); probes.set(createCanvas, probe); }
    const layout = layoutLine(probe, text, style, W, H);
    if (!layout.lines.length) return null;
    const canvas = createCanvas(layout.w, layout.h);
    drawLine(canvas.getContext('2d'), layout, style, W, H, { ...opts, origin: 'box' });
    return { canvas, layout, x: layout.x, y: layout.y, w: layout.w, h: layout.h };
  }

  /** 미리보기용: 캔버스를 지우고 그 시각에 보여야 할 줄들을 그린다. 그린 줄 상자들을 돌려준다 */
  function drawFrame(ctx, lines, t, style, W, H) {
    const st = S.normalizeStyle(style, { w: W, h: H });
    ctx.clearRect(0, 0, W, H);
    const drawn = [];
    for (const l of activeLines(lines, t)) {
      const lay = getLayout(ctx, l.text, st, W, H);
      const box = drawLine(ctx, lay, st, W, H, { alpha: fadeAlpha(t, l.start, l.end, st.fade) });
      if (box.w) drawn.push({ line: l, layout: lay, box });
    }
    return drawn;
  }

  // ---------- 시간 ----------
  /** 지금(t초) 보여야 하는 줄들: 숨긴 줄·빈 줄은 뺀다 */
  function activeLines(lines, t) {
    return (lines || []).filter((l) => l && !l.hidden && l.text && t >= l.start && t < l.end);
  }
  /**
   * 페이드 인/아웃 투명도 (영상에 입힐 때와 같은 규칙: 페이드 길이 = min(fade, 보이는 시간/4))
   */
  function fadeAlpha(t, start, end, fade = 0.15) {
    const d = Math.max(0.05, end - start);
    const f = Math.min(Math.max(0, Number(fade) || 0), d / 4);
    if (f <= 0) return t >= start && t < end ? 1 : 0;
    const a = Math.min(1, Math.max(0, (t - start) / f));
    const b = Math.min(1, Math.max(0, (end - t) / f));
    return Math.min(a, b);
  }

  /**
   * "버튼이 가릴 수 있어요" 안내: 안전영역 밖(비워 둔 가장자리)을 붉게 칠하고 안쪽 경계를 점선으로 그린다.
   * @param {{label?:boolean}} [opts]
   */
  function drawSafeGuide(ctx, style, W, H, opts = {}) {
    const r = S.safeRect(style, W, H);
    const m = r.margin;
    ctx.save();
    ctx.fillStyle = 'rgba(255,70,70,0.16)';
    ctx.fillRect(0, 0, W, m.top);
    ctx.fillRect(0, H - m.bottom, W, m.bottom);
    ctx.fillRect(0, m.top, m.left, H - m.top - m.bottom);
    ctx.fillRect(W - m.right, m.top, m.right, H - m.top - m.bottom);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = Math.max(2, Math.round(Math.min(W, H) / 360));
    ctx.setLineDash([Math.round(Math.min(W, H) / 60), Math.round(Math.min(W, H) / 90)]);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    if (opts.label !== false && m.bottom > Math.min(W, H) * 0.06) {
      ctx.setLineDash([]);
      const px = Math.round(Math.min(W, H) * 0.03);
      ctx.font = `700 ${px}px ${S.SYSTEM_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillText('버튼이 가릴 수 있어요', W / 2, H - m.bottom / 2);
    }
    ctx.restore();
  }

  return {
    wrapText, layoutLine, getLayout, clearLayoutCache, layoutCacheSize,
    drawLine, lineToCanvas, drawFrame, activeLines, fadeAlpha, drawSafeGuide,
    style: S,
  };
}));
