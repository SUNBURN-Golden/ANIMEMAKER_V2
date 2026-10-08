'use strict';
/* 이야기 모음(시리즈) 화면 — 주인공 화면의 '고급' 에서 들어온다: 고정 주인공 + 그림 느낌 약속 + 지난 이야기 기록 */
(function (AM) {
  const { h } = AM;
  AM.views = AM.views || {};
  let selected = null;

  AM.views.series = async function series(arg) {
    const [list, chars] = await Promise.all([window.api.listSeries(), window.api.listCharacters()]);
    AM.state.workflows = await window.api.listWorkflows();
    if (arg) selected = arg;
    if (!selected || !list.find((s) => s.id === selected)) selected = list[0] ? list[0].id : null;
    const cur = list.find((s) => s.id === selected);
    const demoBtn = h('button', {
      class: 'btn',
      onclick: async () => {
        demoBtn.disabled = true;
        demoBtn.textContent = '☔ 만드는 중…';
        const s = await AM.safe(() => window.api.createDemoSeries(), '연습용 주인공 "하루" 와 이야기 모음을 만들었어요.');
        if (s) AM.go('series', s.id); else { demoBtn.disabled = false; demoBtn.textContent = '☔ 연습용 시리즈 만들기'; }
      },
    }, '☔ 연습용 시리즈 만들기');
    const listEl = h('div', { class: 'wf-list' },
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          const s = await AM.safe(() => window.api.saveSeries({ name: '새 시리즈', characterIds: chars.filter((c) => c.isLocked).slice(0, 1).map((c) => c.id) }), '새 시리즈를 만들었어요');
          if (s) AM.go('series', s.id);
        },
      }, '＋ 새 시리즈 만들기'),
      demoBtn,
      list.map((s) => h('button', { class: `wf-item char-item ${s.id === selected ? 'sel' : ''}`, onclick: () => AM.go('series', s.id) },
        s.characters[0] && s.characters[0].thumb ? h('img', { src: AM.fileUrl(s.characters[0].thumb) }) : h('span', { class: 'char-ph' }, s.emoji),
        h('div', null,
          h('div', { style: { fontWeight: 700 } }, `${s.emoji} ${s.name}`),
          h('div', { class: 'small muted' }, `만든 영상 ${s.episodes.length}개 · 주인공 ${s.characters[0] ? s.characters[0].name : '없음'}`)))));
    return h('div', null,
      h('div', { class: 'row', style: { marginBottom: '8px' } }, h('button', { class: 'btn small', onclick: () => AM.go('hero', cur ? cur.characterIds[0] : undefined) }, '← 주인공으로')),
      h('h1', { class: 'page-title' }, '📺 이야기 모음 (시리즈)'),
      h('p', { class: 'page-sub' }, '이야기 모음은 "같은 주인공, 같은 그림 느낌" 으로 이어지는 영상 묶음이에요. 영상을 만들 때마다 지난 이야기를 기억해서 이어 가요.'),
      h('div', { class: 'wf-layout' }, listEl, cur ? editor(cur, chars) : h('div', { class: 'section' },
        h('p', null, '아직 시리즈가 없어요.'),
        h('ol', null,
          h('li', null, '[🧒 주인공] 에서 주인공을 만들고 정해요.'),
          h('li', null, '[＋ 새 시리즈 만들기] 로 시리즈를 만들고 주인공을 골라요.'),
          h('li', null, '[🎬 만들기] 에서 노래를 올려요.')),
        h('p', { class: 'muted small' }, '바로 구경하고 싶으면 [☔ 연습용 시리즈 만들기] 를 누르세요. 연습용 주인공 "하루" 가 생겨요.'))));
  };

  function editor(s, chars) {
    const emoji = h('input', { type: 'text', value: s.emoji, style: { width: '80px' } });
    const name = h('input', { type: 'text', value: s.name });
    const locked = chars.filter((c) => c.isLocked);
    const hero = h('select', null, h('option', { value: '' }, '(주인공 고르기)'), chars.map((c) => h('option', { value: c.id }, `${c.isLocked ? '🔒' : '✏️'} ${c.name}${c.isLocked ? '' : ' (아직 안 잠김)'}`)));
    hero.value = s.characterIds[0] || '';
    const friends = chars.map((c) => {
      const box = h('input', { type: 'checkbox', checked: s.characterIds.slice(1).includes(c.id) });
      return { id: c.id, box, el: h('label', { class: 'check' }, box, `${c.isLocked ? '🔒' : '✏️'} ${c.name}`) };
    });
    // 주인공으로 고른 캐릭터는 '친구' 목록에서 숨긴다
    const syncFriends = () => friends.forEach((f) => { f.el.style.display = f.id === hero.value ? 'none' : ''; if (f.id === hero.value) f.box.checked = false; });
    hero.addEventListener('change', syncFriends);
    syncFriends();
    const presets = AM.state.info.artPresets || [];
    const art = h('textarea', { rows: 4 });
    art.value = s.bible.art_en;
    const world = h('textarea', { rows: 2, placeholder: '예) 비가 자주 오는 작은 항구 마을. 따뜻한 창문 불빛과 젖은 돌길.' });
    world.value = s.bible.world_ko;
    const tone = h('textarea', { rows: 2, placeholder: '예) 포근하고 신비로운 모험, 마지막은 늘 희망차게.' });
    tone.value = s.bible.tone_ko;
    const notes = h('textarea', { rows: 2, placeholder: '예) always summer, the town has blue roofs (영어)' });
    notes.value = s.bible.notes_en;
    const wfSel = h('select', null, h('option', { value: '' }, '(그때그때 고르기)'), AM.state.workflows.map((w) => h('option', { value: w.id }, `${w.emoji || '🎞️'} ${w.name}`)));
    wfSel.value = s.workflowId || '';
    const collect = () => ({
      id: s.id, emoji: emoji.value.trim(), name: name.value.trim(),
      characterIds: [hero.value, ...friends.filter((f) => f.box.checked && f.id !== hero.value).map((f) => f.id)].filter(Boolean),
      bible: { art_en: art.value.trim(), world_ko: world.value.trim(), tone_ko: tone.value.trim(), notes_en: notes.value.trim() },
      workflowId: wfSel.value,
    });
    const save = async () => { const r = await AM.safe(() => window.api.saveSeries(collect()), '저장했어요'); if (r) AM.go('series', s.id); return r; };
    const ready = s.characters.length && s.characters.every((c) => c.isLocked);
    const next = Math.max(s.episodeCounter, ...s.episodes.map((e) => e.number), 0) + 1;
    return h('div', null,
      h('div', { class: 'section' },
        h('div', { class: 'row' },
          h('div', { class: 'grow' }, h('h3', null, `${s.emoji} ${s.name}`), h('p', { class: 'desc' }, `다음 영상: ${next}화`)),
          h('button', {
            class: 'btn primary big', disabled: !ready,
            onclick: () => AM.go('home', s.id),
          }, `🎬 ${next}화 만들러 가기`)),
        ready ? null : h('div', { class: 'notice warn' }, '주인공을 고르고, 모든 캐릭터가 🔒 잠겨 있어야 영상을 만들 수 있어요. ',
          h('a', { href: '#', onclick: (e) => { e.preventDefault(); AM.go('characters', s.characterIds[0] || null); } }, '캐릭터 파일 화면으로 가기'))),
      h('div', { class: 'section' }, h('h3', null, '① 이름 · 주인공'),
        h('div', { class: 'grid3' }, h('label', { class: 'field' }, '아이콘', emoji), h('label', { class: 'field', style: { gridColumn: 'span 2' } }, '시리즈 이름', name)),
        h('div', { class: 'grid2', style: { marginTop: '12px' } },
          h('label', { class: 'field' }, '⭐ 주인공 (고정)', hero, h('span', { class: 'hint' }, '모든 영상의 주인공이에요. AI 가 이름이나 모습을 바꾸지 못해요.')),
          h('div', { class: 'field' }, h('span', null, '함께 나오는 친구 (고정, 선택)'), h('div', { class: 'col', style: { marginTop: '4px' } }, friends.length > 1 ? friends.map((f) => f.el) : h('span', { class: 'small muted' }, '다른 캐릭터가 없어요.')))),
        locked.length ? null : h('div', { class: 'notice info small' }, '잠긴 캐릭터가 아직 없어요. [🧒 주인공] 에서 만들고 정해 주세요.')),
      h('div', { class: 'section' }, h('h3', null, '② 그림 느낌 약속 (모든 영상 똑같이)'),
        h('p', { class: 'desc' }, '그림 AI 에게 보내는 그림체 설명이에요 (영어). 아래 예시를 누르면 들어가요.'),
        art,
        h('div', { class: 'presets' }, presets.map(([l, v]) => h('span', { class: 'chip click', onclick: () => { art.value = v; } }, l))),
        h('div', { class: 'grid2', style: { marginTop: '12px' } },
          h('label', { class: 'field' }, '🌍 세계 · 배경 (한국어)', world),
          h('label', { class: 'field' }, '💗 분위기 (한국어)', tone)),
        h('details', { class: 'adv', style: { marginTop: '10px' } }, h('summary', null, '고급: 시리즈 규칙 · 기본 영상 규칙'),
          h('div', { class: 'grid2', style: { marginTop: '8px' } },
            h('label', { class: 'field' }, '시리즈 규칙 (영어, 모든 그림에 들어가요)', notes),
            h('label', { class: 'field' }, '기본 영상 규칙(워크플로우)', wfSel)))),
      h('div', { class: 'row', style: { justifyContent: 'flex-end', marginBottom: '18px' } },
        h('button', {
          class: 'btn danger ghost',
          onclick: async () => {
            if (!await AM.confirmBox('시리즈 삭제', `"${s.name}" 시리즈를 지울까요? 만든 영상과 캐릭터는 지워지지 않아요.`, '삭제', 'danger')) return;
            if (await AM.safe(() => window.api.deleteSeries(s.id), '지웠어요')) { selected = null; AM.go('series'); }
          },
        }, '🗑 시리즈 삭제'),
        h('button', { class: 'btn primary', onclick: save }, '💾 저장')),
      episodesSection(s));
  }

  function episodesSection(s) {
    const rows = s.episodes.slice().reverse().map((e) => {
      const ta = h('textarea', { rows: 2 });
      ta.value = e.summary_ko;
      return h('div', { class: 'ep-row' },
        h('div', { class: 'ep-no' }, `${e.number}화`),
        h('div', { class: 'grow col' },
          h('b', null, e.title || '(제목 없음)'),
          ta,
          h('div', { class: 'row', style: { gap: '6px' } },
            h('span', { class: 'small muted grow' }, AM.fmtDate(e.madeAt)),
            e.projectId ? h('button', { class: 'btn small', onclick: () => AM.go('project', e.projectId) }, '📂 영상 열기') : null,
            h('button', { class: 'btn small', onclick: () => AM.safe(() => window.api.updateEpisode(s.id, e.number, { summary_ko: ta.value.trim() }), '요약을 고쳤어요') }, '💾 요약 저장'),
            h('button', {
              class: 'btn small ghost danger',
              onclick: async () => {
                if (!await AM.confirmBox('기록에서 빼기', `${e.number}화 를 이야기 기록에서 뺄까요? 다음 영상의 AI 가 이 이야기를 모르게 돼요. (영상 파일은 그대로)`, '빼기', 'danger')) return;
                if (await AM.safe(() => window.api.updateEpisode(s.id, e.number, null), '뺐어요')) AM.go('series', s.id);
              },
            }, '✕'))));
    });
    return h('div', { class: 'section' },
      h('h3', null, `📚 지난 이야기 (${s.episodes.length}편)`),
      h('p', { class: 'desc' }, '영상이 완성되면 2~3줄 요약이 여기에 쌓여요. 다음 영상의 이야기를 짤 때 AI 가 이 요약을 읽고 이야기를 이어 가요. 요약은 직접 고칠 수 있어요.'),
      rows.length ? rows : h('div', { class: 'muted small' }, '아직 완성된 영상이 없어요.'));
  }

}(window.AM));
