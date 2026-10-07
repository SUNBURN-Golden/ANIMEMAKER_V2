'use strict';
// 렌더링 합성기 테스트: 카메라 계산, 컷 영상 프레임 수, 깨끗한 원본의 정확한 길이(±1프레임)와 소리, 자막 따로 입히기
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const X = require('../src/main/pipeline/xsheet');
const { renderShot, sampleFrame, fxState } = require('../src/main/media/render');
const { assembleAnimation, burnSubtitles, buildAss, makePaperTexture, outputSize } = require('../src/main/media/assemble');
const { probe, countFrames } = require('../src/main/media/ffmpeg');
const demo = require('../src/main/ai/demo');

test('camera math: zoom/pan picks the right part of the big drawing', () => {
  // 가로 위치 = 밝기 인 가짜 그림 (200×100)
  const cw = 200;
  const ch = 100;
  const src = Buffer.alloc(cw * ch * 3);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) src.fill(Math.round((x / (cw - 1)) * 255), (y * cw + x) * 3, (y * cw + x) * 3 + 3);
  const left = sampleFrame(src, cw, ch, 50, 25, { zoom: 2, x: -1, y: 0 });
  const right = sampleFrame(src, cw, ch, 50, 25, { zoom: 2, x: 1, y: 0 });
  const whole = sampleFrame(src, cw, ch, 50, 25, { zoom: 1, x: 0, y: 0 });
  const px = (b, x) => b[(12 * 50 + x) * 3];
  assert.ok(px(left, 0) < 10 && px(left, 49) < 135, `left half ${px(left, 0)}..${px(left, 49)}`);
  assert.ok(px(right, 0) > 120 && px(right, 49) > 245, `right half ${px(right, 0)}..${px(right, 49)}`);
  assert.ok(px(whole, 0) < 10 && px(whole, 49) > 245, 'zoom 1 shows the whole drawing');
  // 반 픽셀 움직임도 반영된다 (계단식 떨림 없음)
  const a = sampleFrame(src, cw, ch, 50, 25, { zoom: 1.5, x: 0, y: 0 }, 0);
  const b = sampleFrame(src, cw, ch, 50, 25, { zoom: 1.5, x: 0, y: 0 }, 0.5);
  assert.ok(px(b, 20) > px(a, 20) && px(b, 20) - px(a, 20) < 4, 'sub-pixel camera offset');
  const st = fxState(['fade_in', 'flash'], 0, 48);
  assert.ok(st.fade < 0.2 && st.flash > 0.8);
  assert.strictEqual(fxState(['fade_in'], 30, 48).fade, 1);
});

test('render: clean master has exact frames (±1), right duration and the song; subtitles go on afterwards', { timeout: 300000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am2-render-'));
  const song = path.join(dir, 'song.mp3');
  await demo.demoMusic({ seconds: 9.3, bpm: 120, out: song });
  const songDur = (await probe(song)).duration;
  // 컷 3개: 보통(팬) · 하이라이트(2프레임씩, 반짝임) · 보통(줌, 페이드아웃)
  let t = 0;
  const segments = [3.1, 2.6, songDur - 5.7].map((d, i) => { const s = { index: i + 1, start: t, end: t + d, duration: d, lyrics: [], energy: i === 1 ? 'high' : 'mid', level: 0.5 }; t += d; return s; });
  const frames = X.shotFrames(segments);
  const ctx = { segments, frames, highlights: [false, true, false], budget: 20, plan: { characters: [], story: [{ visual_en: 'x' }] }, analysis: { beats: [], beatPeriod: 0.5 } };
  ctx.alloc = X.allocateDrawings(frames, ctx.highlights, 20);
  const raw = {
    shots: [
      { shot: 1, drawings: ['a', 'b'], exposure: ['A:40', 'B:40'], camera: { move: 'pan_left' }, fx: ['fade_in'], transition_out: { type: 'dissolve', beats: 1 } },
      { shot: 2, highlight: true, drawings: ['1', '2', '3', '4', '5', '6'], exposure: [{ cycle: ['A', 'B', 'C', 'D', 'E', 'F'], each: 2, repeat: 9 }], camera: 'shake', fx: ['sparkle', 'flash'], transition_out: { type: 'cut' } },
      { shot: 3, drawings: ['z'], exposure: ['A:999'], camera: 'zoom_in', fx: ['fade_out'] },
    ],
  };
  const xs = X.normalizeXsheet(raw, ctx);
  assert.strictEqual(xs.totalFrames, Math.round(songDur * 24) - 0, 'timesheet covers the song');
  const { w, h } = outputSize('16:9', '480p');
  const rendered = [];
  for (const [i, shot] of xs.shots.entries()) {
    const files = new Map();
    for (const [k, d] of shot.drawings.entries()) {
      const f = path.join(dir, `s${shot.shot}_${d.id}.png`);
      await demo.demoDrawing({ shot: shot.shot, index: k, count: shot.drawings.length, highlight: shot.highlight, w: 960, h: 540, out: f });
      files.set(d.id, f);
    }
    if (i === 2) files.set('A', null); // 그림이 없어도 빈 카드로 렌더링된다
    const lead = i > 0 ? xs.transitions[i - 1].frames / 2 : 0;
    const tail = i < xs.transitions.length ? xs.transitions[i].frames / 2 : 0;
    const r = await renderShot({ shot, files, W: w, H: h, lead, tail, boil: true, out: path.join(dir, `shot${i}.mp4`) });
    assert.strictEqual(r.frames, lead + shot.frames + tail);
    assert.strictEqual(await countFrames(r.file), r.frames, `shot ${i} frame count`);
    rendered.push(r);
  }
  assert.ok(xs.transitions[0].frames >= 2, 'dissolve overlaps');
  const clean = path.join(dir, 'animation_clean.mp4');
  const paper = await makePaperTexture(w, h, path.join(dir, 'paper.png'));
  await assembleAnimation({ shots: rendered, transitions: xs.transitions, song, totalFrames: xs.totalFrames, w, h, out: clean, paperFile: paper, finish: { grain: true, vignette: true, warm: true, paper: true } });
  const info = await probe(clean);
  assert.ok(info.hasVideo && info.hasAudio, 'video + song');
  assert.strictEqual(info.width, w);
  const n = await countFrames(clean);
  assert.ok(Math.abs(n - xs.totalFrames) <= 1, `frames ${n} vs ${xs.totalFrames}`);
  assert.ok(Math.abs(info.duration - xs.totalFrames / 24) <= 1 / 24 + 0.03, `duration ${info.duration} vs ${xs.totalFrames / 24}`);

  // 자막은 나중에: 원본은 그대로 두고 새 파일을 만든다
  const before = fs.statSync(clean).mtimeMs;
  const ass = path.join(dir, 'lyrics.ass');
  fs.writeFileSync(ass, buildAss([{ text: '첫 줄 가사', start: 0.5, end: 2.5 }, { text: 'second line', start: 4, end: 6 }], { w, h }));
  const final = path.join(dir, 'final.mp4');
  await burnSubtitles({ video: clean, total: xs.totalFrames / 24, w, h, assFile: ass, out: final });
  const fi = await probe(final);
  assert.ok(fi.hasVideo && fi.hasAudio);
  assert.ok(Math.abs((await countFrames(final)) - xs.totalFrames) <= 1);
  assert.strictEqual(fs.statSync(clean).mtimeMs, before, 'clean master untouched');
  const png = path.join(dir, 'sub.png');
  await demo.demoImage({ w: 300, h: 60, out: png });
  const final2 = path.join(dir, 'final2.mp4');
  await burnSubtitles({ video: clean, total: xs.totalFrames / 24, w, h, subtitlePngs: [{ file: png, start: 1, end: 3, y: h - 80 }, { file: png, start: 5, end: 7.5, y: h - 80 }], out: final2 });
  assert.ok(Math.abs((await countFrames(final2)) - xs.totalFrames) <= 1, 'PNG subtitles keep the length');
});
