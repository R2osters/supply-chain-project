"""Supplier scoring — a configurable, auditable ranking.

Distinct from the reliability score the NestJS API computes from purchase-order history. That one
answers "how has this supplier behaved?"; this one answers "which supplier should I pick for
*this* order?", and therefore weighs commercial terms (price, MOQ, distance) alongside behaviour.

Criteria are min-max normalised across the candidate set before weighting, so a criterion whose
natural units are large (price in the thousands) cannot swamp one whose units are small
(reliability in [0, 1]). Every criterion is oriented so that **higher is better**:

    price               inverted — cheaper scores higher
    lead time           inverted — faster scores higher
    reliability         on-time × (1 − cancellation rate)
    quality             acceptance rate, already 0–1
    capacity            more headroom scores higher
    distance            inverted — closer scores higher

Min-max rather than z-scores because the output has to be explainable to a buyer: "cheapest gets
1.0, dearest gets 0.0, you are 0.6 of the way down" is a sentence a human can check. A z-score is
not. The cost is sensitivity to a single outlier candidate, which is why the response reports
both the normalised and the weighted contribution of every criterion — an odd ranking can be
traced to the term that caused it.

Degenerate case: when every candidate has the same value for a criterion, min-max is undefined
(zero range). Those criteria are given 1.0 for everyone, which makes them cancel out of the
comparison instead of producing a division by zero or an arbitrary ordering.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence

DEFAULT_WEIGHTS: dict[str, float] = {
    "price": 0.30,
    "reliability": 0.25,
    "lead_time": 0.20,
    "quality": 0.15,
    "capacity": 0.05,
    "distance": 0.05,
}

CRITERIA = tuple(DEFAULT_WEIGHTS.keys())

#: Criteria where a *lower* raw value is better and the normalisation must be inverted.
LOWER_IS_BETTER = {"price", "lead_time", "distance"}


@dataclass
class ScoredSupplier:
    supplier_id: str
    name: str
    score: float
    rank: int
    normalized: dict[str, float]
    weighted: dict[str, float]
    reasons: list[str] = field(default_factory=list)


@dataclass
class ScoringResult:
    results: list[ScoredSupplier]
    weights_used: dict[str, float]
    reasons: list[str] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)


def _raw_values(supplier) -> dict[str, float]:
    """Project a supplier onto the six criteria, in their natural units."""
    return {
        "price": float(supplier.unit_price),
        "reliability": float(supplier.on_time_delivery_rate) * (
            1.0 - float(getattr(supplier, "cancellation_rate", 0.0) or 0.0)
        ),
        "lead_time": float(supplier.lead_time_days),
        "quality": float(getattr(supplier, "quality_acceptance_rate", 1.0) or 1.0),
        "capacity": float(supplier.capacity_units),
        # A supplier with no known distance is treated as average rather than penalised, which
        # would otherwise punish incomplete master data rather than a real disadvantage.
        "distance": float(supplier.distance_km) if supplier.distance_km is not None else float("nan"),
    }


def _normalise(values: list[float], lower_is_better: bool) -> list[float]:
    finite = [v for v in values if v == v]  # NaN != NaN
    if not finite:
        return [1.0] * len(values)

    low, high = min(finite), max(finite)
    span = high - low

    if span == 0:
        # Every candidate identical on this criterion: it carries no information, so give it a
        # constant and let the other criteria decide.
        return [1.0] * len(values)

    normalised = []
    for value in values:
        if value != value:  # NaN — unknown, treat as the midpoint
            normalised.append(0.5)
            continue
        scaled = (value - low) / span
        normalised.append(1.0 - scaled if lower_is_better else scaled)
    return normalised


def score_suppliers(
    suppliers: Sequence,
    weights: dict[str, float] | None = None,
) -> ScoringResult:
    if not suppliers:
        raise ValueError("at least one supplier is required")

    used = {**DEFAULT_WEIGHTS, **(weights or {})}
    total_weight = sum(used.values())
    if total_weight <= 0:
        raise ValueError("supplier scoring weights must sum to a positive number")

    raw = [_raw_values(s) for s in suppliers]

    normalised_by_criterion: dict[str, list[float]] = {}
    for criterion in CRITERIA:
        column = [row[criterion] for row in raw]
        normalised_by_criterion[criterion] = _normalise(column, criterion in LOWER_IS_BETTER)

    scored: list[ScoredSupplier] = []
    for index, supplier in enumerate(suppliers):
        normalized = {c: round(normalised_by_criterion[c][index], 4) for c in CRITERIA}
        weighted = {c: round(normalized[c] * used[c] / total_weight, 4) for c in CRITERIA}
        score = round(sum(weighted.values()) * 100, 2)

        scored.append(
            ScoredSupplier(
                supplier_id=supplier.supplier_id,
                name=supplier.name,
                score=score,
                rank=0,
                normalized=normalized,
                weighted=weighted,
                reasons=_supplier_reasons(supplier, normalized, weighted, raw[index]),
            )
        )

    scored.sort(key=lambda s: s.score, reverse=True)
    for position, entry in enumerate(scored, start=1):
        entry.rank = position

    return ScoringResult(
        results=scored,
        weights_used={k: round(v / total_weight, 4) for k, v in used.items()},
        reasons=_overall_reasons(scored, used, total_weight),
        assumptions=[
            "Criteria are min-max normalised across the supplied candidates only — a score is a "
            "comparison within this set, not an absolute rating, and adding a candidate changes "
            "everyone's score.",
            "Price, lead time and distance are inverted so that higher is always better.",
            "A criterion on which every candidate is identical is neutralised to 1.0 for all, so "
            "it drops out of the comparison instead of dividing by a zero range.",
            "A supplier with no recorded distance is scored at the midpoint rather than "
            "penalised, so missing master data does not masquerade as a disadvantage.",
            "Weights are normalised to sum to 1, so passing unnormalised weights is safe.",
        ],
    )


def _supplier_reasons(
    supplier, normalized: dict[str, float], weighted: dict[str, float], raw: dict[str, float]
) -> list[str]:
    strongest = max(weighted, key=lambda c: weighted[c])
    weakest = min(weighted, key=lambda c: weighted[c])

    reasons = [
        f"Unit price {raw['price']:,.2f} normalises to {normalized['price']:.2f} "
        f"(1.00 = cheapest in this set).",
        f"Lead time {raw['lead_time']:.0f} days normalises to {normalized['lead_time']:.2f} "
        f"(1.00 = fastest in this set).",
        f"Reliability {raw['reliability']:.1%}, quality acceptance {raw['quality']:.1%}.",
        f"Strongest contribution: {strongest.replace('_', ' ')} "
        f"({weighted[strongest]:.3f} of the weighted total).",
        f"Weakest contribution: {weakest.replace('_', ' ')} ({weighted[weakest]:.3f}).",
    ]

    if supplier.minimum_order_quantity and supplier.minimum_order_quantity > 0:
        reasons.append(
            f"Minimum order quantity {supplier.minimum_order_quantity:,.0f} units — not part of "
            "the score, but a hard constraint in allocation."
        )
    return reasons


def _overall_reasons(
    scored: Sequence[ScoredSupplier], weights: dict[str, float], total: float
) -> list[str]:
    if not scored:
        return []

    best = scored[0]
    reasons = [
        f"{best.name} ranks first with {best.score:.1f}/100.",
        "Weights applied: "
        + ", ".join(f"{c.replace('_', ' ')} {weights[c] / total:.0%}" for c in CRITERIA)
        + ".",
    ]

    if len(scored) > 1:
        runner_up = scored[1]
        gap = best.score - runner_up.score
        reasons.append(
            f"{runner_up.name} is second at {runner_up.score:.1f}"
            + (
                f", only {gap:.1f} points behind — the ranking is sensitive to the weights."
                if gap < 5
                else f", {gap:.1f} points behind."
            )
        )
    return reasons
