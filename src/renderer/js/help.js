'use strict';
/* ❓ 도움말: 짧고 쉽게 */
(function (AM) {
  const { h } = AM;
  AM.views = AM.views || {};

  AM.views.help = function help() {
    const link = (label, url) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); window.api.openExternal(url); } }, label);
    const go = (label, view, arg) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); AM.go(view, arg); } }, label);
    const faq = (q, ...a) => AM.kit.fold(q, h('div', { class: 'hp-a' }, ...a));
    const step = (n, emoji, title, text) => h('li', { class: 'hp-step' },
      h('span', { class: 'hp-n' }, String(n)),
      h('div', null, h('div', { class: 'hp-t' }, `${emoji} ${title}`), h('div', { class: 'hp-d' }, text)));

    return h('div', { class: 'mk-wrap help' },
      h('h1', { class: 'mk-title' }, '❓ 도움말'),
      h('p', { class: 'mk-sub' }, '처음이어도 괜찮아요. 천천히 따라 해 봐요.'),

      h('section', { class: 'mk-card' },
        h('h2', null, '🎬 영상은 이렇게 만들어요'),
        h('ol', { class: 'hp-steps' },
          step(1, '🧒', '주인공을 정해요', '이름과 모습을 적으면 AI 가 그림을 그려 줘요. 마음에 들면 [이 모습으로 정하기] 를 눌러요.'),
          step(2, '🎵', '노래와 가사를 넣어요', '노래만 있어도 돼요. 가사를 붙여 넣으면 영상에 자막으로 들어가요.'),
          step(3, '▶', '[만들기] 를 눌러요', '그림을 그리고 이어서 영상을 만들어요. 다른 화면을 봐도 계속 만들어요.'),
          step(4, '✏️', '마음에 안 드는 곳을 고쳐요', '장면 그림이나 가사 자막을 고친 뒤 [✨ 고친 것 반영하기] 를 눌러요.')),
        h('p', { class: 'hp-tip' }, '💡 먼저 구경하고 싶으면 ', go('🎬 만들기', 'home'), ' 화면에서 연습 모드로 해 보세요. 가짜 그림으로 흐름만 보여 줘요. 무료예요.')),

      h('section', { class: 'mk-card' },
        h('h2', null, '🆘 막힐 때'),
        h('div', { class: 'hp-help' },
          h('div', { class: 'hp-hbox' },
            h('div', { class: 'hp-ht' }, '🔌 AI 가 연결이 안 돼요'),
            h('p', null, go('⚙️ 설정', 'settings'), ' 에서 가지고 있는 구독을 고르고 [연결하기] 를 눌러요. ',
              h('b', null, '설치 → 로그인 → 확인'), ' 순서로 하나씩 알려 줘요. 검은 창이 뜨면 끝날 때까지 기다린 뒤 닫아요.')),
          h('div', { class: 'hp-hbox' },
            h('div', { class: 'hp-ht' }, '🙋 "도움이 필요해요" 카드가 떠요'),
            h('p', null, '그림을 사이트에서 직접 받아야 하는 방식이에요. 카드에 나온 순서대로 해요: 그림 주문 글 복사 → 사이트에 붙여 넣기 → 그림 내려받기. 내려받은 그림은 앱이 알아서 가져가요. 너무 번거로우면 ',
              go('설정', 'settings'), ' 에서 ChatGPT 같은 자동 방식을 연결해 보세요.')),
          h('div', { class: 'hp-hbox' },
            h('div', { class: 'hp-ht' }, '😴 "오늘 쓸 수 있는 만큼 다 썼어요"'),
            h('p', null, '구독마다 하루에 쓸 수 있는 양이 정해져 있어요. 조금 쉬었다가 앱이 알아서 이어서 만들어요. 앱을 꺼도 만든 곳까지는 저장돼 있어요.')),
          h('div', { class: 'hp-hbox' },
            h('div', { class: 'hp-ht' }, '⚠️ 영상이 멈췄어요 · 문제가 생겼어요'),
            h('p', null, go('📂 내 영상', 'projects'), ' 에서 그 영상을 열고 [▶ 이어서 하기] 를 눌러요. 만든 부분은 그대로 남아 있어요.')))),

      h('section', { class: 'mk-card' },
        h('h2', null, '🙋 자주 묻는 질문'),
        h('div', { class: 'hp-faq' },
          faq('돈이 더 나가나요?', '아니요. 쓴 만큼 돈이 나가는 방식은 쓰지 않아요. 이미 내고 있는 구독 안에서만 써요. 구독마다 쓸 수 있는 양이 있어서, 한도에 걸리면 쉬었다가 이어서 해요.'),
          faq('주인공 얼굴이 조금씩 달라져요', '그림을 더 넣어 보세요. ', go('🧒 주인공', 'hero'), ' 에서 주인공을 열면 그림을 다시 그리거나 내 그림을 넣을 수 있어요. 이상한 장면은 영상 화면의 [✏️ 장면 고치기] 에서 그 장면만 다시 그려요.'),
          faq('영상 모양(가로·세로)을 바꾸고 싶어요', go('🎬 만들기', 'home'), ' 화면 아래의 [바꾸기] 를 눌러 가로 · 세로 · 네모 중에서 골라요. 움직임이 많고 적은 것도 거기서 골라요.'),
          faq('가사 자막 시간이나 모양을 고치고 싶어요', '영상이 만들어진 뒤 영상 화면의 [💬 가사 자막 고치기] 에서 글자, 시간, 크기, 색을 고칠 수 있어요.'),
          faq('다음 화는 어떻게 만들어요?', '영상 화면의 [🎬 다음 화 만들기] 를 누르거나, ', go('🎬 만들기', 'home'), ' 에서 같은 주인공으로 새 노래를 넣으면 돼요. 지난 이야기를 기억해서 이어 가요.'),
          faq('만든 영상 파일은 어디에 있나요?', go('📂 내 영상', 'projects'), ' 위쪽의 [📂 저장 폴더 열기] 를 누르면 돼요. 영상마다 폴더가 따로 있고, 완성 영상과 "가사 글씨 없는 영상" 이 들어 있어요.'),
          faq('주인공을 다른 컴퓨터로 옮기고 싶어요', go('🧒 주인공', 'hero'), ' 에서 주인공을 열고 [🔧 고급] 의 [📤 캐릭터 파일로 내보내기] 를 눌러요. 다른 컴퓨터에서는 주인공 화면의 [🔧 고급] 에서 [📥 캐릭터 파일 가져오기] 로 넣어요.'))),

      h('section', { class: 'mk-card' },
        h('h2', null, '📌 꼭 알아 두세요'),
        h('ul', { class: 'hp-list' },
          h('li', null, h('b', null, '저작권 · 초상권: '), '실제 사람, 유명한 캐릭터, 이미 있는 작품을 그대로 따라 하지 마세요. 앱도 "오리지널만" 그리도록 부탁해요.'),
          h('li', null, h('b', null, 'AI 가 만든 영상 표시: '), '유튜브, 틱톡 같은 곳은 AI 로 만든 영상이라고 표시하라고 할 수 있어요. 올릴 때 그 옵션을 켜 주세요. 영상 파일 정보에도 "AI 생성" 표시를 넣어 두었어요.'),
          h('li', null, h('b', null, '서비스 약관: '), '각 AI 서비스의 약관과 영상 사용 조건(돈 버는 데 써도 되는지 등)을 확인해 주세요. 자동 클릭은 약관에 어긋날 수 있어서 기본으로 꺼져 있어요.')),
        h('p', { class: 'hp-links' }, '도움말 링크: ', link('ChatGPT 연결 프로그램 설명', 'https://developers.openai.com/codex'), ' · ', link('SuperGrok 설명', 'https://docs.x.ai/build/overview'), ' · ', link('Google AI 설명', 'https://antigravity.google/docs/cli/headless/'), ' · ', link('Suno (노래 만들기)', 'https://suno.com'))));
  };
}(window.AM));
