"""Multi-supplier order allocation, solved as a mixed-integer program.

This is the engine behind the brief's worked example: 20 000 units, three suppliers differing in
price, lead time and reliability — how much from each?

Formulated as a MILP rather than a scoring heuristic because the constraints are genuinely
combinatorial. A minimum order quantity is the clearest case: "order at least 5 000 units from
this supplier, **or** nothing at all" is a disjunction, and no amount of weighted scoring
expresses it. It needs a binary variable and a big-M linking constraint, which is exactly what a
MILP solver is for. OR-Tools' CBC backend handles this size in milliseconds.

Decision variables, per supplier *i*:

    xᵢ ∈ ℝ≥0    units ordered
    yᵢ ∈ {0,1}  whether supplier i is used at all
    u   ∈ ℝ≥0   unmet demand (a modelled shortfall, not an infeasibility)

Objective — minimise total landed cost, all terms in the same currency so they can be added:

    Σᵢ [ pᵢ·xᵢ                     purchase
       + t·dᵢ·xᵢ                   transport (rate × distance × units)
       + h·Lᵢ·xᵢ                   holding, the cost of capital tied up while in transit
       + δ·max(0, Lᵢ − D)·xᵢ       delay penalty for arriving after the deadline
       + ρ·(1 − rᵢ)·xᵢ ]           risk penalty, priced on the unreliable share
       + σ·u                       stockout penalty on whatever is left uncovered

Constraints:

    Σᵢ xᵢ + u = demand                     demand is met or explicitly short
    xᵢ ≤ capacityᵢ · yᵢ                    capacity, and links x to y
    xᵢ ≥ moqᵢ · yᵢ                         minimum order quantity when used
    Σᵢ pᵢ·xᵢ ≤ budget                      budget, when given
    xᵢ ≤ maxShare · demand                 concentration limit, when given

**Unmet demand is a variable, not a failure.** A model that goes infeasible when suppliers
cannot cover demand tells a buyer nothing. Pricing the shortfall at the stockout penalty makes
the solver reveal *how much* is uncoverable and what it costs — which is the actual decision.

**Why the risk term is linear in quantity.** ``ρ·(1 − rᵢ)·xᵢ`` prices each unit by the
probability its supplier fails to deliver it, so it is the expected shortfall cost of that unit.
This is a deliberate simplification: it treats supplier failures as independent per-unit events,
whereas a real supplier failure is usually all-or-nothing for the whole order. The linear form
keeps the problem an MILP instead of pushing it into stochastic programming, and it still pushes
the solution away from concentrating everything on one shaky supplier. The concentration limit
is the blunt instrument that covers the correlated case.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from ortools.linear_solver import pywraplp
from ..formatting import fr_num

#: Solver time limit. These problems are tiny; a limit this size only ever catches pathology.
SOLVER_TIME_LIMIT_MS = 10_000

#: Default penalties, in currency units. All overridable per request.
DEFAULT_STOCKOUT_PENALTY_PER_UNIT = 25.0
DEFAULT_DELAY_PENALTY_PER_UNIT_PER_DAY = 0.5
DEFAULT_RISK_PENALTY_PER_UNIT = 8.0
DEFAULT_TRANSPORT_COST_PER_UNIT_PER_KM = 0.002
DEFAULT_HOLDING_COST_PER_UNIT_PER_DAY = 0.05


@dataclass
class SupplierOption:
    supplier_id: str
    name: str
    unit_price: float
    lead_time_days: float
    on_time_delivery_rate: float
    capacity_units: float
    minimum_order_quantity: float = 0.0
    quality_acceptance_rate: float = 1.0
    distance_km: float | None = None

    @property
    def reliability(self) -> float:
        """Probability a unit ordered here arrives, on time and acceptable."""
        return max(0.0, min(1.0, self.on_time_delivery_rate * self.quality_acceptance_rate))


@dataclass
class AllocationLine:
    supplier_id: str
    name: str
    quantity: float
    unit_price: float
    purchase_cost: float
    transport_cost: float
    expected_lead_time_days: float
    reliability: float
    share_percent: float

    def to_dict(self) -> dict:
        return {
            "supplierId": self.supplier_id,
            "name": self.name,
            "quantity": round(self.quantity, 2),
            "unitPrice": round(self.unit_price, 4),
            "purchaseCost": round(self.purchase_cost, 2),
            "transportCost": round(self.transport_cost, 2),
            "expectedLeadTimeDays": round(self.expected_lead_time_days, 2),
            "reliability": round(self.reliability, 4),
            "sharePercent": round(self.share_percent, 2),
        }


@dataclass
class AllocationResult:
    status: str
    lines: list[AllocationLine]
    unmet_demand: float
    objective_value: float
    cost_breakdown: dict[str, float]
    expected_delivery_days: float
    stockout_risk: float
    concentration_index: float
    constraints: list[str]
    solver_wall_time_ms: int
    reasons: list[str] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "lines": [line.to_dict() for line in self.lines],
            "unmetDemand": round(self.unmet_demand, 2),
            "objectiveValue": round(self.objective_value, 2),
            "costBreakdown": {k: round(v, 2) for k, v in self.cost_breakdown.items()},
            "expectedDeliveryDays": round(self.expected_delivery_days, 2),
            "stockoutRisk": round(self.stockout_risk, 4),
            "concentrationIndex": round(self.concentration_index, 4),
            "constraints": self.constraints,
            "solverWallTimeMs": self.solver_wall_time_ms,
        }


def allocate(
    *,
    demand_quantity: float,
    suppliers: list[SupplierOption],
    budget: float | None = None,
    required_within_days: float | None = None,
    max_supplier_share_percent: float | None = None,
    stockout_penalty_per_unit: float = DEFAULT_STOCKOUT_PENALTY_PER_UNIT,
    delay_penalty_per_unit_per_day: float = DEFAULT_DELAY_PENALTY_PER_UNIT_PER_DAY,
    risk_penalty_per_unit: float = DEFAULT_RISK_PENALTY_PER_UNIT,
    transport_cost_per_unit_per_km: float = DEFAULT_TRANSPORT_COST_PER_UNIT_PER_KM,
    holding_cost_per_unit_per_day: float = DEFAULT_HOLDING_COST_PER_UNIT_PER_DAY,
) -> AllocationResult:
    """Solve the allocation and explain the answer."""
    if demand_quantity <= 0:
        raise ValueError("demand_quantity doit être strictement positif")
    if not suppliers:
        raise ValueError("au moins une option fournisseur est requise")

    started = time.perf_counter()

    # CBC: an open-source branch-and-cut MILP solver bundled with OR-Tools. No licence, no
    # network call, deterministic for a problem this size.
    solver = pywraplp.Solver.CreateSolver("CBC")
    if solver is None:
        raise RuntimeError("OR-Tools CBC backend is unavailable")
    solver.SetTimeLimit(SOLVER_TIME_LIMIT_MS)

    constraints_described: list[str] = []

    quantities = {}
    used = {}
    for supplier in suppliers:
        capacity = max(supplier.capacity_units, 0.0)
        quantities[supplier.supplier_id] = solver.NumVar(0.0, capacity, f"x_{supplier.supplier_id}")
        used[supplier.supplier_id] = solver.BoolVar(f"y_{supplier.supplier_id}")

    unmet = solver.NumVar(0.0, demand_quantity, "unmet")

    # --- demand ------------------------------------------------------------
    demand_constraint = solver.Constraint(demand_quantity, demand_quantity, "demand")
    for supplier in suppliers:
        demand_constraint.SetCoefficient(quantities[supplier.supplier_id], 1.0)
    demand_constraint.SetCoefficient(unmet, 1.0)
    constraints_described.append(
        f"Le total réparti + la demande non couverte doit être égal à la demande de "
        f"{fr_num(demand_quantity)} unités."
    )

    # --- capacity and MOQ linking -----------------------------------------
    for supplier in suppliers:
        x = quantities[supplier.supplier_id]
        y = used[supplier.supplier_id]
        capacity = max(supplier.capacity_units, 0.0)

        # x ≤ capacity · y   — forces y = 1 whenever anything is ordered.
        link = solver.Constraint(-solver.infinity(), 0.0, f"cap_{supplier.supplier_id}")
        link.SetCoefficient(x, 1.0)
        link.SetCoefficient(y, -capacity)

        if supplier.minimum_order_quantity > 0:
            # x ≥ moq · y    — either order at least the MOQ, or order nothing.
            moq = solver.Constraint(0.0, solver.infinity(), f"moq_{supplier.supplier_id}")
            moq.SetCoefficient(x, 1.0)
            moq.SetCoefficient(y, -supplier.minimum_order_quantity)
            constraints_described.append(
                f"{supplier.name} : commander 0 ou au moins "
                f"{fr_num(supplier.minimum_order_quantity)} unités (MOQ), et jamais plus de "
                f"{fr_num(capacity)} (capacité)."
            )
        else:
            constraints_described.append(
                f"{supplier.name} : capacité de {fr_num(capacity)} unités, pas de quantité minimale "
                "de commande."
            )

    # --- budget ------------------------------------------------------------
    if budget is not None and budget > 0:
        budget_constraint = solver.Constraint(0.0, budget, "budget")
        for supplier in suppliers:
            budget_constraint.SetCoefficient(quantities[supplier.supplier_id], supplier.unit_price)
        constraints_described.append(f"Les dépenses d’achat ne doivent pas dépasser {fr_num(budget, 2)}.")

    # --- concentration -----------------------------------------------------
    if max_supplier_share_percent is not None and 0 < max_supplier_share_percent < 1:
        cap = demand_quantity * max_supplier_share_percent
        for supplier in suppliers:
            share = solver.Constraint(0.0, cap, f"share_{supplier.supplier_id}")
            share.SetCoefficient(quantities[supplier.supplier_id], 1.0)
        constraints_described.append(
            f"Aucun fournisseur ne peut prendre plus de {max_supplier_share_percent:.0%} de la "
            "demande — un garde-fou contre la dépendance à une source unique."
        )

    # --- objective ---------------------------------------------------------
    objective = solver.Objective()
    for supplier in suppliers:
        distance = supplier.distance_km or 0.0
        lateness = (
            max(0.0, supplier.lead_time_days - required_within_days)
            if required_within_days is not None
            else 0.0
        )

        unit_cost = (
            supplier.unit_price
            + transport_cost_per_unit_per_km * distance
            + holding_cost_per_unit_per_day * supplier.lead_time_days
            + delay_penalty_per_unit_per_day * lateness
            + risk_penalty_per_unit * (1.0 - supplier.reliability)
        )
        objective.SetCoefficient(quantities[supplier.supplier_id], unit_cost)

    objective.SetCoefficient(unmet, stockout_penalty_per_unit)
    objective.SetMinimization()

    status_code = solver.Solve()
    wall_time_ms = int((time.perf_counter() - started) * 1000)

    status = {
        pywraplp.Solver.OPTIMAL: "OPTIMAL",
        pywraplp.Solver.FEASIBLE: "FEASIBLE",
        pywraplp.Solver.INFEASIBLE: "INFEASIBLE",
        pywraplp.Solver.UNBOUNDED: "ERROR",
        pywraplp.Solver.ABNORMAL: "ERROR",
        pywraplp.Solver.NOT_SOLVED: "ERROR",
    }.get(status_code, "ERROR")

    if status in {"INFEASIBLE", "ERROR"}:
        return AllocationResult(
            status=status,
            lines=[],
            unmet_demand=demand_quantity,
            objective_value=float("nan"),
            cost_breakdown={},
            expected_delivery_days=0.0,
            stockout_risk=1.0,
            concentration_index=0.0,
            constraints=constraints_described,
            solver_wall_time_ms=wall_time_ms,
            reasons=[
                "Aucune répartition ne satisfait toutes les contraintes à la fois. La cause "
                "habituelle est un budget ou une limite de concentration impossible à respecter "
                "compte tenu des quantités minimales de commande des fournisseurs — assouplissez-en "
                "une et relancez le calcul.",
            ],
            assumptions=_assumptions(required_within_days, max_supplier_share_percent),
        )

    # --- unpack ------------------------------------------------------------
    lines: list[AllocationLine] = []
    breakdown = {
        "purchase": 0.0,
        "transport": 0.0,
        "holding": 0.0,
        "stockoutPenalty": 0.0,
        "delayPenalty": 0.0,
        "riskPenalty": 0.0,
    }

    allocated_total = 0.0
    weighted_lead_time = 0.0
    expected_delivered = 0.0

    for supplier in suppliers:
        quantity = float(quantities[supplier.supplier_id].solution_value())
        # CBC returns values like 7999.999999997; anything under a unit is solver noise.
        if quantity < 1e-6:
            continue
        quantity = round(quantity, 6)

        distance = supplier.distance_km or 0.0
        lateness = (
            max(0.0, supplier.lead_time_days - required_within_days)
            if required_within_days is not None
            else 0.0
        )

        purchase = supplier.unit_price * quantity
        transport = transport_cost_per_unit_per_km * distance * quantity
        holding = holding_cost_per_unit_per_day * supplier.lead_time_days * quantity
        delay = delay_penalty_per_unit_per_day * lateness * quantity
        risk = risk_penalty_per_unit * (1.0 - supplier.reliability) * quantity

        breakdown["purchase"] += purchase
        breakdown["transport"] += transport
        breakdown["holding"] += holding
        breakdown["delayPenalty"] += delay
        breakdown["riskPenalty"] += risk

        allocated_total += quantity
        weighted_lead_time += supplier.lead_time_days * quantity
        expected_delivered += supplier.reliability * quantity

        lines.append(
            AllocationLine(
                supplier_id=supplier.supplier_id,
                name=supplier.name,
                quantity=quantity,
                unit_price=supplier.unit_price,
                purchase_cost=purchase,
                transport_cost=transport,
                expected_lead_time_days=supplier.lead_time_days,
                reliability=supplier.reliability,
                share_percent=0.0,  # filled once the total is known
            )
        )

    unmet_quantity = float(unmet.solution_value())
    if unmet_quantity < 1e-6:
        unmet_quantity = 0.0
    breakdown["stockoutPenalty"] = stockout_penalty_per_unit * unmet_quantity

    for line in lines:
        line.share_percent = (line.quantity / demand_quantity) * 100 if demand_quantity else 0.0

    lines.sort(key=lambda line: line.quantity, reverse=True)

    # Herfindahl index of the split: 1 = single source, 1/n = perfectly even across n suppliers.
    concentration = (
        sum((line.quantity / allocated_total) ** 2 for line in lines) if allocated_total else 0.0
    )

    expected_lead_time = weighted_lead_time / allocated_total if allocated_total else 0.0

    # Expected shortfall as a share of demand: what the plan does not reliably cover.
    expected_short = demand_quantity - expected_delivered
    stockout_risk = max(0.0, min(1.0, expected_short / demand_quantity)) if demand_quantity else 0.0

    return AllocationResult(
        status=status,
        lines=lines,
        unmet_demand=unmet_quantity,
        objective_value=float(solver.Objective().Value()),
        cost_breakdown=breakdown,
        expected_delivery_days=expected_lead_time,
        stockout_risk=stockout_risk,
        concentration_index=concentration,
        constraints=constraints_described,
        solver_wall_time_ms=wall_time_ms,
        reasons=_reasons(
            lines=lines,
            suppliers=suppliers,
            demand=demand_quantity,
            unmet=unmet_quantity,
            breakdown=breakdown,
            expected_lead_time=expected_lead_time,
            stockout_risk=stockout_risk,
            concentration=concentration,
            required_within_days=required_within_days,
        ),
        assumptions=_assumptions(required_within_days, max_supplier_share_percent),
    )


def _reasons(**kw) -> list[str]:
    lines: list[AllocationLine] = kw["lines"]
    suppliers: list[SupplierOption] = kw["suppliers"]
    by_id = {s.supplier_id: s for s in suppliers}

    reasons: list[str] = []

    if not lines:
        reasons.append(
            "L’optimiseur n’a rien réparti — chaque fournisseur a été écarté du plan par son coût."
        )
        return reasons

    cheapest = min(suppliers, key=lambda s: s.unit_price)
    fastest = min(suppliers, key=lambda s: s.lead_time_days)
    most_reliable = max(suppliers, key=lambda s: s.reliability)

    for line in lines:
        supplier = by_id[line.supplier_id]
        notes = []
        if supplier.supplier_id == cheapest.supplier_id:
            notes.append("prix unitaire le plus bas")
        if supplier.supplier_id == fastest.supplier_id:
            notes.append("délai le plus court")
        if supplier.supplier_id == most_reliable.supplier_id:
            notes.append(f"meilleure fiabilité ({supplier.reliability:.0%})")
        if supplier.minimum_order_quantity > 0 and abs(
            line.quantity - supplier.minimum_order_quantity
        ) < 1:
            notes.append("exactement à sa quantité minimale de commande")
        if abs(line.quantity - supplier.capacity_units) < 1:
            notes.append("limité par sa capacité")

        reasons.append(
            f"{line.name} : {fr_num(line.quantity)} unités ({line.share_percent:.1f}%) à "
            f"{fr_num(line.unit_price, 2)}/unité, délai d’approvisionnement de "
            f"{supplier.lead_time_days:.0f} jours"
            + (f" — {', '.join(notes)}." if notes else ".")
        )

    total_cost = sum(kw["breakdown"].values())
    reasons.append(
        f"Coût total modélisé {fr_num(total_cost, 2)} : "
        f"{fr_num(kw['breakdown']['purchase'], 2)} d’achat, "
        f"{fr_num(kw['breakdown']['transport'], 2)} de transport, "
        f"{fr_num(kw['breakdown']['holding'], 2)} de possession, "
        f"{fr_num(kw['breakdown']['delayPenalty'], 2)} de pénalité de retard, "
        f"{fr_num(kw['breakdown']['riskPenalty'], 2)} de pénalité de risque, "
        f"{fr_num(kw['breakdown']['stockoutPenalty'], 2)} de pénalité de rupture."
    )

    reasons.append(
        f"Délai d’approvisionnement pondéré par les quantités : {kw['expected_lead_time']:.1f} "
        f"jours ; manque attendu de {kw['stockout_risk']:.1%} de la demande compte tenu de la "
        "fiabilité des fournisseurs."
    )

    if kw["unmet"] > 0:
        reasons.append(
            f"{fr_num(kw['unmet'])} unités n’ont pas pu être couvertes du tout — la capacité cumulée "
            "des fournisseurs est inférieure au besoin. Ajoutez un fournisseur ou réduisez la "
            "commande."
        )

    if kw["concentration"] > 0.6:
        reasons.append(
            f"Indice de concentration {kw['concentration']:.2f} : le plan repose fortement sur un "
            "seul fournisseur. Fixez une part maximale par fournisseur (maxSupplierSharePercent) "
            "pour imposer une répartition si cette dépendance vous préoccupe."
        )
    elif len(lines) > 1:
        reasons.append(
            f"Indice de concentration {kw['concentration']:.2f} sur {len(lines)} fournisseurs — "
            "la répartition diversifie le risque d’approvisionnement."
        )

    if kw["required_within_days"] is not None:
        late = [
            line
            for line in lines
            if by_id[line.supplier_id].lead_time_days > kw["required_within_days"]
        ]
        if late:
            reasons.append(
                "Accepter une part en retard restait moins coûteux que les alternatives : "
                + ", ".join(
                    f"{line.name} arrive "
                    f"{by_id[line.supplier_id].lead_time_days - kw['required_within_days']:.0f} "
                    "jour(s) après l’échéance"
                    for line in late
                )
                + "."
            )

    return reasons


def _assumptions(
    required_within_days: float | None, max_supplier_share_percent: float | None
) -> list[str]:
    assumptions = [
        "Tous les termes de coût sont exprimés dans une seule devise et s’additionnent "
        "directement.",
        "La fiabilité est le taux de ponctualité × le taux d’acceptation qualité, traitée comme la "
        "probabilité qu’une unité donnée arrive utilisable et à l’heure.",
        "La pénalité de risque valorise chaque unité selon la probabilité de défaillance de son "
        "fournisseur, ce qui suppose des défaillances indépendantes d’une unité à l’autre. Une "
        "vraie défaillance fournisseur touche en général toute la commande d’un coup ; le risque "
        "corrélé est donc traité par la limite de concentration.",
        "Le coût de transport est linéaire en distance × unités ; il ignore le taux de remplissage "
        "des véhicules et la consolidation.",
        "Le coût de possession court par unité et par jour de délai d’approvisionnement — le "
        "capital immobilisé pendant le transport.",
        "La demande non couverte est valorisée plutôt qu’interdite : un marché sous-approvisionné "
        "donne un plan avec un manque visible au lieu d’un « infaisable » sans intérêt.",
    ]
    if required_within_days is None:
        assumptions.append(
            "Aucune échéance de livraison n’a été fournie, donc aucune pénalité de retard n’a été "
            "appliquée."
        )
    else:
        assumptions.append(
            f"L’échéance de livraison est de {required_within_days:.0f} jours ; tout retard "
            "au-delà est pénalisé par unité et par jour."
        )
    if max_supplier_share_percent is None:
        assumptions.append(
            "Aucune limite de concentration n’a été fixée : l’optimiseur peut tout confier à un "
            "seul fournisseur si c’est le moins cher."
        )
    return assumptions
