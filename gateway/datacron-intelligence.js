"use strict";

let abilityDefinitions = new Map();
let localizationStrings = new Map();

function clean(value) {
  return String(value ?? "").trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerOrNull(value) {
  const number = finiteOrNull(value);
  return Number.isInteger(number) ? number : null;
}

function booleanOrNull(value) {
  if (value === true || value === false) return value;
  if (value === 1 || value === "1" || String(value).toLowerCase() === "true") return true;
  if (value === 0 || value === "0" || String(value).toLowerCase() === "false") return false;
  return null;
}

function normalizedTags(value) {
  return Object.freeze([...new Set(asArray(value)
    .map((entry) => typeof entry === "string" ? clean(entry) : clean(entry?.id || entry?.tag || entry?.name))
    .filter(Boolean))]);
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
  if (!isRecord(payload)) return [];

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
  return [];
}

function makeAbilityMap(values) {
  const map = new Map();
  for (const ability of asArray(values)) {
    if (!isRecord(ability)) continue;
    const id = clean(ability.id || ability.abilityId || ability.baseId);
    if (id && !map.has(id)) map.set(id, ability);
  }
  return map;
}

function directStringMap(value) {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value).filter(([, child]) => typeof child === "string");
  return entries.length ? new Map(entries) : null;
}

function parseLocalization(payload) {
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
    const direct = directStringMap(candidate);
    if (direct?.size) return direct;
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
        const nested = directStringMap(value);
        if (nested?.size) return nested;
      }
    }
  }
  return new Map();
}

function observeGameData(payload) {
  const abilities = findCollection(payload, ["ability", "abilities", "abilityData", "abilityList"]);
  if (!abilities.length) return Object.freeze({ observed: false, abilities: abilityDefinitions.size });
  abilityDefinitions = makeAbilityMap(abilities);
  return Object.freeze({ observed: true, abilities: abilityDefinitions.size });
}

function observeLocalization(payload) {
  const parsed = parseLocalization(payload);
  if (!parsed.size) return Object.freeze({ observed: false, strings: localizationStrings.size });
  localizationStrings = parsed;
  return Object.freeze({ observed: true, strings: localizationStrings.size });
}

function localizedText(strings, key, fallback = "") {
  const lookup = clean(key);
  if (lookup && strings instanceof Map) {
    const value = clean(strings.get(lookup));
    if (value) return value;
  }
  return clean(fallback);
}

function enrichAffixAbilityText(affix = {}, abilityMap = abilityDefinitions, strings = localizationStrings) {
  const abilityId = clean(affix?.abilityId);
  if (!abilityId) return Object.freeze({ ...affix, abilityTextResolved: false });
  const ability = abilityMap instanceof Map ? abilityMap.get(abilityId) : null;
  if (!ability || typeof ability !== "object") {
    return Object.freeze({ ...affix, abilityTextResolved: false });
  }

  const abilityNameKey = clean(ability.nameKey || ability.name_key);
  const abilityDescKey = clean(ability.descKey || ability.descriptionKey || ability.desc_key);
  const abilityName = localizedText(strings, abilityNameKey, ability.name);
  const abilityDescription = localizedText(strings, abilityDescKey, ability.description || ability.desc);
  const abilityTextResolved = Boolean(abilityName || abilityDescription);

  return Object.freeze({
    ...affix,
    abilityNameKey,
    abilityDescKey,
    ...(abilityName ? { abilityName } : {}),
    ...(abilityDescription ? { abilityDescription } : {}),
    abilityTextResolved,
  });
}

function normalizeAffix(raw = {}, index = 0) {
  if (!raw || typeof raw !== "object") return null;
  const tier = index + 1;
  const targetRule = clean(raw.targetRule || raw.targetRuleId || raw.battleTargetingRuleId);
  const abilityId = clean(raw.abilityId || raw.abilityID || raw.ability);
  const statType = integerOrNull(raw.statType ?? raw.stat?.type);
  const statValue = finiteOrNull(raw.statValue ?? raw.stat?.value);
  const requiredUnitTier = integerOrNull(raw.requiredUnitTier ?? raw.unitTierRequirement ?? raw.gearRequirement);
  const requiredRelicTier = integerOrNull(raw.requiredRelicTier ?? raw.relicTierRequirement ?? raw.relicRequirement);
  const tags = normalizedTags(raw.tag || raw.tags);
  const kind = abilityId && statType !== null ? "mixed" : abilityId ? "ability" : statType !== null ? "stat" : "unknown";

  return enrichAffixAbilityText(Object.freeze({
    tier,
    kind,
    tags,
    targetRule,
    abilityId,
    statType,
    statValue,
    requiredUnitTier,
    requiredRelicTier,
  }));
}

function normalizeDatacron(raw = {}) {
  if (!raw || typeof raw !== "object") return null;
  const affixes = asArray(raw.affix || raw.affixes)
    .map((affix, index) => normalizeAffix(affix, index))
    .filter(Boolean);
  const id = clean(raw.id || raw.datacronId || raw.datacronID);
  const setIdValue = raw.setId ?? raw.setID ?? raw.set;
  const setIdNumber = integerOrNull(setIdValue);
  const setId = setIdNumber !== null ? setIdNumber : clean(setIdValue);
  const templateId = clean(raw.templateId || raw.templateID || raw.template);
  const rerollIndex = integerOrNull(raw.rerollIndex);
  const rerollCount = integerOrNull(raw.rerollCount);
  const locked = booleanOrNull(raw.locked);
  const tags = normalizedTags(raw.tag || raw.tags);

  if (!id && setId === "" && !templateId && !affixes.length) return null;

  return Object.freeze({
    id,
    setId,
    templateId,
    tags,
    level: affixes.length,
    locked,
    rerollIndex,
    rerollCount,
    affixes: Object.freeze(affixes),
  });
}

function normalizeDatacrons(value) {
  if (!Array.isArray(value)) return null;
  return Object.freeze(value.map(normalizeDatacron).filter(Boolean));
}

function enrichDatacrons(datacrons, abilityMap = abilityDefinitions, strings = localizationStrings) {
  if (!Array.isArray(datacrons)) return datacrons;
  return Object.freeze(datacrons.map((datacron) => Object.freeze({
    ...datacron,
    affixes: Object.freeze(asArray(datacron?.affixes).map((affix) => enrichAffixAbilityText(affix, abilityMap, strings))),
  })));
}

function summarizeDatacrons(value) {
  const datacrons = asArray(value);
  const affixes = datacrons.flatMap((datacron) => asArray(datacron?.affixes));
  return Object.freeze({
    count: datacrons.length,
    maxLevel: datacrons.reduce((max, datacron) => Math.max(max, Number(datacron?.level) || 0), 0),
    level3Plus: datacrons.filter((datacron) => Number(datacron?.level) >= 3).length,
    level6Plus: datacrons.filter((datacron) => Number(datacron?.level) >= 6).length,
    level9Plus: datacrons.filter((datacron) => Number(datacron?.level) >= 9).length,
    locked: datacrons.filter((datacron) => datacron?.locked === true).length,
    rerolled: datacrons.filter((datacron) => Number(datacron?.rerollCount) > 0).length,
    abilityAffixes: affixes.filter((affix) => Boolean(affix?.abilityId)).length,
    resolvedAbilityAffixes: affixes.filter((affix) => affix?.abilityTextResolved === true).length,
    statAffixes: affixes.filter((affix) => affix?.statType !== null && affix?.statType !== undefined).length,
  });
}

function textContextStatus() {
  return Object.freeze({ abilities: abilityDefinitions.size, strings: localizationStrings.size });
}

module.exports = {
  enrichAffixAbilityText,
  enrichDatacrons,
  normalizeAffix,
  normalizeDatacron,
  normalizeDatacrons,
  observeGameData,
  observeLocalization,
  parseLocalization,
  summarizeDatacrons,
  textContextStatus,
};
