'use strict';
/* AI 연결 설정 (구독 전용) */
(function (AM) {
  const { h, toast } = AM;
  AM.views = AM.views || {};

  const CAP_LABEL = { text: '글쓰기(기획·타임시트)', image: '그림' };

  function presetsFor(botOn) {
    return [
      { name: '⭐ 추천: ChatGPT 하나로', desc: '기획·타임시트·그림 모두 ChatGPT 가 자동으로. 캐릭터 기준 그림을 직접 첨부해서 주인공이 가장 잘 유지돼요.', providers: { text: 'codex', image: 'codex' }, sites: { image: 'chatgpt' } },
      { name: 'Claude + ChatGPT', desc: '이야기·타임시트는 Claude, 그림은 ChatGPT (둘 다 자동)', providers: { text: 'claude', image: 'codex' }, sites: { image: 'chatgpt' } },
      { name: 'SuperGrok 하나로', desc: '기획·타임시트·그림 모두 Grok 이 자동으로', providers: { text: 'grok', image: 'grok' }, sites: { image: 'grok' } },
      { name: 'Google AI(Gemini) 하나로', desc: '기획은 Antigravity CLI, 그림은 Gemini 웹(나노바나나)', providers: { text: 'agy', image: botOn ? 'bot:gemini' : 'helper' }, sites: { image: 'gemini' } },
      { name: '체험 모드 (무료 구경)', desc: 'AI 없이 가짜 그림으로 흐름만 확인 (렌더링·자막은 진짜로)', providers: { text: 'demo', image: 'demo' }, sites: {} },
    ];
  }

  AM.views.settings = async function settings() {
    const s = await AM.refreshSettings();
    const info = AM.state.info;
    const root = h('div', null,
      h('h1', { class: 'page-title' }, '🔌 AI 연결 설정'),
      h('p', { class: 'page-sub' }, '이미 구독 중인 AI 를 연결해요. 순서: ① 구독 연결(설치·로그인) → ② 단계별 담당 AI 고르기.'),
      h('div', { class: 'notice ok' }, h('b', null, '🔒 구독 전용 모드 '),
        '이 앱은 API 키(쓴 만큼 돈이 나가는 종량제)를 사용하지 않아요. 각 회사의 공식 프로그램(CLI)에 ', h('b', null, '구독 계정으로 로그인'),
        '해서 쓰고, 실행할 때 API 키 환경변수를 자동으로 지워서 실수로 과금되는 일을 막아요. 구독 사용 한도를 다 쓰면 기다렸다가 이어서 합니다.'),
      quickPresets(s),
      agentsSection(info, s),
      providersSection(s, info),
      botSection(s, info),
      otherSection(s, info));
    return root;
  };

  function quickPresets(s) {
    const botOn = s.bot.enabled && s.bot.acceptedRisk;
    return h('div', { class: 'section' },
      h('h3', null, '⚡ 빠른 설정 (추천 조합)'),
      h('p', { class: 'desc' }, '가지고 있는 구독에 맞는 걸 누르면 아래 "단계별 담당 AI" 가 한 번에 채워져요.'),
      h('div', { class: 'wf-cards' }, presetsFor(botOn).map((p) => h('button', {
        class: 'wf-card',
        onclick: async () => {
          await AM.safe(() => window.api.saveSettings({ providers: p.providers, helperSites: { ...s.helperSites, ...p.sites } }), `"${p.name}" 로 설정했어요`);
          AM.go('settings');
        },
      }, h('div', { class: 't' }, p.name), h('div', { class: 'd' }, p.desc)))));
  }

  function agentsSection(info, s) {
    return h('div', { class: 'section' },
      h('h3', null, '① 내 구독 연결하기'),
      h('p', { class: 'desc' }, '가지고 있는 구독만 연결하면 돼요. [설치하기] → [로그인 하기] → [연결 테스트] 순서로 눌러 주세요. 검은 창이 뜨면 안내대로 진행한 뒤 닫으면 돼요.'),
      h('div', { class: 'agent-grid' }, info.agents.map((a) => agentCard(a, s))));
  }

  function agentCard(a, s) {
    const stat = h('div', { class: 'stat' }, '상태 확인 중…');
    const as = s.agents[a.id] || {};
    const pathIn = h('input', { type: 'text', value: as.path || '', placeholder: '비워 두면 자동으로 찾아요' });
    const modelIn = h('input', { type: 'text', value: as.model || '', placeholder: '비워 두면 기본 모델' });
    const extraIn = h('input', { type: 'text', value: as.extraArgs || '', placeholder: '예) --some-flag' });
    const check = async () => {
      stat.textContent = '상태 확인 중…';
      const st = await AM.safe(() => window.api.agentStatus(a.id));
      if (!st) { stat.textContent = '확인 실패'; return; }
      AM.clear(stat);
      if (!st.installed) {
        stat.append(h('span', { class: 'chip err' }, '설치 안 됨'), ' [설치하기] 를 눌러 주세요.');
      } else {
        stat.append(h('span', { class: 'chip ok' }, '설치됨'), ` ${st.version || ''} `);
        if (st.mode === 'subscription') stat.append(h('span', { class: 'chip ok' }, '구독 로그인 ✔'));
        else if (st.mode === 'apikey') stat.append(h('span', { class: 'chip err' }, 'API 키 로그인 (종량제!)'));
        else if (st.loggedIn === false) stat.append(h('span', { class: 'chip warn' }, '로그인 필요'));
        if (st.message) stat.append(h('div', { class: 'small muted', style: { marginTop: '4px' } }, st.message));
      }
    };
    setTimeout(check, 50);
    const test = async (btn) => {
      btn.disabled = true;
      btn.textContent = '⏳ 테스트 중 (최대 1~2분)…';
      const ok = await AM.safe(() => window.api.agentTest(a.id));
      btn.disabled = false;
      btn.textContent = '✅ 연결 테스트';
      if (ok) toast(`${a.name} 연결 성공! 구독으로 잘 동작해요.`, 'ok');
    };
    const testBtn = h('button', { class: 'btn small', onclick: (e) => test(e.currentTarget) }, '✅ 연결 테스트');
    return h('div', { class: 'agent-card' },
      h('div', null, h('div', { class: 'an' }, a.name), h('div', { class: 'small muted' }, `필요한 구독: ${a.subscription}`)),
      h('div', { class: 'row', style: { gap: '4px' } }, Object.entries(a.caps).filter(([, v]) => v).map(([k, v]) => h('span', { class: `chip ${v === true ? 'ok' : 'warn'}` }, `${CAP_LABEL[k]}${v === true ? '' : ' (실험적)'}`))),
      stat,
      h('div', { class: 'row', style: { gap: '6px' } },
        h('button', { class: 'btn small', onclick: () => AM.safe(() => window.api.agentInstall(a.id), '설치 창을 열었어요. 끝나면 [상태 확인] 을 누르세요.') }, '⬇ 설치하기'),
        h('button', { class: 'btn small', onclick: () => AM.safe(() => window.api.agentLogin(a.id), '로그인 창을 열었어요.') }, '🔑 로그인 하기'),
        h('button', { class: 'btn small', onclick: check }, '🔄 상태 확인'),
        testBtn),
      h('div', { class: 'small muted' }, a.loginNote),
      a.installNote ? h('div', { class: 'small muted' }, `※ ${a.installNote}`) : null,
      h('details', { class: 'adv' }, h('summary', null, '고급 (실행 파일 위치 · 모델)'),
        h('div', { class: 'col', style: { marginTop: '8px' } },
          h('label', { class: 'field' }, '실행 파일 위치', h('div', { class: 'row' }, pathIn, h('button', { class: 'btn small', onclick: async () => { const f = await window.api.pickFile({}); if (f) pathIn.value = f; } }, '찾기'))),
          h('label', { class: 'field' }, '모델 이름 (글쓰기용)', modelIn),
          h('label', { class: 'field' }, '추가 실행 옵션', extraIn, h('span', { class: 'hint' }, `설치 명령: ${a.install}`)),
          h('button', {
            class: 'btn small primary',
            onclick: () => AM.safe(() => window.api.saveSettings({ agents: { [a.id]: { path: pathIn.value.trim(), model: modelIn.value.trim(), extraArgs: extraIn.value.trim() } } }), '저장했어요').then(check),
          }, '저장'))));
  }

  function providersSection(s, info) {
    const rows = [
      ['text', '📝 기획 · 타임시트', '이야기(스토리보드)와 타임시트(컷마다 그림 장수·노출 프레임·카메라)를 쓰는 AI'],
      ['image', '🎨 그림', '타임시트의 그림을 한 장씩 (캐릭터 기준 그림을 붙여서). 캐릭터 화면의 기준 그림도 이 AI 가 그려요'],
    ];
    const siteOpts = (kind) => Object.entries(info.sites).filter(([, v]) => v.good.includes(kind)).map(([k, v]) => h('option', { value: k }, v.name));
    const body = h('tbody', null, rows.map(([k, label, desc]) => {
      const sel = h('select', null, AM.PROVIDERS[k].map((p) => h('option', { value: p.id }, p.label)));
      sel.value = s.providers[k];
      const site = k === 'text' ? null : h('select', { style: { width: '170px' } }, siteOpts(k));
      if (site) site.value = s.helperSites[k] || site.value;
      const siteWrap = site ? h('div', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'small muted' }, '도우미 사이트'), site) : null;
      const sync = () => { if (siteWrap) siteWrap.style.visibility = sel.value === 'helper' ? 'visible' : 'hidden'; };
      sync();
      sel.addEventListener('change', async () => {
        sync();
        const p = AM.providerInfo(k, sel.value);
        if (p.mode === 'bot' && !(s.bot.enabled && s.bot.acceptedRisk)) toast('자동 클릭이 꺼져 있어서, 이 단계는 도우미 모드로 진행돼요. 아래 [자동 클릭] 에서 켤 수 있어요.');
        await AM.safe(() => window.api.saveSettings({ providers: { [k]: sel.value } }));
      });
      if (site) site.addEventListener('change', () => AM.safe(() => window.api.saveSettings({ helperSites: { [k]: site.value } })));
      return h('tr', null, h('td', null, label, h('div', { class: 'small muted', style: { fontWeight: 400 } }, desc)), h('td', null, sel), h('td', { style: { width: '260px' } }, siteWrap));
    }));
    return h('div', { class: 'section' },
      h('h3', null, '② 단계별 담당 AI'),
      h('p', { class: 'desc' }, '자동 = 프로그램이 알아서 / 자동 클릭 = 웹사이트를 대신 눌러줌(실험적) / 도우미 = 내가 웹에서 만들고 다운로드하면 자동으로 가져옴 / 체험 = 가짜로 흐름만'),
      h('table', { class: 'prov-table' }, body),
      h('div', { class: 'small muted', style: { marginTop: '8px' } }, '※ 이 설정은 "새로 만드는 작업" 에 적용돼요. 이미 만든 작업은 진행 화면의 [🔧 담당 AI] 에서 바꿀 수 있어요. 렌더링과 자막은 늘 내 PC 가 무료로 해요.'));
  }

  function botSection(s, info) {
    const b = s.bot;
    const on = b.enabled && b.acceptedRisk;
    const toggle = h('input', { type: 'checkbox', checked: on });
    toggle.addEventListener('change', async () => {
      if (toggle.checked) {
        const ok = await riskDialog();
        if (!ok) { toggle.checked = false; return; }
        await AM.safe(() => window.api.saveSettings({ bot: { enabled: true, acceptedRisk: true } }), '자동 클릭을 켰어요');
      } else {
        await AM.safe(() => window.api.saveSettings({ bot: { enabled: false } }), '자동 클릭을 껐어요');
      }
      AM.go('settings');
    });
    const browser = h('select', null, h('option', { value: 'edge' }, 'Microsoft Edge (윈도우 기본)'), h('option', { value: 'chrome' }, 'Google Chrome'), h('option', { value: 'custom' }, '직접 지정'));
    browser.value = b.browser;
    const bpath = h('input', { type: 'text', value: b.browserPath || '', placeholder: 'msedge.exe 또는 chrome.exe 위치' });
    const pace = h('select', null, h('option', { value: '1.6' }, '아주 천천히 (가장 안전)'), h('option', { value: '1' }, '사람 속도 (기본)'), h('option', { value: '0.7' }, '조금 빠르게'));
    pace.value = String(b.pace);
    const gap = h('input', { type: 'number', value: b.gapSeconds, min: 0, max: 600 });
    const recipeBox = h('textarea', { rows: 14, class: 'mono' });
    const saveBot = () => AM.safe(() => window.api.saveSettings({ bot: { browser: browser.value, browserPath: bpath.value.trim(), pace: Number(pace.value), gapSeconds: Number(gap.value) } }), '저장했어요');
    return h('div', { class: 'section' },
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('h3', null, '🤖 자동 클릭 (실험적)'),
          h('p', { class: 'desc' }, 'CLI 가 없는 그림 사이트(예: Gemini 나노바나나, Grok Imagine 웹)를 브라우저를 대신 눌러서 자동으로 그려요. 사이트 화면이 바뀌면 멈출 수 있고, 그럴 땐 자동으로 도우미 모드로 넘어가요.')),
        h('label', { class: 'check', style: { fontWeight: 700 } }, toggle, on ? '켜짐' : '꺼짐')),
      h('div', { class: 'notice warn small' }, '⚠ 대부분의 AI 서비스 약관은 자동화된 방식의 이용을 금지해요. 계정이 제한될 수 있으니 본인 판단으로 사용하세요. 이 앱은 보안문자(CAPTCHA)를 풀거나 봇 탐지를 피하는 기능을 넣지 않았어요. 그런 화면이 나오면 사용자에게 넘깁니다.'),
      h('div', { class: 'grid3' },
        h('label', { class: 'field' }, '사용할 브라우저', browser),
        h('label', { class: 'field' }, '속도', pace),
        h('label', { class: 'field' }, '생성 요청 사이 쉬는 시간(초)', gap)),
      h('label', { class: 'field', style: { marginTop: '10px' } }, '브라우저 위치 (직접 지정일 때)', bpath),
      h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn small primary', onclick: saveBot }, '저장')),
      h('div', { style: { marginTop: '14px' } },
        h('b', null, '처음 한 번 로그인하기'),
        h('p', { class: 'small muted', style: { margin: '4px 0 8px' } }, '아래 버튼을 누르면 AnimeMaker V2 전용 브라우저 창이 열려요. 거기서 직접 로그인해 두면 다음부터 자동 클릭이 그 로그인을 써요. (비밀번호는 이 앱이 보지 않아요)'),
        h('div', { class: 'row', style: { gap: '6px' } }, ['gemini', 'grok', 'chatgpt'].map((k) => h('button', {
          class: 'btn small', onclick: () => AM.safe(() => window.api.botOpenSite(k), `${info.sites[k].name} 를 열었어요. 로그인해 주세요.`),
        }, `🌐 ${info.sites[k].name} 로그인`)),
        h('button', { class: 'btn small ghost', onclick: () => AM.safe(() => window.api.botClose(), '닫았어요') }, '브라우저 닫기'))),
      h('details', {
        class: 'adv', style: { marginTop: '14px' },
        ontoggle: async (e) => { if (e.target.open && !recipeBox.value) { const r = await AM.safe(() => window.api.botRecipes()); if (r) recipeBox.value = JSON.stringify(r, null, 2); } },
      }, h('summary', null, '고급: 자동 클릭 레시피 고치기 (사이트 화면이 바뀌었을 때)'),
      h('p', { class: 'small muted' }, '각 작업(gemini.image, grok.image 등)의 단계(steps)와 선택자(any), 버튼 글자(texts)를 고칠 수 있어요. 잘 모르겠으면 건드리지 마세요.'),
      recipeBox,
      h('div', { class: 'row', style: { marginTop: '8px' } },
        h('button', { class: 'btn small primary', onclick: () => AM.safe(() => window.api.botSaveRecipes(recipeBox.value), '레시피를 저장했어요') }, '저장'),
        h('button', { class: 'btn small', onclick: async () => { await AM.safe(() => window.api.botResetRecipes(), '기본값으로 되돌렸어요'); const r = await window.api.botRecipes(); recipeBox.value = JSON.stringify(r, null, 2); } }, '기본값으로 되돌리기'))));
  }

  function riskDialog() {
    return new Promise((resolve) => {
      const c = h('input', { type: 'checkbox' });
      AM.modal('자동 클릭을 켜기 전에 꼭 읽어 주세요', h('div', null,
        h('ul', null,
          h('li', null, 'Google(Gemini), xAI(Grok), OpenAI(ChatGPT) 등의 이용약관은 대체로 ', h('b', null, '자동화된 수단으로 서비스를 이용하는 것'), '을 금지하거나 제한해요.'),
          h('li', null, '자동 클릭을 쓰면 ', h('b', null, '계정이 일시 제한되거나 정지될 위험'), '이 있어요. 그 책임은 사용자 본인에게 있어요.'),
          h('li', null, '이 앱은 사람 속도로 천천히 누르고, 생성 사이에 쉬며, 구독 한도 안에서만 써요. CAPTCHA 를 풀거나 봇 탐지를 우회하지 않아요.'),
          h('li', null, '불안하면 끄고 "도우미 모드" 를 쓰세요. 도우미 모드는 사용자가 직접 누르고, 앱은 다운로드된 파일만 가져와요.')),
        h('label', { class: 'check', style: { marginTop: '10px', fontWeight: 700 } }, c, '위 내용을 이해했고, 내 계정에 대한 책임은 내가 집니다.')), [
        { label: '취소', onClick: () => resolve(false) },
        { label: '켜기', kind: 'primary', onClick: () => { if (!c.checked) { toast('체크박스에 동의해 주세요.', 'err'); return true; } resolve(true); return false; } },
      ], { onClose: () => resolve(false), sticky: true });
    });
  }

  function otherSection(s, info) {
    const onLimit = h('select', null, h('option', { value: 'wait' }, '기다렸다가 자동으로 이어서 하기'), h('option', { value: 'stop' }, '멈추고 알려주기'));
    onLimit.value = s.onLimit;
    const waitMin = h('input', { type: 'number', value: s.limitWaitMinutes, min: 5, max: 300 });
    const maxH = h('input', { type: 'number', value: s.limitMaxHours, min: 1, max: 48 });
    const ci = h('select', null, ['1', '2', '3'].map((v) => h('option', { value: v }, `${v}컷씩`)));
    ci.value = String(s.concurrency.image);
    const folderRow = (label, key, cur) => h('label', { class: 'field' }, label, h('div', { class: 'row' },
      h('input', { type: 'text', value: cur, disabled: true }),
      h('button', { class: 'btn small', onclick: async () => { const d = await window.api.pickFolder(); if (d) { await AM.safe(() => window.api.saveSettings({ [key]: d }), '바꿨어요. 앱을 다시 켜면 완전히 적용돼요.'); AM.state.info = await window.api.appInfo(); AM.go('settings'); } } }, '바꾸기'),
      h('button', { class: 'btn small', onclick: () => window.api.openPath(cur) }, '열기')));
    return h('div', { class: 'section' },
      h('h3', null, '⚙ 기타'),
      h('div', { class: 'col' },
        folderRow('작업 저장 폴더', 'projectsDir', info.paths.projects),
        folderRow('다운로드 폴더 (도우미가 새 파일을 지켜보는 곳 - 브라우저 다운로드 위치와 같아야 해요)', 'downloadsDir', info.paths.downloads)),
      h('div', { class: 'grid3', style: { marginTop: '12px' } },
        h('label', { class: 'field' }, '구독 사용 한도에 걸리면', onLimit),
        h('label', { class: 'field' }, '몇 분 기다렸다 다시?', waitMin),
        h('label', { class: 'field' }, '최대 몇 시간까지 기다릴까?', maxH)),
      h('div', { class: 'grid3', style: { marginTop: '12px' } },
        h('label', { class: 'field' }, '그림 동시에 그리기 (자동 CLI 만)', ci, h('span', { class: 'hint' }, '같은 컷의 그림은 앞 그림을 보고 그려야 해서 차례로, 다른 컷끼리 동시에 그려요. 많을수록 빠르지만 한도를 빨리 써요.'))),
      h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', {
        class: 'btn primary small',
        onclick: () => AM.safe(() => window.api.saveSettings({ onLimit: onLimit.value, limitWaitMinutes: Number(waitMin.value), limitMaxHours: Number(maxH.value), concurrency: { image: Number(ci.value) } }), '저장했어요'),
      }, '저장')),
      h('div', { class: 'small muted', style: { marginTop: '10px' } }, `렌더링 엔진: 앱 안의 합성기 + ffmpeg (${info.ffmpeg}) — 따로 설치할 것 없어요.`));
  }
}(window.AM));
