'use strict';
// 사이 그림(in-between) 만들기 (내 PC).
//  - 움직이는 컷에서 이웃한 열쇠 그림 A·B 사이에 '가운데 그림' 을 한 장 만들어 2프레임씩 넘긴다.
//    (24프레임 전부 매끈하게 채우지 않는다. 손그림 느낌이 사라지기 때문)
//  - RIFE (rife-ncnn-vulkan, 설치 파일에 함께 들어 있음): 그래픽카드(Vulkan) → 안 되면 CPU 로 다시
//  - 없거나 안 되면 같이 들어 있는 ffmpeg 의 minterpolate 로 대신한다.
//  - 결과는 다시 배경 빼기를 해서 투명한 셀로 쓴다.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { runFfmpeg, probe } = require('./ffmpeg');
const K = require('./keyer');

const IB_VERSION = 3;
const RIFE_MODEL = 'rife-v4.6';
const TOO_DIFFERENT = 0.45; // 이보다 다르면 사이 그림 없이 그대로 넘긴다 (keyer.celDifference)
// 윈도우: 실행에 필요한 DLL 이 없어서 켜지지 못함 (0xC0000135). RIFE 는 CPU 로 돌릴 때도 vulkan-1.dll 이 있어야 켜진다.
const DLL_NOT_FOUND = [3221225781, -1073741515];

function rifeBinName(platform = process.platform) {
  return platform === 'win32' ? 'rife-ncnn-vulkan.exe' : 'rife-ncnn-vulkan';
}

/** RIFE 를 찾을 곳: 환경변수 → 설치된 앱의 resources/rife → 개발용 vendor/rife/<플랫폼>-<아키텍처> */
function rifeCandidates() {
  return [
    process.env.ANIMEMAKER_RIFE_DIR,
    process.resourcesPath ? path.join(process.resourcesPath, 'rife') : null,
    path.join(__dirname, '..', '..', '..', 'vendor', 'rife', `${process.platform}-${process.arch}`),
  ].filter(Boolean);
}

function findRife() {
  for (const dir of rifeCandidates()) {
    const bin = path.join(dir, rifeBinName());
    const model = path.join(dir, RIFE_MODEL);
    if (K.exists(bin) && K.exists(path.join(model, 'flownet.bin')) && K.exists(path.join(model, 'flownet.param'))) return { dir, bin, model };
  }
  return null;
}

function run(bin, args, { cwd, signal, timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    let err = '';
    let done = false;
    let child;
    try {
      child = spawn(bin, args, { cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, err: e.message });
      return;
    }
    const finish = (r) => { if (!done) { done = true; clearTimeout(t); if (signal) signal.removeEventListener('abort', onAbort); resolve(r); } };
    const onAbort = () => { try { child.kill('SIGKILL'); } catch (_) { /* noop */ } };
    const t = setTimeout(() => { onAbort(); finish({ code: -2, err: `${err}\n시간 초과` }); }, timeoutMs);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.stderr.on('data', (d) => { err += d.toString(); if (err.length > 20000) err = err.slice(-10000); });
    child.on('error', (e) => finish({ code: -1, err: e.message }));
    child.on('close', (code) => finish({ code, err }));
  });
}

let gpuBroken = false; // 한 번 그래픽카드로 실패하면 그다음부터는 바로 CPU

/** RIFE 로 가운데 그림 */
async function rifeMid(a, b, out, rife, { signal } = {}) {
  // RIFE 는 자기 폴더에서 실행하므로 경로는 모두 절대 경로로
  [a, b, out] = [a, b, out].map((p) => path.resolve(p));
  const tries = gpuBroken ? [['-g', '-1']] : [[], ['-g', '-1']];
  let last = {};
  for (const extra of tries) {
    try { fs.unlinkSync(out); } catch (_) { /* 없음 */ }
    const r = await run(rife.bin, ['-0', a, '-1', b, '-o', out, '-m', rife.model, ...extra], { cwd: rife.dir, signal });
    if (signal && signal.aborted) throw Object.assign(new Error('사용자가 중지했습니다.'), { name: 'AbortError' });
    if (K.exists(out)) return { file: out, device: extra.length ? 'cpu' : 'gpu' };
    last = r;
    if (DLL_NOT_FOUND.includes(r.code)) break; // CPU 로 다시 해도 똑같이 못 켜진다
    if (!extra.length) gpuBroken = true;
  }
  const why = DLL_NOT_FOUND.includes(last.code)
    ? '이 PC 에는 그래픽 드라이버의 Vulkan(vulkan-1.dll)이 없어서 RIFE 를 켤 수 없어요.'
    : String(last.err || '').split('\n').filter(Boolean).slice(-2).join(' ');
  throw new Error(`RIFE 가 사이 그림을 만들지 못했습니다: ${why}`);
}

/**
 * ffmpeg minterpolate 로 가운데 그림 (A,A,B,B 를 1초 간격으로 놓고 1.5초 지점).
 * 아주 큰 그림은 절반 크기에서 움직임을 찾고 다시 키운다 (느려서).
 */
async function ffmpegMid(a, b, out, { signal } = {}) {
  const info = await probe(a);
  const W = info.width || 1024;
  const H = info.height || 576;
  const half = W > 1600;
  const pre = half ? `scale=${Math.round(W / 4) * 2}:${Math.round(H / 4) * 2},` : `scale=${W}:${H},`;
  const post = half ? `,scale=${W}:${H}:flags=lanczos` : '';
  await runFfmpeg(['-y', '-i', a, '-i', b, '-filter_complex',
    `[0:v]${pre}format=yuv444p,split[a0][a1];[1:v]${pre}format=yuv444p,split[b0][b1];[a0][a1][b0][b1]concat=n=4:v=1:a=0,settb=1,setpts=N/TB,`
    + `minterpolate=fps=2:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:me=epzs:mb_size=16:search_param=64:vsbmc=1:scd=none,select=eq(n\\,3)${post},format=rgb24`,
    '-frames:v', '1', out], { signal });
  if (!K.exists(out)) throw new Error('ffmpeg 가 사이 그림을 만들지 못했습니다.');
  return { file: out, device: 'cpu' };
}

/** 두 그림 크기가 다르면 B 를 A 크기로 맞춘 복사본 */
async function sameSize(a, b, tmp, signal) {
  const [ia, ib] = [await probe(a), await probe(b)];
  if (ia.width === ib.width && ia.height === ib.height) return b;
  await runFfmpeg(['-y', '-i', b, '-vf', `scale=${ia.width}:${ia.height}`, '-frames:v', '1', tmp], { signal });
  return tmp;
}

function fileSig(f) {
  try { const st = fs.statSync(f); return `${path.basename(f)}:${st.size}:${Math.round(st.mtimeMs)}`; } catch (_) { return `${f}:-`; }
}

/** 사이 그림 캐시 이름: 입력 그림 · 엔진 · 배경색이 같으면 같은 이름 */
function inbetweenHash(a, b, engine, keyColor) {
  return crypto.createHash('sha1').update(JSON.stringify([IB_VERSION, fileSig(a), fileSig(b), engine, keyColor || ''])).digest('hex').slice(0, 16);
}

/** 두 셀이 너무 달라서(자세·위치가 크게 바뀜) 사이 그림이 이상해질지 */
async function tooDifferent(celA, celB, { signal, threshold = TOO_DIFFERENT } = {}) {
  const [a, b] = [await K.readRgba(celA, { width: 64, signal }), await K.readRgba(celB, { width: 64, signal })];
  const d = K.celDifference(a, b);
  return { different: d > threshold, score: Math.round(d * 1000) / 1000 };
}

/**
 * 사이 그림 한 장.
 * @param {{a:string, b:string, outDir:string, engine:'rife'|'ffmpeg', rife?:object, keyColor?:string, signal?:AbortSignal}} o
 *   a, b: 배경색 판(셀) 또는 전체 그림. keyColor 가 있으면 결과에서 그 색을 빼서 투명 셀로 만든다.
 * @returns {Promise<{file:string, plate:string, engine:string, device:string, hash:string}>}
 */
async function makeInbetween(o) {
  fs.mkdirSync(o.outDir, { recursive: true });
  const hash = inbetweenHash(o.a, o.b, o.engine, o.keyColor);
  const plate = path.join(o.outDir, `${hash}_plate.png`);
  const file = o.keyColor ? path.join(o.outDir, `${hash}.png`) : plate;
  if (K.exists(file) && K.exists(plate)) return { file, plate, engine: o.engine, device: 'cache', hash, cached: true };
  const b = await sameSize(o.a, o.b, path.join(o.outDir, `${hash}_b.png`), o.signal);
  const r = o.engine === 'rife' ? await rifeMid(o.a, b, plate, o.rife, { signal: o.signal }) : await ffmpegMid(o.a, b, plate, { signal: o.signal });
  if (o.keyColor) {
    const res = await K.processCel(plate, { celOut: file, plateOut: path.join(o.outDir, `${hash}_rekey.png`), keyColor: o.keyColor, exactKey: true, signal: o.signal });
    if (!res.keyed) throw new Error('사이 그림의 배경을 뺄 수 없어요.');
  }
  return { file, plate, engine: o.engine, device: r.device, hash };
}

/**
 * 설정 → 쓸 엔진. 'auto' 는 RIFE 가 있으면 RIFE, 없으면 ffmpeg.
 * @returns {{engine:'rife'|'ffmpeg'|null, rife:object|null, note:string}}
 */
function resolveEngine(setting = 'auto') {
  if (setting === 'off') return { engine: null, rife: null, note: '사이 그림 끄기' };
  const rife = setting === 'ffmpeg' ? null : findRife();
  if (rife) return { engine: 'rife', rife, note: `RIFE (${rife.dir})` };
  return { engine: 'ffmpeg', rife: null, note: setting === 'rife' ? 'RIFE 를 찾지 못해서 ffmpeg 로 대신' : 'ffmpeg (minterpolate)' };
}

module.exports = { IB_VERSION, RIFE_MODEL, TOO_DIFFERENT, rifeBinName, rifeCandidates, findRife, rifeMid, ffmpegMid, makeInbetween, inbetweenHash, tooDifferent, resolveEngine };
