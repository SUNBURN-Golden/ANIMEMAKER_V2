// 📂 내 영상: 카드 목록 (대표 그림 · 제목 · "1화 · 3분 20초" · 상태 칩) · 눌러서 열기 · ⋯ (저장하기 · 지우기)
import { h, toast, bottomSheet, confirmBox } from '../ui.js';
import { loadRows, thumbUrl, niceTitle, statusOf, fmtSeconds, revokeThumbs, forgetThumb, buzz } from './projects-util.js';

const ASPECT_NAME = { '9:16': '세로', '16:9': '가로', '1:1': '네모', '4:5': '세로' };

function metaOf(r) {
  const parts = [];
  if (r.series) parts.push(`${r.series.episode}화`);
  if (r.durationSec) parts.push(fmtSeconds(r.durationSec));
  if (r.aspect) parts.push(ASPECT_NAME[r.aspect] || r.aspect);
  return parts.join(' · ') || '준비 중';
}
const dateOf = (t) => (t ? new Date(t).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' }) : '');

/** @returns {Promise<{el:HTMLElement, destroy:()=>void}>} */
export async function projectsScreen(app) {
  const { engine } = app;
  const rows = (await loadRows(engine)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const el = h('div', { class: 'projects' }, h('h1', { class: 'page-title' }, '📂 내 영상'));
  const cards = new Map();
  let dead = false;

  function openMenu(r) {
    let sheet;
    const row = (label, fn, cls = '') => h('button', { class: `btn menu-row ${cls}`, onclick: () => { sheet.close(); setTimeout(() => fn().catch((e) => toast(e.message || String(e), 'err')), 0); } }, label);
    sheet = bottomSheet({
      title: niceTitle(r.title, r.series),
      body: h('div', { class: 'menu-list' },
        r.hasVideo ? row('💾 저장하기', async () => {
          const blob = await engine.render.output(r.id, 'video');
          if (!blob) { toast('저장할 영상이 아직 없어요', 'warn'); return; }
          const res = await app.native.saveToGallery(blob, await engine.render.fileName(r.id, 'video'));
          toast(res.shared ? '공유 창에서 저장할 곳을 골라 주세요' : `갤러리의 "AnimeMaker V2" 폴더에 저장했어요${res.folder ? ` (${res.folder})` : ''}`, 'ok', 4500);
        }) : null,
        row('🗑 지우기', async () => {
          const busy = r.status === 'running';
          if (busy) { toast('만드는 중에는 지울 수 없어요. 먼저 멈춰 주세요.', 'warn'); return; }
          if (await confirmBox('영상을 지울까요?', `"${niceTitle(r.title, r.series)}" 와 안에 든 노래·그림·영상을 이 앱에서 지워요. (갤러리에 저장한 영상은 남아요)`, '지우기')) {
            await app.deleteProject(r.id);
            forgetThumb(r.id);
            app.render();
          }
        }, 'danger')),
    });
  }

  function card(r) {
    const st = statusOf(r);
    const thumb = h('div', { class: 'pj-thumb' }, h('span', { class: 'pj-ph' }, '🎬'));
    const chip = h('span', { class: `pj-chip st-${st.key}` }, `${st.emoji} ${st.label}`);
    thumb.appendChild(chip);
    const sub = h('div', { class: 'small muted', 'data-role': 'meta' }, metaOf(r));
    const el1 = h('article', { class: 'card pitem pj', 'data-id': r.id, 'data-status': r.status, role: 'button', tabindex: 0, onclick: () => { buzz(); app.open(r.id, { from: 'projects' }).catch((e) => toast(e.message, 'err')); } },
      thumb,
      h('div', { class: 'pj-body' },
        r.series ? h('div', { class: 'small muted' }, `${r.series.name}`) : null,
        h('div', { class: 'ptitle' }, niceTitle(r.title, r.series)), sub,
        h('div', { class: 'pj-foot' }, h('span', { class: 'small muted grow' }, dateOf(r.updatedAt)),
          h('button', { class: 'icon-btn more', 'aria-label': '더 보기', onclick: (e) => { e.stopPropagation(); openMenu(r); } }, '⋯'))));
    el1.addEventListener('keydown', (e) => { if (e.key === 'Enter') el1.click(); });
    cards.set(r.id, { el: el1, chip, sub, thumb });
    // 대표 그림은 보이는 것부터 하나씩
    thumbUrl(engine, r.id).then((u) => { if (u && !dead) thumb.style.backgroundImage = `url("${u}")`, thumb.classList.add('has-img'); }).catch(() => {});
    return el1;
  }

  if (!rows.length) {
    el.appendChild(h('div', { class: 'card empty' }, h('p', { id: 'empty-list' }, '아직 영상이 없어요 — 🎬 만들기에서 시작해요'), h('button', { class: 'btn primary big', onclick: () => app.go('home') }, '🎬 만들기로 가기')));
  } else {
    el.appendChild(h('div', { class: 'pj-list' }, rows.map(card)));
  }

  // 만드는 중이던 영상이 끝나거나 도움이 필요해지면 칩만 새로 그린다
  const off = engine.on('update', (s) => {
    const c = cards.get(s.id);
    if (!c || dead) return;
    const st = statusOf({ status: s.status });
    c.chip.className = `pj-chip st-${st.key}`;
    c.chip.textContent = `${st.emoji} ${st.label}`;
    c.el.dataset.status = s.status;
  });
  return { el, destroy() { dead = true; off(); revokeThumbs(); } };
}
