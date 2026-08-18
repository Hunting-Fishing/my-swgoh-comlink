"use strict";

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

function timestamp(value) {
  const number = finiteOrNull(value);
  if (number === null || number <= 0) return null;
  const milliseconds = number < 10_000_000_000 ? number * 1000 : number;
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function normalizedCategories(rule = {}) {
  const source = asArray(rule?.category?.category)
    .concat(asArray(rule?.category?.categoryId).map((categoryId) => ({ categoryId, exclude: false })))
    .concat(asArray(rule?.requiredCategory?.category))
    .concat(asArray(rule?.requiredCategory?.categoryId).map((categoryId) => ({ categoryId, exclude: false })));
  const seen = new Set();
  const output = [];
  for (const entry of source) {
    const categoryId = typeof entry === "string" ? clean(entry) : clean(entry?.categoryId || entry?.id);
    if (!categoryId) continue;
    const exclude = typeof entry === "object" && entry?.exclude === true;
    const key = `${exclude ? "-" : "+"}${categoryId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(Object.freeze({ categoryId, exclude }));
  }
  return Object.freeze(output);
}

function targetingRuleSummary(rule = {}) {
  if (!isRecord(rule)) return null;
  const id = clean(rule.id);
  if (!id) return null;
  return Object.freeze({
    id,
    battleSide: finiteOrNull(rule.battleSide),
    unitSelect: finiteOrNull(rule.unitSelect),
    combatTypes: Object.freeze(asArray(rule.unitClass).map(Number).filter(Number.isFinite)),
    forceAlignments: Object.freeze(asArray(rule.forceAlignment).map(Number).filter(Number.isFinite)),
    categories: normalizedCategories(rule),
    excludeSelf: rule.excludeSelf === true,
    excludeSelectedTarget: rule.excludeSelectedTarget === true,
  });
}

function setSummary(set = {}, strings = new Map()) {
  if (!isRecord(set)) return null;
  const id = finiteOrNull(set.id);
  if (id === null) return null;
  const displayNameKey = clean(set.displayName);
  const localizedName = displayNameKey && strings instanceof Map ? clean(strings.get(displayNameKey)) : "";
  const tiers = asArray(set.tier).map((tier) => Object.freeze({
    id: finiteOrNull(tier?.id),
    scopeIdentifier: finiteOrNull(tier?.scopeIdentifier),
  }));
  return Object.freeze({
    id,
    displayNameKey,
    displayName: localizedName || displayNameKey || `Datacron Set ${id}`,
    expirationTime: timestamp(set.expirationTimeMs),
    icon: clean(set.icon),
    maxTier: tiers.reduce((max, tier) => Math.max(max, Number(tier.id) || 0), 0),
    tiers: Object.freeze(tiers),
  });
}

function affixEntries(templateSets = []) {
  const output = [];
  for (const templateSet of asArray(templateSets)) {
    if (!isRecord(templateSet)) continue;
    const templateSetId = clean(templateSet.id);
    for (const affix of asArray(templateSet.affix)) {
      if (!isRecord(affix)) continue;
      output.push(Object.freeze({
        templateSetId,
        tags: Object.freeze(asArray(affix.tag).map((tag) => typeof tag === "string" ? clean(tag) : clean(tag?.id || tag?.tag)).filter(Boolean)),
        abilityId: clean(affix.abilityId),
        targetRule: clean(affix.targetRule),
        statType: finiteOrNull(affix.statType),
        statValueMin: finiteOrNull(affix.statValueMin),
        statValueMax: finiteOrNull(affix.statValueMax),
        minTier: finiteOrNull(affix.minTier),
        maxTier: finiteOrNull(affix.maxTier),
        scopeIcon: clean(affix.scopeIcon),
      }));
    }
  }
  return Object.freeze(output);
}

function makeCatalog({ sets = [], templates = [], affixTemplateSets = [], targetingRules = [], strings = new Map() } = {}) {
  const setMap = new Map();
  for (const set of asArray(sets)) {
    const normalized = setSummary(set, strings);
    if (normalized) setMap.set(String(normalized.id), normalized);
  }

  const templateMap = new Map();
  for (const template of asArray(templates)) {
    if (!isRecord(template)) continue;
    const id = clean(template.id);
    if (id) templateMap.set(id, template);
  }

  const targetingMap = new Map();
  for (const rule of asArray(targetingRules)) {
    const normalized = targetingRuleSummary(rule);
    if (normalized) targetingMap.set(normalized.id, normalized);
  }

  const affixes = affixEntries(affixTemplateSets);
  const abilityAffixMap = new Map();
  const statAffixMap = new Map();
  for (const affix of affixes) {
    if (affix.abilityId) {
      if (!abilityAffixMap.has(affix.abilityId)) abilityAffixMap.set(affix.abilityId, []);
      abilityAffixMap.get(affix.abilityId).push(affix);
    }
    if (affix.statType !== null) {
      const key = `${affix.statType}|${affix.statValueMin ?? ""}|${affix.statValueMax ?? ""}`;
      if (!statAffixMap.has(key)) statAffixMap.set(key, []);
      statAffixMap.get(key).push(affix);
    }
  }

  return Object.freeze({ setMap, templateMap, targetingMap, affixes, abilityAffixMap, statAffixMap });
}

function bestAffixMatch(raw = {}, catalog) {
  if (!catalog) return null;
  const abilityId = clean(raw.abilityId);
  const targetRule = clean(raw.targetRule);
  const statType = finiteOrNull(raw.statType);
  const statValue = finiteOrNull(raw.statValue);
  const tags = new Set(asArray(raw.tags || raw.tag).map(clean).filter(Boolean));
  let candidates = abilityId ? asArray(catalog.abilityAffixMap?.get(abilityId)) : [];
  if (!candidates.length && statType !== null) {
    candidates = catalog.affixes?.filter((entry) => entry.statType === statType) || [];
  }
  if (!candidates.length) return null;

  const scored = candidates.map((candidate) => {
    let score = 0;
    if (abilityId && candidate.abilityId === abilityId) score += 100;
    if (targetRule && candidate.targetRule === targetRule) score += 30;
    if (statType !== null && candidate.statType === statType) score += 20;
    if (statValue !== null && candidate.statValueMin !== null && candidate.statValueMax !== null && statValue >= candidate.statValueMin && statValue <= candidate.statValueMax) score += 20;
    for (const tag of candidate.tags) if (tags.has(tag)) score += 4;
    return { candidate, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0]?.score > 0 ? scored[0].candidate : null;
}

function enrichAffix(raw = {}, catalog) {
  const match = bestAffixMatch(raw, catalog);
  const targetRuleId = clean(raw.targetRule || match?.targetRule);
  const targeting = targetRuleId ? catalog?.targetingMap?.get(targetRuleId) || null : null;
  return Object.freeze({
    ...raw,
    catalog: Object.freeze({
      matched: Boolean(match),
      templateSetId: clean(match?.templateSetId),
      scopeIcon: clean(match?.scopeIcon),
      targetRule: targeting,
      abilityDescriptionResolved: false,
    }),
  });
}

function enrichDatacron(raw = {}, catalog) {
  const setId = clean(raw.setId);
  const templateId = clean(raw.templateId);
  const set = setId ? catalog?.setMap?.get(setId) || null : null;
  const template = templateId ? catalog?.templateMap?.get(templateId) || null : null;
  return Object.freeze({
    ...raw,
    set: set || null,
    template: template ? Object.freeze({
      id: templateId,
      setId: finiteOrNull(template.setId),
      level: finiteOrNull(template.level),
      affixTemplateSetId: clean(template.affixTemplateSetId),
      requiredUnitTier: finiteOrNull(template.requiredUnitTier),
      requiredRelicTier: finiteOrNull(template.requiredRelicTier),
    }) : null,
    affixes: Object.freeze(asArray(raw.affixes).map((affix) => enrichAffix(affix, catalog))),
  });
}

module.exports = {
  affixEntries,
  bestAffixMatch,
  enrichAffix,
  enrichDatacron,
  makeCatalog,
  normalizedCategories,
  setSummary,
  targetingRuleSummary,
};
