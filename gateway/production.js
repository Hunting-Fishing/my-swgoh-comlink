"use strict";

const { brotliDecompress } = require("node:zlib");
const { promisify } = require("node:util");
const { createGateway, loadConfig } = require("./server");
const { createLocalizationAwareFetch } = require("./bootstrap");

const decompressBrotli = promisify(brotliDecompress);
const DEFAULT_GAMEDATA_BASE_URL = "https://raw.githubusercontent.com/swgoh-utils/gamedata/main";
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

  for (const key of ["data", "items", "values", "unit", "units", "skill", "skills", "list", "entries"]) {
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

  if (units.length) normalized.units = units;
  if (skills.length) normalized.skill = skills;

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

      const [unitsPayload, skillsPayload, localizationPayload] = await Promise.all([
        fetchBrotliJson(fetchImpl, `${baseUrl}/units.json.br`),
        fetchJson(fetchImpl, `${baseUrl}/skill.json`),
        fetchBrotliJson(fetchImpl, `${baseUrl}/Loc_ENG_US.txt.json.br`),
      ]);

      const units = collectionArray(unitsPayload);
      const skills = collectionArray(skillsPayload);
      const strings = localizationMap(localizationPayload);

      if (!units.length) throw new Error("GitHub gamedata units.json.br contained no units");
      if (!skills.length) throw new Error("GitHub gamedata skill.json contained no skills");

      cached = {
        versionKey,
        gameVersion: String(versions.gameVersion || unitsPayload.version || ""),
        localeVersion: String(versions.localeVersion || localizationPayload.version || ""),
        assetVersion: versions.assetVersion == null ? "" : String(versions.assetVersion),
        units,
        skills,
        strings,
        loadedAt: new Date(now).toISOString(),
        expiresAt: now + cacheMs,
      };

      console.log(
        `[gateway] GitHub gamedata ready version=${cached.gameVersion} units=${units.length} skills=${skills.length} strings=${Object.keys(strings).length}`
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
    const url = input instanceof URL ? input : new URL(String(input));
    const method = String(options.method || "GET").toUpperCase();

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

    const response = await comlinkFetch(input, options);

    if (method !== "POST" || url.pathname !== "/data" || !response.ok) return response;

    try {
      const payload = await response.json();
      const normalized = normalizeGameData(payload);
      const unitCount = Array.isArray(normalized?.units) ? normalized.units.length : 0;
      const skillCount = Array.isArray(normalized?.skill) ? normalized.skill.length : 0;
      console.log(`[gateway] normalized fallback Comlink /data collections (units=${unitCount}, skills=${skillCount})`);
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
  collectionArray,
  createProductionFetch,
  createStaticGameDataLoader,
  localizationMap,
  normalizeGameData,
};
