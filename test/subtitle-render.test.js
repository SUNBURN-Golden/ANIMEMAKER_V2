'use strict';
// 가사 자막 그리기 공용 모듈 (src/shared/subtitle-render.js): 줄바꿈 · 크기 줄이기 · 위치 · 캐시 · 그리기 순서 (캔버스 대신 가짜 ctx)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const R = require('../src/shared/subtitle-render');
const S = require('../src/shared/subtitle-style');

/** 글자 폭: 한글·한자 1em, 영문·숫자 0.5em, 공백 0.3em. ctx.font 에서 크기를 읽는다. 그린 것은 calls 에 쌓는다 */
function makeCtx({ roundRect = true, widen = 1 } = {}) {
  const calls = [];
  const stack = [];
  const ctx = {
    calls, widen,
    font: '400 10px x', textAlign: '', textBaseline: '', fillStyle: '', strokeStyle: '', lineWidth: 0, lineJoin: '',
    globalAlpha: 1, shadowColor: '', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    measureText(s) {
      const px = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)[1]);
      let w = 0;
      for (const ch of String(s)) w += (ch === ' ' ? 0.3 : /[ -~]/.test(ch) ? 0.5 : 1) * px;
      return { width: w * this.widen };
    },
    save() { stack.push({ globalAlpha: this.globalAlpha, shadowBlur: this.shadowBlur, fillStyle: this.fillStyle }); calls.push({ op: 'save' }); },
    restore() { Object.assign(this, stack.pop()); calls.push({ op: 'restore' }); },
    fillText(t, x, y) { calls.push({ op: 'fillText', t, x, y, fillStyle: this.fillStyle, shadowBlur: this.shadowBlur, shadowColor: this.shadowColor, globalAlpha: this.globalAlpha, font: this.font }); },
    strokeText(t, x, y) { calls.push({ op: 'strokeText', t, x, y, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth, lineJoin: this.lineJoin, shadowBlur: this.shadowBlur }); },
    beginPath() { calls.push({ op: 'beginPath' }); },
    moveTo() { calls.push({ op: 'moveTo' }); },
    lineTo() { calls.push({ op: 'lineTo' }); },
    arcTo() { calls.push({ op: 'arcTo' }); },
    closePath() { calls.push({ op: 'closePath' }); },
    fill() { calls.push({ op: 'fill', fillStyle: this.fillStyle, shadowBlur: this.shadowBlur }); },
    fillRect(...a) { calls.push({ op: 'fillRect', a, fillStyle: this.fillStyle }); },
    strokeRect(...a) { calls.push({ op: 'strokeRect', a }); },
    clearRect(...a) { calls.push({ op: 'clearRect', a }); },
    setLineDash() {},
  };
  if (roundRect) ctx.roundRect = (x, y, w, h, r) => calls.push({ op: 'roundRect', x, y, w, h, r, fillStyle: ctx.fillStyle });
  return ctx;
}
const widthOf = (text, px) => [...text].reduce((a, ch) => a + (ch === ' ' ? 0.3 : /[ -~]/.test(ch) ? 0.5 : 1) * px, 0);

test('wrapText: 어절 단위 · 줄 길이 고르게 · 긴 어절만 글자 단위', () => {
  const m = (s) => widthOf(s, 33);
  // 한 줄에 들어가면 그대로
  assert.deepStrictEqual(R.wrapText('별빛이 내리는 밤', 1126, m), ['별빛이 내리는 밤']);
  // 두 줄이면 마지막 줄에 한 어절만 남지 않게 고르게 나눈다
  const two = R.wrapText('함께라면 두렵지 않아 우리의 노래가 돼 그리고 또 다시 만나요', 560, m);
  assert.strictEqual(two.length, 2);
  const widths = two.map(m);
  assert.ok(Math.max(...widths) - Math.min(...widths) < 100, `고르다: ${widths.map(Math.round)}`);
  assert.ok(two.every((l) => m(l) <= 560 + 0.5));
  assert.strictEqual(two.join(' '), '함께라면 두렵지 않아 우리의 노래가 돼 그리고 또 다시 만나요', '어절을 쪼개지 않는다');
  // 영어도 단어 단위
  const en = R.wrapText('I will always love you more than yesterday and less than tomorrow', 560, m);
  assert.strictEqual(en.length, 2);
  assert.ok(en.every((l) => !/^\s|\s$/.test(l)));
  // 공백 없는 아주 긴 글: 글자 단위로 자르고, 줄 길이는 고르다
  const long = '동해물과백두산이마르고닳도록하느님이보우하사우리나라만세무궁화삼천리화려강산대한사람대한으로길이보전하세';
  const parts = R.wrapText(long, 560, m);
  assert.strictEqual(parts.join(''), long);
  assert.ok(parts.length >= 4 && parts.every((l) => m(l) <= 560 + 0.5));
  assert.ok(Math.max(...parts.map(m)) - Math.min(...parts.map(m)) <= 33 * 2, '마지막 줄만 짧아지지 않는다');
  // 빈 글
  assert.deepStrictEqual(R.wrapText('   ', 500, m), []);
  assert.deepStrictEqual(R.wrapText(null, 500, m), []);
});

test('layoutLine: 한 줄 상자 크기와 자리가 예전 코드(가로 720p)와 같다', () => {
  const ctx = makeCtx();
  const lay = R.layoutLine(ctx, '별빛이 내리는 밤', {}, 1280, 720);
  const textW = widthOf('별빛이 내리는 밤', 33); // 한글 7자 × 33px + 공백 2개
  assert.strictEqual(lay.px, 33);
  assert.strictEqual(lay.lineCount, 1);
  assert.strictEqual(lay.lineHeight, 43);
  assert.strictEqual(lay.padX, 20);
  assert.strictEqual(lay.padY, 12);
  // 예전: width = ceil(textW + padX*2 + size*0.4), height = ceil(lines*lh + padY*2), y = H - margin(8%) - height, x = (W - w) / 2
  assert.strictEqual(lay.w, Math.ceil(textW + 40 + 13.2));
  assert.strictEqual(lay.h, 67);
  assert.strictEqual(lay.y, 720 - 58 - 67);
  assert.strictEqual(lay.x, Math.round((1280 - lay.w) / 2));
  assert.ok(lay.font.startsWith('700 33px "AM Pretendard"'));
  assert.strictEqual(lay.shrunk, false);
  // 위·가운데
  assert.strictEqual(R.layoutLine(ctx, '별빛', { position: 'top' }, 1280, 720).y, 58);
  const mid = R.layoutLine(ctx, '별빛', { position: 'middle' }, 1280, 720);
  assert.ok(Math.abs(mid.y + mid.h / 2 - 360) <= 1);
  // 빈 글
  assert.strictEqual(R.layoutLine(ctx, '', {}, 1280, 720).lines.length, 0);
  assert.strictEqual(R.layoutLine(ctx, ' \n ', {}, 1280, 720).lineCount, 0);
});

test('layoutLine: 최대 2줄 → 글자를 최대 20% 줄이고 → 그래도 넘치면 3줄까지', () => {
  const ctx = makeCtx();
  const W = 1280;
  const H = 720;
  // 5글자 어절 = 165px. 한 줄 최대 약 1125px 라서 한 줄에 6어절, 12어절은 2줄에 딱 들어간다 → 글자 그대로
  const words = (n) => Array.from({ length: n }, () => '가나다라마').join(' ');
  const a = R.layoutLine(ctx, words(12), {}, W, H);
  assert.strictEqual(a.lineCount, 2);
  assert.strictEqual(a.px, 33);
  // 2줄에 안 들어가는 글(15어절): 글자를 줄여서 2줄에 맞춘다 (최대 20%)
  const b = R.layoutLine(ctx, words(15), {}, W, H);
  assert.strictEqual(b.lineCount, 2, `줄여서 2줄: ${b.px}px ${b.lineCount}줄`);
  assert.ok(b.px < 33 && b.px >= Math.round(33 * 0.8), `줄인 크기 ${b.px}`);
  assert.strictEqual(b.shrunk, true);
  assert.strictEqual(b.tooLong, false);
  // 20% 줄여도 2줄에 안 되면(20어절) 한 줄 더 (3줄), 크기는 80% 에서 멈춘다
  const c = R.layoutLine(ctx, words(20), {}, W, H);
  assert.strictEqual(c.lineCount, 3);
  assert.strictEqual(c.tooLong, true);
  assert.strictEqual(c.px, Math.round(33 * 0.8));
  assert.strictEqual(R.layoutLine(ctx, words(12), { maxLines: 1 }, W, H).lineCount, 2, 'maxLines 1 이면 한 줄 더 허용(2줄)');
  assert.strictEqual(R.layoutLine(ctx, words(12), { maxLines: 3 }, W, H).px, 33);
  // 아주 아주 긴 글은 더 줄여서 3줄에 맞춘다
  const d = R.layoutLine(ctx, words(30), {}, W, H);
  assert.strictEqual(d.lineCount, 3);
  assert.ok(d.px < Math.round(33 * 0.8) && d.px >= Math.round(33 * 0.6), `더 줄임: ${d.px}px`);
  // 모든 상자는 안전영역 안
  for (const lay of [a, b, c, d]) {
    assert.ok(lay.x >= 0 && lay.x + lay.w <= W && lay.y >= 0 && lay.y + lay.h <= H, '화면 안');
  }
});

test('layoutLine: 억지 줄바꿈(\\n)은 그대로 두 줄, 세로 영상은 오른쪽 12% 와 아래 24% 를 비운다', () => {
  const ctx = makeCtx();
  const m = R.layoutLine(ctx, '첫 줄\n둘째 줄', {}, 1280, 720);
  assert.deepStrictEqual(m.lines, ['첫 줄', '둘째 줄']);
  assert.strictEqual(m.text, '첫 줄\n둘째 줄');
  const tall = R.layoutLine(ctx, '함께라면 두렵지 않아 우리의 노래가 돼', { preset: 'shorts' }, 720, 1280);
  assert.ok(tall.x + tall.w <= 720 - Math.round(720 * 0.12) + 1, `오른쪽 12% 를 비운다: 오른쪽 끝 ${tall.x + tall.w}`);
  assert.strictEqual(tall.y + tall.h, 1280 - Math.round(1280 * 0.24), '아래 24% 를 비운다');
  assert.ok(tall.x + tall.w / 2 < 360, '가운데보다 왼쪽으로 치우친다');
  assert.ok(tall.lineCount >= 2 && tall.lineCount <= 3);
  // 안전영역을 끄면 예전처럼 아래 8%
  assert.strictEqual(R.layoutLine(ctx, '안녕', { safeArea: 'off' }, 720, 1280).y + R.layoutLine(ctx, '안녕', { safeArea: 'off' }, 720, 1280).h, 1280 - Math.round(1280 * 0.08));
});

test('레이아웃 캐시: (글, 스타일 서명, W, H) 가 같으면 같은 것, 글꼴이 읽혀 폭이 달라지면 새로 계산', () => {
  R.clearLayoutCache();
  const ctx = makeCtx();
  const a = R.getLayout(ctx, '별빛이 내리는 밤', {}, 1280, 720);
  assert.strictEqual(R.getLayout(ctx, '별빛이 내리는 밤', {}, 1280, 720), a, '같은 키 → 같은 객체');
  assert.strictEqual(R.getLayout(ctx, '별빛이 내리는 밤', S.normalizeStyle({}), 1280, 720), a, '정규화된 같은 스타일 → 같은 객체');
  assert.notStrictEqual(R.getLayout(ctx, '별빛이 내리는 밤', { size: 'xl' }, 1280, 720), a, '스타일이 다르면 다른 것');
  assert.notStrictEqual(R.getLayout(ctx, '별빛이 내리는 밤', {}, 720, 1280), a, '크기가 다르면 다른 것');
  assert.notStrictEqual(R.getLayout(ctx, '다른 글', {}, 1280, 720), a);
  assert.strictEqual(R.getLayout(ctx, '별빛이 내리는 밤', { enabled: false, fade: 0.4 }, 1280, 720), a, '켜기·페이드는 레이아웃에 영향 없음');
  const n = R.layoutCacheSize();
  assert.ok(n >= 4);
  // 글꼴 파일이 뒤늦게 읽혀서 같은 글꼴로 잰 폭이 달라지면 (document 없이도) 새로 계산한다
  ctx.widen = 1.2;
  const b = R.getLayout(ctx, '별빛이 내리는 밤', {}, 1280, 720);
  assert.notStrictEqual(b, a);
  assert.ok(b.w > a.w);
  R.clearLayoutCache();
  assert.strictEqual(R.layoutCacheSize(), 0);
  // 너무 많이 쌓이지 않는다
  for (let i = 0; i < 700; i++) R.getLayout(ctx, `줄 ${i}`, {}, 1280, 720);
  assert.ok(R.layoutCacheSize() <= 400);
  R.clearLayoutCache();
});

test('drawLine: 테두리 → 글자 순서, 그림자는 글자에만, 상자는 둥근 사각형, 위치 돌려주기', () => {
  const ctx = makeCtx();
  const lay = R.layoutLine(ctx, '별빛이 내리는 밤', {}, 1280, 720);
  ctx.calls.length = 0;
  const box = R.drawLine(ctx, lay, {}, 1280, 720);
  assert.deepStrictEqual(box, { x: lay.x, y: lay.y, w: lay.w, h: lay.h });
  const ops = ctx.calls.map((c) => c.op);
  assert.ok(ops.indexOf('strokeText') < ops.indexOf('fillText'), '테두리를 먼저');
  const stroke = ctx.calls.find((c) => c.op === 'strokeText');
  const fill = ctx.calls.find((c) => c.op === 'fillText');
  assert.strictEqual(stroke.strokeStyle, 'rgba(0,0,0,0.9)');
  assert.strictEqual(stroke.lineJoin, 'round');
  assert.ok(Math.abs(stroke.lineWidth - 5.28) < 0.01);
  assert.strictEqual(stroke.shadowBlur, 0, '테두리에는 그림자가 없다');
  assert.strictEqual(fill.fillStyle, '#ffffff');
  assert.ok(Math.abs(fill.shadowBlur - 4.95) < 0.01, '글자에는 그림자');
  assert.strictEqual(fill.shadowColor, 'rgba(0,0,0,0.5)');
  assert.strictEqual(fill.t, '별빛이 내리는 밤');
  // 가운데: 상자 안 가운데 x, 첫 줄 가운데 y
  assert.strictEqual(fill.x, lay.x + lay.w / 2);
  assert.strictEqual(fill.y, lay.y + lay.padY + lay.lineHeight / 2);
  assert.ok(!ops.includes('roundRect'), '상자 없음');
  assert.strictEqual(ops.filter((o) => o === 'save').length, ops.filter((o) => o === 'restore').length, 'save/restore 짝');
  assert.strictEqual(ctx.globalAlpha, 1, '상태를 되돌려 놓는다');

  // 상자(은은하게): 테두리 없이 검정 55% 둥근 사각형 (예전 box:true)
  const boxStyle = { preset: 'box' };
  const lay2 = R.layoutLine(ctx, '별빛이 내리는 밤', boxStyle, 1280, 720);
  ctx.calls.length = 0;
  R.drawLine(ctx, lay2, boxStyle, 1280, 720);
  const rr = ctx.calls.find((c) => c.op === 'roundRect');
  assert.ok(rr, '둥근 사각형');
  assert.strictEqual(rr.fillStyle, 'rgba(0,0,0,0.55)');
  assert.strictEqual(rr.r, Math.round(33 * 0.35));
  assert.deepStrictEqual([rr.x, rr.y, rr.w, rr.h], [lay2.x, lay2.y, lay2.w, lay2.h]);
  assert.ok(!ctx.calls.some((c) => c.op === 'strokeText'), '상자일 때 테두리 없음');

  // 줄 상자 크기 캔버스(origin box): (0,0) 에 그리고 영상 위 자리는 돌려준다
  ctx.calls.length = 0;
  const b2 = R.drawLine(ctx, lay, {}, 1280, 720, { origin: 'box', alpha: 0.5 });
  assert.deepStrictEqual(b2, { x: lay.x, y: lay.y, w: lay.w, h: lay.h });
  const f2 = ctx.calls.find((c) => c.op === 'fillText');
  assert.strictEqual(f2.x, lay.w / 2);
  assert.strictEqual(f2.y, lay.padY + lay.lineHeight / 2);
  assert.strictEqual(f2.globalAlpha, 0.5);

  // 그림자 끄기 · 테두리 없음
  ctx.calls.length = 0;
  R.drawLine(ctx, lay, { shadow: false, outline: 'none' }, 1280, 720);
  assert.ok(!ctx.calls.some((c) => c.op === 'strokeText'));
  assert.strictEqual(ctx.calls.find((c) => c.op === 'fillText').shadowBlur, 0);
  // 여러 줄: 줄마다 lineHeight 간격
  const lay3 = R.layoutLine(ctx, '첫 줄\n둘째 줄', {}, 1280, 720);
  ctx.calls.length = 0;
  R.drawLine(ctx, lay3, {}, 1280, 720);
  const ys = ctx.calls.filter((c) => c.op === 'fillText').map((c) => c.y);
  assert.strictEqual(ys[1] - ys[0], lay3.lineHeight);
  // 빈 레이아웃은 아무것도 안 그린다
  ctx.calls.length = 0;
  assert.deepStrictEqual(R.drawLine(ctx, R.layoutLine(ctx, '', {}, 1280, 720), {}, 1280, 720), { x: 0, y: 0, w: 0, h: 0 });
  assert.strictEqual(ctx.calls.length, 0);
});

test('drawLine: roundRect 가 없는 오래된 WebView 에서도 둥근 상자를 그린다 (arcTo)', () => {
  const ctx = makeCtx({ roundRect: false });
  const lay = R.layoutLine(ctx, '안녕하세요', { preset: 'box' }, 1280, 720);
  ctx.calls.length = 0;
  R.drawLine(ctx, lay, { preset: 'box' }, 1280, 720);
  assert.strictEqual(ctx.calls.filter((c) => c.op === 'arcTo').length, 4);
  assert.ok(ctx.calls.some((c) => c.op === 'fill'));
});

test('lineToCanvas: 줄 상자 크기의 투명 캔버스 한 장 + 영상 위 자리', () => {
  const made = [];
  const create = (w, h) => { const c = { width: w, height: h, ctx: makeCtx() }; c.getContext = () => c.ctx; made.push(c); return c; };
  const r = R.lineToCanvas(create, '별빛이 내리는 밤', {}, 1280, 720);
  assert.strictEqual(r.canvas.width, r.w);
  assert.strictEqual(r.canvas.height, r.h);
  assert.strictEqual(r.w, r.layout.w);
  assert.strictEqual(r.x, r.layout.x);
  assert.strictEqual(r.y, 720 - 58 - r.h);
  assert.ok(r.canvas.ctx.calls.some((c) => c.op === 'fillText' && c.x === r.w / 2), '캔버스 안쪽 (0,0) 기준으로 그렸다');
  assert.strictEqual(made.length, 2, '재기용 1×1 캔버스 + 그리기용 1장');
  R.lineToCanvas(create, '다음 줄', {}, 1280, 720);
  assert.strictEqual(made.length, 3, '재기용 캔버스는 다시 쓴다');
  assert.strictEqual(R.lineToCanvas(create, '   ', {}, 1280, 720), null, '빈 글은 null');
});

test('시간 도우미: fadeAlpha · activeLines · drawFrame · drawSafeGuide', () => {
  // 보이는 시간 3초, 페이드 0.15초 (영상에 입힐 때와 같은 규칙)
  assert.strictEqual(R.fadeAlpha(10, 10, 13, 0.15), 0);
  assert.ok(Math.abs(R.fadeAlpha(10.075, 10, 13, 0.15) - 0.5) < 1e-9);
  assert.strictEqual(R.fadeAlpha(11.5, 10, 13, 0.15), 1);
  assert.ok(Math.abs(R.fadeAlpha(12.925, 10, 13, 0.15) - 0.5) < 1e-9);
  assert.strictEqual(R.fadeAlpha(13, 10, 13, 0.15), 0);
  // 짧은 줄은 보이는 시간의 1/4 까지만
  assert.ok(Math.abs(R.fadeAlpha(10.1, 10, 10.4, 0.15) - 1) < 1e-9);
  assert.strictEqual(R.fadeAlpha(10.5, 10, 11, 0), 1, '페이드 0');
  assert.strictEqual(R.fadeAlpha(9.9, 10, 11, 0), 0);
  const lines = [{ text: 'a', start: 0, end: 2 }, { text: 'b', start: 1, end: 3, hidden: true }, { text: '', start: 1, end: 3 }, { text: 'c', start: 1.5, end: 4 }];
  assert.deepStrictEqual(R.activeLines(lines, 1.6).map((l) => l.text), ['a', 'c'], '숨긴 줄 · 빈 줄 제외');
  assert.deepStrictEqual(R.activeLines(lines, 5), []);
  assert.deepStrictEqual(R.activeLines(null, 1), []);
  const ctx = makeCtx();
  const drawn = R.drawFrame(ctx, lines, 1.6, {}, 1280, 720);
  assert.deepStrictEqual(drawn.map((d) => d.line.text), ['a', 'c']);
  assert.strictEqual(ctx.calls[0].op, 'clearRect');
  assert.strictEqual(ctx.calls.filter((c) => c.op === 'fillText').length, 2);
  // 안전영역 안내선
  ctx.calls.length = 0;
  R.drawSafeGuide(ctx, {}, 720, 1280);
  assert.ok(ctx.calls.filter((c) => c.op === 'fillRect').length === 4);
  assert.ok(ctx.calls.some((c) => c.op === 'strokeRect'));
  assert.ok(ctx.calls.some((c) => c.op === 'fillText' && /버튼/.test(c.t)), '"버튼이 가릴 수 있어요"');
});

test('숨은 창 페이지(subtitle-canvas.html): 공용 모듈 · 글꼴 파일 경로가 실제로 있고, 창은 파일로 연다 (data: 주소는 번들 글꼴을 못 읽는다)', () => {
  const dir = path.join(__dirname, '..', 'src', 'main');
  const html = fs.readFileSync(path.join(dir, 'subtitle-canvas.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(scripts, ['../shared/subtitle-style.js', '../shared/subtitle-render.js'], '스타일 모듈이 먼저');
  for (const f of scripts) assert.ok(fs.existsSync(path.join(dir, f)), f);
  const base = /fontFaceCss\('([^']+)'\)/.exec(html)[1];
  assert.strictEqual(base, '../renderer/assets/fonts/');
  for (const f of S.FONTS.filter((x) => x.file)) assert.ok(fs.existsSync(path.join(dir, base, f.file)), `${f.file} 이 숨은 창 페이지에서 상대 경로로 닿는다`);
  assert.match(html, /window\.AMSubs\s*=/);
  assert.match(html, /document\.fonts\.load/, '글꼴이 읽힐 때까지 기다린다');
  const src = fs.readFileSync(path.join(dir, 'subtitles.js'), 'utf8');
  assert.match(src, /loadFile\(PAGE\)/);
  assert.doesNotMatch(src, /loadURL\(/);
  assert.strictEqual(typeof require('../src/main/subtitles').renderSubtitlePngs, 'function', 'electron 없이도 불러올 수 있다 (창은 부를 때 만든다)');
});
