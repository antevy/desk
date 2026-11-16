/* Cache the app shell only. Never cache GitHub state or API responses. */
const CACHE = "desk-shell-v12";
const SHELL = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./chart.js",
  "./manifest.json",
  "./icons/mascot-180.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => null));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Never intercept or cache desk state, or any other origin (GitHub API / raw).
  if (url.hostname !== self.location.hostname) return;
  if (url.pathname.endsWith("state.json") || url.searchParams.has("ref")) return;
  event.respondWith(
    caches.match(event.request).then((hit) => hit || fetch(event.request, { cache: "no-store" })).catch(() => caches.match("./index.html"))
  );
});
