# Situational feeds

The **Situation** screen (`/situation`) and the live map show what is happening around the
network: natural hazards near warehouses and routes, public traffic cameras, local radio,
satellites overhead and live congestion. Tracking says where the cargo is; these feeds say what it
is driving into.

Most of this is adapted from [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view)
(MIT). Each adapted file names its source in its header. The MIT grant covers that project's
*code*; every data source below keeps its own licence, listed here and shown in the app's
**Sources** panel.

## Modules

Each feed is its own NestJS module under `apps/api/src/modules/`, owning its cache and its
upstream calls. None has database tables: everything is live or cached in memory.

| Module | Endpoints | Upstream | Key | Detail |
|---|---|---|---|---|
| `hazards` | `GET /hazards`, `/hazards/weather`, `/hazards/exposure`, `/hazards/news` | NOAA NHC, USGS, GDACS, NASA EONET, NASA FIRMS, Open-Meteo, GDELT | none (FIRMS optional) | [intel/hazards.md](intel/hazards.md) |
| `cameras` | `GET /cameras`, `/cameras/near`, `/cameras/:id`, `/cameras/:id/frame` | TfL, Fintraffic, Ontario 511, DriveBC, Live Traffic NSW, Open Calgary | none | [intel/cameras.md](intel/cameras.md) |
| `radio` | `GET /radio/stations`, `POST /radio/stations/:id/click` | Radio Browser | none | [intel/radio.md](intel/radio.md) |
| `satellites` | `GET /satellites/groups`, `/satellites/tle`, `/satellites/visible` | CelesTrak | none | [intel/satellites.md](intel/satellites.md) |
| `geocoding` | `GET /geocode`, `/geocode/reverse` | Photon, Nominatim | none | [intel/geocoding.md](intel/geocoding.md) |
| `traffic` | `GET /traffic/status`, `/traffic/open-flow`, `/traffic/flow-tiles/:z/:x/:y`, `/traffic/tiles/:z/:x/:y` | Rennes Métropole, Métromobilité (Grenoble), TomTom; roads from OpenFreeMap | none (TomTom optional) | [intel/traffic.md](intel/traffic.md) |

Configuration lives in the `intel` section of `apps/api/src/config/configuration.ts`; the
variables are documented in `.env.example`.

**Keyless by default.** Every hazard kind works out of the box, with no API key: cyclones (NHC
in its basins, GDACS elsewhere), earthquakes (USGS), floods, droughts and volcanic eruptions
(GDACS), fires (GDACS forest fires and NASA EONET wildfires) and severe weather (Open-Meteo). A
NASA FIRMS map key is optional: when one is set, in the settings screen or as `FIRMS_MAP_KEY`,
FIRMS satellite hotspots replace the GDACS and EONET fires, decided per request. Road traffic is
keyless too: simulated on OpenFreeMap roads everywhere, with measured speeds from Rennes and
Grenoble; a TomTom key adds measured speeds worldwide.

## Shared rules

Every connector goes through `apps/api/src/common/http/`:

- **Bounded reads.** A deadline on every request and a byte ceiling on every body, cancelled the
  moment it is crossed. Upstream bodies never appear in error messages.
- **Single flight and serve stale.** Concurrent requests for the same thing cost one upstream
  call. When a source fails, the last good answer is served for a bounded time and marked
  `stale`, and the UI says so.
- **Politeness.** Services with a published rate (Nominatim, GDELT) go through a request gate
  with a bounded queue, and every request carries an identifying User-Agent.
- **Honest status.** Each response carries per-source status (`OK`, `STALE`, `UNAVAILABLE`,
  `DISABLED`). An empty map must never be mistaken for "nothing happening".

## How it reaches decisions

- **Delay prediction** uses the Open-Meteo transport severity at the vehicle's last position
  instead of a fixed zero.
- **Risk analysis** receives the company's hazard exposures and reports them as `WEATHER_RISK`
  (cyclones, severe weather, floods, droughts) and `NATURAL_HAZARD` (earthquakes, eruptions,
  fires) findings.
- **Exposure** (`GET /hazards/exposure`) lists every warehouse, active shipment and supplier
  within `HAZARD_EXPOSURE_RADIUS_KM` of an active hazard. It is the default side panel of the
  Situation screen.

## Frontend

- `apps/web/src/app/(app)/situation/`: the screen, with one file per panel in `_components/`.
- `apps/web/src/lib/intel.ts`: wire types and small pure helpers.
- `apps/web/src/lib/motion.ts`: smooth marker motion (glide plus capped dead reckoning), used by
  the live map.
- `apps/web/src/lib/orbits.ts`: SGP4 propagation in the browser, so satellites move every
  second without a request per second.
- `apps/web/src/components/intel/camera-viewer.tsx`: shared by the Situation screen and the live
  map ("nearest cameras" for a selected vehicle).

## Licences that constrain commercial use

| Source | Constraint |
|---|---|
| GDACS | Published openly for disaster information, no key. Credit "GDACS — European Commission JRC / UN OCHA" and link to the event's GDACS report, as the Sources panel and each hazard's detail do. Alerts are automatic impact estimates, not official warnings: a national service's warning takes precedence. |
| NASA EONET | Public domain (NASA data are not copyrighted); NASA asks to be acknowledged. Its wildfires are US incident records from IRWIN, also US government data. |
| NASA FIRMS (optional) | Free with a personal map key and NASA's acknowledgement text. |
| Open-Meteo | CC BY 4.0: the attribution link must stay next to the weather it describes. The free API is for non-commercial use; commercial use needs their paid plan. |
| Radio Browser | The directory is public domain; each stream belongs to its broadcaster. Playing a stream exposes the listener's IP address to the broadcaster. |
| Public cameras | Each operator's licence applies (Open Government Licences, CC BY 4.0, TfL terms). All require attribution. Frames are relayed, never stored. |
| Photon, Nominatim | Fair use only: no bulk geocoding. Heavy use needs a self-hosted instance. |
| TomTom | Proprietary, your own key and quota. |
| GDELT | Citation required. Articles remain their publishers'. |

## What was deliberately not taken

- **The 3D globe (CesiumJS), cockpit and visual filters.** Too heavy for this product; MapLibre
  covers the need.
- **Google News RSS.** Its terms restrict it to personal, non-commercial use. GDELT covers local
  news instead.
- **OpenSky flights, submarine cables (TeleGeography), public OSRM servers.** These licences are
  non-commercial or restricted. Road routing keeps using `OSRM_URL`, which should point at our own
  instance.
- **Live HLS camera video.** Still frames already answer "is the road blocked", at a fraction of
  the bandwidth and without holding upstream video sessions open.
- **The voice agent.** A separate product decision, not a data feed.
