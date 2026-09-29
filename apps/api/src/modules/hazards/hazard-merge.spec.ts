import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isInNhcBasin, isSameFire, mergeKeylessFires, outsideNhcBasins } from './hazard-merge';
import { parseEonetFires, type EonetFire } from './sources/eonet-wildfires';
import { parseGdacsEvents, type GdacsEvent } from './sources/gdacs-events';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, 'sources', '__fixtures__', name), 'utf8'));

const gdacs = parseGdacsEvents(fixture('gdacs-search.json'));
const eonet = parseEonetFires(fixture('eonet-wildfires.json'), Date.UTC(2026, 8, 28, 12, 0));

const gdacsEvent = (id: number): GdacsEvent => gdacs.find((e) => e.eventId === id) as GdacsEvent;
const eonetFire = (id: string): EonetFire => eonet.find((f) => f.id === id) as EonetFire;

// GWIS's "Forest fires in United States" (5 041 ha, 16–29 Sep, Sierra Nevada) and IRWIN's DOME
// fire (1 177 acres, last reported 15 Sep), 5 km apart: the same fire, as reported on the day.
const GDACS_US_FIRE = 1032460;
const EONET_DOME = 'EONET_24484';

describe('NHC basins', () => {
  it('is the northern hemisphere west of the prime meridian', () => {
    expect(isInNhcBasin(25, -46.8)).toBe(true); // Atlantic
    expect(isInNhcBasin(26.2, -111.9)).toBe(true); // eastern North Pacific
    expect(isInNhcBasin(20, -164.3)).toBe(true); // central North Pacific
    expect(isInNhcBasin(29, 135)).toBe(false); // West Pacific
    expect(isInNhcBasin(-15, -170)).toBe(false); // South Pacific
    expect(isInNhcBasin(38, 18)).toBe(false); // a Mediterranean cyclone
  });

  it('drops only GDACS cyclones inside them', () => {
    const kept = outsideNhcBasins(gdacs);
    expect(kept.map((e) => e.eventId)).not.toContain(1001325); // POLO, off Baja California
    expect(kept.map((e) => e.eventId)).toContain(1001327); // SURIGAE, south of Japan
    expect(kept.filter((e) => e.type !== 'TC')).toHaveLength(gdacs.filter((e) => e.type !== 'TC').length);
  });
});

describe('keyless fire merge', () => {
  it('recognises one fire reported by both feeds', () => {
    expect(isSameFire(gdacsEvent(GDACS_US_FIRE), eonetFire(EONET_DOME))).toBe(true);
    expect(isSameFire(gdacsEvent(GDACS_US_FIRE), eonetFire('EONET_24904'))).toBe(false); // Texas
  });

  it('does not merge fires far apart in time', () => {
    const old = {
      ...eonetFire(EONET_DOME),
      firstSeenAt: '2026-08-01T00:00:00.000Z',
      lastSeenAt: '2026-08-20T00:00:00.000Z',
    };
    expect(isSameFire(gdacsEvent(GDACS_US_FIRE), old)).toBe(false);
  });

  it('keeps GDACS on a geometry tie and names the dropped copy', () => {
    const merged = mergeKeylessFires(gdacs, eonet);
    expect(merged.gdacs).toHaveLength(gdacs.length);
    expect(merged.eonet.map((f) => f.id)).toEqual(['EONET_24904']);
    expect(merged.sameFire.get(`gdacs:WF:${GDACS_US_FIRE}`)).toBe(`eonet:${EONET_DOME}`);
  });

  it('keeps the EONET copy when it has the better geometry', () => {
    const perimeter = { ...eonetFire(EONET_DOME), polygon: true };
    const merged = mergeKeylessFires(gdacs, [perimeter]);
    expect(merged.gdacs.map((e) => e.eventId)).not.toContain(GDACS_US_FIRE);
    expect(merged.eonet).toEqual([perimeter]);
    expect(merged.sameFire.get(`eonet:${EONET_DOME}`)).toBe(`gdacs:WF:${GDACS_US_FIRE}`);
  });

  it('leaves every non-fire GDACS event alone', () => {
    const merged = mergeKeylessFires(gdacs, [{ ...eonetFire(EONET_DOME), polygon: true }]);
    expect(merged.gdacs.filter((e) => e.type !== 'WF')).toEqual(gdacs.filter((e) => e.type !== 'WF'));
  });
});
