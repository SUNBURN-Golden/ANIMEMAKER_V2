'use strict';
// 가사 줄 편집의 순수 계산 (러너·화면 없이 테스트할 수 있다) — DESIGN §2.2
//  - mergeLyricLines : 가사 글이 바뀌어 줄 수가 달라져도 맞춰 둔 시간을 최대한 지킨다 (글을 비교해서 같은 줄을 찾기)
//  - cleanLyricLines : 줄 편집기에서 온 줄 목록을 검사해 정리한다 (빈 줄 버림 · 시간 순 · 끝 > 시작 · 노래 길이 안)
//  - relinkSegments  : 컷이 어떤 가사 줄과 겹치는지 다시 계산
// ProjectRunner.prototype 에는 섞이지 않는다 (pipeline/subs.js 가 이 파일을 불러 쓴다).

const round2 = (x) => Math.round(x * 100) / 100;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const MIN_GAP = 0.3; // 두 줄 시작 사이 최소 간격 (lyricsync.js 와 같다)
const MAX_HOLD = 7; // 자동으로 정하는 줄 길이 상한 (초)
const SIM_MIN = 0.5; // 고친 글로 보고 같은 줄로 묶을 최소 닮은 정도

/** 비교용으로 글을 단순하게: 소문자, 공백·문장부호·기호 제거 */
function normText(t) {
  return String(t == null ? '' : t).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function lcsLen(a, b) {
  if (!a.length || !b.length) return 0;
  let prev = new Uint16Array(b.length + 1);
  let cur = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    const t = prev; prev = cur; cur = t;
  }
  return prev[b.length];
}
/** 두 글이 얼마나 닮았나 (0~1). 글자 단위 가장 긴 공통 부분열 기준 */
function similarity(a, b) {
  if (!a || !b) return 0;
  return (2 * lcsLen(a, b)) / (a.length + b.length);
}

/** 문자열 배열 두 개의 가장 긴 공통 부분열 → [[i, j], …]. 빈 문자열끼리는 같다고 보지 않는다 */
function lcsPairs(A, B) {
  const n = A.length;
  const m = B.length;
  const eq = (i, j) => A[i] !== '' && A[i] === B[j];
  if (n * m > 4e6) {
    // 아주 큰 가사: 앞뒤에서 같은 줄만 묶는다
    const pairs = [];
    let i = 0;
    while (i < n && i < m && eq(i, i)) { pairs.push([i, i]); i++; }
    let a = n - 1;
    let b = m - 1;
    const tail = [];
    while (a >= i && b >= i && eq(a, b)) { tail.push([a, b]); a--; b--; }
    return pairs.concat(tail.reverse());
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = eq(i, j) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (eq(i, j)) { pairs.push([i, j]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return pairs;
}

/** 같은 줄 사이(앵커 사이) 빈 곳에서, 고친 글끼리 닮은 정도가 높은 것을 순서대로 짝짓기 */
function alignGap(A, B, o0, o1, n0, n1, out) {
  const R = o1 - o0;
  const C = n1 - n0;
  if (R <= 0 || C <= 0 || R * C > 40000) return; // 아주 큰 빈 곳(가사를 통째로 바꾼 경우)은 닮은 줄을 찾지 않는다
  const sim = [];
  for (let r = 0; r < R; r++) {
    sim.push([]);
    for (let c = 0; c < C; c++) {
      const s = similarity(A[o0 + r], B[n0 + c]);
      sim[r].push(s >= SIM_MIN ? s : 0);
    }
  }
  const best = Array.from({ length: R + 1 }, () => new Float64Array(C + 1));
  for (let r = R - 1; r >= 0; r--) {
    for (let c = C - 1; c >= 0; c--) {
      best[r][c] = Math.max(best[r + 1][c], best[r][c + 1], sim[r][c] > 0 ? best[r + 1][c + 1] + sim[r][c] : 0);
    }
  }
  let r = 0;
  let c = 0;
  while (r < R && c < C) {
    if (sim[r][c] > 0 && Math.abs(best[r][c] - (best[r + 1][c + 1] + sim[r][c])) < 1e-6) { out.push({ o: o0 + r, n: n0 + c, exact: false }); r++; c++; } else if (best[r + 1][c] >= best[r][c + 1]) r++; else c++;
  }
}

/**
 * 옛 가사 줄과 새 가사 줄 짝짓기.
 * 1) 글이 똑같은 줄(정규화 기준)을 순서대로 가장 길게 묶고 (LCS)  2) 그 사이에 남은 줄은 닮은 것끼리(고친 글) 묶는다.
 * @param {string[]} oldTexts @param {string[]} newTexts
 * @returns {{o:number, n:number, exact:boolean}[]} n 순서
 */
function matchLines(oldTexts, newTexts) {
  const A = oldTexts.map(normText);
  const B = newTexts.map(normText);
  const anchors = lcsPairs(A, B);
  const pairs = anchors.map(([o, n]) => ({ o, n, exact: true }));
  let po = 0;
  let pn = 0;
  const fuzzy = [];
  for (const [o, n] of [...anchors, [A.length, B.length]]) {
    alignGap(A, B, po, o, pn, n, fuzzy);
    po = o + 1;
    pn = n + 1;
  }
  return pairs.concat(fuzzy).sort((x, y) => x.n - y.n);
}

function nearestBeat(beats, t) {
  if (!beats || !beats.length) return t;
  let best = beats[0];
  for (const b of beats) if (Math.abs(b - t) < Math.abs(best - t)) best = b;
  return best;
}

/**
 * 가사 글이 바뀌어 줄 수가 달라졌을 때, 맞춰 둔 시간을 지키면서 새 줄 목록을 만든다.
 * - 글이 같은(또는 조금 고친) 줄: 시작·끝(·endLocked) 그대로.
 * - 새로 생긴 줄: 이웃 줄 시작 사이를 나눠서 시작 시간을 정하고 가장 가까운 박자에 맞춘다.
 * - 없어진 줄의 맞춘 시간은 사라진다 → lost 로 알려 준다.
 * @param {{text:string,start:number,end:number,hidden?:boolean,endLocked?:boolean,words?:any[]}[]} prev 지금 timing.lyrics
 * @param {{text:string,section?:string,sectionStart?:boolean,hidden?:boolean}[]} news 새로 읽은 가사 줄 (parseLyrics 의 lines)
 * @param {{beats?:number[], duration?:number}} [ctx]
 * @returns {{lyrics:object[], matched:number, added:number, lost:number}}
 */
function mergeLyricLines(prev, news, ctx = {}) {
  const duration = Number(ctx.duration) > 0 ? Number(ctx.duration) : 0;
  const beats = ctx.beats || [];
  const pairs = matchLines(prev.map((l) => l.text), news.map((l) => l.text));
  const byNew = new Map(pairs.map((p) => [p.n, p]));
  const out = news.map((nl, j) => {
    const p = byNew.get(j);
    const l = { text: nl.text, part: 1, start: NaN, end: NaN, section: nl.section || '', sectionStart: !!nl.sectionStart };
    let hidden = nl.hidden;
    if (p) {
      const ol = prev[p.o];
      l.start = ol.start;
      l.end = ol.end;
      if (ol.endLocked) l.endLocked = true;
      if (p.exact) {
        if (ol.hidden !== undefined) hidden = ol.hidden;
        if (ol.words) l.words = ol.words;
      }
      l.matched = true;
    }
    if (hidden === true) l.hidden = true;
    else if (hidden === false && p && p.exact) l.hidden = false;
    return l;
  });

  // 새 줄 묶음(연속한 새 줄)마다 시작 시간 나눠 정하기
  let j = 0;
  while (j < out.length) {
    if (out[j].matched) { j++; continue; }
    let k = j;
    while (k < out.length && !out[k].matched) k++;
    const m = k - j;
    const left = j > 0 ? out[j - 1] : null;
    const right = k < out.length ? out[k] : null;
    const starts = [];
    if (left && right) {
      // 앞 줄이 끝난 뒤 빈 틈에 줄마다 0.8초 넘게 들어가면 그 틈에 나눠 놓는다 (앞 줄의 끝은 그대로).
      // 틈이 좁으면 두 줄의 시작 사이를 나눈다 (앞 줄 끝은 새 줄 시작 직전으로 줄어든다).
      const gap = right.start - (Number.isFinite(left.end) ? left.end : left.start);
      const from = gap >= 0.8 * m + 0.2 ? left.end : left.start;
      const to = right.start;
      for (let q = 1; q <= m; q++) starts.push(from + ((to - from) * q) / (m + 1));
    } else if (right) {
      const t0 = Math.max(0, right.start - 3.5 * m);
      for (let q = 0; q < m; q++) starts.push(t0 + ((right.start - t0) * q) / m);
    } else {
      const base = left ? Math.max(left.start + 0.5, (Number.isFinite(left.end) ? left.end : left.start) + 0.3) : 0.5;
      const room = duration ? Math.max(0.8 * m, duration - 0.5 - base) : 3.5 * m;
      const step = clamp(room / m, 0.8, 3.5);
      for (let q = 0; q < m; q++) starts.push(base + step * q);
    }
    let prevStart = left ? left.start : -Infinity;
    for (let q = 0; q < m; q++) {
      let s = nearestBeat(beats, starts[q]);
      s = Math.max(s, prevStart + MIN_GAP);
      if (right) s = Math.min(s, right.start - MIN_GAP * (m - q));
      s = Math.max(s, prevStart + 0.1);
      if (duration) s = Math.min(s, Math.max(0, duration - 0.3));
      out[j + q].start = round2(Math.max(0, s));
      prevStart = out[j + q].start;
    }
    j = k;
  }

  // 끝 시간 정리: 새 줄은 다음 줄 시작 직전까지(최대 7초), 겹치는 줄은 다음 줄 시작 직전으로
  for (let i = 0; i < out.length; i++) {
    const l = out[i];
    const next = out[i + 1];
    const limit = next ? next.start - 0.05 : (duration ? duration - 0.1 : l.start + MAX_HOLD);
    if (!Number.isFinite(l.end)) {
      l.end = round2(limit - l.start >= 0.3 ? Math.min(limit, l.start + MAX_HOLD) : l.start + 0.3);
    } else if (l.end > limit && limit > l.start + 0.1) l.end = round2(limit);
    if (!(l.end > l.start)) l.end = round2(l.start + 0.3);
    delete l.matched;
  }
  return { lyrics: out, matched: pairs.length, added: out.length - pairs.length, lost: prev.length - pairs.length };
}

/**
 * 줄 편집기에서 온 줄 목록 정리.
 * 글(억지 줄바꿈 '\n' 은 유지) · 시작 · 끝 · hidden · endLocked · section · sectionStart 를 받는다.
 * 빈 글은 버리고, 시작 시간 순으로 세우고, 끝 > 시작을 지키며, 노래 길이 안으로 자른다.
 * 끝이 없거나 잘못된 줄은 다음 줄 시작 직전까지(최대 7초)로 정한다. 다음 줄과 겹치면 다음 줄 시작 직전으로 줄인다.
 * @param {object[]} input
 * @param {{duration?:number, prev?:object[]}} [o] prev = 지금 timing.lyrics (단어 시간 words 를 글이 그대로일 때만 이어받는다)
 * @returns {{text:string,part:number,start:number,end:number,section:string,sectionStart:boolean,hidden?:boolean,endLocked?:boolean,words?:any[]}[]}
 */
function cleanLyricLines(input, o = {}) {
  if (!Array.isArray(input)) throw new Error('가사 줄 목록이 올바르지 않아요.');
  const duration = Number(o.duration) > 0 ? Number(o.duration) : 0;
  const prev = o.prev || [];
  const rows = [];
  let lastEnd = 0;
  input.forEach((raw, idx) => {
    if (!raw || typeof raw !== 'object') return;
    const text = String(raw.text == null ? '' : raw.text)
      .replace(/\r/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .split('\n').map((p) => p.replace(/[ \t　]+/g, ' ').trim()).filter(Boolean).join('\n')
      .slice(0, 400);
    if (!text) return;
    let start = Number(raw.start);
    if (!Number.isFinite(start)) start = lastEnd;
    start = clamp(start, 0, duration ? Math.max(0, duration - 0.1) : 36000);
    const endIn = Number(raw.end);
    rows.push({ idx, raw, text, start, endIn: Number.isFinite(endIn) && endIn > start ? endIn : NaN });
    lastEnd = Number.isFinite(endIn) && endIn > start ? endIn : start + 0.5;
  });
  rows.sort((a, b) => a.start - b.start || a.idx - b.idx);
  let lastSection = '';
  const out = rows.map((r, i) => {
    const next = rows[i + 1];
    const limit = next ? next.start - 0.05 : (duration ? duration - 0.05 : Infinity);
    let end = r.endIn;
    if (!Number.isFinite(end)) end = limit - r.start >= 0.3 ? Math.min(limit, r.start + MAX_HOLD) : r.start + 0.3;
    else if (end > limit && limit > r.start + 0.1) end = limit;
    if (duration) end = Math.min(end, duration);
    if (!(end > r.start)) end = r.start + 0.1;
    const rawSec = typeof r.raw.section === 'string' ? r.raw.section.trim().slice(0, 40) : null;
    const section = rawSec !== null ? rawSec : lastSection;
    if (section) lastSection = section;
    const line = {
      text: r.text, part: 1, start: round2(r.start), end: round2(end), section,
      sectionStart: r.raw.sectionStart === true || (r.raw.sectionStart === undefined && i === 0 && !!section),
    };
    if (typeof r.raw.hidden === 'boolean') line.hidden = r.raw.hidden;
    if (r.raw.endLocked === true) line.endLocked = true;
    // 단어 시간은 글과 시작 시간이 그대로일 때만 이어받는다
    const same = prev.find((p) => p.words && p.text === r.text && Math.abs(p.start - line.start) < 0.01);
    if (same) line.words = same.words;
    return line;
  });
  return out;
}

/**
 * 줄 편집기에서 저장할 때 '맞춘 시간이 사라지는' 줄 수: 옛 줄 중 새 목록에서 시작 시간이 같은 줄도, 글이 같은(닮은) 줄도 없는 것.
 * (글을 고친 줄은 시작 시간이 그대로면 사라진 게 아니다. 지우거나 합쳐서 없어진 줄만 센다)
 */
function lostCount(prev, next) {
  const left = [];
  const used = new Set();
  prev.forEach((o, i) => {
    const j = next.findIndex((n, k) => !used.has(k) && Math.abs(n.start - o.start) < 0.02);
    if (j >= 0) used.add(j); else left.push(i);
  });
  const rest = next.map((n, k) => ({ n, k })).filter((x) => !used.has(x.k));
  const pairs = matchLines(left.map((i) => prev[i].text), rest.map((x) => x.n.text));
  return left.length - pairs.length;
}

/** 컷(segments[].lyrics)이 가리키는 가사 줄 번호를 다시 계산 (겹치는 시간이 0.25초보다 길고, 숨긴 줄은 뺀다) */
function relinkSegments(segments, lyrics) {
  if (!Array.isArray(segments)) return;
  for (const s of segments) {
    const idx = [];
    lyrics.forEach((l, i) => {
      if (l.hidden) return;
      if (Math.min(s.end, l.end) - Math.max(s.start, l.start) > 0.25) idx.push(i);
    });
    s.lyrics = idx;
  }
}

module.exports = { normText, similarity, matchLines, mergeLyricLines, cleanLyricLines, lostCount, relinkSegments, nearestBeat, MIN_GAP, MAX_HOLD };
