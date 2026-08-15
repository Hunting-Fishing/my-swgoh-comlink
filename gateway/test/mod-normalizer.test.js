"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  normalizeEquippedMod,
  normalizePlayerMods,
  normalizeStat,
} = require("../mod-normalizer");

function rawStat(unitStatId, displayed, percent = false, rolls = 0) {
  return {
    stat: {
      unitStatId,
      unscaledDecimalValue: String(displayed * (percent ? 1e6 : 1e8)),
    },
    ...(rolls ? { statRolls: rolls } : {}),
  };
}

test("normalizes flat and percent stats from raw Comlink mod scaling", () => {
  const speed = normalizeStat(rawStat(5, 17, false, 4));
  assert.equal(speed.name, "Speed");
  assert.equal(speed.displayValue, 17);
  assert.equal(speed.percent, false);
  assert.equal(speed.rolls, 4);

  const offensePercent = normalizeStat(rawStat(48, 5.88, true));
  assert.equal(offensePercent.name, "Offense");
  assert.equal(offensePercent.displayValue, 5.88);
  assert.equal(offensePercent.percent, true);
});

test("normalizes a five-dot mod including slot set primary and speed secondary", () => {
  const definitions = new Map([["151", { id: "151", slot: 2, setId: "1", rarity: 5 }]]);
  const mod = normalizeEquippedMod({
    id: "mod-five",
    definitionId: "151",
    level: 15,
    tier: 5,
    primaryStat: rawStat(41, 120),
    secondaryStat: [
      rawStat(5, 23, false, 5),
      rawStat(55, 4.2, true, 2),
    ],
  }, definitions);

  assert.equal(mod.pips, 5);
  assert.equal(mod.underSixDot, true);
  assert.equal(mod.sixDot, false);
  assert.equal(mod.slot, 2);
  assert.equal(mod.setId, "1");
  assert.equal(mod.level, 15);
  assert.equal(mod.speedSecondary, 23);
  assert.equal(mod.primaryStat.displayValue, 120);
  assert.equal(mod.secondaryStats[1].displayValue, 4.2);
});

test("keeps all one through six dot equipped mods in player summary", () => {
  const definitions = { data: [1, 2, 3, 4, 5, 6].map((rarity) => ({
    id: `1${rarity}1`,
    slot: 2,
    setId: "1",
    rarity,
  })) };
  const player = {
    rosterUnit: [{
      definitionId: "TESTUNIT:SEVEN_STAR",
      equippedStatMod: [1, 2, 3, 4, 5, 6].map((rarity) => ({
        id: `mod-${rarity}`,
        definitionId: `1${rarity}1`,
        level: 15,
        primaryStat: rawStat(1, 1000),
        secondaryStat: rarity >= 4 ? [rawStat(5, rarity * 4)] : [],
      })),
    }],
  };

  const result = normalizePlayerMods(player, definitions);
  assert.equal(result.units.length, 1);
  assert.equal(result.units[0].mods.length, 6);
  assert.equal(result.summary.totalMods, 6);
  assert.equal(result.summary.underSixDot, 5);
  assert.equal(result.summary.sixDot, 1);
  assert.deepEqual(result.summary.byRarity, { "1": 1, "2": 1, "3": 1, "4": 1, "5": 1, "6": 1 });
  assert.equal(result.summary.speedSecondaryMods, 3);
  assert.equal(result.summary.speed20Plus, 2);
});

test("falls back to the documented definition id encoding when static definition lookup misses", () => {
  const mod = normalizeEquippedMod({
    definitionId: "261",
    level: 12,
    primaryStat: rawStat(28, 4500),
    secondaryStat: [],
  });
  assert.equal(mod.setId, "2");
  assert.equal(mod.rarity, 6);
  assert.equal(mod.slot, 2);
  assert.equal(mod.definitionResolved, false);
});
