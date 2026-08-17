"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { compactSkillTiers, durableMember, durableUnit } = require("../guild-sync-page-service");

test("compact skill tiers keep only identity and tier", () => {
  assert.deepEqual(compactSkillTiers({ skills: [
    { id: "leaderskill_GLREY", tier: 8, extra: "DROP" },
    { skillId: "uniqueskill_GLREY01", currentTier: 7 },
    { abilityId: "specialskill_GLREY01", level: 6 },
    { id: "leaderskill_GLREY", tier: 1 },
  ] }), [
    { id: "leaderskill_GLREY", tier: 8 },
    { id: "uniqueskill_GLREY01", tier: 7 },
    { id: "specialskill_GLREY01", tier: 6 },
  ]);
});

test("durable unit preserves progression plus compact skill evidence without heavyweight payloads", () => {
  const projected = durableUnit({
    id: "unit-1", baseId: "GLREY", definitionId: "GLREY:SEVEN_STAR",
    combatType: 1, unitType: "Character", stars: 7, level: 85, gear: 13,
    relic: 9, power: 55555, speed: 610,
    purchasedAbilityIds: ["ultimateability_glrey"],
    skills: [{ id: "leaderskill_GLREY", tier: 8, nested: "MASSIVE-SKILL-SENTINEL" }],
    equipment: [{ id: "MASSIVE-EQUIPMENT-SENTINEL" }],
    equippedStatMods: [{ id: "MASSIVE-MOD-SENTINEL" }],
    calculatedStats: { sentinel: "MASSIVE-STATS-SENTINEL" },
  });

  assert.deepEqual(projected, {
    id: "unit-1", baseId: "GLREY", definitionId: "GLREY:SEVEN_STAR",
    combatType: 1, unitType: "Character", stars: 7, level: 85, gear: 13,
    relic: 9, power: 55555, speed: 610,
    skills: [{ id: "leaderskill_GLREY", tier: 8 }],
    purchasedAbilityIds: ["ultimateability_glrey"],
  });
  const json = JSON.stringify(projected);
  for (const sentinel of ["MASSIVE-SKILL-SENTINEL", "MASSIVE-EQUIPMENT-SENTINEL", "MASSIVE-MOD-SENTINEL", "MASSIVE-STATS-SENTINEL"]) {
    assert.equal(json.includes(sentinel), false);
  }
});

test("durable member keeps authoritative raw GP and compact raw skill tiers", () => {
  const member = durableMember({
    playerId: "player-warm-bacon", allyCode: "732764286", name: "Warm Bacon", level: 85,
    galacticPower: 12655455, characterGalacticPower: 7200000, shipGalacticPower: 5455455,
    rosterUnit: [{
      id: "unit-1", definitionId: "GLREY:SEVEN_STAR", combatType: 1,
      currentRarity: 7, currentLevel: 85, currentTier: 13, relic: { currentTier: 11 },
      purchasedAbilityId: ["ultimateability_glrey"],
      skill: [{ id: "leaderskill_GLREY", tier: 8, nested: "RAW-SKILL-NESTED-SENTINEL" }],
      equipment: [{ id: "RAW-EQUIPMENT-SENTINEL" }],
      equippedStatMod: [{ id: "RAW-MOD-SENTINEL" }],
    }],
  }, {
    playerId: "player-warm-bacon", playerName: "Warm Bacon", playerLevel: 85,
    memberLevel: 3, guildXp: 1000, galacticPower: 12655455, squadPower: 180000,
  }, {
    playerId: "player-warm-bacon", galacticPower: 1, characterGalacticPower: 1, shipGalacticPower: 1,
    rosterUnit: [{ definitionId: "GLREY:SEVEN_STAR", combatType: 1, gp: 55555, speed: 610,
      stats: { sentinel: "CALCULATED-STATS-SENTINEL" } }],
  });

  assert.equal(member.galacticPower, 12655455);
  assert.equal(member.allyCode, "732764286");
  assert.equal(member.units[0].power, 55555);
  assert.equal(member.units[0].speed, 610);
  assert.deepEqual(member.units[0].skills, [{ id: "leaderskill_GLREY", tier: 8 }]);
  assert.deepEqual(member.units[0].purchasedAbilityIds, ["ultimateability_glrey"]);
  const json = JSON.stringify(member);
  for (const sentinel of ["RAW-SKILL-NESTED-SENTINEL", "RAW-EQUIPMENT-SENTINEL", "RAW-MOD-SENTINEL", "CALCULATED-STATS-SENTINEL"]) {
    assert.equal(json.includes(sentinel), false);
  }
});
