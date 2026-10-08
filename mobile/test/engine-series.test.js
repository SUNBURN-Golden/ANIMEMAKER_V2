// 시리즈 · 가사 시간 건너뛰기 · 숨긴 줄 · 멈추기(노래 분석·그림 정리) · 작품 기록 크기 시험 (Node)
import test, { beforeEach } from 'node:test';
import assert from 'node:assert';
import { newEngine, fakeServices, resetDb, db, songBlob, imgBlob, aiProject, driveToDrawings, DD } from './engine-fixtures.js';

beforeEach(async () => { await resetDb(); });
const file = (label) => ({ name: `${label}.png`, mime: 'image/png', blob: imgBlob(label) });

test('시리즈 에피소드: 기준 그림을 영상마다 복사해 얼린 사본으로 · 에피소드 번호 · 요청서에 기준 그림(최대 4장) · 끝나면 시리즈 기록 · 지우면 사본도 사라진다', async () => {
  const { engine } = newEngine();
  const sid = await engine.demo.ensureSeries();
  assert.strictEqual(await engine.demo.ensureSeries(), sid, '이미 있으면 그대로');
  const id = await aiProject(engine, { seriesId: sid, aspect: '16:9' });
  let s = await engine.projects.get(id);
  assert.deepStrictEqual([s.series.name, s.series.episode, s.title], ['연습 시리즈', 1, '연습 시리즈 EP1']);
  const rt = await engine._runtime(id);
  const ref = rt.p.series.characters[0].refs[0];
  assert.ok(ref.blobKey.startsWith(`${id}/refs/`), '영상 안에 사본이 있다');
  assert.ok(await db.getFile(ref.blobKey));
  const char = (await db.listCharacters())[0];
  await db.deleteFiles(`char/${char.id}/`); // 캐릭터 쪽 파일이 사라져도 이 영상은 그대로 (얼린 사본)
  await driveToDrawings(engine, id);
  // 첫 인물 그림 요청: 캐릭터 기준 그림이 붙는다 (장면의 첫 그림이라 앞 그림은 없다)
  let withRef = null;
  for (let i = 0; i < 12 && !withRef; i++) {
    const req = await engine.handoff.request(id);
    if (req.kind === 'cel') withRef = req;
    else await engine.handoff.acceptFiles(id, [file(`bg${i}`)]);
    await engine.whenIdle(id);
  }
  assert.ok(withRef && withRef.files.length >= 1 && withRef.files.length <= 4);
  assert.match(withRef.files[0].name, /turnaround/);
  assert.match(withRef.files[0].note, /하루 — character turnaround model sheet/);
  assert.match(withRef.prompt, /하루/);
  // 끝까지 만들면 시리즈 기록에 요약이 남고, 다음 에피소드는 번호가 올라가고 지난 이야기를 안다
  const demo = newEngine();
  const did = await demo.engine.projects.create({ workflow: 'demo', seriesId: sid, aspect: '16:9' });
  await demo.engine.demo.fill(did);
  const series = await db.getSeries(sid);
  assert.deepStrictEqual(series.episodes.map((e) => [e.number, e.projectId]), [[2, did]], '에피소드 2 (1번은 아직 안 끝났다)');
  assert.ok(series.episodes[0].title && series.episodes[0].summary_ko);
  assert.strictEqual(series.episodeCounter, 2);
  const next = await demo.engine.projects.create({ workflow: 'demo', seriesId: sid, aspect: '16:9' });
  const ns = await demo.engine.projects.get(next);
  assert.strictEqual(ns.series.episode, 3);
  const nrt = await demo.engine._runtime(next);
  assert.strictEqual(nrt.p.series.previous.length, 1);
  assert.strictEqual(nrt.p.series.previous[0].number, 2);
  // 자막 모양을 시리즈 기본으로 저장하면 다음 에피소드가 그 모양으로 시작한다
  await demo.engine.edits.setSubtitleStyle(did, { preset: 'box' }, { applyToSeries: true });
  assert.strictEqual((await db.getSeries(sid)).subtitleStyle.preset, 'box');
  const e4 = await demo.engine.projects.create({ workflow: 'demo', seriesId: sid, aspect: '16:9' });
  assert.strictEqual((await demo.engine.projects.get(e4)).subtitleStyle.preset, 'box');
  // 지우기
  await demo.engine.projects.delete(did);
  assert.deepStrictEqual(await db.listFileKeys(`${did}/`), []);
  assert.ok(s);
});

test('시리즈 오류: 모르는 시리즈 · 주인공 없음 · 잠기지 않은 캐릭터는 쉬운 한국어로, 번호는 올라가지 않는다', async () => {
  const { engine } = newEngine();
  await assert.rejects(() => engine.projects.create({ workflow: 'demo', seriesId: 'nope' }), /시리즈를 찾을 수 없어요/);
  const sid = await engine.demo.ensureSeries();
  const series = await db.getSeries(sid);
  const empty = { ...series, id: 'empty', characterIds: [] };
  await db.putSeries(empty);
  await assert.rejects(() => engine.projects.create({ workflow: 'demo', seriesId: 'empty' }), /주인공 캐릭터가 없어요/);
  const [c] = await db.listCharacters();
  await db.putCharacter({ ...c, lockedAt: null });
  await assert.rejects(() => engine.projects.create({ workflow: 'demo', seriesId: sid }), /캐릭터 "하루" 가 아직 잠기지 않았어요/);
  assert.strictEqual((await db.getSeries(sid)).episodeCounter || 0, 0);
  await assert.rejects(() => engine.projects.create({ workflow: 'nope' }), /알 수 없는 만들기 방식/);
  await assert.rejects(() => engine.projects.create({ workflow: 'phone-lite' }), /노래 파일을 골라 주세요/);
  await assert.rejects(() => engine.projects.create({ workflow: 'phone-lite', songBlob: new Blob([]) }), /노래 파일이 비어 있어요/);
  await assert.rejects(() => engine.projects.get('없는작품'), /작품을 찾을 수 없어요/);
});

test('가사에 시간이 있으면(.lrc) 가사 맞추기 확인을 건너뛴다 · 시간이 없으면 컷 나누기 전에 묻는다 · 탭으로 맞추면 그 시간을 쓴다', async () => {
  const { engine } = newEngine();
  const lrc = '[00:01.00]첫째 줄\n[00:04.00]둘째 줄\n[00:08.00]셋째 줄\n[00:12.00]넷째 줄';
  const id = await aiProject(engine, { lyricsText: lrc, lyricsName: 'a.lrc' });
  await engine.run(id);
  const rq = await engine.handoff.request(id);
  const wf = (await engine.projects.get(id)).workflow;
  await engine.handoff.acceptText(id, JSON.stringify({ ...DD.demoPlan('t', wf, null), request_id: rq.nonce }));
  await engine.whenIdle(id);
  let s = await engine.projects.get(id);
  assert.strictEqual(s.waiting.key, 'handoff:xsheet', '시간이 있는 가사는 확인 없이 지나간다');
  assert.notStrictEqual(s.timing.lyricsSource, 'auto');
  assert.ok(Math.abs(s.timing.lyrics[1].start - 4) < 0.01);
  // 시간이 없는 가사: 탭으로 맞추고 계속
  const id2 = await aiProject(engine);
  await engine.run(id2);
  const rq2 = await engine.handoff.request(id2);
  await engine.handoff.acceptText(id2, JSON.stringify({ ...DD.demoPlan('t', wf, null), request_id: rq2.nonce }));
  await engine.whenIdle(id2);
  s = await engine.projects.get(id2);
  assert.strictEqual(s.waiting.key, 'review:lyrics');
  assert.strictEqual(s.timing.segments, undefined, '컷은 아직 안 나눴다');
  const tapped = s.timing.lyrics.map((l, i) => ({ text: l.text, start: 1 + i * 2.5, end: 3 + i * 2.5, part: 1, section: l.section, sectionStart: l.sectionStart }));
  await engine.edits.updateLyrics(id2, tapped);
  await engine.continueReview(id2);
  await engine.whenIdle(id2);
  s = await engine.projects.get(id2);
  assert.strictEqual(s.timing.lyricsSource, 'tap');
  assert.ok(Math.abs(s.timing.lyrics[0].start - 1) < 0.001);
  assert.ok(s.timing.segments.length >= 3, '탭으로 맞춘 시간으로 컷을 나눴다');
});

test('자막: 숨긴 줄은 영상 · SRT · LRC 에서 빠지고, 영상 엔진이 글꼴 대체를 알리면 subsFallback 이 켜진다', async () => {
  const sv = fakeServices();
  const burn = sv.render.burnSubtitles;
  let fallback = false;
  sv.render.burnSubtitles = async (o) => ({ ...(await burn(o)), subsFallback: fallback });
  const { engine } = newEngine({ services: sv });
  const id = await engine.projects.create({ workflow: 'demo', aspect: '16:9' });
  const s0 = await engine.demo.fill(id);
  const lines = s0.timing.lyrics.map((l, i) => ({ text: l.text, start: l.start, end: l.end, ...(i === 1 ? { hidden: true } : {}) }));
  const hiddenText = lines[1].text;
  await engine.edits.setLyricLines(id, lines);
  fallback = true;
  await engine.applyChanges(id);
  await engine.whenIdle(id);
  const s = await engine.projects.get(id);
  assert.strictEqual(s.subsFallback, true);
  const burned = sv.calls.burns.at(-1).lines.map((l) => l.text);
  assert.ok(!burned.includes(hiddenText) && burned.length === lines.length - 1);
  assert.ok(!(await (await engine.render.output(id, 'srt')).text()).includes(hiddenText));
  assert.ok(!(await (await engine.render.output(id, 'lrc')).text()).includes(hiddenText));
  assert.ok((await engine.render.fileName(id, 'video')).endsWith('.mp4'));
  assert.ok((await engine.render.fileName(id, 'srt')).endsWith('.srt'));
  // 자막을 끄면 깨끗한 원본이 그대로 완성본 (복사하지 않는다)
  await engine.edits.setSubtitleStyle(id, { enabled: false });
  await engine.applyChanges(id);
  await engine.whenIdle(id);
  const off = await engine.projects.get(id);
  assert.strictEqual(off.output.video, off.output.clean);
  assert.strictEqual(off.output.burned, false);
  assert.strictEqual(await db.getFile(`${id}/out/final`), null, '예전 완성본은 치운다');
});

test('멈추기: 노래 분석 중에도 · 받은 그림 정리 중에도 신호가 가서 하던 일이 멈춘다 (결과는 남은 것만)', async () => {
  // 노래 분석 중
  const slow = fakeServices();
  slow.analyzeSong = async (blob, { signal } = {}) => {
    for (let i = 0; i < 100; i++) {
      if (signal && signal.aborted) throw Object.assign(new Error('멈춤'), { name: 'AbortError' });
      await new Promise((r) => setTimeout(r, 10));
    }
    return {};
  };
  const a = newEngine({ services: slow });
  const id = await a.engine.projects.create({ workflow: 'demo', aspect: '9:16' });
  const run = a.engine.run(id);
  for (let i = 0; i < 200; i++) { const s = a.engine.projects.peek(id); if (s && s.currentStep === 'music' && s.status === 'running') break; await new Promise((r) => setTimeout(r, 5)); }
  assert.strictEqual(await a.engine.stop(id), true);
  const snap = await run;
  assert.strictEqual(snap.status, 'stopped');
  assert.strictEqual(snap.steps.music.status, 'stopped');
  // 그림 정리 중 (여러 장 중간에서)
  const sv = fakeServices();
  const ing = sv.ingest;
  let n = 0;
  sv.ingest = async (blob, o) => { n++; await new Promise((r) => setTimeout(r, 40)); return ing(blob, o); };
  const b = newEngine({ services: sv });
  const id2 = await aiProject(b.engine);
  const s0 = await driveToDrawings(b.engine, id2);
  const files = s0.queue.slice(0, 6).map((q, i) => file(`k${i}`));
  const batch = b.engine.handoff.acceptFiles(id2, files).then((r) => ({ ok: true, r }), (e) => ({ ok: false, name: e.name }));
  for (let i = 0; i < 200 && n < 2; i++) await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(await b.engine.stop(id2), true);
  const res = await batch;
  assert.deepStrictEqual([res.ok, res.name], [false, 'AbortError']);
  const s1 = await b.engine.projects.get(id2);
  const done = s1.drawings.filter((d) => d.status === 'done').length;
  assert.ok(done >= 1 && done < 6, `일부만 들어갔다: ${done}`);
  assert.strictEqual(s1.drawings.filter((d) => d.status === 'running').length, 0, '정리하다 만 그림은 이전 상태로');
  // 남은 그림은 다시 보내면 들어간다
  const again = await b.engine.handoff.acceptFiles(id2, files.slice(done));
  assert.strictEqual(again.placed.length, 6 - done);
});

test('작품 기록은 작게 유지된다: 3분 노래 폰 가볍게 작품도 레코드 512KB 이하 · 그림 기록은 따로 · 그림 한 장 받을 때 작품 전체를 다시 쓰지 않는다(그림 기록만)', async () => {
  const { engine } = newEngine();
  const id = await aiProject(engine, { songBlob: songBlob(210), aspect: '16:9', lyricsText: DD.DEMO_LYRICS });
  const s = await driveToDrawings(engine, id, { fallback: true, approve: true });
  const rec = await db.getProject(id);
  const size = JSON.stringify(rec).length;
  assert.ok(size < 512 * 1024, `작품 기록 ${(size / 1024).toFixed(0)}KB`);
  assert.ok(!('drawings' in rec));
  assert.ok((await db.listDrawings(id)).length === s.drawings.length && s.drawings.length >= 30);
  console.log(`작품 기록 ${(size / 1024).toFixed(0)}KB · 그림 기록 ${s.drawings.length}개 · 그림 하나 평균 ${(JSON.stringify((await db.listDrawings(id))[3]).length / 1024).toFixed(1)}KB`);
});
