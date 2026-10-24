
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // اتصال درخواست‌های API به سرور فعلی بازی
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      url.hostname = "nabard-9d4x.onrender.com";
      url.protocol = "https:";

      // Diagnostic timing: measures only the Worker-to-Render fetch duration.
      // This does not change API payloads or battle/game logic.
      const originStartedAt = Date.now();
      const originResponse = await fetch(new Request(url.toString(), request));
      const originDurationMs = Date.now() - originStartedAt;
      const responseHeaders = new Headers(originResponse.headers);
      responseHeaders.set("X-Game-Origin-Ms", String(originDurationMs));
      responseHeaders.set("Server-Timing", `origin;dur=${originDurationMs}`);
      return new Response(originResponse.body, {
        status: originResponse.status,
        statusText: originResponse.statusText,
        headers: responseHeaders
      });
    }

    // اصلاح مسیر تصاویر بازی
    if (url.pathname.startsWith("/images/")) {
      url.pathname = "/public" + url.pathname;
      return env.ASSETS.fetch(new Request(url.toString(), request));
    }

    return env.ASSETS.fetch(request);
  }
};
