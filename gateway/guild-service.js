"use strict";

const http = require("node:http");
const crypto = require("node:crypto");

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

function finiteNumber(...values) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return 0;
}

function cloneJson(value, fallback) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function baseIdOf(unit) {
  return firstText(unit?.definitionId, unit?.defId, unit?.baseId, unit?.baseID, unit?.id).split(":")[0];
}

function rosterOf(player) {
  if (!isRecord(player)) return [];
  for (const key of ["rosterUnit", "roster", "units", "unit"]) {
    if (Array.isArray(player[key])) return player[key];
  }
  return [];
}

function extractPlayer(payload) {
  if (Array.isArray(payload)) return isRecord(payload[0]) ? payload[0] : null;
  if (!isRecord(payload)) return null;
  for (const key of ["player", "players", "result", "results"]) {
    const value = payload[key];
    if (Array.isArray(value) && isRecord(value[0])) return value[0];
    if (isRecord(value)) return value;
  }
  if (isRecord(payload.payload)) return extractPlayer(payload.payload) || payload.payload;
  if (isRecord(payload.data)) return extractPlayer(payload.data) || payload.data;
  return payload;
}

function extractGuild(payload) {
  if (!isRecord(payload)) return null;
  if (isRecord(payload.guild)) return payload.guild;
  if (isRecord(payload.payload)) return extractGuild(payload.payload);
  if (isRecord(payload.data)) return extractGuild(payload.data);
  if (Array.isArray(payload.member) || isRecord(payload.profile)) return payload;
  return null;
}

function relicLevel(unit) {
  const raw = finiteNumber(unit?.relic?.currentTier, unit?.relicTier, unit?.relic?.tier, unit?.relic);
  return raw > 1 ? Math.max(0, raw - 2) : Math.max(0, raw);
}

function compactRoster(player) {
  return rosterOf(player)
    .map((unit) => {
      if (!isRecord(unit)) return null;
      const baseId = baseIdOf(unit);
      if (!baseId) return null;
      return {
        baseId,
        stars: finiteNumber(unit.currentRarity, unit.rarity),
        gear: finiteNumber(unit.currentTier, unit.gear, unit.gearLevel),
        relic: relicLevel(unit),
      };
    })
    .filter(Boolean);
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
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

function joinUrl(baseUrl, pathname) {
  return new URL(String(pathname || "").replace(/^\//, ""), `${String(baseUrl || "").replace(/\/+$/, "")}/`);
}

async function requestComlink(fetchImpl, config, pathname, payload) {
  if (!config.comlinkUrl) throw new Error("Comlink URL is not configured.");
  const body = JSON.stringify({ payload, enums: false });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), positiveNumber(config.requestTimeoutMs, 45_000));
  try {
    const response = await fetchImpl(joinUrl(config.comlinkUrl, pathname), {
      method: "POST",
      headers: signedHeaders(config, pathname, body),
      body,
      redirect: "error",
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Comlink ${pathname} returned HTTP ${response.status}${text ? `: ${text.slice(0, 180)}` : ""}`);
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Comlink ${pathname} returned invalid JSON.`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function mapLimit(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  const count = Math.min(Math.max(1, Math.floor(limit)), Math.max(1, items.length));
  const runners = Array.from({ length: count }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return output;
}

function guildProfile(guild, fallbackId) {
  const profile = isRecord(guild?.profile) ? guild.profile : {};
  return {
    id: firstText(profile.id, guild?.id, fallbackId),
    name: firstText(profile.name, guild?.name, "Unknown Guild"),
    memberCount: finiteNumber(profile.memberCount, asArray(guild?.member).length),
    memberMax: finiteNumber(profile.memberMax),
    galacticPower: finiteNumber(profile.guildGalacticPower, profile.guildGalacticPowerForRequirement),
    bannerColorId: firstText(profile.bannerColorId),
    bannerLogoId: firstText(profile.bannerLogoId),
    externalMessageKey: firstText(profile.externalMessageKey),
    enrollmentStatus: finiteNumber(profile.enrollmentStatus),
    level: finiteNumber(profile.level),
    levelRequirement: finiteNumber(profile.levelRequirement),
    guildType: firstText(profile.guildType),
  };
}

function guildActivity(guild) {
  const profile = isRecord(guild?.profile) ? guild.profile : {};
  return {
    nextChallengesRefresh: firstText(String(guild?.nextChallengesRefresh || guild?.nextChallengeRefresh || "")),
    raidLaunchConfig: cloneJson(asArray(profile.raidLaunchConfig), []),
    guildEventTracker: cloneJson(asArray(profile.guildEventTracker), []),
    recentRaidResult: cloneJson(asArray(guild?.recentRaidResult), []),
    recentTerritoryWarResult: cloneJson(asArray(guild?.recentTerritoryWarResult), []),
    territoryBattleResult: cloneJson(asArray(guild?.territoryBattleResult), []),
  };
}

function guildMemberSummary(member) {
  return {
    playerId: firstText(member?.playerId),
    name: firstText(member?.playerName, member?.name, "Unknown Player"),
    level: finiteNumber(member?.playerLevel, member?.level),
    memberLevel: finiteNumber(member?.memberLevel),
    guildXp: finiteNumber(member?.guildXp),
    galacticPower: finiteNumber(member?.galacticPower),
    squadPower: finiteNumber(member?.squadPower),
    lastActivityTime: firstText(String(member?.lastActivityTime || "")),
    guildJoinTime: firstText(String(member?.guildJoinTime || "")),
    playerTitle: firstText(member?.playerTitle),
    playerPortrait: firstText(member?.playerPortrait),
    lifetimeSeasonScore: firstText(String(member?.lifetimeSeasonScore || "")),
    leagueId: firstText(member?.leagueId),
    memberContribution: cloneJson(asArray(member?.memberContribution), []),
    seasonStatus: cloneJson(asArray(member?.seasonStatus), []),
  };
}

function compactMember(rawPlayer, member) {
  const summary = guildMemberSummary(member);
  return {
    ...summary,
    playerId: firstText(rawPlayer?.playerId, summary.playerId),
    name: firstText(rawPlayer?.name, summary.name),
    allyCode: firstText(String(rawPlayer?.allyCode || "")),
    rosterAvailable: rosterOf(rawPlayer).length > 0,
    units: compactRoster(rawPlayer),
  };
}

function createGuildService(config, dependencies = {}) {
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const now = dependencies.now || Date.now;
  const guildCacheMs = positiveNumber(config.guildCacheMs, 15 * 60_000);
  const memberCacheMs = positiveNumber(config.guildMemberCacheMs, 15 * 60_000);
  const concurrency = positiveNumber(config.guildConcurrency, 5);
  const guildCache = new Map();
  const memberCache = new Map();
  const allyGuild = new Map();
  const pendingGuild = new Map();

  function fresh(map, key) {
    const entry = map.get(String(key));
    if (!entry || entry.expiresAt <= now()) {
      if (entry) map.delete(String(key));
      return null;
    }
    return entry.value;
  }

  function store(map, key, value, ttl) {
    map.set(String(key), { value, expiresAt: now() + ttl });
    return value;
  }

  function guildCacheKey(guildId, includeActivity) {
    return `${guildId}:${includeActivity ? "activity" : "roster"}`;
  }

  async function playerBy(payload) {
    const response = await requestComlink(fetchImpl, config, "/player", payload);
    const player = extractPlayer(response);
    if (!player) throw new Error("Comlink /player did not return a player.");
    return player;
  }

  async function memberByPlayerId(playerId, summary, seedPlayer = null) {
    const cached = fresh(memberCache, playerId);
    if (cached) {
      return {
        ...cached,
        ...guildMemberSummary(summary),
        playerId: firstText(cached.playerId, summary?.playerId),
        name: firstText(cached.name, summary?.playerName, summary?.name),
      };
    }
    const rawPlayer = seedPlayer || await playerBy({ playerId });
    return store(memberCache, playerId, compactMember(rawPlayer, summary), memberCacheMs);
  }

  async function hydrateGuild(guildId, seedPlayer, options = {}) {
    const includeActivity = options.includeActivity === true;
    const cacheKey = guildCacheKey(guildId, includeActivity);
    const cached = fresh(guildCache, cacheKey);
    if (cached) return cached;
    if (pendingGuild.has(cacheKey)) return pendingGuild.get(cacheKey);

    const pending = (async () => {
      const guildPayload = await requestComlink(fetchImpl, config, "/guild", {
        guildId,
        includeRecentGuildActivityInfo: includeActivity,
      });
      const guild = extractGuild(guildPayload);
      if (!guild) throw new Error("Comlink /guild did not return guild data.");
      const sourceMembers = asArray(guild.member).filter((member) => firstText(member?.playerId));
      if (!sourceMembers.length) throw new Error("Comlink /guild returned no public guild members.");

      const seedPlayerId = firstText(seedPlayer?.playerId);
      if (seedPlayerId) {
        const matching = sourceMembers.find((member) => firstText(member?.playerId) === seedPlayerId) || {};
        store(memberCache, seedPlayerId, compactMember(seedPlayer, matching), memberCacheMs);
      }

      let failures = 0;
      const members = await mapLimit(sourceMembers, concurrency, async (member) => {
        const playerId = firstText(member?.playerId);
        try {
          return await memberByPlayerId(playerId, member, playerId === seedPlayerId ? seedPlayer : null);
        } catch (error) {
          failures += 1;
          return {
            ...guildMemberSummary(member),
            rosterAvailable: false,
            units: [],
            error: String(error?.message || error).slice(0, 180),
          };
        }
      });

      const hydrated = members.filter((member) => member.rosterAvailable).length;
      const body = {
        source: "live",
        guild: guildProfile(guild, guildId),
        members,
        hydration: {
          requested: sourceMembers.length,
          hydrated,
          failed: failures,
          complete: failures === 0 && hydrated === sourceMembers.length,
          concurrency: Math.min(concurrency, sourceMembers.length),
        },
        ...(includeActivity ? { activity: guildActivity(guild) } : {}),
        fetchedAt: new Date(now()).toISOString(),
      };
      return store(guildCache, cacheKey, body, guildCacheMs);
    })().finally(() => pendingGuild.delete(cacheKey));

    pendingGuild.set(cacheKey, pending);
    return pending;
  }

  async function loadByAllyCode(allyCode, options = {}) {
    const normalized = String(allyCode || "").replace(/\D/g, "");
    if (!/^\d{9}$/.test(normalized)) throw new Error("A valid 9-digit Ally Code is required.");
    const includeActivity = options.includeActivity === true;

    const knownGuild = fresh(allyGuild, normalized);
    if (knownGuild) {
      const cached = fresh(guildCache, guildCacheKey(knownGuild, includeActivity));
      if (cached) return cached;
    }

    const seedPlayer = await playerBy({ allyCode: normalized });
    const guildId = firstText(seedPlayer.guildId, seedPlayer.guild?.id);
    if (!guildId) throw new Error("This player is not currently in a public guild.");
    store(allyGuild, normalized, guildId, guildCacheMs);
    return hydrateGuild(guildId, seedPlayer, { includeActivity });
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

function createGuildAwareServer(baseGateway, config, dependencies = {}) {
  const service = createGuildService(config, dependencies);
  return http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://gateway.local");
    const match = url.pathname.match(/^\/v1\/guild\/by-player\/(\d{9})\/roster$/);
    if (!match) {
      baseGateway.emit("request", request, response);
      return;
    }

    if (request.method !== "GET") {
      writeJson(response, 405, { error: "Method not allowed." }, { Allow: "GET" });
      return;
    }
    if (!config.comlinkUrl || !config.apiKey) {
      writeJson(response, 503, { error: "The live SWGOH guild gateway is not configured." });
      return;
    }
    if (!secureEqual(request.headers["x-api-key"], config.apiKey)) {
      writeJson(response, 401, { error: "Unauthorized." });
      return;
    }

    try {
      const includeActivity = url.searchParams.get("activity") === "1";
      const body = await service.loadByAllyCode(match[1], { includeActivity });
      writeJson(response, 200, body, {
        "X-Guild-Source": "comlink-live",
        "X-Guild-Activity": includeActivity ? "included" : "omitted",
      });
    } catch (error) {
      const message = error?.name === "AbortError" ? "Guild request timed out." : String(error?.message || error);
      console.error(`[gateway:guild] ${error?.stack || error}`);
      writeJson(response, 502, { error: message.slice(0, 240), service: "Comlink", stage: "guild-roster" });
    }
  });
}

module.exports = {
  compactMember,
  compactRoster,
  createGuildAwareServer,
  createGuildService,
  extractGuild,
  extractPlayer,
  guildActivity,
  guildMemberSummary,
  mapLimit,
  relicLevel,
  requestComlink,
};
