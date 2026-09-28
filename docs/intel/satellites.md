# Satellites and GPS fix quality

Two uses: explain a jumpy truck track ("only three GPS satellites above the horizon there right
now"), and draw an orbital layer on the map.

Module: `apps/api/src/modules/satellites/` (`SatellitesModule`). Permission: `gps:read`.
Dependency: [`satellite.js`](https://github.com/shashwatak/satellite-js) 6.x (MIT) for SGP4.
Version 7 is ESM-only and does not load under Jest, so the API stays on 6.x.

## Endpoints

| Route | Returns |
| --- | --- |
| `GET /satellites/groups` | `{ groups: [{ id, label, description }] }` |
| `GET /satellites/tle?group=gps-ops` | `{ group, fetchedAt, stale, attribution, satellites: [{ noradId, name, line1, line2, epoch }] }` |
| `GET /satellites/visible?lat=&lon=&group=gps-ops&minElevationDeg=10` | `{ group, at, latitude, longitude, minElevationDeg, visible, summary }`. `visible` is sorted by elevation, highest first. `summary` is `{ count, above30Deg, quality }`. |

Allowed groups: `gps-ops`, `galileo`, `glo-ops`, `beidou`, `stations`, `weather`, `resource`,
`geo`, `iridium-NEXT`. Any other value gets a 400. A group that cannot be loaded and has no cached
copy gets a 503.

## Fix quality

`quality` is based only on satellite geometry above the elevation mask:

- `POOR`: fewer than 4 satellites. A fix needs four (three coordinates plus the receiver clock).
- `GOOD`: 8 or more satellites, at least 4 of them above 30°. A single constellation with open sky
  usually shows 8 to 12 satellites above 10°. Low satellites are the first to be blocked by
  buildings, trees or the cab, so a high count made only of low satellites does not count as good.
- `FAIR`: anything in between.

This cannot see tunnels, urban canyons or jamming. It tells you whether the fix *should* be good
at that place and time. It is computed for every group, but it only means something for the GNSS
groups (`gps-ops`, `galileo`, `glo-ops`, `beidou`).

## Source

[CelesTrak](https://celestrak.org) GP data in TLE format:
`https://celestrak.org/NORAD/elements/gp.php?GROUP=<group>&FORMAT=tle`. Attribution: "CelesTrak
(celestrak.org), Dr. T.S. Kelso". CelesTrak is a free public service.

Every element set is checked before use: line length, line numbers, the modulo-10 checksum on
both lines, and matching catalogue numbers (including Alpha-5 numbers above 99 999). A bad set is
skipped on its own. A 200 response with no valid sets (CelesTrak's plain-text error messages)
counts as a failure and is never cached.

## Caching and limits

CelesTrak asks clients not to download the same group more than once every 2 hours, and blocks
addresses that ignore this. Each group is cached for 2 h. If a refresh fails, the previous copy is
served for up to 24 h with `stale: true`. Elements that old still place a GPS satellite within a
few kilometres of its true position, which makes no difference at 20 000 km.
