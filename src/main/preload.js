'use strict';
// 화면(렌더러)에서 쓸 수 있는 기능만 골라서 연결한다.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = async (ch, ...args) => {
  const r = await ipcRenderer.invoke(ch, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

contextBridge.exposeInMainWorld('api', {
  appInfo: () => call('app:info'),
  openPath: (p) => call('sys:openPath', p),
  showItem: (p) => call('sys:showItem', p),
  openExternal: (u) => call('sys:openExternal', u),
  copyText: (t) => call('sys:copyText', t),
  copyImage: (p) => call('sys:copyImage', p),
  pickFile: (o) => call('sys:pickFile', o),
  pickFiles: (o) => call('sys:pickFiles', o),
  pickFolder: () => call('sys:pickFolder'),
  readTextFile: (p) => call('sys:readTextFile', p),
  probeMedia: (p) => call('media:probe', p),
  pathForFile: (file) => (webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(file) : file.path),

  getSettings: () => call('settings:get'),
  saveSettings: (p) => call('settings:save', p),

  listWorkflows: () => call('wf:list'),
  saveWorkflow: (w) => call('wf:save', w),
  deleteWorkflow: (id) => call('wf:delete', id),

  listCharacters: () => call('char:list'),
  getCharacter: (id) => call('char:get', id),
  saveCharacter: (c) => call('char:save', c),
  deleteCharacter: (id) => call('char:delete', id),
  addCharacterRef: (id, file, kind) => call('char:addRef', id, file, kind),
  removeCharacterRef: (id, index) => call('char:removeRef', id, index),
  lockCharacter: (id) => call('char:lock', id),
  unlockCharacter: (id) => call('char:unlock', id),
  exportCharacter: (id) => call('char:export', id),
  importCharacter: () => call('char:import'),
  characterRefPrompt: (id, kind, art) => call('char:refPrompt', id, kind, art),
  generateCharacterRef: (id, kind, art) => call('char:generateRef', id, kind, art),
  describeCharacter: (draft) => call('char:describe', draft),

  listSeries: () => call('series:list'),
  saveSeries: (s) => call('series:save', s),
  deleteSeries: (id) => call('series:delete', id),
  updateEpisode: (id, number, patch) => call('series:updateEpisode', id, number, patch),
  createDemoSeries: () => call('series:createDemo'),

  listProjects: () => call('proj:list'),
  createProject: (o) => call('proj:create', o),
  getProject: (id) => call('proj:get', id),
  runProject: (id, from) => call('proj:run', id, from),
  stopProject: (id) => call('proj:stop', id),
  deleteProject: (id) => call('proj:delete', id),
  provideFile: (id, key, file) => call('proj:provideFile', id, key, file),
  skipWaiting: (id, key) => call('proj:skipWaiting', id, key),
  continueReview: (id) => call('proj:continue', id),
  regenerate: (id, kind, shot, opts) => call('proj:regenerate', id, kind, shot, opts),
  replaceItem: (id, kind, shot, file, drawingId, opts) => call('proj:replace', id, kind, shot, file, drawingId, opts),
  restoreVersion: (id, shot, drawingId, index) => call('proj:restoreVersion', id, shot, drawingId, index),
  regenerateCut: (id, shot) => call('proj:regenerateCut', id, shot),
  setTransition: (id, shot, type) => call('proj:setTransition', id, shot, type),
  setFx: (id, shot, fx) => call('proj:setFx', id, shot, fx),
  previewShot: (id, shot) => call('proj:previewShot', id, shot),
  applyChanges: (id) => call('proj:applyChanges', id),
  setMotion: (id, patch) => call('proj:setMotion', id, patch),
  setSubtitleStyle: (id, style, opts) => call('proj:setSubtitleStyle', id, style, opts),
  setLyricLines: (id, lines) => call('proj:setLyricLines', id, lines),
  saveSubtitles: (id, o) => call('proj:saveSubtitles', id, o),
  retime: (id, shot, index, frames) => call('proj:retime', id, shot, index, frames),
  setCamera: (id, shot, move) => call('proj:setCamera', id, shot, move),
  updatePlan: (id, plan) => call('proj:updatePlan', id, plan),
  updateLyrics: (id, lyrics) => call('proj:updateLyrics', id, lyrics),
  setBpm: (id, bpm) => call('proj:setBpm', id, bpm),
  replaceSong: (id, file) => call('proj:replaceSong', id, file),
  updateLyricsText: (id, raw, filename, opts) => call('proj:updateLyricsText', id, raw, filename, opts),
  readLog: (id) => call('proj:readLog', id),
  setProviders: (id, providers, sites) => call('proj:setProviders', id, providers, sites),

  suggestTopics: (seed, seriesId) => call('ai:suggestTopics', seed, seriesId),
  agentStatus: (id) => call('agent:status', id),
  agentTest: (id) => call('agent:test', id),
  agentLogin: (id) => call('agent:login', id),
  agentInstall: (id) => call('agent:install', id),

  botOpenSite: (site) => call('bot:openSite', site),
  botClose: () => call('bot:close'),
  botIsOpen: () => call('bot:isOpen'),
  botRecipes: () => call('bot:recipes'),
  botSaveRecipes: (j) => call('bot:saveRecipes', j),
  botResetRecipes: () => call('bot:resetRecipes'),

  onProjectUpdate: (cb) => { const f = (_e, d) => cb(d); ipcRenderer.on('project:update', f); return () => ipcRenderer.off('project:update', f); },
  onProjectLog: (cb) => { const f = (_e, d) => cb(d); ipcRenderer.on('project:log', f); return () => ipcRenderer.off('project:log', f); },
});
