// Drives the app's real API client (src/api.js) against the real Worker and checks every field the screens read.
import { Database } from 'bun:sqlite';
import { readFileSync } from 'fs';
import worker from '../src/index.js';
import * as api from '../../src/api.js';

const sqlite = new Database(':memory:');
sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
const DB = { prepare(sql) { let a = []; const st = sqlite.prepare(sql); const o = { bind(...x) { a = x; return o; }, first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }), run: async () => ({ meta: { changes: st.run(...a).changes } }), _exec() { return { meta: { changes: st.run(...a).changes } }; } }; return o; },
  async batch(s) { sqlite.exec('BEGIN'); try { const r = s.map((x) => x._exec()); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } } };
const env = { DB, DEMO_MODE: 'true', ADMIN_SECRET: 'x', RAKE_BPS: '1000', BLOCKED_STATES: '', RATE_LIMIT: 'off' };
globalThis.fetch = (url, opts) => worker.fetch(new Request('https://api.test' + url, opts), env);

let fails = 0, passes = 0;
const { errMsg } = await import('../../src/util.js');
const has = (label, obj, spec) => { for (const [k, t] of Object.entries(spec)) { const v = obj == null ? undefined : obj[k]; const good = t === 'array' ? Array.isArray(v) : t === 'any' ? v !== undefined : typeof v === t; if (good) passes++; else { fails++; console.log(`FAIL ${label}.${k}: expected ${t}, got ${JSON.stringify(v)}`); } } };

const A = await api.signup('Ann', 'pw1234'), B = await api.signup('Ben', 'pw1234');
has('signup', A, { token: 'string', userId: 'string', name: 'string' });
await api.checkout(A.token, 5000); await api.checkout(B.token, 5000);
const created = await api.createPot(A.token, { name: 'Quit Crew', goalType: 'quit', goalText: 'Stayed clean today', durationDays: 7, stakeCents: 1000, maxMembers: 4, strict: false });
has('createPot', created, { id: 'string', joinCode: 'string' });
const prev = await api.joinPreview(created.joinCode);
has('joinPreview', prev, { name: 'string', goalText: 'string', creator: 'string', durationDays: 'number', memberCount: 'number', maxMembers: 'number', stakeCents: 'number', status: 'string' });
const j = await api.joinPot(B.token, created.joinCode); has('joinPot', j, { id: 'string' });

let d = await api.pot(A.token, created.id);
has('pot(open).pot', d.pot, { id: 'string', name: 'string', goalText: 'string', potCents: 'number', stakeCents: 'number', durationDays: 'number', strict: 'boolean', status: 'string', creatorId: 'string', memberCount: 'number', maxMembers: 'number', joinCode: 'string' });
has('pot(open).me', d.me, { checkedInToday: 'boolean', disputesLeft: 'number' });
has('pot(open).members[0]', d.members[0], { id: 'string', name: 'string', isMe: 'boolean', days: 'array', valid: 'number', streak: 'number', alive: 'boolean', allowed: 'number' });

await api.startPot(A.token, created.id);
await api.checkin(A.token, created.id, ''); await api.checkin(B.token, created.id, '');
d = await api.pot(B.token, created.id);
has('pot(active).members[0].days[0]', d.members[0].days[0], { date: 'string', status: 'string' });
const ann = d.members.find((m) => m.name === 'Ann');
console.log('  active day statuses for Ann:', ann.days.map((x) => x.status).join(','));
if (ann.days[0].status !== 'done') { fails++; console.log('FAIL today should be done after check-in'); } else passes++;
if (d.members.find((m) => m.isMe).name !== 'Ben') { fails++; console.log('FAIL isMe wrong'); } else passes++;
await api.dispute(B.token, created.id, ann.id, ann.days[0].date);
d = await api.pot(B.token, created.id); has('disputesLeft after one dispute', d.me, { disputesLeft: 'number' }); if (d.me.disputesLeft !== 1) { fails++; console.log('FAIL disputesLeft', d.me); } else passes++;

const me = await api.me(A.token);
has('me', me, { balanceCents: 'number', demoMode: 'boolean', pots: 'array', user: 'any' });
has('me.pots[0]', me.pots[0], { id: 'string', name: 'string', potCents: 'number', goalText: 'string', status: 'string', memberCount: 'number', durationDays: 'number', stakeCents: 'number' });
const w = await api.wallet(A.token);
has('wallet', w, { balanceCents: 'number', demoMode: 'boolean', entries: 'array', withdrawals: 'array' });
has('wallet.entries[0]', w.entries[0], { type: 'string', amount_cents: 'number' });
const wd = await api.withdraw(A.token, 1000); has('withdraw', wd, { id: 'string', status: 'string' });
const w2 = await api.wallet(A.token); has('wallet.withdrawals[0]', w2.withdrawals[0], { id: 'string', status: 'string', amount_cents: 'number' });


// ---- public play, leaderboard, recovery: every field the new screens read
{
  const C1 = await api.signup('Cy', 'pw1234'), C2 = await api.signup('Di', 'pw1234');
  await api.checkout(C1.token, 5000); await api.checkout(C2.token, 5000);
  const pp = await api.playPublic(C1.token, { goalType: 'sleep', durationDays: 7, stakeCents: 1000 });
  has('playPublic', pp, { id: 'string', created: 'boolean' });
  const pp2 = await api.playPublic(C2.token, { goalType: 'sleep', durationDays: 7, stakeCents: 1000 });
  if (pp2.id !== pp.id) { fails++; console.log('FAIL second player not matched'); } else passes++;
  const list = await api.publicPots(C1.token);
  has('publicPots', list, { pots: 'array', playersLive: 'number' });
  const row = list.pots.find((p) => p.id === pp.id);
  has('publicPots.pots[]', row, { id: 'string', name: 'string', goalType: 'string', goalText: 'string', potCents: 'number', stakeCents: 'number', durationDays: 'number', memberCount: 'number', maxMembers: 'number', startsAt: 'string', joined: 'boolean' });
  const det = await api.pot(C1.token, pp.id);
  has('pot(public).pot', det.pot, { isPublic: 'boolean', startsAt: 'string', status: 'string', memberCount: 'number', maxMembers: 'number' });
  const C3 = await api.signup('Ed', 'pw1234'); await api.checkout(C3.token, 2000);
  const jp = await api.joinPublic(C3.token, pp.id); has('joinPublic', jp, { id: 'string' });
  const lb = await api.leaderboard(C1.token);
  has('leaderboard', lb, { top: 'array', windowDays: 'number' });
  const me2 = await api.me(C1.token);
  has('me.stats', me2.stats, { played: 'number', wins: 'number', netCents: 'number' });
  const lg = await api.login('cy', 'pw1234');
  has('login', lg, { token: 'string', userId: 'string', name: 'string' });
  try { await api.login('Cy', 'wrong'); fails++; console.log('FAIL bad login accepted'); } catch (e) { if (e.message === 'bad_login') passes++; else { fails++; console.log('FAIL login error', e.message); } }
  try { await api.signup('cy', 'pw1234'); fails++; console.log('FAIL duplicate name accepted'); } catch (e) { if (e.message === 'name_taken') passes++; else { fails++; console.log('FAIL dup error', e.message); } }
  for (const code of ['rate_limited', 'public_auto', 'server_error', 'bad_login', 'name_taken', 'bad_password', 'bad_name']) { if (errMsg({ message: code }) === 'Something went wrong. Try again.') { fails++; console.log('FAIL no message for', code); } else passes++; }
}

// error codes the UI maps must actually be what the server sends
const probes = [
  ['insufficient_funds', () => api.createPot(A.token, { name: 'Huge', goalText: 'yes yes', durationDays: 7, stakeCents: 10000 })],
  ['bad_code', () => api.joinPot(A.token, 'NOPE00')],
  ['already_joined', () => api.joinPot(B.token, created.joinCode)],
  ['not_open', () => api.joinPot(B.token, created.joinCode)],
  ['unauthorized', () => api.me('sk_bogus')],
];
for (const [want, fn] of probes) { try { await fn(); fails++; console.log('FAIL expected error for', want); } catch (e) { const known = errMsg(e) !== 'Something went wrong. Try again.'; if (known) passes++; else { fails++; console.log(`FAIL error "${e.message}" has no friendly message (wanted ${want})`); } } }
console.log(`\ncontract: ${passes} passed, ${fails} failed`); process.exit(fails ? 1 : 0);
