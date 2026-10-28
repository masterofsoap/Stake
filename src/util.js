export const fmt = (cents) => {
  const n = (cents || 0) / 100;
  const neg = n < 0;
  const abs = Math.abs(n);
  return (neg ? '-' : '') + '$' + (Number.isInteger(abs) ? abs.toFixed(0) : abs.toFixed(2));
};

export const STAKES = [500, 1000, 2500, 5000, 10000];
export const DURATIONS = [7, 14, 30];
export const PUBLIC_STAKES = [500, 1000, 2500, 5000];

export const GOALS = [
  { type: 'quit', emoji: '🚭', label: 'Quit nicotine', text: 'Stayed nicotine-free today', name: 'Quit Crew' },
  { type: 'sleep', emoji: '😴', label: 'Sleep', text: 'In bed on time, 7+ hours', name: 'Sleep Club' },
  { type: 'move', emoji: '🏃', label: 'Move', text: '30 minutes of exercise', name: 'Move Squad' },
  { type: 'sober', emoji: '🍺', label: 'Stay sober', text: 'No alcohol today', name: 'Dry Run' },
  { type: 'eat', emoji: '🥗', label: 'Eat clean', text: 'Ate clean all day', name: 'Clean Plate' },
  { type: 'custom', emoji: '🎯', label: 'Your own', text: '', name: '' },
];

const ERRORS = {
  network: "Can't reach the server. Check your connection.",
  unauthorized: 'Please sign in again.',
  insufficient_funds: 'Not enough in your wallet. Add money first.',
  full: 'That pot is full.',
  not_open: "That pot has already started or closed.",
  already_joined: "You're already in that pot.",
  bad_code: "That code doesn't match any pot.",
  need_two_members: 'You need at least 2 people in the pot to start.',
  must_be_18: 'Stake is for adults 18 and over.',
  not_available_in_state: "Stake isn't available in your state yet.",
  bad_request: 'Something in that form looks off.',
  bad_amount: "That amount isn't allowed.",
  bad_date: "That day can't be checked in.",
  no_disputes_left: "You've used both of your disputes in this pot.",
  not_configured: 'Payments are not set up on the server yet.',
  forbidden: 'Only the person who made the pot can do that.',
  bad_login: 'Wrong name or password.',
  name_taken: 'That name is taken. Pick another, or log in if it is yours.',
  bad_password: 'Use a password with at least 4 characters.',
  bad_name: 'Pick a name with at least 2 characters.',
  rate_limited: 'Slow down a little and try again in a minute.',
  public_auto: 'Public pots start on their own.',
  too_large: 'That request was too big.',
  server_error: 'Our server hiccuped. Try again.',
};
export const errMsg = (e) => ERRORS[e && e.message] || 'Something went wrong. Try again.';

export const dayStatusColor = (s, C) =>
  ({ done: C.lime, missed: C.red, disputed: C.orange, open: 'transparent', future: C.line }[s] || C.line);

export const TYPE_LABEL = {
  deposit: 'Added money',
  stake: 'Stake locked in',
  refund: 'Stake returned',
  payout: 'Pot winnings',
  withdrawal: 'Withdrawal',
  withdrawal_reversal: 'Withdrawal reversed',
};
