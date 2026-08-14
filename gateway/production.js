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

  for (const key of ["data", "items", "values", "unit", "units", "skill", "skills", "recipe", "recipes", "material", "materials", "statMod", "statMods", "list", "entries"]) {
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
  const materials = collectionArray(payload.material ?? payload.materials ?? payload.materialData ?? payload.materialList);
  const statMods = collectionArray(payload.statMod ?? payload.statMods ?? payload.statModData ?? payload.statModList);

  if (units.length) normalized.units = units;
  if (skills.length) normalized.skill = skills;
  if (recipes.length) normalized.recipe = recipes;
  if (materials.length) normalized.material = materials;
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

function normalizeMaterialId(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function recipeIngredientIds(recipe) {
  if (!isRecord(recipe)) return [];
  const ids = new Set();

  function visit(node, parentKey = "", depth = 0) {
    if (node == null || depth > 9) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parentKey, depth + 1);
      return;
    }
    if (!isRecord(node)) return;

    for (const [key, child] of Object.entries(node)) {
      const context = `${parentKey} ${key}`;
      if (typeof child === "string") {
        const compact = normalizeMaterialId(child);
        const materialContext = /(material|ingredient|item|cost)/i.test(context);
        const idKey = /^(id|materialid|itemid|definitionid)$/i.test(key);
        if (compact.startsWith("abilitymaterial") || (materialContext && idKey)) ids.add(child.trim());
      } else {
        visit(child, context, depth + 1);
      }
    }
  }

  visit(recipe);
  return [...ids];
}

function materialIdOf(material) {
  if (!isRecord(material)) return "";
  return String(material.id || material.materialId || material.definitionId || material.baseId || "").trim();
}

function materialSemanticText(material, strings = {}) {
  if (!isRecord(material)) return "";
  const pieces = [JSON.stringify(material)];
  const seen = new Set();

  function visit(node, depth = 0) {
    if (node == null || depth > 7) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    if (!isRecord(node)) return;

    for (const child of Object.values(node)) {
      if (typeof child === "string") {
        if (seen.has(child)) continue;
        seen.add(child);
        const localized = strings[child];
        if (typeof localized === "string" && localized.trim()) pieces.push(localized.trim());
      } else {
        visit(child, depth + 1);
      }
    }
  }

  visit(material);
  return pieces.join(" ");
}

function upgradeKindsForMaterial(material, strings = {}) {
  const kinds = new Set();
  if (!isRecord(material)) return kinds;

  const id = normalizeMaterialId(materialIdOf(material));
  const semantic = normalizeMaterialId(materialSemanticText(material, strings));
  const abilityMaterial = id.startsWith("abilitymaterial") || semantic.includes("abilitymaterial");
  if (!abilityMaterial) return kinds;

  if (semantic.includes("omega")) kinds.add("omega");
  if (semantic.includes("zeta")) kinds.add("zeta");
  if (semantic.includes("omicron")) kinds.add("omicron");
  return kinds;
}

function buildMaterialKindMap(materials, strings = {}) {
  const map = new Map();
  for (const material of materials) {
    if (!isRecord(material)) continue;
    const id = materialIdOf(material);
    if (!id) continue;
    const kinds = upgradeKindsForMaterial(material, strings);
    if (kinds.size) map.set(id, kinds);
  }
  return map;
}

function upgradeKindsForRecipe(recipe, materialKinds = new Map()) {
  const kinds = new Set();
  if (!isRecord(recipe)) return kinds;

  for (const ingredientId of recipeIngredientIds(recipe)) {
    const resolved = materialKinds.get(ingredientId);
    if (!resolved) continue;
    for (const kind of resolved) kinds.add(kind);
  }

  // Legacy game-data releases exposed semantic material ids directly in the
  // recipe. Keep that path so older snapshots remain readable.
  const compact = normalizeMaterialId(JSON.stringify(recipe));
  if (compact.includes("abilitymatomega") || compact.includes("abilitymaterialomega")) kinds.add("omega");
  if (compact.includes("abilitymatzeta") || compact.includes("abilitymaterialzeta")) kinds.add("zeta");
  if (compact.includes("abilitymatomicron") || compact.includes("abilitymaterialomicron")) kinds.add("omicron");

  // Exceptional Zeta/Omicron recipes often carry semantic recipe ids. Omega
  // recipes generally do not, which is why resolving material.json is required.
  const recipeId = String(recipe.id || recipe.recipeId || recipe.baseId || "").toUpperCase();
  if (/(?:^|_)ZETA(?:_|$)/.test(recipeId)) kinds.add("zeta");
  if (/(?:^|_)OMICRON(?:_|$)/.test(recipeId)) kinds.add("omicron");

  return kinds;
}

function recipeIdOf(value) {
  if (!isRecord(value)) return "";
  return String(value.id || value.recipeId || value.baseId || "").trim();
}

function prepareRecipes(recipes, materialKinds = new Map()) {
  const recipeKinds = new Map();
  const prepared = recipes.map((recipe) => {
    if (!isRecord(recipe)) return recipe;
    const kinds = upgradeKindsForRecipe(recipe, materialKinds);
    const id = recipeIdOf(recipe);
    if (id) recipeKinds.set(id, kinds);
    if (!kinds.size) return recipe;
    return { ...recipe, gatewayUpgradeMaterials: [...kinds] };
  });
  return { prepared, recipeKinds };
}

function tierRecipeId(tier) {
  if (!isRecord(tier)) return "";
  if (typeof tier.recipeId === "string") return tier.recipeId;
  if (typeof tier.recipeReference === "string") return tier.recipeReference;
  if (isRecord(tier.recipe)) return String(tier.recipe.id || tier.recipe.recipeId || "");
  return "";
}

function prepareSkillForRosterSemantics(skill, recipeKinds) {
  if (!isRecord(skill)) return skill;

  // Raw Comlink player skill.tier is two below the displayed ability level.
  // server.js already compensates with ownedTier + 2. Therefore the gamedata
  // tier array must remain unshifted: index 0 is displayed ability tier 2.
  const sourceTiers = [skill.tier, skill.tierList, skill.tiers].find((value) => Array.isArray(value) && value.length) || [];
  const classified = sourceTiers.map((tier) => {
    if (!isRecord(tier)) return tier;
    const kinds = recipeKinds.get(tierRecipeId(tier)) || new Set();
    return {
      ...tier,
      ...(kinds.has("omega") ? { isOmegaTier: true } : {}),
      ...(kinds.has("zeta") ? { isZetaTier: true } : {}),
      ...(kinds.has("omicron") ? { isOmicronTier: true } : {}),
    };
  });

  if (!classified.length) return skill;
  return {
    ...skill,
    tier: classified,
    tierList: [],
    tiers: [],
  };
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

      const [unitsPayload, skillsPayload, recipesPayload, materialsPayload, statModsPayload, localizationPayload] = await Promise.all([
        fetchJson(fetchImpl, `${baseUrl}/units_gas.json`),
        fetchJson(fetchImpl, `${baseUrl}/skill.json`),
        fetchJson(fetchImpl, `${baseUrl}/recipe.json`),
        fetchJson(fetchImpl, `${baseUrl}/material.json`),
        fetchJson(fetchImpl, `${baseUrl}/statMod.json`),
        fetchBrotliJson(fetchImpl, `${baseUrl}/Loc_ENG_US.txt.json.br`),
      ]);

      const units = collectionArray(unitsPayload);
      const rawSkills = collectionArray(skillsPayload);
      const rawRecipes = collectionArray(recipesPayload);
      const materials = collectionArray(materialsPayload);
      const statMods = collectionArray(statModsPayload);
      const strings = localizationMap(localizationPayload);
      const materialKinds = buildMaterialKindMap(materials, strings);
      const { prepared: recipes, recipeKinds } = prepareRecipes(rawRecipes, materialKinds);
      const skills = rawSkills.map((skill) => prepareSkillForRosterSemantics(skill, recipeKinds));
      const upgradeRecipeCounts = { omega: 0, zeta: 0, omicron: 0 };
      for (const kinds of recipeKinds.values()) {
        for (const kind of kinds) {
          if (Object.prototype.hasOwnProperty.call(upgradeRecipeCounts, kind)) upgradeRecipeCounts[kind] += 1;
        }
      }

      if (!units.length) throw new Error("GitHub gamedata units_gas.json contained no player-obtainable units");
      if (!skills.length) throw new Error("GitHub gamedata skill.json contained no skills");
      if (!recipes.length) throw new Error("GitHub gamedata recipe.json contained no recipes");
      if (!materials.length) throw new Error("GitHub gamedata material.json contained no materials");

      cached = {
        versionKey,
        gameVersion: String(versions.gameVersion || unitsPayload.version || ""),
        localeVersion: String(versions.localeVersion || localizationPayload.version || ""),
        assetVersion: versions.assetVersion == null ? "" : String(versions.assetVersion),
        units,
        skills,
        recipes,
        materials,
        statMods,
        strings,
        loadedAt: new Date(now).toISOString(),
        expiresAt: now + cacheMs,
      };

      console.log(
        `[gateway] GitHub gamedata ready version=${cached.gameVersion} units=${units.length} skills=${skills.length} recipes=${recipes.length} ` +
        `materials=${materials.length} classifiedAbilityMaterials=${materialKinds.size} ` +
        `upgradeRecipes=omega:${upgradeRecipeCounts.omega}/zeta:${upgradeRecipeCounts.zeta}/omicron:${upgradeRecipeCounts.omicron} ` +
        `statMods=${statMods.length} strings=${Object.keys(strings).length} assetVersion=${cached.assetVersion}`
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
            material: gameData.materials,
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
      const materialCount = Array.isArray(normalized?.material) ? normalized.material.length : 0;
      console.log(`[gateway] normalized fallback Comlink /data collections (units=${unitCount}, skills=${skillCount}, recipes=${recipeCount}, materials=${materialCount})`);
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
  buildMaterialKindMap,
  collectionArray,
  createProductionFetch,
  createStaticGameDataLoader,
  ensureFlag,
  fetchAe2AssetWithFallback,
  localizationMap,
  materialSemanticText,
  normalizeAe2AssetName,
  normalizeGameData,
  normalizeMaterialId,
  prepareRecipes,
  prepareSkillForRosterSemantics,
  recipeIngredientIds,
  sameService,
  upgradeKindsForMaterial,
  upgradeKindsForRecipe,
};
