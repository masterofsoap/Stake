// Dev-only test: runs the Worker against SQLite (via bun) standing in for D1.   usage: bun test/run.mjs
import { Database } from 'bun:sqlite';
import { readFileSync } from 'fs';
import worker, { verifyStripeSignature } from '../src/index.js';
import { analyze, settle, addDays, allowedMisses } from '../src/rules.js';

let fails = 0, passes = 0;
const ok = (name, cond, extra) => { if (cond) passes++; else { fails++; console.log('FAIL ' + name, extra !== undefined ? JSON.stringify(extra) : ''); } };
const today = new Date().toISOString().slice(0, 10);

/* ============ 1. pure rules ============ */
const mkPot = (o = {}) => ({ start_date: addDays(today, -20), duration_days: 14, strict: 0, stake_cents: 1000, ...o });
const mem = (n) => Array.from({ length: n }, (_, i) => ({ user_id: 'u' + i }));
const full = (potO, members, missesBy) => { // checks for every day except the listed misses per user
  const pot = mkPot(potO); const checks = [];
  members.forEach((m, mi) => { for (let d = 0; d < pot.duration_days; d++) if (d >= (missesBy[mi] || 0)) checks.push({ user_id: m.user_id, date: addDays(pot.start_date, d) }); });
  return { pot, checks };
};
{
  // standard case: 3 members, 1 loser, 10% rake
  const members = mem(3); const { pot, checks } = full({}, members, [0, 0, 5]);
  const prog = analyze(pot, members, checks, [], today);
  const r = settle(pot, members, prog, 1000);
  ok('std: 2 winners 1 loser', r.winners === 2 && r.losers === 1, r);
  ok('std: rake 100', r.rake_cents === 100, r);
  ok('std: winners get 1450', r.entries.length === 2 && r.entries.every((e) => e.amount_cents === 1450 && e.type === 'payout'), r.entries);
  // nobody loses
  const p2 = analyze(pot, members, full({}, members, [0, 0, 0]).checks, [], today);
  const r2 = settle(pot, members, p2, 1000);
  ok('no losers: everyone refunded, no rake', r2.rake_cents === 0 && r2.entries.every((e) => e.type === 'refund' && e.amount_cents === 1000), r2);
  // nobody wins
  const p3 = analyze(pot, members, [], [], today);
  const r3 = settle(pot, members, p3, 1000);
  ok('no winners: 90% back, house keeps 10%', r3.entries.every((e) => e.amount_cents === 900) && r3.rake_cents === 300, r3);
  // allowed misses boundary (14 days -> 2)
  ok('allowed misses 14d = 2, 30d = 6, 7d = 1, strict = 0', allowedMisses({ duration_days: 14 }) === 2 && allowedMisses({ duration_days: 30 }) === 6 && allowedMisses({ duration_days: 7 }) === 1 && allowedMisses({ duration_days: 14, strict: 1 }) === 0);
  const pb = analyze(pot, members, full({}, members, [2, 3, 0]).checks, [], today);
  const rb = settle(pot, members, pb, 1000);
  ok('exactly 2 misses still wins, 3 misses loses', rb.winners === 2 && rb.losers === 1);
  const ps = analyze({ ...pot, strict: 1 }, members, full({ strict: 1 }, members, [1, 0, 0]).checks, [], today);
  ok('strict: 1 miss loses', settle({ ...pot, strict: 1 }, members, ps, 1000).losers === 1);
  // leftover cents go to earliest joiners
  const m3 = mem(6); const pot3 = mkPot({ stake_cents: 1001 });
  const pr = analyze(pot3, m3, full({ stake_cents: 1001 }, m3, [0, 0, 0, 9, 9, 9]).checks, [], today);
  const rr = settle(pot3, m3, pr, 1000);
  const forfeits = 1001 * 3, rake = Math.floor(forfeits / 10), pool = forfeits - rake;
  ok('remainder cents distributed deterministically', rr.entries.reduce((a, e) => a + e.amount_cents, 0) + rr.rake_cents === 1001 * 6 && rr.entries[0].amount_cents >= rr.entries[2].amount_cents && pool % 3 !== undefined, rr);
}
{ // disputes: majority of the OTHER members needed
  const m5 = mem(5); const pot = mkPot();
  const checks = m5.flatMap((m) => Array.from({ length: 14 }, (_, d) => ({ user_id: m.user_id, date: addDays(pot.start_date, d) })));
  const day = addDays(pot.start_date, 3);
  const dis = (n) => Array.from({ length: n }, (_, i) => ({ claimant_id: 'u0', date: day, disputer_id: 'u' + (i + 1) }));
  const st = (n) => analyze(pot, m5, checks, dis(n), today)['u0'].days[3].status;
  ok('5 members: 2 disputes keep the day, 3 throw it out', st(2) === 'done' && st(3) === 'disputed', [st(2), st(3)]);
  const m2 = mem(2); const c2 = m2.flatMap((m) => Array.from({ length: 14 }, (_, d) => ({ user_id: m.user_id, date: addDays(pot.start_date, d) })));
  ok('2 members: one dispute throws it out', analyze(pot, m2, c2, [{ claimant_id: 'u0', date: day, disputer_id: 'u1' }], today)['u0'].days[3].status === 'disputed');
}
{ // FUZZ: conservation to the cent, no negatives, winners never lose money
  let bad = 0;
  for (let i = 0; i < 5000; i++) {
    const n = 2 + Math.floor(Math.random() * 12), stake = 500 + Math.floor(Math.random() * 9500), bps = Math.floor(Math.random() * 3001);
    const dur = [7, 14, 30][Math.floor(Math.random() * 3)], strict = Math.random() < 0.3 ? 1 : 0;
    const members = mem(n); const pot = { start_date: addDays(today, -40), duration_days: dur, strict, stake_cents: stake };
    const checks = [];
    members.forEach((m) => { const miss = Math.floor(Math.random() * (dur + 1)); for (let d = 0; d < dur; d++) if (Math.random() > miss / dur) checks.push({ user_id: m.user_id, date: addDays(pot.start_date, d) }); });
    const prog = analyze(pot, members, checks, [], today);
    const r = settle(pot, members, prog, bps);
    const paid = r.entries.reduce((a, e) => a + e.amount_cents, 0);
    if (paid + r.rake_cents !== stake * n || r.entries.some((e) => e.amount_cents < 0) || r.rake_cents < 0 || (r.losers > 0 && r.winners > 0 && r.entries.some((e) => e.amount_cents < stake))) { bad++; if (bad < 3) console.log('fuzz counterexample', { n, stake, bps, dur, strict, r }); }
  }
  ok('fuzz: 5000 random pots conserve every cent', bad === 0, bad);
}

/* ============ 2. API against SQLite ============ */
function freshEnv(extra = {}) {
  const sqlite = new Database(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const DB = {
    prepare(sql) {
      let args = []; const st = sqlite.prepare(sql);
      const o = { bind(...a) { args = a; return o; }, first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }),
        run: async () => { const r = st.run(...args); return { meta: { changes: r.changes } }; }, _exec() { const r = st.run(...args); return { meta: { changes: r.changes } }; } };
      return o;
    },
    async batch(stmts) { sqlite.exec('BEGIN'); try { const out = stmts.map((s) => s._exec()); sqlite.exec('COMMIT'); return out; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } },
  };
  return { sqlite, env: { DB, DEMO_MODE: 'true', ADMIN_SECRET: 'adm', RAKE_BPS: '1000', BLOCKED_STATES: 'AZ', RATE_LIMIT: 'off', ...extra } };
}
const mkCall = (env) => async (method, path, { token, body, headers, raw } = {}) => {
  const r = await worker.fetch(new Request('https://api.test' + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...(headers || {}) }, body: raw !== undefined ? raw : body ? JSON.stringify(body) : undefined }), env);
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
};

{ // ---- accounts + wallet
  const { sqlite, env } = freshEnv(); const call = mkCall(env);
  let r = await call('POST', '/api/signup', { body: { name: 'Kid', state: 'CO', adult: false } }); ok('signup needs 18+', r.status === 403, r);
  r = await call('POST', '/api/signup', { body: { name: 'Al', state: 'AZ', password: 'pw1234', adult: true } }); ok('blocked state refused', r.status === 403 && r.data.error === 'not_available_in_state', r);
  r = await call('POST', '/api/signup', { body: { name: 'A', state: 'CO', password: 'pw1234', adult: true } }); ok('short name refused', r.status === 400, r);
  r = await call('POST', '/api/signup', { body: { name: 'Alex', state: 'CO', password: 'pw1234', adult: true } }); ok('signup ok', r.status === 200 && r.data.token.startsWith('sk_'), r);
  const A = r.data;
  r = await call('GET', '/api/me'); ok('me needs auth', r.status === 401);
  r = await call('POST', '/api/wallet/checkout', { token: A.token, body: { amountCents: 100 } }); ok('top-up min enforced', r.status === 400, r);
  r = await call('POST', '/api/wallet/checkout', { token: A.token, body: { amountCents: 5000 } }); ok('demo top-up credits', r.status === 200 && r.data.balanceCents === 5000, r);
  r = await call('POST', '/api/wallet/withdraw', { token: A.token, body: { amountCents: 6000 } }); ok('cannot withdraw more than balance', r.status === 402, r);
  r = await call('POST', '/api/wallet/withdraw', { token: A.token, body: { amountCents: 2000 } }); ok('withdraw request ok, balance drops', r.status === 200 && r.data.balanceCents === 3000, r);
  const wid = r.data.id;
  r = await call('GET', '/api/admin/withdrawals'); ok('admin list needs secret', r.status === 401);
  r = await call('GET', '/api/admin/withdrawals', { headers: { 'x-admin-secret': 'adm' } }); ok('admin sees pending', r.data.pending.length === 1 && r.data.pending[0].amount_cents === 2000, r);
  r = await call('POST', '/api/admin/withdrawals/' + wid, { headers: { 'x-admin-secret': 'adm' }, body: { status: 'rejected' } }); ok('reject ok', r.status === 200, r);
  r = await call('GET', '/api/wallet', { token: A.token }); ok('rejected withdrawal is reversed', r.data.balanceCents === 5000, r.data.balanceCents);
  r = await call('POST', '/api/admin/withdrawals/' + wid, { headers: { 'x-admin-secret': 'adm' }, body: { status: 'rejected' } }); ok('cannot resolve twice (no double refund)', r.status === 409, r);
  r = await call('GET', '/api/wallet', { token: A.token }); ok('balance unchanged after second resolve', r.data.balanceCents === 5000, r.data.balanceCents);
}

{ // ---- Stripe path (DEMO_MODE off)
  const { sqlite, env } = freshEnv({ DEMO_MODE: 'false', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test' }); const call = mkCall(env);
  const A = (await call('POST', '/api/signup', { body: { name: 'Alex', state: 'CO', password: 'pw1234', adult: true } })).data;
  let seen = null; const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => { seen = { url, o }; return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.test/c/1' }), { status: 200 }); };
  let r = await call('POST', '/api/wallet/checkout', { token: A.token, body: { amountCents: 2500 } });
  globalThis.fetch = realFetch;
  const sent = new URLSearchParams(seen.o.body);
  ok('checkout returns Stripe url', r.status === 200 && r.data.url === 'https://checkout.stripe.test/c/1', r);
  ok('checkout request: amount, user, auth', seen.url === 'https://api.stripe.com/v1/checkout/sessions' && sent.get('line_items[0][price_data][unit_amount]') === '2500' && sent.get('client_reference_id') === A.userId && seen.o.headers.authorization === 'Bearer sk_test_x', [...sent.entries()]);
  const sign = async (raw, t = Math.floor(Date.now() / 1000), secret = 'whsec_test') => {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `t=${t},v1=${mac}`;
  };
  const evt = (o = {}) => JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_1', payment_status: 'paid', amount_total: 2500, client_reference_id: A.userId, ...o } } });
  let raw = evt();
  r = await call('POST', '/api/stripe/webhook', { raw, headers: { 'stripe-signature': 'bogus' } }); ok('webhook: bad signature rejected', r.status === 400, r);
  r = await call('POST', '/api/stripe/webhook', { raw, headers: { 'stripe-signature': await sign(raw, Math.floor(Date.now() / 1000) - 3600) } }); ok('webhook: stale timestamp rejected', r.status === 400, r);
  r = await call('POST', '/api/stripe/webhook', { raw, headers: { 'stripe-signature': await sign(raw, undefined, 'wrong_secret') } }); ok('webhook: wrong secret rejected', r.status === 400, r);
  r = await call('POST', '/api/stripe/webhook', { raw, headers: { 'stripe-signature': await sign(raw) } }); ok('webhook: valid accepted', r.status === 200, r);
  r = await call('POST', '/api/stripe/webhook', { raw, headers: { 'stripe-signature': await sign(raw) } });
  r = await call('GET', '/api/wallet', { token: A.token }); ok('webhook: credited exactly once despite duplicate delivery', r.data.balanceCents === 2500, r.data.balanceCents);
  raw = evt({ id: 'cs_2', payment_status: 'unpaid' });
  await call('POST', '/api/stripe/webhook', { raw, headers: { 'stripe-signature': await sign(raw) } });
  raw = evt({ id: 'cs_3', client_reference_id: 'u_nobody' });
  await call('POST', '/api/stripe/webhook', { raw, headers: { 'stripe-signature': await sign(raw) } });
  r = await call('GET', '/api/wallet', { token: A.token }); ok('webhook: unpaid or unknown-user events credit nothing', r.data.balanceCents === 2500, r.data.balanceCents);
  ok('verifyStripeSignature rejects empty header/secret', !(await verifyStripeSignature('x', '', 's')) && !(await verifyStripeSignature('x', 't=1,v1=a', '')));
  // with no Stripe key and demo off
  const e2 = freshEnv({ DEMO_MODE: 'false' }); const c2 = mkCall(e2.env);
  const B = (await c2('POST', '/api/signup', { body: { name: 'Bo', state: 'CO', password: 'pw1234', adult: true } })).data;
  r = await c2('POST', '/api/wallet/checkout', { token: B.token, body: { amountCents: 2500 } }); ok('no processor configured -> 503, never free money', r.status === 503, r);
}

{ // ---- pots end to end
  const { sqlite, env } = freshEnv(); const call = mkCall(env);
  const users = {};
  for (const n of ['Ann', 'Ben', 'Cy', 'Dee']) { users[n] = (await call('POST', '/api/signup', { body: { name: n, state: 'CO', password: 'pw1234', adult: true } })).data; await call('POST', '/api/wallet/checkout', { token: users[n].token, body: { amountCents: 5000 } }); }
  const bal = async (n) => (await call('GET', '/api/wallet', { token: users[n].token })).data.balanceCents;
  let r = await call('POST', '/api/pots', { token: users.Ann.token, body: { name: 'No Vape Gang', goalType: 'quit', goalText: 'Zero vapes today', durationDays: 7, stakeCents: 2000, maxMembers: 3 } });
  ok('create pot', r.status === 200 && r.data.joinCode.length === 6, r);
  const P = r.data; ok('creator stake deducted', (await bal('Ann')) === 3000);
  r = await call('POST', '/api/pots', { token: users.Ann.token, body: { name: 'x', goalText: 'y', durationDays: 5, stakeCents: 2000 } }); ok('bad duration rejected', r.status === 400);
  r = await call('POST', '/api/pots', { token: users.Ann.token, body: { name: 'Big', goalText: 'yes yes', durationDays: 7, stakeCents: 20000 } }); ok('stake above $100 rejected', r.status === 400);
  r = await call('POST', '/api/pots', { token: users.Ann.token, body: { name: 'Poor', goalText: 'yes yes', durationDays: 7, stakeCents: 9000 } }); ok('cannot create pot you cannot afford (and no pot left behind)', r.status === 402 && sqlite.query('select count(*) c from pots').get().c === 1, r);
  r = await call('GET', '/api/join/' + P.joinCode.toLowerCase()); ok('join preview works, case-insensitive', r.status === 200 && r.data.stakeCents === 2000 && r.data.creator === 'Ann', r);
  r = await call('GET', '/j/' + P.joinCode); ok('join page renders code', r.status === 200 && r.data.includes(P.joinCode) && r.data.includes('Ann invited you'));
  r = await call('POST', '/api/pots/start'.replace('start', 'g_zz') , { token: users.Ann.token }); // route sanity (should 404)
  r = await call('POST', `/api/pots/${P.id}/start`, { token: users.Ann.token }); ok('cannot start alone', r.status === 409 && r.data.error === 'need_two_members', r);
  for (const n of ['Ben', 'Cy']) { r = await call('POST', '/api/pots/join', { token: users[n].token, body: { code: P.joinCode } }); ok('join ' + n, r.status === 200, r); }
  r = await call('POST', '/api/pots/join', { token: users.Dee.token, body: { code: P.joinCode } }); ok('pot full', r.status === 409 && r.data.error === 'full', r);
  ok('Dee was not charged for the full pot', (await bal('Dee')) === 5000);
  r = await call('POST', '/api/pots/join', { token: users.Ben.token, body: { code: P.joinCode } }); ok('cannot join twice', r.status === 409, r);
  ok('Ben charged once', (await bal('Ben')) === 3000);
  r = await call('POST', '/api/pots/join', { token: users.Dee.token, body: { code: 'ZZZZZZ' } }); ok('bad code 404', r.status === 404);
  r = await call('POST', `/api/pots/${P.id}/checkin`, { token: users.Ann.token, body: {} }); ok('no check-in before start', r.status === 409, r);
  r = await call('POST', `/api/pots/${P.id}/start`, { token: users.Ben.token }); ok('only creator starts', r.status === 403, r);
  r = await call('POST', `/api/pots/${P.id}/start`, { token: users.Ann.token }); ok('start ok', r.status === 200 && r.data.startDate === today, r);
  r = await call('POST', `/api/pots/${P.id}/leave`, { token: users.Ben.token }); ok('cannot leave after start', r.status === 409, r);
  r = await call('POST', `/api/pots/${P.id}/cancel`, { token: users.Ann.token }); ok('cannot cancel after start', r.status === 409, r);
  r = await call('POST', `/api/pots/${P.id}/checkin`, { token: users.Dee.token, body: {} }); ok('non-member cannot check in', r.status === 404, r);
  r = await call('POST', `/api/pots/${P.id}/checkin`, { token: users.Ann.token, body: { date: addDays(today, -5) } }); ok('cannot backdate a check-in', r.status === 400, r);
  r = await call('POST', `/api/pots/${P.id}/checkin`, { token: users.Ann.token, body: { note: 'day 1' } }); ok('check-in ok', r.status === 200, r);
  r = await call('POST', `/api/pots/${P.id}/checkin`, { token: users.Ann.token, body: { note: 'again' } }); ok('check-in idempotent per day', sqlite.query('select count(*) c from checkins where user_id=?').get(users.Ann.userId).c === 1);
  r = await call('POST', `/api/pots/${P.id}/checkin`, { token: users.Cy.token, body: {} });
  // disputes: 3 members -> need 2 of the other 2
  r = await call('POST', `/api/pots/${P.id}/dispute`, { token: users.Ann.token, body: { userId: users.Ann.userId, date: today } }); ok('cannot dispute yourself', r.status === 400, r);
  r = await call('POST', `/api/pots/${P.id}/dispute`, { token: users.Ben.token, body: { userId: users.Cy.userId, date: today } }); ok('one dispute ok', r.status === 200, r);
  r = await call('GET', `/api/pots/${P.id}`, { token: users.Ann.token }); let cy = r.data.members.find((m) => m.name === 'Cy');
  ok('1 of 2 disputes: day still counts', cy.days[0].status === 'done', cy.days[0]);
  r = await call('POST', `/api/pots/${P.id}/dispute`, { token: users.Ann.token, body: { userId: users.Cy.userId, date: today } });
  r = await call('GET', `/api/pots/${P.id}`, { token: users.Ann.token }); cy = r.data.members.find((m) => m.name === 'Cy');
  ok('2 of 2 disputes: day thrown out', cy.days[0].status === 'disputed' && cy.valid === 0, cy.days[0]);
  ok('detail has grid + pot totals', r.data.pot.potCents === 6000 && r.data.members.length === 3 && r.data.members[0].days.length === 7, r.data.pot);
  r = await call('GET', `/api/pots/${P.id}`, { token: users.Dee.token }); ok('outsiders cannot see a pot', r.status === 404);

  // ---- fast-forward: pretend the pot ran its full week in the past, then fill in check-ins
  sqlite.run("UPDATE pots SET start_date=?, end_date=? WHERE id=?", [addDays(today, -8), addDays(today, -2), P.id]);
  sqlite.run('DELETE FROM checkins'); sqlite.run('DELETE FROM disputes');
  const ins = (uid, d) => sqlite.run('INSERT INTO checkins (pot_id,user_id,date,created_at) VALUES (?,?,?,?)', [P.id, uid, addDays(today, -8 + d), 'x']);
  for (let d = 0; d < 7; d++) ins(users.Ann.userId, d);            // perfect
  for (let d = 0; d < 6; d++) ins(users.Ben.userId, d);            // 1 miss, allowed (7d -> 1)
  for (let d = 0; d < 4; d++) ins(users.Cy.userId, d);             // 3 misses -> loses
  const before = { Ann: await bal('Ann'), Ben: await bal('Ben'), Cy: await bal('Cy') };
  r = await call('GET', '/api/me', { token: users.Ann.token });
  const after = { Ann: await bal('Ann'), Ben: await bal('Ben'), Cy: await bal('Cy') };
  // forfeits 2000, rake 200, pool 1800 -> 900 each + stake back 2000
  ok('settled: winners paid stake + 900', after.Ann - before.Ann === 2900 && after.Ben - before.Ben === 2900, [before, after]);
  ok('settled: loser gets nothing back', after.Cy === before.Cy, [before, after]);
  const potRow = sqlite.query('select * from pots where id=?').get(P.id);
  ok('pot marked settled with rake 200', potRow.status === 'settled' && potRow.rake_cents === 200, potRow);
  const net = sqlite.query("select coalesce(sum(amount_cents),0) s from ledger where pot_id=?").get(P.id).s;
  ok('per-pot ledger nets to minus the rake (no cent created or lost)', net === -200, net);
  await call('GET', '/api/me', { token: users.Ben.token }); await call('GET', `/api/pots/${P.id}`, { token: users.Cy.token });
  const after2 = { Ann: await bal('Ann'), Ben: await bal('Ben'), Cy: await bal('Cy') };
  ok('settlement is idempotent', JSON.stringify(after2) === JSON.stringify(after), [after, after2]);
  r = await call('GET', `/api/pots/${P.id}`, { token: users.Cy.token });
  ok('results visible after settlement', r.data.results && r.data.results.length === 2 && r.data.pot.status === 'settled', r.data.results);
  r = await call('POST', `/api/pots/${P.id}/checkin`, { token: users.Ann.token, body: {} }); ok('no check-ins after settlement', r.status === 409);

  // ---- cancel + leave refunds
  const b0 = await bal('Dee');
  r = await call('POST', '/api/pots', { token: users.Dee.token, body: { name: 'Sleep', goalType: 'sleep', goalText: 'In bed by 11', durationDays: 14, stakeCents: 1500 } }); const Q = r.data;
  await call('POST', '/api/pots/join', { token: users.Ben.token, body: { code: Q.joinCode } });
  ok('stakes held', (await bal('Dee')) === b0 - 1500);
  r = await call('POST', `/api/pots/${Q.id}/leave`, { token: users.Dee.token }); ok('creator cannot leave', r.status === 409);
  const bb = await bal('Ben'); r = await call('POST', `/api/pots/${Q.id}/leave`, { token: users.Ben.token }); ok('member leaves, refunded', r.status === 200 && (await bal('Ben')) === bb + 1500);
  await call('POST', '/api/pots/join', { token: users.Cy.token, body: { code: Q.joinCode } });
  const cb = await bal('Cy');
  r = await call('POST', `/api/pots/${Q.id}/cancel`, { token: users.Dee.token }); ok('cancel ok', r.status === 200);
  ok('cancel refunds everyone exactly once', (await bal('Dee')) === b0 && (await bal('Cy')) === cb + 1500);
  r = await call('POST', `/api/pots/${Q.id}/cancel`, { token: users.Dee.token }); ok('cannot cancel twice', r.status === 409);
  ok('still conserved after cancel', (await bal('Dee')) === b0);

  // ---- nobody wins + nobody loses settle paths through the API
  const mk = async (name, stake, names) => {
    const c = (await call('POST', '/api/pots', { token: users[names[0]].token, body: { name, goalText: 'do the thing', durationDays: 7, stakeCents: stake } })).data;
    for (const n of names.slice(1)) await call('POST', '/api/pots/join', { token: users[n].token, body: { code: c.joinCode } });
    await call('POST', `/api/pots/${c.id}/start`, { token: users[names[0]].token });
    sqlite.run('UPDATE pots SET start_date=?, end_date=? WHERE id=?', [addDays(today, -8), addDays(today, -2), c.id]);
    return c;
  };
  const W = await mk('Wipeout', 1000, ['Ann', 'Ben']);
  const a1 = await bal('Ann'); await call('GET', '/api/me', { token: users.Ann.token });
  ok('nobody checked in: 90% refunded', (await bal('Ann')) === a1 + 900 && sqlite.query('select rake_cents r from pots where id=?').get(W.id).r === 200);
  const G = await mk('Allgood', 1000, ['Ann', 'Ben']);
  for (const n of ['Ann', 'Ben']) for (let d = 0; d < 7; d++) sqlite.run('INSERT INTO checkins (pot_id,user_id,date,created_at) VALUES (?,?,?,?)', [G.id, users[n].userId, addDays(today, -8 + d), 'x']);
  const a2 = await bal('Ann'); await call('GET', '/api/me', { token: users.Ann.token });
  ok('everyone wins: full refund, no rake', (await bal('Ann')) === a2 + 1000 && sqlite.query('select rake_cents r from pots where id=?').get(G.id).r === 0);
}

{ // ---- overdraw race: one balance, two pots, simultaneous joins
  const { sqlite, env } = freshEnv(); const call = mkCall(env);
  const mkU = async (n) => (await call('POST', '/api/signup', { body: { name: n, state: 'CO', password: 'pw1234', adult: true } })).data;
  const host = await mkU('Host'), pal = await mkU('Pal');
  await call('POST', '/api/wallet/checkout', { token: host.token, body: { amountCents: 10000 } });
  await call('POST', '/api/wallet/checkout', { token: pal.token, body: { amountCents: 1000 } });
  const p1 = (await call('POST', '/api/pots', { token: host.token, body: { name: 'One', goalText: 'goal one', durationDays: 7, stakeCents: 1000 } })).data;
  const p2 = (await call('POST', '/api/pots', { token: host.token, body: { name: 'Two', goalText: 'goal two', durationDays: 7, stakeCents: 1000 } })).data;
  const rs = await Promise.all([call('POST', '/api/pots/join', { token: pal.token, body: { code: p1.joinCode } }), call('POST', '/api/pots/join', { token: pal.token, body: { code: p2.joinCode } })]);
  const bal = (await call('GET', '/api/wallet', { token: pal.token })).data.balanceCents;
  ok('double-tap join cannot overdraw: exactly one succeeds, balance 0', rs.filter((x) => x.status === 200).length === 1 && bal === 0, { statuses: rs.map((x) => x.status), bal });
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
