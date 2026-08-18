"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  normalizeDatacrons,
  summarizeDatacrons,
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
  assert.equal(Object.hasOwn(datacrons[0].affixes[2], "description"), false);
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
});

test("returns null when the upstream player payload does not expose a datacron collection", () => {
  assert.equal(normalizeDatacrons(undefined), null);
  assert.equal(normalizeDatacrons({}), null);
});
