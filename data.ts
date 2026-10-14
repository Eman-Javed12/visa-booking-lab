// Fictional applicants (synthetic names, passports and e-mail addresses on a made-up domain; nothing is ever sent to them).
const FIRST = ['Ayesha','Hamza','Fatima','Bilal','Sana','Usman','Hira','Zain','Maryam','Ali','Noor','Ahmed','Iqra',
  'Saad','Amna','Hassan','Zara','Omar','Laiba','Faisal','Mehwish','Talha','Rabia','Imran','Sadia'];
const LAST = ['Khan','Malik','Raza','Siddiqui','Qureshi','Butt','Chaudhry','Sheikh','Mirza','Ansari','Hashmi','Baig',
  'Niazi','Javed','Akhtar','Rana','Gill','Cheema','Dar','Farooqi','Bhatti','Hussain','Aslam','Yousaf','Zafar'];
const MALE = new Set(['Hamza','Bilal','Usman','Zain','Ali','Ahmed','Saad','Hassan','Omar','Faisal','Talha','Imran']);
const pad = (n: number) => String(n).padStart(2, '0');

export interface Person { index: number; name: string; email: string; passport: string; passportExp: string;
  dob: string; gender: string; nationality: string; phone: string }

export const PEOPLE: Person[] = Array.from({ length: 50 }, (_, i) => {
  const first = FIRST[i % 25], last = LAST[(3 * i + 5 * Math.floor(i / 25)) % 25];
  return {
    index: i, name: `${first} ${last}`,
    email: `${first}.${last}@mailvault.pk`.toLowerCase(),
    passport: `VN${String(1500000 + (i * 7919) % 8000000).padStart(7, '0')}`,
    passportExp: `${2029 + (i % 4)}-${pad(1 + (i * 5) % 12)}-${pad(1 + (i * 3) % 28)}`,
    dob: `${1970 + (i * 7) % 33}-${pad(1 + (i * 5) % 12)}-${pad(1 + (i * 11) % 28)}`,
    gender: MALE.has(first) ? 'MALE' : 'FEMALE', nationality: 'PAKISTAN',
    phone: `03${pad(10 + (i * 3) % 40)}${String(1000000 + i * 48271 % 9000000)}`,
  };
});

// Internal account used only by the OTP self-check (not a client profile).
export const PROBE = { name: 'Audit Checker', email: 'audit.checker@mailvault.pk' };
export const ALL_ACCOUNTS = [...PEOPLE.map(p => p.email), PROBE.email];