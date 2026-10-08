'use strict';
/* 워크플로우(영상 스타일 틀) 만들기 · 고치기 */
(function (AM) {
  const { h, toast } = AM;
  AM.views = AM.views || {};
  let selected = null;

  function field(label, input, hint) {
    return h('label', { class: 'field' }, label, input, hint ? h('span', { class: 'hint' }, hint) : null);
  }
  function sel(value, opts) {
    const s = h('select', null, opts.map(([v, l]) => h('option', { value: v }, l)));
    s.value = String(value);
    return s;
  }
  function num(value, min, max, step = 1) { return h('input', { type: 'number', value, min, max, step }); }
  function txt(value) { return h('input', { type: 'text', value: value || '' }); }
  function area(value, rows = 3) { const t = h('textarea', { rows }); t.value = value || ''; return t; }
  function chk(value, label) {
    const c = h('input', { type: 'checkbox', checked: !!value });
    return { el: h('label', { class: 'check' }, c, label), get: () => c.checked };
  }

  AM.views.workflows = async function workflows() {
    const list = await window.api.listWorkflows();
    AM.state.workflows = list;
    if (!selected || !list.find((w) => w.id === selected)) selected = list[0].id;
    const wf = list.find((w) => w.id === selected);
    const listEl = h('div', { class: 'wf-list' },
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          const base = list.find((w) => w.id === selected) || list[0];
          const copy = { ...base, id: null, builtin: false, name: `${base.name} (내 버전)`, emoji: '⭐' };
          const saved = await AM.safe(() => window.api.saveWorkflow(copy), '새 워크플로우를 만들었어요');
          if (saved) { selected = saved.id; AM.go('workflows'); }
        },
      }, '＋ 지금 것을 복사해서 새로 만들기'),
      list.map((w) => h('button', { class: `wf-item ${w.id === selected ? 'sel' : ''}`, onclick: () => { selected = w.id; AM.go('workflows'); } },
        h('div', { style: { fontWeight: 700 } }, `${w.emoji || '🎞️'} ${w.name}`),
        h('div', { class: 'small muted' }, w.builtin ? '기본 제공 (복사해서 수정)' : '내 워크플로우'))));
    return h('div', null,
      h('div', { class: 'row', style: { marginBottom: '8px' } }, h('button', { class: 'btn small', onclick: () => AM.go('settings') }, '← 설정으로')),
      h('h1', { class: 'page-title' }, '🧩 영상 규칙 (워크플로우)'),
      h('p', { class: 'page-sub' }, '영상 규칙은 "어떤 틀로 만들지" 정해 두는 규칙 묶음이에요 (화면 비율, 컷 수, 그림 장수, 필름 느낌, 자막). 주인공과 그림 느낌은 이야기 모음(시리즈)이 정해요. 가로·세로·네모 같은 쉬운 선택은 [🎬 만들기] 의 [바꾸기] 에서 해요.'),
      h('div', { class: 'wf-layout' }, listEl, editor(wf)));
  };

  function editor(wf) {
    const ro = !!wf.builtin;
    const fin = wf.finish || {};
    const f = {
      emoji: txt(wf.emoji), name: txt(wf.name), description: area(wf.description, 2),
      aspect: sel(wf.aspect, [['16:9', '가로 16:9 (유튜브)'], ['9:16', '세로 9:16 (쇼츠·릴스·틱톡)'], ['1:1', '정사각 1:1'], ['4:5', '세로 4:5 (인스타 피드)']]),
      quality: sel(wf.quality, [['480p', '480p (빠른 미리보기)'], ['720p', '720p (기본)'], ['1080p', '1080p (선명, 느림)']]),
      visualStyle: area(wf.visualStyle, 3),
      minClips: num(wf.minClips, 1, 60), maxClips: num(wf.maxClips, 1, 80),
      minClipSec: num(wf.minClipSec, 1, 30, 0.5), maxClipSec: num(wf.maxClipSec, 1, 30, 0.5),
      pace: sel(wf.pace, [['fast', '빠르게 (짧은 컷 위주)'], ['normal', '보통'], ['slow', '느리게 (긴 컷 위주)']]),
      drawingBudget: num(wf.drawingBudget || 0, 0, 3000),
      motionMode: sel(wf.motionMode || 'ghibli', [['ghibli', '🌿 지브리식 (추천)'], ['full', '🏃 전체 움직임'], ['limited', '🖼 리미티드 (그림 적게)']]),
      keyRate: sel(Number(wf.keyRate) === 8 ? 8 : 6, [[6, '1초에 6장 (추천)'], [8, '1초에 8장 (더 부드럽게)']]),
      inbetween: sel(wf.inbetween || 'auto', [['auto', '자동 (추천)'], ['rife', 'RIFE'], ['ffmpeg', 'ffmpeg'], ['off', '끄기']]),
      layers: chk(wf.layers !== false, '배경과 인물을 따로 그려서 겹치기 (인물은 초록색 배경으로 그린 뒤 PC 가 빼요. 카메라가 움직이면 배경이 조금 덜 움직여서 깊이감이 생겨요)'),
      transitionStyle: sel(wf.transitionStyle, [['mixed', '다양하게 (컷 + 특수 전환)'], ['cuts', '컷 위주 (박자에 딱딱)'], ['smooth', '부드럽게 (페이드·디졸브)']]),
      boil: chk(fin.boil, '살짝 떨리는 손그림 느낌 (2프레임마다 아주 작은 흔들림)'),
      grain: chk(fin.grain, '필름 입자 (오래된 극장 필름처럼 자글자글)'),
      vignette: chk(fin.vignette, '가장자리 살짝 어둡게 (비네트)'),
      warm: chk(fin.warm, '따뜻한 색감'),
      paper: chk(fin.paper, '종이 질감 (그림책처럼)'),
      subOn: chk(wf.subtitles.enabled, '하단에 가사 자막 넣기 (영상을 다 만든 뒤에 입혀요)'),
      subSize: num(wf.subtitles.sizePct, 2, 10, 0.1), subColor: sel(wf.subtitles.color, [['white', '흰색 + 검은 테두리'], ['yellow', '노란색 + 검은 테두리']]),
      subBox: chk(wf.subtitles.box, '글자 뒤에 반투명 검은 상자'), subMargin: num(wf.subtitles.marginPct, 2, 40, 0.5),
      extraInstructions: area(wf.extraInstructions, 3),
      lyricSyncPause: chk(wf.lyricSyncPause !== false, '가사에 시간 정보가 없으면, 컷을 나누기 전에 멈추고 "탭으로 가사 맞추기" 할 기회 주기 (권장)'),
      reviewAfterPlan: chk(wf.reviewAfterPlan, '기획안(이야기)이 나오면 멈추고 확인하기'),
      reviewAfterTiming: chk(wf.reviewAfterTiming, '컷 나누기가 끝나면 멈추고 확인하기'),
      reviewBeforeDrawings: chk(wf.reviewBeforeDrawings !== false, '그림을 그리기 전에 멈추고 "그림 약 몇 장, 몇 시간" 예상을 보여 주기 (권장)'),
    };
    const presets = AM.state.info.artPresets || [];
    const stylePresets = h('div', { class: 'presets' }, presets.map(([l, v]) => h('span', { class: 'chip click', onclick: () => { f.visualStyle.value = v; } }, l)));

    const collect = () => ({
      ...wf,
      emoji: f.emoji.value.trim() || '🎞️', name: f.name.value.trim() || '이름 없는 워크플로우', description: f.description.value.trim(),
      aspect: f.aspect.value, quality: f.quality.value, visualStyle: f.visualStyle.value.trim(),
      minClips: clamp(f.minClips.value, 1, 60), maxClips: Math.max(clamp(f.minClips.value, 1, 60), clamp(f.maxClips.value, 1, 80)),
      minClipSec: clamp(f.minClipSec.value, 1, 30), maxClipSec: Math.max(clamp(f.minClipSec.value, 1, 30), clamp(f.maxClipSec.value, 1, 30)),
      pace: f.pace.value, transitionStyle: f.transitionStyle.value, drawingBudget: clamp(f.drawingBudget.value, 0, 3000),
      motionMode: f.motionMode.value, keyRate: Number(f.keyRate.value) === 8 ? 8 : 6, inbetween: f.inbetween.value, layers: f.layers.get(),
      finish: { boil: f.boil.get(), grain: f.grain.get(), vignette: f.vignette.get(), warm: f.warm.get(), paper: f.paper.get() },
      subtitles: { enabled: f.subOn.get(), sizePct: Number(f.subSize.value), color: f.subColor.value, box: f.subBox.get(), marginPct: Number(f.subMargin.value) },
      extraInstructions: f.extraInstructions.value.trim(),
      lyricSyncPause: f.lyricSyncPause.get(), reviewAfterPlan: f.reviewAfterPlan.get(), reviewAfterTiming: f.reviewAfterTiming.get(), reviewBeforeDrawings: f.reviewBeforeDrawings.get(),
    });

    const save = async () => {
      const data = collect();
      const saved = await AM.safe(() => window.api.saveWorkflow(data), '저장했어요');
      if (saved) { selected = saved.id; AM.go('workflows'); }
    };
    const del = async () => {
      if (!await AM.confirmBox('삭제', `"${wf.name}" 워크플로우를 지울까요?`, '삭제', 'danger')) return;
      await AM.safe(() => window.api.deleteWorkflow(wf.id), '삭제했어요');
      selected = null;
      AM.go('workflows');
    };

    const box = h('div', null,
      ro ? h('div', { class: 'notice info' }, '기본 제공 워크플로우는 직접 고칠 수 없어요. 왼쪽 위 [＋ 지금 것을 복사해서 새로 만들기] 를 눌러 내 버전을 만든 뒤 고치세요.') : null,
      h('div', { class: 'section' }, h('h3', null, '기본 정보'),
        h('div', { class: 'grid3' }, field('아이콘(이모지)', f.emoji), field('이름', f.name), field('화면 비율', f.aspect)),
        h('div', { class: 'grid2', style: { marginTop: '12px' } }, field('설명', f.description), field('화질', f.quality, '480p 는 확인용으로 빨리 만들 때, 720p 가 기본이에요.'))),
      h('div', { class: 'section' }, h('h3', null, '✂ 컷 나누기 · 🎨 그림 장수'),
        h('p', { class: 'desc' }, '영상 길이 = 올린 노래 길이예요. 컷 수는 3~4분 노래 기준이고, 3분보다 짧은 노래는 길이에 맞춰 줄여요. 컷 경계는 박자 위에만 놓이고, 구간(벌스→후렴)이 바뀌는 곳·가사 줄 시작·마디 첫 박을 우선해요.'),
        h('div', { class: 'grid3' }, field('컷 개수 최소', f.minClips), field('컷 개수 최대', f.maxClips), field('컷 템포', f.pace)),
        h('div', { class: 'grid3', style: { marginTop: '12px' } }, field('컷 최소 길이(초)', f.minClipSec), field('컷 최대 길이(초)', f.maxClipSec), field('화면전환 스타일', f.transitionStyle)),
        h('div', { class: 'grid3', style: { marginTop: '12px' } }, field('그림 장수 예산 (전체)', f.drawingBudget, '0 = 움직임 방식에 맞춰 자동. 숫자를 적으면 그보다 많이 그리지 않아요 (구독 사용량을 지키는 상한선).'))),
      h('div', { class: 'section' }, h('h3', null, '🏃 움직임 방식'),
        h('p', { class: 'desc' }, '지브리식은 노래의 40~50% (후렴·신나는 장면)만 AI 가 1초에 6~8장씩 그리고, 그 사이 그림은 내 PC 가 무료로 만들어 부드럽게 이어요. 나머지 장면은 멈춘 그림 + 천천히 움직이는 카메라예요. 그림이 많을수록 시간이 오래 걸리고 구독 사용량도 많이 써요. 그리기 전에 "그림 약 몇 장, 몇 시간" 을 먼저 보여 줘요.'),
        h('div', { class: 'grid3' }, field('움직임 방식', f.motionMode, '지브리식: 신나는 부분만 많이 움직여요. 전체: 모든 장면이 움직여요(그림이 아주 많이 필요). 리미티드: 그림 몇 장 + 카메라.'),
          field('움직이는 장면의 그림 수', f.keyRate, '6장 = 그림 한 장을 4프레임, 8장 = 3프레임 (더 부드럽지만 그림이 더 필요). 리미티드에서는 쓰지 않아요.'),
          field('사이 그림 (내 PC)', f.inbetween, '자동 = RIFE 가 되면 RIFE, 안 되면 ffmpeg. RIFE 는 설치 파일에 들어 있고, 그래픽카드가 없으면 CPU 로 해서 느릴 수 있어요. 끄기 = 열쇠 그림만 넘기기.')),
        h('div', { style: { marginTop: '10px' } }, f.layers.el)),
      h('div', { class: 'section' }, h('h3', null, '🎞 손그림 필름 느낌 (영상을 만들 때 입혀요)'),
        h('div', { class: 'col' }, f.boil.el, f.grain.el, f.vignette.el, f.warm.el, f.paper.el)),
      h('div', { class: 'section' }, h('h3', null, '💬 가사 자막'),
        f.subOn.el,
        h('div', { class: 'grid3', style: { marginTop: '10px' } }, field('글자 크기 (화면 높이의 %)', f.subSize), field('색', f.subColor), field('아래 여백 (%)', f.subMargin)),
        h('div', { style: { marginTop: '10px' } }, f.subBox.el)),
      h('div', { class: 'section' }, h('h3', null, '🛠 확인 단계 · 고급'),
        f.lyricSyncPause.el, f.reviewAfterPlan.el, f.reviewAfterTiming.el, f.reviewBeforeDrawings.el,
        h('details', { class: 'adv', style: { marginTop: '12px' } }, h('summary', null, '고급: 시리즈 없이 만들 때의 그림체 · 추가 지시'),
          h('div', { class: 'col', style: { marginTop: '10px' } },
            field('그림체 (영어, 시리즈가 있으면 시리즈 그림체를 따라요)', f.visualStyle), stylePresets,
            field('이야기·그림 순서표 AI 에게 추가로 전할 말', f.extraInstructions, '예) 마지막 장면은 꼭 해피엔딩 / 대사는 넣지 말 것 / 비 오는 장면을 많이')))),
      h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
        ro ? null : h('button', { class: 'btn danger', onclick: del }, '삭제'),
        ro ? null : h('button', { class: 'btn primary big', onclick: save }, '💾 저장')));
    if (ro) box.querySelectorAll('input, textarea, select').forEach((el) => { el.disabled = true; });
    if (ro) box.querySelectorAll('.presets .chip').forEach((el) => { el.style.pointerEvents = 'none'; el.style.opacity = '0.5'; });
    return box;
  }

  function clamp(v, a, b) { const n = Number(v); return Math.max(a, Math.min(b, Number.isFinite(n) ? n : a)); }
}(window.AM));
