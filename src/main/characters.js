'use strict';
// 캐릭터 파일 (.amchar): 주인공을 '아주 단단한 기준' 으로 고정하기 위한 휴대용 파일.
//  - JSON 하나 안에 고정 설명(영어) · 색 팔레트 · 지켜야 할 규칙 · 기준 그림(base64 PNG/JPEG)을 모두 담는다.
//    (zip 같은 새 의존성 없이 메모장으로도 열어 볼 수 있다)
//  - 앱 안에서는 userData/characters/<id>/ 폴더에 character.json + refs/*.png 로 풀어서 보관한다.
//  - '잠그기(lock)' 를 하면 설명·색·규칙·기준 그림을 바꿀 수 없다. 모든 에피소드가 같은 주인공을 쓰게 하기 위해서다.
//  - 순수 계산(normalizeCharacter, validateCharacter, characterBlock, toAmchar, fromAmchar …)은 characters-core.js 로 옮겨
//    폰 앱·프롬프트 조립(pipeline/prompts.js)과 같은 파일을 쓴다. 여기서는 그 이름을 그대로 다시 내보내므로
//    `require('./characters')` 는 예전과 똑같이 쓸 수 있다.
//  - 여기에 남은 것: CharacterStore (userData/characters 폴더 읽고 쓰기 · ffmpeg 로 기준 그림을 PNG 로 바꾸기)와
//    fromAmchar 의 Buffer 어댑터 (PC 쪽 호출자는 기준 그림을 예전처럼 Buffer 로 받는다).
const fs = require('fs');
const path = require('path');
const { runFfmpeg } = require('./media/ffmpeg');
const core = require('./characters-core');

const { REF_KINDS, REF_KIND_LABEL, MAX_REFS, MAX_REF_BYTES, sniffImage, cleanText, newId, normalizeCharacter, validateCharacter, toAmchar } = core;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  try { fs.renameSync(tmp, file); } catch (_) { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); try { fs.unlinkSync(tmp); } catch (__) { /* noop */ } }
}

/** .amchar 내용 → { character, refs: [{kind,label,mime,buffer}] }: characters-core 의 fromAmchar 와 같고, buffer 만 Node Buffer 로 (복사 없이 감싼다) */
function fromAmchar(input) {
  const out = core.fromAmchar(input);
  return { ...out, refs: out.refs.map((r) => ({ ...r, buffer: Buffer.from(r.buffer.buffer, r.buffer.byteOffset, r.buffer.byteLength) })) };
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

module.exports = { ...core, fromAmchar, CharacterStore };
