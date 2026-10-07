'use strict';
// 캐릭터 파일(.amchar) 과 시리즈 저장소 테스트
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../src/main/characters');
const { Store } = require('../src/main/store');
const demo = require('../src/main/ai/demo');

const ICON = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'icon.png');

function newStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am2-char-'));
  return { root, store: new Store({ userDataDir: path.join(root, 'ud'), documentsDir: path.join(root, 'docs'), downloadsDir: path.join(root, 'dl') }) };
}

test('amchar round-trip keeps description, palette, rules and image bytes', { timeout: 60000 }, async () => {
  const { root, store } = newStore();
  let c = store.characters.save({ ...demo.DEMO_CHARACTER, palette: [...demo.DEMO_CHARACTER.palette, { name: 'eyes', hex: 'ABC' }] });
  assert.strictEqual(c.palette[c.palette.length - 1].hex, '#aabbcc', 'short hex normalized');
  const jpg = path.join(root, 'face.jpg');
  await demo.demoImage({ w: 320, h: 240, out: jpg });
  c = await store.characters.addRef(c.id, ICON, 'turnaround');
  c = await store.characters.addRef(c.id, jpg, 'expressions', '표정');
  assert.strictEqual(c.refs.length, 2);
  assert.strictEqual(c.refs[1].mime, 'image/jpeg');
  c = store.characters.lock(c.id);
  assert.ok(c.isLocked);
  assert.throws(() => store.characters.save({ id: c.id, locked: { summary: 'someone else' } }), /잠긴 캐릭터/);
  await assert.rejects(() => store.characters.addRef(c.id, ICON, 'other'), /잠긴 캐릭터/);
  const renamed = store.characters.save({ id: c.id, personality_ko: '조금 수줍음' });
  assert.strictEqual(renamed.personality_ko, '조금 수줍음', 'personality can still change');

  const file = path.join(root, 'haru.amchar');
  store.characters.exportTo(c.id, file);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(raw.format, 'animemaker.character');
  assert.strictEqual(raw.refs.length, 2);
  assert.ok(!('file' in raw.refs[0]), 'no local paths inside the portable file');

  const other = newStore().store;
  const imp = other.characters.importFrom(file);
  assert.strictEqual(imp.name, c.name);
  assert.deepStrictEqual(imp.locked, c.locked);
  assert.deepStrictEqual(imp.palette, c.palette);
  assert.deepStrictEqual(imp.rules, c.rules);
  assert.ok(imp.isLocked, 'lock state travels with the file');
  assert.deepStrictEqual(imp.refs.map((r) => r.kind), ['turnaround', 'expressions']);
  for (let i = 0; i < 2; i++) assert.ok(fs.readFileSync(imp.refsAbs[i]).equals(fs.readFileSync(c.refsAbs[i])), `ref ${i} bytes identical`);
  // 같은 저장소에 다시 가져오면 새 id
  const again = store.characters.importFrom(file);
  assert.notStrictEqual(again.id, c.id);
  // 잠금 풀고 다시 잠그면 버전이 오른다
  const un = store.characters.unlock(c.id);
  assert.strictEqual(un.version, c.version + 1);
});

test('amchar validation rejects broken files with Korean messages', () => {
  const png = fs.readFileSync(ICON).toString('base64');
  const base = { format: 'animemaker.character', formatVersion: 1, name: '하루', locked: { summary: 'a girl' }, refs: [{ kind: 'turnaround', data: png }] };
  assert.ok(C.fromAmchar(JSON.stringify(base)).refs[0].buffer.length > 100);
  assert.throws(() => C.fromAmchar('not json'), /읽을 수 없어요/);
  assert.throws(() => C.fromAmchar({ ...base, format: 'other' }), /캐릭터 파일\(\.amchar\)이 아니에요/);
  assert.throws(() => C.fromAmchar({ ...base, formatVersion: 99 }), /더 새로운 버전/);
  assert.throws(() => C.fromAmchar({ ...base, refs: [{ kind: 'x', data: Buffer.from('hello world, not an image').toString('base64') }] }), /PNG\/JPEG/);
  assert.throws(() => C.fromAmchar({ ...base, refs: Array.from({ length: 7 }, () => ({ data: png })) }), /너무 많아요/);
  assert.throws(() => C.fromAmchar({ ...base, name: '' }), /이름이 비어 있어요/);
  assert.throws(() => C.fromAmchar({ ...base, locked: {} }), /생김새 설명/);
  assert.throws(() => C.fromAmchar({ ...base, lockedAt: Date.now(), refs: [] }), /기준 그림이 1장 이상/);
  const n = C.normalizeCharacter({ name: 'x', palette: [{ name: 'bad', hex: 'zzz' }, '#123456'], rules: { must: 'a\nb', never: ['c'] } });
  assert.deepStrictEqual(n.palette, [{ name: 'color 2', hex: '#123456' }]);
  assert.deepStrictEqual(n.rules, { must: ['a', 'b'], never: ['c'] });
  assert.strictEqual(C.normalizeHex('#FfF'), '#ffffff');
  assert.strictEqual(C.normalizeHex('12345'), null);
});

test('series: episodes need locked characters, snapshot refs, and log summaries', { timeout: 60000 }, async () => {
  const { store } = newStore();
  let c = store.characters.save({ ...demo.DEMO_CHARACTER });
  const s = store.series.save({ name: '하루 시리즈', characterIds: [c.id] });
  const wf = store.getWorkflow('builtin-cel-wide');
  assert.throws(() => store.createProject('', wf, {}, { seriesId: s.id }), /잠기지 않았어요/);
  c = await store.characters.addRef(c.id, ICON, 'turnaround');
  store.characters.lock(c.id);
  const p1 = store.createProject('첫 이야기', wf, {}, { seriesId: s.id });
  assert.strictEqual(p1.series.episode, 1);
  assert.strictEqual(p1.series.characters[0].role, 'protagonist');
  const refFile = path.join(store.projectDir(p1.id), p1.series.characters[0].refs[0].file);
  assert.ok(fs.existsSync(refFile), 'reference copied into the episode folder');
  const p2 = store.createProject('', wf, {}, { seriesId: s.id });
  assert.strictEqual(p2.series.episode, 2);
  assert.strictEqual(p2.title, '하루 시리즈 EP2');
  store.series.recordEpisode(s.id, { number: 1, projectId: p1.id, title: '첫 만남', summary_ko: '하루가 반디를 만났다.' });
  store.series.recordEpisode(s.id, { number: 1, projectId: p1.id, title: '첫 만남', summary_ko: '하루가 반디를 처음 만났다.' });
  const p3 = store.createProject('', wf, {}, { seriesId: s.id });
  assert.strictEqual(p3.series.episode, 3);
  assert.deepStrictEqual(p3.series.previous, [{ number: 1, title: '첫 만남', summary_ko: '하루가 반디를 처음 만났다.' }], 'one log entry per episode, updated in place');
  const listed = store.listProjects().find((x) => x.id === p3.id);
  assert.strictEqual(listed.series.episode, 3);
  // 시리즈 화면에서 저장해도 기록은 지워지지 않는다
  const kept = store.series.save({ id: s.id, name: '하루 시리즈 (새 이름)', episodes: [] });
  assert.strictEqual(kept.episodes.length, 1);
  assert.strictEqual(store.series.updateEpisode(s.id, 1, null).episodes.length, 0);
});
