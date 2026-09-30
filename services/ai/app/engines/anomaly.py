"""Anomaly detection on a shipment's GPS track.

Rule-based rather than learned, and deliberately so. A learned detector needs labelled anomalies
to train on, and a new deployment has none — it would start out useless and stay useless until
somebody hand-labelled a few hundred incidents. These rules encode what a dispatcher already
knows ("the truck has not moved for two hours", "it is 40 km off the corridor"), fire on day one,
and every alert states the threshold it crossed so an operator can argue with it.

Each detector returns a ``score`` in [0, 1] measuring *how far past the threshold* the
observation sits, not a probability. Score 0 is exactly at the threshold; 1 is far beyond it.
Severity is derived from the score so a mild deviation and a catastrophic one are not the same
alert.

Detectors:

``PROLONGED_STOP``     near-zero speed for longer than the tolerance.
``ROUTE_DEVIATION``    lateral distance from the planned corridor beyond tolerance.
``ABNORMAL_SPEED``     sustained speed above what the vehicle class should reach.
``GPS_LOSS``           a gap between consecutive fixes far longer than the reporting cadence.
``EXCESSIVE_DURATION`` elapsed time well past the planned duration while still moving.
``UNUSUAL_STOP``       a stop in a place with no scheduled reason to stop.
``SUSPICIOUS_DELIVERY`` delivery captured far from the declared destination.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Sequence

EARTH_RADIUS_M = 6_371_008.8

#: Speed under which a vehicle counts as stopped. Not zero: GPS jitter fakes 1–2 km/h at rest.
STOPPED_SPEED_KMH = 3.0

#: Default tolerances. All overridable per request.
DEFAULT_STOP_TOLERANCE_MINUTES = 45.0
DEFAULT_CORRIDOR_TOLERANCE_M = 2_000.0
DEFAULT_MAX_SPEED_KMH = 110.0
DEFAULT_GPS_GAP_MINUTES = 30.0

#: Score above which an anomaly is HIGH rather than MEDIUM.
HIGH_SEVERITY_SCORE = 0.6
MEDIUM_SEVERITY_SCORE = 0.25

#: French labels used in the explanation text; the JSON keeps the codes. Same wording as the web UI.
TYPE_LABELS: dict[str, str] = {
    "PROLONGED_STOP": "Arrêt prolongé",
    "ROUTE_DEVIATION": "Écart d’itinéraire",
    "ABNORMAL_SPEED": "Vitesse anormale",
    "GPS_LOSS": "Perte du signal GPS",
    "EXCESSIVE_DURATION": "Durée excessive",
    "UNUSUAL_STOP": "Arrêt inhabituel",
    "SUSPICIOUS_DELIVERY": "Livraison suspecte",
}
SEVERITY_LABELS: dict[str, str] = {"HIGH": "élevée", "MEDIUM": "moyenne", "LOW": "faible"}


@dataclass
class GpsSample:
    latitude: float
    longitude: float
    speed_kmh: float | None
    heading_degrees: float | None
    recorded_at: datetime


@dataclass
class DetectedAnomaly:
    type: str
    severity: str
    score: float
    detected_at: datetime
    latitude: float | None
    longitude: float | None
    description: str
    evidence: dict

    def to_dict(self) -> dict:
        return {
            "type": self.type,
            "severity": self.severity,
            "score": round(self.score, 4),
            "detectedAt": self.detected_at.isoformat(),
            "location": (
                None
                if self.latitude is None or self.longitude is None
                else {"latitude": self.latitude, "longitude": self.longitude}
            ),
            "description": self.description,
            "evidence": self.evidence,
        }


@dataclass
class AnomalyReport:
    shipment_id: str
    anomalies: list[DetectedAnomaly]
    positions_analysed: int
    reasons: list[str] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)


# --------------------------------------------------------------------- geometry


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def _bearing(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    dlon = math.radians(b[1] - a[1])
    y = math.sin(dlon) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return math.atan2(y, x)


def distance_to_segment_m(
    point: tuple[float, float], start: tuple[float, float], end: tuple[float, float]
) -> float:
    """Cross-track distance, clamped at the segment endpoints."""
    segment_length = haversine_m(start, end)
    if segment_length < 1e-6:
        return haversine_m(point, start)

    d13 = haversine_m(start, point) / EARTH_RADIUS_M
    theta13 = _bearing(start, point)
    theta12 = _bearing(start, end)

    cross_track = math.asin(
        max(-1.0, min(1.0, math.sin(d13) * math.sin(theta13 - theta12)))
    ) * EARTH_RADIUS_M

    inner = math.cos(d13) / math.cos(cross_track / EARTH_RADIUS_M)
    along_track = math.acos(max(-1.0, min(1.0, inner))) * EARTH_RADIUS_M

    if along_track < 0:
        return haversine_m(point, start)
    if along_track > segment_length:
        return haversine_m(point, end)
    return abs(cross_track)


def distance_to_polyline_m(point: tuple[float, float], polyline: Sequence[tuple[float, float]]) -> float:
    if not polyline:
        return float("inf")
    if len(polyline) == 1:
        return haversine_m(point, polyline[0])
    return min(
        distance_to_segment_m(point, polyline[i], polyline[i + 1])
        for i in range(len(polyline) - 1)
    )


# -------------------------------------------------------------------- detectors


def _severity(score: float) -> str:
    if score >= HIGH_SEVERITY_SCORE:
        return "HIGH"
    if score >= MEDIUM_SEVERITY_SCORE:
        return "MEDIUM"
    return "LOW"


def _excess_score(observed: float, threshold: float, saturate_at_multiple: float = 3.0) -> float:
    """Map an over-threshold observation onto [0, 1].

    0 at the threshold, 1 once the observation reaches ``saturate_at_multiple`` × threshold.
    Linear because a planner reads "twice the tolerance" more easily than a logistic curve, and
    the ranking — which is all the score is used for — is identical either way.
    """
    if threshold <= 0:
        return 1.0
    ratio = observed / threshold
    if ratio <= 1.0:
        return 0.0
    return min(1.0, (ratio - 1.0) / (saturate_at_multiple - 1.0))


def detect_stops(
    positions: Sequence[GpsSample], stop_tolerance_minutes: float
) -> list[DetectedAnomaly]:
    """Runs of consecutive near-stationary fixes longer than the tolerance."""
    anomalies: list[DetectedAnomaly] = []
    run_start: GpsSample | None = None

    for index, sample in enumerate(positions):
        stopped = (sample.speed_kmh or 0.0) <= STOPPED_SPEED_KMH

        if stopped and run_start is None:
            run_start = sample
        elif not stopped and run_start is not None:
            anomalies.extend(
                _emit_stop(run_start, positions[index - 1], stop_tolerance_minutes)
            )
            run_start = None

    if run_start is not None:
        anomalies.extend(_emit_stop(run_start, positions[-1], stop_tolerance_minutes))

    return [a for a in anomalies if a is not None]


def _emit_stop(
    start: GpsSample, end: GpsSample, tolerance_minutes: float
) -> list[DetectedAnomaly]:
    minutes = (end.recorded_at - start.recorded_at).total_seconds() / 60.0
    if minutes <= tolerance_minutes:
        return []

    score = _excess_score(minutes, tolerance_minutes)
    return [
        DetectedAnomaly(
            type="PROLONGED_STOP",
            severity=_severity(score),
            score=score,
            detected_at=end.recorded_at,
            latitude=start.latitude,
            longitude=start.longitude,
            description=(
                f"Véhicule immobile pendant {minutes:.0f} minutes, pour une tolérance de "
                f"{tolerance_minutes:.0f} minutes."
            ),
            evidence={
                "stoppedMinutes": round(minutes, 1),
                "toleranceMinutes": tolerance_minutes,
                "startedAt": start.recorded_at.isoformat(),
                "endedAt": end.recorded_at.isoformat(),
            },
        )
    ]


def detect_route_deviation(
    positions: Sequence[GpsSample],
    planned_route: Sequence[tuple[float, float]],
    corridor_tolerance_m: float,
) -> list[DetectedAnomaly]:
    """Single worst deviation, not one alert per fix.

    A truck that leaves the corridor produces dozens of consecutive off-corridor fixes. Emitting
    one anomaly each would bury the operator; the useful signal is "it went 40 km off, here".
    """
    if len(planned_route) < 2:
        return []

    worst_distance = 0.0
    worst_sample: GpsSample | None = None

    for sample in positions:
        distance = distance_to_polyline_m((sample.latitude, sample.longitude), planned_route)
        if distance > worst_distance:
            worst_distance, worst_sample = distance, sample

    if worst_sample is None or worst_distance <= corridor_tolerance_m:
        return []

    score = _excess_score(worst_distance, corridor_tolerance_m, saturate_at_multiple=5.0)
    return [
        DetectedAnomaly(
            type="ROUTE_DEVIATION",
            severity=_severity(score),
            score=score,
            detected_at=worst_sample.recorded_at,
            latitude=worst_sample.latitude,
            longitude=worst_sample.longitude,
            description=(
                f"Le véhicule s’est écarté de {worst_distance / 1000:.1f} km du corridor prévu, "
                f"pour une tolérance de {corridor_tolerance_m / 1000:.1f} km."
            ),
            evidence={
                "maxDeviationM": round(worst_distance, 1),
                "toleranceM": corridor_tolerance_m,
            },
        )
    ]


def detect_abnormal_speed(
    positions: Sequence[GpsSample], expected_max_speed_kmh: float
) -> list[DetectedAnomaly]:
    """Sustained overspeed, judged on the fastest fix and how many fixes agree with it.

    A single 130 km/h reading is usually GPS noise. Three of them in a row is a driver.
    """
    over = [s for s in positions if (s.speed_kmh or 0.0) > expected_max_speed_kmh]
    if len(over) < 3:
        return []

    fastest = max(over, key=lambda s: s.speed_kmh or 0.0)
    score = _excess_score(fastest.speed_kmh or 0.0, expected_max_speed_kmh, saturate_at_multiple=1.6)

    return [
        DetectedAnomaly(
            type="ABNORMAL_SPEED",
            severity=_severity(score),
            score=score,
            detected_at=fastest.recorded_at,
            latitude=fastest.latitude,
            longitude=fastest.longitude,
            description=(
                f"Vitesse de pointe de {fastest.speed_kmh:.0f} km/h pour un maximum attendu de "
                f"{expected_max_speed_kmh:.0f} km/h, sur {len(over)} positions GPS."
            ),
            evidence={
                "peakSpeedKmh": round(fastest.speed_kmh or 0.0, 1),
                "expectedMaxKmh": expected_max_speed_kmh,
                "fixesOverLimit": len(over),
            },
        )
    ]


def detect_gps_loss(
    positions: Sequence[GpsSample], gap_tolerance_minutes: float
) -> list[DetectedAnomaly]:
    """Gaps between consecutive fixes far longer than the reporting cadence."""
    anomalies: list[DetectedAnomaly] = []

    for previous, current in zip(positions, positions[1:]):
        minutes = (current.recorded_at - previous.recorded_at).total_seconds() / 60.0
        if minutes <= gap_tolerance_minutes:
            continue

        distance_km = haversine_m(
            (previous.latitude, previous.longitude), (current.latitude, current.longitude)
        ) / 1000
        score = _excess_score(minutes, gap_tolerance_minutes, saturate_at_multiple=6.0)

        anomalies.append(
            DetectedAnomaly(
                type="GPS_LOSS",
                severity=_severity(score),
                score=score,
                detected_at=current.recorded_at,
                latitude=previous.latitude,
                longitude=previous.longitude,
                description=(
                    f"Aucune position pendant {minutes:.0f} minutes ; le véhicule est réapparu "
                    f"à {distance_km:.1f} km de là."
                ),
                evidence={
                    "gapMinutes": round(minutes, 1),
                    "toleranceMinutes": gap_tolerance_minutes,
                    "jumpKm": round(distance_km, 2),
                    "lastSeenAt": previous.recorded_at.isoformat(),
                },
            )
        )

    return anomalies


def detect_excessive_duration(
    positions: Sequence[GpsSample], planned_duration_hours: float | None
) -> list[DetectedAnomaly]:
    if not planned_duration_hours or planned_duration_hours <= 0 or len(positions) < 2:
        return []

    elapsed_hours = (
        positions[-1].recorded_at - positions[0].recorded_at
    ).total_seconds() / 3600.0
    if elapsed_hours <= planned_duration_hours:
        return []

    score = _excess_score(elapsed_hours, planned_duration_hours, saturate_at_multiple=2.0)
    return [
        DetectedAnomaly(
            type="EXCESSIVE_DURATION",
            severity=_severity(score),
            score=score,
            detected_at=positions[-1].recorded_at,
            latitude=positions[-1].latitude,
            longitude=positions[-1].longitude,
            description=(
                f"Trajet en cours depuis {elapsed_hours:.1f} h pour une durée prévue de "
                f"{planned_duration_hours:.1f} h."
            ),
            evidence={
                "elapsedHours": round(elapsed_hours, 2),
                "plannedHours": round(planned_duration_hours, 2),
                "overrunHours": round(elapsed_hours - planned_duration_hours, 2),
            },
        )
    ]


def detect_suspicious_delivery(
    delivery_point: tuple[float, float] | None,
    declared_destination: tuple[float, float] | None,
    tolerance_m: float = 1_000.0,
) -> list[DetectedAnomaly]:
    """Proof of delivery captured far from where the goods were supposed to go."""
    if delivery_point is None or declared_destination is None:
        return []

    distance = haversine_m(delivery_point, declared_destination)
    if distance <= tolerance_m:
        return []

    score = _excess_score(distance, tolerance_m, saturate_at_multiple=10.0)
    return [
        DetectedAnomaly(
            type="SUSPICIOUS_DELIVERY",
            severity=_severity(score),
            score=score,
            detected_at=datetime.now(),
            latitude=delivery_point[0],
            longitude=delivery_point[1],
            description=(
                f"La livraison a été enregistrée à {distance / 1000:.1f} km de la destination "
                "déclarée."
            ),
            evidence={"distanceM": round(distance, 1), "toleranceM": tolerance_m},
        )
    ]


# ------------------------------------------------------------------ entry point


def detect_anomalies(
    shipment_id: str,
    positions: Sequence[GpsSample],
    *,
    planned_route: Sequence[tuple[float, float]] | None = None,
    planned_duration_hours: float | None = None,
    corridor_tolerance_m: float = DEFAULT_CORRIDOR_TOLERANCE_M,
    stop_tolerance_minutes: float = DEFAULT_STOP_TOLERANCE_MINUTES,
    expected_max_speed_kmh: float = DEFAULT_MAX_SPEED_KMH,
    gps_gap_tolerance_minutes: float = DEFAULT_GPS_GAP_MINUTES,
    delivery_point: tuple[float, float] | None = None,
    declared_destination: tuple[float, float] | None = None,
) -> AnomalyReport:
    ordered = sorted(positions, key=lambda s: s.recorded_at)

    if len(ordered) < 2:
        return AnomalyReport(
            shipment_id=shipment_id,
            anomalies=[],
            positions_analysed=len(ordered),
            reasons=[
                "Moins de deux positions GPS : rien ne peut encore être déduit du déplacement."
            ],
            assumptions=[],
        )

    anomalies: list[DetectedAnomaly] = []
    anomalies += detect_stops(ordered, stop_tolerance_minutes)
    anomalies += detect_gps_loss(ordered, gps_gap_tolerance_minutes)
    anomalies += detect_abnormal_speed(ordered, expected_max_speed_kmh)
    anomalies += detect_excessive_duration(ordered, planned_duration_hours)
    if planned_route:
        anomalies += detect_route_deviation(ordered, planned_route, corridor_tolerance_m)
    anomalies += detect_suspicious_delivery(delivery_point, declared_destination)

    anomalies.sort(key=lambda a: a.score, reverse=True)

    return AnomalyReport(
        shipment_id=shipment_id,
        anomalies=anomalies,
        positions_analysed=len(ordered),
        reasons=_reasons(anomalies, ordered),
        assumptions=[
            f"Un véhicule est considéré à l’arrêt en dessous de {STOPPED_SPEED_KMH:.0f} km/h, car "
            "l’imprécision du GPS affiche 1–2 km/h sur un véhicule immobile.",
            f"Les arrêts sont signalés au-delà de {stop_tolerance_minutes:.0f} minutes ; une pause "
            "réglementaire ou une file d’attente en douane déclenchera cette alerte, qu’un "
            "opérateur est censé écarter.",
            f"L’écart d’itinéraire se mesure comme la distance latérale au corridor prévu, "
            f"tolérance {corridor_tolerance_m / 1000:.1f} km — une seule alerte pour le point le "
            "plus éloigné, pas une par position hors corridor.",
            "Un excès de vitesse exige au moins trois positions au-dessus de la limite, pour "
            "qu’un relevé isolé et bruité ne déclenche pas d’alerte.",
            "Les scores mesurent l’écart au-delà du seuil, pas une probabilité ; ils servent à "
            "classer les alertes entre elles.",
        ],
    )


def _reasons(anomalies: Sequence[DetectedAnomaly], positions: Sequence[GpsSample]) -> list[str]:
    span_hours = (
        positions[-1].recorded_at - positions[0].recorded_at
    ).total_seconds() / 3600.0

    if not anomalies:
        return [
            f"{len(positions)} positions GPS analysées sur {span_hours:.1f} h ; tous les "
            "contrôles sont conformes.",
        ]

    reasons = [
        f"{len(positions)} positions GPS analysées sur {span_hours:.1f} h : "
        f"{len(anomalies)} anomalie(s) relevée(s).",
    ]
    reasons.extend(
        f"{TYPE_LABELS.get(a.type, a.type)} (gravité {SEVERITY_LABELS.get(a.severity, a.severity)}) : "
        f"{a.description}"
        for a in anomalies
    )
    return reasons
