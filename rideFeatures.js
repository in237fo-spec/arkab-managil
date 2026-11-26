import {useEffect, useRef, useState} from 'react';
import {AppState, Platform} from 'react-native';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import appConfig from './app.json';

export const coordinate = (lng,lat) => lng == null || lat == null ? null : [lng,lat];

export function estimateFare(pricing, kind, distance) {
  const rate = pricing.find(row => row.vehicle_kind === kind);
  if (!rate || distance == null) return null;
  const result = Number(rate.base_fare) + distance * Number(rate.per_km);
  return Number.isFinite(result) && result > 0 ? Math.ceil(result) : null;
}

export function useNearbyVehicles(db, userId, pickup) {
  const [result,setResult] = useState({rows:[],status:'idle',updatedAt:null});
  const [refreshTick,setRefreshTick]=useState(0);
  const [lng,lat] = pickup || [];
  useEffect(()=>{
    if (!userId || lat == null || lng == null) {
      setResult({rows:[],status:'idle'});
      return;
    }
    let cancelled = false;
    let pending = false;
    setResult({rows:[],status:'loading'});
    async function refresh() {
      if (pending || AppState.currentState !== 'active') return;
      pending = true;
      try {
        const {data,error} = await db.rpc('nearby_vehicles',{p_lat:lat,p_lng:lng});
        if (!cancelled) setResult(error ?
          {rows:[],status:'error'} : {rows:data || [],status:'ready',updatedAt:Date.now()});
      } catch {
        if (!cancelled) setResult({rows:[],status:'error'});
      } finally {
        pending = false;
      }
    }
    refresh();
    const timer = setInterval(refresh,20000);
    const listener = AppState.addEventListener('change',state=>{
      if (state === 'active') refresh();
    });
    return ()=>{cancelled = true; clearInterval(timer); listener.remove();};
  },[db,userId,lng,lat,refreshTick]);
  return {...result,refresh:()=>setRefreshTick(v=>v+1)};
}

export function useAvailableDriverLocation(db, userId, onError) {
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  useEffect(()=>{
    if (!userId) return;
    let stopped = false;
    let pending = false;
    async function send() {
      if (pending || stopped || AppState.currentState !== 'active') return;
      pending = true;
      try {
        if ((await Location.getForegroundPermissionsAsync()).status !== 'granted') return;
        const position = await Location.getLastKnownPositionAsync({maxAge:25000,requiredAccuracy:200})
          || await Location.getCurrentPositionAsync({accuracy:Location.Accuracy.Balanced});
        if (stopped || AppState.currentState !== 'active') return;
        const {error} = await db.from('driver_locations').upsert({
          driver_id:userId, latitude:position.coords.latitude, longitude:position.coords.longitude,
          updated_at:new Date(position.timestamp).toISOString()
        });
        if (error) throw error;
      } catch {
        if (!stopped) onErrorRef.current('تعذر تحديث موقع المركبة المتاحة');
      } finally {
        pending = false;
      }
    }
    send();
    const timer = setInterval(send,45000);
    const listener = AppState.addEventListener('change',state=>{
      if (state === 'active') send();
    });
    return ()=>{stopped = true; clearInterval(timer); listener.remove();};
  },[db,userId]);
}

const PUSH_CHANNEL = 'rides';
const projectId = appConfig.expo.extra.eas.projectId;

Notifications.setNotificationHandler({
  handleNotification: async ()=>({
    shouldShowBanner:true, shouldShowList:true, shouldPlaySound:true, shouldSetBadge:false
  })
});

async function acquirePushToken(requestPermission) {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(PUSH_CHANNEL,{
      name:'إشعارات الرحلات',
      importance:Notifications.AndroidImportance.HIGH,
      vibrationPattern:[0,250,200,250],lightColor:'#086B47',sound:'default',
      lockscreenVisibility:Notifications.AndroidNotificationVisibility.PRIVATE
    });
  }
  let permission = await Notifications.getPermissionsAsync();
  if (!permission.granted && requestPermission) permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) return null;
  return (await Notifications.getExpoPushTokenAsync({projectId})).data;
}

const PUSH_RECORD = 'arkab.push.enrollment.v2';
const rideUuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

async function storedEnrollment() {
  const raw=await SecureStore.getItemAsync(PUSH_RECORD);
  if(!raw)return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function useRidePush(db, userId, onOpen) {
  const openRef = useRef(onOpen);
  const identity = useRef(userId);
  identity.current = userId;
  openRef.current = onOpen;
  const [enabled,setEnabled] = useState(false);
  const [registrationError,setRegistrationError]=useState(false);
  const [checking,setChecking]=useState(true);
  const registration = useRef(null);
  const revoking = useRef(false);

  async function removeRecord(id,record) {
    if(record?.userId!==id)return;
    for(const value of record.tokens||[]) {
      const {error}=await db.rpc('set_push_device',{p_token:value,p_enabled:false});
      if(error)throw error;
    }
    await SecureStore.deleteItemAsync(PUSH_RECORD);
  }

  async function register(requestPermission) {
    const id=userId;
    if(!id||revoking.current)return false;
    if(registration.current) {
      const current=registration.current;
      const result=await current.promise.catch(()=>false);
      if(identity.current!==id||revoking.current)return false;
      if(current.id!==id)return register(requestPermission);
      if(!requestPermission||result)return result;
      return register(true);
    }
    const operation={id,promise:null};
    registration.current=operation;
    setChecking(true);
    operation.promise=(async()=>{
      const previous=await storedEnrollment();
      const value=await acquirePushToken(requestPermission);
      if(identity.current!==id||revoking.current)return false;
      if(!value) {
        await removeRecord(id,previous);
        if(identity.current===id){setEnabled(false);setRegistrationError(false);}
        return false;
      }
      // Persist before network enrollment so any subsequent logout can revoke the token.
      const known=previous?.userId===id?previous.tokens||[]:[];
      await SecureStore.setItemAsync(PUSH_RECORD,JSON.stringify({userId:id,tokens:[...new Set([...known,value])]}));
      if(identity.current!==id||revoking.current)return false;
      const {error}=await db.rpc('set_push_device',{p_token:value,p_enabled:true});
      if(error)throw error;
      for(const old of known.filter(t=>t!==value)){
        const result=await db.rpc('set_push_device',{p_token:old,p_enabled:false});
        if(result.error)throw result.error;
      }
      await SecureStore.setItemAsync(PUSH_RECORD,JSON.stringify({userId:id,tokens:[value]}));
      if(identity.current!==id||revoking.current)return false;
      setEnabled(true);setRegistrationError(false);
      return true;
    })();
    try{return await operation.promise;}
    catch(error){if(identity.current===id){setEnabled(false);setRegistrationError(true);}throw error;}
    finally{
      if(registration.current===operation)registration.current=null;
      if(identity.current===id)setChecking(false);
    }
  }

  useEffect(()=>{
    revoking.current=false;
    setEnabled(false);setRegistrationError(false);setChecking(!!userId);
    if(!userId)return;
    let stopped=false;
    const retry=()=>{if(!stopped&&!revoking.current)void register(false).catch(()=>{});};
    retry();
    const app=AppState.addEventListener('change',state=>{if(state==='active')retry();});
    const rotation=Notifications.addPushTokenListener(()=>retry());
    function open(response) {
      const data=response?.notification?.request?.content?.data;
      if(stopped||identity.current!==userId||typeof data?.rideId!=='string'||!rideUuid.test(data.rideId))return;
      openRef.current(data.rideId,data.event==='new_request'?'طلب مشوار قريب':null);
      void Notifications.clearLastNotificationResponseAsync().catch(()=>{});
    }
    const listener=Notifications.addNotificationResponseReceivedListener(open);
    void Notifications.getLastNotificationResponseAsync().then(open).catch(()=>{});
    return ()=>{stopped=true;listener.remove();app.remove();rotation.remove();};
  },[userId]);

  async function unregister() {
    revoking.current=true;
    try{
      if(registration.current)await registration.current.promise.catch(()=>{});
      await removeRecord(userId,await storedEnrollment());
      setEnabled(false);
      await Notifications.dismissAllNotificationsAsync().catch(()=>{});
      await Notifications.clearLastNotificationResponseAsync().catch(()=>{});
    }catch(error){revoking.current=false;throw error;}
  }
  return {enabled,registrationError,checking,enable:()=>register(true),unregister};
}
