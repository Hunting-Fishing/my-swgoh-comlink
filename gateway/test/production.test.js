"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { brotliCompressSync } = require("node:zlib");
const { createProductionFetch } = require("../production");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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
      return jsonResponse({ data: [{ id: "skill_test", tier: [{ recipeId: "recipe_omega" }] }] });
    }
    if (url.pathname.endsWith("/recipe.json")) {
      return jsonResponse({ data: [{ id: "recipe_omega", ingredients: [{ id: "abilitymaterial_omega", minQuantity: 3 }] }] });
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
  assert.equal(body.recipe[0].ingredients[0].id, "abilitymaterial_omega");
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
