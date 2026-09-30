/** The API's ceiling for the TomTom daily tile budget (`PUT /settings/traffic`). */
export const MAX_BUDGET = 10_000_000;

/** A whole number of tiles from 0 (unlimited) to the API's ceiling, or null for anything else. */
export function parseBudget(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,8}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value <= MAX_BUDGET ? value : null;
}
