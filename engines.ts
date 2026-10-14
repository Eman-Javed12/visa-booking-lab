// One interface, two engines (Playwright and Puppeteer), so the same flow runs on both for a fair comparison.
import { chromium } from 'playwright';
import puppeteer from 'puppeteer-core';

export class DriftError extends Error {}

export interface Pg {
  goto(url: string): Promise<void>;
  reload(): Promise<void>;
  fill(id: string, v: string, delay?: number): Promise<void>;     // delay > 0 types one key at a time
  click(id: string): Promise<void>;
  check(id: string): Promise<void>;
  select(id: string, label: string): Promise<void>;
  waitFor(id: string, ms: number): Promise<void>;
  eval(expr: string): Promise<any>;                       // evaluate a JS expression in the page
  waitJs(expr: string, ms: number): Promise<any>;         // wait until expression is truthy, null on timeout
  freeSlots(): Promise<number>;
  clickFree(i: number): Promise<void>;
  heap(): Promise<number>;
  isClosed(): boolean;
  onClose(cb: () => void): void;
}
export interface Sess { newPage(): Promise<Pg>; close(): Promise<void> }
export interface Brw { name: string; session(): Promise<Sess>; cpuSeconds(): Promise<number>; close(): Promise<void>; onDisconnect(cb: () => void): void }
export type Launcher = (headless: boolean) => Promise<Brw>;

const T = 5000;
const S = (id: string) => `[data-testid="${id}"]`;
const FREE = '[data-testid^="slot-"]:not([disabled])';
const drift = (id: string) => new DriftError(`DOM drift: control "${id}" not found`);
const guard = async <R>(id: string, p: Promise<R>): Promise<R> => {
  try { return await p; } catch (e: any) { throw /Timeout|not found|failed to find|waiting for/i.test(String(e.message)) ? drift(id) : e; }
};
const J = JSON.stringify;
const sumCpu = (r: any) => r.processInfo.reduce((a: number, p: any) => a + (p.cpuTime || 0), 0);
const exe = () => process.env.CHROMIUM_PATH || chromium.executablePath();
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

export const launchers: Record<string, Launcher> = {
  async playwright(headless) {
    const b = await chromium.launch({ headless, executablePath: process.env.CHROMIUM_PATH || undefined });
    let cdp: any;
    return {
      name: 'playwright',
      async session() {
        const ctx = await b.newContext();
        return {
          close: () => ctx.close(),
          async newPage(): Promise<Pg> {
            const page = await ctx.newPage();
            const L = (id: string) => page.getByTestId(id);
            let cs: any;
            return {
              goto: u => page.goto(u).then(() => {}),
              reload: () => page.reload().then(() => {}),
              fill: (id, v, delay = 0) => guard(id, delay
                ? (async () => { await L(id).fill('', { timeout: T }); await L(id).pressSequentially(v, { delay, timeout: T }); })()
                : L(id).fill(v, { timeout: T })),
              click: id => guard(id, L(id).click({ timeout: T })),
              check: id => guard(id, L(id).check({ timeout: T })),
              select: (id, label) => guard(id, L(id).selectOption({ label }, { timeout: T }).catch(() => L(id).selectOption({ index: 1 }, { timeout: T })).then(() => {})),
              waitFor: (id, ms) => guard(id, L(id).waitFor({ timeout: ms })),
              eval: expr => page.evaluate(expr),
              waitJs: async (expr, ms) => { const h = await page.waitForFunction(expr, null, { timeout: ms, polling: 100 }).catch(() => null); return h ? h.jsonValue() : null; },
              freeSlots: () => page.locator(FREE).count(),
              clickFree: i => page.locator(FREE).nth(i).click({ timeout: T }),
              heap: async () => {
                if (!cs) { cs = await ctx.newCDPSession(page); await cs.send('Performance.enable'); }
                const r = await cs.send('Performance.getMetrics');
                return r.metrics.find((m: any) => m.name === 'JSHeapUsedSize')?.value ?? 0;
              },
              isClosed: () => page.isClosed(),
              onClose: cb => { page.on('close', cb); },
            };
          },
        };
      },
      async cpuSeconds() { cdp ??= await b.newBrowserCDPSession(); return sumCpu(await cdp.send('SystemInfo.getProcessInfo')); },
      close: () => b.close(),
      onDisconnect: cb => { b.on('disconnected', cb); },
    };
  },

  async puppeteer(headless) {
    const b = await puppeteer.launch({ headless, executablePath: exe(), defaultViewport: null, args: isRoot ? ['--no-sandbox'] : [] });
    let cdp: any;
    return {
      name: 'puppeteer',
      async session() {
        const ctx = await b.createBrowserContext();
        return {
          close: () => ctx.close(),
          async newPage(): Promise<Pg> {
            const page = await ctx.newPage();
            const q = (id: string) => page.waitForSelector(S(id), { visible: true, timeout: T }).catch(() => { throw drift(id); });
            const ev = (expr: string) => page.evaluate(expr);
            return {
              goto: u => page.goto(u, { waitUntil: 'load' }).then(() => {}),
              reload: () => page.reload().then(() => {}),
              fill: async (id, v, delay = 0) => { await q(id); if (delay) { await ev(`(()=>{const e=document.querySelector(${J(S(id))});e.value='';e.focus()})()`); await page.type(S(id), v, { delay }); return; } await ev(`(()=>{const e=document.querySelector(${J(S(id))});e.value=${J(v)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`); },
              click: async id => { const h = await q(id); await h!.click(); },
              check: async id => { await q(id); if (!(await ev(`document.querySelector(${J(S(id))}).checked`))) await page.click(S(id)); },
              select: async (id, label) => { await q(id); await ev(`(()=>{const e=document.querySelector(${J(S(id))});const o=[...e.options].find(x=>x.text===${J(label)})||e.options[1];e.value=o.value;e.dispatchEvent(new Event('change',{bubbles:true}))})()`); },
              waitFor: async (id, ms) => { await page.waitForSelector(S(id), { visible: true, timeout: ms }).catch(() => { throw drift(id); }); },
              eval: ev,
              waitJs: async (expr, ms) => { const h = await page.waitForFunction(expr, { timeout: ms, polling: 100 }).catch(() => null); return h ? h.jsonValue() : null; },
              freeSlots: async () => (await page.$$(FREE)).length,
              clickFree: async i => { const hs = await page.$$(FREE); await hs[i].click(); },
              heap: async () => (await page.metrics()).JSHeapUsedSize ?? 0,
              isClosed: () => page.isClosed(),
              onClose: cb => { page.on('close', cb); },
            };
          },
        };
      },
      async cpuSeconds() { cdp ??= await b.target().createCDPSession(); return sumCpu(await cdp.send('SystemInfo.getProcessInfo')); },
      close: () => b.close(),
      onDisconnect: cb => { b.on('disconnected', cb); },
    };
  },
};