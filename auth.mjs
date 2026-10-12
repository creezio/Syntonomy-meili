import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {createHmac,createHash,timingSafeEqual,randomBytes} from 'node:crypto';
const login=JSON.parse(await readFile('/run/dashboard-login.json','utf8'));
const signing=createHash('sha256').update('syntonomy-session:'+login.password).digest();
const digest=value=>createHash('sha256').update(value).digest();
const equal=(a,b)=>timingSafeEqual(digest(a),digest(b));
const attempts=new Map();
const cookieName='syntonomy_meili_session';
function session(request){
 const cookie=(request.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);
 if(cookie){try{const [payload,signature]=cookie.split('.');const expected=createHmac('sha256',signing).update(payload).digest('base64url');if(signature&&equal(signature,expected)){const value=JSON.parse(Buffer.from(payload,'base64url').toString());if(value.u===login.username&&value.e>Date.now())return true;}}catch{}}
 const header=request.headers.authorization||'';
 if(header.startsWith('Basic ')){const value=Buffer.from(header.slice(6),'base64').toString();return equal(value,login.username+':'+login.password);}
 return false;
}
const page=error=>`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connexion — Syntonomy Meili</title><style>body{font:16px system-ui;background:#f4f6fb;color:#17243a;min-height:100vh;display:grid;place-items:center;margin:0}main{background:white;max-width:360px;width:calc(100% - 72px);padding:32px;border-radius:20px;box-shadow:0 12px 50px #17243a12}h1{margin:0 0 8px;font-size:26px}p{color:#697589;line-height:1.5}label{display:block;margin:22px 0 8px;font-size:14px}input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #d5dbe7;border-radius:8px;font:inherit}button{width:100%;margin-top:24px;background:#305dce;color:white;border:0;border-radius:8px;padding:13px;font:600 15px system-ui;cursor:pointer}.error{color:#b42318}</style><main><h1>Syntonomy Meili</h1><p>Administration de votre moteur de recherche.</p>${error?'<p class="error">Identifiant ou mot de passe incorrect.</p>':''}<form method="post" action="/_auth/login"><label for="username">Identifiant</label><input id="username" name="username" autocomplete="username" required><label for="password">Mot de passe</label><input id="password" name="password" type="password" autocomplete="current-password" required><button>Se connecter</button></form></main></html>`;
const server=http.createServer(async(request,response)=>{
 response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('X-Frame-Options','SAMEORIGIN');response.setHeader('Referrer-Policy','same-origin');
 const path=new URL(request.url,'http://localhost').pathname;
 if(path==='/_auth/health'){response.end('ok');return;}
 if(path==='/_auth/login'){
  response.setHeader('Cache-Control','no-store');
  if(request.method==='GET'){response.setHeader('Content-Type','text/html; charset=utf-8');response.end(page(false));return;}
  if(request.method!=='POST'){response.writeHead(405).end();return;}
  if(request.headers.origin&&request.headers.origin!==login.url){response.writeHead(403).end();return;}
  const ip=request.headers['cf-connecting-ip']||request.socket.remoteAddress;
  const window=attempts.get(ip)||{count:0,until:Date.now()+900000};if(window.until<Date.now()){window.count=0;window.until=Date.now()+900000;}
  if(window.count>=10){response.writeHead(429).end('Veuillez réessayer dans quelques minutes.');return;}
  let body='';for await(const chunk of request){body+=chunk;if(body.length>8192){response.writeHead(413).end();return;}}
  const fields=new URLSearchParams(body);
  if(!equal(fields.get('username')||'',login.username)||!equal(fields.get('password')||'',login.password)){window.count++;attempts.set(ip,window);response.writeHead(401,{'Content-Type':'text/html; charset=utf-8'}).end(page(true));return;}
  attempts.delete(ip);
  const payload=Buffer.from(JSON.stringify({u:login.username,e:Date.now()+28800000,n:randomBytes(12).toString('hex')})).toString('base64url');
  const signature=createHmac('sha256',signing).update(payload).digest('base64url');
  response.writeHead(303,{'Set-Cookie':cookieName+'='+payload+'.'+signature+'; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=28800',Location:'/'}).end();return;
 }
 if(!session(request)){if(path.startsWith('/api/'))response.writeHead(401,{'Content-Type':'application/json'}).end('{"error":"authentication_required"}');else response.writeHead(302,{Location:'/_auth/login'}).end();return;}
 if(Number(request.headers['content-length']||0)>104857600){response.writeHead(413).end();return;}
 const headers={...request.headers,host:'syntonomy-meili.tempoflow.fr','x-forwarded-host':'syntonomy-meili.tempoflow.fr','x-forwarded-proto':'https'};delete headers.authorization;delete headers.cookie;
 const upstream=http.request({hostname:'dashboard',port:3000,path:request.url,method:request.method,headers},result=>{response.writeHead(result.statusCode,result.headers);result.pipe(response);});
 upstream.setTimeout(120000,()=>upstream.destroy());
 upstream.on('error',()=>{if(!response.headersSent)response.writeHead(502);response.end('Dashboard temporarily unavailable');});
 request.pipe(upstream);
});
server.listen(8080,'0.0.0.0');
