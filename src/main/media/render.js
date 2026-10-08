'use strict';
// 렌더링 합성기 (앱 안에 들어 있음, 따로 설치할 것 없음): 타임시트의 컷 하나 → 영상 조각. — 그림을 읽고 영상으로 쓰는 부분.
//  - 타임시트대로 그림을 프레임 수만큼 보여 준다 (노출, 사이 그림 포함).
//  - 멀티플레인(배경 판 + 인물 셀), 카메라(팬·줌·트럭·흔들기), 라인 보일, 효과(fx) 같은 픽셀 계산은 render-core.js 로 옮겨
//    폰 앱과 같은 파일을 쓴다. 여기서는 그 이름을 그대로 다시 내보내므로 `require('./media/render')` 는 예전과 똑같이 쓸 수 있다.
//    픽셀 계산은 앱이 직접 하고, 그림 읽기·영상 압축만 ffmpeg 가 한다.
//  - 여기에 남은 것: decodeCover (ffmpeg 로 그림 읽기), renderShot (fs + ffmpeg 로 컷 영상 만들기).
const fs = require('fs');
const { runFfmpeg, ffmpegWriter } = require('./ffmpeg');
const { cameraAt, frameTable, FPS } = require('../pipeline/xsheet');
const core = require('./render-core');

const { rand, parallaxFraming, coverSize, blankImage, sampleFrame, fxState, applyFx, composite } = core;

/**
 * 그림 파일 → 화면 비율에 맞춰 꽉 채운 RGB 픽셀 (cw×ch).
 * rgba: 투명 셀은 '미리 곱한 알파' RGBA 로 (크기를 바꾸기 전에 곱해야 투명한 곳의 배경색이 테두리에 번지지 않는다)
 */
async function decodeCover(file, cw, ch, signal, { rgba = false } = {}) {
  const fmt = rgba ? 'rgba' : 'rgb24';
  const k = rgba ? 4 : 3;
  const { stdout } = await runFfmpeg(['-i', file, '-frames:v', '1', '-vf',
    `${rgba ? 'format=rgba,premultiply=inplace=1,' : ''}scale=${cw}:${ch}:force_original_aspect_ratio=increase:flags=lanczos,crop=${cw}:${ch},format=${fmt}`,
    '-f', 'rawvideo', '-pix_fmt', fmt, 'pipe:1'], { capture: 'stdout', signal });
  if (stdout.length < cw * ch * k) throw new Error(`그림을 읽지 못했습니다: ${file}`);
  return stdout.subarray(0, cw * ch * k);
}

/**
 * 컷 하나 렌더링 → 영상 조각 (24fps, 프레임 수 = lead + 컷 프레임 + tail).
 * lead/tail 은 화면전환으로 앞뒤 컷과 겹치는 여분 프레임 (첫/마지막 구도를 유지).
 * @param {{shot:object, table?:string[], bg?:string|null, layers?:Map<string,string|null>, files?:Map<string,string|null>,
 *          parallax?:number, W:number, H:number, lead?:number, tail?:number,
 *          boil?:boolean, seed?:number, out:string, signal?:AbortSignal, onProgress?:(f:number)=>void}} o
 *   table: 컷 프레임마다 보이는 그림 id (사이 그림 'A~B' 포함). 없으면 노출표 그대로.
 *   bg: 배경 판 그림 (있으면 멀티플레인, layers 는 투명 셀). 없으면 layers/files 는 전체 화면 그림.
 */
async function renderShot(o) {
  const { shot, W, H, out, signal } = o;
  const lead = o.lead || 0;
  const tail = o.tail || 0;
  const N = shot.frames;
  const total = lead + N + tail;
  const table = o.table || frameTable(shot);
  if (table.length !== N) throw new Error(`컷 ${shot.shot}: 타임시트 프레임 합계(${table.length})가 컷 길이(${N})와 달라요.`);
  const files = o.layers || o.files || new Map();
  const parallax = o.parallax ?? 0.8;
  const cam = shot.camera;
  const fx = shot.fx || [];
  const seed = (o.seed || 1) * 7919 + shot.shot;
  // 가장 크게 확대하는 만큼 그림을 크게 펼쳐 둔다 (확대해도 흐려지지 않게)
  const { cw, ch } = coverSize(cam, W, H);
  const layered = !!(o.bg && fs.existsSync(o.bg));
  const bgImg = layered ? await decodeCover(o.bg, cw, ch, signal) : null;
  const imgs = new Map();
  for (const id of new Set(table)) {
    const f = files.get(id);
    if (layered) imgs.set(id, f && fs.existsSync(f) ? await decodeCover(f, cw, ch, signal, { rgba: true }) : Buffer.alloc(cw * ch * 4));
    else imgs.set(id, f && fs.existsSync(f) ? await decodeCover(f, cw, ch, signal) : blankImage(cw, ch));
  }
  const enc = ffmpegWriter(['-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(FPS), '-i', 'pipe:0',
    '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-r', String(FPS), out], { signal });
  let prevKey = '';
  let prevBuf = null;
  let bgKey = '';
  let bgBuf = null;
  try {
    for (let r = 0; r < total; r++) {
      const f = Math.min(N - 1, Math.max(0, r - lead));
      const id = table[f];
      const base = cameraAt(cam, N > 1 ? f / (N - 1) : 0);
      const st = fxState(fx, f, N);
      // 카메라 흔들기 (배경·인물 모두)
      let sx = 0;
      let sy = 0;
      const amp = (cam.move === 'shake' ? (cam.shake || 0.012) : 0) + st.shake * 0.02;
      if (amp > 0) {
        const k = Math.floor(r / 2);
        sx = (rand(seed, k, 3) - 0.5) * 2 * amp * W;
        sy = (rand(seed, k, 4) - 0.5) * 2 * amp * H;
      }
      // 라인 보일: 2프레임마다 아주 작은 위치·크기 떨림 (손으로 찍은 셀 애니 느낌, 인물 셀만)
      const fr = { ...base };
      let dx = sx;
      let dy = sy;
      if (o.boil) {
        const k = Math.floor(r / 2);
        dx += (rand(seed, k, 1) - 0.5) * 1.1;
        dy += (rand(seed, k, 2) - 0.5) * 1.1;
        fr.zoom = Math.max(1, fr.zoom * (1 + (rand(seed, k, 5) - 0.5) * 0.0025));
      }
      const bfr = layered ? parallaxFraming(base, parallax) : null;
      const key = `${id}|${fr.zoom.toFixed(5)}|${fr.x.toFixed(5)}|${fr.y.toFixed(5)}|${dx.toFixed(3)}|${dy.toFixed(3)}|${bfr ? `${bfr.zoom.toFixed(5)}|${sx.toFixed(3)}|${sy.toFixed(3)}` : ''}|${st.fade.toFixed(3)}|${st.flash.toFixed(3)}|${st.sparkle ? r : ''}`;
      let buf = prevBuf;
      if (key !== prevKey) {
        if (layered) {
          const bk = `${bfr.zoom.toFixed(5)}|${bfr.x.toFixed(5)}|${bfr.y.toFixed(5)}|${sx.toFixed(3)}|${sy.toFixed(3)}`;
          if (bk !== bgKey) { bgBuf = sampleFrame(bgImg, cw, ch, W, H, bfr, sx, sy, 3); bgKey = bk; }
          buf = composite(sampleFrame(imgs.get(id), cw, ch, W, H, fr, dx, dy, 4), bgBuf, W * H);
        } else {
          buf = sampleFrame(imgs.get(id), cw, ch, W, H, fr, dx, dy, 3);
        }
        applyFx(buf, st, W, H, seed, r);
      }
      await enc.write(buf);
      prevKey = key;
      prevBuf = buf;
      if (o.onProgress && r % 24 === 0) o.onProgress(r / total);
    }
  } finally {
    await enc.end();
  }
  return { file: out, frames: total, layered };
}

module.exports = { ...core, renderShot, decodeCover };
