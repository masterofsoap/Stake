#!/usr/bin/env bash
# Builds ./mobile (a fresh Expo app, so versions match your Expo Go) and copies Stake into it.
# Re-run any time: it refreshes the source and keeps node_modules.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ ! -d mobile ]; then
  npx --yes create-expo-app@latest mobile --template blank
  (cd mobile && npx expo install @react-native-async-storage/async-storage expo-linear-gradient expo-font @expo-google-fonts/poppins)
  node scripts/patch-app-json.js mobile/app.json
fi
cp App.js mobile/App.js
rm -rf mobile/src && cp -R src mobile/src
mkdir -p mobile/assets && cp assets/* mobile/assets/
cp eas.json mobile/eas.json
# point the app at the backend
printf "export const API_URL = '%s';\n" "${API_URL:-}" > mobile/src/config.js
