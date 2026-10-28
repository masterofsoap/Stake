# Stake

Put money on a health goal. Hit it and you get your stake back plus a cut of everyone who quit. Miss it and
your stake goes to the winners. Play with friends, or get matched with strangers from anywhere.

<img src="brand/stake-mark-lime.png" alt="Stake" width="120">

| Part | Where |
|---|---|
| App (Expo / React Native, runs in Expo Go) | `App.js`, `src/` |
| Backend (Cloudflare Worker + D1) | `backend/` |
| Tests (run in CI on every push) | `backend/test/` |

## Two ways to play

**Friends pots** — you make the pot (goal, 7/14/30 days, $5–$100, up to 20 people), share a 6-letter code or
link, and start it when everyone's in.

**Public pots** — tap *Play anyone*, pick goal + length + stake ($5/$10/$25/$50) and you're matched into an open
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

## Run it (3 commands)

You need [Node](https://nodejs.org) and the Expo Go app on your phone (same Wi-Fi as your computer).

```
git clone https://github.com/masterofsoap/Stake.git
cd Stake
bash run.sh
```
That sets up the database, starts the backend, seeds a few play-money players into public pots, builds the
app, and shows a QR code. Scan it with Expo Go, make an account (any name + password) and you start with $50
of play money. Tap **Play anyone** to join a pot.

Re-run `bash run.sh` any time. If it can't find your Wi-Fi address: `IP=192.168.1.23 bash run.sh`.

## Deploy to production

```
cd backend
npx wrangler d1 create stake                 # paste the database_id into backend/wrangler.toml
npm run db:remote
npx wrangler secret put ADMIN_SECRET
npm run deploy                               # prints https://stake-api.<you>.workers.dev
```
Then build the app for the stores:

```
API_URL=https://stake-api.<you>.workers.dev BUNDLE_ID=com.yourname.stake bash setup.sh
cd mobile
npx eas-cli build --platform all --profile production
npx eas-cli submit --platform all
```
(`eas.json` is included; `eas build` walks you through Apple/Google credentials the first time.)

### Real money checklist

1. `wrangler.toml`: `DEMO_MODE = "false"`, keep `RATE_LIMIT = "on"`, set `BLOCKED_STATES` for places you won't serve.
2. `npx wrangler secret put STRIPE_SECRET_KEY` (start with a **test** key).
3. Stripe webhook → `https://<worker>/api/stripe/webhook` for `checkout.session.completed`
   (and `checkout.session.async_payment_succeeded`), then `npx wrangler secret put STRIPE_WEBHOOK_SECRET`.
   Top-ups credit the wallet exactly once per session (signature checked, retries ignored). That's tested against
   a mocked Stripe, so run one test-mode payment end to end before going live.
4. Cash-outs are requested in the app and paid by you:
   `curl -H "x-admin-secret: $ADMIN_SECRET" https://<worker>/api/admin/withdrawals`, pay them, then
   `curl -X POST -H "x-admin-secret: $ADMIN_SECRET" -d '{"status":"paid"}' https://<worker>/api/admin/withdrawals/<id>`
   (`"rejected"` puts the money back in the wallet).
5. Real-money apps in the stores need the store's real-money-gaming approvals, and holding balances/paid
   contests have state-by-state rules. Have a lawyer look before launch; Stripe Connect is the usual route to
   not holding funds yourself.

### What's built in for production

- Fixed-window rate limits in D1: 120 writes/min/IP, 10 signups/hour/IP, 10 login attempts per 15 min per account,
  10 payment calls/min/user, 30 joins/min/user; 20 KB body cap
- Strict security headers (no-sniff, no-store, CSP + frame-deny on the web pages), display names stripped of markup
- Accounts: name + password (PBKDF2-hashed), one session per device, login attempts rate limited per account and per IP
- Race-safe money: atomic conditional charges (no overdraw), seat-taking only while a pot is open, idempotent
  settlement, refunds, and Stripe credits
- CI runs every test on each push (`.github/workflows/test.yml`)

## Tests

```
cd backend && bun test/run.mjs && bun test/public.mjs && bun test/contract.mjs && bun test/seed.mjs
```
`run.mjs` money rules, fuzz and API/Stripe flows · `public.mjs` matchmaking, auto-start, rollovers, refunds,
join races, results, leaderboard, login, rate limits · `contract.mjs` drives the app's real API client
against the Worker and checks every field the screens read.

## Business math

Stake keeps `RAKE_BPS` (default 10%) of forfeited stakes. If 40% of stakes get forfeited, $20k/month in rake
needs about $500k/month in stakes: this is a volume and retention game. Levers: the rake (15–20% is common),
repeat pots, and public-pot liquidity (the more players, the faster pots fill and start).

## Known limits and roadmap

- Check-ins are self-reported; the defense is majority dispute. Photo proof (R2) and Apple Health / Google Fit
  auto-verification are the next trust upgrades, and matter most for public pots with strangers.
- Player reporting/blocking and a name filter (display names are the only user-written text strangers see)
- Push notifications ("3 days left", "someone disputed you"), password reset by email
- Payouts through Stripe Connect instead of manual withdrawals
