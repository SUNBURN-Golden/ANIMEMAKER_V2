'use strict';
// 캐릭터 파일 (.amchar) 의 순수 계산 부분: 주인공을 '아주 단단한 기준' 으로 고정하기 위한 휴대용 파일.
//  - JSON 하나 안에 고정 설명(영어) · 색 팔레트 · 지켜야 할 규칙 · 기준 그림(base64 PNG/JPEG)을 모두 담는다.
//    (zip 같은 새 의존성 없이 메모장으로도 열어 볼 수 있다)
//  - PC 앱(characters.js 의 CharacterStore)과 폰 앱(안드로이드 WebView, esbuild 묶음), 그리고 프롬프트 조립(pipeline/prompts.js)이 같은 파일을 쓴다
//    (scripts/shared-modules.js · test/shared-purity.test.js). fs / path / crypto / ffmpeg / Buffer 를 쓰지 않는다.
//  - 순수 함수: sniffImage, normalizeHex, cleanText, cleanList, newId, normalizeCharacter, validateCharacter, lockedText, paletteText, characterBlock,
//    toAmchar, fromAmchar (그림 데이터는 b64encode / b64decode 로 다룬다: Uint8Array ↔ base64, 결과는 Buffer 와 같다).
//  - 디스크에 보관하는 CharacterStore 와 ffmpeg 로 그림을 PNG 로 바꾸는 일은 characters.js 에 남아 있다.
//  - '잠그기(lock)' 를 하면 설명·색·규칙·기준 그림을 바꿀 수 없다. 모든 에피소드가 같은 주인공을 쓰게 하기 위해서다.

const FORMAT = 'animemaker.character';
const FORMAT_VERSION = 1;
const LOCKED_FIELDS = ['summary', 'face', 'hair', 'eyes', 'body', 'outfit', 'props'];
const REF_KINDS = ['turnaround', 'expressions', 'fullbody', 'other'];
const REF_KIND_LABEL = { turnaround: '앞·옆·뒤 모습 (턴어라운드)', expressions: '표정 모음', fullbody: '전신', other: '기타' };
const MAX_REFS = 6;
const MAX_REF_BYTES = 12 * 1024 * 1024;
const MAX_RULES = 12;
const MAX_PALETTE = 12;

// ---------- base64 (Buffer 없이): buf.toString('base64') · Buffer.from(s, 'base64') 와 같은 결과 ----------
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_CODES = Uint8Array.from(B64, (ch) => ch.charCodeAt(0));
const B64_VALUE = (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < 64; i++) t[B64_CODES[i]] = i;
  t[0x2d] = 62; // '-' , '_' : URL 용 base64 도 받는다 (Buffer 처럼)
  t[0x5f] = 63;
  return t;
})();

/** Uint8Array → base64 문자열 (표준 글자, '=' 채움, 줄바꿈 없음) */
function b64encode(bytes) {
  const n = bytes.length;
  const out = new Uint8Array(Math.ceil(n / 3) * 4);
  let o = 0;
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out[o++] = B64_CODES[v >> 18];
    out[o++] = B64_CODES[(v >> 12) & 63];
    out[o++] = B64_CODES[(v >> 6) & 63];
    out[o++] = B64_CODES[v & 63];
  }
  if (n - i === 1) {
    const v = bytes[i] << 16;
    out[o++] = B64_CODES[v >> 18];
    out[o++] = B64_CODES[(v >> 12) & 63];
    out[o++] = 0x3d;
    out[o++] = 0x3d;
  } else if (n - i === 2) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out[o++] = B64_CODES[v >> 18];
    out[o++] = B64_CODES[(v >> 12) & 63];
    out[o++] = B64_CODES[(v >> 6) & 63];
    out[o++] = 0x3d;
  }
  return new TextDecoder().decode(out);
}

/**
 * base64 문자열 → Uint8Array. Buffer.from(s, 'base64') 처럼 너그럽다:
 * 공백·줄바꿈·알 수 없는 글자는 건너뛰고, '=' 를 만나면 거기서 끝낸다. 끝이 모자라면 온전한 바이트까지만.
 */
function b64decode(str) {
  const s = String(str);
  const out = new Uint8Array((s.length * 3 >>> 2) + 3);
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x3d) break;
    const v = B64_VALUE[c & 255];
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
      acc &= (1 << bits) - 1;
    }
  }
  return out.slice(0, o);
}

/** 새 캐릭터 id: 'char-' + 시각(36진수) + 무작위 6자리 (globalThis.crypto 는 Node 19+ 와 WebView 에 모두 있다) */
function newId() {
  const b = new Uint8Array(3);
  globalThis.crypto.getRandomValues(b);
  return `char-${Date.now().toString(36)}${Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** 파일 앞부분(매직 넘버)으로 그림 종류 판별 */
function sniffImage(buf) {
  if (!buf || buf.length < 8) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

/** '#abc', 'abc', '#AABBCC' → '#aabbcc' (틀리면 null) */
function normalizeHex(s) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(s || '').trim());
  if (!m) return null;
  let h = m[1].toLowerCase();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return `#${h}`;
}

function cleanText(s, max = 600) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanList(v, max = MAX_RULES) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/\r?\n/);
  return arr.map((x) => cleanText(x, 200)).filter(Boolean).slice(0, max);
}

/**
 * 캐릭터 메타데이터를 깔끔한 모양으로 (그림 데이터는 다루지 않음)
 * @returns {{id:string,name:string,version:number,locked:object,palette:{name:string,hex:string}[],rules:{must:string[],never:string[]},
 *   personality_ko:string,description_ko:string,refs:{file:string,kind:string,label:string,mime:string}[],lockedAt:number|null}}
 */
function normalizeCharacter(o = {}) {
  const locked = {};
  const src = o.locked && typeof o.locked === 'object' ? o.locked : {};
  for (const k of LOCKED_FIELDS) locked[k] = cleanText(src[k], k === 'summary' ? 900 : 400);
  const palette = (Array.isArray(o.palette) ? o.palette : [])
    .map((p, i) => (typeof p === 'string' ? { name: `color ${i + 1}`, hex: p } : p || {}))
    .map((p, i) => ({ name: cleanText(p.name, 40) || `color ${i + 1}`, hex: normalizeHex(p.hex) }))
    .filter((p) => p.hex)
    .slice(0, MAX_PALETTE);
  const rules = o.rules && typeof o.rules === 'object' ? o.rules : {};
  return {
    id: String(o.id || ''),
    name: cleanText(o.name, 40),
    version: Math.max(1, Math.floor(Number(o.version) || 1)),
    locked,
    palette,
    rules: { must: cleanList(rules.must), never: cleanList(rules.never) },
    personality_ko: cleanText(o.personality_ko, 600),
    description_ko: cleanText(o.description_ko, 1200),
    refs: (Array.isArray(o.refs) ? o.refs : []).slice(0, MAX_REFS).map((r) => ({
      file: String(r.file || ''),
      kind: REF_KINDS.includes(r.kind) ? r.kind : 'other',
      label: cleanText(r.label, 60),
      mime: r.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png',
    })),
    lockedAt: o.lockedAt ? Number(o.lockedAt) : null,
    createdAt: Number(o.createdAt) || Date.now(),
    updatedAt: Number(o.updatedAt) || Date.now(),
  };
}

/**
 * 문제 목록 (한국어). 비어 있으면 통과.
 * @param {{requireRefs?:boolean}} [opts] 잠그거나 에피소드에 쓰려면 기준 그림이 1장 이상 있어야 한다
 */
function validateCharacter(c, opts = {}) {
  const errs = [];
  if (!c.name) errs.push('이름이 비어 있어요.');
  if (!c.locked.summary && !LOCKED_FIELDS.slice(1).some((k) => c.locked[k])) errs.push('생김새 설명(영어)이 비어 있어요.');
  if (c.refs.length > MAX_REFS) errs.push(`기준 그림은 ${MAX_REFS}장까지예요.`);
  if (opts.requireRefs && !c.refs.length) errs.push('기준 그림이 1장 이상 있어야 해요.');
  return errs;
}

/** 이미지 생성 프롬프트에 그대로 붙이는 '고정 설명' (영어) */
function lockedText(c) {
  const L = c.locked || {};
  const parts = [];
  if (L.summary) parts.push(L.summary);
  for (const k of LOCKED_FIELDS.slice(1)) if (L[k]) parts.push(`${k}: ${L[k]}`);
  return parts.join('; ');
}

function paletteText(c) {
  return (c.palette || []).map((p) => `${p.name} ${p.hex}`).join(', ');
}

/** 캐릭터 한 명의 '절대 규칙' 블록 (영어, 모든 그림 요청에 그대로 들어간다) */
function characterBlock(c) {
  const lines = [`${c.name} — LOCKED DESIGN (copy exactly, do not reinterpret): ${lockedText(c)}`];
  if (c.palette && c.palette.length) lines.push(`${c.name} color palette (use these exact colors): ${paletteText(c)}`);
  if (c.rules && c.rules.must && c.rules.must.length) lines.push(`${c.name} MUST: ${c.rules.must.join('; ')}`);
  if (c.rules && c.rules.never && c.rules.never.length) lines.push(`${c.name} NEVER: ${c.rules.never.join('; ')}`);
  return lines.join('\n');
}

/** 저장된 캐릭터 + 기준 그림 바이트(Uint8Array 또는 Buffer) → .amchar 객체 */
function toAmchar(c, refBuffers) {
  const n = normalizeCharacter(c);
  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    app: 'AnimeMaker V2',
    id: n.id,
    name: n.name,
    version: n.version,
    locked: n.locked,
    palette: n.palette,
    rules: n.rules,
    personality_ko: n.personality_ko,
    description_ko: n.description_ko,
    lockedAt: n.lockedAt,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    refs: n.refs.map((r, i) => ({ kind: r.kind, label: r.label, mime: sniffImage(refBuffers[i]) || r.mime, data: b64encode(refBuffers[i]) })),
  };
}

/**
 * .amchar 내용(문자열·바이트 또는 객체) → { character, refs: [{kind,label,mime,buffer}] }  (buffer 는 Uint8Array)
 * 형식이 틀리면 한국어 설명이 담긴 Error 를 던진다.
 */
function fromAmchar(input) {
  let o = input;
  if (typeof input === 'string' || input instanceof Uint8Array) { // Uint8Array: 파일에서 읽은 바이트 (Node 의 Buffer 도 이것의 한 종류)
    const text = typeof input === 'string' ? input : new TextDecoder('utf-8', { ignoreBOM: true }).decode(input);
    try { o = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (_) { throw new Error('캐릭터 파일을 읽을 수 없어요. (.amchar 파일이 맞나요?)'); }
  }
  if (!o || typeof o !== 'object' || o.format !== FORMAT) throw new Error('AnimeMaker 캐릭터 파일(.amchar)이 아니에요.');
  if (Number(o.formatVersion) > FORMAT_VERSION) throw new Error('더 새로운 버전의 앱에서 만든 캐릭터 파일이에요. 앱을 업데이트해 주세요.');
  const rawRefs = Array.isArray(o.refs) ? o.refs : [];
  if (rawRefs.length > MAX_REFS) throw new Error(`기준 그림이 너무 많아요. (${MAX_REFS}장까지)`);
  const refs = rawRefs.map((r, i) => {
    let buf;
    try { buf = b64decode(String((r && r.data) || '')); } catch (_) { buf = new Uint8Array(0); }
    const mime = sniffImage(buf);
    if (!mime) throw new Error(`${i + 1}번째 기준 그림이 PNG/JPEG 그림이 아니에요.`);
    if (buf.length > MAX_REF_BYTES) throw new Error(`${i + 1}번째 기준 그림이 너무 커요.`);
    return { kind: REF_KINDS.includes(r.kind) ? r.kind : 'other', label: cleanText(r.label, 60), mime, buffer: buf };
  });
  const character = normalizeCharacter({ ...o, refs: refs.map((r) => ({ kind: r.kind, label: r.label, mime: r.mime, file: '' })) });
  const errs = validateCharacter(character, { requireRefs: !!character.lockedAt });
  if (errs.length) throw new Error(`캐릭터 파일에 문제가 있어요: ${errs.join(' ')}`);
  return { character, refs };
}

module.exports = {
  FORMAT, FORMAT_VERSION, LOCKED_FIELDS, REF_KINDS, REF_KIND_LABEL, MAX_REFS, MAX_REF_BYTES, MAX_RULES, MAX_PALETTE,
  sniffImage, normalizeHex, cleanText, cleanList, newId, normalizeCharacter, validateCharacter, lockedText, paletteText, characterBlock,
  b64encode, b64decode, toAmchar, fromAmchar,
};
