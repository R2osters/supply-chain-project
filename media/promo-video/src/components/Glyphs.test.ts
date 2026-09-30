// src/components/Glyphs.test.ts — Ruling R13: the arrow and the check mark are drawn, because the pinned Plex faces
// have no U+2192 or U+2713 glyph. They must size to the text they sit in and take their colour from the caller.
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Arrow, Check, GLYPH_STROKE} from './Glyphs';

const html = (el: ReturnType<typeof createElement>): string => renderToStaticMarkup(el);

describe('Glyphs', () => {
  it.each([
    ['Arrow', Arrow],
    ['Check', Check],
  ])('%s is an inline SVG the height of the font size, stroked in the given colour', (_, Glyph) => {
    const out = html(createElement(Glyph, {size: 24, color: '#141516'}));
    expect(out.startsWith('<svg')).toBe(true);
    expect(out).toContain('height="24"');
    expect(out).toContain('stroke="#141516"');
    expect(out).toContain('fill="none"');
    expect(out).not.toMatch(/[→✓]/);
  });

  it('weights the stroke like a Plex Medium stem by default and accepts an explicit weight', () => {
    expect(GLYPH_STROKE).toBeGreaterThan(0.06);
    expect(GLYPH_STROKE).toBeLessThan(0.12);
    // viewBox units are 24 per em, so the default stroke is GLYPH_STROKE em (2 units) whatever the size.
    expect(GLYPH_STROKE).toBeCloseTo(2 / 24, 12);
    expect(html(createElement(Arrow, {size: 48, color: '#000'}))).toContain('stroke-width="2"');
    expect(html(createElement(Check, {size: 120, color: '#000'}))).toContain('stroke-width="2"');
    expect(html(createElement(Arrow, {size: 48, color: '#000', strokeWidth: 6}))).toContain('stroke-width="3"');
    expect(html(createElement(Check, {size: 24, color: '#000', strokeWidth: 2}))).toContain('stroke-width="2"');
  });
});
