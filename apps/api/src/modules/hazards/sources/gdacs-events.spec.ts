import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UpstreamError } from '../../../common/http';
import {
  GDACS_PAGE_SIZE,
  GDACS_QUERIES,
  fetchGdacsEvents,
  gdacsAlertSeverity,
  gdacsEventToHazard,
  gdacsSearchUrl,
  liveGdacsEvents,
  parseGdacsEvents,
  stormClass,
  type GdacsEvent,
} from './gdacs-events';

// Trimmed from real SEARCH answers of 2026-09-29: two floods, two eruptions, three droughts, two
// cyclones, two forest fires, one earthquake (never used) and one feature without geometry.
const FIXTURE = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'gdacs-search.json'), 'utf8')) as {
  features: Array<{ properties: Record<string, unknown> }>;
};
const NOW = Date.UTC(2026, 8, 29, 14, 0);

const events = parseGdacsEvents(FIXTURE);
const byId = (id: number): GdacsEvent => {
  const event = events.find((e) => e.eventId === id);
  if (!event) throw new Error(`fixture has no event ${id}`);
  return event;
};

describe('GDACS parsing', () => {
  it('keeps the five GDACS types, drops earthquakes and malformed features', () => {
    expect(events).toHaveLength(11);
    expect(new Set(events.map((e) => e.type))).toEqual(new Set(['FL', 'VO', 'DR', 'TC', 'WF']));
    expect(events.some((e) => e.eventId === 1568614)).toBe(false); // the M5.6 quake: USGS's job
  });

  it('reads alerts, dates as UTC, countries and the official report link', () => {
    expect(byId(1104178)).toMatchObject({
      type: 'FL',
      name: 'Flood in Guinea',
      alertLevel: 'Green',
      episodeAlertLevel: 'Green',
      episodeAlertScore: 0.5,
      current: true,
      countries: ['Guinea'],
      fromDate: '2026-09-18T01:00:00.000Z',
      toDate: '2026-09-29T01:00:00.000Z',
      upstream: 'GLOFAS',
      reportUrl: 'https://www.gdacs.org/report.aspx?eventid=1104178&episodeid=4&eventtype=FL',
    });
  });

  it('refuses an answer that is not a feature collection', () => {
    expect(() => parseGdacsEvents({ nope: true })).toThrow('features');
  });

  it('replaces a report link to any other host with the canonical GDACS page', () => {
    const feature = structuredClone(FIXTURE.features[0]);
    feature.properties.url = { report: 'https://evil.example/report' };
    const [event] = parseGdacsEvents({ features: [feature] });
    expect(event.reportUrl).toBe('https://www.gdacs.org/report.aspx?eventid=1104178&eventtype=FL&episodeid=4');
  });
});

describe('GDACS liveness', () => {
  it('keeps current events and the latest drought batch, drops the rest', () => {
    const live = liveGdacsEvents(events, NOW).map((e) => e.eventId);
    // Chikurachki (8 days old, not current) and the drought of the previous batch are gone.
    expect(live).not.toContain(1000149);
    expect(live).not.toContain(1027448);
    // Europe-2026 is not flagged current, but it is in the latest assessment, as on GDACS's own map.
    expect(live).toContain(1018332);
    expect(live).toEqual(expect.arrayContaining([1104178, 1104121, 1000150, 1015915, 1001327, 1001325, 1032478]));
  });

  it('lets a cyclone go two days after its last advisory', () => {
    const later = liveGdacsEvents(events, NOW + 3 * 86_400_000).map((e) => e.type);
    expect(later).not.toContain('TC');
    expect(later).toContain('DR');
  });
});

describe('GDACS severity', () => {
  it('maps the current alert to the shared levels, with the episode score inside the band', () => {
    const green = gdacsAlertSeverity({ alertLevel: 'Green', episodeAlertLevel: 'Green', episodeAlertScore: 0.5 });
    const orange = gdacsAlertSeverity({ alertLevel: 'Orange', episodeAlertLevel: 'Orange', episodeAlertScore: 1.25 });
    const red = gdacsAlertSeverity({ alertLevel: 'Red', episodeAlertLevel: 'Red', episodeAlertScore: 2.5 });
    expect(green).toEqual({ level: 'LOW', score: 0.22 });
    expect(orange).toEqual({ level: 'HIGH', score: 0.66 });
    expect(red.level).toBe('CRITICAL');
    expect(red.score).toBeCloseTo(0.93, 2);
  });

  it('calls an event receding from Orange or Red MEDIUM', () => {
    // The India flood peaked Orange; its latest episode is Green.
    expect(gdacsAlertSeverity(byId(1104121))).toEqual({ level: 'MEDIUM', score: 0.47 });
  });

  it('never ranks a cyclone below its current class', () => {
    // SURIGAE: Green alert (sparse exposure), but a tropical storm is MEDIUM on the NHC scale.
    expect(gdacsEventToHazard(byId(1001327))).toMatchObject({ severity: 'MEDIUM', severityScore: 0.45, radiusKm: 200 });
    // POLO: Red overall, Green now, still a hurricane.
    expect(gdacsEventToHazard(byId(1001325))).toMatchObject({ severity: 'HIGH', severityScore: 0.7, radiusKm: 300 });
  });

  it('reads the storm class, not the peak wind, from the severity text', () => {
    expect(stormClass('Tropical Storm (maximum wind speed of 241 km/h)')).toBe('TS');
    expect(stormClass('Hurricane/Typhoon > 74 mph (maximum wind speed of 250 km/h)')).toBe('HU');
    expect(stormClass('Tropical Depression (maximum wind speed of 83 km/h)')).toBe('TD');
    expect(stormClass('Magnitude 0 ')).toBeNull();
  });
});

describe('GDACS hazards', () => {
  it('turns a flood into a FLOOD hazard linked to its GDACS report', () => {
    expect(gdacsEventToHazard(byId(1104178))).toMatchObject({
      id: 'gdacs:FL:1104178',
      kind: 'FLOOD',
      title: 'Flood in Guinea',
      severity: 'LOW',
      radiusKm: 50,
      source: 'GDACS',
      observedAt: '2026-09-29T01:00:00.000Z',
      url: 'https://www.gdacs.org/report.aspx?eventid=1104178&episodeid=4&eventtype=FL',
      details: expect.objectContaining({ alertLevel: 'Green', place: 'Guinea', upstream: 'GLOFAS' }),
    });
  });

  it('sizes a drought from its area, names it by region, and rates it one level below the alert', () => {
    const hazard = gdacsEventToHazard(byId(1018332));
    // Orange ("Medium impact for agricultural drought" in GDACS's words) is MEDIUM, not HIGH.
    expect(hazard).toMatchObject({
      kind: 'DROUGHT',
      title: 'Sécheresse — Europe-2026',
      severity: 'MEDIUM',
      severityScore: 0.41,
    });
    // 1.26 million km² is a disc of ~634 km; footprints stop at 500 km.
    expect(hazard.radiusKm).toBe(500);
    expect(hazard.details).toMatchObject({ areaKm2: 1264372, place: null });
    expect(hazard.details.countries).toBe('Austria, Bosnia & Herzegovina, Belgium');
  });

  it('names an eruption by its volcano', () => {
    expect(gdacsEventToHazard(byId(1000150))).toMatchObject({
      kind: 'VOLCANO',
      title: 'Eruption Etna',
      radiusKm: 25,
      details: expect.objectContaining({ volcano: 'Etna', place: 'Etna' }),
    });
  });

  it('tells repeated fire names apart by burned area', () => {
    const hazard = gdacsEventToHazard(byId(1032478));
    expect(hazard).toMatchObject({ kind: 'FIRE', title: 'Forest fires in Australia — 5,133 ha', radiusKm: 10 });
    expect(hazard.details.burnedAreaHa).toBe(5133);
  });
});

describe('GDACS fetching', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const page = (count: number): Response => {
    const template = FIXTURE.features[0];
    const features = Array.from({ length: count }, (_, i) => ({
      ...template,
      properties: { ...template.properties, eventid: 2_000_000 + i },
    }));
    return new Response(JSON.stringify({ type: 'FeatureCollection', features }), { status: 200 });
  };

  it('asks for all three alert colours in a bounded window, one page at a time', () => {
    const url = new URL(gdacsSearchUrl(['TC', 'FL', 'VO'], NOW - 10 * 86_400_000, NOW + 86_400_000, 2));
    expect(url.searchParams.get('eventlist')).toBe('TC;FL;VO');
    expect(url.searchParams.get('alertlevel')).toBe('Green;Orange;Red');
    expect(url.searchParams.get('fromDate')).toBe('2026-09-19');
    expect(url.searchParams.get('toDate')).toBe('2026-09-30');
    expect(url.searchParams.get('pageNumber')).toBe('2');
  });

  it('reads the next page only while pages come back full, and takes 204 as the end', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(page(GDACS_PAGE_SIZE))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchGdacsEvents(GDACS_QUERIES.events, NOW);
    expect(result).toHaveLength(GDACS_PAGE_SIZE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('pageNumber=2');
  });

  it('stops after a short page', async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(page(3));
    global.fetch = fetchMock as unknown as typeof fetch;
    expect(await fetchGdacsEvents(GDACS_QUERIES.droughts, NOW)).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a non-JSON body as a failure, so the last good data is served instead', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response('<html>maintenance</html>')) as unknown as typeof fetch;
    await expect(fetchGdacsEvents(GDACS_QUERIES.events, NOW)).rejects.toBeInstanceOf(UpstreamError);
  });
});
