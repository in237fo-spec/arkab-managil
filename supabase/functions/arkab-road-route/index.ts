import {createClient} from 'npm:@supabase/supabase-js@2.80.0';

// The operator configures a trusted HTTPS OSRM-compatible endpoint. It is
// never taken from user input; no public demo endpoint is enabled by default.
const endpoint=(Deno.env.get('ARKAB_ROUTING_URL')||'').trim().replace(/\/+$/,'');
const token=Deno.env.get('ARKAB_ROUTING_TOKEN')||'';
let routingConfigured=false;
try{const target=new URL(endpoint);routingConfigured=target.protocol==='https:'&&!target.username&&!target.password&&!target.search&&!target.hash;}catch{}
const apiUrl=Deno.env.get('SUPABASE_URL')!;
const publicKey=Deno.env.get('SUPABASE_ANON_KEY')||Deno.env.get('SUPABASE_PUBLISHABLE_KEY')||'';
const point=(v:unknown):v is [number,number]=>Array.isArray(v)&&v.length===2&&v.every(Number.isFinite)&&Math.abs(v[0])<=180&&Math.abs(v[1])<=90;
Deno.serve(async req=>{
  const reply=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'private, no-store'}});
  if(req.method!=='POST')return reply({error:'method'},405);
  const auth=req.headers.get('Authorization')||'';
  if(!auth.startsWith('Bearer ')||!publicKey)return reply({error:'unauthorized'},401);
  const db=createClient(apiUrl,publicKey,{global:{headers:{Authorization:auth}},auth:{persistSession:false,autoRefreshToken:false}});
  const {data:user,error}=await db.auth.getUser();
  if(error||!user?.user)return reply({error:'unauthorized'},401);
  if(!routingConfigured)return reply({error:'routing_unconfigured'},503);
  try{
    const reader=req.body?.getReader();if(!reader)return reply({error:'invalid'},400);
    const decoder=new TextDecoder();let body='',size=0;
    while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
      if(size>1024){await reader.cancel();return reply({error:'invalid'},400);}body+=decoder.decode(part.value,{stream:true});}
    const {pickup,destination}=JSON.parse(body+decoder.decode());
    if(!point(pickup)||!point(destination))return reply({error:'invalid'},400);
    // ARKAB launch area only; no general-purpose routing proxy.
    const inArea=(p:[number,number])=>Math.abs(p[0]-32.98)<0.4&&Math.abs(p[1]-14.25)<0.4;
    if(!inArea(pickup)||!inArea(destination))return reply({error:'outside_service_area'},422);
    const {data:allowed,error:quotaError}=await db.rpc('arkab_route_allow_v09');
    if(quotaError)return reply({error:'routing_unavailable'},503);
    if(allowed!==true)return reply({error:'rate_limited'},429);
    const url=endpoint+'/route/v1/driving/'+pickup.join(',')+';'+destination.join(',')+'?overview=full&geometries=geojson';
    const res=await fetch(url,{signal:AbortSignal.timeout(6500),redirect:'error',headers:token?{Authorization:'Bearer '+token}:{}});
    if(!res.ok)return reply({error:'routing_unavailable'},503);
    const obj=await res.json();const route=obj?.routes?.[0];
    if(obj?.code!=='Ok'||!route||!Number.isFinite(route.distance)||route.distance<=0||!Number.isFinite(route.duration)||route.duration<=0||
      !Array.isArray(route.geometry?.coordinates)||route.geometry.coordinates.length<2||route.geometry.coordinates.length>25000||!route.geometry.coordinates.every(point))
      return reply({error:'no_route'},422);
    return reply({code:'Ok',routes:[{distance:route.distance,duration:route.duration,geometry:{type:'LineString',coordinates:route.geometry.coordinates}}]});
  }catch{return reply({error:'routing_unavailable'},503);}
});
