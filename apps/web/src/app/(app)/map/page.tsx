'use client';

import { useQuery } from '@tanstack/react-query';
import maplibregl, { type Map as MapLibreMap, type Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { api, getAccessToken, type FleetVehicle } from '@/lib/api';
import { Chip, Empty, Panel, fmt, statusTone } from '@/components/ui';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'http://localhost:3001';

/**
 * Base map style.
 *
 * Raster OpenStreetMap tiles rather than Mapbox or Google: both of those need a paid API key,
 * and a map that cannot render without a credential this deployment does not have would be a
 * screenshot, not a feature. `NEXT_PUBLIC_MAP_STYLE_URL` swaps in any MapLibre-compatible style
 * (including Mapbox's) the moment a key exists.
 *
 * The tiles are desaturated and darkened in CSS so the basemap recedes and the fleet reads as
 * the foreground — on a default-bright basemap, amber vehicle markers disappear into the roads.
 */
const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#0c0e10' } },
    {
      id: 'osm',
      type: 'raster',
      source: 'osm',
      paint: { 'raster-opacity': 0.42, 'raster-saturation': -0.85, 'raster-contrast': -0.1 },
    },
  ],
};

interface WarehouseRow {
  id: string;
  code: string;
  name: string;
  latitude: number;
  longitude: number;
}

interface LivePosition {
  vehicleId: string;
  shipmentId: string | null;
  latitude: number;
  longitude: number;
  speedKmh: number | null;
  headingDegrees: number | null;
  recordedAt: string;
  isSimulated?: boolean;
}

export default function LiveMapPage() {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);
  const markers = useRef<Map<string, Marker>>(new Map());
  const socket = useRef<Socket | null>(null);

  const [ready, setReady] = useState(false);
  const [live, setLive] = useState(false);
  const [selected, setSelected] = useState<FleetVehicle | null>(null);
  const [lastTick, setLastTick] = useState<Date | null>(null);

  const fleet = useQuery({
    queryKey: ['telemetry', 'fleet'],
    queryFn: () => api<FleetVehicle[]>('/telemetry/fleet'),
    // The socket carries live movement; this poll is the safety net if it drops.
    refetchInterval: 30_000,
  });

  const warehouses = useQuery({
    queryKey: ['warehouses', 'all'],
    queryFn: () => api<{ data: WarehouseRow[] }>('/warehouses?limit=100'),
  });

  /* ------------------------------------------------------------------ map */

  useEffect(() => {
    if (!container.current || map.current) return;

    const styleUrl = process.env.NEXT_PUBLIC_MAP_STYLE_URL;
    const instance = new maplibregl.Map({
      container: container.current,
      style: styleUrl && styleUrl.length > 0 ? styleUrl : OSM_STYLE,
      center: [-1.0, 6.6], // central Ghana: the whole demo network fits in one view
      zoom: 6.4,
      attributionControl: { compact: true },
    });

    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    instance.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    instance.on('load', () => setReady(true));

    map.current = instance;
    return () => {
      instance.remove();
      map.current = null;
      setReady(false);
    };
  }, []);

  /* ------------------------------------------------------------ warehouses */

  useEffect(() => {
    if (!ready || !map.current || !warehouses.data) return;
    const instance = map.current;

    for (const warehouse of warehouses.data.data) {
      // Built with DOM calls rather than innerHTML: `warehouse.code` is tenant-supplied data,
      // and interpolating it into markup would make the warehouse name field an XSS vector.
      const element = document.createElement('div');
      element.className = 'relative';

      const diamond = document.createElement('div');
      diamond.style.cssText =
        'width:9px;height:9px;border:1.5px solid var(--color-info);background:var(--color-void);transform:rotate(45deg)';

      const label = document.createElement('div');
      label.style.cssText =
        'position:absolute;left:14px;top:-3px;white-space:nowrap;font-family:var(--font-mono);font-size:9px;letter-spacing:.1em;color:var(--color-ink-faint)';
      label.textContent = warehouse.code;

      element.append(diamond, label);
      new maplibregl.Marker({ element }).setLngLat([warehouse.longitude, warehouse.latitude]).addTo(instance);
    }
  }, [ready, warehouses.data]);

  /* --------------------------------------------------------------- fleet */

  useEffect(() => {
    if (!ready || !map.current || !fleet.data) return;
    const instance = map.current;

    for (const vehicle of fleet.data) {
      const existing = markers.current.get(vehicle.vehicleId);
      if (existing) {
        existing.setLngLat([vehicle.longitude, vehicle.latitude]);
        continue;
      }

      const element = buildVehicleMarker(vehicle);
      element.addEventListener('click', () => setSelected(vehicle));

      const marker = new maplibregl.Marker({ element })
        .setLngLat([vehicle.longitude, vehicle.latitude])
        .addTo(instance);

      markers.current.set(vehicle.vehicleId, marker);
    }

    // Drop markers for vehicles that stopped reporting, or the map slowly fills with ghosts.
    const alive = new Set(fleet.data.map((vehicle) => vehicle.vehicleId));
    for (const [id, marker] of markers.current) {
      if (!alive.has(id)) {
        marker.remove();
        markers.current.delete(id);
      }
    }
  }, [ready, fleet.data]);

  /* ---------------------------------------------------------- live socket */

  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;

    const connection = io(`${WS_URL}/tracking`, {
      auth: { token },
      transports: ['websocket'],
    });

    connection.on('connect', () => setLive(true));
    connection.on('disconnect', () => setLive(false));
    connection.on('connect_error', () => setLive(false));

    connection.on('position', (position: LivePosition) => {
      setLastTick(new Date());
      const marker = markers.current.get(position.vehicleId);
      // Moving the existing marker rather than re-rendering the layer keeps the motion smooth
      // and avoids a full React pass on every one of a dozen vehicles every few seconds.
      if (marker) marker.setLngLat([position.longitude, position.latitude]);
    });

    socket.current = connection;
    return () => {
      connection.close();
      socket.current = null;
    };
  }, []);

  const moving = useMemo(
    () => (fleet.data ?? []).filter((vehicle) => (vehicle.speedKmh ?? 0) > 3),
    [fleet.data],
  );

  return (
    <div className="grid h-[calc(100vh-105px)] gap-4 xl:grid-cols-[1fr_320px]">
      <Panel
        title="Live network"
        meta={
          <span className="flex items-center gap-1.5">
            <span className={`live-dot ${live ? '' : 'live-dot-stale'}`} />
            <span>{live ? 'streaming' : 'polling'}</span>
          </span>
        }
        actions={
          <span className="tnum">
            {moving.length} moving · {(fleet.data ?? []).length} reporting
            {lastTick && ` · ${fmt.time(lastTick)}`}
          </span>
        }
        className="overflow-hidden"
      >
        <div ref={container} className="h-[calc(100%-33px)] min-h-[420px] w-full" />
      </Panel>

      {/* ------------------------------------------------------------ side */}
      <div className="flex min-h-0 flex-col gap-4">
        {selected ? (
          <Panel
            title="Vehicle"
            actions={
              <button onClick={() => setSelected(null)} className="hover:text-[var(--color-signal)]">
                close
              </button>
            }
          >
            <div className="space-y-3 p-3.5">
              <div>
                <div className="font-mono text-lg text-[var(--color-signal)]">
                  {selected.plateNumber}
                </div>
                <div className="text-[0.75rem] text-[var(--color-ink-dim)]">
                  {selected.label} · {selected.type.replace(/_/g, ' ').toLowerCase()}
                </div>
              </div>

              <dl className="space-y-1.5">
                <Row label="Driver" value={selected.driverName ?? '—'} />
                <Row label="Speed" value={`${fmt.num(selected.speedKmh, 0)} km/h`} />
                <Row label="Heading" value={`${fmt.num(selected.headingDegrees, 0)}°`} />
                <Row label="Last fix" value={fmt.relative(selected.lastPositionAt)} />
                <Row
                  label="Position"
                  value={`${selected.latitude.toFixed(4)}, ${selected.longitude.toFixed(4)}`}
                />
              </dl>

              {selected.shipmentId ? (
                <div className="border-t border-[var(--color-hairline)] pt-3">
                  <div className="flex items-center justify-between gap-2">
                    <Link
                      href={`/shipments/${selected.shipmentId}`}
                      className="font-mono text-[0.75rem] text-[var(--color-ink)] hover:text-[var(--color-signal)]"
                    >
                      {selected.trackingNumber}
                    </Link>
                    <Chip tone={statusTone(selected.shipmentStatus ?? '')}>
                      {selected.shipmentStatus}
                    </Chip>
                  </div>
                  <dl className="mt-2 space-y-1.5">
                    <Row label="Destination" value={selected.destinationName ?? '—'} />
                    <Row label="ETA" value={fmt.dateTime(selected.estimatedArrivalAt)} />
                    <Row
                      label="Delay risk"
                      value={
                        selected.delayProbability === null
                          ? 'not computed'
                          : fmt.pct(selected.delayProbability)
                      }
                    />
                  </dl>
                </div>
              ) : (
                <p className="border-t border-[var(--color-hairline)] pt-3 text-[0.75rem] text-[var(--color-ink-faint)]">
                  No active shipment on this vehicle.
                </p>
              )}

              {selected.isDemoData && (
                <p className="text-[0.6875rem] leading-relaxed text-[var(--color-ink-faint)]">
                  Driven by the built-in telemetry simulator. Every fix is stored with
                  <span className="font-mono"> isSimulated=true</span> and is excludable from
                  analytics.
                </p>
              )}
            </div>
          </Panel>
        ) : (
          <Panel title="Fleet">
            <div className="max-h-[42vh] overflow-y-auto">
              {(fleet.data ?? []).length === 0 ? (
                <Empty
                  title="Nothing reporting"
                  hint="No vehicle has sent a position in the last hour."
                />
              ) : (
                <ul className="divide-y divide-[var(--color-hairline)]">
                  {(fleet.data ?? []).map((vehicle) => (
                    <li key={vehicle.vehicleId}>
                      <button
                        onClick={() => {
                          setSelected(vehicle);
                          map.current?.flyTo({
                            center: [vehicle.longitude, vehicle.latitude],
                            zoom: 9,
                            duration: 900,
                          });
                        }}
                        className="flex w-full items-center justify-between gap-2 px-3.5 py-2 text-left hover:bg-[color-mix(in_srgb,var(--color-signal)_5%,transparent)]"
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-mono text-[0.75rem] text-[var(--color-ink)]">
                            {vehicle.plateNumber}
                          </span>
                          <span className="block truncate text-[0.6875rem] text-[var(--color-ink-faint)]">
                            {vehicle.destinationName ?? 'idle'}
                          </span>
                        </span>
                        <span className="tnum shrink-0 font-mono text-[0.6875rem] text-[var(--color-ink-dim)]">
                          {fmt.num(vehicle.speedKmh, 0)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Panel>
        )}

        <Panel title="Legend">
          <ul className="space-y-2 p-3.5 text-[0.6875rem] text-[var(--color-ink-dim)]">
            <LegendRow colour="var(--color-ok)" label="Moving, on schedule" />
            <LegendRow colour="var(--color-warn)" label="Moving, delay risk ≥ 50%" />
            <LegendRow colour="var(--color-alert)" label="Flagged late or anomalous" />
            <LegendRow colour="var(--color-ink-faint)" label="Stationary" />
            <li className="flex items-center gap-2.5 pt-1">
              <span
                className="inline-block h-2 w-2 border border-[var(--color-info)]"
                style={{ transform: 'rotate(45deg)' }}
              />
              Warehouse
            </li>
          </ul>
        </Panel>
      </div>
    </div>
  );
}

function buildVehicleMarker(vehicle: FleetVehicle): HTMLElement {
  const stationary = (vehicle.speedKmh ?? 0) <= 3;
  const colour =
    vehicle.shipmentStatus === 'DELAYED'
      ? 'var(--color-alert)'
      : (vehicle.delayProbability ?? 0) >= 0.5
        ? 'var(--color-warn)'
        : stationary
          ? 'var(--color-ink-faint)'
          : 'var(--color-ok)';

  // A rotated chevron rather than a pin: heading is real information and a pin throws it away.
  // Built with DOM/SVG calls rather than innerHTML so no server-supplied value is ever parsed
  // as markup — `heading` is coerced to a finite number before it reaches a style string.
  const heading = Number.isFinite(vehicle.headingDegrees) ? Number(vehicle.headingDegrees) : 0;

  const element = document.createElement('div');
  element.style.cursor = 'pointer';

  const frame = document.createElement('div');
  frame.style.cssText = 'position:relative;width:22px;height:22px';

  const rotor = document.createElement('div');
  rotor.style.cssText =
    'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;transition:transform .4s ease';
  rotor.style.transform = `rotate(${heading}deg)`;

  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('viewBox', '0 0 16 16');

  const path = document.createElementNS(svgNs, 'path');
  path.setAttribute('d', 'M8 1 L14 15 L8 11.5 L2 15 Z');
  path.setAttribute('fill', colour);
  path.setAttribute('stroke', 'var(--color-void)');
  path.setAttribute('stroke-width', '1');

  svg.append(path);
  rotor.append(svg);
  frame.append(rotor);

  if (!stationary) {
    const halo = document.createElement('div');
    halo.style.cssText = 'position:absolute;inset:-4px;opacity:.28;border-radius:999px';
    halo.style.border = `1px solid ${colour}`;
    frame.append(halo);
  }

  element.append(frame);
  return element;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="font-mono text-[0.5625rem] uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">
        {label}
      </dt>
      <dd className="tnum truncate text-right font-mono text-[0.75rem] text-[var(--color-ink-dim)]">
        {value}
      </dd>
    </div>
  );
}

function LegendRow({ colour, label }: { colour: string; label: string }) {
  return (
    <li className="flex items-center gap-2.5">
      <svg width="12" height="12" viewBox="0 0 16 16" className="shrink-0">
        <path d="M8 1 L14 15 L8 11.5 L2 15 Z" fill={colour} />
      </svg>
      {label}
    </li>
  );
}
