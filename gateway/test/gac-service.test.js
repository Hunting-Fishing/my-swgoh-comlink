"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  bracketPlayers,
  createGacService,
  currentGacEvent,
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