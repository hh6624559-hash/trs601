// Service worker: vỏ ứng dụng cache-first (phiên bản hóa), điều hướng network-first có dự phòng offline. KHÔNG cache /api.
const V = 'trs6-shell-v9'; // P-09: tăng khi đổi vỏ ứng dụng; người dùng bấm «Cập nhật» để kích hoạt
const SHELL = ['/', '/index.html', '/css/app.css', '/js/app.js', '/js/components.js', '/js/mascot.js', '/i18n/vi.json', '/i18n/en.json', '/manifest.webmanifest', '/icons/icon.svg'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL))); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/') || u.pathname === '/healthz' || u.pathname === '/readyz') return;
  if (r.mode === 'navigate') { e.respondWith(fetch(r).catch(() => caches.match('/index.html'))); return; }
  e.respondWith(caches.match(r).then((hit) => {
    const net = fetch(r).then((res) => { if (res.ok) caches.open(V).then((c) => c.put(r, res.clone())); return res; }).catch(() => hit);
    return hit || net;
  }));
});

self.addEventListener('message', (e) => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });
