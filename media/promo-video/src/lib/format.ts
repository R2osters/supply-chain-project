// src/lib/format.ts — French typography: no-break space (U+00A0) for thousands and before %.
// U+00A0 rather than the narrow no-break space (U+202F): none of the pinned IBM Plex faces has a U+202F glyph, so it
// would be drawn from a system fallback font (or a notdef box) and the render would depend on the machine.
// format.glyphs.test.ts checks every emitted character against the faces' cmap tables.
// The characters are written as escapes on purpose: they are invisible and easy to lose in an editor.
export const frInt = (n: number): string => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
export const frDecimal = (n: number, digits: number): string => n.toFixed(digits).replace('.', ',');
export const frPercent = (n: number): string => `${frInt(n)} %`;
