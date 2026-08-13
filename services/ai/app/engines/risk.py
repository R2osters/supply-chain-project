"""Risk engine and the Supply Chain Health Score.

Every finding carries ``probability``, ``impact`` and a ``score``, where

    score = probability × normalised impact × 100

so the ranking is expected loss, not a vibe. Probability is estimated from the data that exists
(stockout probability from the inventory model, delay probability from the shipment record,
supplier failure from the observed on-time and quality rates). Impact is expressed in currency
where possible, then normalised against the largest impact in the same analysis so the scores are
comparable within a run — and explicitly *not* comparable across runs, which the response says.

The health score is deliberately a **weighted penalty from 100**, not an average of positives:

    health = 100 − Σ (weight_c × severity_c)

Starting at 100 and subtracting for each problem found means a company with nothing wrong scores
100, and each new problem visibly costs it points. Averaging category scores has the opposite
property — one catastrophic category gets diluted by four healthy ones, which is exactly the case
where a warning matters most.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence

from .inventory import stockout_probability

#: Weight of each category in the health score. They sum to 100, so the worst possible score is 0.
HEALTH_WEIGHTS: dict[str, float] = {
    "STOCKOUT_RISK": 30.0,
    "SUPPLIER_RISK": 25.0,
    "TRANSPORT_RISK": 20.0,
    "DEMAND_RISK": 15.0,
    "GEOPOLITICAL_RISK": 5.0,
    "WEATHER_RISK": 5.0,
}

HIGH_SCORE = 50.0
MEDIUM_SCORE = 20.0

#: A supplier holding more than this share of spend is a single point of failure.
CONCENTRATION_THRESHOLD = 0.4

#: Countries flagged as elevated geopolitical risk are supplied by the caller; absent that, the
#: engine only flags concentration in *one* country, which it can see from the data itself.
COUNTRY_CONCENTRATION_THRESHOLD = 0.6


@dataclass
class RiskFinding:
    category: str
    probability: float
    impact: float
    score: float
    level: str
    subject: str
    subject_type: str
    subject_id: str
    recommended_action: str
    reasons: list[str] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "category": self.category,
            "probability": round(self.probability, 4),
            "impact": round(self.impact, 2),
            "score": round(self.score, 2),
            "level": self.level,
            "subject": self.subject,
            "subjectType": self.subject_type,
            "subjectId": self.subject_id,
            "recommendedAction": self.recommended_action,
            "explanation": {
                "summary": f"{self.category} on {self.subject}: score {self.score:.0f}/100.",
                "reasons": self.reasons,
                "assumptions": self.assumptions,
            },
        }


@dataclass
class RiskReport:
    findings: list[RiskFinding]
    health_score: float
    health_breakdown: dict[str, float]
    reasons: list[str] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)


def _level(score: float) -> str:
    if score >= HIGH_SCORE:
        return "HIGH"
    if score >= MEDIUM_SCORE:
        return "MEDIUM"
    return "LOW"


def analyse(
    *,
    company_id: str,
    products: Sequence[dict],
    suppliers: Sequence[dict],
    shipments: Sequence[dict],
) -> RiskReport:
    findings: list[RiskFinding] = []

    findings += _stockout_findings(products)
    findings += _supplier_findings(suppliers)
    findings += _transport_findings(shipments)
    findings += _demand_findings(products)
    findings += _geopolitical_findings(suppliers)

    # Impact is normalised against the largest impact in this run so scores are comparable
    # within the analysis. Doing it after collection is what makes that possible.
    max_impact = max((f.impact for f in findings), default=0.0)
    for finding in findings:
        normalised_impact = finding.impact / max_impact if max_impact > 0 else 0.0
        finding.score = round(finding.probability * normalised_impact * 100, 2)
        finding.level = _level(finding.score)

    findings.sort(key=lambda f: f.score, reverse=True)

    breakdown = _health_breakdown(findings)
    health = round(max(0.0, 100.0 - sum(breakdown.values())), 2)

    return RiskReport(
        findings=findings,
        health_score=health,
        health_breakdown={k: round(v, 2) for k, v in breakdown.items()},
        reasons=_reasons(findings, health, breakdown),
        assumptions=[
            "Score = probability × impact normalised against the largest impact in this run. "
            "Scores are comparable inside one analysis, not between analyses.",
            "Impact is expressed in currency where the data allows (units at risk × unit cost) "
            "and as a relative magnitude otherwise.",
            "The health score starts at 100 and subtracts a weighted penalty per category, so "
            "one catastrophic category cannot be diluted by four healthy ones.",
            "Stockout probability comes from the same normal lead-time-demand model as the "
            "inventory engine and inherits its assumptions.",
            "Weather and geopolitical risk are only assessed from data present in the request; "
            "with no external feed configured they reflect concentration, not live events.",
        ],
    )


def _stockout_findings(products: Sequence[dict]) -> list[RiskFinding]:
    findings: list[RiskFinding] = []

    for product in products:
        demand = float(product.get("averageDailyDemand", 0) or 0)
        if demand <= 0:
            continue

        current = float(product.get("currentStock", 0) or 0)
        incoming = float(product.get("incomingQuantity", 0) or 0)
        lead_time = float(product.get("leadTimeDays", 7) or 7)
        demand_std = float(product.get("demandStdDev", 0) or 0)
        unit_cost = float(product.get("unitCost", 0) or 0)

        probability = stockout_probability(
            current + incoming, demand, demand_std, lead_time, 0.0
        )
        if probability < 0.05:
            continue

        # Impact: the demand that would go unserved during the lead time, valued at unit cost.
        units_at_risk = max(demand * lead_time - (current + incoming), 0.0)
        impact = units_at_risk * unit_cost if unit_cost > 0 else units_at_risk

        days_of_cover = current / demand if demand > 0 else float("inf")

        findings.append(
            RiskFinding(
                category="STOCKOUT_RISK",
                probability=probability,
                impact=impact,
                score=0.0,
                level="LOW",
                subject=product.get("sku", product.get("productId", "unknown")),
                subject_type="PRODUCT",
                subject_id=str(product.get("productId", "")),
                recommended_action=(
                    f"Order at least {units_at_risk:,.0f} units, or expedite the "
                    f"{incoming:,.0f} already on order."
                    if units_at_risk > 0
                    else "Monitor; cover is thin but the position still meets expected demand."
                ),
                reasons=[
                    f"{current:,.0f} on hand plus {incoming:,.0f} incoming against expected "
                    f"demand of {demand * lead_time:,.0f} over a {lead_time:.0f}-day lead time.",
                    f"{days_of_cover:.1f} days of cover remaining at current demand.",
                    f"Probability of stocking out before replenishment: {probability:.1%}.",
                    f"Roughly {units_at_risk:,.0f} units at risk, worth {impact:,.0f}.",
                ],
                assumptions=[
                    "Lead-time demand is approximated as normal.",
                    "Incoming stock is assumed to arrive within the lead time.",
                ],
            )
        )

    return findings


def _supplier_findings(suppliers: Sequence[dict]) -> list[RiskFinding]:
    findings: list[RiskFinding] = []

    for supplier in suppliers:
        on_time = float(supplier.get("onTimeDeliveryRate", 1) or 1)
        quality = float(supplier.get("qualityAcceptanceRate", 1) or 1)
        share = float(supplier.get("sharePercent", 0) or 0)
        lead_std = float(supplier.get("leadTimeStdDevDays", 0) or 0)

        failure_probability = 1.0 - (on_time * quality)
        if failure_probability < 0.05 and share < CONCENTRATION_THRESHOLD:
            continue

        # Impact scales with how much of the business depends on this supplier.
        impact = share * 100.0 * max(failure_probability, 0.05) * 10
        reasons = [
            f"On-time rate {on_time:.1%}, quality acceptance {quality:.1%} — combined failure "
            f"probability {failure_probability:.1%}.",
            f"This supplier carries {share:.1%} of the relevant spend.",
        ]

        action = "Monitor performance."
        if share >= CONCENTRATION_THRESHOLD and failure_probability >= 0.1:
            action = (
                "Qualify a second source. This supplier is both unreliable and heavily relied on "
                "— the two together are what turns a delay into an outage."
            )
            reasons.append(
                "Concentration and unreliability compound: a failure here has no fallback."
            )
        elif share >= CONCENTRATION_THRESHOLD:
            action = "Qualify a second source to reduce single-supplier dependency."
        elif failure_probability >= 0.2:
            action = "Raise the reliability issue with the supplier or shift volume elsewhere."

        if lead_std > 3:
            reasons.append(
                f"Lead time varies by ±{lead_std:.1f} days, which forces a larger safety stock "
                "across every product this supplier serves."
            )

        findings.append(
            RiskFinding(
                category="SUPPLIER_RISK",
                probability=max(failure_probability, 0.01),
                impact=impact,
                score=0.0,
                level="LOW",
                subject=supplier.get("name", "unknown supplier"),
                subject_type="SUPPLIER",
                subject_id=str(supplier.get("supplierId", "")),
                recommended_action=action,
                reasons=reasons,
                assumptions=[
                    "Failure probability is 1 − (on-time × quality acceptance), which treats the "
                    "two as independent.",
                    "Share of spend is supplied by the caller and is not recomputed here.",
                ],
            )
        )

    return findings


def _transport_findings(shipments: Sequence[dict]) -> list[RiskFinding]:
    findings: list[RiskFinding] = []

    at_risk = [
        s for s in shipments if float(s.get("delayProbability", 0) or 0) >= 0.4
    ]
    if not at_risk:
        return findings

    total_value = sum(float(s.get("valueAtRisk", 0) or 0) for s in at_risk)
    mean_probability = sum(
        float(s.get("delayProbability", 0) or 0) for s in at_risk
    ) / len(at_risk)

    findings.append(
        RiskFinding(
            category="TRANSPORT_RISK",
            probability=mean_probability,
            impact=total_value,
            score=0.0,
            level="LOW",
            subject=f"{len(at_risk)} shipment(s) in transit",
            subject_type="SHIPMENT",
            subject_id=str(at_risk[0].get("shipmentId", "")),
            recommended_action=(
                f"Review the {len(at_risk)} at-risk shipment(s); expedite or re-plan the ones "
                "feeding products with thin cover."
            ),
            reasons=[
                f"{len(at_risk)} shipment(s) carry a delay probability of 40 % or more.",
                f"Mean delay probability across them is {mean_probability:.1%}.",
                f"Combined cargo value at risk: {total_value:,.0f}.",
            ],
            assumptions=[
                "Delay probability is taken from the shipment record as supplied.",
                "Value at risk is the cargo value, not the downstream cost of the delay.",
            ],
        )
    )

    return findings


def _demand_findings(products: Sequence[dict]) -> list[RiskFinding]:
    """Products whose demand is so volatile that any forecast will be unreliable."""
    findings: list[RiskFinding] = []

    for product in products:
        demand = float(product.get("averageDailyDemand", 0) or 0)
        demand_std = float(product.get("demandStdDev", 0) or 0)
        if demand <= 0:
            continue

        cv = demand_std / demand
        # A coefficient of variation above 0.5 is the conventional threshold for "erratic".
        if cv < 0.5:
            continue

        unit_cost = float(product.get("unitCost", 0) or 0)
        lead_time = float(product.get("leadTimeDays", 7) or 7)
        impact = demand * lead_time * unit_cost * min(cv, 2.0)

        findings.append(
            RiskFinding(
                category="DEMAND_RISK",
                probability=min(cv / 2.0, 0.95),
                impact=impact,
                score=0.0,
                level="LOW",
                subject=product.get("sku", "unknown"),
                subject_type="PRODUCT",
                subject_id=str(product.get("productId", "")),
                recommended_action=(
                    "Raise the service level or shorten the replenishment cycle. Erratic demand "
                    "cannot be forecast away — it has to be buffered or ordered more often."
                ),
                reasons=[
                    f"Coefficient of variation {cv:.2f} (σ {demand_std:,.1f} on a mean of "
                    f"{demand:,.1f}/day) — above 0.5, demand is classed as erratic.",
                    "A forecast on this series will have wide intervals however good the model is; "
                    "the fix is inventory policy, not a better model.",
                ],
                assumptions=[
                    "Coefficient of variation above 0.5 is the conventional erratic-demand "
                    "threshold.",
                ],
            )
        )

    return findings


def _geopolitical_findings(suppliers: Sequence[dict]) -> list[RiskFinding]:
    """Country concentration — the only geopolitical signal derivable without an external feed."""
    if not suppliers:
        return []

    by_country: dict[str, float] = {}
    for supplier in suppliers:
        country = str(supplier.get("country", "") or "UNKNOWN")
        by_country[country] = by_country.get(country, 0.0) + float(
            supplier.get("sharePercent", 0) or 0
        )

    total = sum(by_country.values())
    if total <= 0:
        return []

    country, share = max(by_country.items(), key=lambda item: item[1])
    concentration = share / total
    if concentration < COUNTRY_CONCENTRATION_THRESHOLD:
        return []

    return [
        RiskFinding(
            category="GEOPOLITICAL_RISK",
            probability=min(concentration, 0.95),
            impact=concentration * 1000,
            score=0.0,
            level="LOW",
            subject=f"Sourcing concentrated in {country}",
            subject_type="COMPANY",
            subject_id=country,
            recommended_action=(
                f"Qualify suppliers outside {country}. A border closure, strike or currency shock "
                "there currently affects most of your inbound supply at once."
            ),
            reasons=[
                f"{concentration:.0%} of supplier spend originates in {country}.",
                "Single-country sourcing correlates risks that would otherwise be independent: "
                "one event hits every supplier simultaneously.",
            ],
            assumptions=[
                "No live geopolitical feed is configured, so this reflects concentration only, "
                "not current events in that country.",
            ],
        )
    ]


def _health_breakdown(findings: Sequence[RiskFinding]) -> dict[str, float]:
    """Penalty points per category, capped at that category's weight."""
    breakdown = {category: 0.0 for category in HEALTH_WEIGHTS}

    for category, weight in HEALTH_WEIGHTS.items():
        relevant = [f for f in findings if f.category == category]
        if not relevant:
            continue
        # The worst finding drives most of the penalty; the rest add a diminishing amount, so a
        # long tail of minor issues cannot outweigh one severe problem.
        scores = sorted((f.score for f in relevant), reverse=True)
        severity = scores[0] + sum(s * 0.25 for s in scores[1:])
        breakdown[category] = min(weight, weight * min(severity / 100.0, 1.0))

    return breakdown


def _reasons(
    findings: Sequence[RiskFinding], health: float, breakdown: dict[str, float]
) -> list[str]:
    if not findings:
        return [
            "No risk above the reporting threshold was found. Health score 100.",
        ]

    verdict = (
        "healthy" if health >= 80 else "strained" if health >= 55 else "under serious pressure"
    )
    reasons = [
        f"Supply chain health {health:.0f}/100 — {verdict}.",
        f"{len(findings)} finding(s); "
        f"{sum(1 for f in findings if f.level == 'HIGH')} high, "
        f"{sum(1 for f in findings if f.level == 'MEDIUM')} medium.",
    ]

    worst_category = max(breakdown, key=lambda c: breakdown[c]) if breakdown else None
    if worst_category and breakdown[worst_category] > 0:
        reasons.append(
            f"{worst_category.replace('_', ' ').title()} costs the most points "
            f"({breakdown[worst_category]:.1f} of a possible {HEALTH_WEIGHTS[worst_category]:.0f})."
        )

    for finding in findings[:3]:
        reasons.append(
            f"{finding.level} — {finding.category} on {finding.subject} "
            f"(score {finding.score:.0f}): {finding.recommended_action}"
        )

    return reasons
