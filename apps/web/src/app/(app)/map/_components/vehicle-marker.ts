import type { Marker } from 'maplibre-gl';
import type { FleetVehicle } from '@/lib/api';

/**
 * Vehicle classification and DOM markers for the live map.
 *
 * Markers are plain DOM (not a GL layer) so they can glide per frame without re-uploading a
 * source, and so their colours can be CSS variables: a theme switch repaints them for free.
 */

/** Below this the vehicle is parked; mirrors `lib/motion.ts`. */
export const STATIONARY_KMH = 3;

export type VehicleState = 'delayed' | 'atRisk' | 'moving' | 'stopped';

export type FleetFilter = 'all' | 'moving' | 'atRisk' | 'delayed' | 'stopped' | 'demo';

export const FLEET_FILTERS: FleetFilter[] = ['all', 'moving', 'atRisk', 'delayed', 'stopped', 'demo'];

export function vehicleState(vehicle: FleetVehicle): VehicleState {
  if (vehicle.shipmentStatus === 'DELAYED') return 'delayed';
  if ((vehicle.delayProbability ?? 0) >= 0.5) return 'atRisk';
  return (vehicle.speedKmh ?? 0) > STATIONARY_KMH ? 'moving' : 'stopped';
}

export function matchesFilter(vehicle: FleetVehicle, filter: FleetFilter): boolean {
  switch (filter) {
    case 'moving':
      return (vehicle.speedKmh ?? 0) > STATIONARY_KMH;
    case 'stopped':
      return (vehicle.speedKmh ?? 0) <= STATIONARY_KMH;
    case 'atRisk':
      return vehicleState(vehicle) === 'atRisk';
    case 'delayed':
      return vehicleState(vehicle) === 'delayed';
    case 'demo':
      return vehicle.isDemoData;
    default:
      return true;
  }
}

/** Charte: nominal stays ink (muted when parked); only exceptions earn ochre or red. */
export const STATE_COLOUR: Record<VehicleState, string> = {
  delayed: 'var(--color-crit)',
  atRisk: 'var(--color-warn)',
  moving: 'var(--color-ink)',
  stopped: 'var(--color-muted)',
};

/**
 * A rotated chevron rather than a pin: heading is real information and a pin throws it away.
 * Built with DOM/SVG calls rather than innerHTML so no server-supplied value is ever parsed as
 * markup — the plate only ever reaches `aria-label`/`title` as text.
 */
export function buildVehicleMarker(vehicle: FleetVehicle, onSelect: () => void): HTMLElement {
  const element = document.createElement('div');
  element.style.cursor = 'pointer';
  element.setAttribute('role', 'button');
  element.tabIndex = 0;
  element.setAttribute('aria-label', vehicle.plateNumber);
  element.title = vehicle.plateNumber;
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
    'position:relative;width:24px;height:24px;transition:transform 200ms cubic-bezier(.2,.8,.2,1)';

  // Selection ring (accent, solid) sits outside the demo ring so a selected simulated vehicle
  // still shows both facts.
  const selection = document.createElement('div');
  selection.dataset.selection = 'true';
  selection.style.cssText = 'position:absolute;inset:-5px;border-radius:999px;pointer-events:none';

  const demo = document.createElement('div');
  demo.dataset.demo = 'true';
  demo.style.cssText = 'position:absolute;inset:-1px;border-radius:999px;pointer-events:none';

  const rotor = document.createElement('div');
  rotor.dataset.rotor = 'true';
  rotor.style.cssText =
    'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;transition:transform .4s ease';
  const heading = Number.isFinite(vehicle.headingDegrees) ? Number(vehicle.headingDegrees) : 0;
  rotor.style.transform = `rotate(${heading}deg)`;

  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('viewBox', '0 0 16 16');
  const path = document.createElementNS(svgNs, 'path');
  path.dataset.hull = 'true';
  path.setAttribute('d', 'M8 1 L14 15 L8 11.5 L2 15 Z');
  path.setAttribute('stroke', 'var(--color-surface-2)');
  path.setAttribute('stroke-width', '1.25');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  rotor.append(svg);

  frame.append(selection, demo, rotor);
  element.append(frame);
  return element;
}

/** Applies state, selection and filter visibility to an existing marker element. */
export function paintVehicleMarker(
  element: HTMLElement,
  vehicle: FleetVehicle,
  options: { selected: boolean; visible: boolean },
): void {
  const state = vehicleState(vehicle);
  const hull = element.querySelector<SVGPathElement>('[data-hull]');
  const frame = element.querySelector<HTMLElement>('[data-frame]');
  const selection = element.querySelector<HTMLElement>('[data-selection]');
  const demo = element.querySelector<HTMLElement>('[data-demo]');

  hull?.setAttribute('fill', STATE_COLOUR[state]);
  if (frame) frame.style.transform = options.selected ? 'scale(1.25)' : 'scale(1)';
  if (selection) {
    selection.style.border = options.selected ? '2px solid var(--color-accent)' : '0';
    selection.style.background = options.selected
      ? 'color-mix(in srgb, var(--color-surface-2) 55%, transparent)'
      : 'transparent';
  }
  if (demo) demo.style.border = vehicle.isDemoData ? '1.5px dashed var(--color-sim)' : '0';

  element.style.display = options.visible ? '' : 'none';
  // Exceptions and the selection draw above nominal traffic.
  element.style.zIndex = options.selected ? '4' : state === 'delayed' ? '3' : state === 'atRisk' ? '2' : '1';
  element.setAttribute('aria-pressed', String(options.selected));
}

/** Turns the chevron to a new heading; a missing heading leaves the last known one in place. */
export function rotateMarker(marker: Marker, heading: number | null): void {
  if (heading === null || !Number.isFinite(heading)) return;
  const rotor = marker.getElement().querySelector<HTMLElement>('[data-rotor]');
  if (rotor) rotor.style.transform = `rotate(${heading}deg)`;
}

/** Warehouses: a neutral diamond with its code. Tenant data → text nodes only. */
export function buildWarehouseMarker(code: string): HTMLElement {
  const element = document.createElement('div');
  element.style.position = 'relative';

  const diamond = document.createElement('div');
  diamond.style.cssText =
    'width:9px;height:9px;border:1.5px solid var(--color-muted);background:var(--color-surface-2);transform:rotate(45deg)';

  const label = document.createElement('div');
  label.style.cssText =
    'position:absolute;left:14px;top:-4px;white-space:nowrap;font-family:var(--font-mono);font-size:11px;letter-spacing:.04em;color:var(--color-muted)';
  label.textContent = code;

  element.append(diamond, label);
  return element;
}
