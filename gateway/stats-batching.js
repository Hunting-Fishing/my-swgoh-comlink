"use strict";

function positiveInteger(value, fallback, min = 1, max = 50) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(max, parsed);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function copyResponse(response, text) {
  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function isEntityTooLarge(status, text) {
  if (Number(status) === 413) return true;
  return /(request|payload|entity|body).{0,24}too large|too large.{0,24}(request|payload|entity|body)/i.test(String(text || ""));
}

async function mapLimit(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  const count = Math.min(Math.max(1, Math.floor(limit)), Math.max(1, items.length));
  const runners = Array.from({ length: count }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return output;
}

async function requestStatsChunk(fetchImpl, url, options, players) {
  const response = await fetchImpl(url, {
    ...options,
    body: JSON.stringify(players),
  });
  const text = await response.text();

  if (!response.ok) {
    if (players.length > 1 && isEntityTooLarge(response.status, text)) {
      const midpoint = Math.ceil(players.length / 2);
      const left = await requestStatsChunk(fetchImpl, url, options, players.slice(0, midpoint));
      if (!left.ok) return left;
      const right = await requestStatsChunk(fetchImpl, url, options, players.slice(midpoint));
      if (!right.ok) return right;
      return {
        ok: true,
        players: left.players.concat(right.players),
        headers: left.headers || right.headers,
        adaptiveSplits: Number(left.adaptiveSplits || 0) + Number(right.adaptiveSplits || 0) + 1,
      };
    }
    return { ok: false, response: copyResponse(response, text) };
  }

  let payload;
  try {
    payload = text ? JSON.parse(text) : [];
  } catch {
    return {
      ok: false,
      response: new Response("SWGOH Stats batch returned invalid JSON.", {
        status: 502,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    };
  }
  if (!Array.isArray(payload)) {
    return {
      ok: false,
      response: new Response("SWGOH Stats batch returned a non-array player payload.", {
        status: 502,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    };
  }

  return { ok: true, players: payload, headers: new Headers(response.headers), adaptiveSplits: 0 };
}

async function fetchStatsBatched(fetchImpl, input, options = {}, players = [], env = process.env) {
  const sourcePlayers = asArray(players);
  if (sourcePlayers.length <= 1) {
    return fetchImpl(input, { ...options, body: JSON.stringify(sourcePlayers) });
  }

  const batchSize = positiveInteger(env.SWGOH_STATS_BATCH_SIZE || env.STATS_BATCH_SIZE, 5, 1, 20);
  const concurrency = positiveInteger(env.SWGOH_STATS_BATCH_CONCURRENCY || env.STATS_BATCH_CONCURRENCY, 3, 1, 8);
  const batches = [];
  for (let index = 0; index < sourcePlayers.length; index += batchSize) {
    batches.push(sourcePlayers.slice(index, index + batchSize));
  }

  const results = await mapLimit(batches, concurrency, (batch) => requestStatsChunk(fetchImpl, input, options, batch));
  const failed = results.find((result) => !result?.ok);
  if (failed) return failed.response;

  const calculated = results.flatMap((result) => asArray(result.players));
  if (calculated.length !== sourcePlayers.length) {
    return new Response(
      `SWGOH Stats batched player count mismatch (${calculated.length}/${sourcePlayers.length}).`,
      { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  const headers = new Headers(results.find((result) => result?.headers)?.headers || {});
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-SWGOH-Stats-Batches", String(batches.length));
  headers.set("X-SWGOH-Stats-Players", String(sourcePlayers.length));
  headers.set("X-SWGOH-Stats-Adaptive-Splits", String(results.reduce((sum, result) => sum + Number(result?.adaptiveSplits || 0), 0)));
  return new Response(JSON.stringify(calculated), { status: 200, headers });
}

module.exports = {
  fetchStatsBatched,
  isEntityTooLarge,
  positiveInteger,
  requestStatsChunk,
};
