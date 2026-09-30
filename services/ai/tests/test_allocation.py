"""Allocation tests, built around the worked example in the brief.

    Supplier A — price 10, lead time  5 days, reliability 92 %
    Supplier B — price  8, lead time 12 days, reliability 75 %
    Supplier C — price 11, lead time  3 days, reliability 97 %

    Demand: 20 000 units.
"""

from __future__ import annotations

import pytest

from app.engines.allocation import (
    AllocationResult,
    SupplierOption,
    allocate,
)


def _supplier(defaults: dict, overrides: dict) -> SupplierOption:
    """Merge so a test can override any default without a duplicate-keyword error."""
    return SupplierOption(**{**defaults, **overrides})


def supplier_a(**overrides) -> SupplierOption:
    return _supplier(
        dict(
            supplier_id="A",
            name="Supplier A",
            unit_price=10.0,
            lead_time_days=5,
            on_time_delivery_rate=0.92,
            capacity_units=20_000,
        ),
        overrides,
    )


def supplier_b(**overrides) -> SupplierOption:
    return _supplier(
        dict(
            supplier_id="B",
            name="Supplier B",
            unit_price=8.0,
            lead_time_days=12,
            on_time_delivery_rate=0.75,
            capacity_units=20_000,
        ),
        overrides,
    )


def supplier_c(**overrides) -> SupplierOption:
    return _supplier(
        dict(
            supplier_id="C",
            name="Supplier C",
            unit_price=11.0,
            lead_time_days=3,
            on_time_delivery_rate=0.97,
            capacity_units=20_000,
        ),
        overrides,
    )


def quantity_for(result: AllocationResult, supplier_id: str) -> float:
    for line in result.lines:
        if line.supplier_id == supplier_id:
            return line.quantity
    return 0.0


class TestFeasibility:
    def test_covers_the_whole_demand_when_capacity_allows(self):
        result = allocate(
            demand_quantity=20_000,
            suppliers=[supplier_a(), supplier_b(), supplier_c()],
        )

        assert result.status == "OPTIMAL"
        assert result.unmet_demand == pytest.approx(0.0, abs=1e-3)
        assert sum(line.quantity for line in result.lines) == pytest.approx(20_000, abs=1e-3)

    def test_reports_a_shortfall_rather_than_going_infeasible(self):
        # Combined capacity is 9 000 against demand of 20 000.
        result = allocate(
            demand_quantity=20_000,
            suppliers=[
                supplier_a(capacity_units=5_000),
                supplier_b(capacity_units=4_000),
            ],
        )

        assert result.status == "OPTIMAL"
        assert result.unmet_demand == pytest.approx(11_000, abs=1.0)
        assert any("n’ont pas pu être couvertes" in reason for reason in result.reasons)

    def test_every_result_carries_an_explanation(self):
        result = allocate(
            demand_quantity=20_000,
            suppliers=[supplier_a(), supplier_b(), supplier_c()],
        )
        assert result.reasons, "a recommendation without reasons is not acceptable"
        assert result.assumptions
        assert result.constraints


class TestEconomicBehaviour:
    def test_prefers_the_cheapest_supplier_when_nothing_else_differs(self):
        result = allocate(
            demand_quantity=10_000,
            suppliers=[
                supplier_a(unit_price=10.0),
                supplier_b(unit_price=8.0, lead_time_days=5, on_time_delivery_rate=0.92),
            ],
            risk_penalty_per_unit=0.0,
        )
        assert quantity_for(result, "B") == pytest.approx(10_000, abs=1.0)

    def test_a_high_risk_penalty_moves_volume_to_the_reliable_supplier(self):
        cheap_risk = allocate(
            demand_quantity=20_000,
            suppliers=[supplier_a(), supplier_b(), supplier_c()],
            risk_penalty_per_unit=0.0,
        )
        expensive_risk = allocate(
            demand_quantity=20_000,
            suppliers=[supplier_a(), supplier_b(), supplier_c()],
            risk_penalty_per_unit=50.0,
        )

        # With no risk pricing the cheapest (B, 75 % reliable) wins outright.
        assert quantity_for(cheap_risk, "B") > quantity_for(cheap_risk, "C")
        # Price the risk and the most reliable supplier takes over.
        assert quantity_for(expensive_risk, "C") > quantity_for(expensive_risk, "B")
        assert expensive_risk.stockout_risk < cheap_risk.stockout_risk

    def test_a_deadline_penalises_the_slow_supplier(self):
        no_deadline = allocate(
            demand_quantity=20_000,
            suppliers=[supplier_a(), supplier_b(), supplier_c()],
            risk_penalty_per_unit=0.0,
        )
        tight_deadline = allocate(
            demand_quantity=20_000,
            suppliers=[supplier_a(), supplier_b(), supplier_c()],
            required_within_days=4,
            delay_penalty_per_unit_per_day=5.0,
            risk_penalty_per_unit=0.0,
        )

        assert quantity_for(no_deadline, "B") > quantity_for(tight_deadline, "B")
        assert tight_deadline.expected_delivery_days < no_deadline.expected_delivery_days

    def test_holding_cost_makes_a_long_lead_time_more_expensive(self):
        free_capital = allocate(
            demand_quantity=10_000,
            suppliers=[supplier_b(), supplier_c()],
            holding_cost_per_unit_per_day=0.0,
            risk_penalty_per_unit=0.0,
        )
        costly_capital = allocate(
            demand_quantity=10_000,
            suppliers=[supplier_b(), supplier_c()],
            holding_cost_per_unit_per_day=1.0,
            risk_penalty_per_unit=0.0,
        )

        assert quantity_for(free_capital, "B") == pytest.approx(10_000, abs=1.0)
        # 9 extra days of lead time at 1.0/unit/day outweighs B's 3.00 price advantage.
        assert quantity_for(costly_capital, "C") == pytest.approx(10_000, abs=1.0)


class TestHardConstraints:
    def test_minimum_order_quantity_is_all_or_nothing(self):
        # B is cheapest but will not take an order below 15 000 units.
        result = allocate(
            demand_quantity=20_000,
            suppliers=[
                supplier_a(),
                supplier_b(minimum_order_quantity=15_000),
                supplier_c(),
            ],
            risk_penalty_per_unit=0.0,
        )

        b_quantity = quantity_for(result, "B")
        assert b_quantity == 0.0 or b_quantity >= 15_000 - 1e-3

    def test_capacity_is_never_exceeded(self):
        result = allocate(
            demand_quantity=20_000,
            suppliers=[
                supplier_a(capacity_units=6_000),
                supplier_b(capacity_units=7_000),
                supplier_c(capacity_units=9_000),
            ],
        )

        assert quantity_for(result, "A") <= 6_000 + 1e-3
        assert quantity_for(result, "B") <= 7_000 + 1e-3
        assert quantity_for(result, "C") <= 9_000 + 1e-3

    def test_budget_caps_purchase_spend(self):
        budget = 170_000.0
        result = allocate(
            demand_quantity=20_000,
            suppliers=[supplier_a(), supplier_b(), supplier_c()],
            budget=budget,
        )

        assert result.cost_breakdown["purchase"] <= budget + 1e-2

    def test_concentration_limit_forces_a_split(self):
        unconstrained = allocate(
            demand_quantity=20_000,
            suppliers=[supplier_a(), supplier_b(), supplier_c()],
            risk_penalty_per_unit=0.0,
        )
        capped = allocate(
            demand_quantity=20_000,
            suppliers=[supplier_a(), supplier_b(), supplier_c()],
            max_supplier_share_percent=0.4,
            risk_penalty_per_unit=0.0,
        )

        assert max(line.share_percent for line in capped.lines) <= 40.0 + 1e-6
        assert len(capped.lines) >= 3
        assert capped.concentration_index < unconstrained.concentration_index

    def test_an_impossible_budget_is_reported_not_crashed(self):
        result = allocate(
            demand_quantity=20_000,
            # Every supplier costs at least 8/unit, so 20 000 units cannot cost under 1 000.
            suppliers=[supplier_a(), supplier_b(), supplier_c()],
            budget=1_000.0,
        )

        # The model stays feasible by leaving demand unmet rather than by failing.
        assert result.status in {"OPTIMAL", "FEASIBLE", "INFEASIBLE"}
        if result.status != "INFEASIBLE":
            assert result.unmet_demand > 0
        assert result.reasons


class TestReportedMetrics:
    def test_cost_breakdown_sums_to_the_objective(self):
        result = allocate(
            demand_quantity=20_000,
            suppliers=[supplier_a(), supplier_b(), supplier_c()],
            required_within_days=6,
        )
        assert sum(result.cost_breakdown.values()) == pytest.approx(
            result.objective_value, rel=1e-6
        )

    def test_concentration_index_is_one_for_a_single_source(self):
        result = allocate(demand_quantity=5_000, suppliers=[supplier_c()])
        assert result.concentration_index == pytest.approx(1.0, abs=1e-6)

    def test_shares_sum_to_one_hundred_percent_when_demand_is_covered(self):
        result = allocate(
            demand_quantity=20_000,
            suppliers=[supplier_a(), supplier_b(), supplier_c()],
        )
        assert sum(line.share_percent for line in result.lines) == pytest.approx(100.0, abs=1e-3)

    def test_stockout_risk_reflects_supplier_reliability(self):
        reliable_only = allocate(demand_quantity=10_000, suppliers=[supplier_c()])
        unreliable_only = allocate(demand_quantity=10_000, suppliers=[supplier_b()])

        assert reliable_only.stockout_risk == pytest.approx(0.03, abs=1e-3)
        assert unreliable_only.stockout_risk == pytest.approx(0.25, abs=1e-3)


class TestInputValidation:
    def test_rejects_non_positive_demand(self):
        with pytest.raises(ValueError, match="demand_quantity"):
            allocate(demand_quantity=0, suppliers=[supplier_a()])

    def test_rejects_an_empty_supplier_list(self):
        with pytest.raises(ValueError, match="au moins une option fournisseur"):
            allocate(demand_quantity=100, suppliers=[])
