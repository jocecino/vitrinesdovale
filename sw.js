const V='vv-__V__';
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(['/','/manifest.webmanifest','/icon-192.png','/logo.webp'])));self.skipWaiting()});
const IMG='vv-img-1',R2='https://pub-c1cbf15f15c14757a0192ce3ea39d547.r2.dev/';
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V&&x!==IMG).map(x=>caches.delete(x)))));self.clients.claim()});
async function aparar(){try{const c=await caches.open(IMG),k=await c.keys();if(k.length>400)for(const r of k.slice(0,k.length-350))await c.delete(r)}catch(e){}}
self.addEventListener('fetch',e=>{const r=e.request,u=new URL(r.url);
 if(r.method==='GET'&&(r.url.startsWith(R2)||(u.pathname.indexOf('/storage/v1/object/public/')>-1&&/supabase\.co$/.test(u.hostname)))){e.respondWith(caches.open(IMG).then(c=>c.match(r).then(m=>m||fetch(r).then(x=>{if(x.ok||x.type==='opaque'){c.put(r,x.clone());aparar()}return x}))));return}
 if(r.method!=='GET'||u.origin!==location.origin||u.pathname.startsWith('/api/'))return;
 // arquivos com versão no endereço (app.js?v=…, biblioteca, ícones, imagens) não mudam: abre direto do aparelho
 if(/[?&]v=/.test(u.search)||u.pathname.startsWith('/vendor/')||u.pathname.startsWith('/ic/')||/\.(webp|png|jpg|svg|woff2?)$/.test(u.pathname)){e.respondWith(caches.open(V).then(c=>c.match(r).then(m=>m||fetch(r).then(x=>{if(x.ok)c.put(r,x.clone());return x}))));return}
 e.respondWith(fetch(r).then(x=>{const c=x.clone();caches.open(V).then(h=>h.put(r,c));return x}).catch(()=>caches.match(r).then(m=>m||caches.match('/'))))});

self.addEventListener('push',e=>{let d={};try{d=e.data?e.data.json():{}}catch(x){d={title:'ValeShop',body:e.data?e.data.text():''}}
 e.waitUntil(self.registration.showNotification(d.title||'ValeShop',{body:d.body||'',icon:'/icon-192.png',badge:'/badge-96.png',tag:d.tag||undefined,data:{url:d.url||'/#/minha'}}))});
self.addEventListener('notificationclick',e=>{e.notification.close();const u=(e.notification.data&&e.notification.data.url)||'/#/minha';
 e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(L=>{for(const c of L){if('focus' in c){c.navigate&&c.navigate(u);return c.focus()}}return clients.openWindow(u)}))});
