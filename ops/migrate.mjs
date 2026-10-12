import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const config=JSON.parse(await readFile('/run/migration-source.json','utf8'));
const target='http://meilisearch:7700';
const stateDir='/migration';await mkdir(stateDir,{recursive:true});
let state;try{state=JSON.parse(await readFile(stateDir+'/state.json','utf8'));}catch(e){if(e.code!=='ENOENT')throw e;state={startedAt:new Date().toISOString(),indexes:{},status:'running'};}
state.status='running';delete state.error;
let writes=Promise.resolve();
function save(){const value=JSON.stringify(state,null,2);writes=writes.then(async()=>{await writeFile(stateDir+'/state.tmp',value);await rename(stateDir+'/state.tmp',stateDir+'/state.json');});return writes;}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function api(host,path,method='GET',body){
 for(let attempt=0;attempt<5;attempt++){
  try{
   const response=await fetch(host+path,{method,headers:{Authorization:'Bearer '+config.key,'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(120000)});
   const value=await response.json();if(response.ok)return value;
   if([429,500,502,503,504].includes(response.status)&&attempt<4){await sleep(1000*(attempt+1));continue;}
   const e=Error(method+' '+path+' HTTP '+response.status+' '+(value.code||''));e.status=response.status;e.data=value;throw e;
  }catch(e){if(e.status||attempt===4)throw e;await sleep(1000*(attempt+1));}
 }
}
async function task(summary){
 if(summary.taskUid===undefined)return summary;
 for(let i=0;i<2400;i++){
  const value=await api(target,'/tasks/'+summary.taskUid);
  if(value.status==='succeeded')return value;
  if(['failed','canceled'].includes(value.status))throw Error('Task '+summary.taskUid+' '+JSON.stringify(value.error));
  await sleep(i<10?100:500);
 }
 throw Error('Task timeout '+summary.taskUid);
}
const stable=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const hash=value=>createHash('sha256').update(stable(value)).digest('hex');
async function index(uid){
 const path='/indexes/'+encodeURIComponent(uid);
 let record=state.indexes[uid]||{offset:0};state.indexes[uid]=record;
 const sourceInfo=await api(config.host,path);
 const stats=await api(config.host,path+'/stats');
 if(record.done&&record.sourceUpdatedAt===sourceInfo.updatedAt&&record.documents===stats.numberOfDocuments)return;
 const settings=await api(config.host,path+'/settings');
 await mkdir(stateDir+'/settings',{recursive:true});await writeFile(stateDir+'/settings/'+uid+'.json',JSON.stringify(settings));
 let targetInfo;try{targetInfo=await api(target,path);}catch(e){if(e.status!==404)throw e;await task(await api(target,'/indexes','POST',{uid,...(sourceInfo.primaryKey?{primaryKey:sourceInfo.primaryKey}:{})}));record.offset=0;}
 if(record.sourceUpdatedAt&&record.sourceUpdatedAt!==sourceInfo.updatedAt){await task(await api(target,path+'/documents','DELETE'));record.offset=0;record.done=false;record.settingsApplied=false;}
 record.sourceUpdatedAt=sourceInfo.updatedAt;
 record.total=stats.numberOfDocuments;
 if(!record.settingsApplied){await task(await api(target,path+'/settings','PATCH',settings));record.settingsApplied=true;}
 await save();
 while(record.offset<record.total){
  const batch=await api(config.host,path+'/documents?limit=5000&offset='+record.offset+'&retrieveVectors=true');
  if(!batch.results.length)throw Error('Unexpected empty document page '+uid+' '+record.offset);
  await task(await api(target,path+'/documents','POST',batch.results));
  record.offset+=batch.results.length;record.updatedAt=new Date().toISOString();await save();
  if(record.total>50000)console.log(JSON.stringify({index:uid,documents:record.offset,total:record.total}));
 }
 const [destinationStats,destinationSettings,sourceAfter]=await Promise.all([api(target,path+'/stats'),api(target,path+'/settings'),api(config.host,path)]);
 if(sourceAfter.updatedAt!==sourceInfo.updatedAt){record.done=false;await save();console.log(JSON.stringify({changedDuringCopy:uid}));return;}
 if(destinationStats.numberOfDocuments!==record.total)throw Error('Document count mismatch '+uid);
 if(hash(settings)!==hash(destinationSettings))throw Error('Settings mismatch '+uid);
 record.documents=destinationStats.numberOfDocuments;record.settingsHash=hash(settings);record.done=true;record.completedAt=new Date().toISOString();await save();
 const complete=Object.values(state.indexes).filter(x=>x.done).length;
 if(complete%20===0||record.total>50000)console.log(JSON.stringify({completedIndexes:complete,lastIndex:uid,documents:record.documents}));
}
try{
 const version=await api(config.host,'/version');const localVersion=await api(target,'/version');
 if(version.pkgVersion!==localVersion.pkgVersion)throw Error('Engine version mismatch');
 state.sourceVersion=version.pkgVersion;
 const keys=await api(config.host,'/keys?limit=1000');await writeFile(stateDir+'/source-keys.json',JSON.stringify(keys));
 const localKeys=await api(target,'/keys?limit=1000');
 for(const key of keys.results){
  if(key.expiresAt&&new Date(key.expiresAt)<=new Date())continue;
  let migrated=localKeys.results.find(k=>k.uid===key.uid);
  if(!migrated)migrated=await api(target,'/keys','POST',{uid:key.uid,name:key.name,description:key.description,actions:key.actions,indexes:key.indexes,expiresAt:key.expiresAt});
  if(migrated.key!==key.key)throw Error('API key derivation mismatch '+key.uid);
 }
 state.keyCount=keys.results.filter(k=>!k.expiresAt||new Date(k.expiresAt)>new Date()).length;
 state.archivedExpiredKeys=keys.results.length-state.keyCount;
 const features=await api(config.host,'/experimental-features');await writeFile(stateDir+'/experimental-features.json',JSON.stringify(features));await api(target,'/experimental-features','PATCH',features);
 for(let pass=0;pass<4;pass++){
  const list=await api(config.host,'/indexes?limit=1000');state.sourceIndexCount=list.total;await save();
  let position=0;
  const rows=list.results.sort((a,b)=>a.uid.localeCompare(b.uid));
  await Promise.all(Array.from({length:3},async()=>{while(position<rows.length){const current=rows[position++];await index(current.uid);}}));
  const [cloudStats,localStats]=await Promise.all([api(config.host,'/stats'),api(target,'/stats')]);
  const differences=Object.entries(cloudStats.indexes).filter(([uid,s])=>!localStats.indexes[uid]||s.numberOfDocuments!==localStats.indexes[uid].numberOfDocuments||!state.indexes[uid]?.done);
  for(const [uid] of differences){state.indexes[uid]||={offset:0};state.indexes[uid].done=false;state.indexes[uid].sourceUpdatedAt='changed';}
  if(!differences.length&&Object.keys(cloudStats.indexes).length===Object.keys(localStats.indexes).length){
   state.status='complete';state.completedAt=new Date().toISOString();state.indexCount=Object.keys(localStats.indexes).length;state.documents=Object.values(localStats.indexes).reduce((n,s)=>n+s.numberOfDocuments,0);state.databaseSize=localStats.databaseSize;await save();
   console.log(JSON.stringify({status:state.status,indexes:state.indexCount,documents:state.documents,keys:state.keyCount,databaseSize:state.databaseSize}));process.exit(0);
  }
  console.log(JSON.stringify({reconciliationPass:pass+1,changedIndexes:differences.map(([uid])=>uid)}));await save();
 }
 throw Error('Source continued changing during migration');
}catch(e){state.status='failed';state.error=e.message;await save();console.error(e.message);process.exit(1);}
