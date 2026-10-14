// Reads clients.xlsx. Columns (case-insensitive): Full_Name (optional), appointment_for, Date_of_Birth, Passport,
// Passport_Exp_Date, Gender, Nationality, Phone (optional), Appointment_Date (one or more dates, comma separated).
import ExcelJS from 'exceljs';
import { PEOPLE } from './data.js';

export interface Client { fullName: string; appointment_for: string; dob: string; passport: string; passportExp: string;
  gender: string; nationality: string; phone: string; dates: string[] }

const plain = (v: any) => (v && typeof v === 'object' && !(v instanceof Date)) ? (v.result ?? v.text ?? '') : v;
const iso = (v: any) => {
  v = plain(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : s;
};

export async function parseClients(buffer: Buffer): Promise<Client[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('No sheet found');
  const header: Record<string, number> = {};
  ws.getRow(1).eachCell((c, i) => { header[String(plain(c.value)).trim().toLowerCase()] = i; });
  const get = (row: ExcelJS.Row, name: string) => { const i = header[name]; return i ? plain(row.getCell(i).value) : ''; };
  const str = (row: ExcelJS.Row, name: string) => String(get(row, name) ?? '').trim();
  const rows: Client[] = [];
  ws.eachRow((row, n) => {
    if (n === 1 || !str(row, 'passport')) return;
    const dc = get(row, 'appointment_date');
    rows.push({
      fullName: str(row, 'full_name'), appointment_for: str(row, 'appointment_for'),
      dob: iso(get(row, 'date_of_birth')), passport: str(row, 'passport'), passportExp: iso(get(row, 'passport_exp_date')),
      gender: str(row, 'gender').toUpperCase(), nationality: str(row, 'nationality').toUpperCase(), phone: str(row, 'phone'),
      dates: (dc instanceof Date ? [dc] : String(dc ?? '').split(/[,;]/)).map(iso).filter(Boolean),
    });
  });
  if (!rows.length) throw new Error('No client rows found (check the Passport column)');
  return rows;
}

/** A ready-made clients.xlsx with 20 fictional applicants, downloadable from the control panel. */
export async function sampleBuffer(): Promise<Buffer> {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const day = (n: number) => { const t = new Date(); t.setDate(t.getDate() + n); return `${p2(t.getDate())}/${p2(t.getMonth() + 1)}/${t.getFullYear()}`; };
  const dmy = (iso: string) => iso.split('-').reverse().join('/');
  const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('clients');
  ws.addRow(['Full_Name', 'appointment_for', 'Date_of_Birth', 'Passport', 'Passport_Exp_Date', 'Gender', 'Nationality', 'Phone', 'Appointment_Date']);
  PEOPLE.slice(0, 20).forEach((p, i) => ws.addRow([p.name, 'Submission Schengen Visa (Short term - Type C)', dmy(p.dob), p.passport,
    dmy(p.passportExp), p.gender, p.nationality, p.phone, `${day(2 + (i % 2))},${day(4)},${day(5)}`]));
  return Buffer.from(await wb.xlsx.writeBuffer());
}