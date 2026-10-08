# 서명 키 — AnimeMaker V2 안드로이드 앱

안드로이드는 **같은 서명 키로 만든 APK 끼리만** 이미 깔린 앱 위에 덮어 설치(업데이트)해 줍니다.
서명이 다르면 먼저 앱을 지워야 하고, **앱을 지우면 앱 안에 저장된 작품·캐릭터가 모두 사라집니다.**
그래서 V2 앱은 처음부터 끝까지 같은 키로 서명합니다. (V1 앱의 키와는 관계가 없고, V1 키는 쓰지 않았어요 — V1·V2 는 나란히 설치돼요.)

## 지금 쓰는 키 (개인 설치용, 저장소에 들어 있어요)

| 항목 | 값 |
|---|---|
| 파일 | `mobile/android/keystore/animemaker-v2.keystore` (PKCS12) |
| 별칭 (alias) | `animemaker-v2` |
| 저장소 · 키 비밀번호 | `animemaker-v2-sideload` (둘 다 같음) |
| 알고리즘 | RSA 2048, 유효기간 100년 (2026-01-01 ~ 2125-12-08) |
| 소유자 | `CN=AnimeMaker V2 (personal sideload), OU=AnimeMaker, O=SUNBURN-Golden, C=KR` |
| 인증서 SHA-256 | `5adffa13e8f9aa3d1d37592e53c41210f9fbcc11d577ebb38cda2f679b47527f` |
| (같은 값, 콜론 표기) | `5A:DF:FA:13:E8:F9:AA:3D:1D:37:59:2E:53:C4:12:10:F9:FB:CC:11:D5:77:EB:B3:8C:DA:2F:67:9B:47:52:7F` |

이 키는 **GitHub 로 나눠 주는 개인용 설치 파일(sideload)** 에 쓰는 키라서 일부러 저장소에 넣었어요 (CI 가 비밀 없이도 늘 같은 서명을 하도록).
저장소를 볼 수 있는 사람은 누구나 이 키로 서명할 수 있으니, **스토어 배포나 모르는 사람에게 나눠 줄 앱에는 쓰지 마세요.**

### 만든 방법 (다시 만들 일은 없어야 해요)
```bash
keytool -genkeypair -keystore mobile/android/keystore/animemaker-v2.keystore -storetype PKCS12 \
  -alias animemaker-v2 -keyalg RSA -keysize 2048 -validity 36500 -startdate "2026/01/01 00:00:00" \
  -storepass animemaker-v2-sideload \
  -dname "CN=AnimeMaker V2 (personal sideload), OU=AnimeMaker, O=SUNBURN-Golden, C=KR"
```

## 지키는 것
- **이 파일을 지우거나 새로 만들지 마세요.** 새 키로 만든 APK 는 기존 앱 위에 설치되지 않습니다.
- CI(`.github/workflows/build.yml` 의 `android-apk`)는 만든 APK 의 인증서 SHA-256 이 위 값과 같은지 확인하고, 다르면 실패해요 (`AM_CERT_SHA256`).
- 버전 번호: `versionName` 은 `mobile/package.json` 의 `version` 하나에서 읽고, `versionCode` 는 CI 실행 번호(`github.run_number`)를 `-PversionCode` 로 넘겨요 (업데이트 설치는 versionCode 가 이전보다 커야 해요). 로컬 빌드의 기본값은 `1` 이라서, CI 가 만든 APK 위에 로컬 빌드를 덮어 설치하려면 `adb install -r -d` 가 필요해요.

## 확인하는 법
```bash
$ANDROID_HOME/build-tools/36.0.0/apksigner verify --print-certs mobile/android/app/build/outputs/apk/release/app-release.apk
# → Signer #1 certificate SHA-256 digest: 5adffa13…527f 이어야 해요
keytool -list -v -keystore mobile/android/keystore/animemaker-v2.keystore -storepass animemaker-v2-sideload
```

## 나중에 비밀 키로 바꾸고 싶을 때
1. 새 키를 만든다 (위 명령에서 파일 이름·비밀번호만 바꿔서). **안전한 곳에 따로 백업**해 둔다 — 잃어버리면 같은 문제가 또 생겨요.
2. 키 파일을 base64 로 바꿔 GitHub 저장소 Secrets 에 넣고(`AM_KEYSTORE_BASE64`, `AM_KEYSTORE_PASSWORD`, `AM_KEY_ALIAS`, `AM_KEY_PASSWORD`), CI 에서 파일로 풀어 놓은 뒤 환경변수 `AM_KEYSTORE_FILE`(경로) · `AM_KEYSTORE_PASSWORD` · `AM_KEY_ALIAS` · `AM_KEY_PASSWORD` 로 넘긴다. `app/build.gradle` 이 이 환경변수를 읽으면 저장소의 키 대신 그것으로 서명해요 (`debug` · `release` 모두).
3. `build.yml` 의 `AM_CERT_SHA256` 을 새 키의 값으로 고친다.
4. ⚠ 이미 앱을 깐 사람은 덮어 설치가 안 되므로, 바꾸기 전에 앱 안의 캐릭터·영상을 내보내 두게 안내하세요.
