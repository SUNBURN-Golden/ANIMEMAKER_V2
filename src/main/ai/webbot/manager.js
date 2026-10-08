'use strict';
// 자동 클릭 브라우저를 한 번에 하나의 작업만 하도록 관리한다.
const path = require('path');
const { BotBrowser } = require('./browser');
const { RecipeRunner, NeedsUserError, loadRecipes } = require('./engine');

const BUNDLED = path.join(__dirname, 'recipes.json');

class BotManager {
  /** @param {import('../../store').Store} store */
  constructor(store) {
    this.store = store;
    this.bb = new BotBrowser();
    this.queue = Promise.resolve();
    this.lastRunAt = 0;
  }

  recipes() {
    return loadRecipes(this.store.recipesFile, BUNDLED);
  }

  browserOptions() {
    const s = this.store.getSettings().bot;
    return {
      prefer: s.browser === 'chrome' ? 'chrome' : 'edge',
      browserPath: s.browser === 'custom' ? s.browserPath : '',
      profileDir: this.store.botProfileDir,
    };
  }

  /** 로그인용으로 사이트를 연다 */
  async openSite(url) {
    await this.bb.ensure({ ...this.browserOptions(), startUrl: url });
    const page = await this.bb.page();
    if (page.url() !== url) await page.goto(url).catch(() => {});
    return true;
  }

  /** 자동 클릭 브라우저에서 일어나는 다운로드를 받아 본다 (도우미 대기 중 사용) */
  watchDownloads(cb) {
    if (!this.bb.isAlive()) return () => {};
    const ctx = this.bb.context;
    const handlers = new Map();
    const attach = (page) => {
      const h = (dl) => cb(dl);
      page.on('download', h);
      handlers.set(page, h);
    };
    ctx.pages().forEach(attach);
    ctx.on('page', attach);
    return () => {
      ctx.off('page', attach);
      for (const [page, h] of handlers) page.off('download', h);
    };
  }

  /**
   * 레시피 실행 (순서대로 하나씩)
   * @returns {Promise<string>} 받은 파일 경로
   */
  run(taskId, params, { outDir, signal, onStatus }) {
    const job = this.queue.then(async () => {
      const recipe = this.recipes().tasks[taskId];
      if (!recipe) throw new NeedsUserError(`자동 클릭 레시피(${taskId})가 없습니다.`, 'no-recipe');
      const s = this.store.getSettings().bot;
      const gap = Math.max(0, (s.gapSeconds || 0) * 1000 - (Date.now() - this.lastRunAt));
      if (gap > 0) {
        onStatus && onStatus({ state: 'running', message: `사람 속도로 진행하기 위해 ${Math.round(gap / 1000)}초 쉬는 중…` });
        await new Promise((r) => setTimeout(r, gap));
      }
      await this.bb.ensure(this.browserOptions());
      const page = await this.bb.page();
      const runner = new RecipeRunner(page, { pace: s.pace || 1, signal, onStatus });
      try {
        return await runner.run(recipe, params, outDir);
      } finally {
        this.lastRunAt = Date.now();
      }
    });
    this.queue = job.catch(() => {});
    return job;
  }

  isOpen() { return this.bb.isAlive(); }

  async close() { await this.bb.close(); }
}

module.exports = { BotManager, NeedsUserError };
