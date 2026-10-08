'use strict';
/* 📂 내 영상: 만든 영상 카드 모음 */
(function (AM) {
  const { h } = AM;
  AM.views = AM.views || {};

  const durCache = new Map(); // 영상 id → 길이(초). 목록에는 없어서 필요할 때 한 번씩 알아 온다
  let live = null; // 지금 열려 있는 목록 화면 { grid, fill }

  function statusOf(p) {
    const snap = AM.state.projects.get(p.id);
    if (snap && snap.running) return snap.waiting ? 'waiting' : (snap.status === 'limited' ? 'limited' : 'running');
    const st = snap ? snap.status : p.status;
    // 앱이 꺼진 채로 남은 '만드는 중' 기록은 멈춘 것
    return st === 'running' || st === 'limited' ? 'stopped' : st;
  }

  const metaOf = (p) => [p.series ? `${p.series.episode}화` : null, AM.fmtDur(durCache.get(p.id))].filter(Boolean).join(' · ');

  function card(p, useVideo = true) {
    const st = statusOf(p);
    const title = AM.niceTitle(p.title) || '이름 없는 영상';
    const busy = ['running', 'waiting', 'limited'].includes(st);
    const thumb = h('div', { class: 'pj-thumb' });
    const fallback = () => {
      AM.clear(thumb);
      if (p.thumb) thumb.style.backgroundImage = `url("${AM.fileUrl(p.thumb, p.updatedAt)}")`;
      else thumb.appendChild(h('span', { class: 'pj-ph' }, '🎬'));
      thumb.appendChild(chip);
    };
    const chip = h('span', { class: `status-pill st-${st} pj-chip` }, AM.STATUS_LABEL[st] || st);
    if (st === 'done' && p.final && useVideo) {
      const v = h('video', { class: 'pj-vid', src: `${AM.fileUrl(p.final, p.updatedAt)}#t=1`, preload: 'metadata', playsinline: true });
      v.muted = true;
      v.addEventListener('error', fallback);
      thumb.append(v, chip);
    } else fallback();
    const meta = h('div', { class: 'pj-meta' }, metaOf(p));
    const menu = AM.kit.menu(() => [
      { label: '📂 이 영상 폴더 열기', onClick: () => window.api.openPath(AM.joinPath(AM.state.info.paths.projects, p.id)) },
      {
        label: busy ? '🗑 지우기 (만드는 중에는 안 돼요)' : '🗑 지우기', danger: true, disabled: busy,
        onClick: async () => {
          if (!await AM.confirmBox('영상을 지울까요?', `"${title}" 영상과 작업 폴더를 통째로 지워요.\n되돌릴 수 없어요.`, '🗑 지우기', 'danger')) return;
          if (await AM.safe(() => window.api.deleteProject(p.id), '지웠어요')) AM.go('projects');
        },
      },
    ]);
    const el = h('div', { class: 'pj-card', role: 'button', tabindex: '0', dataset: { id: p.id }, onclick: () => AM.go('project', p.id), onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) AM.go('project', p.id); } },
      thumb,
      h('div', { class: 'pj-body' },
        p.series ? h('div', { class: 'pj-series' }, `${p.series.emoji || '📺'} ${AM.niceTitle(p.series.name)}`) : null,
        h('div', { class: 'pj-title' }, title),
        meta,
        h('div', { class: 'pj-foot' }, h('span', { class: 'small muted grow' }, AM.fmtDate(p.updatedAt)), menu)));
    el.setMeta = () => { meta.textContent = metaOf(p); };
    return el;
  }

  /** 길이는 목록에 없어서, 화면에 보이는 영상부터 하나씩 알아 와서 채운다 */
  async function fillDurations(list, cards) {
    for (const p of list.slice(0, 40)) {
      if (durCache.has(p.id)) continue;
      const snap = AM.state.projects.get(p.id);
      let d = snap && snap.song && snap.song.duration;
      if (!d) {
        try { const g = await window.api.getProject(p.id); d = g && g.song && g.song.duration; } catch (_) { d = 0; }
      }
      durCache.set(p.id, d || 0);
      const el = cards.get(p.id);
      if (el && el.isConnected) el.setMeta();
    }
  }

  AM.views.projects = async function projects() {
    const list = await window.api.listProjects();
    const grid = h('div', { class: 'pj-grid' });
    const head = h('div', { class: 'pj-head' },
      h('div', { class: 'grow' }, h('h1', { class: 'mk-title' }, '📂 내 영상'), h('p', { class: 'mk-sub', style: { marginBottom: 0 } }, '만든 영상이 여기에 모여요.')),
      h('button', { class: 'btn', onclick: () => window.api.openPath(AM.state.info.paths.projects) }, '📂 저장 폴더 열기'));
    const root = h('div', { class: 'mk-wrap wide' }, head, grid);

    const cards = new Map();
    const fill = (items) => {
      AM.clear(grid);
      cards.clear();
      if (!items.length) {
        grid.className = 'pj-empty';
        grid.appendChild(h('div', { class: 'mk-card pj-empty-card' },
          h('div', { class: 'pj-empty-ico' }, '🎬'),
          h('h2', null, '아직 만든 영상이 없어요'),
          h('p', { class: 'mk-hint' }, '노래 한 곡이면 첫 영상을 만들 수 있어요.'),
          h('button', { class: 'btn primary big', onclick: () => AM.go('home') }, '🎬 첫 영상 만들기')));
        return;
      }
      grid.className = 'pj-grid';
      let videos = 0; // 영상 그림은 24개까지만 (많으면 무거워져서 나머지는 첫 그림으로)
      for (const p of items) { const el = card(p, p.final && videos++ < 24); cards.set(p.id, el); grid.appendChild(el); }
      fillDurations(items, cards);
    };
    fill(list);
    live = { fill, list };
    return root;
  };

  // 만드는 중이던 영상이 끝나거나 도움이 필요해지면 카드 모양(상태)만 새로 그린다
  AM.views.projectsUpdate = function projectsUpdate(snap, prev) {
    if (!live) return;
    const changed = !prev || prev.status !== snap.status || !!prev.running !== !!snap.running || !!prev.waiting !== !!snap.waiting;
    if (!changed) return;
    window.api.listProjects().then((list) => { if (live && AM.state.view === 'projects') live.fill(list); }).catch(() => {});
  };
}(window.AM));
