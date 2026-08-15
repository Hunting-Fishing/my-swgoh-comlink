"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const { extractPlayer } = require("./guild-service");
const { normalizePlayerMods } = require("./mod-normalizer");

const STATMOD_URL = "https://raw.githubusercontent.com/swgoh-utils/gamedata/main/statMod.json";

function positiveNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function joinUrl(baseUrl, pathname) {
  return new URL(String(pathname || "").replace(/^\//, ""), `${String(baseUrl || "").replace(/\/+$/, "")}/`);
}

function signedHeaders(config, pathname, serializedBody) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (!config.comlinkAccessKey || !config.comlinkSecretKey) return headers;
  const timestamp = String(Date.now());
  const bodyHash = crypto.createHash("md5").update(serializedBody).digest("hex");
  const signature = crypto
    .createHmac("sha256", config.comlinkSecretKey)
    .update(timestamp)
    .update("POST")
    .update(pathname)
    .update(bodyHash)
    .digest("hex");
  headers["X-Date"] = timestamp;
  headers.Authorization = `HMAC-SHA256 Credential=${config.comlinkAccessKey},Signature=${signature}`;
  return headers;
}

async function requestPlayer(fetchImpl, config, allyCode) {
  if (!config.comlinkUrl) throw new Error("Comlink URL is not configured.");
  const pathname = "/player";
  const serializedBody = JSON.stringify({ payload: { allyCode }, enums: false });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), positiveNumber(config.requestTimeoutMs, 45_000));
  try {
    const response = await fetchImpl(joinUrl(config.comlinkUrl, pathname), {
      method: "POST",
      headers: signedHeaders(config, pathname, serializedBody),
      body: serializedBody,
      redirect: "error",
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Comlink /player returned HTTP ${response.status}${text ? `: ${text.slice(0, 180)}` : ""}`);
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new Error("Comlink /player returned invalid JSON.");
    }
    const player = extractPlayer(payload);
    if (!player) throw new Error("Comlink /player did not return a player.");
    return player;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadStatMods(fetchImpl) {
  try {
    const response = await fetchImpl(STATMOD_URL, {
      headers: { Accept: "application/json", "User-Agent": "swgoh-live-gateway" },
      redirect: "error",
    });
    if (!response.ok) return [];
    return await response.json();
  } catch {
    return [];
  }
}

function createModService(config, dependencies = {}) {
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const now = dependencies.now || Date.now;
  const env = dependencies.env || process.env;
  const playerCacheMs = positiveNumber(env.MOD_CACHE_SECONDS, 300) * 1000;
  const definitionCacheMs = positiveNumber(env.MOD_DEFINITION_CACHE_SECONDS, 21_600) * 1000;
  const playerCache = new Map();
  let definitions = null;
  let definitionsExpiresAt = 0;
  let definitionsPromise = null;

  async function statMods() {
    if (definitions && definitionsExpiresAt > now()) return definitions;
    if (definitionsPromise) return definitionsPromise;
    definitionsPromise = loadStatMods(fetchImpl).then((payload) => {
      definitions = payload;
      definitionsExpiresAt = now() + definitionCacheMs;
      return payload;
    }).finally(() => {
      definitionsPromise = null;
    });
    return definitionsPromise;
  }

  async function loadByAllyCode(allyCode) {
    const normalized = String(allyCode || "").replace(/\D/g, "");
    if (!/^\d{9}$/.test(normalized)) throw new Error("A valid 9-digit Ally Code is required.");
    const cached = playerCache.get(normalized);
    if (cached && cached.expiresAt > now()) return cached.value;

    const [player, statModPayload] = await Promise.all([
      requestPlayer(fetchImpl, config, normalized),
      statMods(),
    ]);
    const normalizedMods = normalizePlayerMods(player, statModPayload);
    const body = {
      source: "live",
      player: {
        name: firstText(player?.name, "Unknown Player"),
        allyCode: firstText(String(player?.allyCode || normalized)),
        playerId: firstText(player?.playerId),
      },
      units: normalizedMods.units,
      summary: normalizedMods.summary,
      capabilities: {
        equippedModDetails: true,
        allEquippedPipLevels: true,
        unequippedMods: false,
      },
      fetchedAt: new Date(now()).toISOString(),
    };
    playerCache.set(normalized, { value: body, expiresAt: now() + playerCacheMs });
    return body;
  }

  return { loadByAllyCode };
}

function writeJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function createModAwareServer(baseGateway, config, dependencies = {}) {
  const service = createModService(config, dependencies);
  return http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://gateway.local");
    const match = url.pathname.match(/^\/v1\/mods\/by-player\/(\d{9})$/);
    if (!match) {
      baseGateway.emit("request", request, response);
      return;
    }

    if (request.method !== "GET") {
      writeJson(response, 405, { error: "Method not allowed." }, { Allow: "GET" });
      return;
    }
    if (!config.comlinkUrl || !config.apiKey) {
      writeJson(response, 503, { error: "The live SWGOH mod gateway is not configured." });
      return;
    }
    if (!secureEqual(request.headers["x-api-key"], config.apiKey)) {
      writeJson(response, 401, { error: "Unauthorized." });
      return;
    }

    try {
      const body = await service.loadByAllyCode(match[1]);
      writeJson(response, 200, body, { "X-Mod-Source": "comlink-live-equipped" });
    } catch (error) {
      const message = error?.name === "AbortError" ? "Equipped mod request timed out." : String(error?.message || error);
      console.error(`[gateway:mods] ${error?.stack || error}`);
      writeJson(response, 502, { error: message.slice(0, 240), service: "Comlink", stage: "equipped-mods" });
    }
  });
}

module.exports = {
  STATMOD_URL,
  createModAwareServer,
  createModService,
  loadStatMods,
  requestPlayer,
};
