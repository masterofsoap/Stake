import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Platform,
  StatusBar,
  Share,
  Linking,
  Alert,
  RefreshControl,
  KeyboardAvoidingView,
  Image,
  Switch,
  BackHandler,
  useWindowDimensions,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { useFonts, Poppins_400Regular, Poppins_500Medium, Poppins_600SemiBold, Poppins_700Bold, Poppins_800ExtraBold } from '@expo-google-fonts/poppins';
import * as api from './src/api';
import { API_URL } from './src/config';
import { fmt, fmtDate, errMsg, GOALS, STAKES, DURATIONS, PUBLIC_STAKES, TYPE_LABEL } from './src/util';

const KEY = 'stake:v1';
const MODE_KEY = 'stake:mode';
// mode = which wallet the screens use: 'play' (free, never cashes out) or 'cash' (real money)
const MONEY = { play: 'Play money', cash: 'Real money' };
const MARK = require('./assets/stake-mark-lime.png');
const CHIP = require('./assets/stake-mark-white.png'); // tinted per goal

const T = {
  ink: '#0A0C0B',
  surface: '#141815',
  raised: '#1D221E',
  line: '#272D28',
  text: '#F4F6EF',
  muted: '#A0A79F',
  faint: '#646B64',
  lime: '#C6F135',
  loss: '#FF6B57',
  warn: '#FFB23F',
};
// Poppins is the face of the logo's wordmark. Each weight is its own family (fontWeight is ignored on Android).
const F = { r: 'Poppins_400Regular', m: 'Poppins_500Medium', s: 'Poppins_600SemiBold', b: 'Poppins_700Bold', x: 'Poppins_800ExtraBold' };
// Every goal has its own chip color.
const GOAL_COLOR = { quit: '#FF8A3D', sleep: '#A28CFF', move: '#C6F135', sober: '#4CC2FF', eat: '#3DDC97', custom: '#FF5FA2' };
const goalColor = (type) => GOAL_COLOR[type] || GOAL_COLOR.custom;
const alpha = (hex, a) => hex + Math.round(a * 255).toString(16).padStart(2, '0');
const PALETTE = Object.values(GOAL_COLOR);
const nameColor = (name) => PALETTE[[...String(name)].reduce((h, c) => h + c.charCodeAt(0), 0) % PALETTE.length];
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/* ---------- building blocks ---------- */

const Btn = ({ title, onPress, kind = 'primary', disabled, color, style }) => (
  <TouchableOpacity
    activeOpacity={0.85}
    disabled={disabled}
    onPress={onPress}
    style={[kind === 'primary' ? [s.btn, color && { backgroundColor: color }] : kind === 'secondary' ? s.btnSecondary : s.btnGhost, disabled && { opacity: 0.35 }, style]}
  >
    <Text style={kind === 'primary' ? s.btnLabel : kind === 'secondary' ? s.btnSecondaryLabel : [s.btnGhostLabel, kind === 'danger' && { color: T.loss }]}>{title}</Text>
  </TouchableOpacity>
);

const Wordmark = ({ size = 26 }) => (
  <View style={s.wordmark}>
    <Image source={MARK} style={{ width: size, height: size, marginRight: 8 }} resizeMode="contain" />
    <Text style={[s.wordmarkText, { fontSize: size * 0.62 }]}>
      <Text style={{ color: T.lime }}>GO </Text>STAKE
    </Text>
  </View>
);

const Chip = ({ color, size = 40 }) => (
  <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: alpha(color, 0.16), alignItems: 'center', justifyContent: 'center' }}>
    <Image source={CHIP} style={{ width: size * 0.66, height: size * 0.66, tintColor: color }} resizeMode="contain" />
  </View>
);

const Avatar = ({ name, size = 36 }) => {
  const c = nameColor(name);
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: alpha(c, 0.2), alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: c, fontFamily: F.b, fontSize: size * 0.42 }}>{String(name || '?').slice(0, 1).toUpperCase()}</Text>
    </View>
  );
};

const Bar = ({ value, color = T.lime, style }) => (
  <View style={[s.bar, style]}>
    <View style={[s.barFill, { width: `${Math.max(4, Math.min(100, value * 100))}%`, backgroundColor: color }]} />
  </View>
);

const Tick = ({ color = T.ink, size = 12 }) => (
  <View style={{ width: size * 0.55, height: size, borderRightWidth: 2.5, borderBottomWidth: 2.5, borderColor: color, transform: [{ rotate: '45deg' }], marginTop: -size * 0.2 }} />
);

function Segmented({ options, value, onChange, style }) {
  return (
    <View style={[s.seg, style]}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <TouchableOpacity key={String(o.value)} onPress={() => onChange(o.value)} style={[s.segItem, on && s.segOn]} activeOpacity={0.85}>
            <Text style={[s.segLabel, on && s.segLabelOn]} numberOfLines={1}>
              {o.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const Field = ({ label, hint, style, ...input }) => (
  <View style={{ marginBottom: 16 }}>
    {label ? <Text style={s.fieldLabel}>{label}</Text> : null}
    <TextInput placeholderTextColor={T.faint} autoCorrect={false} style={[s.input, style]} {...input} />
    {hint ? <Text style={s.fieldHint}>{hint}</Text> : null}
  </View>
);

const Checkbox = ({ checked, onPress, label }) => (
  <TouchableOpacity onPress={onPress} style={s.checkRow} activeOpacity={0.8}>
    <View style={[s.checkBox, checked && s.checkBoxOn]}>{checked ? <Tick size={11} /> : null}</View>
    <Text style={s.body}>{label}</Text>
  </TouchableOpacity>
);

// Six boxes over one hidden input, so typing and pasting both just work.
function CodeBoxes({ value, onChange }) {
  return (
    <View style={s.codeWrap}>
      {Array.from({ length: 6 }).map((_, i) => (
        <View key={i} style={[s.codeBox, i === value.length && s.codeBoxActive, value[i] && s.codeBoxFilled]}>
          <Text style={s.codeDigit}>{value[i] || ''}</Text>
        </View>
      ))}
      <TextInput
        accessibilityLabel="Code"
        value={value}
        onChangeText={(t) => onChange(t.replace(/\D/g, '').slice(0, 6))}
        keyboardType="number-pad"
        maxLength={6}
        autoFocus
        caretHidden
        style={s.codeHidden}
      />
    </View>
  );
}

const Section = ({ title, aside, children, style }) => (
  <View style={[{ marginTop: 34 }, style]}>
    <View style={s.sectionHead}>
      <Text style={s.sectionTitle}>{title}</Text>
      {aside ? <Text style={s.sectionAside}>{aside}</Text> : null}
    </View>
    {children}
  </View>
);

function Row({ title, subtitle, left, dot, right, rightSub, rightColor, onPress, chevron }) {
  const inner = (
    <View style={s.row}>
      {left ? <View style={{ marginRight: 14 }}>{left}</View> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={s.rowTitle} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <View style={s.rowSubLine}>
            {dot ? <View style={[s.dot, { backgroundColor: dot }]} /> : null}
            <Text style={s.rowSub} numberOfLines={2}>
              {subtitle}
            </Text>
          </View>
        ) : null}
      </View>
      {right !== undefined ? (
        <View style={{ alignItems: 'flex-end', marginLeft: 12 }}>
          <Text style={[s.rowRight, rightColor && { color: rightColor }]}>{right}</Text>
          {rightSub ? <Text style={s.rowSub}>{rightSub}</Text> : null}
        </View>
      ) : null}
      {chevron ? <Text style={s.chevron}>›</Text> : null}
    </View>
  );
  return onPress ? (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7}>
      {inner}
    </TouchableOpacity>
  ) : (
    inner
  );
}

const Notice = ({ text, action, onPress, tone = 'lime' }) => {
  const c = tone === 'lime' ? T.lime : tone === 'warn' ? T.warn : T.loss;
  return (
    <TouchableOpacity disabled={!onPress} onPress={onPress} activeOpacity={0.8} style={[s.notice, { backgroundColor: alpha(c, 0.1), borderColor: alpha(c, 0.3) }]}>
      <Text style={[s.body, { flex: 1, color: T.text }]}>{text}</Text>
      {action ? <Text style={[s.noticeAction, { color: c }]}>{action}</Text> : null}
    </TouchableOpacity>
  );
};

const Tag = ({ currency }) => <Text style={[s.tag, currency === 'cash' && s.tagCash]}>{MONEY[currency || 'play']}</Text>;

function Screen({ children, onBack, title, left, right, refreshing, onRefresh, glow }) {
  return (
    <View style={s.root}>
      {glow ? <LinearGradient colors={[alpha(glow, 0.22), alpha(glow, 0)]} style={s.glow} pointerEvents="none" /> : null}
      <View style={s.bar_}>
        <View style={s.barSide}>
          {onBack ? (
            <TouchableOpacity onPress={onBack} style={s.backHit} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <View style={s.backChevron} />
            </TouchableOpacity>
          ) : (
            left
          )}
        </View>
        <Text style={s.barTitle} numberOfLines={1}>
          {title}
        </Text>
        <View style={[s.barSide, { alignItems: 'flex-end' }]}>{right}</View>
      </View>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={s.pad}
          keyboardShouldPersistTaps="handled"
          refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={T.lime} /> : undefined}
        >
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

function useRefresh(load) {
  const [refreshing, setRefreshing] = useState(false);
  return {
    refreshing,
    onRefresh: async () => {
      setRefreshing(true);
      await load();
      setRefreshing(false);
    },
  };
}

const DAY_COLOR = { done: T.lime, missed: T.loss, disputed: T.warn, open: 'transparent', future: T.raised };
function Days({ days, color, onPressDay }) {
  return (
    <View style={s.days}>
      {days.map((d, i) => {
        const bg = d.status === 'done' ? color || T.lime : DAY_COLOR[d.status] || T.raised;
        const cell = <View style={[s.day, { backgroundColor: bg }, d.status === 'open' && { borderWidth: 2, borderColor: color || T.lime }]} />;
        return onPressDay && d.status === 'done' ? (
          <TouchableOpacity key={d.date} onPress={() => onPressDay(d, i)} hitSlop={{ top: 4, bottom: 4, left: 2, right: 2 }}>
            {cell}
          </TouchableOpacity>
        ) : (
          <View key={d.date}>{cell}</View>
        );
      })}
    </View>
  );
}

// What a winner takes home in a full public pot where a third of the players miss. Used as an honest example.
function exampleTake(stake, players = 12, missed = 4) {
  const forfeit = stake * missed;
  const pool = forfeit - Math.floor(forfeit / 10);
  return stake + Math.floor(pool / (players - missed));
}

// A public pot that's filling up: the thing people tap on.
function PotCard({ p, onPress, style }) {
  const c = goalColor(p.goalType);
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.9} style={style}>
      <LinearGradient colors={[alpha(c, 0.26), alpha(c, 0.05)]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[s.potCard, { borderColor: alpha(c, 0.28) }]}>
        <View style={s.rowBetween}>
          <Chip color={c} size={38} />
          <Text style={[s.joinPill, { backgroundColor: c }]}>{p.joined ? "You're in" : `${fmt(p.stakeCents)} to join`}</Text>
        </View>
        <Text style={s.potCardName} numberOfLines={1}>
          {p.name}
        </Text>
        <Text style={s.small} numberOfLines={1}>
          {p.goalText}
        </Text>
        <Text style={s.potCardAmt}>{fmt(p.potCents)}</Text>
        <Text style={s.small}>in the pot · up to {fmt(p.stakeCents * p.maxMembers)}</Text>
        <Bar value={p.memberCount / p.maxMembers} color={c} style={{ marginTop: 14 }} />
        <Text style={[s.small, { marginTop: 8 }]}>
          {p.memberCount} of {p.maxMembers} in · {p.durationDays} days{p.startsAt ? ` · starts ${fmtDate(p.startsAt)}` : ''}
        </Text>
      </LinearGradient>
    </TouchableOpacity>
  );
}

/* ---------- email confirmation ---------- */

// Enter (or change) an email, get a code, type it in. Used after signup and on the account screen.
function ConfirmEmail({ session, email, autoSend, onDone, onSkip }) {
  const [value, setValue] = useState(email || '');
  const [sentTo, setSentTo] = useState(null);
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState(null);
  const [busy, setBusy] = useState(false);

  const send = async (to) => {
    setBusy(true);
    try {
      const r = await api.sendCode(session.token, to);
      if (r.verified) return onDone();
      setSentTo(r.email);
      setDevCode(r.devCode || null);
      setCode('');
    } catch (e) {
      Alert.alert("Couldn't send a code", errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const verify = async (c) => {
    setBusy(true);
    try {
      await api.verifyCode(session.token, c);
      onDone();
    } catch (e) {
      Alert.alert('Not confirmed', errMsg(e));
      setCode('');
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (autoSend && email) send(undefined);
  }, []);

  if (!sentTo) {
    return (
      <View>
        <Field label="Email" value={value} onChangeText={setValue} placeholder="you@example.com" autoCapitalize="none" keyboardType="email-address" />
        <Btn title={busy ? 'Sending…' : 'Email me a code'} onPress={() => send(value.trim())} disabled={busy || !value.includes('@')} />
        {onSkip ? <Btn kind="ghost" title="Skip for now" onPress={onSkip} /> : null}
      </View>
    );
  }
  return (
    <View>
      <Text style={[s.body, { marginBottom: 18 }]}>
        We sent a 6-digit code to <Text style={{ color: T.text, fontFamily: F.s }}>{sentTo}</Text>
      </Text>
      <CodeBoxes
        value={code}
        onChange={(c) => {
          setCode(c);
          if (c.length === 6 && !busy) verify(c);
        }}
      />
      {devCode ? <Text style={[s.fieldHint, { marginTop: 12 }]}>Dev mode: no email is sent. Your code is {devCode}.</Text> : null}
      <Btn title={busy ? 'Checking…' : 'Confirm'} onPress={() => verify(code)} disabled={busy || code.length !== 6} style={{ marginTop: 20 }} />
      <View style={s.inline}>
        <Btn kind="ghost" title="Send again" onPress={() => send(sentTo)} disabled={busy} />
        <Btn kind="ghost" title="Change email" onPress={() => setSentTo(null)} disabled={busy} />
      </View>
      {onSkip ? <Btn kind="ghost" title="Skip for now" onPress={onSkip} /> : null}
    </View>
  );
}

/* ---------- welcome ---------- */

function ShowCard({ color, name, goal, pot, line, style }) {
  return (
    <LinearGradient colors={[alpha(color, 0.34), alpha(color, 0.08)]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[s.showCard, { borderColor: alpha(color, 0.4) }, style]}>
      <View style={s.rowBetween}>
        <Chip color={color} size={40} />
        <Text style={[s.joinPill, { backgroundColor: color }]}>Live</Text>
      </View>
      <Text style={s.potCardName}>{name}</Text>
      <Text style={s.small}>{goal}</Text>
      <Text style={s.potCardAmt}>{pot}</Text>
      <Bar value={1} color={color} style={{ marginTop: 10 }} />
      <Text style={[s.small, { marginTop: 8, color: T.text }]}>{line}</Text>
    </LinearGradient>
  );
}

function Welcome({ onDone }) {
  const [mode, setMode] = useState('intro'); // intro | new | login | forgot | verify
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [adult, setAdult] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null);
  const [reset, setReset] = useState(null);
  const [code, setCode] = useState('');

  const run = async (title, fn) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      Alert.alert(title, errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const signup = () =>
    run("Couldn't sign you up", async () => {
      const r = await api.signup(name.trim(), password, email.trim());
      setPending({ token: r.token, userId: r.userId, name: r.name });
      setMode('verify');
    });
  const login = () =>
    run("Couldn't log you in", async () => {
      const r = await api.login(name.trim(), password);
      await onDone({ token: r.token, userId: r.userId, name: r.name });
    });
  const forgot = () =>
    run("Couldn't send a code", async () => {
      const r = await api.forgotPassword(email.trim());
      setReset({ email: email.trim(), devCode: r.devCode || null });
    });
  const doReset = () =>
    run("Couldn't reset it", async () => {
      const r = await api.resetPassword(reset.email, code, password);
      await onDone({ token: r.token, userId: r.userId, name: r.name });
    });

  if (mode === 'intro') {
    return (
      <Screen glow={T.lime} left={<Wordmark />}>
        <View style={s.showcase}>
          <ShowCard
            color={GOAL_COLOR.sleep}
            name="Sleep Club"
            goal="In bed on time, 7+ hours"
            pot="$300"
            line="12 players · $25 each"
            style={{ position: 'absolute', top: 0, right: -6, width: '84%', transform: [{ rotate: '5deg' }], opacity: 0.85 }}
          />
          <ShowCard color={T.lime} name="Move Squad" goal="30 minutes of exercise" pot="$300" line="4 quit. You keep going: +$11.25" style={{ marginTop: 44, width: '88%', transform: [{ rotate: '-3deg' }] }} />
        </View>
        <Text style={s.hero}>Get paid to keep your promises.</Text>
        <Text style={s.lede}>Put money on a daily habit. Keep it up and split the pot with everyone who didn't.</Text>
        <View style={s.steps}>
          {[
            ['1', 'Stake $5 to $50'],
            ['2', 'Check in daily'],
            ['3', 'Split the pot'],
          ].map(([n, t]) => (
            <View key={n} style={s.step}>
              <Text style={s.stepNum}>{n}</Text>
              <Text style={s.stepText}>{t}</Text>
            </View>
          ))}
        </View>
        <Btn title="Get started" onPress={() => setMode('new')} style={{ marginTop: 28 }} />
        <Text style={[s.small, { textAlign: 'center', marginTop: 10 }]}>Free to try: you start with $50 in play money.</Text>
        <Btn kind="ghost" title="I already have an account" onPress={() => setMode('login')} style={{ marginTop: 6 }} />
      </Screen>
    );
  }

  if (mode === 'verify' && pending) {
    return (
      <Screen title="" glow={T.lime}>
        <Text style={s.h1}>Check your inbox</Text>
        <Text style={[s.lede, { marginBottom: 26 }]}>Confirm your email so you can reset your password and play for real money.</Text>
        <ConfirmEmail session={pending} email={email.trim()} autoSend onDone={() => onDone(pending)} onSkip={() => onDone(pending)} />
      </Screen>
    );
  }

  if (mode === 'forgot') {
    return (
      <Screen title="" onBack={() => (setReset(null), setMode('login'))}>
        <Text style={s.h1}>Reset your password</Text>
        {!reset ? (
          <>
            <Text style={[s.lede, { marginBottom: 26 }]}>We'll email a code to the address on your account.</Text>
            <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" placeholder="you@example.com" />
            <Btn title={busy ? 'Sending…' : 'Email me a code'} onPress={forgot} disabled={busy || !email.includes('@')} />
          </>
        ) : (
          <>
            <Text style={[s.lede, { marginBottom: 26 }]}>If {reset.email} has an account, the code is on its way.</Text>
            <CodeBoxes value={code} onChange={setCode} />
            {reset.devCode ? <Text style={[s.fieldHint, { marginTop: 12 }]}>Dev mode: no email is sent. Your code is {reset.devCode}.</Text> : null}
            <View style={{ height: 22 }} />
            <Field label="New password" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" hint="At least 4 characters" />
            <Btn title={busy ? 'Saving…' : 'Set new password'} onPress={doReset} disabled={busy || code.length !== 6 || password.length < 4} />
          </>
        )}
      </Screen>
    );
  }

  const isNew = mode === 'new';
  const ready = isNew ? name.trim().length >= 2 && email.includes('@') && password.length >= 4 && adult : name.trim().length >= 2 && password.length >= 4;
  return (
    <Screen title="" onBack={() => setMode('intro')} glow={T.lime}>
      <Text style={s.h1}>{isNew ? 'Create your account' : 'Welcome back'}</Text>
      <Text style={[s.lede, { marginBottom: 26 }]}>{isNew ? 'Takes 20 seconds. $50 in play money is waiting.' : 'Your streaks missed you.'}</Text>
      {isNew ? (
        <>
          <Field label="Display name" value={name} onChangeText={setName} placeholder="What other players see" maxLength={20} autoCapitalize="none" />
          <Field label="Email" value={email} onChangeText={setEmail} placeholder="you@example.com" autoCapitalize="none" keyboardType="email-address" />
          <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" hint="At least 4 characters" />
          <Checkbox checked={adult} onPress={() => setAdult(!adult)} label="I'm 18 or older" />
          <Btn title={busy ? 'One sec…' : 'Create account'} onPress={signup} disabled={!ready || busy} style={{ marginTop: 14 }} />
          <Btn kind="ghost" title="I already have an account" onPress={() => setMode('login')} />
        </>
      ) : (
        <>
          <Field label="Name or email" value={name} onChangeText={setName} autoCapitalize="none" keyboardType="email-address" />
          <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" />
          <Btn title={busy ? 'One sec…' : 'Log in'} onPress={login} disabled={!ready || busy} style={{ marginTop: 6 }} />
          <Btn kind="ghost" title="Forgot password?" onPress={() => setMode('forgot')} />
        </>
      )}
    </Screen>
  );
}

/* ---------- home ---------- */

const STATUS = {
  open: { label: 'Filling up', color: T.warn },
  active: { label: 'Live', color: T.lime },
  settled: { label: 'Finished', color: T.faint },
  cancelled: { label: 'Cancelled, refunded', color: T.faint },
};

function TodayCard({ p, today, onCheckin, onOpen, busy }) {
  const c = goalColor(p.goalType);
  const day = Math.min(p.durationDays, Math.max(1, daysBetween(p.startDate, today) + 1));
  return (
    <TouchableOpacity onPress={onOpen} activeOpacity={0.9} style={{ marginBottom: 12 }}>
      <LinearGradient colors={[alpha(c, 0.24), alpha(c, 0.05)]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[s.today, { borderColor: alpha(c, 0.3) }]}>
        <View style={s.rowCenter}>
          <Chip color={c} size={44} />
          <View style={{ flex: 1, marginLeft: 14 }}>
            <Text style={s.todayName} numberOfLines={1}>
              {p.name}
            </Text>
            <Text style={s.small}>
              Day {day} of {p.durationDays} · {fmt(p.potCents)} pot
            </Text>
          </View>
        </View>
        <Bar value={day / p.durationDays} color={c} style={{ marginTop: 16 }} />
        {p.checkedInToday ? (
          <View style={[s.doneRow, { backgroundColor: alpha(c, 0.14) }]}>
            <View style={[s.tickDot, { backgroundColor: c }]}>
              <Tick size={10} />
            </View>
            <Text style={[s.body, { color: T.text, flex: 1 }]}>Done for today. See you tomorrow.</Text>
          </View>
        ) : (
          <Btn title={busy ? '…' : 'I did it today'} onPress={onCheckin} disabled={busy} color={c} style={{ marginTop: 16 }} />
        )}
      </LinearGradient>
    </TouchableOpacity>
  );
}

function Home({ session, nav, mode, setMode }) {
  const [data, setData] = useState(null);
  const [lobby, setLobby] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(null);
  const { width } = useWindowDimensions();

  const load = async () => {
    try {
      const [d, l] = await Promise.all([api.me(session.token), api.publicPots(session.token, mode)]);
      setData(d);
      setLobby(l);
      if (!d.cash.enabled && mode === 'cash') setMode('play');
      setErr('');
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  useEffect(() => {
    load();
  }, [mode]);
  const refresh = useRefresh(load);

  const checkin = async (p) => {
    setBusy(p.id);
    try {
      await api.checkin(session.token, p.id, '');
      await load();
    } catch (e) {
      Alert.alert('Hold on', errMsg(e));
    } finally {
      setBusy(null);
    }
  };
  const join = (p) =>
    p.joined
      ? nav.push('pot', { potId: p.id })
      : Alert.alert(`Join ${p.name}?`, `${fmt(p.stakeCents)} of ${MONEY[mode].toLowerCase()} goes in now. ${p.goalText}, every day for ${p.durationDays} days.`, [
          { text: 'Not now', style: 'cancel' },
          {
            text: `Join for ${fmt(p.stakeCents)}`,
            onPress: async () => {
              try {
                await api.joinPublic(session.token, p.id);
                nav.push('pot', { potId: p.id });
              } catch (e) {
                Alert.alert('Hold on', errMsg(e));
                if (e.message === 'insufficient_funds') nav.push('wallet');
                if (e.message === 'verify_email') nav.push('account');
              }
            },
          },
        ]);

  const pots = data ? data.pots.filter((p) => p.currency === mode) : [];
  const live = pots.filter((p) => p.status === 'active');
  const waiting = pots.filter((p) => p.status === 'open');
  const done = pots.filter((p) => p.status === 'settled' || p.status === 'cancelled');
  const open = lobby ? lobby.pots.filter((p) => !p.joined).slice(0, 8) : [];
  const cash = data && data.cash;
  const user = data && data.user;
  const stats = data && data.stats;
  const balance = data ? (mode === 'cash' ? data.cashCents : data.balanceCents) : null;
  const left = live.filter((p) => !p.checkedInToday).length;

  let notice = null;
  if (user && !user.email) notice = { text: 'Add your email so you can reset your password.', action: 'Add', go: () => nav.push('account') };
  else if (mode === 'cash' && cash && cash.blocked === 'verify_email') notice = { text: `Confirm ${user.email} to play for real money.`, action: 'Confirm', go: () => nav.push('account') };
  else if (mode === 'cash' && cash && cash.blocked && cash.blocked !== 'cash_disabled') notice = { text: errMsg({ message: cash.blocked }), tone: 'warn' };

  const headline = !data ? ' ' : live.length ? (left ? `${left} check-in${left === 1 ? '' : 's'} left today` : "You're all done today") : 'Bet on yourself.';
  const sub = !data ? ' ' : live.length ? (left ? "Don't let the streak slip." : 'Come back tomorrow and keep it going.') : 'Pick a habit, put money on it, and get paid to stick with it.';

  return (
    <Screen
      glow={live.length && !left ? T.lime : goalColor(live[0] ? live[0].goalType : 'move')}
      left={<Wordmark />}
      right={
        <View style={s.rowCenter}>
          <TouchableOpacity onPress={() => nav.push('wallet')} style={[s.balancePill, mode === 'cash' && { backgroundColor: T.lime }]} activeOpacity={0.85}>
            <Text style={[s.balanceText, mode === 'cash' && { color: T.ink }]}>{balance == null ? '…' : fmt(balance)}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => nav.push('account')} style={{ marginLeft: 10 }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Avatar name={session.name} size={34} />
          </TouchableOpacity>
        </View>
      }
      {...refresh}
    >
      {cash && cash.enabled ? (
        <Segmented
          style={{ marginBottom: 22 }}
          options={[
            { value: 'play', label: 'Play money' },
            { value: 'cash', label: 'Real money' },
          ]}
          value={mode}
          onChange={setMode}
        />
      ) : null}

      <Text style={s.h1}>{headline}</Text>
      <Text style={s.lede}>{sub}</Text>
      {notice ? <Notice text={notice.text} action={notice.action} onPress={notice.go} tone={notice.tone} /> : null}
      {err ? <Text style={s.err}>{err}</Text> : null}

      {live.length ? (
        <View style={{ marginTop: 22 }}>
          {live.map((p) => (
            <TodayCard key={p.id} p={p} today={data.today} busy={busy === p.id} onCheckin={() => checkin(p)} onOpen={() => nav.push('pot', { potId: p.id })} />
          ))}
        </View>
      ) : null}

      <TouchableOpacity onPress={() => nav.push('play')} activeOpacity={0.9} style={{ marginTop: live.length ? 10 : 24 }}>
        <LinearGradient colors={[T.lime, '#9BCB12']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.cta}>
          <Image source={CHIP} style={s.ctaChip} resizeMode="contain" />
          <Text style={s.ctaTitle}>Join a pot</Text>
          <Text style={s.ctaSub}>
            {lobby && lobby.playersLive ? `${lobby.playersLive} people playing · ` : ''}
            {lobby ? `${fmt(lobby.liveCents)} on the line right now` : 'Get matched with players anywhere'}
          </Text>
          <View style={s.ctaArrow}>
            <Text style={s.ctaArrowText}>→</Text>
          </View>
        </LinearGradient>
      </TouchableOpacity>

      {open.length ? (
        <Section title="Filling up now" aside={`${open.length} open`}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -20 }} contentContainerStyle={{ paddingHorizontal: 20 }}>
            {open.map((p) => (
              <PotCard key={p.id} p={p} onPress={() => join(p)} style={{ width: Math.min(260, width * 0.68), marginRight: 12 }} />
            ))}
          </ScrollView>
        </Section>
      ) : null}

      <Section title="With friends">
        <View style={s.tiles}>
          <TouchableOpacity style={s.tile} onPress={() => nav.push('create')} activeOpacity={0.85}>
            <Chip color={GOAL_COLOR.custom} size={36} />
            <Text style={s.tileTitle}>Start a pot</Text>
            <Text style={s.small}>Your goal, your people</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.tile, { marginRight: 0 }]} onPress={() => nav.push('join')} activeOpacity={0.85}>
            <Chip color={GOAL_COLOR.sober} size={36} />
            <Text style={s.tileTitle}>Got a code?</Text>
            <Text style={s.small}>Join a friend's pot</Text>
          </TouchableOpacity>
        </View>
      </Section>

      {waiting.length ? (
        <Section title="Waiting to start">
          {waiting.map((p) => (
            <Row
              key={p.id}
              left={<Chip color={goalColor(p.goalType)} size={38} />}
              title={p.name}
              subtitle={`${p.memberCount} of ${p.maxMembers} in${p.startsAt ? ` · starts ${fmtDate(p.startsAt)}` : ''}`}
              right={fmt(p.potCents)}
              onPress={() => nav.push('pot', { potId: p.id })}
            />
          ))}
        </Section>
      ) : null}
      {done.length ? (
        <Section title="Past pots" aside={stats && stats.played ? `${stats.wins}–${stats.played - stats.wins} · ${stats.netCents >= 0 ? '+' : ''}${fmt(stats.netCents)}` : null}>
          {done.map((p) => (
            <Row key={p.id} left={<Chip color={goalColor(p.goalType)} size={38} />} title={p.name} subtitle={STATUS[p.status].label} right={fmt(p.potCents)} onPress={() => nav.push('pot', { potId: p.id })} />
          ))}
        </Section>
      ) : null}

      <Section title="More">
        <Row title="Leaderboard" subtitle="Biggest winners, last 30 days" onPress={() => nav.push('board')} chevron />
        <Row title="How it works" subtitle="Check-ins, disputes and payouts" onPress={() => nav.push('rules')} chevron />
      </Section>
    </Screen>
  );
}

/* ---------- find a pot ---------- */

function Play({ session, nav, mode }) {
  const goals = GOALS.filter((g) => g.type !== 'custom');
  const [goal, setGoal] = useState(goals[2]);
  const [days, setDays] = useState(7);
  const [stake, setStake] = useState(1000);
  const [busy, setBusy] = useState(false);
  const [list, setList] = useState(null);
  const [err, setErr] = useState('');

  const load = async () => {
    try {
      setList(await api.publicPots(session.token, mode));
      setErr('');
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  useEffect(() => {
    load();
  }, []);
  const refresh = useRefresh(load);

  const fail = (e) => {
    Alert.alert('Hold on', errMsg(e));
    if (e && e.message === 'insufficient_funds') nav.push('wallet');
    if (e && e.message === 'verify_email') nav.push('account');
  };
  const find = async () => {
    setBusy(true);
    try {
      const r = await api.playPublic(session.token, { goalType: goal.type, durationDays: days, stakeCents: stake, currency: mode });
      nav.replace('pot', { potId: r.id });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const joinOne = (p) =>
    p.joined
      ? nav.replace('pot', { potId: p.id })
      : Alert.alert(`Join ${p.name}?`, `${fmt(p.stakeCents)} of ${MONEY[mode].toLowerCase()} goes in now. ${p.goalText}, ${p.durationDays} days.`, [
          { text: 'Not now', style: 'cancel' },
          {
            text: `Join for ${fmt(p.stakeCents)}`,
            onPress: async () => {
              try {
                await api.joinPublic(session.token, p.id);
                nav.replace('pot', { potId: p.id });
              } catch (e) {
                fail(e);
                load();
              }
            },
          },
        ]);

  const c = goalColor(goal.type);
  const take = exampleTake(stake);
  const misses = Math.floor(days * 0.2);
  const pool = list ? list.pots : [];
  return (
    <Screen title="Find a pot" onBack={nav.back} glow={c} {...refresh}>
      <Tag currency={mode} />
      <Text style={[s.h1, { marginTop: 14 }]}>What are you committing to?</Text>

      <View style={s.goalGrid}>
        {goals.map((g) => {
          const gc = goalColor(g.type);
          const on = g.type === goal.type;
          return (
            <TouchableOpacity
              key={g.type}
              onPress={() => setGoal(g)}
              activeOpacity={0.85}
              style={[s.goalTile, on && { borderColor: gc, backgroundColor: alpha(gc, 0.12) }]}
            >
              <Chip color={gc} size={36} />
              <Text style={s.goalLabel}>{g.label}</Text>
              <Text style={s.small} numberOfLines={2}>
                {g.text}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <Section title="For how long" style={{ marginTop: 26 }}>
        <Segmented options={DURATIONS.map((d) => ({ value: d, label: `${d} days` }))} value={days} onChange={setDays} />
      </Section>
      <Section title="Your stake" style={{ marginTop: 26 }}>
        <Segmented options={PUBLIC_STAKES.map((v) => ({ value: v, label: fmt(v) }))} value={stake} onChange={setStake} />
      </Section>

      <View style={[s.takeCard, { borderColor: alpha(c, 0.35) }]}>
        <Text style={s.eyebrow}>If 4 of 12 players miss</Text>
        <View style={[s.rowCenter, { marginTop: 4 }]}>
          <Text style={s.takeAmt}>{fmt(take)}</Text>
          <Text style={[s.takeGain, { color: c }]}> +{fmt(take - stake)}</Text>
        </View>
        <Text style={s.small}>
          is what you take home for sticking with it. You can miss {misses} day{misses === 1 ? '' : 's'} and still win.
        </Text>
      </View>
      <Btn title={busy ? 'Finding your pot…' : `Find me a pot · ${fmt(stake)}`} onPress={find} disabled={busy} color={c} style={{ marginTop: 16 }} />

      <Section title="Or jump into one" aside={pool.length ? `${pool.length} open` : null}>
        {err ? <Text style={s.err}>{err}</Text> : null}
        {list && !pool.length ? <Text style={s.empty}>Nothing open right now. Hit the button and yours is first.</Text> : null}
        {pool.map((p) => (
          <PotCard key={p.id} p={p} onPress={() => joinOne(p)} style={{ marginBottom: 12 }} />
        ))}
      </Section>
    </Screen>
  );
}

function Board({ session, nav, mode }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const load = async () => {
    try {
      setD(await api.leaderboard(session.token, mode));
      setErr('');
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  useEffect(() => {
    load();
  }, []);
  const refresh = useRefresh(load);
  const top3 = d ? d.top.slice(0, 3) : [];
  const rest = d ? d.top.slice(3) : [];
  const MEDAL = [T.lime, GOAL_COLOR.sleep, GOAL_COLOR.quit];
  const BoardRow = ({ r }) => (
    <Row
      left={<Text style={[s.rank, r.isMe && { color: T.lime }]}>{r.rank}</Text>}
      title={r.isMe ? `${r.name} (you)` : r.name}
      subtitle={`${r.wins} won · ${r.played - r.wins} lost`}
      right={`${r.netCents >= 0 ? '+' : ''}${fmt(r.netCents)}`}
      rightColor={r.netCents >= 0 ? T.lime : T.loss}
    />
  );
  return (
    <Screen title="Leaderboard" onBack={nav.back} glow={GOAL_COLOR.sleep} {...refresh}>
      <Tag currency={mode} />
      <Text style={[s.h1, { marginTop: 14 }]}>Biggest winners</Text>
      <Text style={s.lede}>Net winnings in public pots, last {d ? d.windowDays : 30} days.</Text>
      {err ? <Text style={s.err}>{err}</Text> : null}
      {d && !d.top.length ? <Text style={[s.empty, { marginTop: 20 }]}>No finished public pots yet. Win one and you're on top.</Text> : null}
      {top3.length ? (
        <View style={s.podium}>
          {top3.map((r, i) => (
            <View key={r.rank} style={[s.podiumCard, { borderColor: alpha(MEDAL[i], 0.4), backgroundColor: alpha(MEDAL[i], 0.08) }]}>
              <Text style={[s.podiumRank, { color: MEDAL[i] }]}>#{r.rank}</Text>
              <Avatar name={r.name} size={40} />
              <Text style={s.podiumName} numberOfLines={1}>
                {r.isMe ? 'You' : r.name}
              </Text>
              <Text style={[s.podiumAmt, { color: r.netCents >= 0 ? T.lime : T.loss }]}>
                {r.netCents >= 0 ? '+' : ''}
                {fmt(r.netCents)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      <View style={{ marginTop: 10 }}>
        {rest.map((r) => (
          <BoardRow key={r.rank} r={r} />
        ))}
        {d && d.me && d.me.rank > 25 ? <BoardRow r={d.me} /> : null}
      </View>
    </Screen>
  );
}

function Rules({ nav }) {
  const items = [
    ['Check in every day', 'Tap "I did it today" before midnight UTC. Forgot? You can still log yesterday.', GOAL_COLOR.move],
    ['Miss a few, still win', 'You can miss 1 day in 5 and still win. Hard mode allows none.', GOAL_COLOR.sleep],
    ['Call out fakes', 'Tap a check-in that looks fake to dispute it. If most of the other players agree, it doesn\'t count. 2 disputes per pot.', GOAL_COLOR.quit],
    ['Split the pot', 'Winners get their stake back plus an equal share of what the quitters put in, minus a 10% cut of that share.', GOAL_COLOR.eat],
    ['Everyone wins?', 'Everyone gets their money back. No cut.', GOAL_COLOR.sober],
    ['Nobody wins?', 'Everyone gets 90% back.', GOAL_COLOR.custom],
  ];
  return (
    <Screen title="How it works" onBack={nav.back} glow={GOAL_COLOR.eat}>
      {items.map(([title, body, c], i) => (
        <View key={title} style={s.rule}>
          <View style={[s.ruleNum, { backgroundColor: alpha(c, 0.16) }]}>
            <Text style={[s.ruleNumText, { color: c }]}>{i + 1}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.rowTitle}>{title}</Text>
            <Text style={[s.body, { marginTop: 4 }]}>{body}</Text>
          </View>
        </View>
      ))}
    </Screen>
  );
}

/* ---------- create ---------- */

function Create({ session, nav, mode }) {
  const [goal, setGoal] = useState(GOALS[2]);
  const [goalText, setGoalText] = useState(GOALS[2].text);
  const [name, setName] = useState(GOALS[2].name);
  const [days, setDays] = useState(14);
  const [stake, setStake] = useState(1000);
  const [max, setMax] = useState(6);
  const [strict, setStrict] = useState(false);
  const [busy, setBusy] = useState(false);

  const pick = (g) => {
    setGoal(g);
    setGoalText(g.text);
    setName(g.name);
  };
  const allowed = strict ? 0 : Math.floor(days * 0.2);
  const c = goalColor(goal.type);

  const create = async () => {
    setBusy(true);
    try {
      const r = await api.createPot(session.token, {
        name: name.trim(),
        goalType: goal.type,
        goalText: goalText.trim(),
        durationDays: days,
        stakeCents: stake,
        maxMembers: max,
        strict,
        currency: mode,
      });
      nav.replace('pot', { potId: r.id });
    } catch (e) {
      Alert.alert("Couldn't create the pot", errMsg(e));
      if (e && e.message === 'verify_email') nav.push('account');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Start a pot" onBack={nav.back} glow={c}>
      <Tag currency={mode} />
      <Text style={[s.h1, { marginTop: 14 }]}>Set the challenge</Text>
      <Text style={s.lede}>Your friends join with a code. Everyone puts in the same stake.</Text>
      <View style={s.goalGrid}>
        {GOALS.map((g) => {
          const gc = goalColor(g.type);
          const on = g.type === goal.type;
          return (
            <TouchableOpacity key={g.type} onPress={() => pick(g)} activeOpacity={0.85} style={[s.goalTile, s.goalTileSmall, on && { borderColor: gc, backgroundColor: alpha(gc, 0.12) }]}>
              <Chip color={gc} size={30} />
              <Text style={[s.goalLabel, { marginTop: 8 }]}>{g.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <Field label="What counts as a win each day" value={goalText} onChangeText={setGoalText} placeholder="e.g. 10,000 steps" maxLength={120} />
      <Field label="Pot name" value={name} onChangeText={setName} placeholder="Name it" maxLength={40} />
      <Section title="For how long" style={{ marginTop: 14 }}>
        <Segmented options={DURATIONS.map((d) => ({ value: d, label: `${d} days` }))} value={days} onChange={setDays} />
      </Section>
      <Section title="Stake per person" style={{ marginTop: 26 }}>
        <Segmented options={STAKES.map((v) => ({ value: v, label: fmt(v) }))} value={stake} onChange={setStake} />
      </Section>
      <Section title="Max people" style={{ marginTop: 26 }}>
        <Segmented options={[2, 4, 6, 10, 20].map((v) => ({ value: v, label: String(v) }))} value={max} onChange={setMax} />
      </Section>
      <View style={[s.row, { marginTop: 18, borderBottomWidth: 0 }]}>
        <View style={{ flex: 1 }}>
          <Text style={s.rowTitle}>Hard mode</Text>
          <Text style={s.rowSub}>{strict ? 'Miss one day and you are out' : `Everyone can miss up to ${allowed} of ${days} days`}</Text>
        </View>
        <Switch value={strict} onValueChange={setStrict} trackColor={{ true: c, false: T.raised }} thumbColor={T.text} />
      </View>
      <View style={[s.takeCard, { borderColor: alpha(c, 0.35) }]}>
        <Text style={s.eyebrow}>Full pot</Text>
        <Text style={s.takeAmt}>{fmt(stake * max)}</Text>
        <Text style={s.small}>Whoever sticks with it splits what the others put in (minus a 10% cut). If everyone does, everyone gets their money back.</Text>
      </View>
      <Btn
        title={busy ? 'Creating…' : `Create pot · put in ${fmt(stake)}`}
        onPress={create}
        disabled={busy || name.trim().length < 2 || goalText.trim().length < 3}
        color={c}
        style={{ marginTop: 16 }}
      />
    </Screen>
  );
}

/* ---------- join ---------- */

function Join({ session, nav }) {
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);

  const look = async () => {
    setBusy(true);
    try {
      setPreview(await api.joinPreview(code.trim().toUpperCase()));
    } catch (e) {
      setPreview(null);
      Alert.alert('Not found', errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const join = async () => {
    setBusy(true);
    try {
      const r = await api.joinPot(session.token, code.trim().toUpperCase());
      nav.replace('pot', { potId: r.id });
    } catch (e) {
      Alert.alert("Couldn't join", errMsg(e));
      if (e.message === 'insufficient_funds') nav.push('wallet');
      if (e.message === 'verify_email') nav.push('account');
    } finally {
      setBusy(false);
    }
  };
  const c = preview ? goalColor(preview.goalType) : GOAL_COLOR.sober;

  return (
    <Screen title="Join a pot" onBack={nav.back} glow={c}>
      <Text style={s.h1}>Got a code?</Text>
      <Text style={s.lede}>Enter the 6 characters your friend sent you.</Text>
      <TextInput
        style={[s.input, s.bigCode]}
        value={code}
        onChangeText={(t) => {
          setCode(t.toUpperCase().replace(/[^A-Z0-9]/g, ''));
          setPreview(null);
        }}
        placeholder="ABC123"
        placeholderTextColor={T.faint}
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={6}
      />
      {!preview ? <Btn title={busy ? 'Looking…' : 'Find it'} onPress={look} disabled={busy || code.trim().length < 6} /> : null}
      {preview ? (
        <LinearGradient colors={[alpha(c, 0.24), alpha(c, 0.05)]} style={[s.potCard, { borderColor: alpha(c, 0.3), marginTop: 6 }]}>
          <View style={s.rowBetween}>
            <Chip color={c} size={40} />
            <Tag currency={preview.currency} />
          </View>
          <Text style={s.potCardName}>{preview.name}</Text>
          <Text style={s.small}>
            {preview.goalText} · started by {preview.creator}
          </Text>
          <View style={s.stats}>
            <Stat label="Stake" value={fmt(preview.stakeCents)} />
            <Stat label="Length" value={`${preview.durationDays} days`} />
            <Stat label="Players" value={`${preview.memberCount}/${preview.maxMembers}`} />
          </View>
          {preview.status !== 'open' ? <Text style={s.err}>That pot already started.</Text> : null}
          <Btn title={busy ? 'Joining…' : `Join · put in ${fmt(preview.stakeCents)}`} onPress={join} disabled={busy || preview.status !== 'open'} color={c} style={{ marginTop: 8 }} />
        </LinearGradient>
      ) : null}
    </Screen>
  );
}

const Stat = ({ label, value, color }) => (
  <View style={{ flex: 1 }}>
    <Text style={s.eyebrow}>{label}</Text>
    <Text style={[s.statValue, color && { color }]}>{value}</Text>
  </View>
);

/* ---------- pot ---------- */

function PotScreen({ session, nav, potId }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setD(await api.pot(session.token, potId));
      setErr('');
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [potId]);
  const refresh = useRefresh(load);

  const act = async (fn, okReload = true) => {
    setBusy(true);
    try {
      await fn();
      if (okReload) await load();
    } catch (e) {
      Alert.alert('Hold on', errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  if (!d) {
    return (
      <Screen title="" onBack={nav.back}>
        {err ? <Text style={s.err}>{err}</Text> : <Text style={s.body}>Loading…</Text>}
      </Screen>
    );
  }

  const { pot, members, me, results, today } = d;
  const c = goalColor(pot.goalType);
  const mine = members.find((m) => m.isMe);
  const isCreator = !pot.isPublic && pot.creatorId === session.userId;
  const myResult = results ? results.find((r) => r.userId === session.userId) : null;
  const allowed = mine ? mine.allowed : Math.floor(pot.durationDays * 0.2);
  const day = pot.startDate ? Math.min(pot.durationDays, Math.max(1, daysBetween(pot.startDate, today) + 1)) : 0;
  // if it ended right now: the players still in split what the ones out put in
  const aliveN = members.filter((m) => m.alive).length;
  const outN = members.length - aliveN;
  const share = aliveN && outN ? Math.floor((outN * pot.stakeCents * 0.9) / aliveN) : 0;
  const invite = () =>
    Share.share({
      message: `Join my Go Stake pot "${pot.name}": ${pot.goalText}. ${fmt(pot.stakeCents)} each for ${pot.durationDays} days.\nCode: ${pot.joinCode}\n${API_URL}/j/${pot.joinCode}`,
    });

  const disputeDay = (member, dd, idx) => {
    if (member.isMe || pot.status !== 'active') return;
    Alert.alert(
      `Dispute ${member.name}'s day ${idx + 1}?`,
      `If most of the other players agree it doesn't count, it's thrown out. You have ${me.disputesLeft} dispute${me.disputesLeft === 1 ? '' : 's'} left in this pot.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Dispute', style: 'destructive', onPress: () => act(() => api.dispute(session.token, potId, member.id, dd.date)) },
      ]
    );
  };

  return (
    <Screen title="" onBack={nav.back} glow={c} {...refresh}>
      <View style={s.rowBetween}>
        <Chip color={c} size={56} />
        <View style={{ alignItems: 'flex-end' }}>
          <Tag currency={pot.currency} />
          <View style={[s.rowCenter, { marginTop: 8 }]}>
            <View style={[s.dot, { backgroundColor: STATUS[pot.status].color }]} />
            <Text style={s.small}>{STATUS[pot.status].label}</Text>
          </View>
        </View>
      </View>
      <Text style={[s.h1, { marginTop: 16 }]}>{pot.name}</Text>
      <Text style={s.lede}>{pot.goalText}</Text>

      <Text style={[s.eyebrow, { marginTop: 24 }]}>In the pot</Text>
      <Text style={s.display}>{fmt(pot.potCents)}</Text>
      <Text style={s.small}>
        {pot.memberCount} player{pot.memberCount === 1 ? '' : 's'} · {fmt(pot.stakeCents)} each · {pot.durationDays} days · {pot.strict ? 'no misses' : `${allowed} miss${allowed === 1 ? '' : 'es'} allowed`}
      </Text>
      {pot.status === 'active' ? (
        <View style={{ marginTop: 18 }}>
          <View style={s.rowBetween}>
            <Text style={s.rowTitle}>
              Day {day} of {pot.durationDays}
            </Text>
            <Text style={s.small}>ends {fmtDate(pot.endDate)}</Text>
          </View>
          <Bar value={day / pot.durationDays} color={c} style={{ marginTop: 10 }} />
        </View>
      ) : null}

      {pot.status === 'active' && mine ? (
        mine.alive ? (
          <View style={[s.takeCard, { borderColor: alpha(c, 0.35) }]}>
            <Text style={s.eyebrow}>If it ended today you'd take home</Text>
            <View style={[s.rowCenter, { marginTop: 4 }]}>
              <Text style={s.takeAmt}>{fmt(pot.stakeCents + share)}</Text>
              {share ? <Text style={[s.takeGain, { color: c }]}> +{fmt(share)}</Text> : null}
            </View>
            <Text style={s.small}>{outN ? `${outN} player${outN === 1 ? ' is' : 's are'} out. Their money is on the table.` : "Nobody's out yet. Every slip-up grows your share."}</Text>
          </View>
        ) : (
          <Notice tone="loss" text={`You're out this time. Your ${fmt(pot.stakeCents)} goes to the winners. Run it back?`} action="New pot" onPress={() => nav.replace('play')} />
        )
      ) : null}

      {pot.status === 'settled' && myResult ? (
        <LinearGradient colors={[T.lime, '#9BCB12']} style={s.winCard}>
          <Text style={s.winTitle}>{myResult.type === 'payout' ? `You won ${fmt(myResult.amountCents - pot.stakeCents)}` : 'Everyone made it'}</Text>
          <Text style={s.winSub}>
            {myResult.type === 'payout' ? `${fmt(myResult.amountCents)} landed in your wallet.` : `Your ${fmt(myResult.amountCents)} is back in your wallet.`}
          </Text>
        </LinearGradient>
      ) : null}
      {pot.status === 'settled' && !myResult ? <Notice tone="loss" text={`You lost your ${fmt(pot.stakeCents)}. It went to the people who stuck with it.`} action="Run it back" onPress={() => nav.replace('play')} /> : null}
      {pot.status === 'cancelled' ? <Notice tone="warn" text="This pot was cancelled and everyone got their stake back." /> : null}

      {pot.status === 'active' && mine && mine.alive ? (
        me.checkedInToday ? (
          <View style={[s.doneRow, { backgroundColor: alpha(c, 0.14), marginTop: 18, padding: 18 }]}>
            <View style={[s.tickDot, { backgroundColor: c }]}>
              <Tick size={10} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.rowTitle}>Day {day} done</Text>
              <Text style={s.small}>
                {mine.valid} of {pot.durationDays} days · {mine.streak} in a row
              </Text>
            </View>
          </View>
        ) : (
          <Btn title="I did it today" onPress={() => act(() => api.checkin(session.token, potId, ''))} disabled={busy} color={c} style={[s.bigBtn, { marginTop: 18 }]} />
        )
      ) : null}

      {pot.status === 'open' && pot.isPublic ? (
        <Notice
          tone="warn"
          text={`${pot.memberCount} of ${pot.maxMembers} in. It starts when it fills up, or on ${fmtDate(pot.startsAt)} if 2 or more are in. Leave any time before then for a full refund.`}
        />
      ) : null}
      {pot.status === 'open' && pot.isPublic ? <Btn kind="secondary" title="Bring a friend" onPress={invite} /> : null}
      {pot.status === 'open' && !pot.isPublic ? (
        <View style={[s.invite, { borderColor: alpha(c, 0.35) }]}>
          <Text style={s.eyebrow}>
            Invite code · {pot.memberCount} of {pot.maxMembers} in
          </Text>
          <Text style={[s.inviteCode, { color: c }]}>{pot.joinCode}</Text>
          <Btn title="Share invite" onPress={invite} color={c} />
        </View>
      ) : null}

      <Section title="Players" aside={pot.status === 'active' ? 'Tap a day to dispute it' : null}>
        {members.map((m) => (
          <View key={m.id} style={s.member}>
            <View style={s.rowCenter}>
              <Avatar name={m.name} size={34} />
              <Text style={[s.rowTitle, { flex: 1, marginLeft: 12 }]} numberOfLines={1}>
                {m.isMe ? 'You' : m.name}
                {isCreator && pot.creatorId === m.id ? <Text style={s.small}>  host</Text> : null}
              </Text>
              {pot.status === 'open' ? null : (
                <Text style={[s.small, !m.alive && { color: T.loss, fontFamily: F.b }]}>{!m.alive ? 'Out' : `${m.valid}/${pot.durationDays} · ${m.streak} streak`}</Text>
              )}
            </View>
            {m.days && m.days.length ? <Days days={m.days} color={c} onPressDay={m.isMe ? null : (dd, i) => disputeDay(m, dd, i)} /> : null}
          </View>
        ))}
      </Section>

      {pot.status === 'open' && isCreator ? (
        <View style={{ marginTop: 26 }}>
          <Btn
            title={busy ? '…' : 'Start the pot'}
            onPress={() =>
              Alert.alert('Start now?', `${pot.memberCount} people are in. Nobody else can join once it starts.`, [
                { text: 'Not yet', style: 'cancel' },
                { text: 'Start', onPress: () => act(() => api.startPot(session.token, potId)) },
              ])
            }
            disabled={busy || pot.memberCount < 2}
            color={c}
          />
          {pot.memberCount < 2 ? <Text style={[s.small, { marginTop: 8, textAlign: 'center' }]}>You need at least one friend in to start.</Text> : null}
          <Btn
            kind="danger"
            title="Cancel pot and refund everyone"
            onPress={() =>
              act(async () => {
                await api.cancelPot(session.token, potId);
                nav.back();
              }, false)
            }
            disabled={busy}
          />
        </View>
      ) : null}
      {pot.status === 'open' && !isCreator ? (
        <Btn
          kind="danger"
          title="Leave and get my stake back"
          onPress={() =>
            act(async () => {
              await api.leavePot(session.token, potId);
              nav.back();
            }, false)
          }
          disabled={busy}
          style={{ marginTop: 16 }}
        />
      ) : null}
      {err ? <Text style={s.err}>{err}</Text> : null}
    </Screen>
  );
}

/* ---------- wallet ---------- */

function Wallet({ session, nav, mode }) {
  const cashMode = mode === 'cash';
  const [w, setW] = useState(null);
  const [amt, setAmt] = useState(2500);
  const [wd, setWd] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setW(await api.wallet(session.token, mode));
    } catch (e) {
      Alert.alert('Hold on', errMsg(e));
    }
  };
  useEffect(() => {
    load();
  }, []);
  const refresh = useRefresh(load);

  const run = async (title, fn) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      Alert.alert(title, errMsg(e));
      if (e && e.message === 'verify_email') nav.push('account');
    } finally {
      setBusy(false);
    }
  };
  const add = () =>
    run("Couldn't add money", async () => {
      const r = await api.checkout(session.token, amt, mode);
      if (r.url) {
        Linking.openURL(r.url);
        Alert.alert('Finish paying in your browser', 'Come back here after. Your balance updates in a few seconds.');
      }
      await load();
    });
  const setupPayouts = () =>
    run("Couldn't set up cash-outs", async () => {
      const r = await api.payoutSetup(session.token);
      if (r.url) Linking.openURL(r.url);
      await load();
    });
  const withdraw = () => {
    const cents = Math.round(parseFloat(wd) * 100);
    if (!(cents >= 1000)) return Alert.alert('Minimum cash-out', 'The minimum is $10.');
    run("Couldn't cash out", async () => {
      const r = await api.withdraw(session.token, cents);
      setWd('');
      Alert.alert(
        r.status === 'paid' ? 'On its way' : 'Request sent',
        r.status === 'paid' ? 'Sent to your payout account. Your bank usually shows it in 1–2 business days.' : "We're reviewing it. It shows below until it's sent."
      );
      await load();
    });
  };
  const takeBreak = () =>
    Alert.alert(
      'Take a break from real money?',
      "You won't be able to deposit or join real-money pots until it ends, and it can't be ended early. You can still cash out and play for play money.",
      [
        { text: 'Never mind', style: 'cancel' },
        ...[
          ['1 day', 1],
          ['30 days', 30],
          ['6 months', 182],
        ].map(([text, days]) => ({
          text,
          style: 'destructive',
          onPress: () =>
            run("Couldn't do that", async () => {
              await api.selfExclude(session.token, days);
              await load();
            }),
        })),
      ]
    );

  const cash = w ? w.cash : null;
  const blocked = cashMode && cash && cash.blocked;
  const fg = cashMode ? T.ink : T.text;
  return (
    <Screen title="Wallet" onBack={nav.back} glow={cashMode ? T.lime : GOAL_COLOR.sleep} {...refresh}>
      <LinearGradient colors={cashMode ? [T.lime, '#93C40E'] : ['#2B2547', '#191B1F']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.walletCard}>
        <Image source={CHIP} style={[s.walletChip, { tintColor: cashMode ? T.ink : GOAL_COLOR.sleep }]} resizeMode="contain" />
        <Text style={[s.eyebrow, { color: alpha(fg === T.ink ? '#0A0C0B' : '#F4F6EF', 0.7) }]}>{MONEY[mode]}</Text>
        <Text style={[s.display, { color: fg }]}>{fmt(w ? w.balanceCents : 0)}</Text>
        <Text style={[s.small, { color: alpha(fg === T.ink ? '#0A0C0B' : '#F4F6EF', 0.7) }]}>
          {cashMode ? (w && w.withdrawableCents < w.balanceCents ? `${fmt(w.withdrawableCents)} can be cashed out now` : 'Ready to play or cash out') : 'Free, just for bragging rights. Never cashes out.'}
        </Text>
      </LinearGradient>
      {blocked ? (
        <Notice
          tone={blocked === 'verify_email' ? 'lime' : 'warn'}
          text={errMsg({ message: blocked })}
          action={blocked === 'verify_email' ? 'Confirm' : null}
          onPress={blocked === 'verify_email' ? () => nav.push('account') : null}
        />
      ) : null}

      <Section title={cashMode ? 'Add money' : 'Top up play money'}>
        <Segmented options={[1000, 2500, 5000, 10000].map((v) => ({ value: v, label: fmt(v) }))} value={amt} onChange={setAmt} />
        <Btn title={busy ? '…' : cashMode ? `Pay ${fmt(amt)} by card` : `Add ${fmt(amt)}, free`} onPress={add} disabled={busy || !!blocked} style={{ marginTop: 12 }} />
      </Section>

      {cashMode ? (
        <Section title="Cash out">
          {cash && !cash.payoutsReady ? (
            <>
              <Text style={s.body}>Tell us where to send your winnings. Stripe checks your ID and bank once, then cash-outs go straight to your bank.</Text>
              <Btn kind="secondary" title="Set up cash-outs" onPress={setupPayouts} disabled={busy} />
            </>
          ) : (
            <View style={s.inline}>
              <TextInput style={[s.input, { flex: 1, marginRight: 10 }]} value={wd} onChangeText={setWd} placeholder="$ amount" placeholderTextColor={T.faint} keyboardType="decimal-pad" />
              <Btn kind="secondary" title="Cash out" onPress={withdraw} disabled={busy || !wd} style={{ paddingHorizontal: 22, marginTop: 0 }} />
            </View>
          )}
          {w &&
            w.withdrawals.map((x) => (
              <Row
                key={x.id}
                title={fmt(x.amount_cents)}
                subtitle={fmtDate(x.created_at)}
                right={x.status === 'pending' ? 'In review' : x.status === 'paid' ? 'Sent' : 'Returned'}
                rightColor={x.status === 'paid' ? T.lime : T.muted}
              />
            ))}
        </Section>
      ) : null}

      <Section title="History">
        {w && !w.entries.length ? <Text style={s.empty}>Nothing yet.</Text> : null}
        {w &&
          w.entries.map((e, i) => (
            <Row
              key={i}
              title={TYPE_LABEL[e.type] || e.type}
              subtitle={fmtDate(e.created_at)}
              right={`${e.amount_cents >= 0 ? '+' : ''}${fmt(e.amount_cents)}`}
              rightColor={e.amount_cents >= 0 ? T.lime : T.text}
            />
          ))}
      </Section>

      {cashMode && cash ? (
        cash.excludedUntil ? (
          <Text style={[s.small, { marginTop: 24 }]}>On a break from real money until {fmtDate(cash.excludedUntil)}.</Text>
        ) : (
          <Btn kind="danger" title="Take a break from real money" onPress={takeBreak} disabled={busy} style={{ marginTop: 20 }} />
        )
      ) : null}
    </Screen>
  );
}

/* ---------- account ---------- */

function Account({ session, nav, onLogout }) {
  const [me, setMe] = useState(null);
  const [editing, setEditing] = useState(false);
  const load = async () => {
    try {
      setMe(await api.me(session.token));
    } catch (e) {
      Alert.alert('Hold on', errMsg(e));
    }
  };
  useEffect(() => {
    load();
  }, []);
  const user = me && me.user;
  const stats = me && me.stats;
  const done = async () => {
    setEditing(false);
    await load();
  };
  const logout = () =>
    Alert.alert('Log out?', '', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Log out',
        style: 'destructive',
        onPress: async () => {
          await api.logout(session.token).catch(() => {});
          onLogout();
        },
      },
    ]);

  return (
    <Screen title="" onBack={nav.back} glow={nameColor(session.name)}>
      <Avatar name={session.name} size={72} />
      <Text style={[s.h1, { marginTop: 16 }]}>{session.name}</Text>
      {stats ? (
        <View style={s.stats}>
          <Stat label="Pots" value={String(stats.played)} />
          <Stat label="Won" value={String(stats.wins)} />
          <Stat label="Net" value={`${stats.netCents >= 0 ? '+' : ''}${fmt(stats.netCents)}`} color={stats.netCents >= 0 ? T.lime : T.loss} />
        </View>
      ) : null}

      <Section title="Email">
        {user ? (
          <Row
            title={user.email || 'Not added yet'}
            subtitle={user.emailVerified ? 'Confirmed' : user.email ? 'Not confirmed yet. You need this for real money.' : 'Needed to reset your password and to play for real money.'}
            dot={user.emailVerified ? T.lime : T.warn}
          />
        ) : null}
        {user && (editing || !user.emailVerified) ? (
          <View style={{ marginTop: 16 }}>
            <ConfirmEmail key={String(editing)} session={session} email={editing ? '' : user.email} onDone={done} />
          </View>
        ) : null}
        {user && user.emailVerified && !editing ? <Btn kind="ghost" title="Change email" onPress={() => setEditing(true)} /> : null}
      </Section>

      <Btn kind="danger" title="Log out" onPress={logout} style={{ marginTop: 36 }} />
    </Screen>
  );
}

/* ---------- app shell ---------- */

export default function App() {
  const [session, setSession] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [stack, setStack] = useState([{ name: 'home' }]);
  const [mode, setModeState] = useState('play');
  const [fontsLoaded, fontError] = useFonts({ Poppins_400Regular, Poppins_500Medium, Poppins_600SemiBold, Poppins_700Bold, Poppins_800ExtraBold });

  useEffect(() => {
    AsyncStorage.getItem(MODE_KEY)
      .then((m) => m === 'cash' && setModeState('cash'))
      .catch(() => {});
    AsyncStorage.getItem(KEY)
      .then((raw) => raw && setSession(JSON.parse(raw)))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);
  // Android back button walks the stack
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (stack.length > 1) {
        setStack((st) => st.slice(0, -1));
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [stack.length]);
  const setMode = (m) => {
    setModeState(m);
    AsyncStorage.setItem(MODE_KEY, m).catch(() => {});
  };

  const nav = {
    push: (name, params) => setStack((st) => [...st, { name, ...params }]),
    replace: (name, params) => setStack((st) => [...st.slice(0, -1), { name, ...params }]),
    back: () => setStack((st) => (st.length > 1 ? st.slice(0, -1) : st)),
  };

  const signedIn = async (sess) => {
    await AsyncStorage.setItem(KEY, JSON.stringify(sess)).catch(() => {});
    setSession(sess);
    setStack([{ name: 'home' }]);
  };
  const signedOut = async () => {
    await AsyncStorage.removeItem(KEY).catch(() => {});
    setSession(null);
    setStack([{ name: 'home' }]);
  };

  if (!loaded || (!fontsLoaded && !fontError)) return <View style={s.root} />;

  if (!API_URL) {
    return (
      <Screen left={<Wordmark />}>
        <Text style={s.h1}>One setup step</Text>
        <Text style={s.body}>Run node dev.mjs from the project folder, or deploy the backend (see README) and put its URL in src/config.js.</Text>
      </Screen>
    );
  }
  if (!session) return <Welcome onDone={signedIn} />;

  const top = stack[stack.length - 1];
  const common = { session, nav, mode };
  // key forces a fresh load whenever we land on a screen
  return (
    <View style={{ flex: 1, backgroundColor: T.ink }}>
      <StatusBar barStyle="light-content" backgroundColor={T.ink} />
      {top.name === 'home' && <Home key={'h' + stack.length} {...common} setMode={setMode} />}
      {top.name === 'create' && <Create {...common} />}
      {top.name === 'join' && <Join {...common} />}
      {top.name === 'wallet' && <Wallet {...common} />}
      {top.name === 'play' && <Play {...common} />}
      {top.name === 'board' && <Board {...common} />}
      {top.name === 'rules' && <Rules {...common} />}
      {top.name === 'account' && <Account {...common} onLogout={signedOut} />}
      {top.name === 'pot' && <PotScreen key={top.potId} {...common} potId={top.potId} />}
    </View>
  );
}

/* ---------- styles ---------- */

const TOP = Platform.OS === 'android' ? (StatusBar.currentHeight || 24) + 4 : 54;

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.ink, paddingTop: TOP },
  glow: { position: 'absolute', top: 0, left: 0, right: 0, height: 420 },
  bar_: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, height: 54 },
  barSide: { minWidth: 72, justifyContent: 'center' },
  barTitle: { flex: 1, textAlign: 'center', color: T.text, fontSize: 16, fontFamily: F.s },
  backHit: { width: 36, height: 36, borderRadius: 18, backgroundColor: alpha('#FFFFFF', 0.06), alignItems: 'center', justifyContent: 'center' },
  backChevron: { width: 10, height: 10, borderLeftWidth: 2, borderBottomWidth: 2, borderColor: T.text, transform: [{ rotate: '45deg' }], marginLeft: 3 },
  pad: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 72 },

  wordmark: { flexDirection: 'row', alignItems: 'center' },
  wordmarkText: { color: T.text, fontFamily: F.x, letterSpacing: 2.5 },

  hero: { color: T.text, fontSize: 38, lineHeight: 44, fontFamily: F.x, letterSpacing: -1, marginTop: 30 },
  h1: { color: T.text, fontSize: 28, lineHeight: 35, fontFamily: F.x, letterSpacing: -0.6 },
  lede: { color: T.muted, fontSize: 16, lineHeight: 24, marginTop: 8, fontFamily: F.r },
  body: { color: T.muted, fontSize: 15, lineHeight: 22, fontFamily: F.r },
  small: { color: T.muted, fontSize: 13, lineHeight: 19, fontFamily: F.r },
  err: { color: T.loss, fontSize: 14, marginVertical: 10, fontFamily: F.m },
  empty: { color: T.faint, fontSize: 15, lineHeight: 22, paddingVertical: 14, fontFamily: F.r },
  eyebrow: { color: T.muted, fontSize: 13, fontFamily: F.s },
  display: { color: T.text, fontSize: 54, lineHeight: 64, fontFamily: F.x, letterSpacing: -1.5 },

  btn: { backgroundColor: T.lime, borderRadius: 16, height: 56, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  btnLabel: { color: T.ink, fontSize: 16, fontFamily: F.b },
  btnSecondary: { backgroundColor: T.raised, borderRadius: 16, height: 56, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, marginTop: 12 },
  btnSecondaryLabel: { color: T.text, fontSize: 15, fontFamily: F.s },
  btnGhost: { paddingVertical: 14, alignItems: 'center' },
  btnGhostLabel: { color: T.muted, fontSize: 15, fontFamily: F.s },
  bigBtn: { height: 70, borderRadius: 20 },
  inline: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around' },
  rowCenter: { flexDirection: 'row', alignItems: 'center' },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },

  seg: { flexDirection: 'row', backgroundColor: T.surface, borderRadius: 14, padding: 4 },
  segItem: { flex: 1, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  segOn: { backgroundColor: T.text },
  segLabel: { color: T.muted, fontSize: 14, fontFamily: F.s },
  segLabelOn: { color: T.ink },

  fieldLabel: { color: T.muted, fontSize: 13, fontFamily: F.s, marginBottom: 8 },
  fieldHint: { color: T.faint, fontSize: 13, marginTop: 6, fontFamily: F.r },
  input: { backgroundColor: T.surface, borderRadius: 14, height: 54, paddingHorizontal: 16, fontSize: 16, color: T.text, fontFamily: F.m, borderWidth: 1, borderColor: T.line },
  bigCode: { fontSize: 32, letterSpacing: 10, fontFamily: F.x, height: 80, textAlign: 'center', marginTop: 22, marginBottom: 14 },

  codeWrap: { flexDirection: 'row', justifyContent: 'space-between' },
  codeBox: { width: '14.5%', aspectRatio: 0.82, borderRadius: 14, backgroundColor: T.surface, borderWidth: 1.5, borderColor: T.line, alignItems: 'center', justifyContent: 'center' },
  codeBoxActive: { borderColor: T.lime },
  codeBoxFilled: { backgroundColor: T.raised },
  codeDigit: { color: T.text, fontSize: 26, fontFamily: F.b },
  codeHidden: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: 0, color: 'transparent' },

  checkRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  checkBox: { width: 24, height: 24, borderRadius: 7, borderWidth: 2, borderColor: T.faint, marginRight: 12, alignItems: 'center', justifyContent: 'center' },
  checkBoxOn: { backgroundColor: T.lime, borderColor: T.lime },

  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 },
  sectionTitle: { color: T.text, fontSize: 18, fontFamily: F.b },
  sectionAside: { color: T.faint, fontSize: 13, fontFamily: F.m },

  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.line },
  rowTitle: { color: T.text, fontSize: 16, fontFamily: F.s },
  rowSubLine: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  rowSub: { color: T.muted, fontSize: 13, lineHeight: 19, flexShrink: 1, fontFamily: F.r },
  rowRight: { color: T.text, fontSize: 16, fontFamily: F.b },
  chevron: { color: T.faint, fontSize: 24, marginLeft: 10, marginTop: -2 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 7 },
  rank: { color: T.muted, width: 26, fontSize: 16, fontFamily: F.x },

  notice: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 16, padding: 16, marginTop: 18 },
  noticeAction: { fontFamily: F.b, fontSize: 15, marginLeft: 12 },

  tag: { alignSelf: 'flex-start', color: T.muted, backgroundColor: T.raised, fontSize: 12, fontFamily: F.s, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, overflow: 'hidden' },
  tagCash: { color: T.ink, backgroundColor: T.lime },
  balancePill: { backgroundColor: T.raised, borderRadius: 18, height: 36, paddingHorizontal: 14, justifyContent: 'center' },
  balanceText: { color: T.text, fontFamily: F.b, fontSize: 15 },

  bar: { height: 8, borderRadius: 4, backgroundColor: alpha('#FFFFFF', 0.08), overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4 },

  showcase: { height: 300, marginTop: 24 },
  showCard: { borderRadius: 24, padding: 20, borderWidth: 1, backgroundColor: T.surface },
  steps: { flexDirection: 'row', marginTop: 22 },
  step: { flex: 1, marginRight: 8 },
  stepNum: { color: T.lime, fontFamily: F.x, fontSize: 22 },
  stepText: { color: T.text, fontFamily: F.s, fontSize: 14, lineHeight: 19 },

  today: { borderRadius: 24, padding: 18, borderWidth: 1 },
  todayName: { color: T.text, fontSize: 18, fontFamily: F.b },
  doneRow: { flexDirection: 'row', alignItems: 'center', borderRadius: 14, padding: 14, marginTop: 16 },
  tickDot: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginRight: 12 },

  cta: { borderRadius: 26, padding: 22, minHeight: 150, overflow: 'hidden' },
  ctaChip: { position: 'absolute', right: -34, top: -26, width: 170, height: 170, tintColor: alpha('#0A0C0B', 0.1) },
  ctaTitle: { color: T.ink, fontSize: 30, lineHeight: 36, fontFamily: F.x, letterSpacing: -0.6 },
  ctaSub: { color: alpha('#0A0C0B', 0.72), fontSize: 14, lineHeight: 20, fontFamily: F.m, marginTop: 6, maxWidth: '78%' },
  ctaArrow: { position: 'absolute', right: 18, bottom: 18, width: 46, height: 46, borderRadius: 23, backgroundColor: T.ink, alignItems: 'center', justifyContent: 'center' },
  ctaArrowText: { color: T.lime, fontSize: 22, fontFamily: F.b, marginTop: -2 },

  potCard: { borderRadius: 22, padding: 18, borderWidth: 1, backgroundColor: T.surface },
  potCardName: { color: T.text, fontSize: 19, fontFamily: F.b, marginTop: 14 },
  potCardAmt: { color: T.text, fontSize: 34, lineHeight: 42, fontFamily: F.x, marginTop: 10, letterSpacing: -0.8 },
  joinPill: { color: T.ink, fontFamily: F.b, fontSize: 12, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5, overflow: 'hidden' },

  tiles: { flexDirection: 'row' },
  tile: { flex: 1, backgroundColor: T.surface, borderRadius: 20, padding: 16, marginRight: 12, borderWidth: 1, borderColor: T.line },
  tileTitle: { color: T.text, fontSize: 16, fontFamily: F.b, marginTop: 12 },

  goalGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: 20 },
  goalTile: { width: '48.5%', backgroundColor: T.surface, borderRadius: 20, padding: 14, marginBottom: 10, borderWidth: 1.5, borderColor: T.line },
  goalTileSmall: { width: '31.8%', padding: 12, alignItems: 'flex-start' },
  goalLabel: { color: T.text, fontSize: 15, fontFamily: F.b, marginTop: 10 },

  takeCard: { borderRadius: 20, borderWidth: 1, padding: 18, marginTop: 22, backgroundColor: T.surface },
  takeAmt: { color: T.text, fontSize: 36, lineHeight: 44, fontFamily: F.x, letterSpacing: -0.8 },
  takeGain: { fontSize: 18, fontFamily: F.b },

  stats: { flexDirection: 'row', marginTop: 18, paddingVertical: 14, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: T.line },
  statValue: { color: T.text, fontSize: 18, fontFamily: F.b, marginTop: 2 },

  winCard: { borderRadius: 22, padding: 20, marginTop: 20 },
  winTitle: { color: T.ink, fontSize: 26, fontFamily: F.x },
  winSub: { color: alpha('#0A0C0B', 0.72), fontSize: 15, fontFamily: F.m, marginTop: 4 },

  invite: { backgroundColor: T.surface, borderRadius: 22, padding: 18, marginTop: 20, borderWidth: 1 },
  inviteCode: { fontSize: 42, fontFamily: F.x, letterSpacing: 8, marginVertical: 8 },

  member: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.line },
  days: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 12, marginLeft: 46 },
  day: { width: 16, height: 16, borderRadius: 5, marginRight: 5, marginBottom: 5 },

  walletCard: { borderRadius: 26, padding: 22, overflow: 'hidden' },
  walletChip: { position: 'absolute', right: -30, top: -30, width: 160, height: 160, opacity: 0.18 },

  podium: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 22 },
  podiumCard: { width: '31.5%', borderRadius: 20, borderWidth: 1, padding: 12, alignItems: 'center' },
  podiumRank: { fontFamily: F.x, fontSize: 15, marginBottom: 8 },
  podiumName: { color: T.text, fontFamily: F.s, fontSize: 14, marginTop: 8 },
  podiumAmt: { fontFamily: F.b, fontSize: 15, marginTop: 2 },

  rule: { flexDirection: 'row', paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.line },
  ruleNum: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', marginRight: 14 },
  ruleNumText: { fontFamily: F.x, fontSize: 15 },
});
