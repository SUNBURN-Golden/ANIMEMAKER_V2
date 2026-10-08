'use strict';
// 가사 정리 (src/main/media/lyrics.js): 줄 앞 태그 · 단어 시간표시 · 숨기는 줄 · 줄 수 세기 · 줄 → 원문
const test = require('node:test');
const assert = require('node:assert');
const { parseLyrics, sectionSummary, cleanLyricText, countLyricLines, lyricStats, linesToRaw, LINE_BREAK } = require('../src/main/media/lyrics');

const texts = (p) => p.lines.map((l) => l.text);

test("'[Intro] 반짝' → 태그는 구간 표시로, 글은 '반짝'", () => {
  const p = parseLyrics('[Intro] 반짝');
  assert.deepStrictEqual(texts(p), ['반짝']);
  assert.strictEqual(p.lines[0].section, 'Intro');
  assert.strictEqual(p.lines[0].sectionStart, true);
  assert.ok(!p.lines[0].hidden);
  assert.deepStrictEqual(p.sections, ['Intro']);
  // 여러 줄: 태그가 붙은 줄부터 새 구간
  const q = parseLyrics('[Verse 1] 첫 줄\n둘째 줄\n[Chorus] 후렴 줄\n다음 줄');
  assert.deepStrictEqual(texts(q), ['첫 줄', '둘째 줄', '후렴 줄', '다음 줄']);
  assert.deepStrictEqual(q.lines.map((l) => l.section), ['Verse 1', 'Verse 1', 'Chorus', 'Chorus']);
  assert.deepStrictEqual(q.lines.map((l) => l.sectionStart), [true, false, true, false]);
  // 태그가 여러 개: 앞의 구간 태그 + (태그)
  assert.deepStrictEqual(texts(parseLyrics('[Verse 1] (Oh oh) 첫 줄')), ['첫 줄']);
  assert.deepStrictEqual(texts(parseLyrics('(Chorus) 랄랄라')), ['랄랄라'], '(태그) 도 글이 뒤따르면 뗀다');
  assert.deepStrictEqual(texts(parseLyrics('【후렴】 달려가')), ['달려가']);
  // 시간표시 모양 [00:12] 는 구간이 아니다
  const t = parseLyrics('[00:12.50] 텍스트 안의 시간');
  assert.deepStrictEqual(texts(t), ['텍스트 안의 시간']);
  assert.strictEqual(t.lines[0].section, '');
  // 줄 전체가 [태그] 이면 예전처럼 구간 표시일 뿐 줄이 아니다 (이전 동작 그대로)
  const w = parseLyrics('[Intro]\n\n[Verse 1]\n비가 내리던 밤\n[Outro]');
  assert.deepStrictEqual(texts(w), ['비가 내리던 밤']);
  assert.strictEqual(w.lines[0].gapBefore, 1);
  assert.strictEqual(w.trailingGaps, 1);
  // 글 가운데의 [..] 는 건드리지 않는다
  assert.deepStrictEqual(texts(parseLyrics('너를 [사랑해] 정말로')), ['너를 [사랑해] 정말로']);
});

test("'(Chorus)' · ♪ 만 · x2 만 있는 줄은 hidden:true (줄은 남는다)", () => {
  const one = (s) => parseLyrics(s).lines[0];
  for (const s of ['(Chorus)', '(oh oh)', '（후렴）', '♪', '♪ ♫ ♬', '♪♪♪', '🎵', 'x2', 'X2', '×2', '(x2)', '[x2]', '2x']) {
    const l = one(s);
    assert.ok(l && l.hidden === true, `${s} → hidden`);
    assert.ok(l.text, `${s}: 글은 남는다 (회색으로 보이게)`);
  }
  // 보통 줄에는 hidden 이 없다
  for (const s of ['반짝반짝', 'La la la', 'x 2 번 불러요', 'Box2', 'mix2 tape']) assert.ok(!one(s).hidden, s);
  // 이전 테스트가 보던 모양 그대로: (oh oh) 도 줄로 남는다
  const a = parseLyrics('[Verse 1]\n비가 내리던 밤\n**우산** 없이\n(oh oh)\n[Chorus]\n달려가');
  assert.deepStrictEqual(texts(a), ['비가 내리던 밤', '우산 없이', '(oh oh)', '달려가']);
  assert.deepStrictEqual(a.lines.map((l) => !!l.hidden), [false, false, true, false]);
  // 요약(기획 AI 에게 알려 줄 가사)에는 숨긴 줄이 빠진다
  assert.doesNotMatch(sectionSummary(a), /oh oh/);
  assert.match(sectionSummary(a), /\[Chorus\]\n달려가/);
  assert.strictEqual(sectionSummary(parseLyrics('(Chorus)\n♪')), '(가사 없음 - 연주곡)');
});

test("'♪ 랄랄라 ♪' → 양쪽 ♪ 를 떼고 '랄랄라' (보이는 줄), 끝의 x2 같은 반복 표시도 뗀다", () => {
  assert.deepStrictEqual(texts(parseLyrics('♪ 랄랄라 ♪')), ['랄랄라']);
  assert.ok(!parseLyrics('♪ 랄랄라 ♪').lines[0].hidden);
  assert.deepStrictEqual(texts(parseLyrics('♫♫ 안녕 ♬')), ['안녕']);
  for (const s of ['너를 찾아 달려가 x2', '너를 찾아 달려가 X2', '너를 찾아 달려가 ×2', '너를 찾아 달려가 (x2)', '너를 찾아 달려가(x2)', '너를 찾아 달려가 [x2]', '너를 찾아 달려가 2x', '너를 찾아 달려가 x 2', '너를 찾아 달려가 ♪ x2 ♪']) {
    const l = parseLyrics(s).lines[0];
    assert.strictEqual(l.text, '너를 찾아 달려가', s);
    assert.ok(!l.hidden, s);
  }
  // 글자에 붙은 x2 · 영어 단어는 그대로
  assert.strictEqual(parseLyrics('Box2').lines[0].text, 'Box2');
  assert.strictEqual(parseLyrics('I want 2 apples').lines[0].text, 'I want 2 apples');
  assert.strictEqual(parseLyrics('see you x tomorrow').lines[0].text, 'see you x tomorrow');
  // 줄 안 억지 줄바꿈 표시(⏎) → '\n'
  assert.strictEqual(parseLyrics(`첫째 ${LINE_BREAK} 둘째`).lines[0].text, '첫째\n둘째');
  assert.strictEqual(cleanLyricText('**굵게** __밑줄__').text, '굵게 밑줄');
});

test('향상된 LRC <00:03.00>첫 <00:03.50>줄 → 글에서는 빼고 words 로 보관', () => {
  const p = parseLyrics('[00:03.00]<00:03.00>첫 <00:03.50>줄\n[00:07.00]둘째 <00:07.40>줄\n[00:10.00]셋째', 'a.lrc');
  assert.strictEqual(p.source, 'lrc');
  assert.deepStrictEqual(texts(p), ['첫 줄', '둘째 줄', '셋째']);
  assert.ok(!/[<>]/.test(p.timed.map((t) => t.text).join('')), '글에 <..> 가 남지 않는다');
  assert.deepStrictEqual(p.timed[0].words, [{ text: '첫', start: 3, end: 3.5 }, { text: '줄', start: 3.5, end: 6.95 }]);
  assert.deepStrictEqual(p.timed[1].words, [{ text: '둘째', start: 7, end: 7.4 }, { text: '줄', start: 7.4, end: 9.95 }]);
  assert.strictEqual(p.timed[2].words, undefined);
  assert.strictEqual(p.timed[0].start, 3);
  assert.strictEqual(p.timed[0].end, 6.95);
  // 음절 단위 (공백 없이)
  const q = parseLyrics('[00:01.00]<00:01.00>안<00:01.20>녕<00:01.40>하<00:01.60>세<00:01.80>요\n[00:03.00]끝\n[00:04.00]끝2', 'a.lrc');
  assert.strictEqual(q.timed[0].text, '안녕하세요');
  assert.deepStrictEqual(q.timed[0].words.map((w) => w.text), ['안', '녕', '하', '세', '요']);
  assert.strictEqual(q.timed[0].words[4].end, q.timed[0].end, '마지막 단어의 끝은 줄 끝');
  // 시간표시가 줄 앞에 하나만 있고 단어 시간은 없는 보통 LRC 는 그대로
  const r = parseLyrics('[ar:x]\n[00:12.30]첫 줄\n[00:15.8]둘째 줄', 'x.lrc');
  assert.deepStrictEqual(r.timed.map((t) => t.start), [12.3, 15.8]);
  assert.strictEqual(r.timed[0].words, undefined);
  // 한 줄에 시간표시가 여러 개인 LRC(후렴 반복)는 단어를 붙이지 않는다
  const s = parseLyrics('[00:10.00][00:50.00]후렴 <00:10.50>줄\n[00:20.00]다음\n[00:30.00]다다음', 'a.lrc');
  assert.deepStrictEqual(s.timed.filter((t) => t.text === '후렴 줄').map((t) => t.start), [10, 50]);
  assert.ok(s.timed.every((t) => !t.words));
  // 일반 글에 섞인 <..> 도 글에서는 빠진다
  assert.strictEqual(parseLyrics('가 <00:01.00>나').lines[0].text, '가 나');
  // LRC 안의 숨김 · 태그
  const u = parseLyrics('[00:01.00](Chorus)\n[00:05.00]♪ 랄라 ♪\n[00:09.00][Verse 2] 둘째 절', 'a.lrc');
  assert.deepStrictEqual(u.timed.map((t) => [t.text, !!t.hidden]), [['(Chorus)', true], ['랄라', false], ['둘째 절', false]]);
  assert.strictEqual(u.timed[2].section, 'Verse 2');
  assert.deepStrictEqual(u.lines.map((l) => !!l.hidden), [true, false, false]);
});

test('SRT 도 같은 정리 (HTML 태그 · 시간표시 · 숨김)', () => {
  const srt = '1\n00:00:01,000 --> 00:00:03,500\n<i>안녕</i> <00:00:02.00>하세요\n\n2\n00:00:04,000 --> 00:00:06,000\n(후렴)\n\n3\n00:00:07,000 --> 00:00:09,000\n[Verse] 둘째 x2\n';
  const p = parseLyrics(srt);
  assert.strictEqual(p.source, 'srt');
  assert.deepStrictEqual(p.timed.map((t) => t.text), ['안녕 하세요', '(후렴)', '둘째']);
  assert.deepStrictEqual(p.timed.map((t) => !!t.hidden), [false, true, false]);
  assert.deepStrictEqual(p.timed[0], { text: '안녕 하세요', start: 1, end: 3.5 });
});

test('countLyricLines / lyricStats: 홈 화면의 "N줄" — 파서와 같은 규칙, 화면에 나오는 줄만', () => {
  assert.strictEqual(countLyricLines(''), 0);
  assert.strictEqual(countLyricLines('   \n \n'), 0);
  assert.strictEqual(countLyricLines(undefined), 0);
  assert.strictEqual(countLyricLines('가\n나\n다'), 3);
  assert.strictEqual(countLyricLines('[Verse 1]\n가\n나\n\n[Chorus]\n다\n[Outro]'), 3, '구간 태그 줄은 세지 않는다');
  assert.strictEqual(countLyricLines('[Intro] 반짝\n(Chorus)\n♪\nx2\n♪ 랄랄라 ♪\n너를 찾아 x2'), 3, '숨기는 줄은 세지 않는다');
  assert.strictEqual(countLyricLines('[00:01.00]가\n[00:02.00]나\n[00:03.00]다', 'a.lrc'), 3);
  assert.strictEqual(countLyricLines('1\n00:00:01,000 --> 00:00:02,000\n가\n\n2\n00:00:03,000 --> 00:00:04,000\n나\n'), 2);
  assert.deepStrictEqual(lyricStats('가\n(oh)\n나'), { total: 3, visible: 2, hidden: 1, timed: false });
  assert.deepStrictEqual(lyricStats('[00:01.00]가\n[00:02.00]나\n[00:03.00]다', 'a.lrc').timed, true);
  // 파서와 같은 수
  const sample = '[Verse 1]\n하나\n(둘)\n♪\n셋 x2\n[Chorus] 넷\n다섯';
  assert.strictEqual(countLyricLines(sample), parseLyrics(sample).lines.filter((l) => !l.hidden).length);
});

test('linesToRaw: 줄 목록 → 원문 (구간 태그 · 억지 줄바꿈 · 숨긴 글) 이고 다시 읽어도 같다', () => {
  const lines = [
    { text: '첫 줄', section: 'Verse 1', sectionStart: true },
    { text: '둘째 줄\n이어서', section: 'Verse 1', sectionStart: false },
    { text: '(후렴)', section: 'Chorus', sectionStart: true, hidden: true },
    { text: '후렴 줄', section: 'Chorus', sectionStart: false },
    { text: '구간 없는 줄', section: '' },
  ];
  const raw = linesToRaw(lines);
  assert.strictEqual(raw, `[Verse 1]\n첫 줄\n둘째 줄${LINE_BREAK}이어서\n\n[Chorus]\n(후렴)\n후렴 줄\n구간 없는 줄`);
  const back = parseLyrics(raw);
  assert.deepStrictEqual(texts(back), ['첫 줄', '둘째 줄\n이어서', '(후렴)', '후렴 줄', '구간 없는 줄']);
  assert.deepStrictEqual(back.lines.map((l) => l.section), ['Verse 1', 'Verse 1', 'Chorus', 'Chorus', 'Chorus']);
  assert.deepStrictEqual(back.lines.map((l) => !!l.hidden), [false, false, true, false, false], '(후렴) 은 다시 읽어도 숨김');
  assert.strictEqual(linesToRaw([]), '');
  assert.strictEqual(linesToRaw(null), '');
  // 구간 표시가 없어도 구간 이름이 바뀌면 태그를 넣는다
  assert.strictEqual(linesToRaw([{ text: 'a', section: 'A' }, { text: 'b', section: 'B' }]), '[A]\na\n\n[B]\nb');
});
