'use strict';
const config=window.ARKAB_PUBLIC_CONFIG,$=id=>document.getElementById(id);
let token=null,loading=false,epoch=0;
function notice(message){$('notice').textContent=message;$('notice').hidden=!message;}
function element(tag,text){const e=document.createElement(tag);e.textContent=text||'';return e;}
async function request(path,body,auth=true){
 const headers={'apikey':config.publishableKey,'Content-Type':'application/json'};
 if(auth){if(!token)throw Error('auth');headers.Authorization='Bearer '+token;}
 const response=await fetch(config.url+path,{method:'POST',headers,body:JSON.stringify(body),cache:'no-store',referrerPolicy:'no-referrer'});
 if(!response.ok){const error=Error('request');error.status=response.status;throw error;}return response.json();
}
const api=(action,args={})=>request('/functions/v1/arkab-admin',{action,...args});
async function logout(){epoch++;const old=token;token=null;$('rows').replaceChildren();$('queue').hidden=true;$('login').hidden=false;
 if(old)try{await fetch(config.url+'/auth/v1/logout?scope=local',{method:'POST',headers:{apikey:config.publishableKey,Authorization:'Bearer '+old}});}catch{}
}
async function refresh(){
 if(loading||!token)return;loading=true;const myEpoch=epoch;$('refresh').disabled=true;
 try{const data=await api('deletion_requests_list');if(myEpoch!==epoch)return;if(!Array.isArray(data.rows))throw Error('invalid response');
 $('rows').replaceChildren();
 if(!data.rows.length)$('rows').append(element('p','لا توجد طلبات.'));
 for(const row of data.rows){const card=element('article');card.className='ticket';card.append(element('p','معرّف الحساب: '+row.user_id),element('p','وقت الطلب: '+new Date(row.requested_at).toLocaleString('ar-SD',{timeZone:'Africa/Khartoum'})),element('p',row.status==='reviewing'?'قيد المراجعة':'طلب جديد'));
 if(row.status==='requested'){const btn=element('button','بدء المراجعة');btn.onclick=async()=>{btn.disabled=true;try{await api('deletion_request_review',{user_id:row.user_id});notice('تم بدء المراجعة. لم تحذف أي بيانات.');await refresh();}catch{notice('تعذر تحديث الحالة.');}finally{btn.disabled=false;}};card.append(btn);}
 $('rows').append(card);}
 $('queue').hidden=false;$('login').hidden=true;
 }catch(e){if(myEpoch===epoch){notice('تعذر تحميل قائمة الطلبات. تحقق من الصلاحية والاتصال.');if(e.status===401||e.status===403||$('queue').hidden)await logout();}}
 finally{loading=false;$('refresh').disabled=false;}
}
$('signin').onsubmit=async e=>{e.preventDefault();const b=$('signin').querySelector('button');b.disabled=true;notice('');try{const auth=await request('/auth/v1/token?grant_type=password',{email:$('email').value.trim(),password:$('password').value},false);$('password').value='';if(!auth.access_token)throw Error('invalid');token=auth.access_token;epoch++;await refresh();}catch{$('password').value='';notice('تعذر الدخول.');await logout();}finally{b.disabled=false;}};
$('refresh').onclick=refresh;$('logout').onclick=()=>{notice('');void logout();};
