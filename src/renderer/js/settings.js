'use strict';
/* ⚙️ 설정: "어떤 구독이 있나요?" → [연결하기] 한 단추. 나머지는 접힌 '고급 설정' 안에 (자동 저장) */
(function (AM) {
  const { h, toast } = AM;
  AM.views = AM.views || {};

  const AGENT_ORDER = ['codex', 'grok', 'agy', 'claude'];
  const CAP_LABEL = { text: '이야기 쓰기', image: '그림 그리기' };

  /** 연결 테스트가 통과하면 알맞은 담당 AI 를 자동으로 정한다 (연습 모드가 저절로 꺼지게) */
  function presetFor(id, s) {
    const botOn = s.bot.enabled && s.bot.acceptedRisk;
    const curImg = s.providers.image;
    const keepAuto = ['codex', 'grok'].includes(curImg);
    switch (id) {
      case 'codex': return { providers: { text: 'codex', image: 'codex' }, sites: { image: 'chatgpt' } };
      case 'grok': return { providers: { text: 'grok', image: 'grok' }, sites: { image: 'grok' } };
      case 'agy': return keepAuto
        ? { providers: { text: 'agy', image: curImg }, sites: {} }
        : { providers: { text: 'agy', image: botOn ? 'bot:gemini' : 'helper' }, sites: { image: 'gemini' } };
      default: return { providers: { text: id, image: curImg }, sites: {} }; // claude: 이야기만
    }
  }

  const inUse = (s, id) => s.providers.text === id || s.providers.image === id;
  /** 비어 있는 자리(null · false)는 건너뛰고 붙인다 (DOM append 는 null 을 글자 "null" 로 만든다) */
  const put = (el, ...kids) => { kids.flat(Infinity).forEach((k) => { if (k != null && k !== false) el.append(k); }); return el; };

  function statusChip(st, s, id) {
    if (!st) return h('span', { class: 'chip' }, '확인 중…');
    if (!st.installed) return h('span', { class: 'chip warn' }, '설치가 필요해요');
    if (st.mode === 'apikey') return h('span', { class: 'chip err' }, '다시 로그인해 주세요');
    if (st.loggedIn === true) return h('span', { class: 'chip ok' }, '로그인까지 됐어요');
    if (st.loggedIn === false) return h('span', { class: 'chip warn' }, '로그인이 필요해요');
    return h('span', { class: 'chip ok' }, '설치됨');
  }

  AM.views.settings = async function settings() {
    const s = await AM.refreshSettings();
    const info = AM.state.info;
    const ind = AM.kit.savedIndicator();
    const root = h('div', { class: 'mk-wrap st-wrap' });

    // ----- 구독 카드 + 연결하기 -----
    let sel = AGENT_ORDER.includes(s.providers.text) ? s.providers.text : (AGENT_ORDER.includes(s.providers.image) ? s.providers.image : null);
    const status = {}; // id → agentStatus 결과
    const flags = { loginTried: {}, tested: {}, installTried: {}, failed: {}, rest: {}, busy: null, error: null, notice: null, noticeFor: [] };
    const cardsBox = h('div', { class: 'st-cards' });
    const panel = h('div', { class: 'st-panel' });
    let pollTimer = null;
    const stopPoll = () => { if (pollTimer) clearInterval(pollTimer); pollTimer = null; };

    async function checkStatus(id) {
      let st;
      try { st = await window.api.agentStatus(id); } catch (e) { st = { id, installed: false, message: e.message }; }
      status[id] = st;
      if (root.isConnected) { renderCards(); if (sel === id) renderPanel(); }
      return st;
    }
    function poll(id, done) {
      stopPoll();
      const t0 = Date.now();
      pollTimer = setInterval(async () => {
        if (!root.isConnected || sel !== id || Date.now() - t0 > 6 * 60 * 1000) { stopPoll(); return; }
        const st = await checkStatus(id);
        if (done(st)) stopPoll();
      }, 4000);
    }

    function stage(id) {
      const st = status[id];
      if (!st) return 'checking';
      if (!st.installed) return 'install';
      if (flags.failed[id]) return 'test';
      if (flags.tested[id] === 'ok' || (inUse(AM.state.settings, id) && st.mode !== 'apikey' && st.loggedIn !== false)) return 'done';
      if (st.mode === 'apikey' || st.loggedIn === false) return 'login';
      if (st.loggedIn === true) return 'test';
      return flags.loginTried[id] ? 'test' : 'login';
    }

    function renderCards() {
      AM.clear(cardsBox);
      const cur = AM.state.settings;
      cardsBox.appendChild(h('div', { class: 'card-grid st-agents' }, AGENT_ORDER.map((id) => {
        const a = AM.AGENT_UI[id];
        return AM.kit.pickCard({
          emoji: a.emoji, title: a.name, tag: a.star ? '추천' : null, desc: a.who, selected: sel === id,
          foot: h('span', { class: 'cp-chips' },
            inUse(cur, id) ? h('span', { class: 'chip pri' }, '✔ 쓰는 중') : null,
            statusChip(status[id], cur, id)),
          onclick: () => { stopPoll(); sel = id; flags.error = null; flags.notice = null; renderCards(); renderPanel(); if (!status[id]) checkStatus(id); },
        });
      })));
      const demoNow = AM.isAllDemo(cur);
      cardsBox.appendChild(AM.kit.pickCard({
        emoji: '☔', title: '아직 없어요', desc: '연습 모드로 쓸게요 — 가짜 그림으로 흐름만 보여 줘요. 무료예요.', selected: sel === 'demo', class: 'wide',
        foot: demoNow ? h('span', { class: 'chip pri' }, '✔ 지금 연습 모드예요') : null,
        onclick: () => { stopPoll(); sel = 'demo'; flags.error = null; flags.notice = null; renderCards(); renderPanel(); },
      }));
    }

    function steps(cur) {
      const order = ['install', 'login', 'test'];
      const idx = cur === 'done' ? 3 : order.indexOf(cur);
      return h('ol', { class: 'st-steps' }, [['설치', '⬇'], ['로그인', '🔑'], ['확인', '✅']].map(([t, ico], i) => h('li', { class: i < idx ? 'done' : i === idx ? 'now' : '' },
        h('span', { class: 'st-step-n' }, i < idx ? '✓' : String(i + 1)), h('span', null, `${ico} ${t}`))));
    }

    // 같은 단추를 연달아 눌러 검은 창이 두 개 뜨지 않게 잠깐 쉰다
    const resting = (k) => Date.now() - (flags.rest[k] || 0) < 4000;
    const rest = (k) => { flags.rest[k] = Date.now(); setTimeout(() => { if (root.isConnected) renderPanel(); }, 4100); };
    async function doInstall(id) {
      rest(`install:${id}`);
      flags.installTried[id] = true;
      flags.notice = '검은 창이 열렸어요. 설치가 끝나면 알아서 다음 단계로 넘어가요.';
      flags.noticeFor = ['install'];
      renderPanel();
      try { await window.api.agentInstall(id); } catch (e) { flags.error = e.message; flags.notice = null; renderPanel(); return; }
      poll(id, (st) => st.installed);
    }
    async function doLogin(id) {
      rest(`login:${id}`);
      flags.loginTried[id] = true;
      flags.notice = '로그인 창을 열었어요. 로그인이 끝나면 [✅ 잘 되는지 확인] 을 눌러 주세요.';
      flags.noticeFor = ['login', 'test'];
      renderPanel();
      try { await window.api.agentLogin(id); } catch (e) { flags.error = e.message; flags.notice = null; renderPanel(); return; }
      if (id === 'codex') poll(id, (st) => st.loggedIn === true && st.mode === 'subscription');
    }
    async function doTest(id) {
      flags.busy = 'test';
      flags.error = null;
      flags.notice = null;
      flags.failed[id] = false;
      renderPanel();
      try {
        const ok = await window.api.agentTest(id);
        if (!ok) throw new Error('답이 없었어요.');
        const preset = presetFor(id, AM.state.settings);
        await window.api.saveSettings({ providers: preset.providers, helperSites: { ...AM.state.settings.helperSites, ...preset.sites } });
        await AM.refreshSettings();
        flags.tested[id] = 'ok';
        flags.loginTried[id] = true;
        toast(`${AM.AGENT_UI[id].name} 연결 성공!`, 'ok');
      } catch (e) {
        flags.error = e.message || String(e);
        flags.failed[id] = true;
      }
      flags.busy = null;
      if (root.isConnected) { renderCards(); renderPanel(); }
    }

    function doneMessage(id) {
      const cur = AM.state.settings;
      const a = AM.AGENT_UI[id];
      const img = cur.providers.image;
      if (img === 'demo') {
        return { cls: 'ok', title: `✅ ${a.name} 연결 완료! 이야기는 ${a.name}가 써요.`, text: '그림은 아직 연습(가짜) 그림이에요. 그림도 진짜로 그리려면 ChatGPT 나 SuperGrok 도 연결해 보세요.' };
      }
      if (img === 'helper' || img.startsWith('bot:')) {
        return { cls: 'ok', title: `✅ ${a.name} 연결 완료!`, text: '이야기는 AI 가 써요. 그림은 한 장씩 직접 받아야 해요 (30~150번쯤). 영상 화면에 순서가 나와요.' };
      }
      return { cls: 'ok', title: '✅ 이제 진짜 그림으로 만들 수 있어요', text: `${a.name}로 이야기도 그림도 그려요.` };
    }

    function renderPanel() {
      AM.clear(panel);
      if (!sel) {
        panel.appendChild(h('div', { class: 'st-hint' }, '👆 가지고 있는 구독을 하나 골라 주세요.'));
        return;
      }
      if (sel === 'demo') {
        const demoNow = AM.isAllDemo(AM.state.settings);
        panel.appendChild(h('div', { class: 'st-box' },
          h('div', { class: 'st-box-t' }, '☔ 연습 모드'),
          h('p', { class: 'st-box-d' }, demoNow
            ? '지금 연습 모드로 쓰고 있어요. 가짜 그림으로 영상이 만들어지는 흐름을 볼 수 있어요. 돈도 사용량도 들지 않아요.'
            : '연습 모드로 바꾸면 가짜 그림으로 흐름만 보여 줘요. 연결해 둔 AI 는 그대로 남아 있어요.'),
          h('div', { class: 'row' }, demoNow
            ? h('button', { class: 'btn primary', onclick: () => AM.go('home') }, '🎬 연습 영상 만들러 가기')
            : h('button', {
              class: 'btn primary',
              onclick: async () => {
                if (!await AM.confirmBox('연습 모드로 바꿀까요?', '가짜 그림으로 흐름만 보여 줘요.\n연결해 둔 AI 는 그대로 남아 있어서, 언제든 다시 고를 수 있어요.', '☔ 바꾸기')) return;
                await AM.safe(() => window.api.saveSettings({ providers: { text: 'demo', image: 'demo' } }), '연습 모드로 바꿨어요');
                await AM.refreshSettings();
                renderCards();
                renderPanel();
              },
            }, '☔ 연습 모드로 바꾸기'))));
        return;
      }
      const a = AM.AGENT_UI[sel];
      const st = status[sel];
      const cur = stage(sel);
      const box = h('div', { class: 'st-box' });
      box.appendChild(h('div', { class: 'st-box-top' },
        h('div', { class: 'st-box-t' }, `${a.emoji} ${a.name} 연결하기`),
        cur === 'checking' ? null : steps(cur)));
      const zone = h('div', { class: 'st-zone' });
      if (flags.busy === 'test') {
        put(zone,
          h('div', { class: 'st-line' }, AM.kit.spinner(), h('b', null, '잘 되는지 확인하고 있어요…')),
          AM.kit.progressBar(null),
          h('p', { class: 'st-box-d' }, '1~2분 걸려요. 이 창을 닫지 말고 기다려 주세요.'));
      } else if (cur === 'checking') {
        put(zone, h('div', { class: 'st-line' }, AM.kit.spinner(), h('span', null, '상태를 확인하고 있어요…')));
      } else if (cur === 'install') {
        put(zone,
          h('p', { class: 'st-box-d' }, `먼저 내 컴퓨터에 ${a.tool}을 설치해요. 검은 창이 열리면 끝날 때까지 기다려 주세요.`),
          h('div', { class: 'row' },
            h('button', { class: 'btn primary big', disabled: resting(`install:${sel}`), onclick: () => doInstall(sel) }, '⬇ 설치하기'),
            flags.installTried[sel] ? h('button', { class: 'btn', onclick: () => { flags.notice = null; renderPanel(); checkStatus(sel); } }, '🔄 다시 확인') : null));
      } else if (cur === 'login') {
        put(zone,
          st && st.mode === 'apikey'
            ? h('div', { class: 'notice warn' }, '지금은 요금이 나갈 수 있는 방식으로 로그인되어 있어요. 구독 계정으로 다시 로그인해 주세요.')
            : null,
          h('p', { class: 'st-box-d' }, a.loginHint),
          h('div', { class: 'row' },
            h('button', { class: 'btn primary big', disabled: resting(`login:${sel}`), onclick: () => doLogin(sel) }, '🔑 로그인하기'),
            h('button', { class: 'btn ghost', onclick: () => { flags.loginTried[sel] = true; flags.notice = null; renderPanel(); } }, '이미 로그인했어요 →')));
      } else if (cur === 'test') {
        put(zone,
          h('p', { class: 'st-box-d' }, '잘 되는지 한 번 확인해 봐요. 1~2분 걸려요.'),
          h('div', { class: 'row' },
            h('button', { class: 'btn primary big', onclick: () => doTest(sel) }, '✅ 잘 되는지 확인'),
            h('button', { class: 'btn ghost', onclick: () => doLogin(sel) }, '🔑 다시 로그인하기')));
      } else if (cur === 'done') {
        const m = doneMessage(sel);
        put(zone,
          h('div', { class: `notice ${m.cls} st-ok` }, h('div', { class: 'st-ok-t' }, m.title), h('div', null, m.text)),
          a.note && AM.state.settings.providers.image !== 'codex' && AM.state.settings.providers.image !== 'grok' ? h('div', { class: 'small muted' }, a.note) : null,
          h('div', { class: 'row' },
            h('button', { class: 'btn primary', onclick: () => AM.go('home') }, '🎬 영상 만들러 가기'),
            h('button', { class: 'btn ghost', onclick: () => { flags.tested[sel] = null; doTest(sel); } }, '✅ 다시 확인')));
      }
      if (flags.notice && flags.busy !== 'test' && flags.noticeFor.includes(cur)) put(zone, h('div', { class: 'notice info st-note' }, flags.notice));
      if (flags.error) {
        const f = AM.kit.friendlyError(flags.error);
        put(zone, h('div', { class: 'notice err st-note' },
          h('div', null, f.kind === 'other' ? '😢 잘 안 됐어요. 로그인이 잘 됐는지 확인하고 다시 해 봐요.' : `😢 잘 안 됐어요. ${f.text}`),
          h('div', { class: 'small muted', style: { marginTop: '4px' } }, f.kind === 'other' ? `(자세한 내용: ${String(flags.error).slice(0, 160)})` : '계속 안 되면 아래 [⚙️ 고급 설정] 에서 하나씩 해 볼 수 있어요.')));
      }
      box.appendChild(zone);
      panel.appendChild(box);
    }

    renderCards();
    renderPanel();
    // 화면을 열 때 네 가지 상태를 한꺼번에 살펴본다
    AGENT_ORDER.forEach((id) => { checkStatus(id); });

    const top = { refreshTop: () => { renderCards(); renderPanel(); }, refreshAdvanced: () => advFold.refill(), checkStatus, status };
    const advFold = AM.kit.fold('⚙️ 고급 설정', null, { lazy: () => advanced(s, info, ind, top) });

    root.append(
      h('div', { class: 'st-head' }, h('h1', { class: 'mk-title' }, '⚙️ 설정'), h('span', { class: 'grow' }), ind.el),
      h('p', { class: 'mk-sub' }, 'AI 를 연결하면 진짜 그림으로 영상을 만들 수 있어요.'),
      h('section', { class: 'mk-card' },
        h('div', { class: 'mk-card-head' },
          h('h2', null, '어떤 구독이 있나요?'),
          h('p', { class: 'mk-hint' }, '가지고 있는 것을 골라 주세요. 하나만 있어도 돼요.')),
        cardsBox, panel,
        h('div', { class: 'st-assure' }, '🔒 추가 요금 없음 — 이미 내고 있는 구독 안에서만 써요.')),
      advFold);
    return root;
  };

  // =====================================================================
  //  ⚙️ 고급 설정 (예전 설정 화면의 내용 전부)
  // =====================================================================
  function advanced(s0, info, ind, top) {
    const wrap = h('div', { class: 'st-adv' });
    const cur = () => AM.state.settings || s0;
    const asv = (fn, delay = 600) => AM.kit.autosave(fn, { delay, indicator: ind });
    wrap.append(
      quickPresets(top),
      agentsSection(info, ind, top, asv),
      providersSection(cur(), info, ind, asv),
      botSection(cur(), info, ind, asv),
      otherSection(cur(), info, asv),
      h('div', { class: 'section st-link' },
        h('div', { class: 'row' },
          h('div', { class: 'grow' }, h('h3', null, '🧩 영상 규칙(워크플로우)'), h('p', { class: 'desc', style: { margin: 0 } }, '장면 수, 그림 수, 필름 느낌 같은 규칙 묶음을 만들고 고쳐요.')),
          h('button', { class: 'btn', onclick: () => AM.go('workflows') }, '🧩 영상 규칙 열기'))),
      h('div', { class: 'section st-lock' },
        h('h3', null, '🔒 구독 전용 · 추가 과금 없음'),
        h('p', { class: 'desc', style: { margin: 0 } }, '이 앱은 "쓴 만큼 돈이 나가는 방식"을 쓰지 않아요. 각 회사의 공식 연결 프로그램에 구독 계정으로 로그인해서 쓰고, 실수로 요금이 나가지 않도록 막아 두었어요. 구독 한도를 다 쓰면 조금 쉬었다가 이어서 해요.')));
    return wrap;
  }

  function quickPresets(top) {
    const s = AM.state.settings;
    const botOn = s.bot.enabled && s.bot.acceptedRisk;
    const list = [
      { name: '⭐ 추천: ChatGPT 하나로', desc: '이야기도 그림도 ChatGPT 가 자동으로 해요. 주인공 그림도 함께 보내서 모습이 가장 잘 유지돼요.', providers: { text: 'codex', image: 'codex' }, sites: { image: 'chatgpt' } },
      { name: 'Claude + ChatGPT', desc: '이야기는 Claude, 그림은 ChatGPT (둘 다 자동)', providers: { text: 'claude', image: 'codex' }, sites: { image: 'chatgpt' } },
      { name: 'SuperGrok 하나로', desc: '이야기도 그림도 SuperGrok 이 자동으로 해요.', providers: { text: 'grok', image: 'grok' }, sites: { image: 'grok' } },
      { name: 'Google AI(Gemini) 하나로', desc: '이야기는 자동, 그림은 Gemini 웹에서 직접 받아요 (한 장씩).', providers: { text: 'agy', image: botOn ? 'bot:gemini' : 'helper' }, sites: { image: 'gemini' } },
      { name: '연습 모드 (무료 구경)', desc: 'AI 없이 가짜 그림으로 흐름만 확인해요. (영상 만들기와 자막은 진짜로 해요)', providers: { text: 'demo', image: 'demo' }, sites: {} },
    ];
    return h('div', { class: 'section' },
      h('h3', null, '⚡ 빠른 설정 (추천 조합)'),
      h('p', { class: 'desc' }, '가지고 있는 구독에 맞는 것을 누르면 아래 "이야기 쓰는 AI"와 "그림 그리는 AI"가 한 번에 채워져요.'),
      h('div', { class: 'wf-cards' }, list.map((p) => h('button', {
        class: 'wf-card',
        onclick: async () => {
          await AM.safe(() => window.api.saveSettings({ providers: p.providers, helperSites: { ...AM.state.settings.helperSites, ...p.sites } }), `정했어요: ${p.name}`);
          await AM.refreshSettings();
          top.refreshTop();
          top.refreshAdvanced();
        },
      }, h('div', { class: 't' }, p.name), h('div', { class: 'd' }, p.desc)))));
  }

  function agentsSection(info, ind, top, asv) {
    return h('div', { class: 'section' },
      h('h3', null, '① 연결 프로그램 (하나씩 직접 다루기)'),
      h('p', { class: 'desc' }, '위의 [연결하기] 가 이 일을 자동으로 해 줘요. 잘 안 될 때만 여기서 하나씩 해 보세요. 검은 창이 뜨면 안내대로 한 뒤 닫으면 돼요.'),
      h('div', { class: 'agent-grid' }, AGENT_ORDER.map((id) => info.agents.find((a) => a.id === id)).filter(Boolean).map((a) => agentCard(a, top, asv))));
  }

  function agentCard(a, top, asv) {
    const ui = AM.AGENT_UI[a.id] || { name: a.name, emoji: '🤖' };
    const s = AM.state.settings;
    const stat = h('div', { class: 'stat' }, '상태 확인 중…');
    const as = (s.agents && s.agents[a.id]) || {};
    const pathIn = h('input', { type: 'text', value: as.path || '', placeholder: '비워 두면 자동으로 찾아요' });
    const modelIn = h('input', { type: 'text', value: as.model || '', placeholder: '비워 두면 기본값' });
    const extraIn = h('input', { type: 'text', value: as.extraArgs || '', placeholder: '예) --some-flag' });
    const check = async () => {
      stat.textContent = '상태 확인 중…';
      const st = await top.checkStatus(a.id);
      AM.clear(stat);
      if (!st || !st.installed) {
        stat.append(h('span', { class: 'chip err' }, '설치 안 됨'), ' [⬇ 설치하기] 를 눌러 주세요.');
      } else {
        stat.append(h('span', { class: 'chip ok' }, '설치됨'), ` ${st.version || ''} `);
        if (st.mode === 'subscription') stat.append(h('span', { class: 'chip ok' }, '구독 로그인 ✔'));
        else if (st.mode === 'apikey') stat.append(h('span', { class: 'chip err' }, '요금이 나갈 수 있는 로그인!'));
        else if (st.loggedIn === false) stat.append(h('span', { class: 'chip warn' }, '로그인 필요'));
        else stat.append(h('div', { class: 'small muted', style: { marginTop: '4px' } }, '로그인은 [✅ 연결 확인] 으로 알아봐요.'));
      }
    };
    setTimeout(check, 50);
    const save = asv(() => window.api.saveSettings({ agents: { [a.id]: { path: pathIn.value.trim(), model: modelIn.value.trim(), extraArgs: extraIn.value.trim() } } }).then(check));
    [pathIn, modelIn, extraIn].forEach((el) => el.addEventListener('input', save));
    const test = async (btn) => {
      btn.disabled = true;
      btn.textContent = '⏳ 확인 중 (최대 1~2분)…';
      const ok = await AM.safe(() => window.api.agentTest(a.id));
      btn.disabled = false;
      btn.textContent = '✅ 연결 확인';
      if (ok) {
        toast(`${ui.name} 연결 성공! 구독으로 잘 동작해요.`, 'ok');
        // 연습 모드를 그대로 두고 있었다면, 연결한 AI 로 자동으로 바꿔 준다
        if (AM.isAllDemo(AM.state.settings)) {
          const preset = presetFor(a.id, AM.state.settings);
          await AM.safe(() => window.api.saveSettings({ providers: preset.providers, helperSites: { ...AM.state.settings.helperSites, ...preset.sites } }));
          await AM.refreshSettings();
          top.refreshTop();
        }
      }
    };
    return h('div', { class: 'agent-card' },
      h('div', null, h('div', { class: 'an' }, `${ui.emoji} ${ui.name}`), h('div', { class: 'small muted' }, `필요한 구독: ${ui.who || a.subscription}`)),
      h('div', { class: 'row', style: { gap: '4px' } }, Object.entries(a.caps).filter(([, v]) => v).map(([k, v]) => h('span', { class: `chip ${v === true ? 'ok' : 'warn'}` }, `${CAP_LABEL[k]}${v === true ? '' : ' (실험적)'}`))),
      stat,
      h('div', { class: 'row', style: { gap: '6px' } },
        h('button', { class: 'btn small', onclick: () => AM.safe(() => window.api.agentInstall(a.id), '설치 창을 열었어요. 끝나면 [🔄 상태 확인] 을 누르세요.') }, '⬇ 설치하기'),
        h('button', { class: 'btn small', onclick: () => AM.safe(() => window.api.agentLogin(a.id), '로그인 창을 열었어요.') }, '🔑 로그인하기'),
        h('button', { class: 'btn small', onclick: check }, '🔄 상태 확인'),
        h('button', { class: 'btn small', onclick: (e) => test(e.currentTarget) }, '✅ 연결 확인')),
      h('div', { class: 'small muted' }, ui.loginHint || ''),
      a.installNote ? h('div', { class: 'small muted' }, `※ ${a.installNote}`) : null,
      AM.kit.fold('더 자세히 (프로그램 위치 · 모델)', h('div', { class: 'col' },
        h('label', { class: 'field' }, '프로그램 위치', h('div', { class: 'row' }, pathIn, h('button', { class: 'btn small', onclick: async () => { const f = await window.api.pickFile({}); if (f) { pathIn.value = f; save(); } } }, '찾기'))),
        h('label', { class: 'field' }, '모델 이름 (이야기 쓰기용)', modelIn),
        h('label', { class: 'field' }, '추가 실행 옵션', extraIn, h('span', { class: 'hint' }, `설치 명령: ${a.install}`)))));
  }

  function providersSection(s, info, ind, asv) {
    const rows = [
      ['text', '📝 이야기 쓰는 AI', '이야기와 "그림 순서표"(장면마다 어떤 그림을 얼마나 보여 줄지)를 쓰는 AI'],
      ['image', '🎨 그림 그리는 AI', '장면의 그림을 한 장씩 그려요. 주인공을 만들 때 나오는 그림도 이 AI 가 그려요'],
    ];
    const siteOpts = (kind) => Object.entries(info.sites).filter(([, v]) => v.good.includes(kind)).map(([k, v]) => h('option', { value: k }, v.name));
    const body = h('tbody', null, rows.map(([k, label, desc]) => {
      const sel = h('select', null, AM.PROVIDERS[k].map((p) => h('option', { value: p.id }, p.label)));
      sel.value = s.providers[k];
      const site = k === 'text' ? null : h('select', { style: { width: '170px' } }, siteOpts(k));
      if (site) site.value = s.helperSites[k] || site.value;
      const siteWrap = site ? h('div', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'small muted' }, '직접 돕는 사이트'), site) : null;
      const sync = () => { if (siteWrap) siteWrap.style.visibility = sel.value === 'helper' ? 'visible' : 'hidden'; };
      sync();
      const saveSel = asv(async () => {
        await window.api.saveSettings({ providers: { [k]: sel.value } });
        await AM.refreshSettings();
      }, 0);
      sel.addEventListener('change', () => {
        sync();
        const p = AM.providerInfo(k, sel.value);
        const b = AM.state.settings.bot;
        if (p.mode === 'bot' && !(b.enabled && b.acceptedRisk)) toast('자동 클릭이 꺼져 있어서, 이 단계는 "직접 돕기" 방식으로 진행돼요. 아래 [자동 클릭] 에서 켤 수 있어요.');
        saveSel();
      });
      if (site) {
        const saveSite = asv(() => window.api.saveSettings({ helperSites: { [k]: site.value } }), 0);
        site.addEventListener('change', saveSite);
      }
      return h('tr', null, h('td', null, label, h('div', { class: 'small muted', style: { fontWeight: 400 } }, desc)), h('td', null, sel), h('td', { style: { width: '260px' } }, siteWrap));
    }));
    return h('div', { class: 'section' },
      h('h3', null, '② 단계별 담당 AI'),
      h('p', { class: 'desc' }, '자동 = 프로그램이 알아서 / 자동 클릭 = 웹사이트를 대신 눌러 줌(실험적) / 직접 돕기 = 내가 웹에서 그리고 내려받으면 자동으로 가져옴 / 연습 = 가짜로 흐름만'),
      h('table', { class: 'prov-table' }, body),
      h('div', { class: 'small muted', style: { marginTop: '8px' } }, '※ 이 설정은 "새로 만드는 영상" 에 적용돼요. 이미 만든 영상은 영상 화면의 ⋯ 메뉴에서 바꿀 수 있어요. 영상 만들기와 자막 넣기는 늘 내 컴퓨터가 무료로 해요.'));
  }

  function botSection(s, info, ind, asv) {
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
      await AM.refreshSettings();
      label.textContent = AM.state.settings.bot.enabled && AM.state.settings.bot.acceptedRisk ? '켜짐' : '꺼짐';
    });
    const label = h('span', null, on ? '켜짐' : '꺼짐');
    const browser = h('select', null, h('option', { value: 'edge' }, 'Microsoft Edge (윈도우 기본)'), h('option', { value: 'chrome' }, 'Google Chrome'), h('option', { value: 'custom' }, '직접 지정'));
    browser.value = b.browser;
    const bpath = h('input', { type: 'text', value: b.browserPath || '', placeholder: 'msedge.exe 또는 chrome.exe 위치' });
    const pace = h('select', null, h('option', { value: '1.6' }, '아주 천천히 (가장 안전)'), h('option', { value: '1' }, '사람 속도 (기본)'), h('option', { value: '0.7' }, '조금 빠르게'));
    pace.value = String(b.pace);
    const gap = h('input', { type: 'number', value: b.gapSeconds, min: 0, max: 600 });
    const recipeBox = h('textarea', { rows: 14, class: 'mono' });
    const saveBot = asv(() => window.api.saveSettings({ bot: { browser: browser.value, browserPath: bpath.value.trim(), pace: Number(pace.value), gapSeconds: Number(gap.value) } }), 600);
    [browser, pace].forEach((el) => el.addEventListener('change', saveBot));
    [bpath, gap].forEach((el) => el.addEventListener('input', saveBot));
    return h('div', { class: 'section' },
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('h3', null, '🤖 자동 클릭 (실험적)'),
          h('p', { class: 'desc' }, '연결 프로그램이 없는 그림 사이트(예: Gemini 나노바나나, Grok 웹)를 브라우저가 대신 눌러서 그려요. 사이트 화면이 바뀌면 멈출 수 있고, 그럴 땐 자동으로 "직접 돕기" 로 넘어가요.')),
        h('label', { class: 'check', style: { fontWeight: 700 } }, toggle, label)),
      h('div', { class: 'notice warn small' }, '⚠ 대부분의 AI 서비스 약관은 자동화된 방식의 이용을 금지해요. 계정이 제한될 수 있으니 본인 판단으로 사용하세요. 이 앱은 보안문자(CAPTCHA)를 풀거나 봇 탐지를 피하는 기능을 넣지 않았어요. 그런 화면이 나오면 사용자에게 넘깁니다.'),
      h('div', { class: 'grid3' },
        h('label', { class: 'field' }, '사용할 브라우저', browser),
        h('label', { class: 'field' }, '속도', pace),
        h('label', { class: 'field' }, '그림 요청 사이 쉬는 시간(초)', gap)),
      h('label', { class: 'field', style: { marginTop: '10px' } }, '브라우저 위치 (직접 지정일 때)', bpath),
      h('div', { style: { marginTop: '14px' } },
        h('b', null, '처음 한 번 로그인하기'),
        h('p', { class: 'small muted', style: { margin: '4px 0 8px' } }, '아래 버튼을 누르면 AnimeMaker V2 전용 브라우저 창이 열려요. 거기서 직접 로그인해 두면 다음부터 자동 클릭이 그 로그인을 써요. (비밀번호는 이 앱이 보지 않아요)'),
        h('div', { class: 'row', style: { gap: '6px' } }, ['gemini', 'grok', 'chatgpt'].map((k) => h('button', {
          class: 'btn small', onclick: () => AM.safe(() => window.api.botOpenSite(k), `${info.sites[k].name}${AM.josa(info.sites[k].name, '을', '를')} 열었어요. 로그인해 주세요.`),
        }, `🌐 ${info.sites[k].name} 로그인`)),
        h('button', { class: 'btn small ghost', onclick: () => AM.safe(() => window.api.botClose(), '닫았어요') }, '브라우저 닫기'))),
      h('details', {
        class: 'adv', style: { marginTop: '14px' },
        ontoggle: async (e) => { if (e.target.open && !recipeBox.value) { const r = await AM.safe(() => window.api.botRecipes()); if (r) recipeBox.value = JSON.stringify(r, null, 2); } },
      }, h('summary', null, '더 자세히: 자동 클릭 방법 고치기 (사이트 화면이 바뀌었을 때)'),
      h('p', { class: 'small muted' }, '각 작업(gemini.image, grok.image 등)의 단계(steps)와 선택자(any), 버튼 글자(texts)를 고칠 수 있어요. 잘 모르겠으면 건드리지 마세요. 이 칸은 [저장] 을 눌러야 저장돼요.'),
      recipeBox,
      h('div', { class: 'row', style: { marginTop: '8px' } },
        h('button', { class: 'btn small primary', onclick: () => AM.safe(() => window.api.botSaveRecipes(recipeBox.value), '저장했어요') }, '저장'),
        h('button', { class: 'btn small', onclick: async () => { await AM.safe(() => window.api.botResetRecipes(), '기본값으로 되돌렸어요'); const r = await window.api.botRecipes(); recipeBox.value = JSON.stringify(r, null, 2); } }, '기본값으로 되돌리기'))));
  }

  function riskDialog() {
    return new Promise((resolve) => {
      const c = h('input', { type: 'checkbox' });
      AM.modal('자동 클릭을 켜기 전에 꼭 읽어 주세요', h('div', null,
        h('ul', null,
          h('li', null, 'Google(Gemini), xAI(Grok), OpenAI(ChatGPT) 등의 이용약관은 대체로 ', h('b', null, '자동화된 수단으로 서비스를 이용하는 것'), '을 금지하거나 제한해요.'),
          h('li', null, '자동 클릭을 쓰면 ', h('b', null, '계정이 잠시 제한되거나 정지될 위험'), '이 있어요. 그 책임은 사용자 본인에게 있어요.'),
          h('li', null, '이 앱은 사람 속도로 천천히 누르고, 그림 사이에 쉬며, 구독 한도 안에서만 써요. 보안문자(CAPTCHA)를 풀거나 봇 탐지를 피하지 않아요.'),
          h('li', null, '불안하면 끄고 "직접 돕기" 를 쓰세요. 직접 돕기는 사용자가 직접 누르고, 앱은 내려받은 파일만 가져와요.')),
        h('label', { class: 'check', style: { marginTop: '10px', fontWeight: 700 } }, c, '위 내용을 이해했고, 내 계정에 대한 책임은 내가 집니다.')), [
        { label: '취소', onClick: () => resolve(false) },
        { label: '켜기', kind: 'primary', onClick: () => { if (!c.checked) { toast('체크박스에 동의해 주세요.', 'err'); return true; } resolve(true); return false; } },
      ], { onClose: () => resolve(false), sticky: true });
    });
  }

  function otherSection(s, info, asv) {
    const onLimit = h('select', null, h('option', { value: 'wait' }, '기다렸다가 자동으로 이어서 하기'), h('option', { value: 'stop' }, '멈추고 알려 주기'));
    onLimit.value = s.onLimit;
    const waitMin = h('input', { type: 'number', value: s.limitWaitMinutes, min: 5, max: 300 });
    const maxH = h('input', { type: 'number', value: s.limitMaxHours, min: 1, max: 48 });
    const ci = h('select', null, ['1', '2', '3'].map((v) => h('option', { value: v }, `${v}장씩`)));
    ci.value = String(s.concurrency.image);
    const saveOther = asv(() => window.api.saveSettings({ onLimit: onLimit.value, limitWaitMinutes: Number(waitMin.value), limitMaxHours: Number(maxH.value), concurrency: { image: Number(ci.value) } }), 600);
    [onLimit, ci].forEach((el) => el.addEventListener('change', saveOther));
    [waitMin, maxH].forEach((el) => el.addEventListener('input', saveOther));
    const folderRow = (label, key, cur) => h('label', { class: 'field' }, label, h('div', { class: 'row' },
      h('input', { type: 'text', value: cur, disabled: true }),
      h('button', { class: 'btn small', onclick: async (e) => { e.preventDefault(); const d = await window.api.pickFolder(); if (d) { await AM.safe(() => window.api.saveSettings({ [key]: d }), '바꿨어요. 앱을 다시 켜면 완전히 적용돼요.'); AM.state.info = await window.api.appInfo(); AM.go('settings'); } } }, '바꾸기'),
      h('button', { class: 'btn small', onclick: (e) => { e.preventDefault(); window.api.openPath(cur); } }, '📂 열기')));
    return h('div', { class: 'section' },
      h('h3', null, '📁 폴더 · 한도 · 그 밖'),
      h('div', { class: 'col' },
        folderRow('영상 저장 폴더', 'projectsDir', info.paths.projects),
        folderRow('다운로드 폴더 ("직접 돕기"가 새 파일을 지켜보는 곳 — 브라우저의 다운로드 위치와 같아야 해요)', 'downloadsDir', info.paths.downloads)),
      h('div', { class: 'grid3', style: { marginTop: '12px' } },
        h('label', { class: 'field' }, '오늘 쓸 수 있는 만큼 다 썼을 때', onLimit),
        h('label', { class: 'field' }, '몇 분 쉬었다가 다시 해 볼까요?', waitMin),
        h('label', { class: 'field' }, '최대 몇 시간까지 기다릴까요?', maxH)),
      h('div', { class: 'grid3', style: { marginTop: '12px' } },
        h('label', { class: 'field' }, '그림을 한 번에 몇 장씩 그릴까요? (자동일 때만)', ci, h('span', { class: 'hint' }, '같은 장면의 그림은 앞 그림을 보고 그려야 해서 차례로, 다른 장면끼리 동시에 그려요. 많을수록 빠르지만 구독 한도를 빨리 써요.'))),
      AM.kit.fold('진단 정보 (문제가 생겼을 때 알려 주세요)', h('div', { class: 'small muted col' },
        h('div', null, `영상 만드는 도구는 앱 안에 다 들어 있어서 따로 설치할 것이 없어요. (${info.ffmpeg})`),
        h('div', null, info.rife && info.rife.found
          ? `중간 그림을 부드럽게 만드는 도구가 준비돼 있어요. (${info.rife.dir}) 그래픽카드가 되면 빠르고, 안 되면 컴퓨터가 알아서 다른 방법으로 해요.`
          : '중간 그림은 컴퓨터가 자동으로 만들어요. (설치 파일에는 더 빠른 도구가 들어 있어요.)'))));
  }
}(window.AM));
