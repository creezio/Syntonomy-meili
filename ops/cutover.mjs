import {readFile,writeFile} from 'node:fs/promises';
const state=JSON.parse(await readFile('/migration/state.json','utf8'));
if(state.status!=='complete')throw Error('Migration not complete');
const audit=JSON.parse(await readFile('/migration/audit.json','utf8'));if(audit.status!=='passed')throw Error('Migration audit not passed');
const c=JSON.parse(await readFile('/run/migration-source.json','utf8'));
const headers={Authorization:'Bearer '+c.key,'Content-Type':'application/json'};
const response=await fetch('http://meilisearch:7700/keys?limit=1000',{headers});const keys=await response.json();if(!response.ok)throw Error('Local keys unavailable');
const name='Syntonomy Meili administrator';let key=keys.results.find(k=>k.name===name&&k.actions.includes('*')&&k.indexes.includes('*')&&!k.expiresAt);
if(!key){const created=await fetch('http://meilisearch:7700/keys',{method:'POST',headers,body:JSON.stringify({name,description:'Private Syntonomy dashboard on TempoFlow VPS',actions:['*'],indexes:['*'],expiresAt:null})});key=await created.json();if(!created.ok)throw Error('Dashboard admin key unavailable');}
await writeFile('/runtime/environment','NUXT_MEILISEARCH_HOST=http://meilisearch:7700\nNUXT_MEILISEARCH_API_KEY='+key.key+'\nNUXT_MEILISEARCH_SINGLE_INSTANCE_PROXY_MODE=true\n',{mode:0o600});
console.log(JSON.stringify({dashboardKeyUid:key.uid,localHost:'http://meilisearch:7700',indexes:state.indexCount,documents:state.documents}));
