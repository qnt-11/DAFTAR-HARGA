// ==========================================
// SERVICE WORKER (PWA KASIR ENTERPRISE)
// ==========================================

const APP_VERSION = '15.9'; 
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

let isTrimming = {}; 

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

async function manageStorage() {
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const quota = await navigator.storage.estimate();
      if (quota.quota && (quota.usage / quota.quota > 0.8)) {
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
      await cache.addAll(criticalUrls);
      
      await Promise.allSettled(
        optionalUrls.map(url => 
          fetch(new Request(url, { cache: 'reload' }))
            .then(res => { 
              if (res.ok) return cache.put(url, res); 
            })
            .catch(err => console.warn('[SW] Aset opsional tertunda:', url))
        )
      );
    }).catch(err => console.error('[SW] Instalasi PWA Gagal Total:', err))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(keys.map(key => {
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

  if (req.method !== 'GET' || url.hostname.includes('script.google') || !url.protocol.startsWith('http')) return;

  // ---------------------------------------------------------
  // STRATEGI 1: Network-First untuk File Utama HTML
  // ---------------------------------------------------------
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname.includes('index.html')) {
    event.respondWith(
      (async () => {
        const cleanReqUrl = req.url.split('?')[0];
        let cachedRes = null;

        try {
          const cache = await caches.open(CACHE_CORE);
          cachedRes = await cache.match(cleanReqUrl, { ignoreSearch: true }) || 
                      await cache.match('./index.html', { ignoreSearch: true }) || 
                      await cache.match('./', { ignoreSearch: true });
        } catch (err) {
          console.error('[SW] Cache API Crash (Storage diblokir)!', err);
        }

        const pFetch = fetch(req).then(async (res) => {
          if (res && res.ok) {
            try {
              const cache = await caches.open(CACHE_CORE);
              await cache.put(cleanReqUrl, res.clone()); 
            } catch (err) {}
          }
          return res;
        });
        pFetch.catch(() => {});
        event.waitUntil(pFetch); // Mitigasi Lie-Fi: Menjaga background download tetap hidup
        
        const fetchPromise = Promise.race([
          pFetch,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 4000))
        ]).then((res) => {
          return res;
        }).catch(() => null);

        const networkRes = await fetchPromise;
        if (networkRes && networkRes.ok) return networkRes;

        if (cachedRes) {
           return cachedRes;
        }

        try {
          const cache = await caches.open(CACHE_CORE);
          const offlinePage = await cache.match(OFFLINE_URL, { ignoreSearch: true });
          if (offlinePage) return offlinePage;
        } catch (e) {}

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
        if (cachedRes) return cachedRes; 
        
        const fetchPromiseCDN = fetch(req).then(async res => {
          const contentType = res.headers.get('content-type') || '';
          if (res.ok && !contentType.includes('text/html')) {
            const resClone = res.clone();
            try {
              const cache = await caches.open(CACHE_CDN);
              await cache.put(req, resClone); 
              await trimCache(CACHE_CDN, MAX_CDN_ITEMS); 
            } catch (err) { console.warn('[SW] Gagal simpan CDN lokal', err); }
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
  const fetchPromiseDyn = fetch(req).then(async res => {
    const contentType = res.headers.get('content-type') || '';
    if (res.ok && !contentType.includes('text/html')) {
      const resClone = res.clone();
      try {
        const cache = await caches.open(CACHE_DYNAMIC);
        const cleanUrl = req.url.split('?')[0];
        await cache.put(cleanUrl, resClone); 
        await trimCache(CACHE_DYNAMIC, MAX_DYNAMIC_ITEMS); 
      } catch (err) {}
    }
    return res;
  }).catch(() => null);

  event.waitUntil(fetchPromiseDyn);

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(cachedRes => {
      if (cachedRes) return cachedRes; 
      return fetchPromiseDyn.then(res => res || new Response('', { status: 503 }));
    })
  );
});

// ==========================================
// BACKGROUND SYNC (OFFLINE MUTATION)
// ==========================================
self.addEventListener('sync', event => {
  if (event.tag === 'sync-transaksi-cloud') {
    event.waitUntil(processOfflineBackup());
  }
});

async function processOfflineBackup() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('HargaDB_Pro'); 
    req.onsuccess = (e) => {
      const idb = e.target.result;
      if (!idb.objectStoreNames.contains('sync-outbox')) return resolve();
      
      const tx = idb.transaction('sync-outbox', 'readonly');
      const store = tx.objectStore('sync-outbox');
      const getReq = store.get('pending-backup');
      
      getReq.onsuccess = async () => {
        if (!getReq.result) return resolve();
        const payload = getReq.result;
        
        try {
          const CLOUD_API = "https://script.google.com/macros/s/AKfycbxxQqHYzg5lZpswUYvFgKmR70p8jOcF9psrRHPb0h1s0r1iMEW7hkKrd8ZhPIpWkgBQ/exec";
          
          // 1. Eksekusi Backup Data Barang
          const resData = await fetch(CLOUD_API, {
            method: 'POST', body: JSON.stringify({ action: 'backup', data: payload.data })
          });
          if (!resData.ok) throw new Error("Network Error"); 
          
          let jsonResData;
          try { 
            jsonResData = await resData.json(); 
          } catch(e) { 
            return reject(new Error("API mengembalikan non-JSON (Tercegat Captive Portal/Wi-Fi). Sync ditunda demi keamanan data."));
          }
          if (jsonResData.status !== "success") throw new Error("Server Sibuk: Data Barang gagal disinkronkan");

          // 2. Eksekusi Backup Riwayat
          const resHist = await fetch(CLOUD_API, {
            method: 'POST', body: JSON.stringify({ action: 'backupHistory', data: payload.history })
          });
          if (!resHist.ok) throw new Error("Network Error");
          
          let jsonResHist;
          try { 
            jsonResHist = await resHist.json(); 
          } catch(e) {
            return reject(new Error("Gagal parsing JSON Riwayat. Sinkronisasi ditunda."));
          }
          if (jsonResHist.status !== "success") throw new Error("Server Sibuk: Riwayat gagal disinkronkan");

          // 3. Hapus antrean jika 100% SUKSES mendarat di Cloud
          const txDel = idb.transaction('sync-outbox', 'readwrite');
          txDel.objectStore('sync-outbox').delete('pending-backup');
          txDel.oncomplete = () => resolve();
        } catch (err) {
          // Rejeksi untuk memicu retry otomatis oleh Service Worker saat jaringan stabil
          reject(err); 
        }
      };
    };
    req.onerror = () => reject();
  });
}
