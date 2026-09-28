# Geocoding

Find a depot, port or town by name, or describe where a truck is. Uses keyless OpenStreetMap
services.

Module: `apps/api/src/modules/geocoding/` (`GeocodingModule`). Permission: `gps:read`.

## Endpoints

| Route | Returns |
| --- | --- |
| `GET /geocode?q=&limit=` | `{ source, results: [{ label, latitude, longitude, kind, country }] }`. `limit` defaults to 5, max 10. `source` is `coordinates`, `photon`, `nominatim` or `none`. |
| `GET /geocode/reverse?lat=&lon=` | `{ source, label, locality, region, country, countryCode }`. `source` is `nominatim` or `none`. |

## Order of lookup

1. **Coordinates.** `5.6, -0.18`, `5.6 -0.18`, `5.6;-0.18`, `5.6N 0.18W` and `33.87° S, 151.21° E`
   are answered locally, latitude first. At least one number must have a decimal point, so `10 20`
   is treated as text.
2. **Photon** (`https://photon.komoot.io/api/`, run by komoot). Tried first because it is built for
   search-as-you-type. Timeout 6 s.
3. **Nominatim** (`https://nominatim.openstreetmap.org/search`). Only called when Photon fails or
   finds nothing.

`source: none` with no results means no provider found the place, or none could be reached.
Failures are not cached; "not found" answers are.

Reverse lookups go straight to Nominatim at zoom 14 (suburb level). `source: nominatim` with null
fields means Nominatim found nothing there, for example at sea. `source: none` means it could not
be reached.

## Usage policies

- **Nominatim** ([policy](https://operations.osmfoundation.org/policies/nominatim/)): at most
  1 request per second for the whole application, an identifying `User-Agent` and `Referer`, and
  results must be cached. All Nominatim calls, forward and reverse, go through one process-wide
  gate spaced at 1.1 s. At most 10 callers can wait; more are turned away at once and get
  `source: none`. The `Referer` is the first entry of `CORS_ORIGINS`. If you run more than one API
  instance, the limit applies to all of them together; use a self-hosted Nominatim in that case.
- **Photon**: a free public instance with a fair-use policy and no published rate. Heavy use should
  move to a self-hosted Photon.
- Data © OpenStreetMap contributors, ODbL. Show "© OpenStreetMap contributors" wherever results
  are displayed.

## Caching

- Forward: 10 minutes per normalised query and limit. Identical concurrent searches share one
  upstream request.
- Reverse: 30 minutes per 0.01° cell (about 1 km). The request is made for the cell centre, so
  every position in a cell gets the same answer.
