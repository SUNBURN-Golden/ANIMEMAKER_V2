'use strict';
// 이전 그림(history) · 내 그림으로 바꾸기 · 한국어로 고쳐 달라고 하기 · 되돌리기 (DESIGN §3.2)
// 다 만든 연습 영상 한 편(test/helpers/edit-fixture.js)을 복사해서 쓴다.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { copyFixture } = require('./helpers/edit-fixture');
const EC = require('../src/main/pipeline/edits-core');
const K = require('../src/main/media/keyer');

const abs = (fx, rel) => path.join(fx.dir, rel);
const bytes = (fx, rel) => fs.readFileSync(abs(fx, rel));
const histDir = (fx) => path.join(fx.dir, 'drawings', 'history');
const histFiles = (fx) => (fs.existsSync(histDir(fx)) ? fs.readdirSync(histDir(fx)).sort() : []);

/** 투명한 바탕에 빨간 사각형 하나 (직접 넣는 그림 흉내) */
async function makeUserPng(file, w = 640, h = 360, color = [220, 40, 40]) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = Math.round(h * 0.2); y < Math.round(h * 0.9); y++) for (let x = Math.round(w * 0.3); x < Math.round(w * 0.6); x++) { const o = (y * w + x) * 4; px[o] = color[0]; px[o + 1] = color[1]; px[o + 2] = color[2]; px[o + 3] = 255; }
  await K.writePng(file, px, w, h);
  return file;
}

test('순수 함수: 기록 고리(최대 6개, 가장 최근이 앞) · 번호 · 이름 · 꺼내기', () => {
  let h = [];
  let dropped = [];
  for (let i = 1; i <= 8; i++) { const r = EC.pushHistory(h, { file: `drawings/history/shot01_A.v${i}.png`, at: i, kind: 'ai' }); h = r.history; dropped = dropped.concat(r.dropped); }
  assert.strictEqual(h.length, 6);
  assert.deepStrictEqual(h.map((x) => x.at), [8, 7, 6, 5, 4, 3], '가장 최근 것이 맨 앞');
  assert.deepStrictEqual(dropped.map((x) => x.at), [1, 2], '오래된 것부터 빠진다');
  assert.strictEqual(EC.nextVersion({ history: h }), 9, '기록 파일 번호 다음');
  assert.strictEqual(EC.nextVersion({ history: [], vseq: 12 }), 13);
  assert.strictEqual(EC.nextVersion({}), 1);
  assert.strictEqual(EC.historyName(3, 'A', 2, '.jpg'), 'shot03_A.v2.jpg');
  assert.strictEqual(EC.historyName(12, 'bg', 1), 'shot12_bg.v1.png');
  const t = EC.takeHistory(h, 2);
  assert.strictEqual(t.entry.at, 6);
  assert.deepStrictEqual(t.rest.map((x) => x.at), [8, 7, 5, 4, 3]);
  assert.strictEqual(EC.takeHistory(h, 6), null);
  assert.strictEqual(EC.takeHistory(h, -1), null);
  assert.strictEqual(EC.takeHistory(h, 'x'), null);
  assert.strictEqual(EC.takeHistory(undefined, 0), null);
});

test('순수 함수: 한국어 요청 정리 · 주문 글 · 쉬운 오류 문장', () => {
  assert.strictEqual(EC.normalizeNote('  웃는 얼굴로\n\n우산을  들고\t'), '웃는 얼굴로 우산을 들고');
  assert.strictEqual(EC.normalizeNote(undefined), '');
  assert.strictEqual(EC.normalizeNote('가'.repeat(500)).length, EC.NOTE_MAX);
  assert.strictEqual(EC.changeRequestLine('웃는 얼굴로'), 'USER CHANGE REQUEST: 웃는 얼굴로 (keep the character design, palette and everything else identical)');
  const cel = EC.notePrompt({ base: 'ORIGINAL PROMPT', note: '웃는 얼굴로', kind: 'cel', keyColor: '#00ff00' });
  assert.match(cel, /^EDIT MODE: Edit the first attached image/);
  assert.match(cel, /plain flat solid #00FF00 background/);
  assert.match(cel, /ORIGINAL PROMPT\n\nUSER CHANGE REQUEST: 웃는 얼굴로 \(keep the character design, palette and everything else identical\)$/);
  const bg = EC.notePrompt({ base: 'BG PROMPT', note: '노을 지는 하늘', kind: 'bg' });
  assert.match(bg, /background painting/);
  assert.match(bg, /Do not add any characters/);
  assert.ok(!/flat solid/.test(bg));
  // 오류 문장: 스택·영어 없이 쉬운 말
  const lim = Object.assign(new Error('x'), { kind: 'limit' });
  assert.match(EC.friendlyDrawError(lim), /오늘 쓸 수 있는 만큼 다 썼어요/);
  assert.match(EC.friendlyDrawError(Object.assign(new Error('x'), { kind: 'auth' })), /로그인|연결/);
  assert.match(EC.friendlyDrawError(new Error('boom\nstack line')), /^그림을 다시 그리지 못했어요\. 잠시 뒤에 다시 눌러 주세요\. \(boom\)$/);
  assert.strictEqual(EC.friendlyDrawError(Object.assign(new Error('stop'), { name: 'AbortError' })), '그림 다시 그리기를 멈췄어요.');
});

test('다시 그리기를 7번 하면 이전 그림은 최대 6개, 가장 오래된 파일은 지워진다', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  const it = r.itemOf(1, 'A');
  const originalFile = it.file;
  const seen = [bytes(fx, it.file)];
  const firstHistoryFiles = [];
  for (let i = 1; i <= 7; i++) {
    const d = await r.regenerate('drawing', 1, { id: 'A' });
    assert.strictEqual(d.status, 'done');
    assert.strictEqual(d.redraws, i);
    seen.push(bytes(fx, d.file));
    assert.ok(!seen[i].equals(seen[i - 1]), `${i}번째 다시 그린 그림은 앞 그림과 달라 보인다`);
    if (i === 1) firstHistoryFiles.push(d.history[0].file);
    assert.ok(d.history.length <= EC.HISTORY_MAX);
  }
  assert.strictEqual(it.file, originalFile, '현재 그림 파일 이름은 그대로');
  assert.strictEqual(it.history.length, 6);
  // 가장 최근 이전 그림이 맨 앞: 바로 앞 그림과 같은 내용
  assert.ok(bytes(fx, it.history[0].file).equals(seen[6]));
  assert.ok(bytes(fx, it.history[5].file).equals(seen[1]));
  for (const h of it.history) { assert.ok(fs.existsSync(abs(fx, h.file))); assert.strictEqual(h.kind, 'ai'); assert.match(h.file, /^drawings\/history\/shot01_A\.v\d+\.png$/); }
  // 가장 오래된 것(처음 그림 = v1)은 파일도 지워졌다
  assert.ok(!fs.existsSync(abs(fx, firstHistoryFiles[0])), '밀려난 파일은 지운다');
  assert.strictEqual(histFiles(fx).filter((n) => n.startsWith('shot01_A.')).length, 6, '기록 폴더에도 6개만');
  assert.ok(r.p.renderStale && r.p.dirtyShots.includes(1));
  assert.strictEqual(r.running, false);
  // 디스크에도 저장됐다
  assert.strictEqual(fx.store.loadProject(fx.projectId).drawings.find((d) => d.key === '1:A').history.length, 6);
});

test('되돌리기: 예전 그림과 지금 그림이 자리를 바꾼다 (앞뒤로 오갈 수 있다), 배경 빼기도 다시 한다', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  const it = r.itemOf(1, 'A');
  const v1 = bytes(fx, it.file);
  const cel1 = bytes(fx, it.cel);
  await r.regenerate('drawing', 1, { id: 'A' });
  const v2 = bytes(fx, it.file);
  assert.ok(!v1.equals(v2));
  r.p.dirtyShots = []; r.p.renderStale = false;
  const d = await r.restoreVersion(1, 'A', 0);
  assert.ok(bytes(fx, d.file).equals(v1), '예전 그림이 지금 그림이 됐다');
  assert.strictEqual(d.history.length, 1);
  assert.ok(bytes(fx, d.history[0].file).equals(v2), '방금까지의 그림이 기록 맨 앞으로');
  assert.strictEqual(d.keyed, true);
  assert.ok(fs.existsSync(abs(fx, d.cel)) && fs.existsSync(abs(fx, d.plate)), '셀도 다시 만들었다');
  assert.ok(bytes(fx, d.cel).equals(cel1) || d.cel, '배경 뺀 셀이 있다');
  assert.deepStrictEqual(r.p.dirtyShots, [1]);
  assert.strictEqual(r.p.renderStale, true);
  assert.strictEqual(d.custom, true, '내가 고른 그림이라 타임시트를 다시 짜도 지켜진다');
  // 한 번 더 되돌리면 다시 v2
  const d2 = await r.restoreVersion(1, 'A', 0);
  assert.ok(bytes(fx, d2.file).equals(v2));
  assert.ok(bytes(fx, d2.history[0].file).equals(v1));
  assert.strictEqual(d2.history.length, 1, '개수는 그대로');
  assert.strictEqual(histFiles(fx).filter((n) => n.startsWith('shot01_A.')).length, 1, '기록 폴더에 남는 파일도 1개');
  // 잘못된 번호 · 없는 그림
  await assert.rejects(() => r.restoreVersion(1, 'A', 3), /예전 그림을 찾을 수 없어요/);
  await assert.rejects(() => r.restoreVersion(1, 'A', -1), /예전 그림을 찾을 수 없어요/);
  await assert.rejects(() => r.restoreVersion(1, 'Z', 0), /그림을 찾을 수 없어요/);
});

test('내 그림으로 바꾸기: custom · 옛 그림은 이전 그림에 · 색 맞추기 기본 끔 · 두 번 바꾸면 내 그림도 기록에', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  const it = r.itemOf(2, 'B');
  const ai = bytes(fx, it.file);
  const png1 = await makeUserPng(path.join(fx.root, 'mine1.png'));
  const d = await r.replaceItem('drawing', 2, png1, 'B');
  assert.strictEqual(d.custom, true);
  assert.strictEqual(d.source, 'user');
  assert.strictEqual(d.status, 'done');
  assert.strictEqual(d.matchColors, undefined, '내 그림은 색 맞추기 기본 끔');
  assert.ok(bytes(fx, d.file).equals(fs.readFileSync(png1)));
  assert.strictEqual(d.history.length, 1);
  assert.strictEqual(d.history[0].kind, 'ai');
  assert.ok(bytes(fx, d.history[0].file).equals(ai), '옛 AI 그림이 기록에 남았다');
  assert.strictEqual(d.keyed, true, '투명 PNG 라서 인물만 쏙 빠졌다');
  assert.strictEqual(d.keySource, 'alpha');
  assert.ok(r.p.dirtyShots.includes(2) && r.p.renderStale);
  // 두 번째로 바꾸면: 내 첫 그림은 kind:'user' 로 기록에 들어간다
  const png2 = await makeUserPng(path.join(fx.root, 'mine2.png'), 640, 360, [30, 60, 220]);
  const d2 = await r.replaceItem('drawing', 2, png2, 'B', { matchColors: true });
  assert.strictEqual(d2.matchColors, true);
  assert.deepStrictEqual(d2.history.map((h) => h.kind), ['user', 'ai']);
  assert.ok(bytes(fx, d2.history[0].file).equals(fs.readFileSync(png1)));
  // 내 그림 되돌리기 → 색 맞추기 표시도 함께 바뀐다
  const back = await r.restoreVersion(2, 'B', 0);
  assert.strictEqual(back.source, 'user');
  assert.strictEqual(back.matchColors, undefined);
  assert.strictEqual(back.history[0].matchColors, true);
  // 틀린 입력
  await assert.rejects(() => r.replaceItem('drawing', 2, path.join(fx.root, 'nope.png'), 'B'), /그림 파일을 찾을 수 없어요/);
  const txt = path.join(fx.root, 'a.txt');
  fs.writeFileSync(txt, 'x');
  await assert.rejects(() => r.replaceItem('drawing', 2, txt, 'B'), /그림 파일/);
  await assert.rejects(() => r.replaceItem('drawing', 2, png1, 'Z'), /그림을 찾을 수 없어요/);
  await assert.rejects(() => r.replaceItem('movie', 2, png1, 'B'), /알 수 없는 항목/);
});

test('타임시트를 다시 짜도 내가 바꾼 그림(custom)은 남는다: 주문 글이 바뀌어도. 바뀐 AI 그림은 이전 그림 기록으로 옮겨 둔다', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  const png = await makeUserPng(path.join(fx.root, 'mine.png'));
  await r.replaceItem('drawing', 1, png, 'A');
  const mine = r.itemOf(1, 'A');
  const mineFile = mine.file;
  const plainB = r.itemOf(1, 'B');
  const plainBytes = bytes(fx, plainB.file);
  const plainFile = plainB.file;
  // 타임시트의 주문 글(영어 설명)이 바뀐다 → 그림 주문 글도 바뀐다
  for (const d of r.p.xsheet.shots[0].drawings) d.prompt_en = `${d.prompt_en} — completely different idea`;
  r.buildDrawings();
  const kept = r.itemOf(1, 'A');
  assert.strictEqual(kept.status, 'done', '내 그림은 다시 그리지 않는다');
  assert.strictEqual(kept.file, mineFile);
  assert.strictEqual(kept.custom, true);
  assert.ok(bytes(fx, kept.file).equals(fs.readFileSync(png)));
  assert.notStrictEqual(kept.prompt, mine.prompt, "직접 고친 주문 글이 아니니 주문 글은 새 타임시트 것으로 (그림은 그대로)");
  assert.ok(kept.history.length >= 1, '내 그림 이전 기록도 이어받는다');
  // 내가 바꾸지 않은 AI 그림: 다시 그리게 되지만 옛 그림은 이전 그림에 남는다
  const fresh = r.itemOf(1, 'B');
  assert.strictEqual(fresh.status, 'pending');
  assert.strictEqual(fresh.file, null);
  assert.strictEqual(fresh.history.length, 1);
  assert.ok(bytes(fx, fresh.history[0].file).equals(plainBytes), '버려진 AI 그림이 기록에 있다');
  assert.ok(!fs.existsSync(abs(fx, plainFile)), '원래 자리에서는 옮겨졌다');
  assert.strictEqual(fresh.history[0].kind, 'ai');
  assert.ok(fresh.history[0].prompt, '그때의 주문 글도 적어 둔다');
  // 다른 컷은 그대로
  assert.strictEqual(r.itemOf(2, 'A').status, 'done');
  // 한국어 요청으로 바꾼 그림도 custom 이라 같다
  const r2 = fx.runner({ maxRetries: 0 });
  r2.buildDrawings(); // 위에서 버려진 B 는 새 인스턴스에서는 저장 전이라 영향 없음
  assert.strictEqual(r2.itemOf(2, 'A').status, 'done');
});

test('한국어로 고쳐 달라고 하면: note · custom · 그림 주문 글 뒤에 요청 한 줄 · 지금 그림이 첫 번째 기준 그림 · 일반 다시 그리기는 note 를 지운다', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  const calls = [];
  const orig = r.genImage.bind(r);
  r.genImage = async (args, tag, ctl) => { calls.push({ args, tag, ctl }); return orig(args, tag, ctl); };
  const it = r.itemOf(1, 'A');
  const promptBefore = it.prompt;
  const plate = abs(fx, it.plate);
  const d = await r.regenerate('drawing', 1, { id: 'A', note: '  웃는 얼굴로  ' });
  assert.strictEqual(d.note, '웃는 얼굴로');
  assert.strictEqual(d.custom, true);
  assert.strictEqual(d.prompt, promptBefore, '영어 주문 글은 그대로');
  assert.strictEqual(d.history[0].kind, 'ai');
  const c = calls[0];
  assert.match(c.args.prompt, /USER CHANGE REQUEST: 웃는 얼굴로 \(keep the character design, palette and everything else identical\)$/);
  assert.ok(c.args.prompt.includes(promptBefore), '원래 주문 글이 들어 있다');
  assert.match(c.args.prompt, /^EDIT MODE: Edit the first attached image/);
  assert.strictEqual(c.args.refs[0], plate, '지금 그림(배경 뺀 판)이 첫 번째 기준');
  assert.match(c.args.refNotes[0], /EDIT this image/);
  assert.ok(c.args.refs.length > 1, '캐릭터 기준 그림도 같이');
  assert.ok(c.ctl && c.ctl.signal && c.ctl !== r.abort, '낱장 그리기만의 중지 신호');
  assert.deepStrictEqual(c.args.demo.keyColor, r.p.xsheet.keyColor);
  // 요청 없이 새로 그리면 요청 글이 사라진다 (그림이 요청을 따르지 않으므로)
  const d2 = await r.regenerate('drawing', 1, { id: 'A' });
  assert.strictEqual(d2.note, undefined);
  assert.ok(!/USER CHANGE REQUEST/.test(calls[1].args.prompt));
  assert.strictEqual(d2.history.length, 2);
  assert.strictEqual(d2.history[0].kind, 'ai');
  // 이전 그림 기록에는 그때 쓴 요청이 남는다 (note 로 그린 그림 = history[1])
  assert.strictEqual(d2.history[1].note, undefined, '기록의 note 는 그 그림을 그릴 때의 요청 (첫 그림은 없음)');
  assert.strictEqual(d2.history[0].note, '웃는 얼굴로', '바로 앞 그림은 그 요청으로 그렸다');
  // 배경 판: 배경에 맞는 고치기 안내
  calls.length = 0;
  const bgd = await r.regenerate('drawing', 1, { id: 'bg', note: '저녁 노을로' });
  assert.match(calls[0].args.prompt, /background painting/);
  assert.match(calls[0].args.prompt, /USER CHANGE REQUEST: 저녁 노을로/);
  assert.strictEqual(calls[0].args.refs.length, 1, '배경은 지금 그림 한 장만');
  assert.match(calls[0].args.refNotes[0], /background painting/);
  assert.strictEqual(bgd.note, '저녁 노을로');
  // 주문 글을 직접 고치면(고급) custom 이 되고 옛 주문 글은 이전 그림 기록에 남는다
  calls.length = 0;
  const d3 = await r.regenerate('drawing', 2, { id: 'A', prompt: 'my own english prompt' });
  assert.strictEqual(d3.prompt, 'my own english prompt');
  assert.strictEqual(d3.custom, true);
  assert.ok(d3.history[0].prompt && d3.history[0].prompt !== 'my own english prompt', '옛 주문 글을 기록에 남겼다');
  assert.ok(calls[0].args.prompt.includes('my own english prompt'));
  // 되돌리면 주문 글도 함께 되돌아간다
  assert.strictEqual(d3.promptEdited, true);
  const back = await r.restoreVersion(2, 'A', 0);
  assert.strictEqual(back.prompt, d3.history[0].prompt);
  assert.strictEqual(back.promptEdited, undefined, '계획의 주문 글로 돌아왔다');
  assert.strictEqual(back.history[0].prompt, 'my own english prompt', '다시 앞으로 올 수 있게');
  assert.strictEqual(back.history[0].promptEdited, true);
  const fwd = await r.restoreVersion(2, 'A', 0);
  assert.strictEqual(fwd.prompt, 'my own english prompt');
  assert.strictEqual(fwd.promptEdited, true);
});

test('다시 그리기 실패: 이전 그림 그대로 · 쉬운 오류 문장 · 기록에 찌꺼기 없음', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  const it = r.itemOf(1, 'A');
  const before = bytes(fx, it.file);
  const cel = bytes(fx, it.cel);
  const hist0 = histFiles(fx);
  r.genImage = async () => { throw new Error('boom: 서버가 대답하지 않아요\nstack line 2'); };
  await assert.rejects(() => r.regenerate('drawing', 1, { id: 'A', note: '울고 있는 얼굴로' }), /^Error: 그림을 다시 그리지 못했어요\. 잠시 뒤에 다시 눌러 주세요\. \(boom: 서버가 대답하지 않아요\)$/);
  assert.strictEqual(it.status, 'done', '그림이 그대로라서 done');
  assert.match(it.error, /그림을 다시 그리지 못했어요/);
  assert.ok(bytes(fx, it.file).equals(before));
  assert.ok(bytes(fx, it.cel).equals(cel));
  assert.deepStrictEqual(histFiles(fx), hist0);
  assert.ok(!it.history || it.history.length === 0);
  assert.strictEqual(it.note, undefined, '실패한 요청은 남기지 않는다');
  assert.strictEqual(it.custom, undefined);
  assert.strictEqual(r.p.dirtyShots && r.p.dirtyShots.length ? r.p.dirtyShots.length : 0, 0, '실패는 고친 것이 아니다');
  assert.deepStrictEqual(r.snapshot().redrawing, []);
  // 한도에 걸린 경우의 쉬운 문장
  r.genImage = async () => { throw Object.assign(new Error('limit'), { kind: 'limit' }); };
  await assert.rejects(() => r.regenerate('drawing', 1, { id: 'A' }), /오늘 쓸 수 있는 만큼 다 썼어요/);
  // 성공하면 오류 표시가 지워진다
  delete r.genImage;
  const ok = await r.regenerate('drawing', 1, { id: 'A' });
  assert.strictEqual(ok.error, null);
});

test('직접 넣은 그림이 없으면(그림 칸이 비어 있어도) 실패하면 error, 성공하면 done', async (t) => {
  const fx = await copyFixture();
  t.after(fx.cleanup);
  const r = fx.runner({ maxRetries: 0 });
  const it = r.itemOf(1, 'B');
  // 파일이 없는 그림 칸 (처음부터 못 그린 그림)
  fs.unlinkSync(abs(fx, it.file));
  Object.assign(it, { status: 'error', error: '못 그렸어요' });
  const orig = r.genImage.bind(r);
  r.genImage = async () => { throw new Error('nope'); };
  await assert.rejects(() => r.regenerate('drawing', 1, { id: 'B' }), /그림을 다시 그리지 못했어요/);
  assert.strictEqual(it.status, 'error');
  r.genImage = orig;
  const d = await r.regenerate('drawing', 1, { id: 'B' });
  assert.strictEqual(d.status, 'done');
  assert.ok(fs.existsSync(abs(fx, d.file)));
  assert.ok(!d.history || d.history.length === 0, '옛 그림이 없었으니 기록도 없다');
});
