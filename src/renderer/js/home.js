'use strict';
/* 새 에피소드 만들기 화면 + 처음 실행 안내 */
(function (AM) {
  const { h, toast } = AM;
  AM.views = AM.views || {};
  let selectedWf = null;
  let selectedSeries = null;
  // 다른 화면에 다녀와도 입력한 내용이 남도록
  const draft = { topic: '', songPath: '', songInfo: null, lyricsText: '', lyricsFilename: '' };
  const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'mp4', 'webm', 'mov', 'm4v'];
  const LYRIC_EXT = ['txt', 'lrc', 'srt'];

  function flowStrip(pv) {
    return h('div', { class: 'flow' }, AM.STEP_META.map((s, i) => {
      const who = s.who(pv);
      return h('div', { class: 'flow-step' },
        h('div', { class: 'n' }, s.icon),
        h('div', { class: 'l' }, `${i + 1}. ${s.label}`),
        h('div', { class: 'w' }, who.short),
        h('div', { style: { marginTop: '5px' } }, h('span', { class: `chip ${AM.MODE_CHIP[who.mode] || ''}` }, AM.MODE_LABEL[who.mode] || '자동')));
    }));
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

  function nextEpisode(s) {
    return Math.max(s.episodeCounter || 0, ...s.episodes.map((e) => e.number), 0) + 1;
  }

  AM.views.home = async function home(seriesArg) {
    const s = await AM.refreshSettings();
    const [wfs, seriesList] = await Promise.all([window.api.listWorkflows(), window.api.listSeries()]);
    AM.state.workflows = wfs;
    if (seriesArg) selectedSeries = seriesArg;
    if (!selectedSeries || !seriesList.find((x) => x.id === selectedSeries)) selectedSeries = seriesList[0] ? seriesList[0].id : null;
    const ser = () => seriesList.find((x) => x.id === selectedSeries) || null;
    if (seriesArg && ser() && ser().workflowId && wfs.find((w) => w.id === ser().workflowId)) selectedWf = ser().workflowId;
    if (!selectedWf || !wfs.find((w) => w.id === selectedWf)) selectedWf = wfs[0].id;
    const pv = s.providers;
    const allDemo = ['text', 'image'].every((k) => pv[k] === 'demo');
    const someDemo = ['text', 'image'].some((k) => pv[k] === 'demo');

    // ① 시리즈
    const serBox = h('div');
    const renderSeries = () => {
      AM.clear(serBox);
      if (!seriesList.length) {
        const demoBtn = h('button', {
          class: 'btn primary',
          onclick: async () => {
            demoBtn.disabled = true;
            demoBtn.textContent = '☔ 만드는 중…';
            const x = await AM.safe(() => window.api.createDemoSeries(), '체험용 주인공 "하루" 와 시리즈를 만들었어요.');
            if (x) AM.go('home', x.id); else { demoBtn.disabled = false; demoBtn.textContent = '☔ 체험용 시리즈 바로 만들기'; }
          },
        }, '☔ 체험용 시리즈 바로 만들기');
        serBox.appendChild(h('div', { class: 'notice info' },
          h('div', { style: { marginBottom: '8px' } }, '아직 시리즈가 없어요. 주인공 캐릭터를 만들어 잠근 뒤, 시리즈를 만들어 주세요.'),
          h('div', { class: 'row' },
            h('button', { class: 'btn', onclick: () => AM.go('characters') }, '🧒 캐릭터부터 만들기'),
            h('button', { class: 'btn', onclick: () => AM.go('series') }, '📺 시리즈 만들기'),
            demoBtn)));
        return;
      }
      serBox.appendChild(h('div', { class: 'wf-cards' },
        seriesList.map((x) => {
          const ready = x.characters.length && x.characters.every((c) => c.isLocked);
          return h('button', { class: `wf-card ser-card ${x.id === selectedSeries ? 'sel' : ''}`, onclick: () => { selectedSeries = x.id; if (x.workflowId && wfs.find((w) => w.id === x.workflowId)) { selectedWf = x.workflowId; renderCards(); } renderSeries(); } },
            x.characters[0] && x.characters[0].thumb ? h('img', { class: 'ser-thumb', src: AM.fileUrl(x.characters[0].thumb) }) : h('div', { class: 'ser-thumb ph' }, x.emoji),
            h('div', null,
              h('div', { class: 't' }, `${x.emoji} ${x.name}`),
              h('div', { class: 'd' }, `주인공 ${x.characters.map((c) => `${c.isLocked ? '🔒' : '✏️'}${c.name}`).join(', ') || '없음'}`),
              h('div', { class: 'tags' }, h('span', { class: 'chip pri' }, `다음: EP${nextEpisode(x)}`), h('span', { class: 'chip' }, `지난 이야기 ${x.episodes.length}편`),
                ready ? null : h('span', { class: 'chip warn' }, '캐릭터를 잠가 주세요'))));
        }),
        h('button', { class: 'wf-card', onclick: () => AM.go('series') }, h('div', { class: 't' }, '＋ 새 시리즈'), h('div', { class: 'd' }, '다른 주인공으로 새 이야기를 시작해요.'))));
      const cur = ser();
      if (cur && cur.episodes.length) {
        const last = cur.episodes[cur.episodes.length - 1];
        serBox.appendChild(h('div', { class: 'small muted', style: { marginTop: '8px' } }, `📚 지난 이야기 EP${last.number} "${last.title}": ${last.summary_ko}`));
      }
    };
    renderSeries();

    // ② 노래
    const songBox = h('div');
    const renderSong = () => {
      AM.clear(songBox);
      if (draft.songPath) {
        const name = draft.songPath.split(/[\\/]/).pop();
        songBox.appendChild(h('div', { class: 'notice ok row' },
          h('span', { class: 'grow' }, '🎵 ', h('b', null, name), draft.songInfo ? `  ·  ${AM.fmtSec(draft.songInfo.duration)} (${Math.floor(draft.songInfo.duration / 60)}분 ${Math.round(draft.songInfo.duration % 60)}초)` : ''),
          h('audio', { controls: true, src: AM.fileUrl(draft.songPath), preload: 'metadata', style: { height: '34px' } }),
          h('button', { class: 'btn small', onclick: pickSong }, '다시 고르기')));
        if (draft.songInfo && (draft.songInfo.duration < 120 || draft.songInfo.duration > 300)) {
          songBox.appendChild(h('div', { class: 'small muted' }, `ℹ 목표는 3~4분이에요. 이 노래 길이(${AM.fmtSec(draft.songInfo.duration)})에 맞춰 컷과 그림 장수를 정해요.`));
        }
      } else {
        const drop = h('div', { class: 'dropzone', style: { padding: '22px' } },
          h('div', { style: { fontSize: '15px', fontWeight: 700, marginBottom: '8px' } }, '여기에 노래 파일을 끌어다 놓거나'),
          h('button', { class: 'btn primary', onclick: pickSong }, '🎵 노래 파일 고르기'),
          h('div', { class: 'small', style: { marginTop: '8px' } }, 'Suno 에서 받은 mp3 / wav / m4a / mp4 모두 돼요.'));
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
    }
    async function pickSong() {
      const f = await window.api.pickFile({ filters: [{ name: '노래', extensions: AUDIO_EXT }] });
      if (f) setSong(f);
    }
    renderSong();

    // ③ 가사
    const lyrics = h('textarea', {
      rows: 9,
      placeholder: 'Suno 의 가사를 그대로 붙여넣으세요. [Verse 1], [Chorus] 같은 구간 표시도 그대로 두면, 후렴은 그림을 많이 써서 신나게 움직여요.\n\n예)\n[Verse 1]\n비가 내리던 그날 밤\n우산도 없이 걸었지\n\n[Chorus]\n너를 찾아 달려가',
      oninput: (e) => { draft.lyricsText = e.target.value; draft.lyricsFilename = ''; lyricInfo(); },
    });
    lyrics.value = draft.lyricsText;
    const lyricNote = h('div', { class: 'small muted' });
    const lyricInfo = () => {
      const t = draft.lyricsText.trim();
      const timed = /\[\d{1,3}:\d{2}/.test(t) || /-->/.test(t);
      const n = t ? t.split(/\r?\n/).filter((l) => l.trim() && !/^\s*\[[^\]]*\]\s*$/.test(l)).length : 0;
      lyricNote.textContent = !t ? '연주곡(가사 없음)이면 비워 두세요.'
        : timed ? `⏱ 시간이 들어 있는 가사예요 → 자막 싱크가 자동으로 맞아요. (${n}줄)`
          : `가사 ${n}줄 · 자막 시간은 나중에 [⌨ 탭으로 가사 맞추기] 로 정확히 맞출 수 있어요. 자막은 영상을 다 만든 뒤에 입혀서, 나중에 고쳐도 금방 다시 입혀요.`;
    };
    lyricInfo();
    const lyricBtn = h('button', {
      class: 'btn small',
      onclick: async () => {
        const f = await window.api.pickFile({ filters: [{ name: '가사', extensions: LYRIC_EXT }] });
        if (!f) return;
        const text = await AM.safe(() => window.api.readTextFile(f));
        if (text == null) return;
        lyrics.value = text;
        draft.lyricsText = text;
        draft.lyricsFilename = f.split(/[\\/]/).pop();
        lyricInfo();
      },
    }, '📄 가사 파일 불러오기 (.txt .lrc .srt)');
    dropTarget(lyrics, LYRIC_EXT, async (p, name) => {
      const text = await AM.safe(() => window.api.readTextFile(p));
      if (text == null) return;
      lyrics.value = text;
      draft.lyricsText = text;
      draft.lyricsFilename = name;
      lyricInfo();
    });

    // ④ 이번 이야기
    const topic = h('textarea', {
      rows: 3,
      placeholder: '(선택) 이번 에피소드에서 무슨 일이 생길지 적어 주세요. 비워 두면 가사와 지난 이야기를 보고 AI 가 정해요.\n예) 하루가 비 오는 밤, 길 잃은 반딧불 요정을 집에 데려다주는 이야기',
      oninput: (e) => { draft.topic = e.target.value; },
    });
    topic.value = draft.topic;
    const sugBox = h('div', { class: 'row', style: { marginTop: '10px', gap: '6px' } });
    const sugBtn = h('button', {
      class: 'btn small',
      onclick: async () => {
        sugBtn.disabled = true;
        sugBtn.textContent = '🎲 생각하는 중…';
        const seed = [topic.value.trim(), draft.lyricsText.slice(0, 800)].filter(Boolean).join('\n');
        const list = await AM.safe(() => window.api.suggestTopics(seed, selectedSeries));
        sugBtn.disabled = false;
        sugBtn.textContent = '🎲 이야기 추천받기';
        if (!list) return;
        AM.clear(sugBox);
        list.forEach((t) => sugBox.appendChild(h('span', { class: 'chip click', onclick: () => { topic.value = t; draft.topic = t; } }, t)));
      },
    }, '🎲 이야기 추천받기');

    // ⑤ 워크플로우
    const cards = h('div', { class: 'wf-cards' });
    const renderCards = () => {
      AM.clear(cards);
      wfs.forEach((w) => cards.appendChild(h('button', {
        class: `wf-card ${w.id === selectedWf ? 'sel' : ''}`,
        onclick: () => { selectedWf = w.id; renderCards(); },
      },
      h('div', { class: 't' }, `${w.emoji || '🎞️'} ${w.name}`),
      h('div', { class: 'd' }, w.description || ''),
      h('div', { class: 'tags' },
        h('span', { class: 'chip' }, w.aspect),
        h('span', { class: 'chip' }, `컷 ${w.minClips}~${w.maxClips}개`),
        h('span', { class: 'chip' }, w.drawingBudget > 0 ? `그림 최대 ${w.drawingBudget}장` : '그림 장수 자동'),
        w.builtin ? null : h('span', { class: 'chip pri' }, '내 워크플로우')))));
    };
    renderCards();

    const start = async () => {
      const cur = ser();
      if (!cur) { toast('먼저 시리즈를 골라 주세요. (없으면 [☔ 체험용 시리즈 바로 만들기])', 'err'); return; }
      if (!(cur.characters.length && cur.characters.every((c) => c.isLocked))) { toast('이 시리즈의 캐릭터를 먼저 🔒 잠가 주세요.', 'err'); AM.go('series', cur.id); return; }
      if (!draft.songPath && !allDemo) { toast('먼저 노래 파일을 올려 주세요.', 'err'); return; }
      if (!draft.songPath && allDemo) {
        const ok = await AM.confirmBox('체험 모드로 만들까요?', '노래 파일이 없고 모든 단계가 체험 모드예요.\n예시 노래와 가짜 그림으로 전체 흐름만 보여 드려요. (무료, 2~4분)\n\n실제 에피소드를 만들려면 노래를 올리고 [AI 연결 설정] 에서 구독을 연결하세요.', '체험으로 시작');
        if (!ok) return;
      } else if (allDemo) {
        const ok = await AM.confirmBox('체험 모드로 만들까요?', '모든 AI 단계가 체험 모드예요. 올린 노래에 맞춰 컷·타임시트·자막은 실제처럼 만들지만, 그림은 가짜예요. (무료)', '체험으로 시작');
        if (!ok) return;
      }
      const p = await AM.safe(() => window.api.createProject({
        topic: draft.topic.trim(), seriesId: cur.id, workflowId: selectedWf,
        songPath: draft.songPath || null, lyricsText: draft.lyricsText, lyricsFilename: draft.lyricsFilename,
      }));
      if (p) {
        Object.assign(draft, { topic: '', songPath: '', songInfo: null, lyricsText: '', lyricsFilename: '' });
        AM.state.projects.set(p.id, p);
        AM.go('project', p.id);
      }
    };
    const cur = ser();

    return h('div', null,
      h('div', { class: 'hero' },
        h('h1', null, '손그림 애니메이션 뮤직비디오를 만들어 볼까요? 🎨'),
        h('p', null, '옛날 손그림 애니메이션처럼 그림을 한 장씩 넘겨서 움직여요. 주인공은 캐릭터 파일로 꽉 고정해서, 에피소드가 이어져도 늘 같은 모습이에요. 노래와 가사만 올리면 이야기 → 컷 → 타임시트 → 그림 → 렌더링 → 자막까지 차례로 만들어요.')),
      allDemo ? h('div', { class: 'notice warn' }, '💡 지금은 ', h('b', null, '체험 모드'), '예요. 진짜 그림을 그리려면 ',
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); AM.go('settings'); } }, 'AI 연결 설정'), '에서 구독 중인 서비스를 연결해 주세요.') : null,
      !allDemo && someDemo ? h('div', { class: 'notice info' }, 'ℹ 일부 단계가 체험 모드로 설정되어 있어요. (AI 연결 설정에서 바꿀 수 있어요)') : null,
      h('div', { class: 'section' },
        h('h3', null, '① 시리즈 고르기 (주인공이 정해져 있어요)'),
        h('p', { class: 'desc' }, '같은 시리즈의 에피소드는 같은 주인공, 같은 그림체로 이어져요. AI 는 지난 이야기를 읽고 다음 이야기를 써요.'),
        serBox),
      h('div', { class: 'section' },
        h('h3', null, '② 노래 올리기'),
        h('p', { class: 'desc' }, '영상 길이 = 노래 길이예요. 3~4분 노래면 3~4분 뮤직비디오가 나와요.'),
        songBox),
      h('div', { class: 'section' },
        h('div', { class: 'row' },
          h('div', { class: 'grow' }, h('h3', null, '③ 가사'), h('p', { class: 'desc' }, '이야기를 짤 때 쓰고, 영상이 다 만들어진 뒤에 화면 아래 자막으로 입혀요.')),
          lyricBtn),
        lyrics, lyricNote),
      h('div', { class: 'section topic-box' },
        h('h3', null, `④ 이번 에피소드 이야기 (선택)${cur ? ` — ${cur.name} EP${nextEpisode(cur)}` : ''}`),
        topic,
        h('div', { class: 'row', style: { marginTop: '10px' } }, sugBtn, h('span', { class: 'small muted' }, '가사와 지난 이야기에 어울리는 이야기를 추천해 줘요.')),
        sugBox),
      h('div', { class: 'section' },
        h('div', { class: 'row' },
          h('div', { class: 'grow' }, h('h3', null, '⑤ 워크플로우 (화면 틀)'), h('p', { class: 'desc' }, '화면 비율, 컷 수, 그림 장수 예산, 손그림 필름 느낌, 자막 모양 같은 규칙 묶음이에요.')),
          h('button', { class: 'btn small', onclick: () => AM.go('workflows') }, '🧩 워크플로우 만들기/수정')),
        cards),
      h('div', { class: 'section' },
        h('div', { class: 'row' },
          h('div', { class: 'grow' }, h('h3', null, '⑥ 이렇게 만들어져요'), h('p', { class: 'desc' }, '각 단계를 누가 하는지 보여 줘요. 렌더링과 자막은 내 PC 가 무료로 해요. (프로그램 안에 다 들어 있어요)')),
          h('button', { class: 'btn small', onclick: () => AM.go('settings') }, '🔌 담당 AI 바꾸기')),
        flowStrip(pv)),
      h('div', { style: { textAlign: 'center', margin: '26px 0' } },
        h('button', { class: 'btn primary big', onclick: start }, cur ? `▶ ${cur.name} EP${nextEpisode(cur)} 만들기 시작` : '▶ 에피소드 만들기 시작'),
        h('div', { class: 'small muted', style: { marginTop: '8px' } }, '만드는 중에 다른 화면으로 가도 계속 진행돼요. 도움이 필요하면 알려 드릴게요.')));
  };

  AM.views.welcome = function welcome() {
    const done = async () => { await window.api.saveSettings({ firstRunDone: true }); await AM.refreshSettings(); };
    AM.modal('AnimeMaker V2 에 오신 걸 환영해요! 👋', h('div', null,
      h('p', null, '이 프로그램은 ', h('b', null, '노래와 가사'), '로 옛날 손그림 애니메이션 같은 뮤직비디오를 만들어요. 주인공은 ', h('b', null, '캐릭터 파일'), '로 고정해서 에피소드처럼 계속 이어 만들 수 있어요.'),
      h('ol', null,
        h('li', null, h('b', null, '구독 중인 AI 를 연결'), '해요. (ChatGPT, SuperGrok, Google AI(Gemini), Claude 중 가진 것)'),
        h('li', null, h('b', null, '주인공 캐릭터'), '를 만들고 기준 그림을 넣은 뒤 🔒 잠가요.'),
        h('li', null, h('b', null, '시리즈'), '를 만들고, 노래와 가사를 올려 에피소드를 시작해요.')),
      h('div', { class: 'notice ok' }, '🔒 API 키(종량제 과금)는 쓰지 않아요. 이미 내고 있는 구독 요금 한도 안에서만 동작합니다.'),
      h('p', { class: 'muted small' }, '처음이라면 [체험 모드로 먼저 구경하기] 를 눌러 보세요. 체험용 주인공 "하루" 와 시리즈를 바로 만들어 줘요. 돈도 사용량도 들지 않아요.'),
      h('p', { class: 'muted small' }, 'AnimeMaker V1 과 따로 설치되고, 작업 폴더도 따로(문서\\AnimeMaker V2) 써요.')),
    [
      {
        label: '체험 모드로 먼저 구경하기',
        onClick: async () => {
          await done();
          const list = await window.api.listSeries();
          const x = list[0] || await AM.safe(() => window.api.createDemoSeries());
          AM.go('home', x ? x.id : null);
        },
      },
      { label: '내 구독 연결하러 가기', kind: 'primary', onClick: async () => { await done(); AM.go('settings'); } },
    ], { sticky: true });
  };
}(window.AM));
