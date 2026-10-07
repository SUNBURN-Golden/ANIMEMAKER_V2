'use strict';
// 캐릭터 파일 (.amchar): 주인공을 '아주 단단한 기준' 으로 고정하기 위한 휴대용 파일.
//  - JSON 하나 안에 고정 설명(영어) · 색 팔레트 · 지켜야 할 규칙 · 기준 그림(base64 PNG/JPEG)을 모두 담는다.
//    (zip 같은 새 의존성 없이 메모장으로도 열어 볼 수 있다)
//  - 앱 안에서는 userData/characters/<id>/ 폴더에 character.json + refs/*.png 로 풀어서 보관한다.
//  - '잠그기(lock)' 를 하면 설명·색·규칙·기준 그림을 바꿀 수 없다. 모든 에피소드가 같은 주인공을 쓰게 하기 위해서다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runFfmpeg } = require('./media/ffmpeg');

const FORMAT = 'animemaker.character';
const FORMAT_VERSION = 1;
const LOCKED_FIELDS = ['summary', 'face', 'hair', 'eyes', 'body', 'outfit', 'props'];
const REF_KINDS = ['turnaround', 'expressions', 'fullbody', 'other'];
const REF_KIND_LABEL = { turnaround: '앞·옆·뒤 모습 (턴어라운드)', expressions: '표정 모음', fullbody: '전신', other: '기타' };
const MAX_REFS = 6;
const MAX_REF_BYTES = 12 * 1024 * 1024;
const MAX_RULES = 12;
const MAX_PALETTE = 12;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  try { fs.renameSync(tmp, file); } catch (_) { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); try { fs.unlinkSync(tmp); } catch (__) { /* noop */ } }
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

function newId() {
  return `char-${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
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

/** 저장된 캐릭터 + 기준 그림 버퍼 → .amchar 객체 */
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
    refs: n.refs.map((r, i) => ({ kind: r.kind, label: r.label, mime: sniffImage(refBuffers[i]) || r.mime, data: refBuffers[i].toString('base64') })),
  };
}

/**
 * .amchar 내용(문자열 또는 객체) → { character, refs: [{kind,label,mime,buffer}] }
 * 형식이 틀리면 한국어 설명이 담긴 Error 를 던진다.
 */
function fromAmchar(input) {
  let o = input;
  if (typeof input === 'string' || Buffer.isBuffer(input)) {
    try { o = JSON.parse(String(input).replace(/^﻿/, '')); } catch (_) { throw new Error('캐릭터 파일을 읽을 수 없어요. (.amchar 파일이 맞나요?)'); }
  }
  if (!o || typeof o !== 'object' || o.format !== FORMAT) throw new Error('AnimeMaker 캐릭터 파일(.amchar)이 아니에요.');
  if (Number(o.formatVersion) > FORMAT_VERSION) throw new Error('더 새로운 버전의 앱에서 만든 캐릭터 파일이에요. 앱을 업데이트해 주세요.');
  const rawRefs = Array.isArray(o.refs) ? o.refs : [];
  if (rawRefs.length > MAX_REFS) throw new Error(`기준 그림이 너무 많아요. (${MAX_REFS}장까지)`);
  const refs = rawRefs.map((r, i) => {
    let buf;
    try { buf = Buffer.from(String((r && r.data) || ''), 'base64'); } catch (_) { buf = Buffer.alloc(0); }
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

class CharacterStore {
  /** @param {string} dir userData/characters */
  constructor(dir) {
    this.dir = dir;
  }

  charDir(id) {
    if (!/^[\w.-]+$/.test(String(id || ''))) throw new Error('잘못된 캐릭터 id');
    return path.join(this.dir, id);
  }

  list() {
    let ents = [];
    try { ents = fs.readdirSync(this.dir, { withFileTypes: true }); } catch (_) { return []; }
    return ents.filter((e) => e.isDirectory())
      .map((e) => this.get(e.name))
      .filter(Boolean)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  /** 저장된 캐릭터 (+ 기준 그림 절대 경로 refsAbs) */
  get(id) {
    let dir;
    try { dir = this.charDir(id); } catch (_) { return null; }
    const raw = readJson(path.join(dir, 'character.json'), null);
    if (!raw) return null;
    const c = normalizeCharacter(raw);
    c.id = id;
    c.refs = c.refs.filter((r) => r.file && fs.existsSync(path.join(dir, r.file)));
    return { ...c, isLocked: !!c.lockedAt, refsAbs: c.refs.map((r) => path.join(dir, r.file)) };
  }

  write(c) {
    const n = normalizeCharacter(c);
    n.updatedAt = Date.now();
    writeJson(path.join(this.charDir(n.id), 'character.json'), n);
    return this.get(n.id);
  }

  /** 새로 만들거나 고치기. 잠긴 캐릭터는 이름·성격만 바꿀 수 있다. */
  save(patch) {
    const cur = patch.id ? this.get(patch.id) : null;
    if (!cur) {
      const c = normalizeCharacter({ ...patch, id: newId(), refs: [], lockedAt: null, version: 1, createdAt: Date.now() });
      if (!c.name) c.name = '새 캐릭터';
      return this.write(c);
    }
    const next = { ...cur };
    for (const k of ['name', 'personality_ko', 'description_ko']) if (patch[k] !== undefined) next[k] = patch[k];
    if (!cur.isLocked) {
      for (const k of ['locked', 'palette', 'rules']) if (patch[k] !== undefined) next[k] = patch[k];
    } else if (['locked', 'palette', 'rules'].some((k) => patch[k] !== undefined && JSON.stringify(normalizeCharacter({ [k]: patch[k] })[k]) !== JSON.stringify(cur[k]))) {
      throw new Error('잠긴 캐릭터예요. 생김새·색·규칙을 바꾸려면 먼저 [잠금 풀기] 를 눌러 주세요.');
    }
    return this.write(next);
  }

  delete(id) {
    const dir = this.charDir(id);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  /** 기준 그림 추가 (PNG/JPEG 는 그대로, 그 밖의 그림은 PNG 로 바꿔서) */
  async addRef(id, file, kind = 'other', label = '') {
    const c = this.get(id);
    if (!c) throw new Error('캐릭터를 찾을 수 없어요.');
    if (c.isLocked) throw new Error('잠긴 캐릭터예요. 기준 그림을 바꾸려면 먼저 [잠금 풀기] 를 눌러 주세요.');
    if (c.refs.length >= MAX_REFS) throw new Error(`기준 그림은 ${MAX_REFS}장까지 넣을 수 있어요.`);
    const dir = path.join(this.charDir(id), 'refs');
    fs.mkdirSync(dir, { recursive: true });
    const k = REF_KINDS.includes(kind) ? kind : 'other';
    const base = `${Date.now().toString(36)}_${k}`;
    let buf = fs.readFileSync(file);
    let mime = sniffImage(buf);
    let dst;
    if (mime) {
      dst = path.join(dir, `${base}${mime === 'image/jpeg' ? '.jpg' : '.png'}`);
      fs.writeFileSync(dst, buf);
    } else {
      dst = path.join(dir, `${base}.png`);
      await runFfmpeg(['-y', '-i', file, '-frames:v', '1', dst]);
      buf = fs.readFileSync(dst);
      mime = sniffImage(buf);
      if (!mime) throw new Error('그림 파일을 읽을 수 없어요.');
    }
    if (buf.length > MAX_REF_BYTES) { fs.unlinkSync(dst); throw new Error('그림 파일이 너무 커요. (12MB 까지)'); }
    c.refs.push({ file: `refs/${path.basename(dst)}`, kind: k, label: cleanText(label, 60) || REF_KIND_LABEL[k], mime });
    return this.write(c);
  }

  removeRef(id, index) {
    const c = this.get(id);
    if (!c) throw new Error('캐릭터를 찾을 수 없어요.');
    if (c.isLocked) throw new Error('잠긴 캐릭터예요. 먼저 [잠금 풀기] 를 눌러 주세요.');
    const r = c.refs[index];
    if (!r) return c;
    try { fs.unlinkSync(path.join(this.charDir(id), r.file)); } catch (_) { /* noop */ }
    c.refs.splice(index, 1);
    return this.write(c);
  }

  lock(id) {
    const c = this.get(id);
    if (!c) throw new Error('캐릭터를 찾을 수 없어요.');
    const errs = validateCharacter(c, { requireRefs: true });
    if (errs.length) throw new Error(`아직 잠글 수 없어요: ${errs.join(' ')}`);
    if (c.isLocked) return c;
    c.lockedAt = Date.now();
    return this.write(c);
  }

  /** 잠금 풀기: 다시 잠그면 버전이 하나 올라간다 (지난 에피소드는 예전 버전을 그대로 기억) */
  unlock(id) {
    const c = this.get(id);
    if (!c) throw new Error('캐릭터를 찾을 수 없어요.');
    if (!c.isLocked) return c;
    c.lockedAt = null;
    c.version += 1;
    return this.write(c);
  }

  /** .amchar 로 내보내기 */
  exportTo(id, outFile) {
    const c = this.get(id);
    if (!c) throw new Error('캐릭터를 찾을 수 없어요.');
    const bufs = c.refsAbs.map((p) => fs.readFileSync(p));
    const data = toAmchar(c, bufs);
    fs.writeFileSync(outFile, JSON.stringify(data, null, 1), 'utf8');
    return outFile;
  }

  /** .amchar 가져오기 (같은 id 가 이미 있으면 새 id 로) */
  importFrom(file) {
    const { character, refs } = fromAmchar(fs.readFileSync(file, 'utf8'));
    const id = character.id && /^[\w.-]+$/.test(character.id) && !this.get(character.id) ? character.id : newId();
    const dir = this.charDir(id);
    fs.mkdirSync(path.join(dir, 'refs'), { recursive: true });
    character.id = id;
    character.refs = refs.map((r, i) => {
      const name = `${String(i + 1).padStart(2, '0')}_${r.kind}${r.mime === 'image/jpeg' ? '.jpg' : '.png'}`;
      fs.writeFileSync(path.join(dir, 'refs', name), r.buffer);
      return { file: `refs/${name}`, kind: r.kind, label: r.label, mime: r.mime };
    });
    return this.write(character);
  }
}

module.exports = {
  FORMAT, FORMAT_VERSION, LOCKED_FIELDS, REF_KINDS, REF_KIND_LABEL, MAX_REFS,
  sniffImage, normalizeHex, normalizeCharacter, validateCharacter, lockedText, paletteText, characterBlock,
  toAmchar, fromAmchar, CharacterStore,
};
