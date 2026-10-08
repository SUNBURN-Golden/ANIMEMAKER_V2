'use strict';
// 노래 분석 계산 부분: BPM, 박자(비트), 마디 시작(다운비트), 마디별 에너지.
// 소리 데이터(모노, 22050Hz)만 받으므로 PC 앱(media/audio.js 의 analyzeSong)과 폰 앱(안드로이드 WebView, esbuild 묶음)이 같은 파일을 쓴다.
// 모두 순수 함수다 (fs / ffmpeg / Buffer 없음, scripts/shared-modules.js · test/shared-purity.test.js).
// 노래 파일을 소리 데이터로 푸는 일(ffmpeg 디코딩)은 PC 의 audio.js, 폰의 audio.js(WebAudio) 가 맡는다.
// 외부 AI 없이 내 PC·내 폰에서 계산한다 (무료).
// 내보내는 이름은 V1 의 audio-analysis.js(analyzeSamples, estimateTempo, fixOctave, SR)를 포함한다: 폰의 analyze.worker.js 를 그대로 쓸 수 있다.

const SR = 22050;
const N_FFT = 1024;
const HOP = 256;

function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k];
        const ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br;
        im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br;
        im[i + k + len / 2] = ai - bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** 프레임별 onset(소리가 '탁' 시작되는 정도), 저음 onset, RMS 계산 */
function onsetFeatures(samples) {
  const nFrames = Math.max(1, Math.floor((samples.length - N_FFT) / HOP) + 1);
  const win = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N_FFT - 1));
  const maxBin = Math.floor((8000 / SR) * N_FFT);
  const lowBin = Math.max(2, Math.floor((150 / SR) * N_FFT));
  const prev = new Float64Array(maxBin);
  const env = new Float64Array(nFrames);
  const low = new Float64Array(nFrames);
  const rms = new Float64Array(nFrames);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  let prevLow = 0;
  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP;
    let sq = 0;
    for (let i = 0; i < N_FFT; i++) {
      const s = samples[off + i] || 0;
      sq += s * s;
      re[i] = s * win[i];
      im[i] = 0;
    }
    rms[f] = Math.sqrt(sq / N_FFT);
    fftInPlace(re, im);
    let flux = 0;
    let lowE = 0;
    for (let b = 1; b < maxBin; b++) {
      const mag = Math.log1p(10 * Math.hypot(re[b], im[b]));
      const d = mag - prev[b];
      if (d > 0) flux += d;
      prev[b] = mag;
      if (b <= lowBin) lowE += mag;
    }
    env[f] = f === 0 ? 0 : flux / maxBin;
    low[f] = f === 0 ? 0 : Math.max(0, lowE - prevLow);
    prevLow = lowE;
  }
  return { env: normalizeEnv(env), low: normalizeEnv(low), rms, fps: SR / HOP };
}

function normalizeEnv(x) {
  const n = x.length;
  const out = new Float64Array(n);
  const w = 16;
  let sum = 0;
  const q = [];
  for (let i = 0; i < n; i++) {
    q.push(x[i]);
    sum += x[i];
    if (q.length > w) sum -= q.shift();
    out[i] = Math.max(0, x[i] - sum / q.length);
  }
  let m = 0;
  for (let i = 0; i < n; i++) m += out[i] * out[i];
  const sd = Math.sqrt(m / Math.max(1, n)) || 1;
  for (let i = 0; i < n; i++) out[i] /= sd;
  return out;
}

/** 자기상관으로 템포 추정. priorBpm 근처를 선호한다. */
function estimateTempo(env, fps, priorBpm = 120) {
  const minBpm = 55;
  const maxBpm = 200;
  const minLag = Math.floor((60 * fps) / maxBpm);
  const maxLag = Math.ceil((60 * fps) / minBpm);
  const n = env.length;
  const ac = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += env[i] * env[i - lag];
    ac[lag] = s / (n - lag || 1);
  }
  let best = -Infinity;
  let bestLag = Math.round((60 * fps) / priorBpm);
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * fps) / lag;
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / priorBpm) / 0.9, 2));
    // 박자의 정수배 지점에도 힘이 있으면 가산 (하모닉 보강)
    const harm = lag * 2 <= maxLag + 1 ? 0.5 * ac[Math.min(maxLag + 1, lag * 2)] : 0;
    const score = (ac[lag] + harm) * w;
    if (score > best) { best = score; bestLag = lag; }
  }
  // 포물선 보간으로 소수점 lag 보정
  let lag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const a = ac[bestLag - 1];
    const b = ac[bestLag];
    const c = ac[bestLag + 1];
    const den = a - 2 * b + c;
    if (den !== 0) lag = bestLag + Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
  }
  return (60 * fps) / lag;
}

/**
 * 두 배/절반 템포 혼동 보정. 기획 단계에서 정한 BPM(prior)이 있으면 그쪽에 가까운 값을,
 * 없으면 대중음악에서 흔한 70~160 BPM 범위를 고른다.
 */
function fixOctave(bpm, priorBpm) {
  const cands = [bpm / 2, bpm, bpm * 2].filter((b) => b >= 50 && b <= 220);
  if (priorBpm && priorBpm > 40 && priorBpm < 220) {
    return cands.reduce((a, b) => (Math.abs(Math.log2(b / priorBpm)) < Math.abs(Math.log2(a / priorBpm)) ? b : a));
  }
  let out = bpm;
  while (out > 160) out /= 2;
  while (out < 70) out *= 2;
  return out;
}

/** Ellis(2007) 동적계획법 비트 트래킹 */
function trackBeats(env, fps, bpm, tightness = 100) {
  const period = (60 * fps) / bpm;
  const n = env.length;
  // 가우시안으로 부드럽게 한 local score
  const half = Math.round(period);
  const sd = period / 32;
  const kernel = [];
  for (let i = -half; i <= half; i++) kernel.push(Math.exp(-0.5 * (i / sd) ** 2));
  const local = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    let s = 0;
    for (let k = 0; k < kernel.length; k++) {
      const idx = t + k - half;
      if (idx >= 0 && idx < n) s += env[idx] * kernel[k];
    }
    local[t] = s;
  }
  const cum = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2);
  const hi = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    let arg = -1;
    for (let tau = lo; tau <= hi; tau++) {
      const p = t - tau;
      if (p < 0) break;
      const s = cum[p] - tightness * Math.log(tau / period) ** 2;
      if (s > best) { best = s; arg = p; }
    }
    cum[t] = local[t] + (arg >= 0 ? Math.max(0, best) : 0);
    back[t] = arg >= 0 && best > 0 ? arg : -1;
  }
  // 마지막 비트: cum 의 국소 최대값 중 충분히 큰 마지막 지점
  const maxima = [];
  for (let t = 1; t < n - 1; t++) if (cum[t] > cum[t - 1] && cum[t] >= cum[t + 1]) maxima.push(cum[t]);
  maxima.sort((a, b) => a - b);
  const med = maxima.length ? maxima[Math.floor(maxima.length / 2)] : 0;
  let last = n - 1;
  for (let t = n - 2; t > 0; t--) {
    if (cum[t] > cum[t - 1] && cum[t] >= cum[t + 1] && cum[t] >= 0.5 * med) { last = t; break; }
  }
  const beats = [];
  for (let t = last; t >= 0; t = back[t]) {
    beats.push(t);
    if (back[t] < 0) break;
  }
  beats.reverse();
  // 앞뒤 약한 비트 제거
  let rmsLocal = 0;
  for (let i = 0; i < n; i++) rmsLocal += local[i] * local[i];
  rmsLocal = Math.sqrt(rmsLocal / Math.max(1, n));
  while (beats.length > 2 && local[beats[0]] < 0.3 * rmsLocal) beats.shift();
  while (beats.length > 2 && local[beats[beats.length - 1]] < 0.3 * rmsLocal) beats.pop();
  return beats;
}

/** 비트 목록이 너무 듬성하거나 없으면 규칙적인 격자로 보완 */
function fillBeatGrid(beatsSec, bpm, duration) {
  const period = 60 / bpm;
  if (beatsSec.length < 4) {
    const start = beatsSec.length ? beatsSec[0] % period : 0;
    const out = [];
    for (let t = start; t < duration; t += period) out.push(t);
    return out;
  }
  const out = [];
  // 시작 이전 구간을 거꾸로 채움
  for (let t = beatsSec[0] - period; t >= -0.02; t -= period) out.unshift(Math.max(0, t));
  for (let i = 0; i < beatsSec.length; i++) {
    out.push(beatsSec[i]);
    const next = beatsSec[i + 1];
    if (next !== undefined) {
      const gap = next - beatsSec[i];
      const k = Math.round(gap / period);
      for (let j = 1; j < k; j++) out.push(beatsSec[i] + (gap * j) / k);
    }
  }
  for (let t = out[out.length - 1] + period; t < duration - 0.05; t += period) out.push(t);
  return out;
}

function analyzeSamples(samples, priorBpm) {
  const duration = samples.length / SR;
  const { env, low, rms, fps } = onsetFeatures(samples);
  // 하이햇(엇박)에 끌려가지 않도록 저음(킥) onset 을 섞어서 박자를 잡는다.
  const mix = new Float64Array(env.length);
  for (let i = 0; i < env.length; i++) mix[i] = env[i] + low[i];
  const prior = priorBpm && priorBpm > 40 && priorBpm < 220 ? priorBpm : 120;
  let bpm = fixOctave(estimateTempo(mix, fps, prior), priorBpm);
  const beatFrames = trackBeats(mix, fps, bpm);
  // 프레임 시간 = 분석 창의 가운데
  const frameOffset = N_FFT / 2 / SR;
  let beats = beatFrames.map((f) => f / fps + frameOffset);
  // 실제 비트 간격으로 BPM 재계산 (중앙값)
  if (beats.length > 8) {
    const gaps = [];
    for (let i = 1; i < beats.length; i++) gaps.push(beats[i] - beats[i - 1]);
    gaps.sort((a, b) => a - b);
    const g = gaps[Math.floor(gaps.length / 2)];
    if (g > 0.25 && g < 1.2) bpm = 60 / g;
  }
  beats = fillBeatGrid(beats, bpm, duration).filter((t) => t >= 0 && t < duration);

  // 다운비트(마디 첫 박): 4박 위상 중 저음+onset 이 가장 강한 위상
  const at = (arr, t) => {
    const f = Math.round((t - frameOffset) * fps);
    let m = 0;
    for (let k = -2; k <= 2; k++) m = Math.max(m, arr[f + k] || 0);
    return m;
  };
  let bestPhase = 0;
  let bestScore = -Infinity;
  for (let ph = 0; ph < 4; ph++) {
    let s = 0;
    let c = 0;
    for (let i = ph; i < beats.length; i += 4) { s += 1.5 * at(low, beats[i]) + at(env, beats[i]); c++; }
    const score = c ? s / c : 0;
    if (score > bestScore + 1e-9) { bestScore = score; bestPhase = ph; }
  }
  const downbeats = [];
  for (let i = bestPhase; i < beats.length; i += 4) downbeats.push(beats[i]);

  // 마디별 에너지
  const bars = [];
  const marks = [0, ...downbeats.filter((t) => t > 0.05), duration];
  for (let i = 0; i < marks.length - 1; i++) {
    const a = marks[i];
    const b = marks[i + 1];
    if (b - a < 0.05) continue;
    let s = 0;
    let c = 0;
    for (let f = Math.max(0, Math.floor((a - frameOffset) * fps)); f < Math.min(rms.length, Math.ceil((b - frameOffset) * fps)); f++) { s += rms[f]; c++; }
    bars.push({ start: round3(a), end: round3(b), energy: c ? s / c : 0 });
  }
  const maxE = Math.max(1e-9, ...bars.map((b) => b.energy));
  for (const b of bars) {
    b.energy = round3(b.energy / maxE);
    b.level = b.energy > 0.75 ? 'high' : b.energy > 0.45 ? 'mid' : 'low';
  }
  return {
    duration: round3(duration),
    bpm: Math.round(bpm * 10) / 10,
    beatPeriod: round3(60 / bpm),
    beats: beats.map(round3),
    downbeats: downbeats.map(round3),
    bars,
  };
}

function round3(x) { return Math.round(x * 1000) / 1000; }

module.exports = {
  analyzeSamples, estimateTempo, fixOctave, SR,
  N_FFT, HOP, fftInPlace, onsetFeatures, normalizeEnv, normEnv: normalizeEnv, trackBeats, fillBeatGrid,
};
