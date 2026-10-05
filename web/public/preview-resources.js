// Only virtual package resources are handled here. Snapshots belong to a page.
self.addEventListener("install", (event) =>
  event.waitUntil(self.skipWaiting()),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const prefix = new URL("__preview_resources/", self.registration.scope)
    .pathname;
  if (url.origin !== self.location.origin || !url.pathname.startsWith(prefix))
    return;
  event.respondWith(
    (async () => {
      const [scope, digest, ...segments] = url.pathname
        .slice(prefix.length)
        .split("/");
      const client = await self.clients.get(event.clientId);
      if (!client || !scope || !digest)
        return new Response("Preview resource unavailable", { status: 404 });
      let path;
      try {
        path = segments.map(decodeURIComponent).join("/");
      } catch {
        return new Response("Invalid resource path", { status: 400 });
      }
      const channel = new MessageChannel();
      const response = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          channel.port1.close();
          resolve(null);
        }, 10000);
        channel.port1.onmessage = ({ data }) => {
          clearTimeout(timer);
          channel.port1.close();
          resolve(data);
        };
        client.postMessage({ kind: "preview-resource", scope, digest, path }, [
          channel.port2,
        ]);
      });
      if (!response)
        return new Response("Preview resource expired", { status: 404 });
      return new Response(response.data, {
        headers: { "Content-Type": response.type, "Cache-Control": "no-store" },
      });
    })(),
  );
});
