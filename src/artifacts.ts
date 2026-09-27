import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { config } from "./config.js";
import { get, run } from "./core/db.js";
import { log } from "./core/log.js";

/**
 * Hosted pages: Claude can publish a self-contained HTML page and share the link, like Claude Tag's
 * hosted web pages. Pages live under DATA_DIR/artifacts and are served at PUBLIC_BASE_URL/p/<id>,
 * where the id is random and unguessable. Republishing with the same title updates the page.
 */
const MAX_PAGE_BYTES = 5 * 1024 * 1024;

export function pagesEnabled(): boolean {
  return !!config.publicBaseUrl;
}

export function publishPage(sessionKey: string, title: string, html: string): string {
  if (!config.publicBaseUrl) throw new Error("Hosted pages are off (PUBLIC_BASE_URL is not set). Attach the HTML file instead.");
  if (Buffer.byteLength(html) > MAX_PAGE_BYTES) throw new Error("Page is over 5MB.");
  const existing = get<{ id: string }>("SELECT id FROM pages WHERE session_key = ? AND title = ?", sessionKey, title);
  const id = existing?.id ?? crypto.randomBytes(18).toString("base64url");
  fs.mkdirSync(config.artifactsDir, { recursive: true });
  fs.writeFileSync(path.join(config.artifactsDir, `${id}.html`), html);
  const now = Date.now();
  if (existing) run("UPDATE pages SET updated_at = ? WHERE id = ?", now, id);
  else run("INSERT INTO pages (id, session_key, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", id, sessionKey, title, now, now);
  return `${config.publicBaseUrl.replace(/\/$/, "")}/p/${id}`;
}

export function startHttpServer(): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    const m = url.pathname.match(/^\/p\/([A-Za-z0-9_-]{16,64})$/);
    if (req.method === "GET" && m && pagesEnabled()) {
      const file = path.join(config.artifactsDir, `${m[1]}.html`);
      if (fs.existsSync(file)) {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          // The page runs in an opaque origin: its scripts work but can't touch anything else here.
          "content-security-policy": "sandbox allow-scripts allow-popups allow-forms",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "x-robots-tag": "noindex",
          "cache-control": "no-cache",
        });
        fs.createReadStream(file).pipe(res);
        return;
      }
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });
  server.listen(config.httpPort, () => log.info(`HTTP server on :${config.httpPort}${pagesEnabled() ? ` (pages at ${config.publicBaseUrl})` : ""}`));
  return server;
}
