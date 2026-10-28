#!/usr/bin/env bash
# One command: database + backend + app. Scan the QR code with Expo Go.
cd "$(dirname "$0")"
ROOT="$PWD"
PORT=8787

command -v node >/dev/null || { echo "Install Node first (the LTS version): https://nodejs.org"; exit 1; }

detect_ip() {
  local i
  if [ -n "$IP" ]; then echo "$IP"; return; fi
  i=$(ipconfig getifaddr en0 2>/dev/null); [ -n "$i" ] && { echo "$i"; return; }
  i=$(ipconfig getifaddr en1 2>/dev/null); [ -n "$i" ] && { echo "$i"; return; }
  i=$(hostname -I 2>/dev/null | awk '{print $1}'); [ -n "$i" ] && { echo "$i"; return; }
  i=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(k=1;k<=NF;k++) if($k=="src"){print $(k+1); exit}}'); [ -n "$i" ] && { echo "$i"; return; }
}
LAN=$(detect_ip)
if [ -z "$LAN" ]; then
  echo "Couldn't find your Wi-Fi IP. Run it like this instead:  IP=192.168.1.23 bash run.sh"
  exit 1
fi

echo "==> 1/4 Backend packages"
(cd backend && [ -d node_modules ] || npm install --no-audit --no-fund) || exit 1

echo "==> 2/4 Database"
(cd backend && npx --no-install wrangler d1 execute stake --local --file=schema.sql >/dev/null) || { echo "Database setup failed"; exit 1; }

up() { curl -fs "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; }
BPID=""
if up; then
  echo "==> 3/4 Backend already running on :$PORT, reusing it"
else
  echo "==> 3/4 Starting backend"
  (cd backend && exec npx --no-install wrangler dev --ip 0.0.0.0 --port $PORT >"$ROOT/backend.log" 2>&1) &
  BPID=$!
  for i in $(seq 1 90); do up && break; sleep 1; done
  if ! up; then echo "Backend didn't start. Last log lines:"; tail -20 "$ROOT/backend.log"; exit 1; fi
fi
trap '[ -n "$BPID" ] && { pkill -P "$BPID" 2>/dev/null; kill "$BPID" 2>/dev/null; }' EXIT INT TERM
node scripts/seed.mjs "http://127.0.0.1:$PORT"

echo "==> 4/4 App"
API_URL="http://$LAN:$PORT" bash scripts/prepare-app.sh || exit 1
echo
echo "Open Expo Go on your phone (same Wi-Fi as this computer) and scan the QR code below."
echo "Make an account with any name + password. You start with \$50 of play money."
echo
cd mobile && REACT_NATIVE_PACKAGER_HOSTNAME="$LAN" npx expo start --lan
