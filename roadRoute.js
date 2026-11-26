import {useEffect,useState} from 'react';

// Configure an HTTPS OSRM-compatible routing endpoint under your control.
// Do not silently send precise journey locations to an unconfigured public service.
const endpoint=(process.env.EXPO_PUBLIC_ROUTING_URL||'').trim().replace(/\/+$/,'');
export function validPoint(p){
  return Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)&&Math.abs(p[0])<=180&&Math.abs(p[1])<=90;
}
export function parseRoadRoute(payload){
  const route=payload?.routes?.[0];
  if(payload?.code!=='Ok'||!route||!Number.isFinite(route.distance)||route.distance<=0||
    !Number.isFinite(route.duration)||route.duration<=0||!Array.isArray(route.geometry?.coordinates)||
    route.geometry.coordinates.length<2||!route.geometry.coordinates.every(validPoint))return null;
  return {status:'ready',distanceKm:route.distance/1000,durationMin:route.duration/60,coordinates:route.geometry.coordinates};
}
export function useRoadRoute(pickup,destination){
  const [result,setResult]=useState({status:'idle',key:''});
  const [a,b]=pickup||[],[c,d]=destination||[];
  const key=[a,b,c,d].join(',');
  useEffect(()=>{
    if(!validPoint([a,b])||!validPoint([c,d])){setResult({status:'idle',key});return;}
    if(!endpoint.startsWith('https://')){setResult({status:'unconfigured',key});return;}
    const controller=new AbortController();
    let active=true;
    setResult({status:'loading',key});
    const timeout=setTimeout(()=>controller.abort(),7500);
    const timer=setTimeout(async()=>{
      try{
        const response=await fetch(endpoint+'/route/v1/driving/'+a+','+b+';'+c+','+d+'?overview=full&geometries=geojson',{signal:controller.signal});
        if(!response.ok)throw Error('route response');
        const route=parseRoadRoute(await response.json());
        if(!route)throw Error('route invalid');
        if(active)setResult({...route,key});
      }catch{if(active)setResult({status:'unavailable',key});}
      finally{clearTimeout(timeout);}
    },300);
    return ()=>{active=false;clearTimeout(timer);clearTimeout(timeout);controller.abort();};
  },[a,b,c,d,key]);
  return result.key===key?result:{status:validPoint(pickup)&&validPoint(destination)&&endpoint.startsWith('https://')?'loading':'idle',key};
}
