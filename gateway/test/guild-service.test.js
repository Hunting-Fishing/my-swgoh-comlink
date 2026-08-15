"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createGuildService, compactRoster, relicLevel } = require("../guild-service");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("normalizes player-facing relic levels and compact progression", () => {
  assert.equal(relicLevel({ relic: { currentTier: 9 } }), 7);
  assert.deepEqual(compactRoster({ rosterUnit: [{ definitionId: "DARTHVADER:SEVEN_STAR", currentRarity: 7, currentTier: 13, relic: { currentTier: 9 } }] }), [
    { baseId: "DARTHVADER", stars: 7, gear: 13, relic: 7 },
  ]);
});

test("hydrates a guild by playerId, reuses the initiating player, bounds concurrency and caches the snapshot", async () => {
  let now = 1000;
  const calls = [];
  let activePlayers = 0;
  let maxActivePlayers = 0;

  const players = {
    seed: { playerId: "seed", allyCode: "123456789", name: "Seed", guildId: "guild-1", rosterUnit: [{ definitionId: "A:SEVEN_STAR", currentRarity: 7, currentTier: 13, relic: { currentTier: 9 } }] },
    p2: { playerId: "p2", allyCode: "222222222", name: "Two", guildId: "guild-1", rosterUnit: [{ definitionId: "B:SEVEN_STAR", currentRarity: 7, currentTier: 12 }] },
    p3: { playerId: "p3", allyCode: "333333333", name: "Three", guildId: "guild-1", rosterUnit: [{ definitionId: "C:SEVEN_STAR", currentRarity: 6, currentTier: 11 }] },
  };

  const fetchFixture = async (url, options) => {
    const parsed = new URL(url);
    const request = JSON.parse(options.body);
    calls.push({ path: parsed.pathname, payload: request.payload });
    if (parsed.pathname === "/guild") {
      assert.equal(request.payload.includeRecentGuildActivityInfo, false);
      return jsonResponse({ guild: {
        profile: { id: "guild-1", name: "Guild One", memberCount: 3, guildGalacticPower: "123456789" },
        member: [
          { playerId: "seed", playerName: "Seed", galacticPower: "5000000" },
          { playerId: "p2", playerName: "Two", galacticPower: "4000000" },
          { playerId: "p3", playerName: "Three", galacticPower: "3000000" },
        ],
      }});
    }
    if (parsed.pathname === "/player") {
      const playerId = request.payload.playerId;
      if (request.payload.allyCode === "123456789") return jsonResponse([players.seed]);
      activePlayers += 1;
      maxActivePlayers = Math.max(maxActivePlayers, activePlayers);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activePlayers -= 1;
      return jsonResponse([players[playerId]]);
    }
    return jsonResponse({ error: "unexpected" }, 500);
  };

  const service = createGuildService({
    comlinkUrl: "http://comlink.internal:3000",
    comlinkAccessKey: "",
    comlinkSecretKey: "",
    requestTimeoutMs: 1000,
    guildCacheMs: 60000,
    guildMemberCacheMs: 60000,
    guildConcurrency: 2,
  }, { fetch: fetchFixture, now: () => now });

  const first = await service.loadByAllyCode("123456789");
  assert.equal(first.guild.id, "guild-1");
  assert.equal(first.guild.name, "Guild One");
  assert.equal(first.members.length, 3);
  assert.equal(first.hydration.hydrated, 3);
  assert.equal(first.hydration.failed, 0);
  assert.equal(first.hydration.complete, true);
  assert.equal(first.members[0].units[0].relic, 7);
  assert.equal(maxActivePlayers <= 2, true);
  assert.equal(calls.filter((call) => call.path === "/player" && call.payload.playerId === "seed").length, 0, "initiating player must not be fetched twice");
  assert.equal(calls.filter((call) => call.path === "/player").length, 3, "one ally lookup plus two member lookups");

  const callsAfterFirst = calls.length;
  const second = await service.loadByAllyCode("123456789");
  assert.equal(second, first);
  assert.equal(calls.length, callsAfterFirst, "cached guild snapshot should avoid all upstream calls");

  now += 70000;
  await service.loadByAllyCode("123456789");
  assert.equal(calls.length > callsAfterFirst, true, "expired snapshot should refresh");
});

test("returns a partial guild snapshot when one member roster fails", async () => {
  const fetchFixture = async (url, options) => {
    const parsed = new URL(url);
    const request = JSON.parse(options.body);
    if (parsed.pathname === "/guild") return jsonResponse({ guild: {
      profile: { id: "g2", name: "Partial Guild", memberCount: 2 },
      member: [{ playerId: "seed", playerName: "Seed" }, { playerId: "bad", playerName: "Bad" }],
    }});
    if (request.payload.allyCode) return jsonResponse([{ playerId: "seed", allyCode: "987654321", guildId: "g2", rosterUnit: [{ definitionId: "A:SEVEN_STAR", currentRarity: 7 }] }]);
    if (request.payload.playerId === "bad") return jsonResponse({ error: "rate" }, 429);
    return jsonResponse({ error: "unexpected" }, 500);
  };
  const service = createGuildService({
    comlinkUrl: "http://comlink.internal:3000",
    requestTimeoutMs: 1000,
    guildCacheMs: 60000,
    guildMemberCacheMs: 60000,
    guildConcurrency: 2,
  }, { fetch: fetchFixture, now: () => 1000 });
  const body = await service.loadByAllyCode("987654321");
  assert.equal(body.hydration.complete, false);
  assert.equal(body.hydration.hydrated, 1);
  assert.equal(body.hydration.failed, 1);
  assert.equal(body.members.find((member) => member.playerId === "bad").rosterAvailable, false);
});
