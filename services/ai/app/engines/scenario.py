"""Scenario simulation and what-if analysis.

Monte Carlo over a periodic-review inventory system. A closed-form answer exists for the simple
case, but the questions the brief asks — "what if demand rises 20 % *and* the supplier slips 5
days *and* fuel costs 30 % more?" — interact non-linearly through the stockout logic, and
simulation handles that honestly where a formula would need assumptions that no longer hold.

Each iteration replays ``horizon_days`` of operation:

1. draw the day's demand from ``N(μ, σ)``, truncated at zero (negative demand is not a thing);
2. serve what stock allows, record any shortfall;
3. receive whatever arrives today;
4. if the inventory position has fallen below the reorder point and nothing is in flight,
   place an order whose lead time is drawn from ``N(L, σ_L)``, truncated at ⅓ of the mean;
5. accrue holding cost on the closing balance.

Aggregating across iterations gives a *distribution*, not a point estimate, which is the entire
reason for simulating. The response reports the mean plus the 5th and 95th percentiles.

The three cases follow the brief:

``BASE_CASE``   the levers exactly as supplied.
``BEST_CASE``   favourable end of each lever (demand a little lower, lead times a little shorter).
``WORST_CASE``  the unfavourable end.

"Favourable" and "unfavourable" are defined as ±50 % of each supplied lever's own magnitude, so
the spread scales with how uncertain the user says they are, rather than with an invented number.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from ..formatting import fr_num

DEFAULT_ITERATIONS = 2_000
MAX_ITERATIONS = 50_000

#: How far best/worst cases stretch each supplied lever.
CASE_STRETCH = 0.5

#: Lead time is never allowed below this fraction of its mean — a supplier does not deliver
#: instantly no matter how well the dice fall.
MIN_LEAD_TIME_FRACTION = 1.0 / 3.0


@dataclass
class Levers:
    demand_change_percent: float = 0.0
    fuel_price_change_percent: float = 0.0
    supplier_delay_days: float = 0.0
    transport_cost_change_percent: float = 0.0
    stock_level_change_percent: float = 0.0
    lead_time_change_percent: float = 0.0
    unit_price_change_percent: float = 0.0

    def scaled(self, factor: float) -> "Levers":
        return Levers(
            demand_change_percent=self.demand_change_percent * factor,
            fuel_price_change_percent=self.fuel_price_change_percent * factor,
            supplier_delay_days=self.supplier_delay_days * factor,
            transport_cost_change_percent=self.transport_cost_change_percent * factor,
            stock_level_change_percent=self.stock_level_change_percent * factor,
            lead_time_change_percent=self.lead_time_change_percent * factor,
            unit_price_change_percent=self.unit_price_change_percent * factor,
        )

    def to_dict(self) -> dict:
        return {
            "demandChangePercent": round(self.demand_change_percent, 4),
            "fuelPriceChangePercent": round(self.fuel_price_change_percent, 4),
            "supplierDelayDays": round(self.supplier_delay_days, 4),
            "transportCostChangePercent": round(self.transport_cost_change_percent, 4),
            "stockLevelChangePercent": round(self.stock_level_change_percent, 4),
            "leadTimeChangePercent": round(self.lead_time_change_percent, 4),
            "unitPriceChangePercent": round(self.unit_price_change_percent, 4),
        }


@dataclass
class Baseline:
    average_daily_demand: float
    demand_std_dev: float
    current_stock: float
    unit_cost: float
    lead_time_days: float
    lead_time_std_dev_days: float
    holding_cost_per_unit_per_day: float
    stockout_penalty_per_unit: float
    transport_cost_per_order: float
    ordering_cost: float
    service_level: float = 0.95


@dataclass
class CaseResult:
    name: str
    levers: Levers
    total_cost: float
    total_cost_p05: float
    total_cost_p95: float
    stockout_risk: float
    average_inventory_units: float
    service_level: float
    expected_delay_days: float
    fill_rate: float
    orders_placed: float

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "levers": self.levers.to_dict(),
            "totalCost": round(self.total_cost, 2),
            "totalCostP05": round(self.total_cost_p05, 2),
            "totalCostP95": round(self.total_cost_p95, 2),
            "stockoutRisk": round(self.stockout_risk, 4),
            "averageInventoryUnits": round(self.average_inventory_units, 2),
            "serviceLevel": round(self.service_level, 4),
            "expectedDelayDays": round(self.expected_delay_days, 2),
            "fillRate": round(self.fill_rate, 4),
            "ordersPlaced": round(self.orders_placed, 2),
        }


@dataclass
class ScenarioResult:
    cases: list[CaseResult]
    iterations: int
    reasons: list[str] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)


def _apply(baseline: Baseline, levers: Levers) -> Baseline:
    """Project the baseline through a set of levers."""
    return Baseline(
        average_daily_demand=max(
            baseline.average_daily_demand * (1 + levers.demand_change_percent), 0.0
        ),
        # Demand variability scales with the level: a market 20 % bigger is 20 % noisier in
        # absolute units, not the same absolute noise on a bigger base.
        demand_std_dev=max(baseline.demand_std_dev * (1 + levers.demand_change_percent), 0.0),
        current_stock=max(baseline.current_stock * (1 + levers.stock_level_change_percent), 0.0),
        unit_cost=max(baseline.unit_cost * (1 + levers.unit_price_change_percent), 0.0),
        lead_time_days=max(
            baseline.lead_time_days * (1 + levers.lead_time_change_percent)
            + levers.supplier_delay_days,
            0.1,
        ),
        lead_time_std_dev_days=max(baseline.lead_time_std_dev_days, 0.0),
        holding_cost_per_unit_per_day=max(baseline.holding_cost_per_unit_per_day, 0.0),
        stockout_penalty_per_unit=max(baseline.stockout_penalty_per_unit, 0.0),
        transport_cost_per_order=max(
            baseline.transport_cost_per_order
            * (1 + levers.transport_cost_change_percent)
            # Fuel is a component of transport cost; assume it is roughly 40 % of it.
            * (1 + 0.4 * levers.fuel_price_change_percent),
            0.0,
        ),
        ordering_cost=max(baseline.ordering_cost, 0.0),
        service_level=baseline.service_level,
    )


@dataclass
class Policy:
    """The reorder policy in force. Held fixed across cases — see ``derive_policy``."""

    reorder_point: float
    order_quantity: float
    safety_stock: float


def derive_policy(baseline: Baseline) -> Policy:
    """Size the policy once, from the planner's own baseline.

    This is the subtle part of a what-if. If each case re-optimised its own policy, the worst
    case would silently get a *better-tuned* policy than the base case — bigger buffer, higher
    reorder point — and could come out with a *lower* stockout risk than the base. That is the
    opposite of the question being asked.

    A what-if asks: "given the policy I run today, what happens if conditions get worse?" So the
    policy is derived once from the baseline and then held fixed while only conditions vary. If
    the user wants to know what the *re-optimised* policy would be under stress, that is a
    different question and /inventory/optimize answers it directly.
    """
    from .inventory import reorder_point, safety_stock

    buffer = safety_stock(
        baseline.average_daily_demand,
        baseline.demand_std_dev,
        baseline.lead_time_days,
        baseline.lead_time_std_dev_days,
        baseline.service_level,
    )
    return Policy(
        reorder_point=reorder_point(
            baseline.average_daily_demand, baseline.lead_time_days, buffer
        ),
        # One lead time of cover plus the buffer — a standard (s, S) style policy.
        order_quantity=max(
            baseline.average_daily_demand * baseline.lead_time_days + buffer, 1.0
        ),
        safety_stock=buffer,
    )


def simulate_case(
    name: str,
    baseline: Baseline,
    levers: Levers,
    horizon_days: int,
    iterations: int,
    rng: np.random.Generator,
    policy: Policy,
) -> CaseResult:
    """Monte Carlo the inventory system under one set of levers, at a fixed policy."""
    scenario = _apply(baseline, levers)

    rop = policy.reorder_point
    order_quantity = policy.order_quantity

    total_costs = np.zeros(iterations)
    stockout_flags = np.zeros(iterations)
    fill_rates = np.zeros(iterations)
    average_inventory = np.zeros(iterations)
    delays = np.zeros(iterations)
    orders = np.zeros(iterations)

    # Demand is drawn for every (iteration, day) at once — vectorising this is the difference
    # between a 200 ms request and a 20 s one.
    demand_draws = rng.normal(
        scenario.average_daily_demand, scenario.demand_std_dev, size=(iterations, horizon_days)
    ).clip(min=0.0)

    for i in range(iterations):
        stock = scenario.current_stock
        in_transit = 0.0
        arrival_day = -1
        cost = 0.0
        shortfall = 0.0
        demanded = 0.0
        inventory_sum = 0.0
        order_count = 0
        delay_sum = 0.0

        for day in range(horizon_days):
            if arrival_day == day:
                stock += in_transit
                in_transit = 0.0
                arrival_day = -1

            demand = demand_draws[i, day]
            demanded += demand

            served = min(stock, demand)
            stock -= served
            missed = demand - served
            if missed > 0:
                shortfall += missed
                cost += missed * scenario.stockout_penalty_per_unit

            position = stock + in_transit
            if position < rop and in_transit == 0.0:
                lead_time = max(
                    rng.normal(scenario.lead_time_days, scenario.lead_time_std_dev_days),
                    scenario.lead_time_days * MIN_LEAD_TIME_FRACTION,
                )
                arrival_day = day + int(round(lead_time))
                in_transit = order_quantity
                order_count += 1
                cost += (
                    order_quantity * scenario.unit_cost
                    + scenario.ordering_cost
                    + scenario.transport_cost_per_order
                )
                delay_sum += max(lead_time - scenario.lead_time_days, 0.0)

            cost += stock * scenario.holding_cost_per_unit_per_day
            inventory_sum += stock

        total_costs[i] = cost
        stockout_flags[i] = 1.0 if shortfall > 0 else 0.0
        fill_rates[i] = 1.0 if demanded == 0 else max(0.0, 1.0 - shortfall / demanded)
        average_inventory[i] = inventory_sum / horizon_days
        orders[i] = order_count
        delays[i] = delay_sum / order_count if order_count else 0.0

    return CaseResult(
        name=name,
        levers=levers,
        total_cost=float(total_costs.mean()),
        total_cost_p05=float(np.percentile(total_costs, 5)),
        total_cost_p95=float(np.percentile(total_costs, 95)),
        # Probability that *any* stockout occurs during the horizon — the number a planner fears.
        stockout_risk=float(stockout_flags.mean()),
        average_inventory_units=float(average_inventory.mean()),
        # Achieved service level: the share of simulated horizons with no stockout at all.
        service_level=float(1.0 - stockout_flags.mean()),
        expected_delay_days=float(delays.mean()),
        # Fill rate: the share of demand actually served, averaged over runs.
        fill_rate=float(fill_rates.mean()),
        orders_placed=float(orders.mean()),
    )


def simulate(
    *,
    baseline: Baseline,
    levers: Levers | None = None,
    horizon_days: int = 90,
    iterations: int = DEFAULT_ITERATIONS,
    random_seed: int | None = 42,
) -> ScenarioResult:
    if horizon_days <= 0:
        raise ValueError("horizon_days doit être strictement positif")
    if baseline.average_daily_demand < 0:
        raise ValueError("average_daily_demand ne peut pas être négative")

    iterations = max(100, min(iterations, MAX_ITERATIONS))
    applied = levers or Levers()

    # Seeded by default so the same what-if question gives the same answer twice. A simulator
    # whose output moves when nothing changed is one nobody trusts.
    rng = np.random.default_rng(random_seed)

    # Sized once, from the baseline, and held fixed across all three cases.
    policy = derive_policy(baseline)

    cases = [
        simulate_case("BASE_CASE", baseline, applied, horizon_days, iterations, rng, policy),
        simulate_case(
            "BEST_CASE",
            baseline,
            applied.scaled(-CASE_STRETCH),
            horizon_days,
            iterations,
            rng,
            policy,
        ),
        simulate_case(
            "WORST_CASE",
            baseline,
            applied.scaled(1 + CASE_STRETCH),
            horizon_days,
            iterations,
            rng,
            policy,
        ),
    ]

    return ScenarioResult(
        cases=cases,
        iterations=iterations,
        reasons=_reasons(cases, applied, horizon_days),
        assumptions=[
            "La demande journalière est tirée d’une loi normale tronquée à zéro ; pour un produit "
            "à faible rotation, un tirage de Poisson serait plus fidèle.",
            "La variabilité de la demande suit son niveau : un marché plus grand est plus bruité "
            "en unités absolues, et non proportionnellement plus calme.",
            "Le délai d’approvisionnement est tiré pour chaque commande et ne descend jamais sous "
            "le tiers de sa moyenne.",
            "Une seule commande peut être en cours à la fois — politique (s, S) avec une seule "
            "commande en attente.",
            "La politique de réapprovisionnement est dimensionnée une fois à partir de la base, "
            "puis figée pour les trois cas. La réoptimiser pour chaque cas laisserait le pire cas "
            "adopter discrètement une politique mieux réglée que la base, soit l’inverse de la "
            "question posée par une simulation « et si ».",
            "Le meilleur et le pire cas étirent chaque levier fourni de "
            f"±{CASE_STRETCH:.0%} de sa propre amplitude, de sorte que l’écart reflète "
            "l’incertitude réelle des données d’entrée plutôt qu’une fourchette inventée. Un "
            "levier laissé à zéro ne produit aucun écart.",
            "Le prix du carburant est considéré comme environ 40 % du coût de transport.",
            f"{iterations:,} itérations, avec une graine fixe — la même question renvoie la même "
            "réponse.",
            "Les coûts couvrent l’achat, la passation de commande, le transport, le stockage et la "
            "pénalité de rupture. Ils excluent les frais fixes et sont donc comparables d’un cas à "
            "l’autre, pas absolus.",
        ],
    )


def _reasons(cases: list[CaseResult], levers: Levers, horizon_days: int) -> list[str]:
    base = next(c for c in cases if c.name == "BASE_CASE")
    best = next(c for c in cases if c.name == "BEST_CASE")
    worst = next(c for c in cases if c.name == "WORST_CASE")

    # Lever names as the web UI labels them.
    active = {
        "demande": levers.demand_change_percent,
        "prix du carburant": levers.fuel_price_change_percent,
        "coût de transport": levers.transport_cost_change_percent,
        "stock initial": levers.stock_level_change_percent,
        "délai d’approvisionnement": levers.lead_time_change_percent,
        "prix unitaire": levers.unit_price_change_percent,
    }
    described = [f"{name} {value:+.0%}" for name, value in active.items() if value]
    if levers.supplier_delay_days:
        described.append(f"retard fournisseur {levers.supplier_delay_days:+.0f} jours")

    reasons = [
        f"Simulation sur {horizon_days} jours"
        + (f" avec {', '.join(described)}." if described else " sans aucun levier appliqué."),
        f"Cas de base : coût {fr_num(base.total_cost)} (90 % des tirages entre "
        f"{fr_num(base.total_cost_p05)} et {fr_num(base.total_cost_p95)}), risque de rupture "
        f"{base.stockout_risk:.1%}, taux de service {base.fill_rate:.1%}.",
        f"Pire cas : coût {fr_num(worst.total_cost)} ({_delta(base.total_cost, worst.total_cost)}), "
        f"risque de rupture {worst.stockout_risk:.1%}.",
        f"Meilleur cas : coût {fr_num(best.total_cost)} "
        f"({_delta(base.total_cost, best.total_cost)}), "
        f"risque de rupture {best.stockout_risk:.1%}.",
    ]

    if worst.stockout_risk > 0.25 and base.stockout_risk <= 0.25:
        reasons.append(
            "C’est dans le scénario défavorable que tout casse : le risque de rupture dépasse "
            "25 % dans le pire cas alors que le cas de base paraît sûr. Dimensionnez le stock "
            "tampon pour le pire cas, pas pour la moyenne."
        )

    if base.orders_placed > 0:
        reasons.append(
            f"Le cas de base passe {base.orders_placed:.1f} commande(s) sur l’horizon et détient "
            f"en moyenne {fr_num(base.average_inventory_units)} unités."
        )

    return reasons


def _delta(base: float, other: float) -> str:
    if base == 0:
        return "aucune base de comparaison"
    change = (other - base) / base
    return f"{change:+.1%} par rapport à la base"
