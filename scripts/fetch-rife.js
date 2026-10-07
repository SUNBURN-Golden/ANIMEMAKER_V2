#!/usr/bin/env node
'use strict';
// 사이 그림 엔진 RIFE (rife-ncnn-vulkan, MIT) 를 받아서 설치 파일에 넣을 폴더로 꺼낸다.
//  - 공식 릴리스 zip 을 받고 SHA256 을 확인한다 (다르면 멈춤)
//  - zip 안에서 필요한 것만 꺼낸다: 실행 파일, vcomp140.dll (윈도우), LICENSE, rife-v4.6/ 모델
//  - 결과: vendor/rife/<플랫폼>-<아키텍처>/  (electron-builder 가 resources/rife 로 넣는다)
//
// 사용법:
//   node scripts/fetch-rife.js                    지금 PC 용 (윈도우 x64 / 리눅스 x64)
//   node scripts/fetch-rife.js --platform win32   윈도우용
//   node scripts/fetch-rife.js --zip <파일>        이미 받은 zip 사용 (SHA256 은 그래도 확인)
//   node scripts/fetch-rife.js --force            이미 있어도 다시
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const VERSION = '20221029';
const MODEL = 'rife-v4.6';
const RELEASES = {
  win32: {
    name: `rife-ncnn-vulkan-${VERSION}-windows`,
    sha256: 'd8e4d772d26cd8006ef0ad0bc82eb191b53c68677d1ae2f42506d74cbbbea606',
    files: ['rife-ncnn-vulkan.exe', 'vcomp140.dll', 'LICENSE'],
  },
  linux: {
    name: `rife-ncnn-vulkan-${VERSION}-ubuntu`,
    sha256: '1e2c7ee7fa7daa326542d50622f0afedc80cf6f1858bda411d16385ffa5cdf68',
    files: ['rife-ncnn-vulkan', 'LICENSE'],
  },
};
const urlFor = (r) => `https://github.com/nihui/rife-ncnn-vulkan/releases/download/${VERSION}/${r.name}.zip`;

function args(argv) {
  const o = { platform: process.platform, arch: process.arch, zip: null, force: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--platform') o.platform = argv[++i];
    else if (a === '--arch') o.arch = argv[++i];
    else if (a === '--zip') o.zip = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--force') o.force = true;
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

async function sha256File(file) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

async function download(url, dst) {
  console.log(`⬇ ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`다운로드 실패: HTTP ${res.status}`);
  const tmp = `${dst}.part`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  fs.renameSync(tmp, dst);
}

// ---- 아주 작은 zip 읽기 (중앙 디렉터리 → 필요한 파일만 꺼내기) ----
function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, b, got, len - got, pos + got);
    if (!n) throw new Error('zip 파일이 잘렸어요.');
    got += n;
  }
  return b;
}

function zipEntries(fd, size) {
  const tailLen = Math.min(size, 65557);
  const tail = readAt(fd, size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('zip 끝(EOCD)을 찾을 수 없어요.');
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOff = tail.readUInt32LE(eocd + 16);
  if (cdOff === 0xffffffff || count === 0xffff) {
    // ZIP64
    const loc = eocd - 20;
    if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error('ZIP64 정보를 찾을 수 없어요.');
    const z64 = Number(tail.readBigUInt64LE(loc + 8));
    const rec = readAt(fd, z64, 56);
    count = Number(rec.readBigUInt64LE(32));
    cdSize = Number(rec.readBigUInt64LE(40));
    cdOff = Number(rec.readBigUInt64LE(48));
  }
  const cd = readAt(fd, cdOff, cdSize);
  const out = [];
  let p = 0;
  for (let k = 0; k < count; k++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 목록이 이상해요.');
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    let comp = cd.readUInt32LE(p + 20);
    let uncomp = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let local = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    // ZIP64 추가 정보
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = cd.readUInt16LE(e);
      const len = cd.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (uncomp === 0xffffffff) { uncomp = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (comp === 0xffffffff) { comp = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (local === 0xffffffff) { local = Number(cd.readBigUInt64LE(q)); q += 8; }
      }
      e += 4 + len;
    }
    out.push({ name, method, crc, comp, uncomp, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function extractEntry(fd, ent) {
  const lh = readAt(fd, ent.local, 30);
  if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`zip 항목이 이상해요: ${ent.name}`);
  const start = ent.local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  const raw = readAt(fd, start, ent.comp);
  let data;
  if (ent.method === 0) data = raw;
  else if (ent.method === 8) data = zlib.inflateRawSync(raw);
  else throw new Error(`지원하지 않는 압축 방식(${ent.method}): ${ent.name}`);
  if (data.length !== ent.uncomp) throw new Error(`크기가 맞지 않아요: ${ent.name}`);
  if (typeof zlib.crc32 === 'function' && (zlib.crc32(data) >>> 0) !== ent.crc) throw new Error(`CRC 가 맞지 않아요: ${ent.name}`);
  return data;
}

/** zip 에서 필요한 파일만 out 폴더로. @returns {string[]} 꺼낸 상대 경로 */
function extractNeeded(zipFile, rel, out) {
  const fd = fs.openSync(zipFile, 'r');
  try {
    const entries = zipEntries(fd, fs.fstatSync(fd).size);
    const prefix = `${rel.name}/`;
    const wanted = (n) => {
      if (!n.startsWith(prefix) || n.endsWith('/')) return null;
      const r = n.slice(prefix.length);
      if (rel.files.includes(r)) return r;
      if (r.startsWith(`${MODEL}/`) && !r.slice(MODEL.length + 1).includes('/')) return r;
      return null;
    };
    const done = [];
    for (const ent of entries) {
      const r = wanted(ent.name);
      if (!r) continue;
      const dst = path.join(out, ...r.split('/'));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, extractEntry(fd, ent));
      done.push(r);
    }
    return done;
  } finally {
    fs.closeSync(fd);
  }
}

async function main() {
  const o = args(process.argv.slice(2));
  if (o.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 14).join('\n'));
    return;
  }
  const rel = RELEASES[o.platform];
  if (!rel) {
    console.log(`ℹ ${o.platform} 용 RIFE 는 넣지 않아요. 사이 그림은 ffmpeg 로 만들어요.`);
    return;
  }
  if (o.arch !== 'x64') {
    console.log(`ℹ ${o.platform}-${o.arch} 용 RIFE 는 없어요 (x64 만). 사이 그림은 ffmpeg 로 만들어요.`);
    return;
  }
  const root = path.join(__dirname, '..');
  const out = o.out ? path.resolve(o.out) : path.join(root, 'vendor', 'rife', `${o.platform}-${o.arch}`);
  const bin = rel.files[0];
  if (!o.force && fs.existsSync(path.join(out, bin)) && fs.existsSync(path.join(out, MODEL, 'flownet.bin'))) {
    console.log(`✔ 이미 있어요: ${out}`);
    return;
  }
  const cache = path.join(root, 'vendor', 'rife', '.cache');
  const zip = o.zip ? path.resolve(o.zip) : path.join(cache, `${rel.name}.zip`);
  if (!o.zip && !(fs.existsSync(zip) && (await sha256File(zip)) === rel.sha256)) {
    fs.mkdirSync(cache, { recursive: true });
    await download(urlFor(rel), zip);
  }
  const sum = await sha256File(zip);
  if (sum !== rel.sha256) {
    if (!o.zip) { try { fs.unlinkSync(zip); } catch (_) { /* noop */ } }
    throw new Error(`SHA256 이 다릅니다 (받은 파일이 공식 릴리스가 아니에요).\n  기대: ${rel.sha256}\n  실제: ${sum}`);
  }
  console.log(`✔ SHA256 확인: ${sum}`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const done = extractNeeded(zip, rel, out);
  for (const f of rel.files) if (!done.includes(f)) throw new Error(`zip 에 ${f} 가 없어요.`);
  for (const f of ['flownet.bin', 'flownet.param']) if (!done.includes(`${MODEL}/${f}`)) throw new Error(`zip 에 ${MODEL}/${f} 가 없어요.`);
  if (o.platform !== 'win32') fs.chmodSync(path.join(out, bin), 0o755);
  fs.writeFileSync(path.join(out, 'SOURCE.txt'), `rife-ncnn-vulkan ${VERSION} (MIT, nihui) + ${MODEL} model (MIT, hzwer)\n${urlFor(rel)}\nsha256 ${rel.sha256}\n`);
  console.log(`✔ ${done.length}개 파일 → ${out}`);
  for (const f of done) console.log(`   ${f}`);
}

if (require.main === module) {
  main().catch((e) => { console.error(`✖ ${e.message}`); process.exit(1); });
}

module.exports = { RELEASES, VERSION, MODEL, zipEntries, extractNeeded, sha256File, urlFor };
