import {readFile,writeFile} from 'node:fs/promises';
const c=JSON.parse(await readFile('/run/migration-source.json','utf8'));
async function api(host,path,method='GET',body){const r=await fetch(host+path,{method,headers:{Authorization:'Bearer '+c.key,'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});const v=await r.json();if(!r.ok)throw Error(path+' '+r.status+' '+v.code);return v;}
const rules=await api(c.host,'/dynamic-search-rules','POST',{limit:10000});
await writeFile('/migration/source-search-rules.json',JSON.stringify(rules));
for(const rule of rules.results){const {uid,createdAt,updatedAt,...body}=rule;await api('http://meilisearch:7700','/dynamic-search-rules/'+encodeURIComponent(uid),'PATCH',body);}
console.log(JSON.stringify({searchRulesCopied:rules.total}));
