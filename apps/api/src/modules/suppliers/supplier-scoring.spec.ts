import {
  CONFIDENCE_HALF_LIFE_ORDERS,
  NEUTRAL_PRIOR,
  computeSupplierReliability,
  mean,
  stdDev,
  type SupplierObservations,
} from './supplier-scoring';

const base: SupplierObservations = {
  ordersTotal: 0,
  ordersOnTime: 0,
  ordersCancelled: 0,
  quantityOrdered: 0,
  quantityReceived: 0,
  quantityRejected: 0,
  leadTimeSamplesDays: [],
};

const obs = (overrides: Partial<SupplierObservations>): SupplierObservations => ({
  ...base,
  ...overrides,
});

describe('stdDev', () => {
  it('returns 0 for fewer than two samples', () => {
    expect(stdDev([])).toBe(0);
    expect(stdDev([7])).toBe(0);
  });

  it('computes the sample standard deviation (n-1 denominator)', () => {
    // values 2,4,4,4,5,5,7,9 -> mean 5, sample sd = sqrt(32/7)
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(Math.sqrt(32 / 7), 10);
  });

  it('is zero for a constant series', () => {
    expect(stdDev([12, 12, 12, 12])).toBe(0);
    expect(mean([12, 12, 12, 12])).toBe(12);
  });
});

describe('computeSupplierReliability', () => {
  it('falls back to the neutral prior when there is no history', () => {
    const result = computeSupplierReliability(base);

    expect(result.onTimeDeliveryRate).toBeCloseTo(NEUTRAL_PRIOR, 6);
    expect(result.qualityAcceptanceRate).toBeCloseTo(NEUTRAL_PRIOR, 6);
    expect(result.confidence).toBe(0);
    // Four of the five components sit at the prior; `commitment` is a perfect 1.0 because a
    // supplier with no orders has cancelled none. Score = 0.85·0.95 + 1.0·0.05 = 0.8575.
    expect(result.components.commitment).toBe(1);
    expect(result.reliabilityScore).toBeCloseTo(NEUTRAL_PRIOR * 95 + 5, 2);
    expect(result.reasons[0]).toContain('No completed orders yet');
  });

  it('does not let a single late delivery crater the score', () => {
    // 1 of 2 on time: the raw rate is 50%, but with n=2 the shrunk rate stays well above it.
    const result = computeSupplierReliability(
      obs({
        ordersTotal: 2,
        ordersOnTime: 1,
        quantityOrdered: 100,
        quantityReceived: 100,
        leadTimeSamplesDays: [6, 8],
      }),
    );

    const rawRate = 0.5;
    const expectedWeight = 2 / (2 + CONFIDENCE_HALF_LIFE_ORDERS);
    const expected = expectedWeight * rawRate + (1 - expectedWeight) * NEUTRAL_PRIOR;

    expect(result.onTimeDeliveryRate).toBeCloseTo(expected, 4);
    expect(result.onTimeDeliveryRate).toBeGreaterThan(rawRate);
    expect(result.reasons.some((r) => r.includes('shrunk toward'))).toBe(true);
  });

  it('converges on the raw rates once there is plenty of history', () => {
    const result = computeSupplierReliability(
      obs({
        ordersTotal: 200,
        ordersOnTime: 180,
        quantityOrdered: 20000,
        quantityReceived: 20000,
        quantityRejected: 200,
        leadTimeSamplesDays: Array.from({ length: 200 }, () => 7),
      }),
    );

    expect(result.onTimeDeliveryRate).toBeCloseTo(0.9, 2);
    expect(result.qualityAcceptanceRate).toBeCloseTo(0.99, 2);
    expect(result.confidence).toBeGreaterThan(0.97);
  });

  it('prefers a slow but consistent supplier over a fast erratic one', () => {
    const shared = {
      ordersTotal: 60,
      ordersOnTime: 54,
      quantityOrdered: 6000,
      quantityReceived: 6000,
      quantityRejected: 0,
    };

    const consistentSlow = computeSupplierReliability(
      obs({ ...shared, leadTimeSamplesDays: Array.from({ length: 60 }, () => 12) }),
    );
    const erraticFast = computeSupplierReliability(
      obs({
        ...shared,
        leadTimeSamplesDays: Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 3 : 20)),
      }),
    );

    // Same on-time and quality record; only lead-time variance differs.
    expect(consistentSlow.leadTimeStability).toBeGreaterThan(erraticFast.leadTimeStability);
    expect(consistentSlow.reliabilityScore).toBeGreaterThan(erraticFast.reliabilityScore);
  });

  it('caps over-delivery so a fill rate above 100% cannot inflate the score', () => {
    const overDelivered = computeSupplierReliability(
      obs({
        ordersTotal: 50,
        ordersOnTime: 50,
        quantityOrdered: 1000,
        quantityReceived: 1500,
        leadTimeSamplesDays: Array.from({ length: 50 }, () => 5),
      }),
    );
    const exact = computeSupplierReliability(
      obs({
        ordersTotal: 50,
        ordersOnTime: 50,
        quantityOrdered: 1000,
        quantityReceived: 1000,
        leadTimeSamplesDays: Array.from({ length: 50 }, () => 5),
      }),
    );

    expect(overDelivered.fillRate).toBeLessThanOrEqual(1);
    expect(overDelivered.reliabilityScore).toBeCloseTo(exact.reliabilityScore, 6);
  });

  it('penalises cancellations through the commitment component', () => {
    const clean = computeSupplierReliability(
      obs({ ordersTotal: 40, ordersOnTime: 40, quantityOrdered: 400, quantityReceived: 400 }),
    );
    const flaky = computeSupplierReliability(
      obs({
        ordersTotal: 40,
        ordersCancelled: 10,
        ordersOnTime: 30,
        quantityOrdered: 400,
        quantityReceived: 400,
      }),
    );

    expect(flaky.cancellationRate).toBeCloseTo(0.25, 6);
    expect(flaky.components.commitment).toBeCloseTo(0.75, 6);
    expect(flaky.reliabilityScore).toBeLessThan(clean.reliabilityScore);
  });

  it('always produces a score inside 0..100 and rates inside 0..1', () => {
    const nonsense = computeSupplierReliability(
      obs({
        ordersTotal: 10,
        ordersOnTime: 999,
        ordersCancelled: 40,
        quantityOrdered: 10,
        quantityReceived: 5000,
        quantityRejected: 9000,
        leadTimeSamplesDays: [0, 0, 0],
      }),
    );

    expect(nonsense.reliabilityScore).toBeGreaterThanOrEqual(0);
    expect(nonsense.reliabilityScore).toBeLessThanOrEqual(100);
    for (const value of Object.values(nonsense.components)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});
