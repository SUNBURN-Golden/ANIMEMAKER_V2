// 내 폰 점검(probe.js): 가짜 전역으로 판단 규칙과 안내 글을 시험한다
import test from 'node:test';
import assert from 'node:assert';
import { probe, friendlyProblems, decide, summarize, loadProbe, CODEC_TESTS, MIN_CHROME, PROBE_MAX_AGE_MS } from '../src/probe.js';

const UA = (v) => `Mozilla/5.0 (Linux; Android 14; SM-S911N Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/${v}.0.0.0 Mobile Safari/537.36`;

/** 가짜 전역. video/audio = 지원하는 코덱 이름 목록 */
function fakeGlobal({ video = ['avc1.42001f', 'vp09.00.31.08'], audio = ['mp4a.40.2', 'opus'], chrome = 130, memory = 8, cores = 8, quota = 20e9, usage = 1e9, persisted = true, calls = [], extra = {} } = {}) {
  const enc = (list, kind) => class {
    static async isConfigSupported(cfg) {
      calls.push(`${kind}:${cfg.codec}`);
      return { supported: list.includes(cfg.codec) };
    }
  };
  return {
    indexedDB: {},
    OffscreenCanvas: class { getContext(t) { return t === 'webgl2' ? {} : null; } },
    createImageBitmap: () => {},
    VideoEncoder: video === null ? undefined : enc(video, 'V'),
    AudioEncoder: audio === null ? undefined : enc(audio, 'A'),
    WebAssembly: { validate: () => true },
    crossOriginIsolated: false,
    isSecureContext: true,
    navigator: {
      userAgent: UA(chrome),
      deviceMemory: memory === null ? undefined : memory,
      hardwareConcurrency: cores,
      storage: quota === null ? undefined : { estimate: async () => ({ usage, quota }), persisted: async () => persisted },
    },
    ...extra,
  };
}

const ids = (r) => friendlyProblems(r).map((p) => `${p.level}:${p.id}`);

test('인코더 시험 이름: H.264 avc1.42001f · VP9 vp09… 전체 이름 · AAC mp4a.40.2 · opus', () => {
  assert.deepStrictEqual(CODEC_TESTS.video.avc, ['avc1.42001f']);
  assert.ok(CODEC_TESTS.video.vp9.every((c) => /^vp09\.\d\d\.\d\d\.\d\d$/.test(c)), 'vp09 는 WebCodecs 전체 이름이어야 한다');
  assert.deepStrictEqual(CODEC_TESTS.audio.aac, ['mp4a.40.2']);
  assert.deepStrictEqual(CODEC_TESTS.audio.opus, ['opus']);
  assert.strictEqual(MIN_CHROME, 94);
});

test('좋은 폰: 문제 없음, H.264 + AAC, 메모리가 넉넉하면 1080p 까지 권장', async () => {
  const calls = [];
  const r = await probe({ g: fakeGlobal({ calls }) });
  assert.deepStrictEqual(friendlyProblems(r), []);
  assert.deepStrictEqual(r.decision, { level: 'good', canMakeVideo: true, videoCodec: 'avc', audioCodec: 'aac', suggestedQuality: '1080p' });
  assert.ok(calls.includes('V:avc1.42001f') && calls.includes('A:mp4a.40.2') && calls.includes('A:opus'));
  assert.ok(calls.some((c) => c.startsWith('V:vp09.')));
  assert.deepStrictEqual(summarize(r), { level: 'good', emoji: '✅', headline: '이 폰으로 영상을 만들 수 있어요' });
  // 모양: 저장·전달할 수 있는 단순한 JSON
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), r);
  assert.deepStrictEqual(Object.keys(r).sort(), ['at', 'codecs', 'decision', 'env', 'features', 'storage', 'version']);
  assert.deepStrictEqual(r.features, { indexedDB: true, offscreenCanvas: true, createImageBitmap: true, videoEncoder: true, audioEncoder: true, webAssembly: true, wasmSimd: true, webgl2: true, webgpu: false });
  assert.strictEqual(r.env.chromeMajor, 130);
  assert.strictEqual(r.env.webView, true);
  assert.deepStrictEqual(r.storage, { usage: 1e9, quota: 20e9, persisted: true });
});

test('VP9 · Opus 만 되는 폰: 만들 수는 있지만 알려 준다 (카카오톡·인스타에서 안 열릴 수 있어요)', async () => {
  const r = await probe({ g: fakeGlobal({ video: ['vp09.00.31.08'], audio: ['opus'] }) });
  assert.deepStrictEqual(ids(r), ['warn:h264-missing', 'warn:aac-missing']);
  assert.deepStrictEqual(r.decision, { level: 'warn', canMakeVideo: true, videoCodec: 'vp9', audioCodec: 'opus', suggestedQuality: '1080p' });
  const t = friendlyProblems(r).map((p) => p.text).join('\n');
  assert.match(t, /H\.264 인코더가 없어서 VP9/);
  assert.match(t, /카카오톡·인스타그램에서 영상이 안 열릴 수 있어요/);
  assert.strictEqual(summarize(r).level, 'warn');
});

test('WebCodecs(VideoEncoder)가 없으면 "Android System WebView 를 업데이트해 주세요"', async () => {
  const r = await probe({ g: fakeGlobal({ video: null }) });
  assert.ok(ids(r).includes('bad:no-webcodecs'));
  assert.match(friendlyProblems(r)[0].text, /Android System WebView 를 업데이트해 주세요/);
  assert.strictEqual(r.decision.level, 'bad');
  assert.strictEqual(r.decision.canMakeVideo, false);
  assert.strictEqual(r.decision.videoCodec, null);
  assert.strictEqual(r.decision.suggestedQuality, null);
  assert.deepStrictEqual(summarize(r), { level: 'bad', emoji: '❌', headline: '이 폰에서는 영상을 만들기 어려워요' });
});

test('오래된 WebView(Chrome 94 미만): 버전과 업데이트 방법을 알려 준다', async () => {
  const r = await probe({ g: fakeGlobal({ chrome: 90 }) });
  assert.ok(ids(r).includes('bad:old-webview'));
  const p = friendlyProblems(r).find((x) => x.id === 'old-webview');
  assert.match(p.text, /Android System WebView 를 업데이트해 주세요/);
  assert.match(p.text, /90/);
  assert.match(p.text, new RegExp(String(MIN_CHROME)));
  // 앱이 알려 준 WebView 버전이 UserAgent 보다 우선한다
  const r2 = await probe({ g: fakeGlobal({ chrome: 130 }), appInfo: { webViewVersion: '89.0.4389.105', sdkInt: 30, versionName: '2.0.0' } });
  assert.strictEqual(r2.env.chromeMajor, 89);
  assert.strictEqual(r2.env.sdkInt, 30);
  assert.strictEqual(r2.env.appVersion, '2.0.0');
  assert.ok(ids(r2).includes('bad:old-webview'));
  // 딱 94 는 괜찮다
  assert.ok(!ids(await probe({ g: fakeGlobal({ chrome: 94 }) })).includes('bad:old-webview'));
});

test('인코더는 있는데 H.264 도 VP9 도 못 만들면 bad', async () => {
  const r = await probe({ g: fakeGlobal({ video: [] }) });
  assert.ok(ids(r).includes('bad:no-video-codec'));
  assert.strictEqual(r.decision.canMakeVideo, false);
  assert.match(friendlyProblems(r).find((p) => p.id === 'no-video-codec').text, /H\.264·VP9/);
});

test('소리 인코더가 없거나 AAC 도 Opus 도 못 쓰면 bad (노래를 영상에 넣을 수 없다)', async () => {
  for (const audio of [null, []]) {
    const r = await probe({ g: fakeGlobal({ audio }) });
    assert.ok(ids(r).includes('bad:no-audio-encoder'), `audio=${JSON.stringify(audio)}`);
    assert.strictEqual(r.decision.canMakeVideo, false);
    assert.strictEqual(r.decision.audioCodec, null);
  }
});

test('저장소(IndexedDB)나 그림 기능(OffscreenCanvas · createImageBitmap)이 없으면 bad', async () => {
  const noDb = await probe({ g: fakeGlobal({ extra: { indexedDB: undefined } }) });
  assert.ok(ids(noDb).includes('bad:no-indexeddb'));
  const noCanvas = await probe({ g: fakeGlobal({ extra: { OffscreenCanvas: undefined } }) });
  assert.ok(ids(noCanvas).includes('bad:no-canvas'));
  const noBitmap = await probe({ g: fakeGlobal({ extra: { createImageBitmap: undefined } }) });
  assert.ok(ids(noBitmap).includes('bad:no-canvas'));
});

test('메모리가 작은 폰은 480p, 보통은 720p 를 권한다 (임계값은 짐작이다)', async () => {
  const low = await probe({ g: fakeGlobal({ memory: 2 }) });
  assert.ok(ids(low).includes('warn:low-memory'));
  assert.strictEqual(low.decision.suggestedQuality, '480p');
  assert.match(friendlyProblems(low).find((p) => p.id === 'low-memory').text, /약 2GB/);
  const mid = await probe({ g: fakeGlobal({ memory: 4 }) });
  assert.strictEqual(mid.decision.suggestedQuality, '720p');
  const unknown = await probe({ g: fakeGlobal({ memory: null }) });
  assert.strictEqual(unknown.env.deviceMemory, null);
  assert.strictEqual(unknown.decision.suggestedQuality, '720p');
  const slow = await probe({ g: fakeGlobal({ cores: 2 }) });
  assert.ok(ids(slow).includes('warn:few-cores'));
});

test('저장 공간: 1GB 미만이면 알려 주고, 200MB 미만이면 bad', async () => {
  const some = await probe({ g: fakeGlobal({ quota: 1.2e9, usage: 0.5e9 }) });
  assert.ok(ids(some).includes('warn:low-storage'));
  assert.match(friendlyProblems(some).find((p) => p.id === 'low-storage').text, /약 \d+MB/);
  const nearly = await probe({ g: fakeGlobal({ quota: 0.3e9, usage: 0.2e9 }) });
  assert.ok(ids(nearly).includes('bad:low-storage'));
  assert.strictEqual(nearly.decision.canMakeVideo, false);
  const plenty = await probe({ g: fakeGlobal({ quota: 50e9, usage: 1e9 }) });
  assert.ok(!ids(plenty).some((x) => x.endsWith('low-storage')));
  const unknown = await probe({ g: fakeGlobal({ quota: null }) });
  assert.strictEqual(unknown.storage, null);
  assert.ok(!ids(unknown).some((x) => x.endsWith('low-storage')));
});

test('참고 안내(info): 저장 공간 보호 안 됨 · WebGL2 없음 · SIMD 없음 — 있어도 점검 결과는 "좋음"', async () => {
  const g = fakeGlobal({ persisted: false });
  g.OffscreenCanvas = class { getContext() { return null; } };
  g.WebAssembly = { validate: () => false };
  const r = await probe({ g });
  assert.deepStrictEqual(ids(r), ['info:not-persistent', 'info:no-webgl2', 'info:no-simd']);
  assert.strictEqual(r.decision.level, 'good');
  assert.strictEqual(summarize(r).level, 'good');
});

test('안내는 심각한 순서(bad → warn → info)로 나온다', async () => {
  const g = fakeGlobal({ chrome: 90, video: ['vp09.00.31.08'], audio: ['opus'], persisted: false, memory: 2 });
  const order = friendlyProblems(await probe({ g })).map((p) => p.level);
  assert.deepStrictEqual(order, [...order].sort((a, b) => ({ bad: 0, warn: 1, info: 2 }[a] - { bad: 0, warn: 1, info: 2 }[b])));
  assert.strictEqual(order[0], 'bad');
  assert.strictEqual(order[order.length - 1], 'info');
});

test('isConfigSupported 가 오류를 내거나 응답이 없어도 점검은 끝난다 (지원 안 함으로 본다)', async () => {
  const g = fakeGlobal();
  g.VideoEncoder = class { static isConfigSupported() { return Promise.reject(new Error('boom')); } };
  g.AudioEncoder = class { static isConfigSupported() { return new Promise(() => {}); } }; // 영원히 안 끝남
  const t0 = Date.now();
  const r = await probe({ g, timeoutMs: 30 });
  assert.ok(Date.now() - t0 < 2000);
  assert.deepStrictEqual(r.codecs, { video: { avc: false, vp9: false }, audio: { aac: false, opus: false } });
  assert.ok(ids(r).includes('bad:no-video-codec'));
});

test('빈 전역(브라우저 기능이 하나도 없음)에서도 오류 없이 bad 로 끝난다', async () => {
  const r = await probe({ g: {} });
  assert.strictEqual(r.decision.level, 'bad');
  assert.ok(ids(r).includes('bad:no-webcodecs'));
  assert.ok(ids(r).includes('bad:no-indexeddb'));
  assert.strictEqual(r.env.chromeMajor, null);
  assert.strictEqual(r.storage, null);
});

test('decide(): 점검 결과 모양만 있으면 같은 결정을 다시 계산한다 (저장해 둔 결과를 읽어도 된다)', async () => {
  const r = await probe({ g: fakeGlobal({ video: ['vp09.00.10.08'], memory: 4 }) });
  const stored = JSON.parse(JSON.stringify(r));
  assert.deepStrictEqual(decide(stored), r.decision);
  assert.strictEqual(r.codecs.video.vp9, true, '두 번째 vp09 후보도 인정한다');
});

test('loadProbe: 저장해 둔 결과를 다시 쓰고, 오래됐거나 버전이 바뀌었거나 force 면 새로 점검해 저장한다', async () => {
  const mem = new Map();
  const store = { getMeta: async (k, d = null) => (mem.has(k) ? mem.get(k) : d), setMeta: async (k, v) => { mem.set(k, v); } };
  let runs = 0;
  const run = async ({ appInfo }) => { runs++; return probe({ g: fakeGlobal(), appInfo }); };
  const info = { versionName: '2.0.0', webViewVersion: '141.0.1.2', sdkInt: 34 };
  const first = await loadProbe({ store, run, appInfo: info });
  assert.strictEqual(runs, 1);
  assert.deepStrictEqual(mem.get('probe'), first, '점검 결과를 meta("probe") 에 저장');
  const again = await loadProbe({ store, run, appInfo: info, g: fakeGlobal() });
  assert.strictEqual(runs, 1, '저장해 둔 결과를 다시 쓴다 (새로 점검하지 않는다)');
  assert.deepStrictEqual({ ...again, storage: null }, { ...first, storage: null });
  // 저장 공간만은 지금 값으로 다시 읽는다: 공간이 모자라졌다가 비워지면 경고가 따라 바뀐다
  const tight = await loadProbe({ store, run, appInfo: info, g: fakeGlobal({ quota: 0.3e9, usage: 0.2e9 }) });
  assert.strictEqual(runs, 1);
  assert.strictEqual(tight.decision.level, 'bad');
  assert.ok(ids(tight).includes('bad:low-storage'));
  assert.strictEqual((await loadProbe({ store, run, appInfo: info, g: fakeGlobal({ quota: 50e9, usage: 1e9 }) })).decision.level, 'good');
  assert.strictEqual(mem.get('probe').decision.level, 'good', '저장된 원본은 바뀌지 않는다');
  await loadProbe({ store, run, appInfo: { ...info, webViewVersion: '142.0.0.0' } });
  assert.strictEqual(runs, 2, 'WebView 가 바뀌면 다시 점검');
  await loadProbe({ store, run, appInfo: { ...info, webViewVersion: '142.0.0.0', versionName: '2.1.0' } });
  assert.strictEqual(runs, 3, '앱 버전이 바뀌어도 다시 점검');
  await loadProbe({ store, run, appInfo: { ...info, webViewVersion: '142.0.0.0', versionName: '2.1.0' }, force: true });
  assert.strictEqual(runs, 4);
  const old = mem.get('probe');
  mem.set('probe', { ...old, at: Date.now() - PROBE_MAX_AGE_MS - 1000 });
  await loadProbe({ store, run, appInfo: { ...info, webViewVersion: '142.0.0.0', versionName: '2.1.0' } });
  assert.strictEqual(runs, 5, '일주일이 지나면 다시 점검');
  assert.strictEqual((await loadProbe({ run })).decision.level, 'good', 'store 없이도 동작');
  // 저장소가 고장나도 점검 결과는 돌려준다
  const broken = { getMeta: async () => { throw new Error('x'); }, setMeta: async () => { throw new Error('y'); } };
  assert.ok((await loadProbe({ store: broken, run })).decision);
});
