# Live traffic flow

A colour-coded traffic-flow overlay on the map, from TomTom raster tiles. The API proxies the
tiles so the TomTom key stays on the server.

Module: `apps/api/src/modules/traffic/` (`TrafficModule`). Permission: `gps:read`.

## Endpoints

| Route | Returns |
| --- | --- |
| `GET /traffic/status` | `{ enabled, provider, tilesUsedToday, dailyBudget, attribution, note }` |
| `GET /traffic/tiles/:z/:x/:y` | A 256 px PNG with `Cache-Control: private, max-age=120`. `z` is 0 to 22; `x` and `y` are integers from 0 to 2^z − 1. |

Tile responses:

- 404 when no key is configured (`enabled: false` in status);
- 400 for invalid coordinates;
- 429 once today's budget is spent and the tile is not cached;
- 502 when TomTom fails.

The tile route allows 1200 requests per minute per client, because one map view loads dozens of
tiles at a time.

## Configuration

- `TOMTOM_API_KEY`: turns the overlay on. Without it the module does nothing and makes no network
  calls.
- `TOMTOM_DAILY_TILE_BUDGET` (default 6000): our own limit on upstream tile requests per UTC day.

## Source and quotas

TomTom Traffic Flow raster tiles, style `relative0`:
`https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png?tileSize=256`.
Attribution: "Traffic © TomTom". Use is governed by the TomTom developer terms of your key.

TomTom's free allowance is **monthly**. When this was written it was about 200 000 Traffic tile
requests per month; check the current figure on the TomTom pricing page. The default budget of
6000 per day keeps a 31-day month (186 000) under that. A map without a limit can use up a month's
allowance in a few days.

Every upstream attempt counts against the budget, because TomTom bills it whether or not a tile
comes back. Cache hits are free. The counter lives in memory, so it resets when the API restarts
and each instance has its own. Set the budget per instance to allow for this.

## Caching

Tiles are cached in memory for 120 s, up to 512 tiles, which is a few MB. If TomTom fails or the
budget is spent, a cached tile up to 10 minutes old is served. A 200 response that is not a PNG is
refused and not cached.

## Key handling

The key is only used to build the upstream URL. It never appears in responses. Upstream errors
contain only the host and status, and log lines are also redacted as a safeguard. Tests check
this.
