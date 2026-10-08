'use strict';
/* 🧒 주인공: 목록 · 간단 편집기, 그리고 '주인공 만들기' 부품 (AM.hero).
 *  - 주인공 = 잠긴 캐릭터 1명 + 자동으로 만들어지는 시리즈("<이름> 이야기") 1개
 *  - 같은 부품(AM.hero.builder)을 만들기 화면의 '먼저 주인공을 만들어요' 카드와 이 화면의 편집기가 함께 쓴다
 */
(function (AM) {
  const { h, toast } = AM;
  AM.views = AM.views || {};

  const KINDS = ['turnaround', 'expressions', 'fullbody'];
  const KIND_NAME = { turnaround: '앞·옆·뒤 모습', expressions: '표정 모음', fullbody: '전신', other: '내 그림' };
  const KIND_ICON = { turnaround: '🧍', expressions: '😊', fullbody: '🕺', other: '🖼️' };
  const NAME_PLACEHOLDER = '새 캐릭터'; // 이름 없이 만들어진 기록 (화면에는 빈칸으로 보인다)
  const IMG_EXT = ['png', 'jpg', 'jpeg', 'webp'];

  // 그림 느낌 4가지 (ART_PRESETS 와 같은 차례). 영어 설명은 화면에 내지 않고 쉬운 말로만 보여 준다.
  const ART_FRIENDLY = [
    { emoji: '🌿', name: '손그림 극장 애니', desc: '또렷한 선, 포근한 색. 옛날 극장 애니 느낌' },
    { emoji: '🏰', name: '동화 장편 애니', desc: '반짝이는 배경, 동화책 같은 분위기' },
    { emoji: '🧸', name: '수채화 그림책', desc: '물감 번짐과 종이 질감이 있는 부드러운 그림' },
    { emoji: '🌃', name: '90년대 TV 만화', desc: '굵은 선과 진한 색, 90년대 만화 느낌' },
  ];
  let artIdx = 0; // 지금 고른 그림 느낌 (화면을 옮겨도 남는다)

  const heroName = (c) => (c && c.name && c.name !== NAME_PLACEHOLDER ? c.name : '');
  const hasEnglish = (c) => !!(c && c.locked && Object.values(c.locked).some(Boolean));
  const presets = () => (AM.state.info && AM.state.info.artPresets) || [];

  /** 대표 그림 한 장 (전신 > 앞·옆·뒤 > 표정 > 그 밖) */
  function thumbOf(c) {
    if (!c) return null;
    for (const k of ['fullbody', 'turnaround', 'expressions', 'other']) {
      const i = c.refs.findIndex((r) => r.kind === k);
      if (i >= 0) return c.refsAbs[i];
    }
    return null;
  }

  // ---- 시리즈(이야기 모음) 도우미: 주인공 한 명당 시리즈 하나가 자동으로 ----
  const seriesOf = (c, list) => (c ? ((list || []).find((s) => s.characterIds[0] === c.id) || (list || []).find((s) => s.characterIds.includes(c.id)) || null) : null);
  const isReadySeries = (s) => !!(s && s.characters.length && s.characters.every((x) => x.isLocked));
  const readySeries = (list) => (list || []).filter(isReadySeries);

  function artIndexOf(ser) {
    if (!ser) return artIdx;
    const i = presets().findIndex(([, v]) => v === ser.bible.art_en);
    return i;
  }

  /** 이 주인공의 시리즈가 없으면 "<이름> 이야기" 로 만든다 */
  async function ensureSeries(c) {
    const list = await window.api.listSeries();
    const found = list.find((x) => x.characterIds[0] === c.id);
    if (found) return found;
    const art = (presets()[artIdx] || presets()[0] || [])[1];
    return window.api.saveSeries({ name: `${heroName(c) || '주인공'} 이야기`, characterIds: [c.id], bible: art ? { art_en: art } : undefined });
  }

  /** 잠긴 주인공인데 어느 시리즈에도 없는 것(옛 데이터 · 캐릭터 화면에서 만든 것)에 "<이름> 이야기" 를 만들어 준다 */
  async function ensureSeriesForLocked(chars, seriesList) {
    const orphans = chars.filter((x) => x.isLocked && !seriesList.some((s) => s.characterIds.includes(x.id)));
    if (!orphans.length) return seriesList;
    for (const c of orphans) { try { await ensureSeries(c); } catch (_) { /* 다음에 다시 시도 */ } }
    return window.api.listSeries();
  }

  async function deleteHero(c, seriesList) {
    const mine = (seriesList || []).filter((s) => s.characterIds.includes(c.id));
    const eps = mine.filter((s) => s.characterIds[0] === c.id).reduce((n, s) => n + s.episodes.length, 0);
    const ok = await AM.confirmBox('주인공을 지울까요?', `"${heroName(c) || '이름 없는 주인공'}"${AM.josa(heroName(c) || '이름 없는 주인공', '을', '를')} 지워요.${eps ? `\n지난 이야기 ${eps}편의 기록도 함께 사라져요.` : ''}\n이미 만든 영상은 그대로 남아요.`, '🗑 지우기', 'danger');
    if (!ok) return false;
    try {
      for (const s of mine) {
        if (s.characterIds[0] === c.id) await window.api.deleteSeries(s.id);
        else await window.api.saveSeries({ id: s.id, characterIds: s.characterIds.filter((x) => x !== c.id) });
      }
      await window.api.deleteCharacter(c.id);
      toast('지웠어요', 'ok');
      return true;
    } catch (e) { toast(e.message, 'err'); return false; }
  }

  // ---- 그리는 일(job): 화면을 옮겨 다녀도 계속 돌고, 돌아오면 이어서 보여 준다 ----
  const jobs = new Map(); // 주인공 id → job
  function runJob(id, queue, fn) {
    const job = { id, queue, current: null, stage: 'describing', text: '', pct: null, char: null, running: true, error: null, subs: new Set() };
    job.notify = () => { for (const f of [...job.subs]) { try { f(job); } catch (_) { /* noop */ } } };
    job.update = (patch) => { Object.assign(job, patch); job.notify(); };
    jobs.set(id, job);
    AM.navBusy('hero', true);
    job.promise = (async () => {
      try { await fn(job); } catch (e) { job.error = e; }
      job.running = false;
      job.notify();
      jobs.delete(id);
      AM.navBusy('hero', jobs.size > 0);
    })();
    return job;
  }

  // =====================================================================
  //  주인공 만들기 부품
  // =====================================================================
  /**
   * 이름 + 생김새(한국어) → [AI 로 그리기] → 그림 3장 → [이 모습으로 정하기]
   * opts: { character, series, extra: Node|Node[] (그리기 단추 옆), indicator, onLocked(c, series), onName(name), onCreate(c) }
   * 반환: { el, character(), series(), flush() }
   */
  function builder(opts = {}) {
    let c = opts.character || null;
    let ser = opts.series || null;
    const root = h('div', { class: 'hb' });
    // 이미 시리즈가 있으면 그 그림 느낌을 따른다 (-1 = 직접 쓴 것). 없으면 마지막에 고른 것
    let art = ser ? artIndexOf(ser) : artIdx;

    const nameIn = h('input', { type: 'text', class: 'hb-name', placeholder: '예) 하루', maxlength: '40', 'aria-label': '이름' });
    nameIn.value = heroName(c);
    const descIn = h('textarea', { class: 'hb-desc', rows: 3, placeholder: '예) 짧은 갈색 단발머리에 노란 우비를 입은 씩씩한 열두 살 소녀. 빨간 목도리를 해요.', 'aria-label': '어떻게 생겼나요' });
    descIn.value = (c && c.description_ko) || '';
    const hint = h('div', { class: 'hb-hint', role: 'status' });
    let hintT = null;
    const setHint = (msg) => {
      hint.textContent = msg || '';
      clearTimeout(hintT);
      if (msg) hintT = setTimeout(() => { hint.textContent = ''; }, 6000);
    };

    const zArt = h('div', { class: 'hb-art' });
    const zAct = h('div', { class: 'hb-act' });
    const zNote = h('div', { class: 'hb-note' });
    const zProg = h('div', { class: 'hb-prog' });
    const zPics = h('div', { class: 'hb-picwrap' });
    const zLock = h('div', { class: 'hb-lock' });

    const canAuto = () => ['auto', 'demo'].includes(AM.providerInfo('image', AM.state.settings.providers.image).mode);
    const isDemoImg = () => AM.state.settings.providers.image === 'demo';
    const job = () => (c ? jobs.get(c.id) || null : null);
    const cur = () => { const j = job(); return (j && j.running && j.char) || c; };
    const locked = () => !!(c && c.isLocked);
    const currentArt = () => (art >= 0 ? (presets()[art] || presets()[0] || [])[1] : (ser ? ser.bible.art_en : (presets()[0] || [])[1]));

    // ---- 자동 저장 (이름 · 설명). 아무것도 안 적었으면 기록을 만들지 않는다 ----
    async function persist() {
      const name = nameIn.value.trim();
      const desc = descIn.value.trim();
      if (!c) {
        if (!name && !desc) return;
        c = await window.api.saveCharacter({ name: name || NAME_PLACEHOLDER, description_ko: desc });
        if (opts.onCreate) opts.onCreate(c);
        render();
        return;
      }
      const prevName = c.name;
      const patch = { id: c.id, name: name || NAME_PLACEHOLDER };
      if (!c.isLocked) patch.description_ko = desc;
      c = await window.api.saveCharacter(patch);
      if (ser && name && prevName !== c.name && ser.name === `${prevName} 이야기`) {
        ser = await window.api.saveSeries({ id: ser.id, name: `${c.name} 이야기` });
      }
    }
    const saver = AM.kit.autosave(persist, { delay: 700, indicator: opts.indicator });
    nameIn.addEventListener('input', () => { saver(); if (opts.onName) opts.onName(nameIn.value.trim()); });
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (!descIn.disabled) descIn.focus(); } });
    descIn.addEventListener('input', saver);

    async function ensureRecord() {
      if (!c) c = await window.api.saveCharacter({ name: nameIn.value.trim() || NAME_PLACEHOLDER, description_ko: descIn.value.trim() });
      return c;
    }
    async function refreshChar() {
      if (c) { const n = await window.api.getCharacter(c.id); if (n) c = n; }
      return c;
    }

    // ---- 그림 느낌 4칸 (작은 카드에서는 접어 둔다) ----
    let artOpen = false;
    function renderArt() {
      AM.clear(zArt);
      const list = presets();
      const grid = h('div', { class: 'art-grid' }, ART_FRIENDLY.slice(0, list.length || 4).map((a, i) => AM.kit.pickCard({
        emoji: a.emoji, title: a.name, desc: a.desc, selected: art === i, class: 'art',
        onclick: async () => {
          art = i;
          artIdx = i;
          renderArt();
          const text = (presets()[i] || [])[1];
          if (ser && text) {
            try { ser = await window.api.saveSeries({ id: ser.id, bible: { ...ser.bible, art_en: text } }); } catch (e) { toast(e.message, 'err'); }
          }
        },
      })));
      const note = art < 0 && ser ? h('div', { class: 'small muted', style: { marginTop: '6px' } }, '직접 정해 둔 그림 느낌을 쓰고 있어요. 위에서 하나를 고르면 바뀌어요.') : null;
      if (opts.compactArt) {
        const a = ART_FRIENDLY[art >= 0 ? art : 0] || ART_FRIENDLY[0];
        const f = AM.kit.fold(h('span', null, '🎨 그림 느낌 · ', h('b', null, `${a.emoji} ${a.name}`)), [grid, note], { open: artOpen, onToggle: (o) => { artOpen = o; }, class: 'hb-artfold' });
        zArt.appendChild(f);
        return;
      }
      zArt.appendChild(h('div', { class: 'hb-label' }, '그림 느낌'));
      zArt.appendChild(grid);
      if (note) zArt.appendChild(note);
    }

    // ---- 그림 그리기 · 다시 그리기 · 내 그림 ----
    function showError(e) {
      const f = AM.kit.friendlyError(e && e.message);
      AM.clear(zNote);
      zNote.appendChild(h('div', { class: 'notice err hb-err' },
        h('div', null, `😢 ${f.text}`),
        f.kind === 'install' || f.kind === 'login' ? h('div', { style: { marginTop: '8px' } }, h('button', { class: 'btn small', onclick: () => AM.go('settings') }, '🔌 설정에서 연결하기')) : null));
    }

    async function startDraw() {
      const name = nameIn.value.trim();
      const desc = descIn.value.trim();
      if (!name) { setHint('이름을 적어 주세요.'); nameIn.focus(); return; }
      if (!desc) { setHint('"어떻게 생겼나요?" 를 적어 주세요. 몇 줄이면 돼요.'); descIn.focus(); return; }
      AM.clear(zNote);
      try {
        await saver.flush();
        await ensureRecord();
      } catch (e) { showError(e); return; }
      const id = c.id;
      const artText = currentArt();
      const personality = c.personality_ko || '';
      runJob(id, KINDS.slice(), async (j) => {
        j.update({ stage: 'describing', text: '생김새를 정리하는 중이에요 (약 1분)', pct: null, current: null, char: c });
        const d = await window.api.describeCharacter({ name, description_ko: desc, personality_ko: personality });
        let cc = await window.api.saveCharacter({ id, name, description_ko: desc, locked: d.locked, palette: d.palette, rules: d.rules });
        for (let i = cc.refs.length - 1; i >= 0; i--) cc = await window.api.removeCharacterRef(id, i);
        j.update({ char: cc, stage: 'drawing' });
        for (let i = 0; i < KINDS.length; i++) {
          j.update({ current: KINDS[i], text: `${i + 1}/3 그리는 중이에요 · ${KIND_NAME[KINDS[i]]}`, pct: (i / KINDS.length) * 100 });
          cc = await window.api.generateCharacterRef(id, KINDS[i], artText);
          j.update({ char: cc });
        }
        j.update({ current: null, stage: 'done', text: '다 그렸어요', pct: 100 });
      });
      bindJob();
      render();
    }

    async function redrawKind(kind) {
      try { await ensureRecord(); } catch (e) { showError(e); return; }
      const id = c.id;
      const artText = currentArt();
      AM.clear(zNote);
      runJob(id, [kind], async (j) => {
        j.update({ stage: 'drawing', current: kind, text: `${KIND_NAME[kind]} 그림을 다시 그리는 중이에요`, pct: null, char: c });
        let cc = await window.api.generateCharacterRef(id, kind, artText);
        // 새 그림이 잘 들어온 다음에 옛 그림을 뺀다 (실패해도 옛 그림이 남도록)
        for (let i = cc.refs.length - 2; i >= 0; i--) if (cc.refs[i].kind === kind) cc = await window.api.removeCharacterRef(id, i);
        j.update({ char: cc, current: null, pct: 100 });
      });
      bindJob();
      render();
    }

    async function ownPictures(kind) {
      const files = await window.api.pickFiles({ filters: [{ name: '그림', extensions: IMG_EXT }] });
      if (!files || !files.length) return;
      try {
        await ensureRecord();
        let cc = c;
        let added = 0;
        for (let i = 0; i < files.length; i++) {
          const k = i === 0 && KINDS.includes(kind) ? kind : 'other';
          cc = await window.api.addCharacterRef(cc.id, files[i], k);
          added++;
          if (i === 0 && KINDS.includes(kind)) {
            // 같은 칸에 있던 옛 그림은 뺀다 (방금 넣은 것은 맨 뒤)
            for (let j = cc.refs.length - 2; j >= 0; j--) if (cc.refs[j].kind === kind) cc = await window.api.removeCharacterRef(cc.id, j);
          }
        }
        c = cc;
        toast(`그림 ${added}장을 넣었어요.`, 'ok');
        render();
      } catch (e) { toast(e.message, 'err'); }
    }

    async function removePicture(index) {
      try { c = await window.api.removeCharacterRef(c.id, index); render(); } catch (e) { toast(e.message, 'err'); }
    }

    // ---- 정하기 · 모습 고치기 ----
    async function lockNow(btn) {
      const name = nameIn.value.trim();
      if (!c || !c.refs.length) { setHint('그림이 한 장도 없어요. 먼저 그림을 그리거나 내 그림을 넣어 주세요.'); return; }
      if (!name) { setHint('이름을 적어 주세요.'); nameIn.focus(); return; }
      btn.disabled = true;
      try {
        await saver.flush();
        let cc = c;
        if (!hasEnglish(cc)) {
          const desc = descIn.value.trim();
          if (!desc) { setHint('"어떻게 생겼나요?" 를 적어 주세요. AI 가 그림을 그릴 때 이 설명을 읽어요.'); descIn.focus(); btn.disabled = false; return; }
          btn.textContent = '생김새를 정리하는 중…';
          const d = await window.api.describeCharacter({ name, description_ko: desc, personality_ko: cc.personality_ko || '' });
          cc = await window.api.saveCharacter({ id: cc.id, name, description_ko: desc, locked: d.locked, palette: d.palette, rules: d.rules });
        }
        cc = await window.api.lockCharacter(cc.id);
        c = cc;
        ser = await ensureSeries(c);
        toast(`✅ ${heroName(c)}${AM.josa(heroName(c), '이', '가')} 정해졌어요!`, 'ok');
        render();
        if (opts.onLocked) opts.onLocked(c, ser);
      } catch (e) {
        btn.disabled = false;
        btn.textContent = '✅ 이 모습으로 정하기';
        showError(e);
      }
    }

    async function unlockNow() {
      const ok = await AM.confirmBox('모습을 고칠까요?', '고치는 동안에는 영상에 쓸 수 없어요.\n다 고친 뒤 [✅ 이 모습으로 정하기] 를 다시 누르면 돼요.\n이미 만든 영상은 예전 모습 그대로 남아요.', '✏️ 고치기');
      if (!ok) return;
      try { c = await window.api.unlockCharacter(c.id); render(); } catch (e) { toast(e.message, 'err'); }
    }

    // ---- 그림 3장 ----
    function picSlot(kind, ref, state) {
      const j = job();
      const busy = !!(j && j.running);
      const frame = h('div', { class: 'hb-frame' });
      if (state === 'drawing') frame.append(h('div', { class: 'hb-ph' }, AM.kit.spinner(), h('span', null, '그리는 중…')));
      else if (state === 'waiting') frame.append(h('div', { class: 'hb-ph dim' }, h('span', null, '기다리는 중')));
      else if (ref) {
        const url = AM.fileUrl(ref.abs, (cur() && cur().updatedAt) || '');
        frame.append(h('img', { src: url, alt: KIND_NAME[kind] || '', onclick: () => AM.kit.viewImage(url) }));
      } else frame.append(h('div', { class: 'hb-ph dim' }, h('span', null, '아직 없어요')));
      const acts = [];
      if (!locked() && !busy) {
        if (KINDS.includes(kind)) {
          if (canAuto()) acts.push(h('button', { class: 'btn small', onclick: () => redrawKind(kind) }, ref ? '🔄 다시 그리기' : '🎨 그리기'));
          acts.push(h('button', { class: 'btn small', onclick: () => ownPictures(kind) }, '📁 내 그림으로'));
        } else if (ref) {
          acts.push(h('button', { class: 'btn small ghost danger', onclick: () => removePicture(ref.index) }, '✕ 빼기'));
        }
      }
      return h('div', { class: `hb-pic${ref ? '' : ' empty'}` },
        h('div', { class: 'hb-pic-name' }, `${KIND_ICON[kind] || ''} ${KIND_NAME[kind] || kind}`),
        frame,
        acts.length ? h('div', { class: 'hb-pic-acts' }, acts) : null);
    }

    function renderPics() {
      AM.clear(zPics);
      const cc = cur();
      const j = job();
      const running = !!(j && j.running);
      const refs = cc ? cc.refs.map((r, i) => ({ ...r, abs: cc.refsAbs[i], index: i })) : [];
      if (!refs.length && !running) return;
      const queue = running ? j.queue : [];
      const slots = KINDS.map((k) => {
        const ref = [...refs].reverse().find((r) => r.kind === k) || null;
        let state = null;
        if (running && queue.includes(k)) {
          const qi = queue.indexOf(k);
          const ci = j.current ? queue.indexOf(j.current) : -1;
          if (j.stage === 'describing') state = 'waiting'; // 생김새 정리 중: 아직 아무것도 안 그림
          else if (k === j.current) state = 'drawing';
          else if (ci >= 0 && qi > ci) state = 'waiting';
        }
        return picSlot(k, state === 'drawing' || state === 'waiting' ? null : ref, state);
      });
      const others = refs.filter((r) => !KINDS.includes(r.kind)).map((r) => picSlot('other', r, null));
      zPics.appendChild(h('div', { class: 'hb-label' }, locked() ? '이 모습으로 영상에 나와요' : '이 모습으로 영상에 나와요 · 마음에 안 들면 다시 그려요'));
      zPics.appendChild(h('div', { class: 'hb-pics' }, slots, others));
      if (!locked() && !running && refs.length < ((AM.state.info && AM.state.info.maxRefs) || 6)) {
        zPics.appendChild(h('div', { style: { marginTop: '10px' } }, h('button', { class: 'btn small ghost', onclick: () => ownPictures('other') }, '＋ 내 그림 더 넣기')));
      }
    }

    function renderProgress() {
      AM.clear(zProg);
      const j = job();
      if (!j || !j.running) return;
      const bar = AM.kit.progressBar(j.pct);
      zProg.append(h('div', { class: 'hb-prog-card' },
        h('div', { class: 'hb-prog-text' }, AM.kit.spinner(), h('b', null, j.text || '그리는 중이에요')),
        bar,
        h('div', { class: 'small muted' }, '보통 1~3분 걸려요. 다른 화면을 봐도 계속 그려요.')));
    }

    function renderActions() {
      AM.clear(zAct);
      const j = job();
      const running = !!(j && j.running);
      const cc = cur();
      const has = !!(cc && cc.refs.length);
      if (locked()) return;
      const auto = canAuto();
      const row = h('div', { class: 'hb-btns' });
      if (auto) {
        row.appendChild(h('button', {
          class: `btn ${has ? '' : (opts.preferExtra ? 'big' : 'primary big')}`, disabled: running,
          onclick: startDraw,
        }, running ? '🎨 그리는 중…' : has ? '🎨 처음부터 다시 그리기' : '🎨 AI 로 주인공 그리기'));
      } else if (!has) {
        row.appendChild(h('button', { class: 'btn primary big', disabled: running, onclick: () => ownPictures('turnaround') }, '📁 내 그림으로 정하기'));
      }
      // 연습용 주인공 같은 다른 길은, 아직 그림이 없고 그리는 중도 아닐 때만 보여 준다
      if (opts.extra && !has && !running) [].concat(opts.extra).forEach((n) => { if (n) row.appendChild(n); });
      zAct.appendChild(row);
      if (!auto) {
        zAct.appendChild(h('div', { class: 'small muted' }, '지금은 그림 담당이 "직접 돕기" 방식이라 AI 가 주인공을 바로 그릴 수 없어요. 내 그림을 넣거나, ',
          h('a', { href: '#', onclick: (e) => { e.preventDefault(); AM.go('settings'); } }, '설정'), '에서 ChatGPT 같은 자동 방식을 연결해 주세요.'));
      } else if (!has && !running) {
        zAct.appendChild(isDemoImg()
          ? h('div', { class: 'small muted' }, '지금은 연습 모드라서 그림이 가짜예요. 진짜 그림은 AI 를 연결하면 나와요.')
          : h('div', { class: 'small muted' }, '그림 3장을 그려요. 1~3분 걸려요. ',
            h('a', { href: '#', onclick: (e) => { e.preventDefault(); ownPictures('turnaround'); } }, '또는 📁 내 그림으로 정하기')));
      }
    }

    function renderLock() {
      AM.clear(zLock);
      const j = job();
      const running = !!(j && j.running);
      const cc = cur();
      if (locked()) {
        zLock.appendChild(h('div', { class: 'hb-locked' },
          h('div', { class: 'grow' }, h('b', null, `🔒 ${heroName(c)}의 모습이 정해졌어요`), h('div', { class: 'small muted' }, '어느 영상에서나 이 모습으로 나와요.')),
          opts.lockedExtra ? opts.lockedExtra(c, ser) : null,
          h('button', { class: 'btn', onclick: unlockNow }, '✏️ 모습 고치기')));
        return;
      }
      if (!c) return; // 아직 아무것도 안 적었으면 보이지 않는다
      const ready = !running && cc && cc.refs.length > 0;
      const btn = h('button', { class: 'btn primary big', disabled: !ready, onclick: (e) => lockNow(e.currentTarget) }, '✅ 이 모습으로 정하기');
      zLock.appendChild(h('div', { class: 'hb-lockrow' }, btn,
        h('span', { class: 'small muted' }, running ? '다 그린 뒤에 정할 수 있어요.'
          : !ready ? '그림이 있어야 정할 수 있어요. 먼저 그림을 그리거나 내 그림을 넣어 주세요.'
            : '정하면 어느 영상에서나 이 모습으로 나와요. 나중에 [✏️ 모습 고치기] 로 바꿀 수 있어요.')));
    }

    function render() {
      renderArt();
      renderActions();
      renderProgress();
      renderPics();
      renderLock();
      nameIn.disabled = false;
      descIn.disabled = locked();
      root.classList.toggle('is-locked', locked());
      if (opts.onRender) opts.onRender(c, ser);
    }

    // 그리는 중에 화면을 옮겼다가 돌아와도 이어서 보여 준다
    let unsub = null;
    function bindJob() {
      const j = job();
      if (!j || unsub) return;
      const f = async (jj) => {
        if (!root.isConnected) { if (unsub) unsub(); unsub = null; return; }
        if (jj.running) { renderProgress(); renderActions(); renderPics(); renderLock(); return; }
        if (unsub) unsub();
        unsub = null;
        await refreshChar();
        if (jj.error) showError(jj.error);
        else AM.clear(zNote);
        render();
      };
      j.subs.add(f);
      unsub = () => j.subs.delete(f);
    }

    root.append(
      h('label', { class: 'hb-field' }, h('span', { class: 'hb-label' }, '이름'), nameIn),
      h('label', { class: 'hb-field' }, h('span', { class: 'hb-label' }, '어떻게 생겼나요? (한국어로 적어요)'), descIn,
        h('span', { class: 'hint' }, '머리 · 옷 · 색깔을 적으면 더 닮게 그려요.')),
      hint, zArt, zAct, zNote, zProg, zPics, zLock);
    render();
    bindJob();

    return {
      el: root,
      character: () => c,
      series: () => ser,
      flush: () => saver.flush(),
      saver,
    };
  }

  // =====================================================================
  //  만들기 화면에 들어가는 '먼저 주인공을 만들어요' 카드
  // =====================================================================
  /** o: { chars, seriesList, allDemo, onReady(seriesId), onPractice() } */
  function makerCard(o) {
    const draft = (o.chars || []).find((x) => !x.isLocked) || null;
    const practiceBtn = h('button', {
      class: `btn ${o.allDemo ? 'primary big' : 'ghost'}`,
      onclick: async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        b.textContent = '☔ 만드는 중…';
        try { await o.onPractice(); } finally { b.disabled = false; b.textContent = o.allDemo ? '☔ 연습용 주인공으로 바로 구경하기' : '☔ 연습용 주인공 만들기'; }
      },
    }, o.allDemo ? '☔ 연습용 주인공으로 바로 구경하기' : '☔ 연습용 주인공 만들기');
    const b = builder({
      character: draft, series: draft ? seriesOf(draft, o.seriesList) : null, extra: practiceBtn, preferExtra: !!o.allDemo, compactArt: true,
      onLocked: (c, s) => o.onReady(s && s.id),
    });
    return h('section', { class: 'mk-card hero-maker' },
      h('div', { class: 'mk-card-head' },
        h('h2', null, '🧒 먼저 주인공을 만들어요'),
        h('p', { class: 'mk-hint' }, '영상에 나올 주인공이에요. 한 번 정해 두면 어느 영상에서나 똑같은 모습이에요.')),
      b.el);
  }

  // =====================================================================
  //  🧒 주인공 화면
  // =====================================================================
  AM.views.hero = async function hero(arg) {
    await AM.refreshSettings();
    const [chars, seriesList0] = await Promise.all([window.api.listCharacters(), window.api.listSeries()]);
    const seriesList = await ensureSeriesForLocked(chars, seriesList0); // 옛 데이터: 시리즈가 없는 잠긴 주인공에 만들어 준다
    if (arg === 'new') return editorScreen(null, chars, seriesList);
    if (arg) {
      let c = chars.find((x) => x.id === arg);
      if (!c) { const s = seriesList.find((x) => x.id === arg); if (s) c = chars.find((x) => x.id === s.characterIds[0]); }
      if (c) return editorScreen(c, chars, seriesList);
    }
    if (!chars.length) return editorScreen(null, chars, seriesList, { first: true });
    return listScreen(chars, seriesList);
  };

  function listScreen(chars, seriesList) {
    const cards = chars.map((c) => {
      const ser = seriesOf(c, seriesList);
      const thumb = thumbOf(c);
      const j = jobs.get(c.id);
      const startBtn = c.isLocked && ser ? h('button', {
        class: 'btn primary small', onclick: (e) => { e.stopPropagation(); AM.go('home', ser.id); },
      }, '🎬 이 주인공으로 만들기') : null;
      return h('div', { class: 'hero-card', role: 'button', tabindex: '0', onclick: () => AM.go('hero', c.id), onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) AM.go('hero', c.id); } },
        h('div', { class: 'hc-pic' }, thumb ? h('img', { src: AM.fileUrl(thumb, c.updatedAt), alt: '' }) : h('span', { class: 'hc-ph' }, '🧒')),
        h('div', { class: 'hc-body' },
          h('div', { class: 'hc-name' }, AM.niceTitle(heroName(c)) || '이름 없는 주인공',
            c.isLocked ? h('span', { class: 'chip ok' }, '🔒 정해짐') : h('span', { class: 'chip warn' }, j && j.running ? '🎨 그리는 중' : '✏️ 만드는 중')),
          h('div', { class: 'hc-sub' }, ser ? `지난 이야기 ${ser.episodes.length}편` : (c.isLocked ? '이야기 모음이 아직 없어요' : '아직 다 안 만들었어요')),
          startBtn));
    });
    cards.push(h('button', { class: 'hero-card hero-new', onclick: () => AM.go('hero', 'new') },
      h('span', { class: 'hn-plus' }, '＋'), h('span', { class: 'hn-t' }, '새 주인공'), h('span', { class: 'hn-d' }, '이름과 모습을 적으면 AI 가 그려 줘요.')));
    const adv = AM.kit.fold('🔧 고급', h('div', { class: 'col' },
      h('p', { class: 'muted small', style: { margin: 0 } }, '캐릭터 파일을 가져오거나, 이야기 모음(시리즈)을 자세히 고칠 때 써요.'),
      h('div', { class: 'row' },
        h('button', {
          class: 'btn', onclick: async () => {
            const c = await AM.safe(() => window.api.importCharacter());
            if (!c) return;
            if (c.isLocked) { try { await ensureSeries(c); } catch (_) { /* noop */ } }
            toast(`"${c.name}"${AM.josa(c.name, '을', '를')} 가져왔어요.`, 'ok');
            AM.go('hero', c.id);
          },
        }, '📥 캐릭터 파일 가져오기 (.amchar)'),
        h('button', { class: 'btn', onclick: () => AM.go('characters') }, '🔧 캐릭터 파일 자세히 편집'),
        h('button', { class: 'btn', onclick: () => AM.go('series') }, '📺 이야기 모음(시리즈) 설정'))));
    return h('div', { class: 'mk-wrap wide' },
      h('h1', { class: 'mk-title' }, '🧒 주인공'),
      h('p', { class: 'mk-sub' }, '영상에 나오는 주인공이에요. 한 번 정해 두면 어느 영상에서나 똑같은 모습이에요.'),
      h('div', { class: 'hero-grid' }, cards),
      h('div', { style: { marginTop: '28px' } }, adv));
  }

  function editorScreen(c0, chars, seriesList, o = {}) {
    const ser0 = c0 ? seriesOf(c0, seriesList) : null;
    const ind = AM.kit.savedIndicator();
    const title = h('h1', { class: 'mk-title' });
    const setTitle = (name) => { title.textContent = `🧒 ${name || '새 주인공'}`; };
    setTitle(heroName(c0));
    let b = null;
    const advBox = h('div');
    const renderAdv = () => {
      AM.clear(advBox);
      const c = b ? b.character() : c0;
      const s = b ? b.series() : ser0;
      if (!c) {
        advBox.appendChild(h('p', { class: 'muted small', style: { margin: 0 } }, '이름이나 모습을 적으면 여기에 더 많은 기능이 나와요.'));
        return;
      }
      advBox.appendChild(h('div', { class: 'col' },
        h('p', { class: 'muted small', style: { margin: 0 } }, 'AI 가 읽는 영어 설명, 색깔 번호, 지킬 규칙 같은 자세한 것은 아래에서 고쳐요.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: () => AM.go('characters', c.id) }, '🔧 캐릭터 파일 자세히 편집'),
          s ? h('button', { class: 'btn', onclick: () => AM.go('series', s.id) }, '📺 이야기 모음(시리즈) 설정') : null),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: () => AM.safe(async () => { const f = await window.api.exportCharacter(c.id); if (f) toast(`저장했어요: ${f}`, 'ok'); }) }, '📤 캐릭터 파일로 내보내기 (.amchar)'),
          h('button', {
            class: 'btn danger ghost', onclick: async () => {
              const list = await window.api.listSeries();
              if (await deleteHero(c, list)) AM.go('hero');
            },
          }, '🗑 이 주인공 지우기'))));
    };
    b = builder({
      character: c0, series: ser0, indicator: ind,
      onName: (n) => setTitle(n),
      onCreate: () => renderAdv(),
      onLocked: () => renderAdv(),
      // 정해진 주인공은 바로 영상 만들러 갈 수 있게
      lockedExtra: (c, s) => (s ? h('button', { class: 'btn primary', onclick: () => AM.go('home', s.id) }, '🎬 이 주인공으로 영상 만들기') : null),
    });
    renderAdv();
    return h('div', { class: 'mk-wrap' },
      h('div', { class: 'hero-top' },
        chars.length || !o.first ? h('button', { class: 'btn ghost small', onclick: () => AM.go('hero') }, '← 주인공 목록') : null,
        h('span', { class: 'grow' }), ind.el),
      title,
      h('p', { class: 'mk-sub' }, o.first
        ? '영상에 나올 첫 주인공을 만들어요. 이름과 모습을 적고 [AI 로 주인공 그리기] 를 눌러요.'
        : '이름과 모습을 적으면 AI 가 그려 줘요. 적은 것은 알아서 저장돼요.'),
      h('section', { class: 'mk-card' }, b.el),
      AM.kit.fold('🔧 고급', advBox));
  }

  // 다른 화면(만들기 · 옛 화면)이 쓰는 도우미
  AM.hero = {
    KINDS, ART_FRIENDLY, NAME_PLACEHOLDER, builder, makerCard, thumbOf, heroName,
    seriesOf, isReadySeries, readySeries, ensureSeries, ensureSeriesForLocked, deleteHero,
  };
}(window.AM));
