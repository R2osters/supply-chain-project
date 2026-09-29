// Guards the "IBM Plex only" rule for numbers: every character the French formatters can emit must have a glyph
// in every pinned face, otherwise the browser draws it from a system font (or a notdef box) and the render depends
// on the machine. Regression for U+202F (narrow no-break space), which none of the Plex faces contain.
/// <reference types="node" />
import fs from 'node:fs';
import zlib from 'node:zlib';
import {frInt, frDecimal, frPercent} from './format';

const ROOT = new URL('../../', import.meta.url);

// Table tags in WOFF2's known-tag order (spec section 5.1); only the index of 'cmap' (0) matters here.
const KNOWN_TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];

const readBase128 = (buf: Buffer, pos: {p: number}): number => {
  let v = 0;
  for (let i = 0; i < 5; i++) {
    const b = buf[pos.p++];
    v = (v << 7) | (b & 0x7f);
    if (!(b & 0x80)) return v >>> 0;
  }
  throw new Error('invalid UIntBase128');
};

/** Code points covered by a WOFF2 font's cmap (formats 4 and 12; the cmap table is never transformed in WOFF2). */
const woff2Cmap = (file: URL): Set<number> => {
  const buf = fs.readFileSync(file);
  if (buf.toString('latin1', 0, 4) !== 'wOF2') throw new Error(`not a WOFF2 file: ${file.pathname}`);
  const numTables = buf.readUInt16BE(12);
  const compressedSize = buf.readUInt32BE(20);
  const pos = {p: 48};
  const tables: Array<{tag: string; length: number}> = [];
  for (let i = 0; i < numTables; i++) {
    const flags = buf[pos.p++];
    let tag: string;
    if ((flags & 0x3f) === 0x3f) { tag = buf.toString('latin1', pos.p, pos.p + 4); pos.p += 4; } else tag = KNOWN_TAGS[flags & 0x3f];
    const version = flags >> 6;
    const origLength = readBase128(buf, pos);
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    tables.push({tag, length: transformed ? readBase128(buf, pos) : origLength});
  }
  const data = zlib.brotliDecompressSync(buf.subarray(pos.p, pos.p + compressedSize));
  let offset = 0;
  let cmap: Buffer | undefined;
  for (const t of tables) {
    if (t.tag === 'cmap') cmap = data.subarray(offset, offset + t.length);
    offset += t.length;
  }
  if (!cmap) throw new Error(`no cmap table in ${file.pathname}`);
  const covered = new Set<number>();
  const subtables = cmap.readUInt16BE(2);
  for (let i = 0; i < subtables; i++) {
    const o = cmap.readUInt32BE(8 + i * 8);
    const format = cmap.readUInt16BE(o);
    if (format === 4) {
      const segX2 = cmap.readUInt16BE(o + 6);
      const endO = o + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2;
      for (let s = 0; s < segX2; s += 2) {
        const end = cmap.readUInt16BE(endO + s), start = cmap.readUInt16BE(startO + s);
        const delta = cmap.readInt16BE(deltaO + s), rangeOffset = cmap.readUInt16BE(rangeO + s);
        for (let c = start; c <= end && c < 0xffff; c++) {
          let g: number;
          if (rangeOffset === 0) g = (c + delta) & 0xffff;
          else { g = cmap.readUInt16BE(rangeO + s + rangeOffset + (c - start) * 2); if (g) g = (g + delta) & 0xffff; }
          if (g) covered.add(c);
        }
      }
    } else if (format === 12) {
      const groups = cmap.readUInt32BE(o + 12);
      for (let g = 0; g < groups; g++) {
        const b = o + 16 + g * 12;
        for (let c = cmap.readUInt32BE(b); c <= cmap.readUInt32BE(b + 4); c++) covered.add(c);
      }
    }
  }
  return covered;
};

/** The faces `fonts.ts` loads, read from its own import specifiers so this test cannot drift from it. */
const pinnedFaces = (): URL[] => {
  const src = fs.readFileSync(new URL('src/theme/fonts.ts', ROOT), 'utf8');
  const specs = [...src.matchAll(/from '(@fontsource\/[^']+\.woff2)'/g)].map((m) => m[1]);
  return specs.map((s) => new URL(`node_modules/${s}`, ROOT));
};

/** Every distinct character the formatters emit over magnitudes 0 to 10 million, plus decimals and percents. */
const emittedChars = (): Set<string> => {
  const out = new Set<string>();
  const add = (s: string) => { for (const ch of s) out.add(ch); };
  for (const n of [0, 7, 68, 999, 1000, 3000, 20000, 999999, 1000000, 9999999]) { add(frInt(n)); add(frPercent(n)); }
  for (const n of [0, 0.5, 24.13, 1234.5678]) add(frDecimal(n, 2));
  return out;
};

describe('French formatters vs the pinned Plex faces', () => {
  const faces = pinnedFaces();

  it('reads all 7 faces from fonts.ts', () => {
    expect(faces).toHaveLength(7);
  });

  it('emits a non-ASCII separator only from the no-break space (U+00A0)', () => {
    const nonAscii = [...emittedChars()].filter((ch) => ch.charCodeAt(0) > 0x7f);
    expect(nonAscii.map((ch) => ch.charCodeAt(0).toString(16))).toEqual(['a0']);
  });

  it.each(faces.map((f) => [f.pathname.split('/').pop() ?? f.pathname, f] as const))('%s has a glyph for every emitted character', (_name, face) => {
    const cmap = woff2Cmap(face);
    const missing = [...emittedChars()].filter((ch) => !cmap.has(ch.codePointAt(0) as number));
    expect(missing.map((ch) => 'U+' + (ch.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0'))).toEqual([]);
  });
});
