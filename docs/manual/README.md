# AnimeMaker 사용 설명서

> ⚠ 이 폴더의 설명서는 **AnimeMaker V1**(영상 클립 방식) 기준이에요. AnimeMaker V2 의 캐릭터 파일 · 시리즈 · 타임시트 · 렌더링은
> 저장소 맨 위의 [README.md](../../README.md) 와 앱 안의 [❓ 사용 방법] 을 봐 주세요.

초등학생도 따라 할 수 있게 쓴 설명서입니다. 내용은 모두 같고, 파일 모양만 다릅니다.

| 파일 | 여는 프로그램 |
| --- | --- |
| `AnimeMaker_사용설명서.pdf` | 아무 PDF 보기 (인쇄용으로 가장 좋아요) |
| `AnimeMaker_사용설명서.docx` | Microsoft Word |
| `AnimeMaker_사용설명서.hwp` | 한컴오피스 한글 |
| `AnimeMaker_사용설명서.hwpx` | 한컴오피스 한글 2014 이상 (`.hwp` 가 안 열리면 이것) |

## 다시 만들기 (개발자용)

내용은 `build/content.js` 한 곳에만 있고, 그림은 `build/img/` 에 있습니다.

```bash
cd docs/manual/build
npm i -g docx                     # 처음 한 번
pip install python-hwpx           # 처음 한 번

node make-docx.js ../AnimeMaker_사용설명서.docx                      # Word (맑은 고딕)
node make-docx.js /tmp/pdfsrc.docx "나눔바른고딕" "나눔스퀘어라운드 Bold"  # PDF 용 (글꼴이 PDF 에 들어감)
soffice --headless --convert-to pdf --outdir /tmp /tmp/pdfsrc.docx   # → /tmp/pdfsrc.pdf 를 이름 바꿔 복사
python3 make-hwp.py ../AnimeMaker_사용설명서                           # .hwpx + .hwp
```
