// The first-run seed script, driven against the real Worker.   usage: bun test/seed.mjs
import { Database } from 'bun:sqlite';
import { readFileSync } from 'fs';
import worker from '../src/index.js';
import { seed } from '../../scripts/seed.mjs';

const sqlite = new Database(':memory:');
sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
const DB = { prepare(sql) { let a = []; const st = sqlite.prepare(sql); const o = { bind(...x) { a = x; return o; }, first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }), run: async () => ({ meta: { changes: st.run(...a).changes } }), _exec() { return { meta: { changes: st.run(...a).changes } }; } }; return o; },
  async batch(s) { sqlite.exec('BEGIN'); try { const r = s.map((x) => x._exec()); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } } };
// same settings as wrangler.toml, rate limits ON like real life
const env = { DB, PLAY_BONUS_CENTS: '5000', ADMIN_SECRET: 'x', RAKE_BPS: '1000', BLOCKED_STATES: '', RATE_LIMIT: 'on' };
globalThis.fetch = (url, opts) => worker.fetch(new Request(url, opts), env);

let fails = 0, passes = 0;
let emN = 0; const em = () => 'p' + ++emN + '@t.test'; // unique email per signup
const ok = (n, c, x) => { if (c) passes++; else { fails++; console.log('FAIL', n, x ?? ''); } };

const n = await seed('https://api.test', () => {});
ok('seeds 5 players', n === 5, n);
ok('five bot accounts exist', sqlite.query('SELECT COUNT(*) c FROM users').get().c === 5);
const pots = sqlite.query('SELECT goal_type, duration_days, stake_cents, status, (SELECT COUNT(*) FROM members m WHERE m.pot_id = pots.id) AS n FROM pots WHERE is_public = 1 ORDER BY goal_type').all();
ok('three public pots: move $10 (2), quit $25 (1), sleep $5 (2)', pots.length === 3 && pots.every((p) => p.status === 'open') && JSON.stringify(pots.map((p) => [p.goal_type, p.stake_cents, p.n])) === JSON.stringify([['move', 1000, 2], ['quit', 2500, 1], ['sleep', 500, 2]]), pots);
ok('running it again changes nothing', (await seed('https://api.test', () => {})) === 0 && sqlite.query('SELECT COUNT(*) c FROM users').get().c === 5);

// a brand-new person on their first run: sign up, get $50, tap Play anyone, land with the bots
const call = async (p, o = {}) => (await globalThis.fetch('https://api.test' + p, { method: o.method || 'GET', headers: { 'content-type': 'application/json', ...(o.token ? { authorization: 'Bearer ' + o.token } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined })).json();
const me = await call('/api/signup', { method: 'POST', body: { name: 'You', password: 'mypass', adult: true, email: em() } });
ok('first-run signup works with just name + password', !!me.token, me);
ok('and starts with $50', (await call('/api/wallet', { token: me.token })).balanceCents === 5000);
const play = await call('/api/public/play', { method: 'POST', token: me.token, body: { goalType: 'move', durationDays: 7, stakeCents: 1000 } });
const detail = await call('/api/pots/' + play.id, { token: me.token });
ok('Play anyone drops you into the bots\' pot', play.created === false && detail.pot.memberCount === 3 && detail.members.map((m) => m.name).sort().join() === 'Jay,Mia,You', detail.members);
ok('stake taken from the $50', (await call('/api/wallet', { token: me.token })).balanceCents === 4000);
console.log(`seed: ${passes} passed, ${fails} failed`); process.exit(fails ? 1 : 0);
