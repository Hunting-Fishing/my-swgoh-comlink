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
