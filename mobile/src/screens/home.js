// 🎬 만들기 (노래 · 가사 · 이야기 + 아래 고정 바 [바꾸기] [▶ 만들기]) + 처음 켰을 때 환영 화면 + 연습 영상 시작
import { h, clear, toast, bottomSheet, pickFile, busy, confirmBox } from '../ui.js';
import * as db from '../db.js';
import { L, DD } from '../engine/shared.js';
import { friendlyProblems } from '../probe.js';
import { loadHeroes, readyHeroes } from './hero.js';
import { renderTrayList, ensureNotify } from './handoff.js';
import { fmtMinutes, fmtSeconds, buzz, put } from './projects-util.js';
import { REQUEST_MINUTES } from '../engine/index.js';

// ───────────────────────── 고르는 것들 ─────────────────────────

export const ASPECTS = [
  { id: '9:16', name: '세로', emoji: '📱', note: '쇼츠·릴스' },
  { id: '16:9', name: '가로', emoji: '🖥', note: '유튜브' },
  { id: '1:1', name: '네모', emoji: '⬜', note: '인스타' },
];
/** 움직임: 가볍게(추천) / 조금 / 많이. wf = 엔진 만들기 방식, motion = 이 영상만 바꿀 움직임 방식 */
export const PRESETS = [
  { id: 'light', wf: 'phone-lite', motion: null, emoji: '🌿', name: '가볍게', tag: '추천', note: '신나는 부분만 움직여요 · 가장 빨라요', pics: { '9:16': [4, 30], '16:9': [4, 34], '1:1': [4, 32] } },
  { id: 'little', wf: 'phone-lite', motion: 'limited', emoji: '🖼', name: '조금', note: '거의 안 움직여요 · 더 빨리 끝나요', pics: { '9:16': [4, 22], '16:9': [4, 24], '1:1': [4, 23] } },
  { id: 'lots', wf: 'phone-ghibli', motion: null, emoji: '🏃', name: '많이', note: '계속 움직여요', warn: '그림을 100장 넘게 부탁해야 해서 몇 시간이 걸려요. 처음이라면 [가볍게] 를 권해요.', pics: { '9:16': [24, 100], '16:9': [20, 90], '1:1': [22, 95] } },
];
const IDEAS = ['비 오는 날 우산 하나로 만난 친구', '밤하늘 별을 따라 떠나는 모험', '처음 학교에 가는 아침', '바닷가에서 잃어버린 모자를 찾는 하루'];

/** 만들기 전에 보여 주는 어림 (그림 순서표를 짜고 나면 진짜 숫자를 다시 보여 줘요). 부탁 한 번 1~1.5분은 가정 */
export function presetEstimate(presetId, aspect) {
  const p = PRESETS.find((x) => x.id === presetId) || PRESETS[0];
  const [bg, cels] = p.pics[aspect] || p.pics['9:16'];
  const requests = bg + cels + 2;
  return { pictures: bg + cels, requests, minutes: Math.ceil(requests * REQUEST_MINUTES.mid) };
}

// ───────────────────────── 쓰던 내용 (탭을 옮기거나 앱이 꺼져도 남는다) ─────────────────────────

const DEFAULT_DRAFT = { songName: '', songType: '', songSize: 0, songSeconds: 0, lyrics: '', lyricsName: '', topic: '', preset: 'light', aspect: '9:16', seriesId: null, practice: null };
let draft = null;
let songFile = null;
let saveT = 0;

export async function loadDraft() {
  if (draft) return draft;
  let saved = {};
  try { saved = (await db.getMeta('draft', {})) || {}; } catch (_) { saved = {}; }
  draft = { ...DEFAULT_DRAFT, ...saved };
  if (draft.songName) {
    try { songFile = await db.getFile('draft/song'); } catch (_) { songFile = null; }
    if (!songFile) { draft.songName = ''; draft.songSeconds = 0; }
  }
  return draft;
}
const persist = () => { clearTimeout(saveT); saveT = setTimeout(() => db.setMeta('draft', draft).catch(() => {}), 250); };
export const getDraft = () => draft;
export function resetDraftAfterCreate() {
  draft = { ...draft, songName: '', songType: '', songSize: 0, songSeconds: 0, lyrics: '', lyricsName: '', topic: '' };
  songFile = null;
  db.deleteFiles('draft/').catch(() => {});
  persist();
}

// ───────────────────────── 연습 영상 ─────────────────────────

/** 연습용 주인공 + 연습용 노래로 연습 영상을 하나 만든다 → 작품 id (시작은 화면이: app.open(id,{autorun:true})) */
export async function startPractice(app, { seconds, aspect } = {}) {
  const { engine } = app;
  const seriesId = await engine.demo.ensureSeries();
  const sec = seconds || app.practiceSeconds || 60;
  const songBlob = await engine.services.demo.song({ seconds: sec, bpm: 120 });
  return engine.projects.create({
    workflow: 'demo', aspect: aspect || '9:16', quality: app.settings.quality, providers: 'demo', seriesId,
    songBlob, songName: '연습용 노래.wav', lyricsText: DD.DEMO_LYRICS,
  });
}

// ───────────────────────── 처음 켰을 때 ─────────────────────────

function probeNote(app, onAck) {
  const r = app.probe;
  if (!r || !r.decision || r.decision.level === 'good') return null;
  const bad = r.decision.level === 'bad';
  const list = friendlyProblems(r).filter((p) => p.level !== 'info');
  const sig = `${r.decision.level}:${list.map((p) => p.id).join(',')}`;
  if (!bad && app.prefs.probeAck === sig) return null; // [그래도 해 볼게요] 를 이미 눌렀다 (같은 안내는 다시 안 띄운다)
  const card = h('div', { class: `card gate ${bad ? 'bad' : 'warn'}`, id: 'probe-gate' },
    h('b', null, bad ? '❌ 이 폰에서는 영상을 만들기 어려워요' : '⚠️ 알아 두면 좋은 게 있어요'),
    h('ul', { class: 'probe-list' }, list.map((p) => h('li', { class: `probe-item ${p.level}` }, h('span', null, p.level === 'bad' ? '❌' : '⚠️'), h('span', null, p.text)))));
  if (!bad) card.appendChild(h('button', { class: 'btn small', id: 'probe-ack', onclick: () => { card.remove(); app.setPref('probeAck', sig); onAck(); } }, '그래도 해 볼게요'));
  return card;
}

export function welcomeScreen(app) {
  const blocked = !!(app.probe && app.probe.decision && !app.probe.decision.canMakeVideo);
  const el = h('div', { class: 'welcome' },
    h('div', { class: 'hero' },
      h('img', { src: 'icon.png', alt: '' }),
      h('div', null, h('h1', null, 'AnimeMaker V2'), h('p', null, '노래만 있으면 옛날 손그림 애니 느낌의 뮤직비디오를 폰에서 만들어요.'))),
    probeNote(app, () => {}),
    h('button', { class: 'btn primary big', id: 'btn-tour', disabled: blocked, onclick: async () => {
      buzz();
      const b = busy('연습 영상을 준비하는 중…');
      try {
        await app.setPref('welcomed', true);
        const id = await startPractice(app);
        app.open(id, { from: 'home', autorun: true });
      } catch (e) { toast(e.message, 'err'); } finally { b.done(); }
    } }, '🎬 먼저 구경하기 (무료 · 연습 모드)'),
    h('button', { class: 'btn big', id: 'btn-connect', onclick: async () => { buzz(); await app.setPref('welcomed', true); app.go('settings', { focus: 'subs' }); } }, '🔌 내 AI 앱 연결하기'),
    h('p', { class: 'note' }, '연습 모드는 가짜 그림으로 만드는 흐름을 보여 줘요. 돈은 들지 않고 2~4분이면 끝나요. 💳 진짜 그림은 이미 구독 중인 ChatGPT · Gemini · Grok · Claude 앱에 부탁해서 받아요. 따로 돈을 받거나 API 키를 쓰지 않아요.'));
  return { el, destroy() {} };
}

// ───────────────────────── 만들기 화면 ─────────────────────────

export async function homeScreen(app, params = {}) {
  const { engine } = app;
  await loadDraft();
  if (params.seriesId) { draft.seriesId = params.seriesId; persist(); }
  const heroes = readyHeroes(await loadHeroes());
  const hero = heroes.find((x) => x.s.id === draft.seriesId) || heroes.find((x) => !x.practice) || heroes[0] || null;
  if (hero && draft.seriesId !== hero.s.id) draft.seriesId = hero.s.id;
  const practice = draft.practice === null ? !app.prefs.connected : !!draft.practice;
  const urls = [];
  const el = h('div', { class: 'home' });
  let dead = false;

  el.appendChild(h('h1', { class: 'page-title' }, '어떤 노래로 영상을 만들까요?'));
  if (practice) {
    el.appendChild(h('div', { class: 'banner', id: 'practice-banner' }, h('span', null, '지금은 연습 모드예요 — 가짜 그림으로 흐름만 보여 줘요.'), h('button', { class: 'btn small', id: 'banner-connect', onclick: () => app.go('settings', { focus: 'subs' }) }, '🔌 내 AI 앱 연결하기')));
  }
  const gate = probeNote(app, () => {});
  if (gate) el.appendChild(gate);
  const blocked = !!(app.probe && app.probe.decision && !app.probe.decision.canMakeVideo);

  // ── 받은 것 (공유로 왔는데 기다리는 영상이 없을 때) ──
  const inboxBox = h('div', { id: 'inbox-box' });
  el.appendChild(inboxBox);
  async function paintInbox() {
    clear(inboxBox);
    let items = [];
    try { items = await engine.handoff.tray(); } catch (_) { items = []; }
    const audio = items.filter((i) => i.kind === 'audio');
    const images = items.filter((i) => i.kind === 'image' || i.kind === 'other');
    for (const a of audio.slice(0, 1)) {
      inboxBox.appendChild(h('div', { class: 'card offer', id: 'offer-song' }, h('b', null, `🎵 받은 노래: ${a.name}`), h('div', { class: 'row' },
        h('button', { class: 'btn primary small', id: 'offer-song-use', onclick: async () => {
          const [entryId, n] = String(a.itemId).split('#');
          const rec = await db.getInbox(entryId);
          const it = rec && rec.items.find((x) => String(x.key).split('/').pop() === n);
          const blob = it && await db.getFile(it.key);
          if (blob) { await setSong(new File([blob], a.name, { type: a.mime || blob.type })); await engine.handoff.discard('', a.itemId); toast('받은 노래를 넣었어요', 'ok'); app.render(); }
        } }, '이 노래로 만들기'),
        h('button', { class: 'btn small danger', onclick: async () => { await engine.handoff.discard('', a.itemId); paintInbox(); } }, '지우기'))));
    }
    const tray = renderTrayList({ app, engine, id: null, items: images, urls, onChange: () => paintInbox() });
    if (tray) inboxBox.appendChild(tray);
  }
  const onTrayEvt = () => { if (!dead) paintInbox(); };
  const offTray0 = engine.on('tray', onTrayEvt);
  window.addEventListener('am:inbox', onTrayEvt);
  const offTray = () => { offTray0(); window.removeEventListener('am:inbox', onTrayEvt); };
  paintInbox();

  // ── 주인공이 없으면 먼저 주인공 ──
  if (!hero) {
    const nameIn = h('input', { type: 'text', id: 'mk-hero-name', maxlength: 40, placeholder: '예: 하루', 'aria-label': '주인공 이름' });
    const descIn = h('textarea', { id: 'mk-hero-desc', rows: 3, placeholder: '예: 짧은 갈색 머리, 노란 우비를 입은 씩씩한 아이', 'aria-label': '어떻게 생겼나요?' });
    el.appendChild(h('div', { class: 'card', id: 'hero-maker' },
      h('h3', null, '🧒 먼저 주인공을 만들어요'),
      h('p', { class: 'small muted' }, '영상에 계속 나올 주인공이에요. 한 번 정해 두면 다음 영상에도 똑같이 나와요.'),
      h('label', { class: 'lbl', for: 'mk-hero-name' }, '이름'), nameIn,
      h('label', { class: 'lbl', for: 'mk-hero-desc' }, '어떻게 생겼나요?'), descIn,
      h('button', { class: 'btn primary big', id: 'mk-hero-draw', onclick: () => {
        buzz();
        if (!nameIn.value.trim() || !descIn.value.trim()) { toast('이름과 생김새를 적어 주세요', 'warn'); return; }
        app.go('hero', { id: 'new', name: nameIn.value.trim(), desc: descIn.value.trim(), startDraw: true, returnTo: 'home' });
      } }, '🎨 AI 앱에 부탁해서 주인공 그리기'),
      h('button', { class: 'btn big', id: 'mk-hero-practice', disabled: blocked, onclick: async () => {
        buzz();
        const b = busy('연습 영상을 준비하는 중…');
        try { const id = await startPractice(app); app.open(id, { from: 'home', autorun: true }); } catch (e) { toast(e.message, 'err'); } finally { b.done(); }
      } }, '☔ 연습용 주인공으로 바로 구경하기')));
    return { el, destroy() { dead = true; offTray(); urls.forEach((u) => URL.revokeObjectURL(u)); } };
  }

  // ── ① 노래 ──
  const songBox = h('div', { class: 'card', id: 'card-song' });
  function paintSong() {
    clear(songBox);
    songBox.appendChild(h('h3', null, '① 🎵 노래'));
    if (draft.songName && songFile) {
      const u = URL.createObjectURL(songFile);
      urls.push(u);
      put(songBox, 
        h('div', { class: 'song-name', id: 'song-name' }, draft.songName),
        h('div', { class: 'small muted' }, `${draft.songSeconds ? fmtSeconds(draft.songSeconds) : ''}${draft.songSize ? ` · ${(draft.songSize / 1024 / 1024).toFixed(1)}MB` : ''}`),
        h('audio', { controls: true, src: u, class: 'mini-audio', preload: 'metadata' }),
        h('div', { class: 'row' }, h('button', { class: 'btn small', id: 'btn-song', onclick: pickSong }, '다른 노래 고르기'), h('button', { class: 'btn small danger', onclick: () => { clearSong(); paintSong(); paintBar(); } }, '지우기')));
    } else {
      put(songBox, 
        h('p', { class: 'small muted' }, practice ? '연습 모드는 노래를 안 골라도 돼요. 내 노래로 해 보고 싶다면 골라 주세요.' : '폰에 있는 노래 파일을 골라 주세요. 다른 앱에서 [공유] 로 보내도 돼요.'),
        h('button', { class: 'btn primary big', id: 'btn-song', onclick: pickSong }, '🎵 노래 고르기'));
    }
  }
  async function setSong(f) {
    songFile = f;
    draft.songName = f.name; draft.songType = f.type || ''; draft.songSize = f.size; draft.songSeconds = 0;
    await db.putFile('draft/song', f);
    persist();
    durationOf(f).then((d) => { if (d && songFile === f) { draft.songSeconds = d; persist(); if (!dead) paintSong(); } });
  }
  async function pickSong() {
    const f = await pickFile('audio/*,video/mp4');
    if (!f) return;
    await setSong(f);
    paintSong(); paintBar();
  }
  function clearSong() { songFile = null; draft.songName = ''; draft.songSize = 0; draft.songSeconds = 0; db.deleteFiles('draft/').catch(() => {}); persist(); }

  // ── ② 가사 ──
  const lyricsBox = h('div', { class: 'card', id: 'card-lyrics' });
  function paintLyrics() {
    clear(lyricsBox);
    const ta = h('textarea', { id: 'lyrics-input', rows: 6, placeholder: '가사를 붙여넣어 주세요 (없어도 만들 수 있어요)', 'aria-label': '가사' });
    ta.value = draft.lyrics;
    const note = h('div', { class: 'small ok-text', id: 'lyrics-timed' });
    const check = () => { const p = L.parseLyrics(ta.value, draft.lyricsName); note.textContent = p && p.timed ? '⏱ 시간이 들어 있어요 — 자막을 이 시간에 맞춰요' : ''; };
    ta.addEventListener('input', () => { draft.lyrics = ta.value; check(); persist(); });
    put(lyricsBox, h('h3', null, '② 📝 가사'), ta, note, h('div', { class: 'row' },
      h('button', { class: 'btn small', id: 'btn-paste-lyrics', onclick: async () => {
        const t = await app.native.readClipboard();
        if (!t.trim()) { toast('복사한 글이 없어요', 'warn'); return; }
        ta.value = t; draft.lyrics = t; check(); persist(); toast('가사를 붙여넣었어요', 'ok');
      } }, '📋 복사한 가사 붙여넣기'),
      h('button', { class: 'btn small', id: 'btn-lyrics-file', onclick: async () => {
        const f = await pickFile('.txt,.lrc,.srt,text/plain');
        if (!f) return;
        const t = await f.text();
        ta.value = t; draft.lyrics = t; draft.lyricsName = f.name; check(); persist();
      } }, '📁 파일 고르기')));
    check();
  }

  // ── ③ 이야기 ──
  const topicBox = h('div', { class: 'card', id: 'card-topic' });
  function paintTopic() {
    clear(topicBox);
    const inp = h('input', { type: 'text', id: 'topic-input', maxlength: 120, placeholder: '어떤 이야기면 좋을까요? (안 적어도 돼요)', 'aria-label': '이야기' });
    inp.value = draft.topic;
    inp.addEventListener('input', () => { draft.topic = inp.value; persist(); });
    put(topicBox, h('h3', null, '③ 💡 이야기 ', h('span', { class: 'tag' }, '선택')), inp,
      h('div', { class: 'chips' }, [h('span', { class: 'small muted' }, '🎲'), ...IDEAS.map((t) => h('button', { class: 'chip', onclick: () => { inp.value = t; draft.topic = t; persist(); } }, t))]));
  }
  paintSong(); paintLyrics(); paintTopic();
  put(el, songBox, lyricsBox, topicBox, h('div', { class: 'bar-space' }));

  // ── 아래 고정 바 ──
  const summary = h('div', { class: 'mk-sum', id: 'mk-summary' });
  const est = h('div', { class: 'mk-est small', id: 'mk-estimate' });
  const makeBtn = h('button', { class: 'btn primary', id: 'btn-make', onclick: makeIt }, '▶ 만들기');
  const reason = h('div', { class: 'mk-reason small', id: 'mk-reason' });
  const bar = h('div', { class: 'mk-bar', id: 'mk-bar' }, summary, est, reason,
    h('div', { class: 'mk-row' }, h('button', { class: 'btn', id: 'btn-change', onclick: openChange }, '⚙ 바꾸기'), makeBtn));
  document.body.appendChild(bar);

  const isPractice = () => (draft.practice === null ? !app.prefs.connected : !!draft.practice);
  function paintBar() {
    const pr = isPractice();
    const asp = ASPECTS.find((a) => a.id === draft.aspect) || ASPECTS[0];
    const preset = PRESETS.find((p) => p.id === draft.preset) || PRESETS[0];
    const imgApp = (app.native.AI_APPS[app.settings.imageApp] || {}).name || 'AI 앱';
    summary.textContent = `주인공 🔒${hero.c.name} · ${asp.name} 영상 · ${preset.name} · 그림은 ${pr ? '연습(가짜 그림)' : imgApp}`;
    if (pr) est.textContent = '연습 모드: 가짜 그림 · 무료 · 2~4분';
    else {
      const e = presetEstimate(draft.preset, draft.aspect);
      est.textContent = `AI 앱에 약 ${e.requests}번 부탁해요 · ${fmtMinutes(e.minutes)}`;
    }
    let why = '';
    if (blocked) why = '이 폰에서는 영상을 만들기 어려워요 (위 안내를 봐 주세요)';
    else if (!pr && !songFile) why = '먼저 노래를 골라 주세요';
    reason.textContent = why;
    reason.style.display = why ? '' : 'none';
    makeBtn.disabled = !!why;
  }
  paintBar();

  function openChange() {
    const body = h('div', { class: 'change-body' });
    let sheet;
    const paintSheet = () => {
      clear(body);
      if (heroes.length > 1) {
        put(body, h('div', { class: 'lbl' }, '주인공'), h('div', { class: 'chips' }, heroes.map((x) => h('button', { class: `chip${x.s.id === hero.s.id ? ' on' : ''}`, 'data-series': x.s.id, onclick: () => { draft.seriesId = x.s.id; persist(); sheet.close(); app.render(); } }, `🔒 ${x.c.name}`))));
      }
      put(body, h('div', { class: 'lbl' }, '영상 모양'), h('div', { class: 'cells three' }, ASPECTS.map((a) => h('button', { class: `cell${a.id === draft.aspect ? ' on' : ''}`, 'data-aspect': a.id, 'aria-pressed': a.id === draft.aspect, onclick: () => { buzz(); draft.aspect = a.id; persist(); paintSheet(); paintBar(); } },
        h('span', { class: `shape s${a.id.replace(':', 'x')}` }), h('b', null, a.name), h('span', { class: 'small muted' }, a.note)))));
      const pr = isPractice();
      put(body, h('div', { class: 'lbl' }, '움직임'), h('div', { class: 'cells three' }, PRESETS.map((p) => {
        const e = presetEstimate(p.id, draft.aspect);
        return h('button', { class: `cell${p.id === draft.preset ? ' on' : ''}`, 'data-preset': p.id, 'aria-pressed': p.id === draft.preset, onclick: () => { buzz(); draft.preset = p.id; persist(); paintSheet(); paintBar(); } },
          h('span', { class: 'emo' }, p.emoji), h('b', null, p.name), p.tag ? h('span', { class: 'tag' }, p.tag) : null, h('span', { class: 'small muted' }, pr ? p.note : `그림 약 ${e.pictures}장`));
      })));
      const cur = PRESETS.find((p) => p.id === draft.preset);
      if (cur && cur.warn) put(body, h('div', { class: 'ho-msg err', id: 'preset-warn' }, `⚠ ${cur.warn}`));
      const apps = Object.entries(app.native.AI_APPS);
      const chipRow = (kind) => h('div', { class: 'chips', 'data-kind': kind }, [
        ...apps.filter(([, a]) => a.good.includes(kind)).map(([id, a]) => h('button', { class: `chip${!pr && app.settings[`${kind}App`] === id ? ' on' : ''}`, 'data-app': id, onclick: () => { app.setSetting(`${kind}App`, id); if (!app.prefs.connected) app.setPref('connected', true); draft.practice = false; persist(); paintSheet(); paintBar(); } }, `${a.name}${app.installed && app.installed[id] ? ' ✓' : ''}`)),
        ...(kind === 'image' ? [h('button', { class: `chip${pr ? ' on' : ''}`, 'data-app': 'practice', onclick: () => { draft.practice = true; persist(); paintSheet(); paintBar(); } }, '연습 (가짜 그림)')] : []),
      ]);
      put(body, h('div', { class: 'lbl' }, '글은 어느 AI 앱'), chipRow('text'), h('div', { class: 'lbl' }, '그림은 어느 AI 앱'), chipRow('image'));
      put(body, h('p', { class: 'small muted' }, pr ? '연습 모드는 가짜 그림으로 흐름만 보여 줘요.' : `${(presetEstimate(draft.preset, draft.aspect).requests)}번쯤 부탁해야 해요. 부탁 한 번에 1~1.5분쯤 걸린다고 어림한 값이에요.`));
    };
    sheet = bottomSheet({ title: '⚙ 바꾸기', body, buttons: [{ label: '다 골랐어요', kind: 'primary' }], alwaysClose: false, closeLabel: null, onClose: () => paintBar() });
    paintSheet();
  }

  async function makeIt() {
    if (makeBtn.disabled) return;
    buzz();
    const pr = isPractice();
    const preset = PRESETS.find((p) => p.id === draft.preset) || PRESETS[0];
    if (!pr && preset.warn && !(await confirmBox('몇 시간이 걸려요', preset.warn, '그래도 만들기', '다시 고를게요'))) return;
    await ensureNotify(app);
    const b = busy(pr ? '연습 영상을 준비하는 중…' : '영상을 준비하는 중…');
    try {
      let id;
      if (pr) {
        const seriesId = await engine.demo.ensureSeries();
        const songBlob = songFile || await engine.services.demo.song({ seconds: app.practiceSeconds || 60, bpm: 120 });
        id = await engine.projects.create({ workflow: 'demo', aspect: draft.aspect, quality: app.settings.quality, providers: 'demo', seriesId, songBlob, songName: songFile ? draft.songName : '연습용 노래.wav', lyricsText: songFile ? draft.lyrics : (draft.lyrics || DD.DEMO_LYRICS), lyricsName: draft.lyricsName, topic: draft.topic });
      } else {
        id = await engine.projects.create({ workflow: preset.wf, aspect: draft.aspect, quality: app.settings.quality, songBlob: songFile, songName: draft.songName, lyricsText: draft.lyrics, lyricsName: draft.lyricsName, topic: draft.topic, seriesId: hero.s.id });
        if (preset.motion) await engine.edits.setMotion(id, { motionMode: preset.motion });
      }
      resetDraftAfterCreate();
      app.open(id, { from: 'home', autorun: true });
    } catch (e) {
      toast(e.message || String(e), 'err', 6000);
    } finally { b.done(); }
  }

  return { el, destroy() { dead = true; offTray(); bar.remove(); urls.forEach((u) => URL.revokeObjectURL(u)); } };
}

/** 노래 길이(초). 읽지 못하면 0 */
function durationOf(file) {
  return new Promise((resolve) => {
    const a = new Audio();
    const u = URL.createObjectURL(file);
    const done = (v) => { URL.revokeObjectURL(u); resolve(v); };
    const t = setTimeout(() => done(0), 4000);
    a.preload = 'metadata';
    a.onloadedmetadata = () => { clearTimeout(t); done(Number.isFinite(a.duration) ? Math.round(a.duration) : 0); };
    a.onerror = () => { clearTimeout(t); done(0); };
    a.src = u;
  });
}
