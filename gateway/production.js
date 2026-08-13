"use strict";

const { createGateway, loadConfig } = require("./server");
const { createLocalizationAwareFetch } = require("./bootstrap");

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function createProductionFetch(config, fetchImpl = globalThis.fetch) {
  const upstreamFetch = createLocalizationAwareFetch(config, fetchImpl);

  return async function productionFetch(input, options = {}) {
    const response = await upstreamFetch(input, options);
    const url = input instanceof URL ? input : new URL(String(input));
    const method = String(options.method || "GET").toUpperCase();

    if (method !== "POST" || url.pathname !== "/data" || !response.ok) return response;

    try {
      const payload = await response.json();
      const normalized = normalizeGameData(payload);
      const unitCount = Array.isArray(normalized?.units) ? normalized.units.length : 0;
      const skillCount = Array.isArray(normalized?.skill) ? normalized.skill.length : 0;
      console.log(`[gateway] normalized Comlink /data collections (units=${unitCount}, skills=${skillCount})`);
      return jsonResponse(normalized);
    } catch (error) {
      console.warn(`[gateway] could not normalize Comlink /data response: ${error?.message || error}`);
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
  normalizeGameData,
};
