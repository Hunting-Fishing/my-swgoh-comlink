"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { once } = require("node:events");
const http = require("node:http");
const { createModAwareServer } = require("../mod-service");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function rawStat(unitStatId, displayed, percent = false) {
  return {
    stat: {
      unitStatId,
      unscaledDecimalValue: String(displayed * (percent ? 1e6 : 1e8)),
    },
  };
}

test("serves authenticated cached equipped mod details for all pip levels", async (t) => {
  let playerCalls = 0;
  let definitionCalls = 0;
  const player = {
    name: "Mod Player",
    allyCode: "123456789",
    playerId: "player-1",
    rosterUnit: [{
      definitionId: "UNITA:SEVEN_STAR",
      equippedStatMod: [{
        id: "five-dot",
        definitionId: "151",
        level: 15,
        tier: 5,
        primaryStat: rawStat(41, 100),
        secondaryStat: [rawStat(5, 21)],
      }, {
        id: "six-dot",
        definitionId: "161",
        level: 15,
        tier: 6,
        primaryStat: rawStat(55, 16, true),
        secondaryStat: [rawStat(5, 27)],
      }],
    }],
  };

  const fetchFixture = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/player") {
      playerCalls += 1;
      return jsonResponse([player]);
    }
    if (parsed.hostname === "raw.githubusercontent.com" && parsed.pathname.endsWith("/statMod.json")) {
      definitionCalls += 1;
      return jsonResponse({ data: [
        { id: "151", slot: 2, setId: "1", rarity: 5 },
        { id: "161", slot: 2, setId: "1", rarity: 6 },
      ] });
    }
    return jsonResponse({ error: "unexpected" }, 500);
  };

  const baseGateway = http.createServer((_request, response) => {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "base" }));
  });
  const server = createModAwareServer(baseGateway, {
    comlinkUrl: "http://comlink.internal:3000",
    apiKey: "secret",
    comlinkAccessKey: "",
    comlinkSecretKey: "",
    requestTimeoutMs: 1000,
  }, {
    fetch: fetchFixture,
    now: () => Date.parse("2026-08-15T04:00:00Z"),
    env: { MOD_CACHE_SECONDS: "300", MOD_DEFINITION_CACHE_SECONDS: "21600" },
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const unauthorized = await fetch(`${base}/v1/mods/by-player/123456789`);
  assert.equal(unauthorized.status, 401);

  const first = await fetch(`${base}/v1/mods/by-player/123456789`, { headers: { "X-API-Key": "secret" } });
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.source, "live");
  assert.equal(body.player.name, "Mod Player");
  assert.equal(body.units.length, 1);
  assert.equal(body.units[0].mods.length, 2);
  assert.equal(body.summary.totalMods, 2);
  assert.equal(body.summary.underSixDot, 1);
  assert.equal(body.summary.sixDot, 1);
  assert.equal(body.summary.byRarity["5"], 1);
  assert.equal(body.summary.byRarity["6"], 1);
  assert.equal(body.summary.speed20Plus, 2);
  assert.equal(body.capabilities.equippedModDetails, true);
  assert.equal(body.capabilities.allEquippedPipLevels, true);
  assert.equal(body.capabilities.unequippedMods, false);

  const second = await fetch(`${base}/v1/mods/by-player/123456789`, { headers: { "X-API-Key": "secret" } });
  assert.equal(second.status, 200);
  assert.equal(playerCalls, 1, "player payload should be served from mod cache");
  assert.equal(definitionCalls, 1, "static mod definitions should be cached");
});

test("falls through non-mod routes to the wrapped gateway", async (t) => {
  const baseGateway = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ base: true }));
  });
  const server = createModAwareServer(baseGateway, { comlinkUrl: "x", apiKey: "secret" }, { fetch: globalThis.fetch });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { base: true });
});
