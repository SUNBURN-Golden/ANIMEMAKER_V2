'use strict';
/* kit: 여러 화면이 같이 쓰는 부품 (AM.kit)
 *  - fold(summary, content, {open, lazy, onToggle, class})   접는 칸 (<details>)
 *  - pickCard({emoji, visual, title, desc, tag, foot, selected, onclick, disabled})   크고 누르면 고르는 칸
 *  - stickyBar(children, {class})                              화면 아래에 붙어 있는 행동 줄 (#main 안에 넣어 쓴다)
 *  - autosave(fn, {delay, onState, indicator})                  멈추면 저장 + "저장됨 ✓" 표시 (.el)
 *  - savedIndicator()                                           여러 곳이 같이 쓰는 "저장됨 ✓" 표시 {el, set}
 *  - progressBar(pct)                                           진행 막대 (.set(pct), null 이면 빙글빙글)
 *  - sheet(title, content, buttons, opts)                       AM.modal 을 부드럽게 감싼 작은 창
 *  - menu(items, {label})                                       ⋯ 메뉴 단추
 *  - field(label, input, hint) · spinner() · viewImage(src) · friendlyError(msg) · flushAll()
 */
(function (AM) {
  const { h } = AM;

  /** 접는 칸. summary: 글자 또는 Node. content: Node(여러 개 가능). opts.lazy: 처음 열릴 때 만들어 넣는 함수 */
  function fold(summary, content, opts = {}) {
    const body = h('div', { class: 'fold-body' });
    const d = h('details', { class: `fold${opts.class ? ` ${opts.class}` : ''}` },
      h('summary', null, h('span', { class: 'fold-sum' }, summary), h('span', { class: 'fold-chev', 'aria-hidden': 'true' }, '›')),
      body);
    let filled = false;
    const fill = () => {
      if (filled) return;
      filled = true;
      const node = opts.lazy ? opts.lazy() : content;
      if (node) [].concat(node).forEach((n) => { if (n) body.appendChild(n); });
    };
    d.addEventListener('toggle', () => { if (d.open) fill(); if (opts.onToggle) opts.onToggle(d.open); });
    if (opts.open) { d.open = true; fill(); }
    d.fill = fill;
    // 안쪽을 다시 만든다 (lazy 로 만든 내용이 낡았을 때). 열려 있으면 바로, 닫혀 있으면 다음에 열 때
    d.refill = () => { while (body.firstChild) body.removeChild(body.firstChild); filled = false; if (d.open) fill(); };
    return d;
  }

  /** 크게 눌러 고르는 칸. visual 을 주면 이모지 대신 그 Node 를 위에 보여 준다 (예: 영상 모양 그림) */
  function pickCard(o = {}) {
    const el = h('button', {
      type: 'button',
      class: `card-pick${o.selected ? ' sel' : ''}${o.class ? ` ${o.class}` : ''}`,
      disabled: !!o.disabled,
      'aria-pressed': o.selected ? 'true' : 'false',
      onclick: o.onclick,
    },
    o.visual || (o.emoji ? h('span', { class: 'cp-emoji' }, o.emoji) : null),
    h('span', { class: 'cp-title' }, o.title, o.tag ? h('span', { class: 'cp-tag' }, o.tag) : null),
    o.desc ? h('span', { class: 'cp-desc' }, o.desc) : null,
    o.foot ? h('span', { class: 'cp-foot' }, o.foot) : null,
    h('span', { class: 'cp-check', 'aria-hidden': 'true' }, '✓'));
    el.setSelected = (v) => { el.classList.toggle('sel', !!v); el.setAttribute('aria-pressed', v ? 'true' : 'false'); };
    return el;
  }

  /** 화면 아래에 붙는 행동 줄. 화면에서 #main 안(어디든)에 넣으면 된다. 화면을 바꾸면 #main 과 함께 사라진다. */
  function stickyBar(children, opts = {}) {
    return h('div', { class: `bar-sticky${opts.class ? ` ${opts.class}` : ''}` }, children);
  }

  /** 진행 막대. pct 가 null 이면 '기다리는 중' 움직임 */
  function progressBar(pct, opts = {}) {
    const bar = h('i');
    const el = h('div', { class: `pbar${opts.slim ? ' slim' : ''}`, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, bar);
    el.set = (p) => {
      if (p == null || Number.isNaN(Number(p))) {
        el.classList.add('indet');
        bar.style.width = '';
        el.removeAttribute('aria-valuenow');
      } else {
        el.classList.remove('indet');
        const v = Math.max(0, Math.min(100, Number(p)));
        bar.style.width = `${v}%`;
        el.setAttribute('aria-valuenow', String(Math.round(v)));
      }
    };
    el.set(pct);
    return el;
  }

  function spinner() { return h('span', { class: 'spin', 'aria-hidden': 'true' }); }

  // ---- 자동 저장 ----
  const STATE_TEXT = { idle: '', dirty: '저장 준비…', saving: '저장 중…', saved: '저장됨 ✓', error: '저장하지 못했어요' };

  /** 여러 저장이 함께 쓰는 "저장됨 ✓" 표시 */
  function savedIndicator() {
    const el = h('span', { class: 'saved-ind', 'aria-live': 'polite', dataset: { state: 'idle' } });
    let fadeT = null;
    const set = (state, msg) => {
      el.dataset.state = state;
      el.textContent = STATE_TEXT[state] || '';
      if (state === 'error' && msg) el.title = msg; else el.removeAttribute('title');
      clearTimeout(fadeT);
      el.classList.remove('faded');
      if (state === 'saved') fadeT = setTimeout(() => el.classList.add('faded'), 2500);
    };
    return { el, set };
  }

  const pendingSavers = new Set();

  /**
   * 입력이 멎으면(delay ms) fn 을 부르는 자동 저장.
   *   const save = AM.kit.autosave(async () => {...}, { delay: 700 });
   *   input.oninput = save;  header.append(save.el);   // save() = 저장 예약, save.flush() = 지금 저장(기다릴 수 있음)
   * opts.indicator 에 savedIndicator() 를 주면 그 표시를 쓴다. onState(state, msg): idle|dirty|saving|saved|error
   */
  function autosave(fn, opts = {}) {
    const delay = opts.delay == null ? 700 : opts.delay;
    const ind = opts.indicator || savedIndicator();
    let timer = null;
    let running = null;
    let again = false;
    let state = 'idle';
    const set = (s, msg) => { state = s; ind.set(s, msg); if (opts.onState) opts.onState(s, msg); };
    async function run() {
      timer = null;
      if (running) { again = true; return running; }
      set('saving');
      running = (async () => {
        try { await fn(); set('saved'); } catch (e) { set('error', e && e.message ? e.message : String(e)); }
      })();
      const mine = running;
      await mine;
      running = null;
      if (again) { again = false; await run(); }
      if (!timer && !running) pendingSavers.delete(api); // eslint-disable-line no-use-before-define
      return undefined;
    }
    function api() {
      set('dirty');
      clearTimeout(timer);
      pendingSavers.add(api);
      timer = setTimeout(run, delay);
    }
    api.flush = async () => {
      if (timer) { clearTimeout(timer); return run(); }
      if (running) return running;
      return undefined;
    };
    api.cancel = () => { clearTimeout(timer); timer = null; pendingSavers.delete(api); };
    api.el = ind.el;
    api.trigger = api;
    Object.defineProperty(api, 'state', { get: () => state });
    return api;
  }

  /** 화면을 옮기기 전에, 아직 저장 안 된 자동 저장을 모두 끝낸다 (AM.go 가 부른다) */
  function flushAll() {
    if (!pendingSavers.size) return null; // 기다릴 것이 없으면 null (바로 다음 일을 하면 된다)
    return Promise.all([...pendingSavers].map((s) => s.flush())).then(() => undefined);
  }

  // ---- 작은 창 (시트) ----
  /** AM.modal 을 부드럽게 감싼 창. buttons 를 안 주면 [닫기] 하나. 반환: {close, box} */
  function sheet(title, content, buttons, opts = {}) {
    const btns = buttons === undefined ? [{ label: '닫기', kind: 'primary' }] : buttons;
    // 제목과 아래 단추는 그대로 두고 가운데만 스크롤되게
    const m = AM.modal(title, h('div', { class: 'sheet-scroll' }, content), btns, { ...opts, width: opts.width || 'min(680px, 94vw)' });
    m.box.classList.add('sheet');
    m.box.insertBefore(h('button', { type: 'button', class: 'sheet-x', title: '닫기', 'aria-label': '닫기', onclick: m.close }, '✕'), m.box.firstChild);
    return m;
  }

  /** 그림 크게 보기 */
  function viewImage(src, title = '크게 보기') {
    return sheet(title, h('img', { class: 'view-img', src }), undefined, { width: 'min(980px, 94vw)' });
  }

  // ---- ⋯ 메뉴 ----
  /** items: [{label, onClick, danger, disabled, hidden}] 또는 그것을 돌려주는 함수 */
  function menu(items, o = {}) {
    const btn = h('button', {
      type: 'button', class: `btn ghost kmenu-btn${o.class ? ` ${o.class}` : ''}`, title: o.title || '더 보기', 'aria-label': o.title || '더 보기', 'aria-haspopup': 'menu',
    }, o.label || '⋯');
    let pop = null;
    function close() {
      if (!pop) return;
      pop.remove();
      pop = null;
      document.removeEventListener('mousedown', onDoc, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', close);
      const m = document.getElementById('main');
      if (m) m.removeEventListener('scroll', close);
    }
    function onDoc(e) { if (pop && !pop.contains(e.target) && !btn.contains(e.target)) close(); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    function open() {
      const list = (typeof items === 'function' ? items() : items).filter((i) => i && !i.hidden);
      pop = h('div', { class: 'kmenu-pop', role: 'menu' }, list.map((i) => h('button', {
        type: 'button', role: 'menuitem', class: `kmenu-item${i.danger ? ' danger' : ''}`, disabled: !!i.disabled,
        onclick: (e) => { e.stopPropagation(); close(); if (i.onClick) i.onClick(); },
      }, i.label)));
      document.body.appendChild(pop);
      const r = btn.getBoundingClientRect();
      const pr = pop.getBoundingClientRect();
      let left = r.right - pr.width;
      if (left < 8) left = 8;
      let top = r.bottom + 6;
      if (top + pr.height > window.innerHeight - 8) top = Math.max(8, r.top - pr.height - 6);
      pop.style.left = `${left}px`;
      pop.style.top = `${top}px`;
      document.addEventListener('mousedown', onDoc, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', close);
      const m = document.getElementById('main');
      if (m) m.addEventListener('scroll', close, { passive: true });
    }
    btn.addEventListener('click', (e) => { e.stopPropagation(); if (pop) close(); else open(); });
    return btn;
  }

  /** 이름표 + 입력칸 + (작은 설명) */
  function field(label, input, hint) {
    return h('label', { class: 'field' }, label, input, hint ? h('span', { class: 'hint' }, hint) : null);
  }

  /** 오류 글을 아이도 알아볼 말로 (모르는 글은 그대로) */
  function friendlyError(msg) {
    const t = String(msg == null ? '' : msg);
    if (/찾지 못했|not installed|ENOENT|설치되어 있지/.test(t)) return { kind: 'install', text: '연결 프로그램이 아직 없어요. 설정에서 [설치하기] 를 눌러 주세요.' };
    if (/로그인|log ?in|unauthor|auth|credential|401|403/i.test(t)) return { kind: 'login', text: '로그인이 안 된 것 같아요. 설정에서 [로그인하기] 를 눌러 주세요.' };
    if (/한도|limit|quota|rate|usage/i.test(t)) return { kind: 'limit', text: '오늘 쓸 수 있는 만큼 다 썼어요. 조금 쉬었다가 이어서 해요.' };
    return { kind: 'other', text: t };
  }

  AM.kit = { fold, pickCard, stickyBar, progressBar, spinner, savedIndicator, autosave, flushAll, sheet, viewImage, menu, field, friendlyError };
}(window.AM));
