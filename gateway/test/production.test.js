"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { brotliCompressSync } = require("node:zlib");
const {
  createProductionFetch,
  prepareRecipes,
  prepareSkillForRosterSemantics,
  upgradeKindsForRecipe,
} = require("../production");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("current CG ability_mat_Omega recipes are classified structurally", () => {
  const recipe = {
    id: "SKILLRECIPE_BASIC_T7",
    ingredients: [
      { id: "GRIND", minQuantity: 10000 },
      { id: "ability_mat_Omega", minQuantity: 3 },
    ],
  };
  assert.deepEqual([...upgradeKindsForRecipe(recipe)], ["omega"]);

  const { prepared, recipeKinds } = prepareRecipes([recipe]);
  assert.deepEqual(prepared[0].gatewayUpgradeMaterials, ["omega"]);

  const skill = prepareSkillForRosterSemantics({
    id: "skill_test",
    tier: [
      { recipeId: "SKILLRECIPE_BASIC_T2" },
      { recipeId: "SKILLRECIPE_BASIC_T7" },
      { recipeId: "SKILLRECIPE_BASIC_T8", isZetaTier: true },
      { recipeId: "SKILLRECIPE_BASIC_T9", isOmicronTier: true },
    ],
  }, recipeKinds);

  assert.equal(skill.tier.length, 5);
  assert.equal(skill.tier[0], null);
  assert.equal(skill.tier[2].isOmegaTier, true);
  assert.equal(skill.tier[3].isZetaTier, true);
  assert.equal(skill.tier[4].isOmicronTier, true);
});

test("production gamedata includes recipes and stat mods for upgrade/material resolution", async () => {
  const requested = [];
  const fetchFixture = async (input) => {
    const url = new URL(String(input));
    requested.push(url.pathname);

    if (url.pathname.endsWith("/allVersions.json")) {
      return jsonResponse({ gameVersion: "game-1", localeVersion: "loc-1", assetVersion: 123 });
    }
    if (url.pathname.endsWith("/units_gas.json")) {
      return jsonResponse({ data: [{ baseId: "TEST", combatType: 1 }] });
    }
    if (url.pathname.endsWith("/skill.json")) {
      return jsonResponse({ data: [{ id: "skill_test", tier: [{ recipeId: "SKILLRECIPE_BASIC_T7" }] }] });
    }
    if (url.pathname.endsWith("/recipe.json")) {
      return jsonResponse({ data: [{
        id: "SKILLRECIPE_BASIC_T7",
        ingredients: [{ id: "GRIND", minQuantity: 10000 }, { id: "ability_mat_Omega", minQuantity: 3 }],
      }] });
    }
    if (url.pathname.endsWith("/statMod.json")) {
      return jsonResponse({ data: [{ id: "statmod_6dot", rarity: 6 }] });
    }
    if (url.pathname.endsWith("/Loc_ENG_US.txt.json.br")) {
      const bytes = brotliCompressSync(Buffer.from(JSON.stringify({ data: { TEST_NAME: "Test Unit" } }), "utf8"));
      return new Response(bytes, { status: 200 });
    }

    return jsonResponse({ error: `unexpected ${url}` }, 500);
  };

  const productionFetch = createProductionFetch({
    comlinkUrl: "http://comlink.internal:3000",
    statsUrl: "http://stats.internal:3223",
    assetUrl: "http://ae2.internal:8080",
  }, fetchFixture, {
    SWGOH_GAMEDATA_BASE_URL: "https://raw.example/gamedata",
    STATIC_GAMEDATA_CACHE_MS: "60000",
  });

  const response = await productionFetch("http://comlink.internal:3000/data", {
    method: "POST",
    body: JSON.stringify({ payload: { version: "game-1" } }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.units.length, 1);
  assert.equal(body.skill.length, 1);
  assert.equal(body.recipe.length, 1);
  assert.equal(body.recipe[0].ingredients[1].id, "ability_mat_Omega");
  assert.deepEqual(body.recipe[0].gatewayUpgradeMaterials, ["omega"]);
  assert.equal(body.skill[0].tier[0], null);
  assert.equal(body.skill[0].tier[1].isOmegaTier, true);
  assert.equal(body.statMod.length, 1);
  assert.ok(requested.some((path) => path.endsWith("/recipe.json")));
  assert.ok(requested.some((path) => path.endsWith("/statMod.json")));
});

test("production Stats requests always include calcGP", async () => {
  let seen = "";
  const fetchFixture = async (input) => {
    const url = new URL(String(input));
    seen = url.searchParams.get("flags") || "";
    return jsonResponse([]);
  };

  const productionFetch = createProductionFetch({
    comlinkUrl: "http://comlink.internal:3000",
    statsUrl: "http://stats.internal:3223",
    assetUrl: "http://ae2.internal:8080",
  }, fetchFixture);

  await productionFetch("http://stats.internal:3223/api?flags=foo", { method: "POST", body: "[]" });
  assert.equal(new Set(seen.split(",")).has("calcGP"), true);
});

test("production artwork uses static image fallback when AE2 misses an asset", async () => {
  const seen = [];
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const fetchFixture = async (input) => {
    const url = new URL(String(input));
    seen.push(url.href);
    if (url.hostname === "ae2.internal") return new Response("missing", { status: 404 });
    if (url.hostname === "assets.example" && url.pathname.endsWith("/tex.charui_scythe.png")) {
      return new Response(png, { status: 200, headers: { "Content-Type": "image/png" } });
    }
    return new Response("missing", { status: 404 });
  };

  const productionFetch = createProductionFetch({
    comlinkUrl: "http://comlink.internal:3000",
    statsUrl: "http://stats.internal:3223",
    assetUrl: "http://ae2.internal:8080",
  }, fetchFixture, {
    SWGOH_ASSET_FALLBACK_BASE_URL: "https://assets.example/static/img/assets",
  });

  const response = await productionFetch("http://ae2.internal:8080/Asset/single?version=123&assetName=tex.charui_scythe", { method: "GET" });
  assert.equal(response.status, 200);
  assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 8).equals(png.subarray(0, 8)), true);
  assert.ok(seen.some((url) => url.includes("ae2.internal") && url.includes("assetName=charui_scythe")));
  assert.ok(seen.some((url) => url.includes("assets.example") && url.includes("tex.charui_scythe.png")));
});
