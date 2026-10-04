// Serves the dashboard's /api calls from recorded run data. Every write is refused.
(() => {
  const data = window.__REPLAY__;
  const realFetch = window.fetch.bind(window);
  const readOnly = "This is a read-only replay of recorded live runs. Clone the repository to run the worker yourself.";
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  window.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) return realFetch(input, options);
    const method = (options.method || "GET").toUpperCase();
    if (method !== "GET") return json({ error: readOnly }, 403);

    const path = url.pathname.slice(4);
    if (path === "/health") return json(data.health);
    if (path === "/runs") return json(data.runs);
    if (path === "/memory") return json(data.memory);
    if (path === "/company/state") return json(data.company);
    const match = path.match(/^\/runs\/([^/]+)(\/file)?$/);
    if (match) {
      const run = data.runs.find((entry) => entry.id === decodeURIComponent(match[1]));
      if (!run) return json({ error: "Run not found" }, 404);
      if (!match[2]) return json(run);
      const text = data.files[`${run.id}/${url.searchParams.get("path")}`];
      return text === undefined ? json({ error: "File not found" }, 404) : new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    return json({ error: readOnly }, 404);
  };

  document.addEventListener("DOMContentLoaded", () => {
    const banner = document.createElement("div");
    banner.setAttribute("role", "note");
    banner.style.cssText = "position:sticky;top:0;z-index:50;padding:8px 16px;background:#fff4c2;color:#4e431f;border-bottom:1px solid #e3d48f;font:13px/1.4 system-ui,sans-serif;text-align:center";
    banner.innerHTML = 'Read-only replay of real runs recorded on 2026-10-04 (GPT-6 Luna controlling Chromium). Pick a run under <strong>Select a recent run</strong>. Starting new runs needs a local install: <a href="https://github.com/heykay-47/centralign-worker" style="color:inherit">source and setup</a>.';
    document.body.prepend(banner);
  });
})();
