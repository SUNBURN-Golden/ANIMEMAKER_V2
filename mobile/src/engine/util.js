// 엔진 안쪽에서 두루 쓰는 작은 도구들 (화면·Node 어디서나 돈다)

export const pad2 = (n) => String(n).padStart(2, '0');
export const sum = (a) => a.reduce((x, y) => x + y, 0);
export const round1 = (x) => Math.round(x * 10) / 10;
/** JSON 으로 깊은 복사 (Blob 같은 것은 들어 있지 않은 기록용) */
export const clone = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));

export function abortError(msg = '그만뒀어요') {
  return typeof DOMException === 'function' ? new DOMException(msg, 'AbortError') : Object.assign(new Error(msg), { name: 'AbortError' });
}
export const isAbortError = (e) => !!e && (e.name === 'AbortError' || e.code === 20);
export function throwIfAborted(signal, msg) {
  if (signal && signal.aborted) throw abortError(msg);
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(abortError()); return; }
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
  });
}

/** 같은 열쇠로 들어온 일을 한 줄로 세워 차례로 한다 (앞 일이 실패해도 다음 일은 한다) */
export function createChains() {
  const chains = new Map();
  return function exclusive(name, fn) {
    const prev = chains.get(name) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    chains.set(name, tail);
    tail.then(() => { if (chains.get(name) === tail) chains.delete(name); });
    return run;
  };
}

/** 32비트 FNV-1a (같은 바이트 → 같은 값. 일꾼과 PC 쪽 계산을 견주는 시험용) */
export function fnv1a(bytes, h = 0x811c9dc5) {
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 공백을 하나로 줄이고 소문자로 (글 견주기용) */
export const squash = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();

/** 분 → 한국어 ('약 45분' · '약 1.5시간') */
export function fmtMinutes(min) {
  const m = Math.max(1, Math.round(min));
  return m >= 60 ? `약 ${(m / 60).toFixed(1)}시간` : `약 ${m}분`;
}

/** 초 → '3분 12초' */
export function fmtSeconds(sec) {
  const s = Math.max(0, Math.round(sec));
  return s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`;
}
