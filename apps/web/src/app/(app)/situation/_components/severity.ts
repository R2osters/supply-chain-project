import type { HazardSeverity } from '@/lib/intel';

type Tone = 'ok' | 'warn' | 'alert' | 'info' | 'signal' | 'neutral';

export function severityTone(severity: HazardSeverity): Tone {
  switch (severity) {
    case 'CRITICAL':
    case 'HIGH':
      return 'alert';
    case 'MEDIUM':
      return 'warn';
    default:
      return 'neutral';
  }
}
