'use strict';
// 시리즈 (에피소드 묶음): 고정 주인공(캐릭터 파일) + 그림체 약속(스타일 바이블) + 에피소드 기록.
// 새 작업 = 시리즈의 새 에피소드. 기획 AI 는 지난 에피소드 요약을 보고 이야기를 이어 간다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DEFAULT_ART_STYLE } = require('./defaults');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  try { fs.renameSync(tmp, file); } catch (_) { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); try { fs.unlinkSync(tmp); } catch (__) { /* noop */ } }
}

function clean(s, max = 1200) {
  return String(s == null ? '' : s).replace(/[ \t]+/g, ' ').trim().slice(0, max);
}

function normalizeEpisode(e) {
  return {
    number: Math.max(1, Math.floor(Number(e.number) || 1)),
    projectId: String(e.projectId || ''),
    title: clean(e.title, 80),
    summary_ko: clean(e.summary_ko, 400),
    madeAt: Number(e.madeAt) || Date.now(),
  };
}

function normalizeSeries(o = {}) {
  const b = o.bible && typeof o.bible === 'object' ? o.bible : {};
  return {
    id: String(o.id || ''),
    name: clean(o.name, 60) || '새 시리즈',
    emoji: clean(o.emoji, 8) || '🌻',
    characterIds: (Array.isArray(o.characterIds) ? o.characterIds : []).map(String).filter(Boolean).slice(0, 4),
    bible: {
      art_en: clean(b.art_en, 800) || DEFAULT_ART_STYLE,
      world_ko: clean(b.world_ko, 800),
      tone_ko: clean(b.tone_ko, 400),
      notes_en: clean(b.notes_en, 800),
    },
    workflowId: String(o.workflowId || ''),
    episodeCounter: Math.max(0, Math.floor(Number(o.episodeCounter) || 0)),
    episodes: (Array.isArray(o.episodes) ? o.episodes : []).map(normalizeEpisode).sort((a, b) => a.number - b.number),
    createdAt: Number(o.createdAt) || Date.now(),
    updatedAt: Number(o.updatedAt) || Date.now(),
  };
}

class SeriesStore {
  /** @param {string} dir userData/series */
  constructor(dir) {
    this.dir = dir;
  }

  file(id) {
    if (!/^[\w.-]+$/.test(String(id || ''))) throw new Error('잘못된 시리즈 id');
    return path.join(this.dir, `${id}.json`);
  }

  list() {
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')); } catch (_) { return []; }
    return files.map((f) => this.get(f.slice(0, -5))).filter(Boolean).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  get(id) {
    let f;
    try { f = this.file(id); } catch (_) { return null; }
    const raw = readJson(f, null);
    if (!raw) return null;
    return { ...normalizeSeries(raw), id };
  }

  save(patch) {
    const cur = patch.id ? this.get(patch.id) : null;
    const id = cur ? cur.id : `ser-${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
    // 에피소드 기록과 번호는 화면에서 덮어쓰지 않는다 (기록 수정은 updateEpisode 로)
    const next = normalizeSeries({ ...(cur || {}), ...patch, id, episodes: cur ? cur.episodes : [], episodeCounter: cur ? cur.episodeCounter : 0 });
    next.updatedAt = Date.now();
    writeJson(this.file(id), next);
    return this.get(id);
  }

  delete(id) {
    try { fs.unlinkSync(this.file(id)); return true; } catch (_) { return false; }
  }

  /** 새 에피소드 번호를 하나 받아 간다 */
  takeEpisodeNumber(id) {
    const s = this.get(id);
    if (!s) throw new Error('시리즈를 찾을 수 없어요.');
    const last = Math.max(s.episodeCounter, ...s.episodes.map((e) => e.number), 0);
    s.episodeCounter = last + 1;
    writeJson(this.file(id), { ...s, updatedAt: Date.now() });
    return s.episodeCounter;
  }

  /** 완성된 에피소드를 기록 (같은 작업이면 덮어씀) */
  recordEpisode(id, ep) {
    const s = this.get(id);
    if (!s) return null;
    const e = normalizeEpisode(ep);
    const i = s.episodes.findIndex((x) => x.projectId === e.projectId || x.number === e.number);
    if (i >= 0) s.episodes[i] = { ...s.episodes[i], ...e };
    else s.episodes.push(e);
    s.episodes.sort((a, b) => a.number - b.number);
    writeJson(this.file(id), { ...s, updatedAt: Date.now() });
    return this.get(id);
  }

  /** 에피소드 요약 고치기 · 지우기 (summary_ko 가 null 이면 삭제) */
  updateEpisode(id, number, patch) {
    const s = this.get(id);
    if (!s) throw new Error('시리즈를 찾을 수 없어요.');
    const i = s.episodes.findIndex((x) => x.number === Number(number));
    if (i < 0) throw new Error('에피소드를 찾을 수 없어요.');
    if (patch === null) s.episodes.splice(i, 1);
    else s.episodes[i] = normalizeEpisode({ ...s.episodes[i], ...patch });
    writeJson(this.file(id), { ...s, updatedAt: Date.now() });
    return this.get(id);
  }
}

module.exports = { SeriesStore, normalizeSeries, normalizeEpisode };
