CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,   -- lowercase login name
  pw_salt TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  name TEXT NOT NULL,              -- display name
  state TEXT NOT NULL DEFAULT 'XX',
  email TEXT,                               -- lowercase; unique, see index below
  email_verified INTEGER NOT NULL DEFAULT 0,
  stripe_account_id TEXT,                   -- Stripe Connect Express account that receives cash-outs
  payouts_enabled INTEGER NOT NULL DEFAULT 0,
  cash_locked INTEGER NOT NULL DEFAULT 0,   -- set by a chargeback: no cash play or cash-outs until reviewed
  excluded_until TEXT,                      -- self-exclusion from cash play (can only be extended)
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Live one-time email codes (confirm email, reset password). One per email + purpose; stored hashed.
CREATE TABLE IF NOT EXISTS email_codes (
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,           -- verify | reset
  user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (email, purpose)
);

-- One row per signed-in device, so logging in on a second phone doesn't sign out the first.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Every cent that moves is a ledger row. Balance = SUM(amount_cents). `ref` is unique, so any
-- operation that carries a ref (a Stripe session, a stake, a payout) can never be applied twice.
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,          -- deposit | stake | refund | payout | withdrawal | withdrawal_reversal | chargeback
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'play',   -- play | cash: two wallets that never mix
  pot_id TEXT,
  ref TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, currency);

CREATE TABLE IF NOT EXISTS pots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  goal_type TEXT NOT NULL,
  goal_text TEXT NOT NULL,
  duration_days INTEGER NOT NULL,
  stake_cents INTEGER NOT NULL,
  max_members INTEGER NOT NULL,
  strict INTEGER NOT NULL DEFAULT 0,
  join_code TEXT NOT NULL UNIQUE,
  creator_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',   -- open | active | settled | cancelled
  start_date TEXT,
  end_date TEXT,
  rake_cents INTEGER NOT NULL DEFAULT 0,
  settled_at TEXT,
  is_public INTEGER NOT NULL DEFAULT 0,   -- 1 = anyone can find and join it
  starts_at TEXT,                         -- public pots: scheduled auto-start day
  rollovers INTEGER NOT NULL DEFAULT 0,   -- public pots: times the start was pushed back for lack of players
  currency TEXT NOT NULL DEFAULT 'play',  -- play | cash
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pots_public ON pots(is_public, status);
CREATE INDEX IF NOT EXISTS idx_pots_status ON pots(status, end_date);

CREATE TABLE IF NOT EXISTS members (
  pot_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (pot_id, user_id)
);

CREATE TABLE IF NOT EXISTS checkins (
  pot_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (pot_id, user_id, date)
);

CREATE TABLE IF NOT EXISTS disputes (
  pot_id TEXT NOT NULL,
  claimant_id TEXT NOT NULL,
  date TEXT NOT NULL,
  disputer_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (pot_id, claimant_id, date, disputer_id)
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | paid | rejected
  transfer_id TEXT,                        -- Stripe transfer to the user's Connect account
  note TEXT NOT NULL DEFAULT '',           -- why it is waiting for review
  created_at TEXT NOT NULL
);

-- One row per member per settled pot: powers stats and the global leaderboard.
CREATE TABLE IF NOT EXISTS results (
  pot_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  won INTEGER NOT NULL,
  net_cents INTEGER NOT NULL,      -- payout minus stake (negative for a loss)
  is_public INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'play',
  settled_at TEXT NOT NULL,
  PRIMARY KEY (pot_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_results_board ON results(is_public, settled_at);

-- Card payments behind cash deposits, so a chargeback can be traced back to its user.
CREATE TABLE IF NOT EXISTS stripe_payments (
  payment_intent TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- Fixed-window rate limiting counters.
CREATE TABLE IF NOT EXISTS rate_limits (
  k TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
