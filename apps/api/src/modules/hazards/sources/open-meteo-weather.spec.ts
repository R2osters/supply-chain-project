import { computeWeatherSeverity } from '../weather-severity';
import { openMeteoUrl, parseOpenMeteo, weatherCell, weatherToHazard } from './open-meteo-weather';

const PAYLOAD = {
  latitude: 5.6,
  longitude: -0.2,
  current: {
    time: '2026-09-28T12:15',
    interval: 900,
    temperature_2m: 29.4,
    precipitation: 12.3,
    weather_code: 95,
    wind_speed_10m: 22.1,
    wind_gusts_10m: 81,
    visibility: 3200,
    cloud_cover: 100,
  },
};

describe('Open-Meteo weather', () => {
  it('snaps a point to its 0.1° cell', () => {
    expect(weatherCell(5.6037, -0.187)).toEqual({ latitude: 5.6, longitude: -0.2, key: '5.6,-0.2' });
  });

  it('asks only for the current fields the severity model uses', () => {
    const url = new URL(openMeteoUrl(5.6, -0.2));
    expect(url.searchParams.get('current')).toBe(
      'temperature_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,visibility,cloud_cover',
    );
    expect(url.searchParams.get('latitude')).toBe('5.6');
  });

  it('reads zone-less timestamps as UTC', () => {
    const observation = parseOpenMeteo(PAYLOAD, 5.6, -0.2);
    expect(observation.observedAt).toBe('2026-09-28T12:15:00.000Z');
    expect(observation).toMatchObject({ temperatureC: 29.4, windGustKmh: 81, weatherCode: 95 });
  });

  it('rejects a response with no current block', () => {
    expect(() => parseOpenMeteo({ error: true, reason: 'bad' }, 0, 0)).toThrow('current');
  });

  it('turns severe local weather into a SEVERE_WEATHER hazard keyed by cell', () => {
    const observation = parseOpenMeteo(PAYLOAD, 5.6, -0.2);
    const hazard = weatherToHazard(observation, computeWeatherSeverity(observation));
    expect(hazard).toMatchObject({
      id: 'open-meteo:5.6,-0.2',
      kind: 'SEVERE_WEATHER',
      title: 'Météo sévère — Orage',
      severity: 'CRITICAL',
    });
  });
});
