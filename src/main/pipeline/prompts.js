'use strict';
// 오케스트레이터 LLM 에게 보내는 지시문과, 그림 AI 에게 보내는 그림 프롬프트를 조립하는 함수들.
const { lockedText, characterBlock, paletteText } = require('../characters');
const { TRANSITIONS } = require('../media/timeline');

const TRANSITION_TYPES = Object.keys(TRANSITIONS);

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function summarizeEnergy(analysis) {
  const bars = analysis.bars || [];
  if (!bars.length) return 'unknown';
  const chunks = 12;
  const out = [];
  for (let i = 0; i < chunks; i++) {
    const seg = bars.slice(Math.floor((i * bars.length) / chunks), Math.floor(((i + 1) * bars.length) / chunks));
    if (!seg.length) continue;
    const e = seg.reduce((a, b) => a + b.energy, 0) / seg.length;
    out.push(e > 0.75 ? 'high' : e > 0.45 ? 'mid' : 'low');
  }
  return out.join(' → ');
}

/** 시리즈 약속 블록: 그림체, 세계관, 고정 주인공, 지난 이야기 */
function seriesBlock(series) {
  if (!series) return '';
  const b = series.bible || {};
  const chars = (series.characters || []).map((c) => `- ${c.name} (${c.role === 'protagonist' ? 'protagonist' : 'main character'}): ${lockedText(c)}${c.personality_ko ? `. Personality (Korean): ${c.personality_ko}` : ''}`);
  const prev = (series.previous || []).filter((e) => e.summary_ko || e.title);
  return `
## Series (keep continuity)
Series: "${series.name}" — this is episode ${series.episode}.
Art style bible (fixed for every episode): ${b.art_en || ''}
${b.world_ko ? `World / setting (Korean): ${b.world_ko}\n` : ''}${b.tone_ko ? `Tone (Korean): ${b.tone_ko}\n` : ''}${b.notes_en ? `Series rules: ${b.notes_en}\n` : ''}FIXED MAIN CHARACTERS — they star in every episode. Use exactly these names. Never rename them and never change their design, age, outfit or colors (their look is locked by character files and reference images):
${chars.join('\n')}
Previous episodes (continue the journey; do not repeat the same story):
${prev.length ? prev.map((e) => `- EP${e.number} "${e.title}": ${e.summary_ko}`).join('\n') : '- (none yet — this is the first episode: introduce the protagonist and their world)'}
`;
}

/**
 * 기획(스토리보드·시나리오) 지시문. 노래와 가사는 사용자가 올린 것(Suno 등)을 그대로 쓴다.
 * @param {string} topic 사용자가 적은 이번 에피소드 이야기 (비어 있을 수 있음)
 * @param {string} lyricsText 구간 태그가 포함된 가사 (없으면 연주곡)
 * @param {{duration:number,bpm:number,downbeats:number[],bars:{energy:number}[]}} analysis
 * @param {object} wf 워크플로우
 * @param {object|null} [series] 작업에 얼려 둔 시리즈 정보
 */
function planPrompt(topic, lyricsText, analysis, wf, series) {
  const energy = summarizeEnergy(analysis);
  const charShape = series
    ? '"guest_characters": [{"name": "...", "description_ko": "...", "appearance_en": "..."}],'
    : '"characters": [{"name": "...", "description_ko": "...", "appearance_en": "..."}],';
  return `# Task: storyboard and scenario for ${series ? 'one episode of an animated music video series' : 'an animated music video'}

The user already has the finished song (made with Suno) and its lyrics. You do NOT write lyrics or music.
You are the director, storyboard artist and scenario writer of a hand-drawn cel animation music video: still drawings shown one after another (24 fps), like 1980s-1990s feature animation, with gentle camera moves and lively highlights on the chorus.
${seriesBlock(series)}
## Song facts (measured from the audio file)
- Length: ${fmtTime(analysis.duration)} (${analysis.duration.toFixed(1)} seconds)
- Tempo: about ${Math.round(analysis.bpm)} BPM, ${analysis.downbeats.length} bars
- Energy over time (low/mid/high, in order): ${energy}

Lyrics (with Suno section tags):
${lyricsText || '(instrumental - no lyrics)'}

User's idea for this ${series ? 'episode' : 'video'} (Korean, may be empty): ${topic || '(none - derive the story from the lyrics and mood)'}

Workflow settings:
- Aspect ratio: ${wf.aspect}
- Visual style: ${(series && series.bible && series.bible.art_en) || wf.visualStyle}
- The video will be cut into ${wf.minClips}-${wf.maxClips} shots synced to the beat; chorus shots become lively highlights with many drawings, calm parts use few drawings with camera moves.
- Extra instructions from the user: ${wf.extraInstructions || '(none)'}

Rules:
- Korean for: title, logline, concept, episode_summary_ko, description_ko, summary_ko.
- English for: appearance_en, world_en, visual_en (image AIs work best in English).
- The story must follow the song from beginning to end: 5 to 9 acts, in order, each covering one or more lyric sections (use the section names from the lyrics, e.g. "Verse 1", "Chorus"). Choruses should feel like visual highlights.
${series
    ? '- The fixed main characters are the heroes. guest_characters: 0 to 2 NEW side characters for this episode only, with a precise appearance_en. Never list the fixed main characters there.\n- episode_summary_ko: 2 to 3 Korean sentences summarizing what happens in this episode (saved in the series log for the next episodes).'
    : '- characters: 1 to 3 characters (or none for a pure scenery video). appearance_en must be a precise, reusable description (age, hair, face, outfit, colors).\n- episode_summary_ko: 2 to 3 Korean sentences summarizing the story.'}
- Original content only: no real celebrities, brands, or copyrighted characters.

Return ONLY this JSON shape:
{
  "title": "...",
  "logline": "...",
  "concept": "...",
  "episode_summary_ko": "...",
  ${charShape}
  "world_en": "...",
  "story": [{"act": 1, "sections": ["Intro", "Verse 1"], "summary_ko": "...", "visual_en": "..."}],
  "music": {"genre": "...", "mood": "..."}
}`;
}

function validPlan(o) {
  return !!(o && typeof o === 'object' && o.title && Array.isArray(o.story) && o.story.length > 0);
}

function sameName(a, b) {
  const x = String(a || '').toLowerCase().replace(/\s+/g, '');
  const y = String(b || '').toLowerCase().replace(/\s+/g, '');
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

/**
 * 기획 결과 정리. 시리즈가 있으면 고정 주인공을 이름·생김새 그대로 맨 앞에 넣는다 (LLM 이 바꿔도 무시).
 */
function normalizePlan(o, wf, series) {
  const mains = series ? (series.characters || []).map((c) => ({
    name: c.name, role: c.role || 'main', fixed: true, description_ko: c.personality_ko || '', appearance_en: lockedText(c),
  })) : [];
  const llm = [...(Array.isArray(o.guest_characters) ? o.guest_characters : []), ...(Array.isArray(o.characters) ? o.characters : [])]
    .filter((c) => c && typeof c === 'object' && c.name);
  const others = llm.filter((c) => !mains.some((m) => sameName(m.name, c.name)))
    .slice(0, series ? 2 : 4)
    .map((c, i) => ({
      name: String(c.name || `인물${i + 1}`).slice(0, 40),
      role: series ? 'guest' : 'main',
      fixed: false,
      description_ko: String(c.description_ko || ''),
      appearance_en: String(c.appearance_en || c.appearance || ''),
    }));
  const story = (o.story || []).map((s, i) => ({
    act: i + 1,
    sections: Array.isArray(s.sections) ? s.sections.map(String) : [],
    summary_ko: String(s.summary_ko || s.summary || ''),
    visual_en: String(s.visual_en || ''),
  }));
  const logline = String(o.logline || '');
  return {
    title: String(o.title || '제목 없음').slice(0, 80),
    logline,
    concept: String(o.concept || ''),
    episode_summary_ko: String(o.episode_summary_ko || o.summary_ko || '').slice(0, 400)
      || [logline, story.length ? story[story.length - 1].summary_ko : ''].filter(Boolean).join(' ').slice(0, 300),
    visual_style: (series && series.bible && series.bible.art_en) || String(o.visual_style || wf.visualStyle || ''),
    characters: [...mains, ...others],
    world_en: String(o.world_en || ''),
    story,
    music: { genre: String((o.music && o.music.genre) || ''), mood: String((o.music && o.music.mood) || '') },
  };
}

/** 이 컷에 나오는 인물: 컷의 인물 목록 또는 장면·그림 설명에 이름이 나오는 인물 */
function charactersInShot(plan, shot, drawing) {
  const text = `${shot.scene_en || ''} ${(drawing && drawing.prompt_en) || ''}`.toLowerCase();
  return (plan.characters || []).filter((c) => (shot.characters || []).some((n) => sameName(n, c.name)) || (c.name && text.includes(c.name.toLowerCase())));
}

/**
 * 그림 한 장의 프롬프트 (영어). 캐릭터 고정 설명 · 팔레트 · 규칙을 '그대로' 넣고 일관성 지시를 강하게 건다.
 * @param {{plan:object, series?:object, shot:object, drawing:object, wf:object}} o
 */
function composeDrawingPrompt({ plan, series, shot, drawing, wf }) {
  const style = (series && series.bible && series.bible.art_en) || plan.visual_style || wf.visualStyle;
  const cast = charactersInShot(plan, shot, drawing);
  const fixed = series ? cast.filter((c) => c.fixed).map((c) => series.characters.find((s) => s.name === c.name)).filter(Boolean) : [];
  const others = cast.filter((c) => !fixed.some((f) => f.name === c.name));
  const lines = [
    `One drawing (a single frame) from a hand-drawn 2D cel animation sequence. Art style: ${style}.`,
    `Scene (shared by every drawing of this shot): ${shot.scene_en || plan.world_en}${shot.framing_en ? `. Framing: ${shot.framing_en}` : ''}.`,
    `This drawing: ${drawing.prompt_en}.`,
  ];
  for (const c of fixed) lines.push(characterBlock(c));
  for (const c of others) if (c.appearance_en) lines.push(`${c.name}: ${c.appearance_en}`);
  if (series && series.bible && series.bible.notes_en) lines.push(`Series rules: ${series.bible.notes_en}`);
  if (fixed.length) {
    lines.push('CONSISTENCY (most important): the character must look EXACTLY like the attached character reference sheets — same face shape, eye shape and eye color, hairstyle and hair color, body proportions and height, outfit, accessories and colors, same line weight and cel coloring. Do not redesign, restyle, age up or down, or change clothes.');
  }
  lines.push('Keep the same background, camera angle, lighting and color grading as the other drawings of this shot; only the pose, action and expression change.');
  lines.push(`Composition for a ${wf.aspect} frame, drawn a little wider than needed with margin around the subject (the camera will pan and zoom over this drawing).`);
  lines.push('No text, no letters, no speech bubbles, no captions, no watermark, no signature, no frame border.');
  return lines.join('\n');
}

// ---------------- 캐릭터 화면용 ----------------

/** 캐릭터 기준 그림(모델 시트) 프롬프트 */
function characterSheetPrompt(kind, c, art) {
  const pal = paletteText(c);
  const rules = [c.rules && c.rules.must && c.rules.must.length ? `MUST: ${c.rules.must.join('; ')}` : '', c.rules && c.rules.never && c.rules.never.length ? `NEVER: ${c.rules.never.join('; ')}` : ''].filter(Boolean).join('\n');
  const head = `Character design for an original hand-drawn animation. Art style: ${art}.\n${c.name}: ${lockedText(c)}${pal ? `\nColor palette (exact colors): ${pal}` : ''}${rules ? `\n${rules}` : ''}`;
  const tail = 'Plain white background, even flat lighting, flat cel colors, clean ink lines. No text, no labels, no letters, no watermark.';
  if (kind === 'expressions') {
    return `${head}\nExpression sheet: six head-and-shoulders drawings of the SAME character in a 3 by 2 grid — happy, sad, angry, surprised, determined, laughing. Same face, hair and outfit in every drawing. If a reference image is attached, match it exactly.\n${tail}`;
  }
  if (kind === 'fullbody') {
    return `${head}\nOne full-body drawing of the character in a clear, friendly standing pose, whole body visible from head to toe, facing three-quarter view. If a reference image is attached, match it exactly.\n${tail}`;
  }
  return `${head}\nCharacter model sheet (turnaround): the SAME character drawn four times side by side, full body, neutral standing pose — front view, three-quarter view, side view (profile), back view. Identical proportions, outfit and colors in every view.\n${tail}`;
}

/** 한국어로 적은 캐릭터 설명 → 영어 고정 설명 · 팔레트 · 규칙 (LLM) */
function describeCharacterPrompt(d) {
  return `# Task: lock the design of an original animation character

The user described their character in Korean. Turn it into a precise, reusable English design description for image AIs, so the character looks the same in every drawing of every episode.

Name: ${d.name || '(no name)'}
User's description (Korean): ${d.description_ko || '(none)'}
Personality (Korean): ${d.personality_ko || '(none)'}

Rules:
- summary: one English sentence with apparent age, build/height, and the signature look.
- face, hair, eyes, body, outfit, props: short, concrete English phrases (shapes, lengths, colors). Make reasonable choices for anything missing.
- palette: 4 to 8 named colors with exact hex codes (skin, hair, eyes, main outfit color, accent, props).
- rules.must: 2 to 5 things that must always be true (e.g. "always wears the red scarf").
- rules.never: 2 to 5 things that must never happen (e.g. "never change hair color").
- Original design only (not a copy of any existing character).

Return ONLY this JSON shape:
{"locked": {"summary": "...", "face": "...", "hair": "...", "eyes": "...", "body": "...", "outfit": "...", "props": "..."},
 "palette": [{"name": "...", "hex": "#rrggbb"}],
 "rules": {"must": ["..."], "never": ["..."]}}`;
}

function validCharacterDescription(o) {
  return !!(o && o.locked && typeof o.locked === 'object' && (o.locked.summary || o.locked.hair || o.locked.outfit));
}

module.exports = {
  TRANSITION_TYPES, planPrompt, validPlan, normalizePlan, fmtTime, summarizeEnergy, seriesBlock,
  charactersInShot, composeDrawingPrompt, characterSheetPrompt, describeCharacterPrompt, validCharacterDescription, sameName,
};
