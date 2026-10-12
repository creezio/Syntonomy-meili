import {readFile,writeFile} from 'node:fs/promises';
const c=JSON.parse(await readFile('/run/migration-source.json','utf8'));
const host='http://meilisearch:7700';
async function api(path,method='GET'){const r=await fetch(host+path,{method,headers:{Authorization:'Bearer '+c.key},signal:AbortSignal.timeout(60000)});const v=await r.json();if(!r.ok)throw Error(path+' '+r.status+' '+v.code);return v;}
const summary=await api('/dumps','POST');
await writeFile('/migration/backup-task.json',JSON.stringify(summary));
console.log(JSON.stringify({backupTask:summary.taskUid}));
for(let i=0;i<1800;i++){
 const task=await api('/tasks/'+summary.taskUid);
 if(task.status==='succeeded'){const record={taskUid:task.uid,dumpUid:task.details.dumpUid,completedAt:task.finishedAt};await writeFile('/migration/backup.json',JSON.stringify(record,null,2));console.log(JSON.stringify(record));process.exit(0);}
 if(['failed','canceled'].includes(task.status))throw Error('Dump '+task.status+' '+JSON.stringify(task.error));
 await new Promise(r=>setTimeout(r,1000));
}
throw Error('Dump creation timeout');
