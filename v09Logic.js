export const validToken=v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
export const trackingViewer=(process.env.EXPO_PUBLIC_TRACKING_VIEWER_URL||'').trim();
export function makeTrackingLink(base,token){
  if(!validToken(token))return null;
  try{const url=new URL(base);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)return null;url.hash=token;return url.toString();}
  catch{return null;}
}
export const shareReady=()=>!!makeTrackingLink(trackingViewer,'a'.repeat(64));

export const supportCategories={
  ride:'مشكلة في الرحلة',fare:'الأجرة والدفع',technical:'مشكلة تقنية',safety:'السلامة',other:'أخرى'
};
export const supportStatuses={open:'جديدة',in_review:'قيد المعالجة',resolved:'تم الحل'};
export function validateTicket(category,body){
  return Object.prototype.hasOwnProperty.call(supportCategories,category)&&typeof body==='string'&&body.trim().length>=5&&body.trim().length<=1500;
}

