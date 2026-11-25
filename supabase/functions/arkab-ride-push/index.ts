import {createClient} from 'npm:@supabase/supabase-js@2.80.0';

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  {auth:{persistSession:false,autoRefreshToken:false}}
);

Deno.serve(async request=>{
  if (request.method!=='POST') return new Response(null,{status:405});
  let id: unknown, nonce: unknown;
  try {
    const reader=request.body?.getReader();
    if (!reader) return new Response(null,{status:400});
    const decoder=new TextDecoder();
    let size=0;
    let payload='';
    while (true) {
      const {done,value}=await reader.read();
      if (done) break;
      size+=value.byteLength;
      if (size>512) {
        await reader.cancel();
        return new Response(null,{status:413});
      }
      payload+=decoder.decode(value,{stream:true});
    }
    const parsed=JSON.parse(payload+decoder.decode());
    id=parsed.notification_id;
    nonce=parsed.nonce;
  } catch {
    return new Response(null,{status:400});
  }
  if (typeof id!=='string' || !uuid.test(id) || typeof nonce!=='string' || !uuid.test(nonce))
    return new Response(null,{status:400});

  const {data,error}=await db.rpc('claim_ride_push',{p_notification:id,p_nonce:nonce});
  if (error) {
    console.error('Could not claim notification',error.code);
    return new Response(null,{status:503});
  }
  if (!data?.length) return new Response(null,{status:204});

  try {
    const response=await fetch('https://exp.host/--/api/v2/push/send',{
      method:'POST',
      headers:{'Content-Type':'application/json','Accept':'application/json'},
      body:JSON.stringify(data),
      signal:AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      console.error('Expo push send returned HTTP',response.status);
      return new Response(null,{status:502});
    }
    const tickets=await response.json();
    for (const ticket of tickets.data ?? []) {
      if (ticket.status==='error') console.error('Expo push ticket rejected',ticket.details?.error);
    }
    return new Response(null,{status:204});
  } catch {
    console.error('Expo push send failed');
    return new Response(null,{status:502});
  }
});
