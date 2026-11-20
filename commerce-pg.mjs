// NextLevel Gaming: PayPal Orders v2 + private Supabase Postgres storage.
// No credentials are shipped in source files. Payments remain disabled by default.
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';

const {Pool}=pg;
const inventory=JSON.parse(readFileSync(new URL('./catalog.json',import.meta.url),'utf8'));
const frames=new Map(inventory.frames.map(x=>[x.id,x]));
const backgrounds=new Map(inventory.backgrounds.map(x=>[x.id,x]));
const hash=x=>createHash('sha256').update(String(x)).digest('hex');
const prices={frame:75,frameGodlike:300,background:125,backgroundGodlike:300,bundle:200,premium:299};
const mode=process.env.PAYPAL_ENV==='live'?'live':'sandbox';
const liveReady=mode!=='live'||(process.env.PAYPAL_LIVE_ENABLED==='YES'&&process.env.PUBLIC_BASE_URL?.startsWith('https://')&&process.env.PAYPAL_MERCHANT_ID&&process.env.PAYPAL_WEBHOOK_ID&&process.env.NODE_ENV==='production');
const storageConfigured=Boolean(process.env.SUPABASE_DB_URL);
const serverConfigured=Boolean(storageConfigured&&process.env.PAYPAL_CLIENT_ID&&process.env.PAYPAL_CLIENT_SECRET&&liveReady);
const paymentsEnabled=Boolean(serverConfigured&&process.env.NLG_COMMERCE_ENABLED==='YES');
const checkoutProvider='paypal-orders-v2';
const api=mode==='live'?'https://api-m.paypal.com':'https://api-m.sandbox.paypal.com';
// Use Supabase's Session pooler connection string (port 5432) for a long-lived Node server.
// The database role must be allowed to access the private nlg_store schema.
function secureDatabaseUrl(raw){const url=new URL(raw);if(!url.searchParams.has('sslmode'))url.searchParams.set('sslmode','require');return url.toString()}
const pool=storageConfigured?new Pool({connectionString:secureDatabaseUrl(process.env.SUPABASE_DB_URL),max:3,idleTimeoutMillis:15000,connectionTimeoutMillis:10000}):null;
pool?.on('error',e=>console.error('[store database idle]',e.message));
const rows=async(sql,values=[],db=pool)=>(await db.query(sql,values)).rows;
const one=async(sql,values=[],db=pool)=>(await rows(sql,values,db))[0]||null;
const now=()=>new Date().toISOString();
const month=()=>new Date().toISOString().slice(0,7);
const time=x=>Number(x||0);
const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const send=(res,code,data)=>{res.writeHead(code,headers);res.end(JSON.stringify(data));};
const fail=(res,code,message)=>send(res,code,{error:message});
const state=()=>({paymentsEnabled,clientId:paymentsEnabled?process.env.PAYPAL_CLIENT_ID:null,mode,provider:checkoutProvider,configured:serverConfigured,requiresPersistentStorage:!storageConfigured,premium:'30 días, pago único sin renovación automática',prices,restoreCodeRequired:true});
async function currentAccount(req){
 const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
 if(!/^nlg_[A-Za-z0-9_-]{43}$/.test(token)||!pool)return null;
 return one('SELECT key_hash,premium_until FROM nlg_store.accounts WHERE key_hash=$1',[hash(token)]);
}
async function safeData(req,limit=16000){
 const parts=[];let size=0;
 for await(const part of req){size+=part.length;if(size>limit)throw Error('Solicitud demasiado grande');parts.push(part)}
 try{return JSON.parse(Buffer.concat(parts).toString('utf8')||'{}')}catch{throw Error('Solicitud JSON inválida')}
}
async function validSelection(kind,ids,account){
 if(!Object.hasOwn(prices,kind))throw Error('Producto inválido');
 if(kind==='premium'){if(ids?.length)throw Error('Premium no usa selección');return []}
 if(!Array.isArray(ids))throw Error('Falta selección');
 const count=kind==='bundle'?5:1;
 if(ids.length!==count||new Set(ids).size!==count)throw Error(`Elegí exactamente ${count} artículos diferentes`);
 const isBg=kind.startsWith('background'),list=isBg?backgrounds:frames;
 for(const id of ids){
  if(typeof id!=='string')throw Error('Artículo inválido');
  const item=list.get(id);if(!item)throw Error('Artículo inexistente o no vendible');
  if(kind==='frame'&&item.rarity==='godlike'||kind==='frameGodlike'&&item.rarity!=='godlike'||kind==='background'&&item.rarity==='godlike'||kind==='backgroundGodlike'&&item.rarity!=='godlike'||kind==='bundle'&&item.rarity==='godlike')throw Error('Artículo fuera de categoría');
  const existing=await one(`SELECT 1 FROM nlg_store.grants g JOIN nlg_store.orders o ON o.id=g.order_id WHERE g.account_hash=$1 AND g.item_type=$2 AND g.item_id=$3 AND o.status='completed' LIMIT 1`,[account.key_hash,isBg?'background':'frame',id]);
  if(existing)throw Error('Ese artículo ya fue comprado');
 }
 return ids;
}
let access={token:'',until:0};
async function paypalToken(){
 if(access.until>Date.now()+30000)return access.token;
 const pair=Buffer.from(process.env.PAYPAL_CLIENT_ID+':'+process.env.PAYPAL_CLIENT_SECRET).toString('base64');
 const r=await fetch(api+'/v1/oauth2/token',{method:'POST',headers:{Authorization:'Basic '+pair,'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials',signal:AbortSignal.timeout(12000)});
 const data=await r.json();if(!r.ok||!data.access_token)throw Error('No fue posible autenticar PayPal');
 access={token:data.access_token,until:Date.now()+Math.max(60,Number(data.expires_in)-60)*1000};return access.token;
}
async function paypalCall(method,url,body,idempotency){
 const token=await paypalToken(),h={Authorization:'Bearer '+token,'Content-Type':'application/json','Prefer':'return=representation'};
 if(idempotency)h['PayPal-Request-Id']=idempotency;
 const r=await fetch(api+url,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(18000)});
 let data={};try{data=await r.json()}catch{}
 if(!r.ok)throw Error('PayPal rechazó la operación ('+r.status+'): '+(data.message||data.name||'revisar cuenta del vendedor'));
 return data;
}
const receipt=(order,premiumUntil=0)=>({orderId:order.id,kind:order.kind,choices:JSON.parse(order.choice_json),total:(order.amount/100).toFixed(2),currency:'USD',status:order.status,premiumUntil:time(premiumUntil)});
function verifyCaptured(data,order){
 if(data.id!==order.paypal_id||data.status!=='COMPLETED')throw Error('Pago no completado');
 if(!Array.isArray(data.purchase_units)||data.purchase_units.length!==1)throw Error('Cantidad de órdenes PayPal inválida');
 const unit=data.purchase_units[0],captures=unit?.payments?.captures||[];
 const capture=captures.find(c=>c.status==='COMPLETED'&&c.amount?.currency_code==='USD'&&c.amount?.value===(order.amount/100).toFixed(2)&&typeof c.id==='string');
 if(!capture||captures.some(c=>c!==capture&&c.status==='COMPLETED'))throw Error('Importe o estado del cobro no coinciden');
 if(mode==='live'&&!process.env.PAYPAL_MERCHANT_ID)throw Error('Falta identidad del vendedor');
 if(process.env.PAYPAL_MERCHANT_ID&&unit.payee?.merchant_id!==process.env.PAYPAL_MERCHANT_ID&&capture?.payee?.merchant_id!==process.env.PAYPAL_MERCHANT_ID)throw Error('Comerciante inesperado');
 if(unit.reference_id!==order.id||unit.custom_id!==order.id)throw Error('Pedido PayPal distinto del seleccionado');
 return capture.id;
}
async function grantOrder(order,captureId){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const stored=await one('SELECT * FROM nlg_store.orders WHERE id=$1 FOR UPDATE',[order.id],db);
  if(!stored)throw Error('Pedido inexistente');
  if(stored.status==='completed'){await db.query('COMMIT');return}
  if(stored.status==='refunded')throw Error('Pago reembolsado');
  await db.query('UPDATE nlg_store.orders SET status=$1,capture_id=$2,updated_at=$3 WHERE id=$4',['completed',captureId,now(),order.id]);
  if(stored.kind==='premium'){
   const acc=await one('SELECT premium_until FROM nlg_store.accounts WHERE key_hash=$1 FOR UPDATE',[stored.account_hash],db);
   const base=Math.max(Date.now(),time(acc.premium_until));
   await db.query('UPDATE nlg_store.accounts SET premium_until=$1 WHERE key_hash=$2',[base+30*86400000,stored.account_hash]);
  }else{
   for(const id of JSON.parse(stored.choice_json))await db.query('INSERT INTO nlg_store.grants(account_hash,item_type,item_id,order_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[stored.account_hash,stored.kind.startsWith('background')?'background':'frame',id,stored.id]);
  }
  await db.query('COMMIT');
 }catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}
}
async function retrievePayPalOrder(order){if(!order.paypal_id)throw Error('Pedido PayPal incompleto');return paypalCall('GET','/v2/checkout/orders/'+encodeURIComponent(order.paypal_id))}
async function reconcilePayPalOrder(order,captureApproved=false){
 if(order.status==='completed'||order.status==='refunded')return order;
 let upstream=await retrievePayPalOrder(order);
 if(upstream.status==='APPROVED'&&captureApproved){
  try{upstream=await paypalCall('POST','/v2/checkout/orders/'+encodeURIComponent(order.paypal_id)+'/capture',{},order.id+'-capture')}
  catch(error){try{upstream=await retrievePayPalOrder(order)}catch{throw error}if(upstream.status!=='COMPLETED')throw error}
 }
 if(upstream.status==='COMPLETED'){await grantOrder(order,verifyCaptured(upstream,order));return one('SELECT * FROM nlg_store.orders WHERE id=$1',[order.id])}
 return order;
}
export async function reconcilePendingOrders(){
 if(!paymentsEnabled||!pool)return;
 const recent=await rows("SELECT * FROM nlg_store.orders WHERE status='pending' AND paypal_id IS NOT NULL AND created_at >= $1 ORDER BY created_at LIMIT 20",[new Date(Date.now()-24*3600000).toISOString()]);
 for(const o of recent)try{await reconcilePayPalOrder(o,true)}catch(e){console.warn('[paypal reconcile]',o.id,e.message)}
}
async function currentEntitlements(account){
 const [active,record,history]=await Promise.all([
  rows("SELECT DISTINCT g.item_type,g.item_id FROM nlg_store.grants g JOIN nlg_store.orders o ON o.id=g.order_id WHERE g.account_hash=$1 AND o.status='completed'",[account.key_hash]),
  one('SELECT premium_until FROM nlg_store.accounts WHERE key_hash=$1',[account.key_hash]),
  rows('SELECT * FROM nlg_store.orders WHERE account_hash=$1 ORDER BY created_at DESC LIMIT 100',[account.key_hash])
 ]);
 const premiumUntil=time(record?.premium_until);
 return {frames:active.filter(x=>x.item_type==='frame').map(x=>x.item_id),backgrounds:active.filter(x=>x.item_type==='background').map(x=>x.item_id),premiumUntil,orders:history.map(o=>receipt(o,premiumUntil))};
}
async function refundOrder(order,event){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const stored=await one('SELECT * FROM nlg_store.orders WHERE id=$1 FOR UPDATE',[order.id],db);
  if(!stored||stored.status!=='completed'){await db.query('COMMIT');return}
  const reversed=event.event_type==='PAYMENT.CAPTURE.REVERSED';
  if(!reversed&&event.resource?.id&&event.resource?.amount?.currency_code==='USD'){
   const cents=Math.round(Number(event.resource.amount.value)*100);
   if(Number.isSafeInteger(cents)&&cents>0)await db.query('INSERT INTO nlg_store.refunds(refund_id,order_id,amount_cents,received_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[event.resource.id,stored.id,cents,now()]);
  }
  const total=await one('SELECT COALESCE(SUM(amount_cents),0) AS amount FROM nlg_store.refunds WHERE order_id=$1',[stored.id],db);
  if(reversed||Number(total.amount)>=stored.amount){
   await db.query('UPDATE nlg_store.orders SET status=$1,updated_at=$2 WHERE id=$3',['refunded',now(),stored.id]);
   if(stored.kind==='premium'){
    const a=await one('SELECT premium_until FROM nlg_store.accounts WHERE key_hash=$1 FOR UPDATE',[stored.account_hash],db);
    const list=await rows("SELECT created_at FROM nlg_store.orders WHERE account_hash=$1 AND kind='premium' AND status='completed' ORDER BY created_at",[stored.account_hash],db);
    let until=0;for(const o of list)until=Math.max(Date.parse(o.created_at),until)+30*86400000;
    await db.query('UPDATE nlg_store.accounts SET premium_until=$1 WHERE key_hash=$2',[until,stored.account_hash]);
   }
  }
  await db.query('COMMIT');
 }catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}
}
export async function handleCommerce(req,res,url){
 if(!url.pathname.startsWith('/api/store/'))return false;
 const p=url.pathname;
 try{
  if(req.method==='GET'&&p==='/api/store/status'){send(res,200,state());return true}
  if(req.method==='GET'&&p==='/api/store/storage'){
   if(!pool)return fail(res,503,'Supabase aún no está conectado'),true;
   try{await one('SELECT 1 FROM nlg_store.accounts LIMIT 1');send(res,200,{storage:'supabase-postgres',connected:true})}
   catch(e){console.error('[store database]',e.message);fail(res,503,'No se pudo conectar a las tablas privadas de Supabase')}
   return true;
  }
  if(req.method==='GET'&&p==='/api/store/connection'){
   if(!serverConfigured)return fail(res,503,'Faltan credenciales de PayPal o conexión con Supabase'),true;
   try{await one('SELECT 1 FROM nlg_store.accounts LIMIT 1');await paypalToken();send(res,200,{provider:checkoutProvider,mode,connectedToPayPal:true,checkoutEnabled:paymentsEnabled})}
   catch(e){console.error('[paypal connection]',e.message);fail(res,502,'No se pudo comprobar la conexión a PayPal y Supabase')}
   return true;
  }
  if(req.method==='POST'&&p==='/api/store/account'){
   if(!pool)return fail(res,503,'Falta configurar Supabase'),true;
   const code='nlg_'+randomBytes(32).toString('base64url');
   await pool.query('INSERT INTO nlg_store.accounts(key_hash,created_at) VALUES($1,$2)',[hash(code),now()]);
   send(res,201,{recoveryCode:code,warning:'Guardá este código fuera del navegador: es la única forma de recuperar tus compras.'});return true;
  }
  if(req.method==='POST'&&p==='/api/store/webhook'){
   if(!paymentsEnabled||!process.env.PAYPAL_WEBHOOK_ID)return fail(res,503,'Webhooks no configurados'),true;
   const event=await safeData(req,120000);
   const proof={auth_algo:req.headers['paypal-auth-algo'],cert_url:req.headers['paypal-cert-url'],transmission_id:req.headers['paypal-transmission-id'],transmission_sig:req.headers['paypal-transmission-sig'],transmission_time:req.headers['paypal-transmission-time'],webhook_id:process.env.PAYPAL_WEBHOOK_ID,webhook_event:event};
   if(Object.values(proof).some(x=>!x))return fail(res,400,'Firma de webhook incompleta'),true;
   const result=await paypalCall('POST','/v1/notifications/verify-webhook-signature',proof);
   if(result.verification_status!=='SUCCESS')return fail(res,403,'Firma de webhook inválida'),true;
   if(event.event_type==='CHECKOUT.ORDER.APPROVED'){
    const id=event.resource?.id;
    const order=id&&await one('SELECT * FROM nlg_store.orders WHERE paypal_id=$1',[id]);
    if(order?.status==='pending')await reconcilePayPalOrder(order,true);
   }else if(event.event_type==='PAYMENT.CAPTURE.COMPLETED'){
    const id=event.resource?.supplementary_data?.related_ids?.order_id;
    const order=id&&await one('SELECT * FROM nlg_store.orders WHERE paypal_id=$1',[id]);
    if(order?.status==='pending'){
     const data=await paypalCall('GET','/v2/checkout/orders/'+encodeURIComponent(id));
     await grantOrder(order,verifyCaptured(data,order));
    }
   }else if(['PAYMENT.CAPTURE.REFUNDED','PAYMENT.CAPTURE.REVERSED'].includes(event.event_type)){
    const capture=event.resource?.supplementary_data?.related_ids?.capture_id||event.resource?.sale_id||event.resource?.links?.find(x=>x.rel==='up')?.href?.match(/captures\/([^/?]+)/)?.[1]||(event.event_type==='PAYMENT.CAPTURE.REVERSED'?event.resource?.id:null);
    const order=capture&&await one('SELECT * FROM nlg_store.orders WHERE capture_id=$1',[capture]);
    if(order?.status==='completed')await refundOrder(order,event);
   }
   send(res,200,{ok:true});return true;
  }
  if(!pool)return fail(res,503,'Tienda no configurada'),true;
  const account=await currentAccount(req);if(!account)return fail(res,401,'Código de recuperación inválido'),true;
  if(req.method==='GET'&&p==='/api/store/entitlements'){send(res,200,await currentEntitlements(account));return true}
  if(req.method==='POST'&&p==='/api/store/orders'){
   if(!paymentsEnabled)return fail(res,503,'Cobros deshabilitados hasta completar las pruebas'),true;
   const {kind,choices=[]}=await safeData(req),valid=await validSelection(kind,choices,account);
   const period=month();
   if(kind==='bundle'&&await one("SELECT 1 FROM nlg_store.orders WHERE account_hash=$1 AND kind='bundle' AND period=$2 AND status='completed' LIMIT 1",[account.key_hash,period]))return fail(res,409,'Oferta mensual ya utilizada'),true;
   const id=randomUUID(),amount=prices[kind],created=now();
   await pool.query('INSERT INTO nlg_store.orders(id,account_hash,kind,choice_json,amount,period,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,account.key_hash,kind,JSON.stringify(valid),amount,period,'pending',created,created]);
   const data=await paypalCall('POST','/v2/checkout/orders',{intent:'CAPTURE',purchase_units:[{reference_id:id,custom_id:id,description:kind==='premium'?'NextLevel Premium 30 días sin renovación automática':`${kind}: ${valid.join(', ')}`.slice(0,120),amount:{currency_code:'USD',value:(amount/100).toFixed(2)}}],application_context:{shipping_preference:'NO_SHIPPING'}},id);
   await pool.query('UPDATE nlg_store.orders SET paypal_id=$1,updated_at=$2 WHERE id=$3',[data.id,now(),id]);
   send(res,201,{id:data.id,orderId:id,total:(amount/100).toFixed(2)});return true;
  }
  const check=p.match(/^\/api\/store\/orders\/([a-f0-9-]{36})\/reconcile$/i);
  if(req.method==='POST'&&check){
   const order=await one('SELECT * FROM nlg_store.orders WHERE id=$1 AND account_hash=$2',[check[1],account.key_hash]);
   if(!order)return fail(res,404,'Pedido no encontrado'),true;
   if(!order.paypal_id)return fail(res,409,'Pedido PayPal incompleto'),true;
   const updated=await reconcilePayPalOrder(order,true);
   send(res,200,{receipt:receipt(updated),entitlements:await currentEntitlements(account)});return true;
  }
  const m=p.match(/^\/api\/store\/orders\/([a-f0-9-]{36})\/capture$/i);
  if(req.method==='POST'&&m){
   const order=await one('SELECT * FROM nlg_store.orders WHERE id=$1 AND account_hash=$2',[m[1],account.key_hash]);
   if(!order)return fail(res,404,'Pedido no encontrado'),true;
   if(order.status==='completed')return send(res,200,{receipt:receipt(order),entitlements:await currentEntitlements(account)}),true;
   if(order.status==='refunded')return fail(res,409,'Pago ya reembolsado'),true;
   if(!order.paypal_id)return fail(res,409,'Pedido PayPal incompleto'),true;
   let latest=await reconcilePayPalOrder(order);
   if(latest.status!=='completed'){
    try{
     const data=await paypalCall('POST','/v2/checkout/orders/'+encodeURIComponent(order.paypal_id)+'/capture',{},order.id+'-capture');
     await grantOrder(order,verifyCaptured(data,order));
    }catch(error){try{latest=await reconcilePayPalOrder(order)}catch{}if(latest.status!=='completed')throw error}
   }
   const completed=await one('SELECT * FROM nlg_store.orders WHERE id=$1',[order.id]);
   send(res,200,{receipt:receipt(completed),entitlements:await currentEntitlements(account)});return true;
  }
  fail(res,404,'Ruta no encontrada');return true;
 }catch(e){
  console.error('[store]',e.message);
  const clientErrors=['Producto inválido','Premium no usa selección','Falta selección','Elegí exactamente','Artículo inválido','Artículo inexistente','Artículo fuera de categoría','Ese artículo ya fue comprado','Solicitud demasiado grande','Solicitud JSON inválida'];
  fail(res,clientErrors.some(x=>e.message.startsWith(x))?400:503,clientErrors.some(x=>e.message.startsWith(x))?e.message:'No se pudo completar la operación. Reintentá o contactá al soporte.');return true;
 }
}
