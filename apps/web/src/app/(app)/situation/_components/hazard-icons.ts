import type maplibregl from 'maplibre-gl';
import type { HazardKind, HazardTone } from '@/lib/intel';
import type { Palette } from '@/lib/theme';
import { hazardIconId } from './map-layers';

/**
 * Turns the Lucide kind icons into MapLibre sprites, one per kind and tone (4 × 3).
 *
 * The page renders the four icons once in a hidden node; this reads their SVG, recolours the
 * stroke with the palette and registers each as an image. Reusing the rendered Lucide markup keeps
 * the map pictograms identical to the list and detail panels, without shipping a sprite sheet or a
 * glyph server. Called again on a theme switch: `updateImage` swaps pixels in place.
 */
const SIZE = 32; // drawn at 16 css px on a 2× sprite

export async function installHazardIcons(
  map: maplibregl.Map,
  host: HTMLElement,
  palette: Palette,
): Promise<void> {
  const tones: Record<HazardTone, string> = { crit: palette.crit, warn: palette.warn, muted: palette.muted };
  const serializer = new XMLSerializer();
  const jobs: Array<Promise<void>> = [];

  host.querySelectorAll<SVGElement>('svg[data-kind]').forEach((source) => {
    const kind = source.getAttribute('data-kind') as HazardKind;
    for (const [tone, colour] of Object.entries(tones) as Array<[HazardTone, string]>) {
      const svg = source.cloneNode(true) as SVGElement;
      svg.removeAttribute('class');
      svg.removeAttribute('data-kind');
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      svg.setAttribute('width', String(SIZE));
      svg.setAttribute('height', String(SIZE));
      svg.setAttribute('stroke', colour);
      const markup = serializer.serializeToString(svg);
      jobs.push(
        loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`).then((image) => {
          const id = hazardIconId(kind, tone);
          try {
            if (map.hasImage(id)) map.updateImage(id, image);
            else map.addImage(id, image, { pixelRatio: 2 });
          } catch {
            // The map was torn down while the image decoded; nothing left to draw on.
          }
        }),
      );
    }
  });

  await Promise.allSettled(jobs);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image(SIZE, SIZE);
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}
