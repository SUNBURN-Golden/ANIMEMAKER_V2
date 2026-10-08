// 🎤 탭으로 가사 시간 맞추기: PC 앱과 같은 화면(AMLyricSync: 1. 맞추기 → 2. 확인하기)을 키가 큰 아래 창에 담는다.
//   openTapSync(ctx, o) → Promise<{lines, flags, left}|null>   저장하면 결과, 취소하면 null (엔진은 건드리지 않는다 — 자막 스튜디오가 작업 사본에 섞는다)
//   mountTapSync(host, ctx) → { update(), destroy(), isDirty() }   엔진과 이어진 판: 저장하면 engine.edits.updateLyrics 를 부르고 ctx.onClose({saved}) 로 돌아간다
//       (가사 확인 카드에서 열었다면 부른 쪽이 이어서 engine.continueReview(id) 를 한다)
import LS from '../../../src/renderer/js/lyricsync.js';
import SubRender from '../../../src/shared/subtitle-render.js';
import { h, bottomSheet, confirmBox, toast as toastDefault } from '../ui.js';
import * as db from '../db.js';
import { BK } from '../engine/keys.js';
import { createUrlBox, friendly } from './done-parts.js';

/** 위젯이 진짜 영상 + 진짜 자막 확인 단계를 지원하는가 (B2c 가 넓힌 mount({video, styleProvider})) */
const hasRealStage = () => typeof LS.stageSize === 'function' && typeof LS.drawCheck === 'function';

/**
 * @param {object} ctx  마운트 약속의 ctx (toast 만 쓴다)
 * @param {{lines:object[], duration:number, songBlob?:Blob, videoBlob?:Blob, style?:()=>({style:object,W:number,H:number}),
 *          confirmed?:boolean, title?:string, saveLabel?:string}} o  lines: [{text,start,end,part?,section?,sectionStart?}] (숨기지 않은 줄)
 */
export function openTapSync(ctx, o) {
  const urls = createUrlBox();
  let video = null;
  let src;
  if (o.videoBlob && hasRealStage()) {
    video = document.createElement('video');
    video.preload = 'auto';
    video.setAttribute('playsinline', '');
    video.src = urls.get('v', 'v', o.videoBlob);
  } else if (o.videoBlob) src = urls.get('v', 'v', o.videoBlob); // 옛 위젯: 영상 소리로 맞춘다
  else if (o.songBlob) src = urls.get('s', 's', o.songBlob);
  const w = LS.mount({
    lines: o.lines, duration: o.duration || 1, src, confirmed: !!o.confirmed,
    ...(video ? { video, styleProvider: o.style, renderer: SubRender } : {}),
  });
  let result = null;
  const n = o.lines.length;
  const touched = () => w.untapped() < n && !o.confirmed;
  const sh = bottomSheet({
    title: o.title || '🎤 탭으로 가사 맞추기',
    body: w.el,
    buttons: [
      {
        label: '취소', value: null,
        onClick: async () => {
          if (touched() && !(await confirmBox('맞춘 것이 사라져요', '지금까지 맞춘 시간을 버리고 나갈까요?', '버리고 나가기', '계속 맞추기'))) return true;
          return false;
        },
      },
      {
        label: o.saveLabel || '💾 저장', kind: 'primary',
        onClick: async () => {
          const left = w.untapped();
          if (left && !(await confirmBox('아직 다 안 맞췄어요', `${n}줄 중 ${left}줄은 아직 "예상" 시간이에요. 그대로 저장할까요?`, '그대로 저장', '더 맞추기'))) return true;
          result = { lines: w.result(), flags: w.tappedFlags(), left };
          return false;
        },
      },
    ],
    sticky: true,
    onClose: () => { try { w.destroy(); } catch (_) { /* 이미 닫힘 */ } urls.dispose(); },
  });
  sh.el.classList.add('ts-full');
  const p = sh.result.then(() => result);
  p.close = sh.close;
  return p;
}

/** 엔진과 이어진 판 (project.js 의 가사 확인 카드 · 스튜디오 밖에서 부를 때) */
export function mountTapSync(host, ctx) {
  const { engine, id } = ctx;
  const say = ctx.toast || toastDefault;
  let destroyed = false;
  let pending = null;
  (async () => {
    let res = null;
    try {
      const snap = ctx.getSnap();
      const all = (snap.timing && snap.timing.lyrics) || [];
      const lines = all.filter((l) => !l.hidden && l.text).map((l) => ({ text: l.text, start: l.start, end: l.end, part: l.part || 1, section: l.section, sectionStart: l.sectionStart }));
      if (!lines.length) { say('먼저 가사 줄을 하나 이상 만들어 주세요', 'err'); if (ctx.onClose) ctx.onClose({ saved: false }); return; }
      const clean = snap.output && snap.output.clean ? await engine.render.output(id, 'clean') : null;
      const songBlob = clean ? null : await db.getFile(BK.song(id));
      const source = snap.timing && snap.timing.lyricsSource;
      const confirmed = ctx.confirmed != null ? !!ctx.confirmed : ['tap', 'lrc', 'srt'].includes(source);
      const out = snap.outSize || { w: 1280, h: 720 };
      pending = openTapSync(ctx, {
        lines, duration: snap.durationSec || 1, songBlob, videoBlob: clean, confirmed,
        style: () => ({ style: ctx.getSnap().subtitleStyle, W: out.w, H: out.h }),
      });
      res = await pending;
      if (res && !destroyed) {
        await engine.edits.updateLyrics(id, res.lines);
        say(res.left ? `✅ 시간을 저장했어요 · ${res.left}줄은 아직 자동 시간이에요` : '✅ 가사 시간을 모두 맞췄어요', 'ok', 4000);
      }
    } catch (e) {
      say(friendly(e), 'err', 6000);
      res = null;
    }
    if (!destroyed && ctx.onClose) ctx.onClose({ saved: !!res });
  })();
  return {
    update() {},
    isDirty: () => false,
    destroy() { destroyed = true; if (pending && pending.close) pending.close(); },
  };
}
