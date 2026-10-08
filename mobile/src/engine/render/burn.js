// 자막 입히기: 깨끗한 원본(자막 없음)에 가사 자막을 얹은 완성본을 만든다 — 소리는 다시 압축하지 않고 그대로 복사한다.
//   const r = await burnSubtitles({ clean, lines, style, W, H, onProgress, signal, tags });  // → { blob, codecs, burned, subsFallback, … }
//   makeSrt(lines) / makeLrc(lines, title)  PC 앱(runner.step_subtitles → timeline.toSrt/toLrc)과 같은 글 (숨긴 줄 · 빈 줄 제외)
//
// 방식: Mediabunny Conversion + video.process 훅. 원본의 한 장을 디코딩해서 캔버스에 그리고, 그 위에 자막을 얹어 돌려주면 다시 인코딩한다.
//   PC 앱과 같은 규칙: 줄은 한 번 투명 캔버스(PNG 와 같은 그림)로 그려 두고 장마다 페이드(min(fade, 보이는 시간/4))만 곱해 붙인다.
//   → 깨끗한 원본은 그대로 두고, 가사·스타일을 바꿔도 인코딩 한 번(몇 분)이면 다시 만들 수 있다.
//   글꼴: 시작 전에 번들 글꼴을 읽을 때까지 기다린 뒤 줄 크기를 잰다. 못 읽으면 시스템 한글 글꼴로 대신하고 subsFallback:true 를 돌려준다.
import { Input, BlobSource, MP4, Output, Mp4OutputFormat, BufferTarget, Conversion, ConversionCanceledError } from 'mediabunny';
import SubStyle from '../../../../src/shared/subtitle-style.js';
import SubRender from '../../../../src/shared/subtitle-render.js';
import Timeline from '../../../../src/main/media/timeline.js';
import { installFonts } from '../../fonts.js';
import { probeEncoders, assertVideoEncoder } from './codecs.js';
import { createMeter } from './progress.js';
import { AI_TAGS } from './export.js';
import { defaultBitrate } from './frames.js';
import { makeCanvas, frameContext, createPacer, throwIfAborted, abortError, nowMs } from './util.js';

/** 영상·SRT·LRC 에 넣는 줄: 숨긴 줄과 빈 줄은 뺀다 */
const shownLines = (lines) => (lines || []).filter((l) => l && !l.hidden && l.text);

export function makeSrt(lines) {
  return Timeline.toSrt(shownLines(lines));
}
export function makeLrc(lines, title) {
  return Timeline.toLrc(shownLines(lines), title);
}

/**
 * 자막에 쓸 글꼴을 읽어 둔다 (@font-face 를 넣고 document.fonts.load 를 기다린다).
 * @returns {Promise<{ok:boolean, fallback:boolean, families:string[]}>} ok=false 면 번들 글꼴을 못 읽어서 시스템 글꼴로 그려진다
 */
export async function ensureSubtitleFonts(style, text = '가나다라마바사 ABC 123') {
  const st = SubStyle.normalizeStyle(style);
  const families = SubStyle.fontFamiliesFor(st);
  if (!families.length) return { ok: true, fallback: false, families }; // '내 폰 기본' 글꼴: 읽을 것이 없다
  if (typeof document === 'undefined' || !document.fonts) return { ok: false, fallback: true, families };
  try {
    installFonts();
    const css = SubStyle.fontCss(st, 40);
    const sample = String(text).slice(0, 400) || '가나다';
    await document.fonts.load(css, sample);
    const ok = document.fonts.check(css, sample);
    return { ok, fallback: !ok, families };
  } catch (_) {
    return { ok: false, fallback: true, families };
  }
}

/**
 * 시각 t 의 자막을 그리는 도구. 줄은 처음 보일 때 한 번 투명 캔버스로 그려 두고(레이아웃 · 글꼴은 공용 AMSubtitleRender), 끝나면 버린다.
 * @returns {{draw:(ctx:any,t:number)=>number, dispose:()=>void}} draw 는 그린 줄 수를 돌려준다
 */
export function createSubtitleDrawer({ lines, style, W, H, createCanvas = makeCanvas }) {
  const st = SubStyle.normalizeStyle(style, { w: W, h: H });
  const list = shownLines(lines).slice().sort((a, b) => a.start - b.start);
  const cache = new Map();
  const render = (l) => {
    const r = SubRender.lineToCanvas(createCanvas, l.text, st, W, H);
    return r ? { canvas: r.canvas, x: r.x, y: r.y } : { canvas: null, x: 0, y: 0 };
  };
  return {
    draw(ctx, t) {
      let n = 0;
      for (const l of list) {
        if (l.start > t) break;
        if (t >= l.end) { cache.delete(l); continue; }
        let e = cache.get(l);
        if (!e) { e = render(l); cache.set(l, e); }
        if (!e.canvas) continue;
        const a = SubRender.fadeAlpha(t, l.start, l.end, st.fade);
        if (a <= 0) continue;
        ctx.globalAlpha = a;
        ctx.drawImage(e.canvas, e.x, e.y);
        n++;
      }
      ctx.globalAlpha = 1;
      return n;
    },
    dispose() { cache.clear(); },
  };
}

/**
 * @param {object} o
 * @param {Blob} o.clean 깨끗한 원본 (exportClean 이 만든 MP4)
 * @param {{text:string,start:number,end:number,hidden?:boolean}[]} o.lines 가사 줄 (초)
 * @param {object} o.style 자막 스타일 (어떤 형식이든, AMSubtitleStyle.normalizeStyle 이 읽는다)
 * @param {number} [o.W] @param {number} [o.H] 기본: 원본 영상 크기
 * @param {number} [o.bitrate] bps (기본: 크기별 기본값)  @param {boolean} [o.trial=true]
 * @returns {Promise<{blob:Blob, codecs:{video:string|null,audio:string|null}, burned:boolean, subsFallback:boolean, seconds:number, ms:number, probe?:object}>}
 *   자막이 꺼져 있거나 보여 줄 줄이 없으면 아무것도 다시 만들지 않고 clean 을 그대로 돌려준다 (burned:false) — PC 앱이 "깨끗한 원본이 곧 완성본"으로 쓰는 것과 같다.
 */
export async function burnSubtitles(o) {
  const { clean, lines, style, onProgress, signal, tags } = o;
  const t0 = nowMs();
  throwIfAborted(signal, '자막 입히기를 멈췄어요');
  const input = new Input({ source: new BlobSource(clean), formats: [MP4] }); // 깨끗한 원본은 늘 MP4 (다른 형식 읽기 코드를 앱에 넣지 않아 묶음이 작다)
  let output = null;
  let conv = null;
  let onAbort = null;
  try {
    const vtrack = await input.getPrimaryVideoTrack();
    if (!vtrack) throw new Error('깨끗한 원본 영상에서 그림을 찾지 못했어요. 영상 만들기부터 다시 해 주세요.');
    const W = o.W || (await vtrack.getDisplayWidth());
    const H = o.H || (await vtrack.getDisplayHeight());
    const seconds = await vtrack.computeDuration();
    const atrack = await input.getPrimaryAudioTrack();
    const acodec = atrack ? await atrack.getCodec() : null;
    const vcodec = await vtrack.getCodec();
    const st = SubStyle.normalizeStyle(style, { w: W, h: H });
    const shown = shownLines(lines).filter((l) => l.start < seconds).map((l) => ({ ...l, end: Math.min(l.end, seconds) }));
    if (!st.enabled || !shown.length) {
      return { blob: clean, codecs: { video: vcodec, audio: acodec }, burned: false, subsFallback: false, seconds, ms: nowMs() - t0 };
    }
    const fonts = await ensureSubtitleFonts(st, shown.map((l) => l.text).join(' '));
    throwIfAborted(signal, '자막 입히기를 멈췄어요');
    const bitrate = o.bitrate || defaultBitrate(W, H);
    const probe = await probeEncoders({ W, H, fps: 24, bitrate, wantAudio: false, trial: o.trial !== false });
    assertVideoEncoder(probe);

    const canvas = makeCanvas(W, H);
    const ctx = frameContext(canvas);
    const drawer = createSubtitleDrawer({ lines: shown, style: st, W, H });
    const totalFrames = Math.max(1, Math.round(seconds * 24));
    const meter = createMeter(totalFrames);
    const pacer = createPacer();
    let n = 0;
    output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    conv = await Conversion.init({
      input,
      output,
      video: {
        codec: probe.video, bitrate, keyFrameInterval: 2, forceTranscode: true, processedWidth: W, processedHeight: H,
        process: async (sample) => {
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = 'source-over';
          sample.draw(ctx, 0, 0, W, H);
          drawer.draw(ctx, sample.timestamp);
          n++;
          if (onProgress && n % 6 === 0) {
            try { onProgress({ stage: 'burn', ...meter.update(n), frame: n }); } catch (_) { /* 화면 쪽 오류는 무시 */ }
          }
          await pacer.tick();
          return canvas;
        },
      },
      tags: (inTags) => ({ ...(inTags && inTags.title ? { title: inTags.title } : {}), ...AI_TAGS, ...(tags || {}) }),
      showWarnings: false,
    });
    if (!conv.isValid) {
      const why = conv.discardedTracks.map((d) => d.reason).join(', ');
      throw new Error(`자막을 입힌 영상을 만들 수 없어요. (${why || '알 수 없는 이유'})`);
    }
    if (signal) {
      onAbort = () => { if (conv) conv.cancel(); };
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      await conv.execute();
    } catch (e) {
      if (e instanceof ConversionCanceledError || (signal && signal.aborted)) throw abortError('자막 입히기를 멈췄어요');
      throw e;
    }
    drawer.dispose();
    if (onProgress) { try { onProgress({ stage: 'burn', ...meter.update(totalFrames), frame: totalFrames }); } catch (_) { /* 무시 */ } }
    const buf = output.target.buffer;
    const blob = new Blob([buf], { type: 'video/mp4' });
    output.target.buffer = null;
    return { blob, codecs: { video: probe.video, audio: acodec }, burned: true, subsFallback: !fonts.ok, seconds, ms: nowMs() - t0, probe };
  } catch (e) {
    try { if (conv && conv.state === 'executing') await conv.cancel(); } catch (_) { /* 이미 끝남 */ }
    try { if (output && output.state !== 'finalized' && output.state !== 'canceled') await output.cancel(); } catch (_) { /* 이미 끝남 */ }
    throw e;
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    try { if (input.dispose) input.dispose(); } catch (_) { /* 무시 */ }
  }
}
