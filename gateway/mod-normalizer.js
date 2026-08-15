"use strict";

const FLAT_STAT_IDS = new Set([1, 5, 28, 41, 42]);
const STAT_NAMES = new Map([
  [1, "Health"],
  [5, "Speed"],
  [16, "Critical Damage"],
  [17, "Potency"],
  [18, "Tenacity"],
  [28, "Protection"],
  [41, "Offense"],
  [42, "Defense"],
  [48, "Offense"],
  [49, "Defense"],
  [52, "Accuracy"],
  [53, "Critical Chance"],
  [54, "Critical Avoidance"],
  [55, "Health"],
  [56, "Protection"],
]);

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

function unwrapStat(value) {
  if (!isRecord(value)) return null;
  return isRecord(value.stat) ? value.stat : value;
}

function statDisplayValue(stat) {
  const raw = unwrapStat(stat);
  if (!raw) return 0;
  const statId = finiteNumber(raw.unitStatId, raw.unitStat, raw.statId);
  const unscaled = finiteNumber(raw.unscaledDecimalValue);
  if (unscaled) return unscaled / (FLAT_STAT_IDS.has(statId) ? 1e8 : 1e6);
  const decimal = finiteNumber(raw.statValueDecimal);
  if (decimal) return decimal / 1e4;
  return finiteNumber(raw.value, raw.statValue);
}

function normalizeStat(value) {
  const raw = unwrapStat(value);
  if (!raw) return null;
  const unitStatId = finiteNumber(raw.unitStatId, raw.unitStat, raw.statId);
  if (!unitStatId) return null;
  const percent = !FLAT_STAT_IDS.has(unitStatId);
  const displayValue = statDisplayValue(raw);
  const unscaledDecimalValue = raw.unscaledDecimalValue !== undefined
    ? String(raw.unscaledDecimalValue)
    : "";
  const statValueDecimal = finiteNumber(raw.statValueDecimal);
  const rolls = finiteNumber(value?.statRolls, raw.statRolls, value?.rolls, raw.rolls);
  return {
    unitStatId,
    name: STAT_NAMES.get(unitStatId) || `Stat ${unitStatId}`,
    displayValue: Math.round(displayValue * 10000) / 10000,
    percent,
    ...(unscaledDecimalValue ? { unscaledDecimalValue } : {}),
    ...(statValueDecimal ? { statValueDecimal } : {}),
    ...(rolls ? { rolls } : {}),
  };
}

function definitionFallback(definitionId) {
  const text = String(definitionId || "").trim();
  const match = text.match(/^(\d)(\d)(\d)$/);
  if (!match) return {};
  return {
    setId: match[1],
    rarity: Number(match[2]),
    slot: Number(match[3]) + 1,
  };
}

function makeStatModMap(payload) {
  const list = Array.isArray(payload) ? payload
    : Array.isArray(payload?.data) ? payload.data
      : Array.isArray(payload?.statMod) ? payload.statMod
        : Array.isArray(payload?.statMods) ? payload.statMods
          : [];
  const map = new Map();
  for (const definition of list) {
    if (!isRecord(definition)) continue;
    const id = firstText(definition.id, definition.definitionId, definition.baseId);
    if (id && !map.has(id)) map.set(id, definition);
  }
  return map;
}

function equippedModsOf(unit) {
  const combined = asArray(unit?.equippedStatMod).concat(asArray(unit?.equippedStatMods));
  const seen = new Set();
  const output = [];
  for (const mod of combined) {
    if (!isRecord(mod)) continue;
    const definitionId = firstText(mod.definitionId, mod.defId);
    const key = firstText(mod.id, mod.statModId) || `${definitionId}|${finiteNumber(mod.level)}|${output.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(mod);
  }
  return output;
}

function normalizeEquippedMod(mod, statModMap = new Map()) {
  if (!isRecord(mod)) return null;
  const definitionId = firstText(mod.definitionId, mod.defId);
  const definition = definitionId ? statModMap.get(definitionId) : null;
  const fallback = definitionFallback(definitionId);
  const rarity = finiteNumber(definition?.rarity, mod.rarity, fallback.rarity);
  const slot = finiteNumber(definition?.slot, mod.slot, fallback.slot);
  const setId = firstText(String(definition?.setId || ""), String(mod.setId || ""), String(fallback.setId || ""));
  const primaryStat = normalizeStat(mod.primaryStat);
  const secondaryStats = asArray(mod.secondaryStat)
    .concat(asArray(mod.secondaryStats))
    .map(normalizeStat)
    .filter(Boolean);
  const speedSecondary = secondaryStats.find((stat) => stat.unitStatId === 5)?.displayValue || 0;

  return {
    id: firstText(mod.id, mod.statModId) || definitionId,
    definitionId,
    rarity,
    pips: rarity,
    slot,
    setId,
    level: finiteNumber(mod.level),
    tier: finiteNumber(mod.tier, mod.currentTier),
    sixDot: rarity >= 6,
    underSixDot: rarity > 0 && rarity < 6,
    maxLevel: finiteNumber(mod.level) >= 15,
    speedSecondary: Math.round(speedSecondary * 10000) / 10000,
    primaryStat,
    secondaryStats,
    definitionResolved: Boolean(definition),
  };
}

function normalizePlayerMods(player, statModPayload = []) {
  const statModMap = statModPayload instanceof Map ? statModPayload : makeStatModMap(statModPayload);
  const units = [];
  const summary = {
    totalMods: 0,
    underSixDot: 0,
    sixDot: 0,
    maxLevel: 0,
    speedSecondaryMods: 0,
    speed10Plus: 0,
    speed15Plus: 0,
    speed20Plus: 0,
    speed25Plus: 0,
    byRarity: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0, "6": 0 },
  };

  for (const rosterUnit of rosterOf(player)) {
    if (!isRecord(rosterUnit)) continue;
    const mods = equippedModsOf(rosterUnit)
      .map((mod) => normalizeEquippedMod(mod, statModMap))
      .filter(Boolean);
    if (!mods.length) continue;

    for (const mod of mods) {
      summary.totalMods += 1;
      if (mod.rarity >= 1 && mod.rarity <= 6) summary.byRarity[String(mod.rarity)] += 1;
      if (mod.underSixDot) summary.underSixDot += 1;
      if (mod.sixDot) summary.sixDot += 1;
      if (mod.maxLevel) summary.maxLevel += 1;
      if (mod.speedSecondary > 0) summary.speedSecondaryMods += 1;
      if (mod.speedSecondary >= 10) summary.speed10Plus += 1;
      if (mod.speedSecondary >= 15) summary.speed15Plus += 1;
      if (mod.speedSecondary >= 20) summary.speed20Plus += 1;
      if (mod.speedSecondary >= 25) summary.speed25Plus += 1;
    }

    units.push({
      baseId: baseIdOf(rosterUnit),
      equippedMods: mods.length,
      mods,
    });
  }

  return { units, summary };
}

module.exports = {
  FLAT_STAT_IDS,
  STAT_NAMES,
  definitionFallback,
  equippedModsOf,
  makeStatModMap,
  normalizeEquippedMod,
  normalizePlayerMods,
  normalizeStat,
  statDisplayValue,
};
