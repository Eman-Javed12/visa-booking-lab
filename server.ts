// Appointment portal + control panel API. LAB USE ONLY: fictional applicants, simulated OTP channel, fake slots.
import express, { type Request, type Response, type NextFunction } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRunner } from './runner.js';
import { parseClients, sampleBuffer } from './excel.js';
import { PEOPLE, PROBE, ALL_ACCOUNTS } from './data.js';
import { loadVault, hashPw, redact } from './secrets.js';
import { ensureSlots, listSlots, myBooking, tryBook, audit, listRuns, markPaid, createApplication, listApplications, submitApplication,
  deleteDraft, trackApplication, appointmentInfo, createInsurance, listInsurance, insuranceById, payInsurance, portalCounts } from './db.js';

// CHANGE 1: use the port Render provides (falls back to 3000 locally). BASE stays localhost because the bot's browser runs in the same container.
const PORT = Number(process.env.PORT) || 3000, BASE = `http://localhost:${PORT}`;
const RATE_LIMIT_PER_SEC = 10, MAX_OTP_ATTEMPTS = 3, MAX_OTP_SENDS = 5, BAN_STRIKES = 5;

// ---------- accounts (random passwords live in the encrypted vault; the server only keeps hashes) ----------
const vault = loadVault(ALL_ACCOUNTS);
const accounts = new Map(ALL_ACCOUNTS.map(e => [e, hashPw(vault[e], e)]));

// ---------- fault injection (all off by default) ----------
const faults = { requireOtp: false, otpDelaySec: 0, otpDuplicate: false, otpTtlSec: 60, domDrift: 'off', routeLossPct: 0,
  crashAfterCommitPct: 0, challengePct: 0, invalidatePct: 0 };
const chance = (pct: number) => Math.random() * 100 < pct;

// ---------- volatile state (sessions, OTPs, rate limits) ----------
interface Session { email: string; otpOk: boolean; hits: number[]; strikes: number[]; bannedUntil: number; challengeOkUntil: number; word: string }
interface Otp { messages: { code: string; sentAt: number; visibleAt: number }[]; current: string; expires: number; used: boolean; attempts: number; sends: number }
let sessions = new Map<string, Session>(), otps = new Map<string, Otp>();
const stats = { otpRejected: 0, rateLimited: 0, bans: 0, challenges: 0 };
function resetState() { ensureSlots(true); sessions = new Map(); otps = new Map(); }
ensureSlots();

const app = express();

// CHANGE 3: password-protect the control panel (set PANEL_USER and PANEL_PASS in Render).
// Only the panel page and /api/panel are guarded, so the bot's own requests to the portal are unaffected.
const PANEL_USER = process.env.PANEL_USER, PANEL_PASS = process.env.PANEL_PASS;
if (PANEL_USER && PANEL_PASS) {
  app.use(['/app.html', '/api/panel'], (req: Request, res: Response, next: NextFunction) => {
    const [u, p] = Buffer.from((req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString().split(':');
    if (u === PANEL_USER && p === PANEL_PASS) return next();
    res.set('WWW-Authenticate', 'Basic realm="lab"').status(401).send('Authentication required');
  });
}

app.use(express.json());
app.use(express.raw({ type: 'application/octet-stream', limit: '5mb' }));
app.get('/', (_req, res) => res.redirect('/app.html'));
app.get('/site.html', (_req, res) => {                 // drift mode is injected so the page is consistent from first paint
  res.type('html').send(fs.readFileSync('public/site.html', 'utf8').replace('__DRIFT__', faults.domDrift).replace('__OTP__', faults.requireOtp ? 'on' : 'off'));
});
app.use(express.static('public'));

const drop = (req: Request) => req.socket.destroy();   // simulates route loss

// ---------- auth + simulated defenses ----------
function auth(req: Request, res: Response, next: NextFunction) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const s = sessions.get(token);
  if (!s) return void res.status(401).json({ error: 'session expired' });
  const now = Date.now();
  if (s.bannedUntil > now) return void res.status(403).json({ denied: true, error: 'access denied' });
  s.hits = s.hits.filter(t => now - t < 1000); s.hits.push(now);
  if (s.hits.length > RATE_LIMIT_PER_SEC) {
    stats.rateLimited++;
    s.strikes = s.strikes.filter(t => now - t < 10_000); s.strikes.push(now);
    if (s.strikes.length >= BAN_STRIKES) { s.bannedUntil = now + 60_000; stats.bans++; }
    res.set('Retry-After', '2');
    return void res.status(429).json({ error: 'rate limited' });
  }
  (req as any).s = s; next();
}
const sess = (req: Request) => (req as any).s as Session;

// ---------- site API ----------
app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const blank = () => ({ hits: [] as number[], strikes: [] as number[], bannedUntil: 0, challengeOkUntil: 0, word: '' });
  if (!faults.requireOtp) {                            // open sign-in: any username and password, no verification step
    const id = String(email ?? '').trim().toLowerCase().slice(0, 60);
    if (!id || !String(password ?? '')) return void res.status(401).json({ error: 'Please enter your username and password' });
    const token = crypto.randomUUID();
    sessions.set(token, { email: id, otpOk: true, ...blank() });
    return void res.json({ token, otpRequired: false });
  }
  const stored = accounts.get(email);                  // strict mode (OTP tests): real accounts + one-time code
  if (!stored || hashPw(String(password ?? ''), email) !== stored) return void res.status(401).json({ error: 'invalid credentials' });
  const o = otps.get(email);
  if ((o?.sends ?? 0) >= MAX_OTP_SENDS) { stats.rateLimited++; return void res.status(429).json({ error: 'too many OTP requests' }); }
  const now = Date.now(), code = String(crypto.randomInt(100000, 1000000)), visibleAt = now + faults.otpDelaySec * 1000;
  const messages = (o?.messages ?? []).slice(-2);                              // older messages stay around, now stale
  messages.push({ code, sentAt: now, visibleAt });
  if (faults.otpDuplicate) messages.push({ code, sentAt: now + 1, visibleAt });  // duplicate delivery of the same code
  otps.set(email, { messages, current: code, expires: now + faults.otpTtlSec * 1000, used: false, attempts: 0, sends: (o?.sends ?? 0) + 1 });
  const token = crypto.randomUUID();
  sessions.set(token, { email, otpOk: false, ...blank() });
  res.json({ token, otpRequired: true });
});

// Simulated SMS/e-mail channel: what a real broker would receive from the provider.
app.get('/api/otp-broker/:email', (req, res) => {
  const o = otps.get(req.params.email), now = Date.now();
  res.json({ messages: (o?.messages ?? []).filter(m => m.visibleAt <= now).map(m => ({ to: req.params.email, code: m.code, sentAt: m.sentAt })) });
});

app.post('/api/verify-otp', auth, (req, res) => {
  const s = sess(req), o = otps.get(s.email);
  if (!o || o.used || Date.now() > o.expires) { stats.otpRejected++; return void res.status(400).json({ error: 'code expired' }); }
  if (++o.attempts > MAX_OTP_ATTEMPTS) { stats.otpRejected++; return void res.status(429).json({ error: 'too many attempts' }); }
  if (String(req.body.code) !== o.current) { stats.otpRejected++; return void res.status(400).json({ error: 'wrong code' }); }
  o.used = true; s.otpOk = true;                                               // consumed once
  res.json({ ok: true });
});

app.get('/api/slots', auth, (req, res) => {
  const s = sess(req);
  if (!s.otpOk) return void res.status(403).json({ error: 'verify OTP first' });
  if (faults.routeLossPct && chance(faults.routeLossPct)) return void drop(req);
  if (faults.invalidatePct && chance(faults.invalidatePct)) { for (const [t, v] of sessions) if (v === s) sessions.delete(t); return void res.status(401).json({ error: 'session expired' }); }
  if (faults.challengePct && s.challengeOkUntil < Date.now() && chance(faults.challengePct)) {
    stats.challenges++; s.word = ['VISA', 'PASSPORT', 'CONSULATE', 'APPOINTMENT'][crypto.randomInt(4)];
    return void res.status(403).json({ challenge: true, word: s.word });
  }
  res.json({ slots: listSlots(String(req.query.date)).map(r => ({ id: r.id, time: r.time, booked: !!r.booked })) });
});

app.post('/api/challenge/solve', auth, (req, res) => {
  const s = sess(req);
  if (s.word && String(req.body.answer).trim().toUpperCase() === s.word) { s.challengeOkUntil = Date.now() + 5 * 60_000; return void res.json({ ok: true }); }
  res.status(400).json({ error: 'wrong answer' });
});

app.get('/api/my-booking', auth, (req, res) => {
  const b = myBooking(sess(req).email);
  b ? res.json(b) : res.status(404).json({ error: 'no booking' });
});

const APPT_FEE = 25.5, PLANS: Record<string, number> = { Basic: 12, Standard: 21, Premium: 34 };

app.post('/api/pay', auth, (req, res) => {              // a person finishes the payment here; card details never reach the server
  const email = sess(req).email, b = req.body || {};
  const ok = b.kind === 'insurance' ? payInsurance(email, Number(b.id)) : markPaid(email);
  ok ? res.json({ ok: true }) : res.status(404).json({ error: 'nothing to pay' });
});
app.get('/api/portal/payinfo', auth, (req, res) => {
  const email = sess(req).email;
  if (req.query.kind === 'insurance') {
    const p = insuranceById(email, Number(req.query.id));
    return void (p ? res.json({ amount: p.price, currency: 'GBP', title: `Travel medical insurance (${p.plan})`, detail: p.traveller, paid: !!p.paid })
                   : res.status(404).json({ error: 'not found' }));
  }
  const a = appointmentInfo(email);
  a ? res.json({ amount: APPT_FEE, currency: 'GBP', title: 'Appointment service fee', detail: `${a.date} at ${a.time}`, paid: !!a.paid })
    : res.status(404).json({ error: 'no booking' });
});

// ---------- portal tabs: dashboard, applications, tracking, appointments, insurance ----------
app.get('/api/portal/dashboard', auth, (req, res) => {
  const email = sess(req).email;
  res.json({ ...portalCounts(email), appointment: appointmentInfo(email) ?? null });
});
app.get('/api/portal/applications', auth, (req, res) => {
  const email = sess(req).email;
  res.json({ drafts: listApplications(email, 'draft'), submitted: listApplications(email, 'submitted') });
});
app.post('/api/portal/applications', auth, (req, res) => {
  const b = req.body || {};
  if (!b.applicant || !b.passport || !b.type || !b.travelDate) return void res.status(400).json({ error: 'Please fill all fields' });
  const id = createApplication(sess(req).email, { applicant: String(b.applicant), passport: String(b.passport), type: String(b.type), travelDate: String(b.travelDate) }, !!b.submit);
  res.status(201).json({ id });
});
app.post('/api/portal/applications/:id/submit', auth, (req, res) => {
  submitApplication(sess(req).email, Number(req.params.id)) ? res.json({ ok: true }) : res.status(404).json({ error: 'not found' });
});
app.delete('/api/portal/applications/:id', auth, (req, res) => {
  deleteDraft(sess(req).email, Number(req.params.id)) ? res.json({ ok: true }) : res.status(404).json({ error: 'not found' });
});
app.get('/api/portal/track', auth, (req, res) => {
  const a = trackApplication(sess(req).email, String(req.query.ref || '').trim().toUpperCase(), String(req.query.passport || '').trim());
  if (!a) return void res.status(404).json({ error: 'No application found for these details' });
  const stage = Math.min(3, Math.floor((Date.now() - a.submitted) / 120_000));       // moves forward every two minutes
  res.json({ ...a, stage });
});
app.get('/api/portal/appointments', auth, (req, res) => {
  const a = appointmentInfo(sess(req).email);
  res.json({ appointments: a ? [{ date: a.date, time: a.time, center: 'Karachi Visa Application Center', fee: APPT_FEE, paid: !!a.paid }] : [] });
});
app.get('/api/portal/insurance', auth, (req, res) => res.json({ plans: PLANS, policies: listInsurance(sess(req).email) }));
app.post('/api/portal/insurance', auth, (req, res) => {
  const b = req.body || {}, price = PLANS[String(b.plan)];
  if (!price || !b.traveller || !b.fromDate || !b.toDate || b.toDate < b.fromDate) return void res.status(400).json({ error: 'Please check the insurance details' });
  res.status(201).json({ id: createInsurance(sess(req).email, String(b.plan), String(b.traveller), String(b.fromDate), String(b.toDate), price) });
});

app.post('/api/book', auth, (req, res) => {
  const s = sess(req);
  if (!s.otpOk) return void res.status(403).json({ error: 'verify OTP first' });
  const key = req.headers['idempotency-key'] as string;
  if (!key) return void res.status(400).json({ error: 'idempotency-key required' });
  if (!req.body.client?.passport || !req.body.client?.dob) return void res.status(400).json({ error: 'client details missing' });
  if (faults.routeLossPct && chance(faults.routeLossPct)) return void drop(req);            // lost before commit
  const r: any = tryBook(key, Number(req.body.slotId), s.email);
  if (r.status === 'taken') return void res.status(409).json({ error: 'slot taken' });
  if (r.status === 'account') return void res.status(409).json({ error: 'account already booked' });
  if (r.status === 'missing') return void res.status(404).json({ error: 'no such slot' });
  if (faults.crashAfterCommitPct && chance(faults.crashAfterCommitPct)) return void drop(req);   // committed, response lost
  res.status(201).json({ ...r.booking, email: s.email });
});

// ---------- control panel API ----------
const logs: string[] = [];
const log = (m: string) => { logs.push(`[${new Date().toLocaleTimeString('en-GB')}] ${redact(m)}`); if (logs.length > 300) logs.shift(); };
const runner = createRunner(BASE, log, { getPassword: e => vault[e], resetSite: resetState,
  otp: { get: () => faults.requireOtp, set: on => { faults.requireOtp = on; } } });

app.post('/api/panel/license', (req, res) => {
  const { username, password } = req.body || {};
  username && password === 'lab123' ? res.json({ ok: true }) : res.status(401).json({ error: 'Invalid license' });
});
app.get('/api/panel/state', (_req, res) => {
  const snap = runner.snapshot();
  const a = audit(runner.rawProfiles().map(p => ({ account: p.account, slot: p.slot, status: p.status })));
  const times = snap.profiles.filter(p => p.slot && p.elapsed != null).map(p => p.elapsed!).sort((x, y) => x - y);
  res.json({ ...snap, faults, stats, audit: a, bench: runner.bench, runs: listRuns(), log: logs.slice(-80),
    p95ms: times.length ? times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)] : null });
});
app.post('/api/panel/excel', async (req, res) => {
  try {
    const rows = await parseClients(req.body);
    if (req.query.mode !== 'add') { await runner.clear(); resetState(); }
    const n = runner.addClients(rows);
    log(`Loaded ${n} profiles from ${req.query.name || 'excel'}`);
    res.json({ ok: true, added: n });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
app.post('/api/panel/action', async (req, res) => { await runner.act(req.body?.action, req.body?.ids); res.json({ ok: true }); });
app.post('/api/panel/settings', (req, res) => {
  const b = req.body || {};
  if (b.showBrowsers !== undefined) runner.settings.headless = !b.showBrowsers;
  if (b.engine === 'playwright' || b.engine === 'puppeteer') runner.settings.engine = b.engine;
  if (b.maxConcurrent) runner.settings.maxConcurrent = Math.max(1, Math.min(20, +b.maxConcurrent));
  if (b.pace !== undefined) runner.settings.pace = Math.max(0, Math.min(5000, +b.pace || 0));
  if (b.admitPerMin) runner.settings.admitPerMin = Math.max(1, Math.min(6000, +b.admitPerMin));
  res.json({ ok: true });
});
app.post('/api/panel/faults', (req, res) => {
  const b = req.body || {}, num = (v: any, max: number) => Math.max(0, Math.min(max, +v || 0));
  Object.assign(faults, { requireOtp: !!b.requireOtp, otpDelaySec: num(b.otpDelaySec, 10), otpDuplicate: !!b.otpDuplicate, otpTtlSec: Math.max(3, num(b.otpTtlSec, 300) || 60),
    domDrift: ['off', 'layout', 'rename'].includes(b.domDrift) ? b.domDrift : 'off', routeLossPct: num(b.routeLossPct, 50),
    crashAfterCommitPct: num(b.crashAfterCommitPct, 100), challengePct: num(b.challengePct, 100), invalidatePct: num(b.invalidatePct, 50) });
  log(`Faults set: ${JSON.stringify(faults)}`);
  res.json({ ok: true });
});
app.get('/api/panel/sample.xlsx', async (_req, res) => {
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment('clients.xlsx').send(await sampleBuffer());
});
app.post('/api/panel/clear', async (_req, res) => { await runner.clear(); log('Profiles cleared'); res.json({ ok: true }); });
app.post('/api/panel/reset-site', (_req, res) => { resetState(); log('Site reset: slots, bookings and sessions cleared'); res.json({ ok: true }); });
app.post('/api/panel/emergency', (req, res) => { req.body?.on === false ? runner.resume() : runner.emergency(); res.json({ ok: true }); });
app.post('/api/panel/canary', async (_req, res) => { try { res.json(await runner.canary()); } catch (e: any) { res.status(500).json({ error: String(e.message).split('\n')[0] }); } });
app.post('/api/panel/benchmark', (req, res) => {
  const engines = (req.body?.engines || ['playwright', 'puppeteer']).filter((e: string) => e === 'playwright' || e === 'puppeteer');
  const sizes = (req.body?.sizes || [1, 5, 10, 20]).map(Number).filter((n: number) => n >= 1 && n <= 50);
  runner.benchmark(engines, sizes);
  res.json({ ok: true });
});
app.get('/api/panel/report.csv', (_req, res) => {
  const runs = listRuns().reverse();
  const cols = runs.length ? Object.keys(runs[0]) : [];
  res.type('text/csv').attachment('benchmark.csv').send([cols.join(','), ...runs.map(r => cols.map(c => r[c]).join(','))].join('\n'));
});

// CHANGE 2: listen on all interfaces so Render can reach the server.
app.listen(PORT, '0.0.0.0', () => console.log(`Lab running:\n  Control panel: ${BASE}/app.html\n  Portal:        ${BASE}/site.html`));