self.addEventListener("install", function(event) {
  self.skipWaiting();
});

self.addEventListener("activate", function(event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", function(event) {
  // Guard for chrome extensions/browser tools requests
  if (event.request.cache === "only-if-cached" && event.request.mode !== "same-origin") {
    return;
  }
  
  event.respondWith(
    fetch(event.request)
      .then(function(response) {
        if (response.status === 0) {
          return response;
        }

        // Clone headers and inject COOP/COEP policies to enable SharedArrayBuffer
        const newHeaders = new Headers(response.headers);
        newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");
        newHeaders.set("Cross-Origin-Embedder-Policy", "require-corp");

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders
        });
      })
      .catch(function(e) {
        // Fallback for failed requests
        return fetch(event.request);
      })
  );
});
