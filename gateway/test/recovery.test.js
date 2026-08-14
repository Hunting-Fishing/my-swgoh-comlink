"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { mergePlayer, mergeRoster } = require("../recovery");

test("preserves the full Comlink roster and authoritative GP when stats returns only a subset", () => {
  const raw = {
    name: "Michael",
    allyCode: "732754286",
    galacticPower: 9876543,
    characterGalacticPower: 6123456,
    shipGalacticPower: 3753087,
    rosterUnit: [
      { definitionId: "VADER:SEVEN_STAR", skill: [{ id: "basicskill_VADER", tier: 6 }] },
      { definitionId: "JEDIKNIGHTLUKE:SEVEN_STAR", skill: [{ id: "basicskill_JEDIKNIGHTLUKE", tier: 6 }] },
      { definitionId: "MILLENNIUMFALCON:SEVEN_STAR" },
    ],
  };
  const calculated = {
    name: "Michael",
    galacticPower: 18246,
    characterGalacticPower: 18246,
    shipGalacticPower: 0,
    rosterUnit: [
      { definitionId: "VADER:SEVEN_STAR", gp: 32000, stats: { Speed: 275 } },
    ],
  };

  const merged = mergePlayer(raw, calculated);
  assert.equal(merged.rosterUnit.length, 3);
  assert.equal(merged.galacticPower, 9876543);
  assert.equal(merged.characterGalacticPower, 6123456);
  assert.equal(merged.shipGalacticPower, 3753087);
  assert.equal(merged.rosterUnit[0].gp, 32000);
  assert.equal(merged.rosterUnit[0].stats.Speed, 275);
  assert.equal(merged.rosterUnit[0].skill[0].id, "basicskill_VADER");
  assert.equal(merged.rosterUnit[1].definitionId, "JEDIKNIGHTLUKE:SEVEN_STAR");
  assert.equal(merged.rosterUnit[2].definitionId, "MILLENNIUMFALCON:SEVEN_STAR");
});

test("raw Comlink ownership fields beat empty or stale Stats ownership fields", () => {
  const rawRoster = [{
    definitionId: "C3POLEGENDARY:SEVEN_STAR",
    currentRarity: 7,
    currentLevel: 85,
    currentTier: 13,
    relic: { currentTier: 8 },
    skill: [
      { id: "basicskill_C3POLEGENDARY", tier: 6 },
      { id: "uniqueskill_C3POLEGENDARY01", tier: 7 },
    ],
    equippedStatMod: [{ id: "mod1" }],
    purchasedAbilityId: ["specialability_c3po"],
  }];
  const calculatedRoster = [{
    definitionId: "C3POLEGENDARY:SEVEN_STAR",
    currentRarity: 1,
    currentLevel: 1,
    currentTier: 1,
    relic: {},
    skill: [],
    equippedStatMod: [],
    purchasedAbilityId: [],
    gp: 32000,
    stats: { Speed: 281 },
  }];

  const merged = mergeRoster(rawRoster, calculatedRoster)[0];
  assert.equal(merged.gp, 32000);
  assert.equal(merged.stats.Speed, 281);
  assert.equal(merged.currentRarity, 7);
  assert.equal(merged.currentLevel, 85);
  assert.equal(merged.currentTier, 13);
  assert.deepEqual(merged.relic, { currentTier: 8 });
  assert.equal(merged.skill.length, 2);
  assert.equal(merged.skill[0].tier, 6);
  assert.equal(merged.equippedStatMod.length, 1);
  assert.deepEqual(merged.purchasedAbilityId, ["specialability_c3po"]);
});

test("keeps calculated-only units without duplicating roster matches", () => {
  const rawRoster = [
    { definitionId: "VADER:SEVEN_STAR" },
    { definitionId: "THRAWN:SEVEN_STAR" },
  ];
  const calculatedRoster = [
    { definitionId: "VADER:SEVEN_STAR", gp: 30000 },
    { definitionId: "TESTSHIP:SEVEN_STAR", gp: 40000 },
  ];

  const merged = mergeRoster(rawRoster, calculatedRoster);
  assert.equal(merged.length, 3);
  assert.equal(merged.filter((unit) => String(unit.definitionId).startsWith("VADER")).length, 1);
  assert.equal(merged.find((unit) => String(unit.definitionId).startsWith("VADER")).gp, 30000);
  assert.ok(merged.some((unit) => String(unit.definitionId).startsWith("THRAWN")));
  assert.ok(merged.some((unit) => String(unit.definitionId).startsWith("TESTSHIP")));
});
