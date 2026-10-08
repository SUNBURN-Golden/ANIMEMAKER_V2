'use strict';
/* 캐릭터 화면: 주인공 만들기 → 기준 그림(모델 시트) → 잠그기 → 캐릭터 파일(.amchar) 내보내기·가져오기 */
(function (AM) {
  const { h, toast } = AM;
  AM.views = AM.views || {};
  let selected = null;
  let artIdx = 0;

  const FIELD_LABEL = {
    summary: ['한 줄 요약', '예) a cheerful 12-year-old girl with a short brown bob and a long red scarf'],
    face: ['얼굴', 'round face, rosy cheeks …'],
    hair: ['머리', 'short chestnut-brown bob with bangs …'],
    eyes: ['눈', 'large round brown eyes …'],
    body: ['몸·키', 'small and slim, child proportions …'],
    outfit: ['옷', 'yellow raincoat, green boots …'],
    props: ['늘 가지고 다니는 것', 'long red scarf …'],
  };
  const KINDS = ['turnaround', 'expressions', 'fullbody'];
  const KIND_ICON = { turnaround: '🧍', expressions: '😊', fullbody: '🕺', other: '🖼️' };

  function kindLabel(k) { return (AM.state.info.refKinds || {})[k] || k; }

  AM.views.characters = async function characters(arg) {
    const list = await window.api.listCharacters();
    if (arg) selected = arg;
    if (!selected || !list.find((c) => c.id === selected)) selected = list[0] ? list[0].id : null;
    const cur = list.find((c) => c.id === selected);
    const listEl = h('div', { class: 'wf-list' },
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          const c = await AM.safe(() => window.api.saveCharacter({ name: '새 캐릭터' }), '새 캐릭터를 만들었어요. 이름과 생김새를 적어 주세요.');
          if (c) AM.go('characters', c.id);
        },
      }, '＋ 새 캐릭터 만들기'),
      h('button', {
        class: 'btn',
        onclick: async () => {
          const c = await AM.safe(() => window.api.importCharacter());
          if (c) { toast(`"${c.name}" 캐릭터를 가져왔어요.`, 'ok'); AM.go('characters', c.id); }
        },
      }, '📥 캐릭터 파일 가져오기 (.amchar)'),
      list.map((c) => h('button', { class: `wf-item char-item ${c.id === selected ? 'sel' : ''}`, onclick: () => AM.go('characters', c.id) },
        c.refsAbs[0] ? h('img', { src: AM.fileUrl(c.refsAbs[0], c.updatedAt) }) : h('span', { class: 'char-ph' }, '🧒'),
        h('div', null,
          h('div', { style: { fontWeight: 700 } }, c.name),
          h('div', { class: 'small muted' }, c.isLocked ? `🔒 잠김 · v${c.version}` : `✏️ 만드는 중 · 기준 그림 ${c.refs.length}장`)))));
    return h('div', null,
      h('div', { class: 'row', style: { marginBottom: '8px' } }, h('button', { class: 'btn small', onclick: () => AM.go('hero', cur ? cur.id : undefined) }, '← 주인공으로')),
      h('h1', { class: 'page-title' }, '🔧 캐릭터 파일 (자세히 편집)'),
      h('p', { class: 'page-sub' }, '주인공을 한 번 만들어 잠가 두면, 모든 영상에서 똑같은 얼굴·머리·옷으로 나와요. 그림을 그릴 때마다 기준 그림과 설명을 꼭 붙여 보내거든요.'),
      list.length ? null : h('div', { class: 'notice info' }, '아직 캐릭터가 없어요. [＋ 새 캐릭터 만들기] 를 누르거나, 친구가 준 캐릭터 파일(.amchar)을 가져오세요. 쉽게 하려면 [← 주인공으로] 가서 이름과 모습만 적어도 돼요.'),
      h('div', { class: 'wf-layout' }, listEl, cur ? editor(cur) : h('div', { class: 'section muted' }, '왼쪽에서 캐릭터를 고르거나 새로 만들어 주세요.')));
  };

  function editor(c) {
    const locked = c.isLocked;
    const name = h('input', { type: 'text', value: c.name });
    const personality = h('textarea', { rows: 2, placeholder: '예) 호기심 많고 씩씩한 열두 살 소녀. 겁이 나도 친구를 위해 먼저 손을 내민다.' });
    personality.value = c.personality_ko || '';
    const desc = h('textarea', { rows: 3, disabled: locked, placeholder: '한국어로 편하게 적어 주세요. 예) 짧은 갈색 단발머리, 큰 갈색 눈, 빨간 목도리, 노란 우비, 초록 장화' });
    desc.value = c.description_ko || '';
    const fields = {};
    for (const k of Object.keys(FIELD_LABEL)) {
      fields[k] = k === 'summary' ? h('textarea', { rows: 2, disabled: locked, placeholder: FIELD_LABEL[k][1] }) : h('input', { type: 'text', disabled: locked, placeholder: FIELD_LABEL[k][1] });
      fields[k].value = c.locked[k] || '';
    }
    // 색 팔레트
    let palette = c.palette.map((p) => ({ ...p }));
    const palBox = h('div', { class: 'col' });
    const renderPal = () => {
      AM.clear(palBox);
      palette.forEach((p, i) => palBox.appendChild(h('div', { class: 'row', style: { gap: '6px' } },
        h('input', { type: 'color', value: p.hex, disabled: locked, oninput: (e) => { p.hex = e.target.value; } }),
        h('input', { type: 'text', value: p.name, disabled: locked, placeholder: '색 이름 (영어 권장, 예: scarf red)', style: { flex: 1 }, oninput: (e) => { p.name = e.target.value; } }),
        h('span', { class: 'mono small muted' }, p.hex),
        locked ? null : h('button', { class: 'btn small ghost', onclick: () => { palette.splice(i, 1); renderPal(); } }, '✕'))));
      if (!locked && palette.length < 12) palBox.appendChild(h('button', { class: 'btn small', onclick: () => { palette.push({ name: '', hex: '#cc3344' }); renderPal(); } }, '＋ 색 추가'));
    };
    renderPal();
    const must = h('textarea', { rows: 3, disabled: locked, placeholder: '한 줄에 하나씩 (영어 권장)\n예) always wears the long red scarf' });
    must.value = c.rules.must.join('\n');
    const never = h('textarea', { rows: 3, disabled: locked, placeholder: '한 줄에 하나씩 (영어 권장)\n예) never change hair color or hairstyle' });
    never.value = c.rules.never.join('\n');

    const collect = () => ({
      id: c.id, name: name.value.trim() || c.name, personality_ko: personality.value.trim(),
      ...(locked ? {} : {
        description_ko: desc.value.trim(),
        locked: Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value.trim()])),
        palette: palette.filter((p) => p.hex).map((p) => ({ name: p.name.trim() || 'color', hex: p.hex })),
        rules: { must: must.value.split('\n'), never: never.value.split('\n') },
      }),
    });
    const save = async (quiet) => {
      const r = await AM.safe(() => window.api.saveCharacter(collect()), quiet ? null : '저장했어요');
      return r;
    };
    const describeBtn = h('button', {
      class: 'btn small primary', disabled: locked,
      onclick: async () => {
        describeBtn.disabled = true;
        describeBtn.textContent = '✨ AI 가 정리하는 중… (1분 정도)';
        const r = await AM.safe(() => window.api.describeCharacter({ name: name.value, description_ko: desc.value, personality_ko: personality.value }));
        describeBtn.disabled = false;
        describeBtn.textContent = '✨ AI 로 영어 설명 · 색 · 규칙 만들기';
        if (!r) return;
        for (const [k, el] of Object.entries(fields)) el.value = r.locked[k] || el.value;
        if (r.palette.length) { palette = r.palette.map((p) => ({ ...p })); renderPal(); }
        if (r.rules.must.length) must.value = r.rules.must.join('\n');
        if (r.rules.never.length) never.value = r.rules.never.join('\n');
        toast(r.demo ? '연습 모드라서 예시 설명을 넣었어요. 고친 뒤 [💾 저장] 을 눌러 주세요.' : '정리했어요. 확인하고 [💾 저장] 을 눌러 주세요.', 'ok');
      },
    }, '✨ AI 로 영어 설명 · 색 · 규칙 만들기');

    return h('div', null,
      locked
        ? h('div', { class: 'notice ok' }, h('b', null, `🔒 잠긴 캐릭터 (버전 ${c.version})`), ' — 생김새·색·규칙·기준 그림이 고정되어 있어서 모든 영상에 똑같이 나와요. 이름과 성격은 바꿀 수 있어요.')
        : h('div', { class: 'notice warn' }, '✏️ 아직 만드는 중이에요. ① 생김새 적기 → ② 기준 그림 넣기(직접 또는 AI) → ③ [🔒 잠그기] 순서로 해 주세요. 잠가야 영상에 쓸 수 있어요.'),
      h('div', { class: 'section' }, h('h3', null, '① 이름 · 성격'),
        h('div', { class: 'grid2' },
          h('label', { class: 'field' }, '이름', name, h('span', { class: 'hint' }, '모든 영상에서 이 이름 그대로 나와요.')),
          h('label', { class: 'field' }, '성격 (한국어)', personality, h('span', { class: 'hint' }, '이야기를 쓸 때 참고해요.')))),
      h('div', { class: 'section' }, h('h3', null, '② 생김새 (단단한 기준)'),
        h('p', { class: 'desc' }, '그림 AI 는 영어를 가장 잘 알아들어요. 한국어로 적고 [✨ AI 로 …만들기] 를 누르면 영어로 정리해 줘요. 이 설명은 모든 그림 요청에 글자 그대로 들어가요.'),
        h('label', { class: 'field' }, '내 말로 설명 (한국어)', desc),
        h('div', { class: 'row', style: { margin: '8px 0 12px' } }, describeBtn),
        h('div', { class: 'grid2' }, Object.keys(FIELD_LABEL).map((k) => h('label', { class: 'field', style: k === 'summary' ? { gridColumn: '1 / -1' } : null }, `${FIELD_LABEL[k][0]} (영어)`, fields[k])))),
      h('div', { class: 'grid2' },
        h('div', { class: 'section' }, h('h3', null, '🎨 색 팔레트'), h('p', { class: 'desc' }, '머리·눈·옷 색을 정확한 색 번호로 정해 두면 그림마다 색이 바뀌지 않아요.'), palBox),
        h('div', { class: 'section' }, h('h3', null, '📏 규칙'),
          h('label', { class: 'field' }, '✅ 꼭 지킬 것', must),
          h('label', { class: 'field', style: { marginTop: '8px' } }, '🚫 절대 안 되는 것', never))),
      locked ? null : h('div', { class: 'row', style: { justifyContent: 'flex-end', marginBottom: '18px' } },
        h('button', { class: 'btn primary', onclick: async () => { if (await save()) AM.go('characters', c.id); } }, '💾 저장')),
      locked ? h('div', { class: 'row', style: { justifyContent: 'flex-end', marginBottom: '18px' } },
        h('button', { class: 'btn primary', onclick: async () => { if (await save()) AM.go('characters', c.id); } }, '💾 이름·성격 저장')) : null,
      refsSection(c, save),
      lockSection(c, save));
  }

  function refsSection(c, save) {
    const locked = c.isLocked;
    const prov = AM.state.settings.providers.image;
    const pinfo = AM.providerInfo('image', prov);
    const canAuto = pinfo.mode === 'auto' || pinfo.mode === 'demo';
    const presets = AM.state.info.artPresets || [];
    const art = h('select', { onchange: (e) => { artIdx = Number(e.target.value); } }, presets.map(([l], i) => h('option', { value: String(i) }, l)));
    art.value = String(artIdx);
    const artText = () => (presets[artIdx] || presets[0] || ['', ''])[1];
    const cards = c.refs.map((r, i) => h('div', { class: 'media-card' },
      h('div', { class: 'thumb', style: { aspectRatio: '4 / 3' } },
        h('img', { src: AM.fileUrl(c.refsAbs[i], c.updatedAt), onclick: () => bigImage(c.refsAbs[i]) }),
        h('span', { class: 'badge' }, `${KIND_ICON[r.kind] || ''} ${r.label || kindLabel(r.kind)}`)),
      locked ? null : h('div', { class: 'body' }, h('div', { class: 'acts' },
        h('button', { class: 'btn small ghost danger', onclick: async () => { if (await AM.safe(() => window.api.removeCharacterRef(c.id, i), '뺐어요')) AM.go('characters', c.id); } }, '✕ 빼기')))));
    const kindSel = h('select', { style: { width: '220px' } }, [...KINDS, 'other'].map((k) => h('option', { value: k }, kindLabel(k))));
    const genBtns = KINDS.map((k) => {
      const b = h('button', {
        class: 'btn small', disabled: locked || c.refs.length >= (AM.state.info.maxRefs || 6),
        onclick: async () => {
          const saved = await save(true);
          if (!saved) return;
          if (!saved.locked.summary && !saved.locked.outfit) { toast('먼저 ② 생김새(영어 설명)를 적어 주세요.', 'err'); return; }
          if (!canAuto) {
            const text = await AM.safe(() => window.api.characterRefPrompt(c.id, k, artText()));
            if (text) AM.safe(() => window.api.copyText(text), '그림 주문 글을 복사했어요. 그림 사이트에 붙여넣어 그린 뒤, 받은 그림을 [📁 내 그림 넣기] 로 넣어 주세요.');
            return;
          }
          b.disabled = true;
          b.textContent = `${KIND_ICON[k]} 그리는 중… (1~3분)`;
          const r = await AM.safe(() => window.api.generateCharacterRef(c.id, k, artText()), `${kindLabel(k)} 그림을 넣었어요. 마음에 안 들면 빼고 다시 그려요.`);
          if (r) AM.go('characters', c.id); else { b.disabled = false; b.textContent = `${KIND_ICON[k]} ${kindLabel(k)}`; }
        },
      }, `${KIND_ICON[k]} ${kindLabel(k)}`);
      return b;
    });
    return h('div', { class: 'section' },
      h('h3', null, `③ 기준 그림 (${c.refs.length}/${AM.state.info.maxRefs || 6}장)`),
      h('p', { class: 'desc' }, '앞·옆·뒤 모습(턴어라운드), 표정 모음, 전신 그림이 있으면 가장 좋아요. 모든 그림을 그릴 때 이 그림들을 함께 보내서 똑같이 그리게 해요.'),
      cards.length ? h('div', { class: 'media-grid ref-grid' }, cards) : h('div', { class: 'muted small' }, '아직 기준 그림이 없어요.'),
      locked ? null : h('div', { class: 'col', style: { marginTop: '14px' } },
        h('div', { class: 'row', style: { gap: '6px' } },
          h('b', null, '내가 가진 그림 넣기:'), kindSel,
          h('button', {
            class: 'btn small primary',
            onclick: async () => {
              const files = await window.api.pickFiles({ filters: [{ name: '그림', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
              if (!files || !files.length) return;
              let ok = 0;
              for (const f of files) if (await AM.safe(() => window.api.addCharacterRef(c.id, f, kindSel.value))) ok++;
              if (ok) { toast(`그림 ${ok}장을 넣었어요.`, 'ok'); AM.go('characters', c.id); }
            },
          }, '📁 내 그림 넣기')),
        h('div', { class: 'row', style: { gap: '6px' } },
          h('b', null, canAuto ? `AI 로 그리기 (${pinfo.short}):` : `그림 주문 글 복사 (${pinfo.short} 는 직접 그려요):`), ...genBtns),
        h('div', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'small muted' }, '그림체'), art,
          h('span', { class: 'small muted' }, '턴어라운드를 먼저 그리면, 표정·전신은 그 그림을 보고 똑같이 그려요.'))));
  }

  function lockSection(c, save) {
    const btns = [];
    if (c.isLocked) {
      btns.push(h('button', {
        class: 'btn',
        onclick: async () => {
          if (!await AM.confirmBox('잠금을 풀까요?', '잠금을 풀면 생김새·색·규칙·기준 그림을 고칠 수 있어요.\n다시 잠그면 버전이 하나 올라가요.\n\n이미 만든 영상은 예전 모습 그대로 남고, 새 영상부터 바뀐 모습이 나와요.', '잠금 풀기')) return;
          if (await AM.safe(() => window.api.unlockCharacter(c.id), '잠금을 풀었어요')) AM.go('characters', c.id);
        },
      }, '🔓 잠금 풀기'));
    } else {
      btns.push(h('button', {
        class: 'btn primary big',
        onclick: async () => {
          if (!await save(true)) return;
          if (!await AM.confirmBox('이 모습으로 잠글까요?', '잠그면 이 설명과 기준 그림이 "단단한 기준" 이 되어, 모든 영상의 그림이 이 모습을 따라요.\n(나중에 잠금을 풀 수도 있어요)', '🔒 잠그기')) return;
          if (await AM.safe(() => window.api.lockCharacter(c.id), '잠갔어요! 이제 [🎬 만들기] 에서 이 주인공으로 영상을 만들 수 있어요.')) {
            try { await AM.hero.ensureSeries(c); } catch (_) { /* 시리즈는 나중에 만들기 화면이 알아서 만든다 */ }
            AM.go('characters', c.id);
          }
        },
      }, '🔒 이 모습으로 잠그기'));
    }
    btns.push(h('button', { class: 'btn', onclick: () => AM.safe(async () => { const f = await window.api.exportCharacter(c.id); if (f) toast(`저장했어요: ${f}`, 'ok'); }) }, '📤 캐릭터 파일로 내보내기 (.amchar)'));
    btns.push(h('button', {
      class: 'btn danger ghost',
      onclick: async () => {
        if (!await AM.confirmBox('캐릭터 삭제', `"${c.name}" 캐릭터를 지울까요? 이미 만든 영상에는 영향이 없어요.`, '삭제', 'danger')) return;
        if (await AM.safe(() => window.api.deleteCharacter(c.id), '지웠어요')) { selected = null; AM.go('characters'); }
      },
    }, '🗑 삭제'));
    return h('div', { class: 'section' },
      h('h3', null, '④ 잠그기 · 내보내기'),
      h('p', { class: 'desc' }, '캐릭터 파일(.amchar) 하나에 설명·색·규칙·기준 그림이 모두 들어 있어요. 다른 PC 나 친구에게 그대로 옮길 수 있어요.'),
      h('div', { class: 'row' }, btns));
  }

  function bigImage(p) {
    AM.modal('크게 보기', h('img', { src: AM.fileUrl(p), style: { maxWidth: '100%', maxHeight: '72vh', display: 'block', margin: '0 auto', borderRadius: '10px' } }),
      [{ label: '📂 위치 열기', onClick: () => { window.api.showItem(p); return true; } }, { label: '닫기' }], { width: 'min(980px, 94vw)' });
  }
}(window.AM));
