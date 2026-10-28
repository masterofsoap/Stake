// Public pots, leaderboard, recovery, rate limits.   usage: bun test/public.mjs
import { Database } from 'bun:sqlite';
import { readFileSync } from 'fs';
import worker, { settleDue } from '../src/index.js';
import { addDays } from '../src/rules.js';

let fails = 0, passes = 0;
const ok = (name, cond, extra) => { if (cond) passes++; else { fails++; console.log('FAIL ' + name, extra !== undefined ? JSON.stringify(extra) : ''); } };
const today = new Date().toISOString().slice(0, 10);

function fresh(extra = {}) {
  const sqlite = new Database(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const DB = { prepare(sql) { let a = []; const st = sqlite.prepare(sql); const o = { bind(...x) { a = x; return o; }, first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }), run: async () => ({ meta: { changes: st.run(...a).changes } }), _exec() { return { meta: { changes: st.run(...a).changes } }; } }; return o; },
    async batch(s) { sqlite.exec('BEGIN'); try { const r = s.map((x) => x._exec()); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } } };
  const env = { DB, DEMO_MODE: 'true', ADMIN_SECRET: 'adm', RAKE_BPS: '1000', BLOCKED_STATES: '', RATE_LIMIT: 'off', ...extra };
  const call = async (method, path, { token, body, headers } = {}) => {
    const r = await worker.fetch(new Request('https://api.test' + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined }), env);
    let data = null; try { data = await r.json(); } catch {}
    return { status: r.status, data };
  };
  return { sqlite, env, call };
}
let uniq = 0;
async function mkUsers(call, n, cash = 10000) {
  const us = [];
  for (let i = 0; i < n; i++) {
    const s = await call('POST', '/api/signup', { body: { name: 'P' + (uniq++), state: 'CO', password: 'pw1234', adult: true } });
    await call('POST', '/api/wallet/checkout', { token: s.data.token, body: { amountCents: cash } });
    us.push({ ...s.data, i });
  }
  return us;
}
const bal = async (call, u) => (await call('GET', '/api/wallet', { token: u.token })).data.balanceCents;
const play = (call, u, o = {}) => call('POST', '/api/public/play', { token: u.token, body: { goalType: 'move', durationDays: 7, stakeCents: 1000, ...o } });

/* ---- matchmaking ---- */
{
  const { sqlite, env, call } = fresh();
  const [a, b, c] = await mkUsers(call, 3);
  const r1 = await play(call, a);
  ok('first player opens a lobby', r1.status === 200 && r1.data.created === true, r1);
  const r2 = await play(call, b);
  ok('second player is matched into the same pot', r2.data.id === r1.data.id && r2.data.created === false, r2);
  const r2b = await play(call, b);
  ok('same player quick-matching again opens a different lobby', r2b.status === 200 && r2b.data.id !== r1.data.id && r2b.data.created === true, r2b);
  const r3 = await play(call, c, { stakeCents: 2500 });
  ok('different stake never matches', r3.data.id !== r1.data.id && r3.data.created === true);
  ok('stake was charged', (await bal(call, a)) === 9000 && (await bal(call, c)) === 7500);

  const list = await call('GET', '/api/public', { token: c.token });
  const row = list.data.pots.find((p) => p.id === r1.data.id);
  ok('browse lists the lobby with 2 players and the pot size', row && row.memberCount === 2 && row.potCents === 2000 && row.joined === false && row.isPublic === true, row);
  ok('browse never leaks join codes or creator ids', row && row.joinCode === undefined && row.creatorId === undefined);
  ok('browse sorts fullest first', list.data.pots[0].memberCount >= list.data.pots[list.data.pots.length - 1].memberCount);
  const filtered = await call('GET', '/api/public?goalType=sleep', { token: c.token });
  ok('browse filters by goal', filtered.data.pots.length === 0);

  // join by id from browse
  const [d] = await mkUsers(call, 1);
  const j = await call('POST', `/api/pots/${r1.data.id}/join`, { token: d.token });
  ok('join from browse', j.status === 200 && (await bal(call, d)) === 9000, j);
  ok('join twice rejected, no double charge', (await call('POST', `/api/pots/${r1.data.id}/join`, { token: d.token })).status === 409 && (await bal(call, d)) === 9000);
  // private pots can't be joined by id
  const priv = await call('POST', '/api/pots', { token: a.token, body: { name: 'Priv', goalType: 'move', goalText: 'Run daily', durationDays: 7, stakeCents: 1000, maxMembers: 4 } });
  ok('private pot not joinable through the public route', (await call('POST', `/api/pots/${priv.data.id}/join`, { token: d.token })).status === 404);
  ok('private pot never in browse', !(await call('GET', '/api/public', { token: d.token })).data.pots.some((p) => p.id === priv.data.id));

  // validation: only server-defined goals/stakes
  ok('custom goal refused', (await play(call, a, { goalType: 'custom' })).status === 400);
  ok('odd stake refused', (await play(call, a, { stakeCents: 777 })).status === 400);
  ok('bad duration refused', (await play(call, a, { durationDays: 3 })).status === 400);
  ok('broke player refused, nothing created', await (async () => { const [e] = await mkUsers(call, 1, 500); const n0 = sqlite.query('SELECT COUNT(*) c FROM pots').get().c; const r = await play(call, e); return r.status === 402 && sqlite.query('SELECT COUNT(*) c FROM pots').get().c === n0; })());

  // manual controls are disabled on public pots
  const t = await call('POST', `/api/pots/${r1.data.id}/start`, { token: a.token });
  ok('creator cannot hand-start a public pot', t.status === 409 && t.data.error === 'public_auto');
  ok('creator cannot cancel a public pot', (await call('POST', `/api/pots/${r1.data.id}/cancel`, { token: a.token })).data.error === 'public_auto');
  const lv = await call('POST', `/api/pots/${r1.data.id}/leave`, { token: a.token });
  ok('anyone, including the opener, can leave an open public pot with a refund', lv.status === 200 && (await bal(call, a)) === 9000, [lv, await bal(call, a)]) // 10000 - private pot stake 1000; the public stake came back;
}

/* ---- auto start when full ---- */
{
  const { sqlite, call } = fresh();
  const us = await mkUsers(call, 12);
  let id;
  for (let i = 0; i < 11; i++) id = (await play(call, us[i])).data.id;
  ok('11 of 12: still open', sqlite.query('SELECT status FROM pots WHERE id = ?').get(id).status === 'open');
  const last = await play(call, us[11]);
  const p = sqlite.query('SELECT status, start_date, end_date FROM pots WHERE id = ?').get(id);
  ok('12th player fills it and it starts immediately', last.data.id === id && p.status === 'active' && p.start_date === today && p.end_date === addDays(today, 6), p);
  ok('a 13th cannot slip in', (await call('POST', `/api/pots/${id}/join`, { token: (await mkUsers(call, 1))[0].token })).status === 409);
}

/* ---- auto start on the clock, rollovers, refunds ---- */
{
  const { sqlite, env, call } = fresh();
  const [a, b, c, d] = await mkUsers(call, 4);
  const p2 = (await play(call, a)).data.id; await play(call, b);                     // 2 players
  const p1 = (await play(call, c, { goalType: 'sleep' })).data.id;                   // 1 player
  const p0 = (await play(call, d, { goalType: 'eat' })).data.id; await call('POST', `/api/pots/${p0}/leave`, { token: d.token }); // 0 players
  ok('lobbies do not start before their day', (await settleDue(env), sqlite.query("SELECT status FROM pots WHERE id = ?").get(p2).status === 'open'));
  const st = (id) => sqlite.query('SELECT status, starts_at, rollovers FROM pots WHERE id = ?').get(id);
  ok('start day is at least 12h out', st(p2).starts_at > today);
  sqlite.exec(`UPDATE pots SET starts_at = '${today}' WHERE is_public = 1`);
  await settleDue(env);
  ok('2+ players: starts on the day', st(p2).status === 'active', st(p2));
  ok('0 players: closes', st(p0).status === 'cancelled', st(p0));
  ok('1 player: pushed back a day, stays open', st(p1).status === 'open' && st(p1).starts_at === addDays(today, 1) && st(p1).rollovers === 1, st(p1));
  for (let i = 0; i < 2; i++) { sqlite.exec(`UPDATE pots SET starts_at = '${today}' WHERE id = '${p1}'`); await settleDue(env); }
  ok('rolls over three times', st(p1).rollovers === 3 && st(p1).status === 'open', st(p1));
  const before = await bal(call, c);
  sqlite.exec(`UPDATE pots SET starts_at = '${today}' WHERE id = '${p1}'`); await settleDue(env);
  ok('fourth time: refunded and closed', st(p1).status === 'cancelled' && (await bal(call, c)) === before + 1000, [st(p1), before, await bal(call, c)]);
  await settleDue(env); await settleDue(env);
  ok('refund is applied once', (await bal(call, c)) === before + 1000);
  // someone tries to join the pot that just started
  const [late] = await mkUsers(call, 1);
  const lj = await call('POST', `/api/pots/${p2}/join`, { token: late.token });
  ok('late join to an active public pot is refused and costs nothing', lj.status === 409 && (await bal(call, late)) === 10000, lj);
}


/* ---- the race: pot starts between the charge and the seat ---- */
{
  const { sqlite, env, call } = fresh();
  const [a, b, c] = await mkUsers(call, 3);
  const id = (await play(call, a)).data.id; await play(call, b);
  const realPrepare = env.DB.prepare.bind(env.DB);
  let fired = false;
  env.DB.prepare = (sql) => { if (!fired && sql.startsWith('INSERT INTO members')) { fired = true; sqlite.exec(`UPDATE pots SET status='active', start_date='${today}', end_date='${addDays(today, 6)}' WHERE id='${id}'`); } return realPrepare(sql); };
  const r = await call('POST', `/api/pots/${id}/join`, { token: c.token });
  env.DB.prepare = realPrepare;
  ok('joiner who lost the race is refused', r.status === 409 && r.data.error === 'not_open', r);
  ok('and gets the stake back', (await bal(call, c)) === 10000);
  ok('and is not a member', sqlite.query('SELECT COUNT(*) c FROM members WHERE pot_id = ? AND user_id = ?').get(id, c.userId).c === 0);
}

/* ---- settlement feeds results, stats and the leaderboard ---- */
{
  const { sqlite, env, call } = fresh();
  const us = await mkUsers(call, 4);
  let id; for (const u of us) id = (await play(call, u)).data.id;     // 4 in one pot
  sqlite.exec(`UPDATE pots SET starts_at = '${today}' WHERE id = '${id}'`); await settleDue(env);
  // move the pot into the past so it settles: 7-day pot that started 10 days ago
  sqlite.exec(`UPDATE pots SET start_date='${addDays(today, -10)}', end_date='${addDays(today, -4)}' WHERE id='${id}'`);
  // u0,u1 checked in every day, u2 half, u3 none
  const ins = sqlite.prepare('INSERT INTO checkins (pot_id, user_id, date, created_at) VALUES (?,?,?,?)');
  for (let d = 0; d < 7; d++) { ins.run(id, us[0].userId, addDays(today, -10 + d), 'x'); ins.run(id, us[1].userId, addDays(today, -10 + d), 'x'); if (d < 3) ins.run(id, us[2].userId, addDays(today, -10 + d), 'x'); }
  await settleDue(env);
  const pot = sqlite.query('SELECT status, rake_cents FROM pots WHERE id = ?').get(id);
  ok('settled', pot.status === 'settled', pot);
  // 2 losers x $10 = $20 forfeited, 10% rake = $2, $18 to two winners = $9 each: payout 19
  const b = await Promise.all(us.map((u) => bal(call, u)));
  ok('winner balance', b[0] === 9000 + 1900 && b[1] === 9000 + 1900, b);
  ok('loser balance', b[2] === 9000 && b[3] === 9000, b);
  const rows = sqlite.query('SELECT * FROM results WHERE pot_id = ? ORDER BY user_id').all(id);
  ok('one results row per member, flagged public', rows.length === 4 && rows.every((r) => r.is_public === 1));
  const net = Object.fromEntries(rows.map((r) => [r.user_id, r.net_cents]));
  ok('net_cents: +900 winners, -1000 losers', net[us[0].userId] === 900 && net[us[1].userId] === 900 && net[us[2].userId] === -1000 && net[us[3].userId] === -1000, net);
  ok('every cent accounted for (stakes = payouts + rake)', rows.reduce((a, r) => a + r.net_cents, 0) + pot.rake_cents === 0, rows);

  await settleDue(env);
  ok('settling twice adds no results', sqlite.query('SELECT COUNT(*) c FROM results').get().c === 4);

  const lb = await call('GET', '/api/leaderboard', { token: us[3].token });
  ok('leaderboard ranks winners first', lb.data.top.length === 4 && lb.data.top[0].netCents === 900 && lb.data.top[0].wins === 1 && lb.data.top[3].netCents === -1000, lb.data.top);
  ok('leaderboard exposes names only', Object.keys(lb.data.top[0]).sort().join() === 'isMe,name,netCents,played,rank,wins');
  ok('me block present with my rank', lb.data.me && lb.data.me.isMe && lb.data.me.rank >= 3, lb.data.me);
  const me = await call('GET', '/api/me', { token: us[0].token });
  ok('/me carries stats', me.data.stats.played === 1 && me.data.stats.wins === 1 && me.data.stats.netCents === 900, me.data.stats);

  // private pots count toward stats but never the global board
  const [x, y] = await mkUsers(call, 2);
  const pr = await call('POST', '/api/pots', { token: x.token, body: { name: 'Friends', goalType: 'move', goalText: 'Run daily', durationDays: 7, stakeCents: 1000, maxMembers: 3 } });
  await call('POST', '/api/pots/join', { token: y.token, body: { code: pr.data.joinCode } });
  await call('POST', `/api/pots/${pr.data.id}/start`, { token: x.token });
  sqlite.exec(`UPDATE pots SET start_date='${addDays(today, -10)}', end_date='${addDays(today, -4)}' WHERE id='${pr.data.id}'`);
  for (let d = 0; d < 7; d++) ins.run(pr.data.id, x.userId, addDays(today, -10 + d), 'x');
  await settleDue(env);
  ok('private pot settled', sqlite.query('SELECT status FROM pots WHERE id = ?').get(pr.data.id).status === 'settled');
  const lb2 = await call('GET', '/api/leaderboard', { token: x.token });
  ok('private results stay off the global leaderboard', lb2.data.top.length === 4 && lb2.data.me === null, lb2.data);
  ok('...but count in my own stats', (await call('GET', '/api/me', { token: x.token })).data.stats.played === 1);
  // 30-day window
  sqlite.exec(`UPDATE results SET settled_at = '2020-01-01T00:00:00Z'`);
  ok('old results fall off the board', (await call('GET', '/api/leaderboard', { token: us[0].token })).data.top.length === 0);
}

/* ---- login ---- */
{
  const { sqlite, call } = fresh({ DEMO_BONUS_CENTS: '5000' });
  const s1 = await call('POST', '/api/signup', { body: { name: 'Zed', password: 'hunter22', adult: true } });
  ok('signup works with just name + password + 18+', s1.status === 200 && s1.data.token && s1.data.userId, s1);
  ok('new play-money accounts start with the bonus', (await call('GET', '/api/wallet', { token: s1.data.token })).data.balanceCents === 5000);
  const dup = await call('POST', '/api/signup', { body: { name: 'zED', password: 'other1', adult: true } });
  ok('names are unique, ignoring case', dup.status === 409 && dup.data.error === 'name_taken', dup);
  ok('short password refused', (await call('POST', '/api/signup', { body: { name: 'Pip', password: 'abc', adult: true } })).data.error === 'bad_password');
  ok('password is not stored in the clear', !JSON.stringify(sqlite.query('SELECT * FROM users').all()).includes('hunter22'));
  const l = await call('POST', '/api/login', { body: { name: 'ZED', password: 'hunter22' } });
  ok('login works (name ignores case)', l.status === 200 && l.data.userId === s1.data.userId && l.data.token !== s1.data.token, l);
  ok('login does not sign out the other device', (await call('GET', '/api/me', { token: s1.data.token })).status === 200 && (await call('GET', '/api/me', { token: l.data.token })).status === 200);
  ok('same account, same money on the new device', (await call('GET', '/api/me', { token: l.data.token })).data.balanceCents === 5000);
  ok('wrong password refused', (await call('POST', '/api/login', { body: { name: 'Zed', password: 'nope' } })).status === 401);
  ok('unknown name refused the same way', (await call('POST', '/api/login', { body: { name: 'Nobody', password: 'nope' } })).data.error === 'bad_login');
  ok('empty login refused', (await call('POST', '/api/login', { body: {} })).status === 401);
  const nb = fresh(); const s2 = await nb.call('POST', '/api/signup', { body: { name: 'Kay', password: 'abcd', adult: true } });
  ok('no bonus unless configured', (await nb.call('GET', '/api/wallet', { token: s2.data.token })).data.balanceCents === 0);
}

/* ---- hardening ---- */
{
  const { call } = fresh({ RATE_LIMIT: 'on' });
  const ip = { 'cf-connecting-ip': '1.2.3.4' };
  let last;
  for (let i = 0; i < 11; i++) last = await call('POST', '/api/signup', { body: { name: 'Spam' + i, state: 'CO', password: 'pw1234', adult: true }, headers: ip });
  ok('11th signup from one IP in an hour is limited', last.status === 429, last);
  const other = await call('POST', '/api/signup', { body: { name: 'Fine', state: 'CO', password: 'pw1234', adult: true }, headers: { 'cf-connecting-ip': '5.6.7.8' } });
  ok('other IPs unaffected', other.status === 200);
  await call('POST', '/api/signup', { body: { name: 'Victim', password: 'strongpass', adult: true }, headers: { 'cf-connecting-ip': '7.7.7.7' } });
  let rl; for (let i = 0; i < 12; i++) rl = await call('POST', '/api/login', { body: { name: 'Victim', password: 'guess' + i }, headers: { 'cf-connecting-ip': '8.8.8.' + i } });
  ok('password guessing on one account is rate limited, even across IPs', rl.status === 429, rl.status);
  ok('even the right password is blocked while locked out', (await call('POST', '/api/login', { body: { name: 'Victim', password: 'strongpass' }, headers: { 'cf-connecting-ip': '8.8.9.9' } })).status === 429);
  const t = other.data.token; let pay;
  for (let i = 0; i < 12; i++) pay = await call('POST', '/api/wallet/checkout', { token: t, body: { amountCents: 500 }, headers: { 'cf-connecting-ip': '5.6.7.8' } });
  ok('top-up spam limited per user', pay.status === 429, pay.status);
  const big = await worker.fetch(new Request('https://api.test/api/signup', { method: 'POST', headers: { 'content-length': '999999', 'content-type': 'application/json' }, body: '{}' }), { DB: {}, RATE_LIMIT: 'off' });
  ok('oversized body refused', big.status === 413);
  const h = await worker.fetch(new Request('https://api.test/j/ABCDEF'), { DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } });
  ok('HTML pages carry CSP + frame deny', /default-src 'none'/.test(h.headers.get('content-security-policy')) && h.headers.get('x-frame-options') === 'DENY');
  const sn = await call('POST', '/api/signup', { body: { name: '<img onerror=x>  A\u0000B', state: 'CO', password: 'pw1234', adult: true }, headers: { 'cf-connecting-ip': '9.9.9.9' } });
  ok('names are stripped of markup and control chars', sn.data.name === 'img onerror=x AB', sn.data.name);
}

console.log(`public: ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
