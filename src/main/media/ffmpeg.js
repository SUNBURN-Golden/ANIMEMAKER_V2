'use strict';
// ffmpeg 실행 도우미. 앱에 같이 들어있는 ffmpeg-static 을 우선 사용하고,
// 없으면 시스템 ffmpeg 를 사용한다.
const { spawn } = require('child_process');
const { once } = require('events');
const fs = require('fs');

let cachedPath = null;

function ffmpegPath() {
  if (cachedPath) return cachedPath;
  if (process.env.ANIMEMAKER_FFMPEG && fs.existsSync(process.env.ANIMEMAKER_FFMPEG)) {
    cachedPath = process.env.ANIMEMAKER_FFMPEG;
    return cachedPath;
  }
  try {
    let p = require('ffmpeg-static');
    // 패키징된 앱에서는 asar 밖(app.asar.unpacked)에 실제 파일이 있다.
    if (p && p.includes('app.asar') && !p.includes('app.asar.unpacked')) {
      p = p.replace('app.asar', 'app.asar.unpacked');
    }
    if (p && fs.existsSync(p)) {
      cachedPath = p;
      return cachedPath;
    }
  } catch (_) { /* ffmpeg-static 미설치 */ }
  cachedPath = 'ffmpeg';
  return cachedPath;
}

/**
 * ffmpeg 실행. 실패하면 stderr 마지막 부분을 담은 Error 를 던진다.
 * @param {string[]} args
 * @param {{signal?: AbortSignal, onProgress?: (sec:number)=>void, capture?: 'stdout', cwd?: string}} opts
 */
function runFfmpeg(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: opts.cwd,
    });
    const out = [];
    let err = '';
    child.stdout.on('data', (d) => { if (opts.capture === 'stdout') out.push(d); });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      err += s;
      if (err.length > 200000) err = err.slice(-100000);
      if (opts.onProgress) {
        const m = /time=(\d+):(\d+):([\d.]+)/.exec(s);
        if (m) opts.onProgress(+m[1] * 3600 + +m[2] * 60 + +m[3]);
      }
    });
    const onAbort = () => { try { child.kill('SIGKILL'); } catch (_) { /* noop */ } };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', (e) => reject(new Error(`ffmpeg 를 실행할 수 없습니다: ${e.message}`)));
    child.on('close', (code) => {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      if (opts.signal && opts.signal.aborted) return reject(abortError());
      if (code === 0) return resolve({ stdout: Buffer.concat(out), stderr: err });
      const noise = /Task finished|Terminating thread|Could not open encoder before EOF|Nothing was written|^frame=|Conversion failed/;
      const tail = err.split('\n').filter((l) => l.trim() && !noise.test(l)).slice(-15).join('\n');
      reject(new Error(`ffmpeg 오류 (코드 ${code}):\n${tail}`));
    });
  });
}

function abortError() {
  const e = new Error('사용자가 중지했습니다.');
  e.name = 'AbortError';
  return e;
}

/** 미디어 정보(길이, 해상도, 오디오/비디오 유무)를 ffmpeg -i 출력으로 파악 */
async function probe(file) {
  // 출력 파일 없이 -i 만 주면 ffmpeg 는 실패 코드로 끝나지만 stderr 에 정보가 나온다.
  const stderr = await new Promise((resolve) => {
    const child = spawn(ffmpegPath(), ['-hide_banner', '-i', file], { windowsHide: true });
    let s = '';
    child.stderr.on('data', (d) => { s += d.toString(); });
    child.on('close', () => resolve(s));
    child.on('error', () => resolve(''));
  });
  const info = { duration: 0, width: 0, height: 0, hasVideo: false, hasAudio: false };
  const d = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(stderr);
  if (d) info.duration = +d[1] * 3600 + +d[2] * 60 + +d[3];
  const lines = stderr.split('\n');
  for (const line of lines) {
    if (/Stream #.*Video:/.test(line) && !/attached pic/.test(line)) {
      info.hasVideo = true;
      const r = /,\s*(\d{2,5})x(\d{2,5})/.exec(line);
      if (r && !info.width) { info.width = +r[1]; info.height = +r[2]; }
    }
    if (/Stream #.*Audio:/.test(line)) info.hasAudio = true;
  }
  return info;
}

/**
 * 앱이 직접 그린 프레임(raw RGB)을 ffmpeg 로 흘려보내 영상으로 저장한다.
 * write() 는 ffmpeg 가 받을 준비가 될 때까지 기다린다 (메모리가 넘치지 않게).
 * @param {string[]} args 입력은 'pipe:0'
 * @param {{signal?: AbortSignal}} [opts]
 */
function ffmpegWriter(args, opts = {}) {
  const child = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], {
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let err = '';
  let closed = false;
  child.stderr.on('data', (d) => { err += d.toString(); if (err.length > 100000) err = err.slice(-50000); });
  const onAbort = () => { try { child.kill('SIGKILL'); } catch (_) { /* noop */ } };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  const done = new Promise((resolve, reject) => {
    child.on('error', (e) => { closed = true; reject(new Error(`ffmpeg 를 실행할 수 없습니다: ${e.message}`)); });
    child.on('close', (code) => {
      closed = true;
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      if (opts.signal && opts.signal.aborted) return reject(abortError());
      if (code === 0) return resolve();
      return reject(new Error(`ffmpeg 오류 (코드 ${code}):\n${err.split('\n').filter((l) => l.trim()).slice(-12).join('\n')}`));
    });
  });
  done.catch(() => {});
  child.stdin.on('error', () => { /* 끊김은 done 에서 알린다 */ });
  return {
    async write(buf) {
      if (opts.signal && opts.signal.aborted) throw abortError();
      if (closed) { await done; throw new Error('ffmpeg 가 먼저 끝났습니다.'); }
      if (!child.stdin.write(buf)) await Promise.race([once(child.stdin, 'drain'), done]);
    },
    async end() {
      child.stdin.end();
      await done;
    },
  };
}

/** 영상의 실제 프레임 수 (풀어서 셈) */
async function countFrames(file) {
  const { stderr } = await runFfmpeg(['-i', file, '-map', '0:v:0', '-f', 'null', '-']);
  const all = [...stderr.matchAll(/frame=\s*(\d+)/g)];
  return all.length ? Number(all[all.length - 1][1]) : 0;
}

/** 오디오를 mono float32 PCM 으로 디코딩 */
async function decodeAudioMono(file, sampleRate = 22050, opts = {}) {
  const { stdout } = await runFfmpeg(
    ['-i', file, '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', 'pipe:1'],
    { ...opts, capture: 'stdout' },
  );
  const buf = stdout;
  const samples = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  return { samples: Float32Array.from(samples), sampleRate };
}

/** concat demuxer 용 경로 이스케이프 */
function concatEscape(p) {
  return p.replace(/\\/g, '/').replace(/'/g, "'\\''");
}

module.exports = { ffmpegPath, runFfmpeg, ffmpegWriter, countFrames, probe, decodeAudioMono, concatEscape, abortError };
