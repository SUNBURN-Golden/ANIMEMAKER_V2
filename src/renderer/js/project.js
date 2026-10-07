'use strict';
/* 진행 화면: 단계 진행, 도우미 안내, 결과물 확인·수정 (타임시트 · 그림 · 완성 영상) */
(function (AM) {
  const { h, clear, toast } = AM;
  AM.views = AM.views || {};

  let cur = null; // { id, snap, els, tab, userTab, sigs }
  const DCOLORS = ['#7c3aed', '#ff5e62', '#0ea5e9', '#16a34a', '#f59e0b', '#db2777', '#4f46e5', '#0d9488', '#ea580c', '#65a30d', '#9333ea', '#0891b2'];

  const TABS = [
    { id: 'timing', label: '🎵 노래·가사·컷' },
    { id: 'plan', label: '📝 기획' },
    { id: 'xsheet', label: '📋 타임시트' },
    { id: 'drawings', label: '🎨 그림' },
    { id: 'final', label: '🎬 완성 영상' },
    { id: 'log', label: '📜 진행 기록' },
  ];

  function tabForStep(step, status) {
    if (status === 'done') return 'final';
    return { music: 'timing', plan: 'plan', timing: 'timing', xsheet: 'xsheet', drawings: 'drawings', render: 'final', subtitles: 'final' }[step] || 'timing';
  }

  function abs(snap, rel) { return AM.joinPath(snap.dir, rel); }
  function url(snap, rel, v) { return AM.fileUrl(abs(snap, rel), v); }
  function aspectCss(a) { return ({ '9:16': '9 / 16', '16:9': '16 / 9', '1:1': '1 / 1', '4:5': '4 / 5' })[a] || '16 / 9'; }
  function dcolor(id) { return DCOLORS[Math.max(0, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.indexOf(String(id).slice(-1))) % DCOLORS.length]; }
  function drawingOf(snap, shotNo, id) { return (snap.drawings || []).find((d) => d.shot === shotNo && d.id === id); }

  AM.views.project = async function project(id) {
    const snap = await window.api.getProject(id);
    AM.state.projects.set(id, snap);
    cur = { id, snap, els: {}, tab: tabForStep(snap.currentStep, snap.status), userTab: false, sigs: {} };
    const root = h('div', null);
    cur.els.head = h('div');
    cur.els.stepper = h('div', { class: 'stepper' });
    cur.els.alert = h('div');
    cur.els.tabs = h('div', { class: 'tabs' });
    cur.els.body = h('div');
    root.append(cur.els.head, cur.els.stepper, cur.els.alert, cur.els.tabs, cur.els.body);
    renderAll(snap, true);
    return root;
  };

  AM.views.projectLeave = function () { cur = null; };

  AM.views.projectUpdate = function (snap) {
    if (!cur || cur.id !== snap.id) return;
    const prevStep = cur.snap.currentStep;
    cur.snap = snap;
    if (!cur.userTab && (snap.currentStep !== prevStep || snap.status === 'done')) cur.tab = tabForStep(snap.currentStep, snap.status);
    renderAll(snap, false);
  };

  AM.views.projectLog = function (line) {
    if (!cur || cur.tab !== 'log' || !cur.els.logbox) return;
    const box = cur.els.logbox;
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    box.appendChild(document.createTextNode(`${line}\n`));
    if (atBottom) box.scrollTop = box.scrollHeight;
  };

  function renderAll(snap, force) {
    renderHead(snap);
    renderStepper(snap);
    renderAlert(snap);
    renderTabs(snap);
    renderBody(snap, force);
  }

  // ---------- 머리 ----------
  function renderHead(snap) {
    const el = clear(cur.els.head);
    const title = (snap.plan && snap.plan.title) || snap.title;
    const st = snap.running ? (snap.waiting ? 'waiting' : 'running') : snap.status;
    const btns = [];
    if (snap.running) btns.push(h('button', { class: 'btn danger', onclick: () => AM.safe(() => window.api.stopProject(snap.id), '중지했어요') }, '■ 중지'));
    else if (snap.status !== 'done') btns.push(h('button', { class: 'btn primary', onclick: () => AM.safe(() => window.api.runProject(snap.id)) }, '▶ 이어서 하기'));
    btns.push(h('button', { class: 'btn', onclick: () => window.api.openPath(snap.dir) }, '📂 작업 폴더'));
    btns.push(h('button', { class: 'btn', disabled: snap.running, onclick: () => redoDialog(snap) }, '↻ 단계 다시 하기'));
    btns.push(h('button', { class: 'btn', disabled: snap.running, onclick: () => providersDialog(snap) }, '🔧 담당 AI'));
    const s = snap.series;
    el.appendChild(h('div', { class: 'proj-head' },
      h('div', { class: 'grow' },
        h('div', { class: 'row', style: { gap: '10px' } },
          s ? h('span', { class: 'chip pri ep-chip', onclick: () => AM.go('series', s.id) }, `${s.emoji || '📺'} ${s.name} EP${s.episode}`) : null,
          h('h2', { class: 'title' }, title),
          h('span', { class: `status-pill st-${st}` }, AM.STATUS_LABEL[st] || st)),
        h('div', { class: 'muted small' }, `${s ? `주인공 🔒 ${s.characters.map((c) => c.name).join(', ')}  ·  ` : ''}${snap.topic ? `이야기: ${snap.topic}  ·  ` : ''}워크플로우: ${snap.workflow.name || ''}  ·  ${snap.workflow.aspect}`)),
      h('div', { class: 'row', style: { gap: '6px' } }, btns)));
  }

  function renderStepper(snap) {
    const el = clear(cur.els.stepper);
    AM.STEP_META.forEach((m, i) => {
      const s = (snap.steps && snap.steps[m.id]) || {};
      const status = s.status || 'pending';
      const prog = status === 'done' ? 100 : (s.progress && s.progress.total ? Math.round((s.progress.done / s.progress.total) * 100) : 0);
      const who = m.who(snap.providers);
      el.appendChild(h('div', { class: `stp ${status}`, title: s.message || '' },
        h('div', { class: 'top' }, h('span', { class: 'dot' }), `${i + 1}. ${m.icon} ${m.label}`),
        h('div', { class: 'msg' }, status === 'pending' ? `대기 · ${who.short}` : (s.message || '')),
        h('div', { class: 'bar', style: { width: `${status === 'running' || status === 'waiting' ? Math.max(prog, 4) : prog}%` } })));
    });
  }

  // ---------- 도우미/오류 안내 ----------
  function renderAlert(snap) {
    const el = clear(cur.els.alert);
    const w = snap.waiting;
    if (w && snap.running) {
      if (w.kind === 'review' && w.key === 'review:lyrics') {
        el.appendChild(h('div', { class: 'wait-card' }, h('h3', null, '⌨ 가사 자막 시간 맞추기'), h('div', null, w.message),
          h('div', { class: 'actions' },
            h('button', { class: 'btn primary', onclick: () => tapSyncDialog(snap, true) }, '⌨ 탭으로 가사 맞추기'),
            h('button', { class: 'btn', onclick: () => window.api.continueReview(snap.id) }, '자동 추정으로 계속 ▶'))));
        return;
      }
      if (w.kind === 'review') {
        el.appendChild(h('div', { class: 'wait-card' }, h('h3', null, '👀 확인해 주세요'), h('div', null, w.message),
          h('div', { class: 'actions' },
            w.key === 'review:xsheet' ? h('button', { class: 'btn', onclick: () => { cur.tab = 'xsheet'; cur.userTab = true; renderTabs(snap); renderBody(snap, true); } }, '📋 타임시트 보기') : null,
            h('button', { class: 'btn primary', onclick: () => window.api.continueReview(snap.id) }, '계속 ▶'))));
        return;
      }
      if (w.kind === 'bot') {
        el.appendChild(h('div', { class: 'wait-card' }, h('h3', null, `🤖 ${w.title}`), h('div', null, w.message),
          h('div', { class: 'small muted', style: { marginTop: '6px' } }, '자동 클릭 브라우저 창(작업 표시줄의 Edge/Chrome)을 확인해 주세요. 해결되면 자동으로 계속합니다.')));
        return;
      }
      el.appendChild(helperCard(snap, w));
      return;
    }
    if (snap.status === 'limited' && snap.running && snap.limitUntil) {
      const t = new Date(snap.limitUntil);
      el.appendChild(h('div', { class: 'notice warn' }, `⏸ 구독 사용량 한도에 걸려서 기다리는 중이에요. ${t.getHours()}시 ${String(t.getMinutes()).padStart(2, '0')}분쯤 자동으로 이어서 합니다. (그냥 두셔도 돼요)`));
      return;
    }
    if (!snap.running && (snap.status === 'error' || snap.status === 'limited')) {
      const msg = snap.error || '';
      const hints = [];
      if (/로그인/.test(msg)) hints.push(h('button', { class: 'btn small', onclick: () => AM.go('settings') }, '🔌 AI 연결 설정에서 로그인하기'));
      if (/찾지 못했습니다|설치/.test(msg)) hints.push(h('button', { class: 'btn small', onclick: () => AM.go('settings') }, '🔌 AI 연결 설정에서 설치하기'));
      if (/그림 .*장을 그리지 못했습니다/.test(msg)) hints.push(h('button', { class: 'btn small', onclick: () => { cur.tab = 'drawings'; cur.userTab = true; renderTabs(snap); renderBody(snap, true); } }, '🎨 그림 탭 보기'));
      el.appendChild(h('div', { class: 'notice err' },
        h('b', null, snap.status === 'limited' ? '⏸ 구독 사용량 한도에 도달했어요. ' : '✖ 문제가 생겼어요. '),
        h('div', { style: { whiteSpace: 'pre-wrap', margin: '6px 0' } }, msg),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary small', onclick: () => AM.safe(() => window.api.runProject(snap.id)) }, '▶ 이어서 하기'),
          ...hints,
          h('span', { class: 'small muted' }, '이미 만든 것은 저장되어 있어서 이어서 하면 남은 부분만 만들어요.'))));
    }
    if (!snap.running && snap.status === 'stopped') {
      el.appendChild(h('div', { class: 'notice info' }, '중지된 상태예요. [▶ 이어서 하기] 를 누르면 멈춘 곳부터 계속합니다.'));
    }
  }

  function helperCard(snap, w) {
    const kindName = { music: '노래', image: '그림' }[w.kind] || '파일';
    const acts = [];
    if (w.copyText) acts.push(h('button', { class: 'btn primary', onclick: () => AM.safe(() => window.api.copyText(w.copyText), '복사했어요. 사이트 입력창에 Ctrl+V 로 붙여넣으세요.') }, '📋 프롬프트 복사'));
    if (w.siteUrl) acts.push(h('button', { class: 'btn', onclick: () => window.api.openExternal(w.siteUrl) }, `🌐 ${w.siteName} 열기`));
    acts.push(h('button', {
      class: 'btn',
      onclick: async () => {
        const f = await window.api.pickFile({ filters: [{ name: kindName, extensions: w.kind === 'image' ? ['png', 'jpg', 'jpeg', 'webp'] : ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'mp4', 'webm', 'mov'] }] });
        if (f) window.api.provideFile(snap.id, w.key, f);
      },
    }, '📁 파일 직접 고르기'));
    acts.push(h('button', { class: 'btn ghost', onclick: async () => { if (await AM.confirmBox('건너뛸까요?', `이 ${kindName} 없이 진행합니다. 같은 컷의 다른 그림으로 대신 보여 주고, 나중에 다시 그릴 수 있어요.`)) window.api.skipWaiting(snap.id, w.key); } }, '건너뛰기'));
    const refs = (w.images || []).length ? w.images : (w.image ? [{ file: w.image, note: '' }] : []);
    const refBox = refs.length ? h('div', { class: 'helper-refs' },
      h('div', { class: 'small', style: { fontWeight: 700, marginBottom: '6px' } }, '📎 아래 기준 그림을 사이트에 함께 첨부해 주세요 (같은 주인공으로 그리게 해요)'),
      h('div', { class: 'row', style: { gap: '8px', alignItems: 'flex-start' } }, refs.map((r, i) => h('div', { class: 'helper-ref' },
        h('img', { src: url(snap, r.file) }),
        h('div', { class: 'small muted' }, `${i + 1}. ${noteKo(r.note)}`),
        h('div', { class: 'row', style: { gap: '4px' } },
          h('button', { class: 'btn small', onclick: () => AM.safe(() => window.api.copyImage(abs(snap, r.file)), '그림을 복사했어요. 사이트에 Ctrl+V 로 붙여넣으세요.') }, '🖼️ 복사'),
          h('button', { class: 'btn small', onclick: () => window.api.showItem(abs(snap, r.file)) }, '📂')))))) : null;
    const drop = h('div', { class: 'dropzone' }, `또는 받은 ${kindName} 파일을 여기에 끌어다 놓으세요`);
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      const f = e.dataTransfer.files[0];
      if (f) window.api.provideFile(snap.id, w.key, window.api.pathForFile(f));
    });
    return h('div', { class: 'wait-card' },
      h('h3', null, `🙋 도와주세요: ${w.title}`),
      h('div', null, w.message),
      refBox,
      w.copyText ? h('div', { class: 'copybox' }, w.copyText) : null,
      h('div', { class: 'actions' }, acts),
      drop,
      h('div', { style: { marginTop: '8px' } }, h('span', { class: 'watching' }, `다운로드 폴더를 지켜보는 중 (${AM.state.info.paths.downloads}) - 새 파일이 생기면 자동으로 가져와요`)));
  }

  function noteKo(note) {
    if (/previous drawing/.test(note)) return '같은 컷의 앞 그림 (배경·구도 이어서)';
    if (/turnaround/.test(note)) return `${note.split(' — ')[0]} 앞·옆·뒤 모습`;
    if (/expression/.test(note)) return `${note.split(' — ')[0]} 표정 모음`;
    if (/full-body/.test(note)) return `${note.split(' — ')[0]} 전신`;
    return note ? note.split(' — ')[0] : '기준 그림';
  }

  // ---------- 탭 ----------
  function renderTabs(snap) {
    const el = clear(cur.els.tabs);
    TABS.forEach((t) => el.appendChild(h('button', {
      class: `tab ${cur.tab === t.id ? 'active' : ''}`,
      onclick: () => { cur.tab = t.id; cur.userTab = true; cur.sigs = {}; renderTabs(snap); renderBody(snap, true); },
    }, t.label, t.id === 'final' && (snap.renderStale || snap.subsStale) && snap.output ? ' •' : '')));
  }

  function renderBody(snap, force) {
    const fns = { plan: planTab, timing: timingTab, xsheet: xsheetTab, drawings: drawingsTab, final: finalTab, log: logTab };
    const sigFns = {
      plan: () => JSON.stringify([snap.plan, snap.running]),
      timing: () => JSON.stringify([snap.music && snap.music.analysis && snap.music.analysis.bpm, snap.song, snap.lyricsInput && snap.lyricsInput.raw, snap.timing, snap.running, snap.waiting && snap.waiting.key, snap.steps.music && snap.steps.music.status, snap.xsheet && snap.xsheet.transitions]),
      xsheet: () => JSON.stringify([snap.xsheet, snap.drawings, snap.running, snap.renderStale]),
      drawings: () => JSON.stringify([snap.drawings, snap.running]),
      final: () => JSON.stringify([snap.output, snap.renderStale, snap.subsStale, snap.running, snap.steps.render, snap.steps.subtitles]),
      log: () => 'log',
    };
    const sig = sigFns[cur.tab]();
    if (!force && cur.sigs[cur.tab] === sig) return;
    // 입력 중이면 다시 그리지 않는다
    const active = document.activeElement;
    if (!force && active && cur.els.body.contains(active) && /INPUT|TEXTAREA|SELECT/.test(active.tagName)) return;
    cur.sigs = { [cur.tab]: sig };
    const body = clear(cur.els.body);
    Promise.resolve(fns[cur.tab](snap)).then((node) => { if (node && cur && cur.els.body === body) { clear(body); body.appendChild(node); } });
  }

  // ---------- 기획 탭 ----------
  function planTab(snap) {
    const plan = snap.plan;
    if (!plan) return h('div', { class: 'section muted' }, snap.running ? '🧠 가사와 지난 이야기를 보고 이번 에피소드 이야기를 쓰는 중이에요… (보통 1~3분)' : '아직 기획안이 없어요. 노래 분석이 끝나면 만들어요.');
    return h('div', null,
      h('div', { class: 'section' },
        h('h3', null, plan.title),
        h('p', { class: 'desc' }, plan.logline),
        h('p', null, plan.concept),
        plan.episode_summary_ko ? h('div', { class: 'notice info small' }, h('b', null, '📚 이번 이야기 요약 (시리즈 기록에 남아요): '), plan.episode_summary_ko) : null,
        plan.music && (plan.music.genre || plan.music.mood) ? h('div', { class: 'small muted' }, `🎵 ${plan.music.genre || ''} ${plan.music.mood ? `· ${plan.music.mood}` : ''}`) : null,
        h('div', { class: 'grid2', style: { marginTop: '10px' } },
          h('div', null, h('b', null, '🎭 등장인물'), plan.characters.length
            ? h('ul', null, plan.characters.map((c) => h('li', null, h('b', null, c.name),
              c.fixed ? h('span', { class: 'chip ok', style: { marginLeft: '6px' } }, '🔒 고정') : c.role === 'guest' ? h('span', { class: 'chip', style: { marginLeft: '6px' } }, '이번 화 손님') : null,
              c.description_ko ? ` - ${c.description_ko}` : '', h('div', { class: 'small muted' }, c.appearance_en))))
            : h('p', { class: 'muted small' }, '(인물 없이 풍경 위주)')),
          h('div', null, h('b', null, '📖 시나리오 (노래 순서대로)'), h('ol', null, plan.story.map((st) => h('li', null,
            st.sections && st.sections.length ? h('span', { class: 'chip', style: { marginRight: '6px' } }, st.sections.join(', ')) : null,
            st.summary_ko)))))),
      h('div', { class: 'small muted' }, '기획을 바꾸고 싶으면 [↻ 단계 다시 하기] → "기획부터" 를 고르세요. 워크플로우의 "추가 지시" 나 이번 이야기 칸에 원하는 방향을 적으면 반영돼요.'));
  }

  // ---------- 노래·가사·컷 탭 ----------
  function timingTab(snap) {
    const m = snap.music;
    const a = m && m.analysis;
    const t = snap.timing;
    const inLyricReview = !!(snap.waiting && snap.waiting.key === 'review:lyrics');
    const kids = [];

    // 노래
    const songAbs = snap.song ? abs(snap, snap.song.file) : null;
    const audio = h('audio', { controls: true, src: songAbs ? AM.fileUrl(songAbs) : '', preload: 'auto', style: { width: '100%' } });
    const bpmIn = h('input', { type: 'number', value: a ? Math.round(a.bpm) : 120, min: 40, max: 220, style: { width: '90px' }, disabled: snap.running || !a });
    kids.push(h('div', { class: 'section' },
      h('div', { class: 'row' },
        h('div', { class: 'grow' },
          h('h3', null, snap.song ? `🎵 ${snap.song.name}` : '🎵 노래 파일이 아직 없어요'),
          h('p', { class: 'desc' }, a
            ? `길이 ${AM.fmtSec(a.duration)} · BPM ${a.bpm} · 마디 ${a.downbeats.length}개 (내 PC 에서 자동 분석). 박자가 두 배/절반으로 잘못 잡혔다면 BPM 을 고쳐 다시 분석하세요.`
            : (snap.song ? '분석을 기다리는 중이에요.' : 'Suno 등에서 만든 노래 파일을 넣어 주세요.'))),
        a ? h('div', { class: 'row', style: { gap: '6px' } }, 'BPM', bpmIn, h('button', {
          class: 'btn small', disabled: snap.running,
          onclick: async () => {
            const r = await AM.safe(() => window.api.setBpm(snap.id, Number(bpmIn.value)), '다시 분석했어요');
            if (r && snap.timing && await AM.confirmBox('컷을 다시 나눌까요?', '박자가 바뀌었으니 컷 나누기부터 다시 하는 게 좋아요. 이미 그린 그림은 장면이 같으면 그대로 써요.', '컷 나누기부터 다시')) {
              window.api.runProject(snap.id, 'timing');
            }
          },
        }, 'BPM 바꿔서 다시 분석')) : null,
        h('button', {
          class: 'btn small', disabled: snap.running,
          onclick: async () => {
            const f = await window.api.pickFile({ filters: [{ name: '노래', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'mp4', 'webm', 'mov', 'm4v'] }] });
            if (!f) return;
            if (snap.song && !await AM.confirmBox('노래를 바꿀까요?', '노래가 바뀌면 박자 분석과 컷 나누기, 타임시트를 다시 해요. 기획(이야기)은 그대로 둬요.', '바꾸기')) return;
            if (await AM.safe(() => window.api.replaceSong(snap.id, f), '노래를 바꿨어요. [▶ 이어서 하기] 를 누르세요.')) AM.go('project', snap.id);
          },
        }, snap.song ? '🎵 노래 바꾸기' : '🎵 노래 넣기')),
      songAbs ? audio : null));

    // 가사
    const li = snap.lyricsInput || { raw: '', lines: [] };
    const editable = !snap.running || inLyricReview;
    const ta = h('textarea', { rows: 8, disabled: !editable, placeholder: '가사가 없으면 연주곡으로 만들어요.' });
    ta.value = li.raw || '';
    let fname = '';
    const cutsFixed = !!(snap.steps.timing && snap.steps.timing.status === 'done' && t && t.segments);
    kids.push(h('div', { class: 'section' },
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('h3', null, `📝 가사 ${li.lines.length}줄 ${li.timed ? '(시간 포함 ✔)' : ''}`),
          h('p', { class: 'desc' }, cutsFixed
            ? '컷이 이미 정해졌어요. 가사를 고치면 자막만 다시 입혀요 (그림·렌더링은 그대로, 빨라요).'
            : 'Suno 가사를 그대로 붙여넣어도 돼요. [Verse] [Chorus] 같은 구간 표시는 자막에 나오지 않고, 장면을 나누고 하이라이트를 찾을 때 써요.')),
        h('button', {
          class: 'btn small', disabled: !editable,
          onclick: async () => {
            const f = await window.api.pickFile({ filters: [{ name: '가사', extensions: ['txt', 'lrc', 'srt'] }] });
            if (!f) return;
            const text = await AM.safe(() => window.api.readTextFile(f));
            if (text != null) { ta.value = text; fname = f.split(/[\\/]/).pop(); }
          },
        }, '📄 가사 파일 불러오기'),
        h('button', {
          class: 'btn small primary', disabled: !editable,
          onclick: async () => {
            const ok = await AM.safe(() => window.api.updateLyricsText(snap.id, ta.value, fname), '가사를 저장했어요');
            if (ok && inLyricReview) { toast('바뀐 가사로 자막 줄을 다시 만들었어요. [⌨ 탭으로 가사 맞추기] 또는 [자동 추정으로 계속] 을 누르세요.'); return; }
            if (ok && cutsFixed && snap.output && snap.output.clean && await AM.confirmBox('자막만 다시 입힐까요?', '그림과 렌더링은 그대로 두고, 바뀐 가사로 자막만 다시 입혀요. (몇십 초~몇 분)', '💬 자막만 다시 입히기')) {
              window.api.runProject(snap.id, 'subtitles');
            } else if (ok && !cutsFixed && snap.steps.timing) toast('가사가 바뀌었어요. [▶ 이어서 하기] 를 누르면 컷 나누기부터 다시 해요.');
          },
        }, '💾 가사 저장')),
      ta));

    if (t && (t.segments || (t.lyrics && t.lyrics.length))) {
      const canTap = (!snap.running || inLyricReview) && t.lyrics && t.lyrics.length;
      const srcLabel = { tap: '(직접 맞춤 ✔)', lrc: '(가사 파일 시간 ✔)', srt: '(자막 파일 시간 ✔)', auto: '(자동 추정 - 탭으로 맞추면 정확해져요)' }[t.lyricsSource] || '';
      kids.push(h('div', { class: 'section' },
        h('div', { class: 'row' },
          h('div', { class: 'grow' }, h('h3', null, `${t.segments ? `✂ 컷 ${t.segments.length}개 · ` : ''}가사 자막 ${t.lyrics.length}줄 ${srcLabel}`),
            h('p', { class: 'desc' }, '보라색 세로줄 = 마디 시작, 회색 = 박자. 컷 경계는 모두 박자 위에 있어요. ⭐ = 하이라이트 컷(그림을 많이 써서 활기차게). 컷을 누르면 그 위치부터 재생돼요.')),
          h('button', { class: 'btn primary', disabled: !canTap, onclick: () => tapSyncDialog(snap, inLyricReview) }, '⌨ 탭으로 가사 맞추기')),
        a ? timeline(snap, audio) : null,
        t.segments ? segTable(snap) : null));
    }
    return h('div', null, kids);
  }

  function timeline(snap, audio) {
    const a = snap.music.analysis;
    const t = snap.timing;
    const D = a.duration;
    const pct = (x) => `${(x / D) * 100}%`;
    const colors = ['#7c3aed', '#ff5e62', '#0ea5e9', '#16a34a', '#f59e0b', '#db2777', '#4f46e5', '#0d9488'];
    const hl = t.highlights || [];
    const trsList = (snap.xsheet && snap.xsheet.transitions) || [];
    const beats = h('div', { class: 'tl-row small' }, a.beats.map((b) => h('div', { class: `tl-beat ${a.downbeats.some((d) => Math.abs(d - b) < 0.02) ? 'down' : ''}`, style: { left: pct(b) } })));
    const segs = h('div', { class: 'tl-row' }, (t.segments || []).map((s, i) => h('div', {
      class: 'tl-seg', title: `컷 ${s.index}: ${s.start.toFixed(2)}~${s.end.toFixed(2)}초 (${s.beats}박)${hl[i] ? ' ⭐ 하이라이트' : ''}`,
      style: { left: pct(s.start), width: pct(s.duration), background: colors[i % colors.length] },
      onclick: () => { audio.currentTime = s.start; audio.play(); },
    }, `${hl[i] ? '⭐' : ''}${s.index}`)));
    const trs = h('div', { class: 'tl-row small' }, (t.segments ? trsList : []).map((tr, i) => (tr.type === 'cut' || !t.segments[i] ? null : h('div', { class: 'tl-tr', style: { left: pct(t.segments[i].end) }, title: tr.type }, trIcon(tr.type)))));
    const lyr = h('div', { class: 'tl-row' }, t.lyrics.map((l) => h('div', { class: 'tl-lyr', style: { left: pct(l.start), width: pct(Math.max(0.3, l.end - l.start)) }, title: `${l.start.toFixed(2)}s ${l.text}` }, l.text)));
    const head = h('div', { class: 'tl-head', style: { left: '0%' } });
    const wrap = h('div', { class: 'timeline' }, h('div', { class: 'tl-label' }, '박자'), beats, h('div', { class: 'tl-label' }, '컷 / 화면전환'), trs, segs, h('div', { class: 'tl-label' }, '가사 자막'), lyr, head);
    audio.addEventListener('timeupdate', () => { head.style.left = `calc(10px + (100% - 20px) * ${audio.currentTime / D})`; });
    return wrap;
  }

  function trIcon(type) {
    return ({ fade: '◐ 페이드', dissolve: '◌ 디졸브', fadeblack: '■ 암전', flash: '✦ 플래시', slideleft: '⇐ 슬라이드', slideup: '⇑ 슬라이드', wipeleft: '▤ 와이프', zoomin: '⊕ 줌', circleopen: '◯ 원형', pixelize: '▦ 픽셀', smoothleft: '⇐ 스무스' })[type] || type;
  }

  function segTable(snap) {
    const t = snap.timing;
    const xs = snap.xsheet;
    return h('table', { class: 'prov-table small', style: { marginTop: '12px' } },
      h('tbody', null, t.segments.map((s, i) => {
        const shot = xs && xs.shots[i];
        const tr = xs && xs.transitions[i];
        return h('tr', null,
          h('td', { style: { width: '120px' } }, `${(t.highlights || [])[i] ? '⭐ ' : ''}컷 ${s.index}`, h('div', { class: 'muted' }, `${s.start.toFixed(2)}~${s.end.toFixed(2)}초`)),
          h('td', { style: { width: '110px' } }, `${s.duration.toFixed(2)}초`, h('div', { class: 'muted' }, `${(t.frames || [])[i] || '-'}프레임 · ${s.beats}박 · ${({ high: '강', mid: '중', low: '약' })[s.energy]}`)),
          h('td', null, shot ? `그림 ${shot.drawings.length}장 · ${AM.CAMERA_LABEL[shot.camera.move] || shot.camera.move}` : '', h('div', { class: 'muted' }, s.lyrics.map((k) => t.lyrics[k] && t.lyrics[k].text).filter(Boolean).join(' / ') || '(간주)')),
          h('td', { style: { width: '110px' } }, tr ? (tr.type === 'cut' ? '컷' : `${trIcon(tr.type)} ${tr.frames}프레임`) : (i < t.segments.length - 1 ? '' : '끝')));
      })));
  }

  function tapSyncDialog(snap, inReview) {
    const t = snap.timing;
    const lines = (t.lyrics && t.lyrics.length ? t.lyrics : []).map((l) => ({ ...l }));
    if (!lines.length) { toast('가사가 없어요.', 'err'); return; }
    const D = snap.music.analysis.duration;
    const marks = lines.map((l) => l.start);
    let idx = 0;
    const audio = h('audio', { controls: true, src: url(snap, snap.music.song), style: { width: '100%' } });
    const progress = h('span', { class: 'small muted' });
    const rate = h('select', { style: { width: '120px' }, onchange: () => { audio.playbackRate = Number(rate.value); } },
      h('option', { value: '1' }, '보통 속도'), h('option', { value: '0.75' }, '0.75배 느리게'), h('option', { value: '0.5' }, '0.5배 느리게'));
    const list = h('div', { class: 'tap-lines' });
    const render = () => {
      clear(list);
      lines.forEach((l, i) => list.appendChild(h('div', { class: `tap-line ${i === idx ? 'cur' : ''}` },
        h('span', { class: 'tm' }, i < idx ? marks[i].toFixed(2) : (i === idx ? '▶' : marks[i].toFixed(2))), l.text)));
      const c = list.children[idx];
      if (c) c.scrollIntoView({ block: 'nearest' });
      progress.textContent = `${Math.min(idx, lines.length)} / ${lines.length} 줄`;
    };
    const onKey = (e) => {
      if (e.code === 'Space') {
        e.preventDefault();
        if (idx < lines.length) { marks[idx] = Math.max(0, audio.currentTime - 0.12 * audio.playbackRate); idx++; render(); }
      } else if (e.code === 'Backspace') {
        e.preventDefault();
        if (idx > 0) { idx--; render(); }
      }
    };
    document.addEventListener('keydown', onKey);
    render();
    AM.modal('⌨ 탭으로 가사 맞추기', h('div', null,
      h('p', null, '노래를 재생하고, 각 가사 줄이 ', h('b', null, '시작되는 순간'), '에 ', h('span', { class: 'kbd' }, 'Space'), ' 를 누르세요. 틀리면 ', h('span', { class: 'kbd' }, 'Backspace'), ' 로 한 줄 되돌려요.'),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => { idx = 0; audio.currentTime = 0; audio.play(); render(); } }, '⏮ 처음부터 맞추기'), rate, progress),
      h('div', { style: { margin: '10px 0' } }, audio),
      list), [
      { label: '취소' },
      {
        label: '💾 저장', kind: 'primary',
        onClick: async () => {
          for (let i = 1; i < marks.length; i++) if (marks[i] <= marks[i - 1]) { toast(`${i + 1}번째 줄 시간이 앞 줄보다 빨라요. 다시 맞춰 주세요.`, 'err'); return true; }
          if (idx < lines.length && !await AM.confirmBox('아직 다 안 맞췄어요', `${lines.length}줄 중 ${idx}줄만 맞췄어요. 나머지 줄은 원래 시간으로 저장할까요?`, '그대로 저장')) return true;
          const out = lines.map((l, i) => ({ text: l.text, part: l.part, section: l.section, sectionStart: l.sectionStart, start: marks[i], end: Math.min(i + 1 < marks.length ? marks[i + 1] - 0.05 : D - 0.1, marks[i] + 7) }));
          const ok = await AM.safe(() => window.api.updateLyrics(snap.id, out), '가사 타이밍을 저장했어요');
          if (ok === undefined) return true;
          if (inReview) { window.api.continueReview(snap.id); return false; }
          const subsOnly = await AM.confirmBox('어떻게 반영할까요?', '• 자막만 다시 입히기: 그림·렌더링은 그대로, 완성 영상의 자막만 새 타이밍으로 (빠름)\n• 컷도 다시 나누기: 새 가사 타이밍에 맞춰 컷 경계부터 다시 (타임시트·그림을 다시 만들 수 있어요)', '💬 자막만 다시 입히기');
          if (subsOnly) window.api.runProject(snap.id, 'subtitles');
          else if (await AM.confirmBox('컷도 다시 나눌까요?', '컷 나누기 단계부터 다시 진행합니다.', '컷 다시 나누기')) window.api.runProject(snap.id, 'timing');
          return false;
        },
      },
    ], { width: 'min(760px, 94vw)', sticky: true, onClose: () => { document.removeEventListener('keydown', onKey); audio.pause(); } });
  }

  // ---------- 타임시트 탭 ----------
  function xsheetTab(snap) {
    const xs = snap.xsheet;
    if (!xs) return h('div', { class: 'section muted' }, snap.running && snap.currentStep === 'xsheet' ? '📋 AI 가 컷마다 그림 장수·노출 프레임·카메라를 짜는 중이에요… (보통 1~3분)' : '컷 나누기가 끝나면 타임시트(그림 노출표)를 짜요.');
    const hl = xs.shots.filter((s) => s.highlight);
    const ar = aspectCss(snap.workflow.aspect);
    return h('div', null,
      snap.renderStale && !snap.running ? h('div', { class: 'notice warn row' }, h('span', { class: 'grow' }, '✏️ 바뀐 그림·노출·카메라가 있어요. 다시 렌더링하면 바뀐 컷만 새로 만들어요. (내 PC, 무료)'),
        h('button', { class: 'btn primary small', onclick: () => window.api.runProject(snap.id, 'render') }, '🎬 다시 렌더링')) : null,
      h('div', { class: 'section' },
        h('div', { class: 'row' },
          h('div', { class: 'grow' },
            h('h3', null, `📋 타임시트 · 컷 ${xs.shots.length}개 · 그림 ${xs.totalDrawings}장 (예산 ${xs.budget}장)`),
            h('p', { class: 'desc' }, `1초 = 24프레임. 보통 컷은 그림 몇 장을 길게 보여 주며 카메라가 움직이고, ⭐ 하이라이트 컷(${hl.length}개)은 그림을 많이 써서 2프레임마다 넘겨요. 총 ${xs.totalFrames}프레임 = ${AM.fmtSec(xs.totalFrames / 24)}`)),
          h('button', { class: 'btn small', onclick: () => window.api.openPath(AM.joinPath(snap.dir, 'output')) }, '📂 timesheet.json')),
        xs.notes && xs.notes.length ? h('details', { class: 'adv' }, h('summary', null, `🔧 PC 가 고친 것 ${xs.notes.length}개 (프레임 합계 맞추기 등)`),
          h('ul', { class: 'small muted' }, xs.notes.map((n) => h('li', null, n)))) : null),
      xs.shots.map((s, i) => shotCard(snap, s, xs.transitions[i], ar)));
  }

  function shotCard(snap, s, tr, ar) {
    const total = s.frames;
    const used = new Map();
    for (const e of s.exposure) used.set(e.drawing, (used.get(e.drawing) || 0) + e.frames);
    // 바꾼 뒤에는 칸에서 손을 떼야(blur) 화면이 새 내용으로 다시 그려진다
    const camSel = h('select', { class: 'cam-sel', disabled: snap.running, onchange: (e) => { e.target.blur(); AM.safe(() => window.api.setCamera(snap.id, s.shot, e.target.value), '카메라를 바꿨어요. [🎬 다시 렌더링] 을 누르면 반영돼요.'); } },
      (AM.state.info.cameraMoves || Object.keys(AM.CAMERA_LABEL)).map((m) => h('option', { value: m }, AM.CAMERA_LABEL[m] || m)));
    camSel.value = s.camera.move;
    const thumbs = h('div', { class: 'xs-drawings' }, s.drawings.map((d) => {
      const it = drawingOf(snap, s.shot, d.id);
      const v = it && it.updatedAt;
      return h('div', { class: 'xs-draw', title: d.prompt_en },
        h('div', { class: 'thumb', style: { aspectRatio: ar, borderColor: dcolor(d.id) } },
          it && it.file && it.status !== 'running' ? h('img', { src: url(snap, it.file, v), loading: 'lazy', onclick: () => bigImage(snap, it.file, v) })
            : h('div', { class: 'ph' }, it && it.status === 'running' ? '그리는 중…' : it && it.status === 'error' ? '⚠ 실패' : '대기'),
          h('span', { class: 'badge', style: { background: dcolor(d.id) } }, d.id),
          h('span', { class: 'badge r' }, `${used.get(d.id) || 0}f`)),
        h('div', { class: 'acts' },
          h('button', { class: 'btn small', disabled: snap.running || !it, onclick: () => editPromptDialog(snap, it) }, '✏️'),
          h('button', { class: 'btn small', disabled: snap.running || !it, onclick: () => replaceDrawing(snap, it) }, '📁')));
    }));
    // 노출 띠 (X-sheet 를 가로로 펼친 모양)
    const strip = h('div', { class: 'xs-strip' }, s.exposure.map((e) => h('div', {
      class: 'xs-cell', title: `${e.drawing} · ${e.frames}프레임`,
      style: { flexGrow: e.frames, background: dcolor(e.drawing) },
    }, e.frames >= 6 ? `${e.drawing}${e.frames >= 10 ? ` ${e.frames}` : ''}` : '')));
    let acc = 0;
    const table = h('table', { class: 'xs-table small' },
      h('thead', null, h('tr', null, h('th', null, '순서'), h('th', null, '그림'), h('th', null, '프레임 (보여 주는 길이)'), h('th', null, '시작 프레임'), h('th', null, '초'))),
      h('tbody', null, s.exposure.map((e, k) => {
        const start = acc;
        acc += e.frames;
        const inp = h('input', {
          type: 'number', value: e.frames, min: 1, max: total, disabled: snap.running || s.exposure.length < 2, style: { width: '80px' },
          onchange: (ev) => { ev.target.blur(); AM.safe(() => window.api.retime(snap.id, s.shot, k, Number(ev.target.value)), '노출을 바꿨어요. 컷 길이는 그대로라 다음 칸이 맞춰 줄어들거나 늘어나요.'); },
        });
        return h('tr', null, h('td', null, String(k + 1)), h('td', null, h('span', { class: 'dchip', style: { background: dcolor(e.drawing) } }, e.drawing)), h('td', null, inp), h('td', null, String(start)), h('td', null, (e.frames / 24).toFixed(2)));
      })));
    return h('div', { class: `section shot-card ${s.highlight ? 'hl' : ''}` },
      h('div', { class: 'row' },
        h('div', { class: 'grow' },
          h('div', { class: 'row', style: { gap: '8px' } },
            h('b', null, `컷 ${s.shot}`),
            s.highlight ? h('span', { class: 'chip warn' }, '⭐ 하이라이트 · 2프레임씩') : h('span', { class: 'chip' }, '보통 · 길게 보여 주기'),
            h('span', { class: 'small muted' }, `${AM.fmtSec(s.start)}~${AM.fmtSec(s.end)} · ${total}프레임 · 그림 ${s.drawings.length}장`),
            s.fx.map((f) => h('span', { class: 'chip pri' }, AM.FX_LABEL[f] || f)),
            tr ? h('span', { class: 'small muted' }, `→ 다음 컷: ${tr.type === 'cut' ? '컷' : trIcon(tr.type)}`) : null),
          h('div', { class: 'small muted', style: { marginTop: '3px' } }, `🏞 ${s.scene_en}${s.framing_en ? ` · ${s.framing_en}` : ''}`)),
        h('div', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'small muted' }, '카메라'), camSel,
          h('button', { class: 'btn small', onclick: () => flipbook(snap, s) }, '▶ 넘겨보기'))),
      thumbs,
      strip,
      h('details', { class: 'adv', style: { marginTop: '8px' } }, h('summary', null, '📋 노출표 자세히 (프레임 바꾸기)'), table));
  }

  /** 그림만 넘겨 보는 미리보기 (24fps, 카메라 없이) */
  function flipbook(snap, s) {
    const srcs = new Map(s.drawings.map((d) => { const it = drawingOf(snap, s.shot, d.id); return [d.id, it && it.file ? url(snap, it.file, it.updatedAt) : '']; }));
    const img = h('img', { class: 'flip-img', style: { aspectRatio: aspectCss(snap.workflow.aspect) } });
    const label = h('div', { class: 'small muted mono' });
    let k = 0;
    let f = 0;
    let timer = null;
    const tick = () => {
      const e = s.exposure[k];
      img.src = srcs.get(e.drawing) || '';
      label.textContent = `그림 ${e.drawing} · ${f + 1}/${s.frames} 프레임`;
      const wait = (e.frames * 1000) / 24;
      f += e.frames;
      k = (k + 1) % s.exposure.length;
      if (k === 0) f = 0;
      timer = setTimeout(tick, wait);
    };
    tick();
    AM.modal(`▶ 컷 ${s.shot} 넘겨보기`, h('div', { class: 'col', style: { alignItems: 'center' } }, img, label,
      h('div', { class: 'small muted' }, '그림만 순서대로 넘겨요. 카메라 움직임과 필름 느낌은 렌더링한 영상에서 볼 수 있어요.')),
    [{ label: '닫기' }], { width: 'min(900px, 94vw)', onClose: () => clearTimeout(timer) });
  }

  // ---------- 그림 탭 ----------
  function drawingsTab(snap) {
    const ds = snap.drawings || [];
    if (!ds.length) return h('div', { class: 'section muted' }, '타임시트가 끝나면 그림을 한 장씩 그려요.');
    const ar = aspectCss(snap.workflow.aspect);
    const s = snap.series;
    const refCards = s ? s.characters.flatMap((c) => c.refs.map((r) => h('div', { class: 'media-card' },
      h('div', { class: 'thumb', style: { aspectRatio: '4 / 3' } }, h('img', { src: url(snap, r.file), onclick: () => bigImage(snap, r.file) }), h('span', { class: 'badge' }, `🔒 ${c.name} · ${(AM.state.info.refKinds || {})[r.kind] || r.kind}`))))) : [];
    const done = ds.filter((d) => d.status === 'done').length;
    return h('div', null,
      refCards.length ? h('div', { class: 'section' },
        h('h3', null, '🔒 기준 그림 (캐릭터 파일)'),
        h('p', { class: 'desc' }, '그림을 그릴 때마다 이 그림들과 고정 설명·색·규칙을 함께 보내서, 주인공이 늘 똑같이 나오게 해요. 같은 컷의 앞 그림도 함께 보내서 자세가 자연스럽게 이어져요.'),
        h('div', { class: 'media-grid ref-grid' }, refCards)) : null,
      h('p', { class: 'muted small' }, `${done}/${ds.length}장 완료 · 마음에 안 드는 그림은 [✏️ 다시] 를 누르거나 직접 그린 파일로 [📁 교체] 할 수 있어요. 바꾼 뒤 [🎬 다시 렌더링] 을 누르면 그 컷만 다시 만들어요.`),
      h('div', { class: 'media-grid' }, ds.map((d) => drawingCard(snap, d, ar))));
  }

  function drawingCard(snap, it, ar) {
    const v = it.updatedAt || 0;
    let media;
    if (it.file && it.status !== 'running') media = h('img', { src: url(snap, it.file, v), loading: 'lazy', onclick: () => bigImage(snap, it.file, v) });
    else if (it.status === 'running') media = h('div', { class: 'col', style: { alignItems: 'center' } }, h('div', { class: 'spinner' }), h('div', { class: 'ph' }, '그리는 중…'));
    else media = h('div', { class: 'ph' }, it.status === 'error' ? '⚠ 실패' : it.status === 'skipped' ? '건너뜀' : '대기 중');
    const shot = snap.xsheet && snap.xsheet.shots.find((x) => x.shot === it.shot);
    const d = shot && shot.drawings.find((x) => x.id === it.id);
    return h('div', { class: 'media-card' },
      h('div', { class: 'thumb', style: { aspectRatio: ar } }, media,
        h('span', { class: 'badge', style: { background: dcolor(it.id) } }, `컷 ${it.shot} · ${it.id}`),
        shot && shot.highlight ? h('span', { class: 'badge r' }, '⭐') : null),
      h('div', { class: 'body' },
        it.error ? h('div', { class: 'small', style: { color: 'var(--err)' } }, it.error) : null,
        h('div', { class: 'p', title: it.prompt }, (d && d.prompt_en) || it.prompt),
        h('div', { class: 'acts' },
          h('button', { class: 'btn small', disabled: snap.running, onclick: () => editPromptDialog(snap, it) }, '✏️ 다시'),
          h('button', { class: 'btn small', disabled: snap.running, onclick: () => replaceDrawing(snap, it) }, '📁 교체'),
          h('button', { class: 'btn small', onclick: () => AM.safe(() => window.api.copyText(it.prompt), '프롬프트를 복사했어요') }, '📋'))));
  }

  async function replaceDrawing(snap, it) {
    const f = await window.api.pickFile({ filters: [{ name: '그림', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    if (f) AM.safe(() => window.api.replaceItem(snap.id, 'drawing', it.shot, f, it.id), '교체했어요. [🎬 다시 렌더링] 을 누르면 반영돼요.');
  }

  function editPromptDialog(snap, it) {
    const ta = h('textarea', { rows: 10 });
    ta.value = it.prompt;
    AM.modal(`그림 컷${it.shot}-${it.id} 다시 그리기`, h('div', null,
      h('p', { class: 'muted small' }, '프롬프트(영어 권장)를 고친 뒤 [다시 그리기] 를 누르세요. 고치지 않고 그냥 눌러도 새로 그려요. 캐릭터 기준 그림은 자동으로 함께 보내요. (캐릭터 설명 부분은 지우지 마세요)'),
      ta), [
      { label: '취소' },
      {
        label: '🔄 다시 그리기', kind: 'primary',
        onClick: () => {
          AM.safe(() => window.api.regenerate(snap.id, 'drawing', it.shot, { id: it.id, prompt: ta.value.trim() }), '다시 그렸어요. [🎬 다시 렌더링] 을 누르면 반영돼요.');
        },
      },
    ], { width: 'min(820px, 94vw)' });
  }

  function bigImage(snap, rel, v) {
    AM.modal('크게 보기', h('img', { src: url(snap, rel, v), style: { maxWidth: '100%', maxHeight: '72vh', display: 'block', margin: '0 auto', borderRadius: '10px' } }),
      [{ label: '📂 위치 열기', onClick: () => { window.api.showItem(abs(snap, rel)); return true; } }, { label: '닫기' }], { width: 'min(980px, 94vw)' });
  }

  // ---------- 완성 탭 ----------
  function finalTab(snap) {
    const o = snap.output || {};
    const rerender = h('button', { class: 'btn', disabled: snap.running || !snap.xsheet, onclick: () => window.api.runProject(snap.id, 'render') }, '🎬 다시 렌더링 (바뀐 컷만)');
    const resub = h('button', { class: 'btn', disabled: snap.running || !o.clean, onclick: () => window.api.runProject(snap.id, 'subtitles') }, '💬 자막만 다시 입히기');
    if (!o.video) {
      const s = snap.steps.render && snap.steps.render.status === 'running' ? snap.steps.render : snap.steps.subtitles;
      return h('div', { class: 'section' }, h('h3', null, '🎬 아직 완성 전이에요'),
        h('p', { class: 'desc' }, s && s.status === 'running' ? s.message : '그림이 다 그려지면 내 PC 가 타임시트대로 그림을 넘기고 카메라를 움직여 깨끗한 원본을 만들고, 마지막에 가사 자막을 입혀요.'),
        h('div', { class: 'row' }, snap.xsheet ? rerender : null, o.clean ? resub : null));
    }
    const file = abs(snap, o.video);
    const clean = o.clean ? abs(snap, o.clean) : null;
    return h('div', null,
      snap.renderStale ? h('div', { class: 'notice warn' }, '✏️ 바뀐 그림·노출·카메라가 있어요. [🎬 다시 렌더링] 을 누르면 바뀐 컷만 새로 만들고 자막까지 다시 입혀요. (내 PC, 무료)') : null,
      !snap.renderStale && snap.subsStale ? h('div', { class: 'notice warn' }, '✏️ 가사·자막이 바뀌었어요. [💬 자막만 다시 입히기] 를 누르면 몇십 초~몇 분이면 돼요.') : null,
      h('div', { class: 'section' },
        h('div', { class: 'final-wrap' },
          h('video', {
            src: AM.fileUrl(file, o.madeAt), controls: true, preload: 'metadata',
            style: snap.workflow.aspect === '16:9'
              ? { width: '100%', maxWidth: '760px', flex: '1 1 480px', height: 'auto' }
              : { height: 'min(68vh, 640px)', width: 'auto', flex: 'none' },
          }),
          h('div', { class: 'col', style: { minWidth: '260px' } },
            h('h3', null, snap.series ? `🎉 EP${snap.series.episode} 완성!` : '🎉 완성!'),
            h('div', { class: 'small muted' }, o.video.split('/').pop()),
            h('button', { class: 'btn primary', onclick: () => window.api.showItem(file) }, '📂 파일 위치 열기'),
            clean ? h('button', { class: 'btn', onclick: () => window.api.showItem(clean) }, '🎞 자막 없는 깨끗한 원본') : null,
            rerender, resub,
            h('div', { class: 'small muted' }, '같은 폴더에 가사 자막 파일(lyrics.srt / lyrics.lrc), 스토리보드(storyboard.md), 타임시트(timesheet.json)도 있어요.'),
            snap.series ? h('div', { class: 'notice ok small' }, `📚 이번 이야기 요약이 "${snap.series.name}" 기록에 남았어요. 다음 에피소드는 이 이야기에서 이어져요.`,
              h('div', { style: { marginTop: '6px' } }, h('button', { class: 'btn small', onclick: () => AM.go('home', snap.series.id) }, `🎬 EP${snap.series.episode + 1} 만들기`))) : null,
            h('div', { class: 'notice info small' }, '📌 업로드할 때는 플랫폼의 "AI 생성 콘텐츠" 표시 규정을 확인하세요. (파일 정보에도 AI 생성 표시를 넣어 두었어요)')))));
  }

  async function logTab(snap) {
    const box = h('div', { class: 'logbox' });
    let text = '';
    try { text = await window.api.readLog(snap.id); } catch (_) { text = (AM.state.logs.get(snap.id) || []).join('\n'); }
    box.textContent = text;
    cur.els.logbox = box;
    setTimeout(() => { box.scrollTop = box.scrollHeight; }, 0);
    return h('div', null, h('div', { class: 'row', style: { marginBottom: '8px' } },
      h('span', { class: 'muted small grow' }, '문제가 생기면 이 기록을 캡처해서 물어보세요. AI 프로그램 원본 출력은 작업 폴더의 work 폴더에 있어요.'),
      h('button', { class: 'btn small', onclick: () => window.api.openPath(AM.joinPath(snap.dir, 'work')) }, '📂 work 폴더')), box);
  }

  // ---------- 대화상자 ----------
  function redoDialog(snap) {
    const sel = h('select', null, AM.STEP_META.map((m, i) => h('option', { value: m.id }, `${i + 1}. ${m.label} 부터`)));
    sel.value = 'render';
    AM.modal('단계 다시 하기', h('div', null,
      h('p', null, '선택한 단계부터 다시 진행해요. 이미 그린 그림은 내용(프롬프트)이 같으면 그대로 써서 사용량을 아껴요.'),
      sel,
      h('ul', { class: 'small muted' },
        h('li', null, '노래·가사부터: 박자를 다시 분석해요 (노래를 바꾸려면 [노래·가사·컷] 탭의 [노래 바꾸기])'),
        h('li', null, '기획부터: 이번 에피소드 이야기를 새로 써요'),
        h('li', null, '컷 나누기부터: 컷 경계와 하이라이트를 다시 정해요'),
        h('li', null, '타임시트부터: 그림 장수·노출·카메라를 AI 가 다시 짜요'),
        h('li', null, '렌더링부터: 바뀐 컷만 다시 만들고 자막도 다시 입혀요 (무료)'),
        h('li', null, '자막부터: 자막만 다시 입혀요 (무료, 빠름)'))), [
      { label: '취소' },
      {
        label: '다시 하기', kind: 'primary',
        onClick: () => { window.api.runProject(snap.id, sel.value); },
      },
    ]);
  }

  function providersDialog(snap) {
    const sels = {};
    const rows = ['text', 'image'].map((k) => {
      sels[k] = h('select', null, AM.PROVIDERS[k].map((p) => h('option', { value: p.id }, p.label)));
      sels[k].value = snap.providers[k];
      return h('label', { class: 'field' }, ({ text: '기획·타임시트 (글쓰기)', image: '그림' })[k], sels[k]);
    });
    AM.modal('이 작업의 담당 AI', h('div', { class: 'col' }, h('p', { class: 'muted small' }, '이 작업에만 적용돼요. 기본값은 [AI 연결 설정] 에서 바꿔요.'), rows), [
      { label: '취소' },
      { label: '저장', kind: 'primary', onClick: () => AM.safe(() => window.api.setProviders(snap.id, Object.fromEntries(Object.entries(sels).map(([k, s]) => [k, s.value]))), '바꿨어요. [이어서 하기] 를 누르세요.') },
    ]);
  }
}(window.AM));
