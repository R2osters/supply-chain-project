/**
 * CelesTrak groups this API will fetch. An allow-list, not a pass-through: each group costs
 * CelesTrak bandwidth, and a free-form parameter would let any caller make us download the
 * 10 000-object `active` catalogue on their behalf.
 */

export interface SatelliteGroup {
  id: string;
  label: string;
  description: string;
}

export const SATELLITE_GROUPS: readonly SatelliteGroup[] = [
  { id: 'gps-ops', label: 'GPS (operational)', description: 'US Global Positioning System satellites in service.' },
  { id: 'galileo', label: 'Galileo', description: 'European Union GNSS constellation.' },
  { id: 'glo-ops', label: 'GLONASS (operational)', description: 'Russian GNSS constellation in service.' },
  { id: 'beidou', label: 'BeiDou', description: 'Chinese GNSS constellation, including its geostationary members.' },
  { id: 'stations', label: 'Space stations', description: 'ISS, Tiangong and visiting vehicles.' },
  { id: 'weather', label: 'Weather', description: 'Meteorological satellites (GOES, Meteosat, NOAA, Metop and others).' },
  { id: 'resource', label: 'Earth resources', description: 'Earth-observation satellites (Landsat, Sentinel and others).' },
  { id: 'geo', label: 'Geostationary', description: 'Active satellites in geostationary orbit, mostly communications.' },
  { id: 'iridium-NEXT', label: 'Iridium NEXT', description: 'Low-orbit satellite phone and data constellation used by trackers off-grid.' },
];

export const CELESTRAK_ATTRIBUTION = 'CelesTrak (celestrak.org), Dr. T.S. Kelso';

export function isKnownGroup(id: string): boolean {
  return SATELLITE_GROUPS.some((group) => group.id === id);
}
