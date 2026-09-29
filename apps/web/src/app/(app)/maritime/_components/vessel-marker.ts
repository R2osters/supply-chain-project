import type { Marker } from 'maplibre-gl';

/**
 * Vessel classification and DOM markers for the maritime map. Colours are CSS variables so the
 * markers follow the theme without a repaint; GL tracks are repainted by the page.
 */

/** Below this a ship is at anchor or alongside. */
export const STATIONARY_KNOTS = 0.5;
/** AIS reports every few minutes at sea; an hour of silence means the picture is old. */
export const AIS_STALE_AFTER_MIN = 60;
/** Hours behind schedule from which an arrival is "at risk", then "late". */
export const AT_RISK_HOURS = 2;
export const LATE_HOURS = 12;

export type VesselState = 'delayed' | 'atRisk' | 'moving' | 'stopped';

export interface VesselLike {
  vesselId: string;
  name: string;
  speedKnots: number | null;
  courseDegrees: number | null;
  isDemoData: boolean;
  positionSource: string | null;
}

export function isSimulatedVessel(vessel: Pick<VesselLike, 'isDemoData' | 'positionSource'>): boolean {
  return vessel.isDemoData || vessel.positionSource === 'SIMULATOR';
}

/** `deltaHours` = ETA − schedule; positive is behind. `null` when no voyage or no schedule. */
export function vesselState(vessel: VesselLike, deltaHours: number | null): VesselState {
  if (deltaHours !== null && deltaHours >= LATE_HOURS) return 'delayed';
  if (deltaHours !== null && deltaHours >= AT_RISK_HOURS) return 'atRisk';
  return (vessel.speedKnots ?? 0) < STATIONARY_KNOTS ? 'stopped' : 'moving';
}

export const VESSEL_COLOUR: Record<VesselState, string> = {
  delayed: 'var(--color-crit)',
  atRisk: 'var(--color-warn)',
  moving: 'var(--color-ink)',
  stopped: 'var(--color-muted)',
};

/**
 * A hull outline rather than a chevron: at a glance it reads as a ship, not a truck. Built with
 * DOM/SVG calls, never innerHTML: vessel names come from an external AIS feed and are entirely
 * attacker-controlled text.
 */
export function buildVesselMarker(vessel: VesselLike, onSelect: () => void): HTMLElement {
  const element = document.createElement('div');
  element.style.cursor = 'pointer';
  element.title = vessel.name;
  element.setAttribute('role', 'button');
  element.setAttribute('aria-label', vessel.name);
  element.tabIndex = 0;
  element.addEventListener('click', onSelect);
  element.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect();
    }
  });

  const frame = document.createElement('div');
  frame.dataset.frame = 'true';
  frame.style.cssText =
    'position:relative;width:22px;height:22px;transition:transform 200ms cubic-bezier(.2,.8,.2,1)';

  const selection = document.createElement('div');
  selection.dataset.selection = 'true';
  selection.style.cssText = 'position:absolute;inset:-5px;border-radius:999px;pointer-events:none';

  const demo = document.createElement('div');
  demo.dataset.demo = 'true';
  demo.style.cssText = 'position:absolute;inset:-1px;border-radius:999px;pointer-events:none';

  const rotor = document.createElement('div');
  rotor.dataset.rotor = 'true';
  rotor.style.cssText =
    'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;transition:transform .5s ease';
  const heading = Number.isFinite(vessel.courseDegrees) ? Number(vessel.courseDegrees) : 0;
  rotor.style.transform = `rotate(${heading}deg)`;

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 16 16');
  const path = document.createElementNS(ns, 'path');
  path.dataset.hull = 'true';
  path.setAttribute('d', 'M8 0.5 L11 6 L11 12 L8 14.5 L5 12 L5 6 Z');
  path.setAttribute('stroke', 'var(--color-surface-2)');
  path.setAttribute('stroke-width', '1.25');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  rotor.append(svg);

  frame.append(selection, demo, rotor);
  element.append(frame);
  return element;
}

export function paintVesselMarker(
  element: HTMLElement,
  vessel: VesselLike,
  state: VesselState,
  selected: boolean,
): void {
  element.querySelector<SVGPathElement>('[data-hull]')?.setAttribute('fill', VESSEL_COLOUR[state]);
  const frame = element.querySelector<HTMLElement>('[data-frame]');
  if (frame) frame.style.transform = selected ? 'scale(1.3)' : 'scale(1)';
  const selection = element.querySelector<HTMLElement>('[data-selection]');
  if (selection) {
    selection.style.border = selected ? '2px solid var(--color-accent)' : '0';
    selection.style.background = selected
      ? 'color-mix(in srgb, var(--color-surface-2) 55%, transparent)'
      : 'transparent';
  }
  const demo = element.querySelector<HTMLElement>('[data-demo]');
  if (demo) demo.style.border = isSimulatedVessel(vessel) ? '1.5px dashed var(--color-sim)' : '0';
  element.style.zIndex = selected ? '4' : state === 'delayed' ? '3' : state === 'atRisk' ? '2' : '1';
  element.setAttribute('aria-pressed', String(selected));
}

export function rotateVessel(marker: Marker, course: number | null): void {
  if (course === null || !Number.isFinite(course)) return;
  const rotor = marker.getElement().querySelector<HTMLElement>('[data-rotor]');
  if (rotor) rotor.style.transform = `rotate(${course}deg)`;
}
