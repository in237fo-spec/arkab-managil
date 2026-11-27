import 'react-native-url-polyfill/auto';
import React, {useState, useEffect, useRef, useCallback} from 'react';
import SplashIntro from './SplashIntro';
import {
  View, Text as NativeText, TextInput as NativeInput, TouchableOpacity,
  ScrollView, Image, StyleSheet,
  ActivityIndicator, StatusBar, AppState, Linking, Alert, Share, Pressable, Platform, Modal
} from 'react-native';
import {SafeAreaProvider, SafeAreaView}
  from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as ImagePicker from 'expo-image-picker';
import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import {coordinate,estimateFare,useNearbyVehicles,useAvailableDriverLocation,useRidePush} from './rideFeatures';
import {Map, Camera, Marker, GeoJSONSource, Layer} from '@maplibre/maplibre-react-native';
import {createClient} from '@supabase/supabase-js';
import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import {useFonts} from 'expo-font';
import {useRoadRoute} from './roadRoute';
import {createRefreshQueue} from './refreshQueue';
import {parseFare} from './pricingLogic';
import {readDeletionRequest,submitDeletionRequest} from './accountDeletion';
import {useBiometricGate} from './biometricGate';
import {registerPassengerShareTask,beginPassengerShare,endPassengerShare,stopNativeShare,reconcilePassengerShare,usePassengerShare,shareReady,makeTrackingLink,activeShareLink,trackingViewer,useEarnings,useSupportTickets,supportCategories,supportStatuses,validateTicket} from './v09Services';
const Cairo_400Regular=require('@expo-google-fonts/cairo/400Regular/Cairo_400Regular.ttf');
const Cairo_700Bold=require('@expo-google-fonts/cairo/700Bold/Cairo_700Bold.ttf');

const FontContext = React.createContext(false);
function Text({style,...props}) {
  const loaded = React.useContext(FontContext);
  const weight = StyleSheet.flatten(style)?.fontWeight;
  const custom = loaded ? {fontFamily:['700','800','900','bold','600'].includes(String(weight)) ? 'Cairo_700Bold' : 'Cairo_400Regular',fontWeight:'normal'} : null;
  return <NativeText {...props} style={[style,custom]}/>;
}
function TextInput({style,...props}) {
  const loaded = React.useContext(FontContext);
  return <NativeInput {...props} style={[style,loaded&&{fontFamily:'Cairo_400Regular'}]}/>;
}

const theme = {
  green:'#147A53', deep:'#0B3D2E', gold:'#D5AC53', background:'#F4F7F5',
  surface:'#FFFFFF', soft:'#EAF3EE', ink:'#172821', muted:'#62736B',
  border:'#E1E9E4', danger:'#B42318', warning:'#FFF4D6',
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

registerPassengerShareTask(db);

const DRIVER_LOCATION_TASK = 'arkab-driver-background-location-v1';
const ACTIVE_RIDE_KEY = 'arkab.background.activeRideId';
const ACTIVE_DRIVER_KEY = 'arkab.background.driverId';
const AVAILABLE_TASK = 'arkab-available-driver-v1';
const AVAILABLE_DRIVER_KEY = 'arkab.background.availableDriverId';

async function stopAvailableBackground() {
  if (await Location.hasStartedLocationUpdatesAsync(AVAILABLE_TASK).catch(()=>false))
    await Location.stopLocationUpdatesAsync(AVAILABLE_TASK).catch(()=>{});
  await SecureStore.deleteItemAsync(AVAILABLE_DRIVER_KEY).catch(()=>{});
}
if (!TaskManager.isTaskDefined(AVAILABLE_TASK)) {
  TaskManager.defineTask(AVAILABLE_TASK, async ({data,error})=>{
    if(error || !data?.locations?.length) return;
    try {
      const driverId=await SecureStore.getItemAsync(AVAILABLE_DRIVER_KEY);
      if(!driverId) { await stopAvailableBackground(); return; }
      const {data:sessionData,error:sessionError}=await db.auth.getSession();
      if(sessionError) return;
      if(sessionData.session?.user.id!==driverId) {await stopAvailableBackground();return;}
      const {data:driver,error:driverError}=await db.from('drivers').select('approved,online').eq('id',driverId).maybeSingle();
      if(driverError) return;
      if(!driver?.approved||!driver?.online){await stopAvailableBackground();return;}
      const {data:ride,error:rideError}=await db.from('rides').select('id').eq('driver_id',driverId)
        .in('status',['accepted','arrived','in_progress']).limit(1).maybeSingle();
      if(rideError||ride) return;
      const point=data.locations[data.locations.length-1];
      await db.from('driver_locations').upsert({driver_id:driverId,latitude:point.coords.latitude,
        longitude:point.coords.longitude,updated_at:new Date(point.timestamp||Date.now()).toISOString()});
    } catch { /* Retry at the next location event. */ }
  });
}

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
      const {data:sessionData,error:sessionError}=await db.auth.getSession();
      if(sessionError) return;
      if(sessionData.session?.user.id!==driverId){
        await Location.stopLocationUpdatesAsync(DRIVER_LOCATION_TASK).catch(()=>{});
        await SecureStore.deleteItemAsync(ACTIVE_RIDE_KEY);
        await SecureStore.deleteItemAsync(ACTIVE_DRIVER_KEY);
        return;
      }
      const {data:ride,error:rideError} = await db.from('rides')
        .select('id,status,driver_id').eq('id',rideId).eq('driver_id',driverId).maybeSingle();
      // A temporary network failure is not proof that a ride ended.
      if (rideError) throw rideError;
      if (!ride || !['accepted','arrived','in_progress'].includes(ride.status)) {
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

function rideErrorMessage(error) {
  const message = error?.message || 'تعذر الاتصال';
  if (/network request failed|failed to fetch|fetch failed|timeout|network error/i.test(message))return 'تعذر الاتصال بالإنترنت. تحقق من الشبكة وحاول مجدداً.';
  if (error?.code==='23505' && /rides_one_active_(driver|passenger)/i.test(message+' '+(error.details||''))) return 'توجد رحلة نشطة بالفعل للراكب أو الكابتن. حدّث الطلبات واختر رحلة أو عرضاً آخر.';
  if (/ride unavailable|ride not found|ride is not available|offer unavailable|offer not found/i.test(message)) {
    return 'الرحلة أو العرض لم يعد متاحاً. تم طلب تحديث الحالة؛ راجع تفاصيل الرحلة وحاول مرة أخرى.';
  }
  return message;
}

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
    ['home','home-outline','الرئيسية'],
    ['trips','car-outline','رحلاتي'],
    ['favorites',isDriver?'help-circle-outline':'heart-outline',isDriver?'المساعدة':'المفضلة'],
    ['notifications','notifications-outline','التنبيهات'],
    ['account','person-circle-outline','حسابي']
  ];
  return <View style={s.tabBar}>
    {items.map(([key,icon,label])=>(
      <Pressable key={key} accessibilityRole="tab" accessibilityLabel={label}
        accessibilityState={{selected:tab===key}} onPress={()=>onChange(key)}
        style={({pressed})=>[s.tabItem,tab===key&&s.tabActive,pressed&&{opacity:0.75}]}>
        <Ionicons name={icon} size={24} color={tab===key?G:theme.muted}/>
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
    <View style={s.vehicleTop}><MaterialCommunityIcons name={cargo?'truck-cargo-container':'rickshaw'} size={36} color={G}/>
      <View style={[s.radio,selected&&s.radioSelected]}>{selected&&<View style={s.radioDot}/>}</View>
    </View>
    <Text style={s.label}>{cargo?'تكتك نقل':'ركشة'}</Text>
    <Text style={s.caption}>{cargo?'لنقل الأغراض والحمولات':'للمشاوير اليومية'}</Text>
  </Pressable>;
}

function RideChat({rideId,userId}) {
  const [messages,setMessages]=useState([]);
  const [message,setMessage]=useState('');
  const [chatState,setChatState]=useState('loading');
  const [sending,setSending]=useState(false);
  const [sendError,setSendError]=useState('');
  useEffect(()=>{
    let alive=true,pending=false;
    async function loadChat(){
      if(pending||!alive) return;
      pending=true;
      try {
        const {data,error}=await db.from('ride_messages')
          .select('id,sender_id,body,created_at').eq('ride_id',rideId)
          .order('created_at',{ascending:false}).limit(40);
        if(!alive) return;
        if(error) { setChatState('unavailable'); return; }
        setMessages((data||[]).reverse());
        setChatState('ready');
      } catch {if(alive)setChatState('unavailable');}
      finally{pending=false;}
    }
    loadChat();
    const timer=setInterval(loadChat,6000);
    const channel=db.channel('ride-chat-'+rideId)
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'ride_messages',filter:'ride_id=eq.'+rideId},loadChat)
      .subscribe();
    return ()=>{alive=false;clearInterval(timer);db.removeChannel(channel);};
  },[rideId,userId]);
  async function send(){
    const body=message.trim();
    if(!body||sending||chatState!=='ready')return;
    setSending(true);setSendError('');
    try{
      const row=check(await db.from('ride_messages').insert({ride_id:rideId,body})
        .select('id,sender_id,body,created_at').single());
      setMessages(prev=>[...prev.filter(m=>m.id!==row.id),row].slice(-40));
      setMessage('');
    }catch{setSendError('تعذر إرسال الرسالة. حاول مجدداً.');}
    finally{setSending(false);}
  }
  return <View style={s.card}>
    <Text style={s.title}>محادثة الرحلة</Text>
    {chatState==='loading' && <ActivityIndicator color={G}/>}
    {chatState==='unavailable' && <Text style={s.caption}>المحادثة غير متاحة حالياً. استخدم الاتصال بالكابتن عند الحاجة.</Text>}
    {chatState==='ready' && <>
      {!messages.length&&<Text style={s.caption}>ابدأ المحادثة مع الطرف الآخر.</Text>}
      {messages.map(m=><View key={m.id} style={[s.chatBubble,m.sender_id===userId?s.chatMine:s.chatOther]}>
        <Text style={s.body}>{m.body}</Text>
        <Text style={s.caption}>{new Date(m.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</Text>
      </View>)}
      <Field label="رسالة" placeholder="اكتب رسالتك…" value={message} onChangeText={setMessage} maxLength={500}/>
      {!!sendError&&<Text style={s.error}>{sendError}</Text>}
      <Button disabled={sending||!message.trim()} onPress={send}>{sending?'جارٍ الإرسال…':'إرسال الرسالة'}</Button>
    </>}
  </View>;
}

function parseSchedule(value){
  const m=/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/.exec(value.trim());
  if(!m) return null;
  const y=+m[1],month=+m[2]-1,d=+m[3],h=+m[4],min=+m[5];
  const date=new Date(y,month,d,h,min);
  return date.getFullYear()===y&&date.getMonth()===month&&date.getDate()===d&&
    date.getHours()===h&&date.getMinutes()===min?date:null;
}

function localDateLabel(date){
  const d=new Date(date);
  return d.toLocaleString('ar-SD');
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

function Pin({id,point,color,label,icon,count,onPress}) {
  if (!point) return null;
  return (
    <Marker id={id} lngLat={point} onPress={onPress}>
      <View style={s.pinWrap}>
        <View style={[s.pin,{backgroundColor:color}]}>
          {icon
            ? <MaterialCommunityIcons name={icon} size={19} color="#FFFFFF"/>
            : <Text style={{color:'#FFFFFF',fontWeight:'800'}}>{label}</Text>}
        </View>
        {count>1&&<View style={s.pinCount}><Text style={s.pinCountText}>{count}</Text></View>}
      </View>
    </Marker>
  );
}

function RideMap({
  pickup,destination,driver,onSelect,nearby=[],nearbyAnchor,route,staleDriver=false,onSelectNearbyDriver
}) {
  const center = pickup || driver || destination || nearbyAnchor || CENTER;
  const camera=useRef(null);
  const [mapError,setMapError]=useState(false);
  const [reload,setReload]=useState(0);
  const [ready,setReady]=useState(false);
  const points=[pickup,destination,driver,...(route?.coordinates||[])].filter(Boolean);
  const fit=()=>{
    if(points.length>1){
      const lng=points.map(p=>p[0]),lat=points.map(p=>p[1]);
      camera.current?.fitBounds([Math.min(...lng),Math.min(...lat),Math.max(...lng),Math.max(...lat)],
        {padding:{top:48,right:48,bottom:48,left:48},duration:400});
    }else camera.current?.easeTo({center,zoom:14,duration:400});
  };
  useEffect(()=>{if(ready&&pickup&&destination)fit();},[ready,pickup?.[0],pickup?.[1],destination?.[0],destination?.[1],route?.coordinates]);
  const line=route?.coordinates?.length>1 ? route.coordinates : null;

  return (
    <View style={s.mapBox}>
      <Map
        key={reload}
        style={s.map}
        onDidFinishLoadingMap={()=>{setReady(true);setMapError(false);}}
        onDidFailLoadingMap={()=>setMapError(true)}
        mapStyle="https://tiles.openfreemap.org/styles/liberty"
        onPress={e => {
          const p = e.nativeEvent.lngLat;
          if (onSelect && Array.isArray(p)) onSelect(p);
        }}>
        <Camera ref={camera}
          initialViewState={{
            center,
            zoom:14
          }}
        />

        {line&&<GeoJSONSource id="road-route" data={{type:'Feature',properties:{},geometry:{type:'LineString',coordinates:line}}}>
          <Layer id="road-route-line" type="line" paint={{'line-color':G,'line-width':5,'line-opacity':0.9}}/>
        </GeoJSONSource>}
        {nearby.map(cell=>(
          <Pin key={cell.driver_id || cell.kind+'-'+cell.lat+'-'+cell.lng}
            id={'nearby-driver-'+(cell.driver_id || cell.kind+'-'+cell.lat+'-'+cell.lng)}
            point={[cell.lng,cell.lat]}
            color={cell.kind==='rickshaw'?'#246D52':'#915319'}
            icon={cell.kind==='rickshaw'?'rickshaw':'truck-cargo-container'}
            count={cell.vehicle_count}
            onPress={()=>onSelectNearbyDriver?.(cell)}/>
        ))}
        <Pin id="pickup" point={pickup}
          color={G} label="1"/>

        <Pin id="destination" point={destination}
          color="#D84315" label="2"/>

        <Pin id="driver" point={driver}
          color={staleDriver?"#75827A":"#1565C0"} icon="rickshaw"/>
      </Map>

      <Pressable style={s.mapControl} accessibilityRole="button" accessibilityLabel="إعادة توسيط الخريطة" disabled={!ready} onPress={fit}>
        <Ionicons name="locate-outline" size={24} color={G}/>
      </Pressable>
      {mapError&&<View style={s.mapError}><Text style={s.caption}>تعذر تحميل الخريطة. تحقق من الإنترنت.</Text>
        <Button secondary onPress={()=>{setReady(false);setMapError(false);setReload(v=>v+1);}}>إعادة المحاولة</Button></View>}
      <Text style={s.attribution}>
        © OpenStreetMap contributors • OpenFreeMap{route?' • OSRM':''}
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
  const [selectedNearbyDriver,setSelectedNearbyDriver] = useState(null);
  const [forSomeone,setForSomeone] = useState(false);
  const [recipientPhone,setRecipientPhone] = useState('+249');
  const [cargoDescription,setCargoDescription] = useState('');
  const [cargoPhoto,setCargoPhoto] = useState(null);
  const [openedPhoto,setOpenedPhoto] = useState(null);
  const submittedDraft = useRef(null);
  const [pricing,setPricing] = useState([]);
  const [pricingStatus,setPricingStatus] = useState('loading');
  const [savedRides,setSavedRides] = useState([]);
  const [notifications,setNotifications] = useState([]);
  const [focusedRide,setFocusedRide] = useState(null);
  const [savedPlaces,setSavedPlaces] = useState({});
  const [scheduledRides,setScheduledRides] = useState([]);
  const [scheduleDate,setScheduleDate] = useState('');
  const [scheduleOpen,setScheduleOpen] = useState(false);
  const [emergencyPhone,setEmergencyPhone] = useState('');
  const [localReady,setLocalReady] = useState(false);
  const [chatOpen,setChatOpen] = useState(false);
  const [tripFilter,setTripFilter] = useState('active');
  const [expandedTrip,setExpandedTrip] = useState(null);
  const [tripPage,setTripPage] = useState(1);

  const [trips,U] = useState([]);
  const [offers,H] = useState([]);
  const [bid,J] = useState({});
  const [tab,D] = useState('home');

  const [busy,K] = useState(false);
  const actionPending=useRef(false);
  const [extraOpen,setExtraOpen]=useState(false);
  const [availabilityBackground,setAvailabilityBackground]=useState(false);
  const [syncStatus,setSyncStatus]=useState('loading');
  const [lastSync,setLastSync]=useState(null);
  const [err,E] = useState('');
  const [notice,SN] = useState('');

  const [activeRide,AR] = useState(null);
  const refreshSequence = useRef(0);
  const refreshQueue = useRef(null);
  if (!refreshQueue.current) refreshQueue.current=createRefreshQueue();
  const currentAccount = useRef(null);
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
  const [locationStale,setLocationStale]=useState(false);
  const [sharing,SH] = useState(false);
  const watchRef = useRef(null);
  const sharingRef = useRef(false);
  const lastSent = useRef(0);

  const route=useRoadRoute(pickupPoint,destPoint,db);
  const activeRoute=useRoadRoute(
    activeRide ? coordinate(activeRide.pickup_lng,activeRide.pickup_lat):null,
    activeRide ? coordinate(activeRide.destination_lng,activeRide.destination_lat):null,db);
  const km = route.status==='ready'?route.distanceKm:distanceKm(pickupPoint,destPoint);
  const estimate = pricingStatus==='ready'?estimateFare(pricing,vehicle,pickupPoint && destPoint ? km : null):null;
  const userId = session?.user.id;
  const biometric=useBiometricGate(userId,async(password,expectedId)=>{
    // A retained server session is required; the alternative is password
    // authentication to the same account, not a device credential bypass.
    const address=session?.user?.email;
    if(!address||session.user.id!==expectedId)return false;
    const {data,error}=await db.auth.signInWithPassword({email:address,password});
    return !error&&!!data?.session&&data.session.user.id===expectedId;
  });
  const [earningsPeriod,setEarningsPeriod]=useState('day');
  const earnings=useEarnings(db,userId,earningsPeriod,profile?.role==='driver'&&tab==='earnings',lastSync);
  const passengerShare=usePassengerShare(profile?.role==='passenger'?userId:null,activeRide?.id);
  const [supportRide,setSupportRide]=useState(null);
  function openSupport(rideId=null){setSupportRide(rideId);D('support');}
  const shareLink=activeShareLink(trackingViewer,passengerShare.record,userId,activeRide?.id);
  async function sendShareLink(link){if(!link)throw Error('لا يوجد رابط تتبع متاح');await Share.share({message:'تابع موقعي خلال رحلتي في أركب. الرابط خاص ومؤقت: '+link});}
  async function startLiveShare(){
    if(profile?.role!=='passenger'||!activeRide?.driver_id||!activeStates.includes(activeRide.status))throw Error('المشاركة متاحة بعد قبول الرحلة');
    const currentRide=activeRide.id;
    await new Promise((resolve,reject)=>Alert.alert('مشاركة التتبع المباشر',
      'ستشارك موقع هاتفك أنت فقط مع من ترسل إليه الرابط. لا تظهر بيانات الكابتن أو رقم هاتفه. ينتهي الرابط تلقائياً عند نهاية الرحلة أو بعد ساعتين، ويمكن إيقافه في أي وقت.',
      [{text:'إلغاء',style:'cancel',onPress:()=>reject(Error('لم يتم تفعيل المشاركة'))},{text:'مشاركة',onPress:resolve}],{cancelable:false}));
    const created=await beginPassengerShare(db,userId,currentRide);
    passengerShare.setRecord(created);
    await sendShareLink(makeTrackingLink(trackingViewer,created.token));
  }
  const localKey = (name)=>'arkab.v07.'+userId+'.'+name;
  useEffect(()=>{
    let alive=true;
    setLocalReady(false);setSavedPlaces({});setScheduledRides([]);setEmergencyPhone('');setScheduleOpen(false);setChatOpen(false);
    if(!userId)return;
    async function loadLocal(){
      try{
        const [places,schedules,phone]=await Promise.all([
          SecureStore.getItemAsync(localKey('places')),
          SecureStore.getItemAsync(localKey('schedules')),
          SecureStore.getItemAsync(localKey('emergency'))
        ]);
        if(alive){setSavedPlaces(JSON.parse(places||'{}'));setScheduledRides(JSON.parse(schedules||'[]'));setEmergencyPhone(phone||'');setLocalReady(true);}
      }catch{if(alive)E('تعذر تحميل البيانات المحفوظة على الجهاز');}
    }
    void loadLocal();
    return()=>{alive=false;};
  },[userId]);
  useEffect(()=>{setChatOpen(false);},[activeRide?.id]);
  const nearby = useNearbyVehicles(db,profile?.role==='passenger' && !activeRide && tab==='home' ? userId : null,pickupPoint || nearbyAnchor);
  useEffect(()=>{if(profile?.role!=='passenger'||activeRide||tab!=='home')setSelectedNearbyDriver(null);},[profile?.role,activeRide?.id,tab]);
  const nearbyCount = kind => nearby.rows.filter(row=>row.kind===kind)
    .reduce((total,row)=>total+row.vehicle_count,0);
  useAvailableDriverLocation(db,profile?.role==='driver' && driver?.approved && driver?.online && !activeRide ? userId : null,E);
  const push = useRidePush(db,profile?.id===userId ? userId : null,openRide);
  const orderedTrips = focusedRide
    ? [...trips.filter(ride=>ride.id===focusedRide),...trips.filter(ride=>ride.id!==focusedRide)]
    : trips;
  const visibleTrips = tab==='trips'
    ? orderedTrips.filter(ride=>ride.id===focusedRide ||
        (tripFilter==='all' ? true :
          tripFilter==='active' ? ['requested',...activeStates].includes(ride.status) :
          ride.status===tripFilter))
    : orderedTrips.filter(ride=>ride.status==='requested');
  const pagedTrips = visibleTrips.slice(0,tripPage*10);

  function openRide(rideId,title) {
    setFocusedRide(rideId);
    D(profile?.role==='driver'&&title==='طلب مشوار قريب'?'home':'trips');
    void refresh();
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
    if(actionPending.current) return;
    actionPending.current=true;
    K(true);
    E('');
    SN('');

    try {
      await fn();
    } catch(e) {
      E(rideErrorMessage(e));
    } finally {
      actionPending.current=false;
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

      const verified=check(await db.auth.verifyOtp({
        email:address,
        token:otp.trim(),
        type:'email'
      }));
      if(verified?.session)biometric.markAccountVerified(verified.session.user.id);

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

      if(data.session)biometric.markAccountVerified(data.session.user.id);
      if (!data.session) {
        O('');
        SM('verify');
        SN('تم طلب إرسال رمز التأكيد');
      }
    } else {
      const signedIn=check(await db.auth.signInWithPassword({
        email:address,password
      }));
      if(signedIn?.session)biometric.markAccountVerified(signedIn.session.user.id);

      SW('');
    }
  }

  function refresh() {
    const id=session?.user.id;
    if(!id||currentAccount.current!==id) return Promise.resolve();
    return refreshQueue.current.request(id,()=>performRefresh(id));
  }

  async function performRefresh(id) {
    if(currentAccount.current!==id) return;
    const seq = ++refreshSequence.current;
    const current = () => seq === refreshSequence.current && currentAccount.current===id;

    try {

      const p=check(await db.from('profiles')
        .select('*').eq('id',id).maybeSingle());

      if (!current()) return;
      P(p);

      if (!p) {setSyncStatus('ready');setLastSync(Date.now());return;}

      const ownerColumn = p.role==='passenger' ? 'passenger_id' : 'driver_id';
      const [historyResult,activeResult] = await Promise.all([
        db.from('rides').select('*').eq(ownerColumn,id)
          .order('created_at',{ascending:false}).limit(50),
        db.from('rides').select('*').eq(ownerColumn,id)
          .in('status',p.role==='passenger' ? ['requested',...activeStates] : activeStates)
          .order('created_at',{ascending:false}).limit(1).maybeSingle()
      ]);
      const history=check(historyResult);
      const active=check(activeResult);
      if (!current()) return;
      const own=active ? [active,...history.filter(r=>r.id!==active.id)] : history;
      AR(active || null);
      if(p.role==='passenger')void reconcilePassengerShare(id,active?.id||null);

      let available=[];

      if (p.role==='driver') {
        const d=check(await db.from('drivers')
          .select('*').eq('id',id).maybeSingle());

        const ownVehicles=check(await db.from('vehicles')
          .select('*').eq('driver_id',id));
        if (!current()) return;
        SD(d); SV(ownVehicles);

        if (d?.approved && d?.online) {
          available=check(
            await db.rpc('available_ride_details')
          ).map(r=>({...r,status:'requested'}));
        }
      }

      if (!current()) return;
      U([
        ...own,
        ...available.filter(r=>
          !own.some(o=>o.id===r.id))
      ]);

      const freshOffers=check(await db.from('ride_offers')
        .select('*')
        .order('created_at',{ascending:false})
        .limit(100));
      if (!current()) return;
      H(freshOffers);
      if (p.role==='driver') {
        const running=await Location.hasStartedLocationUpdatesAsync(DRIVER_LOCATION_TASK).catch(()=>false);
        const storedRideId=await SecureStore.getItemAsync(ACTIVE_RIDE_KEY);
        if (!current()) return;
        if(running && (!active || active.driver_id!==id || storedRideId!==active.id)) {
          await Location.stopLocationUpdatesAsync(DRIVER_LOCATION_TASK).catch(()=>{});
          await SecureStore.deleteItemAsync(ACTIVE_RIDE_KEY);
          await SecureStore.deleteItemAsync(ACTIVE_DRIVER_KEY); SH(false);
        } else SH(Boolean(running && active && storedRideId===active.id));
      }
      if (active?.driver_id) {
        const dp = check(await db.from('profiles').select('id,full_name,contact_phone,avatar_url').eq('id',active.driver_id).maybeSingle());
        const dv = check(await db.from('vehicles').select('kind,plate').eq('driver_id',active.driver_id).eq('approved',true).eq('kind',active.vehicle_kind).limit(2));
        if (!current()) return;
        ADR(dp); AV(dv?.length===1?dv[0]:null);
      } else { ADR(null); AV(null); }
      const ratings = check(await db.from('ratings').select('ride_id').eq('passenger_id',id));
      if (!current()) return;
      RR((ratings||[]).map(x=>x.ride_id));

      const [inboxResult,pricingResult,savedResult] = await Promise.all([
        db.from('notifications').select('id,ride_id,title,body,created_at')
          .eq('user_id',id).order('created_at',{ascending:false}).limit(30),
        p.role==='passenger' ? db.from('pricing').select('vehicle_kind,base_fare,per_km').eq('active',true) : null,
        p.role==='passenger' ? db.from('saved_rides').select('ride_id,rides(*)')
          .eq('user_id',id).order('created_at',{ascending:false}).limit(25) : null
      ]);
      if (!current()) return;
      if (!inboxResult.error) setNotifications(inboxResult.data || []);
      if(pricingResult){
        if(pricingResult.error){setPricing([]);setPricingStatus('error');}
        else{setPricing(pricingResult.data || []);setPricingStatus('ready');}
      }
      if (savedResult && !savedResult.error) setSavedRides((savedResult.data || []).map(row=>row.rides).filter(Boolean));
      setSyncStatus('ready');setLastSync(Date.now());

    } catch(e) {
      if (current()) {setSyncStatus('error');E(rideErrorMessage(e));}
    } finally {
      if (current()) L(false);
    }
  }

  const act=fn=>run(async()=>{
    try {
      await fn();
    } finally {
      // Even when a stale offer or request is rejected, reconcile with the
      // authoritative server status rather than leaving the old card visible.
      await refresh();
    }
  });

  const rpc=(name,args)=>
    db.rpc(name,args).then(check);

  useEffect(()=>{
    let authEventSeen=false;
    let mounted=true;
    db.auth.getSession().then(({data,error})=>{
      if(!mounted||authEventSeen)return;
      if(error) E(error.message);
      currentAccount.current=data.session?.user.id||null;
      S(data.session);
      if(!data.session) L(false);
    }).catch(()=>{if(mounted&&!authEventSeen)L(false);});

    const {data}=db.auth.onAuthStateChange((_,v)=>{
      authEventSeen=true;
      const previous=currentAccount.current;
      const next=v?.user.id||null;
      currentAccount.current=next;
      S(v);

      if(!v||(previous&&previous!==next)){
        refreshQueue.current.reset();
        refreshSequence.current++;
        void stopNativeShare();setSupportRide(null);
        stopTracking();
        void stopAvailableBackground();setAvailabilityBackground(false);setLastSync(null);setSyncStatus('loading');
        Location.stopLocationUpdatesAsync(DRIVER_LOCATION_TASK).catch(()=>{});
        SecureStore.deleteItemAsync(ACTIVE_RIDE_KEY).catch(()=>{});
        SecureStore.deleteItemAsync(ACTIVE_DRIVER_KEY).catch(()=>{});
        P(null);
        AR(null); ADR(null); AV(null); RR([]); RD({}); J({});
        DP(null);
        U([]);
        H([]);
        SD(null);
        SV([]);
        setNotifications([]);
        setSavedRides([]);
        setPricing([]);setPricingStatus('loading');
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
      mounted=false;
      currentAccount.current=null;
      refreshSequence.current++;
      refreshQueue.current.reset();
      data.subscription.unsubscribe();
      app.remove();
      stopTracking();
    };
  },[]);

  useEffect(()=>{
    if(!session) return;

    const refreshForeground=()=>{if(AppState.currentState==='active')void refresh();};
    refreshForeground();

    const timer=setInterval(()=>{
      if(!refreshQueue.current.isRunning(session.user.id))refreshForeground();
    },12000);
    const foreground=AppState.addEventListener('change',state=>{
      if(state==='active')void refresh();
    });

    const channel=db.channel('arkab-'+session.user.id)
      .on('postgres_changes',{
        event:'*',schema:'public',table:'rides'
      },refreshForeground)
      .on('postgres_changes',{
        event:'*',schema:'public',table:'ride_offers'
      },refreshForeground)
      .on('postgres_changes',{
        event:'INSERT',schema:'public',table:'notifications',filter:'user_id=eq.'+session.user.id
      },refreshForeground)
      .subscribe();

    return ()=>{
      refreshSequence.current++;
      refreshQueue.current.reset();
      clearInterval(timer);
      foreground.remove();
      db.removeChannel(channel);
    };
  },[session?.user.id]);

  useEffect(()=>{
    stopTracking();
    DP(null);
    LT(0);setLocationStale(false);

    if(!activeRide || !session) return;

    let cancelled=false;let locationRequest=0;

    async function readLocation(){
      const sequence=++locationRequest;
      const {data,error}=await db
        .from('ride_locations')
        .select('latitude,longitude,updated_at')
        .eq('ride_id',activeRide.id)
        .maybeSingle();

      if(cancelled||sequence!==locationRequest) return;

      if(error) {setLocationStale(true);return;}
      if(!data || !Number.isFinite(Date.parse(data.updated_at)) || Date.parse(data.updated_at)<=0){
        DP(null);LT(0);setLocationStale(true);return;
      }
      DP([data.longitude,data.latitude]);
      LT(Date.parse(data.updated_at));
      setLocationStale(Date.now()-Date.parse(data.updated_at)>45000);
    }

    const readForeground=()=>{if(AppState.currentState==='active')void readLocation().catch(()=>{if(!cancelled)setLocationStale(true);});};
    readForeground();
    const foreground=AppState.addEventListener('change',state=>{if(state==='active')void readLocation().catch(()=>{if(!cancelled)setLocationStale(true);});});
    const timer=setInterval(readForeground,10000);

    const channel=db.channel('loc-'+activeRide.id)
      .on('postgres_changes',{
        event:'*',
        schema:'public',
        table:'ride_locations',
        filter:'ride_id=eq.'+activeRide.id
      },readForeground)
      .subscribe();

    return ()=>{
      cancelled=true;
      stopTracking();
      foreground.remove();
      clearInterval(timer);
      db.removeChannel(channel);
    };

  },[activeRide?.id,session?.user.id]);

  useEffect(()=>{
    let cancelled=false;
    if(profile?.role!=='driver'||!driver?.approved||!driver?.online){
      if(driver&&(!driver.online||!driver.approved))void stopAvailableBackground();
      setAvailabilityBackground(false);return;
    }
    Location.hasStartedLocationUpdatesAsync(AVAILABLE_TASK).then(running=>{
      if(!cancelled)setAvailabilityBackground(running);
    }).catch(()=>{});
    return()=>{cancelled=true;};
  },[profile?.role,driver?.approved,driver?.online,userId]);

  async function enableAvailableBackground(){
    if(!driver?.approved||!driver?.online) throw Error('فعّل استقبال الطلبات أولاً');
    const allowed=await Location.requestForegroundPermissionsAsync();
    if(allowed.status!=='granted')throw Error('فعّل إذن الموقع أولاً');
    await new Promise((resolve,reject)=>Alert.alert('ظهور المركبة في الخلفية',
      'أثناء تفعيل استقبال الطلبات سيحدّث أركب موقع مركبتك حتى عند إطفاء الشاشة. تظهر للركاب منطقة تقريبية فقط. أوقف استقبال الطلبات لإيقافه.',
      [{text:'إلغاء',style:'cancel',onPress:()=>reject(Error('لم يتم تفعيل الظهور في الخلفية'))},{text:'متابعة',onPress:resolve}],
      {cancelable:false}));
    const permission=await Location.requestBackgroundPermissionsAsync();
    if(permission.status!=='granted')throw Error('لم يتم السماح بالموقع في الخلفية؛ ستظل متاحاً أثناء فتح التطبيق');
    await SecureStore.setItemAsync(AVAILABLE_DRIVER_KEY,userId);
    try{
      const options={accuracy:Location.Accuracy.Balanced,timeInterval:45000,distanceInterval:0,
        deferredUpdatesInterval:45000,pausesUpdatesAutomatically:false};
      if(Platform.OS==='android') options.foregroundService={
        notificationTitle:'أركب | متاح للطلبات',notificationBody:'يتم تحديث موقع المركبة أثناء توفرها فقط',notificationColor:G,killServiceOnDestroy:false};
      if(!(await Location.hasStartedLocationUpdatesAsync(AVAILABLE_TASK)))
        await Location.startLocationUpdatesAsync(AVAILABLE_TASK,options);
      setAvailabilityBackground(true);SN('تم تفعيل ظهور المركبة في الخلفية');
    }catch(e){await stopAvailableBackground();throw e;}
  }

  async function toggleAvailability(){
    if(!driver?.approved)throw Error('الحساب بانتظار الاعتماد');
    if(activeRide)throw Error('أكمل الرحلة النشطة أولاً');
    if(!driver.online){
      if(!vehicles.some(v=>v.approved))throw Error('يلزم اعتماد مركبة أولاً');
      const point=await getGPS();
      check(await db.from('driver_locations').upsert({driver_id:userId,latitude:point[1],longitude:point[0],updated_at:new Date().toISOString()}));
      check(await db.from('drivers').update({online:true}).eq('id',userId));
    }else{
      check(await db.from('drivers').update({online:false}).eq('id',userId));
      await stopAvailableBackground();setAvailabilityBackground(false);
    }
  }

  async function advanceActiveRide(t){
    const next={accepted:'arrived',arrived:'in_progress',in_progress:'completed'}[t.status];
    if(!next)throw Error('حالة الرحلة غير متاحة');
    await rpc('advance_ride',{p_ride:t.id,p_status:next});
    if(next==='completed')await stopSharing(false);
  }

  async function startSharing(){
    if(!activeRide || activeRide.driver_id!==session.user.id || !activeStates.includes(activeRide.status))
      throw Error('لا توجد رحلة نشطة مرتبطة بحسابك');
    const foreground=await Location.requestForegroundPermissionsAsync();
    if(foreground.status!=='granted') throw Error('يجب السماح بموقع الهاتف أثناء استخدام التطبيق');
    await new Promise((resolve,reject)=>Alert.alert(
      'السماح بمشاركة الموقع في الخلفية',
      'سيشارك أركب موقعك مع الراكب أثناء الرحلة النشطة فقط، حتى عند تصغير التطبيق أو إطفاء الشاشة. سيظهر إشعار دائم أثناء المشاركة.',
      [{text:'متابعة',onPress:resolve},{text:'إلغاء',style:'cancel',onPress:()=>reject(Error('تم إلغاء تفعيل تتبع الخلفية'))}],{cancelable:false}
    ));
    const background=await Location.requestBackgroundPermissionsAsync();
    if(background.status!=='granted') throw Error('فعّل إذن الموقع في الخلفية من إعدادات الهاتف');
    const running=await Location.hasStartedLocationUpdatesAsync(DRIVER_LOCATION_TASK);
    if(running) await Location.stopLocationUpdatesAsync(DRIVER_LOCATION_TASK);
    await SecureStore.setItemAsync(ACTIVE_RIDE_KEY,activeRide.id);
    await SecureStore.setItemAsync(ACTIVE_DRIVER_KEY,session.user.id);
    try {
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
      await Location.startLocationUpdatesAsync(DRIVER_LOCATION_TASK,options);
      SH(true); SN('بدأ التتبع في الخلفية. سيظل الإشعار ظاهراً حتى انتهاء الرحلة.');
    } catch(e) {
      await SecureStore.deleteItemAsync(ACTIVE_RIDE_KEY);
      await SecureStore.deleteItemAsync(ACTIVE_DRIVER_KEY); throw e;
    }
  }

  async function stopSharing(invalidate=true){
    stopTracking();
    const running=await Location.hasStartedLocationUpdatesAsync(DRIVER_LOCATION_TASK).catch(()=>false);
    if(running) await Location.stopLocationUpdatesAsync(DRIVER_LOCATION_TASK).catch(()=>{});
    await SecureStore.deleteItemAsync(ACTIVE_RIDE_KEY);
    await SecureStore.deleteItemAsync(ACTIVE_DRIVER_KEY);
    if(invalidate&&activeRide && activeRide.driver_id===session?.user.id){
      const {error}=await db.from('ride_locations').update({updated_at:new Date(0).toISOString()})
        .eq('ride_id',activeRide.id).eq('driver_id',session.user.id);
      if(error) E(error.message);
    }
    DP(null); SH(false);
  }

  async function savePlace(name){
    if(!localReady)throw Error('انتظر تحميل الأماكن المحفوظة');
    const point=selectPoint==='dest'?destPoint:pickupPoint;
    const label=selectPoint==='dest'?dest:pickup;
    if(!point||!label.trim())throw Error('حدد الموقع على الخريطة واكتب اسمه أولاً');
    const next={...savedPlaces,[name]:{point,label:label.trim().slice(0,140)}};
    await SecureStore.setItemAsync(localKey('places'),JSON.stringify(next));
    setSavedPlaces(next);SN('تم حفظ الموقع على هذا الجهاز');
  }

  function usePlace(name){
    if(activeRide){E('أنهِ الرحلة الحالية أولاً');return;}
    const place=savedPlaces[name];
    if(!place)return;
    if(selectPoint==='pickup'){AP(place.point);A(place.label);SEL('dest');}
    else {BP(place.point);B(place.label);}
    MK(v=>v+1);D('home');
  }

  async function removePlace(name){
    const next={...savedPlaces};delete next[name];
    await SecureStore.setItemAsync(localKey('places'),JSON.stringify(next));
    setSavedPlaces(next);
  }

  async function saveSchedule(){
    if(!localReady)throw Error('انتظر تحميل المشاوير المحفوظة');
    if(!pickupPoint||!destPoint||!pickup.trim()||!dest.trim())throw Error('حدد نقطتي المشوار واكتب أسماءهما');
    if(scheduledRides.length>=3)throw Error('يمكن حفظ ثلاثة مشاوير مؤجلة. احذف مشواراً قديماً أولاً.');
    const when=parseSchedule(scheduleDate);
    if(!when||when.getTime()<Date.now()+60000)throw Error('أدخل موعداً مستقبلياً صحيحاً بصيغة سنة-شهر-يوم ساعة:دقيقة');
    if(cargoPhoto)throw Error('أزل صورة الحمولة قبل حفظ المسودة، ويمكن إضافتها عند الطلب');
    const item={id:Crypto.randomUUID(),when:when.getTime(),pickup:pickup.trim().slice(0,140),destination:dest.trim().slice(0,140),
      pickupPoint,destPoint,vehicle,price:price.trim().slice(0,20),pickupNote:pickupNote.trim().slice(0,240),
      cargoDescription:cargoDescription.trim().slice(0,180),forSomeone,recipientPhone:forSomeone?recipientPhone.trim().slice(0,13):'',notificationId:null};
    let notified=false;
    try{
      await Notifications.setNotificationChannelAsync('arkab-reminders',{name:'تذكير المشاوير',importance:Notifications.AndroidImportance.DEFAULT});
      let permissions=await Notifications.getPermissionsAsync();
      if(permissions.status!=='granted')permissions=await Notifications.requestPermissionsAsync();
      if(permissions.status==='granted'){
        item.notificationId=await Notifications.scheduleNotificationAsync({
          content:{title:'حان موعد مشوارك',body:'افتح أركب وراجع تفاصيل المشوار المحفوظ لتأكيد طلبه.'},
          trigger:{type:Notifications.SchedulableTriggerInputTypes.DATE,date:when,channelId:'arkab-reminders'}
        });
        notified=true;
      }
    }catch{/* draft remains usable when scheduling is not available */}
    const next=[...scheduledRides,item].sort((x,y)=>x.when-y.when);
    try{await SecureStore.setItemAsync(localKey('schedules'),JSON.stringify(next));}
    catch(e){if(item.notificationId)await Notifications.cancelScheduledNotificationAsync(item.notificationId).catch(()=>{});throw e;}
    setScheduledRides(next);setScheduleOpen(false);setScheduleDate('');
    SN(notified?'تم حفظ المشوار وتفعيل التذكير. أكّد الطلب عند الموعد.':'تم حفظ المشوار دون إشعار؛ راجع المفضلة عند الموعد.');
    D('favorites');
  }

  function restoreSchedule(item){
    if(activeRide){E('أنهِ الرحلة الحالية قبل طلب مشوار آخر');return;}
    clearRideDraft();
    A(item.pickup);B(item.destination);AP(item.pickupPoint);BP(item.destPoint);V(item.vehicle);
    Q(item.price||'');setPickupNote(item.pickupNote||'');setCargoDescription(item.cargoDescription||'');
    setForSomeone(!!item.forSomeone);setRecipientPhone(item.recipientPhone||'+249');
    MK(v=>v+1);D('home');SN('راجع التفاصيل ثم اضغط اطلب مشوارك');
  }

  async function removeSchedule(item){
    const next=scheduledRides.filter(r=>r.id!==item.id);
    await SecureStore.setItemAsync(localKey('schedules'),JSON.stringify(next));
    if(item.notificationId)await Notifications.cancelScheduledNotificationAsync(item.notificationId).catch(()=>{});
    setScheduledRides(next);
  }

  async function saveEmergency(){
    if(!localReady)throw Error('انتظر تحميل الحساب');
    const phone=emergencyPhone.trim();
    if(phone&&!/^\+249\d{9}$/.test(phone))throw Error('أدخل رقم جهة الاتصال بصيغة +249XXXXXXXXX');
    await SecureStore.setItemAsync(localKey('emergency'),phone);
    SN(phone?'تم حفظ جهة الاتصال':'تم حذف جهة الاتصال');
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
    submittedDraft.current=null;setExtraOpen(false);
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
    if(activeRide)throw Error('لديك رحلة نشطة بالفعل');
    if (!pickupPoint || !destPoint) throw Error('حدد نقطتي الرحلة على الخريطة');
    if(distanceKm(pickupPoint,destPoint)<0.03)throw Error('اختر وجهة مختلفة عن نقطة الانطلاق');
    if (!pickup.trim() || !dest.trim()) throw Error('أدخل أسماء المواقع');
    const fare = price.trim() ? parseFare(price) : estimate;
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

  if(session&&biometric.blocked)return <BiometricLockScreen gate={biometric} hasEmail={!!session.user.email}/>;

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="dark-content" backgroundColor={theme.background}/>

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
             {syncStatus==='error'&&<View style={s.syncBanner}><Ionicons name="cloud-offline-outline" color={theme.danger} size={22}/><View style={{flex:1}}><Text style={s.label}>الاتصال غير مستقر</Text><Text style={s.caption}>{lastSync?'آخر مزامنة '+new Date(lastSync).toLocaleTimeString():'لم تتم المزامنة بعد'}؛ نحتفظ بآخر بيانات متاحة.</Text></View><Pressable accessibilityRole="button" accessibilityLabel="إعادة المزامنة" style={s.iconButton} onPress={refresh}><Ionicons name="refresh" size={22} color={G}/></Pressable></View>}
             {tab==='home' && <View style={s.welcome}>
              <View style={{flex:1}}>
                <Text style={s.eyebrow}>{profile.role==='driver'?'لوحة الكابتن':'مرحباً بك'}</Text>
                <Text style={s.title}>أهلاً {profile.full_name}</Text>
                <Text style={s.body}>{profile.role==='driver'?'تابع طلباتك ومركبتك':'وين ماشي اليوم؟'}</Text>
              </View>
              <View style={s.brandBadge}><Ionicons name="car-sport-outline" size={27} color={theme.deep}/></View>
            </View>}

            {tab==='home'&&!push.enabled&&!push.checking&&<View style={s.card}>
              <View style={s.optionRow}><View style={{flex:1}}>
                <Text style={s.label}>تنبيهات المشاوير على الهاتف</Text>
                <Text style={s.caption}>{profile.role==='driver'?'اعرف بالطلبات القريبة حتى عندما لا تكون فاتح أركب.':'اعرف بقبول الكابتن ووصوله وبدء الرحلة حتى بعد إغلاق أركب.'}</Text>
              </View><Ionicons name="notifications-outline" size={25} color={G}/></View>
              <Button secondary onPress={()=>D('notifications')}>تفعيل إشعارات الهاتف</Button>
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
              <View style={s.tripSummary}>
                <View style={s.optionRow}><Ionicons name="finger-print-outline" size={28} color={G}/><View style={{flex:1,gap:5}}>
                  <Text style={s.label}>فتح التطبيق بالبصمة</Text>
                  <Text style={s.caption}>{biometric.enabled===true?'مفعّل على هذا الجهاز':'اختياري • يحمي فتح التطبيق فقط'}</Text>
                </View></View>
                {biometric.available===false&&<Text style={s.caption}>سجّل بصمة قوية في إعدادات الهاتف أولاً إن كنت ترغب في تفعيلها.</Text>}
                {!!biometric.error&&<Text style={s.error}>{biometric.error}</Text>}
                <Button secondary={biometric.enabled!==false} disabled={biometric.busy||biometric.phase==='checking'}
                  onPress={biometric.enabled===false?biometric.enable:biometric.disable}>
                  {biometric.busy?'جارٍ التحقق…':biometric.enabled===false?'تفعيل البصمة':'إيقاف حماية البصمة'}
                </Button>
                <Text style={s.caption}>يبقى تسجيل الدخول بكلمة المرور متاحاً. لا يخزن أركب البصمة ولا يرسلها إلى الخادم.</Text>
              </View>
              <Button secondary onPress={()=>openSupport()}>الدعم الفني والشكاوى</Button>
              <Button secondary onPress={()=>D('privacy')}>الخصوصية وحذف الحساب</Button>
              {profile.role==='driver'&&<Button secondary onPress={()=>D('earnings')}>لوحة الأرباح</Button>}
               {profile.role==='driver' && <Text style={s.caption}>بيانات المركبات والاعتماد بالأسفل.</Text>}
              <Button secondary disabled={busy} onPress={()=>run(async()=>{
                                 await stopSharing();
                 if(passengerShare.record)await endPassengerShare(db,userId,passengerShare.record.rideId);
                 await stopAvailableBackground();setAvailabilityBackground(false);
                 if(driver?.approved && driver?.online) {
                  await db.from('drivers').update({online:false}).eq('id',userId);
                }
                try { await push.unregister(); } catch { throw Error('تعذر إيقاف إشعارات هذا الحساب. تحقق من الاتصال وحاول تسجيل الخروج مرة أخرى.'); }
                check(await db.auth.signOut());
              })}>تسجيل الخروج</Button>
            </View>}

            {tab==='privacy'&&<PrivacyPanel key={userId} db={db} userId={userId} onBack={()=>D('account')}/>}
            {tab==='support'&&<SupportPanel key={userId} db={db} userId={userId} rideId={supportRide} onBack={()=>D('account')}/>}
            {tab==='earnings'&&profile.role==='driver'&&<EarningsPanel summary={earnings} period={earningsPeriod} onPeriod={setEarningsPeriod} onBack={()=>D('account')}/>}
            {tab==='favorites' && <>
              {profile.role==='passenger' && <>
                <View style={s.card}>
                  <Text style={s.title}>الأماكن المفضلة</Text>
                  <Text style={s.caption}>احفظ المنزل والعمل من شاشة طلب المشوار بعد تحديد الموقع.</Text>
                  {['home','work'].map(key=><View key={key} style={s.tripSummary}>
                    <Text style={s.label}>{key==='home'?'المنزل':'العمل'}</Text>
                    <Text style={s.body}>{savedPlaces[key]?.label||'لم يتم حفظ الموقع'}</Text>
                    {savedPlaces[key]&&<View style={s.row}>
                      <Button disabled={!localReady||!!activeRide} onPress={()=>{SEL('pickup');if(activeRide)return;AP(savedPlaces[key].point);A(savedPlaces[key].label);SEL('dest');MK(v=>v+1);D('home');}}>الانطلاق من هنا</Button>
                      <Button secondary disabled={!localReady||!!activeRide} onPress={()=>{BP(savedPlaces[key].point);B(savedPlaces[key].label);SEL('pickup');MK(v=>v+1);D('home');}}>اجعلها الوجهة</Button>
                      <Button secondary disabled={busy||!localReady} onPress={()=>run(()=>removePlace(key))}>إزالة</Button>
                    </View>}
                  </View>)}
                  <Button secondary disabled={!!activeRide} onPress={()=>D('home')}>تحديد موقع جديد</Button>
                </View>
                <View style={s.card}>
                  <Text style={s.title}>مشاوير مؤجلة</Text>
                  <Text style={s.caption}>تذكير محلي بمشوار محفوظ، وليس حجزاً مؤكداً أو إرسالاً تلقائياً للكباتن.</Text>
                  {!scheduledRides.length&&<Text style={s.body}>لا توجد مشاوير مؤجلة</Text>}
                  {scheduledRides.map(item=><View key={item.id} style={s.tripSummary}>
                    <Text style={s.label}>{item.pickup} ← {item.destination}</Text>
                    <Text style={s.caption}>{localDateLabel(item.when)} • {item.notificationId?'تذكير مضبوط':'دون تذكير'}</Text>
                    <View style={s.row}>
                      <Button disabled={!!activeRide||busy} onPress={()=>restoreSchedule(item)}>استعادة المشوار</Button>
                      <Button secondary disabled={busy} onPress={()=>run(()=>removeSchedule(item))}>إزالة</Button>
                    </View>
                  </View>)}
                  <Button secondary disabled={!!activeRide} onPress={()=>{D('home');setScheduleOpen(true);}}>إعداد مشوار لاحق</Button>
                </View>
                {!!savedRides.length&&<View style={s.card}>
                  <Text style={s.title}>المشاوير المحفوظة</Text>
                  {savedRides.map(ride=><Button key={ride.id} secondary disabled={!!activeRide||busy} onPress={()=>repeatRide(ride)}>{ride.pickup} ← {ride.destination}</Button>)}
                </View>}
              </>}
              <View style={s.card}>
                <Text style={s.title}>السلامة والمساعدة</Text>
                <Button secondary onPress={()=>openSupport()}>الدعم الفني وإرسال شكوى</Button>
                <Text style={s.caption}>احفظ رقم شخص تثق به للاتصال السريع عند الحاجة.</Text>
                <Field label="جهة اتصال موثوقة" value={emergencyPhone} onChangeText={setEmergencyPhone} placeholder="+249XXXXXXXXX" keyboardType="phone-pad" maxLength={13}/>
                <Button disabled={busy||!localReady} onPress={()=>run(saveEmergency)}>حفظ الرقم</Button>
                <Button secondary disabled={!/^\+249\d{9}$/.test(emergencyPhone.trim())} onPress={()=>run(()=>Linking.openURL('tel:'+emergencyPhone.trim()))}>اتصال بجهة الاتصال</Button>
                <Text style={s.caption}>الدفع نقداً مباشرة مع الكابتن. لا توجد مدفوعات إلكترونية داخل التطبيق.</Text>
              </View>
            </>}

            {tab==='notifications' && (
              <View style={s.card}>
                <Text style={s.title}>إشعارات الرحلات</Text>
                <Text style={s.caption}>{push.checking?'جاري التحقق من إعدادات إشعارات الهاتف…':push.enabled?'إشعارات الهاتف مفعّلة':push.registrationError?'تعذر تسجيل الهاتف؛ حاول التفعيل مرة أخرى':'فعّل إشعارات الهاتف لتصلك مستجدات الرحلة.'}</Text>
                {!push.enabled && <Button secondary disabled={busy||push.checking} onPress={()=>run(async()=>{
                  try {
                    const enabled=await push.enable();
                    if (!enabled) { SN('اسمح بإشعارات أركب من إعدادات الهاتف'); return; }
                    SN('تم تفعيل إشعارات الرحلات');
                  } catch {
                    E('تعذر تفعيل إشعارات الهاتف. يمكنك متابعة الإشعارات من هذه الشاشة.');
                  }
                })}>تفعيل الإشعارات على الهاتف</Button>}
                {!push.enabled&&!push.checking&&<Button secondary onPress={()=>Linking.openSettings()}>فتح إعدادات الهاتف</Button>}
                {!notifications.length && <Text style={s.body}>لا توجد إشعارات حالياً</Text>}
                {notifications.map(item=>(
                  <TouchableOpacity key={item.id} style={s.tripSummary} disabled={!item.ride_id}
                    onPress={()=>openRide(item.ride_id,item.title)}>
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
                 <RideProgress status={activeRide.status}/>
                <View style={s.tripSummary}>
                  <View style={s.detailRow}><Ionicons name="location-outline" size={18} color={G}/><Text style={[s.body,s.detailText]}>الانطلاق: {activeRide.pickup}</Text></View>
                  <View style={s.detailRow}><Ionicons name="flag-outline" size={18} color={G}/><Text style={[s.body,s.detailText]}>الوجهة: {activeRide.destination}</Text></View>
                  {!!activeRide.pickup_note && <Text style={s.body}>مكان الالتقاء: {activeRide.pickup_note}</Text>}
                  {!!activeRide.cargo_description && <Text style={s.body}>الحمولة: {activeRide.cargo_description}</Text>}
                  {profile.role==='driver' && !!activeRide.recipient_phone && activeStates.includes(activeRide.status) && (
                    <Button secondary onPress={()=>run(()=>Linking.openURL('tel:'+activeRide.recipient_phone))}>
                      اتصال بالشخص المنتظر
                    </Button>
                  )}
                  <View style={s.detailRow}><MaterialCommunityIcons name={activeRide.vehicle_kind==='rickshaw'?'rickshaw':'truck-cargo-container'} size={18} color={G}/><Text style={[s.body,s.detailText]}>نوع المركبة: {activeRide.vehicle_kind==='rickshaw'?'ركشة':'تكتك نقل'}</Text></View>
                  <View style={s.detailRow}><Ionicons name="navigate-outline" size={18} color={G}/><Text style={[s.body,s.detailText]}>المسافة: {Number(activeRoute.status==='ready'?activeRoute.distanceKm:activeRide.distance_km||0).toFixed(1)} كم {activeRoute.status==='ready'?'حسب الطريق':'(تقدير محفوظ)'}</Text></View>
                  <View style={s.detailRow}><Ionicons name="time-outline" size={18} color={G}/><Text style={[s.body,s.detailText]}>مدة الطريق المتوقعة: {activeRoute.status==='ready'?Math.max(1,Math.ceil(activeRoute.durationMin)):Math.max(3,Math.ceil(Number(activeRide.distance_km||0)*3))} دقيقة تقريباً {activeRoute.status==='ready'?'حسب الطريق':'(تقدير أولي)'}</Text></View>
                  <View style={s.detailRow}><Ionicons name="cash-outline" size={18} color={G}/><Text style={[s.fare,s.detailText]}>الأجرة: {activeRide.agreed_fare??activeRide.proposed_fare} ج.س</Text></View>
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
                   driver={driverPoint} staleDriver={locationStale}
                   route={activeRoute.status==='ready'?activeRoute:null}
                />

                <Text style={s.body}>
                  {driverPoint ?
                     (locationStale?'آخر موقع معروف (غير مباشر): ':'آخر تحديث لموقع الكابتن: ')+
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
                {profile.role==='driver'&&activeRide.driver_id===userId&&activeStates.includes(activeRide.status)&&
                  <Button disabled={busy} onPress={()=>activeRide.status==='in_progress'?Alert.alert('إنهاء الرحلة','هل وصلت إلى الوجهة؟',[{text:'رجوع',style:'cancel'},{text:'إنهاء',onPress:()=>act(()=>advanceActiveRide(activeRide))}]):act(()=>advanceActiveRide(activeRide))}>{activeRide.status==='accepted'?'وصلت للموقع':activeRide.status==='arrived'?'بدء الرحلة':'إنهاء الرحلة'}</Button>}
                {activeRide.driver_id&&activeStates.includes(activeRide.status)&&
                  <Button secondary onPress={()=>setChatOpen(v=>!v)}>{chatOpen?'إغلاق المحادثة':'محادثة الرحلة'}</Button>}
                {chatOpen&&activeRide.driver_id&&activeStates.includes(activeRide.status)&&
                  <RideChat key={activeRide.id} rideId={activeRide.id} userId={userId}/>}
                {/^\+249\d{9}$/.test(emergencyPhone.trim())&&<Button secondary onPress={()=>run(()=>Linking.openURL('tel:'+emergencyPhone.trim()))}>اتصال بجهة موثوقة</Button>}
                {profile.role==='passenger'&&activeRide.driver_id&&activeStates.includes(activeRide.status)&&<View style={s.tripSummary}>
                  <Text style={s.label}>مشاركة التتبع المباشر مع الأسرة</Text>
                  <Text style={s.caption}>{shareLink?'المشاركة مفعّلة حتى '+new Date(passengerShare.record.expiresAt).toLocaleTimeString()+' أو نهاية الرحلة.':'يمكن لشخص تثق به متابعة موقعك أثناء الرحلة.'}</Text>
                  {!shareReady()?<Text style={s.caption}>صفحة التتبع لم تُفعّل على الخادم بعد.</Text>:<>
                    <Button disabled={busy} onPress={()=>run(shareLink?()=>sendShareLink(shareLink):startLiveShare)}>{shareLink?'إعادة مشاركة الرابط':'مشاركة موقعي المباشر'}</Button>
                    <Button secondary disabled={busy} onPress={()=>run(async()=>{await endPassengerShare(db,userId,activeRide.id);passengerShare.setRecord(null);SN('تم إلغاء رابط المشاركة');})}>إيقاف وإلغاء رابط التتبع</Button>
                  </>}
                </View>}
                <Button secondary onPress={()=>openSupport(activeRide.id)}>مساعدة أو شكوى لهذه الرحلة</Button>
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
                <Text style={s.title}>وين ماشي؟</Text>
                <Text style={s.caption}>اختر مكان الانطلاق والوجهة، ثم المركبة المناسبة.</Text>
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
                  route={route.status==='ready'?route:null}
                  onSelectNearbyDriver={setSelectedNearbyDriver}
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
                  استخدام موقعي الحالي
                </Button>

                {nearby.status!=='idle' && (
                  <View style={s.tripSummary}>
                    <View style={s.optionRow}><Text style={[s.label,{flex:1}]}>المركبات المتاحة حول الانطلاق</Text><Pressable accessibilityRole="button" accessibilityLabel="تحديث المركبات القريبة" style={s.iconButton} onPress={nearby.refresh}><Ionicons name="refresh-outline" size={22} color={G}/></Pressable></View>
                    {nearby.status==='ready'
                      ? <View style={s.optionRow}><MaterialCommunityIcons name="rickshaw" size={19} color={G}/><Text style={s.body}>{nearbyCount('rickshaw')} ركشة</Text><MaterialCommunityIcons name="truck-cargo-container" size={19} color={G}/><Text style={s.body}>{nearbyCount('cargo_tuktuk')} تكتك شحن</Text></View>
                      : <Text style={s.body}>{nearby.status==='loading' ? 'جاري تحديث المركبات القريبة…' : 'تعذر تحميل المركبات القريبة'}</Text>}
                    {nearby.status==='ready'&&<Text style={s.caption}>آخر تحديث: {new Date(nearby.updatedAt).toLocaleTimeString()} • المواقع تقريبية لحماية خصوصية الكباتن.</Text>}
                  </View>
                )}

                <Field label="اسم مكان الانطلاق"
                  value={pickup} onChangeText={A}/>

                <Field label="اسم الوجهة"
                  value={dest} onChangeText={B} placeholder="مثلاً: السوق أو المستشفى"/>
                <Pressable accessibilityRole="button" accessibilityState={{expanded:extraOpen}} style={s.optionRow} onPress={()=>setExtraOpen(v=>!v)}>
                  <Ionicons name="options-outline" size={22} color={G}/><Text style={[s.label,{flex:1}]}>خيارات المشوار والمفضلة</Text><Ionicons name={extraOpen?'chevron-up':'chevron-down'} size={20} color={G}/>
                </Pressable>
                {extraOpen&&<>
                <Field label="وصف مكان الالتقاء (اختياري)" placeholder="مثلاً: بوابة السوق الغربية" value={pickupNote} onChangeText={setPickupNote} maxLength={240}/>
                <View style={s.tripSummary}>
                  <Text style={s.label}>الأماكن المفضلة</Text>
                  <Text style={s.caption}>اختر الانطلاق أو الوجهة أعلاه ثم احفظ الموقع أو استخدم مكاناً محفوظاً.</Text>
                  <View style={s.row}>
                    <Button secondary disabled={!localReady||busy} onPress={()=>run(()=>savePlace('home'))}>حفظ كالمنزل</Button>
                    <Button secondary disabled={!localReady||busy} onPress={()=>run(()=>savePlace('work'))}>حفظ كالعمل</Button>
                  </View>
                  <View style={s.row}>
                    {!!savedPlaces.home&&<Button secondary onPress={()=>usePlace('home')}>المنزل</Button>}
                    {!!savedPlaces.work&&<Button secondary onPress={()=>usePlace('work')}>العمل</Button>}
                  </View>
                </View>

                <Button secondary={!forSomeone} onPress={()=>setForSomeone(value=>!value)}>
                  {forSomeone?'تم تفعيل الطلب لشخص آخر':'اطلب لزول تاني'}
                </Button>
                </>}
                {forSomeone && <Field label="رقم هاتف الشخص المنتظر" value={recipientPhone}
                  onChangeText={setRecipientPhone} keyboardType="phone-pad" maxLength={13}/>}

                {!!pickupPoint && !!destPoint &&
                  <Text style={s.fare}>
                    المسافة التقريبية: {km.toFixed(2)} كم
                  </Text>}

                <Text style={s.body}>
                  {route.status==='ready'?'المسافة حسب الطريق المتاح • الزمن '+Math.ceil(route.durationMin)+' دقيقة تقريباً':route.status==='loading'?'جاري حساب الطريق… المسافة الحالية تقدير أولي':'المسافة تقديرية بخط مستقيم، وليست مسافة الطريق الفعلية.'}
                </Text>
                {pickupPoint&&destPoint&&route.status!=='ready'&&route.status!=='loading'&&<Button secondary onPress={route.reload}>إعادة حساب الطريق الفعلي</Button>}
                <Text style={s.caption}>الأجرة النهائية حسب الاتفاق مع الكابتن.
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

                {estimate!==null && <View style={s.tripSummary}><Text style={s.fare}>الأجرة التقديرية: {money(estimate)}</Text><Text style={s.caption}>{route.status==='ready'?'حسب المسافة عبر الطريق':'حسب المسافة التقريبية؛ قد تختلف الأجرة حسب الطريق'}</Text><Button secondary onPress={()=>Q(String(estimate))}>استخدم الأجرة التقديرية</Button></View>}
                {estimate===null && pickupPoint && destPoint &&
                  <Text style={s.body}>{pricingStatus==='loading'?'جاري تحميل تسعيرة المركبة… يمكنك إدخال أجرة مقترحة.':pricingStatus==='error'?'تعذر تحديث التسعيرة؛ أدخل أجرة مقترحة أو حدّث الاتصال.':'لم تعتمد الإدارة تسعيرة تلقائية لهذه المركبة بعد. أدخل أجرة مقترحة.'}</Text>}
                <Field label="الأجرة المقترحة بالجنيه" value={price} onChangeText={Q}
                  placeholder={estimate===null?undefined:String(estimate)} keyboardType="numeric"/>

                {(!pickupPoint||!destPoint)&&<Text style={s.caption}>حدد الموقعين على الخريطة قبل الحجز.</Text>}
                <Button disabled={busy||!pickupPoint||!destPoint||syncStatus==='error'||route.status==='loading'} onPress={()=>act(requestRide)}>
                  اطلب مشوارك
                </Button>
                <Button secondary disabled={busy||!localReady} onPress={()=>setScheduleOpen(v=>!v)}>
                  {scheduleOpen?'إغلاق الموعد':'احفظ مشواراً لوقت لاحق'}
                </Button>
                {scheduleOpen&&<View style={s.tripSummary}>
                  <Text style={s.label}>موعد تذكير المشوار</Text>
                  <Text style={s.caption}>وفق توقيت الهاتف؛ ستراجع المشوار وتؤكد طلبه بنفسك.</Text>
                  <Field label="التاريخ والساعة (24 ساعة)" value={scheduleDate} onChangeText={setScheduleDate}
                    placeholder="2026-12-01 08:30" maxLength={16}/>
                  <Button disabled={busy} onPress={()=>run(saveSchedule)}>حفظ الموعد</Button>
                </View>}
              </View>
            )}

            {profile.role==='driver' && tab==='home' && (
              <View style={s.card}>
                <View style={s.optionRow}><View style={{flex:1}}><Text style={s.title}>العمل اليوم</Text><Text style={s.caption}>{driver?.approved?(driver.online?'متاح لاستقبال الطلبات':'غير متاح الآن'):'أكمل التسجيل والاعتماد'}</Text></View>
                  <Ionicons name={driver?.online?'radio-button-on':'radio-button-off'} size={32} color={driver?.online?G:theme.muted}/></View>
                {driver?.approved?<Button disabled={busy||!!activeRide} secondary={driver.online} onPress={()=>act(toggleAvailability)}>{driver.online?'إيقاف استقبال الطلبات':'بدء استقبال الطلبات'}</Button>:<Button onPress={()=>D('account')}>إكمال حساب الكابتن</Button>}
                {driver?.approved&&driver.online&&!activeRide&&<><Text style={s.caption}>{availabilityBackground?'ظهور المركبة في الخلفية مفعّل':'للوصول إليك بطلبات قريبة بعد إغلاق التطبيق، فعّل ظهور الخلفية بالإضافة إلى إشعارات الهاتف.'}</Text>
                  <Button secondary disabled={busy} onPress={()=>run(availabilityBackground?async()=>{await stopAvailableBackground();setAvailabilityBackground(false);}:enableAvailableBackground)}>{availabilityBackground?'إيقاف ظهور الخلفية':'تفعيل ظهور الخلفية'}</Button></>}
                <Text style={s.caption}>الرحلات المكتملة ضمن آخر 50 رحلة</Text>
                <Text style={s.fare}>{trips.filter(t=>t.status==='completed'&&t.driver_id===userId).length} رحلة</Text>
                <Button secondary onPress={()=>D('earnings')}>عرض الأرباح اليومية والأسبوعية والشهرية</Button>
              </View>
            )}
            {profile.role==='driver' && tab==='account' && (
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

            {tab==='trips'&&<View style={s.filterRow}>
              {[['active','النشطة'],['completed','المكتملة'],['cancelled','الملغاة'],['all','الكل']].map(([key,label])=>
                <Button key={key} secondary={tripFilter!==key} onPress={()=>{setTripFilter(key);setFocusedRide(null);setExpandedTrip(null);setTripPage(1);}}>{label}</Button>)}
            </View>}
            {!visibleTrips.length && <View style={s.emptyState}>
              <Ionicons name="car-outline" size={34} color={theme.muted}/>
              <Text style={s.label}>لا توجد رحلات في هذه القائمة</Text>
              <Text style={s.caption}>ستظهر الرحلات هنا عند توفرها.</Text>
            </View>}
            {pagedTrips.map(t=>(
              <View key={t.id} style={s.rideCard}>
                <View style={s.rideCardTop}>
                  <Text style={t.status==='cancelled'?s.pendingBadge:s.badge}>{states[t.status]||t.status}</Text>
                  <Text style={s.fare}>{t.agreed_fare??t.proposed_fare} ج.س</Text>
                </View>
                <Text style={s.rideRoute}>{t.pickup} ← {t.destination}</Text>
                <Text style={s.caption}>{t.created_at?new Date(t.created_at).toLocaleString('ar-SD'):''}</Text>
                <Button secondary onPress={()=>setExpandedTrip(current=>current===t.id?null:t.id)}>
                  {expandedTrip===t.id?'إخفاء التفاصيل':'عرض التفاصيل'}
                </Button>
                {expandedTrip===t.id && <>
                  {(t.passenger_id===userId||t.driver_id===userId)&&<Button secondary onPress={()=>openSupport(t.id)}>إبلاغ عن مشكلة</Button>}
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
                        {[1,2,3,4,5].map(n=><TouchableOpacity key={n} accessibilityRole="button" accessibilityLabel={n+' من 5 نجوم'} accessibilityState={{selected:ratingDraft[t.id]===n}} style={{minWidth:44,minHeight:44,alignItems:'center',justifyContent:'center'}} onPress={()=>RD(v=>({...v,[t.id]:n}))}><Ionicons name={(ratingDraft[t.id]||0)>=n?'star':'star-outline'} size={25} color={(ratingDraft[t.id]||0)>=n?'#D5AC53':'#B8C2BA'}/></TouchableOpacity>)}
                      </View>
                      <Button disabled={busy||!ratingDraft[t.id]} onPress={()=>act(async()=>{check(await db.from('ratings').insert({ride_id:t.id,passenger_id:session.user.id,score:ratingDraft[t.id]}));RR(v=>[...v,t.id]);})}>إرسال التقييم</Button>
                    </View>
                  )}
                  {profile.role==='passenger' && t.status==='completed' && ratedRides.includes(t.id) && <Text style={s.success}>شكراً لتقييمك لهذه الرحلة</Text>}
                  {profile.role==='driver' && driver?.approved && t.status==='requested' && <>
                    <Field label="عرضك بالجنيه" value={bid[t.id]||''} onChangeText={v=>J(prev=>({...prev,[t.id]:v}))} keyboardType="numeric"/>
                    <Button disabled={busy} onPress={()=>act(async()=>{
                      const fare=parseFare(bid[t.id]?.trim()?bid[t.id]:t.proposed_fare);
                      if(!Number.isFinite(fare)||fare<=0)throw Error('السعر غير صحيح');
                      await rpc('submit_offer',{p_ride:t.id,p_fare:fare});
                    })}>إرسال العرض</Button>
                  </>}
                  {profile.role==='passenger' && t.status==='requested' &&
                    offers.filter(o=>o.ride_id===t.id).sort((a,b)=>Number(a.fare)-Number(b.fare)).map((o,index)=>(
                      <View key={o.id} style={s.offer}>
                        <View style={s.optionRow}><View style={{flex:1}}><Text style={s.label}>عرض {index+1}{index===0?' • أقل سعر':''}</Text><Text style={s.caption}>اختر العرض المناسب. تظهر بيانات الكابتن بعد قبول العرض.</Text></View><Text style={s.fare}>{o.fare} ج.س</Text></View>
                        <Button disabled={busy} onPress={()=>act(()=>rpc('accept_offer',{p_offer:o.id,p_expected_fare:o.fare}))}>قبول العرض</Button>
                      </View>
                    ))}
                  {profile.role==='driver' && t.driver_id===session.user.id && t.id!==activeRide?.id && activeStates.includes(t.status) &&
                    <Button disabled={busy} onPress={()=>act(()=>advanceActiveRide(t))}>
                      {t.status==='accepted'?'وصلت للموقع':t.status==='arrived'?'بدء الرحلة':'إنهاء الرحلة'}
                    </Button>}
                  {profile.role==='passenger' && t.status==='requested' && t.id!==activeRide?.id &&
                    <Button secondary disabled={busy} onPress={()=>act(()=>rpc('advance_ride',{p_ride:t.id,p_status:'cancelled'}))}>إلغاء الطلب</Button>}
                </>}
              </View>
            ))}
            {pagedTrips.length<visibleTrips.length&&<Button secondary onPress={()=>setTripPage(page=>page+1)}>تحميل المزيد من الرحلات</Button>}
            </>}
          </>
        ):null}

        <Text style={s.footer}>ARKAB • v1.0.0</Text>
      </ScrollView>
      {!!session && !!profile && <TabBar tab={tab} isDriver={profile.role==='driver'}
        onChange={key=>{D(key);if(key==='trips'||key==='notifications')refresh();}}/>}
      <Modal visible={!!selectedNearbyDriver} transparent animationType="slide"
        onRequestClose={()=>setSelectedNearbyDriver(null)}>
        <View style={s.driverModalBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button"
            accessibilityLabel="إغلاق بيانات الكابتن" onPress={()=>setSelectedNearbyDriver(null)}/>
          {!!selectedNearbyDriver&&<View style={s.driverModalCard}>
            <View style={s.driverModalHandle}/>
            <View style={s.optionRow}>
              <Text style={[s.title,{flex:1}]}>بيانات الكابتن القريب</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="إغلاق" style={s.iconButton}
                onPress={()=>setSelectedNearbyDriver(null)}>
                <Ionicons name="close" size={22} color={theme.ink}/>
              </Pressable>
            </View>
            <View style={s.driverCard}>
              {selectedNearbyDriver.avatar_url
                ? <Image source={{uri:selectedNearbyDriver.avatar_url}} style={s.driverAvatar}/>
                : <View style={s.driverAvatarFallback}><MaterialCommunityIcons name="account" size={30} color="#FFFFFF"/></View>}
              <View style={{flex:1,gap:4}}>
                <Text style={s.label}>{selectedNearbyDriver.full_name||'كابتن أركب'}</Text>
                <Text style={s.caption}>{selectedNearbyDriver.kind==='rickshaw'?'ركشة':'تكتك نقل'}</Text>
                <Text style={s.caption}>على بُعد نحو {Number(selectedNearbyDriver.distance_km||0).toLocaleString('ar-SD',{minimumFractionDigits:1,maximumFractionDigits:1})} كم</Text>
              </View>
              <View style={s.driverAvailableBadge}><View style={s.driverAvailableDot}/><Text style={s.driverAvailableText}>متاح</Text></View>
            </View>
            <Text style={s.caption}>موقع المركبة تقريبي ويتحدث تلقائياً. رقم الهاتف ورقم اللوحة يظهران بعد قبول الرحلة حفاظاً على خصوصية الكابتن.</Text>
            <Button onPress={()=>{V(selectedNearbyDriver.kind);setSelectedNearbyDriver(null);}}>اختيار {selectedNearbyDriver.kind==='rickshaw'?'الركشة':'تكتك النقل'}</Button>
            <Button secondary onPress={()=>setSelectedNearbyDriver(null)}>إغلاق</Button>
          </View>}
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function BiometricLockScreen({gate,hasEmail}){
  const [showPassword,setShowPassword]=useState(false);
  const [password,setPassword]=useState('');
  const working=gate.phase==='checking'||gate.busy;
  const submit=async()=>{if(!password)return;const candidate=password;setPassword('');await gate.unlockPassword(candidate);};
  return <SafeAreaView style={s.safe}>
    <StatusBar barStyle="dark-content" backgroundColor={theme.background}/>
    <ScrollView contentContainerStyle={s.lockPage} keyboardShouldPersistTaps="handled">
      <Image source={require('./assets/logo.png')} style={s.lockLogo} accessibilityLabel="شعار أركب"/>
      <View style={s.lockBadge}><Ionicons name="finger-print-outline" size={55} color={G}/></View>
      <Text style={[s.title,{textAlign:'center'}]}>أركب | حسابك محمي</Text>
      <Text style={[s.body,{textAlign:'center'}]}>{gate.phase==='checking'?'جارٍ التحقق من إعدادات الأمان…':gate.enabled===null?'يلزم التحقق بكلمة مرور الحساب.':'افتح التطبيق بالبصمة أو كلمة مرور حسابك.'}</Text>
      {working&&<ActivityIndicator color={G}/>}
      {!!gate.error&&<Text style={s.error}>{gate.error}</Text>}
      {gate.phase!=='checking'&&<>
        {gate.enabled===true&&<Button disabled={working} onPress={gate.unlock}>فتح بالبصمة</Button>}
        {hasEmail?<Button secondary disabled={working} onPress={()=>{setPassword('');setShowPassword(v=>!v);}}>{showPassword?'إخفاء كلمة المرور':'استخدام كلمة مرور الحساب'}</Button>:
          <Text style={s.caption}>حسابك لا يحتوي على بريد إلكتروني. استخدم البصمة المسجلة على الهاتف أو تواصل مع الدعم لاستعادة الوصول.</Text>}
        {hasEmail&&showPassword&&<View style={s.card}>
          <Field label="كلمة مرور حسابك" value={password} onChangeText={setPassword} secure/>
          <Button disabled={working||!password} onPress={submit}>فتح الحساب بكلمة المرور</Button>
        </View>}
      </>}
      <Text style={[s.caption,{textAlign:'center'}]}>البصمة خيار محلي على هذا الهاتف، ولا تغيّر حسابك أو توقف تتبع الرحلة المصرّح به.</Text>
    </ScrollView>
  </SafeAreaView>;
}

function money(value){return Number.isFinite(Number(value))?Number(value).toLocaleString('ar-SD',{maximumFractionDigits:2})+' ج.س':'—';}
function EarningsPanel({summary,period,onPeriod,onBack}){
  const data=summary.data;
  return <View style={s.card}>
    <Text style={s.title}>لوحة أرباح الكابتن</Text>
    <Text style={s.caption}>حسب وقت إكمال الرحلة بتوقيت السودان؛ المبالغ المتفق عليها وليست إثباتاً للتحصيل النقدي.</Text>
    <View style={s.row}>{[['day','اليوم'],['week','هذا الأسبوع'],['month','هذا الشهر']].map(([key,label])=><Button key={key} secondary={period!==key} onPress={()=>onPeriod(key)}>{label}</Button>)}</View>
    {summary.status==='loading'&&<ActivityIndicator color={G}/>}
    {data&&<><View style={s.earningsHero}><Text style={[s.caption,{color:'#E6F1E9'}]}>إجمالي الأجرة المتفق عليها</Text><Text style={s.earningsTotal}>{money(data.gross)}</Text><Text style={{color:'#E6F1E9',textAlign:'right'}}>{data.ride_count} رحلة مكتملة</Text></View>
      <View style={s.row}><View style={s.metric}><Text style={s.caption}>متوسط الأجرة</Text><Text style={s.label}>{data.ride_count-data.missing_fare_count>0?money(Number(data.gross)/(data.ride_count-data.missing_fare_count)):'—'}</Text></View><View style={s.metric}><Text style={s.caption}>عمولات مسجلة</Text><Text style={s.label}>{money(data.commission_recorded)}</Text></View></View>
      {data.ride_count>0&&Number(data.missing_fare_count)===0&&Number(data.missing_commission_count)===0&&<View style={s.tripSummary}><Text style={s.label}>صافي الأرباح المحسوب بعد العمولات</Text><Text style={s.fare}>{money(Number(data.gross)-Number(data.commission_recorded))}</Text><Text style={s.caption}>مبالغ حسابية وليست إثباتاً للتحصيل أو التحويل.</Text></View>}
      {data.missing_fare_count>0&&<Text style={s.caption}>عدد رحلات بدون قيمة أجرة موثقة: {data.missing_fare_count}</Text>}
      {data.missing_commission_count>0&&<Text style={s.caption}>العمولة غير موثقة في {data.missing_commission_count} رحلة؛ لا يتم تقدير صافي الأرباح منها.</Text>}
      {data.legacy_count>0&&<View style={s.tripSummary}><Text style={s.label}>رحلات سابقة بلا تاريخ إكمال</Text><Text style={s.body}>{data.legacy_count} رحلة • {money(data.legacy_gross)}</Text><Text style={s.caption}>غير مدرجة في فترات اليوم والأسبوع والشهر.</Text></View>}
    </>}
    {summary.status==='error'&&<Text style={s.error}>تعذر تحميل الأرباح. تأكد من الاتصال أو تفعيل ميزة الأرباح من الإدارة.</Text>}
    <Button secondary onPress={summary.refresh}>تحديث الأرباح</Button><Button secondary onPress={onBack}>العودة للحساب</Button>
  </View>;
}

function PrivacyPanel({db,userId,onBack}){
  const [record,setRecord]=useState(null),[phase,setPhase]=useState('loading'),[posting,setPosting]=useState(false);
  const [error,setError]=useState('');const alive=useRef(true),pending=useRef(false);
  async function load(){
    setPhase('loading');setError('');
    try{const data=await readDeletionRequest(db,userId);if(alive.current){setRecord(data);setPhase('ready');}}
    catch{if(alive.current){setPhase('error');setError('تعذر التحقق من حالة طلبك. حاول مجدداً.');}}
  }
  useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;};},[userId]);
  async function send(){
    if(pending.current||record)return;pending.current=true;setPosting(true);setError('');
    try{const data=await submitDeletionRequest(db,userId);if(alive.current){setRecord(data);setPhase('ready');}}
    catch{if(alive.current)setError('لم نستطع تأكيد تسجيل الطلب. تحقق من الاتصال ثم حاول مرة أخرى.');}
    finally{pending.current=false;if(alive.current)setPosting(false);}
  }
  function confirm(){
    Alert.alert('طلب حذف الحساب','سيُرسل طلب حذف حسابك والبيانات المرتبطة به إلى إدارة أركب للمراجعة. هذا ليس حذفاً فورياً. يرجى إنهاء الرحلة النشطة قبل إتمام الحذف.',[
      {text:'إلغاء',style:'cancel'},{text:'إرسال الطلب',style:'destructive',onPress:()=>void send()}
    ],{cancelable:true});
  }
  return <View style={s.card}>
    <Text style={s.title}>الخصوصية وحذف الحساب</Text>
    <Text style={s.body}>يجمع أركب بيانات الحساب والموقع والرحلات لتقديم خدمة النقل. تستطيع إيقاف مشاركة موقعك، وتعديل أذونات الهاتف من الإعدادات، والتواصل مع الدعم بشأن بياناتك.</Text>
    <Text style={s.caption}>البصمة اختيارية وتظل ضمن نظام الهاتف. لا يرسل التطبيق بيانات بصمتك إلى الخادم.</Text>
    <View style={s.tripSummary}><Text style={s.label}>طلب حذف الحساب والبيانات المرتبطة به</Text>
      <Text style={s.caption}>يتم تسجيل طلبك لمراجعته من الإدارة؛ لا يعني التسجيل أن الحساب حُذف بالفعل. قد توجد رحلة نشطة أو بيانات مشتركة تحتاج إلى معالجة.</Text>
      {phase==='loading'&&<ActivityIndicator color={G}/>}
      {record&&<><Text style={s.label}>{record.status==='reviewing'?'الطلب قيد المراجعة':'تم تسجيل طلب الحذف'}</Text><Text style={s.body}>تاريخ الطلب: {new Date(record.requested_at).toLocaleString('ar-SD')}</Text></>}
      {phase==='ready'&&!record&&<Button secondary disabled={posting} onPress={confirm}>{posting?'جارٍ إرسال الطلب…':'طلب حذف الحساب'}</Button>}
      {!!error&&<Text style={s.error}>{error}</Text>}
      {phase==='error'&&<Button secondary onPress={load}>إعادة المحاولة</Button>}
    </View>
    <Button secondary onPress={onBack}>العودة للحساب</Button>
  </View>;
}

function SupportPanel({db,userId,rideId,onBack}){
  const [category,setCategory]=useState('ride');
  const [body,setBody]=useState('');const [selectedRide,setSelectedRide]=useState(rideId);
  const [posting,setPosting]=useState(false);const pending=useRef(false);const ticketDraft=useRef(null);
  const [message,setMessage]=useState('');const [failure,setFailure]=useState('');
  const tickets=useSupportTickets(db,userId,true);
  useEffect(()=>{setSelectedRide(rideId);},[rideId]);
  async function submit(){
    if(pending.current||!validateTicket(category,body))return;
    pending.current=true;setPosting(true);setFailure('');setMessage('');
    try{
      const values={user_id:userId,ride_id:selectedRide||null,category,body:body.trim()};
      const fingerprint=JSON.stringify(values);
      if(ticketDraft.current?.fingerprint!==fingerprint)ticketDraft.current={fingerprint,id:Crypto.randomUUID()};
      const id=ticketDraft.current.id;
      const {error}=await db.from('complaints').insert({...values,id});
      if(error){
        if(error.code!=='23505')throw error;
        const existing=await db.from('complaints').select('id,ride_id,category,body').eq('id',id).eq('user_id',userId).maybeSingle();
        if(existing.error||!existing.data||existing.data.ride_id!==values.ride_id||existing.data.category!==category||existing.data.body!==values.body)throw error;
      }
      ticketDraft.current=null;
      setBody('');setSelectedRide(null);setMessage('تم إرسال طلبك للدعم. يمكنك متابعة حالته أدناه.');await tickets.refresh();
    }catch{setFailure('تعذر إرسال الطلب. تحقق من الاتصال وحاول مرة أخرى.');}
    finally{pending.current=false;setPosting(false);}
  }
  return <View style={s.card}>
    <Text style={s.title}>الدعم الفني والشكاوى</Text><Text style={s.caption}>اختر نوع المشكلة واكتب التفاصيل. لا تدرج كلمات المرور أو أرقاماً حساسة في الطلب.</Text>
    <View style={s.row}>{Object.entries(supportCategories).map(([key,label])=><Button key={key} secondary={category!==key} disabled={posting} onPress={()=>setCategory(key)}>{label}</Button>)}</View>
    {selectedRide&&<View style={s.tripSummary}><Text style={s.caption}>الطلب مرتبط بالرحلة {selectedRide.slice(0,8)}</Text><Button secondary disabled={posting} onPress={()=>setSelectedRide(null)}>إرسال شكوى عامة بدلاً من ذلك</Button></View>}
    <Text style={s.label}>وصف المشكلة</Text><TextInput accessibilityLabel="وصف المشكلة" style={[s.input,{minHeight:110,textAlignVertical:'top'}]} multiline value={body} maxLength={1500} onChangeText={setBody} placeholder="اكتب تفاصيل طلبك..."/>
    <Text style={s.caption}>{body.length}/1500</Text><Button disabled={posting||!validateTicket(category,body)} onPress={submit}>{posting?'جارٍ الإرسال…':'إرسال طلب الدعم'}</Button>
    {!!failure&&<Text style={s.error}>{failure}</Text>}{!!message&&<Text style={s.success}>{message}</Text>}
    <Text style={s.title}>طلباتي السابقة</Text>
    {tickets.status==='loading'&&<ActivityIndicator color={G}/>}
    {tickets.status==='error'&&<Text style={s.error}>تعذر تحميل طلبات الدعم. حاول التحديث مرة أخرى.</Text>}
    {tickets.status==='ready'&&!tickets.data?.length&&<Text style={s.caption}>لا توجد طلبات دعم حتى الآن.</Text>}
    {(tickets.data||[]).map(t=><View key={t.id} style={s.tripSummary}>
      <Text style={s.badge}>{supportStatuses[t.status]||'قيد المراجعة'}</Text><Text style={s.label}>{supportCategories[t.category]||'أخرى'} • #{t.id.slice(0,8)}</Text>
      <Text style={s.body}>{t.body}</Text><Text style={s.caption}>{new Date(t.created_at).toLocaleString('ar-SD')}</Text>
      {!!t.reply&&<View style={s.chatOther}><Text style={s.label}>رد الدعم الفني</Text><Text style={s.body}>{t.reply}</Text></View>}
    </View>)}
    <Button secondary onPress={tickets.refresh}>تحديث الطلبات</Button><Button secondary onPress={onBack}>العودة للحساب</Button>
    <Text style={s.caption}>هذا النظام ليس خدمة طوارئ فورية. في الحالات العاجلة اتصل بجهة موثوقة مباشرة.</Text>
  </View>;
}

function RideProgress({status}){
  const steps=[['requested','الطلب'],['accepted','الاتفاق'],['arrived','الوصول'],['in_progress','الرحلة'],['completed','تمت']];
  const active=steps.findIndex(([key])=>key===status);
  return <View style={s.progressRow} accessibilityLabel={'مرحلة الرحلة: '+(states[status]||status)}>
    {steps.map(([key,label],i)=><View key={key} style={s.progressItem}><View style={[s.progressDot,i<=active&&{backgroundColor:G}]}>{i<active?<Ionicons name="checkmark" size={14} color="#fff"/>:<Text style={{color:i<=active?'#fff':theme.muted,fontSize:12}}>{i+1}</Text>}</View><Text style={[s.caption,{fontSize:11,textAlign:'center',color:i===active?G:theme.muted}]}>{label}</Text></View>)}
  </View>;
}
export default function App(){
  const [fontsLoaded]=useFonts({Cairo_400Regular,Cairo_700Bold});
  const [intro,setIntro] = useState(true);
  const finishIntro = useCallback(()=>setIntro(false),[]);
  return (
    <SafeAreaProvider>
      <View style={{flex:1,backgroundColor:G}}>
        <FontContext.Provider value={fontsLoaded}><Main/></FontContext.Provider>
        {intro&&<SplashIntro onFinish={finishIntro}/>}
      </View>
    </SafeAreaProvider>
  );
}

const s=StyleSheet.create({
  safe:{flex:1,backgroundColor:theme.background},
  lockPage:{flexGrow:1,justifyContent:'center',padding:24,gap:16},
  lockLogo:{width:84,height:84,resizeMode:'contain',borderRadius:20,alignSelf:'center'},
  lockBadge:{width:100,height:100,borderRadius:50,backgroundColor:theme.soft,alignSelf:'center',alignItems:'center',justifyContent:'center',borderWidth:1,borderColor:theme.border},
  page:{padding:16,gap:14,paddingBottom:26},
  fixedHeader:{backgroundColor:theme.deep,paddingVertical:13,paddingHorizontal:18,
    flexDirection:'row-reverse',alignItems:'center',justifyContent:'space-between',gap:12,
    borderBottomWidth:1,borderBottomColor:'#1E5B45'},
  headerBrand:{flex:1,flexDirection:'row-reverse',alignItems:'center',gap:12},
  logo:{width:44,height:44,borderRadius:14,resizeMode:'contain',backgroundColor:theme.surface},
  brand:{color:theme.surface,fontSize:21,fontWeight:'900',textAlign:'right'},
  muted:{color:'#DDEBE4',fontSize:11,textAlign:'right'},
  headerAction:{width:46,height:46,borderRadius:16,backgroundColor:'#1C5A43',alignItems:'center',justifyContent:'center',borderWidth:1,borderColor:'#36765C'},
  headerActionText:{color:theme.surface,fontWeight:'700',fontSize:12},
  welcome:{flexDirection:'row-reverse',alignItems:'center',gap:12,paddingVertical:7},
  eyebrow:{color:G,fontWeight:'700',fontSize:13,textAlign:'right'},
  brandBadge:{width:52,height:52,borderRadius:18,backgroundColor:theme.warning,justifyContent:'center',alignItems:'center',borderWidth:1,borderColor:'#E9D9A8'},
  card:{backgroundColor:theme.surface,padding:16,gap:12,borderRadius:20,
    borderWidth:1,borderColor:theme.border,shadowColor:'#123B2C',shadowOpacity:0.045,shadowRadius:12,shadowOffset:{width:0,height:4},elevation:2},
  title:{color:theme.ink,fontSize:21,fontWeight:'800',textAlign:'right',lineHeight:30},
  label:{color:theme.ink,fontSize:14,fontWeight:'700',textAlign:'right'},
  body:{color:theme.muted,fontSize:14,textAlign:'right',lineHeight:22},
  caption:{color:theme.muted,fontSize:12,textAlign:'right',lineHeight:18},
  input:{backgroundColor:theme.surface,borderRadius:14,paddingHorizontal:15,paddingVertical:12,minHeight:54,textAlign:'right',
    color:theme.ink,fontSize:15,borderWidth:1,borderColor:theme.border},
  button:{backgroundColor:G,paddingHorizontal:16,paddingVertical:13,minHeight:50,borderRadius:14,alignItems:'center',justifyContent:'center',flexGrow:1},
  secondary:{backgroundColor:theme.soft,borderWidth:1,borderColor:theme.border},
  buttonText:{color:theme.surface,fontWeight:'700',fontSize:15,textAlign:'center'},
  secondaryText:{color:G},
  row:{flexDirection:'row-reverse',flexWrap:'wrap',gap:10},
  filterRow:{flexDirection:'row-reverse',flexWrap:'wrap',gap:7},
  mapBox:{borderRadius:20,overflow:'hidden',borderWidth:1,borderColor:theme.border},
  map:{width:'100%',height:315},
  mapControl:{position:'absolute',right:12,top:12,width:46,height:46,borderRadius:16,backgroundColor:'#FFFFFF',alignItems:'center',justifyContent:'center',elevation:3,shadowColor:'#000',shadowOpacity:0.1,shadowRadius:8,shadowOffset:{width:0,height:2}},
  mapError:{position:'absolute',left:12,right:12,bottom:35,padding:12,borderRadius:12,backgroundColor:theme.surface,gap:8},
  driverModalBackdrop:{flex:1,justifyContent:'flex-end',backgroundColor:'rgba(7,20,15,0.48)'},
  driverModalCard:{backgroundColor:theme.surface,borderTopLeftRadius:26,borderTopRightRadius:26,padding:20,paddingBottom:28,gap:14,borderWidth:1,borderColor:theme.border},
  driverModalHandle:{width:44,height:5,borderRadius:3,backgroundColor:theme.border,alignSelf:'center',marginBottom:2},
  driverAvailableBadge:{flexDirection:'row-reverse',alignItems:'center',gap:5,paddingHorizontal:9,paddingVertical:6,borderRadius:12,backgroundColor:'#E7F5EC'},
  driverAvailableDot:{width:7,height:7,borderRadius:4,backgroundColor:'#16834B'},
  driverAvailableText:{fontSize:11,fontWeight:'800',color:'#16834B'},
  iconButton:{minWidth:46,minHeight:46,alignItems:'center',justifyContent:'center',borderRadius:14,backgroundColor:theme.soft},
  syncBanner:{flexDirection:'row-reverse',alignItems:'center',gap:10,backgroundColor:theme.warning,borderRadius:16,padding:12,borderWidth:1,borderColor:'#F0DDA9'},
  optionRow:{flexDirection:'row-reverse',alignItems:'center',gap:10,minHeight:46},
  detailRow:{flexDirection:'row-reverse',alignItems:'center',gap:9,minHeight:28},
  detailText:{flex:1},
  progressRow:{flexDirection:'row-reverse',justifyContent:'space-between',gap:2},
  progressItem:{flex:1,alignItems:'center',gap:5},
  progressDot:{width:26,height:26,borderRadius:13,backgroundColor:theme.border,alignItems:'center',justifyContent:'center'},
  attribution:{color:theme.muted,fontSize:10,padding:5,backgroundColor:theme.surface},
  pinWrap:{position:'relative',alignItems:'center',justifyContent:'center'},
  pin:{width:38,height:38,borderRadius:19,alignItems:'center',justifyContent:'center',borderWidth:2,borderColor:theme.surface,elevation:4,shadowColor:'#000',shadowOpacity:0.18,shadowRadius:5,shadowOffset:{width:0,height:2}},
  pinCount:{position:'absolute',top:-7,right:-8,minWidth:18,height:18,paddingHorizontal:4,borderRadius:9,backgroundColor:theme.deep,alignItems:'center',justifyContent:'center',borderWidth:1,borderColor:'#FFFFFF'},
  pinCountText:{color:'#FFFFFF',fontSize:10,fontWeight:'800'},
  fare:{fontSize:19,color:G,fontWeight:'800',textAlign:'right'},
  rideCard:{backgroundColor:theme.surface,padding:14,borderRadius:18,borderWidth:1,borderColor:theme.border,gap:9,shadowColor:'#123B2C',shadowOpacity:0.035,shadowRadius:8,shadowOffset:{width:0,height:3},elevation:1},
  rideCardTop:{flexDirection:'row-reverse',alignItems:'center',justifyContent:'space-between',gap:10},
  rideRoute:{fontSize:16,color:theme.ink,fontWeight:'800',textAlign:'right',lineHeight:24},
  emptyState:{alignItems:'center',justifyContent:'center',gap:8,paddingVertical:30,paddingHorizontal:18,backgroundColor:theme.surface,borderRadius:18,borderWidth:1,borderColor:theme.border},
  tripSummary:{backgroundColor:theme.soft,padding:12,borderRadius:theme.radius.md,gap:8},
  driverCard:{flexDirection:'row-reverse',alignItems:'center',gap:12,backgroundColor:theme.background,padding:12,borderRadius:theme.radius.md},
  driverAvatar:{width:58,height:58,borderRadius:29},
  avatarPreview:{width:112,height:112,borderRadius:56,alignSelf:'center',borderWidth:3,borderColor:Y},
  avatarEmpty:{minHeight:76,alignItems:'center',justifyContent:'center',backgroundColor:theme.soft,borderRadius:theme.radius.md},
  driverAvatarFallback:{width:58,height:58,borderRadius:29,backgroundColor:G,alignItems:'center',justifyContent:'center'},
  driverInitial:{color:Y,fontSize:26,fontWeight:'bold'},
  earningsHero:{padding:20,borderRadius:18,backgroundColor:theme.deep,gap:10},
  earningsTotal:{fontSize:32,fontWeight:'900',color:theme.gold,textAlign:'right'},
  metric:{flex:1,minWidth:130,padding:14,borderRadius:14,backgroundColor:theme.soft,gap:8},
  driverStats:{padding:14,gap:8,borderRadius:theme.radius.md,backgroundColor:theme.soft},
  rateBox:{padding:12,backgroundColor:theme.background,borderRadius:theme.radius.md,gap:8},
  offer:{gap:8,padding:12,backgroundColor:theme.soft,borderRadius:theme.radius.sm},
  error:{color:theme.danger,backgroundColor:'#FCE8E6',padding:12,borderRadius:10,textAlign:'right'},
  success:{color:G,backgroundColor:theme.soft,padding:12,borderRadius:10,textAlign:'right'},
  footer:{textAlign:'center',color:theme.muted,fontSize:12},
  tabBar:{flexDirection:'row-reverse',paddingHorizontal:10,paddingTop:9,paddingBottom:8,backgroundColor:theme.surface,borderTopWidth:1,borderColor:theme.border,gap:4,elevation:12,shadowColor:'#102D22',shadowOpacity:0.06,shadowRadius:10,shadowOffset:{width:0,height:-3}},
  tabItem:{flex:1,minHeight:58,paddingVertical:7,paddingHorizontal:3,alignItems:'center',justifyContent:'center',gap:4,borderRadius:16},
  tabActive:{backgroundColor:theme.soft},
  tabIcon:{color:theme.muted,fontSize:23,fontWeight:'700',lineHeight:27},
  tabLabel:{color:theme.muted,fontSize:10,fontWeight:'600',textAlign:'center'},
  tabSelected:{color:G,fontWeight:'800'},
  vehicleChoice:{flex:1,minWidth:120,backgroundColor:theme.surface,borderWidth:1,borderColor:theme.border,borderRadius:18,padding:14,gap:7},
  vehicleSelected:{borderColor:G,borderWidth:2,backgroundColor:theme.soft},
  vehicleTop:{flexDirection:'row-reverse',alignItems:'center',justifyContent:'space-between'},
  vehicleGlyph:{fontSize:34,color:G},
  radio:{width:20,height:20,borderRadius:10,borderWidth:1,borderColor:theme.muted,alignItems:'center',justifyContent:'center'},
  radioSelected:{borderColor:G,borderWidth:2},
  radioDot:{width:10,height:10,borderRadius:5,backgroundColor:G},
  badge:{alignSelf:'flex-end',color:G,backgroundColor:theme.soft,paddingHorizontal:11,paddingVertical:6,borderRadius:10,fontSize:11,fontWeight:'800',overflow:'hidden'},
  pendingBadge:{alignSelf:'flex-end',color:'#775717',backgroundColor:theme.warning,paddingHorizontal:11,paddingVertical:6,borderRadius:10,fontSize:11,fontWeight:'800',overflow:'hidden'},
  chatBubble:{maxWidth:'90%',padding:12,borderRadius:theme.radius.md,gap:3},
  chatMine:{alignSelf:'flex-end',backgroundColor:theme.soft},
  chatOther:{alignSelf:'flex-start',backgroundColor:theme.background,borderWidth:1,borderColor:theme.border},
  cargoPhoto:{width:'100%',height:160,borderRadius:theme.radius.sm,resizeMode:'contain'}
});
