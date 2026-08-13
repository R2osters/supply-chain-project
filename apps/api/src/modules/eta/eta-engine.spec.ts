import type { LatLng } from '@scip/shared';
import {
  MIN_EFFECTIVE_SPEED_KMH,
  NIGHT_FACTOR,
  assessLateness,
  computeEta,
  type EtaInputs,
} from './eta-engine';

// Accra -> Kumasi, the corridor used throughout the demo data (~200 km apart).
const ACCRA: LatLng = { latitude: 5.6037, longitude: -0.187 };
const KUMASI: LatLng = { latitude: 6.6885, longitude: -1.6244 };
const NOON = new Date('2026-06-15T12:00:00Z');

const inputs = (overrides: Partial<EtaInputs> = {}): EtaInputs => ({
  origin: ACCRA,
  destination: KUMASI,
  nominalSpeedKmh: 60,
  now: NOON,
  ...overrides,
});

describe('computeEta — distance', () => {
  it('applies the road-winding factor to straight-line distance when there is no polyline', () => {
    const plain = computeEta(inputs({ roadWindingFactor: 1 }));
    const wound = computeEta(inputs({ roadWindingFactor: 1.5 }));

    // Distances are reported rounded to 3 dp, so compare at 2 dp.
    expect(wound.remainingDistanceKm).toBeCloseTo(plain.remainingDistanceKm * 1.5, 2);
    expect(wound.assumptions.join(' ')).toContain('road-winding factor 1.5');
  });

  it('follows the planned polyline when one is supplied', () => {
    // A dog-leg via a waypoint north of the direct line is longer than the direct line.
    const waypoint: LatLng = { latitude: 7.5, longitude: -0.9 };
    const direct = computeEta(inputs({ roadWindingFactor: 1 }));
    const viaWaypoint = computeEta(
      inputs({ routePolyline: [ACCRA, waypoint, KUMASI], roadWindingFactor: 1 }),
    );

    expect(viaWaypoint.remainingDistanceKm).toBeGreaterThan(direct.remainingDistanceKm);
    expect(viaWaypoint.assumptions.join(' ')).toContain('planned route polyline');
  });

  it('reports zero remaining distance once the vehicle is at the destination', () => {
    const result = computeEta(inputs({ currentLocation: KUMASI }));
    expect(result.remainingDistanceKm).toBeCloseTo(0, 2);
    expect(result.estimatedDurationSeconds).toBe(0);
  });
});

describe('computeEta — speed blending', () => {
  it('uses the prior alone when there are no observations', () => {
    const result = computeEta(inputs({ nominalSpeedKmh: 72 }));
    expect(result.factors.observationWeight).toBe(0);
    expect(result.baseSpeedKmh).toBeCloseTo(72, 6);
  });

  it('weights an observation more heavily as samples accumulate', () => {
    const few = computeEta(
      inputs({ nominalSpeedKmh: 80, observedAverageSpeedKmh: 40, observedSampleCount: 1 }),
    );
    const many = computeEta(
      inputs({ nominalSpeedKmh: 80, observedAverageSpeedKmh: 40, observedSampleCount: 100 }),
    );

    expect(few.baseSpeedKmh).toBeGreaterThan(many.baseSpeedKmh);
    // w = n/(n+5); at n=100 that is 100/105, so the prior still contributes ~4.8%.
    const weight = 100 / 105;
    expect(many.baseSpeedKmh).toBeCloseTo(weight * 40 + (1 - weight) * 80, 2);
    expect(many.factors.observationWeight).toBeGreaterThan(0.9);
  });

  it('prefers a carrier-specific historical prior over the generic vehicle prior', () => {
    const generic = computeEta(inputs({ nominalSpeedKmh: 60 }));
    const historical = computeEta(inputs({ nominalSpeedKmh: 60, historicalAverageSpeedKmh: 45 }));

    expect(historical.baseSpeedKmh).toBeCloseTo(45, 6);
    expect(historical.estimatedDurationSeconds).toBeGreaterThan(generic.estimatedDurationSeconds);
  });
});

describe('computeEta — conditions', () => {
  it('slows the vehicle down as congestion rises', () => {
    const clear = computeEta(inputs({ trafficCongestion: 0 }));
    const heavy = computeEta(inputs({ trafficCongestion: 1 }));

    expect(heavy.effectiveSpeedKmh).toBeCloseTo(clear.effectiveSpeedKmh * 0.5, 4);
    expect(heavy.estimatedDurationSeconds).toBeGreaterThan(clear.estimatedDurationSeconds);
  });

  it('compounds traffic and weather multiplicatively', () => {
    const both = computeEta(inputs({ trafficCongestion: 1, weatherSeverity: 1 }));
    expect(both.factors.traffic).toBeCloseTo(0.5, 6);
    expect(both.factors.weather).toBeCloseTo(0.65, 6);
    expect(both.effectiveSpeedKmh).toBeCloseTo(60 * 0.5 * 0.65, 3);
  });

  it('never predicts an absurdly slow speed', () => {
    const result = computeEta(
      inputs({ nominalSpeedKmh: 6, trafficCongestion: 1, weatherSeverity: 1 }),
    );
    expect(result.effectiveSpeedKmh).toBeGreaterThanOrEqual(MIN_EFFECTIVE_SPEED_KMH);
  });

  it('applies the night multiplier between 22:00 and 05:00 local time', () => {
    const day = computeEta(inputs({ now: new Date('2026-06-15T14:00:00') }));
    const night = computeEta(inputs({ now: new Date('2026-06-15T23:30:00') }));

    expect(day.factors.night).toBe(1);
    expect(night.factors.night).toBe(NIGHT_FACTOR);
  });

  it('adds planned stop time on top of driving time', () => {
    const without = computeEta(inputs());
    const withStops = computeEta(inputs({ remainingStopMinutes: 90 }));

    expect(withStops.estimatedDurationSeconds - without.estimatedDurationSeconds).toBe(90 * 60);
  });
});

describe('computeEta — uncertainty', () => {
  it('produces a window that brackets the point estimate', () => {
    const result = computeEta(inputs());
    expect(result.arrivalWindow.earliest.getTime()).toBeLessThan(result.estimatedArrival.getTime());
    expect(result.arrivalWindow.latest.getTime()).toBeGreaterThan(result.estimatedArrival.getTime());
  });

  it('is more confident about a short leg than a long one', () => {
    const near = computeEta(inputs({ currentLocation: { latitude: 6.6, longitude: -1.6 } }));
    const far = computeEta(inputs({ currentLocation: ACCRA }));

    expect(near.confidenceScore).toBeGreaterThan(far.confidenceScore);
  });

  it('narrows the window as trip observations accumulate', () => {
    const unobserved = computeEta(inputs());
    const observed = computeEta(
      inputs({ observedAverageSpeedKmh: 60, observedSampleCount: 200 }),
    );

    const spread = (r: ReturnType<typeof computeEta>): number =>
      r.arrivalWindow.latest.getTime() - r.arrivalWindow.earliest.getTime();

    expect(spread(observed)).toBeLessThan(spread(unobserved));
  });

  it('widens the window when the carrier is historically erratic', () => {
    const steady = computeEta(inputs({ historicalAverageSpeedKmh: 60, historicalSpeedStdKmh: 2 }));
    const erratic = computeEta(inputs({ historicalAverageSpeedKmh: 60, historicalSpeedStdKmh: 25 }));

    const spread = (r: ReturnType<typeof computeEta>): number =>
      r.arrivalWindow.latest.getTime() - r.arrivalWindow.earliest.getTime();

    expect(spread(erratic)).toBeGreaterThan(spread(steady));
    expect(erratic.confidenceScore).toBeLessThan(steady.confidenceScore);
  });

  it('always returns a confidence strictly inside (0, 1)', () => {
    for (const congestion of [0, 0.5, 1]) {
      for (const samples of [0, 3, 500]) {
        const result = computeEta(
          inputs({
            trafficCongestion: congestion,
            observedAverageSpeedKmh: 55,
            observedSampleCount: samples,
          }),
        );
        expect(result.confidenceScore).toBeGreaterThan(0);
        expect(result.confidenceScore).toBeLessThan(1);
      }
    }
  });
});

describe('assessLateness', () => {
  const eta = computeEta(inputs());

  it('flags a shipment whose estimate overshoots the promise', () => {
    const promise = new Date(eta.estimatedArrival.getTime() - 60 * 60 * 1000);
    const verdict = assessLateness(eta, promise);

    expect(verdict.isLate).toBe(true);
    expect(verdict.minutesLate).toBeCloseTo(60, 0);
  });

  it('does not call a shipment certainly late while the window still reaches the promise', () => {
    // One minute past the estimate, but well inside the window.
    const promise = new Date(eta.estimatedArrival.getTime() + 60 * 1000);
    const verdict = assessLateness(eta, promise);

    expect(verdict.isLate).toBe(false);
    expect(verdict.certainlyLate).toBe(false);
  });

  it('is certain only when even the optimistic end misses the promise', () => {
    const promise = new Date(eta.arrivalWindow.earliest.getTime() - 60 * 1000);
    expect(assessLateness(eta, promise).certainlyLate).toBe(true);
  });
});
