# Third-party notices

AnimeMaker V2 설치 파일에는 아래 구성요소가 함께 들어갑니다. (V1 과 같은 구성에, V2 에서 사이 그림 엔진 RIFE 가 더해졌습니다)

| 구성요소 | 용도 | 라이선스 |
|---|---|---|
| [Electron](https://www.electronjs.org/) | 데스크톱 앱 실행 환경 | MIT (Chromium 등 포함 구성요소는 각자의 라이선스, 설치 폴더의 `LICENSES.chromium.html` 참고) |
| [FFmpeg](https://ffmpeg.org/) via [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) | 노래 분석용 디코딩, 그림 읽기, 화면전환(xfade)·필름 질감 필터, 영상 압축 | ffmpeg-static 은 GPL-3.0-or-later. 포함된 FFmpeg 바이너리는 GPL 로 빌드되었으며(libx264 등), 소스는 https://ffmpeg.org/download.html 및 바이너리 배포처 안내를 따릅니다. |
| [playwright-core](https://github.com/microsoft/playwright) | 자동 클릭 모드의 브라우저 연결 | Apache-2.0 |
| [rife-ncnn-vulkan](https://github.com/nihui/rife-ncnn-vulkan) 릴리스 20221029 (nihui) | 움직이는 컷의 사이 그림 만들기 (설치 폴더 `resources/rife`) | MIT — Copyright (c) 2020 nihui. 원문은 `resources/rife/LICENSE`. 안에 정적으로 묶인 [ncnn](https://github.com/Tencent/ncnn) 은 BSD-3-Clause |
| [RIFE](https://github.com/hzwer/ECCV2022-RIFE) `rife-v4.6` 모델 (hzwer) | 위 엔진이 쓰는 움직임 계산 모델 (`resources/rife/rife-v4.6`) | MIT (hzwer, [ECCV2022-RIFE](https://github.com/hzwer/ECCV2022-RIFE/blob/main/LICENSE)) |
| `vcomp140.dll` (윈도우 판만, rife-ncnn-vulkan 릴리스에 들어 있음) | RIFE 의 CPU 병렬 처리 (Microsoft Visual C++ OpenMP 런타임) | Microsoft Visual C++ 재배포 가능 패키지 조건 |

타임시트대로 그림을 넘기고 카메라를 움직이는 **렌더링 합성기**(`src/main/media/render.js`), 인물 셀의 단색 배경을 빼는 **키어**(`src/main/media/keyer.js`)는 이 앱의 자체 코드이며, 따로 설치할 프로그램이 없습니다.

RIFE 는 소스 저장소에 들어 있지 않고, 설치 파일을 만들 때 `scripts/fetch-rife.js` 가 공식 릴리스 zip 을 받아 SHA256 을 확인한 뒤 실행 파일·`vcomp140.dll`·`LICENSE`·`rife-v4.6/` 만 꺼내 넣습니다.

이 앱이 실행하는 **Codex CLI, Grok Build CLI, Antigravity CLI, Claude Code** 는 앱에 포함되지 않으며, 사용자가 각 회사의 안내에 따라 직접 설치합니다.
각 CLI 와 AI 서비스의 이용약관은 해당 회사의 정책을 따릅니다.
