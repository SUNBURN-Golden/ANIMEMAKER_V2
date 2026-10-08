# AnimeMaker V2 사용 설명서

초등학생도 따라 할 수 있게 쓴 AnimeMaker V2 설명서입니다. 새 "쉬운 V2" 화면(컴퓨터)과 안드로이드 폰 앱 기준으로 다시 썼어요.
1~7장은 설치 · 처음 켜 보기 · 연습 모드 · AI 연결, 8~12장은 주인공 → 영상 만들기 → 만드는 동안(진행 카드 · 도움 카드) → 완성과 저장,
13~14장은 장면 고치기와 가사 자막 고치기(✨ 고친 것 반영하기), 15장은 폰에서 만들기(AI 앱에 부탁하고 받아 오기), 16~19장은 움직임 방식 · 문제 해결 · 약속 · 낱말 사전,
맨 뒤 부록은 어른을 위한 안내(구독 전용, 개인정보, 약관, 폰 앱을 아직 확인하지 못한 부분)입니다. 내용은 모두 같고, 파일 모양만 다릅니다. (36쪽 안팎)

| 파일 | 여는 프로그램 |
| --- | --- |
| `AnimeMaker_V2_사용설명서.pdf` | 아무 PDF 보기 (인쇄용으로 가장 좋아요) |
| `AnimeMaker_V2_사용설명서.docx` | Microsoft Word |
| `AnimeMaker_V2_사용설명서.hwp` | 한컴오피스 한글 |
| `AnimeMaker_V2_사용설명서.hwpx` | 한컴오피스 한글 2014 이상 (`.hwp` 가 안 열리면 이것) |

## 다시 만들기 (개발자용)

내용은 `build/content.js` 한 곳에만 있고, 그림은 `build/img/` 에 있습니다.
화면 그림은 연습 모드로 실제 앱(컴퓨터 앱과 폰 앱)을 돌려 찍은 것을 잘라 쓴 것이고(`pc_*.png` 는 컴퓨터, `ph_*.png` 는 폰 화면 여러 장을 나란히 붙인 것),
`timing.png`, `inbetween.png`, `layers.png`, `motion_modes.png`, `pc_sidebar_map.png`, `pc_sub_examples.png`, `ph_loop.png` 는 설명용으로 따로 그린 그림입니다. 빌드는 그림을 새로 찍지 않고 `build/img/` 의 파일을 그대로 씁니다.
화면이 바뀌면 `content.js` 의 글과 `build/img/` 의 그림을 함께 고쳐 주세요. (쓰지 않는 그림 파일은 지워요.)

```bash
cd docs/manual/build
npm i -g docx                     # 처음 한 번
pip install python-hwpx           # 처음 한 번

node make-docx.js ../AnimeMaker_V2_사용설명서.docx                      # Word (맑은 고딕)
node make-docx.js /tmp/pdfsrc.docx "나눔바른고딕" "나눔스퀘어라운드 Bold"  # PDF 용 (글꼴이 PDF 에 들어감)
soffice --headless --convert-to pdf --outdir /tmp /tmp/pdfsrc.docx   # → /tmp/pdfsrc.pdf 를 이름 바꿔 복사
python3 make-hwp.py ../AnimeMaker_V2_사용설명서                           # .hwpx + .hwp
```

만든 뒤에는 `pdfinfo`(쪽 수), `pdffonts`(글꼴이 PDF 에 들어갔는지)와 `pdftoppm -r 50 -png` 로 몇 쪽을 그림으로 뽑아서 눈으로 확인하세요.
한글 파일(`.hwp`, `.hwpx`)은 python-hwpx 로 다시 열어 제목 수를 비교해 볼 수 있지만, 한컴오피스에서 직접 열어 보는 확인은 따로 해야 합니다.
