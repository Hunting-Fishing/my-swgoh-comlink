"use strict";

const { createGateway, loadConfig } = require("./server");
const { createProductionFetch, sameService } = require("./production");
const { createGuildAwareServer } = require("./guild-service");
const { createGuildSyncPageService } = require("./guild-sync-page-service");
const { createModAwareServer } = require("./mod-service");
const { createVerificationAwareServer } = require("./verification-service");
const { fetchStatsBatched } = require("./stats-batching");

function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function asArray(value) { return Array.isArray(value) ? value : []; }
function firstText(...values) { for (const value of values) if (typeof value === "string" && value.trim()) return value.trim(); return ""; }
function finiteNumber(...values) { for (const value of values) { const number = Number(value); if (Number.isFinite(number)) return number; } return 0; }
function baseIdOf(unit) { return firstText(unit?.defId, unit?.definitionId, unit?.baseId, unit?.baseID, unit?.id).split(":")[0]; }
function rosterOf(player) { if (!isRecord(player)) return []; for (const key of ["rosterUnit","roster","units","unit"]) if (Array.isArray(player[key]) && player[key].length) return player[key]; return []; }

function ensureFlag(url, flag) {
  const flags = new Set(String(url.searchParams.get("flags") || "").split(",").map((value) => value.trim()).filter(Boolean));
  flags.add(flag);
  url.searchParams.set("flags", [...flags].join(","));
}

function statBucketValue(bucket, names = [], ids = []) {
  if (!isRecord(bucket)) return 0;
  for (const name of names) {
    const direct = finiteNumber(bucket[name], bucket[name?.toLowerCase?.()]);
    if (direct) return direct;
  }
  for (const id of ids) {
    const direct = finiteNumber(bucket[id], bucket[String(id)]);
    if (direct) return direct;
  }
  for (const [key, value] of Object.entries(bucket)) {
    const normalized = String(key).replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (names.some((name) => normalized === String(name).replace(/[^a-z0-9]/gi, "").toLowerCase())) {
      const number = finiteNumber(value);
      if (number) return number;
    }
  }
  return 0;
}

function finalStat(stats, names, ids) {
  if (!isRecord(stats)) return 0;
  const direct = statBucketValue(stats.final, names, ids);
  if (direct) return direct;
  let total = 0;
  for (const key of ["base", "gear", "mods", "crew"]) total += statBucketValue(stats[key], names, ids);
  return total;
}

function calculatedSpeed(unit) {
  const direct = finiteNumber(unit?.speed);
  if (direct > 0) return Math.round(direct > 10_000 ? direct / 10_000 : direct);
  const speed = finalStat(unit?.stats, ["Speed", "UnitStatSpeed"], [5]);
  if (!speed) return 0;
  return Math.round(speed > 10_000 ? speed / 10_000 : speed);
}

function mergeUnit(rawUnit, calculatedUnit) {
  if (!isRecord(rawUnit)) return calculatedUnit;
  if (!isRecord(calculatedUnit)) return rawUnit;
  const merged = { ...rawUnit, ...calculatedUnit };

  // Preserve either current raw game field names or the native/help aliases.
  for (const key of [
    "skill","skills","equipment","equipped","mods","equippedStatMod","equippedStatMods",
    "purchasedAbilityId","purchasedAbilityIds","relic","definitionId","defId",
    "currentRarity","rarity","currentLevel","level","currentTier","gear","combatType"
  ]) {
    if (rawUnit[key] !== undefined) merged[key] = rawUnit[key];
  }
  if (!Array.isArray(merged.skill) && Array.isArray(rawUnit.skills)) merged.skill = rawUnit.skills;
  if (!Array.isArray(merged.skills) && Array.isArray(rawUnit.skill)) merged.skills = rawUnit.skill;
  if (!Array.isArray(merged.equipment) && Array.isArray(rawUnit.equipped)) merged.equipment = rawUnit.equipped;
  if (!Array.isArray(merged.equipped) && Array.isArray(rawUnit.equipment)) merged.equipped = rawUnit.equipment;
  if (!Array.isArray(merged.equippedStatMods) && Array.isArray(rawUnit.mods)) merged.equippedStatMods = rawUnit.mods;
  if (!Array.isArray(merged.mods) && Array.isArray(rawUnit.equippedStatMod)) merged.mods = rawUnit.equippedStatMod;

  const speed = calculatedSpeed(calculatedUnit);
  if (speed > 0) merged.speed = speed;
  return merged;
}

function mergeRoster(rawRoster, calculatedRoster) {
  const calculatedByBaseId = new Map();
  for (const unit of calculatedRoster) { if (!isRecord(unit)) continue; const baseId = baseIdOf(unit); if (baseId && !calculatedByBaseId.has(baseId)) calculatedByBaseId.set(baseId, unit); }
  const seen = new Set();
  const merged = [];
  for (const rawUnit of rawRoster) { if (!isRecord(rawUnit)) continue; const baseId = baseIdOf(rawUnit); if (baseId) seen.add(baseId); merged.push(mergeUnit(rawUnit, baseId ? calculatedByBaseId.get(baseId) : null)); }
  for (const calculatedUnit of calculatedRoster) { if (!isRecord(calculatedUnit)) continue; const baseId = baseIdOf(calculatedUnit); if (baseId && seen.has(baseId)) continue; merged.push(calculatedUnit); }
  return merged;
}

function preserveRawPlayerTotals(merged, rawPlayer) {
  for (const key of ["galacticPower","gp","gpFull","characterGalacticPower","characterGp","gpChar","shipGalacticPower","shipGp","gpShip"]) {
    const value = Number(rawPlayer?.[key]);
    if (Number.isFinite(value) && value > 0) merged[key] = rawPlayer[key];
  }
  return merged;
}

function mergePlayer(rawPlayer, calculatedPlayer) {
  if (!isRecord(rawPlayer)) return calculatedPlayer;
  if (!isRecord(calculatedPlayer)) return rawPlayer;
  const rawRoster = rosterOf(rawPlayer);
  const calculatedRoster = rosterOf(calculatedPlayer);
  const mergedRoster = rawRoster.length ? mergeRoster(rawRoster, calculatedRoster) : calculatedRoster;
  const merged = preserveRawPlayerTotals({ ...rawPlayer, ...calculatedPlayer }, rawPlayer);
  if (mergedRoster.length) {
    merged.rosterUnit = mergedRoster;
    if (Array.isArray(rawPlayer.roster) || Array.isArray(calculatedPlayer.roster)) merged.roster = mergedRoster;
  }
  return merged;
}

function mergeStatsPayload(rawPayload, calculatedPayload) {
  if (Array.isArray(rawPayload)) { const calculatedList = Array.isArray(calculatedPayload) ? calculatedPayload : []; return rawPayload.map((rawPlayer, index) => mergePlayer(rawPlayer, calculatedList[index])); }
  if (isRecord(rawPayload)) return mergePlayer(rawPayload, calculatedPayload);
  return calculatedPayload;
}

function responseWithJson(response, body) {
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-SWGOH-Roster-Preserved", "true");
  return new Response(JSON.stringify(body), { status: response.status, statusText: response.statusText, headers });
}

function createRosterPreservingFetch(config, fetchImpl = globalThis.fetch, env = process.env) {
  const productionFetch = createProductionFetch(config, fetchImpl, env);
  return async function rosterPreservingFetch(input, options = {}) {
    const url = input instanceof URL ? new URL(input.href) : new URL(String(input));
    const method = String(options.method || "GET").toUpperCase();
    const isStatsRequest = method === "POST" && url.pathname === "/api" && sameService(url, config.statsUrl);
    let rawPayload = null;
    if (isStatsRequest) {
      ensureFlag(url, "gameStyle");
      ensureFlag(url, "calcGP");
      try { rawPayload = JSON.parse(String(options.body || "null")); } catch { rawPayload = null; }
    }
    const response = isStatsRequest && Array.isArray(rawPayload) && rawPayload.length > 1
      ? await fetchStatsBatched(productionFetch, url, options, rawPayload, env)
      : await productionFetch(url, options);
    if (!isStatsRequest || !response.ok || rawPayload == null) return response;
    const text = await response.text();
    let calculatedPayload;
    try { calculatedPayload = text ? JSON.parse(text) : null; } catch { return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers }); }
    const mergedPayload = mergeStatsPayload(rawPayload, calculatedPayload);
    const rawPlayers = Array.isArray(rawPayload) ? rawPayload : [rawPayload];
    const calculatedPlayers = Array.isArray(calculatedPayload) ? calculatedPayload : [calculatedPayload];
    const mergedPlayers = Array.isArray(mergedPayload) ? mergedPayload : [mergedPayload];
    const rawCount = rawPlayers.reduce((sum, player) => sum + rosterOf(player).length, 0);
    const calculatedCount = calculatedPlayers.reduce((sum, player) => sum + rosterOf(player).length, 0);
    const mergedCount = mergedPlayers.reduce((sum, player) => sum + rosterOf(player).length, 0);
    const batches = response.headers.get("X-SWGOH-Stats-Batches");
    if (batches) console.log(`[gateway] SWGOH Stats calculated ${rawPlayers.length} players across ${batches} bounded batches`);
    if (rawCount !== calculatedCount) console.warn(`[gateway] SWGOH Stats roster size mismatch raw=${rawCount} calculated=${calculatedCount}; preserving merged=${mergedCount}`);
    else console.log(`[gateway] SWGOH Stats roster preserved raw=${rawCount} calculated=${calculatedCount}`);
    return responseWithJson(response, mergedPayload);
  };
}

function start() {
  const config = loadConfig();
  const fetchImpl = createRosterPreservingFetch(config);
  const baseGateway = createGateway(config, { fetch: fetchImpl });
  const guildGateway = createGuildAwareServer(baseGateway, config, { fetch: fetchImpl });
  const syncPageGateway = createGuildSyncPageService(guildGateway, config, { fetch: fetchImpl });
  const modGateway = createModAwareServer(syncPageGateway, config, { fetch: fetchImpl });
  createVerificationAwareServer(modGateway, config, { fetch: fetchImpl }).listen(config.port, "0.0.0.0", () => {
    console.log(`SWGOH live gateway recovery runtime listening on port ${config.port}`);
  });
}

if (require.main === module) start();
module.exports = {
  baseIdOf,
  calculatedSpeed,
  createRosterPreservingFetch,
  finalStat,
  mergePlayer,
  mergeRoster,
  mergeStatsPayload,
  mergeUnit,
  preserveRawPlayerTotals,
  rosterOf,
  statBucketValue,
};
