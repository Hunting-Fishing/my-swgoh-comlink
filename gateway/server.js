"use strict";

const http = require("node:http");
const crypto = require("node:crypto");

const MAX_BODY_BYTES = 100 * 1024 * 1024;
const CHARACTER_COMBAT_TYPE = 1;
const SHIP_COMBAT_TYPE = 2;

class PipelineError extends Error {
  constructor(service, stage, status, detail) {
    super(`${service} ${stage}${status ? ` returned HTTP ${status}` : " failed"}${detail ? `: ${detail}` : ""}`);
    this.name = "PipelineError";
    this.service = service;
    this.stage = stage;
    this.status = status || 502;
    this.detail = String(detail || "").slice(0, 240);
  }
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function trimUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function loadConfig(env = process.env) {
  return {
    port: positiveNumber(env.PORT, 8080),
    comlinkUrl: trimUrl(env.COMLINK_URL),
    statsUrl: trimUrl(env.STATS_URL),
    assetUrl: trimUrl(env.ASSET_URL),
    publicBaseUrl: trimUrl(env.PUBLIC_BASE_URL),
    apiKey: String(env.GATEWAY_API_KEY || "").trim(),
    comlinkAccessKey: String(env.COMLINK_ACCESS_KEY || "").trim(),
    comlinkSecretKey: String(env.COMLINK_SECRET_KEY || "").trim(),
    requestTimeoutMs: positiveNumber(env.REQUEST_TIMEOUT_MS, 45_000),
    rosterCacheMs: positiveNumber(env.ROSTER_CACHE_SECONDS, 30) * 1000,
    metadataCacheMs: positiveNumber(env.METADATA_CACHE_SECONDS, 21_600) * 1000,
    rateLimitPerMinute: positiveNumber(env.RATE_LIMIT_PER_MINUTE, 30),
  };
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
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function joinUrl(baseUrl, pathname) {
  return new URL(String(pathname || "").replace(/^\//, ""), `${baseUrl}/`);
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

function cleanDetail(value) {
  return String(value || "")
    .replace(/authorization\s*[:=]\s*[^\s,;]+/gi, "authorization=[redacted]")
    .replace(/x-api-key\s*[:=]\s*[^\s,;]+/gi, "x-api-key=[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

async function requestJson(fetchImpl, config, service, baseUrl, pathname, body, sign = false) {
  if (!baseUrl) throw new PipelineError(service, pathname, 503, "service URL is not configured");

  const url = joinUrl(baseUrl, pathname);
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
  } catch (error) {
    const detail = error?.name === "AbortError" ? "request timed out" : cleanDetail(error?.message || error);
    throw new PipelineError(service, pathname, 502, detail);
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
    throw new PipelineError(service, pathname, 502, "response exceeded size limit");
  }
  if (!response.ok) {
    throw new PipelineError(service, pathname, response.status, cleanDetail(text));
  }

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new PipelineError(service, pathname, 502, "response was not valid JSON");
  }
}

function extractPlayer(payload) {
  if (Array.isArray(payload)) return isRecord(payload[0]) ? payload[0] : null;
  if (!isRecord(payload)) return null;

  for (const key of ["player", "players", "result", "results"]) {
    const value = payload[key];
    if (Array.isArray(value) && isRecord(value[0])) return value[0];
    if (isRecord(value) && (value.name || value.allyCode || value.roster || value.rosterUnit)) return value;
  }

  if (isRecord(payload.payload)) return extractPlayer(payload.payload) || payload.payload;
  if (isRecord(payload.data)) return extractPlayer(payload.data) || payload.data;

  return payload;
}

function rosterOf(player) {
  if (!isRecord(player)) return [];
  for (const key of ["rosterUnit", "roster", "units", "unit"]) {
    if (Array.isArray(player[key]) && player[key].length) return player[key];
  }
  return [];
}

function childArray(value) {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) {
    if (Array.isArray(value.data)) return value.data;
    if (Array.isArray(value.items)) return value.items;
    if (Array.isArray(value.values)) return value.values;
  }
  return [];
}

function findCollection(payload, names, depth = 0) {
  if (depth > 5 || payload == null) return [];

  if (isRecord(payload)) {
    for (const name of names) {
      const found = childArray(payload[name]);
      if (found.length) return found;
    }

    for (const key of ["data", "payload", "gameData", "result", "response"]) {
      if (payload[key] !== undefined) {
        const found = findCollection(payload[key], names, depth + 1);
        if (found.length) return found;
      }
    }

    for (const value of Object.values(payload)) {
      if (!isRecord(value)) continue;
      const found = findCollection(value, names, depth + 1);
      if (found.length) return found;
    }
  }

  return [];
}

function metadataValue(payload, names, depth = 0) {
  if (depth > 4 || !isRecord(payload)) return null;
  for (const name of names) {
    if (payload[name] !== undefined && payload[name] !== null && payload[name] !== "") return payload[name];
  }
  for (const key of ["data", "payload", "metadata", "result"]) {
    if (isRecord(payload[key])) {
      const found = metadataValue(payload[key], names, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

function parseLocalization(payload) {
  const directMap = (value) => {
    if (!isRecord(value)) return null;
    const entries = Object.entries(value).filter(([, v]) => typeof v === "string");
    if (!entries.length) return null;
    return new Map(entries.map(([key, value]) => [key, value]));
  };

  const candidates = [];
  if (isRecord(payload)) {
    for (const [key, value] of Object.entries(payload)) {
      if (/eng[_-]?us/i.test(key)) candidates.unshift(value);
      else candidates.push(value);
    }
    for (const key of ["data", "payload", "result"]) {
      if (payload[key] !== undefined) candidates.unshift(payload[key]);
    }
  }

  for (const candidate of candidates) {
    const map = directMap(candidate);
    if (map?.size) return map;

    if (typeof candidate === "string") {
      const entries = [];
      for (const line of candidate.split(/\r?\n/)) {
        const separator = line.indexOf("|");
        if (separator <= 0) continue;
        entries.push([line.slice(0, separator), line.slice(separator + 1).replace(/\\n/g, "\n")]);
      }
      if (entries.length) return new Map(entries);
    }

    if (isRecord(candidate)) {
      for (const [key, value] of Object.entries(candidate)) {
        if (!/eng[_-]?us/i.test(key)) continue;
        const nestedMap = directMap(value);
        if (nestedMap?.size) return nestedMap;
      }
    }
  }

  return new Map();
}

function baseIdOf(unit) {
  return firstText(unit?.defId, unit?.definitionId, unit?.baseId, unit?.baseID, unit?.id).split(":")[0];
}

function definitionBaseId(definition) {
  return firstText(definition?.baseId, definition?.baseID, definition?.id).split(":")[0];
}

function makeDefinitionMap(definitions) {
  const map = new Map();
  for (const definition of definitions) {
    if (!isRecord(definition)) continue;
    const key = definitionBaseId(definition);
    if (!key) continue;

    const current = map.get(key);
    const rarity = finiteNumber(definition.rarity, definition.currentRarity);
    if (!current || rarity === 1 || finiteNumber(current.rarity) !== 1) map.set(key, definition);
  }
  return map;
}

function makeSkillMap(skills) {
  const map = new Map();
  for (const skill of skills) {
    if (!isRecord(skill)) continue;
    const id = firstText(skill.id, skill.skillId, skill.baseId);
    if (id && !map.has(id)) map.set(id, skill);
  }
  return map;
}

function makeStatModMap(statMods) {
  const map = new Map();
  for (const statMod of statMods) {
    if (!isRecord(statMod)) continue;
    const id = firstText(statMod.id, statMod.definitionId, statMod.baseId);
    if (id && !map.has(id)) map.set(id, statMod);
  }
  return map;
}

function humanize(value) {
  return String(value || "")
    .replace(/^(unit|skill|ability|category)_/i, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function localized(strings, key, ...fallbacks) {
  const lookup = String(key || "");
  const translated = strings.get(lookup);
  if (typeof translated === "string" && translated.trim()) return translated.trim();

  for (const fallback of fallbacks) {
    if (typeof fallback === "string" && fallback.trim()) return fallback.trim();
  }

  if (lookup && /\s/.test(lookup) && !/^[A-Z0-9_]+$/.test(lookup)) return lookup;
  return humanize(lookup);
}

function categoryIds(definition) {
  const values = []
    .concat(asArray(definition?.categoryId))
    .concat(asArray(definition?.categoryIds))
    .concat(asArray(definition?.categoryIdList))
    .concat(asArray(definition?.categories));

  return [...new Set(values.map((value) => {
    if (typeof value === "string") return value;
    if (isRecord(value)) return firstText(value.id, value.categoryId, value.name);
    return "";
  }).filter(Boolean))];
}

function combatTypeOf(definition, rosterUnit) {
  const raw = definition?.combatType ?? rosterUnit?.combatType;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;

  const text = String(raw || "").toUpperCase();
  if (text === "CHARACTER" || text === "CHAR" || text.endsWith("_CHARACTER")) return CHARACTER_COMBAT_TYPE;
  if (text === "SHIP" || text.endsWith("_SHIP")) return SHIP_COMBAT_TYPE;

  const prefab = firstText(definition?.unitPrefab, definition?.prefab).toLowerCase();
  if (prefab.includes("unit.char_")) return CHARACTER_COMBAT_TYPE;
  if (prefab.includes("unit.ship_")) return SHIP_COMBAT_TYPE;
  return 0;
}

function alignmentOf(definition) {
  const categories = categoryIds(definition).join(" ").toLowerCase();
  const value = String(definition?.forceAlignment ?? definition?.alignment ?? "").toLowerCase();
  if (categories.includes("alignment_dark") || ["dark", "3", "dark_side"].includes(value)) return "Dark";
  if (categories.includes("alignment_light") || ["light", "2", "light_side"].includes(value)) return "Light";
  if (categories.includes("alignment_neutral") || ["neutral", "1"].includes(value)) return "Neutral";
  return "Unknown";
}

function roleOf(definition, type) {
  const role = categoryIds(definition).find((category) => /(^|_)role_/.test(category));
  if (role) return humanize(role.replace(/^.*?role_/, ""));
  return type === SHIP_COMBAT_TYPE ? "Ship" : "Character";
}

function factionsOf(definition) {
  const ignored = /(^|_)(alignment|role|profession|specialunit|selftag|territory|any_obtainable)/i;
  return [...new Set(categoryIds(definition)
    .filter((category) => !ignored.test(category))
    .map((category) => humanize(category.replace(/^.*?(affiliation|category)_/i, "")))
    .filter(Boolean))]
    .slice(0, 16);
}

function deepNumber(value, matchers, depth = 0) {
  if (depth > 7 || value === null || value === undefined) return 0;

  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);

  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (matchers.some((matcher) => matcher.test(key))) {
        const candidate = isRecord(child)
          ? finiteNumber(child.value, child.final, child.base, child.statValue, child.statValueDecimal)
          : finiteNumber(child);
        if (candidate) return candidate;
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

function powerOf(unit) {
  return Math.round(finiteNumber(
    unit?.gp,
    unit?.galacticPower,
    unit?.power,
    unit?.unitPower,
    unit?.stats?.gp,
    unit?.stats?.galacticPower,
    deepNumber(unit?.stats, [/galactic.?power/i, /^gp$/i, /^power$/i])
  ));
}

function speedOf(unit) {
  const raw = finiteNumber(
    unit?.speed,
    unit?.stats?.Speed,
    unit?.stats?.speed,
    deepNumber(unit?.stats, [/^speed$/i, /unitstat.?5$/i, /UNITSTATSPEED/i])
  );
  if (!raw) return 0;
  return Math.round(raw > 10_000 ? raw / 10_000 : raw);
}

function relicLevel(unit) {
  const raw = finiteNumber(unit?.relic?.currentTier, unit?.relicTier, unit?.relic?.tier, unit?.relic);
  return raw > 1 ? Math.max(0, raw - 2) : Math.max(0, raw);
}

function readinessOf({ stars, level, gear, relic, power, speed }) {
  const score =
    (Math.min(stars, 7) / 7) * 15 +
    (Math.min(level, 85) / 85) * 15 +
    (Math.min(gear + Math.min(relic, 10) * 0.7, 20) / 20) * 30 +
    (Math.min(power, 45_000) / 45_000) * 20 +
    (Math.min(speed, 350) / 350) * 20;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function skillReferences(definition) {
  return asArray(definition?.skillReference)
    .concat(asArray(definition?.skillReferenceList))
    .concat(asArray(definition?.skills));
}

function skillTiers(skill) {
  return asArray(skill?.tier)
    .concat(asArray(skill?.tierList))
    .concat(asArray(skill?.tiers));
}

function ownedSkills(unit) {
  const map = new Map();
  for (const skill of asArray(unit?.skill).concat(asArray(unit?.skills))) {
    if (!isRecord(skill)) continue;
    const id = firstText(skill.id, skill.skillId);
    if (!id) continue;
    map.set(id, finiteNumber(skill.tier, skill.currentTier, skill.level));
  }
  return map;
}

function tierHasUpgrade(tier, kind) {
  if (!isRecord(tier)) return false;
  const recipeId = String(tier.recipeId || "").toLowerCase();
  if (kind === "zeta" && (tier.isZetaTier === true || recipeId === "abilitymaterial_zeta")) return true;
  if (kind === "omega" && (tier.isOmegaTier === true || recipeId === "abilitymaterial_omega")) return true;
  if (kind === "omicron" && (tier.isOmicronTier === true || recipeId === "abilitymaterial_omicron")) return true;

  return new RegExp(kind, "i").test([
    tier.powerAdditiveTag,
    tier.powerOverrideTag,
    tier.name,
    tier.id,
    tier.tierName,
    tier.recipeId,
  ].filter(Boolean).join(" "));
}

function skillInfoOf(unit, definition, skillMap, strings) {
  const owned = ownedSkills(unit);
  let zetas = 0;
  let omegas = 0;
  let omicrons = 0;
  const abilities = [];

  for (const reference of skillReferences(definition)) {
    if (!isRecord(reference)) continue;
    const skillId = firstText(reference.skillId, reference.id);
    if (!skillId) continue;

    const skill = skillMap.get(skillId) || {};
    const ownedTier = owned.get(skillId) || 0;
    const playerTier = Math.max(0, ownedTier + 2);
    const tiers = skillTiers(skill);
    const active = tiers.filter((tier, index) => isRecord(tier) && index + 2 <= playerTier);

    zetas += active.filter((tier) => tierHasUpgrade(tier, "zeta")).length;
    omegas += active.filter((tier) => tierHasUpgrade(tier, "omega")).length;
    omicrons += active.filter((tier) => tierHasUpgrade(tier, "omicron")).length;

    const nameKey = firstText(skill.nameKey, reference.nameKey);
    const descKey = firstText(skill.descKey, skill.descriptionKey, reference.descKey);
    abilities.push({
      id: skillId,
      type: humanize(firstText(skill.abilityType, skillId.split("_")[0], "ability")),
      name: localized(strings, nameKey, skill.name, humanize(skillId)),
      note: localized(strings, descKey, skill.description, `Live ability tier ${playerTier}`),
      tier: ownedTier,
      displayTier: playerTier,
      zeta: active.some((tier) => tierHasUpgrade(tier, "zeta")),
      omega: active.some((tier) => tierHasUpgrade(tier, "omega")),
      omicron: active.some((tier) => tierHasUpgrade(tier, "omicron")),
      ...(firstText(skill.icon, reference.icon) ? { image: firstText(skill.icon, reference.icon) } : {}),
    });
  }

  return { zetas, omegas, omicrons, abilities };
}

function sixDotModsOf(player, context) {
  const statMods = context?.statMods instanceof Map ? context.statMods : new Map();
  let equipped = 0;
  let resolved = 0;
  let sixDot = 0;

  for (const rosterUnit of rosterOf(player)) {
    const mods = asArray(rosterUnit?.equippedStatMod)
      .concat(asArray(rosterUnit?.equippedStatMods));

    for (const mod of mods) {
      if (!isRecord(mod)) continue;
      equipped += 1;

      const definitionId = firstText(mod.definitionId, mod.defId);
      const definition = definitionId ? statMods.get(definitionId) : null;
      const rarity = finiteNumber(definition?.rarity, mod.rarity);

      if (rarity > 0) {
        resolved += 1;
        if (rarity >= 6) sixDot += 1;
      }
    }
  }

  if (equipped === 0) return 0;
  if (resolved === 0) return null;
  return sixDot;
}

function originFor(request, config) {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const protocol = firstText(request.headers["x-forwarded-proto"], "https").split(",")[0];
  const host = firstText(request.headers["x-forwarded-host"], request.headers.host);
  return host ? `${protocol}://${host}` : "";
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

function publicPipelineError(error) {
  if (error instanceof PipelineError) {
    return {
      status: error.status === 404 ? 404 : 502,
      body: {
        error: `${error.service} ${error.stage} failed${error.status ? ` (HTTP ${error.status})` : ""}${error.detail ? `: ${error.detail}` : "."}`,
        stage: error.stage,
        service: error.service,
      },
    };
  }
  const detail = error?.name === "AbortError" ? "request timed out" : cleanDetail(error?.message || error);
  return {
    status: 502,
    body: { error: `Live SWGOH pipeline failed: ${detail || "unknown error"}`, stage: "gateway", service: "Gateway" },
  };
}

function createGateway(config = loadConfig(), dependencies = {}) {
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const now = dependencies.now || Date.now;
  const rosterCache = new Map();
  const allowedAssets = new Map();
  const visitors = new Map();
  let gameContext = null;
  let gameContextPromise = null;

  async function comlink(pathname, body) {
    return requestJson(fetchImpl, config, "Comlink", config.comlinkUrl, pathname, body, true);
  }

  async function getGameContext() {
    if (gameContext && gameContext.expiresAt > now()) return gameContext;
    if (gameContextPromise) return gameContextPromise;

    gameContextPromise = (async () => {
      const metadata = await comlink("/metadata", {});
      const gameVersion = metadataValue(metadata, [
        "latestGamedataVersion",
        "latestGameDataVersion",
        "gameDataVersion",
      ]);
      const localizationVersion = metadataValue(metadata, [
        "latestLocalizationBundleVersion",
        "localizationBundleVersion",
        "localizationVersion",
      ]);
      const assetVersion = metadataValue(metadata, [
        "latestAssetVersion",
        "latestAssetBundleVersion",
        "assetVersion",
      ]);

      if (!gameVersion) {
        throw new PipelineError("Gateway", "game-context", 502, "Comlink metadata did not include a game-data version");
      }

      const dataRequest = comlink("/data", {
        payload: { version: String(gameVersion), includePveUnits: false },
      });
      const localizationRequest = localizationVersion
        ? comlink("/localization", { payload: { id: String(localizationVersion) }, unzip: true })
        : Promise.resolve({});

      const [dataPayload, localizationPayload] = await Promise.all([dataRequest, localizationRequest]);
      const definitions = findCollection(dataPayload, ["units", "unit", "unitData", "unitList"]);
      const skills = findCollection(dataPayload, ["skill", "skills", "skillData", "skillList"]);
      const statMods = findCollection(dataPayload, ["statMod", "statMods", "statModData", "statModList"]);
      const unitMap = makeDefinitionMap(definitions);

      if (!unitMap.size) {
        const topKeys = isRecord(dataPayload) ? Object.keys(dataPayload).slice(0, 12).join(",") : typeof dataPayload;
        throw new PipelineError(
          "Gateway",
          "game-context",
          502,
          `no unit definitions found in Comlink /data response (top-level: ${topKeys || "none"})`
        );
      }

      gameContext = {
        units: unitMap,
        skills: makeSkillMap(skills),
        statMods: makeStatModMap(statMods),
        strings: parseLocalization(localizationPayload),
        assetVersion: assetVersion == null ? "" : String(assetVersion),
        expiresAt: now() + config.metadataCacheMs,
      };
      return gameContext;
    })().finally(() => {
      gameContextPromise = null;
    });

    return gameContextPromise;
  }

  function normalizeUnit(rosterUnit, definition, context, request, type) {
    const baseId = baseIdOf(rosterUnit);
    const stars = finiteNumber(rosterUnit.currentRarity, rosterUnit.rarity);
    const level = finiteNumber(rosterUnit.currentLevel, rosterUnit.level);
    const gear = finiteNumber(rosterUnit.currentTier, rosterUnit.gear, rosterUnit.gearLevel);
    const relic = relicLevel(rosterUnit);
    const power = powerOf(rosterUnit);
    const speed = speedOf(rosterUnit);
    const name = localized(
      context.strings,
      definition.nameKey,
      definition.name,
      humanize(baseId)
    );
    const factions = factionsOf(definition);
    const skillInfo = skillInfoOf(rosterUnit, definition, context.skills, context.strings);
    const publicOrigin = originFor(request, config);
    const assetName = firstText(
      definition.thumbnailName,
      definition.thumbnail,
      definition.icon,
      `tex.charui_${baseId.toLowerCase()}`
    );

    let image;
    if (config.assetUrl && context.assetVersion && publicOrigin) {
      allowedAssets.set(baseId, {
        assetName,
        version: context.assetVersion,
        expiresAt: now() + config.metadataCacheMs,
      });
      image = `${publicOrigin}/v1/assets/${encodeURIComponent(baseId)}`;
    }

    return {
      id: firstText(rosterUnit.id, baseId),
      baseId,
      name,
      short: name.split(/\s+/).map((part) => part[0]).join("").slice(0, 3).toUpperCase(),
      unitType: type === SHIP_COMBAT_TYPE ? "Ship" : "Character",
      alignment: alignmentOf(definition),
      role: roleOf(definition, type),
      factions,
      relic,
      power,
      speed,
      readiness: readinessOf({ stars, level, gear, relic, power, speed }),
      tags: factions.slice(0, 4),
      summary: `${stars || 0}★ · Level ${level || 0} · ${type === SHIP_COMBAT_TYPE ? "Ship" : relic > 0 ? `Relic ${relic}` : `Gear ${gear || 0}`}`,
      source: "Comlink + SWGOH Stats",
      ...(image ? { image } : {}),
      gear,
      level,
      stars,
      zetas: skillInfo.zetas,
      omegas: skillInfo.omegas,
      omicrons: skillInfo.omicrons,
      abilities: skillInfo.abilities,
    };
  }

  async function loadRoster(allyCode, request) {
    const cached = rosterCache.get(allyCode);
    if (cached && cached.expiresAt > now()) return cached.body;

    const rawPayload = await comlink("/player", { payload: { allyCode } });
    const rawPlayer = extractPlayer(rawPayload);
    if (!rawPlayer) throw new PipelineError("Comlink", "/player", 404, "player was not returned");

    const rawRoster = rosterOf(rawPlayer);
    if (!rawRoster.length) {
      throw new PipelineError("Gateway", "player-normalization", 502, "player response contained no roster units");
    }

    const [calculatedPayload, context] = await Promise.all([
      requestJson(fetchImpl, config, "SWGOH Stats", config.statsUrl, "/api", [rawPlayer]),
      getGameContext(),
    ]);

    const calculatedPlayer = extractPlayer(calculatedPayload);
    if (!calculatedPlayer) {
      throw new PipelineError("SWGOH Stats", "/api", 502, "calculated player payload was empty");
    }

    const calculatedRoster = rosterOf(calculatedPlayer);
    if (!calculatedRoster.length) {
      throw new PipelineError("SWGOH Stats", "/api", 502, "calculated player contained no roster units");
    }

    const characters = [];
    const ships = [];
    let missingDefinitions = 0;
    let unknownCombatType = 0;

    for (const rosterUnit of calculatedRoster) {
      if (!isRecord(rosterUnit)) continue;
      const baseId = baseIdOf(rosterUnit);
      if (!baseId) continue;

      const definition = context.units.get(baseId);
      if (!definition) {
        missingDefinitions += 1;
        continue;
      }

      const type = combatTypeOf(definition, rosterUnit);
      if (type !== CHARACTER_COMBAT_TYPE && type !== SHIP_COMBAT_TYPE) {
        unknownCombatType += 1;
        continue;
      }

      const normalized = normalizeUnit(rosterUnit, definition, context, request, type);
      if (type === SHIP_COMBAT_TYPE) ships.push(normalized);
      else characters.push(normalized);
    }

    if (!characters.length) {
      throw new PipelineError(
        "Gateway",
        "roster-normalization",
        502,
        `0 characters normalized from ${calculatedRoster.length} roster units; definitions=${context.units.size}, missingDefinitions=${missingDefinitions}, unknownCombatType=${unknownCombatType}`
      );
    }

    const characterPower = characters.reduce((sum, unit) => sum + finiteNumber(unit.power), 0);
    const shipPower = ships.reduce((sum, unit) => sum + finiteNumber(unit.power), 0);

    const playerName = firstText(calculatedPlayer.name, rawPlayer.name);
    const playerLevel = finiteNumber(calculatedPlayer.level, rawPlayer.level);
    if (!playerName) {
      throw new PipelineError("Gateway", "player-normalization", 502, "player name is missing");
    }

    const characterGP = Math.round(finiteNumber(
      calculatedPlayer.characterGalacticPower,
      calculatedPlayer.characterGp,
      calculatedPlayer.gpChar,
      rawPlayer.characterGalacticPower,
      rawPlayer.characterGp,
      rawPlayer.gpChar,
      characterPower
    ));
    const shipGP = Math.round(finiteNumber(
      calculatedPlayer.shipGalacticPower,
      calculatedPlayer.shipGp,
      calculatedPlayer.gpShip,
      rawPlayer.shipGalacticPower,
      rawPlayer.shipGp,
      rawPlayer.gpShip,
      shipPower
    ));
    const totalPower = Math.round(finiteNumber(
      calculatedPlayer.galacticPower,
      calculatedPlayer.gp,
      calculatedPlayer.gpFull,
      rawPlayer.galacticPower,
      rawPlayer.gp,
      rawPlayer.gpFull,
      characterGP + shipGP
    ));

    const guildName = firstText(
      calculatedPlayer.guildName,
      calculatedPlayer.guild?.name,
      rawPlayer.guildName,
      rawPlayer.guild?.name
    );

    const pvpRank = (player, tab) => {
      const entry = asArray(player?.pvpProfile).find((item) => Number(item?.tab) === tab);
      return entry ? finiteNumber(entry.rank) : 0;
    };

    const arenaRank = finiteNumber(
      calculatedPlayer.arenaRank,
      calculatedPlayer.arena?.char?.rank,
      calculatedPlayer.arena?.character?.rank,
      rawPlayer.arenaRank,
      rawPlayer.arena?.char?.rank,
      rawPlayer.arena?.character?.rank,
      pvpRank(calculatedPlayer, 1),
      pvpRank(rawPlayer, 1)
    );
    const fleetArenaRank = finiteNumber(
      calculatedPlayer.fleetArenaRank,
      calculatedPlayer.arena?.fleet?.rank,
      rawPlayer.fleetArenaRank,
      rawPlayer.arena?.fleet?.rank,
      pvpRank(calculatedPlayer, 2),
      pvpRank(rawPlayer, 2)
    );
    const gacSkillRating = finiteNumber(
      calculatedPlayer.playerRating?.playerSkillRating?.skillRating,
      calculatedPlayer.playerSkillRating?.skillRating,
      calculatedPlayer.gacSkillRating,
      rawPlayer.playerRating?.playerSkillRating?.skillRating,
      rawPlayer.playerSkillRating?.skillRating,
      rawPlayer.gacSkillRating
    );

    const datacronCollection = [
      calculatedPlayer.datacron,
      calculatedPlayer.datacrons,
      calculatedPlayer.datacronList,
      rawPlayer.datacron,
      rawPlayer.datacrons,
      rawPlayer.datacronList,
    ].find(Array.isArray);
    const datacronCount = Array.isArray(datacronCollection) ? datacronCollection.length : null;

    const sixDotCandidates = [
      sixDotModsOf(calculatedPlayer, context),
      sixDotModsOf(rawPlayer, context),
    ].filter((value) => Number.isFinite(value));
    const sixDotMods = sixDotCandidates.length ? Math.max(...sixDotCandidates) : null;

    const profile = {
      name: playerName,
      allyCode: String(calculatedPlayer.allyCode || rawPlayer.allyCode || allyCode),
      galacticPower: totalPower,
      characterGalacticPower: characterGP,
      shipGalacticPower: shipGP,
      level: playerLevel,
      ...(guildName ? { guildName } : {}),
      ...(arenaRank ? { arenaRank } : {}),
      ...(fleetArenaRank ? { fleetArenaRank } : {}),
      ...(gacSkillRating ? { gacSkillRating } : {}),
      updatedAt: new Date(now()).toISOString(),
    };

    const competitive = {
      ...(arenaRank ? { arenaRank } : {}),
      ...(fleetArenaRank ? { fleetArenaRank } : {}),
      ...(gacSkillRating ? { gacSkillRating } : {}),
    };
    const summary = {
      ...(datacronCount !== null ? { datacrons: datacronCount } : {}),
      ...(sixDotMods !== null ? { sixDotMods } : {}),
    };

    const body = {
      player: profile,
      units: characters,
      ships,
      ...(Object.keys(summary).length ? { summary } : {}),
      ...(Object.keys(competitive).length ? { competitive } : {}),
      source: "live",
      fetchedAt: profile.updatedAt,
      diagnostics: {
        rawRoster: rawRoster.length,
        calculatedRoster: calculatedRoster.length,
        characters: characters.length,
        ships: ships.length,
        missingDefinitions,
        unknownCombatType,
      },
    };

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
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        throw new PipelineError("AE2", "/Asset/single", upstream.status, cleanDetail(text));
      }

      const data = Buffer.from(await upstream.arrayBuffer());
      const isPng = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const isJpeg = data.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
      const type = isPng ? "image/png" : isJpeg ? "image/jpeg" : "application/octet-stream";

      response.writeHead(200, {
        "Content-Type": type,
        "Content-Length": String(data.length),
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(data);
    } catch (error) {
      const failure = publicPipelineError(error);
      writeJson(response, failure.status, failure.body);
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
      writeJson(response, 200, {
        status: configured ? "configured" : "needs-configuration",
        liveOnly: true,
        services: {
          comlink: Boolean(config.comlinkUrl),
          stats: Boolean(config.statsUrl),
          assets: Boolean(config.assetUrl),
        },
      });
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
      const failure = publicPipelineError(error);
      console.error(`[gateway] ${error?.stack || error}`);
      writeJson(response, failure.status, failure.body);
    }
  });
}

if (require.main === module) {
  const config = loadConfig();
  createGateway(config).listen(config.port, "0.0.0.0", () => {
    console.log(`SWGOH live gateway listening on port ${config.port}`);
  });
}

module.exports = {
  PipelineError,
  createGateway,
  loadConfig,
  parseLocalization,
  readinessOf,
  combatTypeOf,
  categoryIds,
};
