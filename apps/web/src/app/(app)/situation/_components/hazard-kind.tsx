import { Activity, CloudLightning, Flame, Mountain, SunDim, Tornado, Waves, type LucideIcon } from 'lucide-react';
import type { Exposure, Hazard, HazardKind, HazardSeverity } from '@/lib/intel';
import type { TranslationKey } from '@/lib/i18n';
import type { ProvenanceKind, Severity } from '@/components/ui';
import type { FeedStatus, SourceStatus } from '@/lib/intel';

/**
 * Kind is carried by the pictogram, severity by colour and the severity icon's shape (charte
 * §03, §07). One table so the map sprites, the list and the detail panel never disagree.
 */
export const KIND_ICON: Record<HazardKind, LucideIcon> = {
  CYCLONE: Tornado,
  EARTHQUAKE: Activity,
  FIRE: Flame,
  SEVERE_WEATHER: CloudLightning,
  FLOOD: Waves,
  // SunDim, not Sun: the plain sun is the theme switch in the top bar.
  DROUGHT: SunDim,
  VOLCANO: Mountain,
};

export const KIND_KEY: Record<HazardKind, TranslationKey> = {
  CYCLONE: 'sit.kind.cyclone',
  EARTHQUAKE: 'sit.kind.earthquake',
  FIRE: 'sit.kind.fire',
  SEVERE_WEATHER: 'sit.kind.weather',
  FLOOD: 'sit.kind.flood',
  DROUGHT: 'sit.kind.drought',
  VOLCANO: 'sit.kind.volcano',
};

export const SEVERITY_KEY: Record<HazardSeverity, TranslationKey> = {
  LOW: 'sit.v3.sev.LOW',
  MEDIUM: 'sit.v3.sev.MEDIUM',
  HIGH: 'sit.v3.sev.HIGH',
  CRITICAL: 'sit.v3.sev.CRITICAL',
};

const SEVERITY_RANK: Record<HazardSeverity, number> = { CRITICAL: 3, HIGH: 2, MEDIUM: 1, LOW: 0 };

/** HIGH/CRITICAL → octagon, MEDIUM → triangle, LOW → neutral circle. */
export function hazardSeverity(severity: HazardSeverity): Severity {
  return severity === 'CRITICAL' || severity === 'HIGH' ? 'critical' : severity === 'MEDIUM' ? 'warning' : 'info';
}

/**
 * The ranking behind « Signaux classés »: what touches our network first, then how bad it is.
 * A moderate storm over a warehouse matters more to this operator than a strong quake at sea.
 */
export function rankHazards(hazards: Hazard[], exposures: Exposure[]): Array<{ hazard: Hazard; exposed: Exposure[] }> {
  const byHazard = new Map<string, Exposure[]>();
  for (const exposure of exposures) {
    const list = byHazard.get(exposure.hazardId) ?? [];
    list.push(exposure);
    byHazard.set(exposure.hazardId, list);
  }
  return hazards
    .map((hazard) => ({ hazard, exposed: byHazard.get(hazard.id) ?? [] }))
    .sort(
      (a, b) =>
        Number(b.exposed.length > 0) - Number(a.exposed.length > 0) ||
        SEVERITY_RANK[b.hazard.severity] - SEVERITY_RANK[a.hazard.severity] ||
        b.exposed.length - a.exposed.length ||
        b.hazard.severityScore - a.hazard.severityScore,
    );
}

/** A feed's state as the charte's provenance marker. Nothing here is simulated: the API never says so. */
export function feedProvenance(status: FeedStatus): ProvenanceKind {
  switch (status) {
    case 'OK':
      return 'poll';
    case 'STALE':
      return 'stale';
    default:
      return 'offline';
  }
}

/** The status row for the feed a hazard came from, matched on its label. */
export function sourceFor(hazard: Hazard, sources: SourceStatus[]): SourceStatus | undefined {
  const name = hazard.source.toLowerCase();
  return sources.find(
    (source) =>
      source.label.toLowerCase() === name ||
      name.includes(source.id.toLowerCase()) ||
      name.includes(source.label.toLowerCase()),
  );
}
