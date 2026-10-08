'use strict';
// 업로드한 가사 읽기
//  - Suno 가사: [Verse 1], [Chorus] 같은 구간 태그 + 가사 줄
//  - .lrc: [01:23.45]가사   (시간이 있어서 싱크가 바로 맞음)
//  - .srt: 자막 파일        (시간이 있어서 싱크가 바로 맞음)
// 가사 정리 (DESIGN §2.2): 줄 앞의 [태그]/(태그) 는 글이 뒤따르면 떼어 내고(대괄호 태그는 구간 시작으로 기억),
//  <mm:ss.xx> 단어 시간 표시는 글에서 빼고 words 로 보관, ♪ 만 / (…) 만 / x2 만 있는 줄은 hidden:true (화면에 안 나옴),
//  글 끝의 x2 같은 반복 표시와 양쪽 ♪ 는 뗀다. 한 줄 안의 억지 줄바꿈은 ⏎ 로 적는다 (읽을 때 '\n' 이 된다).

// Suno 는 [Verse 1] 처럼 대괄호로 구간을 적는다. (괄호 줄은 코러스·추임새 가사로 본다)
const SECTION_RE = /^\s*[[【]\s*([^\]】]{1,40})\s*[\]】]\s*$/;
const LRC_RE = /^\s*((?:\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\])+)(.*)$/;
const LRC_TAG_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const SRT_TIME_RE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

/** 구간 이름 중 가사가 없는 구간(간주 등) */
const INSTRUMENTAL_RE = /(intro|outro|instrumental|inst|interlude|break|solo|drop|간주|전주|후주|인트로|아웃트로)/i;

/** 한 줄 안에서 억지 줄바꿈을 나타내는 글자 (줄 하나를 두 줄로 보여 주고 싶을 때) */
const LINE_BREAK = '⏎';

function cleanLine(s) {
  return String(s)
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*⏎\s*/g, '\n')
    .trim();
}

const STAMP_RE = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g; // 향상된 LRC 의 단어 시간: <00:03.50>
const MUSIC_SYMBOLS = '♪♫♬♩🎵🎶';
const MUSIC_EDGE_RE = new RegExp(`^[\\s${MUSIC_SYMBOLS}]+|[\\s${MUSIC_SYMBOLS}]+$`, 'gu');
const LEAD_BRACKET_RE = /^[[【]\s*([^\]】]{1,40}?)\s*[\]】]\s*(\S[\s\S]*)$/;
const LEAD_PAREN_RE = /^[(（]\s*([^)）]{1,40}?)\s*[)）]\s*(\S[\s\S]*)$/;
const TIMESTAMP_TAG_RE = /^\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?$/;
const REPEAT_WORD = '(?:[x×X]\\s*\\d{1,2}|\\d{1,2}\\s*[x×X])';
const REPEAT_BRACKET_RE = new RegExp(`\\s*[(\\[（]\\s*${REPEAT_WORD}\\s*[)\\]）]\\s*$`);
const REPEAT_PLAIN_RE = new RegExp(`(?:^|\\s+)${REPEAT_WORD}\\s*$`);
const WHOLE_PAREN_RE = /^[(（][\s\S]*[)）]$/;
const REPEAT_ONLY_RE = new RegExp(`^${REPEAT_WORD}$`);

/**
 * 가사 한 줄의 글을 정리한다.
 * @param {string} raw 줄 글 (구간 태그만 있는 줄은 이 함수로 오기 전에 걸러진다)
 * @param {{lineStart?:number|null}} [o] LRC 줄이면 그 줄의 시작 시간 (단어 시간 계산용)
 * @returns {{text:string, hidden:boolean, tag:string, words:{text:string,start:number,end:number|null}[]|null}}
 *   tag = 줄 앞의 [구간 태그](있으면). words = <mm:ss.xx> 로 나눈 단어들(없으면 null, 마지막 단어 end 는 null — 호출한 쪽이 줄 끝으로 채운다).
 */
function cleanLyricText(raw, o = {}) {
  let s = cleanLine(raw);
  // 1) 단어 시간 표시를 글에서 빼고 단어 목록으로 보관
  let words = null;
  STAMP_RE.lastIndex = 0;
  if (STAMP_RE.test(s)) {
    STAMP_RE.lastIndex = 0;
    const stamps = [];
    const pieces = [];
    let last = 0;
    let m;
    while ((m = STAMP_RE.exec(s))) {
      pieces.push(s.slice(last, m.index));
      stamps.push(Number(m[1]) * 60 + Number(m[2]) + frac(m[3]));
      last = m.index + m[0].length;
    }
    pieces.push(s.slice(last));
    const ws = [];
    let t = Number.isFinite(o.lineStart) ? o.lineStart : stamps[0];
    pieces.forEach((piece, i) => {
      const txt = piece.trim();
      if (txt) ws.push({ text: txt, start: round2(t), end: null });
      if (i < stamps.length) t = stamps[i];
    });
    for (let i = 0; i < ws.length - 1; i++) ws[i].end = ws[i + 1].start;
    if (ws.length) words = ws;
    s = cleanLine(pieces.join(''));
  }
  // 2) 줄 앞의 [태그] · (태그) 떼기 (뒤에 글이 있을 때만)
  let tag = '';
  for (let i = 0; i < 3; i++) {
    let m = LEAD_BRACKET_RE.exec(s);
    if (m) {
      if (!tag && !TIMESTAMP_TAG_RE.test(m[1])) tag = m[1].trim();
      s = m[2].trim();
      continue;
    }
    m = LEAD_PAREN_RE.exec(s);
    if (m) { s = m[2].trim(); continue; }
    break;
  }
  // 3) 양쪽 ♪ 와 끝의 x2 같은 반복 표시 떼기
  const stripped = s.replace(MUSIC_EDGE_RE, '').replace(REPEAT_BRACKET_RE, '').replace(REPEAT_PLAIN_RE, '').replace(MUSIC_EDGE_RE, '').trim();
  // 4) 남은 글이 없거나(♪ 만 · x2 만) 통째로 (…) 이면 화면에 안 나오는 줄
  if (!stripped) return { text: s || cleanLine(raw), hidden: true, tag, words: null };
  if (WHOLE_PAREN_RE.test(stripped)) return { text: stripped, hidden: true, tag, words };
  return { text: stripped, hidden: false, tag, words };
}

function frac(ms) {
  if (!ms) return 0;
  return Number(`0.${ms.padEnd(3, '0').slice(0, 3)}`);
}

function parseLrc(text) {
  const timed = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = LRC_RE.exec(raw);
    if (!m) continue;
    LRC_TAG_RE.lastIndex = 0;
    const starts = [];
    let t;
    while ((t = LRC_TAG_RE.exec(m[1]))) starts.push(Number(t[1]) * 60 + Number(t[2]) + frac(t[3]));
    // 향상된 LRC(<00:03.50> 단어 시간)는 줄이 한 번만 적힌 경우에만 단어로 보관한다
    const c = cleanLyricText(m[2], { lineStart: starts.length === 1 ? starts[0] : null });
    for (const start of starts) {
      const item = { text: c.text, start };
      if (c.hidden) item.hidden = true;
      if (c.words && starts.length === 1) item.words = c.words;
      if (c.tag) item.section = c.tag;
      timed.push(item);
    }
  }
  timed.sort((a, b) => a.start - b.start);
  // 빈 줄 태그는 앞 줄의 끝 시간으로 쓴다
  const out = [];
  for (let i = 0; i < timed.length; i++) {
    if (!timed[i].text) continue;
    const next = timed[i + 1];
    const end = next ? next.start - 0.05 : timed[i].start + 4;
    const line = { text: timed[i].text, start: round2(timed[i].start), end: round2(Math.min(end, timed[i].start + 8)) };
    if (timed[i].hidden) line.hidden = true;
    if (timed[i].words) {
      line.words = timed[i].words.map((w) => ({ text: w.text, start: w.start, end: w.end == null ? line.end : Math.min(w.end, line.end) }));
    }
    if (timed[i].section) line.section = timed[i].section;
    out.push(line);
  }
  return out;
}

function parseSrt(text) {
  const out = [];
  const blocks = text.replace(/\r/g, '').split(/\n\s*\n/);
  for (const b of blocks) {
    const lines = b.split('\n').map((l) => l.trim()).filter(Boolean);
    const ti = lines.findIndex((l) => SRT_TIME_RE.test(l));
    if (ti < 0) continue;
    const m = SRT_TIME_RE.exec(lines[ti]);
    const start = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac(m[4]);
    const end = Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + frac(m[8]);
    const c = cleanLyricText(lines.slice(ti + 1).join(' ').replace(/<[^>]+>/g, ''));
    if (c.text && end > start) {
      const item = { text: c.text, start: round2(start), end: round2(end) };
      if (c.hidden) item.hidden = true;
      out.push(item);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * @param {string} text 가사 원문
 * @param {string} [filename] 파일에서 불러왔다면 파일 이름 (확장자로 형식 판단)
 * @returns {{raw:string, source:'text'|'lrc'|'srt'|'none', lines:{text:string, section:string, sectionStart:boolean, gapBefore?:number, hidden?:boolean}[],
 *   timed:{text:string,start:number,end:number,hidden?:boolean,words?:{text:string,start:number,end:number}[]}[]|null, sections:string[]}}
 *   hidden:true = 화면에 안 나오는 줄(♪ 만 · (…) 만 · x2 만). words = 향상된 LRC 의 단어별 시간(있을 때).
 */
function parseLyrics(text, filename) {
  const raw = String(text || '').replace(/^﻿/, '');
  const ext = (filename || '').toLowerCase().split('.').pop();
  if (!raw.trim()) return { raw: '', source: 'none', lines: [], timed: null, sections: [] };

  const looksSrt = ext === 'srt' || (SRT_TIME_RE.test(raw) && /-->/.test(raw));
  const lrcHits = raw.split(/\r?\n/).filter((l) => LRC_RE.test(l)).length;
  const looksLrc = ext === 'lrc' || lrcHits >= 3;
  if (looksSrt || looksLrc) {
    const timed = looksSrt ? parseSrt(raw) : parseLrc(raw);
    if (timed.length) {
      return {
        raw, source: looksSrt ? 'srt' : 'lrc', timed, sections: [],
        lines: timed.map((t, i) => ({ text: t.text, section: t.section || '', sectionStart: i === 0, ...(t.hidden ? { hidden: true } : {}) })),
      };
    }
  }

  const lines = [];
  const sections = [];
  let section = '';
  let fresh = true;
  let gaps = 0; // 바로 앞에 있던 '가사 없는 구간'(전주·간주) 수
  for (const r of raw.split(/\r?\n/)) {
    const s = r.trim();
    if (!s) continue;
    const sec = SECTION_RE.exec(s);
    if (sec && !REPEAT_ONLY_RE.test(sec[1].trim())) { // [x2] 는 구간이 아니라 반복 표시 → 숨기는 줄
      // 앞 구간이 가사 없이 끝났으면 그 구간은 연주 구간
      if (fresh && section) gaps++;
      section = sec[1].trim();
      sections.push(section);
      fresh = true;
      continue;
    }
    const c = cleanLyricText(s);
    if (!c.text) continue;
    if (c.tag) {
      // '[Intro] 반짝' 처럼 구간 태그가 줄 앞에 붙어 있으면 구간 표시 + 가사 줄로 나눠서 본다
      if (fresh && section) gaps++;
      section = c.tag;
      sections.push(section);
      fresh = true;
    }
    lines.push({ text: c.text, section, sectionStart: fresh, gapBefore: gaps, ...(c.hidden ? { hidden: true } : {}) });
    gaps = 0;
    fresh = false;
  }
  const trailingGaps = gaps + (fresh && section ? 1 : 0);
  return { raw, source: 'text', lines, timed: null, sections, trailingGaps };
}

/** 노래 구조 요약 (오케스트레이터에게 알려 줄 용도). 숨긴 줄(♪ 만 · (…) 만 · x2 만)은 뺀다 */
function sectionSummary(parsed) {
  const shown = parsed && parsed.lines ? parsed.lines.filter((l) => !l.hidden) : [];
  if (!shown.length) return '(가사 없음 - 연주곡)';
  const groups = [];
  for (const l of shown) {
    if (l.sectionStart || !groups.length) groups.push({ section: l.section || '', lines: [] });
    groups[groups.length - 1].lines.push(l.text.replace(/\n/g, ' '));
  }
  return groups.map((g) => `${g.section ? `[${g.section}]` : ''}\n${g.lines.join('\n')}`).join('\n\n').trim();
}

/**
 * 가사 글에서 줄 수 세기 (홈 화면의 'N줄' 표시용). 파서와 똑같은 규칙으로 센다.
 * 화면에 나오는 줄만 센다 (♪ 만 · (…) 만 · x2 만 있는 줄과 구간 태그 줄은 뺀다).
 * @param {string} text 가사 원문 (붙여넣은 글, .lrc/.srt 내용 포함)
 * @param {string} [filename] 파일 이름 (확장자로 형식 판단)
 * @returns {number}
 */
function countLyricLines(text, filename) {
  return lyricStats(text, filename).visible;
}

/** 줄 수 자세히: { total, visible, hidden, timed } (timed = 시간이 들어 있는 .lrc/.srt 인지) */
function lyricStats(text, filename) {
  const p = parseLyrics(text, filename);
  const hidden = p.lines.filter((l) => l.hidden).length;
  return { total: p.lines.length, visible: p.lines.length - hidden, hidden, timed: !!p.timed };
}

/**
 * 줄 목록 → 가사 원문 (구간 태그 포함). 줄 편집기에서 저장할 때 원문(텍스트 칸)이 줄 목록과 어긋나지 않게 다시 만든다.
 * 한 줄 안의 억지 줄바꿈('\n')은 ⏎ 로 적는다 (parseLyrics 가 다시 '\n' 으로 읽는다).
 * @param {{text:string, section?:string, sectionStart?:boolean}[]} lines
 */
function linesToRaw(lines) {
  const out = [];
  let last = '';
  for (const l of lines || []) {
    const sec = (l.section || '').trim();
    if (sec && (l.sectionStart || sec !== last)) {
      if (out.length) out.push('');
      out.push(`[${sec}]`);
    }
    if (sec) last = sec;
    out.push(String(l.text == null ? '' : l.text).replace(/\n/g, LINE_BREAK));
  }
  return out.join('\n');
}

function round2(x) { return Math.round(x * 100) / 100; }

module.exports = { parseLyrics, sectionSummary, INSTRUMENTAL_RE, cleanLyricText, countLyricLines, lyricStats, linesToRaw, LINE_BREAK };
