import { ServiceUnavailableException } from '@nestjs/common';
import { SatellitesService } from './satellites.service';

const GEO_TLE =
  'SYNTH GEO\n' +
  '1 90001U 26001A   26100.50000000  .00000000  00000-0  00000-0 0  9993\n' +
  '2 90001   0.0500  80.0000 0002000 100.0000 180.0000  1.00270000  1008\n';

describe('SatellitesService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('fetches a group once and answers both endpoints from the cache', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(GEO_TLE));
    const service = new SatellitesService(() => new Date('2026-04-10T12:00:00Z'));

    const tle = await service.getTle('geo');
    expect(tle).toMatchObject({ group: 'geo', stale: false, attribution: 'CelesTrak (celestrak.org), Dr. T.S. Kelso' });
    expect(tle.satellites).toHaveLength(1);

    const visible = await service.getVisible(0, -18.7, 'geo', 10);
    expect(visible.visible).toHaveLength(1);
    expect(visible.summary).toEqual({ count: 1, above30Deg: 1, quality: 'POOR' });
    expect(visible.at).toBe('2026-04-10T12:00:00.000Z');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://celestrak.org/NORAD/elements/gp.php?GROUP=geo&FORMAT=tle');
  });

  it('treats a 200 with no element sets as a failure', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async () => new Response('No GP data found'));
    await expect(new SatellitesService().getTle('gps-ops')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('lists the allow-listed groups', () => {
    const ids = new SatellitesService().listGroups().groups.map((g) => g.id);
    expect(ids).toEqual(['gps-ops', 'galileo', 'glo-ops', 'beidou', 'stations', 'weather', 'resource', 'geo', 'iridium-NEXT']);
  });
});
