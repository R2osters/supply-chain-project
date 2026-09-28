# Local radio near a truck

A driver or dispatcher wants the local news or traffic station for wherever a truck is. The API
lists nearby internet radio streams; the browser plays them.

Module: `apps/api/src/modules/radio/` (`RadioModule`). Permission: `gps:read`.

## Endpoints

| Route | Returns |
| --- | --- |
| `GET /radio/stations?lat=&lon=&radiusKm=&tag=&limit=` | `{ status, fetchedAt, attribution, stations }`, nearest first, each with `distanceKm`. `radiusKm` defaults to 150, max 1000. `limit` defaults to 40, max 200. `tag` is a case-insensitive substring matched against station tags (`news`, `traffic`, `talk`). |
| `POST /radio/stations/:id/click` | `{ ok }`. Reports a play to Radio Browser. Only relayed for station UUIDs this API has listed. |

`status` is `OK`, `STALE` (a refresh failed and a cached list up to 24 h old is served) or
`UNAVAILABLE` (nothing to serve; `stations` is empty and `fetchedAt` is null).

## Source

[Radio Browser](https://www.radio-browser.info/), a community directory of internet radio. The
data is public domain. Attribution shown: "Radio Browser (radio-browser.info), public domain
directory".

- Mirrors are discovered from `https://all.api.radio-browser.info/json/servers` (cached 6 h). Only
  `*.api.radio-browser.info` hostnames are accepted. If discovery fails, three known mirrors are
  used. Each request tries the mirrors in turn.
- Query: `/json/stations/search` with `has_geo_info`, `is_https`, `hidebroken`,
  `order=clickcount`, `geo_lat`, `geo_long` and `geo_distance` (in metres).
- Requests carry an identifying `User-Agent`, as the project asks.

## What is filtered out

Anyone can add a station, so every row is treated as untrusted. A station is kept only if:

- the stream is HTTPS on a public hostname (no localhost, private IPs or IPv6 literals);
- it is not HLS and the codec is MP3 or AAC, which every browser plays natively;
- its last health check passed and it has a real position (0,0 is treated as missing).

Text fields are stripped of control characters and truncated. Tags are lower-cased and
de-duplicated. Homepage links go through the same public-HTTPS check.

## Caching and limits

- Queries are snapped to 0.25° cells (about 28 km) and the radius is rounded up to 50, 100, 150,
  300, 500 or 1000 km. Up to 500 stations per cell are fetched and cached for 45 minutes. Tag,
  exact radius and limit are applied locally, so nearby trucks share one upstream request.
- A cached list is served for up to 24 h when Radio Browser cannot be reached.

## Privacy

Audio is never proxied. The browser connects straight to the broadcaster's stream server, so
**the broadcaster sees the listener's IP address**, user agent and listening time, as with any
web radio. Tell users this before they press play if that matters in your deployment. Station
metadata is not verified: a station tagged "traffic" might play music.
