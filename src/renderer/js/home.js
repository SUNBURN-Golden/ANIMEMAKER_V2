'use strict';
/* 🎬 만들기 화면 + 처음 실행 환영 창
 *  주인공이 없으면 '먼저 주인공을 만들어요' 카드 → 있으면 노래 · 가사 · 이야기 3칸과 아래 고정 바([바꾸기] · [▶ 만들기])
 */
(function (AM) {
  const { h, toast } = AM;
  AM.views = AM.views || {};

  // 다른 화면에 다녀와도 입력한 내용이 남도록
  const draft = { topic: '', songPath: '', songInfo: null, lyricsText: '', lyricsFilename: '' };
  // 이번 영상 설정 ([바꾸기] 시트): 주인공(시리즈) · 영상 모양 · 움직임 · (고급) 영상 규칙
  const pick = { seriesId: null, shape: null, motion: null, wfId: null };
  const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'mp4', 'webm', 'mov', 'm4v'];
  const LYRIC_EXT = ['txt', 'lrc', 'srt'];

  // 영상 모양 → 기본 영상 규칙(워크플로우) + 화면 비율. 네모는 가로 규칙에 비율만 1:1 로 덮는다.
  const SHAPES = {
    wide: { title: '가로', desc: '유튜브처럼 옆으로 긴 영상', wf: 'builtin-cel-wide', aspect: '16:9' },
    tall: { title: '세로', desc: '쇼츠 · 릴스 · 틱톡', wf: 'builtin-cel-vertical', aspect: '9:16' },
    square: { title: '네모', desc: '인스타그램 같은 정사각', wf: 'builtin-cel-wide', aspect: '1:1' },
  };
  const MOTIONS = {
    ghibli: { emoji: '🌿', title: '신나는 부분만 움직여요', tag: '추천', desc: '노래의 신나는 부분만 부드럽게 움직여요.' },
    limited: { emoji: '🖼', title: '조금만 움직여요', tag: '빨리 끝나요', desc: '그림을 적게 그려서 빨리 끝나요.' },
    full: { emoji: '🏃', title: '계속 움직여요', tag: '오래 걸려요', desc: '모든 장면이 움직여요. 그림이 아주 많이 필요해요.' },
  };

  /** 가사 줄 수 (태그·시간표시·♪ 만 있는 줄은 빼고 센다) — lyrics.js 의 countLyricLines 가 생기기 전까지 쓰는 작은 함수 */
  function countLyricLines(text) {
    const raw = String(text || '');
    const srt = /-->/.test(raw);
    return raw.split(/\r?\n/).map((l) => l
      .replace(/\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/g, '')
      .replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, '').trim())
      .filter((l) => l && !/^\[[^\]]*\]$/.test(l) && !/^\([^)]*\)$/.test(l) && !/^[♪♫♬\s]+$/.test(l) && !/^[x×]\s*\d+$/i.test(l)
        && !(srt && (/^\d+$/.test(l) || /-->/.test(l)))).length;
  }

  function dropTarget(el, exts, onFile) {
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
    el.addEventListener('dragleave', () => el.classList.remove('over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('over');
      const f = e.dataTransfer.files[0];
      if (!f) return;
      const ext = f.name.split('.').pop().toLowerCase();
      if (!exts.includes(ext)) { toast(`이 파일 형식(.${ext})은 쓸 수 없어요.`, 'err'); return; }
      onFile(window.api.pathForFile(f), f.name);
    });
  }

  /** 영상 모양 그림 (네모 안에 비율대로 그린 작은 화면) */
  function shapeVisual(kind) {
    return h('span', { class: `shape-vis ${kind}` }, h('i'));
  }

  function numCard(num, emoji, title, tag, ...kids) {
    return h('section', { class: 'mk-card' },
      h('div', { class: 'mk-card-head row' },
        h('span', { class: 'mk-num' }, String(num)),
        h('h2', { class: 'grow' }, `${emoji} ${title}`),
        tag ? h('span', { class: `mk-tag ${tag.kind || ''}` }, tag.text) : null),
      ...kids);
  }

  const imgUrlOfSeries = (s) => {
    const t = s && s.characters && s.characters[0] && s.characters[0].thumb;
    return t ? AM.fileUrl(t) : null;
  };

  /** 에피소드(영상) 만들기 시작 → 프로젝트 화면. 실패하면 null */
  async function launch(seriesId, o = {}) {
    const shape = o.shape || pick.shape || 'wide';
    const motion = o.motion || pick.motion || 'ghibli';
    const wfId = o.wfId !== undefined ? o.wfId : pick.wfId;
    const useShape = !wfId;
    const p = await AM.safe(() => window.api.createProject({
      topic: (o.topic != null ? o.topic : draft.topic).trim(),
      seriesId,
      workflowId: wfId || SHAPES[shape].wf,
      // 영상 모양 → aspect, 움직임 → motionMode (백엔드가 아직 모르면 무시돼요)
      workflowOverrides: useShape ? { aspect: SHAPES[shape].aspect, motionMode: motion } : {},
      songPath: o.songPath !== undefined ? o.songPath : (draft.songPath || null),
      lyricsText: o.lyricsText !== undefined ? o.lyricsText : draft.lyricsText,
      lyricsFilename: o.lyricsFilename !== undefined ? o.lyricsFilename : draft.lyricsFilename,
    }));
    if (!p) return null;
    if (!o.keepDraft) Object.assign(draft, { topic: '', songPath: '', songInfo: null, lyricsText: '', lyricsFilename: '' });
    AM.state.projects.set(p.id, p);
    return p;
  }

  AM.views.home = async function home(seriesArg) {
    const s = await AM.refreshSettings();
    const demoNow = AM.isAllDemo(s);
    let [wfs, seriesList, chars, projects] = await Promise.all([
      window.api.listWorkflows(), window.api.listSeries(), window.api.listCharacters(),
      demoNow ? window.api.listProjects() : Promise.resolve([]), // 목록은 '연습 영상을 구경했나요?' 안내에만 쓴다
    ]);
    seriesList = await AM.hero.ensureSeriesForLocked(chars, seriesList);
    AM.state.workflows = wfs;
    const allDemo = demoNow;
    const ux = s.ux || {};
    const ready = () => AM.hero.readySeries(seriesList);

    // ---- 이번 영상 설정 기본값 ----
    if (!pick.shape) pick.shape = SHAPES[ux.shape] ? ux.shape : 'wide';
    if (!pick.motion) pick.motion = MOTIONS[ux.motion] ? ux.motion : 'ghibli';
    const applySeriesDefault = (ser) => {
      // 시리즈에 기본 영상 규칙이 정해져 있으면 따른다 (옛 시리즈 호환)
      pick.wfId = null;
      const wf = ser && ser.workflowId ? wfs.find((w) => w.id === ser.workflowId) : null;
      if (!wf) return;
      if (wf.id === 'builtin-cel-wide') pick.shape = 'wide';
      else if (wf.id === 'builtin-cel-vertical') pick.shape = 'tall';
      else pick.wfId = wf.id;
    };
    if (seriesArg && ready().find((x) => x.id === seriesArg)) {
      pick.seriesId = seriesArg;
      applySeriesDefault(ready().find((x) => x.id === seriesArg));
    }
    if (!pick.seriesId || !ready().find((x) => x.id === pick.seriesId)) pick.seriesId = ready()[0] ? ready()[0].id : null;
    if (pick.wfId && !wfs.find((w) => w.id === pick.wfId)) pick.wfId = null;
    const ser = () => ready().find((x) => x.id === pick.seriesId) || null;
    const saveUx = () => window.api.saveSettings({ ux: { shape: pick.shape, motion: pick.motion } }).catch(() => {});

    // ---- 맨 위: 제목 · 연습 모드 안내 ----
    const hasDone = projects.some((p) => p.status === 'done');
    const pv = s.providers;
    const goSettings = (e) => { if (e) e.preventDefault(); AM.go('settings'); };
    let banner = null;
    if (allDemo && hasDone) {
      banner = h('div', { class: 'mk-invite' },
        h('div', { class: 'grow' },
          h('div', { class: 'mk-invite-t' }, '🎉 연습 영상을 구경했나요?'),
          h('div', { class: 'mk-invite-d' }, '진짜 그림으로 만들어 볼까요? 가지고 있는 구독을 연결하면 돼요.')),
        h('button', { class: 'btn primary', onclick: goSettings }, '🔌 내 AI 연결하기'));
    } else if (allDemo) {
      banner = h('div', { class: 'mk-banner' }, h('span', { class: 'grow' }, '🧪 지금은 ', h('b', null, '연습 모드'), '예요 — 가짜 그림으로 흐름만 보여 줘요.'),
        h('button', { class: 'btn small', onclick: goSettings }, '🔌 내 AI 연결하기'));
    } else if (pv.image === 'demo') {
      banner = h('div', { class: 'mk-banner' }, h('span', { class: 'grow' }, '🧪 이야기는 AI 가 쓰지만 그림은 아직 ', h('b', null, '연습(가짜) 그림'), '이에요.'),
        h('button', { class: 'btn small', onclick: goSettings }, '🔌 그림 AI 연결하기'));
    } else if (pv.text === 'demo') {
      banner = h('div', { class: 'mk-banner' }, h('span', { class: 'grow' }, '🧪 그림은 AI 가 그리지만 이야기는 아직 ', h('b', null, '연습(예시) 이야기'), '예요.'),
        h('button', { class: 'btn small', onclick: goSettings }, '🔌 설정 열기'));
    }

    // ---- 주인공이 없으면: 먼저 주인공 만들기 ----
    let heroZone = null;
    if (!ready().length) {
      heroZone = AM.hero.makerCard({
        chars, seriesList, allDemo,
        onReady: (id) => AM.go('home', id),
        onPractice: async () => {
          const x = await AM.safe(() => window.api.createDemoSeries());
          if (!x) return;
          pick.seriesId = x.id;
          if (allDemo) {
            toast('☔ 연습용 주인공으로 연습 영상을 시작해요.', 'ok');
            const p = await launch(x.id, { wfId: null });
            if (p) { AM.go('project', p.id); return; }
          }
          AM.go('home', x.id);
        },
      });
    }

    // ---- ① 노래 ----
    const songBox = h('div');
    const renderSong = () => {
      AM.clear(songBox);
      if (draft.songPath) {
        const name = draft.songPath.split(/[\\/]/).pop();
        const info = draft.songInfo;
        songBox.appendChild(h('div', { class: 'song-ok' },
          h('div', { class: 'song-ico' }, '🎵'),
          h('div', { class: 'song-meta grow' }, h('div', { class: 'song-name' }, name), h('div', { class: 'small muted' }, info ? `길이 ${AM.fmtDur(info.duration)}` : '')),
          h('audio', { controls: true, src: AM.fileUrl(draft.songPath), preload: 'metadata' }),
          h('button', { class: 'btn small', onclick: pickSong }, '다시 고르기')));
        if (info && (info.duration < 120 || info.duration > 300)) {
          songBox.appendChild(h('div', { class: 'small muted', style: { marginTop: '10px' } }, `ℹ 3~4분 노래가 가장 잘 어울려요. 이 노래는 ${AM.fmtDur(info.duration)}라서 그에 맞춰 장면 수를 정해요.`));
        }
      } else {
        const drop = h('div', { class: 'dropzone mk-drop' },
          h('div', { class: 'mk-drop-ico' }, '🎵'),
          h('div', { class: 'mk-drop-t' }, '여기에 노래 파일을 끌어다 놓아요'),
          h('button', { class: 'btn primary', onclick: pickSong }, '🎵 노래 고르기'),
          h('div', { class: 'small muted' }, 'mp3 · wav · m4a 같은 노래 파일이면 돼요. Suno 에서 받은 것도 좋아요.'));
        dropTarget(drop, AUDIO_EXT, (p) => setSong(p));
        songBox.appendChild(drop);
      }
    };
    async function setSong(p) {
      const info = await AM.safe(() => window.api.probeMedia(p));
      if (!info) return;
      draft.songPath = p;
      draft.songInfo = info;
      renderSong();
      refreshBar();
    }
    async function pickSong() {
      const f = await window.api.pickFile({ filters: [{ name: '노래', extensions: AUDIO_EXT }] });
      if (f) setSong(f);
    }
    renderSong();

    // ---- ② 가사 ----
    const lyrics = h('textarea', {
      rows: 8, class: 'mk-lyrics', 'aria-label': '가사',
      placeholder: '가사를 여기에 붙여 넣어요.\n[Verse 1], [Chorus] 같은 표시도 그대로 두면 돼요.\n\n예)\n[Verse 1]\n비가 내리던 그날 밤\n우산도 없이 걸었지\n\n[Chorus]\n너를 찾아 달려가',
      oninput: (e) => { draft.lyricsText = e.target.value; draft.lyricsFilename = ''; lyricInfo(); },
    });
    lyrics.value = draft.lyricsText;
    const lyricNote = h('div', { class: 'small muted mk-note' });
    function lyricInfo() {
      const t = draft.lyricsText.trim();
      const timed = /\[\d{1,3}:\d{2}/.test(t) || /-->/.test(t);
      const n = countLyricLines(t);
      lyricNote.textContent = !t ? '가사가 없어도 돼요. 노래만으로 만들어요.'
        : timed ? `⏱ 시간이 들어 있어요 — 자막 시간이 자동으로 맞아요. (${n}줄)`
          : `가사 ${n}줄 · 시간은 영상이 만들어진 뒤에도 고칠 수 있어요.`;
    }
    lyricInfo();
    const setLyrics = (text, filename) => { lyrics.value = text; draft.lyricsText = text; draft.lyricsFilename = filename || ''; lyricInfo(); };
    const lyricBtn = h('button', {
      class: 'btn small',
      onclick: async () => {
        const f = await window.api.pickFile({ filters: [{ name: '가사', extensions: LYRIC_EXT }] });
        if (!f) return;
        const text = await AM.safe(() => window.api.readTextFile(f));
        if (text != null) setLyrics(text, f.split(/[\\/]/).pop());
      },
    }, '📄 가사 파일 불러오기');
    dropTarget(lyrics, LYRIC_EXT, async (p, name) => {
      const text = await AM.safe(() => window.api.readTextFile(p));
      if (text != null) setLyrics(text, name);
    });

    // ---- ③ 이야기 ----
    const topic = h('textarea', {
      rows: 3, class: 'mk-topic', 'aria-label': '이야기',
      placeholder: '예) 하루가 비 오는 밤, 길 잃은 반딧불 요정을 집에 데려다줘요',
      oninput: (e) => { draft.topic = e.target.value; },
    });
    topic.value = draft.topic;
    const sugBox = h('div', { class: 'mk-sug' });
    const sugBtn = h('button', {
      class: 'btn small',
      onclick: async () => {
        sugBtn.disabled = true;
        sugBtn.textContent = '🎲 생각하는 중…';
        const seed = [topic.value.trim(), draft.lyricsText.slice(0, 800)].filter(Boolean).join('\n');
        const list = await AM.safe(() => window.api.suggestTopics(seed, pick.seriesId));
        sugBtn.disabled = false;
        sugBtn.textContent = '🎲 이야기 추천받기';
        if (!list) return;
        AM.clear(sugBox);
        list.forEach((t) => sugBox.appendChild(h('button', { class: 'chip click mk-chip', onclick: () => { topic.value = t; draft.topic = t; } }, t)));
      },
    }, '🎲 이야기 추천받기');

    // ---- 아래 고정 바 ----
    const sumEl = h('div', { class: 'bar-sum' });
    const reasonEl = h('span', { class: 'bar-reason' });
    const noteEl = h('div', { class: 'bar-note' });
    const startBtn = h('button', { class: 'btn primary xl', onclick: () => start() }, '▶ 만들기');
    const changeBtn = h('button', { class: 'btn', onclick: () => openSheet() }, '바꾸기');
    const bar = AM.kit.stickyBar([
      h('div', { class: 'bar-main grow' }, h('div', { class: 'bar-label' }, '이렇게 만들어요'), sumEl),
      changeBtn,
      h('div', { class: 'bar-go' }, h('div', { class: 'bar-go-row' }, reasonEl, startBtn), noteEl),
    ]);

    function summaryText() {
      const cur = ser();
      const wf = pick.wfId ? wfs.find((w) => w.id === pick.wfId) : null;
      return [
        cur ? `주인공 🔒${AM.niceTitle(cur.characters[0].name)}` : '주인공이 아직 없어요',
        wf ? `영상 규칙 ${wf.name}` : AM.SHAPE_LABEL[pick.shape],
        wf ? null : AM.MOTION_LABEL[pick.motion],
        `그림은 ${AM.imageWho(AM.state.settings)}`,
      ].filter(Boolean).join(' · ');
    }
    function refreshBar() {
      sumEl.textContent = summaryText();
      let reason = '';
      if (!ser()) reason = '먼저 주인공을 정해 주세요';
      else if (!draft.songPath && !allDemo) reason = '먼저 노래를 골라 주세요';
      reasonEl.textContent = reason ? `👆 ${reason}` : '';
      startBtn.disabled = !!reason;
      noteEl.textContent = allDemo && !reason ? '연습 모드: 가짜 그림 · 무료 · 2~4분' : '';
    }

    let starting = false;
    async function start() {
      const cur = ser();
      if (!cur || starting) return;
      starting = true;
      startBtn.disabled = true;
      startBtn.textContent = '만드는 중…';
      const p = await launch(cur.id);
      starting = false;
      if (p) { AM.go('project', p.id); return; }
      startBtn.textContent = '▶ 만들기';
      refreshBar();
    }

    // ---- [바꾸기] 시트: 주인공 · 영상 모양 · 움직임 · 그림 AI ----
    function openSheet() {
      const box = h('div', { class: 'sheet-body' });
      const render = () => {
        AM.clear(box);
        const list = ready();
        if (list.length > 1) {
          box.appendChild(h('div', { class: 'sheet-sec' },
            h('h3', null, '🧒 주인공'),
            h('div', { class: 'card-grid hero-pick' }, list.map((x) => AM.kit.pickCard({
              visual: imgUrlOfSeries(x) ? h('img', { class: 'hp-img', src: imgUrlOfSeries(x), alt: '' }) : h('span', { class: 'cp-emoji' }, '🧒'),
              title: AM.niceTitle(x.characters[0].name), desc: `${AM.niceTitle(x.name)} · 지난 이야기 ${x.episodes.length}편`, selected: x.id === pick.seriesId,
              onclick: () => { pick.seriesId = x.id; applySeriesDefault(x); render(); refreshBar(); },
            }))),
            h('div', { style: { marginTop: '8px' } }, h('button', { class: 'btn small ghost', onclick: () => { m.close(); AM.go('hero', 'new'); } }, '＋ 새 주인공 만들기'))));
        }
        const custom = !!pick.wfId;
        box.appendChild(h('div', { class: 'sheet-sec' },
          h('h3', null, '📐 영상 모양'),
          h('div', { class: 'card-grid c3' }, Object.entries(SHAPES).map(([k, v]) => AM.kit.pickCard({
            visual: shapeVisual(k), title: v.title, desc: v.desc, selected: !custom && pick.shape === k, disabled: custom,
            onclick: () => { pick.shape = k; saveUx(); render(); refreshBar(); },
          })))));
        box.appendChild(h('div', { class: 'sheet-sec' },
          h('h3', null, '🏃 움직임'),
          h('div', { class: 'card-grid c3' }, Object.entries(MOTIONS).map(([k, v]) => AM.kit.pickCard({
            emoji: v.emoji, title: v.title, tag: v.tag, desc: v.desc, selected: !custom && pick.motion === k, disabled: custom,
            onclick: () => { pick.motion = k; saveUx(); render(); refreshBar(); },
          }))),
          custom ? h('div', { class: 'small muted', style: { marginTop: '8px' } }, '아래에서 고른 영상 규칙대로 만들어요.') : null));
        const pvNow = AM.state.settings.providers;
        const textWho = AM.providerInfo('text', pvNow.text);
        box.appendChild(h('div', { class: 'sheet-sec' },
          h('h3', null, '🤖 누가 만들까요?'),
          h('div', { class: 'row sheet-who' },
            h('div', { class: 'grow col', style: { gap: '2px' } },
              h('div', null, '📝 이야기 ', h('b', { class: 'sheet-who-t' }, textWho.mode === 'demo' ? '연습(예시 이야기)' : textWho.short)),
              h('div', null, '🎨 그림 ', h('b', { class: 'sheet-who-t' }, AM.imageWho(AM.state.settings)))),
            h('button', { class: 'btn small', onclick: () => { m.close(); AM.go('settings'); } }, '🔌 설정에서 바꾸기'))));
        const sel = h('select', null, h('option', { value: '' }, '(위에서 고른 모양과 움직임대로)'), wfs.map((w) => h('option', { value: w.id }, `${w.emoji || '🎞️'} ${w.name}`)));
        sel.value = pick.wfId || '';
        sel.addEventListener('change', () => { pick.wfId = sel.value || null; render(); refreshBar(); });
        box.appendChild(AM.kit.fold('🔧 고급', h('div', { class: 'col' },
          h('label', { class: 'field' }, '🧩 영상 규칙 직접 고르기', sel,
            h('span', { class: 'hint' }, '장면 수, 그림 수 같은 규칙 묶음이에요. 설정 › 고급 › 영상 규칙에서도 열 수 있어요.')),
          h('div', null, h('button', { class: 'btn small', onclick: () => { m.close(); AM.go('workflows'); } }, '🧩 영상 규칙 만들기 · 고치기')))));
      };
      render();
      const m = AM.kit.sheet('🎞 영상 설정', box, [{ label: '다 됐어요', kind: 'primary' }], { onClose: refreshBar, width: 'min(760px, 94vw)' });
    }

    refreshBar();

    // 시험·자동화용 손잡이: 노래·가사를 코드로 넣을 수 있다
    AM.home = { draft, setSong, setLyrics, pick, launch };

    return h('div', { class: 'mk-wrap page-has-bar' },
      h('h1', { class: 'mk-title' }, '🎬 어떤 노래로 영상을 만들까요?'),
      banner,
      heroZone,
      numCard(1, '🎵', '노래', { text: allDemo ? '없어도 돼요 (연습)' : '꼭 필요해요', kind: allDemo ? '' : 'must' }, songBox),
      numCard(2, '📝', '가사', { text: '선택' },
        h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '10px' } }, h('span', { class: 'mk-hint', style: { margin: 0 } }, '노래 가사를 붙여 넣으면 영상에 자막으로 들어가요.'), lyricBtn),
        lyrics, lyricNote),
      numCard(3, '💡', '이야기', { text: '선택' },
        h('p', { class: 'mk-hint' }, '비워 두면 가사를 보고 AI 가 알아서 정해요.'),
        topic,
        h('div', { class: 'row', style: { marginTop: '10px' } }, sugBtn),
        sugBox),
      bar);
  };

  // =====================================================================
  //  처음 실행 환영 창
  // =====================================================================
  AM.views.welcome = function welcome() {
    const done = async () => { await window.api.saveSettings({ firstRunDone: true }); await AM.refreshSettings(); };
    let m = null;
    const tourBtn = h('button', { class: 'btn primary xl wel-btn' },
      h('span', { class: 'wel-t' }, '🎬 먼저 구경하기 (무료 · 2분)'),
      h('span', { class: 'wel-d' }, '가짜 그림으로 영상이 만들어지는 걸 보여 줘요.'));
    const connBtn = h('button', { class: 'btn xl wel-btn' },
      h('span', { class: 'wel-t' }, '🔌 내 AI 연결하기'),
      h('span', { class: 'wel-d' }, 'ChatGPT 같은 구독이 있으면 진짜 그림으로 만들어요.'));
    const setBusy = (t) => { tourBtn.disabled = true; connBtn.disabled = true; tourBtn.querySelector('.wel-t').textContent = t; };

    tourBtn.addEventListener('click', async () => {
      setBusy('☔ 연습용 주인공을 만드는 중…');
      try {
        await done();
        const [list, chars] = await Promise.all([window.api.listSeries(), window.api.listCharacters()]);
        const series = await AM.hero.ensureSeriesForLocked(chars, list);
        let ser = AM.hero.readySeries(series)[0] || null;
        if (!ser) ser = await window.api.createDemoSeries();
        if (!AM.isAllDemo(AM.state.settings)) { m.close(); AM.go('home', ser.id); return; }
        tourBtn.querySelector('.wel-t').textContent = '🎬 연습 영상을 시작하는 중…';
        const p = await launch(ser.id, { wfId: null, shape: 'wide', motion: 'ghibli', topic: '', songPath: null, lyricsText: '', lyricsFilename: '', keepDraft: true });
        m.close();
        if (p) AM.go('project', p.id); else AM.go('home', ser.id);
      } catch (e) {
        toast(e.message || String(e), 'err');
        tourBtn.disabled = false;
        connBtn.disabled = false;
        tourBtn.querySelector('.wel-t').textContent = '🎬 먼저 구경하기 (무료 · 2분)';
      }
    });
    connBtn.addEventListener('click', async () => { await done(); m.close(); AM.go('settings'); });

    m = AM.modal('AnimeMaker V2 에 오신 걸 환영해요! 👋', h('div', { class: 'wel' },
      h('p', { class: 'wel-p' }, '노래와 가사로 손그림 애니 뮤직비디오를 만들어요.', h('br'), '처음이라면 먼저 구경해 보세요. 돈도 사용량도 들지 않아요.'),
      h('div', { class: 'wel-btns' }, tourBtn, connBtn)), [], { sticky: true, width: 'min(560px, 94vw)' });
    m.box.classList.add('welcome');
  };
}(window.AM));
