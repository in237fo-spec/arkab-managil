import {createClient} from 'npm:@supabase/supabase-js@2.80.0';

const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  {auth:{persistSession:false,autoRefreshToken:false}});
const allowed=(Deno.env.get('ARKAB_TRACKING_VIEWER_ORIGIN')||'').trim().replace(/\/$/,'');
const tokenPattern=/^[0-9a-f]{64}$/;
Deno.serve(async req=>{
  const origin=req.headers.get('origin')||'';
  const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
    'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Vary':'Origin'};
  if(!allowed||origin!==allowed)return new Response(null,{status:403,headers});
  const cors={...headers,'Access-Control-Allow-Origin':origin,
    'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type'};
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
  const reply=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:cors});
  if(req.method!=='POST')return reply({error:'method'},405);
  try{
    const length=Number(req.headers.get('content-length')||0);
    if(length>512)return reply({error:'invalid'},400);
    const reader=req.body?.getReader();if(!reader)return reply({error:'invalid'},400);
    let size=0;let body='';const decoder=new TextDecoder();
    while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
      if(size>512){await reader.cancel();return reply({error:'invalid'},400);}
      body+=decoder.decode(part.value,{stream:true});}
    const {token}=JSON.parse(body+decoder.decode());
    if(typeof token!=='string'||!tokenPattern.test(token))return reply({error:'unavailable'},404);
    const {data,error}=await db.rpc('arkab_share_read_v09',{p_token:token});
    if(error)return reply({error:'temporarily_unavailable'},503);
    if(!data)return reply({error:'unavailable'},404);
    return reply(data);
  }catch{return reply({error:'invalid'},400);}
});
