// Pure state decisions. This is a local UI privacy gate, not a server identity.
export const freshGate=(owner=null)=>({owner,enabled:null,phase:owner?'checking':'signed_out',available:null,error:''});
export function gateAfterLoad(owner,stored,available,verified=false){
  // Null is a new, opt-out device. An unreadable/unexpected preference is not
  // permission to display a previously protected account.
  const enabled=stored===null?false:stored==='1'?true:null;
  return {owner,enabled,phase:enabled===false||verified?'unlocked':'locked',available,
    error:enabled===null?'تعذر التحقق من إعداد الحماية. استخدم كلمة مرور حسابك.':''};
}
export function privateViewAllowed(owner,gate,foreground){
  if(!owner)return true;
  if(gate?.owner!==owner||gate.phase!=='unlocked')return false;
  return gate.enabled===false||foreground;
}
export function gateOnBackground(gate,biometricPromptRunning){
  if(!gate?.owner||gate.enabled===false||biometricPromptRunning||gate.phase==='checking')return gate;
  return {...gate,phase:'locked'};
}
