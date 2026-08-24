/*
 * Service Worker de la PWA de Reportes.
 *
 * Esta PWA SIEMPRE necesita conexión para mostrar datos (los reportes
 * se piden en vivo al backend), así que el único objetivo de este
 * Service Worker es:
 *   1) Permitir que Chrome/Safari la dejen instalar como app real.
 *   2) Que la interfaz (HTML/CSS/JS) cargue rápido y no se rompa si
 *      hay un segundo de mala señal al abrir la app.
 *
 * Estrategia "network-first": siempre intenta traer la versión más
 * nueva de internet primero; si no hay conexión, usa la última copia
 * guardada. Así nunca hace falta cambiar manualmente un número de
 * versión para que se vean los cambios — al haber internet, siempre
 * se actualiza solo.
 *
 * Importante: las llamadas a la API de reportes (script.google.com)
 * NUNCA se cachean — los reportes siempre se piden en vivo.
 */

const CACHE_NAME = "reportes-jireh-v1";

const ARCHIVOS_A_CACHEAR = [
  "login.html",
  "index.html",
  "reportes.js",
  "manifest.json",
  "icons/icon-192.png",
  "icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ARCHIVOS_A_CACHEAR))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
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

self.addEventListener("fetch", (event) => {
  const url = event.request.url;

  // Nunca cachear las llamadas al backend (Apps Script) — los
  // reportes siempre deben pedirse en vivo, con datos actuales.
  if (url.includes("script.google.com")) {
    return; // deja pasar la petición tal cual, sin intervenir
  }

  // Para los archivos propios de la app: red primero, caché como
  // respaldo si no hay conexión en ese instante.
  event.respondWith(
    fetch(event.request)
      .then((respuestaDeRed) => {
        const copia = respuestaDeRed.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copia));
        return respuestaDeRed;
      })
      .catch(() => caches.match(event.request))
  );
});
