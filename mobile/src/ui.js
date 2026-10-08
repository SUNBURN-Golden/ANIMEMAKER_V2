// 화면 만들기 도우미 (작은 DOM 함수들): h, toast, 아래에서 올라오는 창(bottomSheet), 확인 창, 그만둘 수 있는 기다림 덮개(busy)

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  add(el, kids);
  return el;
}

function add(el, kids) {
  for (const c of kids) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) add(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// ───────────────────────── 알림 글 (toast) ─────────────────────────

let toastBox = null;
export function toast(msg, kind = 'ok', ms = 3200) {
  if (!toastBox) { toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.appendChild(toastBox); }
  const t = h('div', { class: `toast ${kind}` }, msg);
  while (toastBox.children.length >= 3) toastBox.firstChild.remove();
  toastBox.appendChild(t);
  setTimeout(() => t.classList.add('hide'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

// ───────────────────────── 아래에서 올라오는 창 ─────────────────────────

const openSheets = []; // 위에 있는 것이 뒤에

/**
 * 아래에서 올라오는 창. 닫기 버튼이 늘 눈에 보여요: 머리글의 ✕ 와, 버튼을 따로 안 주면 맨 아래 [닫기].
 * @param {object} o
 * @param {string} o.title
 * @param {Node|string|Array} o.body
 * @param {{label:string, kind?:string, value?:any, onClick?:()=>any}[]} [o.buttons] onClick 이 true 를 돌려주면 창을 닫지 않는다
 * @param {string} [o.closeLabel='닫기'] 닫기 버튼 글 (buttons 가 없을 때 맨 아래에 나온다. alwaysClose 면 buttons 와 함께도 나온다)
 * @param {boolean} [o.alwaysClose] buttons 가 있어도 [닫기] 를 같이 보인다
 * @param {boolean} [o.sticky] 바깥을 눌러도 안 닫힌다 (✕ 와 뒤로가기로는 닫힌다)
 * @param {boolean} [o.top] 다른 덮개(busy) 위에 띄운다 (그만둘까요? 같은 질문용)
 * @param {Function} [o.onClose]
 * @returns {{el:HTMLElement, close:(v?:any)=>void, result:Promise<any>}} result 는 누른 버튼의 value(없으면 순번), 닫기는 null
 */
export function bottomSheet({ title, body, buttons = [], closeLabel = '닫기', alwaysClose = false, sticky = false, top = false, onClose } = {}) {
  let closed = false;
  let resolveFn;
  const result = new Promise((r) => { resolveFn = r; });
  const back = h('div', { class: `sheet-back${top ? ' top' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '창' });
  const entry = { close: null, el: back };
  const close = (v = null) => {
    if (closed) return;
    closed = true;
    const i = openSheets.indexOf(entry);
    if (i >= 0) openSheets.splice(i, 1);
    back.remove();
    if (onClose) { try { onClose(); } catch (_) { /* 닫는 동안 생긴 오류는 무시 */ } }
    resolveFn(v);
  };
  entry.close = close;
  const btnEls = buttons.map((b, i) => h('button', {
    class: `btn ${b.kind || ''}`,
    onclick: async () => {
      if (b.onClick) { const keep = await b.onClick(); if (keep === true) return; }
      close(b.value !== undefined ? b.value : i);
    },
  }, b.label));
  if (closeLabel && (alwaysClose || !buttons.length)) btnEls.push(h('button', { class: 'btn sheet-close', onclick: () => close(null) }, closeLabel));
  const head = h('div', { class: 'sheet-head' },
    h('div', { class: 'sheet-title' }, title || ''),
    h('button', { class: 'icon-btn sheet-x', 'aria-label': '닫기', onclick: () => close(null) }, '✕'));
  const box = h('div', { class: 'sheet' }, head, h('div', { class: 'sheet-body' }, body), btnEls.length ? h('div', { class: 'sheet-btns' }, btnEls) : null);
  back.appendChild(box);
  back.addEventListener('click', (e) => { if (e.target === back && !sticky) close(null); });
  document.body.appendChild(back);
  openSheets.push(entry);
  return { el: back, close, result };
}

/** V1 과 같은 부름 모양: sheet(제목, 내용, 버튼들, {sticky,onClose}) → 누른 버튼의 value 를 돌려주는 약속 */
export function sheet(title, body, buttons = [{ label: '닫기' }], opts = {}) {
  return bottomSheet({ title, body, buttons, ...opts }).result;
}

/** 맨 위 창 하나 닫기 (뒤로가기 버튼용). 닫은 창이 있으면 true */
export function closeTopSheet() {
  const top = openSheets[openSheets.length - 1];
  if (!top) return false;
  top.close(null);
  return true;
}
sheet.closeTop = closeTopSheet;

export function hasOpenSheet() {
  return openSheets.length > 0;
}

export function confirmBox(title, text, ok = '확인', cancel = '취소') {
  return sheet(title, h('p', { class: 'pre' }, text), [{ label: cancel, value: false }, { label: ok, kind: 'primary', value: true }]);
}

// ───────────────────────── 기다림 덮개 (그만둘 수 있다) ─────────────────────────

let busyCount_ = 0;
/** 지금 떠 있는 기다림 덮개 수 (뒤로가기가 덮개 뒤 화면을 움직이지 않게 하려고) */
export function busyCount() {
  return busyCount_;
}

/**
 * 오래 걸리는 일 동안 덮개.
 *   busy('만드는 중…')
 *   busy({ message, progress: 0~1, detail, onCancel, cancelLabel: '그만두기' })
 * onCancel 을 주면 [그만두기] 버튼이 생기고, 누르면 signal 이 abort 되고 onCancel() 이 불린다 (덮개는 일이 끝나 done() 할 때 닫힌다).
 * @returns {{ set(msg?:string, frac?:number|null):void, setDetail(t:string):void, done():void, el:HTMLElement, signal:AbortSignal, cancelled:boolean }}
 */
export function busy(opts) {
  const o = typeof opts === 'string' ? { message: opts } : (opts || {});
  const controller = new AbortController();
  const label = h('div', { class: 'busy-msg' }, o.message || '');
  const detail = h('div', { class: 'busy-detail muted small' }, o.detail || '');
  const bar = h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: { width: '0%' } }));
  const state = { cancelled: false };
  let stopBtn = null;
  if (typeof o.onCancel === 'function') {
    stopBtn = h('button', {
      class: 'btn busy-stop',
      onclick: () => {
        if (state.cancelled) return;
        state.cancelled = true;
        stopBtn.disabled = true;
        stopBtn.textContent = '그만두는 중…';
        controller.abort();
        try { o.onCancel(); } catch (_) { /* 그만두기 중 오류는 무시 */ }
      },
    }, o.cancelLabel || '그만두기');
  }
  const el = h('div', { class: 'busy', role: 'alertdialog', 'aria-live': 'polite' }, h('div', { class: 'busy-box' }, h('div', { class: 'spinner' }), label, detail, bar, stopBtn));
  document.body.appendChild(el);
  busyCount_++;
  let finished = false;
  const setBar = (frac) => {
    if (frac == null || Number.isNaN(frac)) return;
    const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
    bar.style.display = 'block';
    bar.firstChild.style.width = `${pct}%`;
    bar.setAttribute('aria-valuenow', String(pct));
  };
  if (o.progress != null) setBar(o.progress);
  return {
    el,
    signal: controller.signal,
    get cancelled() { return state.cancelled; },
    set(m, frac) {
      if (m) label.textContent = m;
      setBar(frac);
    },
    setDetail(t) { detail.textContent = t || ''; },
    done() {
      if (finished) return;
      finished = true;
      busyCount_ = Math.max(0, busyCount_ - 1);
      el.remove();
    },
  };
}

// ───────────────────────── 일 지킴이 화면 연결 (jobs.js 와 짝) ─────────────────────────

/**
 * jobs.js 의 setJobUi() 에 넣는 화면 부품:
 *  - 덮개가 필요한 일(modal)이면 busy() 를 띄우고 진행을 보여 준다. [그만두기] 는 그 일을 취소한다.
 *  - 뒤로가기 때 "그만둘까요, 계속 할까요?" 를 묻는다 (안전한 쪽인 [계속 하기] 가 눈에 띄는 버튼).
 */
export function createJobUi() {
  return {
    begin(job) {
      if (!job.modal) return null;
      const b = busy({ message: job.title || '일하는 중…', progress: job.progress, onCancel: job.cancelable ? () => job.cancel() : null });
      return {
        update(j) { b.set(j.message, j.progress); },
        cancelling() { b.set('그만두는 중…'); },
        end() { b.done(); },
      };
    },
    ask({ title, text, stopLabel, keepLabel }) {
      return bottomSheet({
        title,
        body: h('p', { class: 'pre' }, text),
        buttons: [{ label: stopLabel, kind: 'danger', value: true }, { label: keepLabel, kind: 'primary', value: false }],
        sticky: true,
        top: true,
        closeLabel: null,
      }).result.then((v) => v === true);
    },
    dismissAsk() { closeTopSheet(); },
  };
}

// ───────────────────────── 파일 고르기 · 작은 도구 ─────────────────────────

/** 파일 고르기 (accept 예: 'audio/*'). 고르지 않고 닫으면 null — 안드로이드 WebView 는 취소 이벤트를 안 주는 일이 있어서, 창으로 돌아오고 2.5초 뒤에도 고른 게 없으면 null 로 끝낸다 */
export function pickFile(accept) {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, style: { display: 'none' } });
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onFocus);
      inp.remove();
      resolve(v);
    };
    const onFocus = () => setTimeout(() => finish(inp.files && inp.files[0] ? inp.files[0] : null), 2500);
    inp.addEventListener('change', () => finish(inp.files && inp.files[0] ? inp.files[0] : null));
    inp.addEventListener('cancel', () => finish(null));
    document.querySelectorAll('input.am-pick').forEach((x) => x.remove());
    inp.classList.add('am-pick');
    document.body.appendChild(inp);
    window.addEventListener('focus', onFocus);
    inp.click();
  });
}

export function fmtSize(n) {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)}GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(n / 1024))}KB`;
}

export function objectUrl(blob) {
  return blob ? URL.createObjectURL(blob) : '';
}
