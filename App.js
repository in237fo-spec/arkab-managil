import 'react-native-url-polyfill/auto';
import React, {useState, useEffect, useRef} from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  ScrollView, Image, StyleSheet,
  ActivityIndicator, StatusBar, AppState, Linking, Alert, Share, Pressable
} from 'react-native';
import {SafeAreaProvider, SafeAreaView}
  from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as ImagePicker from 'expo-image-picker';
import * as Crypto from 'expo-crypto';
import {coordinate,estimateFare,useNearbyVehicles,useAvailableDriverLocation,useRidePush} from './rideFeatures';
import {Map, Camera, Marker} from '@maplibre/maplibre-react-native';
import {createClient} from '@supabase/supabase-js';

const theme = {
  green:'#086B47', deep:'#034735', gold:'#E9B949', background:'#F7F6F2',
  surface:'#FFFFFF', soft:'#EAF4EE', ink:'#152C23', muted:'#52695E',
  border:'#DEE7E1', danger:'#A22D2D', warning:'#FFF4D6',
  radius:{sm:12,md:16,lg:22}, space:{xs:4,sm:8,md:16,lg:24}
};
const G = theme.green;
const Y = theme.gold;
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
    <Pressable
      accessibilityRole="button"
      accessibilityState={{disabled:!!disabled}}
      disabled={disabled}
      onPress={onPress}
      style={({pressed})=>[
        s.button, secondary && s.secondary,
        (disabled || pressed) && {opacity:disabled?0.5:0.82}
      ]}>
      <Text style={[s.buttonText,secondary && s.secondaryText]}>{children}</Text>
    </Pressable>
  );
}

function TabBar({tab,onChange,isDriver}) {
  const items = [
    ['home','⌂',isDriver?'الرئيسية':'الرئيسية'],
    ['trips','≡','رحلاتي'],
    ['wallet','▣','الدفع'],
    ['notifications','◉','التنبيهات'],
    ['account','●','حسابي']
  ];
  return <View style={s.tabBar}>
    {items.map(([key,icon,label])=>(
      <Pressable key={key} accessibilityRole="tab" accessibilityLabel={label}
        accessibilityState={{selected:tab===key}} onPress={()=>onChange(key)}
        style={({pressed})=>[s.tabItem,tab===key&&s.tabActive,pressed&&{opacity:0.75}]}>
        <Text style={[s.tabIcon,tab===key&&s.tabSelected]}>{icon}</Text>
        <Text style={[s.tabLabel,tab===key&&s.tabSelected]}>{label}</Text>
      </Pressable>
    ))}
  </View>;
}

function VehicleChoice({kind,selected,onPress}) {
  const cargo=kind==='cargo_tuktuk';
  return <Pressable accessibilityRole="radio" accessibilityState={{checked:selected}}
    accessibilityLabel={cargo?'تكتك نقل':'ركشة'} onPress={onPress}
    style={({pressed})=>[s.vehicleChoice,selected&&s.vehicleSelected,pressed&&{opacity:0.8}]}>
    <View style={s.vehicleTop}><Text style={s.vehicleGlyph}>{cargo?'▣':'🛺'}</Text>
      <View style={[s.radio,selected&&s.radioSelected]}>{selected&&<View style={s.radioDot}/>}</View>
    </View>
    <Text style={s.label}>{cargo?'تكتك نقل':'ركشة'}</Text>
    <Text style={s.caption}>{cargo?'لنقل الأغراض والحمولات':'للمشاوير اليومية'}</Text>
  </Pressable>;
}

function Field({
  label,value,onChangeText,
  keyboardType='default',secure=false,placeholder,maxLength
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
        placeholder={placeholder}
        placeholderTextColor={theme.muted}
        accessibilityLabel={label}
        maxLength={maxLength}
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
  pickup,destination,driver,onSelect,nearby=[],nearbyAnchor
}) {
  const center = pickup || driver || destination || nearbyAnchor || CENTER;

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

        {nearby.map(cell=>(
          <Pin key={cell.kind+'-'+cell.lat+'-'+cell.lng}
            id={'nearby-'+cell.kind+'-'+cell.lat+'-'+cell.lng}
            point={[cell.lng,cell.lat]}
            color={cell.kind==='rickshaw'?'#246D52':'#915319'}
            label={(cell.kind==='rickshaw'?'🛺':'📦')+(cell.vehicle_count>1?' '+cell.vehicle_count:'')}/>
        ))}
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
  const [pickupNote,setPickupNote] = useState('');
  const [nearbyAnchor,setNearbyAnchor] = useState(null);
  const [forSomeone,setForSomeone] = useState(false);
  const [recipientPhone,setRecipientPhone] = useState('+249');
  const [cargoDescription,setCargoDescription] = useState('');
  const [cargoPhoto,setCargoPhoto] = useState(null);
  const [openedPhoto,setOpenedPhoto] = useState(null);
  const submittedDraft = useRef(null);
  const [pricing,setPricing] = useState([]);
  const [savedRides,setSavedRides] = useState([]);
  const [notifications,setNotifications] = useState([]);
  const [focusedRide,setFocusedRide] = useState(null);

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
  const estimate = estimateFare(pricing,vehicle,pickupPoint && destPoint ? km : null);
  const userId = session?.user.id;
  const nearby = useNearbyVehicles(db,profile?.role==='passenger' && !activeRide && tab==='home' ? userId : null,pickupPoint || nearbyAnchor);
  const nearbyCount = kind => nearby.rows.filter(row=>row.kind===kind)
    .reduce((total,row)=>total+row.vehicle_count,0);
  useAvailableDriverLocation(db,profile?.role==='driver' && driver?.approved && driver?.online && !activeRide ? userId : null,E);
  const push = useRidePush(db,profile?.id===userId ? userId : null,openRide);
  const orderedTrips = focusedRide
    ? [...trips.filter(ride=>ride.id===focusedRide),...trips.filter(ride=>ride.id!==focusedRide)]
    : trips;

  function openRide(rideId) {
    setFocusedRide(rideId);
    D('trips');
  }
  useEffect(()=>{ if(profile?.contact_phone) SDriverPhone(profile.contact_phone); },[profile?.id]);

  useEffect(()=>{
    if (!userId || profile?.role!=='passenger') return;
    let cancelled=false;
    async function locate() {
      if ((await Location.getForegroundPermissionsAsync()).status!=='granted') return;
      const result=await Location.getLastKnownPositionAsync({maxAge:60000,requiredAccuracy:200})
        || await Location.getCurrentPositionAsync({accuracy:Location.Accuracy.Balanced});
      if (!cancelled) {
        setNearbyAnchor([result.coords.longitude,result.coords.latitude]);
        MK(key=>key+1);
      }
    }
    void locate().catch(()=>{});
    return ()=>{cancelled=true;};
  },[userId,profile?.role]);

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
            await db.rpc('available_ride_details')
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

      const [inboxResult,pricingResult,savedResult] = await Promise.all([
        db.from('notifications').select('id,ride_id,title,body,created_at')
          .eq('user_id',id).order('created_at',{ascending:false}).limit(30),
        p.role==='passenger' ? db.from('pricing').select('vehicle_kind,base_fare,per_km').eq('active',true) : null,
        p.role==='passenger' ? db.from('saved_rides').select('ride_id,rides(*)')
          .eq('user_id',id).order('created_at',{ascending:false}).limit(25) : null
      ]);
      if (!inboxResult.error) setNotifications(inboxResult.data || []);
      if (pricingResult && !pricingResult.error) setPricing(pricingResult.data || []);
      if (savedResult && !savedResult.error) setSavedRides((savedResult.data || []).map(row=>row.rides).filter(Boolean));

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
        setNotifications([]);
        setSavedRides([]);
        setPricing([]);
        setNearbyAnchor(null);
        setFocusedRide(null);
        setOpenedPhoto(null);
        clearRideDraft();
        D('home');
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
      .on('postgres_changes',{
        event:'INSERT',schema:'public',table:'notifications',filter:'user_id=eq.'+session.user.id
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

  function clearRideDraft() {
    A('');
    B('');
    AP(null);
    BP(null);
    Q('');
    SEL('pickup');
    setPickupNote('');
    setForSomeone(false);
    setRecipientPhone('+249');
    setCargoDescription('');
    setCargoPhoto(null);
    submittedDraft.current=null;
  }

  function repeatRide(ride) {
    clearRideDraft();
    A(ride.pickup);
    B(ride.destination);
    AP(coordinate(ride.pickup_lng,ride.pickup_lat));
    BP(coordinate(ride.destination_lng,ride.destination_lat));
    V(ride.vehicle_kind);
    setPickupNote(ride.pickup_note || '');
    setCargoDescription(ride.cargo_description || '');
    MK(key=>key+1);
    D('home');
  }

  async function chooseCargoPhoto() {
    const photo = await ImagePicker.launchImageLibraryAsync({
      mediaTypes:['images'], quality:0.55, base64:true, allowsEditing:true
    });
    if (photo.canceled) return;
    const image = photo.assets[0];
    if (!image?.base64 || image.base64.length > 5500000)
      throw Error('اختر صورة حمولة أصغر من 4 ميغابايت');
    setCargoPhoto(image);
  }

  async function viewCargoPhoto(ride) {
    const photo = check(await db.storage.from('ride-cargo').createSignedUrl(ride.cargo_photo_path,60));
    setOpenedPhoto({rideId:ride.id,url:photo.signedUrl});
  }

  async function requestRide() {
    if (!pickupPoint || !destPoint) throw Error('حدد نقطتي الرحلة على الخريطة');
    if (!pickup.trim() || !dest.trim()) throw Error('أدخل أسماء المواقع');
    const fare = price.trim() ? Number(price) : estimate;
    if (!Number.isFinite(fare) || fare<=0) throw Error('أدخل سعراً صحيحاً');
    const contact = forSomeone ? recipientPhone.trim() : null;
    if (forSomeone && !/^\+249\d{9}$/.test(contact)) throw Error('أدخل رقم التواصل بصيغة +249XXXXXXXXX');
    const cargo = vehicle==='cargo_tuktuk';
    if (cargo && !cargoDescription.trim()) throw Error('اكتب نوع الحمولة وحجمها');
    const values = {
      passenger_id:userId, pickup:pickup.trim(), destination:dest.trim(), vehicle_kind:vehicle,
      proposed_fare:fare, pickup_lat:pickupPoint[1], pickup_lng:pickupPoint[0],
      destination_lat:destPoint[1], destination_lng:destPoint[0], distance_km:km,
      pickup_note:pickupNote.trim() || null, recipient_phone:contact,
      cargo_description:cargo ? cargoDescription.trim() : null
    };
    const photo = cargo ? cargoPhoto : null;
    const key = JSON.stringify([values,photo?.uri]);
    if (submittedDraft.current?.key !== key)
      submittedDraft.current={key,id:Crypto.randomUUID(),photoUploaded:false};
    const draft = submittedDraft.current;
    const photoPath = photo ? userId+'/'+draft.id+'.jpg' : null;
    if (photo && !draft.photoUploaded) {
      const bytes = Uint8Array.from(atob(photo.base64),char=>char.charCodeAt(0));
      const {error} = await db.storage.from('ride-cargo').upload(photoPath,bytes.buffer,{contentType:'image/jpeg'});
      if (error && String(error.statusCode)!=='409') throw error;
      draft.photoUploaded=true;
    }

    const {error} = await db.from('rides').insert({...values,id:draft.id,cargo_photo_path:photoPath});
    if (error) {
      if (error.code!=='23505') throw error;
      const existing = check(await db.from('rides').select('id').eq('id',draft.id).maybeSingle());
      if (!existing) throw error;
    }
    clearRideDraft();
    D('trips');
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

      <View style={s.fixedHeader}>
        <View style={s.headerBrand}>
          <Image source={require('./assets/logo.png')} style={s.logo}/>
          <View style={{gap:2}}>
            <Text style={s.brand}>أركب | ARKAB</Text>
            <Text style={s.muted}>المناقل • مشوارك بقى أسهل</Text>
          </View>
        </View>
        {session && profile && <Pressable accessibilityRole="button" accessibilityLabel="الإشعارات"
          style={s.headerAction} onPress={()=>{D('notifications');refresh();}}>
          <Text style={s.headerActionText}>التنبيهات</Text>
        </Pressable>}
      </View>
      <ScrollView
        style={{flex:1}}
        contentContainerStyle={s.page}
        keyboardShouldPersistTaps="handled">

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
            {tab==='home' && <View style={s.welcome}>
              <View style={{flex:1}}>
                <Text style={s.eyebrow}>{profile.role==='driver'?'لوحة الكابتن':'مرحباً بك'}</Text>
                <Text style={s.title}>أهلاً {profile.full_name}</Text>
                <Text style={s.body}>{profile.role==='driver'?'تابع طلباتك ومركبتك':'وين ماشي اليوم؟'}</Text>
              </View>
              <View style={s.brandBadge}><Text style={s.brandBadgeText}>أ</Text></View>
            </View>}

            {tab==='account' && <View style={s.card}>
              <View style={s.driverCard}>
                {profile.avatar_url ? <Image source={{uri:profile.avatar_url}} style={s.driverAvatar}/> :
                  <View style={s.driverAvatarFallback}><Text style={s.driverInitial}>{(profile.full_name||'أ').slice(0,1)}</Text></View>}
                <View style={{flex:1,gap:4}}>
                  <Text style={s.title}>{profile.full_name}</Text>
                  <Text style={s.body}>{profile.role==='driver'?'حساب كابتن':'حساب راكب'}</Text>
                </View>
              </View>
              <Text style={s.label}>بيانات التواصل</Text>
              <Text style={s.body}>{profile.contact_phone||'لا يوجد رقم مسجل'}</Text>
              <Text style={s.body}>{session.user.email}</Text>
              {profile.role==='driver' && <Button secondary onPress={()=>D('home')}>إدارة المركبة وحساب الكابتن</Button>}
              <Button secondary disabled={busy} onPress={()=>run(async()=>{
                await stopSharing();
                if(driver?.approved && driver?.online) {
                  await db.from('drivers').update({online:false}).eq('id',userId);
                }
                await push.unregister().catch(()=>{});
                check(await db.auth.signOut());
              })}>تسجيل الخروج</Button>
            </View>}

            {tab==='wallet' && <>
              <View style={s.walletHero}>
                <Text style={s.walletEyebrow}>أركب • الدفع</Text>
                <Text style={s.walletTitle}>طرق الدفع</Text>
                <Text style={s.walletText}>اختر الطريقة المتاحة عند تسوية مشوارك.</Text>
              </View>
              <View style={s.card}>
                <Text style={s.title}>خيارات الدفع</Text>
                <View style={s.paymentRow}>
                  <View style={s.paymentIcon}><Text style={s.paymentSymbol}>✓</Text></View>
                  <View style={{flex:1,gap:3}}>
                    <Text style={s.label}>نقداً</Text>
                    <Text style={s.caption}>تسوية الأجرة مع الكابتن مباشرة</Text>
                  </View>
                  <Text style={s.badge}>متاح</Text>
                </View>
                <View style={s.paymentRow}>
                  <View style={[s.paymentIcon,{backgroundColor:theme.warning}]}><Text style={s.paymentSymbol}>▣</Text></View>
                  <View style={{flex:1,gap:3}}>
                    <Text style={s.label}>ماي كاشي</Text>
                    <Text style={s.caption}>بانتظار تفعيل الربط الرسمي</Text>
                  </View>
                  <Text style={s.pendingBadge}>قريباً</Text>
                </View>
                <Text style={s.caption}>لا توجد محفظة أموال أو مدفوعات إلكترونية مفعّلة حالياً.</Text>
                <Button secondary onPress={()=>D('trips')}>عرض سجل الرحلات</Button>
              </View>
            </>}

            {tab==='notifications' && (
              <View style={s.card}>
                <Text style={s.title}>إشعارات الرحلات</Text>
                {!push.enabled && <Button secondary disabled={busy} onPress={()=>run(async()=>{
                  try {
                    const enabled=await push.enable();
                    if (!enabled) { SN('اسمح بإشعارات أركب من إعدادات الهاتف'); return; }
                    SN('تم تفعيل إشعارات الرحلات');
                  } catch {
                    E('تعذر تفعيل إشعارات الهاتف. يمكنك متابعة الإشعارات من هذه الشاشة.');
                  }
                })}>تفعيل الإشعارات على الهاتف</Button>}
                {!notifications.length && <Text style={s.body}>لا توجد إشعارات حالياً</Text>}
                {notifications.map(item=>(
                  <TouchableOpacity key={item.id} style={s.tripSummary} disabled={!item.ride_id}
                    onPress={()=>openRide(item.ride_id)}>
                    <Text style={s.label}>{item.title}</Text>
                    <Text style={s.body}>{item.body}</Text>
                    <Text style={s.body}>{new Date(item.created_at).toLocaleString()}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {activeRide && ['home','trips'].includes(tab) && (
              <View style={s.card}>
                <Text style={s.title}>متابعة الرحلة</Text>

                <Text style={s.badge}>{states[activeRide.status]}</Text>
                <View style={s.tripSummary}>
                  <Text style={s.body}>📍 الانطلاق: {activeRide.pickup}</Text>
                  <Text style={s.body}>🏁 الوجهة: {activeRide.destination}</Text>
                  {!!activeRide.pickup_note && <Text style={s.body}>مكان الالتقاء: {activeRide.pickup_note}</Text>}
                  {!!activeRide.cargo_description && <Text style={s.body}>الحمولة: {activeRide.cargo_description}</Text>}
                  {profile.role==='driver' && !!activeRide.recipient_phone && activeStates.includes(activeRide.status) && (
                    <Button secondary onPress={()=>run(()=>Linking.openURL('tel:'+activeRide.recipient_phone))}>
                      اتصال بالشخص المنتظر
                    </Button>
                  )}
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
                {profile.role==='passenger' && <Button secondary onPress={()=>run(()=>Share.share({
                  message:'رحلتي عبر أركب | '+activeRide.pickup+' إلى '+activeRide.destination+' | الحالة: '+states[activeRide.status]
                }))}>مشاركة تفاصيل الرحلة</Button>}
                {profile.role==='passenger' && ['requested','accepted','arrived'].includes(activeRide.status) && (
                  <Button secondary disabled={busy} onPress={()=>Alert.alert('إلغاء الرحلة','هل تريد إلغاء هذه الرحلة؟',[
                    {text:'العودة',style:'cancel'},
                    {text:'إلغاء الرحلة',style:'destructive',onPress:()=>act(()=>rpc('advance_ride',{p_ride:activeRide.id,p_status:'cancelled'}))}
                  ])}>إلغاء الرحلة</Button>
                )}
              </View>
            )}

            {profile.role==='passenger' &&
             tab==='home' && !activeRide && (
              <View style={s.card}>
                <Text style={s.title}>إلى أين؟</Text>
                <Text style={s.caption}>حدد نقطة الانطلاق والوجهة على الخريطة.</Text>
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
                  nearby={nearby.rows}
                  nearbyAnchor={nearbyAnchor}
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
                    setNearbyAnchor(point);
                    A('موقعي الحالي');
                    SEL('dest');
                    MK(v=>v+1);
                  })}>
                  📍 استخدام موقعي الحالي
                </Button>

                {!!savedRides.length && (
                  <View style={s.tripSummary}>
                    <Text style={s.label}>المشاوير المحفوظة</Text>
                    {savedRides.map(ride=>(
                      <Button key={ride.id} secondary disabled={busy} onPress={()=>repeatRide(ride)}>
                        {ride.pickup} ← {ride.destination}
                      </Button>
                    ))}
                  </View>
                )}
                {nearby.status!=='idle' && (
                  <View style={s.tripSummary}>
                    <Text style={s.label}>المركبات المتاحة حول الانطلاق</Text>
                    <Text style={s.body}>{nearby.status==='ready'
                      ? '🛺 '+nearbyCount('rickshaw')+' ركشة • 📦 '+nearbyCount('cargo_tuktuk')+' تكتك شحن'
                      : nearby.status==='loading' ? 'جاري تحديث المركبات القريبة…' : 'تعذر تحميل المركبات القريبة'}</Text>
                  </View>
                )}

                <Field label="اسم مكان الانطلاق"
                  value={pickup} onChangeText={A}/>

                <Field label="وصف مكان الالتقاء (اختياري)"
                  placeholder="مثلاً: بوابة السوق الغربية"
                  value={pickupNote} onChangeText={setPickupNote} maxLength={240}/>
                <Field label="اسم الوجهة"
                  value={dest} onChangeText={B}/>

                <Button secondary={!forSomeone} onPress={()=>setForSomeone(value=>!value)}>
                  {forSomeone?'الطلب لشخص آخر ✓':'اطلب لزول تاني'}
                </Button>
                {forSomeone && <Field label="رقم هاتف الشخص المنتظر" value={recipientPhone}
                  onChangeText={setRecipientPhone} keyboardType="phone-pad" maxLength={13}/>}

                {!!pickupPoint && !!destPoint &&
                  <Text style={s.fare}>
                    المسافة التقريبية: {km.toFixed(2)} كم
                  </Text>}

                <Text style={s.body}>
                  المسافة تقديرية بخط مستقيم،
                  وليست مسافة الطريق الفعلية.
                </Text>

                <Text style={s.label}>اختر نوع المركبة</Text>
                <View style={s.row}>
                  <VehicleChoice kind="rickshaw" selected={vehicle==='rickshaw'} onPress={()=>V('rickshaw')}/>
                  <VehicleChoice kind="cargo_tuktuk" selected={vehicle==='cargo_tuktuk'} onPress={()=>V('cargo_tuktuk')}/>
                </View>

                {vehicle==='cargo_tuktuk' && (
                  <View style={s.tripSummary}>
                    <Field label="نوع الحمولة وحجمها" placeholder="مثلاً: 3 كراتين متوسطة"
                      value={cargoDescription} onChangeText={setCargoDescription} maxLength={180}/>
                    <Button secondary disabled={busy} onPress={()=>run(chooseCargoPhoto)}>
                      {cargoPhoto?'تغيير صورة الحمولة':'إضافة صورة للحمولة (اختياري)'}
                    </Button>
                    {cargoPhoto && <>
                      <Image source={{uri:cargoPhoto.uri}} style={s.cargoPhoto}/>
                      <Button secondary disabled={busy} onPress={()=>setCargoPhoto(null)}>إزالة الصورة</Button>
                    </>}
                  </View>
                )}

                {estimate!==null && <Text style={s.fare}>الأجرة التقديرية: {estimate} ج.س</Text>}
                {estimate===null && pickupPoint && destPoint &&
                  <Text style={s.body}>التقدير التلقائي غير متاح لهذه المركبة. أدخل أجرة مقترحة.</Text>}
                <Field label="الأجرة المقترحة بالجنيه" value={price} onChangeText={Q}
                  placeholder={estimate===null?undefined:String(estimate)} keyboardType="numeric"/>

                <Button disabled={busy} onPress={()=>act(requestRide)}>
                  اطلب مشوارك
                </Button>
              </View>
            )}

            {profile.role==='driver' && tab==='home' && (
              <View style={s.card}>
                <Text style={s.title}>حساب الكابتن</Text>
                {driver?.approved && <View style={s.driverStats}>
                  <Text style={s.badge}>{driver.online?'متصل • متاح للطلبات':'غير متصل'}</Text>
                  <Text style={s.caption}>الرحلات المكتملة ضمن آخر 50 رحلة</Text>
                  <Text style={s.fare}>{trips.filter(t=>t.status==='completed'&&t.driver_id===userId).length} رحلة</Text>
                </View>}

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
                        onPress={()=>act(async()=>{
                          if (!driver.online) {
                            const point=await getGPS();
                            check(await db.from('driver_locations').upsert({
                              driver_id:userId,latitude:point[1],longitude:point[0],updated_at:new Date().toISOString()
                            }));
                          }
                          check(await db.from('drivers').update({online:!driver.online}).eq('id',userId));
                        })}>
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

            {(tab==='trips' || (tab==='home' && (profile.role==='driver' || activeRide?.status==='requested'))) && <>
            <Text style={s.title}>{tab==='home' && profile.role==='driver'?'الطلبات والرحلات':'رحلاتي'}</Text>

            {!trips.length &&
              <Text style={s.body}>لا توجد رحلات حالياً</Text>}

            {orderedTrips.map(t=>(
              <View key={t.id} style={s.card}>
                <Text style={t.status==='cancelled'?s.pendingBadge:s.badge}>{states[t.status]||t.status}</Text>

                <Text style={s.title}>
                  {t.pickup} ← {t.destination}
                </Text>

                <Text style={s.fare}>
                  {t.agreed_fare??t.proposed_fare} ج.س
                </Text>
                {!!t.pickup_note && <Text style={s.body}>مكان الالتقاء: {t.pickup_note}</Text>}
                {!!t.cargo_description && <Text style={s.body}>الحمولة: {t.cargo_description}</Text>}
                {!!t.cargo_photo_path && (
                  openedPhoto?.rideId===t.id ? (
                    <Image source={{uri:openedPhoto.url}} style={s.cargoPhoto}
                      onError={()=>setOpenedPhoto(current=>current?.rideId===t.id?null:current)}/>
                  ) : <Button secondary disabled={busy} onPress={()=>run(()=>viewCargoPhoto(t))}>عرض صورة الحمولة</Button>
                )}
                {profile.role==='passenger' && ['completed','cancelled'].includes(t.status) && (
                  <View style={s.row}>
                    <Button secondary disabled={busy||!!activeRide} onPress={()=>repeatRide(t)}>إعادة الطلب</Button>
                    <Button secondary disabled={busy} onPress={()=>act(async()=>{
                      if (savedRides.some(ride=>ride.id===t.id)) {
                        check(await db.from('saved_rides').delete().eq('user_id',userId).eq('ride_id',t.id));
                      } else {
                        check(await db.from('saved_rides').insert({ride_id:t.id}));
                      }
                    })}>{savedRides.some(ride=>ride.id===t.id)?'إزالة من المحفوظات':'حفظ المشوار'}</Button>
                  </View>
                )}
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
            </>}
          </>
        ):null}

        <Text style={s.footer}>ARKAB • تصميم v0.7</Text>
      </ScrollView>
      {!!session && !!profile && <TabBar tab={tab} isDriver={profile.role==='driver'}
        onChange={key=>{D(key);if(key==='trips'||key==='notifications')refresh();}}/>}
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
  safe:{flex:1,backgroundColor:theme.background},
  page:{padding:theme.space.md,gap:theme.space.md,paddingBottom:theme.space.lg},
  fixedHeader:{backgroundColor:theme.deep,paddingVertical:12,paddingHorizontal:16,
    flexDirection:'row-reverse',alignItems:'center',justifyContent:'space-between',gap:12},
  headerBrand:{flex:1,flexDirection:'row-reverse',alignItems:'center',gap:12},
  logo:{width:48,height:48,borderRadius:12,resizeMode:'contain',backgroundColor:theme.surface},
  brand:{color:theme.surface,fontSize:22,fontWeight:'900',textAlign:'right'},
  muted:{color:'#DDEBE4',fontSize:12,textAlign:'right'},
  headerAction:{paddingHorizontal:12,paddingVertical:12,borderRadius:12,backgroundColor:'#185B46'},
  headerActionText:{color:theme.surface,fontWeight:'700',fontSize:12},
  welcome:{flexDirection:'row-reverse',alignItems:'center',gap:12,paddingVertical:4},
  eyebrow:{color:G,fontWeight:'700',fontSize:13,textAlign:'right'},
  brandBadge:{width:48,height:48,borderRadius:24,backgroundColor:theme.warning,justifyContent:'center',alignItems:'center'},
  brandBadgeText:{color:theme.deep,fontSize:25,fontWeight:'900'},
  card:{backgroundColor:theme.surface,padding:theme.space.md,gap:12,borderRadius:theme.radius.lg,
    borderWidth:1,borderColor:theme.border},
  title:{color:theme.ink,fontSize:22,fontWeight:'800',textAlign:'right',lineHeight:30},
  label:{color:theme.ink,fontSize:15,fontWeight:'700',textAlign:'right'},
  body:{color:theme.muted,fontSize:15,textAlign:'right',lineHeight:23},
  caption:{color:theme.muted,fontSize:13,textAlign:'right',lineHeight:20},
  input:{backgroundColor:theme.background,borderRadius:theme.radius.sm,padding:14,minHeight:52,textAlign:'right',
    color:theme.ink,fontSize:16,borderWidth:1,borderColor:theme.border},
  button:{backgroundColor:G,padding:14,minHeight:48,borderRadius:theme.radius.sm,alignItems:'center',justifyContent:'center',flexGrow:1},
  secondary:{backgroundColor:theme.soft,borderWidth:1,borderColor:theme.border},
  buttonText:{color:theme.surface,fontWeight:'700',fontSize:15,textAlign:'center'},
  secondaryText:{color:G},
  row:{flexDirection:'row-reverse',flexWrap:'wrap',gap:8},
  mapBox:{borderRadius:theme.radius.md,overflow:'hidden',borderWidth:1,borderColor:theme.border},
  map:{width:'100%',height:300},
  attribution:{color:theme.muted,fontSize:10,padding:5,backgroundColor:theme.surface},
  pin:{width:34,height:34,borderRadius:17,alignItems:'center',justifyContent:'center',borderWidth:2,borderColor:theme.surface},
  fare:{fontSize:21,color:G,fontWeight:'800',textAlign:'right'},
  tripSummary:{backgroundColor:theme.soft,padding:12,borderRadius:theme.radius.md,gap:8},
  driverCard:{flexDirection:'row-reverse',alignItems:'center',gap:12,backgroundColor:theme.background,padding:12,borderRadius:theme.radius.md},
  driverAvatar:{width:58,height:58,borderRadius:29},
  avatarPreview:{width:112,height:112,borderRadius:56,alignSelf:'center',borderWidth:3,borderColor:Y},
  avatarEmpty:{minHeight:76,alignItems:'center',justifyContent:'center',backgroundColor:theme.soft,borderRadius:theme.radius.md},
  driverAvatarFallback:{width:58,height:58,borderRadius:29,backgroundColor:G,alignItems:'center',justifyContent:'center'},
  driverInitial:{color:Y,fontSize:26,fontWeight:'bold'},
  driverStats:{padding:14,gap:8,borderRadius:theme.radius.md,backgroundColor:theme.soft},
  rateBox:{padding:12,backgroundColor:theme.background,borderRadius:theme.radius.md,gap:8},
  offer:{gap:8,padding:12,backgroundColor:theme.soft,borderRadius:theme.radius.sm},
  error:{color:theme.danger,backgroundColor:'#FCE8E6',padding:12,borderRadius:10,textAlign:'right'},
  success:{color:G,backgroundColor:theme.soft,padding:12,borderRadius:10,textAlign:'right'},
  footer:{textAlign:'center',color:theme.muted,fontSize:12},
  tabBar:{flexDirection:'row-reverse',paddingHorizontal:6,paddingVertical:8,backgroundColor:theme.surface,borderTopWidth:1,borderColor:theme.border,gap:2},
  tabItem:{flex:1,minHeight:58,paddingVertical:5,paddingHorizontal:2,alignItems:'center',justifyContent:'center',gap:2,borderRadius:theme.radius.sm},
  tabActive:{backgroundColor:theme.soft},
  tabIcon:{color:theme.muted,fontSize:23,fontWeight:'700',lineHeight:27},
  tabLabel:{color:theme.muted,fontSize:11,fontWeight:'600',textAlign:'center'},
  tabSelected:{color:G,fontWeight:'800'},
  vehicleChoice:{flex:1,minWidth:120,backgroundColor:theme.background,borderWidth:1,borderColor:theme.border,borderRadius:theme.radius.md,padding:12,gap:5},
  vehicleSelected:{borderColor:G,borderWidth:2,backgroundColor:theme.soft},
  vehicleTop:{flexDirection:'row-reverse',alignItems:'center',justifyContent:'space-between'},
  vehicleGlyph:{fontSize:34,color:G},
  radio:{width:20,height:20,borderRadius:10,borderWidth:1,borderColor:theme.muted,alignItems:'center',justifyContent:'center'},
  radioSelected:{borderColor:G,borderWidth:2},
  radioDot:{width:10,height:10,borderRadius:5,backgroundColor:G},
  badge:{alignSelf:'flex-end',color:G,backgroundColor:theme.soft,paddingHorizontal:10,paddingVertical:6,borderRadius:12,fontSize:12,fontWeight:'700'},
  pendingBadge:{alignSelf:'flex-end',color:'#775717',backgroundColor:theme.warning,paddingHorizontal:10,paddingVertical:6,borderRadius:12,fontSize:12,fontWeight:'700'},
  walletHero:{backgroundColor:theme.deep,borderRadius:theme.radius.lg,padding:theme.space.lg,gap:8},
  walletEyebrow:{fontSize:14,fontWeight:'700',color:Y,textAlign:'right'},
  walletTitle:{fontSize:28,fontWeight:'900',color:theme.surface,textAlign:'right'},
  walletText:{fontSize:15,lineHeight:22,color:'#DDEBE4',textAlign:'right'},
  paymentRow:{flexDirection:'row-reverse',alignItems:'center',gap:12,paddingVertical:12,borderBottomWidth:1,borderColor:theme.border},
  paymentIcon:{width:44,height:44,borderRadius:12,backgroundColor:theme.soft,justifyContent:'center',alignItems:'center'},
  paymentSymbol:{color:G,fontSize:22,fontWeight:'800'},
  cargoPhoto:{width:'100%',height:160,borderRadius:theme.radius.sm,resizeMode:'contain'}
});
