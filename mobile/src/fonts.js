// 번들 글꼴 (자막용 5개). 파일은 build.mjs 가 ../src/renderer/assets/fonts → www/assets/fonts 로 복사한다.
// @font-face 규칙은 데스크톱과 같은 공용 모듈(subtitle-style.js)이 만든다 → 별칭 'AM Jua' 등. 글꼴은 쓸 때 처음 내려받는다(앱 안 파일).
import SubtitleStyle from '../../src/shared/subtitle-style.js';

export const FONT_BASE = 'assets/fonts/';

export function fontFaceCss(base = FONT_BASE) {
  try { return SubtitleStyle.fontFaceCss(base); } catch (_) { return ''; }
}

/** <style id="am-fonts"> 에 @font-face 를 넣는다 (한 번만) */
export function installFonts(doc = document) {
  if (doc.getElementById('am-fonts')) return;
  const css = fontFaceCss();
  if (!css) return;
  const st = doc.createElement('style');
  st.id = 'am-fonts';
  st.textContent = css;
  doc.head.appendChild(st);
}

/** 글꼴을 미리 불러온다. 캔버스에 글자를 재거나 그리기 전에 기다려야 한다. 쓸 수 있으면 true */
export async function loadFont(fontId, px = 32, sample = '가나다 ABC') {
  try {
    const css = SubtitleStyle.fontCss(fontId, px);
    await document.fonts.load(css, sample);
    return document.fonts.check(css, sample);
  } catch (_) {
    return false;
  }
}
