# Public traffic cameras

An operator sees a truck stopped for twenty minutes, or a route flagged as blocked, and wants to
look at the road. Several road agencies publish still cameras for free. The API keeps their
catalogues in memory and relays one frame at a time on request.

Module: `apps/api/src/modules/cameras/` (`CamerasModule`). Permission: `gps:read`.

## Endpoints

| Route | Returns |
| --- | --- |
| `GET /cameras?minLat=&minLon=&maxLat=&maxLon=&limit=` | `{ cameras, packs }` for cameras inside the box. Give all four bounds or none. `limit` defaults to 500, max 2000. When the limit cuts the list, the cameras nearest the centre of the box are kept. `minLon > maxLon` means the box crosses the antimeridian. |
| `GET /cameras/near?lat=&lon=&radiusKm=&limit=` | `{ cameras, packs }`, nearest first, each with `distanceKm`. `radiusKm` defaults to 25, max 500. |
| `GET /cameras/:id` | One `Camera`, or 404. |
| `GET /cameras/:id/frame` | The JPEG or PNG bytes, with `Cache-Control: private, max-age=10`. Throttled to 600 requests a minute per client. |

Camera ids look like `<pack>:<upstreamId>` (e.g. `tfl:00001.01251`). The client encodes them with
`encodeURIComponent`. The server accepts only `^[a-z0-9]+:[A-Za-z0-9._-]+$`.

Each entry in `packs` reports `OK`, `STALE` or `UNAVAILABLE`:

- `STALE`: the provider is failing and the API is serving its last good catalogue, for up to 6 hours.
- `UNAVAILABLE`: the API has no usable catalogue for that pack.

The frontend should show the status to the operator and should not hide a failing pack.

## Packs

Only the packs listed in `CAMERA_PACKS` (config `intel.cameraPacks`) are loaded. Every pack is
keyless. Each catalogue is cached for 15 minutes. One pack failing does not affect the others.

| Id | Source | Licence | Attribution that must be shown | Notes |
| --- | --- | --- | --- | --- |
| `tfl` | Transport for London JamCams (`api.tfl.gov.uk/Place/Type/JamCam`) | TfL Open Data terms | "Powered by TfL Open Data. Contains OS data © Crown copyright and database rights" | Frames come from TfL's public S3 bucket. The host is shared with other buckets, so frame paths are also pinned to `/jamcams.tfl.gov.uk/`. No facing. |
| `fintraffic` | Fintraffic / Digitraffic weather cameras (`tie.digitraffic.fi/api/weathercam/v1/stations`) | CC BY 4.0 | "Fintraffic / digitraffic.fi, license CC BY 4.0" | Sends the `Digitraffic-User` header the service asks for. One preset (fixed view) is one camera. Frame URLs are built from the preset id. New pictures about every 10 minutes. |
| `ontario511` | Ontario 511 (`511on.ca/api/v2/get/cameras`) | Open Government Licence – Ontario | "Ontario 511. Contains information licensed under the Open Government Licence – Ontario" | **As of 2026-09 this endpoint answers `400 Invalid Key` without a developer key, so the pack reports UNAVAILABLE.** Supporting a key needs a config entry. |
| `drivebc` | DriveBC (`www.drivebc.ca/api/webcams/`) | Open Government Licence – British Columbia | "DriveBC. Contains information licensed under the Open Government Licence – British Columbia" | Frame URL is built from the numeric id (`/images/<id>.jpg`). The DataBC CSV still lists retired `images.drivebc.ca` URLs, which return a placeholder picture. |
| `nsw` | Live Traffic NSW (`data.livetraffic.com/cameras/traffic-cam.json`) | CC BY 4.0 | "Live Traffic NSW — Transport for NSW, CC BY 4.0" | The image host sends non-browser clients an HTML page instead of the picture. Frame requests to that host alone use a browser User-Agent. |
| `calgary` | Open Calgary, dataset `k7p9-kppz` | Open Government Licence – City of Calgary | "Contains information licensed under the Open Government Licence – City of Calgary" | Rows publish `http://` URLs that redirect to https, so they are upgraded before fetching. The `quadrant` field and the "SE" suffix in names are street addresses, not a facing. No heading is derived from them. |

Every `Camera` carries its pack's `attribution`. The frontend must show it next to the picture.

Last live check (2026-09-28): tfl 812, fintraffic 2 260, drivebc 1 046, nsw 240 and calgary 217
cameras, each returning a real JPEG frame. ontario511 returned 400 (key required).

The pack normalisers are adapted from God's Eye View (MIT), `server/providers/cctv/`.

## SSRF design

The frame endpoint is the one place where a browser request makes the server fetch a URL. It is
built so that the client never controls that URL:

1. **The client sends a camera id, never a URL.** The upstream frame URL comes from a server-side
   registry built from the catalogues. The URL is kept in a separate map and is never serialised,
   so a client never sees one it could send back.
2. **Normalisers pin URLs when a catalogue is loaded.** Where possible, a frame URL is rebuilt from
   a validated id on a fixed host (Fintraffic, DriveBC, Ontario). Otherwise its scheme, host and
   path are checked (TfL, NSW, Calgary).
3. **Every URL is checked again right before the fetch** (`frame-guard.ts`):
   - https only. `http` is upgraded only for packs documented to redirect to https (Calgary).
   - The hostname must exactly match the pack's `frameHosts`.
   - Only the default port is allowed, with no credentials in the URL.
   - The path must start with the pack's prefix, where one is set.
   - A URL that fails is refused and logged. It is never fetched.
4. **The fetch itself is limited:**
   - Redirects are refused, since a redirect would reach a host nobody checked.
   - 10 s timeout.
   - 3 MiB byte cap, enforced while streaming.
   - A response whose Content-Type is text or HTML is dropped before its body is read.
5. **Only real images are relayed.** The bytes must start with a JPEG or PNG signature. The
   Content-Type we send is derived from those bytes, never copied from upstream. Anything else
   becomes `502` with a generic message. Upstream bodies and hosts are never echoed to the client.
6. **Frame cache:** 10 seconds, at most 64 entries, in memory only. It is shared per camera, so many
   operators watching the same junction cost one upstream request every 10 s.

Catalogue fetches also refuse redirects, are capped at 16 MiB and time out after 20 s.

## Privacy

Frames are relayed exactly as the provider serves them and are never stored: no disk, no
database, only a 10-second in-memory cache. Nothing in this module blurs, enhances, or analyses a
frame. There is no face recognition, no licence-plate recognition, and no object detection. The
feature is for looking at road conditions, not at people.
