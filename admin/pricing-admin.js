'use strict';
const config=window.ARKAB_PUBLIC_CONFIG,$=id=>document.getElementById(id);
const labels={rickshaw:'ركشة',cargo_tuktuk:'تكتك بضائع'};
let token=null,loading=false,epoch=0;
const el=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
function notice(text){$('notice').textContent=text;$('notice').hidden=!text;}
function amount(raw){const s=String(raw??'').trim();if(!/^\d+(\.\d{1,2})?$/.test(s))return null;const n=Number(s);return Number.isFinite(n)&&n>=0&&n<=1e9?n:null;}
function format(v){return v==null?'—':Number(v).toLocaleString('ar-SD',{maximumFractionDigits:2})+' ج.س';}
function field(card,label,value,max=1e9){
  const l=el('label',label),input=el('input');input.type='number';input.min='0';input.max=String(max);input.step='0.01';input.inputMode='decimal';input.value=value??'';l.append(input);card.append(l);return input;
}
async function request(path,body,authorized=true){
  const headers={'apikey':config.publishableKey,'Content-Type':'application/json'};
  if(authorized){if(!token)throw Error('login required');headers.Authorization='Bearer '+token;}
  const res=await fetch(config.url+path,{method:'POST',headers,body:JSON.stringify(body),cache:'no-store',referrerPolicy:'no-referrer'});
  if(!res.ok){const e=Error('request failed');e.status=res.status;throw e;}return res.json();
}
const api=(action,args={})=>request('/functions/v1/arkab-admin',{action,...args});
async function logout(){
  epoch++;const old=token;token=null;$('rates').replaceChildren();$('commissions').replaceChildren();$('dashboard').hidden=true;$('login').hidden=false;
  if(old){try{await fetch(config.url+'/auth/v1/logout?scope=local',{method:'POST',headers:{apikey:config.publishableKey,Authorization:'Bearer '+old}});}catch{}}
}
function renderRate(kind,row){
  const card=el('article');card.className='ticket';card.append(el('h2',labels[kind]),el('p',row?(row.active?'تسعيرة مفعّلة':'التسعيرة غير مفعّلة'):'لم يتم تحديد تسعيرة'));
  const base=field(card,'أجرة الانطلاق',row?.base_fare),perKm=field(card,'سعر كل كيلومتر',row?.per_km);
  const l=el('label','تفعيل التقدير التلقائي'),active=el('select');
  for(const [value,label] of [['false','غير مفعّل'],['true','مفعّل']]){const opt=el('option',label);opt.value=value;active.append(opt);}active.value=String(row?.active===true);l.append(active);card.append(l);
  const save=el('button','حفظ التسعيرة');card.append(save);
  save.onclick=async()=>{
    const a=amount(base.value),b=amount(perKm.value),enabled=active.value==='true';
    if(a===null||b===null||(enabled&&a===0&&b===0)){notice('أدخل أسعاراً صحيحة؛ لا يمكن تفعيل تسعيرة صفرية بالكامل.');return;}
    if(!confirm('اعتماد التسعيرة لـ '+labels[kind]+'؟ سيظهر التقدير للركاب عند التحديث.'))return;
    save.disabled=true;
    try{await api('pricing_save',{vehicle_kind:kind,base_fare:a,per_km:b,active:enabled});notice('تم حفظ التسعيرة.');await refresh();}
    catch(e){notice('تعذر حفظ التسعيرة. تحقق من الاتصال والصلاحية.');if(e.status===401||e.status===403)await logout();}
    finally{save.disabled=false;}
  };return card;
}
function renderCommission(ride,recorded){
  const card=el('article');card.className='ticket';card.append(el('h2',(labels[ride.vehicle_kind]||'رحلة')+' • #'+ride.id.slice(0,8)),el('p','الأجرة المتفق عليها: '+format(ride.agreed_fare)),el('p',ride.completed_at?new Date(ride.completed_at).toLocaleString('ar-SD',{timeZone:'Africa/Khartoum'}):'تاريخ إكمال غير موثق'));
  if(ride.agreed_fare==null){card.append(el('p','لا يمكن تسجيل عمولة قبل توثيق الأجرة.'));return card;}
  const gross=Number(ride.agreed_fare);
  if(!Number.isFinite(gross)||gross<0){card.append(el('p','الأجرة غير صالحة للمراجعة.'));return card;}
  const fee=field(card,'مبلغ العمولة',recorded?.amount,Math.min(gross,1e9)),pct=field(card,'نسبة للحساب فقط (%)','',100);
  const calc=el('button','احسب المبلغ من النسبة');calc.className='secondary';card.append(calc);calc.onclick=()=>{const p=amount(pct.value);if(p===null||p>100){notice('أدخل نسبة بين صفر و100.');return;}fee.value=(Math.round(gross*p)/100).toFixed(2);};
  const net=el('p','الصافي بعد العمولة: '+(recorded?format(gross-Number(recorded.amount)):'غير محسوب'));const update=()=>{const n=amount(fee.value);net.textContent='الصافي بعد العمولة: '+(n!==null&&n<=gross?format(gross-n):'غير محسوب');};fee.oninput=update;calc.addEventListener('click',update);card.append(net);
  const save=el('button',recorded?'تحديث العمولة المسجلة':'تسجيل العمولة');card.append(save);
  save.onclick=async()=>{const n=amount(fee.value);if(n===null||n>gross){notice('يجب ألا تتجاوز العمولة أجرة الرحلة.');return;}if(!confirm('تسجيل عمولة '+format(n)+' لهذه الرحلة؟'))return;save.disabled=true;try{await api('commission_save',{ride_id:ride.id,amount:n});notice('تم تسجيل العمولة.');await refresh();}catch(e){notice('تعذر تسجيل العمولة. تحقق من الاتصال والصلاحية.');if(e.status===401||e.status===403)await logout();}finally{save.disabled=false;}};
  return card;
}
async function refresh(){
  if(loading||!token)return;loading=true;const requestEpoch=epoch;$('refresh').disabled=true;
  try{const [rates,fees]=await Promise.all([api('pricing_list'),api('commission_list')]);if(requestEpoch!==epoch)return;
    if(!Array.isArray(rates.rows)||!Array.isArray(fees.rides)||!Array.isArray(fees.commissions))throw Error('invalid response');
    $('rates').replaceChildren(...Object.keys(labels).map(k=>renderRate(k,rates.rows.find(r=>r.vehicle_kind===k))));
    $('commissions').replaceChildren(...(fees.rides.length?fees.rides.map(r=>renderCommission(r,fees.commissions.find(c=>c.ride_id===r.id))):[el('p','لا توجد رحلات مكتملة.')]));
    $('dashboard').hidden=false;$('login').hidden=true;
  }catch(e){if(requestEpoch===epoch){notice('تعذر تحميل البيانات. تحقق من صلاحية حساب الإدارة والاتصال.');if(e.status===401||e.status===403||$('dashboard').hidden)await logout();}}
  finally{loading=false;$('refresh').disabled=false;}
}
$('signin').onsubmit=async e=>{e.preventDefault();const pass=$('password'),button=$('signin').querySelector('button');button.disabled=true;notice('');try{const data=await request('/auth/v1/token?grant_type=password',{email:$('email').value.trim(),password:pass.value},false);pass.value='';if(!data.access_token)throw Error('invalid session');epoch++;token=data.access_token;await refresh();}catch{pass.value='';notice('تعذر الدخول. تحقق من بيانات الحساب.');await logout();}finally{button.disabled=false;}};
$('refresh').onclick=refresh;$('logout').onclick=()=>{notice('');void logout();};
