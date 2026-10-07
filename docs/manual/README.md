# AnimeMaker V2 사용 설명서

초등학생도 따라 할 수 있게 쓴 AnimeMaker V2 설명서입니다. 캐릭터 파일, 시리즈, 지브리식 움직임(AI 그림 + PC 사이 그림),
타임시트, 렌더링, 자막까지 담았습니다. 내용은 모두 같고, 파일 모양만 다릅니다.

| 파일 | 여는 프로그램 |
| --- | --- |
| `AnimeMaker_V2_사용설명서.pdf` | 아무 PDF 보기 (인쇄용으로 가장 좋아요) |
| `AnimeMaker_V2_사용설명서.docx` | Microsoft Word |
| `AnimeMaker_V2_사용설명서.hwp` | 한컴오피스 한글 |
| `AnimeMaker_V2_사용설명서.hwpx` | 한컴오피스 한글 2014 이상 (`.hwp` 가 안 열리면 이것) |

## 다시 만들기 (개발자용)

내용은 `build/content.js` 한 곳에만 있고, 그림은 `build/img/` 에 있습니다.
화면 그림은 체험 에피소드를 실제 앱에서 돌려 찍은 것이고, `timing.png`, `inbetween.png`, `layers.png` 는 설명용으로 따로 그린 그림입니다.

```bash
cd docs/manual/build
npm i -g docx                     # 처음 한 번
pip install python-hwpx           # 처음 한 번

node make-docx.js ../AnimeMaker_V2_사용설명서.docx                      # Word (맑은 고딕)
node make-docx.js /tmp/pdfsrc.docx "나눔바른고딕" "나눔스퀘어라운드 Bold"  # PDF 용 (글꼴이 PDF 에 들어감)
soffice --headless --convert-to pdf --outdir /tmp /tmp/pdfsrc.docx   # → /tmp/pdfsrc.pdf 를 이름 바꿔 복사
python3 make-hwp.py ../AnimeMaker_V2_사용설명서                           # .hwpx + .hwp
```
