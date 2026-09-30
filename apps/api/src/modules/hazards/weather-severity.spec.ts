import { SEVERE_WEATHER_THRESHOLD, computeWeatherSeverity, describeWeatherCode, type WeatherSeverityInput } from './weather-severity';

const calm: WeatherSeverityInput = {
  weatherCode: 0,
  windKmh: 10,
  windGustKmh: 18,
  precipitationMm: 0,
  visibilityM: 24_000,
};

describe('computeWeatherSeverity', () => {
  it('scores clear, calm weather as zero with no reasons', () => {
    expect(computeWeatherSeverity(calm)).toEqual({ severity: 0, condition: 'Ciel dégagé', reasons: [] });
  });

  it('treats a thunderstorm with hail as severe on its own', () => {
    const result = computeWeatherSeverity({ ...calm, weatherCode: 96 });
    expect(result.severity).toBeGreaterThanOrEqual(SEVERE_WEATHER_THRESHOLD);
    expect(result.condition).toBe('Orage avec grêle');
    expect(result.reasons[0]).toContain('code OMM 96');
  });

  it('lets one dangerous factor dominate rather than be averaged away', () => {
    const result = computeWeatherSeverity({ ...calm, windGustKmh: 110 });
    expect(result.severity).toBe(0.9);
    expect(result.reasons).toEqual(['Rafales à 110 km/h']);
  });

  it('adds a little for compounding factors and never exceeds 1', () => {
    const fogOnly = computeWeatherSeverity({ ...calm, weatherCode: 45 }).severity;
    const fogAndLowVisibility = computeWeatherSeverity({ ...calm, weatherCode: 45, visibilityM: 150 }).severity;
    expect(fogAndLowVisibility).toBeGreaterThan(fogOnly);

    const everything = computeWeatherSeverity({
      weatherCode: 99,
      windKmh: 90,
      windGustKmh: 130,
      precipitationMm: 30,
      visibilityM: 50,
    });
    expect(everything.severity).toBe(1);
    expect(everything.reasons).toHaveLength(4);
  });

  it('falls back to sustained wind when gusts are not reported', () => {
    const result = computeWeatherSeverity({ ...calm, windGustKmh: null, windKmh: 80 });
    expect(result.severity).toBe(0.9);
    expect(result.reasons[0]).toContain('Vent soutenu');
  });

  it('survives a response with every field missing', () => {
    const result = computeWeatherSeverity({
      weatherCode: null,
      windKmh: null,
      windGustKmh: null,
      precipitationMm: null,
      visibilityM: null,
    });
    expect(result).toEqual({ severity: 0, condition: 'Conditions inconnues', reasons: [] });
  });
});

describe('describeWeatherCode', () => {
  it.each([
    [3, 'Couvert'],
    [48, 'Brouillard'],
    [65, 'Forte pluie'],
    [67, 'Pluie verglaçante'],
    [82, 'Averses violentes'],
    [86, 'Fortes chutes de neige'],
    [95, 'Orage'],
    [42, 'Conditions inconnues'],
  ])('labels code %i as %s', (code, label) => {
    expect(describeWeatherCode(code)).toBe(label);
  });
});
