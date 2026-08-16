"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createGuildService, richRoster } = require("../guild-service");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function rawPlayer({ playerId, allyCode, baseId, guildId = "guild-rich" }) {
  return {
    playerId,
    allyCode,
    name: playerId,
    guildId,
    rosterUnit: [{
      id: `${playerId}-unit`,
      definitionId: `${baseId}:SEVEN_STAR`,
      currentRarity: 7,
      currentLevel: 85,
      currentTier: 13,
      relic: { currentTier: 9 },
      skill: [{ id: `${baseId}_BASIC`, tier: 7 }],
      equipment: [{ equipmentId: "EQUIPMENT_1", slot: 0 }],
      equippedStatMod: [{ id: `${playerId}-mod-1`, definitionId: "MOD_A", level: 15, tier: 5 }],
      purchasedAbilityId: [`${baseId}_ULTIMATE`],
    }],
  };
}

function calculatedPlayer(raw, power, speed) {
  return {
    ...raw,
    rosterUnit: raw.rosterUnit.map((unit) => ({
      ...unit,
      gp: power,
      speed,
      combatType: 1,
      stats: { speed, health: 100000 },
    })),
    characterGalacticPower: power,
    shipGalacticPower: 0,
  };
}

test("rich roster preserves raw progression while taking GP/stats from calculation", () => {
  const raw = rawPlayer({ playerId: "p1", allyCode: "123456789", baseId: "UNIT_A" });
  const calculated = calculatedPlayer(raw, 34567, 321);
  const unit = richRoster(raw, calculated)[0];

  assert.equal(unit.id, "p1-unit");
  assert.equal(unit.baseId, "UNIT_A");
  assert.equal(unit.stars, 7);
  assert.equal(unit.level, 85);
  assert.equal(unit.gear, 13);
  assert.equal(unit.relic, 7);
  assert.equal(unit.power, 34567);
  assert.equal(unit.speed, 321);
  assert.equal(unit.unitType, "Character");
  assert.deepEqual(unit.skills, [{ id: "UNIT_A_BASIC", tier: 7 }]);
  assert.deepEqual(unit.equipment, [{ equipmentId: "EQUIPMENT_1", slot: 0 }]);
  assert.deepEqual(unit.equippedStatMods, [{ id: "p1-mod-1", definitionId: "MOD_A", level: 15, tier: 5 }]);
  assert.deepEqual(unit.purchasedAbilityIds, ["UNIT_A_ULTIMATE"]);
  assert.deepEqual(unit.calculatedStats, { speed: 321, health: 100000 });
});

test("rich Guild hydration performs one Stats batch for all hydrated players", async () => {
  const seed = rawPlayer({ playerId: "p1", allyCode: "123456789", baseId: "UNIT_A" });
  const second = rawPlayer({ playerId: "p2", allyCode: "222222222", baseId: "UNIT_B" });
  let statsCalls = 0;
  let statsBatchSize = 0;
  const urls = [];

  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    urls.push(parsed.href);
    if (parsed.hostname === "stats.example" && parsed.pathname === "/api") {
      statsCalls += 1;
      const players = JSON.parse(options.body);
      statsBatchSize = players.length;
      return jsonResponse(players.map((player, index) => calculatedPlayer(player, 30000 + index * 1000, 300 + index)));
    }
    if (parsed.pathname === "/player") {
      const body = JSON.parse(options.body);
      if (body.payload.allyCode) return jsonResponse([seed]);
      if (body.payload.playerId === "p2") return jsonResponse([second]);
      return jsonResponse([seed]);
    }
    if (parsed.pathname === "/guild") {
      const body = JSON.parse(options.body);
      assert.equal(body.payload.includeRecentGuildActivityInfo, true);
      return jsonResponse({ guild: {
        profile: { id: "guild-rich", name: "Rich Guild", memberCount: 2, guildGalacticPower: "20000000" },
        member: [
          { playerId: "p1", playerName: "p1", galacticPower: "10000000", memberLevel: 3 },
          { playerId: "p2", playerName: "p2", galacticPower: "10000000", memberLevel: 2 },
        ],
        recentRaidResult: [{ raidId: "order66" }],
      }});
    }
    return jsonResponse({ error: "unexpected" }, 500);
  };

  const service = createGuildService({
    comlinkUrl: "https://comlink.example",
    statsUrl: "https://stats.example",
    requestTimeoutMs: 5000,
    guildCacheMs: 60000,
    guildMemberCacheMs: 60000,
    guildConcurrency: 5,
  }, { fetch: fetchImpl, now: () => 1000 });

  const result = await service.loadByAllyCode("123456789", { includeActivity: true });
  assert.equal(statsCalls, 1);
  assert.equal(statsBatchSize, 2);
  assert.equal(result.rosterDetail, "rich");
  assert.equal(result.calculation.requested, 2);
  assert.equal(result.calculation.calculated, 2);
  assert.equal(result.calculation.failed, 0);
  assert.equal(result.calculation.complete, true);
  assert.equal(result.members[0].units[0].power, 30000);
  assert.equal(result.members[1].units[0].power, 31000);
  assert.equal(result.members[0].units[0].skills[0].tier, 7);
  assert.equal(urls.filter((value) => value === "https://stats.example/api").length, 1);
});

test("normal Guild hydration remains compact and never calls Stats", async () => {
  const seed = rawPlayer({ playerId: "p1", allyCode: "123456789", baseId: "UNIT_A" });
  let statsCalls = 0;
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.hostname === "stats.example") {
      statsCalls += 1;
      return jsonResponse([]);
    }
    if (parsed.pathname === "/player") return jsonResponse([seed]);
    if (parsed.pathname === "/guild") return jsonResponse({ guild: {
      profile: { id: "guild-rich", name: "Rich Guild", memberCount: 1 },
      member: [{ playerId: "p1", playerName: "p1", galacticPower: "10000000" }],
    }});
    return jsonResponse({}, 500);
  };

  const service = createGuildService({
    comlinkUrl: "https://comlink.example",
    statsUrl: "https://stats.example",
    requestTimeoutMs: 5000,
    guildCacheMs: 60000,
    guildMemberCacheMs: 60000,
    guildConcurrency: 5,
  }, { fetch: fetchImpl, now: () => 1000 });

  const result = await service.loadByAllyCode("123456789");
  assert.equal(statsCalls, 0);
  assert.equal(result.rosterDetail, "compact");
  assert.deepEqual(Object.keys(result.members[0].units[0]).sort(), ["baseId", "gear", "relic", "stars"]);
});

test("Stats failure keeps raw rich roster and reports incomplete calculation", async () => {
  const seed = rawPlayer({ playerId: "p1", allyCode: "123456789", baseId: "UNIT_A" });
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.hostname === "stats.example") return jsonResponse({ error: "down" }, 503);
    if (parsed.pathname === "/player") return jsonResponse([seed]);
    if (parsed.pathname === "/guild") return jsonResponse({ guild: {
      profile: { id: "guild-rich", name: "Rich Guild", memberCount: 1 },
      member: [{ playerId: "p1", playerName: "p1", galacticPower: "10000000", memberLevel: 3 }],
    }});
    return jsonResponse({}, 500);
  };

  const service = createGuildService({
    comlinkUrl: "https://comlink.example",
    statsUrl: "https://stats.example",
    requestTimeoutMs: 5000,
    guildCacheMs: 60000,
    guildMemberCacheMs: 60000,
    guildConcurrency: 5,
  }, { fetch: fetchImpl, now: () => 1000 });

  const result = await service.loadByAllyCode("123456789", { includeActivity: true });
  assert.equal(result.hydration.complete, true, "Comlink roster hydration remains complete");
  assert.equal(result.calculation.complete, false);
  assert.equal(result.calculation.calculated, 0);
  assert.equal(result.calculation.failed, 1);
  assert.match(result.calculation.error, /SWGOH Stats/);
  assert.equal(result.members[0].rosterAvailable, true);
  assert.equal(result.members[0].units[0].level, 85);
  assert.equal(result.members[0].units[0].power, 0);
  assert.equal(result.members[0].units[0].equippedStatMods.length, 1);
});
