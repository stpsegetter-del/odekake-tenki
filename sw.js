/* =========================================================================
   sw.js  —  サービスワーカー
   ---------------------------------------------------------------------
   ・アプリ本体（HTML/CSS/JS/アイコン）はキャッシュから即座に出します。
     これで「開いた瞬間に表示」が実現できます。
   ・予報データ（Open-Meteo）や住所検索（国土地理院）はキャッシュしません。
     古い予報を掴まないためです。予報の一時保存は localStorage 側で
     期限つきに管理しています。
   ========================================================================= */

const CACHE = 'odekake-tenki-v1';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './icons.js',
  './store.js',
  './muni.js',
  './geocode.js',
  './weather.js',
  './advice.js',
  './sky.js',
  './chart.js',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // 1つでも失敗すると全部失敗するので、個別に入れる
      .then((cache) => Promise.all(
        SHELL.map((url) => cache.add(url).catch(() => null))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 外部API（予報・住所検索）は素通し
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) {
        // 裏で新しいものを取ってきて、次回に備える
        fetch(req).then((res) => {
          if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        }).catch(() => {});
        return hit;
      }
      return fetch(req)
        .then((res) => {
          if (res && res.ok && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
