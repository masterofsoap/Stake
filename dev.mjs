// Run Go Stake on your phone with Expo Go: database + backend + app, live-synced. Works on Windows, macOS, Linux.
//
//   node dev.mjs                  start everything, show the QR code
//   node dev.mjs --cash           same, with real-money screens on (no Stripe needed: fake cash, manual cash-outs)
//   node dev.mjs --tunnel         phone on another network, or the firewall won't cooperate
//   node dev.mjs --ip 192.168.1.23    pick the address yourself
//   node dev.mjs --backend-only   just the API on :8787
//   node dev.mjs cash <name> [dollars]    give an account fake real-money (default $50)
//   node dev.mjs reset            wipe the local database
//
// Edits to App.js and src/ are copied into mobile/ as you save, so the app reloads on your phone by itself.
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { seed } from './scripts/seed.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(ROOT, 'backend');
const MOBILE = path.join(ROOT, 'mobile');
const STATE = path.join(BACKEND, '.wrangler');
const WIN = process.platform === 'win32';
const ADMIN_SECRET = 'devsecret';

/* ---------- args ---------- */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const opt = (name) => {
  const i = argv.findIndex((a) => a === '--' + name || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  return argv[i].includes('=') ? argv[i].split('=')[1] : argv[i + 1];
};
const cmd = flag('help') || argv[0] === '-h' ? 'help' : argv[0] && !argv[0].startsWith('--') ? argv[0] : 'start';
const PORT = Number(opt('port') || 8787);
// outside .wrangler/, which wrangler cleans up on its own
const PID_FILE = path.join(os.tmpdir(), `stake-dev-${PORT}.pid`);

/* ---------- helpers ---------- */

const say = (m) => console.log(`\x1b[32m==>\x1b[0m ${m}`);
const warn = (m) => console.log(`\x1b[33m!!\x1b[0m  ${m}`);
const die = (m) => {
  console.log(`\x1b[31mxx\x1b[0m  ${m}`);
  process.exit(1);
};
// shell: true so npx/npm resolve to their .cmd shims on Windows
const sh = (command, args, o = {}) => spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: true, ...o });
const quiet = (command, args, o = {}) => sh(command, args, { stdio: 'pipe', encoding: 'utf8', ...o });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function healthy(base) {
  try {
    const r = await fetch(base + '/health', { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

// Wi-Fi/Ethernet IPv4 addresses, best guess first. Skips VPNs, WSL, Docker and VM adapters.
function lanIps() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|WSL|VirtualBox|VMware|Hyper-V|docker|^br-|^veth|utun|tailscale|zerotier|loopback|bluetooth/i.test(name)) continue;
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && !a.address.startsWith('169.254.')) out.push({ name, address: a.address });
    }
  }
  const rank = ({ name, address }) =>
    (/wi-?fi|wlan|wireless|^en0$/i.test(name) ? 0 : 10) + (address.startsWith('192.168.') ? 0 : address.startsWith('10.') ? 1 : 2);
  return out.sort((x, y) => rank(x) - rank(y));
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (WIN) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid);
    } catch {}
  }
}
// Is `pid` still the backend we started? PIDs get reused, so a stale pid file must never kill a stranger.
function ours(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const r = WIN
    ? spawnSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: 'utf8' })
    : spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  return /wrangler/.test(r.stdout || '');
}

function d1(args) {
  return quiet('npx', ['--no-install', 'wrangler', 'd1', 'execute', 'stake', '--local', ...args], { cwd: BACKEND });
}

/* ---------- steps ---------- */

function ensureBackendDeps() {
  if (fs.existsSync(path.join(BACKEND, 'node_modules', 'wrangler'))) return;
  say('Installing backend packages (first run only)');
  if (sh('npm', ['install', '--no-audit', '--no-fund'], { cwd: BACKEND }).status !== 0) die('npm install failed in backend/');
}

// [a query that fails on databases from before the change, the upgrade for them]
const MIGRATIONS = [
  ['SELECT currency FROM ledger LIMIT 1', 'migrations/cash.sql'],
  ['SELECT email FROM users LIMIT 1', 'migrations/email.sql'],
];
function ensureDatabase() {
  say('Database');
  // an existing database gets its upgrades first, since schema.sql indexes the new columns
  if (d1(['--command', '"SELECT 1 FROM users LIMIT 1"']).status === 0) {
    for (const [probe, file] of MIGRATIONS) {
      if (d1(['--command', `"${probe}"`]).status === 0) continue;
      say('Upgrading database: ' + file);
      const m = d1(['--file=' + file]);
      if (m.status !== 0) die('Database upgrade failed:\n' + (m.stderr || m.stdout));
    }
  }
  const r = d1(['--file=schema.sql']);
  if (r.status !== 0) die('Database setup failed:\n' + (r.stderr || r.stdout));
}

async function startBackend() {
  const base = `http://127.0.0.1:${PORT}`;
  // a backend we started last time (maybe with other flags): replace it
  if (fs.existsSync(PID_FILE)) {
    const old = Number(fs.readFileSync(PID_FILE, 'utf8'));
    if (ours(old)) {
      say('Stopping the backend from last time');
      killTree(old);
      for (let i = 0; i < 20 && (await healthy(base)); i++) await sleep(250);
    }
    fs.rmSync(PID_FILE, { force: true });
  }
  if (await healthy(base)) {
    warn(`Something is already serving :${PORT} and it wasn't started by dev.mjs. Using it as-is (flags like --cash won't apply).`);
    warn('Close that terminal, or pass --port 8788, to get a fresh one.');
    return null;
  }

  // DEV_CODES: no email/SMS provider locally, so verification and reset codes are shown in the app instead
  const vars = flag('cash')
    ? { CASH: 'on', GEOFENCE: 'off', PAYOUTS: 'manual', WITHDRAW_HOLD_HOURS: '0', ADMIN_SECRET, DEV_CODES: 'on' }
    : { ADMIN_SECRET, DEV_CODES: 'on' };
  const args = ['--no-install', 'wrangler', 'dev', '--ip', '0.0.0.0', '--port', String(PORT), ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])];
  say(`Starting backend on :${PORT}${flag('cash') ? ' (real-money screens ON, fake cash only)' : ''}`);
  const log = fs.openSync(path.join(ROOT, 'backend.log'), 'w');
  const child = spawn('npx', args, { cwd: BACKEND, stdio: ['ignore', log, log], shell: true, detached: !WIN });
  fs.writeFileSync(PID_FILE, String(child.pid));
  for (let i = 0; i < 120; i++) {
    if (await healthy(base)) return child;
    if (child.exitCode !== null) break;
    await sleep(500);
  }
  const tail = fs.readFileSync(path.join(ROOT, 'backend.log'), 'utf8').split('\n').slice(-20).join('\n');
  killTree(child.pid);
  die(`Backend didn't start. Last lines of backend.log:\n${tail}`);
}

// Public HTTPS URL for the backend, through a free Cloudflare quick tunnel (no account needed).
async function tunnelBackend(children) {
  say('Opening a tunnel to the backend (cloudflared)');
  const child = spawn('npx', ['--yes', 'cloudflared', 'tunnel', '--url', `http://localhost:${PORT}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: true, detached: !WIN });
  children.push(child);
  return new Promise((resolve) => {
    let buf = '';
    const t = setTimeout(() => die('Tunnel did not come up in 60s. Try again, or drop --tunnel.'), 60000);
    const on = (d) => {
      buf += d;
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) {
        clearTimeout(t);
        resolve(m[0]);
      }
    };
    child.stdout.on('data', on);
    child.stderr.on('data', on);
  });
}

// native-side packages the app imports (all of them ship inside Expo Go)
const APP_DEPS = ['@react-native-async-storage/async-storage', 'expo-linear-gradient', 'expo-font', '@expo-google-fonts/poppins'];
function ensureMobile() {
  if (!fs.existsSync(path.join(MOBILE, 'package.json'))) {
    say('Creating the Expo app in mobile/ (first run only, a few minutes)');
    if (sh('npx', ['--yes', 'create-expo-app@latest', 'mobile', '--template', 'blank']).status !== 0) die('create-expo-app failed');
  }
  sh('node', ['scripts/patch-app-json.js', 'mobile/app.json']); // name, icon colors, bundle id: cheap, so every run
  const missing = APP_DEPS.filter((d) => !fs.existsSync(path.join(MOBILE, 'node_modules', ...d.split('/'))));
  if (missing.length) {
    say('Installing app packages: ' + missing.join(', '));
    if (sh('npx', ['expo', 'install', ...missing], { cwd: MOBILE }).status !== 0) die('expo install failed');
  }
}

// Copy the app source into mobile/. mobile/src/config.js is generated (it holds API_URL), so it's left alone.
function syncAll(apiUrl) {
  fs.copyFileSync(path.join(ROOT, 'App.js'), path.join(MOBILE, 'App.js'));
  const dst = path.join(MOBILE, 'src');
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'src'), dst, { recursive: true, filter: (p) => path.basename(p) !== 'config.js' || path.dirname(p) !== path.join(ROOT, 'src') });
  fs.writeFileSync(path.join(dst, 'config.js'), `export const API_URL = '${apiUrl}';\n`);
  fs.cpSync(path.join(ROOT, 'assets'), path.join(MOBILE, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'eas.json'), path.join(MOBILE, 'eas.json'));
}

function watchSource() {
  const pending = new Map();
  const copy = (rel) => {
    clearTimeout(pending.get(rel));
    pending.set(
      rel,
      setTimeout(() => {
        const from = path.join(ROOT, rel);
        const to = path.join(MOBILE, rel);
        if (rel === path.join('src', 'config.js')) return;
        try {
          if (fs.existsSync(from) && fs.statSync(from).isFile()) {
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.copyFileSync(from, to);
            console.log(`   synced ${rel.replace(/\\/g, '/')}`);
          } else if (!fs.existsSync(from)) {
            fs.rmSync(to, { force: true, recursive: true });
          }
        } catch {}
      }, 80)
    );
  };
  fs.watch(path.join(ROOT, 'App.js'), () => copy('App.js'));
  fs.watch(path.join(ROOT, 'src'), { recursive: true }, (_e, f) => f && copy(path.join('src', f)));
}

function printWindowsFirewallTip() {
  if (!WIN) return;
  console.log(`
   Phone can't connect? Windows Firewall is the usual cause. Fix it once, in PowerShell as Administrator:
     New-NetFirewallRule -DisplayName "Go Stake dev" -Direction Inbound -Protocol TCP -LocalPort ${PORT},8081 -Action Allow -Profile Private
   and make sure your Wi-Fi is set to Private (Settings > Network > Wi-Fi > your network).
   Or skip all that: node dev.mjs --tunnel`);
}

/* ---------- commands ---------- */

async function start() {
  if (Number(process.versions.node.split('.')[0]) < 18) die('Node 18 or newer needed: https://nodejs.org');
  const children = [];
  let backend = null;
  const cleanup = () => {
    for (const c of children) killTree(c.pid);
    if (backend) {
      killTree(backend.pid);
      fs.rmSync(PID_FILE, { force: true });
    }
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('exit', cleanup);

  const tunnel = flag('tunnel');
  const ips = lanIps();
  const ip = opt('ip') || process.env.IP || (ips[0] && ips[0].address);
  if (!ip && !tunnel && !flag('backend-only')) die("Couldn't find your Wi-Fi address. Pass it: node dev.mjs --ip 192.168.1.23   (or use --tunnel)");

  ensureBackendDeps();
  ensureDatabase();
  backend = await startBackend();
  try {
    await seed(`http://127.0.0.1:${PORT}`, (m) => say(m.replace(/^seed: /, 'Seed: ')));
  } catch (e) {
    warn('Seeding skipped: ' + e.message);
  }

  if (flag('backend-only')) {
    say(`Backend running: http://${ip || 'localhost'}:${PORT}   (Ctrl+C to stop, log in backend.log)`);
    return new Promise(() => {});
  }

  const apiUrl = tunnel ? await tunnelBackend(children) : `http://${ip}:${PORT}`;
  ensureMobile();
  syncAll(apiUrl);
  watchSource();

  console.log(`
   Backend   ${apiUrl}${tunnel ? '' : `\n   Check     open ${apiUrl}/health in your phone's browser. If it loads, the app will connect.`}
   Mode      ${flag('cash') ? 'play money + real-money screens (fake cash: node dev.mjs cash <name>)' : 'play money (add --cash for the real-money screens)'}
   Live      edits to App.js and src/ reload on the phone as you save`);
  if (!tunnel) {
    if (ips.length > 1 && !opt('ip')) console.log(`   Other addresses: ${ips.slice(1).map((i) => `${i.address} (${i.name})`).join(', ')}. Wrong one? --ip <address>`);
    printWindowsFirewallTip();
  }
  console.log(`\n   Scan the QR code with Expo Go (Android) or the Camera app (iPhone). Make any account: you start with $50 of play money.\n`);

  const expo = spawn('npx', ['expo', 'start', tunnel ? '--tunnel' : '--lan'], {
    cwd: MOBILE,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ...(tunnel ? {} : { REACT_NATIVE_PACKAGER_HOSTNAME: ip }) },
  });
  expo.on('exit', (code) => process.exit(code || 0));
}

function giveCash() {
  const name = (argv[1] || '').toLowerCase();
  const dollars = Number(argv[2] || 50);
  if (!name || !(dollars > 0 && dollars <= 10000)) die('Usage: node dev.mjs cash <account name> [dollars]');
  ensureBackendDeps();
  const cents = Math.round(dollars * 100);
  const ref = 'dev-' + Date.now();
  if (!/^[a-z0-9 _.-]+$/.test(name)) die('Use the account name as you typed it in the app (letters, numbers, spaces).');
  // local D1 doesn't report row counts, so look the account up first
  const found = d1(['--json', '--command', JSON.stringify(`SELECT id FROM users WHERE username = '${name}'`)]);
  if (found.status !== 0) die('Failed:\n' + (found.stderr || found.stdout));
  const m = found.stdout.match(/"id":\s*"(u_[0-9a-f]+)"/);
  if (!m) die(`No account named "${name}". Make it in the app first.`);
  const sql = `INSERT INTO ledger (user_id, type, amount_cents, currency, ref, created_at) VALUES ('${m[1]}', 'deposit', ${cents}, 'cash', '${ref}', '${new Date().toISOString()}')`;
  const r = d1(['--command', JSON.stringify(sql)]);
  if (r.status !== 0) die('Failed:\n' + (r.stderr || r.stdout));
  say(`Gave ${name} $${dollars} of fake real money. Pull down on the home screen to refresh.`);
  console.log('   (Only visible when the backend runs with --cash.)');
}

function reset() {
  const d1Dir = path.join(STATE, 'state', 'v3', 'd1');
  if (fs.existsSync(PID_FILE) && ours(Number(fs.readFileSync(PID_FILE, 'utf8')))) die('Stop the running dev.mjs first (Ctrl+C), then reset.');
  fs.rmSync(d1Dir, { recursive: true, force: true });
  say('Local database wiped. The next start creates a fresh one with seed players.');
}

if (cmd === 'start') await start();
else if (cmd === 'cash') giveCash();
else if (cmd === 'reset') reset();
else {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 11).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}
