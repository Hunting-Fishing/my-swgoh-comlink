"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const {
  extractGuild,
  extractPlayer,
  guildActivity,
  mapLimit,
  requestComlink,
  requestStatsBatch,
  richMember,
} = require("./guild-service");

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
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function firstPositive(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function positiveInteger(value, fallback, min = 1, max = 10) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
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

function playerKey(player) {
  return firstText(player?.playerId, player?.id, String(player?.allyCode || ""));
}

function durableUnit(unit = {}) {
  const baseId = firstText(unit.baseId, unit.baseID, unit.definitionId).split(":")[0];
  if (!baseId) return null;
  return {
    id: firstText(unit.id, baseId),
    baseId,
    definitionId: firstText(unit.definitionId),
    combatType: finiteNumber(unit.combatType),
    unitType: firstText(unit.unitType),
    stars: finiteNumber(unit.stars, unit.rarity),
    level: finiteNumber(unit.level),
    gear: finiteNumber(unit.gear, unit.gearLevel),
    relic: finiteNumber(unit.relic, unit.relicTier),
    power: finiteNumber(unit.power, unit.gp, unit.galacticPower),
    speed: finiteNumber(unit.speed),
    purchasedAbilityIds: [...new Set(asArray(unit.purchasedAbilityIds).map((value) => firstText(value)).filter(Boolean))],
  };
}

function durableMember(rawPlayer, guildMember, calculatedPlayer = null) {
  const rich = richMember(rawPlayer, guildMember, calculatedPlayer);
  const characterGalacticPower = firstPositive(
    rawPlayer?.characterGalacticPower,
    rawPlayer?.characterGp,
    rawPlayer?.gpChar,
    calculatedPlayer?.characterGalacticPower,
    calculatedPlayer?.characterGp,
    calculatedPlayer?.gpChar,
    rich.characterGalacticPower,
  );
  const shipGalacticPower = firstPositive(
    rawPlayer?.shipGalacticPower,
    rawPlayer?.shipGp,
    rawPlayer?.gpShip,
    calculatedPlayer?.shipGalacticPower,
    calculatedPlayer?.shipGp,
    calculatedPlayer?.gpShip,
    rich.shipGalacticPower,
  );
  const galacticPower = firstPositive(
    rawPlayer?.galacticPower,
    rawPlayer?.gp,
    rawPlayer?.gpFull,
    guildMember?.galacticPower,
    rich.galacticPower,
    characterGalacticPower + shipGalacticPower,
  );

  return {
    playerId: firstText(rich.playerId),
    name: firstText(rich.name),
    allyCode: firstText(String(rich.allyCode || "")),
    level: finiteNumber(rich.level),
    memberLevel: finiteNumber(rich.memberLevel),
    guildXp: finiteNumber(rich.guildXp),
    galacticPower,
    squadPower: finiteNumber(rich.squadPower),
    lastActivityTime: firstText(String(rich.lastActivityTime || "")),
    guildJoinTime: firstText(String(rich.guildJoinTime || "")),
    playerTitle: firstText(rich.playerTitle),
    playerPortrait: firstText(rich.playerPortrait),
    lifetimeSeasonScore: firstText(String(rich.lifetimeSeasonScore || "")),
    leagueId: firstText(rich.leagueId),
    memberContribution: asArray(rich.memberContribution),
    seasonStatus: asArray(rich.seasonStatus),
    rosterAvailable: rich.rosterAvailable === true,
    characterGalacticPower,
    shipGalacticPower,
    units: asArray(rich.units).map(durableUnit).filter(Boolean),
  };
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

function createGuildSyncPageService(baseGateway, config, dependencies = {}) {
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const now = dependencies.now || Date.now;
  const concurrency = positiveInteger(config.guildConcurrency, 5, 1, 10);
  const manifestTtlMs = Math.max(30_000, Number(config.guildMemberCacheMs || 300_000));
  const manifestCache = new Map();

  function cachedManifest(allyCode) {
    const row = manifestCache.get(allyCode);
    if (!row || row.expiresAt <= now()) {
      if (row) manifestCache.delete(allyCode);
      return null;
    }
    return row.value;
  }

  async function loadManifest(allyCode, includeActivity) {
    const key = `${allyCode}:${includeActivity ? "activity" : "roster"}`;
    const cached = cachedManifest(key);
    if (cached) return cached;

    const seedPayload = await requestComlink(fetchImpl, config, "/player", { allyCode });
    const seedPlayer = extractPlayer(seedPayload);
    if (!seedPlayer) throw new Error("Comlink /player did not return the sync seed player.");
    const guildId = firstText(seedPlayer.guildId, seedPlayer.guild?.id);
    if (!guildId) throw new Error("This player is not currently in a public guild.");

    const guildPayload = await requestComlink(fetchImpl, config, "/guild", {
      guildId,
      includeRecentGuildActivityInfo: includeActivity,
    });
    const guild = extractGuild(guildPayload);
    if (!guild) throw new Error("Comlink /guild did not return guild data.");
    const sourceMembers = asArray(guild.member).filter((member) => firstText(member?.playerId));
    if (!sourceMembers.length) throw new Error("Comlink /guild returned no public guild members.");

    const value = { seedPlayer, guildId, guild, sourceMembers };
    manifestCache.set(key, { value, expiresAt: now() + manifestTtlMs });
    return value;
  }

  async function loadPage(allyCode, options = {}) {
    const includeActivity = options.includeActivity !== false;
    const manifest = await loadManifest(allyCode, includeActivity);
    const total = manifest.sourceMembers.length;
    const offset = Math.max(0, Math.min(total, Math.floor(Number(options.offset || 0))));
    const limit = positiveInteger(options.limit, 5, 1, 10);
    const sourceSlice = manifest.sourceMembers.slice(offset, offset + limit);
    const seedPlayerId = firstText(manifest.seedPlayer?.playerId);

    let failures = 0;
    const hydratedRows = await mapLimit(sourceSlice, Math.min(concurrency, sourceSlice.length || 1), async (member) => {
      const playerId = firstText(member?.playerId);
      try {
        let rawPlayer = null;
        if (playerId && playerId === seedPlayerId) {
          rawPlayer = manifest.seedPlayer;
        } else {
          const payload = await requestComlink(fetchImpl, config, "/player", { playerId });
          rawPlayer = extractPlayer(payload);
        }
        if (!rawPlayer) throw new Error("Comlink /player did not return a guild member.");
        return { member, rawPlayer, error: "" };
      } catch (error) {
        failures += 1;
        return { member, rawPlayer: null, error: String(error?.message || error).slice(0, 180) };
      }
    });

    const rawPlayers = hydratedRows.map((row) => row.rawPlayer).filter(Boolean);
    let calculatedPlayers = [];
    let calculationError = "";
    if (includeActivity && rawPlayers.length && config.statsUrl) {
      try {
        calculatedPlayers = await requestStatsBatch(fetchImpl, config, rawPlayers);
      } catch (error) {
        calculationError = String(error?.message || error).slice(0, 180);
      }
    }

    const calculatedByKey = new Map();
    for (const calculatedPlayer of calculatedPlayers) {
      const key = playerKey(calculatedPlayer);
      if (key && !calculatedByKey.has(key)) calculatedByKey.set(key, calculatedPlayer);
    }

    let calculatedMatches = 0;
    const members = hydratedRows.map((row) => {
      if (!row.rawPlayer) {
        return {
          playerId: firstText(row.member?.playerId),
          name: firstText(row.member?.playerName, row.member?.name, "Unknown Player"),
          rosterAvailable: false,
          units: [],
          error: row.error,
        };
      }
      const calculated = calculatedByKey.get(playerKey(row.rawPlayer)) || null;
      if (calculated) calculatedMatches += 1;
      return durableMember(row.rawPlayer, row.member, calculated);
    });

    const hydrated = members.filter((member) => member.rosterAvailable).length;
    const nextOffset = offset + members.length;
    return {
      source: "live",
      guild: guildProfile(manifest.guild, manifest.guildId),
      members,
      page: {
        offset,
        limit,
        returned: members.length,
        totalMembers: total,
        nextOffset: nextOffset < total ? nextOffset : null,
        complete: nextOffset >= total,
        projection: "durable-baseline-v1",
      },
      hydration: {
        requested: sourceSlice.length,
        hydrated,
        failed: failures,
        complete: failures === 0 && hydrated === sourceSlice.length,
        concurrency: Math.min(concurrency, sourceSlice.length || 1),
      },
      ...(includeActivity ? {
        rosterDetail: "durable-baseline-page",
        activity: guildActivity(manifest.guild),
        calculation: {
          source: "SWGOH Stats",
          configured: Boolean(config.statsUrl),
          requested: rawPlayers.length,
          calculated: calculatedMatches,
          failed: Math.max(0, rawPlayers.length - calculatedMatches),
          complete: Boolean(config.statsUrl) && !calculationError && calculatedMatches === rawPlayers.length,
          ...(calculationError ? { error: calculationError } : {}),
        },
      } : { rosterDetail: "durable-baseline-page" }),
      fetchedAt: new Date(now()).toISOString(),
    };
  }

  return http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://gateway.local");
    const match = url.pathname.match(/^\/v1\/guild\/by-player\/(\d{9})\/sync-page$/);
    if (!match) {
      baseGateway.emit("request", request, response);
      return;
    }

    if (request.method !== "GET") {
      writeJson(response, 405, { error: "Method not allowed." }, { Allow: "GET" });
      return;
    }
    if (!config.comlinkUrl || !config.apiKey) {
      writeJson(response, 503, { error: "The live SWGOH guild sync gateway is not configured." });
      return;
    }
    if (!secureEqual(request.headers["x-api-key"], config.apiKey)) {
      writeJson(response, 401, { error: "Unauthorized." });
      return;
    }

    try {
      const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset") || 0)));
      const limit = positiveInteger(url.searchParams.get("limit"), 5, 1, 10);
      const includeActivity = url.searchParams.get("activity") !== "0";
      const body = await loadPage(match[1], { offset, limit, includeActivity });
      writeJson(response, 200, body, {
        "X-Guild-Source": "comlink-live",
        "X-Guild-Sync-Page": `${body.page.offset}:${body.page.returned}:${body.page.totalMembers}`,
        "X-Guild-Roster-Detail": body.rosterDetail,
        "X-Guild-Persistence-Projection": body.page.projection,
      });
    } catch (error) {
      const message = error?.name === "AbortError" ? "Guild sync page request timed out." : String(error?.message || error);
      console.error(`[gateway:guild-sync-page] ${error?.stack || error}`);
      writeJson(response, 502, { error: message.slice(0, 240), service: "Comlink", stage: "guild-sync-page" });
    }
  });
}

module.exports = {
  createGuildSyncPageService,
  durableMember,
  durableUnit,
  guildProfile,
};
