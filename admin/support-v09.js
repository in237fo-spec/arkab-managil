'use strict';
const config=window.ARKAB_PUBLIC_CONFIG,$=id=>document.getElementById(id);
const categories={ride:'رحلة',fare:'أجرة',technical:'مشكلة تقنية',safety:'السلامة',other:'أخرى'};
const statuses={open:'جديدة',in_review:'قيد المعالجة',resolved:'تم الحل'};
let accessToken=null,loading=false;
function notice(message){$('notice').textContent=message;$('notice').hidden=!message;}
function el(tag,text,cls){const e=document.createElement(tag);e.textContent=text||'';if(cls)e.className=cls;return e;}
async function request(path,body,authorized=true){
  const headers={'apikey':config.publishableKey,'Content-Type':'application/json'};
  if(authorized&&accessToken)headers.Authorization='Bearer '+accessToken;
  const res=await fetch(config.url+path,{method:'POST',headers,body:JSON.stringify(body),cache:'no-store',referrerPolicy:'no-referrer'});
  if(!res.ok)throw Error('request failed: '+res.status);
  return res.status===204?null:res.json();
}
async function refresh(){
  if(loading||!accessToken)return;loading=true;$('refresh').disabled=true;
  try{
    const data=await request('/rest/v1/rpc/arkab_support_queue_v09',{});
    if(!Array.isArray(data))throw Error('invalid response');$('tickets').replaceChildren();
    if(!data.length)$('tickets').appendChild(el('p','لا توجد تذاكر.'));
    for(const t of data){
      const card=el('article','','ticket');card.appendChild(el('strong',(categories[t.category]||'أخرى')+' • #'+t.id.slice(0,8)));
      card.appendChild(el('p',statuses[t.status]||'قيد المراجعة','ticket-status'));card.appendChild(el('p',t.body));
      card.appendChild(el('small',new Date(t.created_at).toLocaleString('ar-SD',{timeZone:'Africa/Khartoum'})+(t.ride_id?' • الرحلة #'+t.ride_id.slice(0,8):'')));
      const label=el('label','الحالة');const select=document.createElement('select');
      for(const [key,text] of Object.entries(statuses)){const option=el('option',text);option.value=key;option.selected=t.status===key;select.append(option)}
      select.setAttribute('aria-label','حالة التذكرة');card.append(label,select);
      const reply=document.createElement('textarea');reply.value=t.reply||'';reply.maxLength=2000;reply.setAttribute('aria-label','رد الدعم');reply.placeholder='اكتب الرد للعميل';
      card.append(el('label','الرد'),reply);
      const save=el('button','حفظ الحالة والرد');save.addEventListener('click',async()=>{
        if(select.value==='resolved'&&!reply.value.trim()){notice('اكتب نتيجة المعالجة قبل إغلاق الطلب.');return;}
        save.disabled=true;try{
          const ok=await request('/rest/v1/rpc/arkab_support_update_v09',{p_ticket:t.id,p_status:select.value,p_reply:reply.value.trim()});
          if(ok!==true)throw Error('not saved');notice('تم الحفظ.');await refresh();
        }catch{notice('تعذر حفظ التذكرة. تحقق من الاتصال والصلاحية.')}finally{save.disabled=false}
      });card.appendChild(save);$('tickets').appendChild(card);
    }
  }catch{notice('تعذر تحميل طلبات الدعم أو أن حسابك غير مصرح له.');await logout();}
  finally{loading=false;$('refresh').disabled=false}
}
async function logout(){
  const old=accessToken;accessToken=null;$('tickets').replaceChildren();$('queue').hidden=true;$('login').hidden=false;
  if(old){try{await fetch(config.url+'/auth/v1/logout?scope=local',{method:'POST',headers:{apikey:config.publishableKey,Authorization:'Bearer '+old}})}catch{}}
}
$('signin').addEventListener('submit',async e=>{
  e.preventDefault();const password=$('password'),email=$('email');const submit=$('signin').querySelector('button');submit.disabled=true;notice('');
  try{const auth=await request('/auth/v1/token?grant_type=password',{email:email.value.trim(),password:password.value},false);
    password.value='';if(!auth?.access_token)throw Error('auth');accessToken=auth.access_token;$('login').hidden=true;$('queue').hidden=false;await refresh();
  }catch{password.value='';notice('تعذر الدخول. تحقق من بيانات الدخول وصلاحية الحساب.');await logout();}
  finally{submit.disabled=false}
});
$('refresh').addEventListener('click',refresh);$('logout').addEventListener('click',()=>{notice('');void logout()});
