/**
 * Service Worker para INDUSTRIAS GOBY
 * Maneja caching, offline mode y actualización en segundo plano
 */

const CACHE_NAME = 'goby-v20';
const urlsToCache = [
    '/',
    '/index.html',
    '/manifest.json',
    '/browserconfig.xml',
    '/service-worker.js',
    '/assets/css/styles.css?v=20260504a',
    '/assets/js/rewards-catalog.js?v=20260420b',
    '/assets/js/contact-module.js?v=20260502a',
    '/assets/js/app.js?v=20260509a',
    '/assets/images/favicon-32.png',
    '/assets/images/favicon.svg',
    '/assets/images/icon-180.png',
    '/assets/images/icon-192.png',
    '/assets/images/icon-512.png',
    '/assets/images/GOBY MARCA REGISTRADA.png',
    'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js',
    'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js'
];

// Instalar Service Worker y cachear archivos
self.addEventListener('install', event => {
    console.log('📦 Instalando Service Worker...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('✅ Cache abierto');
                return cache.addAll(urlsToCache).catch(err => {
                    console.warn('⚠️ Algunos archivos no pudieron ser cacheados:', err);
                    // Continuar incluso si algunos archivos fallan
                    return Promise.resolve();
                });
            })
            .then(() => self.skipWaiting())
    );
});

// Activar Service Worker y limpiar cachés antiguos
self.addEventListener('activate', event => {
    console.log('🚀 Activando Service Worker...');
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('🗑️ Eliminando cache antigua:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// Estrategia de red primero, cache como fallback
self.addEventListener('fetch', event => {
    // Solo cachear requests GET
    if (event.request.method !== 'GET') {
        return;
    }

    // No cachear API calls (rutas que comienzan con /api)
    if (event.request.url.includes('/api')) {
        event.respondWith(
            fetch(event.request)
                .catch(() => new Response('Offline - API no disponible', { status: 503 }))
        );
        return;
    }

    // Estrategia: Network first, fallback to cache
    event.respondWith(
        fetch(event.request)
            .then(response => {
                // Cachear la respuesta si es exitosa
                if (!response || response.status !== 200 || response.type === 'error') {
                    return response;
                }
                
                const responseToCache = response.clone();
                caches.open(CACHE_NAME)
                    .then(cache => {
                        cache.put(event.request, responseToCache);
                    });
                
                return response;
            })
            .catch(() => {
                // Fallback a cache si la red no está disponible
                return caches.match(event.request)
                    .then(response => {
                        return response || new Response('Offline - Página no disponible', {
                            status: 503,
                            statusText: 'Service Unavailable',
                            headers: new Headers({
                                'Content-Type': 'text/plain'
                            })
                        });
                    });
            })
    );
});

// Escuchar mensajes desde el cliente
self.addEventListener('message', event => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});
