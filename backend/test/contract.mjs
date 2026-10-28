// Drives the app's real API client (src/api.js) against the real Worker and checks every field the screens read.
import { Database } from 'bun:sqlite';
import { readFileSync } from 'fs';
import worker from '../src/index.js';
import * as api from '../../src/api.js';

const sqlite = new Database(':memory:');
sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
const DB = { prepare(sql) { let a = []; const st = sqlite.prepare(sql); const o = { bind(...x) { a = x; return o; }, first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }), run: async () => ({ meta: { changes: st.run(...a).changes } }), _exec() { return { meta: { changes: st.run(...a).changes } }; } }; return o; },
  async batch(s) { sqlite.exec('BEGIN'); try { const r = s.map((x) => x._exec()); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } } };
const env = { DB, ADMIN_SECRET: 'x', RAKE_BPS: '1000', BLOCKED_STATES: '', RATE_LIMIT: 'off' };
globalThis.fetch = (url, opts) => worker.fetch(new Request('https://api.test' + url, opts), env);

let fails = 0, passes = 0;
const { errMsg } = await import('../../src/util.js');
const has = (label, obj, spec) => { for (const [k, t] of Object.entries(spec)) { const v = obj == null ? undefined : obj[k]; const good = t === 'array' ? Array.isArray(v) : t === 'any' ? v !== undefined : typeof v === t; if (good) passes++; else { fails++; console.log(`FAIL ${label}.${k}: expected ${t}, got ${JSON.stringify(v)}`); } } };

const A = await api.signup('Ann', 'pw1234', 'ann@t.test'), B = await api.signup('Ben', 'pw1234', 'ben@t.test');
has('signup', A, { token: 'string', userId: 'string', name: 'string' });
await api.checkout(A.token, 5000); await api.checkout(B.token, 5000);
const created = await api.createPot(A.token, { name: 'Quit Crew', goalType: 'quit', goalText: 'Stayed clean today', durationDays: 7, stakeCents: 1000, maxMembers: 4, strict: false });
has('createPot', created, { id: 'string', joinCode: 'string' });
const prev = await api.joinPreview(created.joinCode);
has('joinPreview', prev, { name: 'string', goalText: 'string', creator: 'string', durationDays: 'number', memberCount: 'number', maxMembers: 'number', stakeCents: 'number', status: 'string', currency: 'string' });
const j = await api.joinPot(B.token, created.joinCode); has('joinPot', j, { id: 'string' });

let d = await api.pot(A.token, created.id);
has('pot(open).pot', d.pot, { id: 'string', name: 'string', goalText: 'string', potCents: 'number', stakeCents: 'number', durationDays: 'number', strict: 'boolean', status: 'string', creatorId: 'string', memberCount: 'number', maxMembers: 'number', joinCode: 'string', currency: 'string' });
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
has('me', me, { balanceCents: 'number', cashCents: 'number', cash: 'object', pots: 'array', user: 'any' });
has('me.user', me.user, { id: 'string', name: 'string', email: 'string', emailVerified: 'boolean' });
// account screens: send/verify code, forgot/reset, logout (dev codes on so the code comes back)
{
  env.DEV_CODES = 'on';
  const sc = await api.sendCode(B.token); has('sendCode', sc, { email: 'string', verified: 'boolean', devCode: 'string' });
  has('verifyCode', await api.verifyCode(B.token, sc.devCode), { verified: 'boolean' });
  await api.signup('Dot', 'pw1234', 'dot@t.test'); // reset signs out every device, so not Ben
  const fp = await api.forgotPassword('dot@t.test'); has('forgotPassword', fp, { devCode: 'string' });
  const rp = await api.resetPassword('dot@t.test', fp.devCode, 'pw1234'); has('resetPassword', rp, { token: 'string', userId: 'string', name: 'string' });
  has('logout', await api.logout(rp.token), { ok: 'boolean' });
  delete env.DEV_CODES;
}
has('me.cash', me.cash, { enabled: 'boolean', payoutsReady: 'boolean', blocked: 'any', excludedUntil: 'any' });
has('me.pots[0]', me.pots[0], { id: 'string', name: 'string', potCents: 'number', goalText: 'string', status: 'string', memberCount: 'number', durationDays: 'number', stakeCents: 'number', currency: 'string', checkedInToday: 'boolean', myCheckins: 'number' });
has('me', me, { today: 'string' });
if (!me.pots.find((p) => p.id === created.id).checkedInToday) { fails++; console.log('FAIL me.pots checkedInToday after check-in'); } else passes++;
const w = await api.wallet(A.token);
has('wallet', w, { balanceCents: 'number', withdrawableCents: 'number', cash: 'object', entries: 'array', withdrawals: 'array' });
has('wallet.entries[0]', w.entries[0], { type: 'string', amount_cents: 'number' });

// ---- real money: switch cash on (manual payouts, no geofence, no hold) and walk the cash screens
{
  Object.assign(env, { CASH: 'on', GEOFENCE: 'off', PAYOUTS: 'manual', WITHDRAW_HOLD_HOURS: '0' });
  sqlite.run('UPDATE users SET email_verified = 1 WHERE id = ?', [A.userId]);
  sqlite.run("INSERT INTO ledger (user_id, type, amount_cents, currency, ref, created_at) VALUES (?, 'deposit', 3000, 'cash', 'seedcash', '2020-01-01')", [A.userId]);
  const cw = await api.wallet(A.token, 'cash');
  if (cw.currency !== 'cash' || cw.balanceCents !== 3000 || cw.withdrawableCents !== 3000) { fails++; console.log('FAIL cash wallet', cw); } else passes++;
  const cp = await api.createPot(A.token, { name: 'Cash Crew', goalType: 'move', goalText: 'Move it', durationDays: 7, stakeCents: 1000, currency: 'cash' });
  if ((await api.pot(A.token, cp.id)).pot.currency !== 'cash') { fails++; console.log('FAIL cash pot currency'); } else passes++;
  const pub = await api.playPublic(A.token, { goalType: 'eat', durationDays: 7, stakeCents: 500, currency: 'cash' });
  const cl = await api.publicPots(A.token, 'cash');
  if (!cl.pots.some((p) => p.id === pub.id && p.currency === 'cash') || (await api.publicPots(A.token, 'play')).pots.some((p) => p.id === pub.id)) { fails++; console.log('FAIL cash public list'); } else passes++;
  has('leaderboard(cash)', await api.leaderboard(A.token, 'cash'), { top: 'array', windowDays: 'number' });
  const wd = await api.withdraw(A.token, 1000); has('withdraw', wd, { id: 'string', status: 'string', balanceCents: 'number' });
  const w2 = await api.wallet(A.token, 'cash'); has('wallet.withdrawals[0]', w2.withdrawals[0], { id: 'string', status: 'string', amount_cents: 'number' });
  const ex = await api.selfExclude(A.token, 1); has('selfExclude', ex, { excludedUntil: 'string' });
  has('me.cash after break', (await api.me(A.token)).cash, { excludedUntil: 'string', blocked: 'string' });
  const pw = await api.wallet(A.token, 'play');
  if (pw.entries.some((e) => e.type === 'withdrawal') || pw.withdrawals.length) { fails++; console.log('FAIL cash rows leaked into play wallet'); } else passes++;
  Object.assign(env, { CASH: 'off' });
}


// ---- public play, leaderboard, recovery: every field the new screens read
{
  const C1 = await api.signup('Cy', 'pw1234', 'cy@t.test'), C2 = await api.signup('Di', 'pw1234', 'di@t.test');
  await api.checkout(C1.token, 5000); await api.checkout(C2.token, 5000);
  const pp = await api.playPublic(C1.token, { goalType: 'sleep', durationDays: 7, stakeCents: 1000 });
  has('playPublic', pp, { id: 'string', created: 'boolean' });
  const pp2 = await api.playPublic(C2.token, { goalType: 'sleep', durationDays: 7, stakeCents: 1000 });
  if (pp2.id !== pp.id) { fails++; console.log('FAIL second player not matched'); } else passes++;
  const list = await api.publicPots(C1.token);
  has('publicPots', list, { pots: 'array', playersLive: 'number', liveCents: 'number' });
  const row = list.pots.find((p) => p.id === pp.id);
  has('publicPots.pots[]', row, { id: 'string', name: 'string', goalType: 'string', goalText: 'string', potCents: 'number', stakeCents: 'number', durationDays: 'number', memberCount: 'number', maxMembers: 'number', startsAt: 'string', joined: 'boolean' });
  const det = await api.pot(C1.token, pp.id);
  has('pot(public).pot', det.pot, { isPublic: 'boolean', startsAt: 'string', status: 'string', memberCount: 'number', maxMembers: 'number' });
  const C3 = await api.signup('Ed', 'pw1234', 'ed@t.test'); await api.checkout(C3.token, 2000);
  const jp = await api.joinPublic(C3.token, pp.id); has('joinPublic', jp, { id: 'string' });
  const lb = await api.leaderboard(C1.token);
  has('leaderboard', lb, { top: 'array', windowDays: 'number' });
  const me2 = await api.me(C1.token);
  has('me.stats', me2.stats, { played: 'number', wins: 'number', netCents: 'number' });
  const lg = await api.login('cy', 'pw1234');
  has('login', lg, { token: 'string', userId: 'string', name: 'string' });
  try { await api.login('Cy', 'wrong'); fails++; console.log('FAIL bad login accepted'); } catch (e) { if (e.message === 'bad_login') passes++; else { fails++; console.log('FAIL login error', e.message); } }
  try { await api.signup('cy', 'pw1234', 'cy2@t.test'); fails++; console.log('FAIL duplicate name accepted'); } catch (e) { if (e.message === 'name_taken') passes++; else { fails++; console.log('FAIL dup error', e.message); } }
  for (const code of ['rate_limited', 'public_auto', 'server_error', 'bad_login', 'name_taken', 'bad_password', 'bad_name', 'cash_disabled', 'not_available_here', 'account_locked', 'self_excluded', 'deposit_limit', 'payouts_not_set_up', 'funds_on_hold', 'payment_provider_error', 'not_configured', 'bad_email', 'email_taken', 'wrong_code', 'too_many_attempts', 'verify_email', 'email_not_configured', 'send_failed']) { if (errMsg({ message: code }) === 'Something went wrong. Try again.') { fails++; console.log('FAIL no message for', code); } else passes++; }
}

// error codes the UI maps must actually be what the server sends
const probes = [
  ['insufficient_funds', () => api.createPot(A.token, { name: 'Huge', goalText: 'yes yes', durationDays: 7, stakeCents: 10000 })],
  ['bad_code', () => api.joinPot(A.token, 'NOPE00')],
  ['already_joined', () => api.joinPot(B.token, created.joinCode)],
  ['not_open', () => api.joinPot(B.token, created.joinCode)],
  ['unauthorized', () => api.me('sk_bogus')],
  ['cash_disabled', () => api.checkout(A.token, 1000, 'cash')],
  ['cash_disabled', () => api.payoutSetup(A.token)],
];
for (const [want, fn] of probes) { try { await fn(); fails++; console.log('FAIL expected error for', want); } catch (e) { const known = errMsg(e) !== 'Something went wrong. Try again.'; if (known) passes++; else { fails++; console.log(`FAIL error "${e.message}" has no friendly message (wanted ${want})`); } } }
console.log(`\ncontract: ${passes} passed, ${fails} failed`); process.exit(fails ? 1 : 0);
