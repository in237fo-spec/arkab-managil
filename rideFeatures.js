import {useEffect, useRef, useState} from 'react';
import {AppState, Platform} from 'react-native';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import appConfig from './app.json';

export const coordinate = (lng,lat) => lng == null || lat == null ? null : [lng,lat];

export function estimateFare(pricing, kind, distance) {
  const rate = pricing.find(row => row.vehicle_kind === kind);
  if (!rate || distance == null) return null;
  const result = Number(rate.base_fare) + distance * Number(rate.per_km);
  return Number.isFinite(result) && result > 0 ? Math.ceil(result) : null;
}

export function useNearbyVehicles(db, userId, pickup) {
  const [result,setResult] = useState({rows:[],status:'idle'});
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
          {rows:[],status:'error'} : {rows:data || [],status:'ready'});
      } catch {
        if (!cancelled) setResult({rows:[],status:'error'});
      } finally {
        pending = false;
      }
    }
    refresh();
    const timer = setInterval(refresh,30000);
    const listener = AppState.addEventListener('change',state=>{
      if (state === 'active') refresh();
    });
    return ()=>{cancelled = true; clearInterval(timer); listener.remove();};
  },[db,userId,lng,lat]);
  return result;
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
      importance:Notifications.AndroidImportance.HIGH
    });
  }
  let permission = await Notifications.getPermissionsAsync();
  if (!permission.granted && requestPermission) permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) return null;
  return (await Notifications.getExpoPushTokenAsync({projectId})).data;
}

export function useRidePush(db, userId, onOpen) {
  const token = useRef(null);
  const openRef = useRef(onOpen);
  const identity = useRef(userId);
  identity.current = userId;
  openRef.current = onOpen;
  const [enabled,setEnabled] = useState(false);

  async function register(requestPermission) {
    const id = userId;
    const value = await acquirePushToken(requestPermission);
    if (!value || identity.current !== id || !id) return false;
    const {error} = await db.rpc('set_push_device',{p_token:value,p_enabled:true});
    if (error) throw error;
    if (identity.current !== id) return false;
    token.current = value;
    setEnabled(true);
    return true;
  }

  useEffect(()=>{
    token.current = null;
    setEnabled(false);
    if (!userId) return;
    void register(false).catch(()=>{});
    function open(response) {
      if (!response?.notification.request.content.data?.rideId) return;
      openRef.current(response.notification.request.content.data.rideId);
      void Notifications.clearLastNotificationResponseAsync().catch(()=>{});
    }
    const listener = Notifications.addNotificationResponseReceivedListener(open);
    void Notifications.getLastNotificationResponseAsync().then(open).catch(()=>{});
    return ()=>listener.remove();
  },[userId]);

  async function unregister() {
    if (!token.current) return;
    const {error} = await db.rpc('set_push_device',{p_token:token.current,p_enabled:false});
    if (error) throw error;
    token.current = null;
    setEnabled(false);
  }
  return {enabled, enable:()=>register(true), unregister};
}
