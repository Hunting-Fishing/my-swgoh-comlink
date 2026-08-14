"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  equippedModCount,
  gacRating,
  normalizeProfileStats,
  normalizeSeasonStatus,
  publicPlayerSummary,
  purchasedAbilities,
} = require("../player-summary");

const player = {
  rosterUnit: [
    {
      definitionId: "GLREY:SEVEN_STAR",
      equippedStatMod: [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
      purchasedAbilityId: ["ultimateability_glrey"],
    },
    {
      definitionId: "DARTHVADER:SEVEN_STAR",
      equippedStatMod: [{ id: "m4" }, { id: "m5" }],
      purchasedAbilityId: [],
    },
  ],
  playerRating: {
    playerSkillRating: { skillRating: 4123 },
    league: "KYBER",
    division: 2,
  },
  profileStat: [
    { id: "STAT_GP", value: "10000000" },
    { profileStatId: "STAT_ARENA", statValue: 321 },
  ],
  unlockedPlayerTitle: [{ id: "title-1" }, { id: "title-2" }],
  unlockedPlayerPortrait: [{ id: "portrait-1" }],
  selectedPlayerTitle: { id: "title-2" },
  selectedPlayerPortrait: { id: "portrait-1" },
  seasonStatus: [
    { seasonId: "old", league: "AURODIUM", division: 3, seasonPoints: 100, rank: 44, joinTime: "1000", endTime: "2000" },
    { seasonId: "new", league: "KYBER", division: 2, seasonPoints: 900, rank: 12, joinTime: "3000", endTime: "4000" },
  ],
};

test("counts equipped mods from public roster data", () => {
  assert.equal(equippedModCount(player), 5);
});

test("counts purchased special abilities with unit provenance", () => {
  assert.deepEqual(purchasedAbilities(player), [
    { baseId: "GLREY", abilityId: "ultimateability_glrey" },
  ]);
});

test("extracts current GAC skill rating league and division", () => {
  assert.deepEqual(gacRating(player), {
    skillRating: 4123,
    league: "KYBER",
    division: 2,
  });
});

test("preserves public profile statistics", () => {
  assert.deepEqual(normalizeProfileStats(player), [
    { id: "STAT_GP", value: "10000000" },
    { id: "STAT_ARENA", value: 321 },
  ]);
});

test("sorts recent GAC seasons newest first", () => {
  assert.equal(normalizeSeasonStatus(player)[0].seasonId, "new");
});

test("builds summary without inventing private inventory", () => {
  const result = publicPlayerSummary(player);
  assert.equal(result.summary.equippedMods, 5);
  assert.equal(result.summary.purchasedAbilities, 1);
  assert.equal(result.summary.unlockedTitles, 2);
  assert.equal(result.summary.unlockedPortraits, 1);
  assert.equal(result.competitive.gacSkillRating, 4123);
  assert.equal(result.competitive.gacLeague, "KYBER");
  assert.equal(result.competitive.gacDivision, 2);
  assert.equal(result.seasonStatus[0].seasonId, "new");
  assert.deepEqual(result.selectedCosmetics, { titleId: "title-2", portraitId: "portrait-1" });
  assert.equal(Object.prototype.hasOwnProperty.call(result.summary, "materials"), false);
});
