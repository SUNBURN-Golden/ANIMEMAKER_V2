'use strict';
// 가사 자막을 예쁜 PNG 이미지로 그린다.
// Electron 의 보이지 않는 창에서 canvas 로 그리므로 내 PC 의 글꼴 사정에 덜 흔들린다.
// 그리는 코드는 미리보기·모바일과 같은 공용 모듈(src/shared/subtitle-render.js)이고,
// 창은 data: 주소가 아니라 파일(subtitle-canvas.html)로 열어야 번들 글꼴이 읽힌다.
const fs = require('fs');
const path = require('path');
const S = require('../shared/subtitle-style');

const PAGE = path.join(__dirname, 'subtitle-canvas.html');

/**
 * @param {{text:string,start:number,end:number}[]} lyrics 보여 줄 줄들 (숨긴 줄은 미리 빼고 넘긴다)
 * @param {{w:number,h:number,style?:object,outDir:string,log?:(msg:string)=>void}} o
 *   w,h = 영상 출력 크기, style = 어떤 형식이든(옛 형식도) 되는 자막 스타일, log = 알림 글 남기기(선택)
 * @returns {Promise<{file:string,start:number,end:number,x:number,y:number,w:number,h:number,fade:number}[]>}
 *   x,y = 영상 위 PNG 의 왼쪽 위 (기본은 가운데, 안전영역·위치 반영)
 */
async function renderSubtitlePngs(lyrics, { w, h, style = {}, outDir, log }) {
  const { BrowserWindow } = require('electron');
  const st = S.normalizeStyle(style, { w, h });
  fs.mkdirSync(outDir, { recursive: true });
  // 지난번 파일이 남아 있으면 헷갈리니 먼저 치운다
  for (const f of fs.readdirSync(outDir)) if (/^line\d+\.png$/.test(f)) { try { fs.unlinkSync(path.join(outDir, f)); } catch (_) { /* noop */ } }
  const win = new BrowserWindow({ show: false, width: 800, height: 400, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  try {
    await win.loadFile(PAGE);
    const run = (code) => win.webContents.executeJavaScript(code);
    const sample = lyrics.map((l) => l.text).join('');
    const prep = await run(`window.AMSubs.prepare(${JSON.stringify(st)}, ${JSON.stringify(sample)})`);
    let use = st;
    if (prep && prep.fallback) {
      use = { ...st, font: 'system' };
      if (log) log(`⚠ 고른 글꼴을 불러오지 못해서 내 컴퓨터 기본 글꼴로 그렸어요. (${prep.reason || '이유 모름'})`);
    }
    const out = [];
    const seen = new Map(); // 같은 글은 그림 한 장을 같이 쓴다 (후렴이 되풀이될 때)
    for (let i = 0; i < lyrics.length; i++) {
      const l = lyrics[i];
      const text = String(l.text == null ? '' : l.text);
      if (!text.trim()) continue;
      let r = seen.get(text);
      if (!r) {
        const res = await run(`window.AMSubs.render(${JSON.stringify(text)}, ${JSON.stringify(use)}, ${w}, ${h})`);
        if (!res) continue;
        const file = path.join(outDir, `line${String(seen.size + 1).padStart(3, '0')}.png`);
        fs.writeFileSync(file, Buffer.from(res.png, 'base64'));
        r = { file, x: res.x, y: res.y, w: res.w, h: res.h };
        seen.set(text, r);
      }
      out.push({ file: r.file, start: l.start, end: l.end, x: r.x, y: r.y, w: r.w, h: r.h, fade: st.fade });
    }
    return out;
  } finally {
    win.destroy();
  }
}

module.exports = { renderSubtitlePngs };
