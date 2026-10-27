const CACHE='service-time-local-v233-test-20261027';
const ASSETS=[
  './',
  './index.html',
  './style.css?v=233t',
  './app.js?v=233t',
  './manifest.webmanifest?v=233t'
];
self.addEventListener('install',event=>{
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)));
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(key=>key!==CACHE && key.startsWith('service-time-local-v2') && key.includes('-test-')).map(key=>caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin)return;
  event.respondWith((async()=>{
    try{
      const fresh=await fetch(event.request,{cache:'no-store'});
      if(fresh&&fresh.ok){const cache=await caches.open(CACHE);await cache.put(event.request,fresh.clone())}
      return fresh;
    }catch{
      return (await caches.match(event.request)) || (event.request.mode==='navigate' ? await caches.match('./index.html') : Response.error());
    }
  })());
});
