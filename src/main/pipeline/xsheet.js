'use strict';
// 타임시트(X-sheet, 엑스시트): LLM 이 짜고 내 PC 가 검사·정리하는 '그림 노출표'.
//  - 컷(샷)마다: 그릴 그림 목록(영어 프롬프트), 노출 순서 {그림, 프레임 수} (1초 = 24프레임),
//    카메라 움직임(시작·끝 구도), 효과(fx), 하이라이트 여부
//  - 섞기 규칙: 보통 컷 = 그림 1~4장을 길게 보여 주며 카메라가 움직임 (리미티드 애니메이션)
//               하이라이트 컷(후렴·센 마디) = 그림 6~12장을 2프레임씩 (on 2s) 넘겨서 부드럽게
//  - PC 가 반드시 지키는 것: 컷의 프레임 합계 = 컷 길이(프레임), 그림 장수 예산, 망가진 JSON 고치기
const { resolveTransitions, TRANSITIONS } = require('../media/timeline');

const FPS = 24;
const CAMERA_MOVES = ['hold', 'pan_left', 'pan_right', 'pan_up', 'pan_down', 'zoom_in', 'zoom_out', 'truck_in', 'truck_out', 'shake'];
const FX_TYPES = ['fade_in', 'fade_out', 'flash', 'sparkle', 'shake', 'dissolve_in'];
const EASES = ['linear', 'in', 'out', 'inout'];
const ZOOM_MIN = 1;
const ZOOM_MAX = 1.6;
const NORMAL_MAX = 4;
const HIGHLIGHT_MIN = 6;
const HIGHLIGHT_MAX = 12;
const CHORUS_RE = /(chorus|hook|refrain|drop|climax|후렴|하이라이트|클라이맥스)/i;

const f = (zoom, x = 0, y = 0) => ({ zoom, x, y });
const CAMERA_PRESETS = {
  hold: { start: f(1.04), end: f(1.04), ease: 'linear' },
  pan_left: { start: f(1.25, 0.8), end: f(1.25, -0.8), ease: 'inout' },
  pan_right: { start: f(1.25, -0.8), end: f(1.25, 0.8), ease: 'inout' },
  pan_up: { start: f(1.25, 0, 0.8), end: f(1.25, 0, -0.8), ease: 'inout' },
  pan_down: { start: f(1.25, 0, -0.8), end: f(1.25, 0, 0.8), ease: 'inout' },
  zoom_in: { start: f(1.0), end: f(1.2, 0, -0.1), ease: 'inout' },
  zoom_out: { start: f(1.2, 0, -0.1), end: f(1.0), ease: 'inout' },
  truck_in: { start: f(1.0), end: f(1.45, 0, -0.15), ease: 'inout' },
  truck_out: { start: f(1.45, 0, -0.15), end: f(1.0), ease: 'inout' },
  shake: { start: f(1.08), end: f(1.08), ease: 'linear' },
};

const MOVE_ALIASES = {
  static: 'hold', still: 'hold', none: 'hold', fixed: 'hold', locked: 'hold', hold: 'hold',
  pan: 'pan_right', panleft: 'pan_left', panright: 'pan_right', panup: 'pan_up', pandown: 'pan_down',
  tiltup: 'pan_up', tiltdown: 'pan_down', tilt: 'pan_up',
  zoom: 'zoom_in', zoomin: 'zoom_in', zoomout: 'zoom_out', pushin: 'zoom_in', pullout: 'zoom_out', pullback: 'zoom_out',
  truck: 'truck_in', truckin: 'truck_in', truckout: 'truck_out', dollyin: 'truck_in', dollyout: 'truck_out', dolly: 'truck_in',
  shake: 'shake', camerashake: 'shake', rumble: 'shake',
};
const FX_ALIASES = {
  fadein: 'fade_in', fadefromblack: 'fade_in', fadeout: 'fade_out', fadetoblack: 'fade_out',
  flash: 'flash', whiteflash: 'flash', flashwhite: 'flash',
  sparkle: 'sparkle', sparkles: 'sparkle', glitter: 'sparkle', twinkle: 'sparkle', stars: 'sparkle',
  shake: 'shake', impact: 'shake', dissolve: 'dissolve_in', dissolvein: 'dissolve_in', crossfade: 'dissolve_in',
};

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function sum(a) { return a.reduce((x, y) => x + y, 0); }
function key(s) { return String(s || '').toLowerCase().replace(/[^a-z]/g, ''); }
function str(v, max = 500) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }

/** 컷마다 프레임 수 (누적 반올림이라 합계 = 노래 전체 프레임) */
function shotFrames(segments) {
  return segments.map((s) => Math.max(1, Math.round(s.end * FPS) - Math.round(s.start * FPS)));
}

/** 하이라이트 컷 고르기: 에너지가 센 마디, 후렴(Chorus) 구간. 너무 많으면 센 것만, 없으면 가장 센 것 하나. */
function markHighlights(segments, lyrics = []) {
  const score = segments.map((s) => {
    const secs = (s.lyrics || []).map((i) => lyrics[i] && lyrics[i].section).filter(Boolean);
    const chorus = secs.some((x) => CHORUS_RE.test(x));
    const lv = typeof s.level === 'number' ? s.level : s.energy === 'high' ? 0.85 : s.energy === 'mid' ? 0.6 : 0.3;
    return { flag: s.energy === 'high' || chorus, rank: (chorus ? 1 : 0) + lv };
  });
  const flags = score.map((x) => x.flag);
  const maxN = Math.max(1, Math.round(segments.length * 0.45));
  const on = flags.map((x, i) => (x ? i : -1)).filter((i) => i >= 0);
  if (on.length > maxN) {
    const keep = new Set(on.sort((a, b) => score[b].rank - score[a].rank).slice(0, maxN));
    return flags.map((_, i) => keep.has(i));
  }
  if (!on.length && segments.length >= 3) {
    let best = 0;
    score.forEach((x, i) => { if (x.rank > score[best].rank) best = i; });
    flags[best] = true;
  }
  return flags;
}

/** 그림 장수 예산 (0 = 자동: 3분 ≈ 68장, 4분 ≈ 90장) */
function autoBudget(duration) {
  return clamp(Math.round(duration * 0.375), 8, 120);
}
function resolveBudget(wf, duration, shotCount) {
  const want = Number(wf && wf.drawingBudget) > 0 ? Math.round(Number(wf.drawingBudget)) : autoBudget(duration);
  return Math.max(shotCount, Math.min(400, want));
}

/** 컷 길이로 본 알맞은 그림 장수 */
function idealCount(frames, highlight) {
  const sec = frames / FPS;
  return highlight ? clamp(Math.round(sec * 1.5), HIGHLIGHT_MIN, HIGHLIGHT_MAX) : clamp(Math.round(sec / 4), 1, NORMAL_MAX);
}

/**
 * 예산에 맞게 컷별 장수를 줄인다. 보통 컷은 2장까지, 하이라이트는 8장까지 먼저 줄이고,
 * 그다음 보통 컷 1장 → 하이라이트 6장 → … 순서. 하이라이트는 끝까지 보통 컷보다 많게 남긴다.
 */
function fitCountsToBudget(counts, highlights, budget) {
  const c = counts.slice();
  let total = sum(c);
  const passes = [
    (i) => !highlights[i] && c[i] > 2,
    (i) => highlights[i] && c[i] > 8,
    (i) => !highlights[i] && c[i] > 1,
    (i) => highlights[i] && c[i] > HIGHLIGHT_MIN,
    (i) => highlights[i] && c[i] > 3,
    (i) => highlights[i] && c[i] > 2,
    (i) => c[i] > 1,
  ];
  for (const ok of passes) {
    while (total > budget) {
      let best = -1;
      for (let i = 0; i < c.length; i++) if (ok(i) && (best < 0 || c[i] > c[best])) best = i;
      if (best < 0) break;
      c[best]--;
      total--;
    }
  }
  return c;
}

/** LLM 에게 알려 줄 컷별 추천 장수 */
function allocateDrawings(frames, highlights, budget) {
  return fitCountsToBudget(frames.map((n, i) => idealCount(n, highlights[i])), highlights, budget);
}

/** 컷 안에서 박자가 떨어지는 프레임 (컷 시작 = 0) */
function beatFramesIn(seg, analysis, startFrame) {
  return (analysis.beats || [])
    .filter((b) => b >= seg.start - 1e-3 && b < seg.end - 1e-3)
    .map((b) => Math.round(b * FPS) - startFrame)
    .filter((x, i, a) => x >= 0 && a.indexOf(x) === i);
}

function startFrames(segments) {
  return segments.map((s) => Math.round(s.start * FPS));
}

// ---------------- LLM 지시문 ----------------

/**
 * @param {{plan:object, series?:object, segments:object[], lyrics:object[], analysis:object, wf:object,
 *          frames:number[], highlights:boolean[], alloc:number[], budget:number}} ctx
 */
function xsheetPrompt(ctx) {
  const { plan, series, segments, lyrics, analysis, wf, frames, highlights, alloc, budget } = ctx;
  const starts = startFrames(segments);
  const shotLines = segments.map((s, i) => {
    const lyr = s.lyrics.map((k) => lyrics[k] && lyrics[k].text).filter(Boolean);
    const sec = [...new Set(s.lyrics.map((k) => lyrics[k] && lyrics[k].section).filter(Boolean))];
    const beats = beatFramesIn(s, analysis, starts[i]);
    return `- shot ${s.index}: ${s.start.toFixed(2)}s → ${s.end.toFixed(2)}s = ${frames[i]} frames, energy ${s.energy}${sec.length ? ` [${sec.join(', ')}]` : ''}${highlights[i] ? ' HIGHLIGHT' : ''}, suggested drawings: ${alloc[i]}, beat frames: ${beats.slice(0, 40).join(',') || '-'}${lyr.length ? `, lyrics: "${lyr.join(' / ')}"` : ' (instrumental)'}`;
  }).join('\n');
  const trStyle = {
    cuts: 'Mostly hard cuts on the beat; at most 2 special transitions.',
    smooth: 'Mostly soft transitions (dissolve, fade) of 0.5-1 beat; a few cuts.',
    mixed: 'Hard cuts on strong beats, special transitions at section changes and chorus entries.',
  }[wf.transitionStyle || 'mixed'];
  const fixed = series && series.characters && series.characters.length
    ? `Fixed characters (their design is LOCKED by character files and will be attached as reference images to every drawing; never redesign or rename them): ${series.characters.map((c) => c.name).join(', ')}.`
    : '';
  return `# Task: animation timesheet (X-sheet / exposure sheet) for a hand-drawn music video${series ? ` episode ${series.episode} of the series "${series.name}"` : ''}

This video is classic limited cel animation, like 1980s-1990s hand-drawn feature animation: still drawings are shown one after another at ${FPS} frames per second, and the PC renders your timesheet EXACTLY (drawings, frame counts, camera moves). You decide how many drawings each shot needs and how long each drawing is held.

Story plan:
${JSON.stringify({ title: plan.title, logline: plan.logline, characters: plan.characters.map((c) => ({ name: c.name, role: c.role || '' })), world_en: plan.world_en, story: plan.story.map((s) => ({ act: s.act, sections: s.sections, visual_en: s.visual_en })) }, null, 1)}
${fixed}

Shots (cut points are FIXED on the beat; do not change the count or timing):
${shotLines}

Rules (mixed method):
- NORMAL shots: 1 to ${NORMAL_MAX} drawings, held long (each exposure 3 frames or more, usually 8-48), and the camera moves over the drawing (pan / zoom / truck). Few drawings + a good camera move = calm, cinematic.
- HIGHLIGHT shots (marked HIGHLIGHT: chorus, high-energy bars): ${HIGHLIGHT_MIN} to ${HIGHLIGHT_MAX} drawings "on 2s" (every exposure 2 frames) for fluid action. Use cycles: e.g. A,B,C,B repeating for running, dancing, hair or cloth in the wind.
- Budget: at most ${budget} unique drawings for the WHOLE video (it protects the subscription usage limit). Follow "suggested drawings" per shot. Reuse drawings with cycles instead of drawing more.
- The exposure frames of each shot MUST add up exactly to that shot's frame count.
- Change drawings on the listed beat frames where you can (changes on the beat feel musical).
- scene_en: the shared background, place, time of day, lighting of the shot (all drawings of a shot share it). framing_en: shot size and angle (e.g. "wide shot, low angle").
- Each drawing's prompt_en: one or two English sentences about only what this drawing shows (pose, action, expression, eyes/mouth, hair and cloth motion). Use the characters' exact names.
- camera.move: one of ${CAMERA_MOVES.join(', ')}. start/end framing: zoom 1.0-${ZOOM_MAX} (1.0 = the whole drawing), x and y from -1 to 1 = where the view sits inside the drawing (-1 = left/top edge, 1 = right/bottom edge). Pans need zoom 1.2 or more. ease: linear, in, out or inout.
- fx (optional, per shot): any of ${FX_TYPES.join(', ')}.
- transition_out: from this shot into the next. type: ${Object.keys(TRANSITIONS).join(', ')}. beats: 0 for cut, otherwise 0.5, 1 or 2. ${trStyle}
- Cycle shorthand inside "exposure" is allowed: {"cycle": ["A","B","C","B"], "each": 2, "repeat": 6}.
- Original content only. No text, letters or speech bubbles in drawings.
- Extra instructions from the user: ${wf.extraInstructions || '(none)'}

Return ONLY this JSON shape with exactly ${segments.length} shots (the "exposure" list is required):
{"shots": [{"shot": 1, "highlight": false, "characters": ["Name"], "scene_en": "...", "framing_en": "wide shot, eye level",
  "drawings": [{"id": "A", "prompt_en": "..."}, {"id": "B", "prompt_en": "..."}],
  "exposure": [{"drawing": "A", "frames": 36}, {"drawing": "B", "frames": 24}],
  "camera": {"move": "pan_left", "start": {"zoom": 1.25, "x": 0.8, "y": 0}, "end": {"zoom": 1.25, "x": -0.8, "y": 0}, "ease": "inout"},
  "fx": [], "transition_out": {"type": "cut", "beats": 0}}]}`;
}

function validXsheet(o) {
  const shots = Array.isArray(o) ? o : o && o.shots;
  return !!(Array.isArray(shots) && shots.length > 0 && shots.some((s) => s && typeof s === 'object' && (Array.isArray(s.drawings) || Array.isArray(s.exposure) || Array.isArray(s.exposures))));
}

// ---------------- 정리 (검사 · 고치기) ----------------

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function letter(i) { return i < 26 ? LETTERS[i] : `${LETTERS[Math.floor(i / 26) - 1]}${LETTERS[i % 26]}`; }

/** 그림 목록 정리: id 를 A, B, C… 로 다시 붙이고 예전 id → 새 id 표를 돌려준다 */
function cleanDrawings(raw, notes, shotNo) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const map = new Map();
  list.forEach((d, i) => {
    let prompt;
    let oldId;
    if (typeof d === 'string') { prompt = d; oldId = letter(i); } else if (d && typeof d === 'object') {
      prompt = [d.prompt_en || d.prompt || d.pose_en || d.pose || d.description || d.action || d.desc, d.expression_en || d.expression]
        .filter(Boolean).map((x) => str(x, 400)).join(', ');
      oldId = d.id != null ? d.id : d.name != null ? d.name : d.label != null ? d.label : letter(i);
    } else return;
    if (!prompt) { prompt = 'same scene, small change of pose and expression'; notes.push(`컷 ${shotNo}: 설명 없는 그림에 기본 설명을 붙였어요`); }
    if (out.length >= HIGHLIGHT_MAX) return;
    const id = letter(out.length);
    const k = String(oldId).trim().toUpperCase();
    if (!map.has(k)) map.set(k, id);
    out.push({ id, prompt_en: str(prompt, 600) });
  });
  return { drawings: out, map };
}

/** 노출(exposure) 목록 읽기: 여러 모양을 받아 준다 ({drawing,frames}, "A:12", ["A",12], {cycle:[...]}, seconds) */
function parseExposure(raw, map, drawings, highlight, notes, shotNo) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const resolve = (id) => {
    const k = String(id == null ? '' : id).trim().toUpperCase();
    if (map.has(k)) return map.get(k);
    if (drawings.some((d) => d.id === k)) return k;
    const n = parseInt(k, 10);
    if (Number.isFinite(n) && n >= 1) return drawings[(n - 1) % drawings.length].id;
    if (/^[A-Z]{1,2}$/.test(k)) {
      const idx = LETTERS.indexOf(k[k.length - 1]);
      notes.push(`컷 ${shotNo}: 없는 그림 ${k} 를 다른 그림으로 바꿨어요`);
      return drawings[Math.max(0, idx) % drawings.length].id;
    }
    return null;
  };
  const defFrames = highlight ? 2 : 12;
  const framesOf = (o) => {
    if (o.frames != null || o.f != null || o.duration_frames != null) return Math.round(num(o.frames ?? o.f ?? o.duration_frames, defFrames));
    if (o.seconds != null || o.sec != null || o.duration != null) return Math.round(num(o.seconds ?? o.sec ?? o.duration, defFrames / FPS) * FPS);
    return defFrames;
  };
  for (const e of list) {
    if (typeof e === 'string') {
      const m = /^\s*([A-Za-z]{1,2}|\d+)\s*[:x×*=\s-]?\s*(\d+)?\s*$/.exec(e);
      if (m) { const d = resolve(m[1]); if (d) out.push({ drawing: d, frames: m[2] ? Number(m[2]) : defFrames }); }
      continue;
    }
    if (Array.isArray(e)) { const d = resolve(e[0]); if (d) out.push({ drawing: d, frames: Math.round(num(e[1], defFrames)) }); continue; }
    if (!e || typeof e !== 'object') continue;
    if (Array.isArray(e.cycle)) {
      const ids = e.cycle.map(resolve).filter(Boolean);
      if (!ids.length) continue;
      const each = Math.max(1, Math.round(num(e.each ?? e.frames ?? e.f, 2)));
      const rep = Math.max(1, Math.min(200, Math.round(num(e.repeat ?? e.times ?? e.loops, 1))));
      for (let r = 0; r < rep; r++) for (const d of ids) out.push({ drawing: d, frames: each, cycle: true });
      continue;
    }
    const d = resolve(e.drawing ?? e.id ?? e.d ?? e.cel ?? e.cell);
    if (d) out.push({ drawing: d, frames: framesOf(e) });
  }
  return out.filter((x) => x.frames > 0);
}

/** 붙어 있는 같은 그림은 하나로 합친다 */
function mergeRuns(exp) {
  const out = [];
  for (const e of exp) {
    const last = out[out.length - 1];
    if (last && last.drawing === e.drawing) last.frames += e.frames;
    else out.push({ drawing: e.drawing, frames: e.frames });
  }
  return out;
}

/**
 * 노출 프레임 합계를 컷 길이 N 에 정확히 맞춘다.
 *  - 2프레임씩 넘기는 컷(하이라이트)은 패턴을 이어서 반복하거나 잘라서 맞추고,
 *  - 길게 보여 주는 컷은 비율대로 늘리거나 줄인다. 남는 1프레임은 마지막 그림이 가져간다.
 */
function fitExposure(exp, N, { unit = 1, min = 2 } = {}) {
  let list = exp.map((e) => ({ drawing: e.drawing, frames: Math.max(1, Math.round(e.frames)) }));
  if (!list.length) return [];
  if (N <= 0) return [];
  const minU = Math.max(1, Math.ceil(min / unit));
  const T = Math.floor(N / unit);
  if (T < 1) return [{ drawing: list[0].drawing, frames: N }];
  let w = list.map((e) => Math.max(minU, Math.round(e.frames / unit)));
  const cycleLike = list.length >= 3 && Math.max(...list.map((e) => e.frames)) <= 4 * unit;
  if (cycleLike) {
    // 패턴 반복 또는 자르기
    const pat = list.map((e, i) => ({ drawing: e.drawing, w: w[i] }));
    const out = [];
    let acc = 0;
    for (let k = 0; acc < T; k++) {
      const p = pat[k % pat.length];
      const take = Math.min(p.w, T - acc);
      out.push({ drawing: p.drawing, w: take });
      acc += take;
    }
    list = out.map((o) => ({ drawing: o.drawing }));
    w = out.map((o) => o.w);
  } else {
    // 너무 많으면 뒤에서부터 덜어낸다
    while (list.length > 1 && list.length * minU > T) { list.pop(); w.pop(); }
    const total = sum(w);
    if (total !== T) {
      const raw = w.map((x) => (x * T) / total);
      const fl = raw.map((x) => Math.max(minU, Math.floor(x)));
      let diff = T - sum(fl);
      const order = raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]).map((x) => x[1]);
      for (let k = 0; diff > 0; k = (k + 1) % order.length, diff--) fl[order[k]]++;
      // 최소값 때문에 넘친 경우: 가장 긴 것에서 덜어낸다
      while (diff < 0) {
        let big = 0;
        for (let i = 1; i < fl.length; i++) if (fl[i] > fl[big]) big = i;
        if (fl[big] <= minU && fl.every((x) => x <= minU)) { fl[big] = Math.max(1, fl[big] - 1); diff++; continue; }
        fl[big]--;
        diff++;
      }
      w = fl;
    }
  }
  const out = list.map((e, i) => ({ drawing: e.drawing, frames: w[i] * unit }));
  const rest = N - sum(out.map((e) => e.frames));
  if (rest !== 0) out[out.length - 1].frames += rest;
  return mergeRuns(out.filter((e) => e.frames > 0));
}

/** 보통 컷: 그림이 바뀌는 순간을 가까운 박자(±3프레임)에 맞춘다. 합계는 그대로. */
function snapToBeats(exp, beats, { min = 3, reach = 3 } = {}) {
  if (exp.length < 2 || !beats.length) return exp;
  const out = exp.map((e) => ({ ...e }));
  let acc = 0;
  for (let i = 0; i < out.length - 1; i++) {
    acc += out[i].frames;
    let best = null;
    for (const b of beats) if (Math.abs(b - acc) <= reach && (best === null || Math.abs(b - acc) < Math.abs(best - acc))) best = b;
    if (best === null || best === acc) continue;
    const d = best - acc;
    if (out[i].frames + d >= min && out[i + 1].frames - d >= min) {
      out[i].frames += d;
      out[i + 1].frames -= d;
      acc = best;
    }
  }
  return out;
}

function normMove(m) {
  const k = key(m);
  if (CAMERA_MOVES.includes(String(m || '').toLowerCase())) return String(m).toLowerCase();
  return MOVE_ALIASES[k] || null;
}

function normFraming(o, d) {
  const src = o && typeof o === 'object' ? o : {};
  return {
    zoom: Math.round(clamp(num(src.zoom ?? src.z ?? src.scale, d.zoom), ZOOM_MIN, ZOOM_MAX) * 1000) / 1000,
    x: Math.round(clamp(num(src.x, d.x), -1, 1) * 1000) / 1000,
    y: Math.round(clamp(num(src.y, d.y), -1, 1) * 1000) / 1000,
  };
}

/** 카메라 정리: 모르는 움직임은 'hold', 빠진 구도는 미리 정한 값으로 */
function normalizeCamera(raw, fx = []) {
  const src = raw && typeof raw === 'object' ? raw : { move: raw };
  const move = normMove(src.move || src.type || src.name) || 'hold';
  const preset = CAMERA_PRESETS[move];
  const start = normFraming(src.start || src.from, preset.start);
  const end = normFraming(src.end || src.to, preset.end);
  if (move.startsWith('pan_')) {
    // 팬은 움직일 여유(확대)가 있어야 한다
    start.zoom = Math.max(start.zoom, 1.15);
    end.zoom = Math.max(end.zoom, 1.15);
  }
  if (move === 'shake' || fx.includes('shake')) {
    start.zoom = Math.max(start.zoom, 1.06);
    end.zoom = Math.max(end.zoom, 1.06);
  }
  const ease = EASES.includes(src.ease) ? src.ease : preset.ease;
  const cam = { move, start, end, ease };
  if (move === 'shake') cam.shake = clamp(num(src.shake ?? src.amount, 0.012), 0.002, 0.03);
  return cam;
}

function normalizeFx(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out = [];
  for (const x of list) {
    const k = key(typeof x === 'object' && x ? x.type || x.name : x);
    const v = FX_TYPES.find((t) => key(t) === k) || FX_ALIASES[k];
    if (v && !out.includes(v)) out.push(v);
  }
  return out.slice(0, 3);
}

function easeP(p, ease) {
  const t = clamp(p, 0, 1);
  if (ease === 'in') return t * t;
  if (ease === 'out') return 1 - (1 - t) * (1 - t);
  if (ease === 'inout') return t * t * (3 - 2 * t);
  return t;
}

/** 진행도 p(0~1) 에서의 카메라 구도 */
function cameraAt(cam, p) {
  const e = easeP(p, cam.ease);
  const lerp = (a, b) => a + (b - a) * e;
  return { zoom: lerp(cam.start.zoom, cam.end.zoom), x: lerp(cam.start.x, cam.end.x), y: lerp(cam.start.y, cam.end.y) };
}

/** 그 컷이 등장하는 이야기 막(act) */
function actFor(plan, i, n) {
  const st = (plan && plan.story) || [];
  if (!st.length) return { visual_en: 'the main character in a beautiful painted landscape', summary_ko: '' };
  return st[Math.min(st.length - 1, Math.floor((i / Math.max(1, n)) * st.length))];
}

/** 하이라이트 컷의 노출: 2프레임씩 A,B,C,…,C,B (왕복) 반복 */
function cycleExposure(ids, N) {
  const order = ids.length > 2 ? [...ids, ...ids.slice(1, -1).reverse()] : ids;
  return fitExposure(order.map((d) => ({ drawing: d, frames: 2 })), N, { unit: 2, min: 2 });
}

/** 보통 컷의 노출: 그림 k 장을 박자에 맞춰 고르게 길게 */
function holdExposure(ids, N, beats) {
  const each = Math.floor(N / ids.length);
  const exp = ids.map((d, i) => ({ drawing: d, frames: i === ids.length - 1 ? N - each * (ids.length - 1) : each }));
  return snapToBeats(fitExposure(exp, N, { unit: 1, min: 3 }), beats, { min: 3, reach: 6 });
}

const FALLBACK_MOVES = ['zoom_in', 'pan_right', 'truck_in', 'pan_left', 'zoom_out', 'pan_up'];
const HIGHLIGHT_POSES = [
  'key pose at the start of the motion', 'anticipation, body pulled back', 'moving fast, strong action line, hair and clothes swept back',
  'peak of the motion, arms wide', 'follow-through, hair and cloth still moving', 'settling into a bright smile',
  'turning toward the viewer', 'leaning forward with energy', 'jumping, feet off the ground', 'landing softly',
  'spinning, skirt or coat flaring', 'final joyful pose',
];

/** LLM 결과가 없거나 망가진 컷을 PC 가 대신 짠다 */
function fallbackShot(seg, i, ctx) {
  const N = ctx.frames[i];
  const hl = ctx.highlights[i];
  const n = Math.max(1, (ctx.alloc && ctx.alloc[i]) || idealCount(N, hl));
  const act = actFor(ctx.plan, i, ctx.segments.length);
  const who = ((ctx.plan && ctx.plan.characters) || []).filter((c) => c.role !== 'guest').map((c) => c.name).slice(0, 2);
  const subject = who.length ? who.join(' and ') : 'the main character';
  const drawings = Array.from({ length: n }, (_, k) => ({
    id: letter(k),
    prompt_en: hl
      ? `${subject}: ${HIGHLIGHT_POSES[k % HIGHLIGHT_POSES.length]}`
      : k === 0 ? `${subject}, key pose: ${act.visual_en}` : `${subject}, a little later: ${k % 2 ? 'expression changes, looks in a new direction' : 'small step forward, wind in the hair'}`,
  }));
  const ids = drawings.map((d) => d.id);
  const beats = ctx.beats ? ctx.beats[i] : [];
  return {
    highlight: hl,
    characters: who,
    scene_en: str(act.visual_en, 400),
    framing_en: hl ? 'medium shot, dynamic angle' : i % 3 === 0 ? 'wide shot, eye level' : 'medium shot',
    drawings,
    exposure: hl ? cycleExposure(ids, N) : holdExposure(ids, N, beats),
    camera: normalizeCamera({ move: hl ? (i % 2 ? 'zoom_in' : 'truck_in') : FALLBACK_MOVES[i % FALLBACK_MOVES.length] }),
    fx: i === 0 ? ['fade_in'] : i === ctx.segments.length - 1 ? ['fade_out'] : hl && i % 2 ? ['sparkle'] : [],
    transition_out: { type: i % 4 === 3 ? 'dissolve' : 'cut', beats: i % 4 === 3 ? 1 : 0 },
    source: 'fallback',
  };
}

/** 쓰이지 않거나 넘치는 그림 빼기: 노출에서 가장 적게 보이는 그림부터 (첫 그림은 남김) */
function dropDrawing(shot, N, hl) {
  const used = new Map(shot.drawings.map((d) => [d.id, 0]));
  for (const e of shot.exposure) used.set(e.drawing, (used.get(e.drawing) || 0) + e.frames);
  let victim = null;
  for (const d of shot.drawings.slice(1)) if (!victim || used.get(d.id) < used.get(victim.id)) victim = d;
  if (!victim) return false;
  shot.drawings = shot.drawings.filter((d) => d !== victim);
  // 빠진 그림의 노출은 바로 앞(없으면 뒤) 그림이 이어받는다
  const exp = [];
  shot.exposure.forEach((e, k) => {
    if (e.drawing !== victim.id) { exp.push({ ...e }); return; }
    const prev = exp[exp.length - 1];
    const next = shot.exposure.slice(k + 1).find((x) => x.drawing !== victim.id);
    exp.push({ drawing: prev ? prev.drawing : next ? next.drawing : shot.drawings[0].id, frames: e.frames });
  });
  shot.exposure = fitExposure(mergeRuns(exp), N, hl ? { unit: 2, min: 2 } : { unit: 1, min: 2 });
  return true;
}

/** 하이라이트 컷에 사이 그림(in-between)을 더해 6장으로 */
function addInbetweens(shot, want, N) {
  const base = shot.drawings.slice();
  if (!base.length) return;
  const added = [];
  let k = 0;
  while (base.length + added.length < want) {
    const a = base[k % base.length];
    const b = base[(k + 1) % base.length];
    added.push({
      id: letter(base.length + added.length),
      prompt_en: a === b
        ? `in-between motion drawing: ${a.prompt_en}, mid-movement with hair and clothes swinging`
        : `in-between drawing halfway from (${a.prompt_en}) to (${b.prompt_en})`,
      after: a.id,
    });
    k++;
  }
  // 순서: A, A~B, B, B~C, …
  const order = [];
  for (const d of base) {
    order.push(d.id);
    for (const x of added.filter((y) => y.after === d.id)) order.push(x.id);
  }
  shot.drawings = [...base, ...added.map(({ after, ...rest }) => rest)];
  shot.exposure = cycleExposure(order, N);
}

/**
 * LLM 이 짠 타임시트를 검사하고 고친다.
 * @param {any} raw LLM 결과 (망가졌거나 비어 있어도 됨)
 * @param {{segments:object[], frames:number[], highlights:boolean[], alloc?:number[], budget:number, plan:object,
 *          analysis:object, transitionStyle?:string}} ctx
 * @returns {{fps:number, budget:number, totalFrames:number, totalDrawings:number, notes:string[], shots:object[], transitions:object[]}}
 */
function normalizeXsheet(raw, ctx) {
  const { segments, frames, budget } = ctx;
  const notes = [];
  const starts = startFrames(segments);
  const beats = segments.map((s, i) => beatFramesIn(s, ctx.analysis || { beats: [] }, starts[i]));
  const c2 = { ...ctx, beats };
  const rawShots = Array.isArray(raw) ? raw : raw && Array.isArray(raw.shots) ? raw.shots : [];
  if (!rawShots.length) notes.push('AI 타임시트가 비어 있어서 PC 가 기본 타임시트를 짰어요');
  const byNo = new Map();
  rawShots.forEach((s) => { if (s && typeof s === 'object') { const n = Number(s.shot ?? s.index ?? s.clip ?? s.cut); if (Number.isFinite(n) && !byNo.has(n)) byNo.set(n, s); } });
  const llmFlags = rawShots.some((s) => s && typeof s.highlight === 'boolean' && s.highlight);

  let shots = segments.map((seg, i) => {
    const N = frames[i];
    const src = byNo.get(seg.index) || (rawShots.length === segments.length ? rawShots[i] : null);
    if (!src || typeof src !== 'object') {
      if (rawShots.length) notes.push(`컷 ${seg.index}: AI 결과가 없어서 PC 가 대신 짰어요`);
      return fallbackShot(seg, i, c2);
    }
    const hl = llmFlags && typeof src.highlight === 'boolean' ? src.highlight : ctx.highlights[i];
    let { drawings, map } = cleanDrawings(src.drawings || src.cels || src.keys, notes, seg.index);
    let exposure = drawings.length ? parseExposure(src.exposure || src.exposures || src.timing || src.sheet, map, drawings, hl, notes, seg.index) : [];
    if (!drawings.length) {
      notes.push(`컷 ${seg.index}: 그림 목록이 없어서 PC 가 대신 짰어요`);
      return fallbackShot(seg, i, c2);
    }
    if (!exposure.length) {
      notes.push(`컷 ${seg.index}: 노출표가 없어서 PC 가 만들었어요`);
      exposure = hl ? cycleExposure(drawings.map((d) => d.id), N) : holdExposure(drawings.map((d) => d.id), N, beats[i]);
    }
    // 보통 컷은 4장까지
    if (!hl && drawings.length > NORMAL_MAX) notes.push(`컷 ${seg.index}: 보통 컷이라 그림을 ${NORMAL_MAX}장으로 줄였어요`);
    const fx = normalizeFx(src.fx || src.effects);
    const shot = {
      highlight: !!hl,
      characters: (Array.isArray(src.characters) ? src.characters : []).map((x) => str(typeof x === 'object' && x ? x.name : x, 60)).filter(Boolean).slice(0, 4),
      scene_en: str(src.scene_en || src.scene || src.background || src.setting, 600) || str(actFor(ctx.plan, i, segments.length).visual_en, 400),
      framing_en: str(src.framing_en || src.framing || src.shot_size, 120),
      drawings,
      exposure,
      camera: normalizeCamera(src.camera || src.camera_move || src.move, fx),
      fx,
      transition_out: src.transition_out && typeof src.transition_out === 'object' ? { type: str(src.transition_out.type, 20) || 'cut', beats: num(src.transition_out.beats, 0) } : { type: 'cut', beats: 0 },
      source: 'llm',
    };
    // 쓰이지 않는 그림은 뺀다 (예산 낭비)
    const usedIds = new Set(shot.exposure.map((e) => e.drawing));
    const unused = shot.drawings.filter((d) => !usedIds.has(d.id));
    if (unused.length && usedIds.size) {
      shot.drawings = shot.drawings.filter((d) => usedIds.has(d.id));
      notes.push(`컷 ${seg.index}: 노출표에 없는 그림 ${unused.map((d) => d.id).join(',')} 는 그리지 않아요`);
    }
    shot.exposure = fitExposure(mergeRuns(shot.exposure), N, hl ? { unit: 2, min: 2 } : { unit: 1, min: 2 });
    while (!hl && shot.drawings.length > NORMAL_MAX) dropDrawing(shot, N, hl);
    return shot;
  });

  // ---- 예산: 하이라이트는 사이 그림으로 6장까지 채우고, 넘치면 보통 컷부터 줄인다 ----
  const hlFlags = shots.map((s) => s.highlight);
  const have = shots.map((s) => s.drawings.length);
  const desired = shots.map((s, i) => (s.highlight ? Math.max(have[i], Math.min(HIGHLIGHT_MIN, Math.floor(frames[i] / 2))) : have[i]));
  const target = fitCountsToBudget(desired, hlFlags, budget);
  shots.forEach((s, i) => {
    if (target[i] > have[i]) {
      addInbetweens(s, target[i], frames[i]);
      notes.push(`컷 ${segments[i].index}: 하이라이트라서 사이 그림을 더해 ${target[i]}장으로 만들었어요`);
      return;
    }
    let guard = 50;
    while (s.drawings.length > target[i] && guard-- > 0) if (!dropDrawing(s, frames[i], s.highlight)) break;
  });
  const after = sum(shots.map((s) => s.drawings.length));
  if (sum(desired) > after) notes.push(`그림 장수 예산(${budget}장)에 맞추려고 ${sum(desired) - after}장을 줄였어요`);

  // ---- 마무리: 박자 맞추기, 정지 화면 방지, 프레임 합계 최종 확인 ----
  shots = shots.map((s, i) => {
    const N = frames[i];
    if (!s.highlight && s.source === 'llm') s.exposure = snapToBeats(s.exposure, beats[i], { min: 3, reach: 3 });
    if (!s.highlight && s.drawings.length === 1 && s.camera.move === 'hold' && N > 72 && !s.fx.includes('shake')) {
      // 그림 한 장을 3초 넘게 가만히 두면 멈춘 것처럼 보인다 → 아주 천천히 다가가기
      s.camera = { move: 'zoom_in', start: { zoom: 1.02, x: 0, y: 0 }, end: { zoom: 1.1, x: 0, y: -0.05 }, ease: 'inout' };
    }
    if (sum(s.exposure.map((e) => e.frames)) !== N) s.exposure = fitExposure(s.exposure, N, { unit: 1, min: 1 });
    return {
      shot: segments[i].index,
      start: segments[i].start,
      end: segments[i].end,
      startFrame: starts[i],
      frames: N,
      ...s,
    };
  });
  // dissolve_in 효과는 앞 컷의 화면전환으로
  shots.forEach((s, i) => {
    if (i > 0 && s.fx.includes('dissolve_in') && (!shots[i - 1].transition_out || shots[i - 1].transition_out.type === 'cut')) {
      shots[i - 1].transition_out = { type: 'dissolve', beats: 1 };
    }
  });
  const beatPeriod = (ctx.analysis && ctx.analysis.beatPeriod) || 0.5;
  const transitions = resolveTransitions(segments, shots, beatPeriod).map((t, i) => {
    // 화면전환 길이를 짝수 프레임으로 (앞뒤 컷이 반씩 나눠 겹친다)
    let fr = t.xfade ? Math.max(2, Math.round((t.duration * FPS) / 2) * 2) : 0;
    fr = Math.min(fr, Math.floor(Math.min(frames[i], frames[i + 1]) * 0.6 / 2) * 2);
    if (fr < 2) return { type: 'cut', xfade: null, duration: 0, frames: 0 };
    return { ...t, frames: fr, duration: Math.round((fr / FPS) * 1000) / 1000 };
  });
  return {
    fps: FPS,
    budget,
    totalFrames: sum(frames),
    totalDrawings: sum(shots.map((s) => s.drawings.length)),
    notes: [...new Set(notes)],
    shots,
    transitions,
  };
}

/**
 * 사용자가 한 그림의 노출 프레임을 바꿨을 때: 바로 다음 칸(마지막이면 앞 칸)이 차이를 가져가서 합계를 지킨다.
 * @returns {object} 고친 컷 (원본은 그대로)
 */
function retimeExposure(shot, index, frames) {
  const exp = shot.exposure.map((e) => ({ ...e }));
  if (!exp[index]) throw new Error('그 칸을 찾을 수 없어요.');
  if (exp.length < 2) throw new Error('노출이 한 칸뿐인 컷은 길이를 바꿀 수 없어요. (컷 길이 = 노래 박자)');
  const want = Math.max(1, Math.round(Number(frames) || 1));
  const other = index + 1 < exp.length ? index + 1 : index - 1;
  const room = exp[index].frames + exp[other].frames - 1;
  const v = Math.min(want, room);
  exp[other].frames -= v - exp[index].frames;
  exp[index].frames = v;
  if (sum(exp.map((e) => e.frames)) !== shot.frames) throw new Error('프레임 합계가 맞지 않아요.');
  return { ...shot, exposure: exp };
}

/** 프레임 번호 → 그 프레임에 보이는 그림 id (렌더링용) */
function frameTable(shot) {
  const out = [];
  for (const e of shot.exposure) for (let k = 0; k < e.frames; k++) out.push(e.drawing);
  return out;
}

module.exports = {
  FPS, CAMERA_MOVES, CAMERA_PRESETS, FX_TYPES, NORMAL_MAX, HIGHLIGHT_MIN, HIGHLIGHT_MAX,
  shotFrames, markHighlights, autoBudget, resolveBudget, idealCount, fitCountsToBudget, allocateDrawings, beatFramesIn,
  xsheetPrompt, validXsheet, normalizeXsheet, fitExposure, snapToBeats, normalizeCamera, normalizeFx, cameraAt, easeP,
  fallbackShot, retimeExposure, frameTable, cycleExposure, holdExposure,
};
