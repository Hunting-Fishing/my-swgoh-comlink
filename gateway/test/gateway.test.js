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
    playerRating: {
      playerSkillRating: { skillRating: 3612 },
      league: "KYBER",
      division: 2,
    },
    profileStat: [
      { id: "STAT_GP", value: "10000000" },
      { id: "STAT_WINS", value: "222" },
    ],
    unlockedPlayerTitle: [{ id: "title-1" }, { id: "title-2" }],
    unlockedPlayerPortrait: [{ id: "portrait-1" }],
    selectedPlayerTitle: { id: "title-2" },
    selectedPlayerPortrait: { id: "portrait-1" },
    seasonStatus: [{
      seasonId: "season-current",
      eventInstanceId: "event-current",
      league: "KYBER",
      division: 2,
      seasonPoints: 950,
      rank: 17,
      joinTime: "3000",
      endTime: "4000",
    }],
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
      purchasedAbilityId: ["ultimateability_vader_test"],
    }, {
      id: "owned-ship-1",
      definitionId: "TESTSHIP:SEVEN_STAR",
      currentRarity: 7,
      currentLevel: 85,
      currentTier: 1,
      gp: 50000,
    }],
  };

  let requestedAssetName = "";
  const fetchFixture = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.hostname === "raw.githubusercontent.com" && parsed.pathname.endsWith("/statMod.json")) {
      return jsonResponse({ version: "test", data: [{ id: "statmod_6dot", rarity: 6 }] });
    }
    if (parsed.pathname === "/Asset/single") {
      requestedAssetName = parsed.searchParams.get("assetName") || "";
      return new Response(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]), {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
    }
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
        recipe: [{
          id: "skillrecipe_vader_omega",
          ingredientBundle: {
            entries: [{ materialReference: { id: "ability_mat_Omega" }, quantity: 3 }],
          },
        }],
        skill: [{
          id: "skill_vader_basic",
          nameKey: "SKILL_VADER_BASIC_NAME",
          descKey: "SKILL_VADER_BASIC_DESC",
          tierList: [{}, { recipeId: "skillrecipe_vader_omega" }, { isZetaTier: true }, { isOmicronTier: true }],
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
  assert.equal(body.ships[0].image, "https://gateway.example/v1/assets/charui_testship");
  assert.equal(body.units[0].speed, 271);
  assert.equal(body.units[0].power, 35000);
  assert.equal(body.units[0].alignment, "Dark");
  assert.equal(body.units[0].source, "Comlink + SWGOH Stats");
  assert.equal(body.units[0].equippedMods, 1);
  assert.deepEqual(body.units[0].purchasedAbilityIds, ["ultimateability_vader_test"]);
  assert.equal(body.units[0].omegas, 1);
  assert.equal(body.units[0].zetas, 1);
  assert.equal(body.units[0].omicrons, 1);
  assert.equal(body.summary.datacrons, 2);
  assert.equal(body.summary.sixDotMods, 1);
  assert.equal(body.summary.equippedMods, 1);
  assert.equal(body.summary.purchasedAbilities, 1);
  assert.equal(body.summary.unlockedTitles, 2);
  assert.equal(body.summary.unlockedPortraits, 1);
  assert.equal(body.competitive.arenaRank, 123);
  assert.equal(body.competitive.fleetArenaRank, 45);
  assert.equal(body.competitive.gacSkillRating, 3612);
  assert.equal(body.competitive.gacLeague, "KYBER");
  assert.equal(body.competitive.gacDivision, 2);
  assert.equal(body.player.arenaRank, 123);
  assert.equal(body.player.fleetArenaRank, 45);
  assert.equal(body.player.gacSkillRating, 3612);
  assert.equal(body.player.gacLeague, "KYBER");
  assert.equal(body.player.gacDivision, 2);
  assert.equal(body.profileStats.length, 2);
  assert.equal(body.purchasedAbilities[0].abilityId, "ultimateability_vader_test");
  assert.equal(body.seasonStatus[0].seasonId, "season-current");
  assert.deepEqual(body.selectedCosmetics, { titleId: "title-2", portraitId: "portrait-1" });
  assert.equal(body.capabilities.equippedMods, true);
  assert.equal(body.capabilities.profileStats, true);
  assert.equal(body.capabilities.materials, false);
  assert.equal(body.capabilities.currencyBalances, false);
  assert.equal(body.diagnostics.characters, 1);
  assert.equal(body.diagnostics.ships, 1);

  const imageResponse = await fetch(`${base}/v1/assets/charui_testship`);
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get("content-type"), "image/png");
  assert.equal(requestedAssetName, "charui_testship");
});
