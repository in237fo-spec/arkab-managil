// Serialize refreshes per account; coalesce bursts into one follow-up read.
// Reset detaches pending work on account change. The caller independently
// guards all state writes against its current account and refresh sequence.
export function createRefreshQueue(){
  let active=null;
  return {
    request(owner,work){
      if(active?.owner===owner){
        active.pending=true;
        active.work=work;
        return active.promise;
      }
      const entry={owner,work,pending:false,promise:null};
      active=entry;
      entry.promise=Promise.resolve().then(async()=>{
        try {
          do {
            entry.pending=false;
            if(active!==entry)break;
            await entry.work();
          } while(active===entry&&entry.pending);
        } finally {
          if(active===entry)active=null;
        }
      });
      return entry.promise;
    },
    isRunning(owner){return active?.owner===owner;},
    reset(){active=null;}
  };
}
