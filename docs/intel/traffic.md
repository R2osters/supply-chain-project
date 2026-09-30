# Live road traffic

Road traffic on the live map, everywhere in the world, as in God's Eye View, with the user's own
fleet always told apart from the traffic around it.

No public source gives the position of every car. So, like God's Eye View, the general traffic
is **simulated**: dots drive along real roads at plausible speeds. What is real is the **measured
speed** of the roads that have a source, which sets those roads' colour, speed and density, and
the **fleet**, whose positions come from its GPS trackers. The map says so in its legend (fleet:
GPS trackers, real; traffic: simulated; congestion: measured) and in the status line under the
Traffic switch, which names the measured sources in view, or says speeds are estimated when there
are none.

The Situation page is unchanged: it keeps the TomTom raster overlay.

| Part | Where |
| --- | --- |
| API | `apps/api/src/modules/traffic/` (`TrafficModule`), keyless sources in `open-flow/`. Permission: `gps:read`. |
| Simulation (pure, no map) | `apps/web/src/lib/traffic/`: `flow-level.ts`, `roads.ts`, `flow-match.ts`, `simulation.ts` |
| Map wiring | `apps/web/src/app/(app)/map/_components/`: `road-traffic-layer.ts` (WebGL), `use-road-traffic.ts` |

## What the live map shows

| Element | Zoom | Rendering |
| --- | --- | --- |
| Simulated traffic | 12 and above | Small dots moving along the roads in their direction of travel. Grey on a road with no measurement; green, orange or red on a measured one. At most 6000 dots, major roads served first. |
| Measured congestion | 10 and above | A thin green, orange or red line under the dots, on measured sections only. A closed road is a dashed red line with no dots. |
| Fleet | all | HTML markers above the map, so always above the traffic. |
| Aircraft, vessels | all | Above the traffic: the traffic layer is inserted below them. |

The Traffic switch drives the simulation and the congestion lines. It is on by default and the
choice is remembered in the browser. The animation stops when the switch is off, below zoom 12,
or when the tab is hidden; a frame longer than 0.25 s is capped so cars never jump across the map
after a tab switch.

## How the simulation works

**Roads.** The map loads OpenFreeMap vector tiles and reads their `transportation` layer. Kept
classes, with the free-flow speed and density weight each gets:

| Class | Free speed (km/h) | Density weight |
| --- | --- | --- |
| `motorway` | 110 | 1 |
| `trunk` | 90 | 0.8 |
| `primary` | 70 | 0.6 |
| `secondary` | 60 | 0.45 |
| `tertiary` | 50 | 0.3 |
| `minor` | 40 | 0.12 |
| `service` (zoom 15 and above only) | 20 | 0.05 |

Everything else (`path`, `track`, `rail`, `transit`, `ferry`, `raceway`, `busway`, unknown
classes) is dropped. `oneway` is read as 1 (drawing order), -1 (against it) or two-way. A road
returned by several tiles is counted once.

**Matching measurements to roads.** Measured lines never share vertices with OSM roads. Each road
is sampled every 20 m; each sample takes, per direction, the nearest measured segment within 25 m
whose heading agrees with the road's (forward) or opposes it (backward) within 35°. A direction
is measured when at least 40 % of the road's samples found a segment; its level is the median of
the levels found, it is closed when most samples are closed, and its source is the most frequent
one. Choosing the nearest segment per direction matters on dual carriageways: Rennes publishes
each direction as its own line about 12 m from the other, and a two-way OSM road drawn down the
middle takes each direction's level from its own carriageway.

**Dots.** Each circulated direction of a road gets
`length × density weight × zoom factor × congestion density / 80` dots, where the zoom factor is
2^(zoom − 14), kept between 0.25 and 2. OSM splits streets at every junction, so a short side
street expects a fraction of a dot; the count is rounded up with a probability equal to that
fraction, drawn from a hash of the road, so the total is right on average and does not flicker
when the view moves. Dots move at the free speed times the measured speed factor, ±15 % per dot,
and loop at the end of the road. A closed direction has no dots. Dots on roads still in view keep
their place when the map moves.

## One level for every source

Every source is turned into one `level`: current speed over free-flow speed, 0 to 1 (1 = free
flow), or `null` when nothing was measured.

| Source | Level |
| --- | --- |
| TomTom | `traffic_level` as published; `road_closure = true` means closed. |
| Rennes | `min(1, averagevehiclespeed / vitesse_maxi)` when both are positive; otherwise from `trafficstatus`: `freeFlow` 0.9, `heavy` 0.6, `congested` 0.3. `unknown`, or zero probe vehicles, means not measured. |
| Grenoble | `nsv_id` 1 → 0.9, 2 → 0.6, 3 → 0.3, 4 → closed; 0 or anything else means not measured. |

Colours: a level of 0.85 or more is green, 0.55 or more orange, below that red. The level also
slows the dots (never below 15 % of the free speed, so a jam crawls rather than freezes) and packs
them (`1 / max(level, 0.4)`, so up to 2.5 times denser). An unusable level is "not measured":
grey, free speed, base density, never a phantom jam. Adapted from God's Eye View (MIT),
`src/data/trafficFlowStyle.js`.

## Endpoints

| Route | Returns |
| --- | --- |
| `GET /traffic/status` | `{ enabled, provider, tilesUsedToday, dailyBudget, attribution, note, sources }`. The first six keep their meaning (the Situation page reads them); `dailyBudget` 0 means unlimited. `sources` lists `tomtom`, `rennes` and `grenoble` as `{ id, active, stale, updatedAt, attribution }`. |
| `GET /traffic/open-flow?bbox=minLon,minLat,maxLon,maxLat` | GeoJSON `FeatureCollection` of `LineString`s with `{ id, source, level, closed, speedKmh, limitKmh, bothDirections }`, at most 5000, `Cache-Control: private, max-age=60`. |
| `GET /traffic/tiles/:z/:x/:y` | TomTom raster flow tile for the Situation page: a 256 px PNG, `Cache-Control: private, max-age=120`. |
| `GET /traffic/flow-tiles/:z/:x/:y` | TomTom vector flow tile for the live map (`application/vnd.mapbox-vector-tile`), `Cache-Control: private, max-age=120`. Layer `Traffic flow`: `traffic_level`, `road_type`, `road_closure`, `traffic_road_coverage`. |
| `GET /settings/traffic` | `{ dailyTileBudget, from }`: the budget in force and `'settings'` when it was chosen in the settings screen, `'default'` otherwise. Permission `company:update`. |
| `PUT /settings/traffic` | Body `{ dailyTileBudget }`: a whole number from 0 to 10 000 000, or `null` to go back to the default. Applies at once, no restart. Permission `company:update`, audited as `settings.traffic.update`. |

Status sources: TomTom is `active` when a key is set and today's budget is not spent. A keyless
source is `active` when it answered its last request (fresh or from its grace period, then
`stale: true`); a source nobody has looked at yet is reported inactive.

Open-flow: `bbox` must be valid, not inverted and at most 5° wide, or the answer is 400. A source
whose area does not overlap the box is not called at all, so a view over Accra costs nothing to
Rennes or Grenoble. A failing source leaves the others untouched and shows as inactive.

Tile responses (both tile routes):

- 404 when no key is configured (`enabled: false` in status);
- 400 for invalid coordinates (`z` 0 to 22, `x` and `y` integers from 0 to 2^z − 1);
- 429 once today's budget is spent and the tile is not cached;
- 502 when TomTom fails.

The tile routes allow 1200 requests per minute per client, because one map view loads dozens of
tiles at a time.

## Sources and licences

| Source | Area | Key | Data | Refresh | Licence and attribution |
| --- | --- | --- | --- | --- | --- |
| OpenFreeMap, `https://tiles.openfreemap.org/planet` | world | no | road geometry (`transportation`) | vector tiles, cached by the map | © OpenMapTiles, data © OpenStreetMap contributors (ODbL) |
| Rennes Métropole, "Etat du trafic en temps réel" | Rennes | no | about 2 860 sections: speed, limit, status, geometry | 3 min | ODbL. "Trafic Rennes © Rennes Métropole (ODbL)" |
| Métromobilité (SMMAG), `/api/dyn/trr/json` and `/api/lines/json?types=trr` | Grenoble | no | 253 public sections (`visible_internet = 1`): service level and geometry | levels 60 s, geometry 24 h | ODbL. "Trafic Grenoble © Métromobilité / SMMAG (ODbL)" |
| TomTom Traffic Flow, vector `relative` and raster `relative0` tiles | world | yes | relative speed per road line | 120 s | TomTom developer terms of the key. "Traffic © TomTom" |

**Rennes**
(`https://data.rennesmetropole.fr/api/explore/v2.1/catalog/datasets/etat-du-trafic-en-temps-reel/exports/geojson`)
draws every line in its direction of travel: one-way sections once, two-way roads as a `_D` / `_G`
pair about 12 m apart, so `bothDirections` is false. Two traps, both seen in the live data on
30 September 2026:

- its `unknown` lines still carry a speed and a limit (often 80 / 80) with zero probe vehicles.
  Read as a ratio they would pass for free-flowing measured roads, so `unknown` or no probe means
  not measured, before anything else;
- about one line in six reports a speed above its limit (504 of 2 859), so the ratio is capped
  at 1.

**Grenoble.** The meaning of `nsv_id` (0 unknown, 1 free, 2 heavy, 3 congested, 4 blocked) comes
from Métromobilité's own code (`MetromobiliteWS`, `trrC38.js`). Levels and lines are joined by
the section code. The drawing direction of its sections is not reliable, so `bothDirections` is
true: a level applies to both directions of the road. These two routes need no `origin` header;
only the timetable routes of the same API do.

**TomTom.** The free allowance is **monthly**. When this was written it was about 200 000
Traffic tile requests per month; check the current figure on the TomTom pricing page. The raster
and vector routes share one daily budget and one counter. The default of 6000 tiles a day keeps
a 31-day month (186 000) under that allowance; a map without a limit can use up a month's
allowance in a few days.

## Configuration

- **TomTom key**: pasted by the user in Settings → Data sources, or `TOMTOM_API_KEY`, or a key
  bundled in a build. The settings screen wins over the environment, which wins over the bundled
  key. Without any key the live map still shows the simulation and the keyless measurements; the
  TomTom routes answer 404 and make no network calls.
- **Daily tile budget**: chosen in Settings → Data sources (stored as `tomtomDailyTileBudget`
  in the settings file), otherwise `TOMTOM_DAILY_TILE_BUDGET`, otherwise 6000. `0` means
  unlimited; the screen warns that past the free allowance TomTom bills the tiles or refuses
  them. A change applies to the next tile, without a restart.

Every upstream attempt counts against the budget, because TomTom bills it whether or not a tile
comes back. Cache hits are free. The counter lives in memory, so it resets when the API restarts
and each instance has its own. Set the budget per instance to allow for this.

## Caching

- **TomTom tiles**, raster and vector together: cached in memory for 120 s, up to 512 tiles,
  which is a few MB. If TomTom fails or the budget is spent, a cached tile up to 10 minutes old
  is served. A 200 response that is not a tile (not `image/png` for raster; not
  `application/vnd.mapbox-vector-tile`, `application/x-protobuf` or `application/octet-stream`
  for vector) or larger than 1 MB is refused and not cached.
- **Keyless sources**: no database table. Each source keeps its last good answer in memory and is
  fetched only when a map view needs it, with no timer running when nobody looks. Concurrent
  requests share one upstream call. Rennes is fresh for 3 minutes; Grenoble's levels for 60 s
  and its geometry for 24 hours. When a source fails, its last answer is served, marked `stale`,
  for up to 10 minutes (7 days for Grenoble's geometry); after that the source is inactive and its
  roads go back to "estimated".

## Key handling

The user pastes their own TomTom key in Settings → Data sources; the repository holds none. It is stored in
the settings file next to the database, and the screen only ever shows its last four characters.
The key is read on every tile, so a new key works without a restart. It is only used to build the
upstream URL: it never appears in responses, upstream errors contain only the host and status,
and log lines are redacted (raw and URL-encoded) as a safeguard. Tests check this.

A key bundled into a personal installer (`apps/desktop/keys.local.json`, never committed) can be
read by anyone who has the installer. The keyless sources need no key at all.
