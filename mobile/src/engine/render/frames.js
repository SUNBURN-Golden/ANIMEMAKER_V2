// 프레임 계산 (순수 계산, 화면·DOM 없음): 컷 길이 · 화면전환 · lead/tail 을 PC 앱(runner.step_render + assemble.assembleAnimation)과 똑같이 맞춘다.
//
// 용어: 출력 프레임 R = 완성 영상의 R 번째 장(0부터, 정수, 24fps). 컷 i 는 N_i 프레임.
//   - 컷 i 는 출력 프레임 [start_i, start_i + N_i) 에 자기 프레임을 가진다 (start = 앞 컷 프레임 수의 누적 합, 합계 = xs.totalFrames).
//   - 컷 j 와 j+1 사이 화면전환 T_j 프레임(짝수)은 컷 경계 start_{j+1} 가운데로 [start_{j+1} - T/2, start_{j+1} + T/2) 에서 두 컷을 섞는다.
//     컷 j 는 경계 뒤 T/2 프레임 동안 마지막 구도·그림을 붙들고(tail), 컷 j+1 은 경계 앞 T/2 프레임 동안 첫 구도·그림을 붙든다(lead).
//   - PC 앱은 컷마다 영상 조각(lead + N + tail 프레임)을 만들고 ffmpeg xfade 로 잇는다. 조각 안의 번호 r = R - (start_i - lead_i)
//     (흔들림 · 라인 보일 · 반짝임 난수가 이 r 을 쓴다), 컷 안 프레임 f = clamp(r - lead, 0, N-1) = clamp(R - start_i, 0, N-1).
//   - 전환 진행도 p = k / T (k = 전환 안 번호 0..T-1). 첫 프레임은 앞 컷 그대로(p=0), 경계 프레임은 정확히 0.5, 마지막은 (T-1)/T.
//     (ffmpeg 7.0.2 xfade 로 직접 재서 확인했다: test/render-frames.test.js 가 xfade 이어붙이기 산수를 그대로 흉내 내어 맞춰 본다)
//   - 화면전환 프레임 수는 짝수로 쓴다: xs.transitions[j].xfade 가 있고 frames ≥ 2 일 때만 겹친다 (컷이면 0).

export const FPS = 24;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 컷 j 와 j+1 사이 화면전환 프레임 수. 짝수, 화면전환이 없으면(컷) 0 */
export function transitionFrames(xs, j) {
  const t = xs && xs.transitions && xs.transitions[j];
  if (!t || !t.xfade) return 0;
  const f = Math.floor(Number(t.frames) || 0);
  if (f < 2) return 0;
  return f - (f % 2);
}

/**
 * 컷별 구간표.
 * @param {{fps?:number,totalFrames?:number,shots:{shot?:number,frames:number}[],transitions?:{xfade:string|null,frames:number}[]}} xs
 * @returns {{fps:number,total:number,sum:number,spans:{i:number,shot:number,start:number,frames:number,end:number,lead:number,tail:number,clipStart:number,clipFrames:number}[],
 *            trs:{j:number,xfade:string,frames:number,half:number,cut:number,from:number,to:number}[]}}
 *   total = 완성 영상 프레임 수(xs.totalFrames), sum = 컷 프레임 합계(보통 같다. total 이 더 길면 마지막 장면을 붙들고, 짧으면 자른다 — assemble 의 tpad/trim 과 같다)
 */
export function buildLayout(xs) {
  const shots = (xs && xs.shots) || [];
  const n = shots.length;
  const spans = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    const N = Math.max(1, Math.floor(Number(shots[i].frames) || 1));
    const lead = i > 0 ? transitionFrames(xs, i - 1) / 2 : 0;
    const tail = i < n - 1 ? transitionFrames(xs, i) / 2 : 0;
    spans.push({
      i, shot: Number.isFinite(Number(shots[i].shot)) ? Number(shots[i].shot) : i + 1, start, frames: N, end: start + N,
      lead, tail, clipStart: start - lead, clipFrames: lead + N + tail,
    });
    start += N;
  }
  const trs = [];
  for (let j = 0; j + 1 < n; j++) {
    const T = transitionFrames(xs, j);
    if (!T) continue;
    const cut = spans[j + 1].start;
    trs.push({ j, xfade: xs.transitions[j].xfade, frames: T, half: T / 2, cut, from: cut - T / 2, to: cut + T / 2 });
  }
  const total = Number.isFinite(Number(xs && xs.totalFrames)) && Number(xs.totalFrames) > 0 ? Math.floor(Number(xs.totalFrames)) : start;
  return { fps: Number(xs && xs.fps) || FPS, total, sum: start, spans, trs };
}

function part(layout, i, R) {
  const s = layout.spans[i];
  return { i, shot: s.shot, r: R - s.clipStart, f: clamp(R - s.start, 0, s.frames - 1) };
}

/**
 * 출력 프레임 R 을 그리는 데 쓰는 컷 조각.
 * @returns {{R:number, kind:'single', a:{i,shot,r,f}} | {R:number, kind:'transition', a:{i,shot,r,f}, b:{i,shot,r,f}, tr:{j,xfade,frames,k,p}}}
 *   a = 앞 컷(또는 하나뿐인 컷), b = 뒤 컷(전환 중일 때). r = 조각 안 번호(난수용), f = 컷 안 프레임(구도·그림용, 범위 안으로 붙들린다).
 */
export function frameInfo(layout, R) {
  const last = Math.max(0, layout.total - 1);
  R = clamp(Math.floor(Number(R) || 0), 0, last);
  const { spans, trs } = layout;
  if (!spans.length) return { R, kind: 'single', a: { i: -1, shot: 0, r: R, f: 0 } };
  for (const tr of trs) {
    if (R >= tr.from && R < tr.to) {
      const k = R - tr.from;
      return { R, kind: 'transition', a: part(layout, tr.j, R), b: part(layout, tr.j + 1, R), tr: { j: tr.j, xfade: tr.xfade, frames: tr.frames, k, p: k / tr.frames } };
    }
  }
  // 컷 하나: 마지막으로 시작한 컷 (R 이 합계를 넘으면 마지막 컷이 마지막 장면을 붙든다)
  let lo = 0;
  let hi = spans.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (spans[mid].start <= R) lo = mid; else hi = mid - 1;
  }
  return { R, kind: 'single', a: part(layout, lo, R) };
}

/** 출력 프레임 R 한 장에 필요한 컷 번호들 (전환 중이면 둘) */
export function shotsForFrame(layout, R) {
  const fi = frameInfo(layout, R);
  return fi.kind === 'transition' ? [fi.a.i, fi.b.i] : [fi.a.i];
}

/** 출력 프레임 [from, to] 를 그릴 때 필요한 컷 번호들 (작은 것부터). 미리보기가 앞서 읽어 둘 때 쓴다 */
export function shotsForRange(layout, from, to) {
  const out = new Set();
  const lo = clamp(Math.floor(from), 0, Math.max(0, layout.total - 1));
  const hi = clamp(Math.floor(to), lo, Math.max(0, layout.total - 1));
  for (const s of layout.spans) {
    // 컷 조각은 [clipStart, clipStart + clipFrames) 를 덮는다 (마지막 컷은 total 이 더 길면 끝까지 붙든다)
    const end = s.i === layout.spans.length - 1 ? Math.max(s.clipStart + s.clipFrames, layout.total) : s.clipStart + s.clipFrames;
    if (s.clipStart <= hi && end > lo) out.add(s.i);
  }
  return [...out].sort((a, b) => a - b);
}

/** 컷의 영상 안 프레임 구간 [from, to) (자기 프레임만, lead/tail 제외) */
export function shotRange(layout, i) {
  const s = layout.spans[i];
  return s ? { from: s.start, to: s.end } : null;
}

/** 출력 프레임 → 초 (r / fps) */
export const frameToSeconds = (R, fps = FPS) => R / fps;
/** 초 → 출력 프레임 (아래로 버림, 부동소수 오차 방어) */
export const secondsToFrame = (t, fps = FPS) => Math.floor(t * fps + 1e-6);

/** 영상 해상도별 기본 비트레이트 (bps): 1080p 9M · 720p 5M · 540p 3M · 480p 이하 2M */
export function defaultBitrate(W, H) {
  const px = W * H;
  if (px >= 1.8e6) return 9e6;
  if (px >= 0.8e6) return 5e6;
  if (px >= 0.46e6) return 3e6;
  return 2e6;
}
