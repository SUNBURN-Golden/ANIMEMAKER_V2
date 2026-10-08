'use strict';
// 마무리 (내 PC, ffmpeg): 컷 영상들을 화면전환으로 잇기 → 손그림 필름 느낌 입히기 → 노래 깔기 → 깨끗한 원본.
// 자막은 그 다음에 따로 입힌다 (burnSubtitles). 가사를 고쳐도 원본을 다시 만들 필요가 없다.
const fs = require('fs');
const path = require('path');
const { runFfmpeg } = require('./ffmpeg');
const S = require('../../shared/subtitle-style');

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

/** ASS 색: '#rrggbb' + 불투명도(0~1) → &HAABBGGRR (ASS 의 AA 는 0 = 불투명) */
function assColor(hex, opacity = 1) {
  const c = S.normColor(hex, '#000000');
  const aa = Math.round((1 - Math.min(1, Math.max(0, opacity))) * 255);
  const h2 = (n) => n.toString(16).padStart(2, '0').toUpperCase();
  return `&H${h2(aa)}${c.slice(5, 7)}${c.slice(3, 5)}${c.slice(1, 3)}`.toUpperCase();
}

/** 내 컴퓨터 기본 한글 글꼴 이름 (ASS 대체 경로에서만 쓴다) */
function systemFontName() {
  if (process.platform === 'win32') return 'Malgun Gothic';
  if (process.platform === 'darwin') return 'Apple SD Gothic Neo';
  return 'Noto Sans CJK KR';
}

/** libass 가 쓸 글꼴: { name, bold, k (크기 보정 비율), files:[번들 글꼴 파일 이름] } (files 는 src/renderer/assets/fonts 안 파일) */
function assFont(styleFont) {
  const f = S.FONT_BY_ID[styleFont] || S.FONT_BY_ID.pretendard;
  if (!f.file) return { name: systemFontName(), bold: true, k: process.platform === 'win32' ? 1.25 : process.platform === 'darwin' ? 1.2 : 1.45, files: [] };
  return { name: f.ass.name, bold: f.ass.bold, k: f.ass.k, files: [...new Set([f.file, S.FONT_BY_ID.pretendard.file])] };
}

/**
 * libass 용 ASS 자막 (PNG 자막을 만들 수 없을 때 사용).
 * PNG 자막과 같은 정규화 스타일을 읽어서 색 · 테두리 · 상자 · 위치 · 안전영역 · 글꼴이 최대한 같게 만든다.
 * 줄바꿈은 libass 가 알아서 한다 (PNG 쪽의 균형 잡힌 줄바꿈과 조금 다를 수 있다). 숨긴 줄(hidden)은 넣지 않는다.
 * @param {{text:string,start:number,end:number,hidden?:boolean}[]} lyrics
 * @param {{w:number,h:number,style?:object}} o style 은 어떤 형식이든 된다 (옛 형식 포함)
 */
function buildAss(lyrics, { w, h, style = {} }) {
  const st = S.normalizeStyle(style, { w, h });
  const m = S.layoutMetrics(st, w, h);
  const font = assFont(st.font);
  // libass 의 글자 크기는 글꼴의 줄 높이 기준이라 PNG(em 기준)보다 작게 보인다 → 글꼴마다 실측한 비율 k 로 맞춘다
  const size = Math.round(m.fontPx * font.k);
  const hasBox = st.box !== 'none';
  const primary = assColor(st.color, 1);
  // BorderStyle 3(불투명 상자)은 OutlineColour 로 상자를 칠한다
  const outlineCol = hasBox ? assColor(st.boxColor, S.boxAlpha(st)) : assColor(st.outlineColor, S.outlineAlpha(st));
  const back = assColor('#000000', 0.5);
  const outline = hasBox ? Math.max(1, Math.round(m.fontPx * 0.2)) : (m.strokePx > 0 ? Math.max(1, Math.round(m.strokePx / 2)) : 0);
  const shadow = st.shadow && !hasBox ? Math.max(1, Math.round(m.fontPx / 30)) : 0;
  const align = st.position === 'top' ? 8 : st.position === 'middle' ? 5 : 2;
  // 글자 줄의 가운데가 PNG 와 같은 높이에 오도록 안쪽으로 0.48em 더 밀어 준다 (실측: libass 의 줄 상자는 글꼴 줄 높이를 쓴다)
  const marginV = st.position === 'top' ? m.topPx + Math.round(m.fontPx * 0.48) : st.position === 'bottom' ? m.bottomPx + Math.round(m.fontPx * 0.48) : 0;
  const fadeMs = Math.round(st.fade * 1000);
  const ts = (t) => {
    const cs = Math.max(0, Math.round(t * 100));
    const hh = Math.floor(cs / 360000);
    const mm = Math.floor((cs % 360000) / 6000);
    const ss = Math.floor((cs % 6000) / 100);
    return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
  };
  const esc = (x) => String(x).replace(/\\/g, '\\\\').replace(/\{/g, '(').replace(/\}/g, ')').replace(/\n/g, '\\N');
  return [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${w}`, `PlayResY: ${h}`, 'WrapStyle: 0', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Lyric,${font.name},${size},${primary},&H000000FF,${outlineCol},${back},${font.bold ? -1 : 0},0,0,0,100,100,0,0,${hasBox ? 3 : 1},${outline},${shadow},${align},${m.margin.left},${m.margin.right},${marginV},1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...lyrics.filter((l) => l && !l.hidden && l.text).map((l) => `Dialogue: 0,${ts(l.start)},${ts(l.end)},Lyric,,0,0,0,,${fadeMs > 0 ? `{\\fad(${fadeMs},${fadeMs})}` : ''}${esc(l.text)}`),
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
  const tmp = partFile(out); // 새 영상은 임시 이름으로 만들고 다 끝나면 바꾼다: 도중에 멈춰도 예전 영상이 그대로 남는다
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
    '-metadata', 'comment=Made with AI (AnimeMaker V2)', '-metadata', 'description=AI-generated content', tmp);
  try {
    await runFfmpeg(args, { signal, onProgress: onProgress ? (s) => onProgress(Math.min(1, s / total)) : undefined });
    swapIn(tmp, out);
  } catch (e) {
    discard(tmp);
    throw e;
  }
  return out;
}

/** 임시 출력 이름 (같은 폴더, 확장자는 .mp4 로 끝나야 ffmpeg 가 mp4 로 만든다) */
function partFile(out) { return `${out}.part.mp4`; }
function discard(f) { try { fs.unlinkSync(f); } catch (_) { /* 없으면 괜찮다 */ } }
/**
 * 다 만든 임시 파일을 진짜 이름으로 바꾼다. 예전 파일은 이름만 지우므로, 자막을 끈 에피소드처럼
 * 완성본이 깨끗한 원본과 하드링크로 같은 파일이어도 원본은 그대로 남는다.
 */
function swapIn(tmp, out) {
  try { fs.unlinkSync(out); } catch (_) { /* 없으면 괜찮다 */ }
  fs.renameSync(tmp, out);
}

/**
 * 깨끗한 원본 위에 가사 자막을 입힌다 (영상만 다시 압축, 노래는 그대로 복사).
 * 압축은 x264 veryfast + crf 18 (같은 화질에 fast 보다 약 2배 빠르다). 바꾸고 싶으면 opts.preset / opts.crf.
 * @param {{video:string, total:number, w:number, h:number, out:string,
 *          subtitlePngs?:{start:number,end:number,file:string,y:number,x?:number,fade?:number,hidden?:boolean}[],
 *          assFile?:string, assFonts?:string[], signal?:AbortSignal, onProgress?:Function}} p
 *   subtitlePngs 의 x 는 PNG 왼쪽 가장자리(없으면 가운데), y 는 위쪽 가장자리, fade 는 페이드 초(기본 0.15). hidden 인 것은 건너뛴다.
 *   assFile 은 PNG 가 없을 때의 대체 경로(libass), assFonts 는 그때 쓸 글꼴 파일(없어도 된다).
 * @param {{preset?:string, crf?:number}} [opts]
 */
async function burnSubtitles(p, opts = {}) {
  const { video, total, out, signal, onProgress } = p;
  const preset = opts.preset || p.preset || 'veryfast';
  const crf = opts.crf ?? p.crf ?? 18;
  const subs = (p.subtitlePngs || []).filter((s) => s && !s.hidden && s.file);
  const tmp = partFile(out); // 임시 이름으로 만들고 끝나면 바꾼다 (멈춰도 예전 영상이 남는다)
  const args = ['-y', '-i', video];
  // 자막 그림은 자기가 보이는 동안만 읽는다 (빠름)
  subs.forEach((s) => args.push('-loop', '1', '-framerate', String(FPS), '-t', Math.max(0.05, s.end - s.start).toFixed(3), '-i', s.file));
  const f = ['[0:v]null[base]'];
  let cur = 'base';
  subs.forEach((s, k) => {
    const d = Math.max(0.05, s.end - s.start);
    const fi = Math.min(Number.isFinite(s.fade) ? s.fade : 0.15, d / 4);
    const fades = fi >= 0.01
      ? `fade=t=in:st=0:d=${fi.toFixed(3)}:alpha=1,fade=t=out:st=${(d - fi).toFixed(3)}:d=${fi.toFixed(3)}:alpha=1,`
      : '';
    f.push(`[${k + 1}:v]format=rgba,${fades}setpts=PTS-STARTPTS+${s.start.toFixed(3)}/TB[s${k}]`);
    const x = Number.isFinite(s.x) ? Math.round(s.x) : '(W-w)/2';
    f.push(`[${cur}][s${k}]overlay=x=${x}:y=${Math.round(s.y)}:eof_action=pass[o${k}]`);
    cur = `o${k}`;
  });
  let cwd;
  if (!subs.length && p.assFile) {
    // 필터 문자열 안의 윈도우 경로(C:)는 이스케이프가 까다로워서,
    // ffmpeg 를 자막 파일 폴더에서 실행하고 파일 이름만 넘긴다.
    const assDir = path.dirname(p.assFile);
    const assName = path.basename(p.assFile).replace(/[^\w.-]/g, '_');
    if (assName !== path.basename(p.assFile)) fs.copyFileSync(p.assFile, path.join(assDir, assName));
    let filter = `ass=${assName}`;
    const fonts = (p.assFonts || []).filter((x) => x && fs.existsSync(x));
    if (fonts.length) {
      // 번들 글꼴을 자막 폴더 안 fonts/ 로 복사해 두고 상대 경로로 알려 준다 (윈도우 경로 이스케이프 피하기)
      const fd = path.join(assDir, 'fonts');
      fs.mkdirSync(fd, { recursive: true });
      for (const x of fonts) fs.copyFileSync(x, path.join(fd, path.basename(x)));
      filter += ':fontsdir=fonts';
    }
    f.push(`[${cur}]${filter}[subbed]`);
    cur = 'subbed';
    cwd = assDir;
  }
  f.push(`[${cur}]format=yuv420p[vout]`);
  args.push('-filter_complex', f.join(';'), '-map', '[vout]', '-map', '0:a?', '-c:a', 'copy',
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-r', String(FPS), '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-metadata', 'comment=Made with AI (AnimeMaker V2)', '-metadata', 'description=AI-generated content', tmp);
  try {
    await runFfmpeg(args, {
      signal,
      cwd,
      onProgress: onProgress ? (s) => onProgress(Math.min(1, s / total)) : undefined,
    });
    swapIn(tmp, out);
  } catch (e) {
    discard(tmp);
    throw e;
  }
  return out;
}

/** 미리보기용 썸네일 */
async function thumbnail(video, out, { signal } = {}) {
  await runFfmpeg(['-y', '-ss', '0.3', '-i', video, '-frames:v', '1', '-vf', 'scale=360:-2', out], { signal });
  return out;
}

module.exports = { outputSize, buildAss, assFont, makePaperTexture, finishFilters, assembleAnimation, burnSubtitles, thumbnail, FPS };
