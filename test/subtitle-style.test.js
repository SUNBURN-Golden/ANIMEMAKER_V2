'use strict';
// 가사 자막 스타일 공용 모듈 (src/shared/subtitle-style.js): 프리셋·글꼴 표, 정규화, 옛 형식 변환, 크기·안전영역
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const S = require('../src/shared/subtitle-style');
const { outputSize } = require('../src/main/media/assemble');

const FONT_DIR = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'fonts');

test('프리셋 7개 · 글꼴 6개 (번들 글꼴 파일과 라이선스가 실제로 있다)', () => {
  assert.deepStrictEqual(S.PRESETS.map((p) => p.id), ['basic', 'yellow', 'box', 'storybook', 'pop', 'shorts', 'minimal']);
  for (const p of S.PRESETS) assert.ok(p.label && p.desc && p.emoji, p.id);
  assert.deepStrictEqual(S.FONTS.map((f) => f.id), ['pretendard', 'jua', 'dohyeon', 'gaegu', 'blackhan', 'system']);
  for (const f of S.FONTS) {
    assert.ok(f.label && f.stack.endsWith(S.SYSTEM_STACK), `${f.id}: 끝에 시스템 글꼴 스택`);
    if (!f.file) continue;
    assert.ok(fs.statSync(path.join(FONT_DIR, f.file)).size > 100000, `${f.file} 이 번들되어 있다`);
    assert.ok(fs.readdirSync(FONT_DIR).some((n) => /^(OFL|LICENSE)-/.test(n)), '라이선스 파일');
  }
  // 글꼴마다 라이선스 원문이 같은 폴더에 있다 (SIL OFL)
  for (const n of ['Pretendard', 'Jua', 'DoHyeon', 'Gaegu', 'BlackHanSans']) {
    assert.match(fs.readFileSync(path.join(FONT_DIR, `OFL-${n}.txt`), 'utf8'), /SIL OPEN FONT LICENSE Version 1\.1/);
  }
  // 글꼴 없는 글자는 Pretendard 가 채운다 (Pretendard 자신은 중복 없이)
  assert.match(S.fontStack('jua'), /^"AM Jua","AM Pretendard",/);
  assert.match(S.fontStack('pretendard'), /^"AM Pretendard","Malgun Gothic"/);
  assert.strictEqual(S.fontStack('system'), S.SYSTEM_STACK);
  assert.strictEqual(S.fontStack('없는글꼴'), S.fontStack('pretendard'));
  assert.strictEqual(S.fontCss('jua', 40), `400 40px ${S.fontStack('jua')}`);
  assert.strictEqual(S.fontCss({ font: 'gaegu' }, 20), `700 20px ${S.fontStack('gaegu')}`);
  const css = S.fontFaceCss('../x/');
  assert.strictEqual((css.match(/@font-face/g) || []).length, 5, '번들 글꼴 5개');
  assert.ok(css.includes('url("../x/Jua-Regular.ttf")') && css.includes('font-family:"AM Gaegu"'));
});

test('normalizeStyle: 빈 값 → basic, 다시 넣어도 그대로, 모르는 값은 기본값', () => {
  const d = S.normalizeStyle();
  assert.deepStrictEqual(d, { enabled: true, preset: 'basic', size: 'm', sizeScale: 1, position: 'bottom', marginPct: null, color: '#ffffff', outline: 'normal', outlineColor: '#000000', box: 'none', boxColor: '#000000', font: 'pretendard', shadow: true, fade: 0.15, maxLines: 2, safeArea: 'auto' });
  assert.deepStrictEqual(S.normalizeStyle(d), d, '멱등');
  assert.deepStrictEqual(S.normalizeStyle(null), d);
  assert.deepStrictEqual(S.normalizeStyle('x'), d);
  assert.deepStrictEqual(S.normalizeStyle([1]), d);
  assert.deepStrictEqual(S.DEFAULT_STYLE, d);
  // 프리셋 이름만 줘도 완성된다
  for (const p of S.PRESETS) {
    const s = S.normalizeStyle({ preset: p.id });
    assert.strictEqual(s.preset, p.id);
    assert.deepStrictEqual(S.normalizeStyle(s), s, `${p.id} 멱등`);
    for (const k of S.LOOK_KEYS) assert.deepStrictEqual(s[k], p.style[k], `${p.id}.${k}`);
  }
  // 모르는 id · 틀린 값 → 기본값
  const bad = S.normalizeStyle({ preset: 'zzz', size: 'huge', position: 'left', outline: 'x', box: 'big', font: 'comic', safeArea: 'maybe', color: 'nope', outlineColor: 5, boxColor: {}, shadow: 'yes', unknownKey: 1, hideLines: true });
  assert.deepStrictEqual(bad, d);
  assert.ok(!('unknownKey' in bad));
});

test('normalizeStyle: 숫자는 범위 안으로, 색은 #rrggbb 로', () => {
  assert.strictEqual(S.normalizeStyle({ sizeScale: 5 }).sizeScale, 2);
  assert.strictEqual(S.normalizeStyle({ sizeScale: 0 }).sizeScale, 0.6);
  assert.strictEqual(S.normalizeStyle({ sizeScale: '1.3' }).sizeScale, 1.3);
  assert.strictEqual(S.normalizeStyle({ sizeScale: 'abc' }).sizeScale, 1);
  assert.strictEqual(S.normalizeStyle({ marginPct: 99 }).marginPct, 40);
  assert.strictEqual(S.normalizeStyle({ marginPct: -3 }).marginPct, 0);
  assert.strictEqual(S.normalizeStyle({ marginPct: null }).marginPct, null);
  assert.strictEqual(S.normalizeStyle({ marginPct: '' }).marginPct, null);
  assert.strictEqual(S.normalizeStyle({ marginPct: 12.345 }).marginPct, 12.35);
  assert.strictEqual(S.normalizeStyle({ fade: -1 }).fade, 0);
  assert.strictEqual(S.normalizeStyle({ fade: 9 }).fade, 0.6);
  assert.strictEqual(S.normalizeStyle({ maxLines: 9 }).maxLines, 3);
  assert.strictEqual(S.normalizeStyle({ maxLines: 0 }).maxLines, 1);
  assert.strictEqual(S.normalizeStyle({ maxLines: 2.6 }).maxLines, 3);
  assert.strictEqual(S.normalizeStyle({ color: '#FFF' }).color, '#ffffff');
  assert.strictEqual(S.normalizeStyle({ color: '#FFE14D' }).color, '#ffe14d');
  assert.strictEqual(S.normalizeStyle({ color: '#11223344' }).color, '#112233', '알파는 버린다');
  assert.strictEqual(S.normalizeStyle({ color: 'yellow' }).color, '#ffe14d');
  assert.strictEqual(S.normalizeStyle({ color: 'rgb(255, 0, 10)' }).color, '#ff000a');
  assert.strictEqual(S.normalizeStyle({ enabled: false }).enabled, false);
  assert.strictEqual(S.normalizeStyle({ enabled: 'false' }).enabled, false);
  assert.strictEqual(S.normalizeStyle({ enabled: true }).enabled, true);
  // 겉모습이 프리셋과 달라지면 custom, 같아지면 그 이름
  assert.strictEqual(S.normalizeStyle({ preset: 'yellow', color: '#ff0000' }).preset, 'custom');
  assert.strictEqual(S.normalizeStyle({ preset: 'custom' }).preset, 'basic');
  assert.strictEqual(S.normalizeStyle({ preset: 'yellow', size: 'l', color: '#ffe14d', outline: 'thick', font: 'dohyeon' }).preset, 'yellow');
  // 켜기·위치·여백은 프리셋 이름을 바꾸지 않는다
  assert.strictEqual(S.normalizeStyle({ preset: 'pop', position: 'top', marginPct: 5, enabled: false }).preset, 'pop');
});

test('글자 크기: min(W,H) × 비율 × 단계 — 가로 720p 는 예전과 같은 33px', () => {
  const px = (style, w, h) => S.sizeFor(style, w, h);
  assert.strictEqual(px({}, 1280, 720), 33, '예전 기본 (4.6% of 720)');
  assert.strictEqual(px({}, 1920, 1080), 50);
  assert.strictEqual(px({}, 854, 480), 22);
  assert.strictEqual(px({}, 720, 720), 35, '1:1 4.8%');
  assert.strictEqual(px({}, 720, 900), 36, '4:5 5.0%');
  assert.strictEqual(px({}, 720, 1280), 40, '9:16 5.6% (약 40px)');
  // 단계 s/m/l/xl = ×0.82/1/1.22/1.5
  assert.deepStrictEqual(['s', 'm', 'l', 'xl'].map((size) => px({ size }, 1280, 720)), [27, 33, 40, 50]);
  assert.strictEqual(px({ sizeScale: 2 }, 1280, 720), 66);
  assert.strictEqual(px({ size: 'xl' }, 720, 1280), 60);
  assert.strictEqual(S.outputAspect(1280, 720), '16:9');
  assert.strictEqual(S.outputAspect(720, 720), '1:1');
  assert.strictEqual(S.outputAspect(720, 900), '4:5');
  assert.strictEqual(S.outputAspect(720, 1280), '9:16');
  assert.strictEqual(S.outputAspect(1080, 1920), '9:16');
  assert.strictEqual(S.outputAspect(1000, 1000), '1:1');
  assert.strictEqual(S.outputAspect(0, 0), '16:9');
  // 화면에 보이는 한 줄 크기를 이 모듈 하나로 계산하므로, 출력 크기 표도 assemble.outputSize 와 같아야 한다
  for (const a of ['16:9', '1:1', '4:5', '9:16']) for (const q of ['480p', '720p', '1080p']) assert.deepStrictEqual(S.outputSize(a, q), outputSize(a, q), `${a} ${q}`);
});

test('안전영역과 위치: 9:16 은 아래 24% · 오른쪽 12% 를 비우고, 나머지는 아래 8%', () => {
  const wide = S.layoutMetrics({}, 1280, 720);
  assert.strictEqual(wide.bottomPx, 58, '8% of 720 (예전 marginPct 8)');
  assert.strictEqual(wide.vertical, false);
  assert.deepStrictEqual(wide.area, { x: 51, y: 58, w: 1178, h: 604 });
  assert.ok(Math.abs(wide.maxTextW - 0.88 * 1280) < 3, `예전 최대 글 폭 0.88W 와 거의 같다: ${wide.maxTextW}`);
  assert.strictEqual(wide.lineHeight, 43);
  assert.strictEqual(wide.padX, 20);
  assert.strictEqual(wide.padY, 12);
  assert.ok(Math.abs(wide.strokePx - 5.28) < 0.01 && Math.abs(wide.shadowBlur - 4.95) < 0.01 && wide.boxRadius === 12, '테두리·그림자·상자 모서리도 예전과 같다');
  const tall = S.layoutMetrics({}, 720, 1280);
  assert.strictEqual(tall.vertical, true);
  assert.strictEqual(tall.bottomPx, Math.round(1280 * 0.24));
  assert.strictEqual(tall.margin.right, Math.round(720 * 0.12));
  assert.ok(tall.area.x + tall.area.w <= 720 - 86 + 1);
  // 안전영역 끄기 → 세로여도 아래 8%
  assert.strictEqual(S.layoutMetrics({ safeArea: 'off' }, 720, 1280).bottomPx, Math.round(1280 * 0.08));
  // 직접 여백 (고급)
  assert.strictEqual(S.layoutMetrics({ marginPct: 15 }, 720, 1280).bottomPx, Math.round(1280 * 0.15));
  assert.strictEqual(S.layoutMetrics({ position: 'top', marginPct: 5 }, 1280, 720).topPx, 36);
  // placeBox: 가운데, 세로 영상은 오른쪽 버튼 자리를 피해 왼쪽으로 치우친다
  const b1 = S.placeBox({}, 1280, 720, 400, 67);
  assert.strictEqual(b1.x, 440);
  assert.strictEqual(b1.y, 720 - 58 - 67);
  const b2 = S.placeBox({}, 720, 1280, 400, 100);
  assert.ok(b2.x + 200 < 360, `가운데보다 왼쪽: ${b2.x}`);
  assert.ok(b2.x + 400 <= 720 - 86, '오른쪽 12% 를 침범하지 않는다');
  assert.strictEqual(b2.y + 100, 1280 - 307);
  assert.strictEqual(S.placeBox({ position: 'top' }, 1280, 720, 400, 67).y, 58);
  const mid = S.placeBox({ position: 'middle' }, 1280, 720, 400, 100);
  assert.ok(Math.abs(mid.y + 50 - 360) <= 1, `가운데: ${mid.y}`);
  const r = S.safeRect({}, 720, 1280);
  assert.strictEqual(r.margin.bottom, 307);
  assert.strictEqual(r.vertical, true);
  assert.strictEqual(r.h, 1280 - r.margin.top - r.margin.bottom);
});

test('옛 형식(fromLegacy): 예전 코드와 같은 글자 크기 · 여백 · 모양', () => {
  const old = { enabled: true, sizePct: 4.6, color: 'white', box: false, marginPct: 8 };
  assert.ok(S.isLegacy(old) && !S.isLegacy(S.normalizeStyle(old)));
  for (const [w, h] of [[1280, 720], [1920, 1080], [854, 480], [720, 720], [720, 900], [720, 1280]]) {
    const s = S.normalizeStyle(old, { w, h });
    assert.strictEqual(S.sizeFor(s, w, h), Math.round((4.6 / 100) * h), `${w}x${h}: 글자 크기 = 화면 높이의 4.6% (예전)`);
    const m = S.layoutMetrics(s, w, h);
    assert.strictEqual(m.bottomPx, Math.round((8 / 100) * h), `${w}x${h}: 아래 여백 8%`);
    assert.strictEqual(s.font, 'system');
    assert.strictEqual(s.color, '#ffffff');
    assert.strictEqual(s.box, 'none');
    assert.strictEqual(s.outline, 'normal');
    assert.strictEqual(s.safeArea, 'off', '예전에는 안전영역이 없었다');
    assert.strictEqual(S.normalizeStyle(s, { w, h }).sizeScale, s.sizeScale, '다시 넣어도 그대로');
  }
  const y = S.normalizeStyle({ enabled: true, sizePct: 5.2, color: 'yellow', box: true, marginPct: 12 }, { w: 1280, h: 720 });
  assert.strictEqual(y.color, '#ffe14d');
  assert.strictEqual(y.box, 'soft', '예전 상자 = 검정 55%');
  assert.strictEqual(S.boxAlpha(y), 0.55);
  assert.strictEqual(y.outline, 'none', '예전에는 상자가 있으면 테두리를 안 그렸다');
  assert.strictEqual(S.sizeFor(y, 1280, 720), Math.round(0.052 * 720));
  assert.strictEqual(S.layoutMetrics(y, 1280, 720).bottomPx, Math.round(0.12 * 720));
  assert.strictEqual(S.normalizeStyle({ enabled: false, sizePct: 4.6, color: 'white', box: false, marginPct: 8 }).enabled, false);
  // 입력칸이 비어 저장된 옛 워크플로우(sizePct 0 · null · NaN, marginPct 0) 도 안전하다
  for (const sp of [0, null, NaN, '', 'abc']) {
    const s = S.normalizeStyle({ enabled: true, sizePct: sp, color: 'white', box: false, marginPct: 0 }, { w: 1280, h: 720 });
    assert.strictEqual(S.sizeFor(s, 1280, 720), 33);
    assert.strictEqual(S.layoutMetrics(s, 1280, 720).bottomPx, 58);
  }
  // 아주 큰 옛 값은 배율 상한(2배)에서 멈춘다
  assert.strictEqual(S.normalizeStyle({ sizePct: 10, color: 'white', box: false, marginPct: 8 }, { w: 1280, h: 720 }).sizeScale, 2);
  // fromLegacy 를 직접 불러도 같다
  assert.deepStrictEqual(S.fromLegacy(old, { w: 720, h: 1280 }), S.normalizeStyle(old, { w: 720, h: 1280 }));
  assert.strictEqual(S.sizeFor(S.fromLegacy(old, { w: 720, h: 1280 }), 720, 1280), 59, '세로 영상의 예전 글자 크기 59px 도 그대로');
});

test('섞인 형식(새 워크플로우의 preset + 옛 입력칸): 예전 기본값은 무시하고 사용자가 바꾼 값만 덮어쓴다', () => {
  // 옛 편집기가 저장한 워크플로우 + 새 기본값(preset basic) 이 합쳐진 모양
  const untouched = S.normalizeStyle({ enabled: true, preset: 'basic', sizePct: 4.6, color: 'white', box: false, marginPct: 8 }, { w: 720, h: 1280 });
  assert.deepStrictEqual(untouched, S.normalizeStyle({ preset: 'basic' }), '건드리지 않았으면 새 기본 모양(세로면 안전영역)');
  assert.strictEqual(S.layoutMetrics(untouched, 720, 1280).bottomPx, 307);
  const touched = S.normalizeStyle({ enabled: true, preset: 'basic', sizePct: 6, color: 'yellow', box: true, marginPct: 12 }, { w: 1280, h: 720 });
  assert.strictEqual(S.sizeFor(touched, 1280, 720), Math.round(0.06 * 720));
  assert.strictEqual(touched.color, '#ffe14d');
  assert.strictEqual(touched.box, 'soft');
  assert.strictEqual(touched.font, 'pretendard', '글꼴은 새 프리셋 것');
  assert.strictEqual(touched.marginPct, 12);
  // 입력칸이 비어 저장된 경우도 새 기본값
  const empty = S.normalizeStyle({ enabled: true, preset: 'shorts', sizePct: 0, color: 'white', box: false, marginPct: 0 }, { w: 720, h: 1280 });
  assert.strictEqual(empty.font, 'blackhan');
  assert.strictEqual(empty.size, 'xl');
  assert.strictEqual(empty.marginPct, null);
});

test('mergeStyle · applyPreset · matchPreset', () => {
  const base = S.normalizeStyle({ preset: 'basic', position: 'top', marginPct: 10, enabled: false });
  // 프리셋을 바꾸면 겉모습은 새 프리셋 것, 켜기·위치·여백은 그대로
  const y = S.applyPreset(base, 'yellow');
  assert.strictEqual(y.preset, 'yellow');
  assert.strictEqual(y.position, 'top');
  assert.strictEqual(y.marginPct, 10);
  assert.strictEqual(y.enabled, false);
  assert.strictEqual(y.font, 'dohyeon');
  // 같은 프리셋에서 한 칸만 바꾸면 custom
  const c = S.mergeStyle(y, { size: 'xl' });
  assert.strictEqual(c.preset, 'custom');
  assert.strictEqual(c.font, 'dohyeon');
  // 새 프리셋 + 다른 칸 같이
  const m = S.mergeStyle(c, { preset: 'pop', size: 'xl' });
  assert.strictEqual(m.font, 'jua');
  assert.strictEqual(m.size, 'xl');
  assert.strictEqual(m.color, '#ff6fb5');
  // 일부 칸만 주기
  assert.strictEqual(S.mergeStyle(base, { position: 'middle' }).position, 'middle');
  assert.strictEqual(S.mergeStyle(base, {}).position, 'top');
  assert.strictEqual(S.mergeStyle(undefined, { preset: 'box' }).box, 'soft');
  // 모르는 프리셋 이름은 무시
  assert.strictEqual(S.applyPreset(base, 'nope').preset, 'basic');
  // 옛 형식 patch 도 받는다
  assert.strictEqual(S.mergeStyle(base, { sizePct: 5.5, color: 'yellow', box: false, marginPct: 9 }, { w: 1280, h: 720 }).color, '#ffe14d');
  for (const p of S.PRESETS) assert.strictEqual(S.matchPreset(S.normalizeStyle({ preset: p.id })), p.id);
  assert.strictEqual(S.matchPreset({}), 'custom');
});

test('styleSig: 모양을 가르는 칸만 (켜기 · 이름 · 페이드는 뺀다)', () => {
  const a = S.normalizeStyle({ preset: 'yellow' });
  assert.strictEqual(S.styleSig(a), S.styleSig({ ...a, enabled: false, fade: 0.4 }));
  assert.strictEqual(S.styleSig(a), S.styleSig(a), '같은 입력 같은 결과');
  assert.notStrictEqual(S.styleSig(a), S.styleSig({ ...a, size: 'xl' }));
  assert.notStrictEqual(S.styleSig(a), S.styleSig({ ...a, font: 'jua' }));
  assert.notStrictEqual(S.styleSig(a), S.styleSig({ ...a, position: 'top' }));
  assert.notStrictEqual(S.styleSig(a), S.styleSig({ ...a, marginPct: 5 }));
  assert.strictEqual(S.styleSig({ preset: 'yellow' }), S.styleSig(a), '정규화 안 된 입력도 받는다');
  assert.ok(!S.styleSig(a).includes('undefined'));
});

test('basic 프리셋은 예전 기본 모양: 흰 글씨 + 검은 테두리(굵기 0.16) + 그림자 + 아래 8%', () => {
  const b = S.normalizeStyle({ preset: 'basic' });
  assert.strictEqual(b.color, '#ffffff');
  assert.strictEqual(b.outlineColor, '#000000');
  assert.strictEqual(S.outlineWidth(b, 33).toFixed(2), '5.28');
  assert.strictEqual(S.outlineWidth(S.normalizeStyle({ outline: 'none' }), 33), 0);
  assert.strictEqual(S.outlineWidth(S.normalizeStyle({ outline: 'normal' }), 10), 3, '예전 최소 3px');
  assert.ok(S.outlineWidth(S.normalizeStyle({ outline: 'thick' }), 40) > S.outlineWidth(S.normalizeStyle({ outline: 'thin' }), 40));
  assert.strictEqual(b.shadow, true);
  assert.strictEqual(S.rgba('#000000', 0.9), 'rgba(0,0,0,0.9)');
  assert.strictEqual(S.rgba(S.normalizeStyle({ box: 'soft' }).boxColor, S.boxAlpha({ box: 'soft' })), 'rgba(0,0,0,0.55)');
  assert.strictEqual(S.outlineAlpha({ outlineColor: '#000000' }), 0.9, '어두운 테두리는 예전 0.9');
  assert.strictEqual(S.outlineAlpha({ outlineColor: '#ffffff' }), 1, '흰 테두리는 또렷하게');
  // 프리셋 설명대로
  const sh = S.normalizeStyle({ preset: 'shorts' });
  assert.strictEqual(sh.size, 'xl');
  assert.strictEqual(sh.safeArea, 'auto');
  assert.strictEqual(sh.maxLines, 2);
  assert.strictEqual(S.normalizeStyle({ preset: 'box' }).box, 'soft');
  assert.strictEqual(S.normalizeStyle({ preset: 'yellow' }).color, '#ffe14d');
  assert.strictEqual(S.normalizeStyle({ preset: 'minimal' }).size, 's');
  assert.ok(S.COLOR_SWATCHES.length === 8 && S.COLOR_SWATCHES.every((c) => /^#[0-9a-f]{6}$/.test(c)));
  assert.ok(S.describe(b).includes('기본'));
});
