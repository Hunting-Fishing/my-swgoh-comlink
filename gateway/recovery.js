"use strict";

const { createGateway, loadConfig } = require("./server");
const { createProductionFetch, sameService } = require("./production");
const { createGuildAwareServer } = require("./guild-service");
const { createGuildSyncPageService } = require("./guild-sync-page-service");
const { createModAwareServer } = require("./mod-service");
const { createGacAwareServer } = require("./gac-service");
const { createVerificationAwareServer } = require("./verification-service");
const { fetchStatsBatched } = require("./stats-batching");

function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function firstText(...values) { for (const value of values) if (typeof value === "string" && value.trim()) return value.trim(); return ""; }
function baseIdOf(unit) { return firstText(unit?.defId, unit?.definitionId, unit?.baseId, unit?.baseID, unit?.id).split(":")[0]; }
function rosterOf(player) { if (!isRecord(player)) return []; for (const key of ["rosterUnit","roster","units","unit"]) if (Array.isArray(player[key]) && player[key].length) return player[key]; return []; }

function mergeUnit(rawUnit, calculatedUnit) {
  if (!isRecord(rawUnit)) return calculatedUnit;
  if (!isRecord(calculatedUnit)) return rawUnit;
  const merged = { ...rawUnit, ...calculatedUnit };
  for (const key of ["skill","skills","equippedStatMod","equippedStatMods","purchasedAbilityId","purchasedAbilityIds","relic","definitionId","defId","currentRarity","currentLevel","currentTier"]) {
    if (rawUnit[key] !== undefined) merged[key] = rawUnit[key];
  }
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
    if (isStatsRequest) { try { rawPayload = JSON.parse(String(options.body || "null")); } catch { rawPayload = null; } }
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
  const gacGateway = createGacAwareServer(modGateway, config, { fetch: fetchImpl });
  createVerificationAwareServer(gacGateway, config, { fetch: fetchImpl }).listen(config.port, "0.0.0.0", () => {
    console.log(`SWGOH live gateway recovery runtime listening on port ${config.port}`);
  });
}

if (require.main === module) start();
module.exports = { baseIdOf, createRosterPreservingFetch, mergePlayer, mergeRoster, mergeStatsPayload, mergeUnit, preserveRawPlayerTotals, rosterOf };