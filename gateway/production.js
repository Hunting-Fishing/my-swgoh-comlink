"use strict";

const { brotliDecompress } = require("node:zlib");
const { promisify } = require("node:util");
const { createGateway, loadConfig } = require("./server");
const { createLocalizationAwareFetch } = require("./bootstrap");

const decompressBrotli = promisify(brotliDecompress);
const DEFAULT_GAMEDATA_BASE_URL = "https://raw.githubusercontent.com/swgoh-utils/gamedata/main";
const DEFAULT_ASSET_FALLBACK_BASE_URL = "https://swgoh.gg/static/img/assets";
const DEFAULT_STATIC_CACHE_MS = 6 * 60 * 60 * 1000;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function collectionArray(value, depth = 0) {
  if (Array.isArray(value)) return value;
  if (!isRecord(value) || depth > 4) return [];

  for (const key of ["data", "items", "values", "unit", "units", "skill", "skills", "recipe", "recipes", "statMod", "statMods", "list", "entries"]) {
    if (value[key] !== undefined) {
      const nested = collectionArray(value[key], depth + 1);
      if (nested.length) return nested;
    }
  }

  const mapped = Object.values(value).filter(isRecord);
  return mapped.length ? mapped : [];
}

function localizationMap(value, depth = 0) {
  if (!isRecord(value) || depth > 4) return {};

  const entries = Object.entries(value).filter(([, child]) => typeof child === "string");
  if (entries.length > 100) return Object.fromEntries(entries);

  for (const key of ["data", "items", "values", "localization", "strings", "entries"]) {
    if (isRecord(value[key])) {
      const nested = localizationMap(value[key], depth + 1);
      if (Object.keys(nested).length) return nested;
    }
  }

  return {};
}

function normalizeGameData(payload) {
  if (!isRecord(payload)) return payload;

  const normalized = { ...payload };
  const units = collectionArray(payload.units ?? payload.unit ?? payload.unitData ?? payload.unitList);
  const skills = collectionArray(payload.skill ?? payload.skills ?? payload.skillData ?? payload.skillList);
  const recipes = collectionArray(payload.recipe ?? payload.recipes ?? payload.recipeData ?? payload.recipeList);
  const statMods = collectionArray(payload.statMod ?? payload.statMods ?? payload.statModData ?? payload.statModList);

  if (units.length) normalized.units = units;
  if (skills.length) normalized.skill = skills;
  if (recipes.length) normalized.recipe = recipes;
  if (statMods.length) normalized.statMod = statMods;

  for (const key of ["data", "payload", "gameData", "result", "response"]) {
    if (isRecord(payload[key])) normalized[key] = normalizeGameData(payload[key]);
  }

  return normalized;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    redirect: "error",
  });
  if (!response.ok) throw new Error(`GitHub gamedata request failed (${response.status}) for ${url}`);
  return response.json();
}

async function fetchBrotliJson(fetchImpl, url) {
  const response = await fetchImpl(url, { redirect: "error" });
  if (!response.ok) throw new Error(`GitHub gamedata request failed (${response.status}) for ${url}`);
  const compressed = Buffer.from(await response.arrayBuffer());
  const decompressed = await decompressBrotli(compressed);
  return JSON.parse(decompressed.toString("utf8"));
}

function sameService(url, baseUrl) {
  if (!baseUrl) return false;
  try {
    const base = new URL(baseUrl);
    return url.protocol === base.protocol && url.host === base.host;
  } catch {
    return false;
  }
}

function ensureFlag(url, flag) {
  const flags = new Set(
    String(url.searchParams.get("flags") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  flags.add(flag);
  url.searchParams.set("flags", [...flags].join(","));
  return url;
}

function normalizeAe2AssetName(value) {
  return String(value || "")
    .trim()
    .replace(/^tex\./i, "")
    .replace(/\.(png|jpg|jpeg|webp)$/i, "");
}

function assetFallbackCandidates(rawName, env = process.env) {
  const baseUrl = String(env.SWGOH_ASSET_FALLBACK_BASE_URL || DEFAULT_ASSET_FALLBACK_BASE_URL).replace(/\/+$/, "");
  const raw = String(rawName || "").trim().replace(/\.(png|jpg|jpeg|webp)$/i, "");
  const normalized = normalizeAe2AssetName(raw);
  const names = [];
  if (raw) names.push(raw);
  if (normalized) {
    names.push(`tex.${normalized}`);
    names.push(normalized);
  }
  return [...new Set(names)]
    .filter(Boolean)
    .map((name) => `${baseUrl}/${encodeURIComponent(name)}.png`);
}

async function fetchAe2AssetWithFallback(fetchImpl, ae2Url, options = {}, rawName = "", env = process.env) {
  let ae2Response = null;
  try {
    ae2Response = await fetchImpl(ae2Url, options);
    if (ae2Response.ok) return ae2Response;
  } catch (error) {
    console.warn(`[gateway] AE2 asset request failed for ${normalizeAe2AssetName(rawName) || "unknown"}: ${error?.message || error}`);
  }

  for (const candidate of assetFallbackCandidates(rawName, env)) {
    try {
      const fallback = await fetchImpl(candidate, {
        headers: {
          Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          "User-Agent": "swgoh-live-gateway",
        },
        redirect: "follow",
        signal: options.signal,
      });
      if (fallback.ok) {
        console.log(`[gateway] artwork fallback served ${normalizeAe2AssetName(rawName)} from ${new URL(candidate).hostname}`);
        return fallback;
      }
    } catch {
      // Try the next deterministic image candidate.
    }
  }

  if (ae2Response) return ae2Response;
  return new Response("Asset unavailable", { status: 502 });
}

function createStaticGameDataLoader(fetchImpl = globalThis.fetch, env = process.env) {
  const baseUrl = String(env.SWGOH_GAMEDATA_BASE_URL || DEFAULT_GAMEDATA_BASE_URL).replace(/\/+$/, "");
  const cacheMs = positiveNumber(env.STATIC_GAMEDATA_CACHE_MS, DEFAULT_STATIC_CACHE_MS);
  let cached = null;
  let pending = null;

  return async function loadStaticGameData() {
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached;
    if (pending) return pending;

    pending = (async () => {
      const versions = await fetchJson(fetchImpl, `${baseUrl}/allVersions.json`);
      const versionKey = `${versions.gameVersion || "unknown"}|${versions.localeVersion || "unknown"}|${versions.assetVersion || "unknown"}`;

      if (cached && cached.versionKey === versionKey) {
        cached.expiresAt = now + cacheMs;
        return cached;
      }

      const [unitsPayload, skillsPayload, recipesPayload, statModsPayload, localizationPayload] = await Promise.all([
        fetchJson(fetchImpl, `${baseUrl}/units_gas.json`),
        fetchJson(fetchImpl, `${baseUrl}/skill.json`),
        fetchJson(fetchImpl, `${baseUrl}/recipe.json`),
        fetchJson(fetchImpl, `${baseUrl}/statMod.json`),
        fetchBrotliJson(fetchImpl, `${baseUrl}/Loc_ENG_US.txt.json.br`),
      ]);

      const units = collectionArray(unitsPayload);
      const skills = collectionArray(skillsPayload);
      const recipes = collectionArray(recipesPayload);
      const statMods = collectionArray(statModsPayload);
      const strings = localizationMap(localizationPayload);

      if (!units.length) throw new Error("GitHub gamedata units_gas.json contained no player-obtainable units");
      if (!skills.length) throw new Error("GitHub gamedata skill.json contained no skills");
      if (!recipes.length) throw new Error("GitHub gamedata recipe.json contained no recipes");

      cached = {
        versionKey,
        gameVersion: String(versions.gameVersion || unitsPayload.version || ""),
        localeVersion: String(versions.localeVersion || localizationPayload.version || ""),
        assetVersion: versions.assetVersion == null ? "" : String(versions.assetVersion),
        units,
        skills,
        recipes,
        statMods,
        strings,
        loadedAt: new Date(now).toISOString(),
        expiresAt: now + cacheMs,
      };

      console.log(
        `[gateway] GitHub gamedata ready version=${cached.gameVersion} units=${units.length} skills=${skills.length} recipes=${recipes.length} statMods=${statMods.length} strings=${Object.keys(strings).length} assetVersion=${cached.assetVersion}`
      );
      return cached;
    })().finally(() => {
      pending = null;
    });

    return pending;
  };
}

function createProductionFetch(config, fetchImpl = globalThis.fetch, env = process.env) {
  const comlinkFetch = createLocalizationAwareFetch(config, fetchImpl);
  const loadStaticGameData = createStaticGameDataLoader(fetchImpl, env);

  return async function productionFetch(input, options = {}) {
    const url = input instanceof URL ? new URL(input.href) : new URL(String(input));
    const method = String(options.method || "GET").toUpperCase();

    // SWGOH Stats only calculates Galactic Power when calcGP/onlyGP is requested.
    // Keep the full stat calculation, but always add calcGP for live player lookups.
    if (method === "POST" && url.pathname === "/api" && sameService(url, config.statsUrl)) {
      ensureFlag(url, "calcGP");
      return fetchImpl(url, options);
    }

    // AE2 expects bundle names such as "charui_darthvader", while CG game data
    // exposes thumbnailName as "tex.charui_darthvader". Strip the texture prefix.
    // If AE2 cannot return a specific asset, proxy a deterministic static artwork fallback.
    if (method === "GET" && url.pathname.toLowerCase() === "/asset/single" && sameService(url, config.assetUrl)) {
      const rawName = url.searchParams.get("assetName") || "";
      const assetName = normalizeAe2AssetName(rawName);
      if (assetName) url.searchParams.set("assetName", assetName);
      return fetchAe2AssetWithFallback(fetchImpl, url, options, rawName, env);
    }

    if (method === "POST" && ["/metadata", "/data", "/localization"].includes(url.pathname)) {
      try {
        const gameData = await loadStaticGameData();
        if (url.pathname === "/metadata") {
          return jsonResponse({
            latestGamedataVersion: gameData.gameVersion,
            latestLocalizationBundleVersion: gameData.localeVersion,
            latestAssetVersion: gameData.assetVersion,
            source: "github-gamedata",
          });
        }
        if (url.pathname === "/data") {
          return jsonResponse({
            units: gameData.units,
            skill: gameData.skills,
            recipe: gameData.recipes,
            statMod: gameData.statMods,
            version: gameData.gameVersion,
            source: "github-gamedata",
          });
        }
        return jsonResponse({
          "Loc_ENG_US.txt": gameData.strings,
          version: gameData.localeVersion,
          source: "github-gamedata",
        });
      } catch (error) {
        console.warn(`[gateway] GitHub static gamedata unavailable; falling back to Comlink ${url.pathname}: ${error?.message || error}`);
      }
    }

    const response = await comlinkFetch(url, options);

    if (method !== "POST" || url.pathname !== "/data" || !response.ok) return response;

    try {
      const payload = await response.json();
      const normalized = normalizeGameData(payload);
      const unitCount = Array.isArray(normalized?.units) ? normalized.units.length : 0;
      const skillCount = Array.isArray(normalized?.skill) ? normalized.skill.length : 0;
      const recipeCount = Array.isArray(normalized?.recipe) ? normalized.recipe.length : 0;
      console.log(`[gateway] normalized fallback Comlink /data collections (units=${unitCount}, skills=${skillCount}, recipes=${recipeCount})`);
      return jsonResponse(normalized);
    } catch (error) {
      console.warn(`[gateway] could not normalize fallback Comlink /data response: ${error?.message || error}`);
      return jsonResponse({});
    }
  };
}

function start() {
  const config = loadConfig();
  const fetchImpl = createProductionFetch(config);
  createGateway(config, { fetch: fetchImpl }).listen(config.port, "0.0.0.0", () => {
    console.log(`SWGOH live gateway listening on port ${config.port}`);
  });
}

if (require.main === module) start();

module.exports = {
  assetFallbackCandidates,
  collectionArray,
  createProductionFetch,
  createStaticGameDataLoader,
  ensureFlag,
  fetchAe2AssetWithFallback,
  localizationMap,
  normalizeAe2AssetName,
  normalizeGameData,
  sameService,
};