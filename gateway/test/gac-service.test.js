"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  bracketIndexHints,
  bracketPlayers,
  createGacService,
  currentGacEvent,
  currentSeasonStatus,
  normalizeLeague,
} = require("../gac-service");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("normalizeLeague accepts SWGOH numeric and text league values", () => {
  assert.equal(normalizeLeague(100), "KYBER");
  assert.equal(normalizeLeague("60"), "CHROMIUM");
  assert.equal(normalizeLeague("bronzium"), "BRONZIUM");
  assert.equal(normalizeLeague("unknown"), "");
});

test("currentGacEvent selects type 10 and builds event instance id", () => {
  const event = currentGacEvent({
    gameEvent: [
      { id: "OTHER", type: 2, instance: [{ id: "A" }] },
      {
        id: "CHAMPIONSHIPS_GRAND_ARENA_GA2_EVENT_SEASON_99",
        type: 10,
        status: 2,
        instance: [{ id: "O1999999999999", startTime: "1999999999999" }],
      },
    ],
  });
  assert.equal(event.id, "CHAMPIONSHIPS_GRAND_ARENA_GA2_EVENT_SEASON_99");
  assert.equal(event.eventInstanceId, "CHAMPIONSHIPS_GRAND_ARENA_GA2_EVENT_SEASON_99:O1999999999999");
});

test("bracketPlayers normalizes public leaderboard player records", () => {
  const players = bracketPlayers({
    player: [
      { playerId: "P1", name: "Warmbacon", score: 101, rank: 10, guildName: "Guild A" },
      { playerId: "P2", name: "Navygators", score: 99, rank: 11, guildName: "Guild B" },
    ],
  });
  assert.equal(players.length, 2);
  assert.equal(players[0].name, "Warmbacon");
  assert.equal(players[1].name, "Navygators");
  assert.equal(players[1].score, 99);
});

test("current season rank produces nearby bracket index hints", () => {
  const player = {
    seasonStatus: [
      { eventInstanceId: "OTHER:O1", rank: 900 },
      { eventInstanceId: "GAC_SEASON_TEST:O123", rank: 9 },
    ],
  };
  const event = { id: "GAC_SEASON_TEST", instanceId: "O123", eventInstanceId: "GAC_SEASON_TEST:O123" };
  assert.equal(currentSeasonStatus(player, event).rank, 9);
  assert.deepEqual(bracketIndexHints(player, event).slice(0, 4), [1, 0, 2, 3]);
});

test("GAC service reads current event and a requested live bracket", async () => {
  const requests = [];
  const fetch = async (url, options) => {
    const pathname = new URL(url).pathname;
    const body = JSON.parse(options.body);
    requests.push({ pathname, body });
    if (pathname === "/getEvents") {
      return jsonResponse({
        gameEvent: [{
          id: "GAC_SEASON_TEST",
          type: 10,
          status: 2,
          instance: [{ id: "O123" }],
        }],
      });
    }
    if (pathname === "/getLeaderboard") {
      return jsonResponse({
        player: [
          { playerId: "P1", name: "Warmbacon", score: 150 },
          { playerId: "P2", name: "Navygators", score: 147 },
        ],
      });
    }
    throw new Error(`Unexpected request ${pathname}`);
  };

  const service = createGacService({
    comlinkUrl: "https://comlink.test",
    requestTimeoutMs: 1000,
  }, { fetch, now: () => 1_800_000_000_000, env: {} });

  const current = await service.loadCurrentEvent();
  assert.equal(current.active, true);
  const bracket = await service.loadBracket("chromium", 42);
  assert.equal(bracket.groupId, "GAC_SEASON_TEST:O123:CHROMIUM:42");
  assert.equal(bracket.players.length, 2);
  assert.equal(requests.filter((request) => request.pathname === "/getEvents").length, 1, "event should be cached");
  assert.deepEqual(requests.at(-1).body.payload, {
    leaderboardType: 4,
    eventInstanceId: "GAC_SEASON_TEST:O123",
    groupId: "GAC_SEASON_TEST:O123:CHROMIUM:42",
  });
});

test("GAC service finds a player's bracket and enriches opponent Ally Codes", async () => {
  const requests = [];
  const fetch = async (url, options) => {
    const pathname = new URL(url).pathname;
    const body = JSON.parse(options.body);
    requests.push({ pathname, body });

    if (pathname === "/player") {
      if (body?.payload?.allyCode === "732764286") {
        return jsonResponse({
          allyCode: "732764286",
          playerId: "P1",
          name: "Warm Bacon",
          playerRating: {
            league: 60,
            division: 15,
            playerSkillRating: { skillRating: 2508 },
          },
          seasonStatus: [{ eventInstanceId: "GAC_SEASON_TEST:O123", rank: 9 }],
        });
      }
      if (body?.payload?.playerId === "P2") {
        return jsonResponse({
          allyCode: "987654321",
          playerId: "P2",
          name: "Navygators",
          playerRating: {
            league: 60,
            division: 15,
            playerSkillRating: { skillRating: 2508 },
          },
        });
      }
      throw new Error(`Unexpected /player request ${JSON.stringify(body)}`);
    }

    if (pathname === "/getEvents") {
      return jsonResponse({
        gameEvent: [{ id: "GAC_SEASON_TEST", type: 10, status: 2, instance: [{ id: "O123" }] }],
      });
    }

    if (pathname === "/getLeaderboard") {
      assert.equal(body.payload.groupId, "GAC_SEASON_TEST:O123:CHROMIUM:1");
      return jsonResponse({
        player: [
          { playerId: "P1", name: "Warm Bacon", score: 150, rank: 9 },
          { playerId: "P2", name: "Navygators", score: 147, rank: 10 },
        ],
      });
    }

    throw new Error(`Unexpected request ${pathname}`);
  };

  const service = createGacService({
    comlinkUrl: "https://comlink.test",
    requestTimeoutMs: 1000,
  }, { fetch, now: () => 1_800_000_000_000, env: { GAC_BRACKET_SCAN_MAX: "128" } });

  const bracket = await service.loadBracketByPlayer("732764286");
  assert.equal(bracket.bracketIndex, 1);
  assert.equal(bracket.lookup.method, "rank-hint");
  assert.equal(bracket.lookup.allyCode, "732764286");
  assert.equal(bracket.players.length, 2);
  assert.equal(bracket.players[0].allyCode, "732764286");
  assert.equal(bracket.opponents.length, 1);
  assert.equal(bracket.opponents[0].name, "Navygators");
  assert.equal(bracket.opponents[0].allyCode, "987654321");
  assert.equal(requests.filter((request) => request.pathname === "/getLeaderboard").length, 1);
});
