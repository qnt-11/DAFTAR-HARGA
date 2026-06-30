// ====================================
// SERVICE WORKER (PWA KASIR ENTERPRISE)
// ====================================

const APP_VERSION = '1.6'; 
const CACHE_CORE = 'core-v' + APP_VERSION; 
const CACHE_DYNAMIC = 'dyn-v' + APP_VERSION;
const CACHE_CDN = 'cdn-v1'; 

const MAX_DYNAMIC_ITEMS = 50; 
const MAX_CDN_ITEMS = 100; // [SURGICAL FIX] Ditambah untuk mengamankan Core WASM & TrainedData AI

const OFFLINE_URL = 'offline.html';

const cdnDomains = [
  'unpkg.com', 
  'fonts.googleapis.com', 
  'fonts.gstatic.com'
];

// ==========================================
// MANAJEMEN MEMORI (ANTI-LAG)
// ==========================================
let isTrimming = {}; 

// [SURGICAL FIX] Mutex Lock Atomic System (Anti-Memory Leak)
async function trimCache(cacheName, maxItems) {
  if (isTrimming[cacheName]) return; 
  isTrimming[cacheName] = true;
  
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length > maxItems) {
      const keysToDelete = keys.slice(0, keys.length - maxItems);
      await Promise.all(keysToDelete.map(key => cache.delete(key)));
    }
  } catch (err) {
    console.warn('[SW] Gagal membersihkan memori:', err);
  } finally {
    isTrimming[cacheName] = false;
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
                  // SURGICAL FIX: Caching secara individual (Atomic Bypass). Jika offline.html 404, index.html tetap aman di-cache!
                  await Promise.all(
                    criticalUrls.map(url => cache.add(url).catch(e => console.warn(`[SW] Lewati file hilang: ${url}`)))
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
        }).then(async () => {
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

    // [QA LEAD FIX] Filter mutlak: Cegah Service Worker membajak navigasi ke situs eksternal
  if (req.method !== 'GET' || url.hostname.includes('script.google') || !url.protocol.startsWith('http')) return;
  if (req.mode === 'navigate' && url.origin !== self.location.origin) return;

  // ---------------------------------------------------------
  // STRATEGI 1: Network-First untuk File Utama HTML
  // ---------------------------------------------------------
    if (req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('index.html')) {
    const cleanReqUrl = req.url.split('?')[0];
    
    // [QA LEAD FIX] Tarik eksekusi fetch ke hulu secara SINKRON absolut di Thread Utama SW
                const pFetch = fetch(req).then(res => { // [ELITE QA FIX] Hapus `async` untuk memutus belenggu Deadlock I/O
      if (res && res.ok && res.type !== 'error' && res.type !== 'opaque') {
        const resToCache = res.clone();
        const pwaRoot = new URL('./', self.location).href;
        const isCore = cleanReqUrl === pwaRoot || cleanReqUrl === pwaRoot + 'index.html' || cleanReqUrl.endsWith(OFFLINE_URL);
        const targetCacheName = isCore ? CACHE_CORE : CACHE_DYNAMIC;
        
        // [QA LEAD FIX] Lempar operasi disk (tulis cache/trim) ke thread background terisolasi tanpa await!
        caches.open(targetCacheName).then(async cache => {
          await cache.put(cleanReqUrl, resToCache); 
          if (!isCore) await trimCache(CACHE_DYNAMIC, MAX_DYNAMIC_ITEMS);
        }).catch(() => {});
      }
      return res; // Murni me-return respons ke layar UI SECEPAT KILAT
    });

    // [QA LEAD FIX] Daftarkan waitUntil secara SINKRON pada First-Tick (Mencegah InvalidStateError)
    event.waitUntil(pFetch.catch(() => {}));

    event.respondWith(
      (async () => {
                let cachedRes = null;
        try {
          // [SURGICAL FIX] Cari di seluruh namespace (CORE & DYNAMIC) untuk mencegah Write-Only / I/O Waste pada navigasi dinamis
          cachedRes = await caches.match(cleanReqUrl, { ignoreSearch: true });
          if (!cachedRes) {
            const cacheCore = await caches.open(CACHE_CORE);
            cachedRes = await cacheCore.match('./index.html', { ignoreSearch: true }) || 
                        await cacheCore.match('./', { ignoreSearch: true });
          }
        } catch (err) { console.error('[SW] Cache API Crash!', err); }

                let timeoutId;
        const fetchPromise = Promise.race([
          pFetch.finally(() => clearTimeout(timeoutId)),
          ...(cachedRes ? [new Promise((_, reject) => timeoutId = setTimeout(() => reject(new Error('Timeout')), 4000))] : [])
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
          `<!DOCTYPE html><html><body style="background:#000;color:#f00;text-align:center;padding:50px;font-family:sans-serif;"><h2>⚠️ Sistem Offline</h2><p>Pastikan tersambung internet untuk sinkronisasi awal.</p></body></html>`,
          { headers: { 'Content-Type': 'text/html' }, status: 503 }
        );
      })()
    );
    return;
  }

  // ---------------------------------------------------------
  // STRATEGI 2: Cache-First Murni untuk CDN Eksternal (Termasuk AI OCR)
  // ---------------------------------------------------------
      if (cdnDomains.some(domain => url.hostname.includes(domain))) {
    let taskResolver;
    const lifeLock = new Promise(r => { taskResolver = r; });
    // [QA LEAD FIX] Kunci siklus hidup SW secara SINKRON di hulu menggunakan Master Resolver
    event.waitUntil(lifeLock); 

    event.respondWith(
            caches.match(req.url).catch(() => null).then(cachedRes => {
        if (cachedRes) {
          taskResolver(); // Matikan kunci hidup, SW boleh tidur
          return cachedRes;
        }

                                                           // [SURGICAL FIX] Cabut pemaksaan Mode CORS agar tidak memblokir resource pihak ketiga
                const fetchReq = req;
                return fetch(fetchReq).then(async res => {
          const contentType = res.headers.get('content-type') || '';
          
          if (res && (res.ok || res.type === 'opaque') && res.type !== 'error' && !contentType.includes('text/html')) {
            const resToCache = res.clone();
            caches.open(CACHE_CDN).then(async cache => {
              await cache.put(req.url, resToCache); // SURGICAL FIX: Gunakan req.url agar tidak memicu "Body already used" TypeError
              await trimCache(CACHE_CDN, MAX_CDN_ITEMS);
            }).catch(() => {}).finally(taskResolver);
          } else {
            taskResolver();
          }
          return res;
        }).catch(err => {
          taskResolver();
          return new Response('', { status: 503 });
        });
      })
    );
    return;
  }

  // ---------------------------------------------------------
  // STRATEGI 3: Stale-While-Revalidate untuk Aset Dinamis
  // ---------------------------------------------------------
        // [QA LEAD FIX] Tarik fetch jaringan ke hulu secara SINKRON instan (SWR selalu butuh jaringan)
    const pFetchDyn = fetch(req).then(networkRes => { // [ELITE QA FIX] Hapus `async`
    if (networkRes && networkRes.ok && networkRes.type !== 'error' && networkRes.type !== 'opaque') {
      const contentType = networkRes.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) {
        const resToCache = networkRes.clone();
        // [QA LEAD FIX] Tulis cache dinamis di luar pipeline rendering utama
        caches.open(CACHE_DYNAMIC).then(async cache => {
          await cache.put(req.url, resToCache); 
          await trimCache(CACHE_DYNAMIC, MAX_DYNAMIC_ITEMS); 
        }).catch(() => {});
      }
    }
    return networkRes; // Langsung lepaskan objek ke layar browser
  }).catch(() => null);

  // [QA LEAD FIX] Daftarkan ke waitUntil secara SINKRON absolut di Thread Utama
  event.waitUntil(pFetchDyn);

                                event.respondWith(
                caches.match(req.url).catch(() => null).then(cachedRes => { // SURGICAL FIX: Gunakan req.url untuk memblokir anomali TypeError "Consumed Request" di iOS/WebKit
                  if (cachedRes) return cachedRes; 
                  return pFetchDyn.then(res => {
                    return res || new Response('', { status: 503, statusText: 'Service Unavailable' });
                  });
                })
              );
            }); // [QA LEAD FIX] Penutup Event Listener 'fetch' yang hilang (FATAL SYNTAX ERROR)

// ==========================================
// BACKGROUND SYNC (OFFLINE MUTATION & SILENT UPLOAD)
// ==========================================
self.addEventListener('sync', event => {
  if (event.tag === 'sync-transaksi-cloud') {
    event.waitUntil(processOfflineBackup());
  }
});

let isSyncing = false;
async function processOfflineBackup() {
  if (isSyncing) return Promise.resolve();
  
  // [SURGICAL FIX] Kill-Switch untuk mencegah loop penguras baterai jika offline
  if (!navigator.onLine) return Promise.reject(new Error("Perangkat masih offline. Sinkronisasi ditunda."));
  
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
      tx.onabort = () => { idb.close(); reject(new Error("Transaksi Readonly dibatalkan OS.")); };
      tx.onerror = (e) => { idb.close(); reject(new Error("Transaksi Readonly Error.")); };
      const store = tx.objectStore('sync-outbox');
      
      // [SURGICAL FIX] Gunakan Cursor mundur (prev) untuk LIFO. 
      // DILARANG KERAS menggunakan getAll() karena akan memicu RAM OOM Kill jika antrean menumpuk!
      const getReq = store.openCursor(null, 'prev'); 
      
      getReq.onsuccess = async (event) => {
        const cursor = event.target.result;
        if (!cursor) {
            idb.close();
            return resolve();
        }
        
        const payload = cursor.value; 
        const payloadKey = cursor.primaryKey; // [ELITE QA FIX] Tangkap Kunci Primer Absolut
          try {
            const CLOUD_API = "https://script.google.com/macros/s/AKfycbyCXVmNZkntttxcEcyIl0yuWWkT0oRP9znyS5mF_EbpIr5hoywK4fUYib_YDtptDyn6/exec";
            
                        // [SURGICAL FIX: Tarik kebenaran absolut via Cursor (OOM-Proof) untuk mengganti payload.data yang dikosongkan]
                        // [ELITE QA FIX] Streaming String Serialization (OOM-Proof Memory Compression)
            const backupPayloadStr = await new Promise((res, rej) => {
                const txItems = idb.transaction('items', 'readonly');
                const store = txItems.objectStore('items');
                const req = store.openCursor();
                let jsonStream = '{"action":"backup","data":[';
                let isFirst = true;
                
                req.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (cursor) {
                        let item = cursor.value;
                        if (!item._isGhost) {
                            delete item._cHeight; 
                            if (!isFirst) jsonStream += ',';
                            jsonStream += JSON.stringify(item);
                            isFirst = false;
                        }
                        cursor.continue();
                    } else {
                        jsonStream += ']}';
                        res(jsonStream); // Kirim string rakitan akhir, RAM aman dari penumpukan Array
                    }
                };
                req.onerror = () => rej(new Error("Gagal merakit stream store items"));
            });

            const resData = await fetch(CLOUD_API, {
              method: 'POST', body: backupPayloadStr
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
          const verifyReq = storeDel.openCursor(null, 'prev'); // Cek apakah ada antrean yang LEBIH BARU masuk saat proses upload berjalan

          verifyReq.onsuccess = (e) => {
              storeDel.delete(payloadKey); // Hapus SECARA SPESIFIK HANYA transaksi yang berhasil di-upload
              
              const checkCursor = e.target.result;
              if (checkCursor && checkCursor.value.timestamp !== payload.timestamp) {
                  console.warn('[SW] Mutasi sisa antrean offline terdeteksi. Menunggu siklus sync berlanjut.');
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
        reject(new Error("Gagal membaca antrean Sync IDB: " + (e.target.error && e.target.error.message ? e.target.error.message : "Unknown Error")));
      };

      };
    req.onerror = (e) => reject(new Error("Gagal membuka database: " + (e.target.error && e.target.error.message ? e.target.error.message : "Access Denied/Unknown Error")));
  }).finally(() => { isSyncing = false; });
}
