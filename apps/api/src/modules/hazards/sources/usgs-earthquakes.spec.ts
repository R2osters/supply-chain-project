import { parseUsgsFeed, quakeToHazard } from './usgs-earthquakes';

const feature = (id: string, mag: number | null, extra: Record<string, unknown> = {}) => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates: [-0.2, 5.5, 10] },
  properties: {
    mag,
    place: '12 km SSW of Tema, Ghana',
    time: Date.UTC(2026, 8, 28, 6),
    url: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}`,
    alert: null,
    tsunami: 0,
    sig: 300,
    ...extra,
  },
});

describe('USGS earthquakes', () => {
  it('parses events and drops those without a magnitude or below M2.5', () => {
    const events = parseUsgsFeed({
      features: [feature('us1', 4.6), feature('us2', null), feature('us3', 1.9), feature('us1', 4.6)],
    });
    expect(events.map((e) => e.id)).toEqual(['us1']);
    expect(events[0]).toMatchObject({ magnitude: 4.6, depthKm: 10, time: '2026-09-28T06:00:00.000Z' });
  });

  it('refuses a payload without a feature list', () => {
    expect(() => parseUsgsFeed({})).toThrow('features');
  });

  it('scores by magnitude when there is no alert', () => {
    const [event] = parseUsgsFeed({ features: [feature('us1', 5.0)] });
    const hazard = quakeToHazard(event);
    expect(hazard.severity).toBe('MEDIUM');
    expect(hazard.severityScore).toBe(0.5);
    expect(hazard.radiusKm).toBe(100);
    expect(hazard.title).toBe('M5.0 earthquake — 12 km SSW of Tema, Ghana');
  });

  it('lets a PAGER alert and a tsunami flag raise the level', () => {
    const [red] = parseUsgsFeed({ features: [feature('us1', 4.0, { alert: 'red' })] });
    expect(quakeToHazard(red)).toMatchObject({ severity: 'CRITICAL', severityScore: 0.85 });

    const [wave] = parseUsgsFeed({ features: [feature('us2', 4.0, { tsunami: 1 })] });
    expect(quakeToHazard(wave).severity).toBe('HIGH');
  });

  it('drops a non-http event link', () => {
    const [event] = parseUsgsFeed({ features: [feature('us1', 5, { url: 'javascript:alert(1)' })] });
    expect(event.url).toBeNull();
  });
});
