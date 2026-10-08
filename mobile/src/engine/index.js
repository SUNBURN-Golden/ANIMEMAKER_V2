// V2 안드로이드 앱의 만들기 엔진 (PC 앱 ProjectRunner + 편집 메서드의 폰 판). 화면(C3)은 이 파일의 createEngine 하나만 알면 된다.
//
// ── 시작 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
//   import * as db from '../db.js'; import * as native from '../native.js';
//   const engine = createEngine({ db, native, probe /* loadProbe() 결과, 선택 */, now /* 시험용 */, services /* 시험용으로 일부 바꿔 끼움 */ });
//   await engine.start();                        // 앱을 켤 때 한 번: 공유로 받은 것 받기 시작 + 이미 쌓인 것을 기다리던 칸으로 보낸다
//   const off = engine.on('update', (snap) => …) // 작품 상태가 바뀔 때마다 (snap 은 읽기 전용). 'log' {projectId,line} · 'tray' {} · 'deleted' {id} · 'error' Error
//   const id = await engine.projects.create({ workflow:'phone-lite'|'phone-ghibli'|'demo', aspect:'9:16'|'16:9'|'1:1'|'4:5', quality?, songBlob, songName,
//                lyricsText?, lyricsName?, topic?, title?, seriesId?, providers?: {text,image}|'demo' })   // → 작품 id. 'demo' 는 노래·가사도 알아서 만든다
//   await engine.run(id)                         // 기다려야 할 때(AI 앱 부탁·확인)·끝·멈춤·오류까지 간다. snapshot 을 돌려준다
//
// ── 지금 할 일 한 줄 = snapshot.next ──────────────────────────────────────────────────────────────────────────────
//   {kind:'run'|'running'|'review'|'handoff'|'apply'|'done'|'error', label, key?, handoffKind?:'plan'|'xsheet'|'bg'|'cel'|'redraw', step?}
//   run → engine.run(id) · review → engine.continueReview(id) (카드: snapshot.waiting) · handoff → engine.handoff.request(id) 로 요청서를 받아
//   보여 주고 engine.handoff.send(id, appId) / acceptText / acceptFiles · apply → engine.applyChanges(id)
//
// ── snapshot (engine.projects.get(id) · on('update')) ─────────────────────────────────────────────────────────────
//   id title topic kind createdAt updatedAt · workflow(설정 사본) providers aspect quality · series{id,name,emoji,episode,characters[{id,name}]}|null
//   status('idle'|'running'|'waiting'|'stopped'|'error'|'done') running error currentStep stepOrder stepLabels steps{단계:{status,message,progress?,startedAt,finishedAt,lastMs}}
//   waiting{key,kind:'plan'|'xsheet'|'bg'|'cel'|'review',title,message, review:drawings 는 estimate{pictures,minutes,text,requests,warning,assumption,…}+alt{motionMode,drawingBudget?,pictures,minutes,text}|null,
//           xsheet 는 canFallback:true, 그림은 itemKey}|null · handoff{kind,key,redraw,requestedAt}|null · next(위)
//   song{name,size,rev} music{bpm,bpmOverride,barNudge,analysis} lyricsInput plan timing{lyrics[],lyricsSource,segments[],frames[],highlights[]} xsheet{shots,transitions,bgGroups,bgOf,estimate,totalFrames,…}
//   drawings[{key,kind:'bg'|'cel',shot,id,status:'pending'|'running'|'done'|'skipped'|'error',prompt,hasPicture,keyed,keyReason,w,h,source:'ai'|'user',custom,note,promptEdited,redraws,error,history[{index,at,kind,note}]}]
//   queue[{key,kind,shot,id,weight,status}] (부탁할 차례) nextKey · work{total,done,skipped,pending,running,error,textPending,remainingRequests,remainingMinutes,text} · redrawing[{shot,id,key,status,note}]
//   changes{render,subs,shots[],count,etaSec} subtitleStyle outSize{w,h} canApply durationSec estimate{images,bg,cels,requests,minutes,minutesLow,minutesHigh,motionShots,motionSeconds,text,warning,assumption}
//   output{clean,video,srt,lrc,draft,madeAt,cleanAt,bytes,seconds,codecs,burned,hasVideo} renderStale subsStale dirtyShots subsFallback approvals drawingsApproved log[]
//
// ── 요청서 engine.handoff.request(id) → null 또는 ────────────────────────────────────────────────────────────────
//   {kind:'plan'|'xsheet'|'bg'|'cel', key, title(한국어), prompt(영어 글: 복사·공유할 글), files:[{name,blob,note}] (같이 붙일 그림, 최대 4), nonce,
//    targetApps:[{id,name,pkg,preferred}], expectsText, expectsImages, redraw, hint(한국어 안내)}
//   글 부탁(plan·xsheet)은 prompt 끝에 `"request_id": "<nonce>"` 안내가 붙고, 답장에 그 번호가 와야 받는다 (acceptText 의 reason: echo · placeholder · noNonce · invalid · wrongKind · noRequest).
//
// ── 오류 · 안내 ───────────────────────────────────────────────────────────────────────────────────────────────────
//   고치기·만들기 함수는 사용자에게 그대로 보여 줄 수 있는 한국어 Error(해요체)로 reject 한다. 멈춘 일은 name 'AbortError'. acceptText/acceptFiles 는 reject 대신 {ok:false,reason,message} / {failed[]} 로 알린다.
//
// 모든 오래 걸리는 일은 작품 id 로 만든 런타임을 붙들고 jobs.runJob 아래에서 돈다 → 화면을 떠나도, 뒤로가기를 눌러도 결과를 잃지 않는다. 자세한 구조는 보고서와 각 파일 머리말.
import * as jobs from '../jobs.js';
import { startReceiving } from '../inbox.js';
import { L, DD } from './shared.js';
import { BK } from './keys.js';
import { MSG, STEPS, STEP_LABELS, newProjectRecord } from './model.js';
import { ProjectRuntime, settleLoaded } from './runtime.js';
import { makeWorkflow, WORKFLOW_KINDS, WORKFLOW_INFO, ASPECTS, QUALITIES, outSizeOf, estimateHandoffs, REQUEST_MINUTES } from './workflows.js';
import { runPipeline, renderCleanBlob } from './pipeline.js';
import { songSeconds } from './snapshot.js';
import { createMaterials } from './materials.js';
import * as H from './handoff.js';
import * as Ed from './edits.js';
import * as Mo from './motion.js';
import { createDemoApi } from './demo.js';
import { defaultServices } from './services.js';
import { abortError } from './util.js';

export { WORKFLOW_KINDS, WORKFLOW_INFO, STEPS, STEP_LABELS, MSG, estimateHandoffs, REQUEST_MINUTES };
export { checkReply, isEcho, findPlaceholder, nonceBlock } from './handoff.js';

function rowOf(p, running) {
  const done = STEPS.filter((s) => p.steps && p.steps[s] && p.steps[s].status === 'done').length;
  const out = p.output || {};
  return {
    id: p.id, title: p.title, topic: p.topic, kind: p.kind, aspect: p.workflow.aspect, quality: p.workflow.quality,
    status: p.status === 'running' && !running ? 'stopped' : p.status,
    createdAt: p.createdAt, updatedAt: p.updatedAt, durationSec: songSeconds(p),
    progress: { done, total: STEPS.length }, hasVideo: !!out.video, burned: !!out.burned, madeAt: out.madeAt || null,
    series: p.series ? { name: p.series.name, episode: p.series.episode } : null,
    waiting: p.waiting ? { kind: p.waiting.kind, title: p.waiting.title } : null,
  };
}

const safeName = (s) => String(s || 'video').replace(/[\\/:*?"<>|\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'video';

/**
 * @param {{db:object, native?:object|null, probe?:object|null, now?:()=>number, services?:object|null}} o
 */
export function createEngine({ db, native = null, probe = null, now = Date.now, services = null } = {}) {
  if (!db) throw new Error('createEngine: db 가 필요해요');
  const listeners = new Map();
  const runtimes = new Map(); // id → Promise<ProjectRuntime>
  const loaded = new Map(); // id → ProjectRuntime (다 읽은 것)
  let recvStop = null;
  let routeChain = Promise.resolve();

  const engine = {
    db, native, probe, now: () => now(),
    services: { ...defaultServices(), ...(services || {}) },
    emit, on, reportError, loadRuntime, continueRun, whenIdle,
  };

  function on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
    return () => listeners.get(evt).delete(fn);
  }
  function emit(evt, payload) {
    for (const fn of [...(listeners.get(evt) || [])]) {
      try { fn(payload); } catch (e) { console.error(e); }
    }
  }
  function reportError(e) {
    if (!listeners.get('error') || !listeners.get('error').size) console.error(e);
    else emit('error', e);
  }

  function loadRuntime(id) {
    if (!runtimes.has(id)) {
      const pr = (async () => {
        if (typeof id !== 'string' || !id) throw new Error(MSG.noProject);
        const p = await db.getProject(id);
        if (!p) throw new Error(MSG.noProject);
        const items = await db.listDrawings(id);
        const fixed = settleLoaded(p, items);
        const rt = new ProjectRuntime(engine, p, items);
        if (fixed.project) await rt.save();
        if (fixed.items.length) await rt.saveItems(fixed.items);
        loaded.set(id, rt);
        return rt;
      })();
      runtimes.set(id, pr);
      pr.catch(() => runtimes.delete(id));
    }
    return runtimes.get(id);
  }

  /** AI 앱 답장/그림을 받은 뒤 이어서 만든다 (기다리지 않는다) */
  function continueRun(rt) {
    runPipeline(rt).catch(reportError);
  }

  async function whenIdle(id) {
    const rt = await loadRuntime(id);
    while (rt.running && rt.runPromise) await rt.runPromise.catch(() => {});
    await rt.exclusive('pic', async () => {});
    if (rt.running) await whenIdle(id);
  }

  const E = (fn) => async (id, ...args) => fn(await loadRuntime(id), ...args);

  // ───────────────────────── 작품 ─────────────────────────
  async function snapshotOfStored(id) { return (await loadRuntime(id)).snapshot(); }

  async function buildSeriesSnapshot(seriesId, pid) {
    const s = await db.getSeries(seriesId);
    if (!s) throw new Error('시리즈를 찾을 수 없어요.');
    const chars = [];
    for (const cid of s.characterIds || []) {
      const c = await db.getCharacter(cid);
      if (c) chars.push(c);
    }
    if (!chars.length) throw new Error('이 시리즈에 주인공 캐릭터가 없어요. [시리즈] 화면에서 캐릭터를 넣어 주세요.');
    const open = chars.filter((c) => !c.lockedAt);
    if (open.length) throw new Error(`캐릭터 "${open.map((c) => c.name).join(', ')}" 가 아직 잠기지 않았어요. [캐릭터] 화면에서 기준 그림을 확인하고 [🔒 잠그기] 를 눌러 주세요.`);
    const episode = (Number(s.episodeCounter) || 0) + 1;
    s.episodeCounter = episode;
    await db.putSeries(s);
    const characters = [];
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      const refs = [];
      for (let k = 0; k < (c.refs || []).length; k++) {
        const r = c.refs[k];
        const blob = await db.getFile(r.blobKey);
        if (!blob) continue;
        const key = BK.ref(pid, c.id, k + 1); // 영상마다 사본을 가진다(얼려 둔 사본 — 캐릭터를 나중에 고쳐도 이 영상은 그대로)
        await db.putFile(key, blob);
        refs.push({ kind: r.kind, label: r.label, mime: r.mime, blobKey: key });
      }
      characters.push({ id: c.id, name: c.name, role: i === 0 ? 'protagonist' : 'main', version: c.version, locked: c.locked, palette: c.palette, rules: c.rules, personality_ko: c.personality_ko, refs });
    }
    return {
      series: { id: s.id, name: s.name, emoji: s.emoji, episode, bible: s.bible, characters, previous: (s.episodes || []).slice(-6).map((e) => ({ number: e.number, title: e.title, summary_ko: e.summary_ko })) },
      subtitleStyle: s.subtitleStyle || null,
    };
  }

  const projects = {
    /**
     * 새 영상(에피소드) 만들기. 노래를 저장소에 넣고 작품 기록을 만든다 (만들기는 engine.run 으로 시작).
     * @param {{title?:string, topic?:string, seriesId?:string, songBlob?:Blob, songName?:string, lyricsText?:string, lyricsName?:string,
     *          workflow?:'phone-lite'|'phone-ghibli'|'demo', aspect?:'9:16'|'16:9'|'1:1', quality?:'480p'|'720p'|'1080p', providers?:{text:string,image:string}|'demo'}} opts
     * @returns {Promise<string>} 작품 id
     */
    async create(opts = {}) {
      const kind = WORKFLOW_KINDS.includes(opts.workflow) ? opts.workflow : 'phone-lite';
      if (opts.workflow && !WORKFLOW_KINDS.includes(opts.workflow)) throw new Error(`알 수 없는 만들기 방식이에요: ${opts.workflow}`);
      if (opts.aspect && !ASPECTS.includes(opts.aspect)) throw new Error(`알 수 없는 화면 비율이에요: ${opts.aspect}`);
      const quality = QUALITIES.includes(opts.quality) ? opts.quality : (probe && probe.decision && QUALITIES.includes(probe.decision.suggestedQuality) ? probe.decision.suggestedQuality : '720p');
      const wf = makeWorkflow(kind, { aspect: opts.aspect || '9:16', quality });
      const demoMode = kind === 'demo' || opts.providers === 'demo';
      const pv = opts.providers && typeof opts.providers === 'object' ? opts.providers : {};
      const providers = demoMode && !(pv.text || pv.image) ? { text: 'demo', image: 'demo' } : { text: String(pv.text || 'handoff'), image: String(pv.image || 'handoff') };
      let songBlob = opts.songBlob;
      let songName = opts.songName || '';
      let lyricsText = opts.lyricsText || '';
      if (!songBlob) {
        if (!demoMode) throw new Error('노래 파일을 골라 주세요.');
        songBlob = await engine.services.demo.song({ seconds: wf.demoSongSeconds || 60, bpm: 120 });
        songName = songName || '연습용 노래.wav';
        lyricsText = lyricsText || DD.DEMO_LYRICS;
      }
      if (!(songBlob.size > 0)) throw new Error('노래 파일이 비어 있어요.');
      const id = db.newId('p');
      let series = null;
      if (opts.seriesId) {
        const sn = await buildSeriesSnapshot(opts.seriesId, id);
        series = sn.series;
        if (sn.subtitleStyle) wf.subtitles = { ...sn.subtitleStyle, enabled: !(wf.subtitles && wf.subtitles.enabled === false) };
      }
      const label = opts.topic || opts.title || songName.replace(/\.[^.]+$/, '') || (series ? series.name : '') || '뮤직비디오';
      const title = series ? `${series.name} EP${series.episode}` : String(label).slice(0, 40);
      const song = { key: BK.song(id), name: songName || '노래', type: songBlob.type || '', size: songBlob.size, rev: 0 };
      await db.putFile(song.key, songBlob);
      const rec = newProjectRecord({
        id, now: now(), title, topic: opts.topic || '', kind, workflow: wf, providers, series, seriesId: opts.seriesId || null, song,
        lyricsInput: L.parseLyrics(lyricsText, opts.lyricsName),
      });
      await db.putProject(rec);
      const rt = await loadRuntime(id);
      emit('update', rt.snapshot());
      return id;
    },
    get: (id) => snapshotOfStored(id),
    /** 이름 바꾸기 (40자까지) */
    async rename(id, title) {
      const rt = await loadRuntime(id);
      const t = String(title == null ? '' : title).replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!t) throw new Error('이름을 적어 주세요.');
      rt.p.title = t;
      await rt.save();
      rt.emit();
      return t;
    },
    /** 이미 열려 있으면 바로, 아니면 null (화면 그리기용) */
    peek(id) {
      const rt = loaded.get(id);
      return rt ? rt.snapshot() : null;
    },
    async list() {
      const out = [];
      for (const rec of await db.listProjects()) {
        const pr = runtimes.get(rec.id);
        const rt = pr ? await pr.catch(() => null) : null;
        out.push(rowOf(rt ? rt.p : rec, !!(rt && rt.running)));
      }
      return out;
    },
    async delete(id) {
      const pr = runtimes.get(id);
      const rt = pr ? await pr.catch(() => null) : null;
      if (rt) {
        rt.stopAll();
        rt.deleted = true;
        if (rt.runPromise) await rt.runPromise.catch(() => {});
        await rt.exclusive('pic', async () => {}).catch(() => {});
      }
      jobs.cancelJob(id);
      jobs.cancelJob(`${id}:key`);
      await db.deleteProject(id);
      const exp = await db.getExpecting({ maxAgeMs: 0 });
      if (exp && exp.projectId === id) await db.clearExpecting(exp.nonce).catch(() => {});
      runtimes.delete(id);
      loaded.delete(id);
      emit('deleted', { id });
    },
    on,
  };

  // ───────────────────────── 만들기 제어 ─────────────────────────
  async function run(id, { from } = {}) {
    return runPipeline(await loadRuntime(id), { from });
  }

  /** 멈추기: 노래 분석 · 그림 정리 · 영상 · 자막을 그만두게 한다 (AI 앱 답장을 기다리는 중이면 할 일이 없다). 신호를 보냈으면 true */
  async function stop(id) {
    const pr = runtimes.get(id);
    const rt = pr ? await pr.catch(() => null) : null;
    if (!rt) { jobs.cancelJob(id); jobs.cancelJob(`${id}:key`); return false; }
    const was = rt.running || rt.busyKeying();
    rt.stopAll();
    return was;
  }

  // ───────────────────────── 그림 ─────────────────────────
  async function finishEarly(id) {
    const rt = await loadRuntime(id);
    let n = 0;
    for (const it of rt.items()) if (it.status === 'pending') { it.status = 'skipped'; await rt.saveItem(it); n++; }
    rt.p.drawingsApproved = true;
    if (rt.p.status === 'waiting' && rt.p.waiting && (rt.p.waiting.kind === 'bg' || rt.p.waiting.kind === 'cel')) { rt.p.waiting = null; await rt.save(); continueRun(rt); } else await rt.save();
    rt.emit();
    return n;
  }

  async function unskip(id, key) {
    const rt = await loadRuntime(id);
    const it = rt.drawings.get(key);
    if (!it || it.status !== 'skipped') return false;
    it.status = 'pending';
    await rt.saveItem(it);
    if (rt.p.steps.drawings && rt.p.steps.drawings.status === 'done') { rt.p.steps.drawings.status = 'pending'; if (rt.p.status === 'done') rt.p.status = 'stopped'; }
    await rt.save();
    rt.emit();
    return true;
  }

  const drawings = {
    regenerate: E(H.regenerate),
    regenerateCut: E(H.regenerateCut),
    cancelRedraw: E(H.cancelRedraw),
    replace: E(Ed.replace),
    restoreVersion: E(Ed.restoreVersion),
    skip: (id, key) => E((rt, k) => H.skipWaiting(rt, k))(id, key),
    unskip,
    finishEarly,
    /** 줄 순서(우선순위)와 각 그림 상태 */
    queue: async (id) => (await loadRuntime(id)).snapshot().queue,
    /** 그림 덩어리: which = 'current'(기본) | 'cel'(배경 뺀 셀) | 'plate'(배경색 위에 얹은 그림) | 숫자(예전 그림 번호) */
    async blob(id, key, which = 'current') {
      const rt = await loadRuntime(id);
      const it = rt.drawings.get(key);
      if (!it) return null;
      if (typeof which === 'number') return rt.getBlob(it.history && it.history[which] ? it.history[which].file : null);
      if (which === 'cel') return rt.getBlob(it.cel);
      if (which === 'plate') {
        const cel = it.cel ? await rt.getBlob(it.cel) : null;
        return cel ? engine.services.plate(cel, rt.xs.keyColor) : rt.getBlob(it.file);
      }
      return rt.getBlob(it.file);
    },
  };

  // ───────────────────────── 부탁 · 받기 ─────────────────────────
  const isChar = (id) => String(id).startsWith('char:');
  const handoff = {
    request: E(H.request),
    send: E(H.send),
    acceptText: (id, text, o) => (isChar(id) ? H.acceptCharacterText(engine, id, text, o) : E(H.acceptText)(id, text, o)),
    acceptFiles: (id, files, o) => (isChar(id) ? H.acceptCharacterFiles(engine, id, files) : E(H.acceptFiles)(id, files, o)),
    requestCharacter: (scopeId, spec) => H.requestCharacter(engine, scopeId, spec),
    /** 받은 함: 공유로 받았지만 자리를 못 찾은 항목들 (그림에는 어느 칸에 넣을지 제안이 붙는다) */
    async tray(id) {
      let rt = null;
      if (id) rt = await loadRuntime(id).catch(() => null);
      else {
        const exp = await db.getExpecting();
        if (exp && !String(exp.projectId).startsWith('char:')) rt = await loadRuntime(exp.projectId).catch(() => null);
      }
      const suggest = rt && rt.xs ? (i) => {
        const key = H.planSlots(rt, i + 1)[i];
        const it = key && rt.drawings.get(key);
        return it ? { projectId: rt.id, key, title: `${it.kind === 'bg' ? '배경' : '인물'} 그림 · 컷 ${it.shot}${it.kind === 'bg' ? '' : `-${it.id}`}` } : null;
      } : null;
      return H.listTray(db, { suggest });
    },
    place: async (id, itemId, key, o) => {
      let r;
      if (isChar(id)) { // 캐릭터 기준 그림: 그림을 줄여서 돌려준다 (저장은 캐릭터 화면이)
        const got = await H.readTrayItem(db, itemId);
        if (!got || !got.blob) throw new Error('받은 항목을 찾을 수 없어요.');
        r = await H.acceptCharacterFiles(engine, id, [{ name: got.item.name, mime: got.item.mime, blob: got.blob }]);
        if (r.placed.length) await H.removeTrayItem(db, itemId);
      } else r = await E(H.placeTrayItem)(id, itemId, key, o);
      emit('tray', {});
      return r;
    },
    discard: async (id, itemId) => { const r = await H.removeTrayItem(db, itemId); emit('tray', {}); return r; },
    /** 받은 함에 쌓인 것을 기다리던 칸으로 보낸다 (앱을 켤 때 start() 가 부른다) */
    routeInbox: () => {
      const job = routeChain.then(() => H.routeInbox(engine));
      routeChain = job.catch(() => {});
      return job;
    },
  };

  /** 공유로 받은 것 받기 시작 (앱을 켤 때 한 번): 네이티브 받은 함 → 저장소 inbox → 기다리던 칸으로. 이미 쌓인 것도 바로 보낸다 */
  async function start() {
    if (recvStop) return handoff.routeInbox();
    if (native) {
      recvStop = startReceiving({
        native, store: db,
        onReceived: () => { handoff.routeInbox().catch(reportError); emit('tray', {}); },
        onError: reportError,
      });
    } else recvStop = () => {};
    return handoff.routeInbox();
  }

  // ───────────────────────── 고치기 ─────────────────────────
  const edits = {
    retime: E(Ed.retime), setCamera: E(Ed.setCamera), setFx: E(Ed.setFx), setTransition: E(Ed.setTransition),
    setMotion: E(Mo.setMotion), estimateMotion: E((rt, o) => Mo.estimateMotion(rt, o)),
    setSubtitleStyle: E(Ed.setSubtitleStyle), setLyricLines: E(Ed.setLyricLines), saveSubtitles: E(Ed.saveSubtitles),
    updateLyricsText: E(Ed.updateLyricsText), updateLyrics: E(Ed.updateLyrics), updatePlan: E(Ed.updatePlan),
    replaceSong: E(Ed.replaceSong), setBpm: E(Ed.setBpm), setBarNudge: E(Ed.setBarNudge),
    applyChanges: E((rt) => Ed.applyChanges(rt, reportError)),
    regenerate: drawings.regenerate, regenerateCut: drawings.regenerateCut, replace: drawings.replace, restoreVersion: drawings.restoreVersion,
  };

  // ───────────────────────── 영상 ─────────────────────────
  async function renderDraft(rt, o) {
    if (rt.running || jobs.isJobRunning(rt.id)) throw new Error(MSG.alreadyRunning);
    if (!rt.xs) throw new Error(MSG.needSteps);
    const missing = rt.items().filter((it) => it.status !== 'done').length;
    rt.log(`🎞 초안(애니매틱)을 만들어요 — 아직 없는 그림 ${missing}장은 카드로 보여요.`);
    const out = await renderCleanBlob(rt, { draft: true, title: '초안 만드는 중', onProgress: o.onProgress });
    await rt.putBlob(BK.draft(rt.id), out.blob);
    rt.p.output = { ...(rt.p.output || {}), draft: { key: BK.draft(rt.id), at: rt.now(), missing, bytes: out.bytes, seconds: out.seconds, codecs: out.codecs } };
    await rt.save();
    rt.emit();
    return rt.p.output.draft;
  }

  const render = {
    /**
     * 영상 만들기. 기본은 정식 영상(그림이 다 모인 뒤 · 순서표까지 끝난 작품): 깨끗한 원본 → 자막까지 이어서 한다.
     * draft:true 면 지금 있는 그림만으로 작은 초안(애니매틱)을 따로 만든다(없는 그림은 카드) — 작품 상태는 안 바꾼다.
     * @param {{draft?:boolean, onProgress?:(e:object)=>void, signal?:AbortSignal}} [o]
     */
    async run(id, o = {}) {
      const rt = await loadRuntime(id);
      if (o.signal) {
        if (o.signal.aborted) throw abortError();
        o.signal.addEventListener('abort', () => { stop(id); }, { once: true });
      }
      if (o.draft) return renderDraft(rt, o);
      const ready = ['music', 'plan', 'timing', 'xsheet'].every((s) => rt.p.steps[s] && rt.p.steps[s].status === 'done');
      if (!ready) throw new Error(MSG.needSteps);
      rt.progressHook = o.onProgress || null;
      try {
        return await runPipeline(rt, { from: 'render' });
      } finally {
        rt.progressHook = null;
      }
    },
    /** 미리보기·장면 편집용 합성기 (영상 만들기와 같은 합성). scale 로 작게 만들 수 있다. 쓴 뒤 compositor.release() */
    async createCompositor(id, { quality = 'low', draft = false, scale = 1 } = {}) {
      const rt = await loadRuntime(id);
      if (!rt.xs) throw new Error(MSG.noXsheet);
      const size = outSizeOf(rt.wf);
      const even = (v) => Math.max(2, Math.round((v * scale) / 2) * 2);
      const W = even(size.w);
      const H_ = even(size.h);
      const materials = createMaterials(rt, { draft });
      const compositor = engine.services.render.createCompositor({ xs: rt.xs, W, H: H_, materials, finish: rt.wf.finish, quality });
      return { compositor, width: W, height: H_, materials };
    },
    /** 결과 덩어리: which = 'video'(완성본) | 'clean'(자막 없는 원본) | 'draft' | 'srt' | 'lrc' */
    async output(id, which = 'video') {
      const rt = await loadRuntime(id);
      const o = rt.p.output || {};
      const key = which === 'draft' ? (o.draft && o.draft.key) : o[which];
      return key ? rt.getBlob(key) : null;
    },
    /** 저장할 때 쓸 파일 이름 */
    async fileName(id, which = 'video') {
      const rt = await loadRuntime(id);
      const base = safeName(`${rt.series ? `${rt.series.name} EP${rt.series.episode} ` : ''}${rt.p.plan ? rt.p.plan.title : rt.p.title}`);
      return which === 'srt' ? `${base}.srt` : which === 'lrc' ? `${base}.lrc` : `${base}${which === 'clean' ? ' (자막 없음)' : which === 'draft' ? ' (초안)' : ''}.mp4`;
    },
  };

  const continueReview = E(H.continueReview);
  const demo = createDemoApi({ db, services: engine.services, now: engine.now, loadRuntime, whenIdle, run, continueReview, handoff });

  return {
    projects, run, stop,
    continueReview,
    skipWaiting: E(H.skipWaiting),
    applyChanges: edits.applyChanges,
    whenIdle,
    handoff, drawings, edits, render, demo,
    start,
    on,
    probe,
    get services() { return engine.services; },
    /** 시험·디버그용: 작품 런타임 */
    _runtime: loadRuntime,
    dispose() {
      if (recvStop) recvStop();
      recvStop = null;
      if (engine.services.dispose) engine.services.dispose();
    },
  };
}

