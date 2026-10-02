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
from ..formatting import fr_num

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
            "Les recommandations sont calculées à partir de l’instantané fourni ; elles "
            "n’interrogent pas à nouveau la base de données et seront périmées si la position a "
            "évolué depuis.",
            "Les quantités à commander viennent du même modèle de stock que /inventory/optimize et "
            "héritent de son hypothèse de normalité.",
            "Les répartitions entre fournisseurs viennent de l’optimiseur MILP et respectent la "
            "quantité minimale de commande, la capacité et toute limite de concentration.",
            "Les écarts de coût sont modélisés, pas issus de devis : ils excluent les remises "
            "négociées, les conditions contractuelles et tout ce que l’optimiseur ne voit pas.",
            "La priorité dépend d’abord de l’urgence, ensuite de l’argent en jeu — une rupture "
            "imminente passe avant une inefficacité plus coûteuse mais plus lente.",
        ],
    )


def _index_suppliers_by_product(suppliers: Sequence[dict]) -> dict[str, list[dict]]:
    index: dict[str, list[dict]] = {}
    for supplier in suppliers:
        for product_id in supplier.get("productIds", []) or []:
            index.setdefault(str(product_id), []).append(supplier)
    return index


def _site_note(product: dict) -> list[str]:
    """Says, first, that the figures are those of one warehouse and why the others were left out.

    Without it a reader who knows another warehouse is full would take the advice for a mistake.
    """
    site_name = product.get("siteName")
    if not site_name:
        return []
    note = f"Le calcul porte sur {site_name} seul : ce site est sous son point de commande."
    elsewhere = float(product.get("stockElsewhere") or 0)
    if elsewhere > 0:
        note += (
            f" Les {fr_num(elsewhere)} unités détenues dans les autres entrepôts ne le desservent pas "
            "sans transfert."
        )
    return [note]


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

        reasons = _site_note(product) + list(policy.reasons)

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
                f"Commander {fr_num(quantity)} unités de {sku} — réparties entre "
                f"{len(allocation.lines)} fournisseurs"
                if len(allocation.lines) > 1
                else f"Commander {fr_num(quantity)} unités de {sku} auprès de {allocation.lines[0].name}"
            )
        else:
            cost_delta = quantity * unit_cost
            rec_type = "ORDER_NOW"
            title = f"Commander {fr_num(quantity)} unités de {sku}"
            if not candidates:
                reasons.append(
                    "Aucun fournisseur n’est lié à ce produit, donc aucune répartition n’a pu être "
                    "calculée. Liez une grille tarifaire fournisseur pour obtenir une répartition "
                    "chiffrée."
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
                    f"Relever le stock de sécurité de {sku} de {fr_num(extra_units)} unités "
                    f"(niveau de service {service_level:.0%} → {target_service:.0%})"
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
                reasons=_site_note(product)
                + [
                    f"La probabilité de rupture est de {policy.stockout_probability:.1%} alors que "
                    "la position est encore au-dessus du point de commande — le stock tampon est "
                    "sous-dimensionné pour la variabilité observée.",
                    f"Relever l’objectif de {service_level:.0%} à {target_service:.0%} ajoute "
                    f"{fr_num(extra_units)} unités de stock tampon, pour un coût de possession "
                    f"d’environ {fr_num(extra_units * unit_cost * 0.25)} par an.",
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
                    title=(
                        f"{sku} représente {policy.days_of_cover_remaining:.0f} jours de couverture "
                        "— libérer de la trésorerie"
                    ),
                    subject_type="PRODUCT",
                    subject_id=product_id,
                    payload={
                        "productId": product_id,
                        "sku": sku,
                        "excessUnits": round(excess_units, 2),
                        "suggestedMaxStock": round(demand * OVERSTOCK_COVER_DAYS, 2),
                    },
                    reasons=[
                        f"{fr_num(current)} unités en stock pour une demande de {fr_num(demand, 1)}/jour — "
                        f"{policy.days_of_cover_remaining:.0f} jours de couverture.",
                        f"Environ {fr_num(excess_units)} unités au-delà d’un objectif de "
                        f"{OVERSTOCK_COVER_DAYS:.0f} jours, soit {fr_num(tied_up)} immobilisés en "
                        "fonds de roulement.",
                        f"Avec un coût de possession de 25 %/an, cela représente environ "
                        f"{fr_num(tied_up * 0.25)} par an.",
                        "Suspendez les réapprovisionnements, écoulez le stock ou transférez-le vers "
                        "un site en manque.",
                    ],
                    assumptions=[
                        f"Le seuil de surstock retenu est de {OVERSTOCK_COVER_DAYS:.0f} jours ; les "
                        "articles saisonniers ou à long délai d’approvisionnement peuvent "
                        "légitimement le dépasser.",
                        "Coût de possession pris à 25 %/an du coût unitaire.",
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
        name = supplier.get("name", "fournisseur inconnu")

        if on_time < 0.75 and share > 0.15:
            recommendations.append(
                Recommendation(
                    type="CHANGE_SUPPLIER",
                    priority="HIGH" if share > 0.4 else "MEDIUM",
                    title=f"Réduire le volume confié à {name} — {on_time:.0%} de ponctualité",
                    subject_type="SUPPLIER",
                    subject_id=str(supplier.get("supplierId", "")),
                    payload={
                        "supplierId": supplier.get("supplierId"),
                        "currentSharePercent": round(share, 4),
                        "suggestedSharePercent": round(min(share, 0.2), 4),
                    },
                    reasons=[
                        f"{name} ne livre à l’heure que dans {on_time:.0%} des cas et son taux "
                        f"d’acceptation qualité est de {quality:.0%}.",
                        f"Ce fournisseur porte actuellement {share:.0%} des dépenses : son manque "
                        "de fiabilité se répercute sur chaque produit qu’il livre.",
                        "Ce sont les livraisons en retard et refusées qui font gonfler le stock de "
                        "sécurité partout — le coût de ce fournisseur ne se limite pas à son prix.",
                    ],
                    assumptions=[
                        "Les taux de performance sont ceux fournis par l’appelant et sont ramenés "
                        "vers une valeur a priori quand le nombre de commandes est faible.",
                    ],
                    risk_delta=-(1 - on_time) * share,
                )
            )

        if share >= CONCENTRATION_THRESHOLD:
            recommendations.append(
                Recommendation(
                    type="ADD_SUPPLIER",
                    priority="MEDIUM",
                    title=f"Qualifier un second fournisseur — {name} porte {share:.0%} des dépenses",
                    subject_type="SUPPLIER",
                    subject_id=str(supplier.get("supplierId", "")),
                    payload={
                        "supplierId": supplier.get("supplierId"),
                        "currentSharePercent": round(share, 4),
                        "targetMaxSharePercent": 0.5,
                    },
                    reasons=[
                        f"{share:.0%} des dépenses reposent sur un seul fournisseur. Sa fiabilité "
                        f"est actuellement de {on_time:.0%}, mais la concentration est un risque "
                        "indépendant de la performance — une grève, un incendie ou une faillite ne "
                        "tiennent aucun compte de ses bons antécédents.",
                        "Un second fournisseur qualifié transforme un point de défaillance unique "
                        "en fonctionnement dégradé mais maintenu.",
                    ],
                    assumptions=[
                        "La part des dépenses est fournie par l’appelant.",
                        f"Le seuil de concentration retenu est de {CONCENTRATION_THRESHOLD:.0%}.",
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
                    f"Accélérer {shipment.get('trackingNumber', 'l’expédition')} — risque de "
                    f"retard de {delay_probability:.0%} pour {worst_cover:.1f} jours de couverture"
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
                    f"Cette expédition a une probabilité de {delay_probability:.0%} d’arriver en "
                    "retard.",
                    f"Elle transporte {len(thin)} produit(s) dont la couverture restante est de "
                    f"{worst_cover:.1f} jour(s) — le retard se traduirait par une rupture, pas "
                    "seulement par une livraison tardive.",
                    "Accélérer l’expédition, ou passer une commande de dépannage auprès d’un "
                    "fournisseur rapide, coûte moins cher que la rupture ainsi évitée.",
                ],
                assumptions=[
                    "La probabilité de retard est reprise de la fiche de l’expédition.",
                    "La couverture est calculée à partir du stock actuel et de la demande "
                    "journalière moyenne, sans tenir compte des autres commandes entrantes "
                    "absentes de cet instantané.",
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
            f"{len(products)} produit(s) examiné(s) : rien ne demande d’action pour le moment.",
        ]

    counts: dict[str, int] = {}
    for recommendation in recommendations:
        counts[recommendation.priority] = counts.get(recommendation.priority, 0) + 1

    reasons = [
        f"{len(recommendations)} recommandation(s) sur {len(products)} produit(s) : "
        + ", ".join(_priority_count(priority, count) for priority, count in sorted(
            counts.items(), key=lambda item: PRIORITY_ORDER.get(item[0], 9)
        ))
        + ".",
    ]

    urgent = [r for r in recommendations if r.priority in {"CRITICAL", "HIGH"}]
    if urgent:
        reasons.append("À traiter en priorité : " + " ; ".join(r.title for r in urgent[:3]) + ".")

    total_spend = sum(r.cost_delta or 0 for r in recommendations if (r.cost_delta or 0) > 0)
    total_release = -sum(r.cost_delta or 0 for r in recommendations if (r.cost_delta or 0) < 0)
    if total_spend:
        reasons.append(
            f"Appliquer les recommandations de commande engage environ {fr_num(total_spend)}."
        )
    if total_release:
        reasons.append(
            f"Les recommandations de réduction de stock libéreraient environ {fr_num(total_release)} "
            "par an en coût de possession."
        )

    return reasons


#: French priority labels for the overall summary; the ``priority`` field itself stays a code.
PRIORITY_LABELS = {"CRITICAL": "critique", "HIGH": "haute", "MEDIUM": "moyenne", "LOW": "basse"}


def _priority_count(priority: str, count: int) -> str:
    label = PRIORITY_LABELS.get(priority, priority.lower())
    return f"{count} {label}{'s' if count > 1 else ''}"
