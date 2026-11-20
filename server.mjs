import {gzipSync} from 'node:zlib';
// Keep the legacy SQLite path only for the bundled offline mock tests.
const {handleCommerce,reconcilePendingOrders}=await import(process.env.NLG_TEST_SQLITE==='YES'?'./commerce.mjs':'./commerce-pg.mjs');
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const gzipCache=new Map();
const PORT=Number(process.env.PORT||3000);
const ROOT=process.cwd();
const json=(res,code,obj)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(obj));};
const types={'.html':'text/html; charset=utf-8','.js':'application/javascript','.mjs':'text/javascript','.css':'text/css','.webp':'image/webp','.png':'image/png','.ico':'image/x-icon','.svg':'image/svg+xml'};

const nlgSpeedGames161126=[
 ['celeste','Celeste','celeste'],['hollowknight','Hollow Knight','hollowknight'],['silksong','Hollow Knight: Silksong','silksong'],
 ['smo','Super Mario Odyssey','marioodyssey'],['mc','Minecraft: Java Edition','minecraft'],['gtav','Grand Theft Auto V','gtav'],
 ['sm64','Super Mario 64','supermario64'],['cuphead','Cuphead','cuphead'],['portal','Portal','portal'],
 ['mkw','Mario Kart World','mariokartworld'],['hades2','Hades II','hades2'],['stardew_valley','Stardew Valley','stardew'],
 ['balatro','Balatro','balatro'],['eldenring','Elden Ring','eldenring'],['dkb','Donkey Kong Bananza','donkeykongbananza']
];
let nlgSpeedCache161126={expires:0,records:[]},nlgSpeedWork161126=null;
const nlgSpeedLink161126=url=>{try{let x=new URL(String(url));return x.protocol==='https:'?x.href:''}catch{return ''}};
async function nlgSpeedFetch161126(pathname,timeout=7300){
 const u='https://www.speedrun.com/api/v1/'+pathname;
 const timer=AbortSignal.timeout(timeout);
 const r=await fetch(u,{signal:timer,headers:{'Accept':'application/json','User-Agent':'NextLevelGamingNews/1.0 (public leaderboard reader)'}});
 if(!r.ok)throw Error('speedrun upstream: '+r.status);
 return (await r.json())?.data;
}
function nlgSpeedFmt161126(seconds){
 const ms=Math.round(Number(seconds)*1000);if(!Number.isFinite(ms)||ms<=0)return '';
 const n=Math.floor(ms/1000),h=Math.floor(n/3600),m=Math.floor(n%3600/60),sec=n%60,millis=ms%1000;
 return(h?h+':':'')+(h?String(m).padStart(2,'0'):m)+':'+String(sec).padStart(2,'0')+(millis?'.'+String(millis).padStart(3,'0'):'');
}
function nlgSpeedMainTime161126(run,timing){const t=run?.times||{};return Number((timing==='ingame'&&t.ingame_t)||(timing==='realtime_noloads'&&t.realtime_noloads_t)||t.primary_t||t.realtime_t||0)}
function nlgSpeedPlayer161126(board,run){
 const user=run?.players?.[0];if(!user)return 'Participante verificado';
 if(user.rel==='guest')return String(user.name||'Participante verificado');
 const list=Array.isArray(board?.players?.data)?board.players.data:Array.isArray(board?.players)?board.players:[];
 const match=list.find(p=>p.id===user.id);return String(match?.names?.international||match?.name||user.name||'Participante verificado').slice(0,80);
}
async function nlgSpeedOneGame161126(item){
 const [gameId,gameName,key]=item;const data=await nlgSpeedFetch161126('games/'+encodeURIComponent(gameId)+'/records?top=2&scope=full-game&miscellaneous=no&skip-empty=true&embed=players',11000);
 if(!Array.isArray(data))return [];
 const cutoff=Date.now()-95*24*3600000;
 const candidates=data.filter(x=>x&&Array.isArray(x.runs)).flatMap(board=>{
 const top=board.runs.find(x=>x.place===1)?.run;if(!top?.date||!top?.videos?.links?.length)return [];
 const d=new Date(top.date+'T12:00:00Z');if(d.getTime()<cutoff||d.getTime()>Date.now())return [];
 return [{board,run:top,date:top.date}];
 }).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,3);
 const records=[];
 for(const {board,run,date} of candidates){
 try{
 const start=new Date(date+'T00:00:00Z');start.setUTCDate(start.getUTCDate()-1);
 const before=start.toISOString().slice(0,10);
 let cat=board.category?.data?.id||board.category?.id||board.category;
 if(typeof cat!=='string'||!cat)continue;
 const params=new URLSearchParams({top:'1',date:before});
 for(const [v,x] of Object.entries(run.values||{}))if(/^[-\w]{4,20}$/.test(v)&&/^[-\w]{4,20}$/.test(String(x)))params.set('var-'+v,String(x));
 const old=await nlgSpeedFetch161126('leaderboards/'+encodeURIComponent(gameId)+'/category/'+encodeURIComponent(cat)+'?'+params,9000);
 const older=old?.runs?.find(x=>x.place===1)?.run;if(!older)continue;
 if(JSON.stringify(older.values||{})!==JSON.stringify(run.values||{}))continue;
 const sec=nlgSpeedMainTime161126(run,board.timing),prev=nlgSpeedMainTime161126(older,board.timing);
 if(!(sec>0&&prev>sec))continue;
 const catData=await nlgSpeedFetch161126('categories/'+encodeURIComponent(cat),8500).catch(()=>null);
 if(!catData?.name)continue;
 const video=nlgSpeedLink161126(run.videos?.links?.[0]?.uri);
 const source=nlgSpeedLink161126(run.weblink);
 if(!video||!source)continue;
 records.push({game:gameName,key,category:String(catData.name).slice(0,100),player:nlgSpeedPlayer161126(board,run),date,time:nlgSpeedFmt161126(sec),previous:nlgSpeedFmt161126(prev),diff:nlgSpeedFmt161126(prev-sec),video,source});
 }catch{}
 }
 return records;
}
async function nlgSpeedRecordSearch161126(){
 if(nlgSpeedCache161126.expires>Date.now())return nlgSpeedCache161126.records;
 if(nlgSpeedWork161126)return nlgSpeedWork161126;
 nlgSpeedWork161126=(async()=>{
 const found=[];
 for(let i=0;i<nlgSpeedGames161126.length;i+=3){
 const group=await Promise.allSettled(nlgSpeedGames161126.slice(i,i+3).map(nlgSpeedOneGame161126));
 for(const r of group)if(r.status==='fulfilled')found.push(...r.value);
 if(found.length>=22)break;
 }
 found.sort((a,b)=>b.date.localeCompare(a.date));
 nlgSpeedCache161126={expires:Date.now()+90*60000,records:found.slice(0,30)};
 return nlgSpeedCache161126.records;
 })().finally(()=>{nlgSpeedWork161126=null});
 return nlgSpeedWork161126;
}

const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
 if(await handleCommerce(req,res,url))return;
 if(url.pathname==='/api/nlg-records'&&req.method==='GET'){try{return json(res,200,{records:await nlgSpeedRecordSearch161126(),source:'speedrun.com',verifiedAt:new Date().toISOString()})}catch{return json(res,503,{error:'No se pudo consultar speedrun.com.',records:[]})}}
 if(url.pathname.startsWith('/api/'))return json(res,404,{error:'API no encontrada'});
 const rel=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));if(!(/^assets\/[\w.\-]+$/.test(rel)||rel==='index.html'))return json(res,404,{error:'Archivo no encontrado'});
 const file=path.join(ROOT,rel);fs.readFile(file,(err,bytes)=>{if(err)return json(res,404,{error:'Archivo no encontrado'});
 const headers={'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':rel==='index.html'?'no-cache':'public, max-age=86400','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','X-Frame-Options':'SAMEORIGIN','Permissions-Policy':'camera=(),microphone=(),geolocation=()','Vary':'Accept-Encoding'};
 if(/gzip/.test(req.headers['accept-encoding']||'')&&bytes.length>2048&&/\.(html|js|mjs|css|svg)$/.test(file)){
  const key=file+':'+bytes.length;let compressed=gzipCache.get(key);if(!compressed){compressed=gzipSync(bytes,{level:6});gzipCache.set(key,compressed);if(gzipCache.size>25)gzipCache.delete(gzipCache.keys().next().value)}
  headers['Content-Encoding']='gzip';res.writeHead(200,headers);res.end(compressed);
 }else{res.writeHead(200,headers);res.end(bytes)}
})
});
server.listen(PORT,'0.0.0.0',()=>console.log('NextLevel Gaming News activo en puerto '+PORT));
const pendingTimer=setInterval(()=>reconcilePendingOrders().catch(e=>console.warn('[paypal scan]',e.message)),5*60*1000);
pendingTimer.unref?.();
