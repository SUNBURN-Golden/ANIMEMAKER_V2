'use strict';
// 자동 클릭 '레시피' 실행기.
// 레시피(recipes.json)는 사이트 화면이 바뀌면 고칠 수 있도록 코드와 분리되어 있다.
// 원칙: 사람이 하는 동작만 사람 속도로 한다. CAPTCHA·봇 탐지 우회는 하지 않으며,
//       막히면 사용자에게 넘긴다(NeedsUserError → 도우미 모드).
const fs = require('fs');
const path = require('path');

class NeedsUserError extends Error {
  constructor(msg, reason) { super(msg); this.name = 'NeedsUserError'; this.reason = reason || 'blocked'; }
}

const DEFAULT_PROMPT_BOX = [
  'rich-textarea [contenteditable="true"]',
  'div.ql-editor[contenteditable="true"]',
  '#prompt-textarea',
  'textarea[placeholder]',
  '[contenteditable="true"][role="textbox"]',
  'textarea',
  '[contenteditable="true"]',
];
const SEND_LABEL = /(send|submit|generate|create|make|run|보내기|전송|생성|만들기)/i;
const ATTACH_LABEL = /(upload|attach|add (photo|image|file)|image|photo|file|업로드|첨부|이미지|사진|파일|추가)/i;
const DOWNLOAD_LABEL = /(download|save|다운로드|저장)/i;
const CAPTCHA_RE = /(unusual traffic|verify you are human|are you a robot|captcha|사람인지 확인|로봇이 아닙니다)/i;

function fillTemplate(s, params) {
  return String(s).replace(/\{\{(\w+)\}\}/g, (_, k) => (params[k] != null ? String(params[k]) : ''));
}

function fillDeep(v, params) {
  if (typeof v === 'string') return fillTemplate(v, params);
  if (Array.isArray(v)) return v.map((x) => fillDeep(x, params));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = fillDeep(x, params);
    return o;
  }
  return v;
}

function rand(a, b) { return a + Math.random() * (b - a); }

class RecipeRunner {
  /**
   * @param {import('playwright-core').Page} page
   * @param {{onStatus?:(s:{state:string,message:string})=>void, signal?:AbortSignal, pace?:number, loginWaitMs?:number}} opts
   */
  constructor(page, opts = {}) {
    this.page = page;
    this.opts = opts;
    this.pace = opts.pace || 1;
    this.knownMedia = new Set();
  }

  status(state, message) { if (this.opts.onStatus) this.opts.onStatus({ state, message }); }

  checkAbort() {
    if (this.opts.signal && this.opts.signal.aborted) {
      const e = new Error('사용자가 중지했습니다.');
      e.name = 'AbortError';
      throw e;
    }
  }

  async human(min = 600, max = 1600) {
    this.checkAbort();
    await this.page.waitForTimeout(rand(min, max) * this.pace);
  }

  async firstVisible(selectors, timeout = 0) {
    const until = Date.now() + timeout;
    do {
      this.checkAbort();
      for (const sel of selectors) {
        try {
          const loc = this.page.locator(sel);
          const n = await loc.count();
          for (let i = n - 1; i >= 0; i--) {
            const el = loc.nth(i);
            if (await el.isVisible().catch(() => false)) return el;
          }
        } catch (_) { /* 잘못된 선택자 무시 */ }
      }
      if (timeout) await this.page.waitForTimeout(500);
    } while (Date.now() < until);
    return null;
  }

  async buttonByLabel(re, scope) {
    const handles = await this.page.$$('button, [role="button"], a[download], a[href]');
    let best = null;
    for (const h of handles) {
      const info = await h.evaluate((el) => ({
        label: [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-tooltip'), el.innerText].filter(Boolean).join(' '),
        visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
        disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
      })).catch(() => null);
      if (!info || !info.visible || info.disabled) continue;
      if (re.test(info.label) && (!scope || scope.test(info.label))) best = h;
    }
    return best;
  }

  async detectBlockers() {
    const url = this.page.url();
    const text = await this.page.evaluate(() => (document.body ? document.body.innerText.slice(0, 5000) : '')).catch(() => '');
    const captchaFrame = await this.page.$('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"]').catch(() => null);
    if (captchaFrame || CAPTCHA_RE.test(text)) return 'captcha';
    if (/accounts\.google\.com|\/login|\/signin|auth\./i.test(url)) return 'login';
    return null;
  }

  /** 로그인/보안문자 화면이면 사용자가 해결할 때까지 기다린다 */
  async waitUserIfBlocked(readySelectors) {
    const block = await this.detectBlockers();
    if (!block) return;
    const msg = block === 'captcha'
      ? '보안 확인(CAPTCHA) 화면이 나왔습니다. 자동 클릭 브라우저 창에서 직접 확인을 마쳐 주세요. (자동으로 풀지 않습니다)'
      : '로그인이 필요합니다. 자동 클릭 브라우저 창에서 직접 로그인해 주세요. 로그인 정보는 이 PC 의 전용 프로필에만 저장됩니다.';
    this.status(block === 'captcha' ? 'captcha' : 'login', msg);
    const until = Date.now() + (this.opts.loginWaitMs || 15 * 60 * 1000);
    while (Date.now() < until) {
      this.checkAbort();
      await this.page.waitForTimeout(2500);
      if (!(await this.detectBlockers())) {
        const ok = !readySelectors || (await this.firstVisible(readySelectors, 1000));
        if (ok) { this.status('running', '계속 진행합니다.'); return; }
      }
    }
    throw new NeedsUserError(msg, block);
  }

  async mediaSnapshot() {
    const list = await this.page.evaluate(() => [...document.querySelectorAll('img, video, audio, video source, audio source')]
      .map((e) => e.currentSrc || e.src).filter(Boolean)).catch(() => []);
    list.forEach((s) => this.knownMedia.add(s));
  }

  async findNewMedia(kind) {
    return this.page.evaluate(({ kind, known }) => {
      const knownSet = new Set(known);
      const out = [];
      const want = (tag) => {
        if (kind === 'media') return tag === 'video' || tag === 'audio';
        if (kind === 'image') return tag === 'img';
        return tag === kind;
      };
      for (const el of document.querySelectorAll('img, video, audio')) {
        const tag = el.tagName.toLowerCase();
        if (!want(tag)) continue;
        const src = el.currentSrc || el.src || (el.querySelector('source') && el.querySelector('source').src);
        if (!src || knownSet.has(src)) continue;
        if (tag === 'img') {
          if (!el.complete || el.naturalWidth < 256 || el.naturalHeight < 256) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 120 || r.height < 120) continue;
        } else if (!(el.readyState >= 1 || el.duration > 0 || src.startsWith('blob:')
          || /\.(mp4|webm|mov|m4v|mp3|m4a|wav|ogg)(\?|#|$)/i.test(src))) {
          continue;
        }
        out.push({ src, tag, w: el.naturalWidth || el.videoWidth || 0, dur: el.duration || 0 });
      }
      return out;
    }, { kind, known: [...this.knownMedia] }).catch(() => []);
  }

  async run(recipe, params, outDir) {
    const ctx = { result: null };
    for (const raw of recipe.steps) {
      this.checkAbort();
      const step = fillDeep(raw, params);
      if (step.when && !params[step.when]) continue;
      try {
        await this.step(step, params, ctx, outDir);
      } catch (e) {
        if (e.name === 'AbortError' || e instanceof NeedsUserError) throw e;
        if (step.optional) continue;
        throw new NeedsUserError(`자동 클릭 중 막혔습니다 (${step.do}): ${e.message}`, 'step');
      }
    }
    if (!ctx.result) throw new NeedsUserError('결과 파일을 가져오지 못했습니다.', 'no-result');
    return ctx.result;
  }

  async step(s, params, ctx, outDir) {
    const p = this.page;
    switch (s.do) {
      case 'goto':
        this.status('running', `${s.url} 여는 중`);
        await p.goto(s.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await this.human(1500, 3000);
        await this.waitUserIfBlocked(s.ready || DEFAULT_PROMPT_BOX);
        return;
      case 'waitFor': {
        const el = await this.firstVisible(s.any || DEFAULT_PROMPT_BOX, s.timeout || 30000);
        if (!el) {
          await this.waitUserIfBlocked(s.any || DEFAULT_PROMPT_BOX);
          const again = await this.firstVisible(s.any || DEFAULT_PROMPT_BOX, 10000);
          if (!again) throw new Error('입력창을 찾지 못했습니다');
        }
        return;
      }
      case 'clickText': {
        await this.human();
        const re = new RegExp(s.texts.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
        const btn = await this.buttonByLabel(re);
        if (!btn) throw new Error(`버튼(${s.texts.join('/')})을 찾지 못했습니다`);
        await btn.click();
        await this.human();
        return;
      }
      case 'click': {
        await this.human();
        const el = await this.firstVisible(s.any, s.timeout || 5000);
        if (!el) throw new Error('클릭할 대상을 찾지 못했습니다');
        await el.click();
        await this.human();
        return;
      }
      case 'upload': {
        const files = (Array.isArray(s.files) ? s.files : [s.file]).filter((f) => f && fs.existsSync(f));
        if (!files.length) return;
        await this.human();
        let done = false;
        const inputs = await p.$$(s.input || 'input[type="file"]');
        for (const inp of inputs.reverse()) {
          try { await inp.setInputFiles(files); done = true; break; } catch (_) { /* 다음 후보 */ }
        }
        if (!done) {
          const btn = (s.buttonAny && await this.firstVisible(s.buttonAny, 3000)) || await this.buttonByLabel(ATTACH_LABEL);
          if (!btn) throw new Error('이미지 첨부 버튼을 찾지 못했습니다');
          const [chooser] = await Promise.all([p.waitForEvent('filechooser', { timeout: 8000 }), btn.click()]);
          await chooser.setFiles(files);
        }
        this.status('running', '이미지를 첨부했습니다');
        await this.human(2500, 4500);
        return;
      }
      case 'fill': {
        const box = await this.firstVisible(s.any || DEFAULT_PROMPT_BOX, s.timeout || 20000);
        if (!box) throw new Error('입력창을 찾지 못했습니다');
        await box.click();
        await this.human(300, 700);
        const isEditable = await box.evaluate((el) => el.isContentEditable).catch(() => false);
        if (isEditable) {
          await p.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
          await p.keyboard.press('Backspace');
          await p.keyboard.insertText(s.text);
        } else {
          await box.fill(s.text);
        }
        this.status('running', '프롬프트를 입력했습니다');
        await this.human();
        return;
      }
      case 'submit': {
        await this.mediaSnapshot();
        await this.human();
        const el = (s.any && await this.firstVisible(s.any, 3000)) || await this.buttonByLabel(SEND_LABEL);
        if (el && !s.keyOnly) await el.click();
        else await p.keyboard.press(s.key || 'Enter');
        this.status('running', '생성을 요청했습니다. 결과를 기다리는 중…');
        await this.human(2000, 3500);
        return;
      }
      case 'waitResult': {
        const timeout = s.timeout || 5 * 60 * 1000;
        const stableMs = s.stableMs || 6000;
        const until = Date.now() + timeout;
        let last = null;
        let since = 0;
        while (Date.now() < until) {
          this.checkAbort();
          await p.waitForTimeout(2000);
          const blocked = await this.detectBlockers();
          if (blocked) await this.waitUserIfBlocked();
          const found = await this.findNewMedia(s.kind || 'image');
          const cand = found[0];
          if (!cand) { last = null; continue; }
          if (!last || last.src !== cand.src) { last = cand; since = Date.now(); continue; }
          if (Date.now() - since >= stableMs) { ctx.media = cand; this.status('running', '결과가 나왔습니다'); return; }
        }
        throw new Error('제한 시간 안에 결과가 나오지 않았습니다');
      }
      case 'download': {
        const ext = s.ext || '.bin';
        const base = path.join(outDir, `bot_${Date.now()}`);
        // 1) 결과 미디어 주소에서 바로 받기
        if (ctx.media && !s.buttonsOnly) {
          const saved = await this.saveFromSrc(ctx.media.src, base, ext).catch(() => null);
          if (saved) { ctx.result = saved; return; }
        }
        // 2) 다운로드 버튼 누르기
        const btn = (s.buttonAny && await this.firstVisible(s.buttonAny, 3000)) || await this.buttonByLabel(DOWNLOAD_LABEL);
        if (!btn) throw new Error('다운로드 버튼을 찾지 못했습니다');
        const dlPromise = p.waitForEvent('download', { timeout: s.timeout || 120000 });
        await btn.click();
        if (s.menuTexts) {
          await this.human(500, 1000);
          const re = new RegExp(s.menuTexts.join('|'), 'i');
          const item = await this.buttonByLabel(re).catch(() => null)
            || await this.firstVisible(s.menuTexts.map((t) => `[role="menuitem"]:has-text("${t}")`), 3000);
          if (item) await item.click().catch(() => {});
        }
        const dl = await dlPromise;
        const suggested = dl.suggestedFilename() || `result${ext}`;
        const target = `${base}${path.extname(suggested) || ext}`;
        await dl.saveAs(target);
        ctx.result = target;
        return;
      }
      case 'sleep':
        await p.waitForTimeout(s.ms || 1000);
        return;
      default:
        throw new Error(`모르는 단계: ${s.do}`);
    }
  }

  async saveFromSrc(src, base, ext) {
    let buf;
    if (/^(blob:|data:)/.test(src)) {
      const b64 = await this.page.evaluate(async (u) => {
        const r = await fetch(u);
        const ab = await r.arrayBuffer();
        let s = '';
        const bytes = new Uint8Array(ab);
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return { b64: btoa(s), type: r.headers.get('content-type') || '' };
      }, src);
      buf = Buffer.from(b64.b64, 'base64');
      ext = extFromType(b64.type) || ext;
    } else {
      const res = await this.page.context().request.get(src, { timeout: 120000 });
      if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
      buf = await res.body();
      ext = extFromType(res.headers()['content-type']) || path.extname(new URL(src).pathname) || ext;
    }
    if (!buf || buf.length < 2000) throw new Error('파일이 너무 작습니다');
    const out = `${base}${ext}`;
    fs.writeFileSync(out, buf);
    return out;
  }
}

function extFromType(t) {
  if (!t) return '';
  if (/png/.test(t)) return '.png';
  if (/jpe?g/.test(t)) return '.jpg';
  if (/webp/.test(t)) return '.webp';
  if (/mp4/.test(t)) return '.mp4';
  if (/webm/.test(t)) return '.webm';
  if (/mpeg|mp3/.test(t)) return '.mp3';
  if (/wav/.test(t)) return '.wav';
  if (/aac|m4a/.test(t)) return '.m4a';
  return '';
}

function loadRecipes(userFile, bundledFile) {
  const bundled = JSON.parse(fs.readFileSync(bundledFile, 'utf8'));
  if (userFile && fs.existsSync(userFile)) {
    try {
      const user = JSON.parse(fs.readFileSync(userFile, 'utf8'));
      if ((user.version || 0) >= (bundled.version || 0)) return { ...bundled, ...user, tasks: { ...bundled.tasks, ...(user.tasks || {}) } };
    } catch (_) { /* 손상된 사용자 파일은 무시 */ }
  }
  return bundled;
}

module.exports = { RecipeRunner, NeedsUserError, loadRecipes, fillTemplate };
