import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
let state=JSON.parse(await readFile('/migration/state.json','utf8'));
while(state.status==='running'){await new Promise(resolve=>setTimeout(resolve,5000));state=JSON.parse(await readFile('/migration/state.json','utf8'));}
if(state.status!=='complete')throw Error('Migration incomplete: '+state.error);
const c=JSON.parse(await readFile('/run/migration-source.json','utf8'));
const local='http://meilisearch:7700';
async function api(host,path){const r=await fetch(host+path,{headers:{Authorization:'Bearer '+c.key},signal:AbortSignal.timeout(60000)});const v=await r.json();if(!r.ok)throw Error(path+' '+r.status);return v;}
const stable=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const hash=v=>createHash('sha256').update(stable(v)).digest('hex');
const [sourceIndexes,destinationIndexes]=await Promise.all([api(c.host,'/indexes?limit=1000'),api(local,'/indexes?limit=1000')]);
const sourceNames=sourceIndexes.results.map(i=>i.uid).sort();const destinationNames=destinationIndexes.results.map(i=>i.uid).sort();
if(stable(sourceNames)!==stable(destinationNames))throw Error('Index set mismatch');
const destinationMetadata=new Map(destinationIndexes.results.map(i=>[i.uid,i]));
let position=0;const report={createdAt:new Date().toISOString(),source:c.host,destination:'https://meili.tempoflow.fr',indexes:[],status:'running'};
await Promise.all(Array.from({length:4},async()=>{
 while(position<sourceIndexes.results.length){
  const index=sourceIndexes.results[position++];const path='/indexes/'+encodeURIComponent(index.uid);
  if(index.primaryKey!==destinationMetadata.get(index.uid)?.primaryKey)throw Error('Primary key mismatch '+index.uid);
  const [ss,ds,sourceSettings,destinationSettings,sourceDocuments,destinationDocuments]=await Promise.all([api(c.host,path+'/stats'),api(local,path+'/stats'),api(c.host,path+'/settings'),api(local,path+'/settings'),api(c.host,path+'/documents?limit=5&retrieveVectors=true'),api(local,path+'/documents?limit=5&retrieveVectors=true')]);
  if(ss.numberOfDocuments!==ds.numberOfDocuments||hash(ss.fieldDistribution)!==hash(ds.fieldDistribution)||ss.numberOfEmbeddings!==ds.numberOfEmbeddings||hash(sourceSettings)!==hash(destinationSettings)||hash(sourceDocuments.results)!==hash(destinationDocuments.results))throw Error('Audit mismatch '+index.uid);
  report.indexes.push({uid:index.uid,documents:ds.numberOfDocuments,embeddings:ds.numberOfEmbeddings,settingsHash:hash(destinationSettings),sampleHash:hash(destinationDocuments.results)});
  if(report.indexes.length%100===0)console.log(JSON.stringify({auditedIndexes:report.indexes.length}));
 }
}));
const [sk,dk]=await Promise.all([api(c.host,'/keys?limit=1000'),api(local,'/keys?limit=1000')]);
const active=sk.results.filter(k=>!k.expiresAt||new Date(k.expiresAt)>new Date());
for(const key of active){const dest=dk.results.find(k=>k.uid===key.uid);if(!dest||dest.key!==key.key||hash(dest.actions)!==hash(key.actions)||hash(dest.indexes)!==hash(key.indexes)||dest.expiresAt!==key.expiresAt)throw Error('Key audit mismatch '+key.uid);}
report.status='passed';report.indexCount=report.indexes.length;report.documents=report.indexes.reduce((n,i)=>n+i.documents,0);report.activeKeys=active.length;
await writeFile('/migration/audit.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({status:report.status,indexCount:report.indexCount,documents:report.documents,activeKeys:report.activeKeys}));
