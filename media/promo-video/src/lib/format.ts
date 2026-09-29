// src/lib/format.ts — French typography: narrow no-break space (U+202F) for thousands, no-break space (U+00A0) before %.
// The characters are written as escapes on purpose: both are invisible and easy to lose in an editor.
export const frInt = (n: number): string => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');
export const frDecimal = (n: number, digits: number): string => n.toFixed(digits).replace('.', ',');
export const frPercent = (n: number): string => `${frInt(n)}\u00a0%`;
