/*
 * Service Worker de lector.html — además de ser requisito para que
 * Chrome permita instalarla como app real (ver documentación), ahora
 * SÍ implementa caché: la primera vez que se abre con internet, guarda
 * una copia de los archivos necesarios, y los sirve desde esa copia
 * cuando no hay conexión. Sin esto, la app se "instala" pero igual
 * necesita red cada vez que se abre — que es justo lo que se quiere
 * evitar para el uso en el depósito.
 */

const CACHE_NAME = "lector-qr-v1";

// Cada vez que se cambie algo en estos archivos y se quiera forzar
// que los celulares ya instalados bajen la versión nueva, hay que
// subir el número de CACHE_NAME (ej. "lector-qr-v2") — los Service
// Workers no se actualizan solos si el archivo no cambia de nombre.
const ARCHIVOS_A_CACHEAR = [
  "lector.html",
  "manifest.json",
  "icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ARCHIVOS_A_CACHEAR))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Borra cachés de versiones anteriores, si las hubiera, para no
  // acumular archivos viejos sin uso en el celular.
  event.waitUntil(
    caches.keys().then((nombres) =>
      Promise.all(
        nombres
          .filter((nombre) => nombre !== CACHE_NAME)
          .map((nombre) => caches.delete(nombre))
      )
    )
  );
  self.clients.claim();
});

// Estrategia "cache-first": si el archivo ya está guardado, se sirve
// directo desde ahí (rápido, y funciona sin internet). Si no está en
// caché, se intenta pedir a la red como respaldo.
self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((respuestaCacheada) => {
      return respuestaCacheada || fetch(event.request);
    })
  );
});
