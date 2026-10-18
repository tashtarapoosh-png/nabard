
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // اتصال درخواست‌های API به سرور فعلی بازی
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      url.hostname = "nabard-9d4x.onrender.com";
      url.protocol = "https:";

      return fetch(new Request(url.toString(), request));
    }

    // اصلاح مسیر تصاویر بازی
    if (url.pathname.startsWith("/images/")) {
      url.pathname = "/public" + url.pathname;
      return env.ASSETS.fetch(new Request(url.toString(), request));
    }

    return env.ASSETS.fetch(request);
  }
};
