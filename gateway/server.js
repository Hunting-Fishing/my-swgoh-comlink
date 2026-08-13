"use strict";

const http = require("node:http");
const crypto = require("node:crypto");

const MAX_BODY_BYTES = 100 * 1024 * 1024;
const CHARACTER_COMBAT_TYPE = 1;

class UpstreamError extends Error {
  constructor(service, status, message) {
    super(`${service} returned ${status}: ${message}`);
    this.name = "UpstreamError";
    this.service = service;
    this.status = status;
  }
}

function loadConfig(env = process.env) {
  const number = (name, fallback) => {
    const value = Number(env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };

  return {
    port: number("PORT", 8080),
    comlinkUrl: trimUrl(env.COMLINK_URL),
    statsUrl: trimUrl(env.STATS_URL),
    assetUrl: trimUrl(env.ASSET_URL),
    publicBaseUrl: trimUrl(env.PUBLIC_BASE_URL),
    apiKey: String(env.GATEWAY_API_KEY || ""),
    comlinkAccessKey: String(env.COMLINK_ACCESS_KEY || ""),
    comlinkSecretKey: String(env.COMLINK_SECRET_KEY || ""),
    requestTimeoutMs: number("REQUEST_TIMEOUT_MS", 30_000),
    rosterCacheMs: number("ROSTER_CACHE_SECONDS", 30) * 1000,
    metadataCacheMs: number("METADATA_CACHE_SECONDS", 21_600) * 1000,
    rateLimitPerMinute: number("RATE_LIMIT_PER_MINUTE", 30),
  };
}

function trimUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function joinUrl(baseUrl, path) {
  return new URL(path.replace(/^\//, ""), `${baseUrl}/`);
}

function safeMessage(error, fallback) {
  if (error instanceof UpstreamError) {
    return `${error.service} could not provide current SWGOH data.`;
  }
  if (error && error.name === "AbortError") return "The live SWGOH request timed out.";
  return fallback;
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

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signedHeaders(config, method, pathname, serializedBody) {
  if (!config.comlinkAccessKey || !config.comlinkSecretKey) return {};
  const timestamp = String(Date.now());
  const bodyHash = crypto.createHash("md5").update(serializedBody).digest("hex");
  const signature = crypto
    .createHmac("sha256", config.comlinkSecretKey)
    .update(timestamp)
    .update(method)
    .update(pathname)
    .update(bodyHash)
    .digest("hex");

  return {
    "X-Date": timestamp,
    Authorization: `HMAC-SHA256 Credential=${config.comlinkAccessKey},Signature=${signature}`,
  };
}

async function requestJson(fetchImpl, config, service, baseUrl, path, body, sign = false) {
  const url = joinUrl(baseUrl, path);
  const serializedBody = JSON.stringify(body ?? {});
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  let response;

  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(sign ? signedHeaders(config, "POST", url.pathname, serializedBody) : {}),
      },
      body: serializedBody,
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new UpstreamError(service, 502, "response too large");
  if (!response.ok) throw new UpstreamError(service, response.status, text.slice(0, 180));

  try {
    return JSON.parse(text);
  } catch {
    throw new UpstreamError(service, 502, "invalid JSON");
  }
}

function extractPlayer(payload) {
  if (Array.isArray(payload)) return isRecord(payload[0]) ? payload[0] : null;
  if (!isRecord(payload)) return null;
  if (Array.isArray(payload.player)) return isRecord(payload.player[0]) ? payload.player[0] : null;
  if (isRecord(payload.player)) return payload.player;
  if (Array.isArray(payload.players)) return isRecord(payload.players[0]) ? payload.players[0] : null;
  if (isRecord(payload.payload)) return extractPlayer(payload.payload) || payload.payload;
  return payload;
}

function gameDataRoot(payload) {
  if (!isRecord(payload)) return {};
  if (isRecord(payload.data)) return payload.data;
  if (isRecord(payload.payload)) return payload.payload;
  return payload;
}

function parseLocalization(payload) {
  if (!isRecord(payload)) return new Map();
  const candidates = [];

  for (const [key, value] of Object.entries(payload)) {
    if (/eng_us/i.test(key)) candidates.unshift(value);
    else candidates.push(value);
  }

  for (const candidate of candidates) {
    if (isRecord(candidate)) return new Map(Object.entries(candidate).map(([key, value]) => [key, String(value)]));
    if (typeof candidate !== "string") continue;
    const entries = [];
    for (const line of candidate.split(/\r?\n/)) {
      const separator = line.indexOf("|");
      if (separator <= 0) continue;
      entries.push([line.slice(0, separator), line.slice(separator + 1).replace(/\\n/g, "\n")]);
    }
    if (entries.length) return new Map(entries);
  }

  return new Map();
}

function metadataValue(metadata, names) {
  const root = gameDataRoot(metadata);
  for (const name of names) {
    if (root[name] !== undefined && root[name] !== null) return root[name];
  }
  return null;
}

function makeDefinitionMap(definitions, keyName) {
  const map = new Map();
  for (const definition of definitions) {
    if (!isRecord(definition)) continue;
    const key = firstText(definition[keyName], definition.id);
    if (!key) continue;
    if (!map.has(key) || Number(definition.rarity) === 1) map.set(key, definition);
  }
  return map;
}

function humanize(value) {
  return String(value || "")
    .replace(/^(unit|skill|ability|category)_/i, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function localize(strings, key, fallback) {
  return firstText(strings.get(String(key || "")), fallback, humanize(key));
}

function baseIdOf(unit) {
  return firstText(unit.defId, unit.definitionId, unit.baseId, unit.baseID).split(":")[0];
}

function rosterOf(player) {
  return asArray(player.rosterUnit).length
    ? asArray(player.rosterUnit)
    : asArray(player.roster).length
      ? asArray(player.roster)
      : asArray(player.units);
}

function categoryIds(definition) {
  return asArray(definition.categoryId)
    .concat(asArray(definition.categoryIds))
    .filter((value) => typeof value === "string");
}

function alignmentOf(definition) {
  const categories = categoryIds(definition).join(" ").toLowerCase();
  const value = String(definition.forceAlignment || definition.alignment || "").toLowerCase();
  if (categories.includes("alignment_dark") || value === "dark" || value === "3") return "Dark";
  if (categories.includes("alignment_light") || value === "light" || value === "2") return "Light";
  if (categories.includes("alignment_neutral") || value === "neutral" || value === "1") return "Neutral";
  return "Unknown";
}

function roleOf(definition) {
  const role = categoryIds(definition).find((category) => /(^|_)role_/.test(category));
  return role ? humanize(role.replace(/^.*?role_/, "")) : humanize(definition.combatType === 2 ? "ship" : "character");
}

function factionsOf(definition) {
  const ignored = /(^|_)(alignment|role|profession|specialunit|selftag)_/i;
  return [...new Set(categoryIds(definition)
    .filter((category) => !ignored.test(category))
    .map((category) => humanize(category.replace(/^.*?(affiliation|category)_/i, ""))))]
    .filter(Boolean)
    .slice(0, 12);
}

function deepNumber(value, matchers, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return 0;
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (matchers.some((matcher) => matcher.test(key))) {
        const number = Number(isRecord(child) ? child.value ?? child.final ?? child.base : child);
        if (Number.isFinite(number)) return number;
      }
    }
    for (const child of Object.values(value)) {
      const number = deepNumber(child, matchers, depth + 1);
      if (number) return number;
    }
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      const number = deepNumber(child, matchers, depth + 1);
      if (number) return number;
    }
  }
  return 0;
}

function relicLevel(unit) {
  const raw = finiteNumber(unit.relic?.currentTier, unit.relicTier, unit.relic);
  return raw > 1 ? Math.max(0, raw - 2) : 0;
}

function readinessOf({ stars, level, gear, relic, power, speed }) {
  const score = (Math.min(stars, 7) / 7) * 15
    + (Math.min(level, 85) / 85) * 15
    + (Math.min(gear + Math.min(relic, 10) * 0.7, 20) / 20) * 30
    + (Math.min(power, 45_000) / 45_000) * 20
    + (Math.min(speed, 350) / 350) * 20;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function skillTierFlags(unit, definition, skillMap) {
  const owned = new Map(asArray(unit.skill).concat(asArray(unit.skills)).map((skill) => [firstText(skill.id, skill.skillId), finiteNumber(skill.tier, skill.currentTier)]));
  let zetas = 0;
  let omicrons = 0;
  const abilities = [];

  for (const reference of asArray(definition.skillReference)) {
    const skillId = firstText(reference.skillId, reference.id);
    const skill = skillMap.get(skillId) || {};
    const ownedTier = owned.get(skillId) || 0;
    const tiers = asArray(skill.tier);
    const active = tiers.slice(0, Math.max(0, ownedTier));
    zetas += active.filter((tier) => tier?.isZetaTier === true || /zeta/i.test(String(tier?.powerAdditiveTag || ""))).length;
    omicrons += active.filter((tier) => tier?.isOmicronTier === true || /omicron/i.test(String(tier?.powerAdditiveTag || ""))).length;
    abilities.push({
      type: humanize(firstText(skill.abilityType, skillId.split("_")[0], "ability")),
      nameKey: firstText(skill.nameKey, reference.nameKey),
      noteKey: firstText(skill.descKey, skill.descriptionKey, reference.descKey),
      tier: ownedTier,
      image: firstText(skill.icon, reference.icon),
    });
  }

  return { zetas, omicrons, abilities };
}

function unitColor(baseId) {
  const colors = ["cyan", "violet", "blue", "amber", "rose"];
  let hash = 0;
  for (const character of baseId) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return colors[Math.abs(hash) % colors.length];
}

function originFor(request, config) {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const protocol = firstText(request.headers["x-forwarded-proto"], "https").split(",")[0];
  const host = firstText(request.headers["x-forwarded-host"], request.headers.host);
  return host ? `${protocol}://${host}` : "";
}

function createGateway(config = loadConfig(), dependencies = {}) {
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const now = dependencies.now || Date.now;
  const rosterCache = new Map();
  const allowedAssets = new Map();
  const visitors = new Map();
  let gameContext = null;
  let gameContextPromise = null;

  async function comlink(path, body) {
    return requestJson(fetchImpl, config, "Comlink", config.comlinkUrl, path, body, true);
  }

  async function getGameContext() {
    if (gameContext && gameContext.expiresAt > now()) return gameContext;
    if (gameContextPromise) return gameContextPromise;

    gameContextPromise = (async () => {
      const metadata = await comlink("/metadata", {});
      const gameVersion = metadataValue(metadata, ["latestGamedataVersion", "latestGameDataVersion", "gameDataVersion"]);
      const localizationVersion = metadataValue(metadata, ["latestLocalizationBundleVersion", "localizationBundleVersion", "localizationVersion"]);
      const assetVersion = metadataValue(metadata, ["latestAssetVersion", "latestAssetBundleVersion", "assetVersion"]);
      if (!gameVersion) throw new UpstreamError("Comlink", 502, "missing current game-data version");

      const requests = [comlink("/data", { payload: { version: String(gameVersion), includePveUnits: false } })];
      if (localizationVersion) {
        requests.push(comlink("/localization", { payload: { id: String(localizationVersion) }, unzip: true }));
      }
      const [dataPayload, localizationPayload = {}] = await Promise.all(requests);
      const root = gameDataRoot(dataPayload);
      const context = {
        units: makeDefinitionMap(asArray(root.units).concat(asArray(root.unit)), "baseId"),
        skills: makeDefinitionMap(asArray(root.skill).concat(asArray(root.skills)), "id"),
        strings: parseLocalization(localizationPayload),
        assetVersion: assetVersion === null ? "" : String(assetVersion),
        expiresAt: now() + config.metadataCacheMs,
      };
      if (!context.units.size) throw new UpstreamError("Comlink", 502, "current unit definitions are unavailable");
      gameContext = context;
      return context;
    })().finally(() => { gameContextPromise = null; });

    return gameContextPromise;
  }

  async function loadRoster(allyCode, request) {
    const cached = rosterCache.get(allyCode);
    if (cached && cached.expiresAt > now()) return cached.body;

    const rawPayload = await comlink("/player", { payload: { allyCode } });
    const rawPlayer = extractPlayer(rawPayload);
    if (!rawPlayer) throw new UpstreamError("Comlink", 404, "player not found");

    const [calculatedPayload, context] = await Promise.all([
      requestJson(fetchImpl, config, "SWGOH Stats", config.statsUrl, "/api", [rawPlayer]),
      getGameContext(),
    ]);
    const calculatedPlayer = extractPlayer(calculatedPayload);
    if (!calculatedPlayer) throw new UpstreamError("SWGOH Stats", 502, "calculated roster missing");

    const publicOrigin = originFor(request, config);
    const allRoster = rosterOf(calculatedPlayer);
    const units = [];
    let shipPower = 0;

    for (const rosterUnit of allRoster) {
      if (!isRecord(rosterUnit)) continue;
      const baseId = baseIdOf(rosterUnit);
      const definition = context.units.get(baseId);
      if (!baseId || !definition) continue;
      const power = finiteNumber(rosterUnit.gp, rosterUnit.galacticPower, rosterUnit.power, deepNumber(rosterUnit.stats, [/galactic.?power/i, /^gp$/i, /^power$/i]));
      if (finiteNumber(definition.combatType, rosterUnit.combatType) !== CHARACTER_COMBAT_TYPE) {
        shipPower += power;
        continue;
      }

      const stars = finiteNumber(rosterUnit.currentRarity, rosterUnit.rarity);
      const level = finiteNumber(rosterUnit.currentLevel, rosterUnit.level);
      const gear = finiteNumber(rosterUnit.currentTier, rosterUnit.gear, rosterUnit.gearLevel);
      const relic = relicLevel(rosterUnit);
      const speed = Math.round(finiteNumber(rosterUnit.speed, deepNumber(rosterUnit.stats, [/^speed$/i, /unitstat.?5$/i])));
      if (!stars || !level || !gear || !power) continue;
      const name = localize(context.strings, definition.nameKey, humanize(baseId));
      const skillInfo = skillTierFlags(rosterUnit, definition, context.skills);
      const factions = factionsOf(definition);
      const assetName = firstText(definition.thumbnailName, `charui_${baseId.toLowerCase()}`);
      let image;

      if (config.assetUrl && context.assetVersion && publicOrigin) {
        allowedAssets.set(baseId, { assetName, version: context.assetVersion, expiresAt: now() + config.metadataCacheMs });
        image = `${publicOrigin}/v1/assets/${encodeURIComponent(baseId)}`;
      }

      units.push({
        id: firstText(rosterUnit.id, baseId),
        baseId,
        name,
        short: name.split(/\s+/).map((part) => part[0]).join("").slice(0, 3).toUpperCase(),
        alignment: alignmentOf(definition),
        role: roleOf(definition),
        factions,
        relic,
        power: Math.round(power),
        speed,
        readiness: readinessOf({ stars, level, gear, relic, power, speed }),
        color: unitColor(baseId),
        tags: factions.slice(0, 4),
        summary: `${stars}★ · Level ${level} · ${relic > 0 ? `Relic ${relic}` : `Gear ${gear}`}`,
        source: "Comlink + SWGOH Stats",
        ...(image ? { image } : {}),
        gear,
        level,
        stars,
        zetas: skillInfo.zetas,
        omicrons: skillInfo.omicrons,
        abilities: skillInfo.abilities.map((ability) => ({
          type: ability.type,
          name: localize(context.strings, ability.nameKey, humanize(ability.nameKey)),
          note: localize(context.strings, ability.noteKey, `Live ability tier ${ability.tier}`),
          ...(ability.image ? { image: ability.image } : {}),
        })),
      });
    }

    if (!units.length) throw new UpstreamError("Comlink", 502, "no current character roster returned");
    const characterPower = units.reduce((sum, unit) => sum + unit.power, 0);
    const totalPower = finiteNumber(calculatedPlayer.gp, calculatedPlayer.galacticPower, characterPower + shipPower);
    const playerName = firstText(calculatedPlayer.name);
    const playerLevel = finiteNumber(calculatedPlayer.level);
    if (!playerName || !playerLevel) throw new UpstreamError("Comlink", 502, "current player profile is incomplete");
    const profile = {
      name: playerName,
      allyCode: String(calculatedPlayer.allyCode || allyCode),
      galacticPower: Math.round(totalPower),
      characterGalacticPower: Math.round(finiteNumber(calculatedPlayer.characterGalacticPower, calculatedPlayer.characterGp, characterPower)),
      shipGalacticPower: Math.round(finiteNumber(calculatedPlayer.shipGalacticPower, calculatedPlayer.shipGp, shipPower, Math.max(0, totalPower - characterPower))),
      level: playerLevel,
      ...(firstText(calculatedPlayer.guildName) ? { guildName: firstText(calculatedPlayer.guildName) } : {}),
      ...(finiteNumber(calculatedPlayer.arenaRank) ? { arenaRank: finiteNumber(calculatedPlayer.arenaRank) } : {}),
      updatedAt: new Date(now()).toISOString(),
    };
    const body = { player: profile, units, source: "live", fetchedAt: profile.updatedAt };
    rosterCache.set(allyCode, { body, expiresAt: now() + config.rosterCacheMs });
    return body;
  }

  function permit(request) {
    const forwarded = firstText(request.headers["x-forwarded-for"]).split(",")[0].trim();
    const key = forwarded || request.socket.remoteAddress || "unknown";
    const minute = Math.floor(now() / 60_000);
    const state = visitors.get(key);
    if (!state || state.minute !== minute) {
      visitors.set(key, { minute, count: 1 });
      return true;
    }
    state.count += 1;
    return state.count <= config.rateLimitPerMinute;
  }

  async function proxyAsset(response, baseId) {
    const allowed = allowedAssets.get(baseId);
    if (!config.assetUrl || !allowed || allowed.expiresAt <= now()) {
      writeJson(response, 404, { error: "This asset is not part of a recently loaded live roster." });
      return;
    }
    const url = joinUrl(config.assetUrl, "/Asset/single");
    url.searchParams.set("forceReDownload", "false");
    url.searchParams.set("version", allowed.version);
    url.searchParams.set("assetName", allowed.assetName);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(config.requestTimeoutMs, 60_000));

    try {
      const upstream = await fetchImpl(url, { redirect: "error", signal: controller.signal });
      if (!upstream.ok) throw new UpstreamError("AE2", upstream.status, "asset unavailable");
      const data = Buffer.from(await upstream.arrayBuffer());
      const type = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? "image/png"
        : data.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? "image/jpeg" : "application/octet-stream";
      response.writeHead(200, {
        "Content-Type": type,
        "Content-Length": String(data.length),
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(data);
    } catch (error) {
      writeJson(response, 502, { error: safeMessage(error, "Current game artwork is unavailable.") });
    } finally {
      clearTimeout(timeout);
    }
  }

  return http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://gateway.local");
    if (request.method !== "GET") {
      writeJson(response, 405, { error: "Method not allowed." }, { Allow: "GET" });
      return;
    }
    if (url.pathname === "/healthz") {
      const configured = Boolean(config.comlinkUrl && config.statsUrl && config.apiKey);
      writeJson(response, 200, { status: configured ? "configured" : "needs-configuration", liveOnly: true });
      return;
    }
    if (!permit(request)) {
      writeJson(response, 429, { error: "Too many live requests. Please retry shortly." }, { "Retry-After": "60" });
      return;
    }
    const assetMatch = url.pathname.match(/^\/v1\/assets\/([A-Za-z0-9_-]+)$/);
    if (assetMatch) {
      await proxyAsset(response, assetMatch[1]);
      return;
    }
    const playerMatch = url.pathname.match(/^\/v1\/player\/(\d{9})$/);
    if (!playerMatch) {
      writeJson(response, 404, { error: "Not found." });
      return;
    }
    if (!config.comlinkUrl || !config.statsUrl || !config.apiKey) {
      writeJson(response, 503, { error: "The live SWGOH gateway is not configured." });
      return;
    }
    if (!secureEqual(request.headers["x-api-key"], config.apiKey)) {
      writeJson(response, 401, { error: "Unauthorized." });
      return;
    }

    try {
      const body = await loadRoster(playerMatch[1], request);
      writeJson(response, 200, body, { "X-Roster-Source": "comlink-live" });
    } catch (error) {
      const status = error instanceof UpstreamError && error.status === 404 ? 404 : 502;
      writeJson(response, status, { error: safeMessage(error, "The live SWGOH pipeline is unavailable.") });
    }
  });
}

if (require.main === module) {
  const config = loadConfig();
  createGateway(config).listen(config.port, "0.0.0.0", () => {
    console.log(`SWGOH live gateway listening on port ${config.port}`);
  });
}

module.exports = { createGateway, loadConfig, parseLocalization, readinessOf };
