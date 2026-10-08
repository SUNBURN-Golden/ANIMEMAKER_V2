// 연습 모드 그림·노래 (AI 없이, 인터넷 없이, 무료): PC 앱 ai/demo.js 의 ffmpeg 그림 그리기를 canvas 로 옮긴 것.
//   demoBg({W,H,shot,seed})                          → Blob(png)  하늘 · 해 · 구름 · 언덕 · 땅 · 나무 (컷마다 다른 색, 인물 없음)
//   demoCel({W,H,shot,index,count,highlight,motion,keyColor,palette}) → Blob(png)  한 가지 단색(키 색) 배경 위에 인물만 → 배경 빼기가 되도록
//   demoDrawing({W,H,shot,index,count,highlight,palette})            → Blob(png)  배경 + 인물 통째 그림 (레이어를 안 쓰는 타임시트용)
//   demoCharacterRef({kind,palette,W,H})            → Blob(png)  기준 그림 ('turnaround' | 'expressions' | 'fullbody')
//   demoSong({seconds,bpm,seed})                    → Blob(wav)  박자가 또렷한 노래 (킥 · 하이햇 · 화음), demoSongSamples 는 같은 소리의 PCM
// 인물 모양은 PC 앱과 같은 공용 함수 figureBoxes 가 돌려주는 상자 좌표를 그대로 칠한다. 같은 입력 → 같은 결과(난수는 seed 로 정해진다).
import DemoData from '../../../../src/main/ai/demo-data.js';
import KeyerCore from '../../../../src/main/media/keyer-core.js';
import { makeCanvas, canvasToBlob } from './util.js';
import { mulberry32 } from './finish.js';

const { PALETTE, DEMO_CHARACTER, hex, figureBoxes } = DemoData;

const BOX_RE = /drawbox=x=(-?\d+):y=(-?\d+):w=(\d+):h=(\d+):color=0x([0-9a-fA-F]{6})/;

/** figureBoxes 의 ffmpeg 글자 → 칠할 사각형들 */
export function figureRects(cx, by, u, palette, pose) {
  return figureBoxes(cx, by, u, palette, pose).map((s) => {
    const m = BOX_RE.exec(s);
    return { x: +m[1], y: +m[2], w: +m[3], h: +m[4], color: `#${m[5]}` };
  });
}

function paint(ctx, rects) {
  for (const r of rects) { ctx.fillStyle = r.color; ctx.fillRect(r.x, r.y, r.w, r.h); }
}
const R = Math.round;

function shotColors(shot) {
  return [`#${PALETTE[(shot * 3) % PALETTE.length]}`, `#${PALETTE[(shot * 3 + 5) % PALETTE.length]}`];
}

function ellipse(ctx, cx, cy, rx, ry, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
}

/** 배경 판 그리기 (하늘 그라디언트 · 해 · 구름 · 먼 언덕 · 땅 · 나무) */
function drawBackground(ctx, W, H, shot, seed) {
  const [c0, c1] = shotColors(shot);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, c0);
  g.addColorStop(1, c1);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // 해
  ellipse(ctx, W * 0.76 + H * 0.065, H * 0.1 + H * 0.065, H * 0.065, H * 0.065, '#fff4c2');
  // 구름 (seed · shot 으로 자리가 정해진다)
  const rnd = mulberry32(((seed | 0) * 1009 + shot * 7919) >>> 0);
  for (let k = 0; k < 3; k++) {
    const cx = W * (0.1 + 0.8 * rnd());
    const cy = H * (0.07 + 0.2 * rnd());
    const rw = W * (0.05 + 0.04 * rnd());
    for (const [dx, dy, s] of [[-0.8, 0.15, 0.7], [0, 0, 1], [0.85, 0.12, 0.75]]) ellipse(ctx, cx + dx * rw, cy + dy * rw * 0.5, rw * s, rw * 0.42 * s, 'rgba(255,255,255,0.72)');
  }
  // 먼 언덕과 땅 (수평선은 화면 72% 높이)
  ellipse(ctx, W * 0.225, H * 0.74, W * 0.24, H * 0.12, '#4a7d4f');
  ellipse(ctx, W * 0.75, H * 0.74, W * 0.28, H * 0.16, '#3e6e45');
  ctx.fillStyle = '#2f5d3a';
  ctx.fillRect(0, H * 0.72, W, H * 0.28);
  // 나무
  [0.12, 0.3, 0.68, 0.88].forEach((x, k) => {
    const top = H * (0.4 + 0.05 * (k % 2));
    ctx.fillStyle = '#5a3d28';
    ctx.fillRect(R(W * x), R(top), R(W * 0.035), R(H * 0.3));
    ellipse(ctx, W * x + W * 0.0175, H * (0.3 + 0.05 * (k % 2)) + H * 0.07, W * 0.0475, H * 0.07, '#2e7d32');
  });
}

const newCanvas = (W, H) => {
  const c = makeCanvas(W, H);
  return { c, ctx: c.getContext('2d') };
};

export async function demoBg({ W = 1280, H = 720, shot = 1, seed = 1 } = {}) {
  const { c, ctx } = newCanvas(W, H);
  drawBackground(ctx, W, H, shot, seed);
  return canvasToBlob(c, 'image/png');
}

/** 인물 셀: 단색 배경 + 인물. 움직이는 컷은 열쇠 그림마다 팔 · 다리 · 몸이 조금씩 다르다 (같은 자세가 두 번 이어지지 않게 반 칸 어긋난 위상) */
export function celPose({ W, H, shot = 1, index = 0, count = 1, highlight = false, motion = false }) {
  const u = Math.min(W, H) / 7;
  const ang = count > 1 ? ((index + 0.5) / count) * Math.PI * 2 : 0;
  if (!motion && highlight) {
    const ph = count > 1 ? index / count : 0;
    return {
      u, cx: W * (0.3 + 0.4 * ph) + (shot % 3) * W * 0.03, by: H * 0.36 - u * 0.6 * Math.abs(Math.sin(ph * Math.PI * 2)),
      pose: { arm: index % 2 ? 0.7 : 0, leg: 0.4 * Math.sin(ph * Math.PI * 4), scarf: 0.3 + 0.4 * (index % 3) },
    };
  }
  return {
    u, cx: W * (0.48 + (motion ? 0.012 * Math.sin(ang) : 0.02 * index)) + (shot % 3) * W * 0.03, by: H * 0.36 - (motion ? u * 0.1 * Math.abs(Math.cos(ang)) : 0),
    pose: { arm: motion ? 0.35 + 0.4 * Math.sin(ang) : (index % 2) * 0.5, leg: motion ? 0.8 * Math.cos(ang) : 0, scarf: motion ? 0.25 + 0.15 * Math.cos(ang) : 0.2 },
  };
}

export async function demoCel(o = {}) {
  const { W = 1280, H = 720, palette = DEMO_CHARACTER.palette } = o;
  const key = String(o.keyColor || KeyerCore.keyColorFor(palette));
  const { c, ctx } = newCanvas(W, H);
  ctx.fillStyle = key.startsWith('#') ? key : `#${key}`;
  ctx.fillRect(0, 0, W, H);
  const p = celPose({ ...o, W, H });
  paint(ctx, figureRects(p.cx, p.by, p.u, palette, p.pose));
  return canvasToBlob(c, 'image/png');
}

/** 통째 그림 (배경 + 인물): 레이어를 쓰지 않는 타임시트에서 쓴다 */
export async function demoDrawing(o = {}) {
  const { W = 1280, H = 720, shot = 1, index = 0, count = 1, highlight = false, palette = DEMO_CHARACTER.palette, seed = 1 } = o;
  const { c, ctx } = newCanvas(W, H);
  drawBackground(ctx, W, H, shot, seed);
  const u = Math.min(W, H) / 7;
  const ph = count > 1 ? index / count : 0;
  const cx = W * (highlight ? 0.3 + 0.4 * ph : 0.45 + 0.08 * ph);
  const by = H * 0.42 - (highlight ? u * 0.6 * Math.abs(Math.sin(ph * Math.PI * 2)) : 0);
  paint(ctx, figureRects(cx, by, u, palette, { arm: index % 2 ? 0.7 : 0, scarf: highlight ? 0.3 + 0.4 * (index % 3) : 0.2 }));
  return canvasToBlob(c, 'image/png');
}

/** 캐릭터 기준 그림 (턴어라운드 4면 · 표정 6개 · 전신) */
export async function demoCharacterRef({ kind = 'turnaround', palette = DEMO_CHARACTER.palette, W = 1536, H = 1024 } = {}) {
  const { c, ctx } = newCanvas(W, H);
  ctx.fillStyle = '#fdfcf8';
  ctx.fillRect(0, 0, W, H);
  const u = Math.min(W, H) / 8;
  if (kind === 'expressions') {
    for (let i = 0; i < 6; i++) {
      const cx = W * (0.2 + 0.3 * (i % 3));
      const cy = H * (0.3 + 0.42 * Math.floor(i / 3));
      paint(ctx, [
        { x: R(cx - u), y: R(cy - u), w: R(u * 2), h: R(u * 2), color: `#${hex(palette, 4, '#f6d5bf')}` },
        { x: R(cx - u * 1.05), y: R(cy - u * 1.1), w: R(u * 2.1), h: R(u * 0.7), color: `#${hex(palette, 1, '#6b3e26')}` },
        { x: R(cx - u * 0.5), y: R(cy + u * (0.3 + 0.1 * (i % 3))), w: R(u), h: R(u * 0.15 * (1 + (i % 2))), color: '#7a2a2a' },
      ]);
    }
  } else if (kind === 'fullbody') {
    paint(ctx, figureRects(W * 0.5, H * 0.3, u * 1.6, palette, { scarf: 0.4 }));
  } else {
    for (let i = 0; i < 4; i++) paint(ctx, figureRects(W * (0.14 + 0.24 * i), H * 0.32, u * 1.1, palette, { scarf: i === 3 ? 0 : 0.2 }));
  }
  return canvasToBlob(c, 'image/png');
}

// ---------- 연습용 노래 ----------
const SONG_SR = 22050;
const CHORDS = [
  [[261.63, 329.63, 392.0], [220.0, 277.18, 329.63], [174.61, 220.0, 261.63], [196.0, 246.94, 293.66]],
  [[220.0, 277.18, 329.63], [196.0, 246.94, 293.66], [261.63, 329.63, 392.0], [174.61, 220.0, 261.63]],
  [[174.61, 220.0, 261.63], [261.63, 329.63, 392.0], [196.0, 246.94, 293.66], [220.0, 277.18, 329.63]],
];

/** PCM(Float32, 모노 22050Hz): 마디 첫 박은 센 킥, 나머지 박은 약한 킥, 엇박에 하이햇, 마디마다 바뀌는 삼각파 화음. seed 가 화음 진행을 고른다 */
export function demoSongSamples({ seconds = 60, bpm = 120, seed = 1 } = {}) {
  const n = Math.round(SONG_SR * seconds);
  const out = new Float32Array(n);
  const beat = 60 / bpm;
  const prog = CHORDS[((seed | 0) % 3 + 3) % 3];
  for (let i = 0, t = 0; t < seconds; i++, t = i * beat) {
    const level = i % 4 === 0 ? 0.95 : 0.6;
    const s0 = Math.round(t * SONG_SR);
    // 킥: 140Hz → 45Hz (0.12초 동안 지수로), 소리 크기 level → 0.001 (0.25초 동안 지수로)
    let phase = 0;
    const len = Math.round(0.3 * SONG_SR);
    for (let k = 0; k < len && s0 + k < n; k++) {
      const tt = k / SONG_SR;
      const f = tt < 0.12 ? 140 * Math.pow(45 / 140, tt / 0.12) : 45;
      phase += (2 * Math.PI * f) / SONG_SR;
      const g = tt < 0.25 ? level * Math.pow(0.001 / level, tt / 0.25) : 0.001 * Math.max(0, 1 - (tt - 0.25) / 0.05);
      out[s0 + k] += Math.sin(phase) * g;
    }
    // 하이햇(엇박): 6800Hz 네모파, 0.03 → 0.0005
    const h0 = Math.round((t + beat / 2) * SONG_SR);
    const hl = Math.round(0.05 * SONG_SR);
    for (let k = 0; k < hl && h0 + k < n; k++) {
      const tt = k / SONG_SR;
      const g = tt < 0.04 ? 0.03 * Math.pow(0.0005 / 0.03, tt / 0.04) : 0;
      out[h0 + k] += (Math.sin(2 * Math.PI * 6800 * tt) >= 0 ? 1 : -1) * g;
    }
  }
  const bar = beat * 4;
  for (let b = 0, t = 0; t < seconds; b++, t = b * bar) {
    const s0 = Math.round(t * SONG_SR);
    const s1 = Math.min(n, Math.round((t + bar) * SONG_SR));
    for (const f of prog[b % prog.length]) {
      for (let s = s0; s < s1; s++) {
        const tt = (s - s0) / SONG_SR;
        const env = tt < 0.05 ? 0.0001 + (0.05 - 0.0001) * (tt / 0.05)
          : tt < bar - 0.05 ? 0.05 + (0.03 - 0.05) * ((tt - 0.05) / (bar - 0.1))
            : 0.03 * Math.max(0, (bar - tt) / 0.05);
        const x = ((f * (s / SONG_SR)) % 1 + 1) % 1;
        out[s] += (2 * Math.abs(2 * x - 1) - 1) * env;
      }
    }
  }
  for (let s = 0; s < n; s++) out[s] = Math.max(-1, Math.min(1, out[s] * 0.8));
  return { samples: out, sampleRate: SONG_SR };
}

function wav16(samples, sr) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 0x7fff), true);
  return view.buffer;
}

export async function demoSong(o = {}) {
  const { samples, sampleRate } = demoSongSamples(o);
  return new Blob([wav16(samples, sampleRate)], { type: 'audio/wav' });
}
