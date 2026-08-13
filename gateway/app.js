"use strict";

const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs/promises");
const { spawn } = require("node:child_process");

const publicPort = Number(process.env.PORT || 8080);
const innerPort = Number(process.env.INTERNAL_GATEWAY_PORT || 8081);
const publicDir = path.join(__dirname, "public");
const apiKey = String(process.env.GATEWAY_API_KEY || "");
const visitors = new Map();

const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
  env: { ...process.env, PORT: String(innerPort) },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  console.error(`Inner gateway stopped (${signal || code || 0}).`);
  process.exit(code || 1);
});

function ipOf(request) {
  return String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function permit(request) {
  const minute = Math.floor(Date.now() / 60000);
  const key = ipOf(request);
  const state = visitors.get(key);
  if (!state || state.minute !== minute) {
    visitors.set(key, { minute, count: 1 });
    return true;
  }
  state.count += 1;
  return state.count <= Number(process.env.PUBLIC_RATE_LIMIT_PER_MINUTE || 30);
}

function json(response, status, body, extra = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": "*",
    ...extra,
  });
  response.end(JSON.stringify(body));
}

async function innerFetch(request, pathname, headers = {}) {
  return fetch(`http://127.0.0.1:${innerPort}${pathname}`, {
    method: "GET",
    headers: {
      Accept: request.headers.accept || "*/*",
      "X-Forwarded-For": ipOf(request),
      ...headers,
    },
    redirect: "manual",
  });
}

async function proxy(request, response, pathname, headers = {}) {
  try {
    const upstream = await innerFetch(request, pathname, headers);
    const data = Buffer.from(await upstream.arrayBuffer());
    const outHeaders = {
      "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
      "Cache-Control": upstream.headers.get("cache-control") || "no-store",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": "*",
    };
    const length = upstream.headers.get("content-length");
    if (length) outHeaders["Content-Length"] = length;
    const rosterSource = upstream.headers.get("x-roster-source");
    if (rosterSource) outHeaders["X-Roster-Source"] = rosterSource;
    response.writeHead(upstream.status, outHeaders);
    response.end(data);
  } catch (error) {
    json(response, 502, { error: "The live SWGOH gateway is starting or unavailable." });
  }
}

const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
]);

async function serveStatic(response, pathname) {
  let relative = pathname === "/" || /^\/p\/\d{9}\/?$/.test(pathname)
    ? "index.html"
    : decodeURIComponent(pathname.replace(/^\/+/, ""));
  relative = path.normalize(relative).replace(/^(\.\.(\/|\\|$))+/, "");
  const file = path.join(publicDir, relative);
  if (!file.startsWith(publicDir)) return false;

  try {
    const data = await fs.readFile(file);
    const extension = path.extname(file).toLowerCase();
    response.writeHead(200, {
      "Content-Type": mime.get(extension) || "application/octet-stream",
      "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
    response.end(data);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://roster.local");

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
      "Access-Control-Max-Age": "86400",
    });
    response.end();
    return;
  }

  if (request.method !== "GET") {
    json(response, 405, { error: "Method not allowed." }, { Allow: "GET, OPTIONS" });
    return;
  }

  if (url.pathname === "/api/health") {
    try {
      const upstream = await innerFetch(request, "/healthz");
      const body = await upstream.json();
      json(response, upstream.ok ? 200 : upstream.status, {
        status: upstream.ok && body.status === "configured" ? "ready" : "needs-configuration",
        liveOnly: true,
        gateway: body,
      });
    } catch {
      json(response, 502, { status: "starting", liveOnly: true });
    }
    return;
  }

  const publicPlayer = url.pathname.match(/^\/api\/player\/(\d{9})$/);
  if (publicPlayer) {
    if (!permit(request)) {
      json(response, 429, { error: "Too many live roster requests. Please retry shortly." }, { "Retry-After": "60" });
      return;
    }
    if (!apiKey) {
      json(response, 503, { error: "The live roster gateway is not configured." });
      return;
    }
    await proxy(request, response, `/v1/player/${publicPlayer[1]}`, { "X-API-Key": apiKey });
    return;
  }

  if (url.pathname === "/healthz" || url.pathname.startsWith("/v1/")) {
    await proxy(request, response, `${url.pathname}${url.search}`, request.headers["x-api-key"] ? { "X-API-Key": String(request.headers["x-api-key"]) } : {});
    return;
  }

  if (await serveStatic(response, url.pathname)) return;
  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found");
});

server.listen(publicPort, "0.0.0.0", () => {
  console.log(`SWGOH Roster Command UI listening on port ${publicPort}; inner gateway on ${innerPort}`);
});

function stop(signal) {
  try { child.kill(signal); } catch {}
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
