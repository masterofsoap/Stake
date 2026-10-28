-- Upgrade for databases created before play/cash wallets (fresh installs get all of this from schema.sql).
-- Everything recorded before this point was play money, which is what the defaults say.
--   local:  node dev.mjs does it      remote:  npm run db:migrate:remote:cash
ALTER TABLE users ADD COLUMN stripe_account_id TEXT;
ALTER TABLE users ADD COLUMN payouts_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN cash_locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN excluded_until TEXT;
ALTER TABLE ledger ADD COLUMN currency TEXT NOT NULL DEFAULT 'play';
ALTER TABLE pots ADD COLUMN currency TEXT NOT NULL DEFAULT 'play';
ALTER TABLE withdrawals ADD COLUMN transfer_id TEXT;
ALTER TABLE withdrawals ADD COLUMN note TEXT NOT NULL DEFAULT '';
ALTER TABLE results ADD COLUMN currency TEXT NOT NULL DEFAULT 'play';
DROP INDEX IF EXISTS idx_ledger_user;
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, currency);
CREATE TABLE IF NOT EXISTS stripe_payments (
  payment_intent TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
