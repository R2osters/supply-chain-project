"""Vehicle routing (VRP) with capacity and time windows, solved with OR-Tools.

Answers the brief's question directly: "what is the best route to deliver these 20 customers with
5 vehicles?" — with capacity limits, delivery windows, service times and a maximum driving time.

This is a CVRPTW. It is NP-hard, so the solver does not prove optimality; it builds a good
solution fast (cheapest-insertion style) and then improves it with guided local search until the
time limit. The status therefore reports ``FEASIBLE`` rather than ``OPTIMAL`` for anything
non-trivial, which is honest: the answer is good, not provably best.

Distances are great-circle × a road-winding factor. A real road matrix from OSRM would be better
and the code is structured so the matrix can be swapped, but a routing engine that silently
pretends straight-line distance *is* road distance would produce plans that fall apart on
contact with reality — hence the factor, and hence it appears in every response's assumptions.

Units: OR-Tools' routing library works in integers. Distances are carried in **metres** and times
in **seconds**, both rounded to integers at the matrix boundary. Rounding a 200 km leg to the
metre loses nothing; carrying floats would silently break the solver.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Sequence

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

EARTH_RADIUS_M = 6_371_008.8

DEFAULT_ROAD_WINDING_FACTOR = 1.25
DEFAULT_AVERAGE_SPEED_KMH = 55.0
DEFAULT_SERVICE_MINUTES = 15.0
DEFAULT_TIME_LIMIT_SECONDS = 10

#: Cost charged for leaving a stop unserved, in the solver's internal cost units (metres).
#: Set high enough that dropping a stop is always worse than a long detour, but finite so an
#: over-subscribed fleet produces a partial plan instead of "no solution".
DROP_PENALTY_M = 2_000_000


@dataclass
class RouteStop:
    id: str
    name: str
    latitude: float
    longitude: float
    demand_units: float
    service_minutes: float = DEFAULT_SERVICE_MINUTES
    window_start_minutes: int | None = None
    window_end_minutes: int | None = None


@dataclass
class RouteVehicle:
    id: str
    name: str
    capacity_units: float
    cost_per_km: float = 1.0
    fuel_consumption_l_per_100km: float = 28.0
    max_driving_minutes: int | None = None
    average_speed_kmh: float = DEFAULT_AVERAGE_SPEED_KMH


@dataclass
class RoutePlan:
    vehicle_id: str
    vehicle_name: str
    sequence: list[dict]
    distance_km: float
    duration_minutes: float
    load_units: float
    fuel_liters: float
    cost: float

    def to_dict(self) -> dict:
        return {
            "vehicleId": self.vehicle_id,
            "vehicleName": self.vehicle_name,
            "sequence": self.sequence,
            "distanceKm": round(self.distance_km, 3),
            "durationMinutes": round(self.duration_minutes, 1),
            "loadUnits": round(self.load_units, 3),
            "fuelLiters": round(self.fuel_liters, 2),
            "cost": round(self.cost, 2),
        }


@dataclass
class RoutingResult:
    status: str
    routes: list[RoutePlan]
    unassigned_stops: list[str]
    total_distance_km: float
    total_duration_minutes: float
    total_cost: float
    objective_value: float
    constraints: list[str]
    solver_wall_time_ms: int
    reasons: list[str] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "routes": [route.to_dict() for route in self.routes],
            "unassignedStops": self.unassigned_stops,
            "totalDistanceKm": round(self.total_distance_km, 3),
            "totalDurationMinutes": round(self.total_duration_minutes, 1),
            "totalCost": round(self.total_cost, 2),
            "objectiveValue": round(self.objective_value, 2),
            "constraints": self.constraints,
            "solverWallTimeMs": self.solver_wall_time_ms,
        }


def _haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def build_distance_matrix(
    points: Sequence[tuple[float, float]], road_winding_factor: float
) -> list[list[int]]:
    """Symmetric road-distance estimate in whole metres."""
    size = len(points)
    matrix = [[0] * size for _ in range(size)]
    for i in range(size):
        for j in range(i + 1, size):
            metres = int(round(_haversine_m(points[i], points[j]) * road_winding_factor))
            matrix[i][j] = metres
            matrix[j][i] = metres
    return matrix


def optimize_routes(
    *,
    depot: tuple[float, float],
    depot_name: str = "Dépôt",
    stops: Sequence[RouteStop],
    vehicles: Sequence[RouteVehicle],
    fuel_price_per_liter: float = 1.35,
    road_winding_factor: float = DEFAULT_ROAD_WINDING_FACTOR,
    solver_time_limit_seconds: int = DEFAULT_TIME_LIMIT_SECONDS,
) -> RoutingResult:
    if not stops:
        raise ValueError("au moins un arrêt est requis")
    if not vehicles:
        raise ValueError("au moins un véhicule est requis")

    started = time.perf_counter()

    # Node 0 is the depot; stops occupy 1..n.
    points = [depot] + [(s.latitude, s.longitude) for s in stops]
    distance_matrix = build_distance_matrix(points, road_winding_factor)

    vehicle_count = len(vehicles)
    manager = pywrapcp.RoutingIndexManager(len(points), vehicle_count, 0)
    routing = pywrapcp.RoutingModel(manager)

    constraints_described: list[str] = []

    # --- arc cost: distance, scaled per vehicle by its cost per km ---------
    def make_arc_cost(vehicle_index: int):
        rate = max(vehicles[vehicle_index].cost_per_km, 0.0)

        def arc_cost(from_index: int, to_index: int) -> int:
            from_node = manager.IndexToNode(from_index)
            to_node = manager.IndexToNode(to_index)
            # Cost is scaled by 1000 so a fractional cost-per-km survives integer truncation.
            return int(distance_matrix[from_node][to_node] * rate)

        return arc_cost

    for index, _vehicle in enumerate(vehicles):
        callback_index = routing.RegisterTransitCallback(make_arc_cost(index))
        routing.SetArcCostEvaluatorOfVehicle(callback_index, index)

    # --- capacity ----------------------------------------------------------
    # Demand is scaled to integers; 1 unit of the model = 0.001 of a stock unit, so fractional
    # demand (kilograms, litres) is preserved.
    SCALE = 1000
    demands = [0] + [int(round(stop.demand_units * SCALE)) for stop in stops]
    capacities = [int(round(vehicle.capacity_units * SCALE)) for vehicle in vehicles]

    def demand_callback(from_index: int) -> int:
        return demands[manager.IndexToNode(from_index)]

    demand_index = routing.RegisterUnaryTransitCallback(demand_callback)
    routing.AddDimensionWithVehicleCapacity(
        demand_index, 0, capacities, True, "Capacity"
    )
    constraints_described.append(
        "La charge de chaque véhicule ne doit pas dépasser sa capacité : "
        + ", ".join(f"{v.name} {v.capacity_units:,.0f}" for v in vehicles)
        + "."
    )

    # --- time: travel + service, with windows ------------------------------
    has_windows = any(
        s.window_start_minutes is not None or s.window_end_minutes is not None for s in stops
    )
    max_driving = [
        v.max_driving_minutes if v.max_driving_minutes is not None else 24 * 60
        for v in vehicles
    ]

    # One time callback per vehicle, because travel time depends on the vehicle's speed.
    def make_time_callback(vehicle_index: int):
        speed_kmh = max(vehicles[vehicle_index].average_speed_kmh, 1.0)
        metres_per_minute = speed_kmh * 1000 / 60

        def time_callback(from_index: int, to_index: int) -> int:
            from_node = manager.IndexToNode(from_index)
            to_node = manager.IndexToNode(to_index)
            travel = distance_matrix[from_node][to_node] / metres_per_minute
            service = 0.0 if from_node == 0 else stops[from_node - 1].service_minutes
            return int(round(travel + service))

        return time_callback

    time_callbacks = [
        routing.RegisterTransitCallback(make_time_callback(i)) for i in range(vehicle_count)
    ]
    routing.AddDimensionWithVehicleTransitAndCapacity(
        time_callbacks,
        # Waiting slack: a vehicle arriving before a window opens may idle up to 3 hours.
        180 if has_windows else 0,
        max_driving,
        False,  # do not force start cumul to zero — vehicles may begin at different times
        "Time",
    )
    time_dimension = routing.GetDimensionOrDie("Time")

    for vehicle_index, vehicle in enumerate(vehicles):
        if vehicle.max_driving_minutes is not None:
            constraints_described.append(
                f"{vehicle.name} ne peut pas dépasser {vehicle.max_driving_minutes} minutes sur "
                "la route."
            )
        # Anchor each route's start at t=0 so reported arrival times are minutes from the
        # start of the planning horizon.
        routing.AddVariableMinimizedByFinalizer(
            time_dimension.CumulVar(routing.Start(vehicle_index))
        )
        routing.AddVariableMinimizedByFinalizer(
            time_dimension.CumulVar(routing.End(vehicle_index))
        )

    if has_windows:
        for node, stop in enumerate(stops, start=1):
            start = stop.window_start_minutes if stop.window_start_minutes is not None else 0
            end = stop.window_end_minutes if stop.window_end_minutes is not None else 24 * 60
            if end < start:
                raise ValueError(
                    f"arrêt {stop.name} : la fin de la fenêtre ({end}) précède son début ({start})"
                )
            time_dimension.CumulVar(manager.NodeToIndex(node)).SetRange(int(start), int(end))
        constraints_described.append(
            f"{sum(1 for s in stops if s.window_start_minutes is not None)} arrêt(s) avec une "
            "fenêtre de livraison ; un véhicule peut attendre jusqu’à 3 heures qu’elle s’ouvre."
        )

    # --- allow dropping stops ---------------------------------------------
    # Without this an over-subscribed fleet yields no solution at all. With it, the solver
    # returns the best partial plan and names what it could not serve — far more useful.
    for node in range(1, len(points)):
        routing.AddDisjunction([manager.NodeToIndex(node)], DROP_PENALTY_M)
    constraints_described.append(
        "Un arrêt peut rester non affecté moyennant une forte pénalité, afin qu’une flotte "
        "insuffisante produise quand même un plan au lieu d’échouer purement et simplement."
    )

    # --- search ------------------------------------------------------------
    parameters = pywrapcp.DefaultRoutingSearchParameters()
    parameters.first_solution_strategy = (
        routing_enums_pb2.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION
    )
    parameters.local_search_metaheuristic = (
        routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    )
    parameters.time_limit.FromSeconds(max(1, solver_time_limit_seconds))

    solution = routing.SolveWithParameters(parameters)
    wall_time_ms = int((time.perf_counter() - started) * 1000)

    if solution is None:
        return RoutingResult(
            status="INFEASIBLE",
            routes=[],
            unassigned_stops=[stop.id for stop in stops],
            total_distance_km=0.0,
            total_duration_minutes=0.0,
            total_cost=0.0,
            objective_value=float("nan"),
            constraints=constraints_described,
            solver_wall_time_ms=wall_time_ms,
            reasons=[
                "Aucune tournée ne respecte les contraintes. Les causes habituelles sont des "
                "fenêtres horaires impossibles à toutes atteindre, ou une durée de conduite "
                "maximale trop courte pour les distances en jeu."
            ],
            assumptions=_assumptions(road_winding_factor, has_windows, solver_time_limit_seconds),
        )

    # --- unpack ------------------------------------------------------------
    routes: list[RoutePlan] = []
    served_nodes: set[int] = set()

    for vehicle_index, vehicle in enumerate(vehicles):
        index = routing.Start(vehicle_index)
        if routing.IsEnd(solution.Value(routing.NextVar(index))):
            continue  # vehicle unused

        sequence: list[dict] = []
        distance_m = 0
        load_scaled = 0

        sequence.append(
            {
                "id": "depot",
                "name": depot_name,
                "arrivalMinutes": int(solution.Value(time_dimension.CumulVar(index))),
                "loadAfter": 0.0,
            }
        )

        while not routing.IsEnd(index):
            next_index = solution.Value(routing.NextVar(index))
            from_node = manager.IndexToNode(index)
            to_node = manager.IndexToNode(next_index)
            distance_m += distance_matrix[from_node][to_node]

            if not routing.IsEnd(next_index):
                stop = stops[to_node - 1]
                served_nodes.add(to_node)
                load_scaled += demands[to_node]
                sequence.append(
                    {
                        "id": stop.id,
                        "name": stop.name,
                        "arrivalMinutes": int(
                            solution.Value(time_dimension.CumulVar(next_index))
                        ),
                        "loadAfter": round(load_scaled / SCALE, 3),
                    }
                )
            index = next_index

        end_minutes = int(solution.Value(time_dimension.CumulVar(index)))
        sequence.append(
            {
                "id": "depot",
                "name": depot_name,
                "arrivalMinutes": end_minutes,
                "loadAfter": round(load_scaled / SCALE, 3),
            }
        )

        distance_km = distance_m / 1000
        fuel_liters = distance_km * vehicle.fuel_consumption_l_per_100km / 100

        routes.append(
            RoutePlan(
                vehicle_id=vehicle.id,
                vehicle_name=vehicle.name,
                sequence=sequence,
                distance_km=distance_km,
                duration_minutes=float(end_minutes),
                load_units=load_scaled / SCALE,
                fuel_liters=fuel_liters,
                # Distance cost plus fuel: the two levers an operator can actually pull.
                cost=distance_km * vehicle.cost_per_km + fuel_liters * fuel_price_per_liter,
            )
        )

    unassigned = [
        stop.id for node, stop in enumerate(stops, start=1) if node not in served_nodes
    ]

    total_distance = sum(route.distance_km for route in routes)
    total_duration = sum(route.duration_minutes for route in routes)
    total_cost = sum(route.cost for route in routes)

    return RoutingResult(
        # Guided local search stops on the time limit, not on a proof, so this is FEASIBLE.
        status="FEASIBLE" if routes else "INFEASIBLE",
        routes=routes,
        unassigned_stops=unassigned,
        total_distance_km=total_distance,
        total_duration_minutes=total_duration,
        total_cost=total_cost,
        objective_value=float(solution.ObjectiveValue()),
        constraints=constraints_described,
        solver_wall_time_ms=wall_time_ms,
        reasons=_reasons(routes, unassigned, stops, vehicles, total_distance, total_cost),
        assumptions=_assumptions(road_winding_factor, has_windows, solver_time_limit_seconds),
    )


def _reasons(
    routes: Sequence[RoutePlan],
    unassigned: Sequence[str],
    stops: Sequence[RouteStop],
    vehicles: Sequence[RouteVehicle],
    total_distance: float,
    total_cost: float,
) -> list[str]:
    reasons = [
        f"{len(stops) - len(unassigned)} arrêt(s) sur {len(stops)} desservi(s) par "
        f"{len(routes)} véhicule(s) sur {len(vehicles)}.",
        f"Total {total_distance:,.1f} km pour un coût estimé de {total_cost:,.2f}.",
    ]

    for route in routes:
        names = " → ".join(step["name"] for step in route.sequence)
        reasons.append(
            f"{route.vehicle_name} : {names} "
            f"({route.distance_km:,.1f} km, {route.duration_minutes:,.0f} min, "
            f"{route.load_units:,.0f} unités, {route.fuel_liters:,.1f} L)."
        )

    idle = len(vehicles) - len(routes)
    if idle > 0:
        reasons.append(
            f"{idle} véhicule(s) laissé(s) inutilisé(s) — les mobiliser ajouterait de la distance "
            "fixe sans réduire le total."
        )

    if unassigned:
        by_id = {stop.id: stop for stop in stops}
        reasons.append(
            "Impossible de desservir : "
            + ", ".join(by_id[i].name for i in unassigned if i in by_id)
            + ". La capacité, la durée de conduite ou les fenêtres de livraison les ont rendus "
            "inaccessibles."
        )

    return reasons


def _assumptions(
    road_winding_factor: float, has_windows: bool, time_limit_seconds: int
) -> list[str]:
    assumptions = [
        f"Les distances sont à vol d’oiseau (orthodromie) × {road_winding_factor} pour approcher "
        "la distance routière. Définissez OSRM_URL sur l’API pour les remplacer par une vraie "
        "matrice routière.",
        "Le temps de trajet vaut distance ÷ vitesse moyenne du véhicule ; la congestion n’est pas "
        "modélisée ici (le moteur d’ETA s’en charge pour les expéditions effectivement en route).",
        "Les heures d’arrivée sont exprimées en minutes depuis le début de l’horizon de "
        "planification, pas en heures d’horloge.",
        "Le routage de véhicules est un problème NP-difficile. Le solveur exécute une recherche "
        f"locale guidée pendant au plus {time_limit_seconds} s et renvoie le meilleur plan "
        "trouvé — bon, mais pas optimal de façon prouvée, d’où le statut FEASIBLE.",
        "Le coût vaut distance × coût au km plus carburant ; il exclut les salaires des "
        "chauffeurs, les péages et le chargement.",
    ]
    if has_windows:
        assumptions.append(
            "Un véhicule arrivant avant l’ouverture d’une fenêtre de livraison peut attendre "
            "jusqu’à 3 heures ; ce temps d’attente compte dans sa durée de conduite maximale."
        )
    return assumptions
