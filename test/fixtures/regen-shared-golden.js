'use strict';
// 골든(shared-golden.json)을 *지금 코드로* 다시 만드는 도구. 평소에는 쓰지 않는다.
//  - 골든은 모듈을 *-core 로 나누기 전의 원본 코드로 만들어 둔 값이라서, 나눈 뒤에도 같은 값이 나오는지가 시험의 뜻이다.
//  - 동작을 일부러 바꿨을 때(예: 효과 추가, 색 맞추기 수식 변경)만, 바뀐 값이 의도한 것인지 확인한 다음 이 도구로 다시 만든다:
//      node test/fixtures/regen-shared-golden.js
//    다시 만든 JSON 의 diff 가 의도한 변화 말고는 없어야 한다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('./shared-golden');
const ff = require('../../src/main/media/ffmpeg');

const sinkState = G.installFrameSink(ff); // render.js 를 불러오기 전에
const src = path.join(__dirname, '..', '..', 'src', 'main');
const m = {
  K: require(path.join(src, 'media', 'keyer')),
  R: require(path.join(src, 'media', 'render')),
  A: require(path.join(src, 'media', 'audio')),
  C: require(path.join(src, 'characters')),
  S: require(path.join(src, 'series')),
  D: require(path.join(src, 'ai', 'demo')),
  P: require(path.join(src, 'pipeline', 'prompts')),
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am2-golden-'));
  try {
    const golden = await G.computeAll(m, dir, sinkState);
    const out = path.join(__dirname, 'shared-golden.json');
    fs.writeFileSync(out, `${JSON.stringify(golden, null, 2)}\n`);
    console.log(`wrote ${path.relative(process.cwd(), out)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
