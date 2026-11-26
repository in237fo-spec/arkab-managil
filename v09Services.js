import {useCallback,useEffect,useRef,useState} from 'react';
import {AppState} from 'react-native';
import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';
import * as TaskManager from 'expo-task-manager';

const SHARE_TASK='arkab-passenger-live-share-v09';
const SHARE_KEY='arkab.v09.passenger-live-share';
import {validToken,trackingViewer,makeTrackingLink,shareReady,activeShareRecord} from './v09Logic';
export {trackingViewer,makeTrackingLink,activeShareLink,shareReady,supportCategories,supportStatuses,validateTicket} from './v09Logic';

async function localShare(){
  try{const text=await SecureStore.getItemAsync(SHARE_KEY);return text?JSON.parse(text):null;}catch{return null;}
}
export async function stopNativeShare(){
  await SecureStore.deleteItemAsync(SHARE_KEY).catch(()=>{});
  if(await Location.hasStartedLocationUpdatesAsync(SHARE_TASK).catch(()=>false))await Location.stopLocationUpdatesAsync(SHARE_TASK).catch(()=>{});
}
async function publish(db,sample,state){
  if(!sample?.coords||!validToken(state?.token))return false;
  const {data,error}=await db.rpc('arkab_share_publish_v09',{p_ride:state.rideId,p_token:state.token,
    p_lat:sample.coords.latitude,p_lng:sample.coords.longitude,p_sample_at:new Date(sample.timestamp||Date.now()).toISOString()});
  if(error)throw error;return data===true;
}
export function registerPassengerShareTask(db){
  if(TaskManager.isTaskDefined(SHARE_TASK))return;
  TaskManager.defineTask(SHARE_TASK,async ({data,error})=>{
    if(error||!data?.locations?.length)return;
    try{
      const record=await localShare();
      if(!record||!validToken(record.token)||Date.parse(record.expiresAt)<=Date.now()){await stopNativeShare();return;}
      const session=await db.auth.getSession();if(session.error)return;
      if(session.data.session?.user.id!==record.userId){await stopNativeShare();return;}
      const sample=data.locations[data.locations.length-1];
      if(!(await publish(db,sample,record)))await stopNativeShare();
    }catch{ /* A temporary network failure should not stop the current share. */ }
  });
}
export async function beginPassengerShare(db,userId,rideId){
  if(!shareReady())throw Error('رابط صفحة التتبع لم يُفعّل بعد.');
  const fg=await Location.requestForegroundPermissionsAsync();
  if(fg.status!=='granted')throw Error('اسمح بالوصول إلى موقعك أولاً');
  const bg=await Location.requestBackgroundPermissionsAsync();
  if(bg.status!=='granted')throw Error('اسمح بالموقع في الخلفية حتى يستمر التتبع بعد إطفاء الشاشة');
  // Stop the previous local task before rotating the server-side link.
  await stopNativeShare();
  const sample=await Location.getLastKnownPositionAsync({maxAge:15000,requiredAccuracy:150})||
    await Location.getCurrentPositionAsync({accuracy:Location.Accuracy.Balanced});
  const {data,error}=await db.rpc('arkab_share_create_v09',{p_ride:rideId});
  if(error||!validToken(data?.token)||!data?.expires_at)throw Error('لم يتم إنشاء رابط التتبع. حاول لاحقاً.');
  const record={rideId,userId,token:data.token,expiresAt:data.expires_at};
  try{
    await SecureStore.setItemAsync(SHARE_KEY,JSON.stringify(record));
    if(!(await publish(db,sample,record)))throw Error('الرحلة غير متاحة للمشاركة');
    await Location.startLocationUpdatesAsync(SHARE_TASK,{
      accuracy:Location.Accuracy.Balanced,timeInterval:15000,distanceInterval:15,
      deferredUpdatesInterval:15000,pausesUpdatesAutomatically:false,
      foregroundService:{notificationTitle:'أركب | مشاركة موقعي',
        notificationBody:'تشارك موقعك مع من أرسلت إليه الرابط أثناء الرحلة',notificationColor:'#086B47',killServiceOnDestroy:false}
    });
    return record;
  }catch(e){
    await stopNativeShare();await db.rpc('arkab_share_revoke_v09',{p_ride:rideId}).catch(()=>{});throw e;
  }
}
export async function reconcilePassengerShare(userId,confirmedActiveRideId){
  const record=await localShare();
  if(record&&userId&&record.userId===userId&&record.rideId!==confirmedActiveRideId)await stopNativeShare();
}
export async function endPassengerShare(db,userId,rideId){
  const record=await localShare();
  if(record&&userId&&record.userId===userId)await stopNativeShare();
  if(rideId){
    const {error}=await db.rpc('arkab_share_revoke_v09',{p_ride:rideId});
    if(error)throw Error('توقف نشر موقعك على الجهاز. تعذر تأكيد إلغاء الرابط في الخادم؛ أعد المحاولة عند عودة الشبكة.');
  }
}
export function usePassengerShare(userId,rideId){
  const [record,setRecord]=useState(null);
  const refresh=useCallback(async()=>{
    const saved=await localShare();
    const running=await Location.hasStartedLocationUpdatesAsync(SHARE_TASK).catch(()=>false);
    const current=running?activeShareRecord(saved,userId,rideId):null;
    setRecord(current);
  },[userId,rideId]);
  useEffect(()=>{
    let active=true;setRecord(null);
    if(!userId||!rideId)return;
    const load=async()=>{const saved=await localShare();const running=await Location.hasStartedLocationUpdatesAsync(SHARE_TASK).catch(()=>false);
      if(active)setRecord(running?activeShareRecord(saved,userId,rideId):null);};
    void load();const t=setInterval(load,15000);
    const listener=AppState.addEventListener('change',state=>{if(state==='active')void load();});
    return()=>{active=false;clearInterval(t);listener.remove();};
  },[userId,rideId]);
  return {record,setRecord,refresh};
}

function useQueryState(loader,enabled,refreshKey,identity){
  const [state,setState]=useState({status:'idle',data:null});const seq=useRef(0);
  const refresh=useCallback(async()=>{
    const id=++seq.current;
    if(!enabled){setState({status:'idle',data:null,identity});return;}
    setState(prev=>({status:'loading',data:prev.identity===identity?prev.data:null,identity}));
    try{const data=await loader();if(seq.current===id)setState({status:'ready',data,identity});}
    catch{if(seq.current===id)setState(prev=>({status:'error',data:prev.identity===identity?prev.data:null,identity}));}
  },[loader,enabled,identity]);
  useEffect(()=>{void refresh();return()=>{seq.current++;};},[refresh,refreshKey]);
  return {...(state.identity===identity?state:{status:'loading',data:null}),refresh};
}
export function useEarnings(db,userId,period,enabled,refreshKey){
  const load=useCallback(async()=>{
    const {data,error}=await db.rpc('arkab_driver_earnings_v09',{p_period:period});
    if(error||!data)throw Error('earnings unavailable');
    return data;
  },[db,userId,period]);
  return useQueryState(load,!!userId&&enabled,refreshKey,userId+':'+period);
}
export function useSupportTickets(db,userId,enabled){
  const load=useCallback(async()=>{
    const {data,error}=await db.from('complaints').select('id,ride_id,category,body,status,reply,created_at,updated_at')
      .eq('user_id',userId).order('created_at',{ascending:false}).limit(100);
    if(error)throw error;return data||[];
  },[db,userId]);
  return useQueryState(load,!!userId&&enabled,0,userId);
}
