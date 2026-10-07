'use strict';
// 마무리 (내 PC, ffmpeg): 컷 영상들을 화면전환으로 잇기 → 손그림 필름 느낌 입히기 → 노래 깔기 → 깨끗한 원본.
// 자막은 그 다음에 따로 입힌다 (burnSubtitles). 가사를 고쳐도 원본을 다시 만들 필요가 없다.
const fs = require('fs');
const path = require('path');
const { runFfmpeg } = require('./ffmpeg');

const FPS = 24;

/** 화면 비율 + 화질 → 출력 해상도 */
function outputSize(aspect, quality = '720p') {
  const short = quality === '1080p' ? 1080 : quality === '480p' ? 480 : 720;
  const long = Math.round((short * 16) / 9 / 2) * 2;
  switch (aspect) {
    case '16:9': return { w: long, h: short };
    case '1:1': return { w: short, h: short };
    case '4:5': return { w: short, h: Math.round((short * 5) / 4 / 2) * 2 };
    case '9:16':
    default: return { w: short, h: long };
  }
}

/** libass 용 ASS 자막 (PNG 자막을 만들 수 없을 때 사용) */
function buildAss(lyrics, { w, h, style = {} }) {
  const font = style.font || (process.platform === 'win32' ? 'Malgun Gothic' : 'Noto Sans CJK KR');
  const size = Math.round((style.sizePct || 4.2) / 100 * h);
  const margin = Math.round((style.marginPct || 8) / 100 * h);
  const primary = style.color === 'yellow' ? '&H0000E5FF' : '&H00FFFFFF';
  const box = style.box ? 3 : 1;
  const ts = (t) => {
    const cs = Math.max(0, Math.round(t * 100));
    const hh = Math.floor(cs / 360000);
    const mm = Math.floor((cs % 360000) / 6000);
    const ss = Math.floor((cs % 6000) / 100);
    return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
  };
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\{/g, '(').replace(/\}/g, ')').replace(/\n/g, '\\N');
  return [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${w}`, `PlayResY: ${h}`, 'WrapStyle: 0', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Lyric,${font},${size},${primary},&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,${box},${Math.max(2, Math.round(size / 14))},1,2,${Math.round(w * 0.06)},${Math.round(w * 0.06)},${margin},1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...lyrics.map((l) => `Dialogue: 0,${ts(l.start)},${ts(l.end)},Lyric,,0,0,0,,{\\fad(120,120)}${esc(l.text)}`),
    '',
  ].join('\n');
}

/** 은은한 종이 질감 그림 한 장 (곱하기로 살짝 입힌다) */
async function makePaperTexture(w, h, out, { signal } = {}) {
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', `color=c=0xf7f0e2:s=${w}x${h}:d=1`, '-vf',
    'noise=alls=38:allf=u,gblur=sigma=1.6,eq=contrast=0.55:brightness=0.03,format=rgb24', '-frames:v', '1', out], { signal });
  return out;
}

/** 손그림 필름 느낌 필터 (켜고 끌 수 있음) */
function finishFilters(finish = {}) {
  const f = [];
  if (finish.warm) f.push('colorbalance=rs=0.04:gs=0.01:bs=-0.04:rm=0.03:bm=-0.03:rh=0.02:bh=-0.03', 'eq=saturation=1.05');
  f.push('format=yuv420p');
  if (finish.vignette) f.push('vignette=angle=0.5');
  if (finish.grain) f.push('noise=c0s=6:c0f=t+u');
  return f;
}

/**
 * 깨끗한 원본 만들기 (자막 없음).
 * @param {object} p
 * @param {{file:string, frames:number}[]} p.shots 컷 영상 (화면전환 여분 포함)
 * @param {{xfade:string|null, frames:number}[]} p.transitions 컷 사이 전환 (shots.length-1 개)
 * @param {string} [p.song] 노래 파일
 * @param {number} p.totalFrames 최종 프레임 수 (= 노래 길이 × 24)
 * @param {{boil?:boolean,grain?:boolean,vignette?:boolean,warm?:boolean,paper?:boolean}} [p.finish]
 * @param {string} [p.paperFile] 종이 질감 그림
 */
async function assembleAnimation(p) {
  const { shots, transitions, song, totalFrames, w, h, out, signal, onProgress } = p;
  const finish = p.finish || {};
  const total = totalFrames / FPS;
  const args = ['-y'];
  shots.forEach((s) => args.push('-i', s.file));
  let idx = shots.length;
  const paperIdx = finish.paper && p.paperFile ? idx++ : -1;
  if (paperIdx >= 0) args.push('-loop', '1', '-framerate', String(FPS), '-i', p.paperFile);
  const songIdx = song ? idx++ : -1;
  if (song) args.push('-i', song);

  const f = [];
  // 모든 조각의 시간 기준을 똑같이 맞춰야 xfade/concat 을 섞어 쓸 수 있다.
  shots.forEach((_, i) => f.push(`[${i}:v]setpts=PTS-STARTPTS,fps=${FPS},settb=1/${FPS},format=yuv420p,setsar=1[c${i}]`));
  let cur = 'c0';
  let curLen = shots[0].frames;
  for (let i = 1; i < shots.length; i++) {
    const tr = transitions[i - 1] || { xfade: null, frames: 0 };
    const label = `v${i}`;
    if (tr.xfade && tr.frames > 0) {
      const off = (curLen - tr.frames) / FPS;
      f.push(`[${cur}][c${i}]xfade=transition=${tr.xfade}:duration=${(tr.frames / FPS).toFixed(6)}:offset=${off.toFixed(6)}[${label}]`);
      curLen += shots[i].frames - tr.frames;
    } else {
      f.push(`[${cur}][c${i}]concat=n=2:v=1:a=0,settb=1/${FPS}[${label}]`);
      curLen += shots[i].frames;
    }
    cur = label;
  }
  // 길이를 프레임 단위로 정확히 (모자라면 마지막 장면 유지)
  f.push(`[${cur}]tpad=stop_mode=clone:stop=${FPS * 2},trim=end_frame=${totalFrames},setpts=PTS-STARTPTS[base]`);
  cur = 'base';
  if (paperIdx >= 0) {
    f.push(`[${paperIdx}:v]scale=${w}:${h},setsar=1,format=gbrp[paper]`);
    f.push(`[${cur}]format=gbrp[bg]`);
    f.push(`[bg][paper]blend=all_mode=multiply:all_opacity=0.22:shortest=1[papered]`);
    cur = 'papered';
  }
  f.push(`[${cur}]${finishFilters(finish).join(',')}[vout]`);
  if (song) {
    const fadeOut = Math.min(2, total / 10);
    f.push(`[${songIdx}:a]atrim=0:${total.toFixed(4)},asetpts=PTS-STARTPTS,apad=whole_dur=${total.toFixed(4)},afade=t=out:st=${(total - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}[aout]`);
  }
  args.push('-filter_complex', f.join(';'), '-map', '[vout]');
  if (song) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k');
  args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-r', String(FPS), '-pix_fmt', 'yuv420p',
    '-frames:v', String(totalFrames), '-movflags', '+faststart',
    '-metadata', 'comment=Made with AI (AnimeMaker V2)', '-metadata', 'description=AI-generated content', out);
  await runFfmpeg(args, { signal, onProgress: onProgress ? (s) => onProgress(Math.min(1, s / total)) : undefined });
  return out;
}

/**
 * 깨끗한 원본 위에 가사 자막을 입힌다 (영상만 다시 압축, 노래는 그대로 복사).
 * @param {{video:string, total:number, w:number, h:number, out:string,
 *          subtitlePngs?:{start:number,end:number,file:string,y:number}[], assFile?:string, signal?:AbortSignal, onProgress?:Function}} p
 */
async function burnSubtitles(p) {
  const { video, total, out, signal, onProgress } = p;
  const subs = p.subtitlePngs || [];
  const args = ['-y', '-i', video];
  // 자막 그림은 자기가 보이는 동안만 읽는다 (빠름)
  subs.forEach((s) => args.push('-loop', '1', '-framerate', String(FPS), '-t', Math.max(0.05, s.end - s.start).toFixed(3), '-i', s.file));
  const f = ['[0:v]null[base]'];
  let cur = 'base';
  subs.forEach((s, k) => {
    const d = Math.max(0.05, s.end - s.start);
    const fi = Math.min(0.15, d / 4);
    f.push(`[${k + 1}:v]format=rgba,fade=t=in:st=0:d=${fi.toFixed(3)}:alpha=1,fade=t=out:st=${(d - fi).toFixed(3)}:d=${fi.toFixed(3)}:alpha=1,setpts=PTS-STARTPTS+${s.start.toFixed(3)}/TB[s${k}]`);
    f.push(`[${cur}][s${k}]overlay=x=(W-w)/2:y=${Math.round(s.y)}:eof_action=pass[o${k}]`);
    cur = `o${k}`;
  });
  if (!subs.length && p.assFile) {
    // 필터 문자열 안의 윈도우 경로(C:)는 이스케이프가 까다로워서,
    // ffmpeg 를 자막 파일 폴더에서 실행하고 파일 이름만 넘긴다.
    const assName = path.basename(p.assFile).replace(/[^\w.-]/g, '_');
    if (assName !== path.basename(p.assFile)) fs.copyFileSync(p.assFile, path.join(path.dirname(p.assFile), assName));
    f.push(`[${cur}]ass=${assName}[subbed]`);
    cur = 'subbed';
  }
  f.push(`[${cur}]format=yuv420p[vout]`);
  args.push('-filter_complex', f.join(';'), '-map', '[vout]', '-map', '0:a?', '-c:a', 'copy',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-r', String(FPS), '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-metadata', 'comment=Made with AI (AnimeMaker V2)', '-metadata', 'description=AI-generated content', out);
  await runFfmpeg(args, {
    signal,
    cwd: !subs.length && p.assFile ? path.dirname(p.assFile) : undefined,
    onProgress: onProgress ? (s) => onProgress(Math.min(1, s / total)) : undefined,
  });
  return out;
}

/** 미리보기용 썸네일 */
async function thumbnail(video, out, { signal } = {}) {
  await runFfmpeg(['-y', '-ss', '0.3', '-i', video, '-frames:v', '1', '-vf', 'scale=360:-2', out], { signal });
  return out;
}

module.exports = { outputSize, buildAss, makePaperTexture, finishFilters, assembleAnimation, burnSubtitles, thumbnail, FPS };
