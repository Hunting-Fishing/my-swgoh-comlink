"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createGuildService, guildActivity, guildMemberSummary } = require("../guild-service");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("normalizes the public Guild activity fields needed for first-party history", () => {
  const guild = {
    nextChallengesRefresh: "1770000000",
    recentRaidResult: [{ raidId: "order66", endTime: "1769990000", raidMember: [{ playerId: "p1", memberProgress: "12345" }] }],
    recentTerritoryWarResult: [{ endTime: "1769980000", score: "100", opponentScore: "90" }],
    territoryBattleResult: [{ instanceId: "tb-1", starCount: 31 }],
    profile: {
      raidLaunchConfig: [{ raidId: "order66", autoLaunch: true }],
      guildEventTracker: [{ definitionId: "t05D", completedStars: 31, endTime: "1769970000" }],
    },
  };
  assert.deepEqual(guildActivity(guild), {
    nextChallengesRefresh: "1770000000",
    raidLaunchConfig: [{ raidId: "order66", autoLaunch: true }],
    guildEventTracker: [{ definitionId: "t05D", completedStars: 31, endTime: "1769970000" }],
    recentRaidResult: [{ raidId: "order66", endTime: "1769990000", raidMember: [{ playerId: "p1", memberProgress: "12345" }] }],
    recentTerritoryWarResult: [{ endTime: "1769980000", score: "100", opponentScore: "90" }],
    territoryBattleResult: [{ instanceId: "tb-1", starCount: 31 }],
  });
});

test("member summary preserves rank, activity and contribution history inputs", () => {
  const summary = guildMemberSummary({
    playerId: "p1",
    playerName: "Alpha",
    playerLevel: 85,
    memberLevel: 3,
    guildXp: 15,
    galacticPower: "12000000",
    squadPower: 200000,
    lastActivityTime: "1769999000",
    guildJoinTime: "1700000000",
    playerTitle: "PLAYERTITLE_TEST",
    playerPortrait: "PLAYERPORTRAIT_TEST",
    lifetimeSeasonScore: "123456",
    leagueId: "KYBER",
    memberContribution: [
      { type: 2, currentValue: "600", lifetimeValue: "123456" },
      { type: 1, currentValue: "500", lifetimeValue: "100000" },
    ],
    seasonStatus: [{ seasonId: "S1", league: "KYBER" }],
  });

  assert.equal(summary.memberLevel, 3);
  assert.equal(summary.lastActivityTime, "1769999000");
  assert.equal(summary.guildJoinTime, "1700000000");
  assert.equal(summary.memberContribution.length, 2);
  assert.equal(summary.memberContribution[0].type, 2);
  assert.equal(summary.memberContribution[0].currentValue, "600");
  assert.equal(summary.seasonStatus.length, 1);
});

test("rich Guild activity is opt-in and uses a cache distinct from normal roster reads", async () => {
  let now = 1000;
  const guildCalls = [];
  const players = {
    seed: {
      playerId: "seed",
      allyCode: "123456789",
      name: "Seed",
      guildId: "guild-activity",
      rosterUnit: [{ definitionId: "A:SEVEN_STAR", currentRarity: 7, currentTier: 13, relic: { currentTier: 9 } }],
    },
    p2: {
      playerId: "p2",
      allyCode: "222222222",
      name: "Two",
      guildId: "guild-activity",
      rosterUnit: [{ definitionId: "B:SEVEN_STAR", currentRarity: 7, currentTier: 12 }],
    },
  };

  const fetchFixture = async (url, options) => {
    const parsed = new URL(url);
    const request = JSON.parse(options.body);
    if (parsed.pathname === "/player") {
      if (request.payload.allyCode) return jsonResponse([players.seed]);
      return jsonResponse([players[request.payload.playerId]]);
    }
    if (parsed.pathname === "/guild") {
      const includeActivity = request.payload.includeRecentGuildActivityInfo === true;
      guildCalls.push(includeActivity);
      return jsonResponse({ guild: {
        profile: {
          id: "guild-activity",
          name: "Activity Guild",
          memberCount: 2,
          guildGalacticPower: "20000000",
          ...(includeActivity ? {
            guildEventTracker: [{ definitionId: "t05D", completedStars: 30 }],
            raidLaunchConfig: [{ raidId: "order66" }],
          } : {}),
        },
        member: [
          {
            playerId: "seed",
            playerName: "Seed",
            memberLevel: 3,
            galacticPower: "11000000",
            ...(includeActivity ? { memberContribution: [{ type: 2, currentValue: "600", lifetimeValue: "9000" }] } : {}),
          },
          {
            playerId: "p2",
            playerName: "Two",
            memberLevel: 2,
            galacticPower: "9000000",
            ...(includeActivity ? { memberContribution: [{ type: 2, currentValue: "450", lifetimeValue: "8000" }] } : {}),
          },
        ],
        ...(includeActivity ? {
          nextChallengesRefresh: "1770000000",
          recentRaidResult: [{ raidId: "order66", endTime: "1769990000" }],
          recentTerritoryWarResult: [{ endTime: "1769980000", score: "100" }],
        } : {}),
      }});
    }
    return jsonResponse({ error: "unexpected" }, 500);
  };

  const service = createGuildService({
    comlinkUrl: "http://comlink.internal:3000",
    requestTimeoutMs: 1000,
    guildCacheMs: 60000,
    guildMemberCacheMs: 60000,
    guildConcurrency: 2,
  }, { fetch: fetchFixture, now: () => now });

  const normal = await service.loadByAllyCode("123456789");
  assert.equal(normal.activity, undefined);
  assert.deepEqual(guildCalls, [false]);

  const rich = await service.loadByAllyCode("123456789", { includeActivity: true });
  assert.deepEqual(guildCalls, [false, true], "activity request must not reuse the normal roster cache");
  assert.equal(rich.activity.nextChallengesRefresh, "1770000000");
  assert.equal(rich.activity.recentRaidResult.length, 1);
  assert.equal(rich.activity.recentTerritoryWarResult.length, 1);
  assert.equal(rich.activity.guildEventTracker.length, 1);
  assert.equal(rich.members[0].memberLevel, 3);
  assert.equal(rich.members[0].memberContribution[0].currentValue, "600");
  assert.equal(rich.members[1].memberContribution[0].currentValue, "450");

  const richAgain = await service.loadByAllyCode("123456789", { includeActivity: true });
  assert.equal(richAgain, rich);
  assert.deepEqual(guildCalls, [false, true], "rich snapshot should use its own cache");

  now += 70000;
  await service.loadByAllyCode("123456789", { includeActivity: true });
  assert.deepEqual(guildCalls, [false, true, true]);
});
