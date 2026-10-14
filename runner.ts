// Profile manager, scheduler and workers. Locked to localhost: refuses any other target.
import { launchers, DriftError, type Brw, type Sess, type Pg } from './engines.js';
import { PEOPLE, PROBE, type Person } from './data.js';
import type { Client } from './excel.js';
import { appointmentInfo, audit, dayStr, jobEnd, jobStart, saveRun } from './db.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
class StopError extends Error {}
class Reauth extends Error {}                       // expired session/code: start a new authentication attempt
class Denied extends Error {}                       // ban or unsolved challenge: stop, never route around it
const MAX_PROFILES = 50, MAX_REQUESTS = 80, CHALLENGE_WAIT_MS = Number(process.env.CHALLENGE_WAIT_MS || 90_000);
const COST = { cpuHour: 0.04, otpMessage: 0.0075, humanHandoff: 0.5 };   // illustrative assumptions

// In-page checks (strings, so they work unchanged in both engines).
const MSG = `(document.getElementById('message').textContent||'')`;
const OUTCOME = `(()=>{const c=document.getElementById('claimed');if(c&&c.textContent)return 'ok';const m=${MSG};
 if(/unknown/i.test(m))return 'unknown';if(/taken/i.test(m))return 'retry';if(/limited|lost/i.test(m))return 'backoff';
 if(/expired/i.test(m))return 'expired';if(/denied/i.test(m))return 'denied';if(/security check/i.test(m))return 'challenge';return null})()`;
const LOGIN = `(()=>{if(!document.getElementById('v-otp').hidden)return 'otp';if(!document.getElementById('v-dash').hidden)return 'dash';const m=${MSG};
 if(/limited|many/i.test(m))return 'limited';if(m)return 'error:'+m;return null})()`;
const AUTH = `(()=>{if(!document.getElementById('v-dash').hidden)return 'ok';const m=${MSG};
 if(/expired/i.test(m))return 'expired';if(/wrong/i.test(m))return 'wrong';if(/denied/i.test(m))return 'denied';if(/limited/i.test(m))return 'limited';return null})()`;

export interface Profile {
  id: number; person: Person; account: string; center: string[]; proxy: string; status: string; progress: number;
  error: string | null; slot: string | null; elapsed: number | null; startedAt: number; queuedAt: number;
  queueMs: number; otpMs: number; restrictions: number; handoffs: number; client: Client;
  _sess?: Sess | null; _page?: Pg | null; _task?: Promise<void> | null; _stop?: boolean; _lease?: boolean;
}
export interface RunnerDeps { getPassword(email: string): string; resetSite(): void; otp: { get(): boolean; set(on: boolean): void } }

export function createRunner(base: string, log: (m: string) => void, deps: RunnerDeps) {
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw new Error('Lab runner only targets the local site');
  const settings = { headless: false, engine: 'playwright', maxConcurrent: 10, admitPerMin: 300, pace: 700 };   // pace = pause between steps (ms), 0 = full speed
  const profiles: Profile[] = [], queue: Profile[] = [], leases = new Set<string>();
  let brw: Brw | null = null, launching: Promise<Brw> | null = null, launchedEngine = '';
  let active = 0, nextId = 1, halted = false, lastAdmit = 0, timer: NodeJS.Timeout | null = null;

  async function ensureBrowser(): Promise<Brw> {
    if (brw && launchedEngine !== settings.engine) { await closeBrowser(); }
    if (brw) return brw;
    launching ??= launchers[settings.engine](settings.headless).then(b => {
      brw = b; launchedEngine = settings.engine;
      b.onDisconnect(() => { brw = null; profiles.forEach(p => { p._sess = p._page = null; }); });
      log(`Browser launched (${settings.engine}${settings.headless ? ', headless' : ''})`);
      return b;
    }).finally(() => { launching = null; });
    return launching;
  }
  async function closeBrowser() { const b = brw; brw = null; await b?.close().catch(() => {}); }

  async function open(p: Profile): Promise<Pg> {
    if (!p._task) p.status = 'Starting browser...';
    const b = await ensureBrowser();
    p._sess ??= await b.session();                         // isolated browser context per profile
    if (!p._page || p._page.isClosed()) {
      p._page = await p._sess.newPage();
      p._page.onClose(() => { p._page = null; });
      await p._page.goto(`${base}/site.html`);
      if (!p._task) p.status = 'Ready';
    }
    return p._page;
  }

  // ---------- the booking workflow (written once, runs on either engine) ----------
  async function flow(p: Profile, page: Pg) {
    const c = p.client, step = (s: string, n: number) => {
      if (p._stop) throw new StopError();
      p.status = s; p.progress = n;
      page.eval(`window.setBot&&setBot(${JSON.stringify(s)})`).catch(() => {});      // on-page bot badge
    };
    const dates = c.dates.length ? c.dates : [dayStr(2), dayStr(3), dayStr(4)];
    let requests = 0;
    const td = settings.pace ? 35 : 0;                                              // typing speed (ms per key)
    const pause = (k = 1) => settings.pace ? sleep(settings.pace * k * (0.6 + Math.random() * 0.8)) : Promise.resolve();
    const dmy = (iso: string) => iso.split('-').reverse().join('/');
    const parts = (c.fullName || p.person.name).trim().split(/\s+/);
    const surname = parts.length > 1 ? parts[parts.length - 1] : parts[0];
    const given = parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0];
    const retryAfter = async () => { const v = Number(await page.eval(`document.getElementById('message').dataset.retryAfter||2`)); await sleep(Math.min(v, 10) * 1000); };

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // 1. login
        step(attempt > 1 ? 'Signing in again' : 'Logging in', 10);
        await page.goto(`${base}/site.html`);
        await pause();
        const loginAt = Date.now() - 20;
        await page.fill('email', p.account, td); await pause(0.5);
        await page.fill('password', deps.getPassword(p.account), td); await pause(0.5);
        await page.click('login-btn');
        const lr = await page.waitJs(LOGIN, 6000);
        if (lr === 'limited') { p.restrictions++; throw new Denied('Too many sign-in or OTP requests: stopped'); }
        if (lr !== 'otp' && lr !== 'dash') throw new Error(String(lr || 'Login timed out').replace('error:', ''));

        if (lr === 'otp') {
          // 2. OTP (only when verification is switched on): newest message for this attempt wins
          step('Waiting for OTP', 25);
          let code: string | null = null; const t0 = Date.now();
          for (let i = 0; i < 80 && !code; i++) {
            step('Waiting for OTP', 25);
            const j: any = await (await fetch(`${base}/api/otp-broker/${encodeURIComponent(p.account)}`)).json();
            const fresh = (j.messages || []).filter((m: any) => m.sentAt >= loginAt).sort((a: any, b: any) => b.sentAt - a.sentAt);
            if (fresh.length) code = fresh[0].code; else await sleep(250);
          }
          p.otpMs += Date.now() - t0;
          if (!code) throw new Error('OTP not received');
          step('Verifying OTP', 35);
          await page.fill('otp-input', code, td); await pause(0.5);
          await page.click('otp-btn');
          const ar = await page.waitJs(AUTH, 6000);
          if (ar === 'expired') throw new Reauth('code expired');
          if (ar === 'denied') throw new Denied('Access denied');
          if (ar !== 'ok') throw new Error(`OTP rejected (${ar})`);
        }

        // 3. open Book Appointment from the menu, then fill the client information on the same page
        await pause();
        step('Opening Book Appointment', 45);
        await page.click('nav-book'); await pause();
        step('Filling client form', 50);
        await page.waitFor('appt-for', 8000);
        await page.select('appt-for', c.appointment_for); await pause(0.5);
        await page.fill('phone', (c.phone || '3001234567').replace(/^0/, ''), td); await pause(0.5);
        await page.fill('surname', surname, td); await pause(0.4);
        await page.fill('given-name', given, td); await pause(0.4);
        await page.fill('dob', dmy(c.dob), td); await pause(0.4);
        await page.fill('passport', c.passport, td); await pause(0.4);
        await page.fill('passport-exp', dmy(c.passportExp), td); await pause(0.4);
        await page.select('gender', c.gender || 'MALE'); await pause(0.4);
        await page.select('nationality', c.nationality || 'PAKISTAN'); await pause();

        // 4. search and book
        for (let round = 1; round <= 8; round++) {
          for (const date of dates) {
            if (++requests > MAX_REQUESTS) throw new Error('Request budget exhausted');
            step('Running for slots...', 65);
            await page.fill('date-input', dmy(date), td); await pause(0.5);
            await page.click('search-btn');
            await page.waitJs(`document.getElementById('slots').dataset.date===${JSON.stringify(date)}`, 10_000);
            const m: string = await page.eval(MSG);
            if (/expired/i.test(m)) throw new Reauth('session expired');
            if (/denied/i.test(m)) throw new Denied('Access denied: stopped');
            if (/security check/i.test(m)) { await human(p, page, step); continue; }
            if (/limited/i.test(m)) { p.restrictions++; await retryAfter(); continue; }
            if (/lost/i.test(m)) { await sleep(1000); continue; }
            const n = await page.freeSlots();
            if (!n) continue;

            step('Booking slot', 85);
            await pause();
            await page.clickFree(Math.floor(Math.random() * n)); await pause(0.6);
            await page.check('terms'); await pause(0.6);
            await page.click('book-btn'); await pause(0.8);
            await page.click('agree-yes');
            const out = await page.waitJs(OUTCOME, 6000);
            if (out === 'ok') return done(p, step, await page.eval(`document.getElementById('claimed').dataset.slot`));
            if (out === 'unknown' || out === null) {                      // lost response: ask the server before doing anything else
              const token = await page.eval(`sessionStorage.getItem('t')`);
              const r = await fetch(`${base}/api/my-booking`, { headers: { authorization: `Bearer ${token}` } });
              if (r.ok) { const b: any = await r.json(); log(`Profile ${p.id}: lost response, booking found on server`); return done(p, step, `${b.date} ${b.time}`); }
              await sleep(500); continue;
            }
            if (out === 'expired') throw new Reauth('session expired');
            if (out === 'denied') throw new Denied('Access denied: stopped');
            if (out === 'challenge') { await human(p, page, step); continue; }
            if (out === 'backoff') { p.restrictions++; await retryAfter(); continue; }
            await sleep(500);                                              // slot taken: search again
          }
          step('Running for slots...', 65);
          await sleep(1500);
        }
        throw new Error('No slots on preferred dates');
      } catch (e) {
        if (e instanceof Reauth && attempt < 3) { log(`Profile ${p.id}: ${e.message}, starting a new sign-in`); continue; }
        throw e;
      }
    }
  }
  const done = (p: Profile, step: (s: string, n: number) => void, slot: string) => { p.slot = slot; step('Claimed - awaiting payment', 100); };

  async function human(p: Profile, page: Pg, step: (s: string, n: number) => void) {
    p.handoffs++; p.restrictions++;
    const until = Date.now() + CHALLENGE_WAIT_MS;
    while (Date.now() < until) {
      step('Waiting for human (security check)', 70);
      if (await page.eval(`document.getElementById('challenge').hidden`)) return;
      await sleep(500);
    }
    throw new Denied('Security check not completed: workflow ended');
  }

  // ---------- scheduler: bounded queue, concurrency cap, admission rate, exclusive account lease ----------
  function run(p: Profile) {
    active++; p.startedAt = Date.now(); p.queueMs = p.startedAt - p.queuedAt; p.elapsed = null; p._lease = true;
    leases.add(p.account);
    const job = jobStart(p.account, settings.engine);
    p._task = (async () => {
      try { await flow(p, await open(p)); }
      catch (e: any) {
        if (e instanceof StopError) p.status = 'Stopped';
        else if (e instanceof Denied) { p.status = 'Denied'; p.error = e.message; }
        else {
          p.status = 'Failed'; p.error = String(e.message).split('\n')[0];
          if (/Executable doesn't exist|Could not find|ENOENT/.test(String(e.message))) p.error = 'Browser missing. Run: npm run setup';
          if (e instanceof DriftError) p.error = e.message;
        }
      } finally {
        p.elapsed = Date.now() - p.startedAt; active--; p._task = null; leases.delete(p.account); p._lease = false;
        jobEnd(job, p.status, p.slot, p.error, p.elapsed);
        log(`Profile ${p.id} (${p.person.name}): ${p.status}${p.slot ? ' (' + p.slot + ')' : ''}${p.error ? ' - ' + p.error : ''}`);
        pump();
      }
    })();
  }
  function pump() {
    if (halted) return;
    while (active < settings.maxConcurrent && queue.length) {
      const wait = lastAdmit + 60000 / settings.admitPerMin - Date.now();
      if (wait > 0) { timer ??= setTimeout(() => { timer = null; pump(); }, wait); return; }
      lastAdmit = Date.now(); run(queue.shift()!);
    }
  }
  function start(p: Profile) {
    if (halted) { log('Emergency stop is active: click Resume first'); return; }
    if (p._task || queue.includes(p) || leases.has(p.account)) return;
    p._stop = false; p.error = null; p.slot = null; p.progress = 0; p.otpMs = 0; p.restrictions = 0; p.handoffs = 0;
    p.status = 'Queued'; p.queuedAt = Date.now(); queue.push(p); pump();
  }
  function stop(p: Profile) {
    p._stop = true;
    const i = queue.indexOf(p);
    if (i >= 0) { queue.splice(i, 1); p.status = 'Stopped'; }
  }
  async function close(p: Profile) {
    stop(p);
    await p._sess?.close().catch(() => {});
    p._sess = p._page = null; p.status = 'Closed'; p.progress = 0;
    if (brw && !profiles.some(x => x._sess)) await closeBrowser();
  }

  function addClients(rows: Client[]) {
    let n = 0;
    for (const client of rows) {
      if (profiles.length >= MAX_PROFILES) break;
      const used = new Set(profiles.map(p => p.account));
      const person = client.fullName ? PEOPLE.find(x => x.name.toLowerCase() === client.fullName.toLowerCase())
                                     : PEOPLE.find(x => !used.has(x.email));
      if (!person || used.has(person.email)) { log(`Skipped row "${client.fullName || client.passport}": no free account`); continue; }
      profiles.push({ id: nextId++, person, account: person.email, center: ['KHI', 'Submission Schengen'], proxy: 'DIRECT',
        status: 'Idle', progress: 0, error: null, slot: null, elapsed: null, startedAt: 0, queuedAt: 0, queueMs: 0,
        otpMs: 0, restrictions: 0, handoffs: 0, client });
      n++;
    }
    return n;
  }
  async function clear() { for (const p of [...profiles]) await close(p); profiles.length = 0; queue.length = 0; nextId = 1; await closeBrowser(); }

  /** Canary: confirms the login page still exposes the controls the workers depend on. */
  async function canary() {
    const b = await ensureBrowser(), s = await b.session(), page = await s.newPage();
    const missing: string[] = [];
    try {
      await page.goto(`${base}/site.html`);
      for (const id of ['email', 'password', 'login-btn']) await page.waitFor(id, 1500).catch(() => missing.push(id));
    } finally { await s.close(); if (!profiles.some(x => x._sess)) await closeBrowser(); }
    log(missing.length ? `Canary FAILED: missing ${missing.join(', ')}` : 'Canary passed: login controls present');
    return { ok: !missing.length, missing };
  }

  /** Self-check: stale, wrong, replayed and expired OTPs must never be accepted. Returns number of wrongly accepted codes. */
  async function otpProbe() {
    const email = PROBE.email, password = deps.getPassword(email);
    const post = (path: string, body: object, token?: string) => fetch(base + path, { method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const newest = async (since: number) => {
      for (let i = 0; i < 60; i++) {
        const j: any = await (await fetch(`${base}/api/otp-broker/${encodeURIComponent(email)}`)).json();
        const m = (j.messages || []).filter((x: any) => x.sentAt >= since).sort((a: any, b: any) => b.sentAt - a.sentAt)[0];
        if (m) return m.code as string; await sleep(250);
      }
      return '';
    };
    let bad = 0;
    const t1 = Date.now() - 20, a = await (await post('/api/login', { email, password })).json() as any;
    const stale = await newest(t1);
    const t2 = Date.now() - 20, b = await (await post('/api/login', { email, password })).json() as any;
    const fresh = await newest(t2);
    if (stale !== fresh && (await post('/api/verify-otp', { code: stale }, a.token)).status === 200) bad++;   // stale code
    if ((await post('/api/verify-otp', { code: '000000' }, b.token)).status === 200) bad++;                   // wrong code
    if ((await post('/api/verify-otp', { code: fresh }, b.token)).status !== 200) bad++;                      // valid code must pass
    if ((await post('/api/verify-otp', { code: fresh }, b.token)).status === 200) bad++;                      // replay
    return bad;
  }

  // ---------- benchmark: engine x users, with measurements ----------
  const bench = { running: false, label: '' };
  async function runBatch(engine: string, users: number) {
    await clear(); deps.resetSite();
    Object.assign(settings, { engine, headless: true, maxConcurrent: users, pace: 0 });
    const rows: Client[] = PEOPLE.slice(0, users).map(p => ({ fullName: p.name, appointment_for: 'Submission Schengen Visa (Short term - Type C)',
      dob: p.dob, passport: p.passport, passportExp: p.passportExp, gender: p.gender, nationality: p.nationality, phone: p.phone,
      dates: [dayStr(2), dayStr(3), dayStr(4), dayStr(5)] }));
    addClients(rows);
    const b = await ensureBrowser(), cpu0 = await b.cpuSeconds(), t0 = Date.now();
    let peakHeap = 0, peakRss = 0;
    const sampler = setInterval(async () => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      let sum = 0; for (const p of profiles) if (p._page) sum += await p._page.heap().catch(() => 0);
      peakHeap = Math.max(peakHeap, sum);
    }, 400);
    profiles.forEach(start);
    while ((queue.length || profiles.some(p => p._task)) && Date.now() - t0 < 240_000) await sleep(200);
    clearInterval(sampler);
    const totalMs = Date.now() - t0, cpuSec = (await b.cpuSeconds()) - cpu0;
    const ok = profiles.filter(p => /^Claimed/.test(p.status)), times = ok.map(p => p.elapsed!).sort((x, y) => x - y);
    const a = audit(profiles.map(p => ({ account: p.account, slot: p.slot, status: p.status })));
    const invalidOtp = await otpProbe();
    const otpMsgs = profiles.length, handoffs = profiles.reduce((s, p) => s + p.handoffs, 0);
    const cost = ok.length ? (cpuSec / 3600 * COST.cpuHour + otpMsgs * COST.otpMessage + handoffs * COST.humanHandoff) / ok.length : null;
    const r = {
      at: new Date().toISOString(), engine, users, completed: ok.length, failed: users - ok.length,
      completionRate: +(ok.length / users * 100).toFixed(1),
      p95ms: times.length ? times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)] : null,
      avgMs: times.length ? Math.round(times.reduce((s, x) => s + x, 0) / times.length) : null, totalMs,
      cpuSec: +cpuSec.toFixed(2), peakHeapMB: +(peakHeap / 1048576).toFixed(1), peakNodeRssMB: +(peakRss / 1048576).toFixed(0),
      maxQueueMs: Math.max(0, ...profiles.map(p => p.queueMs)),
      avgOtpMs: Math.round(profiles.reduce((s, p) => s + p.otpMs, 0) / users), restrictions: profiles.reduce((s, p) => s + p.restrictions, 0),
      costPerCompletionUSD: cost === null ? null : +cost.toFixed(5),
      doubleAllocated: a.doubleAllocated, multiBooked: a.multiBooked, slotMismatch: a.slotMismatch, phantom: a.phantom,
      unreconciled: a.unreconciled, invalidOtpAccepted: invalidOtp,
      pass: !a.doubleAllocated && !a.multiBooked && !a.slotMismatch && !a.phantom && !a.unreconciled && !invalidOtp,
    };
    saveRun(r); log(`Benchmark ${engine} x${users}: ${r.completed}/${users} completed, p95 ${r.p95ms} ms, ${r.pass ? 'PASS' : 'FAIL'}`);
    await clear();
    return r;
  }
  async function benchmark(engines: string[], sizes: number[]) {
    if (bench.running) return;
    bench.running = true;
    const otpBefore = deps.otp.get(), paceBefore = settings.pace;
    deps.otp.set(true);                                  // the study tests the OTP workflow, so verification is on while benchmarking
    try {
      for (const e of engines) for (const n of sizes) { bench.label = `${e} x ${n}`; await runBatch(e, n); }
    } catch (e: any) { log(`Benchmark error: ${String(e.message).split('\n')[0]}`); }
    finally { deps.otp.set(otpBefore); settings.pace = paceBefore; bench.running = false; bench.label = ''; }
  }

  return {
    settings, addClients, clear, canary, benchmark, bench,
    emergency() { halted = true; queue.splice(0).forEach(p => { p.status = 'Stopped'; }); profiles.forEach(p => { p._stop = true; });
      closeBrowser(); profiles.forEach(p => { p._sess = p._page = null; if (!p._task) p.status = 'Closed'; }); log('EMERGENCY STOP: all work halted, browsers closed'); },
    resume() { halted = false; log('Resumed'); },
    async act(action: string, ids?: number[]) {
      const list = action === 'stopAll' ? profiles : profiles.filter(p => (ids || []).includes(p.id));
      for (const p of list) {
        try {
          if (action === 'open') await open(p);
          else if (action === 'start') start(p);
          else if (action === 'stop' || action === 'stopAll') stop(p);
          else if (action === 'close') await close(p);
          else if (action === 'reload') { if (p._page && !p._task) { await p._page.reload(); p.status = 'Ready'; } }
        } catch (e: any) {
          p.status = 'Failed';
          p.error = /Executable doesn't exist|Could not find|ENOENT/.test(String(e.message)) ? 'Browser missing. Run: npm run setup' : String(e.message).split('\n')[0];
        }
      }
    },
    snapshot() {
      return {
        halted, queued: queue.length, settings,
               profiles: profiles.map(p => {
          const paid = /^Claimed/.test(p.status) && !!appointmentInfo(p.account)?.paid;      // payment finished in the payment tab
          return { id: p.id, name: p.person.name, portal: 'PK', account: p.account, center: p.center, proxy: p.proxy,
            status: paid ? 'Paid - appointment confirmed' : p.status, progress: p.progress, error: p.error, slot: p.slot,
            elapsed: p._task ? Date.now() - p.startedAt : p.elapsed };
        }),
        activeBrowsers: profiles.filter(p => p._page).length, running: profiles.filter(p => p._task).length,
      };
    },
    rawProfiles: () => profiles,
  };
}