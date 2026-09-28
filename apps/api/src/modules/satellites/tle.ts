/**
 * Two-line element sets, parsed strictly.
 *
 * A TLE is a fixed-column format from the punch-card era, and SGP4 will happily propagate a
 * corrupted one into a satellite that is confidently in the wrong place. So a set is accepted
 * only when both lines have the right length and line numbers, both modulo-10 checksums hold,
 * and both lines name the same catalogue number. An upstream error page, a truncated download or
 * a line mangled in transit fails one of those checks and is dropped rather than drawn.
 *
 * Format reference: https://celestrak.org/columns/v04n03/ (T.S. Kelso, "Frequently Asked
 * Questions: Two-Line Element Set Format").
 */

export interface TleRecord {
  noradId: number;
  name: string;
  line1: string;
  line2: string;
  /** ISO-8601 instant the elements describe; accuracy decays with distance from it. */
  epoch: string;
}

const LINE_LENGTH = 69;

/**
 * The TLE checksum: sum of all digits in columns 1–68, with each minus sign counting as 1,
 * modulo 10. Letters, spaces, periods and plus signs count as 0.
 */
export function tleChecksum(line: string): number {
  let sum = 0;
  for (const char of line.slice(0, LINE_LENGTH - 1)) {
    if (char >= '0' && char <= '9') sum += Number(char);
    else if (char === '-') sum += 1;
  }
  return sum % 10;
}

export function hasValidChecksum(line: string): boolean {
  return line.length === LINE_LENGTH && /^\d$/.test(line[68]) && tleChecksum(line) === Number(line[68]);
}

/**
 * Catalogue number from columns 3–7. The catalogue passed 99 999 objects, so CelesTrak uses the
 * "Alpha-5" scheme: a leading letter stands for 10–33 (I and O skipped, as they read like 1 and 0).
 */
export function parseCatalogNumber(field: string): number | null {
  const value = field.trim();
  if (/^\d{1,5}$/.test(value)) return Number(value);
  const match = /^([A-HJ-NP-Z])(\d{4})$/.exec(value);
  if (!match) return null;
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  return (letters.indexOf(match[1]) + 10) * 10_000 + Number(match[2]);
}

/**
 * Epoch from line 1 columns 19–32: two-digit year (57–99 means 19xx, the Sputnik convention) and
 * a fractional day of year, where day 1.0 is 1 January 00:00 UTC.
 */
export function parseTleEpoch(line1: string): Date | null {
  const yearField = line1.slice(18, 20);
  const dayField = line1.slice(20, 32).trim();
  if (!/^\d{2}$/.test(yearField) || !/^\d{1,3}\.\d+$/.test(dayField)) return null;
  const twoDigit = Number(yearField);
  const year = twoDigit < 57 ? 2000 + twoDigit : 1900 + twoDigit;
  const dayOfYear = Number(dayField);
  if (dayOfYear < 1 || dayOfYear >= 367) return null;
  return new Date(Date.UTC(year, 0, 1) + (dayOfYear - 1) * 86_400_000);
}

/** Validates one name/line1/line2 triple; null when any check fails. */
export function parseTleSet(nameLine: string, line1: string, line2: string): TleRecord | null {
  if (!line1.startsWith('1 ') || !line2.startsWith('2 ')) return null;
  if (!hasValidChecksum(line1) || !hasValidChecksum(line2)) return null;

  const noradId = parseCatalogNumber(line1.slice(2, 7));
  if (noradId === null || noradId !== parseCatalogNumber(line2.slice(2, 7))) return null;

  const epoch = parseTleEpoch(line1);
  if (!epoch) return null;

  // Line 0 may carry the optional "0 " prefix used by some catalogues (e.g. Space-Track 3LE).
  const name = nameLine.replace(/^0 /, '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
  return { noradId, name: name || `NORAD ${noradId}`, line1, line2, epoch: epoch.toISOString() };
}

/**
 * Parses a CelesTrak `FORMAT=tle` body (three-line sets). Invalid sets are skipped individually:
 * one corrupt satellite should not blank out the other thirty in the group.
 */
export function parseTle(text: string): TleRecord[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  const records: TleRecord[] = [];
  const seen = new Set<number>();
  for (let i = 0; i + 2 < lines.length; ) {
    const [nameLine, line1, line2] = [lines[i], lines[i + 1], lines[i + 2]];
    if (!nameLine.startsWith('1 ') && line1.startsWith('1 ') && line2.startsWith('2 ')) {
      const record = parseTleSet(nameLine, line1, line2);
      if (record && !seen.has(record.noradId)) {
        records.push(record);
        seen.add(record.noradId);
      }
      i += 3;
    } else {
      // Out of step (a missing name line, a stray blank): advance one line and resynchronise.
      i += 1;
    }
  }
  return records;
}
