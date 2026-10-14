// SQLite (node:sqlite, built into Node 22+). UNIQUE constraints make slot allocation atomic.
import { DatabaseSync } from 'node:sqlite';

export const db = new DatabaseSync('lab.db');
db.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS slots(id INTEGER PRIMARY KEY, date TEXT, time TEXT);
  CREATE TABLE IF NOT EXISTS bookings(id INTEGER PRIMARY KEY AUTOINCREMENT, idem TEXT UNIQUE,
    slot_id INTEGER UNIQUE REFERENCES slots(id), email TEXT UNIQUE, created INTEGER);
  CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT, engine TEXT, status TEXT,
    started INTEGER, ended INTEGER, ms INTEGER, slot TEXT, error TEXT);
  CREATE TABLE IF NOT EXISTS runs(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, json TEXT);
  CREATE TABLE IF NOT EXISTS applications(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, ref TEXT, applicant TEXT, passport TEXT,
    type TEXT, travel_date TEXT, status TEXT, created INTEGER, submitted INTEGER);
  CREATE TABLE IF NOT EXISTS insurance(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, plan TEXT, traveller TEXT, from_date TEXT,
    to_date TEXT, price REAL, paid INTEGER DEFAULT 0, created INTEGER);
`);

try { db.exec('ALTER TABLE bookings ADD COLUMN paid INTEGER DEFAULT 0'); } catch { /* column already exists */ }

const pad = (n: number) => String(n).padStart(2, '0');
export const dayStr = (offset: number) => {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** 16 slots per day for the next 14 days. Rebuilt when the window is stale or when forced. */
export function ensureSlots(force = false) {
  const first = db.prepare('SELECT MIN(date) d FROM slots').get() as { d: string | null };
  if (!force && first.d === dayStr(1)) return;
  if (force) db.exec('DELETE FROM applications; DELETE FROM insurance;');
  db.exec('DELETE FROM bookings; DELETE FROM slots; BEGIN');
  const ins = db.prepare('INSERT INTO slots(date,time) VALUES(?,?)');
  for (let d = 1; d <= 14; d++) for (let h = 9; h < 13; h++) for (const m of [0, 15, 30, 45])
    ins.run(dayStr(d), `${pad(h)}:${pad(m)}`);
  db.exec('COMMIT');
}

export const listSlots = (date: string) => db.prepare(
  `SELECT s.id id, s.time time, (b.id IS NOT NULL) booked FROM slots s LEFT JOIN bookings b ON b.slot_id=s.id
   WHERE s.date=? ORDER BY s.time`).all(date) as { id: number; time: string; booked: number }[];

export const myBooking = (email: string) => db.prepare(
  `SELECT b.slot_id slotId, s.date date, s.time time FROM bookings b JOIN slots s ON s.id=b.slot_id WHERE b.email=?`
).get(email) as { slotId: number; date: string; time: string } | undefined;

const byKey = (k: string) => db.prepare(
  `SELECT b.slot_id slotId, s.date date, s.time time FROM bookings b JOIN slots s ON s.id=b.slot_id WHERE b.idem=?`
).get(k) as { slotId: number; date: string; time: string } | undefined;

export function tryBook(key: string, slotId: number, email: string) {
  if (byKey(key)) return { status: 'ok', booking: byKey(key) };                  // idempotent replay
  if (myBooking(email)) return { status: 'account' };
  if (!db.prepare('SELECT 1 FROM slots WHERE id=?').get(slotId)) return { status: 'missing' };
  try {
    db.prepare('INSERT INTO bookings(idem,slot_id,email,created) VALUES(?,?,?,?)').run(key, slotId, email, Date.now());
  } catch (e: any) {
    if (/slot_id/.test(String(e.message))) return { status: 'taken' };           // constraint = atomic guarantee
    if (/email/.test(String(e.message))) return { status: 'account' };
    throw e;
  }
  return { status: 'ok', booking: myBooking(email) };
}

export function audit(rows: { account: string; slot: string | null; status: string }[]) {
  const recs = db.prepare(`SELECT b.email email, s.date||' '||s.time slot FROM bookings b JOIN slots s ON s.id=b.slot_id`)
    .all() as { email: string; slot: string }[];
  const byAcct = new Map(recs.map(r => [r.email, r.slot]));
  const one = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  let slotMismatch = 0, phantom = 0, unreconciled = 0;
  for (const r of rows) {
    const rec = byAcct.get(r.account), claimed = /^Claimed/.test(r.status);
    if (claimed && !rec) phantom++; else if (claimed && rec !== r.slot) slotMismatch++; else if (!claimed && rec) unreconciled++;
  }
  return {
    booked: recs.length, slotMismatch, phantom, unreconciled,
    doubleAllocated: one('SELECT COUNT(*) c FROM (SELECT slot_id FROM bookings GROUP BY slot_id HAVING COUNT(*)>1)'),
    multiBooked: one('SELECT COUNT(*) c FROM (SELECT email FROM bookings GROUP BY email HAVING COUNT(*)>1)'),
  };
}

export const jobStart = (account: string, engine: string) => Number(db.prepare(
  'INSERT INTO jobs(account,engine,status,started) VALUES(?,?,?,?)').run(account, engine, 'running', Date.now()).lastInsertRowid);
export const jobEnd = (id: number, status: string, slot: string | null, error: string | null, ms: number) =>
  db.prepare('UPDATE jobs SET status=?, ended=?, ms=?, slot=?, error=? WHERE id=?').run(status, Date.now(), ms, slot, error, id);
export const saveRun = (r: object) => db.prepare('INSERT INTO runs(at,json) VALUES(?,?)').run(Date.now(), JSON.stringify(r));
export const listRuns = () => (db.prepare('SELECT json FROM runs ORDER BY id DESC LIMIT 40').all() as { json: string }[]).map(r => JSON.parse(r.json));

export const markPaid = (email: string) => Number(db.prepare('UPDATE bookings SET paid=1 WHERE email=?').run(email).changes) > 0;

// ---------- portal data: applications, appointments, insurance ----------
export interface AppIn { applicant: string; passport: string; type: string; travelDate: string }
const refNo = () => 'APP' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
export function createApplication(email: string, a: AppIn, submit: boolean) {
  const now = Date.now();
  return Number(db.prepare('INSERT INTO applications(email,ref,applicant,passport,type,travel_date,status,created,submitted) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(email, refNo(), a.applicant, a.passport, a.type, a.travelDate, submit ? 'submitted' : 'draft', now, submit ? now : null).lastInsertRowid);
}
export const listApplications = (email: string, status: string) => db.prepare(
  `SELECT id, ref, applicant, passport, type, travel_date travelDate, created, submitted FROM applications WHERE email=? AND status=? ORDER BY id DESC`
).all(email, status) as { id: number; ref: string; applicant: string; passport: string; type: string; travelDate: string; created: number; submitted: number }[];
export const submitApplication = (email: string, id: number) => Number(db.prepare(
  "UPDATE applications SET status='submitted', submitted=? WHERE id=? AND email=? AND status='draft'").run(Date.now(), id, email).changes) > 0;
export const deleteDraft = (email: string, id: number) => Number(db.prepare(
  "DELETE FROM applications WHERE id=? AND email=? AND status='draft'").run(id, email).changes) > 0;
export const trackApplication = (email: string, ref: string, passport: string) => db.prepare(
  "SELECT ref, applicant, type, submitted FROM applications WHERE email=? AND ref=? AND passport=? AND status='submitted'"
).get(email, ref, passport) as { ref: string; applicant: string; type: string; submitted: number } | undefined;

export const appointmentInfo = (email: string) => db.prepare(
  `SELECT s.date date, s.time time, b.paid paid FROM bookings b JOIN slots s ON s.id=b.slot_id WHERE b.email=?`
).get(email) as { date: string; time: string; paid: number } | undefined;

export const createInsurance = (email: string, plan: string, traveller: string, from: string, to: string, price: number) => Number(db.prepare(
  'INSERT INTO insurance(email,plan,traveller,from_date,to_date,price,created) VALUES(?,?,?,?,?,?,?)').run(email, plan, traveller, from, to, price, Date.now()).lastInsertRowid);
export const listInsurance = (email: string) => db.prepare(
  'SELECT id, plan, traveller, from_date fromDate, to_date toDate, price, paid FROM insurance WHERE email=? ORDER BY id DESC'
).all(email) as { id: number; plan: string; traveller: string; fromDate: string; toDate: string; price: number; paid: number }[];
export const insuranceById = (email: string, id: number) => db.prepare(
  'SELECT id, plan, traveller, price, paid FROM insurance WHERE email=? AND id=?').get(email, id) as { id: number; plan: string; traveller: string; price: number; paid: number } | undefined;
export const payInsurance = (email: string, id: number) => Number(db.prepare('UPDATE insurance SET paid=1 WHERE email=? AND id=?').run(email, id).changes) > 0;
export const portalCounts = (email: string) => {
  const n = (sql: string) => (db.prepare(sql).get(email) as { c: number }).c;
  return { drafts: n("SELECT COUNT(*) c FROM applications WHERE email=? AND status='draft'"),
    submitted: n("SELECT COUNT(*) c FROM applications WHERE email=? AND status='submitted'"),
    insurance: n('SELECT COUNT(*) c FROM insurance WHERE email=?') };
};