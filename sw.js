/* =========================================================================
   sw.js  —  サービスワーカー
   ---------------------------------------------------------------------
   ・アプリ本体（HTML/CSS/JS）は「まずネットワーク、だめならキャッシュ」。
     こうしないと、ファイルを更新しても端末が古い画面を出し続けます。
     （以前はキャッシュ優先にしていたため、更新が反映されませんでした）
   ・画像（アイコン）は変わらないのでキャッシュ優先のまま。
   ・予報データや地図タイルはキャッシュしません。古い予報を掴まないためです。
   ========================================================================= */

// ファイルを差し替えたときは、この番号を1つ増やしてください。
const CACHE = 'odekake-tenki-v6';

// ネットワークがこの時間で返らなければ、キャッシュの内容を使う
const NET_TIMEOUT_MS = 3500;

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
  './radar.js',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // 1つでも失敗すると全部失敗するので、個別に入れる
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** アプリ本体（更新されうるファイル）かどうか */
function isShellRequest(req, url) {
  if (req.mode === 'navigate') return true;
  return /\.(html|css|js|json)$/i.test(url.pathname);
}

/** まずネットワーク。遅い・つながらないときはキャッシュ。 */
function networkFirst(req) {
  const fromNet = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), NET_TIMEOUT_MS);
    // no-cache を付けて、必ずサーバーに新しいか確認させる
    // （GitHub Pages は10分間ブラウザにキャッシュさせるため）
    fetch(req, { cache: 'no-cache' })
      .then((res) => { clearTimeout(timer); resolve(res); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });

  return fromNet
    .then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    })
    .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')));
}

/** 変わらないもの（アイコン）はキャッシュ優先 */
function cacheFirst(req) {
  return caches.match(req).then((hit) => {
    if (hit) return hit;
    return fetch(req).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    });
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 外部（予報・地図タイル・住所検索）は素通し
  if (url.origin !== self.location.origin) return;

  event.respondWith(isShellRequest(req, url) ? networkFirst(req) : cacheFirst(req));
});

/** 画面側から「すぐ新しいのに切り替えて」と言われたとき */
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
