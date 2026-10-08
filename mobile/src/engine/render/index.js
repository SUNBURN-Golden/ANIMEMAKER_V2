// 영상 만들기 엔진 (그림 합성 · 24fps 내보내기 · 자막 입히기 · 미리보기 · 연습용 그림). 쓰는 쪽은 여기서 가져가면 된다.
export { createCompositor, plateSizeFor, estimateShotBytes, sparkleList } from './compositor.js';
export { exportClean, createAudioFeeder, AI_TAGS } from './export.js';
export { burnSubtitles, makeSrt, makeLrc, ensureSubtitleFonts, createSubtitleDrawer } from './burn.js';
export { createPreview, renderStill } from './preview.js';
export { demoBg, demoCel, demoDrawing, demoCharacterRef, demoSong, demoSongSamples } from './demo-canvas.js';
export { probeEncoders, NoEncoderError, VIDEO_ORDER, AUDIO_ORDER } from './codecs.js';
export { buildLayout, frameInfo, shotsForFrame, shotsForRange, transitionFrames, defaultBitrate, FPS } from './frames.js';
export { createMeter, fmtDuration, fmtEta } from './progress.js';
export { DEFAULT_FINISH, normalizeFinish } from './finish.js';
export { TRANSITION_NAMES, drawTransition } from './transitions.js';
export { yieldToUI, createPacer, abortError, isAbortError } from './util.js';
