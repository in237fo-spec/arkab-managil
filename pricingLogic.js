// SDG amounts. Arabic and Eastern Arabic numerals are supported without
// silently interpreting thousands separators, scientific notation or blanks.
export function parseFare(value,allowZero=false){
  const raw=String(value??'').trim()
    .replace(/[٠-٩]/g,d=>String(d.charCodeAt(0)-0x660))
    .replace(/[۰-۹]/g,d=>String(d.charCodeAt(0)-0x6f0))
    .replace(/٫/g,'.');
  if(!/^\d+(?:\.\d{1,2})?$/.test(raw))return null;
  const num=Number(raw);
  return Number.isFinite(num)&&num<=1e9&&(allowZero?num>=0:num>0)?num:null;
}

export function estimateFare(pricing,kind,distance){
  const rate=Array.isArray(pricing)?pricing.find(row=>row.vehicle_kind===kind&&row.active!==false):null;
  if(!rate||typeof distance!=='number'||!Number.isFinite(distance)||distance<0)return null;
  const base=parseFare(rate.base_fare,true),perKm=parseFare(rate.per_km,true);
  if(base===null||perKm===null)return null;
  const value=Math.ceil(base+distance*perKm);
  return Number.isFinite(value)&&value>0&&value<=1e9?value:null;
}
