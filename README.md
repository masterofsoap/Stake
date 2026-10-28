# Go Stake

Put money on a health goal. Hit it and you get your stake back plus a cut of everyone who quit. Miss it and
your stake goes to the winners. Play with friends, or get matched with strangers from anywhere.

<img src="brand/stake-mark-lime.png" alt="Go Stake" width="120">

Lives at **gostake.app**: the API at `api.gostake.app`, code emails from `hello@gostake.app`.

| Part | Where |
|---|---|
| App (Expo / React Native, runs in Expo Go) | `App.js`, `src/` |
| Backend (Cloudflare Worker + D1) | `backend/` |
| Tests (run in CI on every push) | `backend/test/` |

## Two ways to play (each in play money or real money)

**Friends pots** — tap *Start a pot*: you make it (goal, 7/14/30 days, $5–$100, up to 20 people), share a 6-letter code or
link, and start it when everyone's in.

**Public pots** — tap *Join a pot*, pick goal + length + stake ($5/$10/$25/$50) and you're matched into an open
pot with players from everywhere (or you open a lobby others fill). Public pots run themselves:
- starts the moment it hits 12 players, or on its start day (at least 12 hours out) if 2+ are in
- fewer than 2 on the day? The start slides a day, up to 3 times, then everyone is refunded
- you can leave any time before it starts for a full refund
- goals and stakes are server-defined, so strangers never see user-written text, only display names
- a global leaderboard ranks public-pot net winnings over the last 30 days

## Rules (both modes)

1. Tap **I did it today** every day. Missing at most 20% of days (hard mode: none) keeps you in.
2. Players can **dispute** a check-in that looks fake: a day is thrown out when a majority of the *other*
   members dispute it (2 disputes per person per pot).
3. When it ends (the server checks every 30 min and whenever anyone opens the app):
   - some win, some lose: winners get their stake back + an equal share of the losers' stakes minus the rake
   - everyone wins: everyone is refunded, no rake
   - nobody wins: everyone gets 90% back, the house keeps 10%

Every cent is a ledger row. Settlement is one atomic batch with unique refs, so it cannot pay twice, and
`sum(payouts) + rake = sum(stakes)` is fuzz-tested over thousands of random pots.

## Run it on your phone (Expo Go)

You need [Node](https://nodejs.org) 18+ and the Expo Go app on your phone (same Wi-Fi as your computer).
Works the same in PowerShell, Terminal or Git Bash.

```
git clone https://github.com/masterofsoap/Stake.git
cd Stake
node dev.mjs
```
That sets up the database, starts the backend, seeds a few play-money players into public pots, builds the
app, and shows a QR code. Scan it with Expo Go (Android) or the Camera app (iPhone), make an account (any name
and password), and you start with $50 of play money. The first run takes a few minutes; after that it's
seconds.

**Edit and see it live:** `dev.mjs` watches `App.js` and `src/` and copies every save into `mobile/`, so the
app reloads on your phone by itself. Ctrl+C stops everything.

| | |
|---|---|
| `node dev.mjs --cash` | Real-money screens on, no Stripe needed (fake cash, manual cash-outs, no location check) |
| `node dev.mjs cash <name> [dollars]` | Give an account fake real money (default $50), while `--cash` is running |
| `node dev.mjs --tunnel` | Phone on a different network, or the firewall is in the way: tunnels both the app and the backend |
| `node dev.mjs --ip 192.168.1.23` | Pick the address yourself (it lists the others it found) |
| `node dev.mjs --backend-only` | Just the API on :8787 |
| `node dev.mjs reset` | Wipe the local database |

In `--cash` mode the admin secret is `devsecret`, so you can approve cash-outs with
`curl -H "x-admin-secret: devsecret" http://localhost:8787/api/admin/withdrawals`.

**Phone can't connect?** Open the `Check` URL it prints in your phone's browser. If that doesn't load, it's
the network, not the app. On Windows that almost always means the firewall. Run this once in PowerShell as
Administrator, and set your Wi-Fi to Private:
`New-NetFirewallRule -DisplayName "Go Stake dev" -Direction Inbound -Protocol TCP -LocalPort 8787,8081 -Action Allow -Profile Private`.
Or just use `--tunnel`.

## Deploy to production

Do this in the Cloudflare account that holds gostake.app:

1. Workers Paid plan ($5/mo). Email to arbitrary addresses needs it.
2. Dashboard → **Compute → Email Service → Email Sending → Onboard Domain** → gostake.app. Cloudflare adds the
   SPF/DKIM/DMARC records itself (usually live in 5–15 minutes).
3. Then:
```
cd backend
npx wrangler login
npx wrangler d1 create stake                 # paste the database_id into backend/wrangler.toml
npm run db:remote
npx wrangler secret put ADMIN_SECRET
npm run deploy                               # serves https://api.gostake.app (DNS record created for you)
```
4. Sign up in the app with your own email and check the code arrives. If it doesn't, `npx wrangler tail` shows
   `email send failed <code>` with Cloudflare's reason (`E_SENDER_DOMAIN_NOT_AVAILABLE` = step 2 isn't done yet).

Then build the app for the stores:

```
API_URL=https://api.gostake.app BUNDLE_ID=app.gostake bash setup.sh
cd mobile
npx eas-cli build --platform all --profile production
npx eas-cli submit --platform all
```
(`eas.json` is included; `eas build` walks you through Apple/Google credentials the first time.)

### Real money

Every account has two wallets that never mix: **play money** (free, everyone, everywhere, never cashes out)
and **real money** (card deposits, cash pots, cash-outs). Every ledger row and every pot is tagged `play` or
`cash`; a play balance can never fund a cash pot, and play winnings can never be withdrawn. In the app it's
one toggle on the home screen, and every screen (play anyone, friends pots, wallet, leaderboard) follows it.
Cash stays hidden until you switch it on.

**Turn it on (Stripe test mode first):**

1. Stripe dashboard: turn on **Connect** (Settings → Connect, platform type, Express accounts).
2. `npx wrangler secret put STRIPE_SECRET_KEY` (an `sk_test_...` key to start)
3. Webhook 1 (platform): `https://<worker>/api/stripe/webhook`, events `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`, `charge.dispute.created`, then
   `npx wrangler secret put STRIPE_WEBHOOK_SECRET`
4. Webhook 2 (**Connected accounts**): same URL, event `account.updated`, then
   `npx wrangler secret put STRIPE_CONNECT_WEBHOOK_SECRET`
5. `npx wrangler secret put ADMIN_SECRET` (a long random string)
6. `wrangler.toml`: `CASH = "on"`, review `BLOCKED_STATES` with your lawyer, then `npm run deploy`
7. Run one deposit → pot → payout cycle end to end with Stripe test cards before you swap in the live key.

Already deployed before this version? Run `npm run db:migrate:remote:cash` once (`dev.mjs` upgrades the local DB itself).

**What happens:**

| | |
|---|---|
| Deposits | Stripe Checkout → webhook credits the cash wallet exactly once per session. Capped at `DEPOSIT_DAILY_CAP_CENTS` per rolling 24h. |
| Where | Cash needs a connection from `CASH_COUNTRIES` (US) and not from `BLOCKED_STATES`, using Cloudflare's geolocation of the request rather than anything the user types. Checked on deposit, creating, joining and matchmaking into cash pots. Withdrawals always work, so nobody's money gets stuck. |
| Cash-outs | The player taps **Set up cash-outs** once. Stripe's hosted Express onboarding verifies identity and bank, so we never store SSNs or bank details. After that a cash-out is a Stripe transfer to their account, with the withdrawal id as the idempotency key so it can't pay twice. Cash-outs over `WITHDRAW_AUTO_MAX_CENTS` wait for you. `PAYOUTS = "manual"` queues every cash-out instead, if you'd rather pay by hand. |
| Card fraud | New card deposits can't be withdrawn for `WITHDRAW_HOLD_HOURS` (winnings aren't held). A chargeback debits the wallet (it can go negative) and locks the account's cash until you unlock it. Play money keeps working. |
| Responsible play | **Take a break from real money** in the wallet: 1 day, 30 days or 6 months, can't be shortened. Adults only (18+ checkbox; Stripe verifies age at cash-out). |

**Admin** (all need header `x-admin-secret: $ADMIN_SECRET`):

```
GET  /api/admin/summary                      # deposits, paid out, owed in wallets, in live pots, rake, locked accounts
GET  /api/admin/withdrawals                  # the review queue, with the reason each one is waiting
POST /api/admin/withdrawals/<id>  {"status":"approve"}   # send it via Stripe now (safe to retry)
                                  {"status":"paid"}      # you paid it some other way
                                  {"status":"rejected"}  # money goes back to their wallet
POST /api/admin/users/<id>/unlock            # after a chargeback is sorted out
```
Reconcile `summary` against Stripe: deposits − paid out − rake = wallets + live pots. The rake stays in your
Stripe balance, and transfers to players are paid from that same balance.

**Before taking a real dollar**, get a lawyer to sign off on:
- **Contest law by state.** Paying winners out of other players' stakes is regulated as a paid-entry skill
  contest in some states and as gambling in others. `BLOCKED_STATES` ships with a commonly restricted list as a
  starting point, not legal advice. Some states also need registration, bonding or an age of 19 or 21.
- **Money transmission.** Holding player balances can make you a money transmitter. Stripe Connect moves the
  payouts, but you still hold the wallet balances, and some operators avoid wallets entirely by charging the
  stake at join and paying winners directly.
- **Stripe's terms.** Contests with prizes are a restricted business at Stripe, so get written approval for
  your account before going live, or it can be shut down and funds held.
- **App stores.** Apple and Google need real-money-contest approval, licensing proof, and geo-restriction
  inside the app.
- **Taxes.** 1099 reporting on player winnings (Stripe Connect can issue 1099s for Express accounts).

### Accounts and email

Every account has a display name, an **email** (lowercased, one account per address) and a password. People
log in with their name or email. A 6-digit code (hashed, 15 minutes, 5 tries) confirms the email and resets
forgotten passwords. Real money needs a confirmed email.

Code emails go out through **Cloudflare Email Service** from `hello@gostake.app` (`EMAIL_FROM`), via the
`EMAIL` binding in `wrangler.toml`. There is no API key to manage, just the one-time domain onboarding above. Each
email has a plain-text part and a branded HTML part.

`node dev.mjs` runs with `DEV_CODES=on`: nothing is emailed and the app shows the code on screen. Never set
`DEV_CODES` in production.

Already deployed? Run `npm run db:migrate:remote:email` once (and `db:migrate:remote:cash` if you deployed
before real money). Older accounts are asked for an email in the app.

### What's built in for production

- Fixed-window rate limits in D1: 120 writes/min/IP, 10 signups/hour/IP, 10 login attempts per 15 min per account,
  10 payment calls/min/user, 30 joins/min/user; 20 KB body cap
- Strict security headers (no-sniff, no-store, CSP + frame-deny on the web pages), display names stripped of markup
- Accounts: name, email and password (PBKDF2-hashed), one session per device, login attempts rate limited per account and per IP, emailed codes for confirmation and password reset, log out
- Race-safe money: atomic conditional charges (no overdraw), seat-taking only while a pot is open, idempotent
  settlement, refunds, Stripe credits and Stripe transfers
- Play and cash ledgers kept apart in every query, so tests check that no row ever crosses wallets
- CI runs every test on each push (`.github/workflows/test.yml`)

## Tests

```
cd backend && bun test/run.mjs && bun test/public.mjs && bun test/contract.mjs && bun test/seed.mjs
```
`run.mjs` money rules, fuzz, and real-money flows against a fake Stripe (geofence, deposits, Connect payouts, holds, chargebacks, self-exclusion, play/cash separation) · `public.mjs` matchmaking, auto-start, rollovers, refunds,
join races, results, leaderboard, login, rate limits · `contract.mjs` drives the app's real API client
against the Worker and checks every field the screens read.

## Business math

Go Stake keeps `RAKE_BPS` (default 10%) of forfeited stakes. If 40% of stakes get forfeited, $20k/month in rake
needs about $500k/month in stakes: this is a volume and retention game. Levers: the rake (15–20% is common),
repeat pots, and public-pot liquidity (the more players, the faster pots fill and start).

## Known limits and roadmap

- Check-ins are self-reported; the defense is majority dispute. Photo proof (R2) and Apple Health / Google Fit
  auto-verification are the next trust upgrades, and matter most for public pots with strangers.
- Player reporting/blocking and a name filter (display names are the only user-written text strangers see)
- Push notifications ("3 days left", "someone disputed you")
