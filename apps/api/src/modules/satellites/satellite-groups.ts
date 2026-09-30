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
  { id: 'gps-ops', label: 'GPS (opérationnels)', description: 'Satellites du système de positionnement mondial américain en service.' },
  { id: 'galileo', label: 'Galileo', description: 'Constellation GNSS de l’Union européenne.' },
  { id: 'glo-ops', label: 'GLONASS (opérationnels)', description: 'Constellation GNSS russe en service.' },
  { id: 'beidou', label: 'BeiDou', description: 'Constellation GNSS chinoise, y compris ses satellites géostationnaires.' },
  { id: 'stations', label: 'Stations spatiales', description: 'ISS, Tiangong et véhicules en visite.' },
  { id: 'weather', label: 'Météo', description: 'Satellites météorologiques (GOES, Meteosat, NOAA, Metop et autres).' },
  { id: 'resource', label: 'Ressources terrestres', description: 'Satellites d’observation de la Terre (Landsat, Sentinel et autres).' },
  { id: 'geo', label: 'Géostationnaires', description: 'Satellites actifs en orbite géostationnaire, surtout de télécommunications.' },
  { id: 'iridium-NEXT', label: 'Iridium NEXT', description: 'Constellation en orbite basse de téléphonie et de données par satellite, utilisée par les balises hors réseau.' },
];

export const CELESTRAK_ATTRIBUTION = 'CelesTrak (celestrak.org), Dr. T.S. Kelso';

export function isKnownGroup(id: string): boolean {
  return SATELLITE_GROUPS.some((group) => group.id === id);
}
