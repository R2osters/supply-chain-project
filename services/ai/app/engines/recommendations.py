"""The recommendation engine — where the platform stops describing and starts deciding.

Takes the whole picture (demand, inventory, suppliers, shipments, risks) and emits *actionable*
recommendations: not "SKU-001 is low" but "order 5 000 units from Supplier C today, here is what
it costs, here is what happens if you do not".

Two properties are enforced rather than encouraged:

**Every recommendation carries a machine-readable ``payload``.** The API turns it into a real
draft purchase order or a real inventory-policy write. A recommendation that a human has to
retype is a report, not a recommendation.

**Every recommendation carries reasons.** The dataclass has no default for ``reasons``, so a
recommendation without justification cannot be constructed at all.

Priority is derived from time pressure and money at stake, in that order — a 200-unit stockout
tomorrow outranks a 50 000-unit inefficiency next quarter, because the first one is unrecoverable
and the second one is still negotiable.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Sequence

from .allocation import SupplierOption, allocate
from .inventory import optimize_inventory

#: Days of cover below which a stockout is treated as imminent rather than approaching.
CRITICAL_COVER_DAYS = 3.0
HIGH_COVER_DAYS = 10.0

#: Stockout probability above which action is recommended regardless of cover.
ACTIONABLE_STOCKOUT_PROBABILITY = 0.2

#: Excess cover above which capital is considered to be sitting idle.
OVERSTOCK_COVER_DAYS = 120.0

#: Concentration above which a second source is recommended.
CONCENTRATION_THRESHOLD = 0.7


@dataclass
class Recommendation:
    type: str
    priority: str
    title: str
    subject_type: str
    subject_id: str
    payload: dict
    reasons: list[str]
    assumptions: list[str]
    cost_delta: float | None = None
    risk_delta: float | None = None
    service_level_delta: float | None = None
    expires_at: str | None = None

    def to_dict(self) -> dict:
        return {
            "type": self.type,
            "priority": self.priority,
            "title": self.title,
            "subjectType": self.subject_type,
            "subjectId": self.subject_id,
            "payload": self.payload,
            "estimatedImpact": {
                "costDelta": None if self.cost_delta is None else round(self.cost_delta, 2),
                "riskDelta": None if self.risk_delta is None else round(self.risk_delta, 4),
                "serviceLevelDelta": (
                    None
                    if self.service_level_delta is None
                    else round(self.service_level_delta, 4)
                ),
            },
            "explanation": {
                "summary": self.title,
                "reasons": self.reasons,
                "assumptions": self.assumptions,
            },
            "expiresAt": self.expires_at,
        }


@dataclass
class RecommendationSet:
    recommendations: list[Recommendation]
    reasons: list[str] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)


PRIORITY_ORDER = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}


def _priority(days_of_cover: float, stockout_probability: float, value_at_risk: float) -> str:
    if days_of_cover <= CRITICAL_COVER_DAYS or stockout_probability >= 0.75:
        return "CRITICAL"
    if days_of_cover <= HIGH_COVER_DAYS or stockout_probability >= 0.4:
        return "HIGH"
    if stockout_probability >= ACTIONABLE_STOCKOUT_PROBABILITY or value_at_risk > 10_000:
        return "MEDIUM"
    return "LOW"


def generate(
    *,
    company_id: str,
    products: Sequence[dict],
    suppliers: Sequence[dict],
    shipments: Sequence[dict] = (),
    today: date | None = None,
) -> RecommendationSet:
    """Build the full recommendation set for one company."""
    today = today or date.today()
    recommendations: list[Recommendation] = []

    suppliers_by_product = _index_suppliers_by_product(suppliers)

    for product in products:
        recommendations += _for_product(product, suppliers_by_product, today)

    recommendations += _supplier_recommendations(suppliers, today)
    recommendations += _shipment_recommendations(shipments, products, today)

    recommendations.sort(
        key=lambda r: (
            PRIORITY_ORDER.get(r.priority, 9),
            -(r.cost_delta or 0.0),
        )
    )

    return RecommendationSet(
        recommendations=recommendations,
        reasons=_overall_reasons(recommendations, products),
        assumptions=[
            "Recommendations are generated from the snapshot supplied; they do not re-query the "
            "database and will be stale if the position has moved since.",
            "Order quantities come from the same inventory model as /inventory/optimize and "
            "inherit its normality assumption.",
            "Supplier splits come from the MILP allocator and respect minimum order quantity, "
            "capacity and any concentration limit.",
            "Cost deltas are modelled, not quoted: they exclude negotiated discounts, contract "
            "terms and anything the optimiser cannot see.",
            "Priority is driven by time pressure first and money second — an imminent stockout "
            "outranks a larger but slower inefficiency.",
        ],
    )


def _index_suppliers_by_product(suppliers: Sequence[dict]) -> dict[str, list[dict]]:
    index: dict[str, list[dict]] = {}
    for supplier in suppliers:
        for product_id in supplier.get("productIds", []) or []:
            index.setdefault(str(product_id), []).append(supplier)
    return index


def _for_product(
    product: dict, suppliers_by_product: dict[str, list[dict]], today: date
) -> list[Recommendation]:
    product_id = str(product.get("productId", ""))
    sku = product.get("sku", product_id)

    demand = float(product.get("averageDailyDemand", 0) or 0)
    demand_std = float(product.get("demandStdDev", 0) or 0)
    current = float(product.get("currentStock", 0) or 0)
    reserved = float(product.get("reservedStock", 0) or 0)
    incoming = float(product.get("incomingQuantity", 0) or 0)
    lead_time = float(product.get("leadTimeDays", 7) or 7)
    lead_time_std = float(product.get("leadTimeStdDevDays", 0) or 0)
    unit_cost = float(product.get("unitCost", 0) or 0)
    service_level = float(product.get("serviceLevel", 0.95) or 0.95)

    if demand <= 0:
        return []

    policy = optimize_inventory(
        current_stock=current,
        reserved_stock=min(reserved, current),
        average_daily_demand=demand,
        demand_std=demand_std,
        lead_time_days=lead_time,
        lead_time_std_days=lead_time_std,
        service_level=service_level,
        unit_cost=unit_cost or None,
        ordering_cost=float(product.get("orderingCost", 0) or 0) or None,
        incoming_quantity=incoming,
        today=today,
    )

    recommendations: list[Recommendation] = []
    candidates = suppliers_by_product.get(product_id, [])

    # ---------------------------------------------------------------- order
    if policy.reorder_required and policy.recommended_order_quantity > 0:
        quantity = policy.recommended_order_quantity
        value_at_risk = quantity * unit_cost
        priority = _priority(policy.days_of_cover_remaining, policy.stockout_probability, value_at_risk)

        allocation = _allocate_if_possible(quantity, candidates, lead_time)

        payload: dict = {
            "productId": product_id,
            "sku": sku,
            "quantity": round(quantity, 2),
            "warehouseId": product.get("warehouseId"),
            "requiredByDate": (today + timedelta(days=max(policy.days_of_cover_remaining, 0))).isoformat(),
        }

        reasons = list(policy.reasons)

        if allocation is not None and allocation.lines:
            payload["lines"] = [
                {
                    "supplierId": line.supplier_id,
                    "supplierName": line.name,
                    "quantity": round(line.quantity, 2),
                    "unitPrice": line.unit_price,
                    "estimatedCost": round(line.purchase_cost, 2),
                }
                for line in allocation.lines
            ]
            reasons.extend(allocation.reasons)
            cost_delta = allocation.cost_breakdown.get("purchase", quantity * unit_cost)
            rec_type = "SPLIT_ORDER" if len(allocation.lines) > 1 else "ORDER_NOW"
            title = (
                f"Order {quantity:,.0f} units of {sku} — split across "
                f"{len(allocation.lines)} suppliers"
                if len(allocation.lines) > 1
                else f"Order {quantity:,.0f} units of {sku} from {allocation.lines[0].name}"
            )
        else:
            cost_delta = quantity * unit_cost
            rec_type = "ORDER_NOW"
            title = f"Order {quantity:,.0f} units of {sku}"
            if not candidates:
                reasons.append(
                    "No supplier is linked to this product, so no split could be computed. "
                    "Link a supplier price list to get a costed allocation."
                )

        recommendations.append(
            Recommendation(
                type=rec_type,
                priority=priority,
                title=title,
                subject_type="PRODUCT",
                subject_id=product_id,
                payload=payload,
                reasons=reasons,
                assumptions=policy.assumptions
                + (allocation.assumptions if allocation else []),
                cost_delta=cost_delta,
                # Ordering removes essentially all of the modelled stockout risk.
                risk_delta=-policy.stockout_probability,
                service_level_delta=max(0.0, service_level - (1 - policy.stockout_probability)),
                expires_at=(today + timedelta(days=max(1, int(policy.days_of_cover_remaining)))).isoformat(),
            )
        )

    # ------------------------------------------------------ safety stock up
    elif policy.stockout_probability >= ACTIONABLE_STOCKOUT_PROBABILITY:
        # Not yet at the reorder point, but the buffer is too thin for the volatility observed.
        target_service = min(0.99, service_level + 0.03)
        stronger = optimize_inventory(
            current_stock=current,
            reserved_stock=min(reserved, current),
            average_daily_demand=demand,
            demand_std=demand_std,
            lead_time_days=lead_time,
            lead_time_std_days=lead_time_std,
            service_level=target_service,
            unit_cost=unit_cost or None,
            incoming_quantity=incoming,
            today=today,
        )
        extra_units = stronger.safety_stock - policy.safety_stock

        recommendations.append(
            Recommendation(
                type="INCREASE_SAFETY_STOCK",
                priority="MEDIUM",
                title=(
                    f"Raise safety stock for {sku} by {extra_units:,.0f} units "
                    f"({service_level:.0%} → {target_service:.0%} service level)"
                ),
                subject_type="PRODUCT",
                subject_id=product_id,
                payload={
                    "productId": product_id,
                    "sku": sku,
                    "warehouseId": product.get("warehouseId"),
                    "safetyStock": round(stronger.safety_stock, 2),
                    "reorderPoint": round(stronger.reorder_point, 2),
                    "serviceLevel": target_service,
                },
                reasons=[
                    f"Stockout probability is {policy.stockout_probability:.1%} even though the "
                    "position is still above the reorder point — the buffer is undersized for "
                    "the observed variability.",
                    f"Raising the target from {service_level:.0%} to {target_service:.0%} adds "
                    f"{extra_units:,.0f} units of buffer, costing about "
                    f"{extra_units * unit_cost * 0.25:,.0f} per year to hold.",
                ]
                + policy.reasons[:3],
                assumptions=stronger.assumptions,
                cost_delta=extra_units * unit_cost * 0.25,
                risk_delta=-(policy.stockout_probability * 0.6),
                service_level_delta=target_service - service_level,
            )
        )

    # -------------------------------------------------------- reduce excess
    if (
        policy.days_of_cover_remaining > OVERSTOCK_COVER_DAYS
        and not policy.reorder_required
        and unit_cost > 0
    ):
        excess_units = max(current - demand * OVERSTOCK_COVER_DAYS, 0)
        tied_up = excess_units * unit_cost

        if tied_up > 1_000:
            recommendations.append(
                Recommendation(
                    type="REDUCE_INVENTORY",
                    priority="LOW",
                    title=f"{sku} holds {policy.days_of_cover_remaining:.0f} days of cover — release capital",
                    subject_type="PRODUCT",
                    subject_id=product_id,
                    payload={
                        "productId": product_id,
                        "sku": sku,
                        "excessUnits": round(excess_units, 2),
                        "suggestedMaxStock": round(demand * OVERSTOCK_COVER_DAYS, 2),
                    },
                    reasons=[
                        f"{current:,.0f} units on hand against {demand:,.1f}/day of demand — "
                        f"{policy.days_of_cover_remaining:.0f} days of cover.",
                        f"Roughly {excess_units:,.0f} units beyond a {OVERSTOCK_COVER_DAYS:.0f}-day "
                        f"target, tying up {tied_up:,.0f} in working capital.",
                        f"At a 25 %/year carrying cost that is about {tied_up * 0.25:,.0f} a year.",
                        "Stop reordering, run the stock down, or transfer it to a location that "
                        "is short.",
                    ],
                    assumptions=[
                        f"{OVERSTOCK_COVER_DAYS:.0f} days is used as the overstock threshold; "
                        "seasonal or long-lead-time items may legitimately exceed it.",
                        "Carrying cost taken as 25 %/year of unit cost.",
                    ],
                    cost_delta=-tied_up * 0.25,
                )
            )

    return recommendations


def _allocate_if_possible(
    quantity: float, candidates: Sequence[dict], required_within_days: float
):
    if not candidates:
        return None

    options = []
    for candidate in candidates:
        try:
            options.append(
                SupplierOption(
                    supplier_id=str(candidate["supplierId"]),
                    name=str(candidate.get("name", candidate["supplierId"])),
                    unit_price=float(candidate["unitPrice"]),
                    lead_time_days=float(candidate.get("leadTimeDays", 7) or 7),
                    on_time_delivery_rate=float(candidate.get("onTimeDeliveryRate", 1) or 1),
                    capacity_units=float(candidate.get("capacityUnits", quantity) or quantity),
                    minimum_order_quantity=float(candidate.get("minimumOrderQuantity", 0) or 0),
                    quality_acceptance_rate=float(candidate.get("qualityAcceptanceRate", 1) or 1),
                    distance_km=(
                        float(candidate["distanceKm"])
                        if candidate.get("distanceKm") is not None
                        else None
                    ),
                )
            )
        except (KeyError, TypeError, ValueError):
            # A malformed supplier row must not sink the whole recommendation run.
            continue

    if not options:
        return None

    try:
        return allocate(
            demand_quantity=quantity,
            suppliers=options,
            required_within_days=required_within_days,
        )
    except (ValueError, RuntimeError):
        return None


def _supplier_recommendations(suppliers: Sequence[dict], today: date) -> list[Recommendation]:
    recommendations: list[Recommendation] = []

    for supplier in suppliers:
        on_time = float(supplier.get("onTimeDeliveryRate", 1) or 1)
        quality = float(supplier.get("qualityAcceptanceRate", 1) or 1)
        share = float(supplier.get("sharePercent", 0) or 0)
        name = supplier.get("name", "unknown supplier")

        if on_time < 0.75 and share > 0.15:
            recommendations.append(
                Recommendation(
                    type="CHANGE_SUPPLIER",
                    priority="HIGH" if share > 0.4 else "MEDIUM",
                    title=f"Shift volume away from {name} — {on_time:.0%} on-time",
                    subject_type="SUPPLIER",
                    subject_id=str(supplier.get("supplierId", "")),
                    payload={
                        "supplierId": supplier.get("supplierId"),
                        "currentSharePercent": round(share, 4),
                        "suggestedSharePercent": round(min(share, 0.2), 4),
                    },
                    reasons=[
                        f"{name} delivers on time only {on_time:.0%} of the time and quality "
                        f"acceptance is {quality:.0%}.",
                        f"They currently carry {share:.0%} of spend, so their unreliability "
                        "propagates into every product they serve.",
                        "Late and rejected deliveries are what force safety stock up across the "
                        "board — the cost of this supplier is not just their price.",
                    ],
                    assumptions=[
                        "Performance rates are as supplied by the caller and are shrunk toward a "
                        "prior when the order count is small.",
                    ],
                    risk_delta=-(1 - on_time) * share,
                )
            )

        if share >= CONCENTRATION_THRESHOLD:
            recommendations.append(
                Recommendation(
                    type="ADD_SUPPLIER",
                    priority="MEDIUM",
                    title=f"Qualify a second source — {name} carries {share:.0%} of spend",
                    subject_type="SUPPLIER",
                    subject_id=str(supplier.get("supplierId", "")),
                    payload={
                        "supplierId": supplier.get("supplierId"),
                        "currentSharePercent": round(share, 4),
                        "targetMaxSharePercent": 0.5,
                    },
                    reasons=[
                        f"{share:.0%} of spend sits with one supplier. Their reliability is "
                        f"currently {on_time:.0%}, but concentration is a risk independent of "
                        "performance — a strike, a fire or an insolvency does not care how good "
                        "their record is.",
                        "A qualified second source turns a single point of failure into a "
                        "degraded-but-running state.",
                    ],
                    assumptions=[
                        "Share of spend is supplied by the caller.",
                        f"{CONCENTRATION_THRESHOLD:.0%} is used as the concentration threshold.",
                    ],
                )
            )

    return recommendations


def _shipment_recommendations(
    shipments: Sequence[dict], products: Sequence[dict], today: date
) -> list[Recommendation]:
    """Expedite shipments that feed a product with thin cover — the TRACK→OPTIMIZE link."""
    recommendations: list[Recommendation] = []

    cover_by_product: dict[str, float] = {}
    for product in products:
        demand = float(product.get("averageDailyDemand", 0) or 0)
        if demand > 0:
            cover_by_product[str(product.get("productId", ""))] = (
                float(product.get("currentStock", 0) or 0) / demand
            )

    for shipment in shipments:
        delay_probability = float(shipment.get("delayProbability", 0) or 0)
        if delay_probability < 0.5:
            continue

        product_ids = [str(p) for p in (shipment.get("productIds") or [])]
        thin = [
            product_id
            for product_id in product_ids
            if cover_by_product.get(product_id, 999) <= HIGH_COVER_DAYS
        ]
        if not thin:
            continue

        worst_cover = min(cover_by_product.get(p, 999) for p in thin)

        recommendations.append(
            Recommendation(
                type="EXPEDITE_SHIPMENT",
                priority="CRITICAL" if worst_cover <= CRITICAL_COVER_DAYS else "HIGH",
                title=(
                    f"Expedite {shipment.get('trackingNumber', 'shipment')} — "
                    f"{delay_probability:.0%} delay risk against {worst_cover:.1f} days of cover"
                ),
                subject_type="SHIPMENT",
                subject_id=str(shipment.get("shipmentId", "")),
                payload={
                    "shipmentId": shipment.get("shipmentId"),
                    "trackingNumber": shipment.get("trackingNumber"),
                    "affectedProductIds": thin,
                    "coverDays": round(worst_cover, 2),
                },
                reasons=[
                    f"This shipment has a {delay_probability:.0%} probability of arriving late.",
                    f"It carries {len(thin)} product(s) whose remaining cover is "
                    f"{worst_cover:.1f} day(s) — the delay would turn into a stockout, not just "
                    "a late delivery.",
                    "Expediting, or raising a bridging order from a fast supplier, is cheaper "
                    "than the stockout it prevents.",
                ],
                assumptions=[
                    "Delay probability is taken from the shipment record.",
                    "Cover is computed from current stock and mean daily demand, ignoring other "
                    "inbound orders not present in this snapshot.",
                ],
                risk_delta=-delay_probability,
            )
        )

    return recommendations


def _overall_reasons(
    recommendations: Sequence[Recommendation], products: Sequence[dict]
) -> list[str]:
    if not recommendations:
        return [
            f"Reviewed {len(products)} product(s) and found nothing that needs action right now.",
        ]

    counts: dict[str, int] = {}
    for recommendation in recommendations:
        counts[recommendation.priority] = counts.get(recommendation.priority, 0) + 1

    reasons = [
        f"{len(recommendations)} recommendation(s) across {len(products)} product(s): "
        + ", ".join(f"{count} {priority.lower()}" for priority, count in sorted(
            counts.items(), key=lambda item: PRIORITY_ORDER.get(item[0], 9)
        ))
        + ".",
    ]

    urgent = [r for r in recommendations if r.priority in {"CRITICAL", "HIGH"}]
    if urgent:
        reasons.append("Act first on: " + "; ".join(r.title for r in urgent[:3]) + ".")

    total_spend = sum(r.cost_delta or 0 for r in recommendations if (r.cost_delta or 0) > 0)
    total_release = -sum(r.cost_delta or 0 for r in recommendations if (r.cost_delta or 0) < 0)
    if total_spend:
        reasons.append(f"Acting on the ordering recommendations commits about {total_spend:,.0f}.")
    if total_release:
        reasons.append(
            f"The inventory-reduction recommendations would release about {total_release:,.0f} a "
            "year in carrying cost."
        )

    return reasons
