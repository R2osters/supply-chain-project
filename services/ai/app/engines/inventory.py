"""Inventory policy: safety stock, reorder point, order quantity.

All of it is textbook (Silver–Pyke–Peterson, Chopra–Meindl) rather than invented, because these
formulas are the ones planners already reason about and a bespoke heuristic would be impossible
to defend in a review.

**Safety stock under uncertain demand *and* uncertain lead time.** The common mistake is to size
the buffer from demand variability alone. Lead-time variability is usually the larger term in
practice — a supplier that swings between 3 and 20 days hurts far more than one whose daily
demand wobbles by 10 % — so both are carried:

    σ_LTD = sqrt( L · σ_d²  +  d̄² · σ_L² )

    SS    = z(SL) · σ_LTD

where ``L`` is the mean lead time in days, ``σ_d`` the standard deviation of daily demand, ``d̄``
the mean daily demand and ``σ_L`` the standard deviation of lead time in days. The first term is
demand risk over the lead time; the second is the risk that the lead time itself stretches. The
formula assumes demand and lead time are independent — stated explicitly in every response,
because when a supplier's delays are *caused* by a demand surge the two correlate and this
underestimates the buffer.

``z(SL)`` is the standard normal quantile at the target cycle service level. Normality is an
approximation: lead-time demand is a sum of many daily demands, so the central limit theorem
makes it reasonable for fast movers and progressively worse for slow, lumpy ones. Flagged, not
hidden.

**Reorder point** is expected demand over the lead time plus the buffer:

    ROP = d̄ · L + SS

**Order quantity** is the classic EOQ when the economic inputs exist:

    EOQ = sqrt( 2 · D · S / H )

with ``D`` annual demand, ``S`` the fixed cost per order and ``H`` the holding cost per unit-year.
When they do not exist the engine falls back to covering the forecast horizon plus the buffer,
and says so rather than inventing a cost.

**Stockout probability** is computed against the *actual* projected position, not assumed to be
``1 − SL``: the target service level is what the policy aims for, whereas the number a planner
needs is the risk given what is really on the shelf right now.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, timedelta

from scipy import stats

from .data_quality import validate_positive

#: Below this many units of mean daily demand, the normal approximation is unreliable.
SLOW_MOVER_THRESHOLD = 1.0

#: Service levels outside this range are refused: 0.9999 implies a buffer nobody can afford.
MIN_SERVICE_LEVEL = 0.50
MAX_SERVICE_LEVEL = 0.9999

DAYS_PER_YEAR = 365.0


@dataclass
class InventoryPolicy:
    safety_stock: float
    reorder_point: float
    recommended_order_quantity: float
    economic_order_quantity: float | None
    days_of_cover_remaining: float
    projected_stockout_date: str | None
    stockout_probability: float
    reorder_required: bool
    recommended_order_date: str | None
    expected_stock_after_order: float
    sigma_lead_time_demand: float
    z_score: float
    reasons: list[str] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "safetyStock": round(self.safety_stock, 2),
            "reorderPoint": round(self.reorder_point, 2),
            "recommendedOrderQuantity": round(self.recommended_order_quantity, 2),
            "economicOrderQuantity": (
                None
                if self.economic_order_quantity is None
                else round(self.economic_order_quantity, 2)
            ),
            "daysOfCoverRemaining": round(self.days_of_cover_remaining, 2),
            "projectedStockoutDate": self.projected_stockout_date,
            "stockoutProbability": round(self.stockout_probability, 4),
            "reorderRequired": self.reorder_required,
            "recommendedOrderDate": self.recommended_order_date,
            "expectedStockAfterOrder": round(self.expected_stock_after_order, 2),
        }


def z_for_service_level(service_level: float) -> float:
    """Standard normal quantile for a cycle service level."""
    if not MIN_SERVICE_LEVEL <= service_level <= MAX_SERVICE_LEVEL:
        raise ValueError(
            f"service_level doit être compris entre {MIN_SERVICE_LEVEL} et {MAX_SERVICE_LEVEL} "
            f"(reçu : {service_level})"
        )
    return float(stats.norm.ppf(service_level))


def sigma_lead_time_demand(
    average_daily_demand: float,
    demand_std: float,
    lead_time_days: float,
    lead_time_std_days: float,
) -> float:
    """Combined standard deviation of demand over the lead time."""
    demand_term = lead_time_days * (demand_std**2)
    lead_time_term = (average_daily_demand**2) * (lead_time_std_days**2)
    return math.sqrt(max(demand_term + lead_time_term, 0.0))


def safety_stock(
    average_daily_demand: float,
    demand_std: float,
    lead_time_days: float,
    lead_time_std_days: float,
    service_level: float,
) -> float:
    z = z_for_service_level(service_level)
    return max(z * sigma_lead_time_demand(
        average_daily_demand, demand_std, lead_time_days, lead_time_std_days
    ), 0.0)


def reorder_point(
    average_daily_demand: float,
    lead_time_days: float,
    buffer: float,
) -> float:
    return max(average_daily_demand * lead_time_days + buffer, 0.0)


def economic_order_quantity(
    annual_demand: float, ordering_cost: float, holding_cost_per_unit_per_year: float
) -> float | None:
    """EOQ. Returns ``None`` when an input makes the formula meaningless rather than raising."""
    if annual_demand <= 0 or ordering_cost <= 0 or holding_cost_per_unit_per_year <= 0:
        return None
    return math.sqrt(2 * annual_demand * ordering_cost / holding_cost_per_unit_per_year)


def stockout_probability(
    projected_position: float,
    average_daily_demand: float,
    demand_std: float,
    lead_time_days: float,
    lead_time_std_days: float,
) -> float:
    """P(demand over the lead time exceeds what will be on hand).

    Under the normal approximation this is ``1 − Φ((position − μ_LTD) / σ_LTD)``.
    """
    sigma = sigma_lead_time_demand(
        average_daily_demand, demand_std, lead_time_days, lead_time_std_days
    )
    mu = average_daily_demand * lead_time_days

    if sigma <= 0:
        # No uncertainty at all: it is a certainty either way.
        return 0.0 if projected_position >= mu else 1.0

    return float(1.0 - stats.norm.cdf((projected_position - mu) / sigma))


def optimize_inventory(
    *,
    current_stock: float,
    reserved_stock: float = 0.0,
    average_daily_demand: float,
    demand_std: float,
    lead_time_days: float,
    lead_time_std_days: float,
    service_level: float = 0.95,
    ordering_cost: float | None = None,
    holding_cost_per_unit_per_year: float | None = None,
    unit_cost: float | None = None,
    review_period_days: float = 0.0,
    incoming_quantity: float = 0.0,
    incoming_arrival_days: float | None = None,
    today: date | None = None,
) -> InventoryPolicy:
    """Compute the full policy and the decision that follows from it."""
    validate_positive("average_daily_demand", average_daily_demand, allow_zero=True)
    validate_positive("demand_std", demand_std, allow_zero=True)
    validate_positive("lead_time_days", lead_time_days, allow_zero=True)
    validate_positive("lead_time_std_days", lead_time_std_days, allow_zero=True)
    validate_positive("current_stock", current_stock, allow_zero=True)

    today = today or date.today()
    z = z_for_service_level(service_level)
    sigma_ltd = sigma_lead_time_demand(
        average_daily_demand, demand_std, lead_time_days, lead_time_std_days
    )

    buffer = max(z * sigma_ltd, 0.0)

    # A periodic-review policy must also cover the review interval, otherwise it is blind between
    # reviews. With continuous review (period 0) this term vanishes.
    effective_lead_time = lead_time_days + review_period_days
    rop = reorder_point(average_daily_demand, effective_lead_time, buffer)

    # The decision is made on the *inventory position* — what is on hand, minus what is already
    # promised, plus what is already on order. Using on-hand alone is the classic double-ordering
    # bug: the buyer reorders on Monday, again on Tuesday, and the warehouse floods on Friday.
    free_stock = current_stock - reserved_stock
    position = free_stock + incoming_quantity

    reorder_required = position < rop

    if average_daily_demand > 0:
        days_of_cover = free_stock / average_daily_demand
        stockout_day = today + timedelta(days=max(days_of_cover, 0.0))
        projected_stockout_date = stockout_day.isoformat() if free_stock >= 0 else today.isoformat()
    else:
        days_of_cover = float("inf")
        projected_stockout_date = None

    risk = stockout_probability(
        position, average_daily_demand, demand_std, effective_lead_time, lead_time_std_days
    )

    # --- order quantity ----------------------------------------------------
    annual_demand = average_daily_demand * DAYS_PER_YEAR
    holding = holding_cost_per_unit_per_year
    if holding is None and unit_cost is not None:
        # 25 %/year is the conventional carrying-cost rule of thumb (capital, storage, shrinkage,
        # obsolescence). Stated as an assumption so the planner can override it.
        holding = 0.25 * unit_cost

    eoq = (
        economic_order_quantity(annual_demand, ordering_cost, holding)
        if ordering_cost is not None and holding is not None
        else None
    )

    if eoq is not None:
        order_quantity = max(eoq, rop - position)
        quantity_basis = (
            f"de la quantité économique de commande (EOQ) de {eoq:.0f} unités, relevée si "
            "nécessaire pour repasser au-dessus du point de commande"
        )
    else:
        # No economic inputs: order enough to reach the reorder point plus one lead time of cover.
        order_quantity = max(rop - position + average_daily_demand * lead_time_days, 0.0)
        quantity_basis = (
            "de l’écart au point de commande, plus la couverture d’un délai d’approvisionnement "
            "(aucun coût de commande ni de possession fourni, donc pas de calcul d’EOQ)"
        )

    order_quantity = max(order_quantity, 0.0) if reorder_required else 0.0

    if reorder_required:
        recommended_order_date = today.isoformat()
    elif average_daily_demand > 0:
        # Order on the day the position is projected to fall to the reorder point.
        days_until = (position - rop) / average_daily_demand
        recommended_order_date = (today + timedelta(days=max(days_until, 0.0))).isoformat()
    else:
        recommended_order_date = None

    return InventoryPolicy(
        safety_stock=buffer,
        reorder_point=rop,
        recommended_order_quantity=order_quantity,
        economic_order_quantity=eoq,
        days_of_cover_remaining=days_of_cover if math.isfinite(days_of_cover) else 9999.0,
        projected_stockout_date=projected_stockout_date,
        stockout_probability=risk,
        reorder_required=reorder_required,
        recommended_order_date=recommended_order_date,
        expected_stock_after_order=position + order_quantity,
        sigma_lead_time_demand=sigma_ltd,
        z_score=z,
        reasons=_reasons(
            reorder_required=reorder_required,
            position=position,
            free_stock=free_stock,
            incoming=incoming_quantity,
            rop=rop,
            buffer=buffer,
            z=z,
            service_level=service_level,
            sigma_ltd=sigma_ltd,
            average_daily_demand=average_daily_demand,
            demand_std=demand_std,
            lead_time_days=lead_time_days,
            lead_time_std_days=lead_time_std_days,
            days_of_cover=days_of_cover,
            risk=risk,
            order_quantity=order_quantity,
            quantity_basis=quantity_basis,
        ),
        assumptions=_assumptions(
            service_level=service_level,
            average_daily_demand=average_daily_demand,
            review_period_days=review_period_days,
            holding_derived=holding_cost_per_unit_per_year is None and unit_cost is not None,
            incoming_arrival_days=incoming_arrival_days,
            incoming=incoming_quantity,
        ),
    )


def _reasons(**kw) -> list[str]:
    reasons = [
        f"La position de stock est de {kw['position']:.0f} unités "
        f"({kw['free_stock']:.0f} disponibles en stock + {kw['incoming']:.0f} déjà en commande) "
        f"pour un point de commande de {kw['rop']:.0f}.",
        f"Stock de sécurité {kw['buffer']:.0f} = z({kw['service_level']:.0%}) × σ_LTD "
        f"= {kw['z']:.3f} × {kw['sigma_ltd']:.1f}.",
        f"σ_LTD combine la variabilité de la demande (σ_d = {kw['demand_std']:.1f}/jour sur "
        f"{kw['lead_time_days']:.1f} jours) et celle du délai d’approvisionnement "
        f"(σ_L = {kw['lead_time_std_days']:.1f} jours à {kw['average_daily_demand']:.1f} unités/jour).",
    ]

    demand_term = kw["lead_time_days"] * kw["demand_std"] ** 2
    lead_term = (kw["average_daily_demand"] ** 2) * (kw["lead_time_std_days"] ** 2)
    if lead_term > demand_term and lead_term > 0:
        share = lead_term / (demand_term + lead_term)
        reasons.append(
            f"La variabilité du délai d’approvisionnement explique {share:.0%} du stock tampon "
            "nécessaire — fiabiliser le fournisseur réduirait davantage le stock qu’améliorer la "
            "prévision de la demande."
        )
    elif demand_term > 0:
        share = demand_term / (demand_term + lead_term)
        reasons.append(
            f"La variabilité de la demande explique {share:.0%} du stock tampon nécessaire — une "
            "meilleure prévision est ici le levier le moins coûteux."
        )

    if math.isfinite(kw["days_of_cover"]):
        reasons.append(
            f"Le stock disponible couvre {kw['days_of_cover']:.1f} jour(s) au rythme actuel de la "
            "demande."
        )

    reasons.append(
        f"Probabilité de rupture avant l’arrivée du réapprovisionnement : {kw['risk']:.1%}."
    )

    if kw["reorder_required"]:
        reasons.append(
            f"Commander maintenant : {kw['order_quantity']:.0f} unités, quantité calculée à partir "
            f"{kw['quantity_basis']}."
        )
    else:
        reasons.append(
            "Pas de commande nécessaire pour l’instant — la position est encore au-dessus du point "
            "de commande."
        )

    return reasons


def _assumptions(**kw) -> list[str]:
    assumptions = [
        "La demande sur le délai d’approvisionnement est approchée par une loi normale.",
        "La demande et le délai d’approvisionnement sont supposés indépendants ; si les retards "
        "du fournisseur sont eux-mêmes causés par des pics de demande, les deux sont corrélés et "
        "ce stock tampon est sous-estimé.",
        f"L’objectif est un niveau de service par cycle de {kw['service_level']:.0%} — la "
        "probabilité de ne pas tomber en rupture pendant un cycle de réapprovisionnement, et non "
        "la part de la demande servie.",
    ]

    if kw["average_daily_demand"] < SLOW_MOVER_THRESHOLD:
        assumptions.append(
            f"La demande moyenne n’est que de {kw['average_daily_demand']:.2f} unités/jour. Pour "
            "un article à rotation aussi lente, l’approximation normale est fragile ; un modèle de "
            "Poisson ou empirique dimensionnerait mieux le stock tampon."
        )

    if kw["review_period_days"] > 0:
        assumptions.append(
            f"Révision périodique tous les {kw['review_period_days']:.0f} jour(s) : le stock "
            "tampon couvre donc aussi l’intervalle sans visibilité entre deux révisions."
        )
    else:
        assumptions.append("Révision continue : la position est contrôlée à chaque mouvement.")

    if kw["holding_derived"]:
        assumptions.append(
            "Le coût de possession n’a pas été fourni et a été pris à 25 %/an du coût unitaire — "
            "la règle empirique usuelle. Renseignez-le pour obtenir une véritable EOQ."
        )

    if kw["incoming"] > 0:
        arrival = kw["incoming_arrival_days"]
        assumptions.append(
            f"{kw['incoming']:.0f} unités entrantes sont comptées dans la position"
            + (
                f" et sont supposées arriver sous {arrival:.0f} jour(s)."
                if arrival is not None
                else ", sans date d’arrivée fournie — elles sont supposées arriver dans le délai "
                "d’approvisionnement."
            )
        )

    return assumptions
