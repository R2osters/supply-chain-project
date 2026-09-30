import { Logger } from '@nestjs/common';
import { intersects, overlaps, type Bbox } from './bbox';
import type { FlowSegment, OpenFlowProvider, OpenFlowSourceId } from './types';

/** A city at street level holds a few thousand lines; this bounds a response to a few MB. */
export const MAX_OPEN_FLOW_FEATURES = 5000;

export interface SourceStatus {
  id: 'tomtom' | OpenFlowSourceId;
  /** Answered on its last request (fresh or from its grace period). */
  active: boolean;
  stale: boolean;
  updatedAt: string | null;
  attribution: string;
}

export interface FlowFeature {
  type: 'Feature';
  geometry: { type: 'LineString'; coordinates: [number, number][] };
  properties: Omit<FlowSegment, 'coordinates'>;
}

export interface FlowFeatureCollection {
  type: 'FeatureCollection';
  features: FlowFeature[];
}

/**
 * Merges the keyless measured-speed sources for one map view. A source whose area is out of view
 * is not asked at all (a view over Accra costs no call to Rennes); a failing source leaves the
 * others untouched and shows as inactive in the status.
 */
export class OpenFlowService {
  private readonly logger = new Logger(OpenFlowService.name);
  private readonly outcomes = new Map<OpenFlowSourceId, Omit<SourceStatus, 'id' | 'attribution'>>();

  constructor(private readonly providers: OpenFlowProvider[]) {}

  async inBbox(box: Bbox): Promise<FlowFeatureCollection> {
    const relevant = this.providers.filter((provider) => overlaps(provider.coverage, box));
    const results = await Promise.allSettled(relevant.map((provider) => provider.snapshot()));

    const features: FlowFeature[] = [];
    results.forEach((result, index) => {
      const provider = relevant[index];
      if (result.status === 'rejected') {
        const reason = result.reason instanceof Error ? result.reason.message : 'unknown error';
        this.logger.warn(`Open traffic source ${provider.id} failed: ${reason}`);
        this.outcomes.set(provider.id, { active: false, stale: false, updatedAt: this.outcomes.get(provider.id)?.updatedAt ?? null });
        return;
      }
      const { segments, fetchedAt, stale } = result.value;
      this.outcomes.set(provider.id, { active: true, stale, updatedAt: fetchedAt.toISOString() });
      for (const segment of segments) {
        if (features.length >= MAX_OPEN_FLOW_FEATURES) break;
        if (!intersects(segment.coordinates, box)) continue;
        const { coordinates, ...properties } = segment;
        features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates }, properties });
      }
    });
    return { type: 'FeatureCollection', features };
  }

  /** Each source's last outcome; a source nobody has looked at yet is reported inactive. */
  sources(): SourceStatus[] {
    return this.providers.map((provider) => ({
      id: provider.id,
      ...(this.outcomes.get(provider.id) ?? { active: false, stale: false, updatedAt: null }),
      attribution: provider.attribution,
    }));
  }
}
