// Creates clients.xlsx with 20 fictional applicants, preferred dates inside the demo site's window.
import ExcelJS from 'exceljs';
import { PEOPLE } from '../data.js';

const d = (n: number) => { const t = new Date(); t.setDate(t.getDate() + n); return t.toISOString().slice(0, 10).split('-').reverse().join('/'); };
const dmy = (iso: string) => iso.split('-').reverse().join('/');
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('clients');
ws.addRow(['Full_Name', 'appointment_for', 'Date_of_Birth', 'Passport', 'Passport_Exp_Date', 'Gender', 'Nationality', 'Phone', 'Appointment_Date']);
PEOPLE.slice(0, 20).forEach((p, i) => ws.addRow([p.name, 'Submission Schengen Visa (Short term - Type C)', dmy(p.dob), p.passport,
  dmy(p.passportExp), p.gender, p.nationality, p.phone, `${d(2 + (i % 2))},${d(4)},${d(5)}`]));
await wb.xlsx.writeFile('clients.xlsx');
console.log('Created clients.xlsx with 20 fictional applicants');