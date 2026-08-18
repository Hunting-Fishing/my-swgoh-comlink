"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { observeComlinkMetadataResponse } = require("../recovery");
const { normalizeDatacrons, textContextStatus } = require("../datacron-intelligence");

const config = { comlinkUrl: "https://comlink.test" };

test("recovery observes Comlink data from a cloned response without consuming the original", async () => {
  const payload = {
    ability: [{ id: "DC_RECOVERY", nameKey: "DC_RECOVERY_NAME", descKey: "DC_RECOVERY_DESC" }],
  };
  const response = new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  await observeComlinkMetadataResponse(response, new URL("https://comlink.test/data"), config);
  assert.deepEqual(await response.json(), payload);
  assert.ok(textContextStatus().abilities >= 1);
});

test("recovery observes localization and subsequent datacron normalization receives official text", async () => {
  const localization = {
    ENG_US: {
      DC_RECOVERY_NAME: "Recovery Bonus",
      DC_RECOVERY_DESC: "Eligible allies gain an official localized effect.",
    },
  };
  const response = new Response(JSON.stringify(localization), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  await observeComlinkMetadataResponse(response, new URL("https://comlink.test/localization"), config);
  assert.deepEqual(await response.json(), localization);

  const datacrons = normalizeDatacrons([{ id: "DCR", setId: 33, affix: [{ abilityId: "DC_RECOVERY" }] }]);
  const affix = datacrons[0].affixes[0];
  assert.equal(affix.abilityName, "Recovery Bonus");
  assert.equal(affix.abilityDescription, "Eligible allies gain an official localized effect.");
  assert.equal(affix.abilityTextResolved, true);
});

test("non-Comlink responses are ignored", async () => {
  const before = textContextStatus();
  const response = new Response(JSON.stringify({ ability: [{ id: "SHOULD_NOT_LOAD" }] }), { status: 200 });
  await observeComlinkMetadataResponse(response, new URL("https://stats.test/data"), config);
  assert.deepEqual(textContextStatus(), before);
});
