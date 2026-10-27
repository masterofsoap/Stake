import { analyze, settle, addDays, daysBetween, DURATIONS, GOAL_TYPES, allowedMisses } from './rules.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type,x-admin-secret',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...CORS } });
const html = (body, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const MIN_STAKE = 500; // $5
const MAX_STAKE = 10000; // $100
const MIN_TOPUP = 500;
const MAX_TOPUP = 50000;
const MIN_WITHDRAW = 1000;

/* ---------- helpers ---------- */

const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (t) => toHex(await crypto.subtle.digest('SHA-256', enc.encode(t)));
const randHex = (n) => toHex(crypto.getRandomValues(new Uint8Array(n)));
const randCode = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
const nowIso = () => new Date().toISOString();
const utcToday = () => nowIso().slice(0, 10);
const bearer = (req) => (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
const rakeBps = (env) => Math.min(Math.max(parseInt(env.RAKE_BPS, 10) || 1000, 0), 5000);

async function readJson(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
async function userAuth(req, env) {
  const t = bearer(req);
  if (!t) return null;
  return env.DB.prepare('SELECT * FROM users WHERE token_hash = ?').bind(await sha256(t)).first();
}
async function balanceOf(env, userId) {
  const r = await env.DB.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS b FROM ledger WHERE user_id = ?').bind(userId).first();
  return r ? r.b : 0;
}
const ledgerInsert = (env, userId, type, amount, potId, ref, ts) =>
  env.DB.prepare('INSERT INTO ledger (user_id, type, amount_cents, pot_id, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
    userId, type, amount, potId, ref, ts
  );

// Deduct `amount` only if the balance covers it. One atomic statement, so two taps can never overdraw.
async function chargeIfFunded(env, userId, type, amount, potId, ref) {
  const r = await env.DB.prepare(
    `INSERT INTO ledger (user_id, type, amount_cents, pot_id, ref, created_at)
     SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COALESCE(SUM(amount_cents), 0) FROM ledger WHERE user_id = ?) >= ?`
  )
    .bind(userId, type, -amount, potId, ref, nowIso(), userId, amount)
    .run();
  return r.meta.changes === 1;
}

/* ---------- accounts ---------- */

async function signup(req, env) {
  const b = await readJson(req);
  if (!b) return json({ error: 'bad_request' }, 400);
  const name = clip(b.name, 20).trim();
  const state = clip(b.state, 2).toUpperCase();
  if (b.adult !== true) return json({ error: 'must_be_18' }, 403);
  if (name.length < 2 || !/^[A-Z]{2}$/.test(state)) return json({ error: 'bad_request' }, 400);
  const blocked = String(env.BLOCKED_STATES || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (blocked.includes(state)) return json({ error: 'not_available_in_state' }, 403);
  const id = 'u_' + randHex(6);
  const token = 'sk_' + randHex(24);
  await env.DB.prepare('INSERT INTO users (id, token_hash, name, state, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, await sha256(token), name, state, nowIso())
    .run();
  return json({ userId: id, token, name });
}

async function potSummaryRows(env, userId) {
  return (
    await env.DB.prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM members WHERE pot_id = p.id) AS member_count
       FROM pots p JOIN members m ON m.pot_id = p.id WHERE m.user_id = ? ORDER BY p.created_at DESC LIMIT 50`
    )
      .bind(userId)
      .all()
  ).results;
}
const potPublic = (p) => ({
  id: p.id,
  name: p.name,
  goalType: p.goal_type,
  goalText: p.goal_text,
  durationDays: p.duration_days,
  stakeCents: p.stake_cents,
  maxMembers: p.max_members,
  strict: !!p.strict,
  status: p.status,
  startDate: p.start_date,
  endDate: p.end_date,
  joinCode: p.join_code,
  creatorId: p.creator_id,
  memberCount: p.member_count,
  potCents: p.stake_cents * (p.member_count || 0),
  rakeCents: p.rake_cents,
});

async function me(req, env) {
  const u = await userAuth(req, env);
  if (!u) return json({ error: 'unauthorized' }, 401);
  await settleDue(env);
  const pots = await potSummaryRows(env, u.id);
  return json({ user: { id: u.id, name: u.name }, balanceCents: await balanceOf(env, u.id), demoMode: env.DEMO_MODE === 'true', pots: pots.map(potPublic) });
}

/* ---------- wallet ---------- */

async function wallet(req, env) {
  const u = await userAuth(req, env);
  if (!u) return json({ error: 'unauthorized' }, 401);
  const entries = (
    await env.DB.prepare('SELECT type, amount_cents, pot_id, created_at FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 50').bind(u.id).all()
  ).results;
  const withdrawals = (
    await env.DB.prepare('SELECT id, amount_cents, status, created_at FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 10')
      .bind(u.id)
      .all()
  ).results;
  return json({ balanceCents: await balanceOf(env, u.id), demoMode: env.DEMO_MODE === 'true', entries, withdrawals });
}

async function checkout(req, env) {
  const u = await userAuth(req, env);
  if (!u) return json({ error: 'unauthorized' }, 401);
  const b = await readJson(req);
  const amount = parseInt(b && b.amountCents, 10);
  if (!(amount >= MIN_TOPUP && amount <= MAX_TOPUP)) return json({ error: 'bad_amount' }, 400);

  if (env.DEMO_MODE === 'true') {
    await ledgerInsert(env, u.id, 'deposit', amount, null, 'demo:' + randHex(8), nowIso()).run();
    return json({ demo: true, balanceCents: await balanceOf(env, u.id) });
  }
  if (!env.STRIPE_SECRET_KEY) return json({ error: 'not_configured' }, 503);

  const origin = env.APP_URL || new URL(req.url).origin;
  const params = new URLSearchParams({
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(amount),
    'line_items[0][price_data][product_data][name]': 'Stake wallet top-up',
    client_reference_id: u.id,
    'metadata[user_id]': u.id,
    success_url: `${origin}/paid`,
    cancel_url: `${origin}/cancelled`,
  });
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) return json({ error: 'payment_provider_error' }, 502);
  const s = await res.json();
  return json({ url: s.url });
}

async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export async function verifyStripeSignature(raw, header, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!header || !secret) return false;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = (parts.find((p) => p[0] === 't') || [])[1];
  const sigs = parts.filter((p) => p[0] === 'v1').map((p) => p[1]);
  if (!t || !sigs.length || Math.abs(nowSec - parseInt(t, 10)) > 300) return false;
  const mac = await hmacHex(secret, `${t}.${raw}`);
  return sigs.some((s) => safeEqual(s, mac));
}

async function stripeWebhook(req, env) {
  const raw = await req.text();
  if (!(await verifyStripeSignature(raw, req.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET))) {
    return json({ error: 'bad_signature' }, 400);
  }
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const s = event.data && event.data.object;
    if (s && s.payment_status === 'paid' && s.client_reference_id && Number.isInteger(s.amount_total) && s.amount_total > 0) {
      const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(s.client_reference_id).first();
      if (user) {
        try {
          await ledgerInsert(env, user.id, 'deposit', s.amount_total, null, 'stripe:' + s.id, nowIso()).run();
        } catch (e) {
          // duplicate delivery: this session was already credited
        }
      }
    }
  }
  return json({ received: true });
}

async function withdraw(req, env) {
  const u = await userAuth(req, env);
  if (!u) return json({ error: 'unauthorized' }, 401);
  const b = await readJson(req);
  const amount = parseInt(b && b.amountCents, 10);
  if (!(amount >= MIN_WITHDRAW)) return json({ error: 'bad_amount' }, 400);
  const id = 'w_' + randHex(6);
  if (!(await chargeIfFunded(env, u.id, 'withdrawal', amount, null, 'wd:' + id))) return json({ error: 'insufficient_funds' }, 402);
  await env.DB.prepare('INSERT INTO withdrawals (id, user_id, amount_cents, created_at) VALUES (?, ?, ?, ?)').bind(id, u.id, amount, nowIso()).run();
  return json({ id, status: 'pending', balanceCents: await balanceOf(env, u.id) });
}

function adminOk(req, env) {
  return !!env.ADMIN_SECRET && (req.headers.get('x-admin-secret') || '') === env.ADMIN_SECRET;
}
async function adminWithdrawals(req, env) {
  if (!adminOk(req, env)) return json({ error: 'unauthorized' }, 401);
  const rows = (
    await env.DB.prepare(
      `SELECT w.id, w.amount_cents, w.created_at, u.name, u.state FROM withdrawals w JOIN users u ON u.id = w.user_id
       WHERE w.status = 'pending' ORDER BY w.created_at`
    ).all()
  ).results;
  return json({ pending: rows });
}
async function adminResolve(req, env, id) {
  if (!adminOk(req, env)) return json({ error: 'unauthorized' }, 401);
  const b = await readJson(req);
  const status = b && b.status === 'rejected' ? 'rejected' : b && b.status === 'paid' ? 'paid' : null;
  if (!status) return json({ error: 'bad_request' }, 400);
  const w = await env.DB.prepare('SELECT * FROM withdrawals WHERE id = ?').bind(id).first();
  if (!w) return json({ error: 'not_found' }, 404);
  const upd = await env.DB.prepare("UPDATE withdrawals SET status = ? WHERE id = ? AND status = 'pending'").bind(status, id).run();
  if (upd.meta.changes !== 1) return json({ error: 'already_resolved' }, 409);
  if (status === 'rejected') {
    try {
      await ledgerInsert(env, w.user_id, 'withdrawal_reversal', w.amount_cents, null, 'wdrev:' + id, nowIso()).run();
    } catch (e) {}
  }
  return json({ ok: true, status });
}

/* ---------- pots ---------- */

async function joinInternal(env, user, pot) {
  if (pot.status !== 'open') return 'not_open';
  const already = await env.DB.prepare('SELECT 1 AS x FROM members WHERE pot_id = ? AND user_id = ?').bind(pot.id, user.id).first();
  if (already) return 'already_joined';
  const count = (await env.DB.prepare('SELECT COUNT(*) AS c FROM members WHERE pot_id = ?').bind(pot.id).first()).c;
  if (count >= pot.max_members) return 'full';
  let charged;
  try {
    charged = await chargeIfFunded(env, user.id, 'stake', pot.stake_cents, pot.id, `stake:${pot.id}:${user.id}`);
  } catch (e) {
    return 'already_joined'; // unique ref: this stake was already taken
  }
  if (!charged) return 'insufficient_funds';
  await env.DB.prepare('INSERT INTO members (pot_id, user_id, joined_at) VALUES (?, ?, ?)').bind(pot.id, user.id, nowIso()).run();
  const after = (await env.DB.prepare('SELECT COUNT(*) AS c FROM members WHERE pot_id = ?').bind(pot.id).first()).c;
  if (after > pot.max_members) {
    // lost a race for the last seat: give the money back
    await env.DB.prepare('DELETE FROM members WHERE pot_id = ? AND user_id = ?').bind(pot.id, user.id).run();
    await ledgerInsert(env, user.id, 'refund', pot.stake_cents, pot.id, `undo:${pot.id}:${user.id}`, nowIso()).run();
    return 'full';
  }
  return 'ok';
}
const JOIN_ERRORS = { not_open: 409, already_joined: 409, full: 409, insufficient_funds: 402 };

async function createPot(req, env) {
  const u = await userAuth(req, env);
  if (!u) return json({ error: 'unauthorized' }, 401);
  const b = await readJson(req);
  if (!b) return json({ error: 'bad_request' }, 400);
  const name = clip(b.name, 40).trim();
  const goalText = clip(b.goalText, 120).trim();
  const goalType = GOAL_TYPES.includes(b.goalType) ? b.goalType : 'custom';
  const duration = parseInt(b.durationDays, 10);
  const stake = parseInt(b.stakeCents, 10);
  const maxMembers = Math.min(Math.max(parseInt(b.maxMembers, 10) || 6, 2), 20);
  if (name.length < 2 || goalText.length < 3 || !DURATIONS.includes(duration) || !(stake >= MIN_STAKE && stake <= MAX_STAKE)) {
    return json({ error: 'bad_request' }, 400);
  }
  const id = 'g_' + randHex(5);
  let code = '';
  for (let i = 0; i < 6; i++) {
    code = randCode(6);
    try {
      await env.DB.prepare(
        `INSERT INTO pots (id, name, goal_type, goal_text, duration_days, stake_cents, max_members, strict, join_code, creator_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(id, name, goalType, goalText, duration, stake, maxMembers, b.strict ? 1 : 0, code, u.id, nowIso())
        .run();
      break;
    } catch (e) {
      code = '';
    }
  }
  if (!code) return json({ error: 'server_error' }, 500);
  const pot = await env.DB.prepare('SELECT * FROM pots WHERE id = ?').bind(id).first();
  const res = await joinInternal(env, u, pot);
  if (res !== 'ok') {
    await env.DB.prepare('DELETE FROM pots WHERE id = ?').bind(id).run();
    return json({ error: res }, JOIN_ERRORS[res] || 400);
  }
  return json({ id, joinCode: code });
}

async function joinPreview(env, code) {
  const p = await env.DB.prepare(
    `SELECT p.*, u.name AS creator_name, (SELECT COUNT(*) FROM members WHERE pot_id = p.id) AS member_count
     FROM pots p JOIN users u ON u.id = p.creator_id WHERE p.join_code = ?`
  )
    .bind(code.toUpperCase())
    .first();
  return p || null;
}

async function joinByCode(req, env) {
  const u = await userAuth(req, env);
  if (!u) return json({ error: 'unauthorized' }, 401);
  const b = await readJson(req);
  const code = clip(b && b.code, 8).trim().toUpperCase();
  const pot = code ? await env.DB.prepare('SELECT * FROM pots WHERE join_code = ?').bind(code).first() : null;
  if (!pot) return json({ error: 'bad_code' }, 404);
  const res = await joinInternal(env, u, pot);
  if (res !== 'ok') return json({ error: res }, JOIN_ERRORS[res] || 400);
  return json({ id: pot.id });
}

async function loadPot(env, potId, userId) {
  const pot = await env.DB.prepare(
    'SELECT p.*, (SELECT COUNT(*) FROM members WHERE pot_id = p.id) AS member_count FROM pots p WHERE p.id = ?'
  )
    .bind(potId)
    .first();
  if (!pot) return {};
  const mem = await env.DB.prepare('SELECT 1 AS x FROM members WHERE pot_id = ? AND user_id = ?').bind(potId, userId).first();
  return { pot, isMember: !!mem };
}

async function potDetail(req, env, potId) {
  const u = await userAuth(req, env);
  if (!u) return json({ error: 'unauthorized' }, 401);
  await settleDue(env);
  const { pot, isMember } = await loadPot(env, potId, u.id);
  if (!pot || !isMember) return json({ error: 'not_found' }, 404);
  const members = (
    await env.DB.prepare(
      'SELECT m.user_id, u.name FROM members m JOIN users u ON u.id = m.user_id WHERE m.pot_id = ? ORDER BY m.joined_at, m.user_id'
    )
      .bind(potId)
      .all()
  ).results;
  const today = utcToday();
  let progress = {};
  let myDisputesLeft = 0;
  if (pot.start_date) {
    const checks = (await env.DB.prepare('SELECT user_id, date FROM checkins WHERE pot_id = ?').bind(potId).all()).results;
    const disputes = (await env.DB.prepare('SELECT claimant_id, date, disputer_id FROM disputes WHERE pot_id = ?').bind(potId).all()).results;
    progress = analyze(pot, members, checks, disputes, today);
    myDisputesLeft = Math.max(0, 2 - new Set(disputes.filter((d) => d.disputer_id === u.id).map((d) => d.claimant_id + d.date)).size);
  }
  let results = null;
  if (pot.status === 'settled') {
    const rows = (await env.DB.prepare('SELECT user_id, type, amount_cents FROM ledger WHERE pot_id = ? AND ref LIKE ?').bind(potId, 'settle:%').all()).results;
    results = rows.map((r) => ({ userId: r.user_id, type: r.type, amountCents: r.amount_cents }));
  }
  const mine = progress[u.id];
  return json({
    pot: potPublic(pot),
    today,
    members: members.map((m) => ({
      id: m.user_id,
      name: m.name,
      isMe: m.user_id === u.id,
      ...(progress[m.user_id] || { days: [], valid: 0, lost: 0, streak: 0, allowed: allowedMisses(pot), alive: true }),
    })),
    me: {
      checkedInToday: !!(mine && mine.days.find((d) => d.date === today && d.status === 'done')),
      disputesLeft: myDisputesLeft,
    },
    results,
  });
}

async function startPot(req, env, potId) {
  const u = await userAuth(req, env);
  if (!u) return json({ error: 'unauthorized' }, 401);
  const { pot, isMember } = await loadPot(env, potId, u.id);
  if (!pot || !isMember) return json({ error: 'not_found' }, 404);
  if (pot.creator_id !== u.id) return json({ error: 'forbidden' }, 403);
  if (pot.status !== 'open') return json({ error: 'not_open' }, 409);
  if (pot.member_count < 2) return json({ error: 'need_two_members' }, 409);
  const start = utcToday();
  const upd = await env.DB.prepare("UPDATE pots SET status = 'active', start_date = ?, end_date = ? WHERE id = ? AND status = 'open'")
    .bind(start, addDays(start, pot.duration_days - 1), potId)
    .run();
  if (upd.meta.changes !== 1) return json({ error: 'not_open' }, 409);
  return json({ ok: true, startDate: start });
}

async function refundAll(env, pot, userIds, tag) {
  const ts = nowIso();
  const stmts = userIds.map((id) => ledgerInsert(env, id, 'refund', pot.stake_cents, pot.id, `${tag}:${pot.id}:${id}`, ts));
  return stmts;
}

async function cancelPot(req, env, potId) {
  const u = await userAuth(req, env);
  if (!u) return json({ error: 'unauthorized' }, 401);
  const { pot, isMember } = await loadPot(env, potId, u.id);
  if (!pot || !isMember) return json({ error: 'not_found' }, 404);
  if (pot.creator_id !== u.id) return json({ error: 'forbidden' }, 403);
  if (pot.status !== 'open') return json({ error: 'not_open' }, 409);
  const ids = (await env.DB.prepare('SELECT user_id FROM members WHERE pot_id = ?').bind(potId).all()).results.map((r) => r.user_id);
  const stmts = await refundAll(env, pot, ids, 'cancel');
  stmts.push(env.DB.prepare("UPDATE pots SET status = 'cancelled' WHERE id = ? AND status = 'open'").bind(potId));
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    return json({ error: 'already_cancelled' }, 409);
  }
  return json({ ok: true });
}

async function leavePot(req, env, potId) {
  const u = await userAuth(req, env);
  if (!u) return json({ error: 'unauthorized' }, 401);
  const { pot, isMember } = await loadPot(env, potId, u.id);
  if (!pot || !isMember) return json({ error: 'not_found' }, 404);
  if (pot.creator_id === u.id) return json({ error: 'creator_must_cancel' }, 409);
  if (pot.status !== 'open') return json({ error: 'not_open' }, 409);
  try {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM members WHERE pot_id = ? AND user_id = ?').bind(potId, u.id),
      ledgerInsert(env, u.id, 'refund', pot.stake_cents, potId, `leave:${potId}:${u.id}`, nowIso()),
    ]);
  } catch (e) {
    return json({ error: 'already_left' }, 409);
  }
  return json({ ok: true });
}

async function checkin(req, env, potId) {
  const u = await userAuth(req, env);
  if (!u) return json({ error: 'unauthorized' }, 401);
  const { pot, isMember } = await loadPot(env, potId, u.id);
  if (!pot || !isMember) return json({ error: 'not_found' }, 404);
  if (pot.status !== 'active') return json({ error: 'not_active' }, 409);
  const b = (await readJson(req)) || {};
  const today = utcToday();
  const date = DATE_RE.test(b.date || '') ? b.date : today;
  if (Math.abs(daysBetween(today, date)) > 1 || date < pot.start_date || date > pot.end_date) return json({ error: 'bad_date' }, 400);
  await env.DB.prepare('INSERT OR REPLACE INTO checkins (pot_id, user_id, date, note, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(potId, u.id, date, clip(b.note, 140), nowIso())
    .run();
  return json({ ok: true, date });
}

async function dispute(req, env, potId) {
  const u = await userAuth(req, env);
  if (!u) return json({ error: 'unauthorized' }, 401);
  const { pot, isMember } = await loadPot(env, potId, u.id);
  if (!pot || !isMember) return json({ error: 'not_found' }, 404);
  if (pot.status !== 'active') return json({ error: 'not_active' }, 409);
  const b = (await readJson(req)) || {};
  const date = clip(b.date, 10);
  const target = clip(b.userId, 20);
  if (!DATE_RE.test(date) || target === u.id) return json({ error: 'bad_request' }, 400);
  const tm = await env.DB.prepare('SELECT 1 AS x FROM members WHERE pot_id = ? AND user_id = ?').bind(potId, target).first();
  const ch = await env.DB.prepare('SELECT 1 AS x FROM checkins WHERE pot_id = ? AND user_id = ? AND date = ?').bind(potId, target, date).first();
  if (!tm || !ch) return json({ error: 'nothing_to_dispute' }, 404);
  const used = (await env.DB.prepare('SELECT claimant_id, date FROM disputes WHERE pot_id = ? AND disputer_id = ?').bind(potId, u.id).all()).results;
  if (!used.some((d) => d.claimant_id === target && d.date === date) && new Set(used.map((d) => d.claimant_id + d.date)).size >= 2) {
    return json({ error: 'no_disputes_left' }, 409);
  }
  await env.DB.prepare('INSERT OR IGNORE INTO disputes (pot_id, claimant_id, date, disputer_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(potId, target, date, u.id, nowIso())
    .run();
  return json({ ok: true });
}

/* ---------- settlement ---------- */

export async function settlePot(env, pot) {
  const members = (await env.DB.prepare('SELECT user_id FROM members WHERE pot_id = ? ORDER BY joined_at, user_id').bind(pot.id).all()).results;
  const checks = (await env.DB.prepare('SELECT user_id, date FROM checkins WHERE pot_id = ?').bind(pot.id).all()).results;
  const disputes = (await env.DB.prepare('SELECT claimant_id, date, disputer_id FROM disputes WHERE pot_id = ?').bind(pot.id).all()).results;
  const progress = analyze(pot, members, checks, disputes, utcToday());
  const res = settle(pot, members, progress, rakeBps(env));
  const ts = nowIso();
  const stmts = res.entries.map((e) => ledgerInsert(env, e.user_id, e.type, e.amount_cents, pot.id, `settle:${pot.id}:${e.user_id}`, ts));
  stmts.push(
    env.DB.prepare("UPDATE pots SET status = 'settled', settled_at = ?, rake_cents = ? WHERE id = ? AND status = 'active'").bind(ts, res.rake_cents, pot.id)
  );
  try {
    // one atomic batch; unique refs make a second attempt fail harmlessly
    await env.DB.batch(stmts);
  } catch (e) {
    // already settled by another request
  }
}

export async function settleDue(env) {
  const cutoff = addDays(utcToday(), -1);
  const due = (await env.DB.prepare("SELECT * FROM pots WHERE status = 'active' AND end_date < ?").bind(cutoff).all()).results;
  for (const p of due) await settlePot(env, p);
  return due.length;
}

/* ---------- pages ---------- */

const PAGE_CSS = `body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0B0F0D;color:#F2F7F4;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:20px}
.c{max-width:420px;width:100%;background:#131A16;border:1px solid #243029;border-radius:20px;padding:24px;text-align:center}
h1{margin:0 0 6px;font-size:24px}.s{color:#8CA096;font-size:14px;line-height:1.5}.code{font-size:40px;letter-spacing:6px;font-weight:800;color:#C6F135;margin:16px 0}
.big{font-size:22px;font-weight:800;color:#C6F135}`;
const page = (inner) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Stake</title><style>${PAGE_CSS}</style></head><body><div class="c">${inner}</div></body></html>`;

function joinPage(p) {
  if (!p) return page('<h1>Pot not found</h1><div class="s">Double-check the code with your friend.</div>');
  return page(`<h1>${esc(p.creator_name)} invited you</h1>
<div class="s">${esc(p.name)} · ${esc(p.goal_text)}</div>
<div class="big" style="margin-top:12px">$${(p.stake_cents / 100).toFixed(2)} stake · ${esc(p.duration_days)} days</div>
<div class="s">${esc(p.member_count)} of ${esc(p.max_members)} in${p.status === 'open' ? '' : ' · already started'}</div>
<div class="code">${esc(p.join_code)}</div>
<div class="s">Open Stake, tap <b>Join a pot</b>, and enter this code. Hit your goal and you get your stake back plus a share of the pot. Miss and your stake goes to the winners.</div>`);
}

/* ---------- router ---------- */

async function route(req, env) {
  const url = new URL(req.url);
  const path = url.pathname;
  const m = req.method;
  if (m === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  if (path === '/' || path === '/health') return json({ ok: true, service: 'stake-api' });
  if (path === '/paid') return html(page('<h1>Payment received</h1><div class="s">Head back to Stake. Your balance updates in a few seconds.</div>'));
  if (path === '/cancelled') return html(page('<h1>No charge made</h1><div class="s">You can close this and head back to Stake.</div>'));

  const jp = path.match(/^\/j\/([A-Za-z0-9]{4,10})$/);
  if (jp && m === 'GET') return html(joinPage(await joinPreview(env, jp[1])));
  const jpa = path.match(/^\/api\/join\/([A-Za-z0-9]{4,10})$/);
  if (jpa && m === 'GET') {
    const p = await joinPreview(env, jpa[1]);
    if (!p) return json({ error: 'bad_code' }, 404);
    return json({
      name: p.name, goalText: p.goal_text, durationDays: p.duration_days, stakeCents: p.stake_cents,
      memberCount: p.member_count, maxMembers: p.max_members, status: p.status, creator: p.creator_name,
    });
  }

  if (path === '/api/signup' && m === 'POST') return signup(req, env);
  if (path === '/api/me' && m === 'GET') return me(req, env);
  if (path === '/api/wallet' && m === 'GET') return wallet(req, env);
  if (path === '/api/wallet/checkout' && m === 'POST') return checkout(req, env);
  if (path === '/api/wallet/withdraw' && m === 'POST') return withdraw(req, env);
  if (path === '/api/stripe/webhook' && m === 'POST') return stripeWebhook(req, env);
  if (path === '/api/admin/withdrawals' && m === 'GET') return adminWithdrawals(req, env);
  const aw = path.match(/^\/api\/admin\/withdrawals\/(w_[0-9a-f]+)$/);
  if (aw && m === 'POST') return adminResolve(req, env, aw[1]);

  if (path === '/api/pots' && m === 'POST') return createPot(req, env);
  if (path === '/api/pots/join' && m === 'POST') return joinByCode(req, env);
  const pm = path.match(/^\/api\/pots\/(g_[0-9a-f]+)(?:\/(start|cancel|leave|checkin|dispute))?$/);
  if (pm) {
    if (!pm[2] && m === 'GET') return potDetail(req, env, pm[1]);
    if (m === 'POST') {
      if (pm[2] === 'start') return startPot(req, env, pm[1]);
      if (pm[2] === 'cancel') return cancelPot(req, env, pm[1]);
      if (pm[2] === 'leave') return leavePot(req, env, pm[1]);
      if (pm[2] === 'checkin') return checkin(req, env, pm[1]);
      if (pm[2] === 'dispute') return dispute(req, env, pm[1]);
    }
  }
  return json({ error: 'not_found' }, 404);
}

export default {
  async fetch(req, env) {
    try {
      return await route(req, env);
    } catch (e) {
      return json({ error: 'server_error' }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(settleDue(env));
  },
};
