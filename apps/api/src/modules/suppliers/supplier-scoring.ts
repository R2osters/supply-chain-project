/**
 * Supplier reliability scoring.
 *
 * A single 0–100 number that procurement can sort by, built from four observable behaviours.
 * The weights are the tunable part; the components are deliberately all "share of things that
 * went right", so every one is already a 0–1 probability and the weighted sum needs no
 * normalisation tricks that would make the number hard to explain to a buyer.
 *
 *   reliability = 100 × (
 *       w_ontime   · onTimeDeliveryRate
 *     + w_quality  · qualityAcceptanceRate
 *     + w_fill     · fillRate
 *     + w_stable   · leadTimeStability
 *     + w_commit   · (1 − cancellationRate)
 *   )
 *
 * `leadTimeStability` converts lead-time variance into a 0–1 score:
 *
 *     stability = 1 / (1 + cv)        where cv = σ(leadTime) / μ(leadTime)
 *
 * A supplier that always takes 12 days scores better on stability than one that averages 8 but
 * swings between 3 and 20 — which is correct, because safety stock is driven by the *variance*
 * of lead time, not its mean. The mean is already priced into the ordering decision elsewhere.
 *
 * Confidence shrinkage: with few observations the raw rates are noisy (one late delivery out of
 * two orders is not a 50 % on-time supplier). Each rate is shrunk toward a neutral prior using
 * `n / (n + k)`, with k = 5 orders. A brand-new supplier therefore starts near the prior rather
 * than at a misleading 100 or 0.
 */

export interface SupplierReliabilityWeights {
  onTime: number;
  quality: number;
  fill: number;
  leadTimeStability: number;
  commitment: number;
}

export const DEFAULT_RELIABILITY_WEIGHTS: SupplierReliabilityWeights = {
  onTime: 0.35,
  quality: 0.25,
  fill: 0.2,
  leadTimeStability: 0.15,
  commitment: 0.05,
};

/** Observations that go into the score. */
export interface SupplierObservations {
  ordersTotal: number;
  ordersOnTime: number;
  ordersCancelled: number;
  quantityOrdered: number;
  quantityReceived: number;
  quantityRejected: number;
  leadTimeSamplesDays: number[];
}

export interface SupplierReliabilityResult {
  reliabilityScore: number;
  onTimeDeliveryRate: number;
  qualityAcceptanceRate: number;
  fillRate: number;
  cancellationRate: number;
  observedLeadTimeDays: number;
  observedLeadTimeStdDays: number;
  leadTimeStability: number;
  /** 0..1 — how much the raw observations were trusted versus the neutral prior. */
  confidence: number;
  components: Record<keyof SupplierReliabilityWeights, number>;
  reasons: string[];
}

/** Orders needed before the observed rates are trusted at ~50 %. */
export const CONFIDENCE_HALF_LIFE_ORDERS = 5;

/** Neutral prior for a supplier with no history. Not 1.0 — an unproven supplier is not perfect. */
export const NEUTRAL_PRIOR = 0.85;

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Sample standard deviation (n−1). Returns 0 for fewer than two samples. */
export function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mu = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - mu) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function shrink(rawRate: number, sampleSize: number, prior = NEUTRAL_PRIOR): number {
  const weight = sampleSize / (sampleSize + CONFIDENCE_HALF_LIFE_ORDERS);
  return weight * rawRate + (1 - weight) * prior;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export function computeSupplierReliability(
  obs: SupplierObservations,
  weights: SupplierReliabilityWeights = DEFAULT_RELIABILITY_WEIGHTS,
): SupplierReliabilityResult {
  const completed = Math.max(obs.ordersTotal - obs.ordersCancelled, 0);

  const rawOnTime = completed > 0 ? obs.ordersOnTime / completed : NEUTRAL_PRIOR;
  const rawQuality =
    obs.quantityReceived > 0
      ? (obs.quantityReceived - obs.quantityRejected) / obs.quantityReceived
      : NEUTRAL_PRIOR;
  const rawFill = obs.quantityOrdered > 0 ? obs.quantityReceived / obs.quantityOrdered : NEUTRAL_PRIOR;
  const cancellationRate = obs.ordersTotal > 0 ? obs.ordersCancelled / obs.ordersTotal : 0;

  const onTimeDeliveryRate = clamp01(shrink(rawOnTime, completed));
  const qualityAcceptanceRate = clamp01(shrink(rawQuality, completed));
  // Fill rate can legitimately exceed 1 (over-delivery); cap it so it cannot inflate the score.
  const fillRate = clamp01(shrink(Math.min(rawFill, 1), completed));

  const observedLeadTimeDays = mean(obs.leadTimeSamplesDays);
  const observedLeadTimeStdDays = stdDev(obs.leadTimeSamplesDays);
  const cv =
    observedLeadTimeDays > 0 ? observedLeadTimeStdDays / observedLeadTimeDays : 0;
  const leadTimeStability =
    obs.leadTimeSamplesDays.length >= 2 ? clamp01(1 / (1 + cv)) : NEUTRAL_PRIOR;

  const components = {
    onTime: onTimeDeliveryRate,
    quality: qualityAcceptanceRate,
    fill: fillRate,
    leadTimeStability,
    commitment: clamp01(1 - cancellationRate),
  } satisfies Record<keyof SupplierReliabilityWeights, number>;

  const weightSum =
    weights.onTime + weights.quality + weights.fill + weights.leadTimeStability + weights.commitment;

  const weighted =
    weights.onTime * components.onTime +
    weights.quality * components.quality +
    weights.fill * components.fill +
    weights.leadTimeStability * components.leadTimeStability +
    weights.commitment * components.commitment;

  const reliabilityScore = clamp01(weighted / (weightSum || 1)) * 100;
  const confidence = completed / (completed + CONFIDENCE_HALF_LIFE_ORDERS);

  return {
    reliabilityScore: round(reliabilityScore, 2),
    onTimeDeliveryRate: round(onTimeDeliveryRate, 4),
    qualityAcceptanceRate: round(qualityAcceptanceRate, 4),
    fillRate: round(fillRate, 4),
    cancellationRate: round(cancellationRate, 4),
    observedLeadTimeDays: round(observedLeadTimeDays, 2),
    observedLeadTimeStdDays: round(observedLeadTimeStdDays, 2),
    leadTimeStability: round(leadTimeStability, 4),
    confidence: round(confidence, 4),
    components,
    reasons: buildReasons(components, completed, observedLeadTimeDays, observedLeadTimeStdDays),
  };
}

function buildReasons(
  components: Record<keyof SupplierReliabilityWeights, number>,
  completedOrders: number,
  leadTimeMean: number,
  leadTimeStd: number,
): string[] {
  const reasons: string[] = [];
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

  if (completedOrders === 0) {
    reasons.push(
      `No completed orders yet — every rate is the neutral prior of ${pct(NEUTRAL_PRIOR)}, not measured performance.`,
    );
  } else if (completedOrders < CONFIDENCE_HALF_LIFE_ORDERS) {
    reasons.push(
      `Only ${completedOrders} completed order(s); rates are shrunk toward the ${pct(NEUTRAL_PRIOR)} prior to avoid over-reacting to a small sample.`,
    );
  }

  reasons.push(`On-time delivery ${pct(components.onTime)} (weight 35%).`);
  reasons.push(`Quality acceptance ${pct(components.quality)} (weight 25%).`);
  reasons.push(`Fill rate ${pct(components.fill)} (weight 20%).`);

  if (leadTimeMean > 0) {
    reasons.push(
      `Lead time ${leadTimeMean.toFixed(1)} ± ${leadTimeStd.toFixed(1)} days → stability ${pct(components.leadTimeStability)} (weight 15%).`,
    );
  }
  if (components.commitment < 1) {
    reasons.push(`Cancellations reduce the commitment component to ${pct(components.commitment)}.`);
  }
  return reasons;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
