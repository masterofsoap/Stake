import { API_URL } from './config';

async function call(path, { method = 'GET', token, body } = {}) {
  let res;
  try {
    res = await fetch(API_URL + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const err = new Error('network');
    err.status = 0;
    throw err;
  }
  let data = null;
  try {
    data = await res.json();
  } catch (e) {}
  if (!res.ok) {
    const err = new Error((data && data.error) || 'http_' + res.status);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const signup = (name, password, email) => call('/api/signup', { method: 'POST', body: { name, password, email, adult: true } });
export const logout = (t) => call('/api/logout', { method: 'POST', token: t });
// email a confirmation code; pass email to change the account's email first
export const sendCode = (t, email) => call('/api/email/send', { method: 'POST', token: t, body: email === undefined ? {} : { email } });
export const verifyCode = (t, code) => call('/api/email/verify', { method: 'POST', token: t, body: { code } });
export const forgotPassword = (email) => call('/api/password/forgot', { method: 'POST', body: { email } });
export const resetPassword = (email, code, password) => call('/api/password/reset', { method: 'POST', body: { email, code, password } });
export const login = (name, password) => call('/api/login', { method: 'POST', body: { name, password } });
export const me = (t) => call('/api/me', { token: t });
// currency: 'play' (free, never cashes out) or 'cash' (real money)
export const wallet = (t, currency = 'play') => call('/api/wallet?currency=' + currency, { token: t });
export const checkout = (t, amountCents, currency = 'play') => call('/api/wallet/checkout', { method: 'POST', token: t, body: { amountCents, currency } });
export const withdraw = (t, amountCents) => call('/api/wallet/withdraw', { method: 'POST', token: t, body: { amountCents } });
export const payoutSetup = (t) => call('/api/payouts/setup', { method: 'POST', token: t });
export const selfExclude = (t, days) => call('/api/me/exclude', { method: 'POST', token: t, body: { days } });
export const createPot = (t, body) => call('/api/pots', { method: 'POST', token: t, body });
export const joinPreview = (code) => call('/api/join/' + encodeURIComponent(code));
export const joinPot = (t, code) => call('/api/pots/join', { method: 'POST', token: t, body: { code } });
export const pot = (t, id) => call('/api/pots/' + id, { token: t });
export const startPot = (t, id) => call(`/api/pots/${id}/start`, { method: 'POST', token: t });
export const cancelPot = (t, id) => call(`/api/pots/${id}/cancel`, { method: 'POST', token: t });
export const leavePot = (t, id) => call(`/api/pots/${id}/leave`, { method: 'POST', token: t });
export const checkin = (t, id, note) => call(`/api/pots/${id}/checkin`, { method: 'POST', token: t, body: { note } });
export const dispute = (t, id, userId, date) => call(`/api/pots/${id}/dispute`, { method: 'POST', token: t, body: { userId, date } });
export const publicPots = (t, currency = 'play', goalType) =>
  call('/api/public?currency=' + currency + (goalType ? '&goalType=' + encodeURIComponent(goalType) : ''), { token: t });
export const playPublic = (t, body) => call('/api/public/play', { method: 'POST', token: t, body });
export const joinPublic = (t, id) => call(`/api/pots/${id}/join`, { method: 'POST', token: t });
export const leaderboard = (t, currency = 'play') => call('/api/leaderboard?currency=' + currency, { token: t });
