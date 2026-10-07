'use strict';
/* 내 작업 목록 */
(function (AM) {
  const { h } = AM;
  AM.views = AM.views || {};

  AM.views.projects = async function projects() {
    const list = await window.api.listProjects();
    if (!list.length) {
      return h('div', null,
        h('h1', { class: 'page-title' }, '📂 내 작업'),
        h('p', { class: 'page-sub' }, '만든 에피소드가 여기에 모여요.'),
        h('div', { class: 'section', style: { textAlign: 'center' } },
          h('p', null, '아직 만든 작업이 없어요.'),
          h('button', { class: 'btn primary', onclick: () => AM.go('home') }, '🎬 첫 에피소드 만들기')));
    }
    return h('div', null,
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('h1', { class: 'page-title' }, '📂 내 작업'), h('p', { class: 'page-sub' }, `작업 ${list.length}개 · 저장 위치: ${AM.state.info.paths.projects}`)),
        h('button', { class: 'btn', onclick: () => window.api.openPath(AM.state.info.paths.projects) }, '📂 저장 폴더 열기')),
      h('div', { class: 'proj-grid' }, list.map((p) => {
        const live = AM.state.projects.get(p.id);
        const status = live && live.running ? (live.waiting ? 'waiting' : 'running') : p.status;
        return h('div', { class: 'proj-card', onclick: () => AM.go('project', p.id) },
          h('div', { class: 'pt', style: p.thumb ? { backgroundImage: `url("${AM.fileUrl(p.thumb)}")` } : null },
            h('span', { class: `status-pill st-${status}`, style: { position: 'absolute', top: '8px', left: '8px' } }, AM.STATUS_LABEL[status] || status)),
          h('div', { class: 'pb' },
            p.series ? h('div', { class: 'small', style: { color: 'var(--primary)', fontWeight: 700 } }, `${p.series.emoji || '📺'} ${p.series.name} EP${p.series.episode}`) : null,
            h('div', { class: 'pn' }, p.title),
            h('div', { class: 'small muted' }, p.topic),
            h('div', { class: 'row small muted', style: { marginTop: '6px' } },
              h('span', { class: 'grow' }, AM.fmtDate(p.updatedAt)),
              h('button', {
                class: 'btn small ghost danger',
                onclick: async (e) => {
                  e.stopPropagation();
                  if (await AM.confirmBox('작업 삭제', `"${p.title}" 작업 폴더를 통째로 지울까요? 되돌릴 수 없어요.`, '삭제', 'danger')) {
                    if (await AM.safe(() => window.api.deleteProject(p.id), '삭제했어요')) AM.go('projects');
                  }
                },
              }, '삭제'))));
      })));
  };
}(window.AM));
