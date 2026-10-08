// '내 폰 점검' 카드 (홈·설정 화면에 붙는다). 점검 결과는 저장소 meta('probe') 에 남겨 영상 만들기 쪽이 읽을 수 있게 한다.
import { h, clear, fmtSize } from './ui.js';
import { loadProbe, friendlyProblems, summarize } from './probe.js';
import * as db from './db.js';
import * as N from './native.js';

const yn = (v) => (v ? '✔' : '✘');

/** 이번 실행에서 한 점검 결과 (화면을 오갈 때마다 다시 점검하지 않으려고) */
let lastResult = null;

function facts(r) {
  const e = r.env || {};
  const f = r.features || {};
  const c = r.codecs || { video: {}, audio: {} };
  const s = r.storage;
  const rows = [
    ['앱', `AnimeMaker V2 ${e.appVersion || ''}`.trim()],
    ['안드로이드 / WebView', `${e.sdkInt ? `안드로이드 SDK ${e.sdkInt}` : '(안드로이드 아님)'} / ${e.webViewVersion || (e.chromeMajor ? `Chrome ${e.chromeMajor}` : '알 수 없음')}`],
    ['영상 부품', `H.264 ${yn(c.video.avc)} · VP9 ${yn(c.video.vp9)}`],
    ['소리 부품', `AAC ${yn(c.audio.aac)} · Opus ${yn(c.audio.opus)}`],
    ['그림 기능', `OffscreenCanvas ${yn(f.offscreenCanvas)} · ImageBitmap ${yn(f.createImageBitmap)} · WebGL2 ${yn(f.webgl2)}`],
    ['빠른 계산', `SIMD ${yn(f.wasmSimd)} · WebGPU ${yn(f.webgpu)} · 여러 갈래 ${yn(e.crossOriginIsolated)}`],
    ['메모리 / 계산 장치', `${e.deviceMemory ? `약 ${e.deviceMemory}GB` : '알 수 없음'} / ${e.cores ? `${e.cores}개` : '알 수 없음'}`],
    ['저장 공간', s && s.quota ? `쓴 것 ${fmtSize(s.usage)} / 쓸 수 있는 한도 ${fmtSize(s.quota)}${s.persisted === true ? ' · 보호됨' : (s.persisted === false ? ' · 보호 안 됨' : '')}` : '알 수 없음'],
  ];
  return h('div', { class: 'probe-facts' }, rows.map(([k, v]) => h('div', { class: 'probe-row' }, h('span', { class: 'probe-k' }, k), h('span', { class: 'probe-v' }, v))));
}

/**
 * 내 폰 점검 카드. 만들어지면 바로 점검을 시작하고, [다시 점검] 으로 다시 한다.
 * @param {{run?:Function}} [o] run: 점검 함수 바꿔 끼우기 (시험용)
 */
export function probeCard({ run } = {}) {
  // 처음에는 저장해 둔 결과(일주일 안, 같은 앱·WebView 버전)를 쓰고, [다시 점검] 은 새로 점검한다
  const doProbe = run || (async (force) => loadProbe({ store: db, appInfo: await N.getAppInfo(), force }));
  const body = h('div', { class: 'probe-body' });
  const again = h('button', { class: 'btn small', 'data-act': 'reprobe', onclick: () => start(true) }, '🔄 다시 점검');
  const card = h('section', { class: 'card probe-card', 'data-state': 'loading', 'aria-label': '내 폰 점검' },
    h('h3', null, '📱 내 폰 점검'),
    body,
    h('div', { class: 'row' }, again));

  function show(r) {
    clear(body);
    const sum = summarize(r);
    const problems = friendlyProblems(r);
    body.appendChild(h('div', { class: `probe-head ${sum.level}` }, h('span', { class: 'probe-emoji' }, sum.emoji), h('b', null, sum.headline)));
    if (problems.length) {
      body.appendChild(h('ul', { class: 'probe-list' }, problems.map((p) => h('li', { class: `probe-item ${p.level}`, 'data-id': p.id },
        h('span', { class: 'probe-badge' }, p.level === 'bad' ? '❌' : (p.level === 'warn' ? '⚠️' : '💡')), h('span', null, p.text)))));
    }
    body.appendChild(h('details', { class: 'probe-more' }, h('summary', null, '자세히 보기'), facts(r)));
    card.dataset.state = 'done';
    card.dataset.level = sum.level;
  }

  async function start(force = true) {
    if (!force && lastResult) { show(lastResult); return; }
    card.dataset.state = 'loading';
    again.disabled = true;
    clear(body);
    body.appendChild(h('p', { class: 'muted' }, '점검하는 중이에요…'));
    try {
      const r = await doProbe(force);
      lastResult = r;
      show(r);
    } catch (e) {
      clear(body);
      card.dataset.state = 'error';
      body.appendChild(h('p', { class: 'muted' }, `점검하지 못했어요 (${e && e.message ? e.message : e})`));
    } finally {
      again.disabled = false;
    }
  }

  start(false);
  return card;
}
