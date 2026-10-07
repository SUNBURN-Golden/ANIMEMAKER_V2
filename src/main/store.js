'use strict';
// 설정 · 워크플로우 · 캐릭터 · 시리즈 · 프로젝트(에피소드) 저장소 (모두 내 PC 의 JSON 파일)
const fs = require('fs');
const path = require('path');
const { DEFAULT_SETTINGS, BASE_WORKFLOW, BUILTIN_WORKFLOWS } = require('./defaults');
const { parseLyrics } = require('./media/lyrics');
const { CharacterStore } = require('./characters');
const { SeriesStore } = require('./series');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const text = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (_) {
    // 윈도우에서 백신 등이 파일을 잡고 있으면 이름 바꾸기가 실패할 수 있다 → 직접 쓰기
    fs.writeFileSync(file, text, 'utf8');
    try { fs.unlinkSync(tmp); } catch (__) { /* noop */ }
  }
}

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? deepMerge(base[k], v) : v;
  }
  return out;
}

class Store {
  /**
   * @param {{userDataDir:string, documentsDir:string, downloadsDir:string}} paths
   */
  constructor(paths) {
    this.paths = paths;
    this.settingsFile = path.join(paths.userDataDir, 'settings.json');
    this.workflowsDir = path.join(paths.userDataDir, 'workflows');
    this.recipesFile = path.join(paths.userDataDir, 'recipes.json');
    this.botProfileDir = path.join(paths.userDataDir, 'bot-browser-profile');
    this.characters = new CharacterStore(path.join(paths.userDataDir, 'characters'));
    this.series = new SeriesStore(path.join(paths.userDataDir, 'series'));
  }

  getSettings() {
    return deepMerge(DEFAULT_SETTINGS, readJson(this.settingsFile, {}));
  }

  saveSettings(patch) {
    const next = deepMerge(this.getSettings(), patch || {});
    writeJson(this.settingsFile, next);
    return next;
  }

  projectsDir() {
    const s = this.getSettings();
    const dir = s.projectsDir || path.join(this.paths.documentsDir, 'AnimeMaker V2');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  downloadsDir() {
    const s = this.getSettings();
    return s.downloadsDir || this.paths.downloadsDir;
  }

  // ---- 워크플로우 ----
  listWorkflows() {
    let user = [];
    try {
      user = fs.readdirSync(this.workflowsDir).filter((f) => f.endsWith('.json'))
        .map((f) => readJson(path.join(this.workflowsDir, f), null)).filter(Boolean)
        .map((w) => ({ ...deepMerge(BASE_WORKFLOW, w), builtin: false }));
    } catch (_) { /* 폴더 없음 */ }
    return [...BUILTIN_WORKFLOWS, ...user.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))];
  }

  getWorkflow(id) {
    return this.listWorkflows().find((w) => w.id === id) || BUILTIN_WORKFLOWS[0];
  }

  saveWorkflow(wf) {
    const id = wf.id && !wf.builtin && !String(wf.id).startsWith('builtin-') ? wf.id : `wf-${Date.now().toString(36)}`;
    const data = { ...deepMerge(BASE_WORKFLOW, wf), id, builtin: false, updatedAt: Date.now() };
    writeJson(path.join(this.workflowsDir, `${id}.json`), data);
    return data;
  }

  deleteWorkflow(id) {
    if (String(id).startsWith('builtin-')) return false;
    try { fs.unlinkSync(path.join(this.workflowsDir, `${id}.json`)); return true; } catch (_) { return false; }
  }

  // ---- 프로젝트 (= 시리즈의 에피소드 하나) ----
  /**
   * @param {string} topic 이번 에피소드 이야기 (비어 있어도 됨)
   * @param {object} workflow
   * @param {{songPath?:string, lyricsText?:string, lyricsFilename?:string}} [media] 올린 노래·가사
   * @param {{seriesId?:string}} [opts] 시리즈를 고르면 주인공 캐릭터와 그림체 약속을 그대로 가져온다
   */
  createProject(topic, workflow, media = {}, opts = {}) {
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const series = opts.seriesId ? this.series.get(opts.seriesId) : null;
    if (opts.seriesId && !series) throw new Error('시리즈를 찾을 수 없어요.');
    if (series) this.checkSeriesReady(series);
    const songName = media.songPath ? path.basename(media.songPath, path.extname(media.songPath)) : '';
    const label = topic || songName || (series ? series.name : '') || '뮤직비디오';
    const slug = label.replace(/[\\/:*?"<>|\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 24).trim() || 'project';
    const id = `${stamp} ${slug}`;
    const dir = path.join(this.projectsDir(), id);
    fs.mkdirSync(dir, { recursive: true });
    const s = this.getSettings();
    const project = {
      id,
      title: label.slice(0, 40),
      topic,
      lyricsInput: parseLyrics(media.lyricsText || '', media.lyricsFilename),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      workflow: { ...workflow },
      providers: { ...s.providers },
      helperSites: { ...s.helperSites },
      series: series ? this.seriesSnapshot(series, dir) : null,
      status: 'idle',
      steps: {},
    };
    if (project.series) project.title = `${project.series.name} EP${project.series.episode}`;
    if (media.songPath) {
      fs.mkdirSync(path.join(dir, 'music'), { recursive: true });
      const ext = path.extname(media.songPath).toLowerCase() || '.mp3';
      fs.copyFileSync(media.songPath, path.join(dir, 'music', `song${ext}`));
      project.song = { file: `music/song${ext}`, name: path.basename(media.songPath) };
    }
    writeJson(path.join(dir, 'project.json'), project);
    return project;
  }

  /** 에피소드를 시작할 수 있는 시리즈인지 (주인공이 있고 모두 잠겨 있어야 한다) */
  checkSeriesReady(series) {
    const chars = series.characterIds.map((cid) => this.characters.get(cid)).filter(Boolean);
    if (!chars.length) throw new Error('이 시리즈에 주인공 캐릭터가 없어요. [시리즈] 화면에서 캐릭터를 넣어 주세요.');
    const open = chars.filter((c) => !c.isLocked);
    if (open.length) throw new Error(`캐릭터 "${open.map((c) => c.name).join(', ')}" 가 아직 잠기지 않았어요. [캐릭터] 화면에서 기준 그림을 확인하고 [🔒 잠그기] 를 눌러 주세요.`);
    return chars;
  }

  /**
   * 에피소드가 쓸 시리즈 정보를 작업 폴더에 '얼려' 둔다.
   * 캐릭터 기준 그림도 복사해 두어서, 나중에 캐릭터를 고쳐도 이 에피소드는 그대로 다시 만들 수 있다.
   */
  seriesSnapshot(series, dir) {
    const chars = this.checkSeriesReady(series);
    const episode = this.series.takeEpisodeNumber(series.id);
    const characters = chars.map((c, i) => {
      const rel = `refs/characters/${c.id}`;
      fs.mkdirSync(path.join(dir, rel), { recursive: true });
      const refs = c.refs.map((r, k) => {
        const name = `${k + 1}_${r.kind}${path.extname(r.file) || '.png'}`;
        fs.copyFileSync(c.refsAbs[k], path.join(dir, rel, name));
        return { kind: r.kind, label: r.label, file: `${rel}/${name}` };
      });
      return {
        id: c.id, name: c.name, role: i === 0 ? 'protagonist' : 'main', version: c.version,
        locked: c.locked, palette: c.palette, rules: c.rules, personality_ko: c.personality_ko, refs,
      };
    });
    return {
      id: series.id, name: series.name, emoji: series.emoji, episode,
      bible: series.bible, characters,
      previous: series.episodes.slice(-6).map((e) => ({ number: e.number, title: e.title, summary_ko: e.summary_ko })),
    };
  }

  projectDir(id) {
    return path.join(this.projectsDir(), id);
  }

  loadProject(id) {
    return readJson(path.join(this.projectDir(id), 'project.json'), null);
  }

  saveProject(p) {
    p.updatedAt = Date.now();
    writeJson(path.join(this.projectDir(p.id), 'project.json'), p);
  }

  listProjects() {
    const dir = this.projectsDir();
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
    return ents.filter((e) => e.isDirectory())
      .map((e) => readJson(path.join(dir, e.name, 'project.json'), null))
      .filter(Boolean)
      .map((p) => ({
        id: p.id, title: (p.plan && p.plan.title) || p.title, topic: p.topic, status: p.status,
        updatedAt: p.updatedAt, createdAt: p.createdAt, workflowName: p.workflow && p.workflow.name,
        series: p.series ? { id: p.series.id, name: p.series.name, emoji: p.series.emoji, episode: p.series.episode } : null,
        thumb: p.drawings && p.drawings.find((k) => k.file) ? path.join(dir, p.id, p.drawings.find((k) => k.file).file) : null,
        final: p.output && p.output.video ? path.join(dir, p.id, p.output.video) : null,
      }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  deleteProject(id) {
    const dir = this.projectDir(id);
    if (!dir.startsWith(this.projectsDir())) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }
}

module.exports = { Store, readJson, writeJson, deepMerge };
