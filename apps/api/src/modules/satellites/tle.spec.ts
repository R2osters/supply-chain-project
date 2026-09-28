import { hasValidChecksum, parseCatalogNumber, parseTle, parseTleEpoch, tleChecksum } from './tle';

// The canonical ISS example from the TLE format documentation (epoch 2008-09-20).
const ISS_NAME = 'ISS (ZARYA)';
const ISS_1 = '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927';
const ISS_2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';
// A synthetic geostationary set with valid checksums (epoch 2026-04-10 12:00 UTC).
const GEO_1 = '1 90001U 26001A   26100.50000000  .00000000  00000-0  00000-0 0  9993';
const GEO_2 = '2 90001   0.0500  80.0000 0002000 100.0000 180.0000  1.00270000  1008';

describe('tleChecksum', () => {
  it('counts digits and minus signs modulo 10', () => {
    expect(tleChecksum(ISS_1)).toBe(7);
    expect(tleChecksum(ISS_2)).toBe(7);
    expect(hasValidChecksum(ISS_1)).toBe(true);
  });

  it('fails a line with one corrupted digit', () => {
    const corrupted = ISS_2.replace('51.6416', '51.6417');
    expect(hasValidChecksum(corrupted)).toBe(false);
  });
});

describe('parseTleEpoch', () => {
  it('reads a two-digit year and fractional day of year', () => {
    expect(parseTleEpoch(GEO_1)?.toISOString()).toBe('2026-04-10T12:00:00.000Z');
    expect(parseTleEpoch(ISS_1)?.toISOString().slice(0, 16)).toBe('2008-09-20T12:25');
  });

  it('maps years 57 to 99 to the twentieth century', () => {
    const line = '1 00005U 58002B   58065.50000000';
    expect(parseTleEpoch(line.padEnd(69, ' '))?.getUTCFullYear()).toBe(1958);
  });
});

describe('parseCatalogNumber', () => {
  it('decodes numeric and Alpha-5 catalogue numbers', () => {
    expect(parseCatalogNumber('25544')).toBe(25544);
    expect(parseCatalogNumber('A0000')).toBe(100000);
    expect(parseCatalogNumber('J2345')).toBe(182345); // J = 18, because I is skipped
    expect(parseCatalogNumber('I0000')).toBeNull();
  });
});

describe('parseTle', () => {
  it('parses three-line sets with CRLF endings and blank lines', () => {
    const text = `${ISS_NAME}\r\n${ISS_1}\r\n${ISS_2}\r\n\r\nSYNTH GEO\n${GEO_1}\n${GEO_2}\n`;
    const records = parseTle(text);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ noradId: 25544, name: 'ISS (ZARYA)', line1: ISS_1, line2: ISS_2 });
    expect(records[1].epoch).toBe('2026-04-10T12:00:00.000Z');
  });

  it('skips a set with a bad checksum but keeps the rest', () => {
    const bad = ISS_2.slice(0, 68) + '0';
    const records = parseTle(`${ISS_NAME}\n${ISS_1}\n${bad}\nSYNTH GEO\n${GEO_1}\n${GEO_2}`);
    expect(records.map((r) => r.noradId)).toEqual([90001]);
  });

  it('rejects lines whose catalogue numbers disagree', () => {
    expect(parseTle(`MIXED\n${ISS_1}\n${GEO_2}`)).toEqual([]);
  });

  it('resynchronises after a set with no name line', () => {
    const records = parseTle(`${ISS_1}\n${ISS_2}\nSYNTH GEO\n${GEO_1}\n${GEO_2}`);
    expect(records.map((r) => r.noradId)).toEqual([90001]);
  });

  it('returns nothing for an upstream error page', () => {
    expect(parseTle('<html><body>No GP data found</body></html>')).toEqual([]);
  });
});
