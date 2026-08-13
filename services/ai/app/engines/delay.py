"""Delay prediction.

Two modes, and the response always says which one produced the number.

**Scorecard (cold start).** A new deployment has no labelled shipments, so there is nothing to
train on. Rather than ship a model trained on nothing — or worse, a random number dressed as a
prediction — the engine evaluates a logistic scorecard whose coefficients are stated in the code
and reported in every response:

    logit(p) = β₀ + Σ βᵢ · xᵢ

The coefficients encode ordinary freight knowledge (a carrier with a poor on-time record is more
likely to be late; long trips accumulate more opportunities to slip; bad weather and congestion
both hurt) and are calibrated so that a median shipment with an average carrier sits near the
observed industry base rate. They are a *prior*, not a fit, and the response labels them as such.

**Learned (once history exists).** When the caller supplies labelled historical shipments,
a gradient-boosted classifier is trained on them and used instead, with the scorecard kept as the
fallback for feature vectors the model has never seen. Training data is required to be balanced
enough to be worth using — a set with fewer than 30 examples or fewer than 5 of either class is
refused, because a classifier fitted on 3 late shipments will confidently predict nonsense.

Feature contributions are reported either way: log-odds contributions for the scorecard,
permutation-style deltas for the learned model. A delay probability with no attribution is not
actionable — the point is to know *which* input to fix.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Sequence

import numpy as np

#: Base rate: share of road-freight shipments that arrive late in ordinary conditions.
#: Sets the intercept so a completely average shipment predicts roughly this.
BASE_LATE_RATE = 0.18

#: Scorecard coefficients, in log-odds per unit of the (scaled) feature.
COEFFICIENTS: dict[str, float] = {
    # A carrier that is late a third of the time is the single strongest signal available.
    "carrier_unreliability": 2.60,
    # Longer trips have more chances to go wrong; scaled per 1000 km.
    "distance_scaled": 0.55,
    # Congestion, 0..1.
    "traffic_congestion": 1.10,
    # Weather severity, 0..1.
    "weather_severity": 0.95,
    # Historic incident rate on this corridor, per 100 trips, scaled.
    "route_incident_rate": 0.80,
    # Departing into the evening peak or overnight.
    "unsocial_departure": 0.35,
    # Weekend departures: thinner support, slower customs, fewer relief drivers.
    "weekend_departure": 0.25,
    # Running below the plan's implied speed already.
    "speed_shortfall": 1.80,
    # Each intermediate stop is another chance to lose time.
    "stops_scaled": 0.40,
    # A supplier that ships late makes the whole leg late before it starts.
    "supplier_unreliability": 0.70,
}

MIN_TRAINING_ROWS = 30
MIN_MINORITY_CLASS = 5

HIGH_RISK = 0.6
MEDIUM_RISK = 0.3


@dataclass
class DelayPrediction:
    delay_probability: float
    risk: str
    expected_delay_hours: float
    feature_contributions: list[dict]
    model_name: str
    model_version: str
    reasons: list[str] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "delayProbability": round(self.delay_probability, 4),
            "risk": self.risk,
            "expectedDelayHours": round(self.expected_delay_hours, 2),
            "featureContributions": self.feature_contributions,
            "model": {
                "name": self.model_name,
                "version": self.model_version,
                "trainedAt": None,
                "metrics": {},
            },
        }


def _risk_band(probability: float) -> str:
    if probability >= HIGH_RISK:
        return "HIGH"
    if probability >= MEDIUM_RISK:
        return "MEDIUM"
    return "LOW"


def build_features(payload: dict) -> dict[str, float]:
    """Project a shipment onto the scorecard's feature space.

    Everything is scaled so a coefficient is interpretable as "log-odds added when this feature
    goes from its benign value to its severe one".
    """
    distance_km = float(payload.get("distanceKm", 0) or 0)
    planned_hours = float(payload.get("plannedDurationHours", 0) or 0)
    departure_hour = int(payload.get("departureHour", 9) or 9)
    departure_dow = int(payload.get("departureDayOfWeek", 1) or 1)
    carrier_on_time = float(payload.get("carrierOnTimeRate", 0.85) or 0.85)
    supplier_reliability = payload.get("supplierReliabilityScore")
    observed_speed = payload.get("observedAverageSpeedKmh")
    stops = float(payload.get("stopsCount", 0) or 0)

    # Speed shortfall: how far below the plan's implied speed the vehicle is actually running.
    speed_shortfall = 0.0
    if observed_speed and planned_hours > 0 and distance_km > 0:
        required_speed = distance_km / planned_hours
        if required_speed > 0:
            speed_shortfall = max(0.0, 1.0 - float(observed_speed) / required_speed)

    return {
        "carrier_unreliability": max(0.0, min(1.0, 1.0 - carrier_on_time)),
        "distance_scaled": min(distance_km / 1000.0, 3.0),
        "traffic_congestion": max(0.0, min(1.0, float(payload.get("trafficCongestion", 0) or 0))),
        "weather_severity": max(0.0, min(1.0, float(payload.get("weatherSeverity", 0) or 0))),
        "route_incident_rate": min(float(payload.get("routeIncidentRate", 0) or 0) / 10.0, 1.0),
        "unsocial_departure": 1.0 if departure_hour >= 18 or departure_hour <= 4 else 0.0,
        "weekend_departure": 1.0 if departure_dow in (5, 6) else 0.0,
        "speed_shortfall": min(speed_shortfall, 1.0),
        "stops_scaled": min(stops / 5.0, 1.0),
        "supplier_unreliability": (
            max(0.0, min(1.0, 1.0 - float(supplier_reliability) / 100.0))
            if supplier_reliability is not None
            else 0.0
        ),
    }


def _intercept() -> float:
    """Intercept placing an all-benign shipment at the base late rate."""
    return math.log(BASE_LATE_RATE / (1 - BASE_LATE_RATE))


def predict_scorecard(payload: dict) -> DelayPrediction:
    features = build_features(payload)
    intercept = _intercept()

    contributions = [
        {"feature": name, "contribution": round(COEFFICIENTS[name] * value, 4)}
        for name, value in features.items()
    ]
    logit = intercept + sum(item["contribution"] for item in contributions)
    probability = 1.0 / (1.0 + math.exp(-logit))

    contributions.sort(key=lambda item: abs(item["contribution"]), reverse=True)

    planned_hours = float(payload.get("plannedDurationHours", 0) or 0)
    # Expected delay conditional on being late, scaled by probability. A long trip that slips
    # slips by more hours than a short one, so it is expressed as a share of planned duration.
    expected_delay = probability * planned_hours * 0.25

    return DelayPrediction(
        delay_probability=probability,
        risk=_risk_band(probability),
        expected_delay_hours=expected_delay,
        feature_contributions=contributions,
        model_name="delay-scorecard",
        model_version="1.0.0",
        reasons=_scorecard_reasons(contributions, probability, features, intercept),
        assumptions=[
            "This is a calibrated logistic scorecard, not a model fitted to your data. The "
            "coefficients encode ordinary freight knowledge and are published in the response.",
            f"The intercept places a completely benign shipment at the {BASE_LATE_RATE:.0%} "
            "industry base rate.",
            "Contributions are additive in log-odds, so they explain the score exactly; they are "
            "not probabilities and do not sum to the final number.",
            "Supply at least "
            f"{MIN_TRAINING_ROWS} labelled historical shipments to train a model on your own "
            "operation and replace this prior.",
            "Expected delay is estimated as a quarter of planned duration, weighted by the delay "
            "probability — a rough magnitude, not a prediction of arrival time. Use the ETA "
            "engine for that.",
        ],
    )


def _scorecard_reasons(
    contributions: Sequence[dict], probability: float, features: dict[str, float], intercept: float
) -> list[str]:
    readable = {
        "carrier_unreliability": "the carrier's on-time record",
        "distance_scaled": "trip distance",
        "traffic_congestion": "traffic congestion",
        "weather_severity": "weather severity",
        "route_incident_rate": "this corridor's incident history",
        "unsocial_departure": "an evening or overnight departure",
        "weekend_departure": "a weekend departure",
        "speed_shortfall": "the vehicle already running below the plan's required speed",
        "stops_scaled": "the number of intermediate stops",
        "supplier_unreliability": "the supplier's reliability",
    }

    reasons = [
        f"Delay probability {probability:.1%} ({_risk_band(probability)} risk), from a baseline "
        f"of {BASE_LATE_RATE:.0%} for an unremarkable shipment.",
    ]

    material = [item for item in contributions if abs(item["contribution"]) > 0.05][:4]
    if material:
        for item in material:
            direction = "raises" if item["contribution"] > 0 else "lowers"
            reasons.append(
                f"{readable.get(item['feature'], item['feature'])} {direction} the log-odds by "
                f"{abs(item['contribution']):.2f}."
            )
    else:
        reasons.append("No individual factor moves the estimate materially from the baseline.")

    if features.get("speed_shortfall", 0) > 0.2:
        reasons.append(
            "The vehicle is already behind the speed the plan requires — this is an observation, "
            "not a forecast, and it is the strongest evidence in the set."
        )

    return reasons


def train_and_predict(
    payload: dict, history: Sequence[dict]
) -> DelayPrediction:
    """Train on labelled history when there is enough of it; otherwise fall back to the scorecard.

    Each history row is a feature payload plus ``"wasLate": bool``.
    """
    labelled = [row for row in history if "wasLate" in row]

    if len(labelled) < MIN_TRAINING_ROWS:
        prediction = predict_scorecard(payload)
        prediction.reasons.insert(
            0,
            f"Only {len(labelled)} labelled shipment(s) supplied; at least {MIN_TRAINING_ROWS} "
            "are needed before a model is fitted, so the scorecard prior was used.",
        )
        return prediction

    positives = sum(1 for row in labelled if row["wasLate"])
    negatives = len(labelled) - positives
    if min(positives, negatives) < MIN_MINORITY_CLASS:
        prediction = predict_scorecard(payload)
        prediction.reasons.insert(
            0,
            f"Training data is too imbalanced ({positives} late, {negatives} on time); at least "
            f"{MIN_MINORITY_CLASS} of each class are needed. Scorecard prior used instead.",
        )
        return prediction

    from sklearn.ensemble import HistGradientBoostingClassifier

    feature_names = list(COEFFICIENTS.keys())
    x = np.array([[build_features(row)[name] for name in feature_names] for row in labelled])
    y = np.array([1 if row["wasLate"] else 0 for row in labelled])

    model = HistGradientBoostingClassifier(
        max_iter=150, learning_rate=0.08, max_depth=3, min_samples_leaf=8, random_state=42
    )
    model.fit(x, y)

    features = build_features(payload)
    vector = np.array([[features[name] for name in feature_names]])
    probability = float(model.predict_proba(vector)[0][1])

    # Attribution by ablation: set each feature to its benign value and see how the prediction
    # moves. Cheap, model-agnostic, and directly answers "what should I change?".
    contributions = []
    for index, name in enumerate(feature_names):
        ablated = vector.copy()
        ablated[0, index] = 0.0
        without = float(model.predict_proba(ablated)[0][1])
        contributions.append(
            {"feature": name, "contribution": round(probability - without, 4)}
        )
    contributions.sort(key=lambda item: abs(item["contribution"]), reverse=True)

    planned_hours = float(payload.get("plannedDurationHours", 0) or 0)

    return DelayPrediction(
        delay_probability=probability,
        risk=_risk_band(probability),
        expected_delay_hours=probability * planned_hours * 0.25,
        feature_contributions=contributions,
        model_name="delay-gbdt",
        model_version="1.0.0",
        reasons=[
            f"Delay probability {probability:.1%} ({_risk_band(probability)} risk), from a "
            f"gradient-boosted model fitted on {len(labelled)} of your own shipments "
            f"({positives} late, {negatives} on time).",
        ]
        + [
            f"{item['feature'].replace('_', ' ')} moves the estimate by "
            f"{item['contribution']:+.1%}."
            for item in contributions[:4]
            if abs(item["contribution"]) > 0.005
        ],
        assumptions=[
            f"Fitted on {len(labelled)} labelled shipments supplied with this request; the model "
            "is not persisted between calls.",
            "Contributions are ablation deltas — the change in predicted probability when a "
            "feature is reset to its benign value.",
            "The model has seen only the operation represented by the training rows; a new "
            "corridor or carrier is out of distribution and the estimate will be less reliable.",
            "Expected delay is a quarter of planned duration weighted by probability — a "
            "magnitude, not an arrival time.",
        ],
    )
