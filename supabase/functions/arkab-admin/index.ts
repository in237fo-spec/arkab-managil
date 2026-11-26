const url=Deno.env.get('SUPABASE_URL')!;
const anon=Deno.env.get('SUPABASE_ANON_KEY')!;
const service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const origins=new Set(['https://twilight-firefly-2b20.in237fo.workers.dev','https://admin.almanagil.com']);
const baseCors={'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'POST, OPTIONS','Cache-Control':'no-store','Content-Type':'application/json','Vary':'Origin'};
async function db(path:string,method='GET',body?:unknown,prefer='return=representation'){const r=await fetch(url+'/rest/v1/'+path,{method,headers:{apikey:service,Authorization:'Bearer '+service,'Content-Type':'application/json',Prefer:prefer},body:body===undefined?undefined:JSON.stringify(body)});if(!r.ok)throw new Error('database');return await r.json();}
Deno.serve(async req=>{
const origin=req.headers.get('Origin');
const cors:Record<string,string>={...baseCors};
if(origin&&origins.has(origin))cors['Access-Control-Allow-Origin']=origin;
const out=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:cors});
if(origin&&!origins.has(origin))return out({error:'origin forbidden'},403);
if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
if(req.method!=='POST')return out({error:'method'},405);
try{
const token=req.headers.get('Authorization')||'';
if(!token.startsWith('Bearer '))return out({error:'unauthorized'},401);
const ar=await fetch(url+'/auth/v1/user',{headers:{apikey:anon,Authorization:token}});
if(!ar.ok)return out({error:'unauthorized'},401);
const user=await ar.json();
if(!user.email_confirmed_at||user.app_metadata?.arkab_admin!==true)return out({error:'forbidden'},403);
const b=await req.json();
if(b.action==='overview'){
const specs={drivers:'drivers?select=id,approved,online,profiles(full_name,contact_phone),vehicles(id,kind,plate,approved)&limit=200',rides:'rides?select=id,status,pickup,destination,vehicle_kind,agreed_fare,proposed_fare,created_at&order=created_at.desc&limit=100',complaints:'complaints?select=id,body,created_at&order=created_at.desc&limit=100',ratings:'ratings?select=id,score,comment&limit=100',payments:'payments?select=id,method,amount,status,created_at&limit=100',subscriptions:'subscriptions?select=id,driver_id,starts_at,ends_at,amount&limit=100',commissions:'commissions?select=id,ride_id,amount&limit=100',pricing:'pricing?select=vehicle_kind,base_fare,per_km,active'};
return out(Object.fromEntries(await Promise.all(Object.entries(specs).map(async ([k,v])=>[k,await db(v)]))));
}
if(b.action==='approval'&&['drivers','vehicles'].includes(b.table)&&typeof b.approved==='boolean'&&typeof b.id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(b.id)){
const patch=b.table==='drivers'&&!b.approved?{approved:false,online:false}:{approved:b.approved};
const rows=await db(b.table+'?id=eq.'+b.id,'PATCH',patch);if(rows.length!==1)return out({error:'not found'},404);return out({ok:true});
}
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const money=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1e9;
// Dedicated minimal administrative reads: no rider contacts or unrelated records.
if(b.action==='deletion_requests_list'){
return out({rows:await db('account_deletion_requests?select=user_id,requested_at,status&order=requested_at.asc&limit=100')});
}
if(b.action==='deletion_request_review'&&uuid(b.user_id)){
const rows=await db('account_deletion_requests?user_id=eq.'+b.user_id+'&status=eq.requested','PATCH',{status:'reviewing'});
if(rows.length!==1)return out({error:'pending request not found'},404);
return out({ok:true});
}
if(b.action==='pricing_list'){
return out({rows:await db('pricing?select=vehicle_kind,base_fare,per_km,active&order=vehicle_kind.asc')});
}
if(b.action==='commission_list'){
const rides=await db('rides?select=id,vehicle_kind,agreed_fare,completed_at&status=eq.completed&order=completed_at.desc.nullslast&limit=100');
const ids=rides.map((r:{id:string})=>r.id);
const commissions=ids.length?await db('commissions?select=ride_id,amount&ride_id=in.('+ids.join(',')+')'):[];
return out({rides,commissions});
}
if(b.action==='pricing_save'&&['rickshaw','cargo_tuktuk'].includes(b.vehicle_kind)&&money(b.base_fare)&&money(b.per_km)&&typeof b.active==='boolean'){
if(b.active&&b.base_fare===0&&b.per_km===0)return out({error:'positive fare required'},400);
return out({rows:await db('pricing?on_conflict=vehicle_kind','POST',{vehicle_kind:b.vehicle_kind,base_fare:b.base_fare,per_km:b.per_km,active:b.active},'resolution=merge-duplicates,return=representation')});
}
if(b.action==='commission_save'&&uuid(b.ride_id)&&money(b.amount)){
const rides=await db('rides?select=id,agreed_fare&id=eq.'+b.ride_id+'&status=eq.completed');
if(rides.length!==1||rides[0].agreed_fare==null)return out({error:'completed ride with agreed fare required'},400);
if(!Number.isFinite(Number(rides[0].agreed_fare))||b.amount>Number(rides[0].agreed_fare))return out({error:'commission exceeds fare'},400);
return out({rows:await db('commissions?on_conflict=ride_id','POST',{ride_id:b.ride_id,amount:b.amount},'resolution=merge-duplicates,return=representation')});
}
if(b.action==='subscription_save'&&uuid(b.driver_id)&&money(b.amount)&&typeof b.starts_at==='string'&&typeof b.ends_at==='string'&&Number.isFinite(Date.parse(b.starts_at))&&Date.parse(b.ends_at)>Date.parse(b.starts_at)){
const row={driver_id:b.driver_id,amount:b.amount,starts_at:new Date(b.starts_at).toISOString(),ends_at:new Date(b.ends_at).toISOString()};
if(b.id!==undefined&&!uuid(b.id))return out({error:'invalid id'},400);
const rows=b.id?await db('subscriptions?id=eq.'+b.id,'PATCH',row):await db('subscriptions','POST',row);
if(rows.length!==1)return out({error:'not found'},404);
return out({rows});
}
if(b.action==='payment_review'&&uuid(b.id)&&['verified','rejected'].includes(b.status)){
const rows=await db('payments?id=eq.'+b.id+'&status=eq.pending','PATCH',{status:b.status});
if(rows.length!==1)return out({error:'pending payment not found'},404);
return out({ok:true});
}
if(b.action==='live_locations'){
const rides=await db('rides?select=id,driver_id,pickup,destination,status&status=in.(accepted,arrived,in_progress)&limit=200');
const ids=rides.map((r:{id:string})=>r.id);
const locations=ids.length?await db('ride_locations?select=ride_id,driver_id,latitude,longitude,updated_at&ride_id=in.('+ids.join(',')+')&limit=200'):[];
return out({rides,locations});
}
if(b.action==='notification_send'&&['all','driver','passenger'].includes(b.audience)&&typeof b.title==='string'&&b.title.trim().length>0&&b.title.length<=100&&typeof b.body==='string'&&b.body.trim().length>0&&b.body.length<=1000){
const recipients=await db('profiles?select=id&order=id&limit=501'+(b.audience==='all'?'':'&role=eq.'+b.audience));
if(recipients.length>500)return out({error:'recipient limit exceeded'},400);
if(recipients.length)await db('notifications','POST',recipients.map((u:{id:string})=>({user_id:u.id,title:b.title.trim(),body:b.body.trim()})));
return out({count:recipients.length});
}
return out({error:'invalid action'},400);
}catch{return out({error:'request failed'},500);}
});
