#!/usr/bin/env node
'use strict';
// 테스트용 가짜 CLI (codex / grok / agy / claude 흉내). 실제 AI 를 부르지 않는다.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const name = path.basename(process.argv[1]).replace(/\.(js|cmd)$/, '');
const args = process.argv.slice(2);
const ffmpeg = process.env.FAKE_FFMPEG || 'ffmpeg';

const LEAKS = ['OPENAI_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY'].filter((k) => process.env[k]);
if (LEAKS.length) { console.error(`API KEY LEAK: ${LEAKS.join(',')}`); process.exit(42); }
if (args[0] === '--version') { console.log(`${name} 9.9.9-fake`); process.exit(0); }
if (process.env.FAKE_LIMIT === name) { console.error("Error: You've hit your usage limit. Try again in 2 hours."); process.exit(1); }
if (name === 'codex' && args[0] === 'login' && args[1] === 'status') { console.log('Logged in using ChatGPT'); process.exit(0); }

function readStdin() { try { return fs.readFileSync(0, 'utf8'); } catch (_) { return ''; } }
const usesFile = name === 'grok' || name === 'agy';
const prompt = usesFile ? fs.readFileSync(path.join(process.cwd(), 'PROMPT.md'), 'utf8') : readStdin();
fs.appendFileSync(path.join(process.cwd(), `fake-${name}-calls.log`), `${JSON.stringify(args)}\n`);
fs.writeFileSync(path.join(process.cwd(), `fake-${name}-prompt.txt`), prompt);

function img(out, color) {
  execFileSync(ffmpeg, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=1024x576:d=1`, '-frames:v', '1', out]);
}

if (/\$imagegen|image_gen|image generation/.test(prompt) && !/Return ONLY/.test(prompt)) {
  if (name === 'codex') {
    // 진짜 codex 처럼 CODEX_HOME/generated_images 에 저장 (작업 폴더로는 복사하지 않음 → 앱의 대체 탐지 확인)
    const dir = path.join(process.env.CODEX_HOME, 'generated_images', `sess-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    img(path.join(dir, 'ig_0001.png'), 'orange');
    console.log('DONE');
  } else {
    img(path.join(process.cwd(), 'output.png'), 'purple');
    console.log(JSON.stringify({ result: 'saved output.png' }));
  }
  process.exit(0);
}

// 글쓰기
const demo = require(path.join(process.env.FAKE_REPO_ROOT, 'src', 'main', 'ai', 'demo.js'));
let answer;
if (/"exposure"/.test(prompt)) {
  // 타임시트: 지시문의 컷 목록을 읽어서, 일부러 프레임 합계가 안 맞는 노출표를 돌려준다 (PC 가 고쳐야 함)
  const shots = [...prompt.matchAll(/- shot (\d+): .*?= (\d+) frames(.*)/g)].map((m) => ({ shot: Number(m[1]), frames: Number(m[2]), hl: /HIGHLIGHT/.test(m[3]) }));
  answer = {
    shots: shots.map((s, i) => (s.hl
      ? {
        shot: s.shot, highlight: true, characters: ['하루'], scene_en: 'rooftops in the rain at night',
        drawings: ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((id, k) => ({ id, prompt_en: `Haru running, step ${k + 1}` })),
        exposure: [{ cycle: ['A', 'B', 'C', 'D', 'E', 'F', 'G'], each: 2, repeat: 3 }],
        camera: { move: 'truck in' }, fx: ['sparkles'], transition_out: { type: 'flash', beats: 1 },
      }
      : {
        shot: s.shot, highlight: false, characters: i % 2 ? [] : ['하루'], scene_en: 'a quiet harbor at dusk', framing_en: 'wide shot',
        drawings: [{ id: '1', pose: 'Haru looks at the sea' }, { id: '2', pose: 'Haru turns and smiles' }, 'Haru waves'],
        exposure: ['1:30', ['2', 20], { drawing: '3', seconds: 1.5 }],
        camera: { move: 'PAN-LEFT', start: { zoom: 1.0, x: 0.9 } }, fx: [], transition_out: { type: 'dissolve', beats: 1 },
      })),
  };
} else if (/"episode_summary_ko"/.test(prompt) || /"logline"/.test(prompt)) {
  const plan = demo.demoPlan('가짜 주제', {}, null);
  plan.title = `${name} 가 쓴 기획`;
  // 고정 주인공을 멋대로 다시 디자인하려고 해도 앱이 무시해야 한다
  plan.guest_characters = [{ name: '하루', appearance_en: 'a tall adult man with blue hair' }, { name: '반디', appearance_en: 'a tiny glowing firefly spirit' }];
  answer = plan;
} else if (/"locked"/.test(prompt)) {
  answer = { locked: { ...demo.DEMO_CHARACTER.locked }, palette: demo.DEMO_CHARACTER.palette, rules: demo.DEMO_CHARACTER.rules };
} else if (/"topics"/.test(prompt)) {
  answer = { topics: ['가짜 주제 1', '가짜 주제 2'] };
} else {
  answer = { ok: true, hello: '안녕하세요' };
}
if (process.env.FAKE_BROKEN_XSHEET && /"exposure"/.test(prompt)) {
  console.log('Sorry, here is the timesheet: {"shots": [ {"shot": 1, "drawings": [ ... oops');
  process.exit(0);
}
const text = `Here you go:\n\`\`\`json\n${JSON.stringify(answer, null, 1)}\n\`\`\``;
if (name === 'codex') {
  const i = args.indexOf('-o');
  fs.writeFileSync(args[i + 1], text);
  console.log('[codex] working...');
} else if (usesFile) {
  fs.writeFileSync(path.join(process.cwd(), 'result.json'), JSON.stringify(answer));
  console.log(JSON.stringify({ status: 'SUCCESS', response: text }));
} else {
  console.log(JSON.stringify({ type: 'result', is_error: false, result: text }));
}
