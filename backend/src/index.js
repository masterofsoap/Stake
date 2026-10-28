import { analyze, settle, addDays, daysBetween, DURATIONS, GOAL_TYPES, allowedMisses } from './rules.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type,x-admin-secret',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
};
const SEC = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...SEC, ...CORS, ...extra } });
const html = (body, status = 200) =>
  new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...SEC,
      'x-robots-tag': 'noindex',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    },
  });

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const MIN_STAKE = 500; // $5
const MAX_STAKE = 10000; // $100
const MIN_TOPUP = 500;
const MAX_TOPUP = 50000;
const MIN_WITHDRAW = 1000;
const HOUR_MS = 3600 * 1000;

// Public pots are server-defined so strangers never see user-written text: fixed goals, fixed stakes.
const PUBLIC_STAKES = [500, 1000, 2500, 5000];
const PUBLIC_MAX_MEMBERS = 12;
const PUBLIC_GOALS = {
  quit: { name: 'Quit Crew', text: 'Stayed nicotine-free today' },
  sleep: { name: 'Sleep Club', text: 'In bed on time, 7+ hours' },
  move: { name: 'Move Squad', text: '30 minutes of exercise' },
  sober: { name: 'Dry Run', text: 'No alcohol today' },
  eat: { name: 'Clean Plate', text: 'Ate clean all day' },
};
const MAX_BODY = 20000;

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
const intVar = (v, dflt) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : dflt);
const csv = (v) => String(v || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);

/* ---------- play money vs cash ---------- */

// Two wallets that never mix: every ledger row and every pot is either 'play' or 'cash'.
const curOf = (v) => (v === 'cash' ? 'cash' : 'play');
const cashOn = (env) => env.CASH === 'on';

// Why this user can't put cash in right now (null = they can). Location comes from Cloudflare's view of the
// connection, not from anything the user typed. Play money works everywhere.
function cashBlock(req, env, u) {
  if (!cashOn(env)) return 'cash_disabled';
  if (u.cash_locked) return 'account_locked';
  if (u.excluded_until && u.excluded_until > nowIso()) return 'self_excluded';
  if (!u.email_verified) return 'verify_email';
  if (env.GEOFENCE !== 'off') {
    const cf = req.cf || {};
    if (!cf.country || !csv(env.CASH_COUNTRIES || 'US').includes(String(cf.country).toUpperCase())) return 'not_available_here';
    if (csv(env.BLOCKED_STATES).includes(String(cf.regionCode || '').toUpperCase())) return 'not_available_here';
  }
  return null;
}
const cashStatus = (req, env, u) => ({
  enabled: cashOn(env),
  blocked: cashBlock(req, env, u),
  payoutsReady: !!u.payouts_enabled || env.PAYOUTS === 'manual',
  excludedUntil: u.excluded_until && u.excluded_until > nowIso() ? u.excluded_until : null,
});

async function stripeApi(env, method, path, params, idempotencyKey) {
  const headers = { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` };
  if (params) headers['content-type'] = 'application/x-www-form-urlencoded';
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const res = await fetch('https://api.stripe.com/v1' + path, { method, headers, body: params ? new URLSearchParams(params).toString() : undefined });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  return { ok: res.ok, data };
}

// Fixed-window counter in D1. Returns true when the caller is over the limit.
async function limited(env, key, max, windowSec) {
  if (env.RATE_LIMIT === 'off') return false;
  const w = Math.floor(Date.now() / 1000 / windowSec);
  const k = `${key}:${w}`;
  await env.DB.prepare('INSERT INTO rate_limits (k, n, expires_at) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = n + 1')
    .bind(k, (w + 2) * windowSec)
    .run();
  const r = await env.DB.prepare('SELECT n FROM rate_limits WHERE k = ?').bind(k).first();
  return !!r && r.n > max;
}
const clientIp = (req) => req.headers.get('cf-connecting-ip') || 'local';
const cleanName = (v) => clip(v, 20).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = Uint8Array.from(saltHex.match(/.{2}/g).map((h) => parseInt(h, 16)));
  return toHex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256));
}
const sameStr = (a, b) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};
async function newSession(env, userId) {
  const token = 'sk_' + randHex(24);
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)').bind(await sha256(token), userId, nowIso()).run();
  return token;
}

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
  return env.DB.prepare('SELECT u.* FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.token_hash = ?').bind(await sha256(t)).first();
}
async function balanceOf(env, userId, currency = 'play') {
  const r = await env.DB.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS b FROM ledger WHERE user_id = ? AND currency = ?').bind(userId, currency).first();
  return r ? r.b : 0;
}
const ledgerInsert = (env, userId, type, amount, potId, ref, ts, currency = 'play') =>
  env.DB.prepare('INSERT INTO ledger (user_id, type, amount_cents, pot_id, ref, created_at, currency) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
    userId, type, amount, potId, ref, ts, currency
  );

// Deduct `amount` only if the balance covers it. One atomic statement, so two taps can never overdraw.
async function chargeIfFunded(env, userId, type, amount, potId, ref, currency = 'play') {
  const r = await env.DB.prepare(
    `INSERT INTO ledger (user_id, type, amount_cents, pot_id, ref, created_at, currency)
     SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COALESCE(SUM(amount_cents), 0) FROM ledger WHERE user_id = ? AND currency = ?) >= ?`
  )
    .bind(userId, type, -amount, potId, ref, nowIso(), currency, userId, currency, amount)
    .run();
  return r.meta.changes === 1;
}

// Cash that can leave: the balance minus card deposits still inside the hold window (chargeback protection).
const holdSince = (env) => new Date(Date.now() - intVar(env.WITHDRAW_HOLD_HOURS, 72) * HOUR_MS).toISOString();
const WITHDRAWABLE_SQL = `(SELECT COALESCE(SUM(amount_cents), 0) FROM ledger WHERE user_id = ? AND currency = 'cash')
  - (SELECT COALESCE(SUM(amount_cents), 0) FROM ledger WHERE user_id = ? AND currency = 'cash' AND type = 'deposit' AND created_at > ?)`;
async function withdrawableOf(env, userId) {
  const r = await env.DB.prepare(`SELECT ${WITHDRAWABLE_SQL} AS w`).bind(userId, userId, holdSince(env)).first();
  return Math.max(0, r ? r.w : 0);
}

/* ---------- accounts ---------- */

const BRAND = 'Go Stake';

// Lowercased and checked, so the same person can't sign up twice with different capitalization.
export function normEmail(v) {
  const e = String(v == null ? '' : v).trim().toLowerCase();
  return e.length <= 254 && /^[^\s@<>()",;:]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(e) ? e : null;
}
const emailUser = (env, email) => env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();

const esc2 = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function codeEmail(code, purpose) {
  const what = purpose === 'reset' ? 'reset your password' : 'confirm your email';
  return {
    subject: `${code} is your ${BRAND} code`,
    text: `Your ${BRAND} code is ${code}. Use it to ${what}. It expires in 15 minutes.\n\nDidn't ask for this? You can ignore this email.`,
    html: `<!doctype html><html><body style="margin:0;background:#0A0C0B">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0A0C0B;padding:40px 16px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<tr><td align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#141815;border-radius:24px">
<tr><td style="padding:32px 32px 0;font-size:15px;font-weight:800;letter-spacing:3px;color:#C6F135">GO STAKE</td></tr>
<tr><td style="padding:28px 32px 0;font-size:17px;line-height:26px;color:#A7ADA6">Here's your code to ${esc2(what)}:</td></tr>
<tr><td style="padding:14px 32px 6px;font-size:44px;line-height:52px;font-weight:800;letter-spacing:12px;color:#F4F6EF">${esc2(code)}</td></tr>
<tr><td style="padding:0 32px 32px;font-size:14px;line-height:22px;color:#6E756E">It expires in 15 minutes. Didn't ask for this? You can ignore this email.</td></tr>
</table></td></tr></table></body></html>`,
  };
}

// Sends through Cloudflare Email Service (the EMAIL binding in wrangler.toml), from EMAIL_FROM on gostake.app.
// Returns 'sent', 'dev' (DEV_CODES on: nothing is sent, the app shows the code), or an error code.
async function sendEmail(env, to, msg) {
  if (env.DEV_CODES === 'on') return 'dev';
  if (!env.EMAIL) return 'email_not_configured';
  try {
    await env.EMAIL.send({ from: { email: env.EMAIL_FROM || 'hello@gostake.app', name: BRAND }, to, ...msg });
    return 'sent';
  } catch (e) {
    console.log('email send failed', e && e.code, e && e.message);
    return e && (e.code === 'E_RATE_LIMIT_EXCEEDED' || e.code === 'E_DAILY_LIMIT_EXCEEDED') ? 'rate_limited' : 'send_failed';
  }
}

// One live 6-digit code per email and purpose ('verify' | 'reset'). Stored hashed, 15 minutes, 5 tries.
const CODE_MINUTES = 15;
const codeHash = (email, purpose, code) => sha256(`${purpose}:${email}:${code}`);
async function sendCode(env, email, purpose, userId) {
  if (await limited(env, 'code:' + email, 5, 3600)) return { error: 'rate_limited', status: 429 };
  const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  await env.DB.prepare('INSERT OR REPLACE INTO email_codes (email, purpose, user_id, code_hash, attempts, expires_at) VALUES (?, ?, ?, ?, 0, ?)')
    .bind(email, purpose, userId, await codeHash(email, purpose, code), new Date(Date.now() + CODE_MINUTES * 60000).toISOString())
    .run();
  const res = await sendEmail(env, email, codeEmail(code, purpose));
  if (res === 'dev') return { devCode: code };
  if (res !== 'sent') return { error: res, status: res === 'email_not_configured' ? 503 : res === 'rate_limited' ? 429 : 502 };
  return {};
}
// Returns the code's user id, or an error code. A right code is used up; wrong guesses count.
async function useCode(env, email, purpose, code) {
  const row = await env.DB.prepare('SELECT * FROM email_codes WHERE email = ? AND purpose = ?').bind(email, purpose).first();
  if (!row || row.expires_at < nowIso()) return { error: 'wrong_code' };
  if (row.attempts >= 5) return { error: 'too_many_attempts' };
  if (!sameStr(await codeHash(email, purpose, String(code || '').trim()), row.code_hash)) {
    await env.DB.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE email = ? AND purpose = ?').bind(email, purpose).run();
    return { error: 'wrong_code' };
  }
  const del = await env.DB.prepare('DELETE FROM email_codes WHERE email = ? AND purpose = ? AND code_hash = ?').bind(email, purpose, row.code_hash).run();
  return del.meta.changes === 1 ? { userId: row.user_id } : { error: 'wrong_code' };
}

async function signup(req, env) {
  const b = await readJson(req);
  if (!b) return json({ error: 'bad_request' }, 400);
  const name = cleanName(b.name);
  const password = String(b.password == null ? '' : b.password);
  const email = normEmail(b.email);
  const state = /^[A-Za-z]{2}$/.test(String(b.state || '')) ? String(b.state).toUpperCase() : 'XX';
  if (b.adult !== true) return json({ error: 'must_be_18' }, 403);
  if (name.length < 2) return json({ error: 'bad_name' }, 400);
  if (!email) return json({ error: 'bad_email' }, 400);
  if (password.length < 4 || password.length > 72) return json({ error: 'bad_password' }, 400);
  if (await emailUser(env, email)) return json({ error: 'email_taken' }, 409);
  // anyone can sign up and play for play money; cash is checked per action (see cashBlock)
  const username = name.toLowerCase();
  const id = 'u_' + randHex(6);
  const salt = randHex(16);
  try {
    await env.DB.prepare('INSERT INTO users (id, username, pw_salt, pw_hash, name, state, email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, username, salt, await hashPassword(password, salt), name, state, email, nowIso())
      .run();
  } catch (e) {
    // lost a race on the email, or the name is taken
    return (await emailUser(env, email)) ? json({ error: 'email_taken' }, 409) : json({ error: 'name_taken' }, 409);
  }
  // everyone starts with some play money so they can try a pot straight away (never cash)
  const bonus = parseInt(env.PLAY_BONUS_CENTS, 10) || 0;
  if (bonus > 0) await ledgerInsert(env, id, 'deposit', bonus, null, 'bonus:' + id, nowIso(), 'play').run();
  return json({ userId: id, token: await newSession(env, id), name });
}

// `name` may be the display name or the email.
async function login(req, env) {
  const b = await readJson(req);
  const raw = String((b && b.name) == null ? '' : b.name);
  const email = raw.includes('@') ? normEmail(raw) : null;
  const username = cleanName(raw).toLowerCase();
  const password = String((b && b.password) == null ? '' : b.password);
  if (!username || !password) return json({ error: 'bad_login' }, 401);
  if (await limited(env, 'login:' + (email || username), 10, 900)) return json({ error: 'rate_limited' }, 429, { 'retry-after': '300' });
  const u = email ? await emailUser(env, email) : await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
  // always do the hash so timing doesn't reveal whether the account exists
  const got = await hashPassword(password, u ? u.pw_salt : '00'.repeat(16));
  if (!u || !sameStr(got, u.pw_hash)) return json({ error: 'bad_login' }, 401);
  return json({ userId: u.id, token: await newSession(env, u.id), name: u.name });
}

async function logout(req, env) {
  const t = bearer(req);
  if (t) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(t)).run();
  return json({ ok: true });
}

// Send a confirmation code. With `email`, first change the account's email to it (unconfirmed until the code is entered).
async function emailSend(req, env) {
  const u = await userAuth(req, env);
  if (!u) return json({ error: 'unauthorized' }, 401);
  const b = (await readJson(req)) || {};
  let email = u.email;
  if (b.email !== undefined) {
    email = normEmail(b.email);
    if (!email) return json({ error: 'bad_email' }, 400);
    if (email !== u.email) {
      if (await emailUser(env, email)) return json({ error: 'email_taken' }, 409);
      try {
        await env.DB.prepare('UPDATE users SET email = ?, email_verified = 0 WHERE id = ?').bind(email, u.id).run();
      } catch (e) {
        return json({ error: 'email_taken' }, 409);
      }
    }
  }
  if (!email) return json({ error: 'bad_email' }, 400);
  if (email === u.email && u.email_verified) return json({ email, verified: true });
  const r = await sendCode(env, email, 'verify', u.id);
  if (r.error) return json({ error: r.error }, r.status);
  return json({ email, verified: false, ...(r.devCode ? { devCode: r.devCode } : {}) });
}

async function emailVerify(req, env) {
  const u = await userAuth(req, env);
  if (!u) return json({ error: 'unauthorized' }, 401);
  if (!u.email) return json({ error: 'bad_email' }, 400);
  const b = (await readJson(req)) || {};
  const r = await useCode(env, u.email, 'verify', b.code);
  if (r.error || r.userId !== u.id) return json({ error: r.error || 'wrong_code' }, 400);
  await env.DB.prepare('UPDATE users SET email_verified = 1 WHERE id = ? AND email = ?').bind(u.id, u.email).run();
  return json({ ok: true, verified: true });
}

// Forgot password: always answers ok, so it can't be used to find out who has an account.
async function passwordForgot(req, env) {
  const b = (await readJson(req)) || {};
  const email = normEmail(b.email);
  if (!email) return json({ error: 'bad_email' }, 400);
  const u = await emailUser(env, email);
  if (!u) return json({ ok: true });
  const r = await sendCode(env, email, 'reset', u.id);
  if (r.error === 'email_not_configured') return json({ error: r.error }, 503);
  return json({ ok: true, ...(r.devCode ? { devCode: r.devCode } : {}) });
}

async function passwordReset(req, env) {
  const b = (await readJson(req)) || {};
  const email = normEmail(b.email);
  const password = String(b.password == null ? '' : b.password);
  if (!email) return json({ error: 'bad_email' }, 400);
  if (password.length < 4 || password.length > 72) return json({ error: 'bad_password' }, 400);
  const r = await useCode(env, email, 'reset', b.code);
  if (r.error) return json({ error: r.error }, 400);
  const salt = randHex(16);
  // a new password signs out every device; the code proved they own the email, so it counts as confirmed
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pw_salt = ?, pw_hash = ?, email_verified = 1 WHERE id = ?').bind(salt, await hashPassword(password, salt), r.userId),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(r.userId),
  ]);
  const u = await env.DB.prepare('SELECT id, name FROM users WHERE id = ?').bind(r.userId).first();
  return json({ userId: u.id, token: await newSession(env, u.id), name: u.name });
}

// The user's pots, with their own check-in state so the home screen can offer today's check-in.
async function potSummaryRows(env, userId) {
  return (
    await env.DB.prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM members WHERE pot_id = p.id) AS member_count,
              (SELECT COUNT(*) FROM checkins c WHERE c.pot_id = p.id AND c.user_id = m.user_id AND c.date = ?) AS checked_today,
              (SELECT COUNT(*) FROM checkins c WHERE c.pot_id = p.id AND c.user_id = m.user_id) AS my_checkins
       FROM pots p JOIN members m ON m.pot_id = p.id WHERE m.user_id = ? ORDER BY p.created_at DESC LIMIT 50`
    )
      .bind(utcToday(), userId)
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
  isPublic: !!p.is_public,
  startsAt: p.starts_at || null,
  currency: p.currency || 'play',
});

async function me(req, env) {
  const u = await userAuth(req, env);
  if (!u) return json({ error: 'unauthorized' }, 401);
  await settleDue(env);
  const pots = await potSummaryRows(env, u.id);
  const st = await env.DB.prepare('SELECT COUNT(*) AS played, COALESCE(SUM(won), 0) AS wins, COALESCE(SUM(net_cents), 0) AS net FROM results WHERE user_id = ?').bind(u.id).first();
  return json({
    user: { id: u.id, name: u.name, email: u.email || null, emailVerified: !!u.email_verified },
    balanceCents: await balanceOf(env, u.id, 'play'),
    cashCents: await balanceOf(env, u.id, 'cash'),
    cash: cashStatus(req, env, u),
    pots: pots.map((p) => ({ ...potPublic(p), checkedInToday: !!p.checked_today, myCheckins: p.my_checkins })),
    stats: { played: st.played, wins: st.wins, netCents: st.net },
    today: utcToday(),
  });
}

// Self-exclusion from cash play. It can be extended but never shortened from the app.
async function selfExclude(req, env) {
  const u = await userAuth(req, env);
  if (!u) return json({ error: 'unauthorized' }, 401);
  const b = await readJson(req);
  const days = parseInt(b && b.days, 10);
  if (!(days >= 1 && days <= 3650)) return json({ error: 'bad_request' }, 400);
  const until = new Date(Date.now() + days * 24 * HOUR_MS).toISOString();
  await env.DB.prepare('UPDATE users SET excluded_until = ? WHERE id = ? AND (excluded_until IS NULL OR excluded_until < ?)').bind(until, u.id, until).run();
  const r = await env.DB.prepare('SELECT excluded_until FROM users WHERE id = ?').bind(u.id).first();
  return json({ excludedUntil: r.excluded_until });
}

/* ---------- wallet ---------- */

async function wallet(req, env) {
  const u = await userAuth(req, env);
  if (!u) return json({ error: 'unauthorized' }, 401);
  const currency = curOf(new URL(req.url).searchParams.get('currency'));
  const entries = (
    await env.DB.prepare('SELECT type, amount_cents, pot_id, created_at FROM ledger WHERE user_id = ? AND currency = ? ORDER BY id DESC LIMIT 50')
      .bind(u.id, currency)
      .all()
  ).results;
  const withdrawals =
    currency === 'cash'
      ? (
          await env.DB.prepare('SELECT id, amount_cents, status, created_at FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 10')
            .bind(u.id)
            .all()
        ).results
      : [];
  return json({
    currency,
    balanceCents: await balanceOf(env, u.id, currency),
    withdrawableCents: currency === 'cash' ? await withdrawableOf(env, u.id) : 0,
    cash: cashStatus(req, env, u),
    entries,
    withdrawals,
  });
}

async function checkout(req, env) {
  const u = await userAuth(req, env);
  if (!u) return json({ error: 'unauthorized' }, 401);
  if (await limited(env, 'pay:' + u.id, 10, 60)) return json({ error: 'rate_limited' }, 429);
  const b = await readJson(req);
  const amount = parseInt(b && b.amountCents, 10);
  if (!(amount >= MIN_TOPUP && amount <= MAX_TOPUP)) return json({ error: 'bad_amount' }, 400);

  if (curOf(b.currency) === 'play') {
    await ledgerInsert(env, u.id, 'deposit', amount, null, 'play:' + randHex(8), nowIso(), 'play').run();
    return json({ play: true, balanceCents: await balanceOf(env, u.id, 'play') });
  }
  const block = cashBlock(req, env, u);
  if (block) return json({ error: block }, 403);
  if (!env.STRIPE_SECRET_KEY) return json({ error: 'not_configured' }, 503);
  const day = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount_cents), 0) AS s FROM ledger WHERE user_id = ? AND currency = 'cash' AND type = 'deposit' AND created_at > ?"
  )
    .bind(u.id, new Date(Date.now() - 24 * HOUR_MS).toISOString())
    .first();
  if (day.s + amount > intVar(env.DEPOSIT_DAILY_CAP_CENTS, 50000)) return json({ error: 'deposit_limit' }, 403);

  const origin = env.APP_URL || new URL(req.url).origin;
  const r = await stripeApi(env, 'POST', '/checkout/sessions', {
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(amount),
    'line_items[0][price_data][product_data][name]': 'Go Stake wallet top-up',
    client_reference_id: u.id,
    'metadata[user_id]': u.id,
    'payment_intent_data[metadata][user_id]': u.id,
    success_url: `${origin}/paid`,
    cancel_url: `${origin}/cancelled`,
  });
  if (!r.ok || !r.data.url) return json({ error: 'payment_provider_error' }, 502);
  return json({ url: r.data.url });
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
  const sig = req.headers.get('stripe-signature');
  // two endpoints can point here: the platform one, and the Connect one (account.updated for payout accounts)
  const valid = (await verifyStripeSignature(raw, sig, env.STRIPE_WEBHOOK_SECRET)) || (await verifyStripeSignature(raw, sig, env.STRIPE_CONNECT_WEBHOOK_SECRET));
  if (!valid) return json({ error: 'bad_signature' }, 400);
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  const o = (event.data && event.data.object) || {};
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    if (o.payment_status === 'paid' && o.client_reference_id && Number.isInteger(o.amount_total) && o.amount_total > 0 && (o.currency || 'usd') === 'usd') {
      const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(o.client_reference_id).first();
      if (user) {
        if (o.payment_intent) {
          await env.DB.prepare('INSERT OR IGNORE INTO stripe_payments (payment_intent, user_id, session_id, amount_cents, created_at) VALUES (?, ?, ?, ?, ?)')
            .bind(o.payment_intent, user.id, o.id, o.amount_total, nowIso())
            .run();
        }
        try {
          await ledgerInsert(env, user.id, 'deposit', o.amount_total, null, 'stripe:' + o.id, nowIso(), 'cash').run();
        } catch (e) {
          // duplicate delivery: this session was already credited
        }
      }
    }
  } else if (event.type === 'charge.dispute.created') {
    // chargeback: take the money back out of the wallet (it can go negative) and freeze cash until reviewed
    const pay = o.payment_intent ? await env.DB.prepare('SELECT user_id FROM stripe_payments WHERE payment_intent = ?').bind(o.payment_intent).first() : null;
    if (pay && Number.isInteger(o.amount) && o.amount > 0) {
      try {
        await env.DB.batch([
          ledgerInsert(env, pay.user_id, 'chargeback', -o.amount, null, 'dispute:' + o.id, nowIso(), 'cash'),
          env.DB.prepare('UPDATE users SET cash_locked = 1 WHERE id = ?').bind(pay.user_id),
        ]);
      } catch (e) {
        // duplicate delivery
      }
    }
  } else if (event.type === 'account.updated' && o.id) {
    await env.DB.prepare('UPDATE users SET payouts_enabled = ? WHERE stripe_account_id = ?').bind(o.payouts_enabled ? 1 : 0, o.id).run();
  }
  return json({ received: true });
}

// Cash-outs go to a Stripe Connect Express account. Stripe verifies the person (name, DOB, SSN last 4, bank)
// during onboarding, so we never hold that data. Returns a Stripe-hosted onboarding link.
async function payoutSetup(req, env) {
  const u = await userAuth(req, env);
  if (!u) return json({ error: 'unauthorized' }, 401);
  if (!cashOn(env)) return json({ error: 'cash_disabled' }, 403);
  if (await limited(env, 'pay:' + u.id, 10, 60)) return json({ error: 'rate_limited' }, 429);
  if (!env.STRIPE_SECRET_KEY) return json({ error: 'not_configured' }, 503);
  let acct = u.stripe_account_id;
  if (acct) {
    const r = await stripeApi(env, 'GET', '/accounts/' + acct);
    if (r.ok && r.data.payouts_enabled) {
      await env.DB.prepare('UPDATE users SET payouts_enabled = 1 WHERE id = ?').bind(u.id).run();
      return json({ ready: true });
    }
  } else {
    const r = await stripeApi(
      env,
      'POST',
      '/accounts',
      {
        type: 'express',
        country: 'US',
        business_type: 'individual',
        'capabilities[transfers][requested]': 'true',
        'business_profile[product_description]': 'Go Stake player payouts',
        'metadata[user_id]': u.id,
      },
      'acct:' + u.id
    );
    if (!r.ok || !r.data.id) return json({ error: 'payment_provider_error' }, 502);
    await env.DB.prepare('UPDATE users SET stripe_account_id = ? WHERE id = ? AND stripe_account_id IS NULL').bind(r.data.id, u.id).run();
    acct = (await env.DB.prepare('SELECT stripe_account_id FROM users WHERE id = ?').bind(u.id).first()).stripe_account_id;
  }
  const origin = new URL(req.url).origin;
  const link = await stripeApi(env, 'POST', '/account_links', {
    account: acct,
    type: 'account_onboarding',
    refresh_url: `${origin}/payouts/retry`,
    return_url: `${origin}/payouts/done`,
  });
  if (!link.ok || !link.data.url) return json({ error: 'payment_provider_error' }, 502);
  return json({ ready: false, url: link.data.url });
}

// Move a pending withdrawal to the user's Connect account. The idempotency key is the withdrawal id,
// so retries (or two admins clicking at once) can never pay twice.
async function sendTransfer(env, w) {
  const u = await env.DB.prepare('SELECT stripe_account_id, payouts_enabled FROM users WHERE id = ?').bind(w.user_id).first();
  const fail = async (note) => {
    await env.DB.prepare('UPDATE withdrawals SET note = ? WHERE id = ?').bind(note, w.id).run();
    return note;
  };
  if (!env.STRIPE_SECRET_KEY) return fail('stripe not configured');
  if (!u || !u.stripe_account_id || !u.payouts_enabled) return fail('payout account not ready');
  const r = await stripeApi(
    env,
    'POST',
    '/transfers',
    { amount: String(w.amount_cents), currency: 'usd', destination: u.stripe_account_id, 'metadata[withdrawal_id]': w.id, 'metadata[user_id]': w.user_id },
    'wd:' + w.id
  );
  if (!r.ok || !r.data.id) return fail('transfer failed: ' + clip((r.data.error && r.data.error.message) || 'unknown', 200));
  await env.DB.prepare("UPDATE withdrawals SET status = 'paid', transfer_id = ?, note = '' WHERE id = ? AND status = 'pending'").bind(r.data.id, w.id).run();
  return null;
}

async function withdraw(req, env) {
  const u = await userAuth(req, env);
  if (!u) return json({ error: 'unauthorized' }, 401);
  if (await limited(env, 'pay:' + u.id, 10, 60)) return json({ error: 'rate_limited' }, 429);
  // no geofence or self-exclusion check here: people can always take their own money out
  if (!cashOn(env)) return json({ error: 'cash_disabled' }, 403);
  if (u.cash_locked) return json({ error: 'account_locked' }, 403);
  const b = await readJson(req);
  const amount = parseInt(b && b.amountCents, 10);
  if (!(amount >= MIN_WITHDRAW)) return json({ error: 'bad_amount' }, 400);
  const manual = env.PAYOUTS === 'manual';
  if (!manual && !u.payouts_enabled) return json({ error: 'payouts_not_set_up' }, 409);
  const id = 'w_' + randHex(6);
  const ts = nowIso();
  const r = await env.DB.prepare(
    `INSERT INTO ledger (user_id, type, amount_cents, pot_id, ref, created_at, currency)
     SELECT ?, 'withdrawal', ?, NULL, ?, ?, 'cash' WHERE ${WITHDRAWABLE_SQL} >= ?`
  )
    .bind(u.id, -amount, 'wd:' + id, ts, u.id, u.id, holdSince(env), amount)
    .run();
  if (r.meta.changes !== 1) {
    const onHold = (await balanceOf(env, u.id, 'cash')) >= amount;
    return json({ error: onHold ? 'funds_on_hold' : 'insufficient_funds' }, 402);
  }
  const big = amount > intVar(env.WITHDRAW_AUTO_MAX_CENTS, 25000);
  const note = manual ? 'manual payout' : big ? 'over auto-approve limit' : '';
  await env.DB.prepare('INSERT INTO withdrawals (id, user_id, amount_cents, note, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, u.id, amount, note, ts).run();
  let status = 'pending';
  if (!manual && !big) status = (await sendTransfer(env, { id, user_id: u.id, amount_cents: amount })) ? 'pending' : 'paid';
  return json({ id, status, balanceCents: await balanceOf(env, u.id, 'cash') });
}

function adminOk(req, env) {
  return !!env.ADMIN_SECRET && safeEqual(req.headers.get('x-admin-secret') || '', env.ADMIN_SECRET);
}
async function adminWithdrawals(req, env) {
  if (!adminOk(req, env)) return json({ error: 'unauthorized' }, 401);
  const rows = (
    await env.DB.prepare(
      `SELECT w.id, w.amount_cents, w.note, w.created_at, u.id AS user_id, u.name, u.state, u.payouts_enabled, u.cash_locked
       FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.status = 'pending' ORDER BY w.created_at`
    ).all()
  ).results;
  return json({ pending: rows });
}
// status: "approve" (send it through Stripe now), "paid" (you paid it some other way), "rejected" (money goes back)
async function adminResolve(req, env, id) {
  if (!adminOk(req, env)) return json({ error: 'unauthorized' }, 401);
  const b = await readJson(req);
  const status = b && ['approve', 'paid', 'rejected'].includes(b.status) ? b.status : null;
  if (!status) return json({ error: 'bad_request' }, 400);
  const w = await env.DB.prepare('SELECT * FROM withdrawals WHERE id = ?').bind(id).first();
  if (!w) return json({ error: 'not_found' }, 404);
  if (w.status !== 'pending') return json({ error: 'already_resolved' }, 409);
  if (status === 'approve') {
    const err = await sendTransfer(env, w);
    return err ? json({ error: 'transfer_failed', note: err }, 502) : json({ ok: true, status: 'paid' });
  }
  const upd = await env.DB.prepare("UPDATE withdrawals SET status = ? WHERE id = ? AND status = 'pending'").bind(status, id).run();
  if (upd.meta.changes !== 1) return json({ error: 'already_resolved' }, 409);
  if (status === 'rejected') {
    try {
      await ledgerInsert(env, w.user_id, 'withdrawal_reversal', w.amount_cents, null, 'wdrev:' + id, nowIso(), 'cash').run();
    } catch (e) {}
  }
  return json({ ok: true, status });
}
// Unlock an account after a chargeback has been dealt with.
async function adminUnlock(req, env, userId) {
  if (!adminOk(req, env)) return json({ error: 'unauthorized' }, 401);
  const r = await env.DB.prepare('UPDATE users SET cash_locked = 0 WHERE id = ?').bind(userId).run();
  return r.meta.changes ? json({ ok: true }) : json({ error: 'not_found' }, 404);
}
// The numbers to reconcile against the Stripe dashboard.
async function adminSummary(req, env) {
  if (!adminOk(req, env)) return json({ error: 'unauthorized' }, 401);
  const q = (sql) => env.DB.prepare(sql).first();
  const owed = await q("SELECT COALESCE(SUM(amount_cents), 0) AS c FROM ledger WHERE currency = 'cash'");
  const inPots = await q("SELECT COALESCE(SUM(p.stake_cents), 0) AS c FROM members m JOIN pots p ON p.id = m.pot_id WHERE p.currency = 'cash' AND p.status IN ('open', 'active')");
  const dep = await q("SELECT COALESCE(SUM(amount_cents), 0) AS c FROM ledger WHERE currency = 'cash' AND type = 'deposit'");
  const out = await q("SELECT COALESCE(SUM(amount_cents), 0) AS c FROM withdrawals WHERE status = 'paid'");
  const pend = await q("SELECT COALESCE(SUM(amount_cents), 0) AS c, COUNT(*) AS n FROM withdrawals WHERE status = 'pending'");
  const rake = await q("SELECT COALESCE(SUM(rake_cents), 0) AS c FROM pots WHERE currency = 'cash' AND status = 'settled'");
  const locked = await q('SELECT COUNT(*) AS n FROM users WHERE cash_locked = 1');
  return json({
    walletsCents: owed.c, // what players could withdraw if pots ended now (excludes stakes in live pots)
    inLivePotsCents: inPots.c,
    depositsCents: dep.c,
    paidOutCents: out.c,
    pendingWithdrawals: { cents: pend.c, count: pend.n },
    rakeEarnedCents: rake.c,
    lockedAccounts: locked.n,
  });
}

/* ---------- pots ---------- */

async function joinInternal(req, env, user, pot) {
  if (pot.status !== 'open') return 'not_open';
  if (pot.currency === 'cash') {
    const block = cashBlock(req, env, user);
    if (block) return block;
  }
  const already = await env.DB.prepare('SELECT 1 AS x FROM members WHERE pot_id = ? AND user_id = ?').bind(pot.id, user.id).first();
  if (already) return 'already_joined';
  const count = (await env.DB.prepare('SELECT COUNT(*) AS c FROM members WHERE pot_id = ?').bind(pot.id).first()).c;
  if (count >= pot.max_members) return 'full';
  let charged;
  try {
    charged = await chargeIfFunded(env, user.id, 'stake', pot.stake_cents, pot.id, `stake:${pot.id}:${user.id}`, pot.currency);
  } catch (e) {
    return 'already_joined'; // unique ref: this stake was already taken
  }
  if (!charged) return 'insufficient_funds';
  // only while the pot is still open: a pot that started a millisecond ago must not take a late joiner
  const ins = await env.DB.prepare("INSERT INTO members (pot_id, user_id, joined_at) SELECT ?, ?, ? WHERE (SELECT status FROM pots WHERE id = ?) = 'open'")
    .bind(pot.id, user.id, nowIso(), pot.id)
    .run();
  if (ins.meta.changes !== 1) {
    await ledgerInsert(env, user.id, 'refund', pot.stake_cents, pot.id, `undo:${pot.id}:${user.id}`, nowIso(), pot.currency).run();
    return 'not_open';
  }
  const after = (await env.DB.prepare('SELECT COUNT(*) AS c FROM members WHERE pot_id = ?').bind(pot.id).first()).c;
  if (after > pot.max_members) {
    // lost a race for the last seat: give the money back
    await env.DB.prepare('DELETE FROM members WHERE pot_id = ? AND user_id = ?').bind(pot.id, user.id).run();
    await ledgerInsert(env, user.id, 'refund', pot.stake_cents, pot.id, `undo:${pot.id}:${user.id}`, nowIso(), pot.currency).run();
    return 'full';
  }
  // a full public pot starts right away, no waiting for the clock
  if (pot.is_public && after >= pot.max_members) await activatePot(env, pot, utcToday());
  return 'ok';
}

async function activatePot(env, pot, start) {
  const r = await env.DB.prepare("UPDATE pots SET status = 'active', start_date = ?, end_date = ? WHERE id = ? AND status = 'open'")
    .bind(start, addDays(start, pot.duration_days - 1), pot.id)
    .run();
  return r.meta.changes === 1;
}
const JOIN_ERRORS = { not_open: 409, already_joined: 409, full: 409, insufficient_funds: 402, cash_disabled: 403, account_locked: 403, self_excluded: 403, not_available_here: 403 };

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
  const currency = curOf(b.currency);
  if (name.length < 2 || goalText.length < 3 || !DURATIONS.includes(duration) || !(stake >= MIN_STAKE && stake <= MAX_STAKE)) {
    return json({ error: 'bad_request' }, 400);
  }
  const id = 'g_' + randHex(5);
  let code = '';
  for (let i = 0; i < 6; i++) {
    code = randCode(6);
    try {
      await env.DB.prepare(
        `INSERT INTO pots (id, name, goal_type, goal_text, duration_days, stake_cents, max_members, strict, join_code, creator_id, currency, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(id, name, goalType, goalText, duration, stake, maxMembers, b.strict ? 1 : 0, code, u.id, currency, nowIso())
        .run();
      break;
    } catch (e) {
      code = '';
    }
  }
  if (!code) return json({ error: 'server_error' }, 500);
  const pot = await env.DB.prepare('SELECT * FROM pots WHERE id = ?').bind(id).first();
  const res = await joinInternal(req, env, u, pot);
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
  const res = await joinInternal(req, env, u, pot);
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
  if (pot.is_public) return json({ error: 'public_auto' }, 409);
  if (pot.creator_id !== u.id) return json({ error: 'forbidden' }, 403);
  if (pot.status !== 'open') return json({ error: 'not_open' }, 409);
  if (pot.member_count < 2) return json({ error: 'need_two_members' }, 409);
  const start = utcToday();
  if (!(await activatePot(env, pot, start))) return json({ error: 'not_open' }, 409);
  return json({ ok: true, startDate: start });
}

async function refundAll(env, pot, userIds, tag) {
  const ts = nowIso();
  const stmts = userIds.map((id) => ledgerInsert(env, id, 'refund', pot.stake_cents, pot.id, `${tag}:${pot.id}:${id}`, ts, pot.currency));
  return stmts;
}

async function cancelPot(req, env, potId) {
  const u = await userAuth(req, env);
  if (!u) return json({ error: 'unauthorized' }, 401);
  const { pot, isMember } = await loadPot(env, potId, u.id);
  if (!pot || !isMember) return json({ error: 'not_found' }, 404);
  if (pot.is_public) return json({ error: 'public_auto' }, 409);
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
  if (pot.creator_id === u.id && !pot.is_public) return json({ error: 'creator_must_cancel' }, 409);
  if (pot.status !== 'open') return json({ error: 'not_open' }, 409);
  try {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM members WHERE pot_id = ? AND user_id = ?').bind(potId, u.id),
      ledgerInsert(env, u.id, 'refund', pot.stake_cents, potId, `leave:${potId}:${u.id}`, nowIso(), pot.currency),
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
  const stmts = res.entries.map((e) => ledgerInsert(env, e.user_id, e.type, e.amount_cents, pot.id, `settle:${pot.id}:${e.user_id}`, ts, pot.currency));
  const paid = new Map(res.entries.map((e) => [e.user_id, e.amount_cents]));
  const everyoneWon = res.losers === 0;
  const winnerIds = new Set(everyoneWon ? members.map((m) => m.user_id) : members.filter((m) => progress[m.user_id].finalMisses <= allowedMisses(pot)).map((m) => m.user_id));
  for (const m of members) {
    stmts.push(
      env.DB.prepare('INSERT OR IGNORE INTO results (pot_id, user_id, won, net_cents, is_public, currency, settled_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(pot.id, m.user_id, winnerIds.has(m.user_id) ? 1 : 0, (paid.get(m.user_id) || 0) - pot.stake_cents, pot.is_public ? 1 : 0, pot.currency, ts)
    );
  }
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

// Public pots start by themselves: when full (see joinInternal) or when their start day arrives.
// Not enough players on the day? Push the start back (up to 3 times), then refund and close.
export async function startDuePublic(env) {
  const today = utcToday();
  const due = (
    await env.DB.prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM members WHERE pot_id = p.id) AS member_count
       FROM pots p WHERE p.is_public = 1 AND p.status = 'open' AND p.starts_at <= ?`
    ).bind(today).all()
  ).results;
  for (const p of due) {
    if (p.member_count >= 2) {
      await activatePot(env, p, today);
    } else if (p.member_count === 0) {
      await env.DB.prepare("UPDATE pots SET status = 'cancelled' WHERE id = ? AND status = 'open'").bind(p.id).run();
    } else if (p.rollovers < 3) {
      await env.DB.prepare('UPDATE pots SET starts_at = ?, rollovers = rollovers + 1 WHERE id = ? AND status = \'open\'').bind(addDays(today, 1), p.id).run();
    } else {
      const ids = (await env.DB.prepare('SELECT user_id FROM members WHERE pot_id = ?').bind(p.id).all()).results.map((r) => r.user_id);
      const stmts = await refundAll(env, p, ids, 'cancel');
      stmts.push(env.DB.prepare("UPDATE pots SET status = 'cancelled' WHERE id = ? AND status = 'open'").bind(p.id));
      try { await env.DB.batch(stmts); } catch (e) { /* already handled */ }
    }
  }
  return due.length;
}

export async function settleDue(env) {
  await startDuePublic(env);
  const cutoff = addDays(utcToday(), -1);
  const due = (await env.DB.prepare("SELECT * FROM pots WHERE status = 'active' AND end_date < ?").bind(cutoff).all()).results;
  for (const p of due) await settlePot(env, p);
  return due.length;
}

/* ---------- public pots + leaderboard ---------- */

const publicRow = (p) => ({ ...potPublic(p), joinCode: undefined, creatorId: undefined });

// Browse: open public pots with free seats, fullest first (closest to starting).
async function publicList(req, env) {
  const u = await userAuth(req, env);
  if (!u) return json({ error: 'unauthorized' }, 401);
  await settleDue(env);
  const url = new URL(req.url);
  const goal = url.searchParams.get('goalType');
  const currency = curOf(url.searchParams.get('currency'));
  const rows = (
    await env.DB.prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM members WHERE pot_id = p.id) AS member_count,
              (SELECT COUNT(*) FROM members WHERE pot_id = p.id AND user_id = ?) AS mine
       FROM pots p WHERE p.is_public = 1 AND p.status = 'open' AND p.currency = ? AND (? = '' OR p.goal_type = ?)
       ORDER BY member_count DESC, p.starts_at ASC LIMIT 60`
    ).bind(u.id, currency, goal || '', goal || '').all()
  ).results.filter((p) => p.member_count < p.max_members);
  const active = (
    await env.DB.prepare("SELECT COUNT(*) AS c FROM members m JOIN pots p ON p.id = m.pot_id WHERE p.is_public = 1 AND p.status = 'active' AND p.currency = ?")
      .bind(currency)
      .first()
  ).c;
  const live = await env.DB.prepare(
    "SELECT COALESCE(SUM(p.stake_cents), 0) AS c FROM members m JOIN pots p ON p.id = m.pot_id WHERE p.is_public = 1 AND p.status IN ('open', 'active') AND p.currency = ?"
  )
    .bind(currency)
    .first();
  return json({ pots: rows.map((p) => ({ ...publicRow(p), joined: !!p.mine })), playersLive: active, liveCents: live.c });
}

async function joinPublicById(req, env, potId) {
  const u = await userAuth(req, env);
  if (!u) return json({ error: 'unauthorized' }, 401);
  if (await limited(env, 'join:' + u.id, 30, 60)) return json({ error: 'rate_limited' }, 429);
  const pot = await env.DB.prepare('SELECT * FROM pots WHERE id = ? AND is_public = 1').bind(potId).first();
  if (!pot) return json({ error: 'not_found' }, 404);
  const res = await joinInternal(req, env, u, pot);
  if (res !== 'ok') return json({ error: res }, JOIN_ERRORS[res] || 400);
  return json({ id: pot.id });
}

// Quick match: put me in the best matching open public pot, or open a new one for others to fill.
async function playPublic(req, env) {
  const u = await userAuth(req, env);
  if (!u) return json({ error: 'unauthorized' }, 401);
  if (await limited(env, 'join:' + u.id, 30, 60)) return json({ error: 'rate_limited' }, 429);
  const b = await readJson(req);
  if (!b) return json({ error: 'bad_request' }, 400);
  const goal = PUBLIC_GOALS[b.goalType];
  const duration = parseInt(b.durationDays, 10);
  const stake = parseInt(b.stakeCents, 10);
  if (!goal || !DURATIONS.includes(duration) || !PUBLIC_STAKES.includes(stake)) return json({ error: 'bad_request' }, 400);
  const currency = curOf(b.currency);
  if (currency === 'cash') {
    const block = cashBlock(req, env, u);
    if (block) return json({ error: block }, 403);
  }
  await startDuePublic(env);
  const cands = (
    await env.DB.prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM members WHERE pot_id = p.id) AS member_count
       FROM pots p WHERE p.is_public = 1 AND p.status = 'open' AND p.currency = ? AND p.goal_type = ? AND p.duration_days = ? AND p.stake_cents = ?
         AND NOT EXISTS (SELECT 1 FROM members m WHERE m.pot_id = p.id AND m.user_id = ?)
       ORDER BY member_count DESC, p.created_at ASC LIMIT 5`
    ).bind(currency, b.goalType, duration, stake, u.id).all()
  ).results.filter((p) => p.member_count < p.max_members);
  let last = 'full';
  for (const p of cands) {
    const res = await joinInternal(req, env, u, p);
    if (res === 'ok') return json({ id: p.id, created: false });
    if (res === 'insufficient_funds') return json({ error: res }, 402);
    last = res;
  }
  // nothing open: start a lobby. Gives others at least 12 hours to find it before it can start.
  const hour = new Date().getUTCHours();
  const startsAt = addDays(utcToday(), hour >= 12 ? 2 : 1);
  const id = 'g_' + randHex(5);
  let code = '';
  for (let i = 0; i < 6 && !code; i++) {
    const c = randCode(6);
    try {
      await env.DB.prepare(
        `INSERT INTO pots (id, name, goal_type, goal_text, duration_days, stake_cents, max_members, strict, join_code, creator_id, is_public, starts_at, currency, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?, ?)`
      ).bind(id, goal.name, b.goalType, goal.text, duration, stake, PUBLIC_MAX_MEMBERS, c, u.id, startsAt, currency, nowIso()).run();
      code = c;
    } catch (e) {}
  }
  if (!code) return json({ error: 'server_error' }, 500);
  const pot = await env.DB.prepare('SELECT * FROM pots WHERE id = ?').bind(id).first();
  const res = await joinInternal(req, env, u, pot);
  if (res !== 'ok') {
    await env.DB.prepare('DELETE FROM pots WHERE id = ?').bind(id).run();
    return json({ error: res }, JOIN_ERRORS[res] || 400);
  }
  return json({ id, created: true });
}

// Global board: public pots only, last 30 days, ranked by net winnings.
async function leaderboard(req, env) {
  const u = await userAuth(req, env);
  if (!u) return json({ error: 'unauthorized' }, 401);
  const since = addDays(utcToday(), -30);
  const currency = curOf(new URL(req.url).searchParams.get('currency'));
  const rows = (
    await env.DB.prepare(
      `SELECT r.user_id, u.name, COUNT(*) AS played, SUM(r.won) AS wins, SUM(r.net_cents) AS net
       FROM results r JOIN users u ON u.id = r.user_id
       WHERE r.is_public = 1 AND r.currency = ? AND r.settled_at >= ?
       GROUP BY r.user_id ORDER BY net DESC, wins DESC, played DESC, r.user_id ASC LIMIT 200`
    ).bind(currency, since).all()
  ).results;
  const shape = (r, i) => ({ rank: i + 1, name: r.name, played: r.played, wins: r.wins, netCents: r.net, isMe: r.user_id === u.id });
  const all = rows.map(shape);
  const mine = all.find((r) => r.isMe) || null;
  return json({ top: all.slice(0, 25), me: mine, windowDays: 30 });
}

/* ---------- pages ---------- */

const PAGE_CSS = `body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0B0F0D;color:#F2F7F4;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:20px}
.c{max-width:420px;width:100%;background:#131A16;border:1px solid #243029;border-radius:20px;padding:24px;text-align:center}
h1{margin:0 0 6px;font-size:24px}.s{color:#8CA096;font-size:14px;line-height:1.5}.code{font-size:40px;letter-spacing:6px;font-weight:800;color:#C6F135;margin:16px 0}
.big{font-size:22px;font-weight:800;color:#C6F135}`;
const page = (inner) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Go Stake</title><style>${PAGE_CSS}</style></head><body><div class="c">${inner}</div></body></html>`;

function joinPage(p) {
  if (!p) return page('<h1>Pot not found</h1><div class="s">Double-check the code with your friend.</div>');
  return page(`<h1>${esc(p.creator_name)} invited you</h1>
<div class="s">${esc(p.name)} · ${esc(p.goal_text)}</div>
<div class="big" style="margin-top:12px">$${(p.stake_cents / 100).toFixed(2)} ${p.currency === 'cash' ? 'real-money' : 'play-money'} stake · ${esc(p.duration_days)} days</div>
<div class="s">${esc(p.member_count)} of ${esc(p.max_members)} in${p.status === 'open' ? '' : ' · already started'}</div>
<div class="code">${esc(p.join_code)}</div>
<div class="s">Open Go Stake, tap <b>Enter a code</b>, and enter this code. Hit your goal and you get your stake back plus a share of the pot. Miss and your stake goes to the winners.</div>`);
}

/* ---------- router ---------- */

async function route(req, env) {
  const url = new URL(req.url);
  const path = url.pathname;
  const m = req.method;
  if (m === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (Number(req.headers.get('content-length') || 0) > MAX_BODY) return json({ error: 'too_large' }, 413);
  if (m === 'POST' && path.startsWith('/api/') && path !== '/api/stripe/webhook' && (await limited(env, 'ip:' + clientIp(req), 120, 60))) {
    return json({ error: 'rate_limited' }, 429, { 'retry-after': '30' });
  }

  if (path === '/' || path === '/health') return json({ ok: true, service: 'gostake-api' });
  if (path === '/paid') return html(page('<h1>Payment received</h1><div class="s">Head back to Go Stake. Your balance updates in a few seconds.</div>'));
  if (path === '/cancelled') return html(page('<h1>No charge made</h1><div class="s">You can close this and head back to Go Stake.</div>'));
  if (path === '/payouts/done') return html(page('<h1>Payout account saved</h1><div class="s">Head back to Go Stake. Once Stripe finishes checking your details you can cash out.</div>'));
  if (path === '/payouts/retry') return html(page('<h1>That link expired</h1><div class="s">Head back to Go Stake and tap <b>Set up cash-outs</b> again.</div>'));

  const jp = path.match(/^\/j\/([A-Za-z0-9]{4,10})$/);
  if (jp && m === 'GET') return html(joinPage(await joinPreview(env, jp[1])));
  const jpa = path.match(/^\/api\/join\/([A-Za-z0-9]{4,10})$/);
  if (jpa && m === 'GET') {
    const p = await joinPreview(env, jpa[1]);
    if (!p) return json({ error: 'bad_code' }, 404);
    return json({
      name: p.name, goalText: p.goal_text, durationDays: p.duration_days, stakeCents: p.stake_cents,
      memberCount: p.member_count, maxMembers: p.max_members, status: p.status, creator: p.creator_name, currency: p.currency,
    });
  }

  if (path === '/api/signup' && m === 'POST') {
    if (await limited(env, 'signup:' + clientIp(req), 10, 3600)) return json({ error: 'rate_limited' }, 429, { 'retry-after': '600' });
    return signup(req, env);
  }
  if (path === '/api/login' && m === 'POST') {
    if (await limited(env, 'loginip:' + clientIp(req), 40, 3600)) return json({ error: 'rate_limited' }, 429, { 'retry-after': '600' });
    return login(req, env);
  }
  if (path === '/api/public' && m === 'GET') return publicList(req, env);
  if (path === '/api/public/play' && m === 'POST') return playPublic(req, env);
  if (path === '/api/leaderboard' && m === 'GET') return leaderboard(req, env);
  if (path === '/api/me' && m === 'GET') return me(req, env);
  if (path === '/api/me/exclude' && m === 'POST') return selfExclude(req, env);
  if (path === '/api/logout' && m === 'POST') return logout(req, env);
  if (path === '/api/email/send' && m === 'POST') return emailSend(req, env);
  if (path === '/api/email/verify' && m === 'POST') return emailVerify(req, env);
  if (path === '/api/password/forgot' && m === 'POST') return passwordForgot(req, env);
  if (path === '/api/password/reset' && m === 'POST') return passwordReset(req, env);
  if (path === '/api/wallet' && m === 'GET') return wallet(req, env);
  if (path === '/api/wallet/checkout' && m === 'POST') return checkout(req, env);
  if (path === '/api/wallet/withdraw' && m === 'POST') return withdraw(req, env);
  if (path === '/api/payouts/setup' && m === 'POST') return payoutSetup(req, env);
  if (path === '/api/stripe/webhook' && m === 'POST') return stripeWebhook(req, env);
  if (path === '/api/admin/withdrawals' && m === 'GET') return adminWithdrawals(req, env);
  if (path === '/api/admin/summary' && m === 'GET') return adminSummary(req, env);
  const aw = path.match(/^\/api\/admin\/withdrawals\/(w_[0-9a-f]+)$/);
  if (aw && m === 'POST') return adminResolve(req, env, aw[1]);
  const au = path.match(/^\/api\/admin\/users\/(u_[0-9a-f]+)\/unlock$/);
  if (au && m === 'POST') return adminUnlock(req, env, au[1]);

  if (path === '/api/pots' && m === 'POST') return createPot(req, env);
  if (path === '/api/pots/join' && m === 'POST') return joinByCode(req, env);
  const pm = path.match(/^\/api\/pots\/(g_[0-9a-f]+)(?:\/(start|cancel|leave|checkin|dispute|join))?$/);
  if (pm) {
    if (!pm[2] && m === 'GET') return potDetail(req, env, pm[1]);
    if (m === 'POST') {
      if (pm[2] === 'join') return joinPublicById(req, env, pm[1]);
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
    ctx.waitUntil(
      (async () => {
        await settleDue(env);
        await env.DB.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(Math.floor(Date.now() / 1000)).run();
      })()
    );
  },
};
