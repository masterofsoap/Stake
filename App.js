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
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as api from './src/api';
import { API_URL } from './src/config';
import { fmt, errMsg, GOALS, STAKES, DURATIONS, dayStatusColor, TYPE_LABEL } from './src/util';

const KEY = 'stake:v1';
const C = {
  bg: '#0B0F0D',
  card: '#131A16',
  line: '#243029',
  text: '#F2F7F4',
  sub: '#8CA096',
  lime: '#C6F135',
  limeText: '#0B0F0D',
  red: '#FF5A5F',
  orange: '#FFB020',
};

/* ---------- small UI pieces ---------- */

const Card = ({ children, style }) => <View style={[s.card, style]}>{children}</View>;
const Label = ({ children }) => <Text style={s.label}>{children}</Text>;

const Btn = ({ title, onPress, kind = 'primary', disabled, style }) => (
  <TouchableOpacity
    activeOpacity={0.85}
    disabled={disabled}
    onPress={onPress}
    style={[s.btn, kind === 'ghost' && s.btnGhost, kind === 'danger' && s.btnDanger, disabled && { opacity: 0.4 }, style]}
  >
    <Text style={[s.btnText, kind !== 'primary' && { color: kind === 'danger' ? C.red : C.lime }]}>{title}</Text>
  </TouchableOpacity>
);

const Chip = ({ label, active, onPress }) => (
  <TouchableOpacity onPress={onPress} style={[s.chip, active && s.chipOn]}>
    <Text style={[s.chipText, active && { color: C.limeText, fontWeight: '800' }]}>{label}</Text>
  </TouchableOpacity>
);

const Money = ({ cents, big, color }) => (
  <Text style={[big ? s.moneyBig : s.money, color ? { color } : null]}>{fmt(cents)}</Text>
);

function Screen({ children, onBack, title, right, refreshing, onRefresh }) {
  return (
    <View style={s.root}>
      <View style={s.header}>
        {onBack ? (
          <TouchableOpacity onPress={onBack} style={s.back}>
            <Text style={s.backText}>‹</Text>
          </TouchableOpacity>
        ) : (
          <View style={s.back} />
        )}
        <Text style={s.headerTitle} numberOfLines={1}>
          {title}
        </Text>
        <View style={{ minWidth: 44, alignItems: 'flex-end' }}>{right}</View>
      </View>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={s.pad}
          keyboardShouldPersistTaps="handled"
          refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={C.lime} /> : undefined}
        >
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

function Dots({ days, onPressDay }) {
  return (
    <View style={s.dots}>
      {days.map((d, i) => {
        const dot = (
          <View
            style={[
              s.dot,
              { backgroundColor: dayStatusColor(d.status, C), borderColor: d.status === 'open' ? C.lime : d.status === 'future' ? C.line : dayStatusColor(d.status, C) },
            ]}
          />
        );
        return onPressDay && d.status === 'done' ? (
          <TouchableOpacity key={d.date} onPress={() => onPressDay(d, i)} hitSlop={{ top: 6, bottom: 6, left: 3, right: 3 }}>
            {dot}
          </TouchableOpacity>
        ) : (
          <View key={d.date}>{dot}</View>
        );
      })}
    </View>
  );
}

/* ---------- welcome ---------- */

function Welcome({ onDone }) {
  const [name, setName] = useState('');
  const [state, setState] = useState('');
  const [adult, setAdult] = useState(false);
  const [busy, setBusy] = useState(false);

  const go = async () => {
    setBusy(true);
    try {
      const r = await api.signup(name.trim(), state.trim().toUpperCase());
      await onDone({ token: r.token, userId: r.userId, name: r.name });
    } catch (e) {
      Alert.alert("Couldn't sign you up", errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const ready = name.trim().length >= 2 && /^[A-Za-z]{2}$/.test(state.trim()) && adult;
  return (
    <Screen title="">
      <Text style={s.logoWord}>stake</Text>
      <Text style={s.hero}>Bet on yourself.{'\n'}Win with your friends.</Text>
      <Text style={s.sub}>
        Put money on a health goal. Hit it and you get your stake back plus a cut of everyone who quit on theirs.
      </Text>

      <Card style={{ marginTop: 20 }}>
        <Label>Your name</Label>
        <TextInput style={s.input} value={name} onChangeText={setName} placeholder="What your friends call you" placeholderTextColor={C.sub} maxLength={20} />
        <Label>Your state (2 letters)</Label>
        <TextInput
          style={s.input}
          value={state}
          onChangeText={setState}
          placeholder="CO"
          placeholderTextColor={C.sub}
          autoCapitalize="characters"
          maxLength={2}
        />
        <TouchableOpacity onPress={() => setAdult(!adult)} style={s.check}>
          <Text style={s.checkBox}>{adult ? '☑' : '☐'}</Text>
          <Text style={s.checkText}>I'm 18 or older</Text>
        </TouchableOpacity>
      </Card>
      <Btn title={busy ? 'One sec...' : "Let's go"} onPress={go} disabled={!ready || busy} />
    </Screen>
  );
}

/* ---------- home ---------- */

const STATUS_TEXT = { open: 'Waiting for friends', active: 'Live', settled: 'Finished', cancelled: 'Cancelled' };

function Home({ session, nav }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    try {
      setData(await api.me(session.token));
      setErr('');
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  useEffect(() => {
    load();
  }, []);

  const pots = data ? data.pots : [];
  const live = pots.filter((p) => p.status === 'open' || p.status === 'active');
  const done = pots.filter((p) => p.status === 'settled' || p.status === 'cancelled');

  const PotRow = ({ p }) => (
    <TouchableOpacity onPress={() => nav.push('pot', { potId: p.id })} activeOpacity={0.85}>
      <Card>
        <View style={s.rowBetween}>
          <Text style={s.potName} numberOfLines={1}>
            {p.name}
          </Text>
          <Money cents={p.potCents} color={C.lime} />
        </View>
        <Text style={s.sub}>{p.goalText}</Text>
        <Text style={[s.sub, { marginTop: 6 }]}>
          {STATUS_TEXT[p.status]} · {p.memberCount} in · {p.durationDays} days · {fmt(p.stakeCents)} each
        </Text>
      </Card>
    </TouchableOpacity>
  );

  return (
    <Screen
      title="stake"
      refreshing={refreshing}
      onRefresh={async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
      }}
      right={
        <TouchableOpacity onPress={() => nav.push('wallet')} style={s.walletPill}>
          <Text style={s.walletText}>{data ? fmt(data.balanceCents) : '...'}</Text>
        </TouchableOpacity>
      }
    >
      <Text style={s.hello}>Hey {session.name} 👋</Text>
      {data && data.demoMode ? <Text style={s.demo}>Play-money mode: no real cash moves.</Text> : null}
      {err ? <Text style={s.err}>{err}</Text> : null}

      <View style={s.row}>
        <Btn title="＋ New pot" onPress={() => nav.push('create')} style={{ flex: 1, marginRight: 8 }} />
        <Btn title="Join a pot" kind="ghost" onPress={() => nav.push('join')} style={{ flex: 1 }} />
      </View>

      {live.length ? <Label>YOUR POTS</Label> : null}
      {live.map((p) => (
        <PotRow key={p.id} p={p} />
      ))}
      {data && !pots.length ? (
        <Card style={{ marginTop: 14 }}>
          <Text style={s.potName}>No pots yet</Text>
          <Text style={s.sub}>Start one with a friend. Pick a goal, put in $10, and see who's serious.</Text>
        </Card>
      ) : null}
      {done.length ? <Label>PAST</Label> : null}
      {done.map((p) => (
        <PotRow key={p.id} p={p} />
      ))}
    </Screen>
  );
}

/* ---------- create ---------- */

function Create({ session, nav }) {
  const [goal, setGoal] = useState(GOALS[0]);
  const [goalText, setGoalText] = useState(GOALS[0].text);
  const [name, setName] = useState(GOALS[0].name);
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
      });
      nav.replace('pot', { potId: r.id });
    } catch (e) {
      Alert.alert("Couldn't create the pot", errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="New pot" onBack={nav.back}>
      <Label>GOAL</Label>
      <View style={s.wrap}>
        {GOALS.map((g) => (
          <Chip key={g.type} label={`${g.emoji} ${g.label}`} active={goal.type === g.type} onPress={() => pick(g)} />
        ))}
      </View>
      <TextInput style={s.input} value={goalText} onChangeText={setGoalText} placeholder="What counts as a win each day?" placeholderTextColor={C.sub} maxLength={120} />
      <Label>POT NAME</Label>
      <TextInput style={s.input} value={name} onChangeText={setName} placeholder="Name it" placeholderTextColor={C.sub} maxLength={40} />

      <Label>HOW LONG</Label>
      <View style={s.wrap}>
        {DURATIONS.map((d) => (
          <Chip key={d} label={`${d} days`} active={days === d} onPress={() => setDays(d)} />
        ))}
      </View>
      <Label>STAKE (EACH PERSON)</Label>
      <View style={s.wrap}>
        {STAKES.map((v) => (
          <Chip key={v} label={fmt(v)} active={stake === v} onPress={() => setStake(v)} />
        ))}
      </View>
      <Label>MAX PEOPLE</Label>
      <View style={s.wrap}>
        {[2, 4, 6, 10, 20].map((v) => (
          <Chip key={v} label={String(v)} active={max === v} onPress={() => setMax(v)} />
        ))}
      </View>
      <TouchableOpacity onPress={() => setStrict(!strict)} style={s.check}>
        <Text style={s.checkBox}>{strict ? '☑' : '☐'}</Text>
        <Text style={s.checkText}>Hard mode: zero misses allowed</Text>
      </TouchableOpacity>

      <Card>
        <Text style={s.potName}>The rules</Text>
        <Text style={s.rule}>• Check in once a day. Friends can dispute a check-in that looks fake.</Text>
        <Text style={s.rule}>
          • {strict ? 'Miss a single day and you lose your stake.' : `You can miss up to ${allowed} of ${days} days and still win.`}
        </Text>
        <Text style={s.rule}>• Losers' stakes get split between the winners. Stake keeps 10% of what's forfeited.</Text>
        <Text style={s.rule}>• If everyone wins, everyone gets their money back.</Text>
        <Text style={[s.rule, { color: C.lime, fontWeight: '700' }]}>You put in {fmt(stake)} now.</Text>
      </Card>
      <Btn title={busy ? 'Creating...' : `Create pot · ${fmt(stake)}`} onPress={create} disabled={busy || name.trim().length < 2 || goalText.trim().length < 3} />
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
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Join a pot" onBack={nav.back}>
      <Label>ENTER THE CODE YOUR FRIEND SENT</Label>
      <TextInput
        style={[s.input, s.codeInput]}
        value={code}
        onChangeText={(t) => {
          setCode(t.toUpperCase());
          setPreview(null);
        }}
        placeholder="ABC123"
        placeholderTextColor={C.sub}
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={6}
      />
      {!preview ? <Btn title={busy ? 'Looking...' : 'Look it up'} onPress={look} disabled={busy || code.trim().length < 6} /> : null}
      {preview ? (
        <>
          <Card>
            <Text style={s.potName}>{preview.name}</Text>
            <Text style={s.sub}>
              {preview.goalText} · by {preview.creator}
            </Text>
            <View style={[s.rowBetween, { marginTop: 12 }]}>
              <Text style={s.sub}>{preview.durationDays} days</Text>
              <Text style={s.sub}>
                {preview.memberCount}/{preview.maxMembers} in
              </Text>
              <Money cents={preview.stakeCents} color={C.lime} />
            </View>
          </Card>
          <Btn title={busy ? 'Joining...' : `Join · put in ${fmt(preview.stakeCents)}`} onPress={join} disabled={busy || preview.status !== 'open'} />
          {preview.status !== 'open' ? <Text style={s.err}>That pot already started.</Text> : null}
        </>
      ) : null}
    </Screen>
  );
}

/* ---------- pot detail ---------- */

function PotScreen({ session, nav, potId }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

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
        {err ? <Text style={s.err}>{err}</Text> : <Text style={s.sub}>Loading...</Text>}
      </Screen>
    );
  }

  const { pot, members, me, results } = d;
  const mine = members.find((m) => m.isMe);
  const isCreator = pot.creatorId === session.userId;
  const myResult = results ? results.find((r) => r.userId === session.userId) : null;
  const invite = () =>
    Share.share({
      message: `Join my Stake pot "${pot.name}": ${pot.goalText}. ${fmt(pot.stakeCents)} each for ${pot.durationDays} days.\nCode: ${pot.joinCode}\n${API_URL}/j/${pot.joinCode}`,
    });

  const disputeDay = (member, day, idx) => {
    if (member.isMe || pot.status !== 'active') return;
    Alert.alert(
      `Dispute ${member.name}'s day ${idx + 1}?`,
      `If most of the others agree it doesn't count, it's thrown out. You have ${me.disputesLeft} dispute${me.disputesLeft === 1 ? '' : 's'} left in this pot.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Dispute', style: 'destructive', onPress: () => act(() => api.dispute(session.token, potId, member.id, day.date)) },
      ]
    );
  };

  return (
    <Screen
      title={pot.name}
      onBack={nav.back}
      refreshing={refreshing}
      onRefresh={async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
      }}
    >
      <Card style={{ alignItems: 'center' }}>
        <Text style={s.sub}>IN THE POT</Text>
        <Money cents={pot.potCents} big />
        <Text style={s.goal}>{pot.goalText}</Text>
        <Text style={s.sub}>
          {fmt(pot.stakeCents)} each · {pot.durationDays} days · {pot.strict ? 'hard mode' : `miss up to ${mine ? mine.allowed : Math.floor(pot.durationDays * 0.2)}`}
        </Text>
      </Card>

      {pot.status === 'settled' && myResult ? (
        <Card style={{ borderColor: C.lime }}>
          <Text style={[s.potName, { color: C.lime }]}>
            {myResult.type === 'payout' ? `🏆 You won ${fmt(myResult.amountCents - pot.stakeCents)}` : '✅ Everyone hit their goal. Stakes returned.'}
          </Text>
          <Text style={s.sub}>
            {myResult.type === 'payout'
              ? `${fmt(myResult.amountCents)} was added to your wallet (your stake back plus winnings).`
              : `${fmt(myResult.amountCents)} was added back to your wallet.`}
          </Text>
        </Card>
      ) : null}
      {pot.status === 'settled' && !myResult ? (
        <Card style={{ borderColor: C.red }}>
          <Text style={[s.potName, { color: C.red }]}>You lost your {fmt(pot.stakeCents)}</Text>
          <Text style={s.sub}>It went to the people who hit the goal. Run it back?</Text>
        </Card>
      ) : null}
      {pot.status === 'cancelled' ? <Text style={s.err}>This pot was cancelled and everyone was refunded.</Text> : null}

      {pot.status === 'open' ? (
        <Card>
          <Text style={s.potName}>Invite your people</Text>
          <Text style={s.sub}>
            {pot.memberCount}/{pot.maxMembers} in. Share this code:
          </Text>
          <Text style={s.code}>{pot.joinCode}</Text>
          <Btn title="Share invite" onPress={invite} />
        </Card>
      ) : null}

      {pot.status === 'active' && mine ? (
        <>
          {me.checkedInToday ? (
            <Card style={{ borderColor: C.lime }}>
              <Text style={[s.potName, { color: C.lime }]}>✅ Checked in for today</Text>
              <Text style={s.sub}>Streak: {mine.streak} · {mine.valid}/{pot.durationDays} days</Text>
            </Card>
          ) : (
            <Btn title="✅ I did it today" onPress={() => act(() => api.checkin(session.token, potId, ''))} disabled={busy} style={s.bigBtn} />
          )}
        </>
      ) : null}

      <Label>THE PEOPLE</Label>
      {members.map((m) => (
        <Card key={m.id} style={m.isMe ? { borderColor: C.lime } : null}>
          <View style={s.rowBetween}>
            <Text style={s.potName}>
              {m.isMe ? 'You' : m.name}
              {isCreator && pot.creatorId === m.id ? '  👑' : ''}
            </Text>
            {pot.status === 'open' ? null : (
              <Text style={[s.sub, !m.alive && { color: C.red, fontWeight: '800' }]}>
                {!m.alive ? 'OUT' : `${m.valid}/${pot.durationDays} · 🔥${m.streak}`}
              </Text>
            )}
          </View>
          {m.days && m.days.length ? <Dots days={m.days} onPressDay={m.isMe ? null : (day, i) => disputeDay(m, day, i)} /> : null}
          {m.days && m.days.length && !m.isMe && pot.status === 'active' ? <Text style={s.tiny}>Tap a green dot to dispute that day</Text> : null}
        </Card>
      ))}

      {pot.status === 'open' && isCreator ? (
        <>
          <Btn
            title={busy ? '...' : 'Start the pot'}
            onPress={() =>
              Alert.alert('Start now?', `${pot.memberCount} people are in. Nobody else can join once it starts.`, [
                { text: 'Not yet', style: 'cancel' },
                { text: 'Start', onPress: () => act(() => api.startPot(session.token, potId)) },
              ])
            }
            disabled={busy || pot.memberCount < 2}
          />
          {pot.memberCount < 2 ? <Text style={s.tiny}>You need at least one friend in to start.</Text> : null}
          <Btn
            title="Cancel pot and refund everyone"
            kind="danger"
            onPress={() => act(async () => { await api.cancelPot(session.token, potId); nav.back(); }, false)}
            disabled={busy}
            style={{ marginTop: 10 }}
          />
        </>
      ) : null}
      {pot.status === 'open' && !isCreator ? (
        <Btn
          title="Leave and get my stake back"
          kind="danger"
          onPress={() => act(async () => { await api.leavePot(session.token, potId); nav.back(); }, false)}
          disabled={busy}
        />
      ) : null}
      {err ? <Text style={s.err}>{err}</Text> : null}
    </Screen>
  );
}

/* ---------- wallet ---------- */

function Wallet({ session, nav }) {
  const [w, setW] = useState(null);
  const [amt, setAmt] = useState(2500);
  const [wd, setWd] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setW(await api.wallet(session.token));
    } catch (e) {
      Alert.alert('Hold on', errMsg(e));
    }
  };
  useEffect(() => {
    load();
  }, []);

  const add = async () => {
    setBusy(true);
    try {
      const r = await api.checkout(session.token, amt);
      if (r.url) {
        Linking.openURL(r.url);
        Alert.alert('Finish paying in your browser', 'Come back here after. Your balance updates in a few seconds.');
      }
      await load();
    } catch (e) {
      Alert.alert("Couldn't add money", errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const withdraw = async () => {
    const cents = Math.round(parseFloat(wd) * 100);
    if (!(cents >= 1000)) return Alert.alert('Minimum withdrawal', 'The minimum is $10.');
    setBusy(true);
    try {
      await api.withdraw(session.token, cents);
      setWd('');
      Alert.alert('Request sent', "We'll pay it out and mark it done. It shows below until then.");
      await load();
    } catch (e) {
      Alert.alert("Couldn't withdraw", errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Wallet" onBack={nav.back}>
      <Card style={{ alignItems: 'center' }}>
        <Text style={s.sub}>BALANCE</Text>
        <Money cents={w ? w.balanceCents : 0} big />
        {w && w.demoMode ? <Text style={s.demo}>Play-money mode: top-ups are free and not real cash.</Text> : null}
      </Card>

      <Label>ADD MONEY</Label>
      <View style={s.wrap}>
        {[1000, 2500, 5000, 10000].map((v) => (
          <Chip key={v} label={fmt(v)} active={amt === v} onPress={() => setAmt(v)} />
        ))}
      </View>
      <Btn title={busy ? '...' : `Add ${fmt(amt)}`} onPress={add} disabled={busy} />

      <Label>CASH OUT</Label>
      <View style={s.row}>
        <TextInput
          style={[s.input, { flex: 1, marginRight: 8, marginBottom: 0 }]}
          value={wd}
          onChangeText={setWd}
          placeholder="Amount in dollars"
          placeholderTextColor={C.sub}
          keyboardType="decimal-pad"
        />
        <Btn title="Request" kind="ghost" onPress={withdraw} disabled={busy || !wd} style={{ paddingHorizontal: 18 }} />
      </View>
      {w && w.withdrawals.filter((x) => x.status === 'pending').map((x) => (
        <Text key={x.id} style={s.tiny}>Pending withdrawal: {fmt(x.amount_cents)}</Text>
      ))}

      <Label>HISTORY</Label>
      {w && !w.entries.length ? <Text style={s.sub}>Nothing yet.</Text> : null}
      {w &&
        w.entries.map((e, i) => (
          <View key={i} style={s.histRow}>
            <Text style={s.histText}>{TYPE_LABEL[e.type] || e.type}</Text>
            <Text style={[s.histAmt, { color: e.amount_cents >= 0 ? C.lime : C.text }]}>
              {e.amount_cents >= 0 ? '+' : ''}
              {fmt(e.amount_cents)}
            </Text>
          </View>
        ))}
    </Screen>
  );
}

/* ---------- app shell ---------- */

export default function App() {
  const [session, setSession] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [stack, setStack] = useState([{ name: 'home' }]);

  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((raw) => raw && setSession(JSON.parse(raw)))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

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

  if (!loaded) return <View style={s.root} />;

  if (!API_URL) {
    return (
      <Screen title="">
        <Text style={s.logoWord}>stake</Text>
        <Card>
          <Text style={s.potName}>One setup step</Text>
          <Text style={s.sub}>
            Deploy the backend (see README), then paste its URL into src/config.js as API_URL and reload the app.
          </Text>
        </Card>
      </Screen>
    );
  }
  if (!session) return <Welcome onDone={signedIn} />;

  const top = stack[stack.length - 1];
  const common = { session, nav };
  // key forces a fresh load whenever we land on a screen
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <StatusBar barStyle="light-content" />
      {top.name === 'home' && <Home key={'h' + stack.length} {...common} />}
      {top.name === 'create' && <Create {...common} />}
      {top.name === 'join' && <Join {...common} />}
      {top.name === 'wallet' && <Wallet {...common} />}
      {top.name === 'pot' && <PotScreen key={top.potId} {...common} potId={top.potId} />}
    </View>
  );
}

/* ---------- styles ---------- */

const TOP = Platform.OS === 'android' ? (StatusBar.currentHeight || 24) + 4 : 54;

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg, paddingTop: TOP },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, height: 48 },
  back: { width: 44, height: 44, justifyContent: 'center' },
  backText: { color: C.lime, fontSize: 34, fontWeight: '300', marginTop: -4 },
  headerTitle: { flex: 1, textAlign: 'center', color: C.text, fontSize: 18, fontWeight: '800' },
  pad: { padding: 16, paddingBottom: 60 },
  card: { backgroundColor: C.card, borderRadius: 18, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: C.line },
  label: { color: C.sub, fontSize: 12, fontWeight: '800', letterSpacing: 1, marginTop: 14, marginBottom: 8 },
  logoWord: { color: C.lime, fontSize: 46, fontWeight: '900', letterSpacing: -1, marginTop: 8 },
  hero: { color: C.text, fontSize: 30, fontWeight: '900', lineHeight: 36, marginTop: 8, marginBottom: 10 },
  hello: { color: C.text, fontSize: 24, fontWeight: '900', marginBottom: 10 },
  sub: { color: C.sub, fontSize: 14, lineHeight: 20 },
  tiny: { color: C.sub, fontSize: 12, marginTop: 8 },
  demo: { color: C.orange, fontSize: 12, fontWeight: '700', marginBottom: 8, marginTop: 6 },
  err: { color: C.red, fontSize: 14, marginVertical: 8 },
  input: {
    backgroundColor: '#0E1411',
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 12,
    padding: 13,
    fontSize: 16,
    color: C.text,
    marginBottom: 10,
  },
  codeInput: { textAlign: 'center', fontSize: 30, letterSpacing: 8, fontWeight: '900', color: C.lime },
  code: { color: C.lime, fontSize: 40, fontWeight: '900', letterSpacing: 8, textAlign: 'center', marginVertical: 12 },
  row: { flexDirection: 'row', alignItems: 'center', marginVertical: 6 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 },
  chip: { borderWidth: 1, borderColor: C.line, borderRadius: 22, paddingVertical: 10, paddingHorizontal: 15, marginRight: 8, marginBottom: 8, backgroundColor: C.card },
  chipOn: { backgroundColor: C.lime, borderColor: C.lime },
  chipText: { color: C.text, fontSize: 14, fontWeight: '600' },
  btn: { backgroundColor: C.lime, borderRadius: 16, paddingVertical: 16, alignItems: 'center', marginTop: 6 },
  btnGhost: { backgroundColor: '#1A2420', borderWidth: 1, borderColor: C.line },
  btnDanger: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#4A2528' },
  btnText: { color: C.limeText, fontSize: 16, fontWeight: '900' },
  bigBtn: { paddingVertical: 22, marginBottom: 12 },
  check: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  checkBox: { color: C.lime, fontSize: 24, marginRight: 10 },
  checkText: { color: C.text, fontSize: 15 },
  potName: { color: C.text, fontSize: 18, fontWeight: '800', flexShrink: 1, marginRight: 8 },
  goal: { color: C.text, fontSize: 16, fontWeight: '600', textAlign: 'center', marginVertical: 8 },
  rule: { color: C.sub, fontSize: 14, lineHeight: 21, marginTop: 6 },
  money: { color: C.text, fontSize: 18, fontWeight: '900' },
  moneyBig: { color: C.lime, fontSize: 54, fontWeight: '900', marginVertical: 4 },
  walletPill: { backgroundColor: C.lime, borderRadius: 16, paddingVertical: 7, paddingHorizontal: 12 },
  walletText: { color: C.limeText, fontWeight: '900', fontSize: 14 },
  dots: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 12 },
  dot: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, marginRight: 6, marginBottom: 6 },
  histRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.line },
  histText: { color: C.text, fontSize: 14 },
  histAmt: { fontSize: 14, fontWeight: '800' },
});
