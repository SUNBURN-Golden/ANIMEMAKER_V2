'use strict';
// 타이밍 설계: 가사 줄 타이밍 추정, 박자/마디에 맞춘 컷(샷) 나누기, 화면전환 길이 계산.

const TRANSITIONS = {
  cut: { label: '컷 (바로 전환)', xfade: null },
  fade: { label: '부드럽게 겹치기', xfade: 'fade' },
  dissolve: { label: '디졸브', xfade: 'dissolve' },
  fadeblack: { label: '검은 화면 거쳐서', xfade: 'fadeblack' },
  flash: { label: '하얀 플래시', xfade: 'fadewhite' },
  slideleft: { label: '왼쪽으로 밀기', xfade: 'slideleft' },
  slideup: { label: '위로 밀기', xfade: 'slideup' },
  wipeleft: { label: '닦아내기', xfade: 'wipeleft' },
  zoomin: { label: '확대하며 전환', xfade: 'zoomin' },
  circleopen: { label: '원형으로 열기', xfade: 'circleopen' },
  pixelize: { label: '픽셀 전환', xfade: 'pixelize' },
  smoothleft: { label: '스무스 슬라이드', xfade: 'smoothleft' },
};

/** 글자 수 기반 '부르는 길이' 가중치 (한글은 글자=음절, 영어는 모음 묶음) */
function syllables(text) {
  const hangul = (text.match(/[가-힣]/g) || []).length;
  const kana = (text.match(/[぀-ヿ一-鿿]/g) || []).length;
  const latinWords = text.replace(/[가-힣぀-ヿ一-鿿]/g, ' ').toLowerCase().match(/[a-z']+/g) || [];
  let latin = 0;
  for (const w of latinWords) latin += Math.max(1, (w.match(/[aeiouy]+/g) || []).length);
  return hangul + kana + latin;
}

function nearest(arr, t) {
  let best = arr[0];
  for (const x of arr) if (Math.abs(x - t) < Math.abs(best - t)) best = x;
  return best;
}

/**
 * 가사 줄 타이밍 자동 추정 (대략).
 * 전주·간주 구간([Intro], [Instrumental] 등)은 몇 마디를 비워 두고,
 * 나머지 시간을 글자 수 비율로 나눈 뒤 박자에 붙인다.
 * 정확한 싱크는 앱의 '탭으로 가사 맞추기' 로 맞춘다.
 * @param {{text:string, part?:number, sectionStart?:boolean, gapBefore?:number}[]} lines
 * @param {{index:number,start:number,end:number}[]} parts
 * @param {{beats:number[],downbeats:number[],beatPeriod:number,duration:number}} analysis
 * @param {{trailingGaps?:number}} [opts]
 */
function estimateLyricTiming(lines, parts, analysis, opts = {}) {
  if (!lines.length) return [];
  const bar = analysis.beatPeriod * 4;
  const start0 = parts.length ? parts[0].start : 0;
  const end0 = parts.length ? parts[parts.length - 1].end : analysis.duration;
  const songLen = end0 - start0;
  const gapBar = 8;
  const gapsBefore = lines.map((l, i) => {
    const g = l.gapBefore || 0;
    if (i === 0) return g ? g * gapBar : 2; // 태그가 없어도 전주 2마디는 비운다
    return g * gapBar;
  });
  const tail = (opts.trailingGaps ? opts.trailingGaps * gapBar : 2);
  let gapSec = (gapsBefore.reduce((a, b) => a + b, 0) + tail) * bar;
  const scale = gapSec > songLen * 0.4 ? (songLen * 0.4) / gapSec : 1;
  gapSec *= scale;
  const weights = lines.map((l) => syllables(l.text) + 3 + (l.sectionStart ? 2 : 0));
  const total = weights.reduce((a, b) => a + b, 0);
  const sing = Math.max(lines.length * 0.8, songLen - gapSec);
  const out = [];
  let acc = start0;
  lines.forEach((l, i) => {
    acc += gapsBefore[i] * bar * scale;
    const grid = l.sectionStart && analysis.downbeats.length ? analysis.downbeats : analysis.beats;
    let st = grid.length ? nearest(grid, acc) : acc;
    if (out.length && st <= out[out.length - 1].start + 0.3) st = acc;
    out.push({ text: l.text, part: l.part || 1, start: round2(Math.max(start0, st)), end: 0 });
    acc += (sing * weights[i]) / total;
  });
  for (let k = 0; k < out.length; k++) {
    const next = out[k + 1];
    const limit = next ? next.start - 0.05 : end0 - 0.1;
    out[k].end = round2(Math.max(out[k].start + 0.8, Math.min(limit, out[k].start + 7)));
  }
  return out;
}

/**
 * 워크플로우의 컷 수는 3~4분 노래 기준이다. 3분보다 짧은 노래는 길이에 맞춰 줄인다
 * (1분짜리 노래를 16컷 넘게 자르면 그림 장수 예산이 너무 잘게 나뉜다).
 */
function scaledCutRange(minClips, maxClips, duration) {
  if (!(duration > 0) || duration >= 180) return { minClips, maxClips };
  const k = duration / 180;
  const lo = Math.max(2, Math.round(minClips * k));
  return { minClips: lo, maxClips: Math.max(lo, Math.round(maxClips * k)) };
}

/**
 * 박자에 맞춘 컷 나누기 (동적계획법).
 * - 컷 경계는 반드시 박자 위에 놓이고, 마디 첫 박·가사 줄 시작·파트 경계를 우대한다.
 * - 각 컷 길이는 minLen~maxLen 초.
 * @returns {{index:number,start:number,end:number,duration:number,beats:number,lyrics:number[],part:number,energy:string}[]}
 */
function segmentSong(analysis, lyrics, parts, opts = {}) {
  const duration = analysis.duration;
  const minClips = opts.minClips ?? 10;
  const maxClips = opts.maxClips ?? 15;
  const minLen = Math.max(1, opts.minLen ?? 1);
  const maxLen = Math.min(30, opts.maxLen ?? 30);
  const pace = opts.pace || 'normal';
  // 컷 수 목표: 빠르게=최대, 보통=중간, 느리게=최소 → 컷 하나의 이상적인 길이
  const targetCount = pace === 'fast' ? maxClips : pace === 'slow' ? minClips : Math.round((minClips + maxClips) / 2);
  const idealLen = opts.idealLen ?? Math.min(maxLen, Math.max(minLen, duration / Math.max(1, targetCount)));

  const beatSet = analysis.beats.filter((t) => t > 0.2 && t < duration - 0.2);
  const cands = [0, ...beatSet, duration];
  const isDown = (t) => analysis.downbeats.some((d) => Math.abs(d - t) < 0.03);
  const lyricStarts = lyrics.map((l) => l.start);
  const sectionStarts = lyrics.filter((l) => l.sectionStart).map((l) => l.start);
  const partStarts = parts.slice(1).map((p) => p.start);
  const cutCost = cands.map((t, i) => {
    if (i === 0 || i === cands.length - 1) return 0;
    let c = 1.2;
    if (isDown(t)) c -= 0.9;
    if (lyricStarts.some((s) => Math.abs(s - t) < 0.12)) c -= 0.8;
    // 구간(벌스→후렴 등)이 바뀌는 곳은 장면 전환하기 가장 좋은 자리
    if (sectionStarts.some((s) => Math.abs(s - t) < analysis.beatPeriod * 0.6)) c -= 1.2;
    if (partStarts.some((s) => Math.abs(s - t) < analysis.beatPeriod * 0.6)) c -= 1.5;
    // 가사 줄 한가운데를 자르는 건 감점
    if (lyrics.some((l) => t > l.start + 0.3 && t < l.end - 0.3)) c += 0.4;
    return c;
  });

  let target = Math.round(duration / idealLen);
  target = Math.max(minClips, Math.min(maxClips, target));
  const feasibleMin = Math.ceil(duration / maxLen);
  const feasibleMax = Math.floor(duration / minLen);
  const kList = [];
  for (let k = minClips; k <= maxClips; k++) if (k >= feasibleMin && k <= feasibleMax) kList.push(k);
  if (!kList.length) kList.push(Math.max(1, Math.min(feasibleMax, Math.max(feasibleMin, target))));

  const segCost = (a, b) => {
    const len = cands[b] - cands[a];
    if (len < minLen - 1e-6 || len > maxLen + 1e-6) return Infinity;
    return ((len - idealLen) / idealLen) ** 2 * 2;
  };

  const n = cands.length;
  const maxK = Math.max(...kList);
  // dp[k][j] = 0 에서 j 까지 k 개 컷으로 나눈 최소 비용
  const dp = Array.from({ length: maxK + 1 }, () => new Float64Array(n).fill(Infinity));
  const from = Array.from({ length: maxK + 1 }, () => new Int32Array(n).fill(-1));
  dp[0][0] = 0;
  for (let k = 1; k <= maxK; k++) {
    for (let j = 1; j < n; j++) {
      for (let i = j - 1; i >= 0; i--) {
        if (cands[j] - cands[i] > maxLen + 1e-6) break;
        if (dp[k - 1][i] === Infinity) continue;
        const c = dp[k - 1][i] + segCost(i, j) + cutCost[j];
        if (c < dp[k][j]) { dp[k][j] = c; from[k][j] = i; }
      }
    }
  }
  let bestK = -1;
  let best = Infinity;
  for (const k of kList) {
    const c = dp[k][n - 1] + 0.8 * Math.abs(k - target);
    if (c < best) { best = c; bestK = k; }
  }
  if (bestK < 0) {
    // 박자로 나눌 수 없는 경우: 균등 분할
    const k = kList[0];
    const out = [];
    for (let i = 0; i < k; i++) out.push([(duration * i) / k, (duration * (i + 1)) / k]);
    return decorate(out, analysis, lyrics, parts);
  }
  const bounds = [];
  for (let k = bestK, j = n - 1; k > 0; k--) {
    const i = from[k][j];
    bounds.unshift([cands[i], cands[j]]);
    j = i;
  }
  return decorate(bounds, analysis, lyrics, parts);
}

function decorate(bounds, analysis, lyrics, parts) {
  return bounds.map(([s, e], idx) => {
    const lyr = [];
    lyrics.forEach((l, i) => {
      const overlap = Math.min(e, l.end) - Math.max(s, l.start);
      if (overlap > 0.25) lyr.push(i);
    });
    const part = (parts.find((p) => s + 0.01 >= p.start && s < p.end) || parts[0] || { index: 1 }).index;
    const bars = analysis.bars.filter((b) => b.start < e && b.end > s);
    const energy = bars.length ? bars.reduce((a, b) => a + b.energy, 0) / bars.length : 0.5;
    return {
      index: idx + 1,
      start: round3(s),
      end: round3(e),
      duration: round3(e - s),
      beats: Math.round((e - s) / analysis.beatPeriod),
      lyrics: lyr,
      part,
      energy: energy > 0.75 ? 'high' : energy > 0.45 ? 'mid' : 'low',
      level: round3(energy),
    };
  });
}

/**
 * 화면전환 정보를 검증하고 초 단위 길이를 붙인다.
 * 전환은 컷 경계(박자) 를 중심으로 겹친다: 앞 클립은 d/2 더 길게, 뒤 클립은 d/2 일찍 시작.
 */
function resolveTransitions(segments, shots, beatPeriod) {
  const res = [];
  for (let i = 0; i < segments.length - 1; i++) {
    const raw = (shots[i] && shots[i].transition_out) || {};
    let type = String(raw.type || 'cut').toLowerCase();
    if (!TRANSITIONS[type]) type = 'cut';
    let beats = Number(raw.beats);
    if (!Number.isFinite(beats)) beats = type === 'cut' ? 0 : 0.5;
    beats = Math.max(0, Math.min(2, beats));
    let dur = TRANSITIONS[type].xfade ? Math.max(0.12, beats * beatPeriod) : 0;
    // 전환이 클립보다 길면 안 된다
    const maxDur = Math.min(segments[i].duration, segments[i + 1].duration) * 0.6;
    dur = Math.min(dur, maxDur);
    if (dur < 0.08) { type = 'cut'; dur = 0; }
    res.push({ type, xfade: TRANSITIONS[type].xfade, duration: round3(dur) });
  }
  return res;
}

function toSrtTime(t) {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(r).padStart(3, '0')}`;
}

function toSrt(lyrics) {
  return lyrics
    .map((l, i) => `${i + 1}\n${toSrtTime(l.start)} --> ${toSrtTime(l.end)}\n${l.text}\n`)
    .join('\n');
}

function toLrc(lyrics, title) {
  const tag = (t) => {
    const m = Math.floor(t / 60);
    const s = (t % 60).toFixed(2).padStart(5, '0');
    return `[${String(m).padStart(2, '0')}:${s}]`;
  };
  return [`[ti:${title || ''}]`, ...lyrics.map((l) => `${tag(l.start)}${l.text}`)].join('\n') + '\n';
}

function round2(x) { return Math.round(x * 100) / 100; }
function round3(x) { return Math.round(x * 1000) / 1000; }

module.exports = {
  TRANSITIONS, syllables, estimateLyricTiming, scaledCutRange, segmentSong, resolveTransitions, toSrt, toLrc,
};
