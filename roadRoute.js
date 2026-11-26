import {useEffect,useRef,useState} from 'react';

// A trusted configured provider or the authenticated project function; no
// unconfigured public routing demo and no invented straight-line "road" path.
const endpoint=(process.env.EXPO_PUBLIC_ROUTING_URL||'').trim().replace(/\/+$/,'');
const cache=new Map();
export function validPoint(p){
  return Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)&&Math.abs(p[0])<=180&&Math.abs(p[1])<=90;
}
export function parseRoadRoute(payload){
  const route=payload?.routes?.[0];
  if(payload?.code!=='Ok'||!route||!Number.isFinite(route.distance)||route.distance<=0||
    !Number.isFinite(route.duration)||route.duration<=0||!Array.isArray(route.geometry?.coordinates)||
    route.geometry.coordinates.length<2||route.geometry.coordinates.length>25000||!route.geometry.coordinates.every(validPoint))return null;
  return {status:'ready',distanceKm:route.distance/1000,durationMin:route.duration/60,coordinates:route.geometry.coordinates};
}

export function useRoadRoute(pickup,destination,db){
  const [result,setResult]=useState({status:'idle',key:''});
  const [retry,setRetry]=useState(0);const generation=useRef(0);
  const [a,b]=pickup||[],[c,d]=destination||[];
  const key=[a,b,c,d].join(',');
  const reload=()=>{cache.delete(key);setRetry(v=>v+1);};
  useEffect(()=>{
    const id=++generation.current;
    if(!validPoint([a,b])||!validPoint([c,d])){setResult({status:'idle',key});return;}
    const hit=cache.get(key);
    if(hit&&Date.now()-hit.at<5*60*1000){setResult({...hit.route,key});return;}
    const controller=new AbortController();
    const current=()=>generation.current===id;
    setResult({status:'loading',key});
    const timeout=setTimeout(()=>controller.abort(),8500);
    const timer=setTimeout(async()=>{
      try{
        let payload;
        if(endpoint.startsWith('https://')){
          const response=await fetch(endpoint+'/route/v1/driving/'+a+','+b+';'+c+','+d+'?overview=full&geometries=geojson',{signal:controller.signal});
          if(!response.ok)throw Error('routing unavailable');payload=await response.json();
        }else if(db){
          const {data,error}=await db.functions.invoke('arkab-road-route',{body:{pickup:[a,b],destination:[c,d]},signal:controller.signal});
          if(error)throw error;payload=data;
        }else {if(current())setResult({status:'unconfigured',key});return;}
        const route=parseRoadRoute(payload);if(!route)throw Error('invalid route');
        if(current()){
          cache.set(key,{route,at:Date.now()});if(cache.size>16)cache.delete(cache.keys().next().value);
          setResult({...route,key});
        }
      }catch{if(current())setResult({status:'unavailable',key});}
      finally{clearTimeout(timeout);}
    },350);
    return ()=>{generation.current++;clearTimeout(timer);clearTimeout(timeout);controller.abort();};
  },[a,b,c,d,key,db,retry]);
  const value=result.key===key?result:{status:validPoint(pickup)&&validPoint(destination)?'loading':'idle',key};
  return {...value,reload};
}
