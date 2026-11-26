'use strict';
const config=window.ARKAB_PUBLIC_CONFIG,$=id=>document.getElementById(id);
let token=null,owner=null,busy=false;
function notice(text){$('notice').textContent=text;$('notice').hidden=!text;}
async function request(path,method='GET',body,authorized=true){
  const headers={'apikey':config.publishableKey,'Content-Type':'application/json'};
  if(authorized){if(!token)throw Error('login required');headers.Authorization='Bearer '+token;}
  if(method==='POST'&&path.startsWith('/rest/'))headers.Prefer='return=minimal';
  const res=await fetch(config.url+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',referrerPolicy:'no-referrer'});
  if(!res.ok){const e=Error('request failed');e.status=res.status;throw e;}
  return res.status===204||res.status===201?null:res.json();
}
async function read(){
  const rows=await request('/rest/v1/account_deletion_requests?select=requested_at,status&user_id=eq.'+encodeURIComponent(owner));
  if(!Array.isArray(rows))throw Error('invalid response');return rows[0]||null;
}
function render(record){
  $('submit').hidden=!!record;$('state').textContent=record?(record.status==='reviewing'?'طلبك قيد المراجعة.':'تم تسجيل طلب حذف حسابك. لم يُحذف الحساب بعد.'):'حسابك مؤكد. يمكنك الآن إرسال طلب الحذف.';
  if(record)$('state').textContent+=' تاريخ الطلب: '+new Date(record.requested_at).toLocaleString('ar-SD');
}
async function logout(){
  const old=token;token=null;owner=null;$('signin').hidden=false;$('account').hidden=true;$('state').textContent='';$('submit').hidden=false;
  if(old){try{await fetch(config.url+'/auth/v1/logout?scope=local',{method:'POST',headers:{apikey:config.publishableKey,Authorization:'Bearer '+old}});}catch{}}
}
$('signin').onsubmit=async e=>{
  e.preventDefault();if(busy)return;busy=true;const btn=$('signin').querySelector('button');btn.disabled=true;notice('');
  try{const auth=await request('/auth/v1/token?grant_type=password','POST',{email:$('email').value.trim(),password:$('password').value},false);$('password').value='';
    if(!auth?.access_token||!auth.user?.id)throw Error('invalid account');token=auth.access_token;owner=auth.user.id;render(await read());$('signin').hidden=true;$('account').hidden=false;
  }catch{$('password').value='';notice('تعذر التحقق من الحساب. تأكد من بيانات الدخول والاتصال.');await logout();}
  finally{busy=false;btn.disabled=false;}
};
$('submit').onclick=async()=>{
  if(busy||!owner||!confirm('هل تؤكد إرسال طلب حذف حساب أركب والبيانات المرتبطة به؟'))return;busy=true;$('submit').disabled=true;$('logout').disabled=true;notice('');
  try{try{await request('/rest/v1/account_deletion_requests','POST',{user_id:owner});}catch(e){if(e.status!==409)throw e;}
    const record=await read();if(!record)throw Error('not confirmed');render(record);notice('تم استلام طلبك للمراجعة.');
  }catch{notice('تعذر تأكيد تسجيل الطلب. يمكنك إعادة المحاولة؛ لن يتكرر الطلب لنفس الحساب.');}
  finally{busy=false;$('submit').disabled=false;$('logout').disabled=false;}
};
$('logout').onclick=()=>{if(!busy){notice('');void logout();}};
