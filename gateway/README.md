# SWGOH Live Gateway

Secure, live-only bridge for SWGOH Roster Command. It retrieves the current player and game data from Comlink, sends the current roster through SWGOH Stats, and optionally proxies current character artwork from AE2.

There is no production fallback, sample roster, or demonstration response. If any required live service fails, the endpoint returns an error and the web app remains empty.

## API

- `GET /healthz` — container health and configuration state
- `GET /v1/player/:allyCode` — normalized live player and character roster; requires `X-API-Key`
- `GET /v1/assets/:baseId` — AE2 artwork proxy for characters present in a recently requested live roster

## Railway service

Create a second Railway service from `Hunting-Fishing/my-swgoh-comlink` and set its root directory to `/gateway`. Railway will build the included Dockerfile; Docker Desktop and Docker Cloud are not required.

Set these service variables:

```text
COMLINK_URL=http://<comlink-private-domain>:<comlink-port>
STATS_URL=http://<stats-private-domain>:<stats-port>
ASSET_URL=http://<ae2-private-domain>:<ae2-port>
GATEWAY_API_KEY=<a-long-random-secret>
PUBLIC_BASE_URL=https://<gateway-public-domain>
```

Optional variables:

```text
COMLINK_ACCESS_KEY=
COMLINK_SECRET_KEY=
ROSTER_CACHE_SECONDS=30
METADATA_CACHE_SECONDS=21600
RATE_LIMIT_PER_MINUTE=30
REQUEST_TIMEOUT_MS=30000
```

Use Railway private-network domains for the three upstream services. Only the gateway needs a public domain. If Comlink uses HMAC protection, copy the same access and secret keys into the gateway.

Finally configure the hosted web app with:

```text
SWGOH_GATEWAY_URL=https://<gateway-public-domain>
SWGOH_GATEWAY_API_KEY=<the-same-long-random-secret>
```

## Local validation

```sh
npm test
```
