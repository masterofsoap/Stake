// Pure game rules: no database, no network. Everything that touches money is decided here.

const pad = (n) => String(n).padStart(2, '0');
export const addDays = (str, n) => {
  const d = new Date(str + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
export const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);

export const DURATIONS = [7, 14, 30];
export const allowedMisses = (pot) => (pot.strict ? 0 : Math.floor(pot.duration_days * 0.2));

/**
 * Work out every member's progress.
 *   pot      { start_date, duration_days, strict }
 *   members  [{ user_id }]  in join order
 *   checks   [{ user_id, date }]
 *   disputes [{ claimant_id, date, disputer_id }]
 *   today    'YYYY-MM-DD' (UTC)
 * A day counts only if the member checked in AND fewer than a majority of the other members disputed it.
 */
export function analyze(pot, members, checks, disputes, today) {
  const n = members.length;
  const need = Math.floor((n - 1) / 2) + 1; // disputes needed to throw a day out
  const checked = new Set(checks.map((c) => `${c.user_id}|${c.date}`));
  const disputeCount = new Map();
  for (const d of disputes) {
    const k = `${d.claimant_id}|${d.date}`;
    disputeCount.set(k, (disputeCount.get(k) || 0) + 1);
  }
  const allowed = allowedMisses(pot);
  const out = {};
  for (const m of members) {
    const days = [];
    let valid = 0;
    let lost = 0; // days already gone for good
    let streak = 0;
    let run = 0;
    for (let i = 0; i < pot.duration_days; i++) {
      const date = addDays(pot.start_date, i);
      const has = checked.has(`${m.user_id}|${date}`);
      const dis = disputeCount.get(`${m.user_id}|${date}`) || 0;
      let status;
      if (has && dis < need) status = 'done';
      else if (has) status = 'disputed';
      else if (date > today) status = 'future';
      else if (date < addDays(today, -1)) status = 'missed'; // one day of slack for time zones
      else status = 'open';
      if (status === 'done') {
        valid += 1;
        run += 1;
        streak = run;
      } else {
        run = 0;
      }
      if (status === 'missed' || status === 'disputed') lost += 1;
      days.push({ date, status, disputes: dis });
    }
    out[m.user_id] = {
      days,
      valid,
      lost,
      streak,
      allowed,
      alive: lost <= allowed,
      finalMisses: pot.duration_days - valid, // used once the pot is over
    };
  }
  return out;
}

/**
 * Final payouts. Returns { entries: [{ user_id, type, amount_cents }], rake_cents, winners, losers }.
 * Conservation rule (tested): sum(entries) + rake_cents === total stakes, to the cent.
 */
export function settle(pot, members, progress, rakeBps) {
  const stake = pot.stake_cents;
  const total = stake * members.length;
  const winners = members.filter((m) => progress[m.user_id].finalMisses <= allowedMisses(pot));
  const losers = members.length - winners.length;
  const entries = [];
  let rake = 0;

  if (losers === 0) {
    for (const m of members) entries.push({ user_id: m.user_id, type: 'refund', amount_cents: stake });
  } else if (winners.length === 0) {
    // nobody made it: everyone gets most of their money back, the house keeps the rake share
    const back = Math.floor((stake * (10000 - rakeBps)) / 10000);
    for (const m of members) entries.push({ user_id: m.user_id, type: 'refund', amount_cents: back });
    rake = total - back * members.length;
  } else {
    const forfeits = stake * losers;
    rake = Math.floor((forfeits * rakeBps) / 10000);
    const pool = forfeits - rake;
    const share = Math.floor(pool / winners.length);
    let extra = pool - share * winners.length; // leftover cents go to the earliest joiners
    for (const m of winners) {
      const bonus = extra > 0 ? 1 : 0;
      extra -= bonus;
      entries.push({ user_id: m.user_id, type: 'payout', amount_cents: stake + share + bonus });
    }
  }
  return { entries, rake_cents: rake, winners: winners.length, losers };
}

export const GOAL_TYPES = ['quit', 'sleep', 'move', 'sober', 'eat', 'custom'];
