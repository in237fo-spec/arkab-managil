import 'react-native-url-polyfill/auto';
import React, {useState, useEffect, useRef} from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  ScrollView, Image, StyleSheet,
  ActivityIndicator, StatusBar, AppState, Linking, Alert
} from 'react-native';
import {SafeAreaProvider, SafeAreaView}
  from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as ImagePicker from 'expo-image-picker';
import {Map, Camera, Marker} from '@maplibre/maplibre-react-native';
import {createClient} from '@supabase/supabase-js';

const G = '#06432D';
const Y = '#FFB600';
const CENTER = [32.98, 14.25];

const db = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL ||
  'https://hfhkscqmsmxsxzjfxzew.supabase.co',
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ||
  'sb_publishable_F9NNkmsikUX_jcNK8zgjOw_hFotc3Pf',
  {
    auth: {
      storage: {
        getItem: k => SecureStore.getItemAsync(k),
        setItem: (k,v) => SecureStore.setItemAsync(k,v),
        removeItem: k => SecureStore.deleteItemAsync(k)
      },
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false
    }
  }
);

const DRIVER_LOCATION_TASK = 'arkab-driver-background-location-v1';
const ACTIVE_RIDE_KEY = 'arkab.background.activeRideId';
const ACTIVE_DRIVER_KEY = 'arkab.background.driverId';

if (!TaskManager.isTaskDefined(DRIVER_LOCATION_TASK)) {
  TaskManager.defineTask(DRIVER_LOCATION_TASK, async ({data,error}) => {
    if (error || !data?.locations?.length) return;
    try {
      const rideId = await SecureStore.getItemAsync(ACTIVE_RIDE_KEY);
      const driverId = await SecureStore.getItemAsync(ACTIVE_DRIVER_KEY);
      if (!rideId || !driverId) {
        await Location.stopLocationUpdatesAsync(DRIVER_LOCATION_TASK).catch(()=>{});
        return;
      }
      const {data:ride,error:rideError} = await db.from('rides')
        .select('id,status,driver_id').eq('id',rideId).eq('driver_id',driverId).maybeSingle();
      if (rideError || !ride || !['accepted','arrived','in_progress'].includes(ride.status)) {
        await Location.stopLocationUpdatesAsync(DRIVER_LOCATION_TASK).catch(()=>{});
        await SecureStore.deleteItemAsync(ACTIVE_RIDE_KEY);
        await SecureStore.deleteItemAsync(ACTIVE_DRIVER_KEY);
        return;
      }
      const latest = data.locations[data.locations.length-1];
      const {error:saveError} = await db.from('ride_locations').upsert({
        ride_id:rideId, driver_id:driverId, latitude:latest.coords.latitude,
        longitude:latest.coords.longitude,
        updated_at:new Date(latest.timestamp || Date.now()).toISOString()
      });
      if (saveError) throw saveError;
    } catch (_) { /* next background location event retries */ }
  });
}

const states = {
  requested: 'بانتظار العروض',
  accepted: 'تم الاتفاق',
  arrived: 'وصل الكابتن',
  in_progress: 'الرحلة جارية',
  completed: 'مكتملة',
  cancelled: 'ملغاة'
};

const activeStates = [
  'accepted', 'arrived', 'in_progress'
];

function check({data,error}) {
  if (error) throw error;
  return data;
}

function Button({children,onPress,secondary,disabled}) {
  return (
    <TouchableOpacity
      disabled={disabled}
      onPress={onPress}
      style={[
        s.button,
        secondary && s.secondary,
        disabled && {opacity:0.5}
      ]}>
      <Text style={s.buttonText}>{children}</Text>
    </TouchableOpacity>
  );
}

function Field({
  label,value,onChangeText,
  keyboardType='default',secure=false
}) {
  return (
    <View style={{gap:6}}>
      <Text style={s.label}>{label}</Text>
      <TextInput
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

function distanceKm(a,b) {
  if (!a || !b) return 0;
  const rad = v => v * Math.PI / 180;
  const dLat = rad(b[1]-a[1]);
  const dLng = rad(b[0]-a[0]);

  const x =
    Math.sin(dLat/2)**2 +
    Math.cos(rad(a[1])) *
    Math.cos(rad(b[1])) *
    Math.sin(dLng/2)**2;

  return 12742 * Math.asin(Math.sqrt(Math.min(1,x)));
}

function Pin({id,point,color,label}) {
  if (!point) return null;

  return (
    <Marker id={id} lngLat={point}>
      <View style={[s.pin,{backgroundColor:color}]}>
        <Text style={{color:'#fff',fontWeight:'bold'}}>
          {label}
        </Text>
      </View>
    </Marker>
  );
}

function RideMap({
  pickup,destination,driver,onSelect
}) {
  const center = pickup || driver || destination || CENTER;

  return (
    <View style={s.mapBox}>
      <Map
        style={s.map}
        mapStyle="https://tiles.openfreemap.org/styles/liberty"
        onPress={e => {
          const p = e.nativeEvent.lngLat;
          if (onSelect && Array.isArray(p)) onSelect(p);
        }}>
        <Camera
          initialViewState={{
            center,
            zoom:14
          }}
        />

        <Pin id="pickup" point={pickup}
          color={G} label="1"/>

        <Pin id="destination" point={destination}
          color="#D84315" label="2"/>

        <Pin id="driver" point={driver}
          color="#1565C0" label="🛺"/>
      </Map>

      <Text style={s.attribution}>
        © OpenStreetMap contributors • OpenFreeMap
      </Text>
    </View>
  );
}

async function getGPS() {
  const p = await Location.requestForegroundPermissionsAsync();

  if (p.status !== 'granted') {
    throw Error('يرجى السماح بالوصول إلى الموقع');
  }

  const result = await Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.Balanced
  });

  return [
    result.coords.longitude,
    result.coords.latitude
  ];
}

function Main() {
  const [session,S] = useState(null);
  const [profile,P] = useState(null);
  const [loading,L] = useState(true);

  const [mode,SM] = useState('login');
  const [email,SE] = useState('');
  const [password,SW] = useState('');
  const [otp,O] = useState('');
  const [phone,F] = useState('+249');
  const [name,N] = useState('');
  const [role,R] = useState('passenger');

  const [driver,SD] = useState(null);
  const [vehicles,SV] = useState([]);
  const [plate,SP] = useState('');
  const [driverPhone,SDriverPhone] = useState('');

  const [pickup,A] = useState('');
  const [dest,B] = useState('');
  const [pickupPoint,AP] = useState(null);
  const [destPoint,BP] = useState(null);
  const [selectPoint,SEL] = useState('pickup');
  const [mapKey,MK] = useState(0);
  const [vehicle,V] = useState('rickshaw');
  const [price,Q] = useState('');

  const [trips,U] = useState([]);
  const [offers,H] = useState([]);
  const [bid,J] = useState({});
  const [tab,D] = useState('home');

  const [busy,K] = useState(false);
  const [err,E] = useState('');
  const [notice,SN] = useState('');

  const [activeRide,AR] = useState(null);
  const previousActive = useRef(null);
  useEffect(()=>{
    if(profile?.role==='passenger' && previousActive.current && !activeRide) D('home');
    previousActive.current=activeRide?.id || null;
  },[activeRide?.id,profile?.role]);
  const [activeDriver,ADR] = useState(null);
  const [activeVehicle,AV] = useState(null);
  const [ratedRides,RR] = useState([]);
  const [ratingDraft,RD] = useState({});
  const [driverPoint,DP] = useState(null);
  const [locationTime,LT] = useState(0);
  const [sharing,SH] = useState(false);
  const watchRef = useRef(null);
  const sharingRef = useRef(false);
  const lastSent = useRef(0);

  const km = distanceKm(pickupPoint,destPoint);
  useEffect(()=>{ if(profile?.contact_phone) SDriverPhone(profile.contact_phone); },[profile?.id]);

  function stopTracking() {
    sharingRef.current = false;
    watchRef.current?.remove();
    watchRef.current = null;
    SH(false);
  }

  async function run(fn) {
    K(true);
    E('');
    SN('');

    try {
      await fn();
    } catch(e) {
      E(e.message || 'تعذر الاتصال');
    } finally {
      K(false);
    }
  }

  async function authenticate() {
    const address=email.trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))
      throw Error('أدخل بريداً إلكترونياً صحيحاً');

    if (mode==='verify') {

      if (!/^\d{6,8}$/.test(otp.trim()))
        throw Error('أدخل رمز التحقق كاملاً');

      check(await db.auth.verifyOtp({
        email:address,
        token:otp.trim(),
        type:'email'
      }));

      O('');
      SW('');
      return;
    }

    if (password.length<8)
      throw Error('كلمة المرور 8 أحرف على الأقل');

    if (mode==='register') {
      const data = check(await db.auth.signUp({
        email:address,password
      }));

      if (!data.session) {
        O('');
        SM('verify');
        SN('تم طلب إرسال رمز التأكيد');
      }
    } else {
      check(await db.auth.signInWithPassword({
        email:address,password
      }));

      SW('');
    }
  }

  async function refresh() {
    if (!session) return;

    try {
      const id=session.user.id;

      const p=check(await db.from('profiles')
        .select('*').eq('id',id).maybeSingle());

      P(p);

      if (!p) return;

      const own=check(await db.from('rides')
        .select('*')
        .order('created_at',{ascending:false})
        .limit(50));

      let available=[];

      if (p.role==='driver') {
        const d=check(await db.from('drivers')
          .select('*').eq('id',id).maybeSingle());

        SD(d);

        SV(check(await db.from('vehicles')
          .select('*').eq('driver_id',id)));

        if (d?.approved && d?.online) {
          available=check(
            await db.rpc('available_rides')
          ).map(r=>({...r,status:'requested'}));
        }
      }

      U([
        ...own,
        ...available.filter(r=>
          !own.some(o=>o.id===r.id))
      ]);

      H(check(await db.from('ride_offers')
        .select('*')
        .order('created_at',{ascending:false})
        .limit(100)));

      const active=own.find(r=>
        activeStates.includes(r.status) || (p.role==='passenger' && r.status==='requested')
      );

      AR(active || null);
      if (p.role==='driver') {
        const running=await Location.hasStartedLocationUpdatesAsync(DRIVER_LOCATION_TASK).catch(()=>false);
        const storedRideId=await SecureStore.getItemAsync(ACTIVE_RIDE_KEY);
        if(running && (!active || active.driver_id!==id || storedRideId!==active.id)) {
          await Location.stopLocationUpdatesAsync(DRIVER_LOCATION_TASK).catch(()=>{});
          await SecureStore.deleteItemAsync(ACTIVE_RIDE_KEY);
          await SecureStore.deleteItemAsync(ACTIVE_DRIVER_KEY); SH(false);
        } else SH(Boolean(running && active && storedRideId===active.id));
      }
      if (active?.driver_id) {
        const dp = check(await db.from('profiles').select('id,full_name,contact_phone,avatar_url').eq('id',active.driver_id).maybeSingle());
        const dv = check(await db.from('vehicles').select('kind,plate').eq('driver_id',active.driver_id).eq('approved',true).eq('kind',active.vehicle_kind).limit(2));
        ADR(dp); AV(dv?.length===1?dv[0]:null);
      } else { ADR(null); AV(null); }
      const ratings = check(await db.from('ratings').select('ride_id').eq('passenger_id',id));
      RR((ratings||[]).map(x=>x.ride_id));

    } catch(e) {
      E(e.message);
    } finally {
      L(false);
    }
  }

  const act=fn=>run(async()=>{
    await fn();
    await refresh();
  });

  const rpc=(name,args)=>
    db.rpc(name,args).then(check);

  useEffect(()=>{
    db.auth.getSession().then(({data,error})=>{
      if(error) E(error.message);
      S(data.session);
      if(!data.session) L(false);
    }).catch(()=>L(false));

    const {data}=db.auth.onAuthStateChange((_,v)=>{
      S(v);

      if(!v){
        stopTracking();
        Location.stopLocationUpdatesAsync(DRIVER_LOCATION_TASK).catch(()=>{});
        SecureStore.deleteItemAsync(ACTIVE_RIDE_KEY).catch(()=>{});
        SecureStore.deleteItemAsync(ACTIVE_DRIVER_KEY).catch(()=>{});
        P(null);
        AR(null);
        DP(null);
        U([]);
        H([]);
        SD(null);
        SV([]);
        L(false);
      }
    });

    const app=AppState.addEventListener('change',state=>{
      if(state==='active'){
        db.auth.startAutoRefresh();
      }else{
        db.auth.stopAutoRefresh();
        stopTracking();
      }
    });

    return ()=>{
      data.subscription.unsubscribe();
      app.remove();
      stopTracking();
    };
  },[]);

  useEffect(()=>{
    if(!session) return;

    refresh();

    const timer=setInterval(refresh,12000);

    const channel=db.channel('arkab-'+session.user.id)
      .on('postgres_changes',{
        event:'*',schema:'public',table:'rides'
      },refresh)
      .on('postgres_changes',{
        event:'*',schema:'public',table:'ride_offers'
      },refresh)
      .subscribe();

    return ()=>{
      clearInterval(timer);
      db.removeChannel(channel);
    };
  },[session?.user.id]);

  useEffect(()=>{
    stopTracking();
    DP(null);
    LT(0);

    if(!activeRide || !session) return;

    let cancelled=false;

    async function readLocation(){
      const {data,error}=await db
        .from('ride_locations')
        .select('latitude,longitude,updated_at')
        .eq('ride_id',activeRide.id)
        .maybeSingle();

      if(cancelled) return;

      if(error || !data ||
        Date.now()-Date.parse(data.updated_at)>45000){
        DP(null);
        LT(0);
        return;
      }

      DP([data.longitude,data.latitude]);
      LT(Date.parse(data.updated_at));
    }

    readLocation();

    const timer=setInterval(readLocation,10000);

    const channel=db.channel('loc-'+activeRide.id)
      .on('postgres_changes',{
        event:'*',
        schema:'public',
        table:'ride_locations',
        filter:'ride_id=eq.'+activeRide.id
      },readLocation)
      .subscribe();

    return ()=>{
      cancelled=true;
      stopTracking();
      clearInterval(timer);
      db.removeChannel(channel);
    };

  },[activeRide?.id,session?.user.id]);

  async function startSharing(){
    if(!activeRide || activeRide.driver_id!==session.user.id || !activeStates.includes(activeRide.status))
      throw Error('لا توجد رحلة نشطة مرتبطة بحسابك');
    const foreground=await Location.requestForegroundPermissionsAsync();
    if(foreground.status!=='granted') throw Error('يجب السماح بموقع الهاتف أثناء استخدام التطبيق');
    await new Promise((resolve,reject)=>Alert.alert(
      'السماح بمشاركة الموقع في الخلفية',
      'سيشارك أركب موقعك مع الراكب أثناء الرحلة النشطة فقط، حتى عند تصغير التطبيق أو إطفاء الشاشة. سيظهر إشعار دائم أثناء المشاركة.',
      [{text:'متابعة',onPress:resolve},{text:'إلغاء',style:'cancel',onPress:()=>reject(Error('تم إلغاء تفعيل تتبع الخلفية'))}]
    ));
    const background=await Location.requestBackgroundPermissionsAsync();
    if(background.status!=='granted') throw Error('فعّل إذن الموقع في الخلفية من إعدادات الهاتف');
    const running=await Location.hasStartedLocationUpdatesAsync(DRIVER_LOCATION_TASK);
    if(running) await Location.stopLocationUpdatesAsync(DRIVER_LOCATION_TASK);
    await SecureStore.setItemAsync(ACTIVE_RIDE_KEY,activeRide.id);
    await SecureStore.setItemAsync(ACTIVE_DRIVER_KEY,session.user.id);
    const current=await Location.getCurrentPositionAsync({accuracy:Location.Accuracy.High});
    const {error:initialError}=await db.from('ride_locations').upsert({
      ride_id:activeRide.id,driver_id:session.user.id,
      latitude:current.coords.latitude,longitude:current.coords.longitude,
      updated_at:new Date(current.timestamp||Date.now()).toISOString()
    });
    if(initialError) throw initialError;
    const options={accuracy:Location.Accuracy.High,timeInterval:7000,distanceInterval:10,
      deferredUpdatesInterval:10000,pausesUpdatesAutomatically:false,showsBackgroundLocationIndicator:true};
    if(Platform.OS==='android') options.foregroundService={
      notificationTitle:'أركب | مشاركة موقع الرحلة',
      notificationBody:'موقعك يُشارك مع الراكب أثناء الرحلة النشطة فقط',
      notificationColor:G,killServiceOnDestroy:false
    };
    try {
      await Location.startLocationUpdatesAsync(DRIVER_LOCATION_TASK,options);
      SH(true); SN('بدأ التتبع في الخلفية. سيظل الإشعار ظاهراً حتى انتهاء الرحلة.');
    } catch(e) {
      await SecureStore.deleteItemAsync(ACTIVE_RIDE_KEY);
      await SecureStore.deleteItemAsync(ACTIVE_DRIVER_KEY); throw e;
    }
  }

  async function stopSharing(){
    stopTracking();
    const running=await Location.hasStartedLocationUpdatesAsync(DRIVER_LOCATION_TASK).catch(()=>false);
    if(running) await Location.stopLocationUpdatesAsync(DRIVER_LOCATION_TASK);
    await SecureStore.deleteItemAsync(ACTIVE_RIDE_KEY);
    await SecureStore.deleteItemAsync(ACTIVE_DRIVER_KEY);
    if(activeRide && activeRide.driver_id===session?.user.id){
      const {error}=await db.from('ride_locations').update({updated_at:new Date(0).toISOString()})
        .eq('ride_id',activeRide.id).eq('driver_id',session.user.id);
      if(error) E(error.message);
    }
    DP(null); SH(false);
  }

  async function chooseDriverAvatar(){
    const result=await ImagePicker.launchImageLibraryAsync({mediaTypes:['images'],allowsEditing:true,aspect:[1,1],quality:0.82});
    if(result.canceled || !result.assets?.[0]) return;
    const asset=result.assets[0];
    const mime=['image/jpeg','image/png','image/webp'].includes(asset.mimeType)?asset.mimeType:'image/jpeg';
    const response=await fetch(asset.uri); const bytes=await response.arrayBuffer();
    if(bytes.byteLength>3*1024*1024) throw Error('حجم الصورة يجب ألا يتجاوز 3 ميجابايت');
    const path=`${session.user.id}/avatar`;
    const {error:uploadError}=await db.storage.from('driver-avatars').upload(path,bytes,{contentType:mime,upsert:true,cacheControl:'3600'});
    if(uploadError) throw uploadError;
    const {data:urlData}=db.storage.from('driver-avatars').getPublicUrl(path);
    const updated=check(await db.from('profiles').update({avatar_url:urlData.publicUrl}).eq('id',session.user.id).select().single());
    P(v=>({...v,...updated})); SN('تم رفع صورة الكابتن وحفظها بنجاح');
  }

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="dark-content"/>

      <ScrollView
        contentContainerStyle={s.page}
        keyboardShouldPersistTaps="handled">

        <View style={s.header}>
          <View>
            <Text style={s.brand}>أركب | ARKAB</Text>
            <Text style={s.muted}>
              المناقل • مشوارك بقى أسهل
            </Text>
          </View>

          <Image
            source={require('./assets/logo.png')}
            style={s.logo}/>
        </View>

        {!!err && <Text style={s.error}>{err}</Text>}
        {!!notice && <Text style={s.success}>{notice}</Text>}

        {(busy||loading) &&
          <ActivityIndicator color={G}/>}

        {!loading && !session ? (
          <View style={s.card}>
            <Text style={s.title}>
              {mode==='register'?'إنشاء حساب':
              mode==='verify'?'تأكيد البريد':'أهلاً بيك'}
            </Text>

            <Field label="البريد الإلكتروني"
              value={email} onChangeText={SE}
              keyboardType="email-address"/>

            {mode==='verify' ? (
              <Field label="رمز التحقق"
                value={otp} onChangeText={O}
                keyboardType="number-pad"/>
            ):(
              <Field label="كلمة المرور"
                value={password} onChangeText={SW}
                secure/>
            )}

            <Button disabled={busy}
              onPress={()=>run(authenticate)}>
              {mode==='register'?'إنشاء حساب':
              mode==='verify'?'تأكيد الرمز':'دخول'}
            </Button>

            {mode==='verify' ? (
              <Button secondary disabled={busy}
                onPress={()=>run(async()=>{
                  check(await db.auth.resend({
                    type:'signup',
                    email:email.trim().toLowerCase()
                  }));
                  SN('تم طلب رمز جديد');
                })}>
                إعادة إرسال الرمز
              </Button>
            ):(
              <Button secondary disabled={busy}
                onPress={()=>SM(mode==='login'
                  ?'register':'login')}>
                {mode==='login'?'إنشاء حساب':'لدي حساب'}
              </Button>
            )}

            {mode==='verify' &&
              <Button secondary onPress={()=>SM('login')}>
                العودة للدخول
              </Button>}
          </View>

        ):!loading && session && !profile ? (

          <View style={s.card}>
            <Text style={s.title}>أكمل حسابك</Text>

            <Field label="الاسم الكامل"
              value={name} onChangeText={N}/>

            <Field label="رقم هاتف التواصل"
              value={phone} onChangeText={F}
              keyboardType="phone-pad"/>

            <Text style={s.body}>
              رقم التواصل غير موثق عبر SMS.
            </Text>

            <View style={s.row}>
              <Button secondary={role!=='passenger'}
                onPress={()=>R('passenger')}>راكب</Button>
              <Button secondary={role!=='driver'}
                onPress={()=>R('driver')}>كابتن</Button>
            </View>

            <Button disabled={busy}
              onPress={()=>act(async()=>{
                if(!name.trim())
                  throw Error('أدخل اسمك');

                if(!/^\+249\d{9}$/.test(phone.trim()))
                  throw Error('أدخل رقم هاتف صحيحاً');

                check(await db.auth.updateUser({
                  data:{contact_phone:phone.trim()}
                }));

                check(await db.from('profiles').insert({
                  id:session.user.id,
                  full_name:name.trim(),
                  contact_phone:phone.trim(),
                  role
                }));
              })}>حفظ الحساب</Button>
          </View>

        ):session && profile ? (
          <>
            <View style={s.hero}>
              <Text style={s.heroTitle}>
                أهلاً {profile.full_name}
              </Text>
              <Text style={s.muted}>وين ماشي اليوم؟</Text>
            </View>

            <View style={s.row}>
              <Button secondary={tab!=='home'}
                onPress={()=>D('home')}>الرئيسية</Button>

              <Button secondary={tab!=='trips'}
                onPress={()=>{D('trips');refresh();}}>
                الرحلات
              </Button>

              <Button secondary
                onPress={()=>run(async()=>{
                  await stopSharing();
                  check(await db.auth.signOut());
                })}>خروج</Button>
            </View>

            {activeRide && (
              <View style={s.card}>
                <Text style={s.title}>متابعة الرحلة</Text>

                <Text style={s.body}>
                  {states[activeRide.status]}
                </Text>
                <View style={s.tripSummary}>
                  <Text style={s.body}>📍 الانطلاق: {activeRide.pickup}</Text>
                  <Text style={s.body}>🏁 الوجهة: {activeRide.destination}</Text>
                  <Text style={s.body}>🛺 نوع المركبة: {activeRide.vehicle_kind==='rickshaw'?'ركشة':'تكتك نقل'}</Text>
                  <Text style={s.body}>📏 المسافة: {Number(activeRide.distance_km||0).toFixed(1)} كم تقريباً</Text>
                  <Text style={s.body}>⏱ الزمن المتوقع: {Math.max(3,Math.ceil(Number(activeRide.distance_km||0)*3))} دقيقة تقريباً (تقديري)</Text>
                  <Text style={s.fare}>💰 الأجرة: {activeRide.agreed_fare??activeRide.proposed_fare} ج.س</Text>
                </View>
                {profile.role==='passenger' && activeDriver && (
                  <View style={s.driverCard}>
                    {activeDriver.avatar_url ? <Image source={{uri:activeDriver.avatar_url}} style={s.driverAvatar}/> : <View style={s.driverAvatarFallback}><Text style={s.driverInitial}>{(activeDriver.full_name||'ك').slice(0,1)}</Text></View>}
                    <View style={{flex:1,gap:4}}>
                      <Text style={s.title}>{activeDriver.full_name||'الكابتن'}</Text>
                      <Text style={s.body}>{activeRide.vehicle_kind==='rickshaw'?'ركشة':'تكتك نقل'} • {activeVehicle?.plate||'بيانات المركبة غير متاحة'}</Text>
                      <Text style={s.body}>{activeDriver.contact_phone||'رقم الهاتف غير مسجل'}</Text>
                    </View>
                    {!!activeDriver.contact_phone && <Button onPress={()=>Linking.openURL('tel:'+activeDriver.contact_phone)}>اتصال</Button>}
                  </View>
                )}

                <RideMap
                  key={activeRide.id}
                  pickup={activeRide.pickup_lng!=null &&
                    activeRide.pickup_lat!=null ?
                    [activeRide.pickup_lng,activeRide.pickup_lat]:null}
                  destination={activeRide.destination_lng!=null &&
                    activeRide.destination_lat!=null ?
                    [activeRide.destination_lng,activeRide.destination_lat]:null}
                  driver={driverPoint}
                />

                <Text style={s.body}>
                  {driverPoint ?
                    'آخر تحديث لموقع الكابتن: '+
                    new Date(locationTime).toLocaleTimeString():
                    'لا يوجد موقع مباشر حديث'}
                </Text>

                {profile.role==='driver' &&
                 activeRide.driver_id===session.user.id && (
                  <>
                    <Text style={s.body}>
                      سيظهر موقعك للراكب أثناء الرحلة، حتى عند تصغير التطبيق أو إطفاء الشاشة. سيظهر إشعار دائم أثناء المشاركة.
                    </Text>

                    <Button disabled={busy}
                      onPress={()=>run(sharing
                        ?stopSharing:startSharing)}>
                      {sharing?
                        'إيقاف مشاركة الموقع':
                        'مشاركة موقعي مع الراكب'}
                    </Button>
                  </>
                )}
                {profile.role==='passenger' && ['requested','accepted','arrived'].includes(activeRide.status) && (
                  <Button secondary disabled={busy} onPress={()=>act(()=>rpc('advance_ride',{p_ride:activeRide.id,p_status:'cancelled'}))}>إلغاء الرحلة</Button>
                )}
              </View>
            )}

            {profile.role==='passenger' &&
             tab==='home' && !activeRide && (
              <View style={s.card}>
                <Text style={s.title}>احجز مشوارك</Text>

                <View style={s.row}>
                  <Button secondary={selectPoint!=='pickup'}
                    onPress={()=>SEL('pickup')}>
                    الانطلاق
                  </Button>

                  <Button secondary={selectPoint!=='dest'}
                    onPress={()=>SEL('dest')}>
                    الوجهة
                  </Button>
                </View>

                <RideMap key={mapKey}
                  pickup={pickupPoint}
                  destination={destPoint}
                  onSelect={p=>{
                    if(selectPoint==='pickup'){
                      AP(p);
                      A('نقطة انطلاق مختارة');
                      SEL('dest');
                    }else{
                      BP(p);
                      B('وجهة مختارة');
                    }
                  }}/>

                <Button secondary disabled={busy}
                  onPress={()=>run(async()=>{
                    const point=await getGPS();
                    AP(point);
                    A('موقعي الحالي');
                    SEL('dest');
                    MK(v=>v+1);
                  })}>
                  📍 استخدام موقعي الحالي
                </Button>

                <Field label="اسم مكان الانطلاق"
                  value={pickup} onChangeText={A}/>

                <Field label="اسم الوجهة"
                  value={dest} onChangeText={B}/>

                {!!pickupPoint && !!destPoint &&
                  <Text style={s.fare}>
                    المسافة التقريبية: {km.toFixed(2)} كم
                  </Text>}

                <Text style={s.body}>
                  المسافة تقديرية بخط مستقيم،
                  وليست مسافة الطريق الفعلية.
                </Text>

                <View style={s.row}>
                  <Button secondary={vehicle!=='rickshaw'}
                    onPress={()=>V('rickshaw')}>
                    🛺 ركشة
                  </Button>

                  <Button secondary={vehicle!=='cargo_tuktuk'}
                    onPress={()=>V('cargo_tuktuk')}>
                    تكتك نقل
                  </Button>
                </View>

                <Field label="السعر المقترح بالجنيه"
                  value={price} onChangeText={Q}
                  keyboardType="numeric"/>

                <Button disabled={busy}
                  onPress={()=>act(async()=>{
                    if(!pickupPoint||!destPoint)
                      throw Error('حدد نقطتي الرحلة على الخريطة');

                    if(!pickup.trim()||!dest.trim())
                      throw Error('أدخل أسماء المواقع');

                    if(!Number.isFinite(Number(price))||
                      Number(price)<=0)
                      throw Error('أدخل سعراً صحيحاً');

                    check(await db.from('rides').insert({
                      passenger_id:session.user.id,
                      pickup:pickup.trim(),
                      destination:dest.trim(),
                      vehicle_kind:vehicle,
                      proposed_fare:Number(price),
                      pickup_lat:pickupPoint[1],
                      pickup_lng:pickupPoint[0],
                      destination_lat:destPoint[1],
                      destination_lng:destPoint[0],
                      distance_km:km
                    }));

                    A('');
                    B('');
                    AP(null);
                    BP(null);
                    Q('');
                    D('trips');
                  })}>
                  اطلب مشوارك
                </Button>
              </View>
            )}

            {profile.role==='driver' && (
              <View style={s.card}>
                <Text style={s.title}>حساب الكابتن</Text>

                {!driver ? (
                  <Button disabled={busy}
                    onPress={()=>act(()=>db.from('drivers')
                      .insert({id:session.user.id})
                      .then(check))}>
                    تسجيل حساب الكابتن
                  </Button>
                ):(
                  <>
                    <Text style={s.body}>
                      {driver.approved?'حساب معتمد':
                        'بانتظار اعتماد الإدارة'}
                    </Text>
                    <Field label="رقم هاتف الكابتن" value={driverPhone} onChangeText={SDriverPhone} keyboardType="phone-pad"/>
                    {profile.avatar_url ? <Image source={{uri:profile.avatar_url}} style={s.avatarPreview}/> : <View style={s.avatarEmpty}><Text style={s.body}>لم تُرفع صورة للكابتن بعد</Text></View>}
                    <Button secondary disabled={busy} onPress={()=>run(chooseDriverAvatar)}>اختيار صورة من معرض الهاتف ورفعها</Button>
                    <Button disabled={busy} onPress={()=>act(async()=>{
                      if(driverPhone.trim() && !/^\+249\d{9}$/.test(driverPhone.trim())) throw Error('أدخل رقم هاتف بصيغة +249XXXXXXXXX');
                      const updated=check(await db.from('profiles').update({contact_phone:driverPhone.trim()||null}).eq('id',session.user.id).select().single());
                      P(v=>({...v,...updated})); SN('تم تحديث رقم التواصل');
                    })}>حفظ رقم الهاتف</Button>

                    {driver.approved &&
                      <Button disabled={busy}
                        onPress={()=>act(()=>db.from('drivers')
                          .update({online:!driver.online})
                          .eq('id',session.user.id)
                          .then(check))}>
                        {driver.online?'إيقاف استقبال الطلبات':
                         'استقبال الطلبات'}
                      </Button>}

                    <Field label="رقم اللوحة"
                      value={plate} onChangeText={SP}/>

                    <View style={s.row}>
                      <Button secondary={vehicle!=='rickshaw'}
                        onPress={()=>V('rickshaw')}>ركشة</Button>

                      <Button secondary={vehicle!=='cargo_tuktuk'}
                        onPress={()=>V('cargo_tuktuk')}>
                        تكتك نقل
                      </Button>
                    </View>

                    <Button disabled={busy||!plate.trim()}
                      onPress={()=>act(async()=>{
                        check(await db.from('vehicles').insert({
                          driver_id:session.user.id,
                          kind:vehicle,
                          plate:plate.trim()
                        }));

                        SP('');
                      })}>تسجيل المركبة</Button>

                    {vehicles.map(v=>
                      <Text key={v.id} style={s.body}>
                        {v.plate} • {v.approved?
                        'معتمدة':'بانتظار الاعتماد'}
                      </Text>
                    )}
                  </>
                )}
              </View>
            )}

            <Text style={s.title}>الرحلات</Text>

            {!trips.length &&
              <Text style={s.body}>لا توجد رحلات حالياً</Text>}

            {trips.map(t=>(
              <View key={t.id} style={s.card}>
                <Text style={s.label}>
                  {states[t.status]}
                </Text>

                <Text style={s.title}>
                  {t.pickup} ← {t.destination}
                </Text>

                <Text style={s.fare}>
                  {t.agreed_fare??t.proposed_fare} ج.س
                </Text>
                {profile.role==='passenger' && t.status==='completed' && !ratedRides.includes(t.id) && (
                  <View style={s.rateBox}>
                    <Text style={s.label}>قيّم تجربتك مع الكابتن</Text>
                    <View style={s.row}>
                      {[1,2,3,4,5].map(n=><TouchableOpacity key={n} onPress={()=>RD(v=>({...v,[t.id]:n}))}><Text style={{fontSize:30,color:(ratingDraft[t.id]||0)>=n?'#FFB600':'#B8C2BA'}}>★</Text></TouchableOpacity>)}
                    </View>
                    <Button disabled={busy||!ratingDraft[t.id]} onPress={()=>act(async()=>{check(await db.from('ratings').insert({ride_id:t.id,passenger_id:session.user.id,score:ratingDraft[t.id]}));RR(v=>[...v,t.id]);})}>إرسال التقييم</Button>
                  </View>
                )}
                {profile.role==='passenger' && t.status==='completed' && ratedRides.includes(t.id) && <Text style={s.success}>شكراً لتقييمك لهذه الرحلة</Text>}

                {profile.role==='driver' &&
                 driver?.approved &&
                 t.status==='requested' && (
                  <>
                    <Field label="عرضك بالجنيه"
                      value={bid[t.id]||''}
                      onChangeText={v=>J(prev=>({
                        ...prev,[t.id]:v
                      }))}
                      keyboardType="numeric"/>

                    <Button disabled={busy}
                      onPress={()=>act(async()=>{
                        const fare=Number(
                          bid[t.id]||t.proposed_fare
                        );

                        if(!Number.isFinite(fare)||fare<=0)
                          throw Error('السعر غير صحيح');

                        await rpc('submit_offer',{
                          p_ride:t.id,p_fare:fare
                        });
                      })}>إرسال العرض</Button>
                  </>
                )}

                {profile.role==='passenger' &&
                 t.status==='requested' &&
                 offers.filter(o=>o.ride_id===t.id)
                   .map(o=>(
                    <View key={o.id} style={s.offer}>
                      <Text style={s.body}>{o.fare} ج.س</Text>
                      <Button disabled={busy}
                        onPress={()=>act(()=>rpc('accept_offer',{
                          p_offer:o.id,
                          p_expected_fare:o.fare
                        }))}>قبول العرض</Button>
                    </View>
                  ))}

                {profile.role==='driver' &&
                 t.driver_id===session.user.id &&
                 activeStates.includes(t.status) && (
                  <Button disabled={busy}
                    onPress={()=>act(async()=>{
                      if(t.status==='in_progress')
                        await stopSharing();

                      await rpc('advance_ride',{
                        p_ride:t.id,
                        p_status:{
                          accepted:'arrived',
                          arrived:'in_progress',
                          in_progress:'completed'
                        }[t.status]
                      });
                    })}>
                    {t.status==='accepted'?'وصلت للموقع':
                     t.status==='arrived'?'بدء الرحلة':
                     'إنهاء الرحلة'}
                  </Button>
                )}

                {profile.role==='passenger' &&
                 t.status==='requested' && (
                  <Button secondary disabled={busy}
                    onPress={()=>act(()=>rpc('advance_ride',{
                      p_ride:t.id,
                      p_status:'cancelled'
                    }))}>إلغاء الطلب</Button>
                )}
              </View>
            ))}
          </>
        ):null}

        <Text style={s.footer}>ARKAB • v0.5</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

export default function App(){
  return (
    <SafeAreaProvider>
      <Main/>
    </SafeAreaProvider>
  );
}

const s=StyleSheet.create({
  safe:{
    flex:1,
    backgroundColor:'#F8F7F2'
  },
  page:{
    padding:16,
    gap:16,
    paddingBottom:32
  },
  header:{
    flexDirection:'row',
    justifyContent:'space-between',
    alignItems:'center',
    backgroundColor:G,
    padding:18,
    borderRadius:22
  },
  logo:{
    width:74,
    height:74,
    borderRadius:12,
    resizeMode:'contain',
    backgroundColor:'#fff'
  },
  brand:{
    color:'#fff',
    fontSize:25,
    fontWeight:'900'
  },
  muted:{
    color:'#E3EDE7',
    textAlign:'right'
  },
  card:{
    backgroundColor:'#fff',
    padding:16,
    gap:12,
    borderRadius:20,
    borderWidth:1,
    borderColor:'#E1E7E0'
  },
  hero:{
    backgroundColor:G,
    padding:22,
    borderRadius:20,
    gap:8
  },
  heroTitle:{
    color:Y,
    fontSize:26,
    fontWeight:'bold',
    textAlign:'right'
  },
  title:{
    color:G,
    fontSize:22,
    fontWeight:'bold',
    textAlign:'right'
  },
  label:{
    color:G,
    fontSize:15,
    fontWeight:'600',
    textAlign:'right'
  },
  body:{
    color:'#385246',
    fontSize:15,
    textAlign:'right',
    lineHeight:23
  },
  input:{
    backgroundColor:'#F1F5F0',
    borderRadius:12,
    padding:14,
    minHeight:52,
    textAlign:'right',
    color:'#19251F',
    fontSize:16,
    borderWidth:1,
    borderColor:'#DCE5DC'
  },
  button:{
    backgroundColor:Y,
    padding:14,
    minHeight:48,
    borderRadius:13,
    alignItems:'center',
    justifyContent:'center',
    flexGrow:1
  },
  secondary:{
    backgroundColor:'#E4EFE8'
  },
  buttonText:{
    color:G,
    fontWeight:'bold',
    fontSize:15
  },
  row:{
    flexDirection:'row-reverse',
    flexWrap:'wrap',
    gap:8
  },
  mapBox:{
    borderRadius:16,
    overflow:'hidden',
    borderWidth:1,
    borderColor:'#DCE5DC'
  },
  map:{
    width:'100%',
    height:320
  },
  attribution:{
    color:'#536B5D',
    fontSize:10,
    padding:5,
    backgroundColor:'#fff'
  },
  pin:{
    width:34,
    height:34,
    borderRadius:17,
    alignItems:'center',
    justifyContent:'center',
    borderWidth:2,
    borderColor:'#fff'
  },
  fare:{
    fontSize:21,
    color:G,
    fontWeight:'bold',
    textAlign:'right'
  },
  tripSummary:{backgroundColor:'#F1F5F0',padding:12,borderRadius:14,gap:8},
  driverCard:{flexDirection:'row-reverse',alignItems:'center',gap:12,backgroundColor:'#F8F7F2',padding:12,borderRadius:14},
  driverAvatar:{width:58,height:58,borderRadius:29},
  avatarPreview:{width:112,height:112,borderRadius:56,alignSelf:'center',borderWidth:3,borderColor:Y},
  avatarEmpty:{minHeight:76,alignItems:'center',justifyContent:'center',backgroundColor:'#F1F5F0',borderRadius:14},
  driverAvatarFallback:{width:58,height:58,borderRadius:29,backgroundColor:G,alignItems:'center',justifyContent:'center'},
  driverInitial:{color:Y,fontSize:26,fontWeight:'bold'},
  rateBox:{padding:12,backgroundColor:'#F8F7F2',borderRadius:14,gap:8},
  offer:{
    gap:8,
    padding:12,
    backgroundColor:'#F1F5F0',
    borderRadius:12
  },
  error:{
    color:'#9B2020',
    backgroundColor:'#FCE8E6',
    padding:12,
    borderRadius:10,
    textAlign:'right'
  },
  success:{
    color:G,
    backgroundColor:'#DDF3E7',
    padding:12,
    borderRadius:10,
    textAlign:'right'
  },
  footer:{
    textAlign:'center',
    color:'#536B5D',
    fontSize:12
  }
});
