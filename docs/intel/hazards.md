# Hazards

Live natural hazards (tropical cyclones, earthquakes, wildfires, floods, droughts, volcanic
eruptions, severe weather) on the map, the weather at any point, which of the company's sites and
shipments sit near a hazard, and recent news for a place. Everything is keyless. A NASA FIRMS map
key is optional: with one, FIRMS satellite hotspots supply the fires; without one, GDACS forest
fires and NASA EONET wildfires do.

Module: `apps/api/src/modules/hazards/` (`HazardsModule`, exports `HazardsService`).
Permission: `gps:read` on every route.

## Endpoints

| Route | Returns |
| --- | --- |
| `GET /hazards?minLat=&minLon=&maxLat=&maxLon=` | `{ generatedAt, sources, hazards }`. The box is optional; give all four edges or none. Without it: every global feed worldwide — cyclones, earthquakes, floods, droughts, eruptions, and GDACS/EONET fires when no FIRMS key is set. With it: those inside the box (a cyclone whose forecast track enters the box counts) plus FIRMS fires when a key is set. `minLon > maxLon` means the box crosses 180°. |
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
| GDACS (EC JRC / UN OCHA) | `gdacsapi/api/events/geteventlist/SEARCH`, three queries: cyclones + floods + eruptions (last 10 days), droughts (last 45 days), forest fires (last 3 days, only without a FIRMS key) | none | 20 min / 3 h, per query |
| NASA EONET v3 | `api/v3/events?status=open&category=wildfires&days=14` | none | 30 min / 3 h; only without a FIRMS key |
| NASA FIRMS | Area CSV, VIIRS NOAA-20 near-real-time, trailing 24 h | `FIRMS_MAP_KEY` (optional) | 30 min / 2 h, per area |
| Open-Meteo | `/v1/forecast?current=…` at a point, snapped to 0.1° (~11 km) | none | 10 min / 60 min, per cell |
| GDELT DOC 2.0 | `artlist` mode, 72 h, up to 10 articles | none | 15 min / 2 h, per query |

Which feed supplies fires is decided on every request from the FIRMS key (settings screen first,
then `FIRMS_MAP_KEY`): with a key, FIRMS only, and EONET reports `DISABLED`; without one, GDACS
forest fires and EONET wildfires, and FIRMS reports `DISABLED` with a note saying so.

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
- **GDACS.** The search endpoint returns history as well as live events, 100 per page (its
  maximum) ordered by the latest episode date, and a bare `204` when nothing matches. So each query
  asks for a recent window, pages are read one after another until a page comes back short (at
  most 3 pages), and liveness is judged on our side: a cyclone is live while GDACS flags it current
  and its last advisory is under 2 days old, a flood under 7 days, an eruption under 14 days, a
  forest fire under 3 days. Droughts are different: GDACS leaves `iscurrent` false on most live
  droughts while its own map shows the whole latest assessment, so a drought is live when it is
  within 5 days of the newest drought update (and under 45 days old). GDACS earthquakes are never
  requested (USGS is the better source). The three queries run in parallel and fail independently;
  the status note names the part that is missing. Only links to GDACS's own report pages are passed
  on. The event point is GDACS's centroid; no polygon or track is fetched.
- **NASA EONET.** EONET leaves wildfires "open" for years (7 000+ open, most untouched for a year
  or more), so only events observed in the last 14 days are asked for, and the window is checked
  again here. In practice they are US incidents from IRWIN, each a point with its size in acres.
  Prescribed burns (IRWIN "Prescribed Fire … RX") are planned fires, not hazards, and are dropped;
  so are EONET's copies of GDACS fires (GDACS is read directly). The link is the incident record
  at the source, else EONET's event page.

## Overlapping feeds

Two keyless feeds can describe the same event. One copy is dropped before the map, the exposure
list or the risk engine sees it (`hazard-merge.ts`):

- **Cyclones: NHC basins go to NHC.** NHC's basins are the North Atlantic and the eastern and
  central North Pacific, i.e. north of the equator and west of the prime meridian
  (`latitude ≥ 0 and longitude < 0`). There NHC publishes the forecast track and cone and GDACS
  only a position, so a GDACS cyclone in that area is dropped whenever NHC answered (fresh or
  stale). When NHC is down they are kept, so a hurricane never disappears because one feed failed.
  Everywhere else (West Pacific, North Indian Ocean, Southern Hemisphere) GDACS is the only
  cyclone source. The NHC status note says which applies: "cyclones in other basins come from
  GDACS" while GDACS answers, the original "not included" caveat when it does not.
- **Fires: GDACS and EONET, kept once.** A GDACS forest fire and an EONET wildfire are the same
  fire when `distance ≤ max(15 km, r(GDACS burned area) + r(EONET burned area) + 5 km)`, where r is
  the radius of a disc of that area, and their dates overlap within 3 days. The copy with the better
  geometry is kept: perimeter polygon > multi-day track > point with a measured size > bare point.
  GDACS's search answer is a centroid with a burned area, and IRWIN's a point with a size, so on
  the usual tie GDACS is kept — its alert weighs the exposed population and its report page is
  public. The kept hazard names the other in `details.sameFireAs`.
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

| Kind (source) | Score from | Footprint (`radiusKm`) |
| --- | --- | --- |
| Cyclone (NHC) | Saffir–Simpson wind bands: depression LOW, tropical storm MEDIUM, hurricane HIGH, Cat 3+ (≥ 96 kt) CRITICAL | 100 / 200 / 250 / 300 km by band |
| Cyclone (GDACS) | GDACS alert (below), never below the storm's current class on the NHC scale: depression 0.2, tropical storm 0.45 (MEDIUM), hurricane/typhoon 0.7 (HIGH). The class is read from GDACS's severity text; its wind figure is the event's peak, shown as `peakWindKmh` but never scored | 100 / 200 / 250 km by class, 300 km on a Red alert |
| Earthquake (USGS) | Magnitude, linear from M2.5 (0) to M7.5 (1). A USGS PAGER alert (yellow/orange/red) raises the level to at least MEDIUM/HIGH/CRITICAL; a tsunami flag to at least HIGH | 20 km below M4, 50, 100, 200, 400 km at M7+ |
| Flood (GDACS) | GDACS alert | 50 / 75 / 100 / 150 km for LOW / MEDIUM / HIGH / CRITICAL (a GloFAS event is a river reach) |
| Drought (GDACS) | GDACS alert, one level lower: Green LOW, Orange MEDIUM, Red HIGH. GDACS's own words for drought alerts are minor / medium / high impact, and a slow-onset drought is never CRITICAL | Radius of a disc of the reported area (km²), kept within 100–500 km; 250 km without an area |
| Volcanic eruption (GDACS) | GDACS alert | 25 / 50 / 100 / 150 km by level (flows near, ash far) |
| Fire (FIRMS, with a key) | Total fire radiative power of the cluster, log scale (~30 MW field burn, ~300 MW serious fire, ~3 000 MW firestorm) | 10 km |
| Fire (GDACS, no key) | GDACS alert; the burned area is in the title and `burnedAreaHa` | Disc radius of the burned area + 5 km (smoke, closed roads), 10–50 km |
| Fire (EONET, no key) | Reported burned area, log scale: 1 000 ha 0.25 (LOW), 10 000 ha 0.5 (MEDIUM), 100 000 ha 0.75 (HIGH), 1 Mha 1 (CRITICAL); 0.2 when no size is given | As for GDACS fires |
| Severe weather (Open-Meteo) | `computeWeatherSeverity` ≥ 0.6 at an asset's cell | 10 km |

**GDACS alerts.** Each event carries two alerts: the event's overall alert (its worst episode so
far) and the latest episode's. The latest one is what is happening now, so it sets the level:
Red → CRITICAL, Orange → HIGH, Green → LOW, the same colours as USGS PAGER (droughts one level
lower, see the table). A Green episode of an event that peaked Orange or Red is MEDIUM: receding,
not over. The event's `alertscore` only
restates its colour (1, 2, 3); the episode's alert score has resolution (Green 0–1, Orange 1–2,
Red 2–3), so it places the score inside the level's band (LOW 0.10–0.34, MEDIUM 0.35–0.59, HIGH
0.60–0.84, CRITICAL 0.85–1). GDACS weighs the exposed population, so a large fire in empty bush
is Green: the exposure match, not the level, is what flags it next to an asset. The EONET area
scale is deliberately conservative for the same reason — GDACS rates most fires under 100 000 ha
Green, and IRWIN's median fire is a few hundred hectares.

Footprints are coarse heuristics for matching, not damage models. Real cyclone wind radii are
asymmetric and published per quadrant; the cone and track carry the real spatial uncertainty. A
GDACS point is the event's centroid: for a multi-country drought it can sit far from parts of the
affected area, which is why drought footprints are capped at 500 km rather than grown to the
full extent.

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
- **Risk analysis** sends the company's exposures as `hazards`. Cyclones, severe weather, floods
  and droughts become `WEATHER_RISK` findings; earthquakes, volcanic eruptions and fires
  `NATURAL_HAZARD` findings (a new category, weight 5 in the health score, taken from
  `DEMAND_RISK` which went from 15 to 10). One finding per hazard, attached to the closest asset.
  When no hazard feed answered, the field is omitted (not sent empty), and the analysis's
  assumptions say no live feed was supplied. The AI service validates `kind`
  (`services/ai/app/schemas.py`); a new hazard kind must be added there too, or risk analysis
  answers 422.

## Licences and attribution

Show the `attribution` of each `SourceStatus` wherever the data is shown.

- **NOAA / NWS National Hurricane Center.** U.S. Government work, public domain. Credit
  "NOAA/NWS National Hurricane Center".
- **USGS.** U.S. Government work, public domain. Credit "U.S. Geological Survey".
- **GDACS.** A cooperation framework of the European Commission (Joint Research Centre) and UN
  OCHA, published openly and keyless. Credit "GDACS — European Commission JRC / UN OCHA" (the
  source's attribution) and link to the event's GDACS report page (every GDACS hazard's `url`).
  GDACS alerts are automatic impact estimates, not official warnings; a national meteorological
  or civil-protection warning takes precedence.
- **NASA EONET.** NASA data are not copyrighted (public domain); credit "NASA Earth Observatory
  Natural Event Tracker (EONET)". Its wildfires are US incident records from IRWIN (US
  government data); the hazard links to the incident record.
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

- NHC covers the Atlantic and the eastern/central North Pacific only. Cyclones elsewhere come
  from GDACS, as a position without forecast track or cone; when GDACS is down they are missing,
  and the NHC source note says so.
- GDACS gives one point per event. Flood events carry no size, so their footprint comes from the
  alert level alone. GDACS lists fires from about 5 000 ha, or smaller ones only when they
  threaten people; EONET's open wildfires are essentially US (IRWIN) incidents. Without a FIRMS
  key, a small fire outside the US is not on the map.
- USGS `2.5_day` is the past 24 hours; older aftershock sequences drop off.
- FIRMS near-real-time detections arrive about 3 h after the satellite pass, and a satellite sees
  a given place only a few times a day. Clouds hide fires.
- Open-Meteo "current" is a model analysis, not a station reading.
- GDELT searches text. A place with a common name returns unrelated stories; `lat/lon` without `q`
  only resolves near an active cyclone or earthquake.
- All caches are in memory, per API instance. A restart starts cold.
