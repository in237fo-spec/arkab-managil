import {useEffect,useRef,useState} from 'react';
import {AppState} from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import {freshGate,gateAfterLoad,privateViewAllowed,gateOnBackground} from './biometricGateLogic';

const pref=owner=>'arkab.biometric.v1.'+owner;
const active=state=>state!=='background'&&state!=='inactive';
async function strongBiometricsAvailable(){
  try{
    const [hardware,enrolled,level]=await Promise.all([
      LocalAuthentication.hasHardwareAsync(),LocalAuthentication.isEnrolledAsync(),LocalAuthentication.getEnrolledLevelAsync()
    ]);
    return hardware&&enrolled&&level===LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG;
  }catch{return false;}
}
async function authenticateBiometrics(message){
  return LocalAuthentication.authenticateAsync({promptMessage:message,cancelLabel:'إلغاء',
    fallbackLabel:'',disableDeviceFallback:true,biometricsSecurityLevel:'strong',requireConfirmation:true});
}
function failureMessage(result){
  if(result?.error==='lockout')return 'تم إيقاف البصمة مؤقتاً من الهاتف. يمكنك فتح أركب بكلمة مرور حسابك.';
  if(['not_available','not_enrolled','passcode_not_set'].includes(result?.error))return 'البصمة غير متاحة أو غير مسجلة. استخدم كلمة مرور حسابك.';
  return 'لم يتم التحقق من البصمة. حاول مرة أخرى أو استخدم كلمة مرور الحساب.';
}
export function useBiometricGate(owner,reauthenticate){
  const [gate,setGate]=useState(()=>freshGate());
  const gateRef=useRef(gate);const ownerRef=useRef(owner);ownerRef.current=owner;
  const [foreground,setForeground]=useState(()=>active(AppState.currentState));
  const foregroundRef=useRef(foreground);
  const generation=useRef(0),recentAuth=useRef(null),prompt=useRef(false),operation=useRef(null),unlockedAt=useRef(0);
  const [busy,setBusy]=useState(false);
  const publish=next=>{gateRef.current=next;setGate(next);};
  const safe=(id,gen)=>ownerRef.current===id&&generation.current===gen;
  const patch=(id,gen,p)=>{if(safe(id,gen)&&gateRef.current.owner===id)publish({...gateRef.current,...p});};
  useEffect(()=>{
    const gen=++generation.current;
    if(!owner){recentAuth.current=null;publish(freshGate());return;}
    publish(freshGate(owner));
    (async()=>{
      const availability=strongBiometricsAvailable();
      let stored;try{stored=await SecureStore.getItemAsync(pref(owner));}catch{stored='unreadable';}
      const available=await availability;
      if(!safe(owner,gen))return;
      const verified=recentAuth.current?.owner===owner&&Date.now()-recentAuth.current.at<30000;
      if(recentAuth.current?.owner===owner)recentAuth.current=null;
      let next=gateAfterLoad(owner,stored,available,verified);
      if(next.enabled!==false&&!foregroundRef.current)next={...next,phase:'locked'};
      if(next.phase==='unlocked'&&next.enabled!==false)unlockedAt.current=Date.now();
      publish(next);
    })();
    return()=>{generation.current++;};
  },[owner]);

  useEffect(()=>{
    const sub=AppState.addEventListener('change',next=>{
      const wasForeground=foregroundRef.current;const isForeground=active(next);
      foregroundRef.current=isForeground;setForeground(isForeground);
      if(!isForeground&&!prompt.current){
        recentAuth.current=null;
        const locked=gateOnBackground(gateRef.current,false);
        if(locked!==gateRef.current)publish(locked);
      }
      if(isForeground&&!wasForeground){
        // A native authentication prompt can temporarily background the app.
        // Only preserve its immediately preceding successful verification.
        const current=gateRef.current;
        if(!prompt.current&&current.enabled!==false&&current.phase==='unlocked'&&Date.now()-unlockedAt.current>3000)
          publish({...current,phase:'locked'});
        if(ownerRef.current){
          const id=ownerRef.current,gen=generation.current;
          void strongBiometricsAvailable().then(available=>patch(id,gen,{available}));
        }
      }
    });
    return()=>sub.remove();
  },[]);

  // Call only following successful server-side account authentication.
  function markAccountVerified(id){
    if(!id)return;
    recentAuth.current={owner:id,at:Date.now()};
    if(id===ownerRef.current&&gateRef.current.owner===id&&gateRef.current.phase!=='checking'){
      recentAuth.current=null;unlockedAt.current=Date.now();
      publish({...gateRef.current,phase:'unlocked',error:''});
    }
  }
  async function perform(job){
    if(!owner||operation.current)return;
    const id=owner,gen=generation.current,token={};operation.current=token;setBusy(true);
    patch(id,gen,{error:''});
    try{await job(id,gen);}
    catch(e){patch(id,gen,{error:e?.message||'تعذر إكمال التحقق. حاول مرة أخرى.'});}
    finally{if(operation.current===token){operation.current=null;setBusy(false);}}
  }
  async function nativePrompt(id,gen,message){
    if(!foregroundRef.current)throw Error('افتح التطبيق أولاً لإكمال التحقق.');
    if(!(await strongBiometricsAvailable())){
      patch(id,gen,{available:false});throw Error('سجّل بصمة قوية في إعدادات هاتفك أولاً، أو استخدم كلمة المرور.');
    }
    if(!safe(id,gen))return false;
    if(!foregroundRef.current)throw Error('افتح التطبيق أولاً لإكمال التحقق.');
    prompt.current=true;
    try{
      const result=await authenticateBiometrics(message);
      if(!safe(id,gen))return false;
      if(!result.success)throw Error(failureMessage(result));
      return true;
    }finally{prompt.current=false;}
  }
  function enable(){return perform(async(id,gen)=>{
    if(gateRef.current.phase!=='unlocked')throw Error('افتح الحساب أولاً.');
    if(!(await nativePrompt(id,gen,'تفعيل فتح أركب ببصمة الهاتف')))return;
    if(!safe(id,gen))return;
    await SecureStore.setItemAsync(pref(id),'1');
    unlockedAt.current=Date.now();
    patch(id,gen,{enabled:true,phase:'unlocked',available:true,error:''});
  });}
  function disable(){return perform(async(id,gen)=>{
    if(gateRef.current.phase!=='unlocked'||!foregroundRef.current)throw Error('افتح الحساب أولاً.');
    await SecureStore.deleteItemAsync(pref(id));
    patch(id,gen,{enabled:false,phase:'unlocked',error:''});
  });}
  function unlock(){return perform(async(id,gen)=>{
    if(gateRef.current.phase!=='locked'||gateRef.current.enabled!==true)return;
    if(!(await nativePrompt(id,gen,'فتح أركب ببصمة الهاتف')))return;
    unlockedAt.current=Date.now();patch(id,gen,{phase:'unlocked',available:true,error:''});
  });}
  function unlockPassword(password){return perform(async(id,gen)=>{
    if(gateRef.current.phase!=='locked'||!foregroundRef.current)return;
    if(!password)throw Error('أدخل كلمة مرور حسابك.');
    // The callback authenticates the existing server account, never a local PIN.
    const verified=await reauthenticate(password,id);
    if(!verified||!safe(id,gen))throw Error('تعذر التحقق من كلمة مرور الحساب. تحقق من الاتصال وحاول مرة أخرى.');
    unlockedAt.current=Date.now();patch(id,gen,{phase:'unlocked',error:''});
  });}
  const visible=privateViewAllowed(owner,gate,foreground);
  return {...gate,busy,blocked:!!owner&&!visible,visible,markAccountVerified,enable,disable,unlock,unlockPassword};
}
