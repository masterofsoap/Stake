// Dev-only test: runs the Worker against SQLite (via bun) standing in for D1.   usage: bun test/run.mjs
import { Database } from 'bun:sqlite';
import { readFileSync } from 'fs';
import worker, { verifyStripeSignature, normEmail } from '../src/index.js';
import { analyze, settle, addDays, allowedMisses } from '../src/rules.js';

let fails = 0, passes = 0;
const ok = (name, cond, extra) => { if (cond) passes++; else { fails++; console.log('FAIL ' + name, extra !== undefined ? JSON.stringify(extra) : ''); } };
const today = new Date().toISOString().slice(0, 10);
let emN = 0; const em = () => 'p' + ++emN + '@t.test'; // unique email per signup
const sha = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, '0')).join('');

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
  // new accounts count as verified (real money needs that) unless a test wants to walk the code flow itself
  const __verify = extra.noAutoVerify ? null : (id) => sqlite.run('UPDATE users SET email_verified = 1 WHERE id = ?', [id]);
  return { sqlite, env: { __verify, DB, ADMIN_SECRET: 'adm', RAKE_BPS: '1000', BLOCKED_STATES: 'AZ', RATE_LIMIT: 'off', ...extra } };
}
// cf = Cloudflare's geo for the connection, e.g. { country: 'US', regionCode: 'CO' }
const mkCall = (env) => async (method, path, { token, body, headers, raw, cf } = {}) => {
  const req = new Request('https://api.test' + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...(headers || {}) }, body: raw !== undefined ? raw : body ? JSON.stringify(body) : undefined });
  if (cf) Object.defineProperty(req, 'cf', { value: cf });
  const r = await worker.fetch(req, env);
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (path === '/api/signup' && r.status === 200 && env.__verify) env.__verify(data.userId);
  return { status: r.status, data };
};

{ // ---- accounts + play wallet
  const { sqlite, env } = freshEnv(); const call = mkCall(env);
  let r = await call('POST', '/api/signup', { body: { name: 'Kid', state: 'CO', adult: false } }); ok('signup needs 18+', r.status === 403, r);
  r = await call('POST', '/api/signup', { body: { name: 'Al', state: 'AZ', password: 'pw1234', adult: true, email: em() } }); ok('any state can sign up and play for play money', r.status === 200, r);
  r = await call('POST', '/api/signup', { body: { name: 'A', state: 'CO', password: 'pw1234', adult: true, email: em() } }); ok('short name refused', r.status === 400, r);
  r = await call('POST', '/api/signup', { body: { name: 'Alex', state: 'CO', password: 'pw1234', adult: true, email: em() } }); ok('signup ok', r.status === 200 && r.data.token.startsWith('sk_'), r);
  const A = r.data;
  r = await call('GET', '/api/me'); ok('me needs auth', r.status === 401);
  r = await call('POST', '/api/wallet/checkout', { token: A.token, body: { amountCents: 100 } }); ok('top-up min enforced', r.status === 400, r);
  r = await call('POST', '/api/wallet/checkout', { token: A.token, body: { amountCents: 5000 } }); ok('play top-up credits', r.status === 200 && r.data.balanceCents === 5000, r);
  r = await call('POST', '/api/wallet/checkout', { token: A.token, body: { amountCents: 5000, currency: 'cash' } }); ok('cash off: no cash top-ups', r.status === 403 && r.data.error === 'cash_disabled', r);
  r = await call('POST', '/api/wallet/withdraw', { token: A.token, body: { amountCents: 2000 } }); ok('play money can never be withdrawn', r.status === 403 && r.data.error === 'cash_disabled', r);
  r = await call('GET', '/api/me', { token: A.token }); ok('me: play balance, zero cash, cash disabled', r.data.balanceCents === 5000 && r.data.cashCents === 0 && r.data.cash.enabled === false, r.data);
  r = await call('POST', '/api/pots', { token: A.token, body: { name: 'Cashy', goalText: 'do it', durationDays: 7, stakeCents: 1000, currency: 'cash' } });
  ok('cash off: no cash pots, none left behind', r.status === 403 && sqlite.query('select count(*) c from pots').get().c === 0, r);
  r = await call('GET', '/api/admin/withdrawals'); ok('admin list needs secret', r.status === 401);
}

// ---- real money: Stripe mocked, geofence on, Cloudflare geo passed as req.cf
const US_CO = { country: 'US', regionCode: 'CO' };
const sign = async (raw, t = Math.floor(Date.now() / 1000), secret = 'whsec_test') => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `t=${t},v1=${mac}`;
};
// fake Stripe: records calls, answers by path
function fakeStripe(over = {}) {
  const calls = [];
  const answer = {
    'POST /v1/checkout/sessions': () => ({ id: 'cs_x', url: 'https://checkout.stripe.test/c/1' }),
    'POST /v1/accounts': () => ({ id: 'acct_1', payouts_enabled: false }),
    'GET /v1/accounts/acct_1': () => ({ id: 'acct_1', payouts_enabled: false }),
    'POST /v1/account_links': () => ({ url: 'https://connect.stripe.test/onboard' }),
    'POST /v1/transfers': () => ({ id: 'tr_' + calls.length }),
    ...over,
  };
  const real = globalThis.fetch;
  globalThis.fetch = async (url, o = {}) => {
    const key = `${o.method || 'GET'} ${new URL(url).pathname}`;
    calls.push({ key, body: new URLSearchParams(o.body || ''), headers: o.headers || {} });
    const fn = answer[key];
    if (!fn) return new Response('{}', { status: 404 });
    const out = fn(calls[calls.length - 1]);
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200 });
  };
  return { calls, restore: () => (globalThis.fetch = real) };
}
const cashEnv = (extra = {}) => freshEnv({ CASH: 'on', GEOFENCE: 'on', BLOCKED_STATES: 'AZ', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_connect', ...extra });
const hook = async (call, type, object, secret) => {
  const raw = JSON.stringify({ type, data: { object } });
  return call('POST', '/api/stripe/webhook', { raw, headers: { 'stripe-signature': await sign(raw, undefined, secret) } });
};
const paid = (call, userId, id, amount, pi = 'pi_' + id) => hook(call, 'checkout.session.completed', { id, payment_status: 'paid', amount_total: amount, currency: 'usd', client_reference_id: userId, payment_intent: pi });

{ // ---- deposits + webhook
  const { sqlite, env } = cashEnv(); const call = mkCall(env);
  const A = (await call('POST', '/api/signup', { body: { name: 'Alex', password: 'pw1234', adult: true, email: em() } })).data;
  const fs = fakeStripe();
  let r = await call('POST', '/api/wallet/checkout', { token: A.token, body: { amountCents: 2500, currency: 'cash' }, cf: US_CO });
  fs.restore();
  const sent = fs.calls[0];
  ok('checkout returns Stripe url', r.status === 200 && r.data.url === 'https://checkout.stripe.test/c/1', r);
  ok('checkout request: amount, user, auth', sent.key === 'POST /v1/checkout/sessions' && sent.body.get('line_items[0][price_data][unit_amount]') === '2500' && sent.body.get('client_reference_id') === A.userId && sent.headers.authorization === 'Bearer sk_test_x', [...sent.body.entries()]);
  r = await call('POST', '/api/wallet/checkout', { token: A.token, body: { amountCents: 2500, currency: 'cash' }, cf: { country: 'US', regionCode: 'AZ' } });
  ok('geofence: blocked state cannot deposit', r.status === 403 && r.data.error === 'not_available_here', r);
  r = await call('POST', '/api/wallet/checkout', { token: A.token, body: { amountCents: 2500, currency: 'cash' }, cf: { country: 'CA', regionCode: 'ON' } });
  ok('geofence: outside the US cannot deposit', r.status === 403 && r.data.error === 'not_available_here', r);
  r = await call('POST', '/api/wallet/checkout', { token: A.token, body: { amountCents: 2500, currency: 'cash' } });
  ok('geofence: unknown location cannot deposit', r.status === 403 && r.data.error === 'not_available_here', r);
  r = await call('GET', '/api/me', { token: A.token, cf: { country: 'US', regionCode: 'AZ' } });
  ok('me tells the app why cash is blocked', r.data.cash.enabled === true && r.data.cash.blocked === 'not_available_here', r.data.cash);

  const raw = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_1', payment_status: 'paid', amount_total: 2500, currency: 'usd', client_reference_id: A.userId, payment_intent: 'pi_1' } } });
  r = await call('POST', '/api/stripe/webhook', { raw, headers: { 'stripe-signature': 'bogus' } }); ok('webhook: bad signature rejected', r.status === 400, r);
  r = await call('POST', '/api/stripe/webhook', { raw, headers: { 'stripe-signature': await sign(raw, Math.floor(Date.now() / 1000) - 3600) } }); ok('webhook: stale timestamp rejected', r.status === 400, r);
  r = await call('POST', '/api/stripe/webhook', { raw, headers: { 'stripe-signature': await sign(raw, undefined, 'wrong_secret') } }); ok('webhook: wrong secret rejected', r.status === 400, r);
  r = await call('POST', '/api/stripe/webhook', { raw, headers: { 'stripe-signature': await sign(raw) } }); ok('webhook: valid accepted', r.status === 200, r);
  r = await call('POST', '/api/stripe/webhook', { raw, headers: { 'stripe-signature': await sign(raw) } });
  r = await call('GET', '/api/wallet?currency=cash', { token: A.token }); ok('webhook: credited to CASH exactly once despite duplicate delivery', r.data.balanceCents === 2500, r.data.balanceCents);
  r = await call('GET', '/api/wallet', { token: A.token }); ok('play wallet untouched by a card payment', r.data.balanceCents === 0, r.data.balanceCents);
  await hook(call, 'checkout.session.completed', { id: 'cs_3', payment_status: 'unpaid', amount_total: 2500, currency: 'usd', client_reference_id: A.userId });
  await hook(call, 'checkout.session.completed', { id: 'cs_4', payment_status: 'paid', amount_total: 2500, currency: 'usd', client_reference_id: 'u_nobody' });
  await hook(call, 'checkout.session.completed', { id: 'cs_5', payment_status: 'paid', amount_total: 2500, currency: 'eur', client_reference_id: A.userId });
  r = await call('GET', '/api/wallet?currency=cash', { token: A.token }); ok('webhook: unpaid, unknown-user and non-USD events credit nothing', r.data.balanceCents === 2500, r.data.balanceCents);
  ok('verifyStripeSignature rejects empty header/secret', !(await verifyStripeSignature('x', '', 's')) && !(await verifyStripeSignature('x', 't=1,v1=a', '')));

  // daily deposit cap counts what already landed
  const capped = cashEnv({ DEPOSIT_DAILY_CAP_CENTS: '3000' }); const cc = mkCall(capped.env);
  const B = (await cc('POST', '/api/signup', { body: { name: 'Bo', password: 'pw1234', adult: true, email: em() } })).data;
  await paid(cc, B.userId, 'cs_b1', 2000);
  r = await cc('POST', '/api/wallet/checkout', { token: B.token, body: { amountCents: 1500, currency: 'cash' }, cf: US_CO }); ok('daily deposit cap enforced', r.status === 403 && r.data.error === 'deposit_limit', r);

  const e2 = freshEnv({ CASH: 'on', GEOFENCE: 'off' }); const c2 = mkCall(e2.env);
  const C = (await c2('POST', '/api/signup', { body: { name: 'Cy', password: 'pw1234', adult: true, email: em() } })).data;
  r = await c2('POST', '/api/wallet/checkout', { token: C.token, body: { amountCents: 2500, currency: 'cash' } }); ok('no Stripe key -> 503, never free cash', r.status === 503, r);
}

{ // ---- play and cash never mix
  const { sqlite, env } = cashEnv({ PLAY_BONUS_CENTS: '5000' }); const call = mkCall(env);
  const mk = async (n) => (await call('POST', '/api/signup', { body: { name: n, password: 'pw1234', adult: true, email: em() } })).data;
  const A = await mk('Ann'), B = await mk('Ben');
  await paid(call, A.userId, 'cs_a', 3000);
  let r = await call('POST', '/api/pots', { token: B.token, body: { name: 'Cashy', goalText: 'do it', durationDays: 7, stakeCents: 1000, currency: 'cash' }, cf: US_CO });
  ok('play bonus cannot fund a cash pot', r.status === 402 && r.data.error === 'insufficient_funds', r);
  r = await call('POST', '/api/pots', { token: A.token, body: { name: 'Cashy', goalText: 'do it', durationDays: 7, stakeCents: 1000, currency: 'cash' }, cf: US_CO });
  ok('cash pot created from cash', r.status === 200, r);
  const P = r.data;
  const bal = async (u, c) => (await call('GET', '/api/wallet?currency=' + c, { token: u.token })).data.balanceCents;
  ok('cash stake from cash wallet, play untouched', (await bal(A, 'cash')) === 2000 && (await bal(A, 'play')) === 5000);
  r = await call('GET', '/api/join/' + P.joinCode); ok('preview says cash', r.data.currency === 'cash', r.data);
  r = await call('GET', '/j/' + P.joinCode); ok('invite page says real money', r.data.includes('real-money'));
  r = await call('POST', '/api/pots/join', { token: B.token, body: { code: P.joinCode }, cf: { country: 'US', regionCode: 'AZ' } });
  ok('geofence applies to joining a friend\'s cash pot', r.status === 403 && r.data.error === 'not_available_here', r);
  await paid(call, B.userId, 'cs_b', 1000);
  r = await call('POST', '/api/pots/join', { token: B.token, body: { code: P.joinCode }, cf: US_CO }); ok('join cash pot', r.status === 200, r);
  await call('POST', `/api/pots/${P.id}/start`, { token: A.token });
  sqlite.run('UPDATE pots SET start_date=?, end_date=? WHERE id=?', [addDays(today, -8), addDays(today, -2), P.id]);
  for (let d = 0; d < 7; d++) sqlite.run('INSERT INTO checkins (pot_id,user_id,date,created_at) VALUES (?,?,?,?)', [P.id, A.userId, addDays(today, -8 + d), 'x']);
  await call('GET', '/api/me', { token: A.token });
  ok('cash pot pays out in cash (2000 left + 1000 stake back + 900 winnings)', (await bal(A, 'cash')) === 3900 && (await bal(A, 'play')) === 5000, [await bal(A, 'cash'), await bal(A, 'play')]);
  ok('nothing in any pot leaks into play', sqlite.query("select count(*) c from ledger where pot_id=? and currency<>'cash'").get(P.id).c === 0);

  // public matchmaking keeps cash and play lobbies apart
  const q = await call('POST', '/api/public/play', { token: A.token, body: { goalType: 'move', durationDays: 7, stakeCents: 1000, currency: 'cash' }, cf: US_CO });
  const p = await call('POST', '/api/public/play', { token: B.token, body: { goalType: 'move', durationDays: 7, stakeCents: 1000 }, cf: US_CO });
  ok('same goal/stake: play player not dropped into the cash lobby', q.data.created === true && p.data.created === true && q.data.id !== p.data.id, [q.data, p.data]);
  r = await call('GET', '/api/public?currency=cash', { token: B.token }); ok('browse cash shows only cash pots', r.data.pots.length === 1 && r.data.pots[0].currency === 'cash', r.data.pots);
  r = await call('GET', '/api/public', { token: B.token }); ok('browse defaults to play', r.data.pots.every((x) => x.currency === 'play'), r.data.pots);
  r = await call('POST', '/api/public/play', { token: B.token, body: { goalType: 'move', durationDays: 7, stakeCents: 1000, currency: 'cash' }, cf: { country: 'GB' } });
  ok('public cash play is geofenced too', r.status === 403 && r.data.error === 'not_available_here', r);
}

{ // ---- payouts: Connect onboarding, hold, auto transfer, review queue, admin
  const { sqlite, env } = cashEnv({ WITHDRAW_HOLD_HOURS: '72', WITHDRAW_AUTO_MAX_CENTS: '5000' }); const call = mkCall(env);
  const A = (await call('POST', '/api/signup', { body: { name: 'Ann', password: 'pw1234', adult: true, email: em() } })).data;
  await paid(call, A.userId, 'cs_1', 20000);
  let r = await call('POST', '/api/wallet/withdraw', { token: A.token, body: { amountCents: 2000 } });
  ok('no payout account yet', r.status === 409 && r.data.error === 'payouts_not_set_up', r);
  let fs = fakeStripe();
  r = await call('POST', '/api/payouts/setup', { token: A.token });
  fs.restore();
  ok('setup creates an Express account and returns onboarding link', r.status === 200 && r.data.url === 'https://connect.stripe.test/onboard' && fs.calls[0].key === 'POST /v1/accounts' && fs.calls[0].body.get('type') === 'express' && fs.calls[0].headers['idempotency-key'] === 'acct:' + A.userId, fs.calls.map((c) => c.key));
  ok('account id stored', sqlite.query('select stripe_account_id a from users where id=?').get(A.userId).a === 'acct_1');
  fs = fakeStripe();
  await call('POST', '/api/payouts/setup', { token: A.token });
  fs.restore();
  ok('second setup reuses the account', !fs.calls.some((c) => c.key === 'POST /v1/accounts'), fs.calls.map((c) => c.key));
  r = await hook(call, 'account.updated', { id: 'acct_1', payouts_enabled: true }, 'whsec_connect');
  ok('Connect webhook (own secret) marks payouts ready', r.status === 200 && sqlite.query('select payouts_enabled p from users where id=?').get(A.userId).p === 1);

  r = await call('POST', '/api/wallet/withdraw', { token: A.token, body: { amountCents: 2000 } });
  ok('fresh card deposit is on hold', r.status === 402 && r.data.error === 'funds_on_hold', r);
  r = await call('GET', '/api/wallet?currency=cash', { token: A.token }); ok('wallet shows 0 withdrawable during hold', r.data.balanceCents === 20000 && r.data.withdrawableCents === 0, r.data);
  sqlite.run("UPDATE ledger SET created_at = '2020-01-01T00:00:00Z' WHERE ref = 'stripe:cs_1'");
  r = await call('GET', '/api/wallet?currency=cash', { token: A.token }); ok('after the hold it is withdrawable', r.data.withdrawableCents === 20000, r.data);

  fs = fakeStripe();
  r = await call('POST', '/api/wallet/withdraw', { token: A.token, body: { amountCents: 3000 } });
  fs.restore();
  const tr = fs.calls.find((c) => c.key === 'POST /v1/transfers');
  ok('small cash-out is transferred right away', r.status === 200 && r.data.status === 'paid' && r.data.balanceCents === 17000, r);
  ok('transfer: amount, destination, idempotency key = withdrawal id', tr && tr.body.get('amount') === '3000' && tr.body.get('destination') === 'acct_1' && tr.headers['idempotency-key'] === 'wd:' + r.data.id, tr && [...tr.body.entries()]);

  fs = fakeStripe();
  r = await call('POST', '/api/wallet/withdraw', { token: A.token, body: { amountCents: 9000 } });
  fs.restore();
  const big = r.data.id;
  ok('big cash-out waits for review, no transfer yet', r.data.status === 'pending' && !fs.calls.length, r);
  r = await call('GET', '/api/admin/withdrawals', { headers: { 'x-admin-secret': 'adm' } });
  ok('admin sees it with the reason', r.data.pending.length === 1 && r.data.pending[0].note === 'over auto-approve limit', r.data);
  fs = fakeStripe({ 'POST /v1/transfers': () => new Response(JSON.stringify({ error: { message: 'insufficient platform balance' } }), { status: 400 }) });
  r = await call('POST', '/api/admin/withdrawals/' + big, { headers: { 'x-admin-secret': 'adm' }, body: { status: 'approve' } });
  fs.restore();
  ok('failed transfer stays pending with the Stripe error', r.status === 502 && sqlite.query('select status, note from withdrawals where id=?').get(big).note.includes('insufficient platform balance'), r);
  fs = fakeStripe();
  r = await call('POST', '/api/admin/withdrawals/' + big, { headers: { 'x-admin-secret': 'adm' }, body: { status: 'approve' } });
  fs.restore();
  ok('approve retries with the same idempotency key and pays', r.status === 200 && fs.calls[0].headers['idempotency-key'] === 'wd:' + big && sqlite.query('select status from withdrawals where id=?').get(big).status === 'paid', r);
  r = await call('POST', '/api/admin/withdrawals/' + big, { headers: { 'x-admin-secret': 'adm' }, body: { status: 'rejected' } }); ok('cannot reject a paid withdrawal', r.status === 409, r);

  r = await call('POST', '/api/wallet/withdraw', { token: A.token, body: { amountCents: 6000 } });
  const rej = r.data.id;
  r = await call('POST', '/api/admin/withdrawals/' + rej, { headers: { 'x-admin-secret': 'adm' }, body: { status: 'rejected' } }); ok('reject ok', r.status === 200, r);
  r = await call('GET', '/api/wallet?currency=cash', { token: A.token }); ok('rejected withdrawal is reversed', r.data.balanceCents === 8000, r.data.balanceCents);
  r = await call('POST', '/api/admin/withdrawals/' + rej, { headers: { 'x-admin-secret': 'adm' }, body: { status: 'rejected' } }); ok('cannot resolve twice (no double refund)', r.status === 409, r);
  r = await call('POST', '/api/wallet/withdraw', { token: A.token, body: { amountCents: 9000 } }); ok('cannot withdraw more than balance', r.status === 402 && r.data.error === 'insufficient_funds', r);
  r = await call('GET', '/api/admin/summary', { headers: { 'x-admin-secret': 'adm' } });
  ok('admin summary reconciles', r.data.depositsCents === 20000 && r.data.paidOutCents === 12000 && r.data.walletsCents === 8000, r.data);

  // manual mode: no Connect needed, everything queues
  const m = freshEnv({ CASH: 'on', GEOFENCE: 'off', PAYOUTS: 'manual', WITHDRAW_HOLD_HOURS: '0' }); const mc = mkCall(m.env);
  const B = (await mc('POST', '/api/signup', { body: { name: 'Bo', password: 'pw1234', adult: true, email: em() } })).data;
  m.sqlite.run("INSERT INTO ledger (user_id,type,amount_cents,currency,ref,created_at) VALUES (?, 'deposit', 5000, 'cash', 'x', '2020-01-01')", [B.userId]);
  r = await mc('POST', '/api/wallet/withdraw', { token: B.token, body: { amountCents: 2000 } }); ok('manual payouts: request queues', r.status === 200 && r.data.status === 'pending', r);
  r = await mc('POST', '/api/admin/withdrawals/' + r.data.id, { headers: { 'x-admin-secret': 'adm' }, body: { status: 'paid' } }); ok('manual payouts: mark paid', r.status === 200, r);
}

{ // ---- chargebacks + self-exclusion
  const { sqlite, env } = cashEnv({ WITHDRAW_HOLD_HOURS: '0', PAYOUTS: 'manual' }); const call = mkCall(env);
  const A = (await call('POST', '/api/signup', { body: { name: 'Ann', password: 'pw1234', adult: true, email: em() } })).data;
  await paid(call, A.userId, 'cs_1', 5000, 'pi_A');
  await call('POST', '/api/wallet/withdraw', { token: A.token, body: { amountCents: 4000 } });
  let r = await hook(call, 'charge.dispute.created', { id: 'dp_1', payment_intent: 'pi_A', amount: 5000 });
  await hook(call, 'charge.dispute.created', { id: 'dp_1', payment_intent: 'pi_A', amount: 5000 });
  r = await call('GET', '/api/wallet?currency=cash', { token: A.token });
  ok('chargeback debits once, balance can go negative', r.data.balanceCents === -4000, r.data.balanceCents);
  ok('chargeback locks the account', r.data.cash.blocked === 'account_locked');
  r = await call('POST', '/api/wallet/withdraw', { token: A.token, body: { amountCents: 1000 } }); ok('locked: no cash-outs', r.status === 403 && r.data.error === 'account_locked', r);
  r = await call('POST', '/api/wallet/checkout', { token: A.token, body: { amountCents: 1000, currency: 'cash' }, cf: US_CO }); ok('locked: no deposits', r.data.error === 'account_locked', r);
  r = await call('POST', '/api/wallet/checkout', { token: A.token, body: { amountCents: 1000 } }); ok('locked: play money still works', r.status === 200, r);
  r = await call('POST', `/api/admin/users/${A.userId}/unlock`, { headers: { 'x-admin-secret': 'adm' } }); ok('admin can unlock', r.status === 200 && sqlite.query('select cash_locked l from users where id=?').get(A.userId).l === 0);

  r = await call('POST', '/api/me/exclude', { token: A.token, body: { days: 30 } }); ok('self-exclusion set', r.status === 200 && r.data.excludedUntil > new Date().toISOString(), r);
  const until = r.data.excludedUntil;
  r = await call('POST', '/api/me/exclude', { token: A.token, body: { days: 1 } }); ok('self-exclusion cannot be shortened', r.data.excludedUntil === until, r.data);
  r = await call('POST', '/api/wallet/checkout', { token: A.token, body: { amountCents: 1000, currency: 'cash' }, cf: US_CO }); ok('excluded: no cash deposits', r.data.error === 'self_excluded', r);
  r = await call('POST', '/api/public/play', { token: A.token, body: { goalType: 'move', durationDays: 7, stakeCents: 500, currency: 'cash' }, cf: US_CO }); ok('excluded: no cash pots', r.data.error === 'self_excluded', r);
  r = await call('POST', '/api/me/exclude', { token: A.token, body: { days: 0 } }); ok('bad exclusion length refused', r.status === 400);
}

{ // ---- email: signup, login, confirmation codes, password reset
  ok('normEmail: trimmed + lowercased, junk refused',
    normEmail(' Ann@Mail.COM ') === 'ann@mail.com' && normEmail('ann@') === null && normEmail('5551234567') === null && normEmail('a b@c.com') === null && normEmail('') === null && normEmail('x@y.co.uk') === 'x@y.co.uk');
  const { sqlite, env } = freshEnv({ noAutoVerify: true, CASH: 'on', GEOFENCE: 'off', DEV_CODES: 'on' }); const call = mkCall(env);
  let r = await call('POST', '/api/signup', { body: { name: 'Nina', password: 'pw1234', adult: true } }); ok('signup needs an email', r.status === 400 && r.data.error === 'bad_email', r);
  r = await call('POST', '/api/signup', { body: { name: 'Nina', password: 'pw1234', adult: true, email: '5551234567' } }); ok('phone numbers are not emails', r.data.error === 'bad_email', r);
  r = await call('POST', '/api/signup', { body: { name: 'Nina', password: 'pw1234', adult: true, email: 'Nina@Mail.com' } }); ok('signup with email', r.status === 200, r);
  const N = r.data;
  r = await call('POST', '/api/signup', { body: { name: 'Other', password: 'pw1234', adult: true, email: 'nina@mail.com ' } }); ok('same email, other case: taken', r.status === 409 && r.data.error === 'email_taken', r);
  r = await call('POST', '/api/signup', { body: { name: 'Olly', password: 'pw1234', adult: true, email: 'olly@mail.com' } }); const O = r.data;
  ok('stored lowercased', sqlite.query('select email from users where id=?').get(N.userId).email === 'nina@mail.com');
  r = await call('POST', '/api/login', { body: { name: 'NINA@mail.com', password: 'pw1234' } }); ok('log in with email', r.status === 200 && r.data.userId === N.userId, r);
  r = await call('POST', '/api/login', { body: { name: 'nina', password: 'pw1234' } }); ok('log in with name still works', r.status === 200, r);
  r = await call('GET', '/api/me', { token: N.token }); ok('me shows email, unconfirmed', r.data.user.email === 'nina@mail.com' && r.data.user.emailVerified === false, r.data.user);
  ok('real money needs a confirmed email', r.data.cash.blocked === 'verify_email', r.data.cash);
  r = await call('POST', '/api/wallet/checkout', { token: N.token, body: { amountCents: 1000, currency: 'cash' } }); ok('unconfirmed: no cash deposit', r.data.error === 'verify_email', r);

  r = await call('POST', '/api/email/send', { token: N.token }); ok('send code (dev mode returns it)', r.status === 200 && /^\d{6}$/.test(r.data.devCode), r);
  const code = r.data.devCode;
  ok('code stored hashed', !JSON.stringify(sqlite.query('select * from email_codes').all()).includes(code));
  r = await call('POST', '/api/email/verify', { token: N.token, body: { code: code === '123456' ? '654321' : '123456' } }); ok('wrong code refused', r.status === 400 && r.data.error === 'wrong_code', r);
  r = await call('POST', '/api/email/verify', { token: O.token, body: { code } }); ok("someone else's code doesn't confirm you", r.status === 400, r);
  r = await call('POST', '/api/email/verify', { token: N.token, body: { code } }); ok('right code confirms', r.status === 200, r);
  r = await call('POST', '/api/email/verify', { token: N.token, body: { code } }); ok('code is single-use', r.status === 400, r);
  r = await call('GET', '/api/me', { token: N.token }); ok('confirmed: cash no longer blocked', r.data.user.emailVerified === true && r.data.cash.blocked === null, r.data);
  r = await call('POST', '/api/email/send', { token: N.token }); ok('already confirmed: no new code', r.data.verified === true && !r.data.devCode, r);
  const c2 = (await call('POST', '/api/email/send', { token: O.token })).data.devCode;
  for (let i = 0; i < 5; i++) await call('POST', '/api/email/verify', { token: O.token, body: { code: String((Number(c2) + 1 + i) % 1000000).padStart(6, '0') } });
  r = await call('POST', '/api/email/verify', { token: O.token, body: { code: c2 } }); ok('5 wrong guesses burn the code', r.data.error === 'too_many_attempts', r);
  const c3 = (await call('POST', '/api/email/send', { token: O.token })).data.devCode;
  sqlite.run("UPDATE email_codes SET expires_at = '2020-01-01'");
  r = await call('POST', '/api/email/verify', { token: O.token, body: { code: c3 } }); ok('expired code refused', r.data.error === 'wrong_code', r);

  r = await call('POST', '/api/email/send', { token: O.token, body: { email: 'NINA@mail.com' } }); ok("can't take someone else's email", r.status === 409 && r.data.error === 'email_taken', r);
  r = await call('POST', '/api/email/send', { token: N.token, body: { email: 'nina@new.com' } }); ok('changing email sends a code', r.status === 200 && r.data.email === 'nina@new.com' && r.data.devCode, r);
  r = await call('GET', '/api/me', { token: N.token }); ok('new email is unconfirmed again', r.data.user.email === 'nina@new.com' && !r.data.user.emailVerified && r.data.cash.blocked === 'verify_email', r.data.user);
  sqlite.run("INSERT INTO users (id, username, pw_salt, pw_hash, name, created_at) VALUES ('u_0ld', 'oldie', '00', '00', 'Oldie', 'x')");
  sqlite.run("INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, 'u_0ld', 'x')", [await sha('sk_old')]);
  r = await call('GET', '/api/me', { token: 'sk_old' }); ok('old account: no email yet', r.status === 200 && r.data.user.email === null, r.data);
  r = await call('POST', '/api/email/send', { token: 'sk_old' }); ok('old account: send without an email refused', r.data.error === 'bad_email', r);
  r = await call('POST', '/api/email/send', { token: 'sk_old', body: { email: 'oldie@mail.com' } }); ok('old account: adds one', r.status === 200 && r.data.devCode, r);

  r = await call('POST', '/api/password/forgot', { body: { email: 'nobody@mail.com' } }); ok('forgot: unknown email looks the same (no code)', r.status === 200 && !r.data.devCode, r);
  r = await call('POST', '/api/password/forgot', { body: { email: 'nina@mail.com' } }); ok("forgot: Nina's old email no longer works", !r.data.devCode, r);
  r = await call('POST', '/api/password/forgot', { body: { email: 'olly@mail.com' } }); ok('forgot: known email gets a code', r.status === 200 && r.data.devCode, r);
  const rc = r.data.devCode;
  const vc = (await call('POST', '/api/email/send', { token: O.token })).data.devCode;
  r = await call('POST', '/api/password/reset', { body: { email: 'olly@mail.com', code: vc, password: 'newpass1' } }); ok("a confirm code can't reset a password", r.status === 400, r);
  r = await call('POST', '/api/password/reset', { body: { email: 'olly@mail.com', code: rc, password: 'ab' } }); ok('reset: short password refused', r.data.error === 'bad_password', r);
  r = await call('POST', '/api/password/reset', { body: { email: 'Olly@mail.com', code: rc, password: 'newpass1' } }); ok('reset ok, signed in', r.status === 200 && r.data.userId === O.userId && r.data.token, r);
  ok('reset signs out other devices', (await call('GET', '/api/me', { token: O.token })).status === 401);
  ok('reset counts as confirming the email', sqlite.query('select email_verified v from users where id=?').get(O.userId).v === 1);
  ok('old password dead, new one works', (await call('POST', '/api/login', { body: { name: 'olly', password: 'pw1234' } })).status === 401 && (await call('POST', '/api/login', { body: { name: 'olly', password: 'newpass1' } })).status === 200);
  r = await call('POST', '/api/password/reset', { body: { email: 'olly@mail.com', code: rc, password: 'again123' } }); ok('reset code is single-use', r.status === 400, r);
  r = await call('POST', '/api/logout', { token: N.token }); ok('logout', r.status === 200 && (await call('GET', '/api/me', { token: N.token })).status === 401);
}

{ // ---- sending: Cloudflare Email Service binding (env.EMAIL), from gostake.app
  const sent = [];
  const EMAIL = { send: async (m) => { sent.push(m); return { messageId: 'm' + sent.length }; } };
  const { env } = freshEnv({ noAutoVerify: true, EMAIL, EMAIL_FROM: 'hello@gostake.app' }); const call = mkCall(env);
  const E = (await call('POST', '/api/signup', { body: { name: 'Em', password: 'pw1234', adult: true, email: 'em@mail.com' } })).data;
  const r = await call('POST', '/api/email/send', { token: E.token });
  const m = sent[0] || {};
  const code = ((m.text || '').match(/\d{6}/) || [])[0];
  ok('email goes out via the binding, from Go Stake at gostake.app', m.to === 'em@mail.com' && m.from.email === 'hello@gostake.app' && m.from.name === 'Go Stake', m);
  ok('subject, text and branded HTML all carry the code; the API never returns it', code && m.subject.startsWith(code) && m.subject.includes('Go Stake') && m.html.includes(code) && m.html.includes('GO STAKE') && !r.data.devCode, [m.subject, r.data]);
  ok('and that code works', (await call('POST', '/api/email/verify', { token: E.token, body: { code } })).status === 200);
  const fp = await call('POST', '/api/password/forgot', { body: { email: 'em@mail.com' } });
  ok('reset email says reset', fp.status === 200 && sent[1] && /reset your password/.test(sent[1].text), sent[1] && sent[1].text);
  EMAIL.send = async () => { throw Object.assign(new Error('nope'), { code: 'E_DELIVERY_FAILED' }); };
  const bad = await call('POST', '/api/email/send', { token: E.token, body: { email: 'em2@mail.com' } });
  ok('delivery failure -> send_failed', bad.status === 502 && bad.data.error === 'send_failed', bad);
  EMAIL.send = async () => { throw Object.assign(new Error('slow'), { code: 'E_RATE_LIMIT_EXCEEDED' }); };
  const rl = await call('POST', '/api/email/send', { token: E.token });
  ok('Cloudflare rate limit -> rate_limited', rl.status === 429 && rl.data.error === 'rate_limited', rl);
  const none = freshEnv({ noAutoVerify: true }); const nc = mkCall(none.env);
  const Z = (await nc('POST', '/api/signup', { body: { name: 'Zo', password: 'pw1234', adult: true, email: 'zo@mail.com' } })).data;
  const z = await nc('POST', '/api/email/send', { token: Z.token });
  ok('no binding and no DEV_CODES: refuse, never leak the code', z.status === 503 && z.data.error === 'email_not_configured' && !z.data.devCode, z);
  const dv = freshEnv({ noAutoVerify: true, EMAIL, DEV_CODES: 'on' }); const dc = mkCall(dv.env);
  const n0 = sent.length;
  const D = (await dc('POST', '/api/signup', { body: { name: 'Dee', password: 'pw1234', adult: true, email: 'dee@mail.com' } })).data;
  const d = await dc('POST', '/api/email/send', { token: D.token });
  ok('DEV_CODES on: shown in the app, nothing actually emailed', d.data.devCode && sent.length === n0, d);
}

{ // ---- pots end to end
  const { sqlite, env } = freshEnv(); const call = mkCall(env);
  const users = {};
  for (const n of ['Ann', 'Ben', 'Cy', 'Dee']) { users[n] = (await call('POST', '/api/signup', { body: { name: n, state: 'CO', password: 'pw1234', adult: true, email: em() } })).data; await call('POST', '/api/wallet/checkout', { token: users[n].token, body: { amountCents: 5000 } }); }
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
  const mkU = async (n) => (await call('POST', '/api/signup', { body: { name: n, state: 'CO', password: 'pw1234', adult: true, email: em() } })).data;
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
