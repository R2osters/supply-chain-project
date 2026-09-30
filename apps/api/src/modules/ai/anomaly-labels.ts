/**
 * French names for anomaly types, shared by the shipment timeline (ai.service.ts) and the alert
 * the domain-event worker sends, so both name an anomaly the same way. The stored `type` and the
 * event metadata keep the codes; only the sentence a person reads uses these names.
 */
export const ANOMALY_LABELS: Record<string, string> = {
  UNUSUAL_STOP: 'arrêt inhabituel',
  ROUTE_DEVIATION: 'écart d’itinéraire',
  ABNORMAL_SPEED: 'vitesse anormale',
  GPS_LOSS: 'perte du signal GPS',
  EXCESSIVE_DURATION: 'durée excessive',
  PROLONGED_STOP: 'arrêt prolongé',
  SUSPICIOUS_DELIVERY: 'livraison suspecte',
  GEOFENCE_BREACH: 'sortie de zone',
};

/** An unknown type is shown as sent rather than dropped. */
export function anomalyLabel(type: string): string {
  return ANOMALY_LABELS[type] ?? type;
}

/** "2 anomalies détectées : arrêt prolongé, écart d’itinéraire" — at most three types named. */
export function anomalyEventDescription(created: number, types: string[]): string {
  const noun = created > 1 ? 'anomalies détectées' : 'anomalie détectée';
  return `${created} ${noun} : ${types.slice(0, 3).map(anomalyLabel).join(', ')}`;
}
