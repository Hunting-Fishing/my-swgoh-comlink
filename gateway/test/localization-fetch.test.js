"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const JSZip = require("jszip");
const { createLocalizationAwareFetch } = require("../bootstrap");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("requests the compressed Comlink localization bundle and returns only English text", async () => {
  const zip = new JSZip();
  zip.file("Loc_ENG_US.txt", "UNIT_DARTHVADER_NAME|Darth Vader\nSKILL_TEST_NAME|Test Skill\n");
  zip.file("Loc_FRE_FR.txt", "UNIT_DARTHVADER_NAME|Dark Vador\n");
  const base64 = await zip.generateAsync({ type: "base64", compression: "DEFLATE" });

  let upstreamBody;
  const fetchFixture = async (_url, options) => {
    upstreamBody = JSON.parse(options.body);
    return jsonResponse({ localizationBundle: base64 });
  };

  const wrapped = createLocalizationAwareFetch({
    comlinkAccessKey: "",
    comlinkSecretKey: "",
  }, fetchFixture);

  const response = await wrapped("http://comlink.internal:3000/localization", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload: { id: "live-loc-version" }, unzip: true }),
  });

  assert.equal(upstreamBody.unzip, false);
  const body = await response.json();
  assert.match(body["Loc_ENG_US.txt"], /Darth Vader/);
  assert.doesNotMatch(body["Loc_ENG_US.txt"], /Dark Vador/);
});

test("localization extraction failure does not block the live roster pipeline", async () => {
  const wrapped = createLocalizationAwareFetch({
    comlinkAccessKey: "",
    comlinkSecretKey: "",
  }, async () => jsonResponse({ unexpected: true }));

  const response = await wrapped("http://comlink.internal:3000/localization", {
    method: "POST",
    body: JSON.stringify({ payload: { id: "live-loc-version" }, unzip: true }),
  });

  assert.deepEqual(await response.json(), {});
});
