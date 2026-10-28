// Brand the generated Expo app: name, dark theme, colors, bundle ids.
const fs = require('fs');
const file = process.argv[2];
const j = JSON.parse(fs.readFileSync(file, 'utf8'));
const e = j.expo || (j.expo = {});
const bid = process.env.BUNDLE_ID || 'com.example.stake';
e.name = 'Stake';
e.slug = 'stake';
e.userInterfaceStyle = 'dark';
if (e.splash) e.splash.backgroundColor = '#0B0F0D';
e.plugins = (e.plugins || []).map((p) =>
  Array.isArray(p) && p[0] === 'expo-splash-screen' ? [p[0], Object.assign({}, p[1], { backgroundColor: '#0B0F0D' })] : p
);
e.ios = Object.assign({}, e.ios, { bundleIdentifier: bid, supportsTablet: false });
e.android = Object.assign({}, e.android, {
  package: bid,
  adaptiveIcon: Object.assign({}, (e.android || {}).adaptiveIcon, { backgroundColor: '#0B0F0D' }),
});
fs.writeFileSync(file, JSON.stringify(j, null, 2));
