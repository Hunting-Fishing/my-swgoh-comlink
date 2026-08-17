"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { durableMember, durableUnit } = require("../guild-sync-page-service");

test("durable unit preserves progression and ability evidence without heavyweight nested payloads", () => {
  const projected = durableUnit({
    id: "unit-1",
    baseId: "GLREY",
    definitionId: "GLREY:SEVEN_STAR",
    combatType: 1,
    unitType: "Character",
    stars: 7,
    level: 85,
    gear: 13,
    relic: 9,
    power: 55555,
    speed: 610,
    purchasedAbilityIds: ["leaderskill_GLREY", "uniqueskill_GLREY01"],
    skills: [{ id: "MASSIVE-SKILL-SENTINEL", tiers: Array(100).fill("x") }],
    equipment: [{ id: "MASSIVE-EQUIPMENT-SENTINEL", data: "x".repeat(2000) }],
    equippedStatMods: [{ id: "MASSIVE-MOD-SENTINEL", data: "y".repeat(2000) }],
    calculatedStats: { health: 123456, sentinel: "MASSIVE-STATS-SENTINEL" },
  });

  assert.deepEqual(projected, {
    id: "unit-1",
    baseId: "GLREY",
    definitionId: "GLREY:SEVEN_STAR",
    combatType: 1,
    unitType: "Character",
    stars: 7,
    level: 85,
    gear: 13,
    relic: 9,
    power: 55555,
    speed: 610,
    purchasedAbilityIds: ["leaderskill_GLREY", "uniqueskill_GLREY01"],
  });
  const json = JSON.stringify(projected);
  for (const sentinel of ["MASSIVE-SKILL-SENTINEL", "MASSIVE-EQUIPMENT-SENTINEL", "MASSIVE-MOD-SENTINEL", "MASSIVE-STATS-SENTINEL"]) {
    assert.equal(json.includes(sentinel), false, `${sentinel} must not enter durable Guild baseline pages`);
  }
});

test("durable member keeps authoritative raw player GP while retaining calculated unit GP and speed", () => {
  const rawPlayer = {
    playerId: "player-warm-bacon",
    allyCode: "782764286",
    name: "Warm Bacon",
    level: 85,
    galacticPower: 12654861,
    characterGalacticPower: 7200000,
    shipGalacticPower: 5454861,
    rosterUnit: [{
      id: "unit-1",
      definitionId: "GLREY:SEVEN_STAR",
      combatType: 1,
      currentRarity: 7,
      currentLevel: 85,
      currentTier: 13,
      relic: { currentTier: 11 },
      purchasedAbilityId: ["leaderskill_GLREY", "uniqueskill_GLREY01"],
      skill: [{ id: "RAW-SKILL-SENTINEL" }],
      equipment: [{ id: "RAW-EQUIPMENT-SENTINEL" }],
      equippedStatMod: [{ id: "RAW-MOD-SENTINEL" }],
    }],
  };
  const guildMember = {
    playerId: "player-warm-bacon",
    playerName: "Warm Bacon",
    playerLevel: 85,
    memberLevel: 3,
    guildXp: 1000,
    galacticPower: 12654861,
    squadPower: 180000,
    lastActivityTime: "1770000000",
    guildJoinTime: "1700000000",
    memberContribution: [{ type: 2, currentValue: "600" }],
    seasonStatus: [{ seasonId: "S1" }],
  };
  const calculatedPlayer = {
    playerId: "player-warm-bacon",
    galacticPower: 1,
    characterGalacticPower: 1,
    shipGalacticPower: 1,
    rosterUnit: [{
      definitionId: "GLREY:SEVEN_STAR",
      combatType: 1,
      gp: 55555,
      speed: 610,
      stats: { health: 123456, sentinel: "CALCULATED-STATS-SENTINEL" },
    }],
  };

  const member = durableMember(rawPlayer, guildMember, calculatedPlayer);
  assert.equal(member.galacticPower, 12654861);
  assert.equal(member.characterGalacticPower, 7200000);
  assert.equal(member.shipGalacticPower, 5454861);
  assert.equal(member.allyCode, "782764286");
  assert.equal(member.units.length, 1);
  assert.equal(member.units[0].baseId, "GLREY");
  assert.equal(member.units[0].gear, 13);
  assert.equal(member.units[0].relic, 9);
  assert.equal(member.units[0].power, 55555);
  assert.equal(member.units[0].speed, 610);
  assert.deepEqual(member.units[0].purchasedAbilityIds, ["leaderskill_GLREY", "uniqueskill_GLREY01"]);

  const json = JSON.stringify(member);
  for (const sentinel of ["RAW-SKILL-SENTINEL", "RAW-EQUIPMENT-SENTINEL", "RAW-MOD-SENTINEL", "CALCULATED-STATS-SENTINEL"]) {
    assert.equal(json.includes(sentinel), false, `${sentinel} must not enter durable Guild baseline pages`);
  }
  for (const forbiddenKey of ["skills", "equipment", "equippedStatMods", "calculatedStats"]) {
    assert.equal(Object.hasOwn(member.units[0], forbiddenKey), false, `${forbiddenKey} must stay out of durable Guild baseline units`);
  }
});
