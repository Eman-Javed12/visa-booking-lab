// Encrypted secrets (AES-256-GCM) + log redaction.
import crypto from 'node:crypto';
import fs from 'node:fs';

const KEY_FILE = '.lab.key', VAULT = 'vault.enc';
const key = () => {
  if (!fs.existsSync(KEY_FILE)) fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
};
const seal = (obj: object) => {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return JSON.stringify({ iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), data: data.toString('hex') });
};
const unseal = (s: string) => {
  const j = JSON.parse(s), d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(j.iv, 'hex'));
  d.setAuthTag(Buffer.from(j.tag, 'hex'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(j.data, 'hex')), d.final()]).toString('utf8'));
};

/** Loads (or creates) one random password per account; the file on disk is encrypted. */
export function loadVault(emails: string[]): Record<string, string> {
  let v: Record<string, string> = {};
  try { if (fs.existsSync(VAULT)) v = unseal(fs.readFileSync(VAULT, 'utf8')); } catch { v = {}; }
  let dirty = false;
  for (const e of emails) if (!v[e]) { v[e] = crypto.randomBytes(9).toString('base64url'); dirty = true; }
  if (dirty) fs.writeFileSync(VAULT, seal(v));
  return v;
}
export const hashPw = (pw: string, salt: string) => crypto.scryptSync(pw, salt, 32, { N: 2048 }).toString('hex');

/** Keeps OTPs, tokens, passwords and passport numbers out of logs. */
export const redact = (s: string) => s
  .replace(/\b\d{6}\b/g, '******')
  .replace(/Bearer\s+[\w-]+/gi, 'Bearer ***')
  .replace(/password["'=:\s]+\S+/gi, 'password=***')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<token>')
  .replace(/\bVN\d{4}(\d{3})\b/g, 'VN****$1');