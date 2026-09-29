'use client';

import maplibregl, { type Map as MapLibreMap, type Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import type { FleetVehicle } from '@/lib/api';
import { useI18n, type TranslationKey } from '@/lib/i18n';
import { basemapStyle, useBasemapTheme, watchBasemapTiles } from '@/lib/map-style';
import { isTrackAnimating, positionAt, startTrack, type MotionTrack } from '@/lib/motion';
import { usePalette } from '@/lib/theme';

export interface WarehousePoint {
  id: string;
  code: string;
  name: string;
  latitude: number;
  longitude: number;
}

/** How a vehicle reads on the corridor: grey unless it is an exception. */
export type VehicleState = 'nominal' | 'risk' | 'late';

export function vehicleState(vehicle: FleetVehicle): VehicleState {
  if (vehicle.shipmentStatus === 'DELAYED') return 'late';
  if ((vehicle.delayProbability ?? 0) >= 0.5) return 'risk';
  return 'nominal';
}

const STATE_FILL: Record<VehicleState, string> = {
  nominal: 'var(--color-ink)',
  risk: 'var(--color-warn)',
  late: 'var(--color-crit)',
};

const STATE_LABEL: Record<VehicleState, TranslationKey> = {
  nominal: 'dash.v3.legend.nominal',
  risk: 'dash.v3.legend.risk',
  late: 'dash.v3.legend.late',
};

interface VehicleMotion {
  track: MotionTrack;
  lastFixAt: number;
  fixTime: number;
}

/**
 * The compact corridor on Control. Deliberately read-only: selecting and inspecting a vehicle is
 * the live map's job; here the operator only needs to see where the exceptions sit on the
 * network. Markers are DOM elements styled with CSS variables, so a theme switch recolours them
 * without any repaint code — only the basemap needs `useBasemapTheme`.
 */
export function CorridorMap({
  vehicles,
  warehouses,
}: {
  vehicles: FleetVehicle[] | undefined;
  warehouses: WarehousePoint[] | undefined;
}) {
  const { t } = useI18n();
  const palette = usePalette();
  const container = useRef<HTMLDivElement | null>(null);
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const markers = useRef<Map<string, { marker: Marker; dot: HTMLDivElement }>>(new Map());
  const depots = useRef<Marker[]>([]);
  const motions = useRef<Map<string, VehicleMotion>>(new Map());
  const frame = useRef<number | null>(null);
  const framed = useRef(false);

  useBasemapTheme(map, palette);

  useEffect(() => {
    if (!container.current) return;
    const styleUrl = process.env.NEXT_PUBLIC_MAP_STYLE_URL;
    const instance = new maplibregl.Map({
      container: container.current,
      style: styleUrl && styleUrl.length > 0 ? styleUrl : basemapStyle(palette),
      center: [-1.0, 6.6], // central Ghana: the demo corridor fits in one view
      zoom: 5.8,
      attributionControl: { compact: true },
      cooperativeGestures: true,
    });
    watchBasemapTiles(instance);
    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    instance.on('load', () => setReady(true));
    setMap(instance);
    const currentMarkers = markers.current;
    const currentMotions = motions.current;
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      instance.remove();
      currentMarkers.clear();
      currentMotions.clear();
      depots.current = [];
      framed.current = false;
      setMap(null);
      setReady(false);
    };
    // The palette is only the initial style; later theme switches go through useBasemapTheme.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------------------------------------- motion */

  const animate = (): void => {
    const now = performance.now();
    let pending = false;
    for (const [id, motion] of motions.current) {
      const entry = markers.current.get(id);
      if (!entry) continue;
      const point = positionAt(motion.track, now);
      entry.marker.setLngLat([point.longitude, point.latitude]);
      if (isTrackAnimating(motion.track, now)) pending = true;
    }
    frame.current = pending ? requestAnimationFrame(animate) : null;
  };

  const applyFix = (vehicle: FleetVehicle, marker: Marker): void => {
    // An estimated position has no fix time; "now" lets it move to each new estimate.
    const fixTime = vehicle.lastPositionAt ? Date.parse(vehicle.lastPositionAt) : Date.now();
    const previous = motions.current.get(vehicle.vehicleId);
    if (previous && previous.fixTime === fixTime) return;
    const reduced =
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      // Charte §10: with reduced motion the markers jump, they never glide.
      marker.setLngLat([vehicle.longitude, vehicle.latitude]);
      motions.current.delete(vehicle.vehicleId);
      return;
    }
    const now = performance.now();
    const drawn = marker.getLngLat();
    motions.current.set(vehicle.vehicleId, {
      track: startTrack(
        previous ? { latitude: drawn.lat, longitude: drawn.lng } : null,
        vehicle,
        now,
        previous ? now - previous.lastFixAt : null,
      ),
      lastFixAt: now,
      fixTime,
    });
    if (frame.current === null) frame.current = requestAnimationFrame(animate);
  };

  /* ------------------------------------------------------------ vehicles */

  useEffect(() => {
    if (!ready || !map || !vehicles) return;

    for (const vehicle of vehicles) {
      const state = vehicleState(vehicle);
      let entry = markers.current.get(vehicle.vehicleId);
      if (!entry) {
        // DOM calls, not innerHTML: plate numbers are tenant-supplied text.
        const element = document.createElement('div');
        element.style.cssText = 'width:16px;height:16px;display:grid;place-items:center;cursor:default';
        const dot = document.createElement('div');
        element.append(dot);
        const marker = new maplibregl.Marker({ element })
          .setLngLat([vehicle.longitude, vehicle.latitude])
          .addTo(map);
        entry = { marker, dot };
        markers.current.set(vehicle.vehicleId, entry);
      }
      // Restyle on every poll: a vehicle can enter or leave the at-risk set between two fixes.
      entry.dot.style.cssText = [
        'width:10px;height:10px;border-radius:999px',
        `background:${STATE_FILL[state]}`,
        'box-shadow:0 0 0 2px var(--color-surface-2)',
        vehicle.isDemoData ? 'outline:1.5px dashed var(--color-sim);outline-offset:3px' : '',
      ].join(';');
      const title = [
        vehicle.plateNumber,
        t(STATE_LABEL[state]),
        vehicle.trackingNumber ?? '',
        vehicle.isDemoData ? t('prov.demo') : '',
      ]
        .filter(Boolean)
        .join(' · ');
      entry.marker.getElement().title = title;
      entry.marker.getElement().setAttribute('aria-label', title);
      applyFix(vehicle, entry.marker);
    }

    // Vehicles that stopped reporting leave the map, or it slowly fills with ghosts.
    const alive = new Set(vehicles.map((vehicle) => vehicle.vehicleId));
    for (const [id, entry] of markers.current) {
      if (!alive.has(id)) {
        entry.marker.remove();
        markers.current.delete(id);
        motions.current.delete(id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, map, vehicles, t]);

  /* ---------------------------------------------------------- warehouses */

  useEffect(() => {
    if (!ready || !map || !warehouses) return;
    for (const marker of depots.current) marker.remove();
    depots.current = warehouses.map((warehouse) => {
      const element = document.createElement('div');
      element.style.cssText = 'position:relative';
      element.title = warehouse.name;
      const square = document.createElement('div');
      square.style.cssText =
        'width:8px;height:8px;border:1.5px solid var(--color-muted);background:var(--color-surface-2);border-radius:2px';
      const label = document.createElement('div');
      label.style.cssText =
        'position:absolute;left:12px;top:-4px;white-space:nowrap;font-family:var(--font-mono);font-size:11px;color:var(--color-muted)';
      label.textContent = warehouse.code;
      element.append(square, label);
      return new maplibregl.Marker({ element })
        .setLngLat([warehouse.longitude, warehouse.latitude])
        .addTo(map);
    });
  }, [ready, map, warehouses]);

  /* --------------------------------------------------------------- frame */

  useEffect(() => {
    if (!ready || !map || framed.current) return;
    const points = [
      ...(vehicles ?? []).map((vehicle) => [vehicle.longitude, vehicle.latitude] as [number, number]),
      ...(warehouses ?? []).map((warehouse) => [warehouse.longitude, warehouse.latitude] as [number, number]),
    ];
    if (points.length < 2) return;
    const bounds = points.reduce(
      (box, point) => box.extend(point),
      new maplibregl.LngLatBounds(points[0], points[0]),
    );
    map.fitBounds(bounds, { padding: 40, maxZoom: 9, duration: 0 });
    framed.current = true;
  }, [ready, map, vehicles, warehouses]);

  return (
    <div className="relative h-full min-h-[320px] w-full overflow-hidden rounded-[var(--radius-md)] bg-[var(--color-map)]">
      <div ref={container} className="absolute inset-0" />
      {!ready && <div className="skeleton absolute inset-0" aria-hidden />}
    </div>
  );
}
