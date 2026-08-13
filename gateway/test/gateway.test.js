"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { once } = require("node:events");
const { createGateway, combatTypeOf, categoryIds } = require("../server");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("accepts current Comlink enum/list field shapes", () => {
  const definition = {
    combatType: "CHARACTER",
    categoryIdList: ["alignment_dark", "role_attacker", "affiliation_sith"],
  };
  assert.equal(combatTypeOf(definition, {}), 1);
  assert.deepEqual(categoryIds(definition), ["alignment_dark", "role_attacker", "affiliation_sith"]);
});

test("serves only authenticated, calculated live roster data", async (t) => {
  const player = {
    name: "Live Player",
    allyCode: "123456789",
    level: 85,
    pvpProfile: [
      { tab: 1, rank: 123 },
      { tab: 2, rank: 45 },
    ],
    playerRating: { playerSkillRating: { skillRating: 3612 } },
    datacron: [{ id: "dc-1" }, { id: "dc-2" }],
    rosterUnit: [{
      id: "owned-unit-1",
      definitionId: "DARTHVADER:SEVEN_STAR",
      currentRarity: 7,
      currentLevel: 85,
      currentTier: 13,
      relic: { currentTier: 9 },
      gp: 35000,
      skill: [{ id: "skill_vader_basic", tier: 3 }],
      equippedStatMod: [{ definitionId: "statmod_6dot" }],
    }, {
      id: "owned-ship-1",
      definitionId: "TESTSHIP:SEVEN_STAR",
      currentRarity: 7,
      currentLevel: 85,
      currentTier: 1,
      gp: 50000,
    }],
  };

  const fetchFixture = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/player") return jsonResponse([player]);
    if (parsed.pathname === "/api") {
      const calculated = JSON.parse(options.body);
      calculated[0].rosterUnit[0].stats = { final: { Speed: 271 } };
      return jsonResponse(calculated);
    }
    if (parsed.pathname === "/metadata") {
      return jsonResponse({
        latestGamedataVersion: "live-game-version",
        latestLocalizationBundleVersion: "live-loc-version",
        latestAssetVersion: 1234,
      });
    }
    if (parsed.pathname === "/data") {
      return jsonResponse({
        units: [{
          baseId: "DARTHVADER",
          rarity: 1,
          combatType: "CHARACTER",
          nameKey: "UNIT_DARTHVADER_NAME",
          categoryIdList: ["alignment_dark", "role_attacker", "affiliation_empire", "affiliation_sith"],
          skillReferenceList: [{ skillId: "skill_vader_basic" }],
        }, {
          baseId: "TESTSHIP",
          rarity: 1,
          combatType: "SHIP",
          name: "Test Ship",
          thumbnailName: "tex.charui_testship",
          categoryIdList: ["alignment_light"],
        }],
        statMod: [{
          id: "statmod_6dot",
          rarity: 6,
        }],
        skill: [{
          id: "skill_vader_basic",
          nameKey: "SKILL_VADER_BASIC_NAME",
          descKey: "SKILL_VADER_BASIC_DESC",
          tierList: [{}, { isOmegaTier: true }, { isZetaTier: true }, { isOmicronTier: true }],
        }],
      });
    }
    if (parsed.pathname === "/localization") {
      return jsonResponse({
        "Loc_ENG_US.txt": [
          "UNIT_DARTHVADER_NAME|Darth Vader",
          "SKILL_VADER_BASIC_NAME|Terrifying Swing",
          "SKILL_VADER_BASIC_DESC|Live ability description",
        ].join("\n"),
      });
    }
    return jsonResponse({ error: "unexpected upstream request" }, 500);
  };

  const server = createGateway({
    port: 0,
    comlinkUrl: "http://comlink.internal:3000",
    statsUrl: "http://stats.internal:3223",
    assetUrl: "http://ae2.internal:5000",
    publicBaseUrl: "https://gateway.example",
    apiKey: "test-secret",
    comlinkAccessKey: "",
    comlinkSecretKey: "",
    requestTimeoutMs: 1000,
    rosterCacheMs: 30_000,
    metadataCacheMs: 60_000,
    rateLimitPerMinute: 30,
  }, { fetch: fetchFixture, now: () => Date.parse("2026-08-13T12:00:00Z") });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const unauthorized = await fetch(`${base}/v1/player/123456789`);
  assert.equal(unauthorized.status, 401);

  const response = await fetch(`${base}/v1/player/123456789`, { headers: { "X-API-Key": "test-secret" } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.source, "live");
  assert.equal(body.player.name, "Live Player");
  assert.equal(body.units.length, 1);
  assert.equal(body.ships.length, 1);
  assert.equal(body.units[0].name, "Darth Vader");
  assert.equal(body.ships[0].name, "Test Ship");
  assert.equal(body.ships[0].image, "https://gateway.example/v1/assets/TESTSHIP");
  assert.equal(body.units[0].speed, 271);
  assert.equal(body.units[0].power, 35000);
  assert.equal(body.units[0].alignment, "Dark");
  assert.equal(body.units[0].source, "Comlink + SWGOH Stats");
  assert.equal(body.units[0].omegas, 1);
  assert.equal(body.units[0].zetas, 1);
  assert.equal(body.units[0].omicrons, 1);
  assert.equal(body.summary.datacrons, 2);
  assert.equal(body.summary.sixDotMods, 1);
  assert.equal(body.competitive.arenaRank, 123);
  assert.equal(body.competitive.fleetArenaRank, 45);
  assert.equal(body.competitive.gacSkillRating, 3612);
  assert.equal(body.player.arenaRank, 123);
  assert.equal(body.player.fleetArenaRank, 45);
  assert.equal(body.player.gacSkillRating, 3612);
  assert.equal(body.diagnostics.characters, 1);
  assert.equal(body.diagnostics.ships, 1);
});
