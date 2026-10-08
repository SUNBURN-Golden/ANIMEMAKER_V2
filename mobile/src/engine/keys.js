// 저장소 files 의 덩어리(Blob) 열쇠 이름 — 작품 것은 모두 '<작품id>/…' 로 시작해서 작품을 지우면 한 번에 사라진다 (db.deleteProject)
//   <id>/song                  노래 원본
//   <id>/pic/03_A              그림 원본 (AI 가 준 것을 긴 변 1536px 이하로 줄인 것 · 배경 판은 03_bg)
//   <id>/cel/03_A              배경을 뺀 인물 셀 (무손실 WebP, 투명)
//   <id>/hist/03_A.v2.img      예전 그림 (최대 6장)
//   <id>/refs/<캐릭터id>/<n>   이 영상이 쓰는 캐릭터 기준 그림 (영상을 만들 때 복사 = 얼려 둔 사본)
//   <id>/out/{clean,final,draft,srt,lrc}   깨끗한 원본 · 자막 입힌 완성본 · 초안 · 자막 파일
import { pad2 } from './util.js';

export const BG_ID = 'bg';

export const BK = Object.freeze({
  song: (pid) => `${pid}/song`,
  pic: (pid, shot, id) => `${pid}/pic/${pad2(shot)}_${id}`,
  cel: (pid, shot, id) => `${pid}/cel/${pad2(shot)}_${id}`,
  hist: (pid, shot, id, v) => `${pid}/hist/${pad2(shot)}_${id}.v${v}.img`,
  ref: (pid, charId, n) => `${pid}/refs/${charId}/${n}`,
  clean: (pid) => `${pid}/out/clean`,
  final: (pid) => `${pid}/out/final`,
  draft: (pid) => `${pid}/out/draft`,
  srt: (pid) => `${pid}/out/lyrics.srt`,
  lrc: (pid) => `${pid}/out/lyrics.lrc`,
});

/** 그림 기록 한 줄이 가진 덩어리 열쇠들 (지울 때) */
export function blobKeysOf(d) {
  const out = [];
  if (d.file) out.push(d.file);
  if (d.cel) out.push(d.cel);
  for (const h of d.history || []) if (h && h.file) out.push(h.file);
  return out;
}

export const drawingKey = (shot, id) => `${shot}:${id}`;
