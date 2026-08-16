"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createVerificationService,
  normalizeVerificationProfile,
} = require("../verification-service");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("verification profile exposes only canonical identity and cosmetic ids", () => {
  const normalized = normalizeVerificationProfile({
    playerId: "player-1",
    allyCode: "123456789",
    name: "Alpha",
    selectedPlayerTitle: { id: "TITLE_A", nameKey: "SHOULD_NOT_LEAK" },
    selectedPlayerPortrait: { id: "PORTRAIT_A", someOtherField: "SHOULD_NOT_LEAK" },
    unlockedPlayerTitle: [
      { id: "TITLE_A", nameKey: "ignored" },
      { titleId: "TITLE_B" },
      "TITLE_C",
      { id: "TITLE_B" },
    ],
    unlockedPlayerPortrait: [
      { id: "PORTRAIT_A" },
      { portraitId: "PORTRAIT_B" },
      "PORTRAIT_C",
    ],
    rosterUnit: [{ definitionId: "DARTHVADER", currentRarity: 7 }],
    profileStat: [{ id: "secret-unneeded", value: 10 }],
  });

  assert.deepEqual(normalized, {
    source: "live",
    player: {
      playerId: "player-1",
      allyCode: "123456789",
      name: "Alpha",
      selectedTitleId: "TITLE_A",
      selectedPortraitId: "PORTRAIT_A",
    },
    unlocked: {
      titleIds: ["TITLE_A", "TITLE_B", "TITLE_C"],
      portraitIds: ["PORTRAIT_A", "PORTRAIT_B", "PORTRAIT_C"],
    },
  });
  assert.equal(JSON.stringify(normalized).includes("DARTHVADER"), false);
  assert.equal(JSON.stringify(normalized).includes("SHOULD_NOT_LEAK"), false);
  assert.equal(JSON.stringify(normalized).includes("secret-unneeded"), false);
});

test("verification service caches normal reads and force refresh bypasses that cache", async () => {
  let now = 1000;
  let calls = 0;
  let selectedPortrait = "PORTRAIT_A";
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, "/player");
    const body = JSON.parse(options.body);
    assert.equal(body.payload.allyCode, "123456789");
    calls += 1;
    return jsonResponse([{
      playerId: "player-1",
      allyCode: "123456789",
      name: "Alpha",
      selectedPlayerTitle: { id: "TITLE_A" },
      selectedPlayerPortrait: { id: selectedPortrait },
      unlockedPlayerTitle: [{ id: "TITLE_A" }, { id: "TITLE_B" }],
      unlockedPlayerPortrait: [{ id: "PORTRAIT_A" }, { id: "PORTRAIT_B" }],
    }]);
  };

  const service = createVerificationService({
    comlinkUrl: "https://comlink.example",
    comlinkAccessKey: "access",
    comlinkSecretKey: "secret",
    requestTimeoutMs: 1000,
    playerVerificationCacheMs: 15000,
  }, { fetch: fetchImpl, now: () => now });

  const first = await service.load("123456789");
  assert.equal(first.player.selectedPortraitId, "PORTRAIT_A");
  assert.equal(calls, 1);

  selectedPortrait = "PORTRAIT_B";
  const cached = await service.load("123456789");
  assert.equal(cached.player.selectedPortraitId, "PORTRAIT_A");
  assert.equal(calls, 1);

  const refreshed = await service.load("123456789", { forceRefresh: true });
  assert.equal(refreshed.player.selectedPortraitId, "PORTRAIT_B");
  assert.equal(calls, 2);

  now += 16000;
  await service.load("123456789");
  assert.equal(calls, 3);
});

test("profile requires a stable player id and 9-digit Ally Code", () => {
  assert.equal(normalizeVerificationProfile({ allyCode: "123456789", name: "Missing ID" }), null);
  assert.equal(normalizeVerificationProfile({ playerId: "p1", allyCode: "123", name: "Bad Ally" }), null);
});
