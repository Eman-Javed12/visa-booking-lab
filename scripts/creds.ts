// Prints the (decrypted) login for one account so you can sign in by hand:  npm run creds -- ayesha
import { PEOPLE, ALL_ACCOUNTS } from '../data.js';
import { loadVault } from '../secrets.js';

const q = (process.argv[2] || '').toLowerCase();
const vault = loadVault(ALL_ACCOUNTS);
const hits = PEOPLE.filter(p => !q || p.name.toLowerCase().includes(q)).slice(0, 10);
for (const p of hits) console.log(`${p.name.padEnd(22)} ${p.email.padEnd(32)} ${vault[p.email]}`);
if (!hits.length) console.log('No match');