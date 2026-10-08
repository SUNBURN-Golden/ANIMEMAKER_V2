// 엔진 Node 시험에서 같이 쓰는 도구 (시험 파일이 아니다: 이름이 .test.js 로 끝나지 않는다)
//  - 진짜 db.js 를 fake-indexeddb 위에서 쓴다
//  - native / services 는 가짜: 노래는 {seconds,bpm} 글자를 담은 Blob(분석은 진짜 audio-analysis 로), 그림은 'IMG:…' 글자를 담은 Blob
import 'fake-indexeddb/auto';
import { createRequire } from 'node:module';
import * as db from '../src/db.js';
import { createEngine } from '../src/engine/index.js';
import { demoSongSamples } from '../src/engine/render/demo-canvas.js';
import { makeSrt, makeLrc } from '../src/engine/render/burn.js';

const require = createRequire(import.meta.url);
const A = require('../../src/main/media/audio-analysis.js');

export { db };

const cache = new Map();
/** 진짜 박자 분석 (같은 노래는 한 번만 계산) */
export function analyzeFake(seconds, bpm, priorBpm = null) {
  const k = `${seconds}/${bpm}/${priorBpm}`;
  if (!cache.has(k)) cache.set(k, A.analyzeSamples(demoSongSamples({ seconds, bpm }).samples, priorBpm));
  return structuredClone(cache.get(k));
}

export const songBlob = (seconds = 60, bpm = 120) => new Blob([JSON.stringify({ seconds, bpm })], { type: 'audio/wav' });
export const imgBlob = (label = 'x', type = 'image/png') => new Blob([`IMG:${label}`], { type });

export function fakeNative() {
  const sent = [];
  const acked = [];
  const n = {
    sent, acked, inbox: [], service: [], keep: [],
    AI_APPS: {
      chatgpt: { name: 'ChatGPT', pkg: 'com.openai.chatgpt', url: 'x', good: ['text', 'image'] },
      gemini: { name: 'Gemini', pkg: 'com.google.android.apps.bard', url: 'x', good: ['text', 'image'] },
      claude: { name: 'Claude', pkg: 'com.anthropic.claude', url: 'x', good: ['text'] },
    },
    async sendToApp(appId, o) { sent.push({ appId, ...o }); return { direct: true }; },
    async takeInbox() { return n.inbox.filter((e) => !acked.includes(e.id)); },
    async ackInbox(ids) { acked.push(...ids); return ids.length; },
    onShared(cb) { n._cb = cb; Promise.resolve().then(() => n.inbox.forEach((e) => cb(e))); return () => { n._cb = null; }; },
    async sharedItemToBlob(item) { return item.blob; },
    async startJobService(o) { n.service.push(['start', o.title]); return { started: true, notifications: true }; },
    async updateJobService() {},
    async stopJobService() { n.service.push(['stop']); },
    async keepAwake(on) { n.keep.push(on); },
  };
  return n;
}

/** 가짜 services: 필요한 곳만 바꿔 쓴다 */
export function fakeServices(over = {}) {
  const calls = { ingest: [], plate: 0, analyze: 0, priors: [], exports: [], burns: [], decode: 0, compositors: [] };
  const sv = {
    calls,
    async analyzeSong(blob, { priorBpm } = {}) {
      calls.analyze++;
      calls.priors.push(priorBpm == null ? null : priorBpm);
      const { seconds, bpm } = JSON.parse(await blob.text());
      return analyzeFake(seconds, bpm, priorBpm);
    },
    async decodeSong() { calls.decode++; return { duration: 60, sampleRate: 48000, numberOfChannels: 2 }; },
    async ingest(blob, o = {}) {
      calls.ingest.push({ kind: o.kind, refStats: o.refStats || null, keyColor: o.keyColor, skipOrig: !!o.skipOrig });
      if (o.signal && o.signal.aborted) throw Object.assign(new Error('멈춤'), { name: 'AbortError' });
      const text = await blob.text();
      if (text.includes('BAD')) throw Object.assign(new Error('그림 파일을 읽지 못했어요. 다른 파일로 해 보세요.'), { code: 'badImage' });
      const out = { w: 120, h: 80, orig: o.skipOrig ? undefined : new Blob([`ORIG:${text}`], { type: 'image/webp' }), keyed: null };
      if (o.kind === 'cel') {
        out.keyed = !text.includes('NOKEY');
        if (out.keyed) Object.assign(out, { cel: new Blob([`CEL:${text}`], { type: 'image/webp' }), source: '#00ff00', stats: { mean: [10, 20, 30], std: [5, 5, 5], n: 100 } });
        else out.reason = 'notkey';
      }
      return out;
    },
    async plate(cel) { calls.plate++; return new Blob([`PLATE:${await cel.text()}`], { type: 'image/png' }); },
    async decodeImage(blob, { premultiply } = {}) { return { token: await blob.text(), premultiply: !!premultiply, close() {} }; },
    async placeholder({ label }) { return { placeholder: label, close() {} }; },
    demo: {
      async bg({ shot }) { return imgBlob(`bg${shot}`); },
      async cel({ shot, index }) { return imgBlob(`cel${shot}_${index}`); },
      async drawing({ shot, index }) { return imgBlob(`full${shot}_${index}`); },
      async ref() { return imgBlob('ref'); },
      async song({ seconds = 60, bpm = 120 } = {}) { return songBlob(seconds, bpm); },
    },
    render: {
      createCompositor(o) { const c = { ...o, totalFrames: o.xs.totalFrames, released: false, release() { this.released = true; } }; calls.compositors.push(c); return c; },
      async exportClean({ compositor, audio, onProgress, signal }) {
        const shots = [];
        const n = compositor.xs.shots.length;
        for (let i = 0; i < n; i++) {
          if (signal && signal.aborted) { compositor.release(); throw Object.assign(new Error('영상 만들기를 멈췄어요'), { name: 'AbortError' }); }
          shots.push(await compositor.materials.shot(i));
          if (onProgress) onProgress({ stage: 'video', frame: Math.round(((i + 1) / n) * compositor.totalFrames), total: compositor.totalFrames, fraction: (i + 1) / n, etaMs: 0, fps: 24 });
          if (over.exportDelay) await new Promise((r) => setTimeout(r, over.exportDelay));
        }
        compositor.release();
        const rec = { compositor, audio, shots };
        calls.exports.push(rec);
        return { blob: new Blob([`MP4CLEAN:${compositor.totalFrames}`], { type: 'video/mp4' }), codecs: { video: 'vp9', audio: audio ? 'opus' : null }, seconds: compositor.totalFrames / 24, frames: compositor.totalFrames, bytes: 20, mime: 'video/mp4', ms: 5, msPerFrame: 1, fallback: { video: true, audio: !!audio }, probe: {}, reusedFrames: 0, audioDropped: false };
      },
      async burnSubtitles({ clean, lines, style, W, H, signal }) {
        calls.burns.push({ lines, style, W, H });
        if (signal && signal.aborted) throw Object.assign(new Error('멈춤'), { name: 'AbortError' });
        if (!style.enabled || !lines.length) return { blob: clean, codecs: {}, burned: false, subsFallback: false };
        return { blob: new Blob([`MP4FINAL:${lines.length}`], { type: 'video/mp4' }), codecs: { video: 'vp9' }, burned: true, subsFallback: false, seconds: 1, ms: 1, probe: {} };
      },
      makeSrt, makeLrc,
    },
    ...over,
  };
  return sv;
}

/** 새 엔진 (같은 저장소를 쓰는 엔진을 여러 번 만들면 앱 재시작을 흉내 낼 수 있다) */
export function newEngine({ native = fakeNative(), services = fakeServices(), probe = null, now } = {}) {
  const engine = createEngine({ db, native, probe, now: now || (() => Date.now()), services });
  return { engine, native, services };
}

export async function resetDb() {
  await db.deleteDatabase();
}

/** 연습 프로젝트를 만들고 끝까지 돌린다 (가짜 services) */
export async function demoEpisode(engine, o = {}) {
  const id = await engine.projects.create({ workflow: 'demo', aspect: '9:16', ...o });
  await engine.demo.fill(id);
  return id;
}

// ───────────────────────── AI 앱 모드 진행 도우미 ─────────────────────────
import { buildXsheetContext } from '../src/engine/workflows.js';
const DD = createRequire(import.meta.url)('../../src/main/ai/demo-data.js');
export { DD };

/** AI 앱 모드 작품 (글 답장은 연습 답장으로, 그림은 직접 받는다) */
export async function aiProject(engine, o = {}) {
  return engine.projects.create({
    workflow: 'phone-lite', aspect: '9:16', songBlob: songBlob(60), songName: 'song.wav', topic: '비 오는 날',
    lyricsText: '[Verse 1]\n작은 불빛 하나 따라\n낯선 길을 걸어가\n[Chorus]\n날아올라 저 하늘로\n멈추지 마 지금 이대로\n[Outro]\n안녕 안녕',
    providers: { text: 'chatgpt', image: 'chatgpt' }, ...o,
  });
}

/** 이야기·가사 확인·그림 순서표를 연습 답장으로 채우고 '그림 수 확인' 카드까지 간다. fallback:true 면 순서표는 AI 없이 폰이 짠다 */
export async function driveToDrawings(engine, id, { fallback = false, approve = true } = {}) {
  await engine.run(id);
  for (let i = 0; i < 12; i++) {
    const rt = await engine._runtime(id);
    const w = rt.p.waiting;
    if (!w || rt.p.status !== 'waiting') break;
    if (w.key === 'handoff:plan') {
      const req = await engine.handoff.request(id);
      const r = await engine.handoff.acceptText(id, JSON.stringify({ ...DD.demoPlan('주제', rt.wf, rt.series), request_id: req.nonce }));
      if (!r.ok) throw new Error(r.message);
    } else if (w.key === 'review:lyrics') {
      await engine.continueReview(id);
    } else if (w.key === 'handoff:xsheet') {
      if (fallback) await engine.skipWaiting(id, 'xsheet');
      else {
        const req = await engine.handoff.request(id);
        const r = await engine.handoff.acceptText(id, JSON.stringify({ ...DD.demoXsheet(buildXsheetContext(rt.p, rt.series)), request_id: req.nonce }));
        if (!r.ok) throw new Error(r.message);
      }
    } else if (w.key === 'review:drawings') {
      if (!approve) break;
      await engine.continueReview(id);
    } else break;
    await engine.whenIdle(id);
  }
  return engine.projects.get(id);
}
