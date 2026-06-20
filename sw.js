// ==================================
// SERVICE WORKER (PWA KASIR ENTERPRISE)
// ==================================

const APP_VERSION = '17.8'; 
const CACHE_CORE = 'core-v' + APP_VERSION; 
const CACHE_DYNAMIC = 'dyn-v' + APP_VERSION;
const CACHE_CDN = 'cdn-v1'; 

const MAX_DYNAMIC_ITEMS = 50; 
const MAX_CDN_ITEMS = 20;

const OFFLINE_URL = 'offline.html';

const cdnDomains = [
  'unpkg.com', 
  'fonts.googleapis.com', 
  'fonts.gstatic.com'
];

// ==========================================
// MANAJEMEN MEMORI (ANTI-LAG)
// ==========================================

let trimQueues = {}; 

// [SURGICAL FIX] Enterprise Promise Queueing System (Anti-Bypass)
function trimCache(cacheName, maxItems) {
  if (!trimQueues[cacheName]) {
    trimQueues[cacheName] = Promise.resolve();
  }
  
  trimQueues[cacheName] = trimQueues[cacheName].then(async () => {
    try {
      const cache = await caches.open(cacheName);
      const keys = await cache.keys();
      if (keys.length > maxItems) {
        const keysToDelete = keys.slice(0, keys.length - maxItems);
        await Promise.all(keysToDelete.map(key => cache.delete(key)));
      }
    } catch (err) {
      console.warn('[SW] Gagal membersihkan memori:', err);
    }
  }).catch(() => {}); // Catch inline agar antrean tidak macet jika terjadi error
  
  return trimQueues[cacheName];
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
  
  // [ENHANCEMENT MUTLAK]: OFFLINE_URL dipindah ke core agar aplikasi tidak crash saat offline pertama kali
  const criticalUrls = ['./', './index.html', OFFLINE_URL, './manifest.json'];

  event.waitUntil(
    caches.open(CACHE_CORE).then(async cache => {
      await cache.addAll(criticalUrls);
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
    }).then(async () => {
      await manageStorage(); 
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
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('index.html')) {
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

                        const pFetch = fetch(req).then(async res => {
          if (res && res.ok && res.type !== 'error' && res.type !== 'opaque') {
            const resToCache = res.clone(); // Kloning instan absolut sebelum browser membaca
            try { 
              const cache = await caches.open(CACHE_CORE); 
              await cache.put(cleanReqUrl, resToCache); 
            } catch(e) {}
          }
          return res;
        });

                // [SURGICAL FIX] Daftarkan promise ke waitUntil secara SINKRON untuk mencegah SW dibunuh
        event.waitUntil(pFetch.catch(() => {}));

        let timeoutId;
        const fetchPromise = Promise.race([
          pFetch.finally(() => clearTimeout(timeoutId)),
          new Promise((_, reject) => timeoutId = setTimeout(() => reject(new Error('Timeout')), 4000))
        ]).catch(() => null);

        const networkRes = await fetchPromise;
        if (networkRes && (networkRes.ok || networkRes.status === 0)) return networkRes;

        if (cachedRes) return cachedRes;

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
      caches.match(req).catch(() => null).then(cachedRes => {
        if (cachedRes) return cachedRes; 
        
                const fetchReqCDN = fetch(req).then(res => {
          const contentType = res.headers.get('content-type') || '';
          if ((res.ok || res.status === 0) && !contentType.includes('text/html')) {
            const resToCache = res.clone();
            event.waitUntil((async () => {
              try { 
                const cache = await caches.open(CACHE_CDN); 
                await cache.put(req, resToCache); 
                await trimCache(CACHE_CDN, MAX_CDN_ITEMS); 
              } catch(err) { console.warn('[SW] Gagal simpan CDN lokal', err); }
            })());
          }
          return res;
        });

        return fetchReqCDN.catch(() => new Response('', { status: 503 }));
      })
    );
    return;
  }

  // ---------------------------------------------------------
  // STRATEGI 3: Stale-While-Revalidate untuk Aset Dinamis
  // ---------------------------------------------------------
    event.respondWith(
    caches.match(req, { ignoreSearch: true }).catch(() => null).then(cachedRes => {
      const fetchReqDyn = fetch(req).then(networkRes => {
        if (networkRes && networkRes.ok && networkRes.type !== 'error' && networkRes.type !== 'opaque') {
          const contentType = networkRes.headers.get('content-type') || '';
          if (!contentType.includes('text/html')) {
            const resToCache = networkRes.clone();
            event.waitUntil((async () => {
              try { 
                            const cache = await caches.open(CACHE_DYNAMIC); 
                            const cleanUrl = req.url.split('?')[0]; 
                            await cache.delete(cleanUrl); // [SURGICAL FIX] Paksa perbarui indeks LRU ke antrean paling belakang
                            await cache.put(cleanUrl, resToCache); 
                            await trimCache(CACHE_DYNAMIC, MAX_DYNAMIC_ITEMS); 
              } catch(e) {}
            })());
          }
        }
        return networkRes;
      });

      // PERISAI MUTLAK: Tahan nyawa Service Worker hingga fetch latar belakang selesai
      event.waitUntil(fetchReqDyn.catch(() => {}));

      if (cachedRes) return cachedRes;

      return fetchReqDyn.catch(() => null).then(res => {
         if (res) return res;
         return new Response('', { status: 503, statusText: 'Service Unavailable' });
      });
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

let isSyncing = false;
async function processOfflineBackup() {
  if (isSyncing) return Promise.resolve();
  isSyncing = true;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('HargaDB_Pro'); 
    req.onsuccess = (e) => {
      const idb = e.target.result;
      
      if (!idb.objectStoreNames.contains('sync-outbox')) {
          idb.close();
          return resolve();
      }
      
      const tx = idb.transaction('sync-outbox', 'readonly');
      const store = tx.objectStore('sync-outbox');
      const getReq = store.get('pending-backup');
      
      getReq.onsuccess = async () => {
        if (!getReq.result) {
            idb.close();
            return resolve();
        }
        
        const payload = getReq.result;
        
        try {
          const CLOUD_API = "https://script.google.com/macros/s/AKfycbyQywfwKuEZ9I6knou0Q8t4S62H6cOQWI9iszXc5sJh4BDld2E1MvWC7lgGZLfT02XW/exec";
          
          const resData = await fetch(CLOUD_API, {
            method: 'POST', body: JSON.stringify({ action: 'backup', data: payload.data })
          });
          if (!resData.ok) throw new Error("Network Error"); 
          
          let jsonResData;
          try { 
            jsonResData = await resData.json(); 
          } catch(e) { 
            throw new Error("API mengembalikan non-JSON. Sync ditunda.");
          }
          if (jsonResData.status !== "success") throw new Error("Server Sibuk: Data Barang gagal disinkronkan");

          const resHist = await fetch(CLOUD_API, {
            method: 'POST', body: JSON.stringify({ action: 'backupHistory', data: payload.history })
          });
          if (!resHist.ok) throw new Error("Network Error");
          
          let jsonResHist;
          try { 
            jsonResHist = await resHist.json(); 
          } catch(e) {
            throw new Error("Gagal parsing JSON Riwayat. Sinkronisasi ditunda.");
          }
          if (jsonResHist.status !== "success") throw new Error("Server Sibuk: Riwayat gagal disinkronkan");

          const txDel = idb.transaction('sync-outbox', 'readwrite');
          const storeDel = txDel.objectStore('sync-outbox');
          const verifyReq = storeDel.get('pending-backup');

          verifyReq.onsuccess = () => {
              if (verifyReq.result && verifyReq.result.timestamp === payload.timestamp) {
                  storeDel.delete('pending-backup'); 
              } else {
                  console.warn('[SW] Mutasi transaksi baru terdeteksi saat proses upload berjalan. Antrean dipertahankan.');
              }
          };

                    txDel.oncomplete = () => { 
              idb.close(); 
              resolve(); 
          };
          txDel.onabort = () => { 
              idb.close(); 
              reject(new Error("Transaksi dibatalkan paksa oleh sistem.")); 
          };
          txDel.onerror = (e) => { 
              idb.close(); 
              reject(new Error("Gagal memvalidasi antrean IDB: " + e.target.error)); 
          };
        } catch (err) {
          idb.close(); 
          reject(err); 
        }
      };

      getReq.onerror = (e) => {
        idb.close();
        reject(new Error("Gagal membaca antrean Sync IDB: " + e.target.error));
      };

     };
    req.onerror = () => reject();
  }).finally(() => { isSyncing = false; });
}
