import {
  acquisitionMsUtc,
  boxesAroundPoints,
  clampFirmsBox,
  clusterFires,
  firmsAreaKey,
  parseFirmsCsv,
  splitAtAntimeridian,
} from './firms-fires';

const NOW = Date.UTC(2026, 8, 28, 12, 0);

const CSV = [
  'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight',
  '6.01,-1.01,340.1,0.4,0.4,2026-09-28,1006,N20,VIIRS,h,2.0NRT,300.1,120.5,D',
  '6.02,-1.02,338.0,0.4,0.4,2026-09-28,1006,N20,VIIRS,n,2.0NRT,299.0,40.0,D',
  // Low confidence: usually glint or an industrial roof, not a wildfire.
  '9.50,2.50,330.0,0.4,0.4,2026-09-28,45,N20,VIIRS,l,2.0NRT,290.0,5.0,N',
  // Older than 24 h: out of the window.
  '7.00,-2.00,340.0,0.4,0.4,2026-09-26,1200,N20,VIIRS,h,2.0NRT,300.0,90.0,D',
  'garbage,row',
  '',
].join('\r\n');

describe('FIRMS fires', () => {
  it('parses the area CSV and keeps only the trailing 24 hours', () => {
    const detections = parseFirmsCsv(CSV, NOW);
    expect(detections).toHaveLength(3);
    expect(detections[0]).toMatchObject({ latitude: 6.01, longitude: -1.01, frp: 120.5, confidence: 'h' });
  });

  it('treats an HTML or text error body as a failure, not as "no fires"', () => {
    expect(() => parseFirmsCsv('Invalid MAP_KEY.', NOW)).toThrow('autre chose que du CSV');
    expect(() => parseFirmsCsv('<html>oops</html>', NOW)).toThrow();
  });

  it('caps the number of parsed rows', () => {
    expect(parseFirmsCsv(CSV, NOW, 1)).toHaveLength(1);
  });

  it('reads unpadded acquisition times as UTC', () => {
    expect(acquisitionMsUtc('2026-09-28', '45')).toBe(Date.UTC(2026, 8, 28, 0, 45));
    expect(acquisitionMsUtc('2026-09-28', '2460')).toBeNaN();
  });

  it('clusters neighbouring pixels into one hazard and drops low-confidence ones', () => {
    const hazards = clusterFires(parseFirmsCsv(CSV, NOW));
    expect(hazards).toHaveLength(1);
    expect(hazards[0]).toMatchObject({ kind: 'FIRE', title: 'Feu actif — 2 détections' });
    expect(hazards[0].details.totalFrpMw).toBe(160.5);
    // The FRP-weighted centroid leans towards the hotter pixel.
    expect(hazards[0].latitude).toBeLessThan(6.015);
  });

  it('clamps a huge viewport to its centre and says it did', () => {
    const { box, clamped } = clampFirmsBox({ minLat: -40, minLon: -20, maxLat: 40, maxLon: 60 });
    expect(clamped).toBe(true);
    expect(box.maxLat - box.minLat).toBeCloseTo(15);
    expect((box.minLon + box.maxLon) / 2).toBeCloseTo(20);
  });

  it('splits a box that crosses the antimeridian', () => {
    const parts = splitAtAntimeridian({ minLat: 0, minLon: 170, maxLat: 10, maxLon: -170 });
    expect(parts).toEqual([
      { minLat: 0, minLon: 170, maxLat: 10, maxLon: 180 },
      { minLat: 0, minLon: -180, maxLat: 10, maxLon: -170 },
    ]);
  });

  it('snaps area keys outward so the queried box never shrinks', () => {
    expect(firmsAreaKey({ minLat: 5.3, minLon: -1.2, maxLat: 6.1, maxLon: -0.1 })).toBe('-1.5,5.0,0.0,6.5');
  });

  it('shares one box between nearby sites', () => {
    const boxes = boxesAroundPoints(
      [
        { latitude: 5.6, longitude: -0.2 },
        { latitude: 6.7, longitude: -1.6 },
        { latitude: 48.8, longitude: 2.3 },
      ],
      1,
    );
    expect(boxes).toHaveLength(2);
  });
});
