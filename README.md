# Stake

Put money on a health goal with your friends. Hit it and you get your stake back plus a cut of everyone
who quit. Miss it and your stake goes to the winners. Stake keeps a share of what's forfeited.

<img src="brand/stake-app-icon.png" alt="Stake" width="120">

| Part | Where |
|---|---|
| App (Expo / React Native, runs in Expo Go) | `App.js`, `src/` |
| Backend (Cloudflare Worker + D1) | `backend/` |
| Tests | `backend/test/run.mjs` (money logic + API), `backend/test/contract.mjs` (app <-> API) |

## How a pot works

1. Someone creates a pot: goal, 7/14/30 days, stake ($5-$100), up to 20 people. Their stake is locked immediately.
2. Friends join with a 6-letter code (or the `/j/<code>` link). Each stake is locked on joining.
3. The creator starts it once 2+ people are in. Everyone taps **I did it today** daily.
4. Friends can **dispute** a check-in that looks fake: a day is thrown out when a majority of the *other*
   members dispute it (2 disputes per person per pot).
5. You win if you miss at most 20% of days (hard mode: zero). 
6. When it ends (checked automatically every 30 min and whenever anyone opens the app):
   - some win, some lose: winners get their stake back + an equal share of the losers' stakes minus the rake
   - everyone wins: everyone is refunded, no rake
   - nobody wins: everyone gets 90% back; the house keeps 10%
   
   Every cent is a row in a ledger; settlement is one atomic batch with unique refs, so it cannot pay twice,
   and `sum(payouts) + rake = sum(stakes)` is fuzz-tested over thousands of random pots.

## Run it locally (about 5 minutes)

```
cd backend
npx wrangler d1 create stake                      # paste database_id into wrangler.toml
npx wrangler d1 execute stake --local --file=schema.sql
npx wrangler dev --ip 0.0.0.0                     # serves on :8787 in play-money mode
```
Then `bash setup.sh`, set `API_URL` in `stake-app/src/config.js` to `http://<your computer's LAN IP>:8787`,
and `cd ../stake-app && npx expo start`. Open it in Expo Go on two phones (or one phone + a second account
by reinstalling) to try a full pot. `DEMO_MODE = "true"` gives free play-money top-ups.

## Deploy

```
cd backend
npx wrangler d1 execute stake --remote --file=schema.sql
npx wrangler secret put ADMIN_SECRET
npx wrangler deploy                                # prints https://stake-api.<you>.workers.dev
```
Put that URL in `src/config.js`.

## Taking real money

1. In `wrangler.toml` set `DEMO_MODE = "false"`.
2. `npx wrangler secret put STRIPE_SECRET_KEY` (start with a **test** key).
3. In Stripe, add a webhook to `https://<your-worker>/api/stripe/webhook` for `checkout.session.completed`
   (and `checkout.session.async_payment_succeeded`), then `npx wrangler secret put STRIPE_WEBHOOK_SECRET`.
4. Top-ups use Stripe Checkout; the webhook credits the wallet exactly once per session (signature checked,
   duplicate deliveries ignored; all of this is tested, but only against a mocked Stripe, so run a test-mode
   payment end to end before going live).
5. Cash-outs: users request them in the app; you see them with
   `curl -H "x-admin-secret: $ADMIN_SECRET" https://<worker>/api/admin/withdrawals`, pay them (Stripe payout,
   bank transfer, etc.), then mark done:
   `curl -X POST -H "x-admin-secret: $ADMIN_SECRET" -d '{"status":"paid"}' https://<worker>/api/admin/withdrawals/<id>`
   (`"rejected"` puts the money back in the user's wallet).

Before real users: holding balances for people can count as money transmission, and paid contests have
state-by-state rules. `BLOCKED_STATES` (comma list, e.g. `"AZ,AR"`) refuses signup in states you decide not
to serve. Get a lawyer's read on both before launch; Stripe Connect is the usual way to avoid holding funds yourself.

## The business math

Stake earns `RAKE_BPS` (default 10%) of forfeited stakes. As an illustration, if 40% of stakes get forfeited,
$20k/month in rake needs about $500k/month in stakes. That's the honest scale: this is a volume and retention
game. Levers: raise `RAKE_BPS` (15-20% is common for this model), add a paid "pro" tier, and make pots
repeatable so winners and losers both run it back.

## Roadmap

- Auto-verification: Apple Health / Google Fit for sleep, steps and workouts (needs a development build)
- Photo proof stored in R2, and proof prompts per goal type
- Email / phone sign-in so an account survives a lost phone (today an account is tied to the device token)
- Push notifications: "3 days left, you're in the lead", "Ben just checked in"
- Real payouts through Stripe Connect instead of manual withdrawals
- Public pots and a leaderboard
