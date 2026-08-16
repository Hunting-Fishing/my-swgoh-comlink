"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const { extractPlayer, requestComlink } = require("./guild-service");

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function cosmeticId(value, kind) {
  if (typeof value === "string") return value.trim();
  if (!isRecord(value)) return "";
  if (kind === "title") return firstText(value.id, value.titleId, value.definitionId);
  return firstText(value.id, value.portraitId, value.definitionId);
}

function uniqueIds(values, kind) {
  return [...new Set(asArray(values).map((value) => cosmeticId(value, kind)).filter(Boolean))].sort();
}

function selectedCosmetic(player, key, kind) {
  const value = player?.[key];
  return cosmeticId(value, kind);
}

function normalizeVerificationProfile(player, fallbackAllyCode = "") {
  if (!isRecord(player)) return null;
  const allyCode = firstText(String(player.allyCode || ""), fallbackAllyCode).replace(/\D/g, "");
  const playerId = firstText(player.playerId, player.id);
  const name = firstText(player.name, player.playerName, allyCode);
  if (!/^\d{9}$/.test(allyCode) || !playerId) return null;

  const unlockedTitleIds = uniqueIds(player.unlockedPlayerTitle || player.unlockedTitles, "title");
  const unlockedPortraitIds = uniqueIds(player.unlockedPlayerPortrait || player.unlockedPortraits, "portrait");
  const selectedTitleId = selectedCosmetic(player, "selectedPlayerTitle", "title");
  const selectedPortraitId = selectedCosmetic(player, "selectedPlayerPortrait", "portrait");

  return Object.freeze({
    source: "live",
    player: Object.freeze({
      playerId,
      allyCode,
      name,
      selectedTitleId,
      selectedPortraitId,
    }),
    unlocked: Object.freeze({
      titleIds: Object.freeze(unlockedTitleIds),
      portraitIds: Object.freeze(unlockedPortraitIds),
    }),
  });
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
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

function createVerificationService(config, dependencies = {}) {
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const now = dependencies.now || Date.now;
  const cacheMs = positiveNumber(config.playerVerificationCacheMs, 15_000);
  const cache = new Map();
  const pending = new Map();

  function fresh(allyCode) {
    const entry = cache.get(allyCode);
    if (!entry || entry.expiresAt <= now()) {
      if (entry) cache.delete(allyCode);
      return null;
    }
    return entry.value;
  }

  async function load(allyCode, options = {}) {
    const forceRefresh = options.forceRefresh === true;
    if (!forceRefresh) {
      const cached = fresh(allyCode);
      if (cached) return cached;
      if (pending.has(allyCode)) return pending.get(allyCode);
    }

    const work = (async () => {
      const payload = await requestComlink(fetchImpl, config, "/player", { allyCode });
      const player = extractPlayer(payload);
      const normalized = normalizeVerificationProfile(player, allyCode);
      if (!normalized) throw new Error("Comlink /player did not return a usable verification profile.");
      const value = Object.freeze({ ...normalized, fetchedAt: new Date(now()).toISOString() });
      cache.set(allyCode, { value, expiresAt: now() + cacheMs });
      return value;
    })();

    if (!forceRefresh) pending.set(allyCode, work);
    try {
      return await work;
    } finally {
      if (!forceRefresh) pending.delete(allyCode);
    }
  }

  return Object.freeze({ load });
}

function createVerificationAwareServer(baseGateway, config, dependencies = {}) {
  const service = createVerificationService(config, dependencies);
  return http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://gateway.local");
    const match = url.pathname.match(/^\/v1\/player\/(\d{9})\/verification-profile$/);
    if (!match) {
      baseGateway.emit("request", request, response);
      return;
    }

    if (request.method !== "GET") {
      writeJson(response, 405, { error: "Method not allowed." }, { Allow: "GET" });
      return;
    }
    if (!config.comlinkUrl || !config.apiKey) {
      writeJson(response, 503, { error: "The live SWGOH verification gateway is not configured." });
      return;
    }
    if (!secureEqual(request.headers["x-api-key"], config.apiKey)) {
      writeJson(response, 401, { error: "Unauthorized." });
      return;
    }

    try {
      const forceRefresh = url.searchParams.get("refresh") === "1";
      const body = await service.load(match[1], { forceRefresh });
      writeJson(response, 200, body, {
        "X-Verification-Source": "comlink-live",
        "X-Verification-Refresh": forceRefresh ? "requested" : "normal",
      });
    } catch (error) {
      const message = error?.name === "AbortError" ? "Verification request timed out." : String(error?.message || error);
      console.error(`[gateway:verification] ${error?.stack || error}`);
      writeJson(response, 502, { error: message.slice(0, 240), service: "Comlink", stage: "player-verification" });
    }
  });
}

module.exports = {
  cosmeticId,
  createVerificationAwareServer,
  createVerificationService,
  normalizeVerificationProfile,
  uniqueIds,
};
