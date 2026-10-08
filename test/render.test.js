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

test('layered render: BG plate + transparent cels (+ in-between ids), exact length, background moves 0.8× the cels (multiplane)', { timeout: 300000 }, async () => {
  const K = require('../src/main/media/keyer');
  const { runFfmpeg } = require('../src/main/media/ffmpeg');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am2-layer-'));
  const BW = 480;
  const BH = 270;
  // 배경: 회색 + 가운데 빨간 세로줄
  const bgPx = new Uint8ClampedArray(BW * BH * 3);
  for (let i = 0; i < BW * BH; i++) { const x = i % BW; bgPx.set(Math.abs(x - BW / 2) < 3 ? [230, 20, 20] : [120, 120, 120], i * 3); }
  const bg = await K.writePng(path.join(dir, 'bg.png'), bgPx, BW, BH, { rgb: true });
  // 셀: 투명(색 값은 배경을 뺀 초록 그대로) + 파란 상자 (B 는 조금 위로)
  const cel = async (name, dy) => {
    const px = new Uint8ClampedArray(BW * BH * 4);
    for (let i = 0; i < BW * BH; i++) { const x = i % BW; const y = Math.floor(i / BW); px.set(Math.abs(x - BW / 2) < 15 && Math.abs(y - BH / 2 - dy) < 30 ? [20, 40, 230, 255] : [0, 255, 0, 0], i * 4); }
    return K.writePng(path.join(dir, `${name}.png`), px, BW, BH);
  };
  const layers = new Map([['A', await cel('A', 0)], ['B', await cel('B', -10)], ['A~B', await cel('AB', -5)]]);
  const shot = {
    shot: 1, frames: 24, motion: true, fx: [],
    exposure: [{ drawing: 'A', frames: 4 }, { drawing: 'B', frames: 4 }, { drawing: 'A', frames: 16 }],
    camera: { move: 'pan_left', start: { zoom: 1.5, x: 0.8, y: 0 }, end: { zoom: 1.5, x: -0.8, y: 0 }, ease: 'linear' },
  };
  const table = X.expandExposure(shot, () => true);
  assert.deepStrictEqual(table.slice(0, 8), ['A', 'A', 'A~B', 'A~B', 'B', 'B', 'A~B', 'A~B']);
  const W = 320;
  const H = 180;
  const out = path.join(dir, 'shot.mp4');
  const r = await renderShot({ shot, table, bg, layers, parallax: 0.8, W, H, lead: 2, tail: 3, boil: false, out });
  assert.ok(r.layered);
  assert.strictEqual(r.frames, 29);
  assert.strictEqual(await countFrames(out), 29, 'lead + 24 + tail frames exactly');
  await assert.rejects(renderShot({ shot, table: table.slice(1), bg, layers, W, H, out: path.join(dir, 'bad.mp4') }), /프레임 합계/);
  // 첫 프레임과 마지막 프레임에서 빨간 줄(배경)과 파란 상자(인물)의 위치
  const where = async (n) => {
    const png = path.join(dir, `f${n}.png`);
    await runFfmpeg(['-y', '-i', out, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1', png]);
    const img = await K.readRgba(png);
    let rx = 0; let rn = 0; let bx = 0; let bn = 0; let green = 0;
    for (let i = 0; i < W * H; i++) {
      const [R, G, B] = [img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]];
      if (G > R + 40 && G > B + 40) green++;
      if (R > 180 && G < 80 && B < 80) { rx += i % W; rn++; }
      if (B > 180 && R < 80) { bx += i % W; bn++; }
    }
    const grey = img.data.slice(4 * (5 * W + 5), 4 * (5 * W + 5) + 3);
    return { red: rx / rn, blue: bx / bn, grey: Array.from(grey), green };
  };
  const a = await where(2);
  const b = await where(26);
  assert.strictEqual(a.green + b.green, 0, 'no key-colour fringe around the cel');
  assert.ok(a.grey.every((v) => Math.abs(v - 120) < 12), `background shows through the transparent cel ${a.grey}`);
  const celMove = b.blue - a.blue;
  const bgMove = b.red - a.red;
  assert.ok(celMove > 40, `camera pans (cel moved ${celMove.toFixed(1)}px)`);
  assert.ok(Math.abs(bgMove / celMove - 0.8) < 0.06, `parallax ${(bgMove / celMove).toFixed(3)} (bg ${bgMove.toFixed(1)} / cel ${celMove.toFixed(1)})`);
});

// ---------- 자막: ASS 대체 경로 · 영상에 입히기 ----------

test('buildAss: PNG 자막과 같은 정규화 스타일을 읽는다 (색 · 테두리 · 상자 · 위치 · 안전영역 · 글꼴 · 숨긴 줄)', () => {
  const S = require('../src/shared/subtitle-style');
  const A = require('../src/main/media/assemble');
  const styleLine = (ass) => ass.split('\n').find((l) => l.startsWith('Style: Lyric,')).slice('Style: Lyric,'.length).split(',');
  // [Fontname, Fontsize, Primary, Secondary, Outline, Back, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, OutlineW, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding]
  const lines = [{ text: '첫 줄', start: 0.5, end: 2.5 }, { text: '숨긴 줄', start: 3, end: 4, hidden: true }, { text: '둘째\n줄 {태그}', start: 4, end: 6 }];
  const basic = A.buildAss(lines, { w: 1280, h: 720 });
  const b = styleLine(basic);
  assert.strictEqual(b[0], 'Pretendard', '번들 글꼴');
  assert.strictEqual(Number(b[1]), Math.round(33 * S.FONT_BY_ID.pretendard.ass.k), 'libass 크기 보정 (줄 높이 기준)');
  assert.strictEqual(b[2], '&H00FFFFFF');
  assert.strictEqual(b[4], '&H19000000', '검은 테두리 90%');
  assert.strictEqual(b[14], '1', 'BorderStyle 1 (테두리 + 그림자)');
  assert.strictEqual(Number(b[15]), 3, '테두리 5.28px 의 절반 ≈ 3');
  assert.strictEqual(b[17], '2', '아래 가운데');
  assert.deepStrictEqual(b.slice(18, 21).map(Number), [51, 51, 58 + Math.round(33 * 0.48)], '좌우 4% · 아래 8%');
  assert.strictEqual(b[6], '-1', 'Pretendard Bold');
  assert.match(basic, /PlayResX: 1280\nPlayResY: 720/);
  assert.match(basic, /\{\\fad\(150,150\)\}첫 줄/);
  assert.doesNotMatch(basic, /숨긴 줄/, '숨긴 줄은 ASS 에도 없다');
  assert.match(basic, /둘째\\N줄 \(태그\)/, '억지 줄바꿈은 \\N, 중괄호는 괄호로');
  // 노랑 예능체: 노랑 · 굵은 테두리 · Do Hyeon(굵지 않은 파일이라 Bold 0)
  const y = styleLine(A.buildAss(lines, { w: 1280, h: 720, style: { preset: 'yellow' } }));
  assert.strictEqual(y[0], 'Do Hyeon');
  assert.strictEqual(y[2], '&H004DE1FF', '#ffe14d (BGR 순서)');
  assert.strictEqual(y[6], '0');
  assert.ok(Number(y[15]) > Number(b[15]), '굵은 테두리');
  // 상자: BorderStyle 3, 상자 색은 OutlineColour 에 검정 55%
  const box = styleLine(A.buildAss(lines, { w: 1280, h: 720, style: { preset: 'box' } }));
  assert.strictEqual(box[14], '3');
  assert.strictEqual(box[4], '&H73000000');
  // 위치: 위 · 가운데
  assert.strictEqual(styleLine(A.buildAss(lines, { w: 1280, h: 720, style: { position: 'top' } }))[17], '8');
  assert.strictEqual(styleLine(A.buildAss(lines, { w: 1280, h: 720, style: { position: 'middle' } }))[17], '5');
  // 세로 영상 안전영역: 오른쪽 12% · 아래 24%
  const tall = styleLine(A.buildAss(lines, { w: 720, h: 1280, style: { preset: 'shorts' } }));
  assert.deepStrictEqual(tall.slice(18, 20).map(Number), [29, 86], '왼쪽 4% · 오른쪽 12%');
  assert.ok(Number(tall[20]) >= 307, `아래 24% 이상: ${tall[20]}`);
  assert.strictEqual(tall[0], 'Black Han Sans');
  // 옛 형식(예전 워크플로우)도 읽는다: 글꼴 = 내 컴퓨터 기본, 예전 글자 크기 · 여백
  const legacy = styleLine(A.buildAss(lines, { w: 1280, h: 720, style: { enabled: true, sizePct: 4.6, color: 'yellow', box: true, marginPct: 8 } }));
  assert.strictEqual(legacy[0], A.assFont('system').name);
  assert.strictEqual(legacy[14], '3');
  assert.strictEqual(legacy[2], '&H004DE1FF');
  // 페이드 0 이면 \fad 를 안 붙인다
  assert.doesNotMatch(A.buildAss(lines, { w: 1280, h: 720, style: { fade: 0 } }), /\\fad/);
  // 번들 글꼴 파일 이름: 고른 글꼴 + 없는 글자를 채울 Pretendard
  assert.deepStrictEqual(A.assFont('jua').files, ['Jua-Regular.ttf', 'Pretendard-Bold.otf']);
  assert.deepStrictEqual(A.assFont('pretendard').files, ['Pretendard-Bold.otf']);
  assert.deepStrictEqual(A.assFont('system').files, []);
});

test('burnSubtitles: x264 veryfast(crf 18) 가 기본이고 옵션으로 바꿀 수 있다 · 줄마다 x/y · 숨긴 줄은 건너뜀 · 하드링크로 묶인 출력은 끊고 쓴다', { timeout: 200000 }, async () => {
  const K = require('../src/main/media/keyer');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am2-burn-'));
  const W = 320;
  const H = 180;
  const bg = path.join(dir, 'bg.mp4');
  const { runFfmpeg } = require('../src/main/media/ffmpeg');
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', `color=c=0x303030:s=${W}x${H}:d=2:r=24`, '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', bg]);
  const white = path.join(dir, 'white.png');
  const px = new Uint8ClampedArray(40 * 20 * 4);
  for (let i = 0; i < 40 * 20; i++) px.set([255, 255, 255, 255], i * 4);
  await K.writePng(white, px, 40, 20);
  const x264 = (file) => {
    const txt = fs.readFileSync(file).toString('latin1');
    const m = /options: ([^\0]*?)\0/.exec(txt.slice(txt.indexOf('x264 - core')));
    return m ? m[1] : '';
  };
  const subs = [
    { file: white, start: 0.2, end: 1.8, x: 20, y: 30, fade: 0 },
    { file: white, start: 0.2, end: 1.8, x: 200, y: 30, hidden: true }, // 숨긴 줄: 입히지 않는다
    { file: white, start: 0.2, end: 1.8, y: 120 }, // x 가 없으면 가운데
  ];
  const out = path.join(dir, 'out.mp4');
  await burnSubtitles({ video: bg, total: 2, w: W, h: H, out, subtitlePngs: subs });
  const opt = x264(out);
  assert.match(opt, /subme=2/, 'veryfast');
  assert.match(opt, /rc_lookahead=10/);
  assert.match(opt, /crf=18\.0/);
  assert.ok(Math.abs((await countFrames(out)) - 48) <= 1, '길이 그대로');
  const info = await probe(out);
  assert.ok(info.hasAudio && info.hasVideo, '노래는 그대로 복사');
  // 그 순간(1초) 프레임에서 자막이 놓인 자리를 본다
  const shot = path.join(dir, 'f.png');
  await runFfmpeg(['-y', '-ss', '1', '-i', out, '-frames:v', '1', shot]);
  const img = await K.readRgba(shot);
  const lum = (x, y) => img.data[(y * img.width + x) * 4];
  assert.ok(lum(40, 40) > 200, '보이는 줄: x=20 에서 시작');
  assert.ok(lum(10, 40) < 80, 'x=20 왼쪽은 비어 있다');
  assert.ok(lum(220, 40) < 80, '숨긴 줄(x=200)은 입히지 않았다');
  assert.ok(lum(Math.round((W - 40) / 2) + 20, 130) > 200, 'x 가 없으면 가운데');
  // 옵션으로 압축 빠르기 바꾸기
  const out2 = path.join(dir, 'out-fast.mp4');
  await burnSubtitles({ video: bg, total: 2, w: W, h: H, out: out2, subtitlePngs: subs }, { preset: 'fast', crf: 23 });
  assert.match(x264(out2), /subme=6/);
  assert.match(x264(out2), /crf=23\.0/);
  // 완성본이 깨끗한 원본과 하드링크로 같은 파일이어도(자막을 껐던 에피소드) 원본이 망가지지 않는다
  const master = path.join(dir, 'master.mp4');
  fs.copyFileSync(bg, master);
  const linked = path.join(dir, 'final.mp4');
  fs.linkSync(master, linked);
  const before = fs.readFileSync(master);
  await burnSubtitles({ video: master, total: 2, w: W, h: H, out: linked, subtitlePngs: subs });
  assert.ok(fs.statSync(linked).ino !== fs.statSync(master).ino, '끊고 새 파일로');
  assert.ok(Buffer.compare(fs.readFileSync(master), before) === 0, '깨끗한 원본은 그대로');
  assert.ok(Math.abs((await countFrames(linked)) - 48) <= 1);
  // 자막이 하나도 없어도(전부 숨김) 입히기는 끝까지 간다
  const none = path.join(dir, 'none.mp4');
  await burnSubtitles({ video: bg, total: 2, w: W, h: H, out: none, subtitlePngs: [{ ...subs[0], hidden: true }] });
  assert.ok(Math.abs((await countFrames(none)) - 48) <= 1);
});

test('burnSubtitles: 도중에 멈추거나 실패해도 예전 영상은 그대로 남고, 임시 파일(.part.mp4)은 남지 않는다 · 끝까지 가면 새 영상으로 바뀐다', { timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am2-burn-stop-'));
  const { runFfmpeg } = require('../src/main/media/ffmpeg');
  const bg = path.join(dir, 'bg.mp4');
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=0x303030:s=640x360:d=20:r=24', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=20', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', bg]);
  const out = path.join(dir, 'final.mp4');
  const tmp = `${out}.part.mp4`;
  fs.writeFileSync(out, 'OLD-VIDEO');
  // 1) 만드는 도중에 멈춤 (느린 압축이라 0.3초 안에는 끝나지 않는다)
  const ac = new AbortController();
  const running = burnSubtitles({ video: bg, total: 20, w: 640, h: 360, out, subtitlePngs: [], signal: ac.signal }, { preset: 'veryslow' });
  setTimeout(() => ac.abort(), 300);
  await assert.rejects(running, (e) => e.name === 'AbortError');
  assert.strictEqual(fs.readFileSync(out, 'utf8'), 'OLD-VIDEO', '멈추면 예전 영상이 그대로');
  assert.ok(!fs.existsSync(tmp), '임시 파일은 지운다');
  // 2) 입력이 없어서 실패
  await assert.rejects(burnSubtitles({ video: path.join(dir, 'none.mp4'), total: 2, w: 640, h: 360, out, subtitlePngs: [] }));
  assert.strictEqual(fs.readFileSync(out, 'utf8'), 'OLD-VIDEO', '실패해도 예전 영상이 그대로');
  assert.ok(!fs.existsSync(tmp));
  // 3) 끝까지 가면 새 영상으로 바뀌고 임시 파일은 없다
  await burnSubtitles({ video: bg, total: 20, w: 640, h: 360, out, subtitlePngs: [] }, { preset: 'ultrafast' });
  assert.ok(fs.statSync(out).size > 1000 && fs.readFileSync(out).subarray(4, 8).toString('latin1') === 'ftyp', '새 mp4');
  assert.ok(!fs.existsSync(tmp));
});
