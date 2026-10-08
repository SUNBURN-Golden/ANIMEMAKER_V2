// 폰 앱 웹 부분 묶기: src → www (Capacitor 가 이 폴더를 앱 안에 넣는다)
//   node build.mjs          배포용 (줄이기, www/)
//   node build.mjs --dev    개발·시험용 (줄이지 않음 + 소스맵, www-dev/)   환경변수 AM_DEV=1 도 같다
import path from 'node:path';
import { buildApp } from './build-lib.mjs';

const dev = process.argv.includes('--dev') || process.env.AM_DEV === '1';
const r = await buildApp({ dev });
for (const m of r.missing) console.warn(`⚠ 공용 코드 ${m} 가 아직 없어요 — 쓰는 순간 오류가 나는 빈 껍데기로 대신했어요`);
console.log('built', path.relative(process.cwd(), r.out) || '.', dev ? '(개발용)' : '(배포용)');
