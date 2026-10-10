// PWA 설치/오프라인 셸 캐싱용 서비스워커. 매매 데이터는 Cloudflare Worker에서
// 실시간으로 가져와야 의미가 있으므로 여기서는 건드리지 않고, 앱 셸(정적
// 파일)만 캐싱해서 오프라인이거나 네트워크가 느릴 때도 화면은 뜨게 한다.
const CACHE_NAME = 'tradex-shell-v3';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];
// index.html/manifest.json처럼 자주 바뀌는 파일은 캐시 우선으로 두면
// 새로고침해도 예전 버전이 계속 보이는 문제가 생긴다(버전 올려도 SW
// 업데이트가 한 박자 늦게 적용돼서 첫 새로고침엔 여전히 옛 캐시가 뜸).
// 이 파일들만 네트워크 우선으로 바꿔서 항상 최신 내용이 먼저 시도되게 한다.
const NETWORK_FIRST_FILES = new Set(['./', './index.html', './manifest.json']);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // 같은 출처의 정적 파일만 다루고, Worker API 호출(다른 출처) 등은
  // 손대지 않고 그대로 네트워크로 보낸다.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  const path = url.pathname.endsWith('/') ? './' : '.' + url.pathname;
  const isNetworkFirst = NETWORK_FIRST_FILES.has(path) || url.pathname.endsWith('/index.html');

  if (isNetworkFirst) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ||
        fetch(event.request)
          .then((res) => {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
            return res;
          })
          .catch(() => cached)
    )
  );
});
