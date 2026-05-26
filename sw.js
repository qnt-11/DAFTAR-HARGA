// ==========================================
// SERVICE WORKER (PWA KASIR ENTERPRISE)
// ==========================================

// PENTING: Naikkan angka APP_VERSION setiap kali Anda mengubah isi index.html, CSS, atau logika sistem!
const APP_VERSION = '12.9'; 
const CACHE_CORE = 'core-v' + APP_VERSION; 
const CACHE_DYNAMIC = 'dyn-v' + APP_VERSION;
const CACHE_CDN = 'cdn-v1'; 

const MAX_DYNAMIC_ITEMS = 50; 
const MAX_CDN_ITEMS = 20;

// Daftar file pondasi yang WAJIB diunduh saat instalasi pertama
const coreUrls = [
  './', 
  './index.html', 
  './offline.html',
  './manifest.json',
  'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js',
  'https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://fonts.googleapis.com/css2?family=Audiowide&family=Montserrat:wght@400;500;600;700;800&display=swap'
];

const cdnDomains = [
  'unpkg.com', 
  'fonts.googleapis.com', 
  'fonts.gstatic.com', 
  'cdn.jsdelivr.net'
];

// ==========================================
// MANAJEMEN MEMORI (ANTI-LAG)
// ==========================================

let isTrimming = false;

// Menghapus file lama agar CPU HP tidak macet
async function trimCache(cacheName, maxItems) {
  if (isTrimming) return; 
  isTrimming = true;
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
    isTrimming = false;
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
  event.waitUntil(
    caches.open(CACHE_CORE).then(cache => {
      // Menggunakan Promise.all agar instalasi batal jika 1 file inti gagal unduh (Mencegah Instalasi Ilusi)
      return Promise.all(
        coreUrls.map(url => {
          return fetch(new Request(url, { cache: 'reload' })).then(res => {
            if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
            return cache.put(url, res);
          });
        })
      );
    }).catch(err => console.error('[SW] Instalasi PWA Gagal, akan mencoba lagi:', err))
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
  // STRATEGI 1: Stale-While-Revalidate untuk File Utama HTML
  // ---------------------------------------------------------
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname.includes('index.html')) {
    const fetchPromiseHTML = fetch(req).then(res => {
      // Menolak halaman yang dialihkan (redirect) oleh WiFi Publik
      if (res.ok && !res.redirected && res.type !== 'opaque') {
        const resClone = res.clone();
        caches.open(CACHE_CORE).then(cache => cache.put(req.url.split('?')[0], resClone));
      }
      return res;
    }).catch(() => null);

    // Eksekusi janji jaringan di background agar tersinkronisasi
    event.waitUntil(fetchPromiseHTML);

    event.respondWith(
      caches.open(CACHE_CORE).then(async cache => {
        const cleanReqUrl = req.url.split('?')[0];
        
        // PERBAIKAN KRITIS: Tambahan ignoreSearch agar Deep Link dari WhatsApp tetap bisa memuat Cache Offline
        const cachedRes = await cache.match(cleanReqUrl, { ignoreSearch: true }) || 
                          await cache.match('./index.html', { ignoreSearch: true }) || 
                          await cache.match('./', { ignoreSearch: true });

        // Berikan UI dari memori seketika (0 detik)
        if (cachedRes) return cachedRes;

        const res = await fetchPromiseHTML;
        if (res) return res;

        // Failsafe cerdas: Jika jaringan mati total, arahkan ke Mode Darurat
        const offlinePage = await cache.match('./offline.html');
        if (offlinePage) return offlinePage;
        
        // Failsafe darurat jika aplikasi benar-benar belum pernah ter-install
        return new Response(
          `<!DOCTYPE html><html><body style="background:#000;color:#f00;text-align:center;padding:50px;font-family:sans-serif;"><h2>⚠️ Sistem Offline</h2><p>Pastikan Anda tersambung ke internet untuk sinkronisasi awal aplikasi ke dalam perangkat.</p></body></html>`,
          { headers: { 'Content-Type': 'text/html' } }
        );
      })
    );
    return;
  }

  // ---------------------------------------------------------
  // STRATEGI 2: Cache-First untuk CDN Eksternal
  // ---------------------------------------------------------
  if (cdnDomains.some(domain => url.hostname.includes(domain))) {
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

    // Mencegah Crash Browser karena Siklus Berakhir Prematur
    event.waitUntil(fetchPromiseCDN);

    event.respondWith(
      caches.match(req).then(cachedRes => {
        if (cachedRes) return cachedRes; // Jika CDN ada di HP, pakai langsung
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
