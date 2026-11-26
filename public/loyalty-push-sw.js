self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = { body: event.data?.text() || "" }; }
  event.waitUntil(self.registration.showNotification(payload.title || "Your motel rewards", {
    body: payload.body || "A new loyalty deal is waiting for you.",
    icon: "/brand/innseva-logo.png",
    badge: "/brand/innseva-logo.png",
    tag: payload.tag || "innseva-loyalty-deal",
    data: { url: payload.url || "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    let target = new URL("/", self.location.origin);
    try {
      const candidate = new URL(event.notification.data?.url || "/", self.location.origin);
      if (candidate.origin === self.location.origin) target = candidate;
    } catch {}
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).pathname === target.pathname) return client.focus();
    }
    return clients.openWindow(target.href);
  })());
});
