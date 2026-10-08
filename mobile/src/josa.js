// 한국어 조사 고르기 (이/가 · 을/를 · 은/는 · 와/과 · 으로/로). 받침이 있으면 앞쪽, 없으면 뒤쪽.
// 한글은 받침을 보고, 영어 이름·숫자는 읽는 소리로 어림한다 (ChatGPT → 챗지피티: 받침 없음, Grok → 그록: 받침 있음).
const PAIRS = { '이/가': ['이', '가'], '을/를': ['을', '를'], '은/는': ['은', '는'], '와/과': ['과', '와'], '으로/로': ['으로', '로'] };
const WORDS = { chatgpt: false, gemini: false, grok: true, claude: false, suno: false };
const DIGIT_FINAL = [true, true, false, true, false, false, true, true, true, false]; // 영 일 이 삼 사 오 육 칠 팔 구

/** 단어 끝에 받침이 있는가 */
export function hasBatchim(word) {
  const s = String(word == null ? '' : word).trim();
  if (!s) return false;
  const low = s.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(WORDS, low)) return WORDS[low];
  const ch = s[s.length - 1];
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  if (/[0-9]/.test(ch)) return DIGIT_FINAL[Number(ch)];
  if (/[lmnr]/i.test(ch)) return true; // 엘 엠 엔 알
  return false;
}

/** josa('그림', '을/를') → '을',  josa('ChatGPT', '이/가') → '가' */
export function josa(word, pair) {
  const p = PAIRS[pair] || PAIRS['이/가'];
  const withB = hasBatchim(word);
  if (pair === '으로/로') {
    const s = String(word == null ? '' : word).trim();
    const code = s ? s.charCodeAt(s.length - 1) : 0;
    const ieul = code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 === 8; // ㄹ 받침은 '로'
    return withB && !ieul ? '으로' : '로';
  }
  return withB ? p[0] : p[1];
}

/** withJosa('그림', '을/를') → '그림을' */
export function withJosa(word, pair) { return `${word}${josa(word, pair)}`; }
