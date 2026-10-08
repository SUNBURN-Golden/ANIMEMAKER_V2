// 만들기 엔진 진짜 브라우저 시험용 도구 (test/e2e-engine.test.js 가 Chromium 안에서 부른다). 앱 번들에는 들어가지 않는다.
// 진짜 db.js(IndexedDB) · 진짜 services(배경 빼기 일꾼 · 영상 엔진 · 연습 그림) 를 쓰고, native 만 가짜다.
import * as db from '../../src/db.js';
import * as jobs from '../../src/jobs.js';
import { createEngine } from '../../src/engine/index.js';
import { createIngestor } from '../../src/engine/ingest.js';
import { demoPicture } from '../../src/engine/pipeline.js';
import { buildXsheetContext } from '../../src/engine/workflows.js';
import { DD } from '../../src/engine/shared.js';
import { demoSong, demoCel, demoBg } from '../../src/engine/render/index.js';
import { Input, BlobSource, ALL_FORMATS, CanvasSink, EncodedPacketSink } from 'mediabunny';

const H = {};
window.H = H;
H.db = db;
H.jobs = jobs;
H.E = {};
H.blobs = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
H.sleep = sleep;

function fakeNative(inbox = []) {
  const n = {
    acked: [], sent: [], service: [], clip: '',
    AI_APPS: {
      chatgpt: { name: 'ChatGPT', pkg: 'com.openai.chatgpt', url: 'x', good: ['text', 'image'] },
      gemini: { name: 'Gemini', pkg: 'com.google.android.apps.bard', url: 'x', good: ['text', 'image'] },
      claude: { name: 'Claude', pkg: 'com.anthropic.claude', url: 'x', good: ['text'] },
    },
    async sendToApp(appId, o) { n.sent.push({ appId, text: o.text, files: (o.files || []).length }); n.clip = o.text; return { direct: true }; },
    async readClipboard() { return n.clip; },
    async takeInbox() { return inbox.filter((e) => !n.acked.includes(e.id)); },
    async ackInbox(ids) { n.acked.push(...ids); return ids.length; },
    onShared(cb) { Promise.resolve().then(() => inbox.forEach((e) => cb(e))); return () => {}; },
    async sharedItemToBlob(item) { return item.blob; },
    async startJobService(o) { n.service.push('start:' + o.title); return { started: true, notifications: true }; },
    async updateJobService() {},
    async stopJobService() { n.service.push('stop'); },
    async keepAwake() {},
  };
  return n;
}

/** 새 엔진 (같은 저장소를 쓴다: 페이지를 새로 읽으면 앱 프로세스가 죽었다 켜진 것) */
H.engine = (name = 'main', { inbox = [] } = {}) => {
  const native = fakeNative(inbox);
  const engine = createEngine({ db, native });
  H.E[name] = { engine, native };
  return true;
};
H.eng = (name = 'main') => H.E[name].engine;

H.fullEpisode = async ({ aspect, seconds, quality, name = 'main', lyrics = DD.DEMO_LYRICS, keep = 'ep' }) => {
  const engine = H.eng(name);
  const t0 = performance.now();
  const id = await engine.projects.create({ workflow: 'demo', aspect, quality, songBlob: await demoSong({ seconds, bpm: 120 }), songName: '연습.wav', lyricsText: lyrics });
  const snap = await engine.demo.fill(id);
  H.blobs[`${keep}.final`] = await engine.render.output(id, 'video');
  H.blobs[`${keep}.clean`] = await engine.render.output(id, 'clean');
  const steps = Object.fromEntries(snap.stepOrder.map((s) => [s, snap.steps[s].status]));
  return {
    id, ms: Math.round(performance.now() - t0), status: snap.status, steps, totalFrames: snap.xsheet.totalFrames, outSize: snap.outSize, output: snap.output,
    lines: snap.timing.lyrics.filter((l) => !l.hidden).map((l) => ({ start: l.start, end: l.end, text: l.text })),
    items: snap.drawings.length, keyed: snap.drawings.filter((d) => d.keyed === true).length, unkeyed: snap.drawings.filter((d) => d.keyed === false).length,
    ingestMode: engine.services.ingestMode(), finalSize: H.blobs[`${keep}.final`].size, cleanSize: H.blobs[`${keep}.clean`].size,
    srt: await (await engine.render.output(id, 'srt')).text(), lrc: await (await engine.render.output(id, 'lrc')).text(),
    tracks: snap.xsheet.shots.length, subsFallback: snap.subsFallback,
  };
};

H.readVideo = async (name) => {
  const input = new Input({ source: new BlobSource(H.blobs[name]), formats: ALL_FORMATS });
  const v = await input.getPrimaryVideoTrack();
  const a = await input.getPrimaryAudioTrack();
  const vs = await v.computePacketStats();
  const tags = await input.getMetadataTags();
  const out = { vcodec: await v.getCodec(), w: await v.getDisplayWidth(), h: await v.getDisplayHeight(), packets: vs.packetCount, vdur: await v.computeDuration(), tags: { comment: tags.comment, description: tags.description }, size: H.blobs[name].size };
  if (a) {
    out.acodec = await a.getCodec();
    out.sr = await a.getSampleRate();
    out.adur = await a.computeDuration();
    let bytes = 0;
    for await (const p of new EncodedPacketSink(a).packets()) bytes += p.byteLength;
    out.abytes = bytes;
  }
  if (input.dispose) input.dispose();
  return out;
};

async function grab(name, t) {
  const input = new Input({ source: new BlobSource(H.blobs[name]), formats: ALL_FORMATS });
  const v = await input.getPrimaryVideoTrack();
  const wc = await new CanvasSink(v, { poolSize: 1 }).getCanvas(t);
  const c = wc.canvas;
  const img = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  if (input.dispose) input.dispose();
  return { img, canvas: c };
}

/** 두 영상의 같은 시각 장을 비교: thr 보다 많이 다른 곳의 바깥 상자와 개수, 전체 평균 차이 */
H.diffFrames = async (a, b, t, thr = 40) => {
  const A = (await grab(a, t)).img;
  const B = (await grab(b, t)).img;
  let x0 = 1e9; let y0 = 1e9; let x1 = -1; let y1 = -1; let count = 0; let sum = 0;
  const rows = new Int32Array(A.height); const cols = new Int32Array(A.width);
  for (let y = 0; y < A.height; y++) {
    for (let x = 0; x < A.width; x++) {
      const i = (y * A.width + x) * 4;
      const d = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]));
      sum += d;
      if (d > thr) { count++; rows[y]++; cols[x]++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  // core: 다시 인코딩한 잡음(H.264 는 먼 곳에도 흩어져 생긴다)은 빼고, 글씨처럼 촘촘히 달라진 줄·칸만으로 잰 상자
  let core = null;
  if (count) {
    const maxR = Math.max(...rows); const maxC = Math.max(...cols);
    const rMin = Math.max(6, maxR * 0.2); const cMin = Math.max(4, maxC * 0.2);
    let cy0 = -1; let cy1 = -1; let cx0 = -1; let cx1 = -1;
    for (let y = 0; y < A.height; y++) if (rows[y] >= rMin) { if (cy0 < 0) cy0 = y; cy1 = y; }
    for (let x = 0; x < A.width; x++) if (cols[x] >= cMin) { if (cx0 < 0) cx0 = x; cx1 = x; }
    if (cy0 >= 0 && cx0 >= 0) core = { x0: cx0, y0: cy0, x1: cx1, y1: cy1 };
  }
  return { w: A.width, h: A.height, count, bbox: count ? { x0, y0, x1, y1 } : null, core, mean: sum / (A.width * A.height) };
};

H.framePng = async (name, t) => {
  const { canvas } = await grab(name, t);
  const c = document.createElement('canvas');
  c.width = canvas.width; c.height = canvas.height;
  c.getContext('2d').drawImage(canvas, 0, 0);
  const url = c.toDataURL('image/png');
  return url.slice(url.indexOf(',') + 1);
};

const b64 = async (blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const rgbaOf = async (blob, premultiplyAlpha = 'none') => {
  const bmp = await createImageBitmap(blob, { premultiplyAlpha });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  const img = g.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return img;
};

/** 저장된 그림 한 장의 모양 (배경 뺀 셀의 알파 · 원본 크기) */
H.pictureInfo = async (name, id, key) => {
  const engine = H.eng(name);
  const s = await engine.projects.get(id);
  const d = s.drawings.find((x) => x.key === key);
  const pic = await engine.drawings.blob(id, key, 'current');
  const out = { status: d.status, keyed: d.keyed, picType: pic && pic.type, history: d.history.length };
  if (pic) { const bmp = await createImageBitmap(pic); out.w = bmp.width; out.h = bmp.height; bmp.close(); }
  const cel = await engine.drawings.blob(id, key, 'cel');
  if (cel) {
    const img = await rgbaOf(cel);
    const at = (x, y) => img.data[(y * img.width + x) * 4 + 3];
    out.cel = { type: cel.type, w: img.width, h: img.height, corners: [at(0, 0), at(img.width - 1, 0), at(0, img.height - 1), at(img.width - 1, img.height - 1)], centerAlpha: at(img.width >> 1, img.height >> 1) };
    let opaque = 0;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i] === 255) opaque++;
    out.cel.opaqueFraction = opaque / (img.width * img.height);
  }
  return out;
};

/** 배경 빼기 일꾼 vs PC 계산: 같은 그림을 일꾼에 보내고, 브라우저가 읽은 RGBA 와 일꾼 결과(알파·RGB·해시·통계)를 돌려준다 */
H.keyParity = async ({ keyColor, W, H: Hh, soft = false }) => {
  let blob = await demoCel({ W, H: Hh, shot: 2, index: 1, count: 3, highlight: false, motion: false, keyColor, palette: DD.DEMO_CHARACTER.palette });
  if (soft) {
    // 안티앨리어싱처럼 가장자리를 흐리게: 배경과 몸이 섞인 반투명 가장자리가 생긴다 (진짜 AI 그림에 가깝다)
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(W, Hh);
    const g = c.getContext('2d');
    g.fillStyle = keyColor;
    g.fillRect(0, 0, W, Hh);
    g.filter = 'blur(1.6px)';
    g.drawImage(bmp, 0, 0);
    blob = await c.convertToBlob({ type: 'image/png' });
  }
  const input = await rgbaOf(blob);
  const ing = createIngestor({ workerUrl: 'key.worker.js' });
  const r = await ing.ingest(blob, { kind: 'cel', keyColor, wantHash: true });
  const cel = await rgbaOf(r.cel);
  const plate = await ing.plate(r.cel, keyColor);
  const plateImg = await rgbaOf(plate);
  const out = {
    mode: ing.mode, w: r.w, h: r.h, keyed: r.keyed, source: r.source, stats: r.stats, hash: r.hash, origType: r.orig.type, celType: r.cel.type,
    inputB64: await b64(new Blob([input.data])), celB64: await b64(new Blob([cel.data])), plateB64: await b64(new Blob([plateImg.data])), pngB64: await b64(blob),
  };
  ing.dispose();
  return out;
};

/** 1536×864 그림 하나를 일꾼에서 정리하는 데 걸리는 시간 (ms): 읽기 + 배경 빼기 + 원본·셀 인코딩 */
H.keyTiming = async () => {
  const blob = await demoCel({ W: 1536, H: 864, shot: 3, index: 1, count: 3, highlight: false, motion: false, keyColor: '#00ff00', palette: DD.DEMO_CHARACTER.palette });
  const ing = createIngestor({ workerUrl: 'key.worker.js' });
  await ing.ingest(blob, { kind: 'cel', keyColor: '#00ff00' }); // 일꾼을 깨운다
  const ms = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    await ing.ingest(blob, { kind: 'cel', keyColor: '#00ff00' });
    ms.push(Math.round(performance.now() - t0));
  }
  const t1 = performance.now();
  await ing.ingest(blob, { kind: 'pic' });
  const pic = Math.round(performance.now() - t1);
  const t2 = performance.now();
  const r = await ing.ingest(blob, { kind: 'cel', keyColor: '#00ff00' });
  await ing.plate(r.cel, '#00ff00');
  const plate = Math.round(performance.now() - t2) - ms[2];
  ing.dispose();
  return { cel: ms, pic, plate };
};

/** 큰 그림은 1536px 로 줄여서 저장한다 */
H.bigImage = async () => {
  const c = new OffscreenCanvas(3000, 1800);
  const g = c.getContext('2d');
  g.fillStyle = '#4a90d9';
  g.fillRect(0, 0, 3000, 1800);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const ing = createIngestor({ workerUrl: 'key.worker.js' });
  const r = await ing.ingest(blob, { kind: 'pic' });
  ing.dispose();
  return { w: r.w, h: r.h, origType: r.orig.type, size: r.orig.size, inSize: blob.size };
};

// ───────────────────────── AI 앱 모드 ─────────────────────────
H.aiProject = async (name, { aspect = '9:16', seconds = 10, quality = '480p' } = {}) => {
  const engine = H.eng(name);
  return engine.projects.create({
    workflow: 'phone-lite', aspect, quality, songBlob: await demoSong({ seconds, bpm: 120 }), songName: '노래.wav', topic: '비 오는 날', lyricsText: DD.DEMO_LYRICS,
    providers: { text: 'chatgpt', image: 'chatgpt' },
  });
};

/** 이야기 · 가사 확인 · 그림 순서표를 연습 답장으로 채워서 그림을 기다리는 곳까지 */
H.drive = async (name, id) => {
  const engine = H.eng(name);
  await engine.run(id);
  for (let i = 0; i < 12; i++) {
    const rt = await engine._runtime(id);
    const w = rt.p.waiting;
    if (!w || rt.p.status !== 'waiting') break;
    if (w.key === 'handoff:plan') {
      const req = await engine.handoff.request(id);
      const r = await engine.handoff.acceptText(id, JSON.stringify({ ...DD.demoPlan('주제', rt.wf, rt.series), request_id: req.nonce }));
      if (!r.ok) throw new Error(r.message);
    } else if (w.key === 'review:lyrics' || w.key === 'review:drawings') {
      await engine.continueReview(id);
    } else if (w.key === 'handoff:xsheet') {
      const req = await engine.handoff.request(id);
      const r = await engine.handoff.acceptText(id, JSON.stringify({ ...DD.demoXsheet(buildXsheetContext(rt.p, rt.series)), request_id: req.nonce }));
      if (!r.ok) throw new Error(r.message);
    } else break;
    await engine.whenIdle(id);
  }
  const snap = await engine.projects.get(id);
  return { status: snap.status, waiting: snap.waiting && snap.waiting.key, nextKey: snap.nextKey, queue: snap.queue.map((q) => q.key), total: snap.work.total };
};

H.pictureFor = async (name, id, key) => {
  const engine = H.eng(name);
  const rt = await engine._runtime(id);
  return demoPicture(rt, rt.drawings.get(key));
};

H.coldBlob = async ({ kind, shot, W, H: Hh }) => (kind === 'bg' ? demoBg({ W, H: Hh, shot }) : demoCel({ W, H: Hh, shot, index: 0, count: 2, highlight: false, motion: false, keyColor: '#00ff00', palette: DD.DEMO_CHARACTER.palette }));

H.untilDone = async (name, id, key, ms = 15000) => {
  const t0 = performance.now();
  for (;;) {
    const s = await H.eng(name).projects.get(id);
    const d = s.drawings.find((x) => x.key === key);
    if (d && d.status === 'done') return true;
    if (performance.now() - t0 > ms) return false;
    await sleep(30);
  }
};

H.guardBackDuringRender = async ({ name = 'main', id, choice }) => {
  const engine = H.eng(name);
  // 느린 러너(CI)에서는 '영상 만들기' 단계에 닿기까지 오래 걸릴 수 있다: 시간 제한은 넉넉히, 그리고 실제로 지킴이가 붙든 일이 보일 때까지 기다린다
  const until = Date.now() + 180000;
  for (;;) {
    const s = engine.projects.peek(id);
    if (s && s.currentStep === 'render' && s.status === 'running' && jobs.listJobs().some((j) => j.modal)) break;
    if (Date.now() > until) break;
    await sleep(5);
  }
  const g = await jobs.guardBack({ ask: async () => choice === 'stop' });
  return g;
};

H.encoders = () => window.__enc.map((e) => e.state);

/** 연습 에피소드를 만들고 끝까지 채우기를 시작만 한다 (기다리지 않는다) → H.finishFill() 로 결과를 받는다 */
H.startEpisode = async ({ name = 'main', aspect, seconds, quality }) => {
  const engine = H.eng(name);
  const id = await engine.projects.create({ workflow: 'demo', aspect, quality, songBlob: await demoSong({ seconds, bpm: 120 }), songName: '연습.wav', lyricsText: DD.DEMO_LYRICS });
  H.pending = engine.demo.fill(id).then((s) => ({ ok: true, status: s.status }), (e) => ({ ok: false, error: e.name, message: e.message }));
  return id;
};
H.finishFill = () => H.pending;

H.listProjects = (name = 'main') => H.eng(name).projects.list();
H.outputSize = async (name, id) => { const b = await H.eng(name).render.output(id, 'video'); return b ? b.size : 0; };
H.dbStats = async () => ({ inbox: (await db.listInbox()).length, inboxFiles: (await db.listFileKeys('inbox/')).length });

H.place = async (name, id, keys) => {
  const e = H.eng(name);
  const files = [];
  for (const k of keys) files.push({ name: `${k}.png`, mime: 'image/png', blob: await H.pictureFor(name, id, k) });
  const r = await e.handoff.acceptFiles(id, files, { slotKey: keys[0] });
  return { placed: r.placed.map((p) => ({ key: p.key, keyed: p.keyed })), failed: r.failed.length, pending: r.pending.length };
};

/** 클립보드에 남은 부탁 글을 답장으로 붙여넣으면 거절된다 (D3) */
H.echo = async (name, id) => {
  const e = H.eng(name);
  const req = await e.handoff.request(id);
  await e.handoff.send(id, 'chatgpt');
  const clip = await H.E[name].native.readClipboard();
  const echo = await e.handoff.acceptText(id, clip);
  const rt = await e._runtime(id);
  const plan = DD.demoPlan('t', rt.wf, null);
  const noNonce = await e.handoff.acceptText(id, JSON.stringify(plan));
  const stale = await e.handoff.acceptText(id, JSON.stringify({ ...plan, request_id: 'ffffffffffffffff' }));
  const before = (await e.projects.get(id)).plan;
  const ok = await e.handoff.acceptText(id, JSON.stringify({ ...plan, request_id: req.nonce }));
  await e.whenIdle(id);
  return { kind: req.kind, clipIsPrompt: clip === req.prompt, echo: echo.reason, noNonce: noNonce.reason, stale: stale.reason, planBefore: before, ok: ok.ok, applied: ok.applied, after: !!(await e.projects.get(id)).plan };
};

H.drawDraft = async (name, id) => {
  const engine = H.eng(name);
  const out = await engine.render.run(id, { draft: true });
  H.blobs.draft = await engine.render.output(id, 'draft');
  return out;
};

window.__harnessReady = true;
