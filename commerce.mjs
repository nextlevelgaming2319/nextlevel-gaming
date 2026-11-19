import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {existsSync, mkdirSync, readFileSync} from 'node:fs';
import path from 'node:path';

const inventory=JSON.parse(readFileSync(new URL('./catalog.json',import.meta.url),'utf8'));
const frames=new Map(inventory.frames.map(x=>[x.id,x]));
const backgrounds=new Map(inventory.backgrounds.map(x=>[x.id,x]));
const hash=x=>createHash('sha256').update(String(x)).digest('hex');
const prices={frame:75,frameGodlike:300,background:125,backgroundGodlike:300,bundle:200,premium:299};
const accessHeaders={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const send=(res,code,obj)=>{res.writeHead(code,accessHeaders);res.end(JSON.stringify(obj));};
const fail=(res,code,message)=>send(res,code,{error:message});
const mode=process.env.PAYPAL_ENV==='live'?'live':'sandbox';
const liveReady=mode!=='live'||(process.env.PAYPAL_LIVE_ENABLED==='YES'&&process.env.PUBLIC_BASE_URL?.startsWith('https://')&&process.env.PAYPAL_MERCHANT_ID&&process.env.PAYPAL_WEBHOOK_ID&&process.env.NODE_ENV==='production');
const serverConfigured=Boolean(process.env.PAYPAL_CLIENT_ID&&process.env.PAYPAL_CLIENT_SECRET&&process.env.NLG_PERSISTENT_DIR&&liveReady);
const checkoutProvider='paypal-orders-v2';
const paymentsEnabled=serverConfigured&&process.env.NLG_COMMERCE_ENABLED==='YES';
const api=mode==='live'?'https://api-m.paypal.com':'https://api-m.sandbox.paypal.com';
let db=null;
if(process.env.NLG_PERSISTENT_DIR){const dir=path.resolve(process.env.NLG_PERSISTENT_DIR);mkdirSync(dir,{recursive:true});db=new DatabaseSync(path.join(dir,'nextlevel-purchases.sqlite'));db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS accounts (key_hash TEXT PRIMARY KEY,premium_until INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY,paypal_id TEXT UNIQUE,account_hash TEXT NOT NULL,kind TEXT NOT NULL,choice_json TEXT NOT NULL,amount INTEGER NOT NULL,period TEXT NOT NULL,status TEXT NOT NULL,capture_id TEXT UNIQUE,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS grants (account_hash TEXT NOT NULL,item_type TEXT NOT NULL,item_id TEXT NOT NULL,order_id TEXT NOT NULL,PRIMARY KEY(account_hash,item_type,item_id,order_id));
CREATE TABLE IF NOT EXISTS refunds (refund_id TEXT PRIMARY KEY,order_id TEXT NOT NULL,amount_cents INTEGER NOT NULL,received_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS orders_account ON orders(account_hash,status);`);}
const month=()=>new Date().toISOString().slice(0,7);
const state=()=>({paymentsEnabled,clientId:paymentsEnabled?process.env.PAYPAL_CLIENT_ID:null,mode,provider:checkoutProvider,configured:serverConfigured,requiresPersistentStorage:!db,premium:'30 días, pago único sin renovación automática',prices,restoreCodeRequired:true});
const currentAccount=req=>{const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');if(!/^nlg_[A-Za-z0-9_-]{43}$/.test(token)||!db)return null;const h=hash(token);return db.prepare('SELECT key_hash,premium_until FROM accounts WHERE key_hash=?').get(h)||null;};
const safeData=async(req,limit=16000)=>{let parts=[],size=0;for await(const part of req){size+=part.length;if(size>limit)throw Error('Solicitud demasiado grande');parts.push(part);}return JSON.parse(Buffer.concat(parts).toString('utf8')||'{}');};
function validSelection(kind,ids,account){
 if(!Object.hasOwn(prices,kind))throw Error('Producto inválido');
 if(kind==='premium'){if(ids?.length)throw Error('Premium no usa selección');return [];}
 if(!Array.isArray(ids))throw Error('Falta selección');
 const count=kind==='bundle'?5:1;
 if(ids.length!==count||new Set(ids).size!==count)throw Error(`Elegí exactamente ${count} artículos diferentes`);
 const isBg=kind.startsWith('background');const pool=isBg?backgrounds:frames;
 for(const id of ids){const item=pool.get(id);if(!item)throw Error('Artículo inexistente o no vendible');
  if(kind==='frame'&&item.rarity==='godlike'||kind==='frameGodlike'&&item.rarity!=='godlike'||kind==='background'&&item.rarity==='godlike'||kind==='backgroundGodlike'&&item.rarity!=='godlike'||kind==='bundle'&&item.rarity==='godlike')throw Error('Artículo fuera de categoría');
  if(db.prepare('SELECT 1 FROM grants g JOIN orders o ON g.order_id=o.id WHERE g.account_hash=? AND g.item_type=? AND g.item_id=? AND o.status=?').get(account.key_hash,isBg?'background':'frame',id,'completed'))throw Error('Ese artículo ya fue comprado');
 }
 return ids;
}
let cachedAccess={token:'',until:0};
async function paypalToken(){if(cachedAccess.until>Date.now()+30000)return cachedAccess.token;
 const pair=Buffer.from(process.env.PAYPAL_CLIENT_ID+':'+process.env.PAYPAL_CLIENT_SECRET).toString('base64');
 const r=await fetch(api+'/v1/oauth2/token',{method:'POST',headers:{Authorization:'Basic '+pair,'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials',signal:AbortSignal.timeout(12000)});
 const data=await r.json();if(!r.ok||!data.access_token)throw Error('No fue posible autenticar PayPal');
 cachedAccess={token:data.access_token,until:Date.now()+Math.max(60,Number(data.expires_in)-60)*1000};return cachedAccess.token;
}
async function paypalCall(method,url,body,idempotency){const token=await paypalToken();const headers={Authorization:'Bearer '+token,'Content-Type':'application/json','Prefer':'return=representation'};if(idempotency)headers['PayPal-Request-Id']=idempotency;
 const r=await fetch(api+url,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(18000)});
 let data={};try{data=await r.json()}catch{}
 if(!r.ok)throw Error('PayPal rechazó la operación ('+r.status+'): '+(data.message||data.name||'revisar cuenta del vendedor'));
 return data;
}
function receipt(order,account){return {orderId:order.id,kind:order.kind,choices:JSON.parse(order.choice_json),total:(order.amount/100).toFixed(2),currency:'USD',status:order.status,premiumUntil:account?.premium_until||0};}
function grantOrder(order,captureId){db.exec('BEGIN IMMEDIATE');try{
 const stored=db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
 if(stored.status==='completed'){db.exec('COMMIT');return;}
 if(stored.status==='refunded')throw Error('Pago reembolsado');
 db.prepare('UPDATE orders SET status=?,capture_id=?,updated_at=? WHERE id=?').run('completed',captureId,new Date().toISOString(),order.id);
 if(order.kind==='premium'){const a=db.prepare('SELECT premium_until FROM accounts WHERE key_hash=?').get(order.account_hash);const base=Math.max(Date.now(),a.premium_until);db.prepare('UPDATE accounts SET premium_until=? WHERE key_hash=?').run(base+30*86400000,order.account_hash);}
 else for(const id of JSON.parse(order.choice_json))db.prepare('INSERT OR IGNORE INTO grants(account_hash,item_type,item_id,order_id) VALUES(?,?,?,?)').run(order.account_hash,order.kind.startsWith('background')?'background':'frame',id,order.id);
 db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}
function verifyCaptured(data,order){
 if(data.id!==order.paypal_id||data.status!=='COMPLETED')throw Error('Pago no completado');
 if(!Array.isArray(data.purchase_units)||data.purchase_units.length!==1)throw Error('Cantidad de órdenes PayPal inválida');
 const unit=data.purchase_units[0];const captures=unit?.payments?.captures||[];
 const capture=captures.find(c=>c.status==='COMPLETED'&&c.amount?.currency_code==='USD'&&c.amount?.value===(order.amount/100).toFixed(2)&&typeof c.id==='string');
 if(!capture||captures.some(c=>c!==capture&&c.status==='COMPLETED'))throw Error('Importe o estado del cobro no coinciden');
 if(mode==='live'&&!process.env.PAYPAL_MERCHANT_ID)throw Error('Falta identidad del vendedor');
 if(process.env.PAYPAL_MERCHANT_ID&&unit.payee?.merchant_id!==process.env.PAYPAL_MERCHANT_ID&&capture?.payee?.merchant_id!==process.env.PAYPAL_MERCHANT_ID)throw Error('Comerciante inesperado');
 if(unit.reference_id!==order.id||unit.custom_id!==order.id)throw Error('Pedido PayPal distinto del seleccionado');
 return capture.id;
}
async function retrievePayPalOrder(order){
 if(!order.paypal_id)throw Error('Pedido PayPal incompleto');
 return paypalCall('GET','/v2/checkout/orders/'+encodeURIComponent(order.paypal_id));
}
async function reconcilePayPalOrder(order,captureApproved=false){
 if(order.status==='completed'||order.status==='refunded')return order;
 let upstream=await retrievePayPalOrder(order);
 if(upstream.status==='APPROVED'&&captureApproved){
   try{upstream=await paypalCall('POST','/v2/checkout/orders/'+encodeURIComponent(order.paypal_id)+'/capture',{},order.id+'-capture')}
   catch(error){
     try{upstream=await retrievePayPalOrder(order)}catch{throw error}
     if(upstream.status!=='COMPLETED')throw error;
   }
 }
 if(upstream.status==='COMPLETED'){
   const captureId=verifyCaptured(upstream,order);
   grantOrder(order,captureId);
   return db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
 }
 return order;
}
export async function reconcilePendingOrders(){
 if(!paymentsEnabled||!db)return;
 const recent=db.prepare("SELECT * FROM orders WHERE status='pending' AND paypal_id IS NOT NULL AND created_at>=? ORDER BY created_at LIMIT 20").all(new Date(Date.now()-24*3600000).toISOString());
 for(const order of recent)try{await reconcilePayPalOrder(order,true)}catch(error){console.warn('[paypal reconcile]',order.id,error.message)}
}
const currentEntitlements=account=>{
 const active=db.prepare(`SELECT DISTINCT g.item_type,g.item_id FROM grants g JOIN orders o ON o.id=g.order_id WHERE g.account_hash=? AND o.status='completed'`).all(account.key_hash);
 return {frames:active.filter(x=>x.item_type==='frame').map(x=>x.item_id),backgrounds:active.filter(x=>x.item_type==='background').map(x=>x.item_id),premiumUntil:db.prepare('SELECT premium_until FROM accounts WHERE key_hash=?').get(account.key_hash)?.premium_until||0,orders:db.prepare('SELECT * FROM orders WHERE account_hash=? ORDER BY created_at DESC LIMIT 100').all(account.key_hash).map(o=>receipt(o))};
};
export async function handleCommerce(req,res,url){if(!url.pathname.startsWith('/api/store/'))return false;
 const p=url.pathname;
 try{
  if(req.method==='GET'&&p==='/api/store/status'){send(res,200,state());return true;}
  if(req.method==='GET'&&p==='/api/store/connection'){
    if(!serverConfigured)return fail(res,503,'Faltan credenciales privadas de PayPal o el almacenamiento persistente'),true;
    try{await paypalToken();send(res,200,{provider:checkoutProvider,mode,connectedToPayPal:true,checkoutEnabled:paymentsEnabled});}
    catch(e){console.error('[paypal connection]',e.message);fail(res,502,'PayPal rechazó las credenciales o no se pudo conectar'),true;}
    return true;
  }
  if(req.method==='POST'&&p==='/api/store/account'){
    if(!db)return fail(res,503,'Falta configurar almacenamiento persistente'),true;
    const code='nlg_'+randomBytes(32).toString('base64url');db.prepare('INSERT INTO accounts(key_hash,created_at) VALUES(?,?)').run(hash(code),new Date().toISOString());send(res,201,{recoveryCode:code,warning:'Guardá este código fuera del navegador: es la única forma de recuperar tus compras.'});return true;}
  if(req.method==='POST'&&p==='/api/store/webhook'){
   if(!paymentsEnabled||!process.env.PAYPAL_WEBHOOK_ID)return fail(res,503,'Webhooks no configurados'),true;
   const event=await safeData(req,120000);
   const proof={auth_algo:req.headers['paypal-auth-algo'],cert_url:req.headers['paypal-cert-url'],transmission_id:req.headers['paypal-transmission-id'],transmission_sig:req.headers['paypal-transmission-sig'],transmission_time:req.headers['paypal-transmission-time'],webhook_id:process.env.PAYPAL_WEBHOOK_ID,webhook_event:event};
   if(Object.values(proof).some(x=>!x))return fail(res,400,'Firma de webhook incompleta'),true;
   const result=await paypalCall('POST','/v1/notifications/verify-webhook-signature',proof);
   if(result.verification_status!=='SUCCESS')return fail(res,403,'Firma de webhook inválida'),true;
   if(event.event_type==='CHECKOUT.ORDER.APPROVED'){
    const paypalId=event.resource?.id;
    const order=paypalId&&db.prepare('SELECT * FROM orders WHERE paypal_id=?').get(paypalId);
    if(order&&order.status==='pending')await reconcilePayPalOrder(order,true);
   }else if(event.event_type==='PAYMENT.CAPTURE.COMPLETED'){
    const paypalId=event.resource?.supplementary_data?.related_ids?.order_id;
    const order=paypalId&&db.prepare('SELECT * FROM orders WHERE paypal_id=?').get(paypalId);
    if(order&&order.status!=='completed'){
      const data=await paypalCall('GET','/v2/checkout/orders/'+encodeURIComponent(paypalId));
      const captureId=verifyCaptured(data,order);grantOrder(order,captureId);
    }
   }else if(['PAYMENT.CAPTURE.REFUNDED','PAYMENT.CAPTURE.REVERSED'].includes(event.event_type)){
    const captureId=event.resource?.supplementary_data?.related_ids?.capture_id||event.resource?.sale_id||event.resource?.links?.find(x=>x.rel==='up')?.href?.match(/captures\/([^/?]+)/)?.[1]||(event.event_type==='PAYMENT.CAPTURE.REVERSED'?event.resource?.id:null);
    const order=captureId&&db.prepare('SELECT * FROM orders WHERE capture_id=?').get(captureId);
    if(order&&order.status==='completed'){
      const reversed=event.event_type==='PAYMENT.CAPTURE.REVERSED';
      if(!reversed&&event.resource?.id&&event.resource?.amount?.currency_code==='USD'){
       const cents=Math.round(Number(event.resource.amount.value)*100);
       if(Number.isSafeInteger(cents)&&cents>0)db.prepare('INSERT OR IGNORE INTO refunds(refund_id,order_id,amount_cents,received_at) VALUES(?,?,?,?)').run(event.resource.id,order.id,cents,new Date().toISOString());
      }
      const refunded=db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS amount FROM refunds WHERE order_id=?').get(order.id).amount;
      if(reversed||refunded>=order.amount){
       db.prepare('UPDATE orders SET status=?,updated_at=? WHERE id=?').run('refunded',new Date().toISOString(),order.id);
       if(order.kind==='premium'){
        const list=db.prepare("SELECT * FROM orders WHERE account_hash=? AND kind='premium' AND status='completed' ORDER BY created_at").all(order.account_hash);
        let until=0;for(const o of list)until=Math.max(new Date(o.created_at).getTime(),until)+30*86400000;
        db.prepare('UPDATE accounts SET premium_until=? WHERE key_hash=?').run(until,order.account_hash);
       }
      }
    }
   }
   send(res,200,{ok:true});return true;
  }
  if(!db)return fail(res,503,'Tienda no configurada'),true;
  const account=currentAccount(req);if(!account)return fail(res,401,'Código de recuperación inválido'),true;
  if(req.method==='GET'&&p==='/api/store/entitlements'){send(res,200,currentEntitlements(account));return true;}
  if(req.method==='POST'&&p==='/api/store/orders'){
   if(!paymentsEnabled)return fail(res,503,'Cobros deshabilitados hasta completar la configuración y las pruebas'),true;
   const {kind,choices=[]}=await safeData(req),valid=validSelection(kind,choices,account);
   const period=month();if(kind==='bundle'&&db.prepare("SELECT 1 FROM orders WHERE account_hash=? AND kind='bundle' AND period=? AND status='completed'").get(account.key_hash,period))return fail(res,409,'Oferta mensual ya utilizada'),true;
   const id=randomUUID(),amount=prices[kind],created=new Date().toISOString();
   db.prepare('INSERT INTO orders(id,account_hash,kind,choice_json,amount,period,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,account.key_hash,kind,JSON.stringify(valid),amount,period,'pending',created,created);
   const data=await paypalCall('POST','/v2/checkout/orders',{intent:'CAPTURE',purchase_units:[{reference_id:id,custom_id:id,description:kind==='premium'?'NextLevel Premium 30 días sin renovación automática':`${kind}: ${valid.join(', ')}`.slice(0,120),amount:{currency_code:'USD',value:(amount/100).toFixed(2)}}],application_context:{shipping_preference:'NO_SHIPPING'}},id);
   db.prepare('UPDATE orders SET paypal_id=?,updated_at=? WHERE id=?').run(data.id,new Date().toISOString(),id);
   send(res,201,{id:data.id,orderId:id,total:(amount/100).toFixed(2)});return true;
  }
  const check=p.match(/^\/api\/store\/orders\/([a-f0-9-]{36})\/reconcile$/i);
  if(req.method==='POST'&&check){
   const order=db.prepare('SELECT * FROM orders WHERE id=? AND account_hash=?').get(check[1],account.key_hash);
   if(!order)return fail(res,404,'Pedido no encontrado'),true;
   if(!order.paypal_id)return fail(res,409,'Pedido PayPal incompleto'),true;
   const reconciled=await reconcilePayPalOrder(order,true);
   send(res,200,{receipt:receipt(reconciled),entitlements:currentEntitlements(account)});return true;
  }
  const m=p.match(/^\/api\/store\/orders\/([a-f0-9-]{36})\/capture$/i);
  if(req.method==='POST'&&m){const order=db.prepare('SELECT * FROM orders WHERE id=? AND account_hash=?').get(m[1],account.key_hash);
   if(!order)return fail(res,404,'Pedido no encontrado'),true;
   if(order.status==='completed')return send(res,200,{receipt:receipt(order),entitlements:currentEntitlements(account)}),true;
   if(order.status==='refunded')return fail(res,409,'Pago ya reembolsado'),true;
   if(!order.paypal_id)return fail(res,409,'Pedido PayPal incompleto'),true;
   let latest=await reconcilePayPalOrder(order);
   if(latest.status!=='completed'){
     try{
       const captured=await paypalCall('POST','/v2/checkout/orders/'+encodeURIComponent(order.paypal_id)+'/capture',{},order.id+'-capture');
       grantOrder(order,verifyCaptured(captured,order));
     }catch(error){
       try{latest=await reconcilePayPalOrder(order)}catch{}
       if(latest.status!=='completed')throw error;
     }
   }
   send(res,200,{receipt:receipt(db.prepare('SELECT * FROM orders WHERE id=?').get(order.id)),entitlements:currentEntitlements(account)});return true;
  }
  fail(res,404,'Ruta no encontrada');return true;
 }catch(e){console.error('[store]',e.message);fail(res,400,e.message||'Error de compra');return true;}
}
