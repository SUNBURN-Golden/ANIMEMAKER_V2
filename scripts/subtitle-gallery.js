'use strict';
// 자막 모양 갤러리 — 눈으로 확인하는 용도 (npm test 에는 들어가지 않는다).
// 진짜 자막 그리기(renderSubtitlePngs)로 프리셋 7개 × 가로(1280x720)·세로(720x1280) × 짧은 줄/긴 줄을 그려서
// 샘플 장면 위에 얹은 그림 한 장씩을 만든다.
//
//   xvfb-run -a -s "-screen 0 1400x1000x24" node_modules/electron/dist/electron scripts/subtitle-gallery.js <출력 폴더>
//
// 만드는 파일:  gallery-16x9.png · gallery-9x16.png (한눈에 보기), frames/<가로세로>-<프리셋>-<짧은|긴>.png (실제 크기)
//              fonts-16x9.png (글꼴 6개 견본), report.json (칸마다 PNG 크기·자리)
// 그림과 함께 자동 검사도 한다: PNG 가 안전 영역 안에 있나 · 글자가 실제로 그려졌나 · 번들 글꼴 5개가 모두 읽히나 ·
// 글꼴 파일을 못 읽으면 system 글꼴로 되돌아가나. 하나라도 틀리면 CHECK-FAILED 를 찍고 종료 코드 1.
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../src/shared/subtitle-style');
const { renderSubtitlePngs } = require('../src/main/subtitles');

// 출력 폴더: 스크립트 뒤의 첫 인자 (electron 이 붙이는 --옵션 은 건너뛴다)
const argDir = process.argv.slice(1).filter((a) => !a.startsWith('--') && path.resolve(a) !== __filename)[0];
const OUT = path.resolve(argDir || path.join(process.cwd(), 'subtitle-gallery'));
const ASPECTS = [{ key: '16x9', w: 1280, h: 720 }, { key: '9x16', w: 720, h: 1280 }];
const LINES = [
  { key: '짧은', text: '별빛이 내리는 밤, 함께 걸어요' },
  { key: '긴', text: '함께라면 두렵지 않아 우리의 노래가 하늘 끝까지 닿을 때까지 달려가자' },
];

app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'am-gallery-')));
app.on('window-all-closed', () => {});

/** 합성 페이지 쪽에서 돌릴 코드: 샘플 장면 + PNG 얹기 + 라벨 (subtitle-canvas.html 의 글꼴·모듈을 그대로 쓴다) */
const COMPOSE = `
(async () => {
  window.compose = async function (spec) {
    await document.fonts.load('700 20px "AM Pretendard"', '가나다');
    const sheet = document.createElement('canvas');
    sheet.width = spec.sheetW; sheet.height = spec.sheetH;
    const g = sheet.getContext('2d');
    g.fillStyle = '#20232b'; g.fillRect(0, 0, sheet.width, sheet.height);
    const load = (url) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    for (const c of spec.cells) {
      // 샘플 장면: 하늘(밝음) + 언덕 + 왼쪽은 어두운 땅, 오른쪽은 밝은 벽 → 흰 글씨·검은 글씨 둘 다 시험
      const scene = document.createElement('canvas'); scene.width = spec.W; scene.height = spec.H;
      const s = scene.getContext('2d');
      const sky = s.createLinearGradient(0, 0, 0, spec.H);
      sky.addColorStop(0, '#6fb7f2'); sky.addColorStop(0.6, '#cfe9ff'); sky.addColorStop(1, '#fff3d6');
      s.fillStyle = sky; s.fillRect(0, 0, spec.W, spec.H);
      s.fillStyle = '#fff6b0'; s.beginPath(); s.arc(spec.W * 0.8, spec.H * 0.2, spec.H * 0.09, 0, 7); s.fill();
      s.fillStyle = '#5c9a55'; s.beginPath(); s.moveTo(0, spec.H * 0.62); s.quadraticCurveTo(spec.W * 0.35, spec.H * 0.5, spec.W * 0.7, spec.H * 0.65); s.lineTo(spec.W, spec.H * 0.6); s.lineTo(spec.W, spec.H); s.lineTo(0, spec.H); s.fill();
      s.fillStyle = '#2b3a2a'; s.fillRect(0, spec.H * 0.78, spec.W * 0.5, spec.H * 0.22);   // 어두운 땅 (왼쪽 아래)
      s.fillStyle = '#f4f1e8'; s.fillRect(spec.W * 0.5, spec.H * 0.78, spec.W * 0.5, spec.H * 0.22); // 밝은 벽 (오른쪽 아래)
      s.fillStyle = 'rgba(255,255,255,0.7)'; for (let k = 0; k < 6; k++) { s.beginPath(); s.arc(spec.W * (0.1 + 0.15 * k), spec.H * (0.18 + 0.04 * (k % 3)), spec.H * 0.04, 0, 7); s.fill(); }
      if (c.png) { const img = await load(c.png); s.drawImage(img, c.x, c.y); }
      if (spec.guide) {
        // 9:16 은 버튼이 가릴 수 있는 곳(아래 24%, 오른쪽 12%)을 붉게 표시
        const m = window.AMSubtitleStyle.safeRect(c.style, spec.W, spec.H).margin;
        s.fillStyle = 'rgba(255,40,40,0.14)'; s.fillRect(0, spec.H - m.bottom, spec.W, m.bottom); s.fillRect(spec.W - m.right, 0, m.right, spec.H);
        s.strokeStyle = 'rgba(255,0,0,0.5)'; s.setLineDash([10, 8]); s.lineWidth = 2; s.strokeRect(m.left, m.top, spec.W - m.left - m.right, spec.H - m.top - m.bottom);
      }
      g.drawImage(scene, c.cx, c.cy, spec.cellW, spec.cellH);
      g.fillStyle = 'rgba(0,0,0,0.65)'; g.fillRect(c.cx, c.cy, spec.cellW, 22);
      g.fillStyle = '#fff'; g.font = '700 14px "AM Pretendard", sans-serif'; g.textBaseline = 'middle'; g.fillText(c.label, c.cx + 8, c.cy + 11);
    }
    return sheet.toDataURL('image/png').split(',')[1];
  };
})()
`;

async function composeSheet(spec) {
  const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await win.loadFile(path.join(__dirname, '..', 'src', 'main', 'subtitle-canvas.html'));
    await win.webContents.executeJavaScript(COMPOSE);
    return Buffer.from(await win.webContents.executeJavaScript(`window.compose(${JSON.stringify(spec)})`), 'base64');
  } finally {
    win.destroy();
  }
}

const dataUrl = (file) => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;

const failures = [];
const logs = [];
function check(name, ok, detail = '') {
  if (!ok) failures.push(`${name} ${detail}`);
  console.log(`${ok ? 'CHECK-OK    ' : 'CHECK-FAILED'} ${name}${detail ? ` (${detail})` : ''}`);
}
/** PNG 에서 투명하지 않은 픽셀 수 */
function inkPixels(file) {
  const img = nativeImage.createFromBuffer(fs.readFileSync(file));
  const { width, height } = img.getSize();
  const bmp = img.toBitmap();
  let n = 0;
  for (let i = 3; i < bmp.length; i += 4) if (bmp[i] > 16) n++;
  return { width, height, n };
}

async function main() {
  fs.mkdirSync(path.join(OUT, 'frames'), { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'am-gallery-png-'));
  const report = [];
  for (const asp of ASPECTS) {
    // 전체 갤러리: 줄(짧은/긴) × 프리셋 7개
    const scale = asp.w > asp.h ? 0.5 : 0.4;
    const cellW = Math.round(asp.w * scale);
    const cellH = Math.round(asp.h * scale);
    const cells = [];
    for (let pi = 0; pi < S.PRESETS.length; pi++) {
      const preset = S.PRESETS[pi];
      for (let li = 0; li < LINES.length; li++) {
        const style = { preset: preset.id };
        const dir = path.join(work, `${asp.key}-${preset.id}-${LINES[li].key}`);
        const t0 = Date.now();
        const res = await renderSubtitlePngs([{ text: LINES[li].text, start: 0, end: 3 }], { w: asp.w, h: asp.h, style, outDir: dir, log: (m) => { logs.push(m); console.log('LOG', m); } });
        const r = res[0];
        const ink = inkPixels(r.file);
        const W = asp.w;
        const H = asp.h;
        const m = S.layoutMetrics({ preset: preset.id }, W, H);
        check(`${asp.key} ${preset.id} ${LINES[li].key}: 크기가 맞다`, ink.width === r.w && ink.height === r.h, `${ink.width}x${ink.height}`);
        check(`${asp.key} ${preset.id} ${LINES[li].key}: 글자가 그려졌다`, ink.n > (r.w * r.h) * 0.01, `${ink.n} 픽셀`);
        check(`${asp.key} ${preset.id} ${LINES[li].key}: 안전 영역 안`, r.x >= m.area.x - 1 && r.x + r.w <= m.area.x + m.area.w + 1 && r.y + r.h <= H - m.bottomPx + 1 && r.y >= 0, `x ${r.x}..${r.x + r.w}, 아래 ${r.y + r.h} (허용 ${m.area.x}..${m.area.x + m.area.w}, ${H - m.bottomPx})`);
        report.push({ aspect: asp.key, preset: preset.id, line: LINES[li].key, x: r.x, y: r.y, w: r.w, h: r.h, bottom: r.y + r.h, right: r.x + r.w, ms: Date.now() - t0 });
        // 실제 크기 한 장
        const full = await composeSheet({ sheetW: asp.w, sheetH: asp.h, W: asp.w, H: asp.h, cellW: asp.w, cellH: asp.h, guide: asp.key === '9x16',
          cells: [{ png: dataUrl(r.file), x: r.x, y: r.y, cx: 0, cy: 0, label: `${asp.key} · ${preset.id} · ${LINES[li].key} 줄 · ${r.w}x${r.h} @ ${r.x},${r.y}`, style }] });
        fs.writeFileSync(path.join(OUT, 'frames', `${asp.key}-${preset.id}-${LINES[li].key}.png`), full);
        const col = asp.w > asp.h ? li : pi;
        const row = asp.w > asp.h ? pi : li;
        cells.push({ png: dataUrl(r.file), x: r.x, y: r.y, cx: col * (cellW + 6) + 6, cy: row * (cellH + 6) + 6, label: `${preset.id} ${preset.label} · ${LINES[li].key} 줄`, style });
      }
    }
    const cols = asp.w > asp.h ? LINES.length : S.PRESETS.length;
    const rows = asp.w > asp.h ? S.PRESETS.length : LINES.length;
    const sheet = await composeSheet({ sheetW: cols * (cellW + 6) + 6, sheetH: rows * (cellH + 6) + 6, W: asp.w, H: asp.h, cellW, cellH, guide: asp.key === '9x16', cells });
    fs.writeFileSync(path.join(OUT, `gallery-${asp.key}.png`), sheet);
  }

  // 글꼴 6개 견본 (가로 영상, 같은 글을 글꼴만 바꿔서)
  {
    const asp = ASPECTS[0];
    const cells = [];
    const scale = 0.5;
    for (let fi = 0; fi < S.FONTS.length; fi++) {
      const f = S.FONTS[fi];
      const dir = path.join(work, `font-${f.id}`);
      const res = await renderSubtitlePngs([{ text: '가나다라 ABC 123 별빛이 내리는 밤 뷁뜮', start: 0, end: 3 }], { w: asp.w, h: asp.h, style: { preset: 'basic', font: f.id }, outDir: dir, log: (m) => { logs.push(m); console.log('LOG', m); } });
      const r = res[0];
      const ink = inkPixels(r.file);
      check(`글꼴 ${f.id}: 글자가 그려졌다`, ink.n > r.w * r.h * 0.01, `${ink.n} 픽셀`);
      cells.push({ png: dataUrl(r.file), x: r.x, y: r.y, cx: (fi % 2) * (asp.w * scale + 6) + 6, cy: Math.floor(fi / 2) * (asp.h * scale + 6) + 6, label: `${f.id} ${f.label}`, style: { font: f.id } });
    }
    const sheet = await composeSheet({ sheetW: 2 * (asp.w * scale + 6) + 6, sheetH: 3 * (asp.h * scale + 6) + 6, W: asp.w, H: asp.h, cellW: asp.w * scale, cellH: asp.h * scale, guide: false, cells });
    fs.writeFileSync(path.join(OUT, 'fonts-16x9.png'), sheet);
  }
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  check('글꼴을 못 불러왔다는 알림이 한 번도 없었다', !logs.some((m) => /불러오지 못/.test(m)), logs.join(' / '));
  await fontSelfTest();
  console.log('GALLERY-DONE', OUT, report.length, 'cells');
  if (failures.length) { console.log('CHECK-FAILED 합계', failures.length, '\n', failures.join('\n ')); return 1; }
  console.log('CHECK-ALL-OK');
  return 0;
}

/** 번들 글꼴이 모두 읽히는지, 글꼴 파일이 없으면 system 으로 되돌아가는지 (숨은 창의 페이지에서 직접) */
async function fontSelfTest() {
  const page = path.join(__dirname, '..', 'src', 'main', 'subtitle-canvas.html');
  const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await win.loadFile(page);
    for (const f of S.FONTS) {
      const r = await win.webContents.executeJavaScript(`window.AMSubs.prepare({ font: ${JSON.stringify(f.id)} }, '가나다 별빛이 내리는 밤')`);
      check(`글꼴 ${f.id} 가 읽힌다`, r && r.fallback === false && r.font === f.id, JSON.stringify(r));
    }
  } finally { win.destroy(); }
  const win2 = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await win2.loadFile(page);
    // 글꼴 파일 위치를 일부러 틀리게 바꿔서 (= 파일이 없는 경우)
    await win2.webContents.executeJavaScript("document.getElementById('am-fonts').textContent = window.AMSubtitleStyle.fontFaceCss('../nope/')");
    const r = await win2.webContents.executeJavaScript("window.AMSubs.prepare({ font: 'jua' }, '가나다')");
    check('글꼴 파일이 없으면 system 글꼴로 되돌아간다', r && r.fallback === true && r.font === 'system', JSON.stringify(r));
    const ok = await win2.webContents.executeJavaScript("(() => { const x = window.AMSubs.render('가나다라 별빛이 내리는 밤', { font: 'system' }, 1280, 720); return !!x && x.w > 100 && x.png.length > 500; })()");
    check('되돌아간 system 글꼴로도 한글이 그려진다', ok === true);
  } finally { win2.destroy(); }
}

app.whenReady().then(main).then((code) => app.exit(code || 0)).catch((e) => { console.error('GALLERY-FAILED', e); app.exit(1); });
