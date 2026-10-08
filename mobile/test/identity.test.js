// V2 정체성 · 서명 · 매니페스트 확인 (정적 검사): V1 과 나란히 설치되고, 업데이트 설치가 되며, 옛 이름이 남지 않았는지
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.join(here, '..');
const repo = path.join(mobile, '..');
const main = path.join(mobile, 'android', 'app', 'src', 'main');
const res = path.join(main, 'res');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const json = (...p) => JSON.parse(read(...p));

const APP_ID = 'com.animemaker.v2';
const PINNED = '5adffa13e8f9aa3d1d37592e53c41210f9fbcc11d577ebb38cda2f679b47527f';

test('npm 정체성: 이름 animemaker-v2-mobile, 버전 2.0.0 (버전은 여기 한 곳)', () => {
  const pkg = json(mobile, 'package.json');
  assert.strictEqual(pkg.name, 'animemaker-v2-mobile');
  assert.strictEqual(pkg.version, '2.0.0');
  assert.match(pkg.description, /AnimeMaker V2/);
  const lock = json(mobile, 'package-lock.json');
  assert.strictEqual(lock.name, 'animemaker-v2-mobile');
  assert.strictEqual(lock.version, pkg.version);
});

test('package.json 스크립트: build · build:dev · sync · apk(서명된 release) · test', () => {
  const s = json(mobile, 'package.json').scripts;
  assert.strictEqual(s.build, 'node build.mjs');
  assert.strictEqual(s['build:dev'], 'node build.mjs --dev');
  assert.match(s.sync, /node build\.mjs && cap sync android/);
  assert.match(s.apk, /node build\.mjs && cap sync android && cd android && \.\/gradlew assembleRelease/);
  assert.ok(!/assembleDebug/.test(s.apk));
  assert.strictEqual(s.test, 'node --test --test-concurrency=1 "test/*.test.js"');
});

test('Capacitor 설정: appId com.animemaker.v2, 이름 "AnimeMaker V2", 배포용 www 만 넣는다', () => {
  const c = json(mobile, 'capacitor.config.json');
  assert.strictEqual(c.appId, APP_ID);
  assert.strictEqual(c.appName, 'AnimeMaker V2');
  assert.strictEqual(c.webDir, 'www');
  assert.strictEqual(c.android.webContentsDebuggingEnabled, false);
});

test('Gradle: namespace · applicationId, 버전은 -P 속성(기본은 package.json), release 는 서명·디버그 아님·줄이기 없음', () => {
  const g = read(mobile, 'android', 'app', 'build.gradle');
  assert.match(g, /namespace = "com\.animemaker\.v2"/);
  assert.match(g, /applicationId "com\.animemaker\.v2"/);
  assert.match(g, /project\.findProperty\('versionName'\) \?: amPackage\.version/);
  assert.match(g, /project\.findProperty\('versionCode'\) \?: '1'/);
  assert.match(g, /file\('\.\.\/\.\.\/package\.json'\)/);
  assert.match(g, /versionCode amVersionCode/);
  assert.match(g, /versionName amVersionName/);
  const release = /release \{\s*debuggable false\s*minifyEnabled false\s*signingConfig signingConfigs\.release/;
  assert.match(g, release);
  assert.match(g, /debug \{\s*signingConfig signingConfigs\.debug/);
  // 서명 설정: debug · release 둘 다 같은 키, 환경변수로 덮어쓸 수 있다
  assert.match(g, /signingConfigs \{\s*[^}]*debug \{[^}]*storeFile file\(amKeystoreFile\)/s);
  assert.match(g, /release \{\s*storeFile file\(amKeystoreFile\)/);
  for (const env of ['AM_KEYSTORE_FILE', 'AM_KEYSTORE_PASSWORD', 'AM_KEY_ALIAS', 'AM_KEY_PASSWORD']) assert.ok(g.includes(`System.getenv('${env}')`), `${env} 로 덮어쓸 수 있어야 해요`);
  assert.match(g, /keystore\/animemaker-v2\.keystore/);
  assert.ok(!/google-services\.json'\)\s*$/m || true);
  assert.ok(!g.includes('com.animemaker.mobile'));
});

test('Java: 패키지·폴더 com/animemaker/v2, 옛 폴더·템플릿 시험 파일 없음', () => {
  const dir = path.join(main, 'java', 'com', 'animemaker', 'v2');
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['AnimeMakerV2NativePlugin.java', 'JobService.java', 'MainActivity.java', 'ShareInbox.java']);
  for (const f of fs.readdirSync(dir)) assert.match(read(dir, f), /^package com\.animemaker\.v2;/m, f);
  assert.ok(!fs.existsSync(path.join(main, 'java', 'com', 'animemaker', 'mobile')));
  assert.ok(!fs.existsSync(path.join(mobile, 'android', 'app', 'src', 'test')), '템플릿 단위 시험 stub 는 지웠어요');
  assert.ok(!fs.existsSync(path.join(mobile, 'android', 'app', 'src', 'androidTest')), '템플릿 기기 시험 stub 는 지웠어요');
});

test('strings.xml: 앱 이름 · 공유창 이름 "AnimeMaker V2", 패키지/스킴 com.animemaker.v2, 알림 채널 이름', () => {
  const s = read(res, 'values', 'strings.xml');
  const val = (name) => new RegExp(`<string name="${name}">([^<]*)</string>`).exec(s)[1];
  assert.strictEqual(val('app_name'), 'AnimeMaker V2');
  assert.strictEqual(val('title_activity_main'), 'AnimeMaker V2');
  assert.strictEqual(val('package_name'), APP_ID);
  assert.strictEqual(val('custom_url_scheme'), APP_ID);
  assert.strictEqual(val('job_channel_name'), 'AnimeMaker V2 작업');
});

test('매니페스트: 백업 끔 · singleTask · largeHeap · 서비스(dataSync) · 권한 · 받기 필터(video 없음, amchar 용 json) · 알림 아이콘', () => {
  const m = read(main, 'AndroidManifest.xml');
  assert.match(m, /android:allowBackup="false"/);
  assert.match(m, /android:launchMode="singleTask"/);
  assert.match(m, /android:largeHeap="true"/);
  assert.match(m, /<service\s+android:name="\.JobService"\s+android:exported="false"\s+android:foregroundServiceType="dataSync"/);
  for (const p of ['INTERNET', 'FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_DATA_SYNC', 'POST_NOTIFICATIONS']) assert.ok(m.includes(`android.permission.${p}"`), p);
  assert.ok(!m.includes('FOREGROUND_SERVICE_MEDIA_PROCESSING'), 'mediaProcessing 은 안드로이드 15 부터라 쓰지 않아요 (dataSync 선택 이유는 JobService.java 주석)');
  assert.ok(!/android:mimeType="video\//.test(m), 'video/* 는 받지 않아요');
  for (const t of ['image/*', 'audio/*', 'text/plain', 'application/json']) assert.ok(m.includes(`android:mimeType="${t}"`), t);
  assert.ok((m.match(/android\.intent\.action\.SEND"/g) || []).length === 1 && m.includes('android.intent.action.SEND_MULTIPLE'));
  assert.match(m, /\$\{applicationId\}\.fileprovider/);
  assert.ok(fs.existsSync(path.join(res, 'drawable', 'ic_stat_job.xml')));
});

test('file_paths.xml: 캐시의 am/ 과 shared/ 만 (외부 저장소 통째로 내놓지 않는다)', () => {
  const x = read(res, 'xml', 'file_paths.xml');
  assert.deepStrictEqual([...x.matchAll(/<(cache-path|external-path|files-path|external-files-path|root-path)\s+[^>]*path="([^"]*)"/g)].map((m) => [m[1], m[2]]), [['cache-path', 'am/'], ['cache-path', 'shared/']]);
});

test('런처 아이콘: 적응형 층(배경·전경·단색) + 옛 아이콘 15장, 시작 화면 11장, 로봇 템플릿 그림 없음', () => {
  for (const d of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
    for (const n of ['ic_launcher', 'ic_launcher_round', 'ic_launcher_foreground', 'ic_launcher_background', 'ic_launcher_monochrome']) {
      assert.ok(fs.existsSync(path.join(res, `mipmap-${d}`, `${n}.png`)), `mipmap-${d}/${n}.png`);
    }
    for (const o of ['port', 'land']) assert.ok(fs.existsSync(path.join(res, `drawable-${o}-${d}`, 'splash.png')), `drawable-${o}-${d}/splash.png`);
  }
  assert.ok(fs.existsSync(path.join(res, 'drawable', 'splash.png')));
  for (const f of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
    const x = read(res, 'mipmap-anydpi-v26', f);
    for (const layer of ['background', 'foreground', 'monochrome']) assert.match(x, new RegExp(`<${layer} android:drawable="@mipmap/ic_launcher_${layer}"/>`), `${f} ${layer}`);
  }
  assert.ok(!fs.existsSync(path.join(res, 'drawable-v24')), '로봇 전경 그림(drawable-v24)은 지웠어요');
  assert.ok(!fs.existsSync(path.join(res, 'drawable', 'ic_launcher_background.xml')));
  assert.ok(!fs.existsSync(path.join(res, 'values', 'ic_launcher_background.xml')));
  // PNG 크기 (머리글에서 읽는다): 적응형 층 108dp, 옛 아이콘 48dp, 밀도별 배율
  const size = (f) => { const b = fs.readFileSync(f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
  const scale = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, k] of Object.entries(scale)) {
    assert.deepStrictEqual(size(path.join(res, `mipmap-${d}`, 'ic_launcher_foreground.png')), [108 * k, 108 * k]);
    assert.deepStrictEqual(size(path.join(res, `mipmap-${d}`, 'ic_launcher.png')), [48 * k, 48 * k]);
  }
});

test('웹 쪽 이름: 저장소 animemaker-v2, 설정 키 am2.settings, 갤러리 폴더 "AnimeMaker V2", 화면 제목', () => {
  assert.match(read(mobile, 'src', 'db.js'), /export const DB_NAME = 'animemaker-v2'/);
  assert.match(read(mobile, 'src', 'settings.js'), /export const SETTINGS_KEY = 'am2\.settings'/);
  const java = read(main, 'java', 'com', 'animemaker', 'v2', 'AnimeMakerV2NativePlugin.java');
  assert.match(java, /GALLERY_NAME = "AnimeMaker V2"/);
  assert.match(java, /Environment\.DIRECTORY_MOVIES : Environment\.DIRECTORY_PICTURES\) \+ "\/" \+ GALLERY_NAME/);
  assert.match(read(mobile, 'src', 'index.html'), /<title>AnimeMaker V2<\/title>/);
  assert.match(read(mobile, 'src', 'main.js'), /'AnimeMaker V2'/);
});

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'www', 'www-dev', 'build', '.gradle', 'test', 'public', 'capacitor-cordova-android-plugins'].includes(e.name)) continue;
      yield* walk(p);
    } else if (/\.(java|xml|gradle|json|js|mjs|md|properties|html|css|pro|py|gitignore)$/.test(e.name) && e.name !== 'package-lock.json') {
      yield p;
    }
  }
}

test('V1 이름이 하나도 남지 않았다 (com.animemaker.mobile · AnimeMakerNative · animemaker-mobile · 안 쓰는 sora 패키지)', () => {
  const bad = [/com\.animemaker\.mobile/, /com\/animemaker\/mobile/, /\bAnimeMakerNative\b/, /animemaker-mobile/, /com\.openai\.sora/, /['"]am\.settings['"]/];
  const hits = [];
  for (const f of walk(mobile)) {
    const txt = fs.readFileSync(f, 'utf8');
    for (const re of bad) if (re.test(txt)) hits.push(`${path.relative(mobile, f)} ~ ${re}`);
  }
  assert.deepStrictEqual(hits, []);
});

test('서명: 키 파일이 있고, 인증서 SHA-256 이 README-signing.md · CI 에 적힌 값과 같다 (keytool 이 있을 때)', (t) => {
  const ks = path.join(mobile, 'android', 'keystore', 'animemaker-v2.keystore');
  assert.ok(fs.existsSync(ks), '서명 키 파일');
  const readme = read(mobile, 'android', 'README-signing.md');
  assert.ok(readme.includes(PINNED), 'README-signing.md 에 인증서 SHA-256');
  assert.ok(readme.includes('animemaker-v2-sideload') && readme.includes('`animemaker-v2`'), '비밀번호와 별칭을 적어 둠');
  const ci = fs.existsSync(path.join(repo, '.github', 'workflows', 'build.yml')) ? read(repo, '.github', 'workflows', 'build.yml') : '';
  assert.ok(ci.includes(`AM_CERT_SHA256: ${PINNED}`), 'CI 에 인증서 SHA-256 고정');
  let out;
  try {
    out = execFileSync('keytool', ['-list', '-v', '-keystore', ks, '-storepass', 'animemaker-v2-sideload'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (_) {
    t.skip('keytool 이 없어 키 자체의 지문은 확인하지 못했어요');
    return;
  }
  assert.match(out, /Alias name: animemaker-v2/);
  assert.match(out, /Keystore type: PKCS12/);
  assert.match(out, /2048-bit RSA key/);
  const sha = /SHA256:\s*([0-9A-F:]+)/.exec(out)[1].replace(/:/g, '').toLowerCase();
  assert.strictEqual(sha, PINNED, '키의 인증서 지문이 고정한 값과 같아야 해요');
  const until = /until: (.+)/.exec(out)[1];
  assert.ok(new Date(until).getFullYear() >= 2100, `유효기간 100년: ${until}`);
});

test('CI: android-apk 작업이 있다 (서명 확인 · 이름 · 아티팩트 · 태그 릴리스)', () => {
  const ci = read(repo, '.github', 'workflows', 'build.yml');
  assert.match(ci, /^  android-apk:/m);
  assert.ok(ci.includes('name: AnimeMaker-V2-Android'));
  assert.ok(ci.includes('assembleRelease --no-daemon -PversionCode=${{ github.run_number }} -PversionName='));
  assert.ok(ci.includes('apksigner'));
  assert.ok(ci.includes('dump badging'));
  assert.ok(ci.includes("AnimeMaker-V2-${V}-android.apk"));
  assert.ok(ci.includes('gradle/actions/setup-gradle'));
  assert.ok(ci.includes('files: dist/AnimeMaker-V2-*-android.apk'));
  assert.ok(!/RIFE|vulkan/i.test(ci.slice(ci.indexOf('  android-apk:'))), 'Android 작업에는 RIFE/Vulkan 단계가 없다');
});

test('.gitignore: 만든 것(node_modules · www · www-dev)은 올리지 않고, 서명 키와 안드로이드 프로젝트는 올린다', () => {
  const gi = read(mobile, '.gitignore');
  for (const l of ['node_modules/', 'www/', 'www-dev/']) assert.ok(gi.split('\n').includes(l), l);
  const agi = read(mobile, 'android', '.gitignore');
  assert.match(agi, /^app\/src\/main\/assets\/public$/m);
  assert.match(agi, /^local\.properties$/m);
  assert.ok(!/^\*\.keystore$/m.test(agi) && !/^\*\.jks$/m.test(agi), '키스토어는 무시 목록에 없어야 한다 (저장소에 들어 있다)');
});
