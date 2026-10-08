'use strict';
/* 화면 공통 도우미 */
window.AM = window.AM || {};

(function (AM) {
  /** 안전한 DOM 생성: 문자열은 항상 textContent 로 들어간다 */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked') el.checked = !!v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

  function toast(msg, kind) {
    const t = h('div', { class: `toast ${kind || ''}` }, msg);
    document.getElementById('toast-root').appendChild(t);
    setTimeout(() => t.remove(), kind === 'err' ? 7000 : 3500);
  }

  /** 모달. content 는 Node, buttons: [{label, kind, onClick(close) }] */
  function modal(title, content, buttons = [{ label: '닫기' }], opts = {}) {
    const root = document.getElementById('modal-root');
    const back = h('div', { class: 'modal-back' });
    let closed = false;
    const onKey = (e) => {
      if (e.key !== 'Escape' || opts.sticky) return;
      const all = root.querySelectorAll('.modal-back');
      if (all[all.length - 1] === back) close();
    };
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      back.remove();
      if (opts.onClose) opts.onClose();
    }
    const box = h('div', { class: 'modal', style: opts.width ? { width: opts.width } : null },
      h('h2', null, title),
      content,
      h('div', { class: 'foot' }, buttons.map((b) => h('button', {
        class: `btn ${b.kind || ''}`,
        onclick: async () => { if (b.onClick) { const keep = await b.onClick(close); if (keep === true) return; } close(); },
      }, b.label))));
    back.appendChild(box);
    if (!opts.sticky) back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    document.addEventListener('keydown', onKey);
    root.appendChild(back);
    return { close, box };
  }

  function confirmBox(title, text, okLabel = '확인', kind = 'primary') {
    return new Promise((resolve) => {
      modal(title, h('p', { style: { whiteSpace: 'pre-wrap' } }, text), [
        { label: '취소', onClick: () => resolve(false) },
        { label: okLabel, kind, onClick: () => resolve(true) },
      ], { onClose: () => resolve(false) });
    });
  }

  function fileUrl(p, v) {
    if (!p) return '';
    const norm = String(p).replace(/\\/g, '/');
    const segs = norm.split('/');
    const enc = segs.map((s, i) => (i === 0 && /^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s))).join('/');
    const url = norm.startsWith('/') ? `file://${enc}` : `file:///${enc}`;
    return v ? `${url}?v=${v}` : url;
  }

  function joinPath(dir, rel) {
    if (!rel) return null;
    const sep = dir.includes('\\') ? '\\' : '/';
    return dir.replace(/[\\/]+$/, '') + sep + rel.replace(/\//g, sep);
  }

  function fmtSec(t) {
    if (t == null || Number.isNaN(t)) return '-';
    const m = Math.floor(t / 60);
    const s = (t % 60).toFixed(1).padStart(4, '0');
    return `${m}:${s}`;
  }

  function fmtDate(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  async function safe(fn, okMsg) {
    try {
      const r = await fn();
      if (okMsg) toast(okMsg, 'ok');
      return r;
    } catch (e) {
      toast(e.message || String(e), 'err');
      return undefined;
    }
  }

  // ---- 단계별 담당 AI 선택지 (화면에는 쉬운 이름만 보여 준다) ----
  const PROVIDERS = {
    text: [
      { id: 'codex', label: 'ChatGPT 구독 · 자동', mode: 'auto', agent: 'codex', short: 'ChatGPT' },
      { id: 'grok', label: 'SuperGrok 구독 · 자동', mode: 'auto', agent: 'grok', short: 'SuperGrok' },
      { id: 'agy', label: 'Google AI(Gemini) 구독 · 자동', mode: 'auto', agent: 'agy', short: 'Gemini' },
      { id: 'claude', label: 'Claude 구독 · 자동', mode: 'auto', agent: 'claude', short: 'Claude' },
      { id: 'demo', label: '연습 모드 (AI 없이 예시로)', mode: 'demo', short: '연습 모드' },
    ],
    image: [
      { id: 'codex', label: 'ChatGPT 그림 · 자동 · 주인공 그림도 함께 보내요', mode: 'auto', agent: 'codex', short: 'ChatGPT' },
      { id: 'grok', label: 'SuperGrok 그림 · 자동', mode: 'auto', agent: 'grok', short: 'SuperGrok' },
      { id: 'agy', label: 'Gemini 그림 · 자동 · 실험적', mode: 'auto', agent: 'agy', short: 'Gemini' },
      { id: 'bot:gemini', label: 'Gemini 웹 · 자동 클릭 (실험적)', mode: 'bot', site: 'gemini', short: 'Gemini 웹' },
      { id: 'bot:grok', label: 'Grok 웹 · 자동 클릭 (실험적)', mode: 'bot', site: 'grok', short: 'Grok 웹' },
      { id: 'bot:chatgpt', label: 'ChatGPT 웹 · 자동 클릭 (실험적)', mode: 'bot', site: 'chatgpt', short: 'ChatGPT 웹' },
      { id: 'helper', label: '내가 직접 돕기 (웹에서 그리고 내려받기)', mode: 'helper', short: '직접 돕기' },
      { id: 'demo', label: '연습 모드 (가짜 그림)', mode: 'demo', short: '연습 그림' },
    ],
  };
  const MODE_LABEL = { auto: '자동', bot: '자동 클릭', helper: '직접 돕기', file: '직접', demo: '연습' };
  const MODE_CHIP = { auto: 'ok', bot: 'pri', helper: 'warn', file: 'warn', demo: '' };
  function providerInfo(kind, id) {
    return (PROVIDERS[kind] || []).find((p) => p.id === id) || { id, label: id, mode: 'auto', short: id };
  }

  /** 연습 모드(가짜 그림) 인지: 이야기·그림 담당이 모두 demo */
  function isAllDemo(s) {
    const pv = (s && s.providers) || {};
    return pv.text === 'demo' && pv.image === 'demo';
  }

  /** 구독 AI 카드에 쓰는 쉬운 이름 · 설명 (연결 프로그램 이름은 화면에 내지 않는다) */
  const AGENT_UI = {
    codex: {
      emoji: '💬', name: 'ChatGPT', who: 'ChatGPT 유료 구독 (Plus · Pro 등)', does: '이야기도 그림도 그려요', star: true, tool: 'ChatGPT 연결 프로그램',
      loginHint: '검은 창이 뜨면 "Sign in with ChatGPT" 를 골라 로그인해요. 다른 방식은 고르지 마세요.',
    },
    grok: {
      emoji: '🚀', name: 'SuperGrok', who: 'SuperGrok 또는 X Premium+ 구독', does: '이야기도 그림도 그려요', tool: 'SuperGrok 연결 프로그램',
      loginHint: '브라우저가 열리면 SuperGrok 계정으로 로그인하고, 끝나면 창을 닫아요.',
    },
    agy: {
      emoji: '✨', name: 'Google AI (Gemini)', who: 'Google AI Pro · Ultra 구독', does: '이야기는 자동 · 그림은 직접 받아야 해요', tool: 'Google AI 연결 프로그램',
      loginHint: '창이 뜨면 구독 중인 구글 계정으로 로그인하고, 끝나면 창을 닫아요.',
      note: '그림은 한 장씩 직접 받아야 해요 (30~150번쯤).',
    },
    claude: {
      emoji: '🧡', name: 'Claude', who: 'Claude Pro · Max 구독', does: '이야기만 써요 · 그림은 다른 구독이 필요해요', tool: 'Claude 연결 프로그램',
      loginHint: '"Claude 구독 계정" 으로 로그인해요.',
    },
  };

  const PC = () => ({ short: '내 PC (무료)', mode: 'auto' });
  // label: 짧은 이름 / title: 한 줄 설명 / doing: 만드는 중에 보여 줄 쉬운 문장 / chip: 사이드바 칩
  const STEP_META = [
    { id: 'music', icon: '🎵', label: '노래·가사', title: '노래 듣기', doing: '🎵 노래를 듣고 박자를 살피고 있어요', chip: '노래 듣는 중', who: PC },
    { id: 'plan', icon: '📝', label: '이야기', title: '이야기 짓기', doing: '📝 이야기를 짓고 있어요', chip: '이야기 짓는 중', who: (pv) => providerInfo('text', pv.text) },
    { id: 'timing', icon: '⏱️', label: '장면 나누기', title: '장면 나누기', doing: '✂️ 노래에 맞춰 장면을 나누고 있어요', chip: '장면 나누는 중', who: PC },
    { id: 'xsheet', icon: '📋', label: '그림 순서표', title: '그림 순서 정하기', doing: '📋 어떤 그림이 필요한지 정하고 있어요', chip: '그림 순서 정하는 중', who: (pv) => ({ ...providerInfo('text', pv.text), short: `${providerInfo('text', pv.text).short} + 내 PC 검사` }) },
    { id: 'drawings', icon: '🎨', label: '그림', title: '그림 그리기', doing: '🎨 그림을 그리고 있어요', chip: '그림 그리는 중', who: (pv) => providerInfo('image', pv.image) },
    { id: 'render', icon: '🎬', label: '영상 만들기', title: '영상으로 이어 붙이기', doing: '🎬 그림을 이어서 영상을 만들고 있어요', chip: '영상 만드는 중', who: PC },
    { id: 'subtitles', icon: '💬', label: '가사 자막', title: '가사 자막 넣기', doing: '💬 가사를 영상에 넣고 있어요', chip: '자막 넣는 중', who: PC },
  ];

  // 카메라 움직임 · 효과 이름 (아이도 알아보게)
  const CAMERA_LABEL = {
    hold: '📷 가만히', pan_left: '⬅ 왼쪽으로 훑기', pan_right: '➡ 오른쪽으로 훑기', pan_up: '⬆ 위로 훑기', pan_down: '⬇ 아래로 훑기',
    zoom_in: '🔍 다가가기', zoom_out: '🔭 멀어지기', truck_in: '🚀 확 다가가기', truck_out: '🌌 확 멀어지기', shake: '💥 흔들기',
  };
  const FX_LABEL = { fade_in: '🌅 서서히 밝게', fade_out: '🌙 서서히 어둡게', flash: '⚡ 번쩍', sparkle: '✨ 반짝반짝', shake: '💥 쿵', dissolve_in: '🌫 스르륵' };

  // 영상 모양 · 움직임 이름 (만들기 화면과 다른 화면이 같이 쓴다)
  const SHAPE_LABEL = { wide: '가로 영상', tall: '세로 영상', square: '네모 영상' };
  const MOTION_LABEL = { ghibli: '신나는 부분만 움직여요', limited: '조금만 움직여요', full: '계속 움직여요' };

  const STATUS_LABEL = {
    idle: '준비 중', running: '만드는 중', done: '완성', error: '문제가 생겼어요', limited: '잠깐 쉬는 중', stopped: '멈춤', waiting: '도움이 필요해요',
  };

  /** 받침 있으면 first, 없으면 second: josa('하루', '이', '가') → '가' (이/가 · 은/는 · 을/를 · 와/과 에 쓴다) */
  function josa(word, withFinal, noFinal) {
    const t = String(word == null ? '' : word).trim();
    const c = t.charCodeAt(t.length - 1);
    if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 ? withFinal : noFinal;
    return noFinal;
  }

  /** 초 → "3분 20초" */
  function fmtDur(sec) {
    const t = Math.round(Number(sec));
    if (!Number.isFinite(t) || t <= 0) return '';
    const m = Math.floor(t / 60);
    const r = t % 60;
    if (!m) return `${r}초`;
    return r ? `${m}분 ${r}초` : `${m}분`;
  }

  /** "하루 이야기 EP3" → "하루 이야기 3화", "(체험)" → "(연습)" (옛 말은 화면에 내지 않는다) */
  function niceTitle(t) {
    return String(t == null ? '' : t).replace(/(^|\s)EP\s*(\d+)(?![\w])/gi, '$1$2화').replace(/\(체험\)/g, '(연습)').trim();
  }

  /** "그림은 ChatGPT" 같은 한 마디 */
  function imageWho(settings) {
    const pv = (settings && settings.providers) || {};
    const i = providerInfo('image', pv.image);
    return i.mode === 'demo' ? '연습 그림(가짜)' : i.short;
  }

  /** 색 견본 칩 */
  function swatch(hex, title) {
    return h('span', { class: 'swatch', title: title || hex, style: { background: hex } });
  }

  Object.assign(AM, {
    h, clear, toast, modal, confirmBox, fileUrl, joinPath, fmtSec, fmtDate, safe, swatch,
    PROVIDERS, MODE_LABEL, MODE_CHIP, providerInfo, isAllDemo, AGENT_UI, STEP_META, STATUS_LABEL, CAMERA_LABEL, FX_LABEL,
    SHAPE_LABEL, MOTION_LABEL, fmtDur, niceTitle, imageWho, josa,
  });
}(window.AM));
