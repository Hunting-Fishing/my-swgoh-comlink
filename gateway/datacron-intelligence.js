"use strict";

function clean(value) {
  return String(value ?? "").trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
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

  return Object.freeze({
    tier,
    kind,
    tags,
    targetRule,
    abilityId,
    statType,
    statValue,
    requiredUnitTier,
    requiredRelicTier,
  });
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

function localizedText(strings, key, fallback = "") {
  const lookup = clean(key);
  if (lookup && strings instanceof Map) {
    const value = clean(strings.get(lookup));
    if (value) return value;
  }
  return clean(fallback);
}

function enrichAffixAbilityText(affix = {}, abilityMap = new Map(), strings = new Map()) {
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

function enrichDatacrons(datacrons, abilityMap = new Map(), strings = new Map()) {
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

module.exports = {
  enrichAffixAbilityText,
  enrichDatacrons,
  normalizeAffix,
  normalizeDatacron,
  normalizeDatacrons,
  summarizeDatacrons,
};
