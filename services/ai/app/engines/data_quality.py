"""Data quality gate.

Nothing is trained or optimised on data that has not been through here first. The rule the
brief asks for — "the model must not be trained silently on obviously corrupt data" — is
implemented as a three-level severity:

* ``INFO``     — worth knowing, changes nothing.
* ``WARNING``  — the row was repaired (a gap filled, a duplicate collapsed) and modelling
  continues, but the caller is told what was changed.
* ``BLOCKING`` — the series cannot be trusted. ``passed`` becomes ``False`` and every downstream
  number is refused rather than quietly produced from garbage.

The distinction matters because real supply-chain data is always a bit dirty. A pipeline that
blocks on any imperfection is a pipeline nobody can use; one that blocks on nothing produces
confident forecasts from nonsense.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Iterable, Literal, Sequence

import numpy as np
import pandas as pd

Severity = Literal["INFO", "WARNING", "BLOCKING"]

#: A series shorter than this cannot support even a naive model with a holdout.
MIN_OBSERVATIONS = 14

#: Fraction of the span that may be missing before the series is considered too sparse.
MAX_MISSING_FRACTION = 0.5

#: Values beyond this many robust standard deviations from the median are flagged as outliers.
OUTLIER_Z = 6.0


@dataclass
class DataQualityIssue:
    code: str
    severity: Severity
    message: str
    affected_rows: int = 0

    def to_dict(self) -> dict:
        return {
            "code": self.code,
            "severity": self.severity,
            "message": self.message,
            "affectedRows": self.affected_rows,
        }


@dataclass
class DataQualityReport:
    rows_in: int
    rows_used: int
    issues: list[DataQualityIssue] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return not any(issue.severity == "BLOCKING" for issue in self.issues)

    def to_dict(self) -> dict:
        return {
            "rowsIn": self.rows_in,
            "rowsUsed": self.rows_used,
            "issues": [issue.to_dict() for issue in self.issues],
            "passed": self.passed,
        }


@dataclass
class CleanedSeries:
    """A daily-frequency series with no gaps, plus the report describing what was done to it."""

    series: pd.Series
    report: DataQualityReport

    @property
    def passed(self) -> bool:
        return self.report.passed


def clean_demand_history(
    history: Sequence[dict],
    *,
    allow_zero_fill: bool = True,
) -> CleanedSeries:
    """Validate and normalise raw demand history into a gap-free daily series.

    ``history`` is a sequence of ``{"date": "YYYY-MM-DD", "quantity": float}``.

    Missing days are filled with zero rather than interpolated. For demand that is the honest
    choice: a day with no sales is a day with zero demand, and interpolating invents sales that
    never happened, which biases both the mean and — worse — the variance that safety stock is
    computed from.
    """
    issues: list[DataQualityIssue] = []
    rows_in = len(history)

    if rows_in == 0:
        issues.append(
            DataQualityIssue("EMPTY_SERIES", "BLOCKING", "Aucun historique de demande n’a été fourni.")
        )
        return CleanedSeries(pd.Series(dtype=float), DataQualityReport(0, 0, issues))

    frame = pd.DataFrame(list(history))
    if "date" not in frame.columns or "quantity" not in frame.columns:
        issues.append(
            DataQualityIssue(
                "MISSING_COLUMNS",
                "BLOCKING",
                "Chaque ligne d’historique doit comporter un champ « date » et un champ "
                "« quantity ».",
            )
        )
        return CleanedSeries(pd.Series(dtype=float), DataQualityReport(rows_in, 0, issues))

    # --- dates -------------------------------------------------------------
    parsed = pd.to_datetime(frame["date"], errors="coerce", utc=False)
    unparseable = int(parsed.isna().sum())
    if unparseable:
        issues.append(
            DataQualityIssue(
                "UNPARSEABLE_DATE",
                "WARNING",
                f"{unparseable} ligne(s) écartée(s) : leur date n’a pas pu être interprétée.",
                unparseable,
            )
        )
    frame = frame.loc[parsed.notna()].copy()
    frame["date"] = parsed[parsed.notna()].dt.normalize()

    if frame.empty:
        issues.append(
            DataQualityIssue("NO_VALID_DATES", "BLOCKING", "Aucune ligne n’a de date exploitable.")
        )
        return CleanedSeries(pd.Series(dtype=float), DataQualityReport(rows_in, 0, issues))

    future = frame["date"] > pd.Timestamp(date.today())
    if future.any():
        count = int(future.sum())
        issues.append(
            DataQualityIssue(
                "FUTURE_DATE",
                "WARNING",
                f"{count} ligne(s) écartée(s) : datée(s) dans le futur.",
                count,
            )
        )
        frame = frame.loc[~future]

    # --- quantities --------------------------------------------------------
    quantities = pd.to_numeric(frame["quantity"], errors="coerce")
    non_numeric = int(quantities.isna().sum())
    if non_numeric:
        issues.append(
            DataQualityIssue(
                "NON_NUMERIC_QUANTITY",
                "WARNING",
                f"{non_numeric} ligne(s) écartée(s) : quantité non numérique.",
                non_numeric,
            )
        )
    frame = frame.loc[quantities.notna()].copy()
    frame["quantity"] = quantities[quantities.notna()]

    negative = frame["quantity"] < 0
    if negative.any():
        count = int(negative.sum())
        # Negative demand is usually a return posted against the sales table. Clipping to zero
        # keeps the day in the series without letting a return look like negative consumption.
        issues.append(
            DataQualityIssue(
                "NEGATIVE_QUANTITY",
                "WARNING",
                f"{count} ligne(s) avec une quantité négative, ramenée(s) à zéro "
                "(le plus souvent un retour comptabilisé dans les ventes).",
                count,
            )
        )
        frame.loc[negative, "quantity"] = 0.0

    if frame.empty:
        issues.append(
            DataQualityIssue(
                "NO_VALID_QUANTITIES", "BLOCKING", "Aucune ligne n’a de quantité exploitable."
            )
        )
        return CleanedSeries(pd.Series(dtype=float), DataQualityReport(rows_in, 0, issues))

    # --- duplicates --------------------------------------------------------
    duplicated = int(frame.duplicated(subset=["date"]).sum())
    if duplicated:
        issues.append(
            DataQualityIssue(
                "DUPLICATE_DATE",
                "WARNING",
                f"{duplicated} date(s) en double additionnée(s) en un seul total journalier.",
                duplicated,
            )
        )
    daily = frame.groupby("date", as_index=True)["quantity"].sum().sort_index()

    # --- gaps --------------------------------------------------------------
    full_index = pd.date_range(daily.index.min(), daily.index.max(), freq="D")
    missing = len(full_index) - len(daily)
    span = len(full_index)

    if missing:
        fraction = missing / span
        if fraction > MAX_MISSING_FRACTION:
            issues.append(
                DataQualityIssue(
                    "SPARSE_SERIES",
                    "BLOCKING",
                    f"{missing} jours sur {span} ({fraction:.0%}) n’ont aucun enregistrement. "
                    f"Au-delà de {MAX_MISSING_FRACTION:.0%}, la série est trop clairsemée pour être "
                    "modélisée comme un signal de demande journalier — agrégez à la semaine ou "
                    "corrigez le flux amont.",
                    missing,
                )
            )
        elif allow_zero_fill:
            issues.append(
                DataQualityIssue(
                    "GAPS_ZERO_FILLED",
                    "WARNING",
                    f"{missing} jour(s) manquant(s) complété(s) par une demande nulle plutôt "
                    "qu’interpolé(s), pour ne pas sous-estimer la variance utilisée pour le stock "
                    "de sécurité.",
                    missing,
                )
            )

    daily = daily.reindex(full_index, fill_value=0.0)
    daily.index.name = "date"

    # --- length ------------------------------------------------------------
    if len(daily) < MIN_OBSERVATIONS:
        issues.append(
            DataQualityIssue(
                "TOO_SHORT",
                "BLOCKING",
                f"Seulement {len(daily)} jour(s) d’historique ; il en faut au moins "
                f"{MIN_OBSERVATIONS} pour ajuster et valider ne serait-ce qu’un modèle naïf.",
                len(daily),
            )
        )

    # --- constant / outliers ----------------------------------------------
    if len(daily) >= MIN_OBSERVATIONS and float(daily.std()) == 0.0:
        issues.append(
            DataQualityIssue(
                "ZERO_VARIANCE",
                "INFO",
                "La demande est parfaitement constante. La prévision est triviale et le stock de "
                "sécurité ne voit plus aucune variabilité — vérifiez que c’est réel et non un flux "
                "factice.",
                len(daily),
            )
        )

    outliers = _count_outliers(daily)
    if outliers:
        issues.append(
            DataQualityIssue(
                "EXTREME_OUTLIER",
                "WARNING",
                f"{outliers} jour(s) au-delà de {OUTLIER_Z:.0f} écarts-types robustes de la "
                "médiane. Ils sont conservés — un vrai pic de demande est un signal — mais ils "
                "élargiront l’intervalle de prévision.",
                outliers,
            )
        )

    return CleanedSeries(daily, DataQualityReport(rows_in, len(daily), issues))


def _count_outliers(series: pd.Series) -> int:
    """Count points far from the median, measured in MAD-based robust standard deviations.

    The median absolute deviation is used instead of the standard deviation because the outliers
    being looked for would inflate the very statistic used to detect them.
    """
    values = series.to_numpy(dtype=float)
    if values.size < MIN_OBSERVATIONS:
        return 0

    median = float(np.median(values))
    mad = float(np.median(np.abs(values - median)))
    if mad == 0.0:
        return 0

    # 1.4826 scales the MAD to be a consistent estimator of sigma for normal data.
    robust_sigma = 1.4826 * mad
    return int(np.sum(np.abs(values - median) > OUTLIER_Z * robust_sigma))


def validate_positive(name: str, value: float | None, *, allow_zero: bool = False) -> None:
    """Guard for scalar inputs to the optimisers. Raises ``ValueError`` with a usable message."""
    if value is None:
        raise ValueError(f"{name} est requis")
    if not np.isfinite(value):
        raise ValueError(f"{name} doit être un nombre fini (reçu : {value!r})")
    if value < 0 or (value == 0 and not allow_zero):
        bound = "positif ou nul" if allow_zero else "strictement positif"
        raise ValueError(f"{name} doit être {bound} (reçu : {value})")


def summarise_issues(reports: Iterable[DataQualityReport]) -> list[str]:
    """Flatten several reports into human-readable lines for an explanation block."""
    lines: list[str] = []
    for report in reports:
        for issue in report.issues:
            if issue.severity != "INFO":
                lines.append(f"[{issue.severity}] {issue.message}")
    return lines
