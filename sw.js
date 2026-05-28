// ==========================================
// SERVICE WORKER (PWA KASIR ENTERPRISE)
// ==========================================

// PENTING: Naikkan angka APP_VERSION setiap kali Anda mengubah isi index.html, CSS, atau logika sistem!
const APP_VERSION = '14.0'; 
const CACHE_CORE = 'core-v' + APP_VERSION; 
const CACHE_DYNAMIC = 'dyn-v' + APP_VERSION;
const CACHE_CDN = 'cdn-v1'; 

const MAX_DYNAMIC_ITEMS = 50; 
const MAX_CDN_ITEMS = 20;

const OFFLINE_URL = 'offline.html';

const cdnDomains = [
  'unpkg.com', 
  'fonts.googleapis.com', 
  'fonts.gstatic.com', 
  'cdn.jsdelivr.net'
];

// ==========================================
// MANAJEMEN MEMORI (ANTI-LAG)
// ==========================================

// Gembok per-namespace agar pembersihan CDN dan Dynamic tidak saling memblokir
let isTrimming = {}; 

// Menghapus file lama agar CPU HP tidak macet
async function trimCache(cacheName, maxItems) {
  if (isTrimming[cacheName]) return; 
  isTrimming[cacheName] = true;
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length > maxItems) {
      const keysToDelete = keys.slice(0, keys.length - maxItems);
      for (let key of keysToDelete) {
        await cache.delete(key);
      }
    }
  } catch (err) {
    console.warn('[SW] Gagal membersihkan memori:', err);
  } finally {
    isTrimming[cacheName] = false;
  }
}

// Mengecek sisa kapasitas penyimpanan HP
async function manageStorage() {
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const quota = await navigator.storage.estimate();
      if (quota.usage / quota.quota > 0.8) {
        console.log('[SW] Memori penuh, melakukan pembersihan ekstra...');
        await trimCache(CACHE_DYNAMIC, 20); 
      }
    } catch(e) {}
  }
}

// ==========================================
// SIKLUS HIDUP SERVICE WORKER
// ==========================================

self.addEventListener('install', event => {
  self.skipWaiting(); 
  
  // FIX KRITIS: Pisahkan file KRUSIAL dan OPSIONAL untuk mencegah "Atomic Install Trap (Error 404)"
  const criticalUrls = ['./', './index.html'];
  const optionalUrls = [
    OFFLINE_URL, 
    './manifest.json',
    'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js',
    'https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js',
    'https://fonts.googleapis.com/css2?family=Audiowide&family=Montserrat:wght@400;500;600;700;800&display=swap'
  ];

  event.waitUntil(
    caches.open(CACHE_CORE).then(async cache => {
      // 1. Wajib Mutlak (SW batal install HANYA jika index.html gagal)
      await cache.addAll(criticalUrls);
      
      // 2. Opsional & CDN (Aman dari kegagalan berantai jika server mati/file 404)
      optionalUrls.forEach(url => {
        fetch(new Request(url, { cache: 'reload' }))
          .then(res => { if (res.ok) cache.put(url, res); })
          .catch(err => console.warn('[SW] Aset opsional tertunda (aman):', url));
      });
    }).catch(err => console.error('[SW] Instalasi PWA Gagal Total:', err))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(keys.map(key => {
        // Hapus versi aplikasi yang sudah usang
        if (key !== CACHE_CORE && key !== CACHE_DYNAMIC && key !== CACHE_CDN) {
          return caches.delete(key); 
        }
      }));
    }).then(() => {
      manageStorage(); 
      return self.clients.claim();
    }) 
  );
});

// ==========================================
// PENCEGATAN LALU LINTAS JARINGAN (ROUTING)
// ==========================================

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // BYPASS: Abaikan permintaan non-GET dan API Google Sheets
  if (req.method !== 'GET' || url.hostname.includes('script.google') || !url.protocol.startsWith('http')) return;

  // ---------------------------------------------------------
  // STRATEGI 1: Stale-While-Revalidate untuk File Utama HTML (Anti Race-Condition)
  // ---------------------------------------------------------
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname.includes('index.html')) {
    event.respondWith(
      (async () => {
        const cleanReqUrl = req.url.split('?')[0];
        let cachedRes = null;

        try {
          const cache = await caches.open(CACHE_CORE);
          // Prioritas 1: Berikan UI dari memori lokal (Fastest Response)
          cachedRes = await cache.match(cleanReqUrl, { ignoreSearch: true }) || 
                      await cache.match('./index.html', { ignoreSearch: true }) || 
                      await cache.match('./', { ignoreSearch: true });
        } catch (err) {
          console.error('[SW] Cache API Crash (Storage diblokir)!', err);
        }

        // Jalankan Fetch di background tanpa waitUntil ganda (mengamankan Lifecycle)
        const fetchPromise = fetch(req).then(async (res) => {
          if (res.ok && !res.redirected && res.type !== 'opaque') {
            try {
              const cache = await caches.open(CACHE_CORE);
              await cache.put(cleanReqUrl, res.clone());
            } catch (e) {} // Abaikan error jika storage korup saat menyimpan
          }
          return res;
        }).catch(() => null);

        // Jika cache ada, langsung kirimkan ke layar (0 ms load time)
        if (cachedRes) {
           // Background sync tetap berjalan secara asinkron (mengunci pembaruan di latar belakang)
           event.waitUntil(fetchPromise); 
           return cachedRes;
        }

        // Jika tidak ada di cache (Install pertama kali atau memori kehapus), tunggu jaringan
        const networkRes = await fetchPromise;
        if (networkRes) return networkRes;

        // Failsafe 1: Coba ambil halaman darurat (offline.html)
        try {
          const cache = await caches.open(CACHE_CORE);
          const offlinePage = await cache.match(OFFLINE_URL, { ignoreSearch: true });
          if (offlinePage) return offlinePage;
        } catch (e) {}

        // Failsafe Absolut: Tampilkan HTML statis Peringatan Jaringan
        return new Response(
          `<!DOCTYPE html><html><body style="background:#000;color:#f00;text-align:center;padding:50px;font-family:sans-serif;"><h2>⚠️ Sistem Offline</h2><p>Pastikan Anda tersambung ke internet untuk sinkronisasi awal aplikasi ke dalam perangkat.</p></body></html>`,
          { headers: { 'Content-Type': 'text/html' }, status: 503 }
        );
      })()
    );
    return;
  }

  // ---------------------------------------------------------
  // STRATEGI 2: Cache-First Murni untuk CDN Eksternal
  // ---------------------------------------------------------
  if (cdnDomains.some(domain => url.hostname.includes(domain))) {
    event.respondWith(
      caches.match(req).then(cachedRes => {
        // Jika ada di cache, langsung kembalikan TANPA request ke jaringan (Anti Bocor Kuota)
        if (cachedRes) return cachedRes; 
        
        // Jika tidak ada di cache, baru download dan simpan
        const fetchPromiseCDN = fetch(req).then(res => {
          const contentType = res.headers.get('content-type') || '';
          if (res.ok && res.type !== 'opaque' && !contentType.includes('text/html')) {
            const resClone = res.clone();
            caches.open(CACHE_CDN).then(async cache => { 
              await cache.put(req, resClone); 
              await trimCache(CACHE_CDN, MAX_CDN_ITEMS); 
            }).catch(() => console.warn('[SW] Gagal simpan CDN lokal'));
          }
          return res;
        }).catch(() => new Response('', { status: 503 }));

        return fetchPromiseCDN;
      })
    );
    return;
  }

  // ---------------------------------------------------------
  // STRATEGI 3: Stale-While-Revalidate untuk Aset Dinamis
  // ---------------------------------------------------------
  const fetchPromiseDyn = fetch(req).then(res => {
    const contentType = res.headers.get('content-type') || '';
    if (res.ok && res.type !== 'opaque' && !contentType.includes('text/html')) {
      const resClone = res.clone();
      caches.open(CACHE_DYNAMIC).then(async cache => {
        const cleanUrl = req.url.split('?')[0];
        try {
          await cache.put(cleanUrl, resClone); 
          await trimCache(CACHE_DYNAMIC, MAX_DYNAMIC_ITEMS); 
        } catch (err) {}
      });
    }
    return res;
  }).catch(() => null);

  // Eksekusi WaitUntil Sinkron
  event.waitUntil(fetchPromiseDyn);

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(cachedRes => {
      if (cachedRes) return cachedRes; 
      return fetchPromiseDyn.then(res => res || new Response('', { status: 503 }));
    })
  );
});
