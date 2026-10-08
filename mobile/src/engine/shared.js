// PC 앱과 '같은 파일' 로 쓰는 공용 순수 코드를 한곳에서 가져온다 (경로가 바뀌면 여기만 고친다).
// 전부 scripts/shared-modules.js 의 목록에 있는 모듈이다 — 단, edits-core.js 는 아직 목록에 없다(순수하지만 목록에 넣어 달라고 보고했다).
import X from '../../../src/main/pipeline/xsheet.js';
import P from '../../../src/main/pipeline/prompts.js';
import EC from '../../../src/main/pipeline/edits-core.js';
import SubCore from '../../../src/main/pipeline/subs-core.js';
import T from '../../../src/main/media/timeline.js';
import L from '../../../src/main/media/lyrics.js';
import Key from '../../../src/main/media/keyer-core.js';
import J from '../../../src/main/ai/json.js';
import DD from '../../../src/main/ai/demo-data.js';
import D from '../../../src/main/defaults.js';
import CC from '../../../src/main/characters-core.js';
import SC from '../../../src/main/series-core.js';
import SubStyle from '../../../src/shared/subtitle-style.js';

export { X, P, EC, SubCore, T, L, Key, J, DD, D, CC, SC, SubStyle };
