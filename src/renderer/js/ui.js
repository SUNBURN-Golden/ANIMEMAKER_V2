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
    const close = () => { back.remove(); if (opts.onClose) opts.onClose(); };
    const box = h('div', { class: 'modal', style: opts.width ? { width: opts.width } : null },
      h('h2', null, title),
      content,
      h('div', { class: 'foot' }, buttons.map((b) => h('button', {
        class: `btn ${b.kind || ''}`,
        onclick: async () => { if (b.onClick) { const keep = await b.onClick(close); if (keep === true) return; } close(); },
      }, b.label))));
    back.appendChild(box);
    if (!opts.sticky) back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
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

  // ---- 단계별 담당 AI 선택지 ----
  const PROVIDERS = {
    text: [
      { id: 'codex', label: 'ChatGPT 구독 (Codex CLI) · 자동', mode: 'auto', agent: 'codex', short: 'ChatGPT' },
      { id: 'grok', label: 'SuperGrok 구독 (grok CLI) · 자동', mode: 'auto', agent: 'grok', short: 'Grok' },
      { id: 'agy', label: 'Google AI 구독 - Gemini (Antigravity CLI) · 자동', mode: 'auto', agent: 'agy', short: 'Gemini' },
      { id: 'claude', label: 'Claude 구독 (Claude Code) · 자동', mode: 'auto', agent: 'claude', short: 'Claude' },
      { id: 'demo', label: '체험 모드 (AI 없이 예시로)', mode: 'demo', short: '체험' },
    ],
    image: [
      { id: 'codex', label: 'ChatGPT 그림 (Codex CLI) · 자동 · 기준 그림 첨부 ✔', mode: 'auto', agent: 'codex', short: 'ChatGPT' },
      { id: 'grok', label: 'Grok Imagine (grok CLI) · 자동', mode: 'auto', agent: 'grok', short: 'Grok' },
      { id: 'agy', label: 'Gemini 나노바나나 (Antigravity CLI) · 자동 · 실험적', mode: 'auto', agent: 'agy', short: 'Gemini' },
      { id: 'bot:gemini', label: 'Gemini 웹 · 자동 클릭 (실험적)', mode: 'bot', site: 'gemini', short: 'Gemini 웹' },
      { id: 'bot:grok', label: 'Grok Imagine 웹 · 자동 클릭 (실험적)', mode: 'bot', site: 'grok', short: 'Grok 웹' },
      { id: 'bot:chatgpt', label: 'ChatGPT 웹 · 자동 클릭 (실험적)', mode: 'bot', site: 'chatgpt', short: 'ChatGPT 웹' },
      { id: 'helper', label: '도우미 (웹에서 직접 그리고 다운로드)', mode: 'helper', short: '도우미' },
      { id: 'demo', label: '체험 모드 (가짜 그림)', mode: 'demo', short: '체험' },
    ],
  };
  const MODE_LABEL = { auto: '자동', bot: '자동 클릭', helper: '도우미', file: '직접', demo: '체험' };
  const MODE_CHIP = { auto: 'ok', bot: 'pri', helper: 'warn', file: 'warn', demo: '' };
  function providerInfo(kind, id) {
    return (PROVIDERS[kind] || []).find((p) => p.id === id) || { id, label: id, mode: 'auto', short: id };
  }

  const PC = () => ({ short: '내 PC (무료)', mode: 'auto' });
  const STEP_META = [
    { id: 'music', icon: '🎵', label: '노래·가사', who: PC },
    { id: 'plan', icon: '📝', label: '기획', who: (pv) => providerInfo('text', pv.text) },
    { id: 'timing', icon: '⏱️', label: '컷 나누기', who: PC },
    { id: 'xsheet', icon: '📋', label: '타임시트', who: (pv) => ({ ...providerInfo('text', pv.text), short: `${providerInfo('text', pv.text).short} + 내 PC 검사` }) },
    { id: 'drawings', icon: '🎨', label: '그림', who: (pv) => providerInfo('image', pv.image) },
    { id: 'render', icon: '🎬', label: '렌더링', who: PC },
    { id: 'subtitles', icon: '💬', label: '자막', who: PC },
  ];

  // 카메라 움직임 · 효과 이름 (아이도 알아보게)
  const CAMERA_LABEL = {
    hold: '📷 가만히', pan_left: '⬅ 왼쪽으로 훑기', pan_right: '➡ 오른쪽으로 훑기', pan_up: '⬆ 위로 훑기', pan_down: '⬇ 아래로 훑기',
    zoom_in: '🔍 다가가기', zoom_out: '🔭 멀어지기', truck_in: '🚀 확 다가가기', truck_out: '🌌 확 멀어지기', shake: '💥 흔들기',
  };
  const FX_LABEL = { fade_in: '🌅 서서히 밝게', fade_out: '🌙 서서히 어둡게', flash: '⚡ 번쩍', sparkle: '✨ 반짝반짝', shake: '💥 쿵', dissolve_in: '🌫 스르륵' };

  const STATUS_LABEL = {
    idle: '대기', running: '만드는 중', done: '완성', error: '오류', limited: '한도 대기', stopped: '중지됨', waiting: '기다리는 중',
  };

  /** 색 견본 칩 */
  function swatch(hex, title) {
    return h('span', { class: 'swatch', title: title || hex, style: { background: hex } });
  }

  Object.assign(AM, {
    h, clear, toast, modal, confirmBox, fileUrl, joinPath, fmtSec, fmtDate, safe, swatch,
    PROVIDERS, MODE_LABEL, MODE_CHIP, providerInfo, STEP_META, STATUS_LABEL, CAMERA_LABEL, FX_LABEL,
  });
}(window.AM));
