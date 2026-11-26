'use strict';
const api='https://hfhkscqmsmxsxzjfxzew.supabase.co/functions/v1/arkab-live-share';
const $=id=>document.getElementById(id);
const statuses={accepted:'تم الاتفاق مع الكابتن',arrived:'وصل الكابتن',in_progress:'الرحلة جارية'};
let token=location.hash.slice(1);
if(/^[0-9a-f]{64}$/.test(token)){
  // Keep the capability in this tab only; do not leak it in request URLs/referrers.
  try{sessionStorage.setItem('arkab-track-token',token)}catch{}
  history.replaceState(null,'',location.pathname);
}else{try{token=sessionStorage.getItem('arkab-track-token')||''}catch{token=''}}
let timer=null,active=true,pending=false,mapEnabled=false,lastPoint=null,lastMapKey='';
function setText(id,value){$(id).textContent=value}
function hideLocation(){
  lastPoint=null;lastMapKey='';$('coords').hidden=true;$('map-link').hidden=true;$('enable-map').hidden=true;$('map-notice').hidden=true;$('map').hidden=true;$('map').removeAttribute('src');
}
function stop(message){
  active=false;clearInterval(timer);hideLocation();setText('status',message);setText('updated','—');setText('expires','—');
  try{sessionStorage.removeItem('arkab-track-token')}catch{};token='';$('retry').disabled=true;
}
function showMap(){
  if(!lastPoint||!mapEnabled)return;
  const [lat,lng]=lastPoint;const key=lat.toFixed(4)+','+lng.toFixed(4);
  $('map').hidden=false;
  if(key===lastMapKey)return;lastMapKey=key;
  const box=[lng-.009,lat-.006,lng+.009,lat+.006].join(',');
  $('map').src='https://www.openstreetmap.org/export/embed.html?bbox='+encodeURIComponent(box)+'&layer=mapnik&marker='+encodeURIComponent(lat+','+lng);
}
$('enable-map').addEventListener('click',()=>{
  if(!window.confirm('سيتم إرسال الموقع إلى OpenStreetMap لعرض الخريطة. هل تريد المتابعة؟'))return;
  mapEnabled=true;$('enable-map').hidden=true;showMap();
});
async function refresh(){
  if(!active||pending)return;
  if(!/^[0-9a-f]{64}$/.test(token)){stop('رابط التتبع غير صالح أو منتهي.');return}
  pending=true;
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),8000);
  try{
    const res=await fetch(api,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token}),signal:controller.signal,cache:'no-store',referrerPolicy:'no-referrer'});
    if(res.status===404){stop('انتهت المشاركة أو أُلغي الرابط.');return}
    if(!res.ok)throw Error('network');
    const data=await res.json();
    if(!statuses[data.status]||Date.parse(data.expires_at)<=Date.now()){stop('انتهت المشاركة.');return}
    setText('status',statuses[data.status]);setText('expires',new Date(data.expires_at).toLocaleTimeString('ar-SD',{timeZone:'Africa/Khartoum'}));
    const age=Date.now()-Date.parse(data.location_at||'');
    if(!Number.isFinite(age)||age< -30000||age>120000||!Number.isFinite(data.latitude)||!Number.isFinite(data.longitude)){
      hideLocation();setText('details','لا توجد إشارة موقع حديثة حالياً.');setText('updated','—');return
    }
    setText('details',age<=60000?'تم تحديث موقع الراكب خلال الدقيقة الأخيرة.':'هذا آخر موقع معروف، وليس بالضرورة الموقع الحالي.');
    setText('updated',new Date(data.location_at).toLocaleTimeString('ar-SD',{timeZone:'Africa/Khartoum'}));
    lastPoint=[data.latitude,data.longitude];setText('coords',data.latitude.toFixed(5)+' ، '+data.longitude.toFixed(5));$('coords').hidden=false;
    $('map-link').href='https://www.openstreetmap.org/?mlat='+encodeURIComponent(data.latitude)+'&mlon='+encodeURIComponent(data.longitude)+'#map=17/'+data.latitude+'/'+data.longitude;
    $('map-link').hidden=false;$('map-notice').hidden=false;$('enable-map').hidden=mapEnabled;showMap();
  }catch{hideLocation();setText('status','تعذر التحديث الآن');setText('details','تحقق من الإنترنت. نحجب الإحداثيات القديمة حتى يصل تحديث جديد.');setText('updated','—')}
  finally{pending=false;clearTimeout(timeout)}
}
$('retry').addEventListener('click',refresh);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh()});
void refresh();timer=setInterval(()=>{if(!document.hidden)void refresh()},15000);
