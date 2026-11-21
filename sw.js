/* Irene's Puzzle Box - service worker (offline + installable)
   IMPORTANT: bump CACHE (v3 -> v4 ...) whenever any cached file changes;
   the new content is picked up on the next visit. */
// 版本同步铁律：CACHE 整数为 N 时，index.html 大厅底部显示版本必须同步为 v1.0.N
// 每次改动任何被缓存的文件（css/js/html），都要同时升这里的大厅显示版本
const CACHE_PREFIX = 'ire-pbox-';
const CACHE = 'ire-pbox-v14';
const FILES = [
  './',
  'index.html',
  'manifest.json',
  'css/common.css?v=14',
  'js/common.js?v=13',
  'games/telepathy/telepathy.html',
  'games/telepathy/telepathy.css?v=12',
  'games/telepathy/telepathy.js?v=13',
  'games/starbattle/star.html',
  'games/starbattle/star.css?v=14',
  'games/starbattle/star.js?v=14',
  'games/starbattle/bank.js',
  'games/sudoku/sudoku.html',
  'games/sudoku/sudoku.css?v=13',
  'games/sudoku/sudoku.js?v=13',
  'assets/app-icon.png',
  'assets/irene.png',
  'assets/handrix.png'
];
const OFFLINE_PAGES = new Set(FILES
  .filter(file => file === './' || file.endsWith('.html'))
  .map(file => new URL(file, self.registration.scope).pathname));

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(FILES); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k.startsWith(CACHE_PREFIX) && k !== CACHE; })
          .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

async function matchCached(request) {
  try {
    const cache = await caches.open(CACHE);
    return await cache.match(request);
  } catch {
    return undefined;
  }
}

async function storeResponse(request, response) {
  if (response.status !== 200 || response.type !== 'basic' || new URL(response.url).origin !== self.location.origin) {
    return response;
  }
  try {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  } catch {
    // 缓存写入失败时仍交付网络响应。
  }
  return response;
}

async function navigate(request, url) {
  const response = await fetch(request).catch(() => null);
  if (response && response.status < 500) return storeResponse(request, response);

  const exact = await matchCached(request);
  if (exact) return exact;
  if (OFFLINE_PAGES.has(url.pathname)) {
    const cachedPage = await matchCached(url.origin + url.pathname);
    if (cachedPage) return cachedPage;
  }
  return response || new Response('当前处于离线状态，页面尚未缓存。请联网后重试。', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

async function loadAsset(request) {
  const cached = await matchCached(request);
  return cached || storeResponse(request, await fetch(request));
}

self.addEventListener('fetch', function (e) {
  const request = e.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(request.mode === 'navigate' ? navigate(request, url) : loadAsset(request));
});
