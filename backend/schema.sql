CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Every cent that moves is a ledger row. Balance = SUM(amount_cents). `ref` is unique, so any
-- operation that carries a ref (a Stripe session, a stake, a payout) can never be applied twice.
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,          -- deposit | stake | refund | payout | withdrawal | withdrawal_reversal
  amount_cents INTEGER NOT NULL,
  pot_id TEXT,
  ref TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id);

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
  created_at TEXT NOT NULL
);

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
  created_at TEXT NOT NULL
);
