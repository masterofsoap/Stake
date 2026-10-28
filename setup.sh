#!/usr/bin/env bash
# Run from the folder containing this file. Creates a fresh Expo app (so versions always match your
# Expo Go), then drops the Stake source and assets into it.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/.."
npx create-expo-app@latest stake-app --template blank
cp "$HERE/App.js" stake-app/App.js
rm -rf stake-app/src && cp -R "$HERE/src" stake-app/src
mkdir -p stake-app/assets && cp "$HERE"/assets/* stake-app/assets/
cp "$HERE/eas.json" stake-app/eas.json
cd stake-app
npx expo install @react-native-async-storage/async-storage

# app name, dark theme, icon + splash colors (handles both old and new Expo config layouts)
node -e '
const fs = require("fs");
const j = JSON.parse(fs.readFileSync("app.json", "utf8"));
const e = j.expo || (j.expo = {});
e.name = "Stake";
e.userInterfaceStyle = "dark";
e.slug = "stake";
const bid = process.env.BUNDLE_ID || "com.example.stake";
e.ios = Object.assign({}, e.ios, { bundleIdentifier: bid, supportsTablet: false });
e.android = Object.assign({}, e.android, { package: bid });
if (e.splash) e.splash.backgroundColor = "#0B0F0D";
e.plugins = (e.plugins || []).map((p) =>
  Array.isArray(p) && p[0] === "expo-splash-screen" ? [p[0], Object.assign({}, p[1], { backgroundColor: "#0B0F0D" })] : p
);
e.android = Object.assign({}, e.android, { adaptiveIcon: Object.assign({}, (e.android || {}).adaptiveIcon, { backgroundColor: "#0B0F0D" }) });
fs.writeFileSync("app.json", JSON.stringify(j, null, 2));
'
echo ""
echo "Bundle id is ${BUNDLE_ID:-com.example.stake} (re-run with BUNDLE_ID=com.yourname.stake to set your own before building for the stores)."
echo "Done. 1) put your API URL in stake-app/src/config.js   2) cd stake-app && npx expo start"
