"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  enrichAffixAbilityText,
  normalizeDatacrons,
  observeGameData,
  observeLocalization,
  summarizeDatacrons,
  textContextStatus,
} = require("../datacron-intelligence");

test("normalizes only public Comlink datacron instance fields without inventing bonus descriptions", () => {
  const datacrons = normalizeDatacrons([{
    id: "DATACRON-GUID-1",
    setId: 33,
    templateId: "datacron_set_33_base",
    tag: ["alignment_dark"],
    locked: true,
    rerollIndex: 2,
    rerollCount: 4,
    affix: [
      {
        tag: ["alignment_dark"],
        targetRule: "targetrule_darkside",
        abilityId: "",
        statType: 55,
        statValue: "25000000",
        requiredUnitTier: 2,
        requiredRelicTier: 1,
      },
      {
        tag: [],
        targetRule: "",
        abilityId: "",
        statType: 48,
        statValue: "15000000",
        requiredUnitTier: 2,
        requiredRelicTier: 1,
      },
      {
        tag: ["alignment_dark"],
        targetRule: "targetrule_darkside",
        abilityId: "datacron_darkside_bonus_001",
        statType: 0,
        statValue: "0",
        requiredUnitTier: 2,
        requiredRelicTier: 1,
      },
    ],
  }]);

  assert.equal(datacrons.length, 1);
  assert.equal(datacrons[0].id, "DATACRON-GUID-1");
  assert.equal(datacrons[0].setId, 33);
  assert.equal(datacrons[0].templateId, "datacron_set_33_base");
  assert.equal(datacrons[0].level, 3);
  assert.equal(datacrons[0].locked, true);
  assert.equal(datacrons[0].rerollCount, 4);
  assert.deepEqual(datacrons[0].tags, ["alignment_dark"]);
  assert.equal(datacrons[0].affixes[0].tier, 1);
  assert.equal(datacrons[0].affixes[0].statType, 55);
  assert.equal(datacrons[0].affixes[0].statValue, 25000000);
  assert.equal(datacrons[0].affixes[2].tier, 3);
  assert.equal(datacrons[0].affixes[2].abilityId, "datacron_darkside_bonus_001");
  assert.equal(datacrons[0].affixes[2].targetRule, "targetrule_darkside");
  assert.equal(datacrons[0].affixes[2].requiredRelicTier, 1);
  assert.equal(Object.hasOwn(datacrons[0].affixes[2], "abilityDescription"), false);
  assert.equal(datacrons[0].affixes[2].abilityTextResolved, false);
});

test("observed gameData ability and localization resolve official datacron ability name and description", () => {
  const gameStatus = observeGameData({
    data: {
      ability: [{
        id: "DC_ABILITY_1",
        nameKey: "DC_ABILITY_1_NAME",
        descKey: "DC_ABILITY_1_DESC",
      }],
    },
  });
  const localizationStatus = observeLocalization({
    ENG_US: {
      DC_ABILITY_1_NAME: "Calculated Risk",
      DC_ABILITY_1_DESC: "At the start of battle, eligible allies gain a bonus.",
    },
  });
  assert.equal(gameStatus.observed, true);
  assert.equal(gameStatus.abilities, 1);
  assert.equal(localizationStatus.observed, true);
  assert.ok(localizationStatus.strings >= 2);

  const datacrons = normalizeDatacrons([{
    id: "DC1",
    setId: 33,
    affix: [{ abilityId: "DC_ABILITY_1", targetRule: "target_dark" }],
  }]);
  const affix = datacrons[0].affixes[0];
  assert.equal(affix.abilityId, "DC_ABILITY_1");
  assert.equal(affix.abilityNameKey, "DC_ABILITY_1_NAME");
  assert.equal(affix.abilityDescKey, "DC_ABILITY_1_DESC");
  assert.equal(affix.abilityName, "Calculated Risk");
  assert.equal(affix.abilityDescription, "At the start of battle, eligible allies gain a bonus.");
  assert.equal(affix.abilityTextResolved, true);

  const summary = summarizeDatacrons(datacrons);
  assert.equal(summary.abilityAffixes, 1);
  assert.equal(summary.resolvedAbilityAffixes, 1);
  assert.deepEqual(textContextStatus(), { abilities: 1, strings: localizationStatus.strings });
});

test("missing ability definition remains raw and unresolved rather than receiving guessed prose", () => {
  const affix = enrichAffixAbilityText({ abilityId: "UNKNOWN_DC_ABILITY", tier: 9 }, new Map(), new Map());
  assert.equal(affix.abilityId, "UNKNOWN_DC_ABILITY");
  assert.equal(affix.abilityTextResolved, false);
  assert.equal(Object.hasOwn(affix, "abilityName"), false);
  assert.equal(Object.hasOwn(affix, "abilityDescription"), false);
});

test("summarizes owned datacron progression from unlocked affix count", () => {
  const datacrons = normalizeDatacrons([
    { id: "L3", setId: 33, affix: [{}, {}, { abilityId: "A3" }] },
    { id: "L6", setId: 33, rerollCount: 1, affix: [{}, {}, {}, {}, {}, { abilityId: "A6" }] },
    { id: "L9", setId: 32, locked: true, affix: [{}, {}, {}, {}, {}, {}, {}, {}, { abilityId: "A9" }] },
  ]);
  const summary = summarizeDatacrons(datacrons);

  assert.equal(summary.count, 3);
  assert.equal(summary.maxLevel, 9);
  assert.equal(summary.level3Plus, 3);
  assert.equal(summary.level6Plus, 2);
  assert.equal(summary.level9Plus, 1);
  assert.equal(summary.locked, 1);
  assert.equal(summary.rerolled, 1);
  assert.equal(summary.abilityAffixes, 3);
  assert.equal(summary.resolvedAbilityAffixes >= 0, true);
});

test("returns null when the upstream player payload does not expose a datacron collection", () => {
  assert.equal(normalizeDatacrons(undefined), null);
  assert.equal(normalizeDatacrons({}), null);
});
