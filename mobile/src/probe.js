// 내 폰 점검 — 이 폰(WebView)이 영상을 만들 수 있는지 처음 켤 때 미리 확인한다.
// V1 은 영상 인코더가 없다는 것을 맨 마지막 '영상 만들기' 에서야 알았다. V2 는 시작할 때 알려 주고, 고치는 방법도 말해 준다.
//
//   probe({ g, appInfo })      → 점검 결과 (JSON 으로 저장할 수 있는 모양)
//   friendlyProblems(result)  → [{ id, level:'bad'|'warn'|'info', text }]  쉬운 한국어 안내 (심각한 것부터)
//   summarize(result)         → { level, emoji, headline }
//   decide(result)            → { level, canMakeVideo, videoCodec, audioCodec, suggestedQuality }
//
// g 는 전역 객체(기본 globalThis). 시험에서는 가짜 전역을 넣어 판단 규칙만 따로 확인한다.

/** esbuild 대상 (build.mjs 의 chrome94) = WebCodecs 가 처음 들어온 Chrome 버전 */
export const MIN_CHROME = 94;

/**
 * 인코더 시험 설정. 영상 코덱 이름은 WebCodecs 규칙의 '전체 이름' 이어야 한다
 * (그냥 'vp09' 나 'vp9' 는 Chrome 에서 지원 안 함으로 나온다 — 진짜 안 되는 것과 구분하려고 전체 이름을 쓴다).
 */
export const CODEC_TESTS = Object.freeze({
  video: { avc: ['avc1.42001f'], vp9: ['vp09.00.31.08', 'vp09.00.10.08'] },
  audio: { aac: ['mp4a.40.2'], opus: ['opus'] },
});

const VIDEO_BASE = { width: 1280, height: 720, framerate: 24, bitrate: 4_000_000 };
const AUDIO_BASE = { sampleRate: 48000, numberOfChannels: 2, bitrate: 128_000 };

/** wasm-feature-detect 의 SIMD 시험용 아주 작은 모듈 */
const SIMD_WASM = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

function withTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((resolve) => { t = setTimeout(() => resolve(false), ms); })]).finally(() => clearTimeout(t));
}

async function encoderSupports(Enc, config, ms) {
  try {
    const r = await withTimeout(Enc.isConfigSupported(config), ms);
    return !!(r && r.supported);
  } catch (_) {
    return false;
  }
}

async function anySupported(Enc, names, base, ms) {
  if (typeof Enc !== 'function' || typeof Enc.isConfigSupported !== 'function') return false;
  for (const codec of names) if (await encoderSupports(Enc, { codec, ...base }, ms)) return true;
  return false;
}

function hasWasmSimd(g) {
  try {
    return !!(g.WebAssembly && typeof g.WebAssembly.validate === 'function' && g.WebAssembly.validate(SIMD_WASM));
  } catch (_) {
    return false;
  }
}

function hasWebgl2(g) {
  try {
    if (typeof g.OffscreenCanvas === 'function') {
      const c = new g.OffscreenCanvas(1, 1);
      if (c.getContext('webgl2')) return true;
    }
    if (g.document && typeof g.document.createElement === 'function') return !!g.document.createElement('canvas').getContext('webgl2');
  } catch (_) { /* 못 만들면 없는 것 */ }
  return false;
}

function chromeMajorOf(ua, webViewVersion) {
  const fromVersion = /^(\d+)\./.exec(webViewVersion || '');
  if (fromVersion) return Number(fromVersion[1]);
  const m = /Chrome\/(\d+)/.exec(ua || '');
  return m ? Number(m[1]) : null;
}

/** 저장 공간 사용량·한도·보호 여부. 알 수 없으면 null (점검과 별개로 자주 바뀌어서 따로 읽는다) */
export async function readStorage(g = globalThis) {
  try {
    const st = g.navigator && g.navigator.storage;
    if (!st || typeof st.estimate !== 'function') return null;
    const e = await st.estimate();
    const persisted = typeof st.persisted === 'function' ? await st.persisted() : null;
    return { usage: e.usage || 0, quota: e.quota || 0, persisted };
  } catch (_) {
    return null;
  }
}

/**
 * 이 폰이 영상을 만들 수 있는지 점검한다. (몇 백 ms 안에 끝난다)
 * @param {{g?:object, appInfo?:{versionName?:string, versionCode?:number, sdkInt?:number, webViewVersion?:string}, timeoutMs?:number}} [o]
 */
export async function probe({ g = globalThis, appInfo = null, timeoutMs = 4000 } = {}) {
  const nav = g.navigator || {};
  const ua = nav.userAgent || '';
  const features = {
    indexedDB: !!g.indexedDB,
    offscreenCanvas: typeof g.OffscreenCanvas === 'function',
    createImageBitmap: typeof g.createImageBitmap === 'function',
    videoEncoder: typeof g.VideoEncoder === 'function',
    audioEncoder: typeof g.AudioEncoder === 'function',
    webAssembly: typeof g.WebAssembly === 'object' && g.WebAssembly !== null,
    wasmSimd: hasWasmSimd(g),
    webgl2: hasWebgl2(g),
    webgpu: !!nav.gpu,
  };
  const codecs = {
    video: {
      avc: await anySupported(g.VideoEncoder, CODEC_TESTS.video.avc, VIDEO_BASE, timeoutMs),
      vp9: await anySupported(g.VideoEncoder, CODEC_TESTS.video.vp9, VIDEO_BASE, timeoutMs),
    },
    audio: {
      aac: await anySupported(g.AudioEncoder, CODEC_TESTS.audio.aac, AUDIO_BASE, timeoutMs),
      opus: await anySupported(g.AudioEncoder, CODEC_TESTS.audio.opus, AUDIO_BASE, timeoutMs),
    },
  };
  const storage = await readStorage(g);
  const webViewVersion = (appInfo && appInfo.webViewVersion) || '';
  const result = {
    version: 1,
    at: Date.now(),
    env: {
      userAgent: ua,
      chromeMajor: chromeMajorOf(ua, webViewVersion),
      webViewVersion,
      webView: /; wv\)/.test(ua),
      secureContext: g.isSecureContext !== false,
      crossOriginIsolated: !!g.crossOriginIsolated,
      deviceMemory: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
      cores: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
      sdkInt: appInfo && appInfo.sdkInt ? appInfo.sdkInt : null,
      appVersion: appInfo && appInfo.versionName ? appInfo.versionName : null,
    },
    features,
    codecs,
    storage,
  };
  result.decision = decide(result);
  return result;
}

/** 저장해 둔 점검 결과를 다시 쓰는 기간 (WebView 가 업데이트되면 그전에 다시 점검한다) */
export const PROBE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 저장해 둔 점검 결과를 돌려주고, 없거나 오래됐거나 앱·WebView 버전이 바뀌었으면 새로 점검해서 저장한다.
 * 영상 만들기가 코덱을 고를 때 이것을 읽으면 된다 (result.decision.videoCodec / audioCodec / suggestedQuality).
 * @param {{store?:{getMeta:Function,setMeta:Function}, run?:Function, appInfo?:object, maxAgeMs?:number, force?:boolean, g?:object}} [o] store = db.js
 */
export async function loadProbe({ store = null, run = probe, appInfo = null, maxAgeMs = PROBE_MAX_AGE_MS, force = false, g = globalThis } = {}) {
  if (store && !force) {
    try {
      const saved = await store.getMeta('probe', null);
      const same = saved && saved.version === 1 && saved.env
        && (!appInfo || ((saved.env.appVersion || '') === (appInfo.versionName || '') && (saved.env.webViewVersion || '') === (appInfo.webViewVersion || '')));
      if (same && Date.now() - saved.at < maxAgeMs) {
        // 코덱 같은 것은 저장해 둔 대로, 저장 공간만 지금 값으로 다시 읽어 안내를 맞춘다 (공간을 비웠다면 경고가 사라져야 한다)
        const result = { ...saved, storage: (await readStorage(g)) || saved.storage };
        result.decision = decide(result);
        return result;
      }
    } catch (_) { /* 읽지 못하면 새로 점검 */ }
  }
  const result = await run({ appInfo });
  if (store) { try { await store.setMeta('probe', result); } catch (_) { /* 저장 못 해도 결과는 쓴다 */ } }
  return result;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** 쓸 수 있는 저장 공간(바이트). 모르면 null */
function freeBytes(result) {
  const s = result.storage;
  return s && s.quota > 0 ? Math.max(0, s.quota - (s.usage || 0)) : null;
}

/**
 * 점검 결과 → 쉬운 한국어 안내 목록 (심각한 것부터: bad → warn → info)
 *  bad  = 영상을 만들 수 없거나 곧 실패할 것   warn = 만들 수는 있지만 알아 둘 것   info = 참고
 */
export function friendlyProblems(result) {
  const out = [];
  const add = (id, level, text) => out.push({ id, level, text });
  const f = result.features || {};
  const c = result.codecs || { video: {}, audio: {} };
  const env = result.env || {};
  const update = "Play 스토어에서 'Android System WebView' 와 'Chrome' 을 찾아 [업데이트] 를 눌러 주세요.";

  if (f.indexedDB === false) add('no-indexeddb', 'bad', '이 앱이 작품을 저장할 곳(저장소)을 쓸 수 없어요. 앱을 지우고 다시 설치해 보세요.');
  if (env.chromeMajor && env.chromeMajor < MIN_CHROME) {
    add('old-webview', 'bad', `Android System WebView 를 업데이트해 주세요. 지금은 ${env.chromeMajor} 버전이고 ${MIN_CHROME} 이상이 필요해요. ${update}`);
  }
  if (f.videoEncoder === false) {
    add('no-webcodecs', 'bad', `영상을 만드는 기능이 없어요. Android System WebView 를 업데이트해 주세요. ${update}`);
  } else if (f.videoEncoder && !c.video.avc && !c.video.vp9) {
    add('no-video-codec', 'bad', '이 폰에는 영상을 만드는 부품(H.264·VP9 인코더)이 없어요. WebView 를 업데이트해도 안 되면 다른 폰에서 만들어 주세요.');
  }
  if (f.audioEncoder === false || (f.audioEncoder && !c.audio.aac && !c.audio.opus)) {
    add('no-audio-encoder', 'bad', `노래를 영상에 넣는 부품(AAC·Opus 인코더)이 없어요. Android System WebView 를 업데이트해 주세요. ${update}`);
  }
  if (f.offscreenCanvas === false || f.createImageBitmap === false) {
    add('no-canvas', 'bad', `그림을 다루는 기능이 없어요. Android System WebView 를 업데이트해 주세요. ${update}`);
  }
  const free = freeBytes(result);
  if (free !== null && free < 200 * MB) {
    add('low-storage', 'bad', `폰 저장 공간이 거의 없어요 (쓸 수 있는 곳 약 ${Math.round(free / MB)}MB). 안 쓰는 사진·앱을 지워 공간을 만들어 주세요.`);
  } else if (free !== null && free < GB) {
    add('low-storage', 'warn', `저장 공간이 모자랄 수 있어요 (쓸 수 있는 곳 약 ${Math.round(free / MB)}MB). 안 쓰는 작품을 지우면 도움이 돼요.`);
  }

  if (c.video.vp9 && !c.video.avc && f.videoEncoder) add('h264-missing', 'warn', 'H.264 인코더가 없어서 VP9 로 만들어요. 카카오톡·인스타그램에서 영상이 안 열릴 수 있어요.');
  if (c.audio.opus && !c.audio.aac && f.audioEncoder) add('aac-missing', 'warn', 'AAC 인코더가 없어서 소리를 Opus 로 넣어요. 일부 앱에서는 소리가 안 나올 수 있어요.');
  if (typeof env.deviceMemory === 'number' && env.deviceMemory <= 2) {
    add('low-memory', 'warn', `폰 메모리가 작아요 (약 ${env.deviceMemory}GB). 영상은 480p~720p 로 만들고, 다른 앱은 닫고 해 보세요.`);
  }
  if (typeof env.cores === 'number' && env.cores <= 2) add('few-cores', 'warn', '폰 계산 속도가 느린 편이에요. 영상 만들기가 오래 걸릴 수 있어요.');

  if (result.storage && result.storage.persisted === false) {
    add('not-persistent', 'info', '폰 저장 공간이 부족해지면 작품이 지워질 수 있어요. 완성한 영상은 갤러리에 저장해 두세요.');
  }
  if (f.webgl2 === false) add('no-webgl2', 'info', '화면 효과(필름 느낌 등)가 조금 느릴 수 있어요.');
  if (f.webAssembly && f.wasmSimd === false) add('no-simd', 'info', '빠른 계산 기능(SIMD)이 없어서 일부 기능은 쉬운 방법으로 대신해요.');

  const rank = { bad: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

/**
 * 점검 결과 → 앱이 쓸 결정. 임계값(메모리·코어)은 짐작이고 실제 폰에서 확인한 값이 아니다.
 * @returns {{level:'good'|'warn'|'bad', canMakeVideo:boolean, videoCodec:'avc'|'vp9'|null, audioCodec:'aac'|'opus'|null, suggestedQuality:'480p'|'720p'|'1080p'|null}}
 */
export function decide(result) {
  const problems = friendlyProblems(result);
  const bad = problems.some((p) => p.level === 'bad');
  const warn = problems.some((p) => p.level === 'warn');
  const c = result.codecs || { video: {}, audio: {} };
  const videoCodec = c.video.avc ? 'avc' : (c.video.vp9 ? 'vp9' : null);
  const audioCodec = c.audio.aac ? 'aac' : (c.audio.opus ? 'opus' : null);
  const canMakeVideo = !bad && !!videoCodec && !!audioCodec;
  const mem = result.env && typeof result.env.deviceMemory === 'number' ? result.env.deviceMemory : null;
  let suggestedQuality = null;
  if (canMakeVideo) {
    if (mem !== null && mem <= 2) suggestedQuality = '480p';
    else if (mem === null || mem <= 4) suggestedQuality = '720p';
    else suggestedQuality = '1080p';
  }
  return { level: bad ? 'bad' : (warn ? 'warn' : 'good'), canMakeVideo, videoCodec, audioCodec, suggestedQuality };
}

/** 카드 맨 위에 보일 한 줄 */
export function summarize(result) {
  const level = (result.decision || decide(result)).level;
  if (level === 'bad') return { level, emoji: '❌', headline: '이 폰에서는 영상을 만들기 어려워요' };
  if (level === 'warn') return { level, emoji: '⚠️', headline: '영상을 만들 수 있어요. 알아 두면 좋은 게 있어요' };
  return { level, emoji: '✅', headline: '이 폰으로 영상을 만들 수 있어요' };
}
