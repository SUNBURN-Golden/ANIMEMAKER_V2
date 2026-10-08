// 🎤 탭으로 가사 맞추기: PC 앱과 같은 화면 (1. 맞추기 → 2. 확인하기)
import LS from '../../src/renderer/js/lyricsync.js';
import { sheet, confirmBox } from './ui.js';

/**
 * @param {{text:string,start:number,end:number}[]} lyrics 지금 가사 줄
 * @param {Blob} songBlob
 * @param {number} duration
 * @param {{confirmed?:boolean}} [o] confirmed: 이미 정확한 시간(직접 맞춤·.lrc·.srt)이면 확인하기부터
 * @returns {Promise<{text,start,end,section,sectionStart}[]|null>} 저장하면 새 줄들, 취소하면 null
 */
export function tapSync(lyrics, songBlob, duration, { confirmed = false } = {}) {
  const url = URL.createObjectURL(songBlob);
  const w = LS.mount({ lines: lyrics, duration, src: url, confirmed });
  let result = null;
  return sheet('🎤 탭으로 가사 맞추기', w.el, [
    { label: '취소', value: null },
    {
      label: '💾 저장',
      kind: 'primary',
      onClick: async () => {
        const left = w.untapped();
        if (left && !await confirmBox('아직 다 안 맞췄어요', `${lyrics.length}줄 중 ${left}줄은 아직 "예상" 시간이에요. 그대로 저장할까요?`, '그대로 저장')) return true;
        result = w.result();
        return false;
      },
    },
  ], { sticky: true, onClose: () => { w.destroy(); URL.revokeObjectURL(url); } }).then(() => result);
}
