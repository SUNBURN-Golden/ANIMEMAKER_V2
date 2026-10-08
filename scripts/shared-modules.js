'use strict';
// 데스크톱(Electron)과 안드로이드 앱(WebView, esbuild chrome94)이 '같은 파일' 로 함께 쓰는 모듈 목록 — 이 목록이 유일한 기준이다.
//  - 폰 쪽 빌드(mobile/)와 순수성 검사(test/shared-purity.test.js)가 이 목록을 읽는다.
//  - 목록의 모듈은 순수해야 한다: fs / path / os / crypto / child_process / electron 등 Node 내장 모듈을 불러오지 않고,
//    Buffer · __dirname · __filename · process 를 쓰지 않는다 (정말 필요한 한 줄은 줄 끝에 `// shared-ok: 이유`).
//    상대 경로(`./…`)로 불러오는 모듈도 모두 이 목록 안에 있어야 한다 (순수하지 않은 것이 몰래 따라 들어오지 못하게).
//  - 순수하지 않은 쪽(ffmpeg · fs · Electron)은 각 모듈의 옛 파일에 남아 있다:
//    characters.js · series.js · media/keyer.js · media/render.js · media/audio.js · ai/demo.js — 이 파일들은 목록에 넣지 않는다.
//  - dom:true (= browserOnly) : 브라우저 화면 부품이다. document 를 쓰므로 Node·Worker 에서는 불러올 수 없고 화면 쪽에서만 묶는다.
//  - 새 순수 모듈을 만들면 여기에 한 줄 더한다.
// 항목: { file: 저장소 기준 상대 경로(/ 로 구분), dom?: boolean, browserOnly?: boolean(= dom) }
module.exports = [
  { file: 'src/main/pipeline/xsheet.js' },
  { file: 'src/main/media/timeline.js' },
  { file: 'src/main/media/lyrics.js' },
  { file: 'src/main/defaults.js' },
  { file: 'src/main/ai/json.js' },
  { file: 'src/main/pipeline/prompts.js' },
  { file: 'src/main/characters-core.js' },
  { file: 'src/main/series-core.js' },
  { file: 'src/main/media/keyer-core.js' },
  { file: 'src/main/media/render-core.js' },
  { file: 'src/main/media/audio-analysis.js' },
  { file: 'src/main/ai/demo-data.js' },
  { file: 'src/main/pipeline/subs-core.js' },
  { file: 'src/shared/subtitle-style.js' },
  { file: 'src/shared/subtitle-render.js' },
  { file: 'src/shared/camera.js' },
  { file: 'src/renderer/js/lyricsync.js', dom: true, browserOnly: true },
];
