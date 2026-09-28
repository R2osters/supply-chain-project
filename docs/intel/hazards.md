# Hazards

Live natural hazards (tropical cyclones, earthquakes, wildfires, severe weather) on the map, the
weather at any point, which of the company's sites and shipments sit near a hazard, and recent
news for a place. Everything is keyless except fires.

Module: `apps/api/src/modules/hazards/` (`HazardsModule`, exports `HazardsService`).
Permission: `gps:read` on every route.

## Endpoints

| Route | Returns |
| --- | --- |
| `GET /hazards?minLat=&minLon=&maxLat=&maxLon=` | `{ generatedAt, sources, hazards }`. The box is optional; give all four edges or none. Without it: worldwide cyclones and earthquakes. With it: those inside the box (a cyclone whose forecast track enters the box counts) plus fires. `minLon > maxLon` means the box crosses 180°. |
| `GET /hazards/weather?lat=&lon=` | Current conditions and a 0..1 `severity` with `reasons`. Coordinates returned are those of the 0.1° cell the observation came from. `503` only when there is neither fresh nor cached data. |
| `GET /hazards/exposure` | `{ radiusKm, generatedAt, exposures, sources }` for the caller's company. |
| `GET /hazards/news?q=` or `?lat=&lon=` | `{ status, query, articles, attribution: 'GDELT Project' }`. Prefer `q`. With only a point, the nearest active cyclone or earthquake within ~500 km names the place; if there is none, `status` is `UNAVAILABLE` with an empty `query`. |

Every hazard has the same shape whatever its source: `id`, `kind`, `title`, `severity`,
`severityScore`, `latitude`, `longitude`, `radiusKm`, `observedAt`, `source`, `url`, `details`,
and for cyclones `track` (forecast points) and `cone` (polygon rings as `[lon, lat]`).

Each source reports its own `SourceStatus` (`OK`, `STALE`, `UNAVAILABLE`, `DISABLED`, with a
`note`). One source failing never fails the response: the map shows what it has and says what is
missing.

## Sources

| Source | What | Key | Cache (fresh / served stale up to) |
| --- | --- | --- | --- |
| NOAA National Hurricane Center | `CurrentStorms.json` for position and intensity; the tropical-weather-summary MapServer for forecast points, track line and cone | none | 5 min / 60 min |
| USGS Earthquake Hazards Program | `summary/2.5_day.geojson`: every M2.5+ event in the past day | none | 5 min / 60 min |
| NASA FIRMS | Area CSV, VIIRS NOAA-20 near-real-time, trailing 24 h | `FIRMS_MAP_KEY` | 30 min / 2 h, per area |
| Open-Meteo | `/v1/forecast?current=…` at a point, snapped to 0.1° (~11 km) | none | 10 min / 60 min, per cell |
| GDELT DOC 2.0 | `artlist` mode, 72 h, up to 10 articles | none | 15 min / 2 h, per query |

Notes per source:

- **NHC.** Cone and forecast track are attached only when their advisory number matches the
  storm's current advisory, so a previous advisory's cone is never drawn under a newer position.
  If the geometry layers fail, storms are still returned with `details.geometry = 'unavailable'`.
  Forecast point times are the storm position time plus the forecast hour.
- **USGS.** Events without a magnitude are dropped (they cannot be shown to meet M2.5).
- **FIRMS.** Never queried for the world (a two-day world pull is >100 000 rows). Only for the
  map box, clamped to its central 15°×15° (the status note says when), or for boxes around the
  company's sites, grouped on a 5° grid and capped at 12 boxes. At most 20 000 rows are parsed per
  area. Low-confidence VIIRS pixels (mostly sun glint and hot roofs) are dropped, and the rest
  are clustered on a 0.1° grid: one FIRE hazard per cluster with its detection count and total
  fire radiative power. The map key is part of the URL and is never logged. Without a key the
  source is `DISABLED` and no request is made.
- **Open-Meteo.** Zone-less timestamps are read as UTC. The exposure pass checks at most 40
  weather cells, warehouses first.
- **GDELT.** At most one request every 5 s (GDELT answers faster callers with a plain-text refusal),
  at most 4 waiting; beyond that the answer is `UNAVAILABLE` rather than a long wait. Only
  http(s) article links are returned. The reference implementation also used Google News RSS;
  that feed is for personal, non-commercial use and was deliberately not adapted.

## Severity

All sources map to one `severityScore` in 0..1 and then to four levels with the same cut-offs:
`CRITICAL` ≥ 0.85, `HIGH` ≥ 0.6, `MEDIUM` ≥ 0.35, else `LOW`. The score orders a list; it is not
a probability, and a HIGH earthquake and a HIGH cyclone are only roughly comparable.

| Kind | Score from | Footprint (`radiusKm`) |
| --- | --- | --- |
| Cyclone | Saffir–Simpson wind bands: depression LOW, tropical storm MEDIUM, hurricane HIGH, Cat 3+ (≥ 96 kt) CRITICAL | 100 / 200 / 250 / 300 km by band |
| Earthquake | Magnitude, linear from M2.5 (0) to M7.5 (1). A USGS PAGER alert (yellow/orange/red) raises the level to at least MEDIUM/HIGH/CRITICAL; a tsunami flag to at least HIGH | 20 km below M4, 50, 100, 200, 400 km at M7+ |
| Fire | Total fire radiative power of the cluster, log scale (~30 MW field burn, ~300 MW serious fire, ~3 000 MW firestorm) | 10 km |
| Severe weather | `computeWeatherSeverity` ≥ 0.6 at an asset's cell | 10 km |

Footprints are coarse heuristics for matching, not damage models. Real cyclone wind radii are
asymmetric and published per quadrant; the cone and track carry the real spatial uncertainty.

**Weather severity** (`weather-severity.ts`) combines four factors, each 0..1: the WMO weather
code (thunderstorm, hail, freezing rain, heavy snow, fog), wind gusts (sustained wind if no gust
is reported), precipitation and visibility. `severity = worst + 0.25 × (sum of the others)`,
capped at 1: one dangerous factor is enough to stop a truck, and the others compound it a little.
Thresholds are operational rules of thumb (high-sided vehicles are restricted from about 75 km/h
gusts; port cranes stop around 70 km/h), listed in `reasons` so they can be argued with.

## Exposure

Assets: active warehouses, active suppliers that have coordinates, and shipments in `DEPARTED`,
`IN_TRANSIT` or `DELAYED`. A shipment counts at its last GPS fix and at its destination; with no
fix yet, at its origin and destination (the label says which).

An asset is exposed when `distance ≤ HAZARD_EXPOSURE_RADIUS_KM (default 150) + hazard.radiusKm`.
For a cyclone the distance is to the nearest of its position and forecast track points, so a
storm forecast to reach a warehouse in 48 h is reported now. Each hazard/asset pair appears once,
at its closest point. Sorted by severity, then distance.

## Use by the AI service

- **Delay prediction** sends the Open-Meteo severity at the shipment's last GPS fix as
  `weatherSeverity`. With no fix, or when Open-Meteo is down, it sends 0 — an optimistic fallback,
  chosen because a free weather API must never block a prediction.
- **Risk analysis** sends the company's exposures as `hazards`. Cyclones and severe weather become
  `WEATHER_RISK` findings, earthquakes and fires `NATURAL_HAZARD` findings (a new category, weight
  5 in the health score, taken from `DEMAND_RISK` which went from 15 to 10). One finding per
  hazard, attached to the closest asset. When no hazard feed answered, the field is omitted
  (not sent empty), and the analysis's assumptions say no live feed was supplied.

## Licences and attribution

Show the `attribution` of each `SourceStatus` wherever the data is shown.

- **NOAA / NWS National Hurricane Center.** U.S. Government work, public domain. Credit
  "NOAA/NWS National Hurricane Center".
- **USGS.** U.S. Government work, public domain. Credit "U.S. Geological Survey".
- **NASA FIRMS.** Free and open; NASA asks for this acknowledgement: "We acknowledge the use of
  data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS)
  (https://earthdata.nasa.gov/firms), part of NASA's Earth Science Data and Information System
  (ESDIS)." The MAP_KEY quota is 5 000 transactions per 10 minutes.
- **Open-Meteo.** Data under CC BY 4.0; attribution with a link to https://open-meteo.com/ is
  required. **The free API is for non-commercial use.** A commercial deployment needs an
  Open-Meteo API subscription (the customer endpoint and an `apikey` parameter), which this
  module does not configure yet.
- **GDELT.** Free for any use including commercial, with citation: credit "The GDELT Project"
  and link to https://www.gdeltproject.org/. Article titles and links belong to their publishers;
  only titles and links are shown.

Parts of this module are adapted from God's Eye View (MIT licence); each adapted file says which
file it came from.

## Limits

- NHC covers the Atlantic and the eastern/central North Pacific only. West Pacific typhoons,
  North Indian Ocean and Southern Hemisphere cyclones are not in this feed; the NHC source note
  always says so.
- USGS `2.5_day` is the past 24 hours; older aftershock sequences drop off.
- FIRMS near-real-time detections arrive about 3 h after the satellite pass, and a satellite sees
  a given place only a few times a day. Clouds hide fires.
- Open-Meteo "current" is a model analysis, not a station reading.
- GDELT searches text. A place with a common name returns unrelated stories; `lat/lon` without `q`
  only resolves near an active cyclone or earthquake.
- All caches are in memory, per API instance. A restart starts cold.
