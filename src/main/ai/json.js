'use strict';
// LLM 응답에서 JSON 을 안전하게 꺼내는 도우미.

function tryParse(s) {
  try { return JSON.parse(s); } catch (_) { return undefined; }
}

/** 문자열 안에서 균형 잡힌 {...} 덩어리들을 모두 찾는다 */
function balancedObjects(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { out.push(text.slice(i, j + 1)); break; }
      }
    }
  }
  return out;
}

/** 흔한 LLM 실수(끝 쉼표, 스마트 따옴표) 정리 */
function repair(s) {
  return s
    .replace(/[“”]/g, '"')
    .replace(/,\s*([}\]])/g, '$1');
}

/**
 * 텍스트에서 원하는 모양의 JSON 객체를 찾는다.
 * @param {string} text
 * @param {(o:any)=>boolean} [accept] 원하는 객체인지 판별
 */
function extractJson(text, accept = () => true) {
  if (text == null) return undefined;
  const raw = String(text).trim();
  const queue = [raw];
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(raw))) queue.push(m[1]);
  const seen = new Set();
  let best;
  let bestLen = -1;
  while (queue.length) {
    const t = queue.shift();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    let o = tryParse(t);
    if (o === undefined) o = tryParse(repair(t));
    if (o !== undefined && typeof o === 'object' && o) {
      if (accept(o) && t.length > bestLen) { best = o; bestLen = t.length; }
      // CLI 들이 결과를 {"result": "..."} 같은 봉투에 담아 주는 경우
      for (const k of ['result', 'response', 'text', 'output', 'content', 'message', 'last_message', 'final']) {
        if (typeof o[k] === 'string') queue.push(o[k]);
      }
      continue;
    }
    for (const cand of balancedObjects(t)) {
      if (cand.length === t.length) continue;
      queue.push(cand);
    }
  }
  return best;
}

/** JSON Lines(스트리밍 JSON) 에서 텍스트 조각들을 모은다 */
function collectJsonLinesText(stdout) {
  const parts = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const o = tryParse(line.trim());
    if (!o || typeof o !== 'object') continue;
    for (const k of ['result', 'response', 'text', 'content', 'message', 'output']) {
      if (typeof o[k] === 'string') parts.push(o[k]);
    }
    if (o.item && typeof o.item.text === 'string') parts.push(o.item.text);
  }
  return parts.join('\n');
}

module.exports = { extractJson, collectJsonLinesText, balancedObjects };
