// Puts a few play-money players into public pots so there is something to join on your first run.
// Safe to run again: it does nothing if public pots already exist.
import { pathToFileURL } from 'url';

export async function seed(base, log = console.log) {
  const call = async (path, { method = 'GET', token, body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'http_' + res.status), { status: res.status });
    return data;
  };
  const PASS = 'bot-pass-1234';
  const player = async (name) => {
    try {
      return await call('/api/login', { method: 'POST', body: { name, password: PASS } });
    } catch (e) {
      return call('/api/signup', { method: 'POST', body: { name, password: PASS, adult: true, email: name.toLowerCase() + '@bots.example.com' } });
    }
  };
  const first = await player('Mia');
  if ((await call('/api/public', { token: first.token })).pots.length) {
    log('seed: public pots already exist, skipping');
    return 0;
  }
  const plan = [
    ['Mia', 'move', 7, 1000],
    ['Jay', 'move', 7, 1000],
    ['Kobe', 'sleep', 7, 500],
    ['Rae', 'sleep', 7, 500],
    ['Theo', 'quit', 14, 2500],
  ];
  let n = 0;
  for (const [name, goalType, durationDays, stakeCents] of plan) {
    const p = name === 'Mia' ? first : await player(name);
    await call('/api/public/play', { method: 'POST', token: p.token, body: { goalType, durationDays, stakeCents } });
    n++;
  }
  log(`seed: ${n} play-money players joined public pots`);
  return n;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seed(process.argv[2] || 'http://127.0.0.1:8787').catch((e) => {
    console.log('seed skipped:', e.message);
  });
}
