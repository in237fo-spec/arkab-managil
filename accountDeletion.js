// Shared intake API. A request does not mean an account is already deleted.
export async function readDeletionRequest(db,owner){
  if(!owner)throw Error('يلزم تسجيل الدخول');
  const {data,error}=await db.from('account_deletion_requests')
    .select('requested_at,status').eq('user_id',owner).maybeSingle();
  if(error)throw error;
  return data;
}
export async function submitDeletionRequest(db,owner){
  if(!owner)throw Error('يلزم تسجيل الدخول');
  const {error}=await db.from('account_deletion_requests').insert({user_id:owner});
  if(error&&error.code!=='23505')throw error;
  const record=await readDeletionRequest(db,owner);
  if(!record)throw Error('تعذر تأكيد تسجيل الطلب');
  return record;
}
