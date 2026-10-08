// ❓ 도움말: 초등학생도 따라 할 수 있는 짧은 안내 (AI 앱에 부탁하는 3단계 · 영상 저장 위치 · 막혔을 때)
import { h } from '../ui.js';

const STEPS = [
  { n: '1', emoji: '📋', title: '부탁하기 ▶ 를 눌러요', text: '부탁 글이 복사되고 AI 앱(ChatGPT 같은)이 열려요. 기준 그림이 있으면 함께 보내져요.' },
  { n: '2', emoji: '🖼', title: 'AI 앱에서 받아 와요', text: '그림은 길게 눌러 [공유] → AnimeMaker V2. 글(답장)은 길게 눌러 [복사] 한 뒤 돌아와서 [📋 복사한 답장 붙여넣기].' },
  { n: '3', emoji: '✅', title: '저절로 자리를 찾아가요', text: '받은 그림은 알맞은 자리에 들어가고, 다음 부탁이 바로 나와요. 모자란 그림은 이웃 그림이 대신해서 언제든 영상을 만들 수 있어요.' },
];

/** @returns {{el:HTMLElement, destroy:()=>void}} */
export function helpScreen(app) {
  const el = h('div', { class: 'help' },
    h('h1', { class: 'page-title' }, '❓ 도움말'),
    h('div', { class: 'card' },
      h('h3', null, 'AI 앱에 부탁하는 방법'),
      h('div', { class: 'help-steps' }, STEPS.map((s) => h('div', { class: 'help-step' }, h('div', { class: 'help-num' }, s.n), h('div', { class: 'help-emoji', 'aria-hidden': 'true' }, s.emoji), h('div', { class: 'grow' }, h('b', null, s.title), h('div', { class: 'small' }, s.text)))))),
    h('details', { class: 'card fold', open: true },
      h('summary', null, '💾 영상은 어디에 저장돼요?'),
      h('p', { class: 'small' }, '영상이 완성되면 [💾 갤러리에 저장하기] 를 눌러요. 폰 갤러리의 "AnimeMaker V2" 폴더에 저장돼요.'),
      h('p', { class: 'small' }, '앱 안의 [📂 내 영상] 에도 남아 있어요. 하지만 앱을 지우면 함께 지워지니까, 마음에 드는 영상은 꼭 갤러리에 저장해 두세요.')),
    h('details', { class: 'card fold' },
      h('summary', null, '🆘 막혔을 때'),
      h('ul', { class: 'help-list small' },
        h('li', null, h('b', null, 'AI 앱이 안 열려요'), ' — 설정의 "어떤 구독이 있나요?" 에서 앱을 설치했는지 확인해요. 앱을 직접 열어서 부탁 글을 붙여넣어도 돼요.'),
        h('li', null, h('b', null, '그림이 안 들어와요'), ' — [📁 내 사진에서 고르기] 로 갤러리에 저장한 그림을 직접 넣을 수 있어요.'),
        h('li', null, h('b', null, '답장이 안 받아져요'), ' — 답장 "전체"를 복사했는지 확인해요. 부탁 글을 그대로 복사하면 거절해요. 그래도 괜찮다면 [그래도 이 답장 쓰기].'),
        h('li', null, h('b', null, '너무 오래 걸려요'), ' — [지금까지 그린 걸로 영상 만들기] 로 먼저 볼 수 있어요. 그림 수를 줄이려면 [그림 줄여서 빨리] 를 눌러요.'),
        h('li', null, h('b', null, '앱이 꺼졌어요'), ' — 다시 켜면 하던 곳에서 이어서 할 수 있어요. 받은 그림도 잃어버리지 않아요.'),
        h('li', null, h('b', null, '영상이 안 만들어져요'), ' — 설정의 [📱 내 폰 점검] 을 봐요. WebView 업데이트가 필요할 수 있어요.'))),
    h('details', { class: 'card fold' },
      h('summary', null, '💳 돈이 드나요?'),
      h('p', { class: 'small' }, '이 앱은 따로 돈을 받지 않아요. AI 그림은 이미 구독 중인 ChatGPT · Gemini · Grok · Claude 앱 안에서 만들어요. 구독이 아직 없다면 [연습 모드] 로 가짜 그림으로 흐름만 해 볼 수 있어요.')),
    h('button', { class: 'btn big', onclick: () => app.go('home') }, '🎬 만들기로 가기'));
  return { el, destroy() {} };
}
