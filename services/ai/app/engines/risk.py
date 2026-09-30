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

import math
from dataclasses import dataclass, field
from typing import Sequence

from .inventory import stockout_probability

#: Weight of each category in the health score. They sum to 100, so the worst possible score is 0.
#: NATURAL_HAZARD (earthquakes, eruptions, wildfires) took its 5 points from DEMAND_RISK: erratic demand is
#: buffered by inventory policy, while a fire at a warehouse is not something policy can absorb.
HEALTH_WEIGHTS: dict[str, float] = {
    "STOCKOUT_RISK": 30.0,
    "SUPPLIER_RISK": 25.0,
    "TRANSPORT_RISK": 20.0,
    "DEMAND_RISK": 10.0,
    "GEOPOLITICAL_RISK": 5.0,
    "WEATHER_RISK": 5.0,
    "NATURAL_HAZARD": 5.0,
}

#: Which risk category each live hazard kind feeds. Cyclones, storms, floods and droughts are
#: weather (hydro-meteorological, driven by rain or its absence); earthquakes, eruptions and fires
#: are not, and lumping them in would make "weather risk" mean "anything outdoors".
HAZARD_CATEGORY: dict[str, str] = {
    "CYCLONE": "WEATHER_RISK",
    "SEVERE_WEATHER": "WEATHER_RISK",
    "FLOOD": "WEATHER_RISK",
    "DROUGHT": "WEATHER_RISK",
    "EARTHQUAKE": "NATURAL_HAZARD",
    "VOLCANO": "NATURAL_HAZARD",
    "FIRE": "NATURAL_HAZARD",
}

#: Chance that a hazard of this level disrupts an asset sitting right next to it.
HAZARD_LEVEL_PROBABILITY: dict[str, float] = {
    "CRITICAL": 0.9,
    "HIGH": 0.7,
    "MEDIUM": 0.45,
    "LOW": 0.2,
}

#: Impact of a hazard as a fraction of the largest other impact in the run (see _hazard_findings).
HAZARD_LEVEL_IMPACT: dict[str, float] = {
    "CRITICAL": 1.0,
    "HIGH": 0.6,
    "MEDIUM": 0.3,
    "LOW": 0.1,
}

#: Distance over which a hazard's grip on an asset fades, km.
HAZARD_DISTANCE_SCALE_KM = 150.0

#: At most this many hazard findings per analysis, strongest first.
MAX_HAZARD_FINDINGS = 20

HIGH_SCORE = 50.0
MEDIUM_SCORE = 20.0

#: A supplier holding more than this share of spend is a single point of failure.
CONCENTRATION_THRESHOLD = 0.4

#: Countries flagged as elevated geopolitical risk are supplied by the caller; absent that, the
#: engine only flags concentration in *one* country, which it can see from the data itself.
COUNTRY_CONCENTRATION_THRESHOLD = 0.6

#: French labels for the explanation text; the JSON keeps the codes.
CATEGORY_LABELS: dict[str, str] = {
    "STOCKOUT_RISK": "risque de rupture",
    "SUPPLIER_RISK": "risque fournisseur",
    "TRANSPORT_RISK": "risque transport",
    "DEMAND_RISK": "risque lié à la demande",
    "GEOPOLITICAL_RISK": "risque géopolitique",
    "WEATHER_RISK": "risque météo",
    "NATURAL_HAZARD": "danger naturel",
}
LEVEL_LABELS: dict[str, str] = {
    "CRITICAL": "critique",
    "HIGH": "élevé",
    "MEDIUM": "moyen",
    "LOW": "faible",
}
#: Hazard names used when the feed row carries no title. Same wording as the web UI.
HAZARD_KIND_LABELS: dict[str, str] = {
    "CYCLONE": "Cyclone tropical",
    "SEVERE_WEATHER": "Météo sévère",
    "FLOOD": "Inondation",
    "DROUGHT": "Sécheresse",
    "EARTHQUAKE": "Séisme",
    "VOLCANO": "Éruption volcanique",
    "FIRE": "Feu actif",
}


def _capitalised(text: str) -> str:
    return text[:1].upper() + text[1:]


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
                "summary": (
                    f"{_capitalised(CATEGORY_LABELS.get(self.category, self.category))} — "
                    f"{self.subject} : score {self.score:.0f}/100."
                ),
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
    hazards: Sequence[dict] | None = None,
) -> RiskReport:
    findings: list[RiskFinding] = []

    findings += _stockout_findings(products)
    findings += _supplier_findings(suppliers)
    findings += _transport_findings(shipments)
    findings += _demand_findings(products)
    findings += _geopolitical_findings(suppliers)

    # Hazard impact has no currency value of its own, so it is anchored to the largest impact
    # found above — which is why hazards are collected after everything else.
    reference_impact = max((f.impact for f in findings), default=0.0)
    findings += _hazard_findings(hazards or [], reference_impact)

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
            "Score = probabilité × impact normalisé par rapport au plus grand impact de cette "
            "analyse. Les scores sont comparables au sein d’une même analyse, pas d’une analyse "
            "à l’autre.",
            "L’impact est exprimé en valeur monétaire quand les données le permettent (unités à "
            "risque × coût unitaire), et en ordre de grandeur relatif sinon.",
            "Le score de santé part de 100 et soustrait une pénalité pondérée par catégorie, de "
            "sorte qu’une catégorie catastrophique ne puisse pas être diluée par quatre "
            "catégories saines.",
            "La probabilité de rupture provient du même modèle normal de demande pendant le "
            "délai d’approvisionnement que le moteur de stock, et en hérite les hypothèses.",
            _hazard_assumption(hazards),
            "Le risque géopolitique n’est évalué qu’à partir des données présentes dans la "
            "requête ; il reflète la concentration des approvisionnements, pas l’actualité.",
        ],
    )


def _hazard_assumption(hazards: Sequence[dict] | None) -> str:
    if hazards is None:
        return (
            "Aucun flux de dangers en direct n’a été fourni avec cette requête : les risques "
            "météo et les dangers naturels ne reflètent donc aucun élément extérieur."
        )
    return (
        "Les risques météo et les dangers naturels proviennent de flux publics en direct "
        "(cyclones NOAA NHC, séismes USGS, incendies NASA FIRMS, météo Open-Meteo), rapprochés "
        f"de la position des sites par l’API. Expositions à un danger fournies : {len(hazards)}. "
        "Le NHC ne couvre que l’Atlantique et le Pacifique est et central."
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
                subject=product.get("sku", product.get("productId", "inconnu")),
                subject_type="PRODUCT",
                subject_id=str(product.get("productId", "")),
                recommended_action=(
                    f"Commandez au moins {units_at_risk:,.0f} unités, ou accélérez les "
                    f"{incoming:,.0f} déjà en commande."
                    if units_at_risk > 0
                    else "Surveillez : la couverture est faible, mais la position couvre encore "
                    "la demande attendue."
                ),
                reasons=[
                    f"{current:,.0f} en stock plus {incoming:,.0f} en stock entrant, face à une "
                    f"demande attendue de {demand * lead_time:,.0f} sur un délai "
                    f"d’approvisionnement de {lead_time:.0f} jours.",
                    f"{days_of_cover:.1f} jours de couverture restants au rythme actuel de la "
                    "demande.",
                    f"Probabilité de rupture avant réapprovisionnement : {probability:.1%}.",
                    f"Environ {units_at_risk:,.0f} unités à risque, pour une valeur de {impact:,.0f}.",
                ],
                assumptions=[
                    "La demande pendant le délai d’approvisionnement est approchée par une loi "
                    "normale.",
                    "Le stock entrant est supposé arriver dans le délai d’approvisionnement.",
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
            f"Taux de ponctualité {on_time:.1%}, taux d’acceptation qualité {quality:.1%} — "
            f"probabilité de défaillance combinée {failure_probability:.1%}.",
            f"Ce fournisseur représente {share:.1%} des dépenses concernées.",
        ]

        action = "Surveillez ses performances."
        if share >= CONCENTRATION_THRESHOLD and failure_probability >= 0.1:
            action = (
                "Qualifiez un second fournisseur. Celui-ci est à la fois peu fiable et très "
                "sollicité — c’est la combinaison des deux qui transforme un retard en rupture "
                "d’approvisionnement."
            )
            reasons.append(
                "Concentration et manque de fiabilité se cumulent : une défaillance ici n’a "
                "aucune solution de repli."
            )
        elif share >= CONCENTRATION_THRESHOLD:
            action = (
                "Qualifiez un second fournisseur pour réduire la dépendance à un fournisseur "
                "unique."
            )
        elif failure_probability >= 0.2:
            action = (
                "Signalez le problème de fiabilité au fournisseur ou reportez du volume ailleurs."
            )

        if lead_std > 3:
            reasons.append(
                f"Le délai d’approvisionnement varie de ±{lead_std:.1f} jours, ce qui impose un "
                "stock de sécurité plus élevé sur tous les produits que livre ce fournisseur."
            )

        findings.append(
            RiskFinding(
                category="SUPPLIER_RISK",
                probability=max(failure_probability, 0.01),
                impact=impact,
                score=0.0,
                level="LOW",
                subject=supplier.get("name", "fournisseur inconnu"),
                subject_type="SUPPLIER",
                subject_id=str(supplier.get("supplierId", "")),
                recommended_action=action,
                reasons=reasons,
                assumptions=[
                    "La probabilité de défaillance vaut 1 − (ponctualité × acceptation qualité), "
                    "ce qui traite les deux comme indépendantes.",
                    "La part des dépenses est fournie par l’appelant et n’est pas recalculée ici.",
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
            subject=f"{len(at_risk)} expédition(s) en transit",
            subject_type="SHIPMENT",
            subject_id=str(at_risk[0].get("shipmentId", "")),
            recommended_action=(
                f"Examinez les {len(at_risk)} expédition(s) à risque ; accélérez ou replanifiez "
                "celles qui alimentent des produits à faible couverture."
            ),
            reasons=[
                f"{len(at_risk)} expédition(s) présentent une probabilité de retard de 40 % ou "
                "plus.",
                f"Leur probabilité de retard moyenne est de {mean_probability:.1%}.",
                f"Valeur totale des marchandises à risque : {total_value:,.0f}.",
            ],
            assumptions=[
                "La probabilité de retard est reprise telle quelle de la fiche de l’expédition.",
                "La valeur à risque est celle des marchandises, pas le coût induit du retard en "
                "aval.",
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
                subject=product.get("sku", "inconnu"),
                subject_type="PRODUCT",
                subject_id=str(product.get("productId", "")),
                recommended_action=(
                    "Relevez le niveau de service ou raccourcissez le cycle de réapprovisionnement. "
                    "Une demande erratique ne disparaît pas avec une meilleure prévision — il faut "
                    "l’absorber par du stock ou commander plus souvent."
                ),
                reasons=[
                    f"Coefficient de variation {cv:.2f} (σ {demand_std:,.1f} pour une moyenne de "
                    f"{demand:,.1f}/jour) — au-delà de 0.5, la demande est considérée comme "
                    "erratique.",
                    "Une prévision sur cette série aura des intervalles larges, quelle que soit la "
                    "qualité du modèle ; la solution est la politique de stock, pas un meilleur "
                    "modèle.",
                ],
                assumptions=[
                    "Un coefficient de variation supérieur à 0.5 est le seuil conventionnel de "
                    "demande erratique.",
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
            subject=f"Approvisionnement concentré dans le pays {country}",
            subject_type="COMPANY",
            subject_id=country,
            recommended_action=(
                f"Qualifiez des fournisseurs hors du pays {country}. Une fermeture de frontière, "
                "une grève ou un choc monétaire dans ce pays toucherait aujourd’hui la plupart de "
                "vos approvisionnements entrants en même temps."
            ),
            reasons=[
                f"{concentration:.0%} des dépenses fournisseurs proviennent du pays {country}.",
                "S’approvisionner dans un seul pays corrèle des risques qui seraient sinon "
                "indépendants : un seul événement touche tous les fournisseurs à la fois.",
            ],
            assumptions=[
                "Aucun flux géopolitique en direct n’est configuré : ce constat reflète "
                "uniquement la concentration, pas l’actualité de ce pays.",
            ],
        )
    ]


def _hazard_findings(hazards: Sequence[dict], reference_impact: float) -> list[RiskFinding]:
    """One finding per live hazard, attached to the asset it is closest to.

        probability = P(level) × proximity,   proximity = 0.4 + 0.6 · exp(−distance / 150 km)

    A hazard on top of a site keeps its full level probability; one at the edge of the exposure
    radius keeps under half of it, never zero, because the API only sends exposures it already
    judged close enough to matter.

    Impact has no currency figure — nobody knows what a fire near a warehouse will cost — so it is
    expressed relative to the largest impact elsewhere in the analysis: a CRITICAL hazard counts
    as much as the worst other problem found, a LOW one a tenth of it, scaled up a little for each
    additional asset in reach. Without any other finding the reference is 1 and hazards rank
    among themselves.
    """
    by_hazard: dict[str, list[dict]] = {}
    for exposure in hazards:
        if str(exposure.get("kind", "")) not in HAZARD_CATEGORY:
            continue
        by_hazard.setdefault(str(exposure.get("hazardId", "")), []).append(exposure)

    reference = reference_impact if reference_impact > 0 else 1.0
    findings: list[RiskFinding] = []

    for exposures in by_hazard.values():
        exposures = sorted(exposures, key=lambda e: float(e.get("distanceKm", 0) or 0))
        closest = exposures[0]
        kind = str(closest["kind"])
        level = str(closest.get("severity", "LOW"))
        distance = float(closest.get("distanceKm", 0) or 0)
        subjects = list(dict.fromkeys(str(e.get("subjectLabel", "")) for e in exposures))

        proximity = 0.4 + 0.6 * math.exp(-distance / HAZARD_DISTANCE_SCALE_KM)
        probability = min(HAZARD_LEVEL_PROBABILITY.get(level, 0.2) * proximity, 0.95)
        spread = min(1.0 + 0.25 * (len(subjects) - 1), 2.0)
        impact = HAZARD_LEVEL_IMPACT.get(level, 0.1) * spread * reference

        title = closest.get("title", HAZARD_KIND_LABELS.get(kind, kind.title()))
        label = closest.get("subjectLabel")
        target = f"de {label}" if label else "d’un site suivi"
        reasons = [
            f"{title} (niveau {LEVEL_LABELS.get(level, level)}) se trouve à {distance:,.0f} km "
            f"{target}.",
            f"Probabilité estimée d’une perturbation de ce site : {probability:.0%}.",
        ]
        if len(subjects) > 1:
            others = ", ".join(subjects[1:6])
            more = f" et {len(subjects) - 6} autre(s)" if len(subjects) > 6 else ""
            reasons.append(f"Également à portée : {others}{more}.")

        findings.append(
            RiskFinding(
                category=HAZARD_CATEGORY[kind],
                probability=probability,
                impact=impact,
                score=0.0,
                level="LOW",
                subject=str(closest.get("subjectLabel", "site inconnu")),
                subject_type=str(closest.get("subjectType", "COMPANY")),
                subject_id=str(closest.get("subjectId", "")),
                recommended_action=_hazard_action(kind),
                reasons=reasons,
                assumptions=[
                    "La position et la gravité du danger proviennent du flux en direct, telles que "
                    "transmises par l’API.",
                    "La distance est mesurée jusqu’au centre du danger ou, pour un cyclone, "
                    "jusqu’au point le plus proche de sa trajectoire prévue ; les zones réellement "
                    "touchées sont irrégulières.",
                    "L’impact est relatif au plus grand autre impact de cette analyse ; ce n’est "
                    "pas une estimation de coût.",
                ],
            )
        )

    findings.sort(key=lambda f: f.probability * f.impact, reverse=True)
    return findings[:MAX_HAZARD_FINDINGS]


def _hazard_action(kind: str) -> str:
    return {
        "CYCLONE": (
            "Suivez l’avis officiel (NHC, ou le centre régional hors de l’Atlantique et du "
            "Pacifique est). Déroutez ou retenez les expéditions qui croisent la trajectoire de la "
            "tempête, déplacez le stock qui peut l’être et sécurisez le site avant que la tempête "
            "ne touche terre."
        ),
        "SEVERE_WEATHER": (
            "Retenez ou déroutez les départs qui traversent la zone touchée jusqu’à ce que les "
            "conditions s’améliorent, et prévenez les chauffeurs déjà sur la route."
        ),
        "FLOOD": (
            "Vérifiez quelles routes et quels franchissements de cours d’eau sont fermés, "
            "surélevez le stock posé au rez-de-chaussée, et déroutez ou retenez les expéditions "
            "qui traversent la zone inondée."
        ),
        "DROUGHT": (
            "Attendez-vous à des niveaux de rivière plus bas et à des restrictions d’eau : "
            "vérifiez la capacité des barges et des ports fluviaux ainsi que les fournisseurs "
            "dépendant des récoltes, et constituez un stock tampon sur les axes concernés."
        ),
        "EARTHQUAKE": (
            "Vérifiez que le personnel et le site sont en sécurité, inspectez les dégâts, et "
            "contrôlez l’état des routes et des ports avant toute expédition."
        ),
        "VOLCANO": (
            "Suivez les avis de la protection civile et les avis aéronautiques sur les cendres : "
            "attendez-vous à des fermetures d’aéroports et à des restrictions routières sous le "
            "vent, et basculez le fret aérien sur d’autres itinéraires."
        ),
        "FIRE": (
            "Surveillez la progression du feu, préparez-vous à déplacer le stock, et déroutez les "
            "expéditions pour contourner les routes fermées."
        ),
    }.get(kind, "Surveillez le danger.")


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
            "Aucun risque au-dessus du seuil de signalement n’a été détecté. Score de santé 100.",
        ]

    verdict = (
        "saine" if health >= 80 else "tendue" if health >= 55 else "sous forte pression"
    )
    reasons = [
        f"Santé de la supply chain {health:.0f}/100 — situation {verdict}.",
        f"{len(findings)} constat(s) ; "
        f"{sum(1 for f in findings if f.level == 'HIGH')} élevé(s), "
        f"{sum(1 for f in findings if f.level == 'MEDIUM')} moyen(s).",
    ]

    worst_category = max(breakdown, key=lambda c: breakdown[c]) if breakdown else None
    if worst_category and breakdown[worst_category] > 0:
        category_label = _capitalised(CATEGORY_LABELS.get(worst_category, worst_category))
        reasons.append(
            f"La catégorie « {category_label} » coûte le plus de points "
            f"({breakdown[worst_category]:.1f} sur un maximum de "
            f"{HEALTH_WEIGHTS[worst_category]:.0f})."
        )

    for finding in findings[:3]:
        reasons.append(
            f"{_capitalised(LEVEL_LABELS.get(finding.level, finding.level))} — "
            f"{CATEGORY_LABELS.get(finding.category, finding.category)} pour {finding.subject} "
            f"(score {finding.score:.0f}) : {finding.recommended_action}"
        )

    return reasons
