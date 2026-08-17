"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchStatsBatched, isEntityTooLarge } = require("../stats-batching");

test("entity-too-large detection accepts the deployed Stats failure shape", () => {
  assert.equal(isEntityTooLarge(500, "request entity too large"), true);
  assert.equal(isEntityTooLarge(413, "payload rejected"), true);
  assert.equal(isEntityTooLarge(500, "calculation failed"), false);
});

test("batched Stats request adaptively splits oversized chunks and preserves player order", async () => {
  const calls = [];
  const fetchImpl = async (_url, options = {}) => {
    const players = JSON.parse(String(options.body || "[]"));
    calls.push(players.map((player) => player.playerId));
    if (players.length > 2) {
      return new Response("request entity too large", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });
    }
    return new Response(JSON.stringify(players.map((player) => ({ ...player, calculated: true }))), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const players = Array.from({ length: 5 }, (_, index) => ({ playerId: `p${index + 1}`, rosterUnit: [{ id: `u${index + 1}` }] }));
  const response = await fetchStatsBatched(
    fetchImpl,
    new URL("https://stats.internal/api?flags=calcGP"),
    { method: "POST", headers: { "Content-Type": "application/json" } },
    players,
    { STATS_BATCH_SIZE: "5", STATS_BATCH_CONCURRENCY: "1" },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-SWGOH-Stats-Batches"), "1");
  assert.ok(Number(response.headers.get("X-SWGOH-Stats-Adaptive-Splits")) >= 1);
  const result = await response.json();
  assert.deepEqual(result.map((player) => player.playerId), ["p1", "p2", "p3", "p4", "p5"]);
  assert.ok(result.every((player) => player.calculated === true));
  assert.deepEqual(calls[0], ["p1", "p2", "p3", "p4", "p5"]);
  assert.ok(calls.slice(1).every((call) => call.length <= 3));
});

test("non-size Stats failures remain failures instead of being hidden by splitting", async () => {
  let calls = 0;
  const response = await fetchStatsBatched(
    async () => {
      calls += 1;
      return new Response("calculator unavailable", { status: 500 });
    },
    new URL("https://stats.internal/api"),
    { method: "POST" },
    [{ playerId: "p1" }, { playerId: "p2" }, { playerId: "p3" }],
    { STATS_BATCH_SIZE: "3", STATS_BATCH_CONCURRENCY: "1" },
  );

  assert.equal(response.status, 500);
  assert.equal(await response.text(), "calculator unavailable");
  assert.equal(calls, 1);
});
