import 'react-native-url-polyfill/auto';
import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Image,
  StyleSheet,
  ActivityIndicator,
  AppState,
  StatusBar
} from 'react-native';

import {
  SafeAreaProvider,
  SafeAreaView
} from 'react-native-safe-area-context';

import * as SecureStore from 'expo-secure-store';
import { createClient } from '@supabase/supabase-js';

const URL =
  process.env.EXPO_PUBLIC_SUPABASE_URL ||
  'https://hfhkscqmsmxsxzjfxzew.supabase.co';

const KEY =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ||
  'sb_publishable_F9NNkmsikUX_jcNK8zgjOw_hFotc3Pf';

const db = createClient(URL, KEY, {
  auth: {
    storage: {
      getItem: key => SecureStore.getItemAsync(key),
      setItem: (key, value) =>
        SecureStore.setItemAsync(key, value),
      removeItem: key =>
        SecureStore.deleteItemAsync(key)
    },
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false
  }
});

const G = '#06432D';
const Y = '#FFB600';

const states = {
  requested: 'بانتظار العروض',
  accepted: 'تم الاتفاق',
  arrived: 'وصل السائق',
  in_progress: 'الرحلة جارية',
  completed: 'مكتملة',
  cancelled: 'ملغاة'
};

function check({ data, error }) {
  if (error) throw error;
  return data;
}

function errorMessage(error) {
  const message = error?.message || '';

  if (message.includes('Invalid login credentials'))
    return 'البريد الإلكتروني أو كلمة المرور غير صحيحة';

  if (message.includes('Email not confirmed'))
    return 'يرجى تأكيد بريدك الإلكتروني أولاً';

  if (message.includes('rate limit'))
    return 'انتظر قليلاً قبل المحاولة مرة أخرى';

  if (message.includes('expired'))
    return 'انتهت صلاحية الرمز. اطلب رمزاً جديداً';

  return message || 'حدث خطأ. حاول مرة أخرى';
}

function Button({
  children,
  onPress,
  secondary = false,
  disabled = false
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[
        s.button,
        secondary && s.secondary,
        disabled && { opacity: 0.5 }
      ]}
    >
      <Text style={s.buttonText}>
        {children}
      </Text>
    </TouchableOpacity>
  );
}

function Field({
  label,
  value,
  onChangeText,
  keyboardType = 'default',
  secure = false
}) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={s.label}>{label}</Text>

      <TextInput
        accessibilityLabel={label}
        style={s.input}
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType}
        secureTextEntry={secure}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );
}

function Main() {
  const [session, S] = useState(null);
  const [profile, P] = useState(null);
  const [loading, L] = useState(true);

  const [mode, SM] = useState('login');
  const [email, SE] = useState('');
  const [password, SW] = useState('');
  const [otp, O] = useState('');
  const [phone, F] = useState('+249');

  const [name, N] = useState('');
  const [role, R] = useState('passenger');

  const [driver, SD] = useState(null);
  const [plate, SP] = useState('');
  const [vehicles, SV] = useState([]);

  const [pickup, A] = useState('');
  const [dest, B] = useState('');
  const [vehicle, V] = useState('rickshaw');
  const [price, Q] = useState('');

  const [trips, U] = useState([]);
  const [offers, H] = useState([]);
  const [bid, J] = useState({});

  const [busy, K] = useState(false);
  const [err, E] = useState('');
  const [notice, SN] = useState('');
  const [tab, D] = useState('home');

  const run = async fn => {
    K(true);
    E('');
    SN('');

    try {
      await fn();
    } catch (e) {
      E(errorMessage(e));
    } finally {
      K(false);
    }
  };

  async function authenticate() {
    const address = email.trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))
      throw Error('أدخل بريداً إلكترونياً صحيحاً');

    if (mode === 'verify') {
      if (!/^\d{6}$/.test(otp.trim()))
        throw Error('أدخل رمز التحقق المكون من 6 أرقام');

      check(await db.auth.verifyOtp({
        email: address,
        token: otp.trim(),
        type: 'email'
      }));

      O('');
      SW('');
      return;
    }

    if (password.length < 8)
      throw Error('كلمة المرور يجب ألا تقل عن 8 أحرف');

    if (mode === 'register') {
      const data = check(await db.auth.signUp({
        email: address,
        password
      }));

      if (!data.session) {
        SM('verify');
        O('');
        SN('تم طلب رمز تأكيد البريد الإلكتروني');
      }

    } else {
      check(await db.auth.signInWithPassword({
        email: address,
        password
      }));

      SW('');
    }
  }

  async function resendCode() {
    check(await db.auth.resend({
      type: 'signup',
      email: email.trim().toLowerCase()
    }));

    SN('تم طلب إعادة إرسال رمز التأكيد');
  }

  async function refresh() {
    if (!session) return;

    try {
      const id = session.user.id;

      const p = check(
        await db.from('profiles')
          .select('*')
          .eq('id', id)
          .maybeSingle()
      );

      P(p);

      if (!p) return;

      const own = check(
        await db.from('rides')
          .select('*')
          .order('created_at', {
            ascending: false
          })
          .limit(50)
      );

      let available = [];

      if (p.role === 'driver') {
        const d = check(
          await db.from('drivers')
            .select('*')
            .eq('id', id)
            .maybeSingle()
        );

        SD(d);

        SV(check(
          await db.from('vehicles')
            .select('*')
            .eq('driver_id', id)
        ));

        if (d?.approved && d?.online) {
          available = check(
            await db.rpc('available_rides')
          ).map(r => ({
            ...r,
            status: 'requested'
          }));
        }
      }

      U([
        ...own,
        ...available.filter(
          r => !own.some(o => o.id === r.id)
        )
      ]);

      H(check(
        await db.from('ride_offers')
          .select('*')
          .order('created_at', {
            ascending: false
          })
          .limit(100)
      ));

    } catch (e) {
      E(errorMessage(e));
    } finally {
      L(false);
    }
  }

  useEffect(() => {
    db.auth.getSession().then(({ data }) => {
      S(data.session);
      if (!data.session) L(false);
    }).catch(() => L(false));

    const { data } = db.auth.onAuthStateChange(
      (_, value) => {
        S(value);

        if (!value) {
          P(null);
          SD(null);
          SV([]);
          U([]);
          H([]);
          L(false);
        }
      }
    );

    const appState = AppState.addEventListener(
      'change',
      state => {
        if (state === 'active')
          db.auth.startAutoRefresh();
        else
          db.auth.stopAutoRefresh();
      }
    );

    return () => {
      data.subscription.unsubscribe();
      appState.remove();
    };
  }, []);

  useEffect(() => {
    if (!session) return;

    refresh();

    const timer = setInterval(refresh, 12000);

    const channel = db
      .channel('arkab-' + session.user.id)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'rides'
      }, refresh)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'ride_offers'
      }, refresh)
      .subscribe();

    return () => {
      clearInterval(timer);
      db.removeChannel(channel);
    };
  }, [session?.user.id]);

  const act = fn => run(async () => {
    await fn();
    await refresh();
  });

  const rpc = (name, args) =>
    db.rpc(name, args).then(check);

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar
        barStyle="dark-content"
        backgroundColor="#F8F7F2"
      />

      <ScrollView
        contentContainerStyle={s.page}
        keyboardShouldPersistTaps="handled"
      >
        <View style={s.header}>
          <View>
            <Text style={s.brand}>أركب | ARKAB</Text>
            <Text style={s.mutedLight}>
              المناقل • مشوارك بقى أسهل
            </Text>
          </View>

          <Image
            source={require('./assets/logo.png')}
            style={s.logo}
          />
        </View>

        {!!err && (
          <Text style={s.error}>{err}</Text>
        )}

        {!!notice && (
          <Text style={s.success}>{notice}</Text>
        )}

        {(busy || loading) && (
          <ActivityIndicator color={G} />
        )}

        {!loading && !session ? (

          <View style={s.card}>
            <Text style={s.title}>
              {mode === 'register'
                ? 'إنشاء حساب جديد'
                : mode === 'verify'
                ? 'تأكيد البريد الإلكتروني'
                : 'أهلاً بيك'}
            </Text>

            <Field
              label="البريد الإلكتروني"
              value={email}
              onChangeText={SE}
              keyboardType="email-address"
            />

            {mode === 'verify' ? (
              <Field
                label="رمز التحقق"
                value={otp}
                onChangeText={O}
                keyboardType="number-pad"
              />
            ) : (
              <Field
                label="كلمة المرور"
                value={password}
                onChangeText={SW}
                secure
              />
            )}

            <Button
              disabled={busy}
              onPress={() => run(authenticate)}
            >
              {mode === 'register'
                ? 'إنشاء حساب'
                : mode === 'verify'
                ? 'تأكيد الرمز'
                : 'تسجيل الدخول'}
            </Button>

            {mode === 'verify' ? (
              <Button
                secondary
                disabled={busy}
                onPress={() => run(resendCode)}
              >
                إعادة إرسال الرمز
              </Button>
            ) : (
              <Button
                secondary
                disabled={busy}
                onPress={() => {
                  E('');
                  SM(mode === 'login'
                    ? 'register'
                    : 'login');
                }}
              >
                {mode === 'login'
                  ? 'إنشاء حساب جديد'
                  : 'لدي حساب بالفعل'}
              </Button>
            )}

            {mode !== 'login' && (
              <Button
                secondary
                onPress={() => {
                  SM('login');
                  E('');
                }}
              >
                العودة لتسجيل الدخول
              </Button>
            )}
          </View>

        ) : !loading && session && !profile ? (

          <View style={s.card}>
            <Text style={s.title}>أكمل حسابك</Text>

            <Field
              label="الاسم الكامل"
              value={name}
              onChangeText={N}
            />

            <Field
              label="رقم هاتف التواصل"
              value={phone}
              onChangeText={F}
              keyboardType="phone-pad"
            />

            <Text style={s.body}>
              رقم التواصل غير موثّق عبر SMS.
            </Text>

            <View style={s.row}>
              <Button
                secondary={role !== 'passenger'}
                onPress={() => R('passenger')}
              >
                راكب
              </Button>

              <Button
                secondary={role !== 'driver'}
                onPress={() => R('driver')}
              >
                كابتن
              </Button>
            </View>

            <Button
              disabled={busy}
              onPress={() => act(async () => {
                if (!name.trim())
                  throw Error('أدخل اسمك الكامل');

                if (!/^\+249\d{9}$/.test(phone.trim()))
                  throw Error('أدخل رقم هاتف سودانياً صحيحاً');

                check(await db.auth.updateUser({
                  data: {
                    contact_phone: phone.trim()
                  }
                }));

                check(await db.from('profiles').insert({
                  id: session.user.id,
                  full_name: name.trim(),
                  role
                }));
              })}
            >
              حفظ الحساب
            </Button>
          </View>

        ) : session && profile ? (

          <>
            <View style={s.hero}>
              <Text style={s.heroTitle}>
                أهلاً {profile.full_name}
              </Text>

              <Text style={s.mutedLight}>
                {profile.role === 'driver'
                  ? 'مساحة الكابتن'
                  : 'وين ماشي اليوم؟'}
              </Text>
            </View>

            <View style={s.row}>
              <Button
                secondary={tab !== 'home'}
                onPress={() => D('home')}
              >
                الرئيسية
              </Button>

              <Button
                secondary={tab !== 'trips'}
                onPress={() => {
                  D('trips');
                  refresh();
                }}
              >
                الرحلات
              </Button>

              <Button
                secondary
                onPress={() =>
                  run(() => db.auth.signOut().then(check))
                }
              >
                خروج
              </Button>
            </View>

            {profile.role === 'passenger' &&
              tab === 'home' && (
              <View style={s.card}>
                <Text style={s.title}>احجز مشوارك</Text>

                <Field
                  label="مكان الانطلاق"
                  value={pickup}
                  onChangeText={A}
                />

                <Field
                  label="الوجهة"
                  value={dest}
                  onChangeText={B}
                />

                <View style={s.row}>
                  <Button
                    secondary={vehicle !== 'rickshaw'}
                    onPress={() => V('rickshaw')}
                  >
                    ركشة
                  </Button>

                  <Button
                    secondary={vehicle !== 'cargo_tuktuk'}
                    onPress={() => V('cargo_tuktuk')}
                  >
                    تكتك نقل
                  </Button>
                </View>

                <Field
                  label="السعر المقترح بالجنيه السوداني"
                  value={price}
                  onChangeText={Q}
                  keyboardType="numeric"
                />

                <Button
                  disabled={busy}
                  onPress={() => act(async () => {
                    if (
                      !pickup.trim() ||
                      !dest.trim() ||
                      !Number.isFinite(Number(price)) ||
                      Number(price) <= 0
                    )
                      throw Error('أدخل المواقع والسعر الصحيح');

                    check(await db.from('rides').insert({
                      passenger_id: session.user.id,
                      pickup: pickup.trim(),
                      destination: dest.trim(),
                      vehicle_kind: vehicle,
                      proposed_fare: Number(price)
                    }));

                    A('');
                    B('');
                    Q('');
                    D('trips');
                  })}
                >
                  اطلب مشوارك
                </Button>
              </View>
            )}

            {profile.role === 'driver' && (
              <View style={s.card}>
                <Text style={s.title}>إدارة حساب الكابتن</Text>

                {!driver ? (
                  <Button
                    disabled={busy}
                    onPress={() => act(() =>
                      db.from('drivers').insert({
                        id: session.user.id
                      }).then(check)
                    )}
                  >
                    تسجيل حساب الكابتن
                  </Button>
                ) : (
                  <>
                    <Text style={s.body}>
                      {driver.approved
                        ? 'حساب معتمد'
                        : 'بانتظار اعتماد الإدارة'}
                    </Text>

                    {driver.approved && (
                      <Button
                        disabled={busy}
                        onPress={() => act(() =>
                          db.from('drivers')
                            .update({
                              online: !driver.online
                            })
                            .eq('id', session.user.id)
                            .then(check)
                        )}
                      >
                        {driver.online
                          ? 'إيقاف استقبال الطلبات'
                          : 'استقبال الطلبات'}
                      </Button>
                    )}

                    <Field
                      label="رقم اللوحة"
                      value={plate}
                      onChangeText={SP}
                    />

                    <View style={s.row}>
                      <Button
                        secondary={vehicle !== 'rickshaw'}
                        onPress={() => V('rickshaw')}
                      >
                        ركشة
                      </Button>

                      <Button
                        secondary={vehicle !== 'cargo_tuktuk'}
                        onPress={() => V('cargo_tuktuk')}
                      >
                        تكتك نقل
                      </Button>
                    </View>

                    <Button
                      disabled={busy || !plate.trim()}
                      onPress={() => act(async () => {
                        check(await db.from('vehicles').insert({
                          driver_id: session.user.id,
                          kind: vehicle,
                          plate: plate.trim()
                        }));

                        SP('');
                      })}
                    >
                      تسجيل المركبة
                    </Button>

                    {vehicles.map(v => (
                      <Text key={v.id} style={s.body}>
                        {v.plate} • {
                          v.approved
                            ? 'معتمدة'
                            : 'بانتظار الاعتماد'
                        }
                      </Text>
                    ))}
                  </>
                )}
              </View>
            )}

            <Text style={s.title}>
              {profile.role === 'driver'
                ? 'الطلبات المتاحة ورحلاتي'
                : 'رحلاتي'}
            </Text>

            {!trips.length && (
              <Text style={s.body}>
                لا توجد رحلات حالياً.
              </Text>
            )}

            {trips.map(t => (
              <View style={s.card} key={t.id}>
                <Text style={s.label}>
                  {states[t.status]} • {
                    t.vehicle_kind === 'rickshaw'
                      ? 'ركشة'
                      : 'تكتك نقل'
                  }
                </Text>

                <Text style={s.title}>
                  {t.pickup} ← {t.destination}
                </Text>

                <Text style={s.fare}>
                  {t.agreed_fare ?? t.proposed_fare} ج.س
                </Text>

                {profile.role === 'driver' &&
                 driver?.approved &&
                 t.status === 'requested' && (
                  <>
                    <Field
                      label="عرضك بالجنيه"
                      value={bid[t.id] || ''}
                      onChangeText={v =>
                        J(prev => ({
                          ...prev,
                          [t.id]: v
                        }))
                      }
                      keyboardType="numeric"
                    />

                    <Button
                      disabled={busy}
                      onPress={() => act(async () => {
                        const fare = Number(
                          bid[t.id] || t.proposed_fare
                        );

                        if (!Number.isFinite(fare) || fare <= 0)
                          throw Error('أدخل سعراً صحيحاً');

                        await rpc('submit_offer', {
                          p_ride: t.id,
                          p_fare: fare
                        });
                      })}
                    >
                      إرسال العرض
                    </Button>
                  </>
                )}

                {profile.role === 'passenger' &&
                 t.status === 'requested' &&
                 offers.filter(o => o.ride_id === t.id)
                   .map(o => (
                    <View key={o.id} style={s.offer}>
                      <Text style={s.body}>{o.fare} ج.س</Text>

                      <Button
                        disabled={busy}
                        onPress={() => act(() =>
                          rpc('accept_offer', {
                            p_offer: o.id,
                            p_expected_fare: o.fare
                          })
                        )}
                      >
                        قبول العرض
                      </Button>
                    </View>
                  ))}

                {profile.role === 'driver' &&
                 t.driver_id === session.user.id &&
                 ['accepted', 'arrived', 'in_progress']
                   .includes(t.status) && (
                  <Button
                    disabled={busy}
                    onPress={() => act(() =>
                      rpc('advance_ride', {
                        p_ride: t.id,
                        p_status: {
                          accepted: 'arrived',
                          arrived: 'in_progress',
                          in_progress: 'completed'
                        }[t.status]
                      })
                    )}
                  >
                    {t.status === 'accepted'
                      ? 'وصلت للموقع'
                      : t.status === 'arrived'
                      ? 'بدء الرحلة'
                      : 'إنهاء الرحلة'}
                  </Button>
                )}

                {profile.role === 'passenger' &&
                 t.status === 'requested' && (
                  <Button
                    secondary
                    disabled={busy}
                    onPress={() => act(() =>
                      rpc('advance_ride', {
                        p_ride: t.id,
                        p_status: 'cancelled'
                      })
                    )}
                  >
                    إلغاء الطلب
                  </Button>
                )}
              </View>
            ))}
          </>
        ) : null}

        <Text style={s.footer}>
          ARKAB • نسخة اختبار 0.3
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Main />
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#F8F7F2'
  },
  page: {
    padding: 18,
    gap: 16,
    paddingBottom: 32
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: G,
    padding: 18,
    borderRadius: 22
  },
  logo: {
    width: 74,
    height: 74,
    borderRadius: 12,
    resizeMode: 'contain',
    backgroundColor: '#FFFFFF'
  },
  brand: {
    color: '#FFFFFF',
    fontSize: 25,
    fontWeight: '900'
  },
  mutedLight: {
    color: '#E3EDE7',
    fontSize: 13,
    textAlign: 'right'
  },
  hero: {
    backgroundColor: G,
    padding: 22,
    borderRadius: 20,
    gap: 8
  },
  heroTitle: {
    color: Y,
    fontSize: 27,
    fontWeight: 'bold',
    textAlign: 'right'
  },
  card: {
    backgroundColor: '#FFFFFF',
    padding: 18,
    borderRadius: 20,
    gap: 14,
    borderWidth: 1,
    borderColor: '#E1E7E0'
  },
  title: {
    color: G,
    fontSize: 22,
    fontWeight: 'bold',
    textAlign: 'right'
  },
  body: {
    color: '#385246',
    fontSize: 15,
    lineHeight: 23,
    textAlign: 'right'
  },
  label: {
    color: G,
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'right'
  },
  input: {
    backgroundColor: '#F1F5F0',
    borderRadius: 12,
    padding: 14,
    minHeight: 52,
    textAlign: 'right',
    color: '#19251F',
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#DCE5DC'
  },
  button: {
    backgroundColor: Y,
    paddingHorizontal: 16,
    paddingVertical: 13,
    minHeight: 48,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    flexGrow: 1
  },
  buttonText: {
    color: '#172B21',
    fontWeight: 'bold',
    fontSize: 15
  },
  secondary: {
    backgroundColor: '#E4EFE8',
    borderWidth: 1,
    borderColor: '#C9D9CE'
  },
  row: {
    flexDirection: 'row-reverse',
    flexWrap: 'wrap',
    gap: 8
  },
  fare: {
    fontSize: 25,
    color: G,
    fontWeight: 'bold',
    textAlign: 'right'
  },
  offer: {
    gap: 8,
    padding: 12,
    backgroundColor: '#F1F5F0',
    borderRadius: 12
  },
  error: {
    color: '#9B2020',
    backgroundColor: '#FCE8E6',
    padding: 12,
    borderRadius: 10,
    textAlign: 'right'
  },
  success: {
    color: G,
    backgroundColor: '#DDF3E7',
    padding: 12,
    borderRadius: 10,
    textAlign: 'right'
  },
  footer: {
    textAlign: 'center',
    color: '#536B5D',
    fontSize: 12
  }
});
