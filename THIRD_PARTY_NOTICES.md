# Third-party notices

AnimeMaker V2 설치 파일에는 아래 구성요소가 함께 들어갑니다. (AnimeMaker V1 과 같은 구성이며, V2 에서 새로 추가된 외부 구성요소는 없습니다)

| 구성요소 | 용도 | 라이선스 |
|---|---|---|
| [Electron](https://www.electronjs.org/) | 데스크톱 앱 실행 환경 | MIT (Chromium 등 포함 구성요소는 각자의 라이선스, 설치 폴더의 `LICENSES.chromium.html` 참고) |
| [FFmpeg](https://ffmpeg.org/) via [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) | 노래 분석용 디코딩, 그림 읽기, 화면전환(xfade)·필름 질감 필터, 영상 압축 | ffmpeg-static 은 GPL-3.0-or-later. 포함된 FFmpeg 바이너리는 GPL 로 빌드되었으며(libx264 등), 소스는 https://ffmpeg.org/download.html 및 바이너리 배포처 안내를 따릅니다. |
| [playwright-core](https://github.com/microsoft/playwright) | 자동 클릭 모드의 브라우저 연결 | Apache-2.0 |

타임시트대로 그림을 넘기고 카메라를 움직이는 **렌더링 합성기**(`src/main/media/render.js`)는 이 앱의 자체 코드이며, 따로 설치할 프로그램이 없습니다.

이 앱이 실행하는 **Codex CLI, Grok Build CLI, Antigravity CLI, Claude Code** 는 앱에 포함되지 않으며, 사용자가 각 회사의 안내에 따라 직접 설치합니다.
각 CLI 와 AI 서비스의 이용약관은 해당 회사의 정책을 따릅니다.
