"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const { gacRating } = require("./player-summary");
const { requestPlayer } = require("./mod-service");

const LEAGUE_NAMES = new Map([
  [100, "KYBER"],
  [80, "AURODIUM"],
  [60, "CHROMIUM"],
  [40, "BRONZIUM"],
  [20, "CARBONITE"],
]);
const ALLOWED_LEAGUES = new Set(LEAGUE_NAMES.values());

function positiveNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
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

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function joinUrl(baseUrl, pathname) {
  return new URL(String(pathname || "").replace(/^\//, ""), `${String(baseUrl || "").replace(/\/+$/, "")}/`);
}

function signedHeaders(config, pathname, serializedBody) {
  const headers = { Accept: "application/json", "Content-Type": "application/json" };
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

async function postComlink(fetchImpl, config, pathname, payload) {
  if (!config.comlinkUrl) throw new Error("Comlink URL is not configured.");
  const serializedBody = JSON.stringify(payload ?? {});
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
    if (!response.ok) {
      throw new Error(`Comlink ${pathname} returned HTTP ${response.status}${text ? `: ${text.slice(0, 180)}` : ""}`);
    }
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Comlink ${pathname} returned invalid JSON.`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeLeague(value) {
  const numeric = Number(value);
  if (LEAGUE_NAMES.has(numeric)) return LEAGUE_NAMES.get(numeric);
  const text = String(value ?? "").trim().toUpperCase();
  if (ALLOWED_LEAGUES.has(text)) return text;
  return "";
}

function eventInstanceId(event) {
  const instance = asArray(event?.instance)[0];
  const eventId = firstText(event?.id);
  const instanceId = firstText(instance?.id);
  return eventId && instanceId ? `${eventId}:${instanceId}` : "";
}

function normalizeEvent(event) {
  const instance = asArray(event?.instance)[0] || {};
  return {
    id: firstText(event?.id),
    type: Number(event?.type || 0),
    status: event?.status ?? null,
    instanceId: firstText(instance?.id),
    eventInstanceId: eventInstanceId(event),
    displayStartTime: String(instance?.displayStartTime ?? ""),
    displayEndTime: String(instance?.displayEndTime ?? ""),
    startTime: String(instance?.startTime ?? ""),
    rewardTime: String(instance?.rewardTime ?? ""),
  };
}

function currentGacEvent(eventsPayload) {
  const events = asArray(eventsPayload?.gameEvent).filter((event) => Number(event?.type) === 10);
  if (!events.length) return null;
  const active = events.find((event) => {
    const status = String(event?.status ?? "").toLowerCase();
    return !["complete", "completed", "finished", "ended"].includes(status);
  });
  return normalizeEvent(active || events[0]);
}

function bracketPlayers(payload) {
  const values = asArray(payload?.player)
    .concat(asArray(payload?.players))
    .concat(asArray(payload?.result?.player));
  return values.filter(isRecord).map((player) => ({
    playerId: firstText(player?.playerId, player?.id),
    name: firstText(player?.name, player?.playerName, "Unknown Player"),
    score: Number(player?.score ?? player?.seasonScore ?? player?.points ?? 0) || 0,
    rank: Number(player?.rank ?? 0) || 0,
    guildName: firstText(player?.guildName, player?.guild?.name),
    raw: player,
  }));
}

function ratingSummary(player) {
  const rating = gacRating(player);
  const league = normalizeLeague(rating.league);
  return {
    name: firstText(player?.name, "Unknown Player"),
    allyCode: firstText(String(player?.allyCode || "")),
    playerId: firstText(player?.playerId),
    skillRating: Number(rating.skillRating || 0),
    league,
    division: rating.division ?? "",
  };
}

function createGacService(config, dependencies = {}) {
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const now = dependencies.now || Date.now;
  const eventCacheMs = positiveNumber(dependencies.env?.GAC_EVENT_CACHE_SECONDS || process.env.GAC_EVENT_CACHE_SECONDS, 60) * 1000;
  const bracketCacheMs = positiveNumber(dependencies.env?.GAC_BRACKET_CACHE_SECONDS || process.env.GAC_BRACKET_CACHE_SECONDS, 30) * 1000;
  let eventCache = null;
  const bracketCache = new Map();

  async function loadCurrentEvent() {
    if (eventCache && eventCache.expiresAt > now()) return eventCache.value;
    const payload = await postComlink(fetchImpl, config, "/getEvents", { payload: {}, enums: false });
    const event = currentGacEvent(payload);
    const value = {
      source: "comlink-live",
      active: Boolean(event?.eventInstanceId),
      event,
      fetchedAt: new Date(now()).toISOString(),
    };
    eventCache = { value, expiresAt: now() + eventCacheMs };
    return value;
  }

  async function loadBracket(leagueInput, bracketIndexInput) {
    const league = normalizeLeague(leagueInput);
    const bracketIndex = Number(bracketIndexInput);
    if (!league) throw new Error("A valid GAC league is required.");
    if (!Number.isInteger(bracketIndex) || bracketIndex < 0) throw new Error("A non-negative GAC bracket index is required.");

    const current = await loadCurrentEvent();
    const eventId = current?.event?.eventInstanceId;
    if (!eventId) throw new Error("No active GAC event is currently exposed by Comlink.");
    const cacheKey = `${eventId}:${league}:${bracketIndex}`;
    const cached = bracketCache.get(cacheKey);
    if (cached && cached.expiresAt > now()) return cached.value;

    const groupId = `${eventId}:${league}:${bracketIndex}`;
    const payload = await postComlink(fetchImpl, config, "/getLeaderboard", {
      payload: {
        leaderboardType: 4,
        eventInstanceId: eventId,
        groupId,
      },
      enums: false,
    });
    const players = bracketPlayers(payload);
    const value = {
      source: "comlink-live",
      event: current.event,
      league,
      bracketIndex,
      groupId,
      players,
      playerCount: players.length,
      fetchedAt: new Date(now()).toISOString(),
    };
    bracketCache.set(cacheKey, { value, expiresAt: now() + bracketCacheMs });
    return value;
  }

  async function loadPlayerContext(allyCode) {
    const player = await requestPlayer(fetchImpl, config, allyCode);
    const current = await loadCurrentEvent();
    return {
      source: "comlink-live",
      player: ratingSummary(player),
      event: current.event,
      seasonStatus: asArray(player?.seasonStatus),
      fetchedAt: new Date(now()).toISOString(),
    };
  }

  return { loadBracket, loadCurrentEvent, loadPlayerContext };
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

function createGacAwareServer(baseGateway, config, dependencies = {}) {
  const service = createGacService(config, dependencies);
  return http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://gateway.local");
    const bracketMatch = url.pathname.match(/^\/v1\/gac\/bracket\/([A-Za-z]+)\/(\d+)$/);
    const playerMatch = url.pathname.match(/^\/v1\/gac\/player\/(\d{9})$/);
    const isEvent = url.pathname === "/v1/gac/current-event";

    if (!bracketMatch && !playerMatch && !isEvent) {
      baseGateway.emit("request", request, response);
      return;
    }
    if (request.method !== "GET") {
      writeJson(response, 405, { error: "Method not allowed." }, { Allow: "GET" });
      return;
    }
    if (!config.comlinkUrl || !config.apiKey) {
      writeJson(response, 503, { error: "The live SWGOH GAC gateway is not configured." });
      return;
    }
    if (!secureEqual(request.headers["x-api-key"], config.apiKey)) {
      writeJson(response, 401, { error: "Unauthorized." });
      return;
    }

    try {
      const body = isEvent
        ? await service.loadCurrentEvent()
        : playerMatch
          ? await service.loadPlayerContext(playerMatch[1])
          : await service.loadBracket(bracketMatch[1], bracketMatch[2]);
      writeJson(response, 200, body, { "X-GAC-Source": "comlink-live" });
    } catch (error) {
      const message = error?.name === "AbortError" ? "GAC request timed out." : String(error?.message || error);
      console.error(`[gateway:gac] ${error?.stack || error}`);
      writeJson(response, 502, { error: message.slice(0, 240), service: "Comlink", stage: "gac" });
    }
  });
}

module.exports = {
  LEAGUE_NAMES,
  bracketPlayers,
  createGacAwareServer,
  createGacService,
  currentGacEvent,
  eventInstanceId,
  normalizeEvent,
  normalizeLeague,
  postComlink,
  ratingSummary,
};