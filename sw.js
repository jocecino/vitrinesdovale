const V='vv-__V__';
// Endereço antigo (antes de virar Eita Vale): apaga a cópia guardada, desliga e leva para o domínio novo.
const OLD=location.hostname==='valeshop-sobradinho.vercel.app';
if(OLD){
 self.addEventListener('install',()=>self.skipWaiting());
 self.addEventListener('activate',e=>e.waitUntil((async()=>{try{for(const k of await caches.keys())await caches.delete(k)}catch(x){}
  try{await self.registration.unregister()}catch(x){}
  try{for(const c of await self.clients.matchAll({type:'window',includeUncontrolled:true})){const u=new URL(c.url);c.navigate('https://eitavale.com.br'+u.pathname+u.search+u.hash)}}catch(x){}})()));
 self.addEventListener('fetch',e=>{const r=e.request;if(r.mode==='navigate'){const u=new URL(r.url);e.respondWith(Response.redirect('https://eitavale.com.br'+u.pathname+u.search,302))}});
}
if(!OLD){
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(['/','/manifest.webmanifest','/icon-192.png','/logo.webp'])));self.skipWaiting()});
const IMG='vv-img-1',R2='https://pub-c1cbf15f15c14757a0192ce3ea39d547.r2.dev/',R2N='https://fotos.eitavale.com.br/';
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V&&x!==IMG).map(x=>caches.delete(x)))));self.clients.claim()});
async function aparar(){try{const c=await caches.open(IMG),k=await c.keys();if(k.length>400)for(const r of k.slice(0,k.length-350))await c.delete(r)}catch(e){}}
self.addEventListener('fetch',e=>{const r=e.request,u=new URL(r.url);
 if(r.method==='GET'&&(r.url.startsWith(R2)||r.url.startsWith(R2N)||(u.pathname.indexOf('/storage/v1/object/public/')>-1&&/supabase\.co$/.test(u.hostname)))){e.respondWith(caches.open(IMG).then(c=>c.match(r).then(m=>m||fetch(r).then(x=>{if(x.ok||x.type==='opaque'){c.put(r,x.clone());aparar()}return x}))));return}
 if(r.method!=='GET'||u.origin!==location.origin||u.pathname.startsWith('/api/'))return;
 // arquivos com versão no endereço (app.js?v=…, painel.js?v=…, biblioteca, ícones, imagens) não mudam: abre direto do aparelho
 if(/[?&]v=/.test(u.search)||u.pathname.startsWith('/vendor/')||u.pathname.startsWith('/ic/')||/\.(webp|png|jpg|svg|woff2?)$/.test(u.pathname)){e.respondWith(caches.open(V).then(c=>c.match(r).then(m=>m||fetch(r).then(x=>{if(x.ok)c.put(r,x.clone());return x}))));return}
 e.respondWith(fetch(r).then(x=>{const c=x.clone();caches.open(V).then(h=>h.put(r,c));return x}).catch(()=>caches.match(r).then(m=>m||caches.match('/'))))});

self.addEventListener('push',e=>{let d={};try{d=e.data?e.data.json():{}}catch(x){d={title:'Eita Vale',body:e.data?e.data.text():''}}
 e.waitUntil(self.registration.showNotification(d.title||'Eita Vale',{body:d.body||'',icon:'/icon-192.png',badge:'/badge-96.png',tag:d.tag||undefined,data:{url:d.url||'/#/minha'}}))});
self.addEventListener('notificationclick',e=>{e.notification.close();const u=(e.notification.data&&e.notification.data.url)||'/#/minha';
 e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(L=>{for(const c of L){if('focus' in c){c.navigate&&c.navigate(u);return c.focus()}}return clients.openWindow(u)}))});
}
