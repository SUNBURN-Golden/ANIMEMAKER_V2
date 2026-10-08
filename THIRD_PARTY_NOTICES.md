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
| [Pretendard](https://github.com/orioncactus/pretendard) Bold v1.3.9 (`Pretendard-Bold.otf`) | 가사 자막 글꼴 '깔끔한 고딕' | SIL OFL 1.1 — Copyright (c) 2021, Kil Hyung-jin (https://github.com/orioncactus/pretendard), with Reserved Font Name Pretendard. 원문: `src/renderer/assets/fonts/OFL-Pretendard.txt` |
| [Jua](https://github.com/google/fonts/tree/main/ofl/jua) (`Jua-Regular.ttf`) | 가사 자막 글꼴 '동글동글' | SIL OFL 1.1 — Copyright 2018 The Jua Project Authors. 원문: `src/renderer/assets/fonts/OFL-Jua.txt` |
| [Do Hyeon](https://github.com/google/fonts/tree/main/ofl/dohyeon) (`DoHyeon-Regular.ttf`) | 가사 자막 글꼴 '굵은 예능체' | SIL OFL 1.1 — Copyright 2018 The Do Hyeon Project Authors. 원문: `src/renderer/assets/fonts/OFL-DoHyeon.txt` |
| [Gaegu](https://github.com/google/fonts/tree/main/ofl/gaegu) Bold (`Gaegu-Bold.ttf`) | 가사 자막 글꼴 '손글씨' | SIL OFL 1.1 — Copyright 2018 The Gaegu Project Authors. 원문: `src/renderer/assets/fonts/OFL-Gaegu.txt` |
| [Black Han Sans](https://github.com/google/fonts/tree/main/ofl/blackhansans) (`BlackHanSans-Regular.ttf`) | 가사 자막 글꼴 '아주 굵게' | SIL OFL 1.1 — Copyright 2015 The Black Han Sans Project Authors (https://github.com/zesstype/Black-Han-Sans). 원문: `src/renderer/assets/fonts/OFL-BlackHanSans.txt` |

타임시트대로 그림을 넘기고 카메라를 움직이는 **렌더링 합성기**(`src/main/media/render.js`), 인물 셀의 단색 배경을 빼는 **키어**(`src/main/media/keyer.js`)는 이 앱의 자체 코드이며, 따로 설치할 프로그램이 없습니다.

가사 자막 글꼴 5개(위 표의 Pretendard · Jua · Do Hyeon · Gaegu · Black Han Sans)는 **고치지 않은 원본 파일**을 `src/renderer/assets/fonts/` 에 그대로 넣었고, 각 라이선스 원문도 같은 폴더에 있습니다. 글꼴 이름은 자막 화면 안에서 `AM Jua` 처럼 별칭(@font-face)으로만 쓰며 글꼴 파일은 바꾸지 않았습니다. (Google Fonts 한글 글꼴은 가장 많이 쓰는 한글 약 2,350~2,580자를 담고 있어서, 없는 글자는 Pretendard 와 내 컴퓨터 글꼴로 자동으로 채워집니다.)

RIFE 는 소스 저장소에 들어 있지 않고, 설치 파일을 만들 때 `scripts/fetch-rife.js` 가 공식 릴리스 zip 을 받아 SHA256 을 확인한 뒤 실행 파일·`vcomp140.dll`·`LICENSE`·`rife-v4.6/` 만 꺼내 넣습니다.

이 앱이 실행하는 **Codex CLI, Grok Build CLI, Antigravity CLI, Claude Code** 는 앱에 포함되지 않으며, 사용자가 각 회사의 안내에 따라 직접 설치합니다.
각 CLI 와 AI 서비스의 이용약관은 해당 회사의 정책을 따릅니다.

## 안드로이드 앱 (APK, `mobile/`)

AnimeMaker V2 안드로이드 앱(`AnimeMaker-V2-<버전>-android.apk`)에는 아래 구성요소가 들어갑니다. 위 표의 **가사 자막 글꼴 5개**도 같은 파일(수정 없음)로 APK 안 `assets/fonts/` 에 함께 들어가고, 각 글꼴의 라이선스 원문(`OFL-*.txt`)도 같은 폴더에 있습니다.

| 구성요소 | 용도 | 라이선스 |
|---|---|---|
| [Capacitor](https://capacitorjs.com/) (`@capacitor/core` · `android` · `app` · `clipboard` · `filesystem`) | 웹 화면을 안드로이드 앱으로 감싸는 틀, 앱 신호(뒤로가기 · 앱으로 돌아옴) · 클립보드 · 캐시 파일 쓰기 | MIT — Copyright (c) 2017-present Drifty Co. |
| [Mediabunny](https://mediabunny.dev/) | 영상(MP4) 묶기 · 읽기 (WebCodecs 인코더와 함께 쓰는 폰 안 영상 만들기) | MPL-2.0 — 수정하지 않은 npm 배포본을 그대로 묶어 씀. 소스는 https://github.com/Vanilagy/mediabunny |
| [AndroidX](https://developer.android.com/jetpack/androidx) (appcompat · core · coordinatorlayout · core-splashscreen · webkit 등) | 안드로이드 화면·알림·공유·시작 화면 부품 (Capacitor 가 함께 가져옴) | Apache-2.0 — Copyright The Android Open Source Project |
| [esbuild](https://esbuild.github.io/) (개발용, APK 에는 들어가지 않음) | 웹 화면 코드를 한 파일로 묶기 (`mobile/build.mjs`) | MIT — Copyright (c) 2020 Evan Wallace |
| [playwright-core](https://github.com/microsoft/playwright) (개발용, APK 에는 들어가지 않음) | 폰 화면을 Chromium 으로 열어 확인하는 시험 (`mobile/test/e2e.test.js`) | Apache-2.0 |
| [fake-indexeddb](https://github.com/dumbmatter/fakeIndexedDB) (개발용, APK 에는 들어가지 않음) | 폰 저장소(IndexedDB) 규칙을 Node 에서 시험 | Apache-2.0 |
| [Capacitor CLI](https://capacitorjs.com/docs/cli) (개발용, APK 에는 들어가지 않음) | 웹 화면을 안드로이드 프로젝트에 넣기 (`cap sync`) | MIT |

폰 앱은 데스크톱 앱과 **같은 파일**(`scripts/shared-modules.js` 의 공용 계산 코드: 타임시트 · 가사 · 박자 분석 · 자막 · 카메라 …)을 묶어 쓰고, FFmpeg·RIFE 같은 데스크톱 전용 프로그램은 APK 에 들어가지 않습니다.
런처 아이콘·시작 화면은 이 앱의 자체 그림(`build/icon.png` 에서 `mobile/tools/make-icons.py` 로 만듦)입니다.
APK 는 `mobile/android/keystore/` 의 이 앱 전용 개인 설치용 키로 서명합니다 (`mobile/android/README-signing.md`).
