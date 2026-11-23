// Service worker for the usage page (admin.html) only: shows the Worker's push notifications.
// Registered with scope "./admin", so it never controls the driving app (evailability.html).
// No fetch handler: nothing is cached or intercepted.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) { d = { body: event.data ? event.data.text() : "" }; }
  const title = d.title || "EVailability";
  event.waitUntil((async () => {
    await self.registration.showNotification(title, {
      body: d.body || "",
      tag: d.tag || undefined,
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
      data: { url: d.url || "admin.html#timer", at: d.at || null },
    });
    // An open usage page refreshes its timer card at once.
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    open.forEach((c) => c.postMessage({ type: "push", title, body: d.body || "" }));
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "admin.html#timer", self.registration.scope).href;
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const page = open.find((c) => new URL(c.url).pathname.endsWith("/admin.html"));
    if (page) { await page.focus(); page.postMessage({ type: "open", url }); return; }
    await self.clients.openWindow(url);
  })());
});
