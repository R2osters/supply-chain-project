import { ANOMALY_TYPES } from '@scip/shared';
import { ANOMALY_LABELS, anomalyEventDescription, anomalyLabel } from './anomaly-labels';

describe('anomaly labels', () => {
  it('names every anomaly type the platform knows', () => {
    for (const type of ANOMALY_TYPES) expect(ANOMALY_LABELS[type]).toBeDefined();
  });

  it('shows an unknown type as sent rather than dropping it', () => {
    expect(anomalyLabel('NEW_KIND')).toBe('NEW_KIND');
  });

  it('writes the timeline sentence in French, singular or plural, three types at most', () => {
    expect(anomalyEventDescription(1, ['PROLONGED_STOP'])).toBe('1 anomalie détectée : arrêt prolongé');
    expect(
      anomalyEventDescription(4, ['ROUTE_DEVIATION', 'ABNORMAL_SPEED', 'GPS_LOSS', 'UNUSUAL_STOP']),
    ).toBe('4 anomalies détectées : écart d’itinéraire, vitesse anormale, perte du signal GPS');
  });
});
