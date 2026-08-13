"use strict";

const crypto = require("node:crypto");
const JSZip = require("jszip");
const { createGateway, loadConfig } = require("./server");

function signedLocalizationHeaders(config, serializedBody, sourceHeaders) {
  const headers = new Headers(sourceHeaders || {});
  if (!config.comlinkAccessKey || !config.comlinkSecretKey) return headers;

  const timestamp = String(Date.now());
  const bodyHash = crypto.createHash("md5").update(serializedBody).digest("hex");
  const signature = crypto
    .createHmac("sha256", config.comlinkSecretKey)
    .update(timestamp)
    .update("POST")
    .update("/localization")
    .update(bodyHash)
    .digest("hex");

  headers.set("X-Date", timestamp);
  headers.set(
    "Authorization",
    `HMAC-SHA256 Credential=${config.comlinkAccessKey},Signature=${signature}`
  );
  return headers;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function createLocalizationAwareFetch(config, fetchImpl = globalThis.fetch) {
  return async function localizationAwareFetch(input, options = {}) {
    const url = input instanceof URL ? input : new URL(String(input));
    const method = String(options.method || "GET").toUpperCase();

    if (method !== "POST" || url.pathname !== "/localization") {
      return fetchImpl(input, options);
    }

    try {
      const requested = JSON.parse(String(options.body || "{}"));
      const compactRequest = { ...requested, unzip: false };
      const serializedBody = JSON.stringify(compactRequest);
      const headers = signedLocalizationHeaders(config, serializedBody, options.headers);

      const upstream = await fetchImpl(input, {
        ...options,
        headers,
        body: serializedBody,
      });

      if (!upstream.ok) return upstream;

      const payload = await upstream.json();
      const base64 = typeof payload === "string"
        ? payload
        : payload?.localizationBundle || payload?.data?.localizationBundle || "";

      if (!base64) {
        console.warn("[gateway] Comlink localization response did not contain a compressed bundle; continuing without localization.");
        return jsonResponse({});
      }

      const zip = await JSZip.loadAsync(Buffer.from(base64, "base64"));
      const englishName = Object.keys(zip.files).find((name) =>
        !zip.files[name].dir && /(^|\/)Loc_ENG_US\.txt$/i.test(name)
      );

      if (!englishName) {
        console.warn("[gateway] English localization file was not present in the Comlink bundle; continuing without localization.");
        return jsonResponse({});
      }

      const english = await zip.files[englishName].async("text");
      console.log(`[gateway] extracted ${englishName} from compressed Comlink localization bundle (${Buffer.byteLength(english)} bytes)`);
      return jsonResponse({ "Loc_ENG_US.txt": english });
    } catch (error) {
      console.warn(`[gateway] localization extraction failed; roster will continue without localized labels: ${error?.message || error}`);
      return jsonResponse({});
    }
  };
}

function start() {
  const config = loadConfig();
  const fetchImpl = createLocalizationAwareFetch(config);
  createGateway(config, { fetch: fetchImpl }).listen(config.port, "0.0.0.0", () => {
    console.log(`SWGOH live gateway listening on port ${config.port}`);
  });
}

if (require.main === module) start();

module.exports = {
  createLocalizationAwareFetch,
  signedLocalizationHeaders,
};
