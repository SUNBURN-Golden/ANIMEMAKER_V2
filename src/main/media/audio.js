'use strict';
// 노래 분석: BPM, 박자(비트), 마디 시작(다운비트), 마디별 에너지.
// 외부 AI 없이 내 PC 에서 계산한다 (무료).
//  - 계산 부분(analyzeSamples, estimateTempo …)은 audio-analysis.js 로 옮겨 폰 앱과 같은 파일을 쓴다.
//    여기서는 그 이름을 그대로 다시 내보내므로 `require('./media/audio')` 는 예전과 똑같이 쓸 수 있다.
//  - 여기에 남은 것: analyzeSong (ffmpeg 로 노래 파일을 소리 데이터로 풀어서 analyzeSamples 에 넘긴다).
const { decodeAudioMono } = require('./ffmpeg');
const core = require('./audio-analysis');

const { SR, analyzeSamples } = core;

/**
 * 노래 파일 분석.
 * @returns {{duration:number,bpm:number,beats:number[],downbeats:number[],bars:{start:number,end:number,energy:number,level:string}[]}}
 */
async function analyzeSong(file, opts = {}) {
  const { samples } = await decodeAudioMono(file, SR, opts);
  return analyzeSamples(samples, opts.priorBpm);
}

module.exports = { ...core, analyzeSong };
