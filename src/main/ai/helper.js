'use strict';
// 도우미 모드: 사용자가 웹사이트에서 직접 만들고 '다운로드' 하면,
// 다운로드 폴더에 새로 생긴 파일을 자동으로 가져온다.
const fs = require('fs');
const path = require('path');

const PARTIAL = /\.(crdownload|part|partial|tmp|download)$/i;

function listCandidates(dir, exts, sinceMs) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
  const out = [];
  for (const e of ents) {
    if (!e.isFile() || PARTIAL.test(e.name)) continue;
    if (exts.length && !exts.includes(path.extname(e.name).toLowerCase())) continue;
    const p = path.join(dir, e.name);
    try {
      const st = fs.statSync(p);
      if (Math.max(st.mtimeMs, st.birthtimeMs || 0) >= sinceMs && st.size > 1000) out.push({ p, size: st.size, t: st.mtimeMs });
    } catch (_) { /* noop */ }
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * 다운로드 폴더에서 새 파일이 생기길 기다린다. 크기가 안정되면(다운로드 완료) 돌려준다.
 * @param {{dir:string, exts:string[], sinceMs:number, signal?:AbortSignal, ignore?:Set<string>}} o
 */
function waitForNewDownload(o) {
  return new Promise((resolve, reject) => {
    const sizes = new Map();
    const ignore = o.ignore || new Set();
    const timer = setInterval(() => {
      if (o.signal && o.signal.aborted) {
        clearInterval(timer);
        const e = new Error('사용자가 중지했습니다.');
        e.name = 'AbortError';
        reject(e);
        return;
      }
      for (const c of listCandidates(o.dir, o.exts, o.sinceMs)) {
        if (ignore.has(c.p)) continue;
        const prev = sizes.get(c.p);
        if (prev === c.size) {
          clearInterval(timer);
          resolve(c.p);
          return;
        }
        sizes.set(c.p, c.size);
      }
    }, 1200);
  });
}

const SITES = {
  gemini: { name: 'Gemini', url: 'https://gemini.google.com/app', good: ['image', 'video'] },
  grok: { name: 'Grok Imagine', url: 'https://grok.com/imagine', good: ['image', 'video'] },
  chatgpt: { name: 'ChatGPT', url: 'https://chatgpt.com/', good: ['image'] },
  sora: { name: 'Sora', url: 'https://sora.chatgpt.com/', good: ['video'] },
};

const EXTS = {
  image: ['.png', '.jpg', '.jpeg', '.webp'],
  video: ['.mp4', '.mov', '.webm', '.m4v'],
  music: ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.mp4', '.webm', '.m4v', '.mov'],
};

module.exports = { waitForNewDownload, listCandidates, SITES, EXTS };
