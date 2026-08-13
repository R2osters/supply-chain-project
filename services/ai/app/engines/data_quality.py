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
            DataQualityIssue("EMPTY_SERIES", "BLOCKING", "No demand history was supplied.")
        )
        return CleanedSeries(pd.Series(dtype=float), DataQualityReport(0, 0, issues))

    frame = pd.DataFrame(list(history))
    if "date" not in frame.columns or "quantity" not in frame.columns:
        issues.append(
            DataQualityIssue(
                "MISSING_COLUMNS",
                "BLOCKING",
                "Each history row needs a 'date' and a 'quantity'.",
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
                f"{unparseable} row(s) had a date that could not be parsed and were dropped.",
                unparseable,
            )
        )
    frame = frame.loc[parsed.notna()].copy()
    frame["date"] = parsed[parsed.notna()].dt.normalize()

    if frame.empty:
        issues.append(DataQualityIssue("NO_VALID_DATES", "BLOCKING", "No row had a usable date."))
        return CleanedSeries(pd.Series(dtype=float), DataQualityReport(rows_in, 0, issues))

    future = frame["date"] > pd.Timestamp(date.today())
    if future.any():
        count = int(future.sum())
        issues.append(
            DataQualityIssue(
                "FUTURE_DATE",
                "WARNING",
                f"{count} row(s) were dated in the future and were dropped.",
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
                f"{non_numeric} row(s) had a non-numeric quantity and were dropped.",
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
                f"{count} row(s) had a negative quantity and were clipped to zero "
                "(most often a return booked against sales).",
                count,
            )
        )
        frame.loc[negative, "quantity"] = 0.0

    if frame.empty:
        issues.append(
            DataQualityIssue("NO_VALID_QUANTITIES", "BLOCKING", "No row had a usable quantity.")
        )
        return CleanedSeries(pd.Series(dtype=float), DataQualityReport(rows_in, 0, issues))

    # --- duplicates --------------------------------------------------------
    duplicated = int(frame.duplicated(subset=["date"]).sum())
    if duplicated:
        issues.append(
            DataQualityIssue(
                "DUPLICATE_DATE",
                "WARNING",
                f"{duplicated} duplicate date(s) were summed into a single daily total.",
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
                    f"{missing} of {span} days ({fraction:.0%}) have no record. Above "
                    f"{MAX_MISSING_FRACTION:.0%} the series is too sparse to model as a daily "
                    "demand signal — aggregate to weekly, or fix the upstream feed.",
                    missing,
                )
            )
        elif allow_zero_fill:
            issues.append(
                DataQualityIssue(
                    "GAPS_ZERO_FILLED",
                    "WARNING",
                    f"{missing} missing day(s) were filled with zero demand rather than "
                    "interpolated, so the variance used for safety stock is not understated.",
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
                f"Only {len(daily)} day(s) of history; at least {MIN_OBSERVATIONS} are needed "
                "to fit and validate even a naive model.",
                len(daily),
            )
        )

    # --- constant / outliers ----------------------------------------------
    if len(daily) >= MIN_OBSERVATIONS and float(daily.std()) == 0.0:
        issues.append(
            DataQualityIssue(
                "ZERO_VARIANCE",
                "INFO",
                "Demand is perfectly constant. Forecasting is trivial and safety stock "
                "collapses to zero variability — check this is real and not a placeholder feed.",
                len(daily),
            )
        )

    outliers = _count_outliers(daily)
    if outliers:
        issues.append(
            DataQualityIssue(
                "EXTREME_OUTLIER",
                "WARNING",
                f"{outliers} day(s) sit beyond {OUTLIER_Z:.0f} robust standard deviations from "
                "the median. They are kept — a genuine demand spike is signal — but they will "
                "widen the forecast interval.",
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
        raise ValueError(f"{name} is required")
    if not np.isfinite(value):
        raise ValueError(f"{name} must be a finite number, got {value!r}")
    if value < 0 or (value == 0 and not allow_zero):
        bound = "non-negative" if allow_zero else "strictly positive"
        raise ValueError(f"{name} must be {bound}, got {value}")


def summarise_issues(reports: Iterable[DataQualityReport]) -> list[str]:
    """Flatten several reports into human-readable lines for an explanation block."""
    lines: list[str] = []
    for report in reports:
        for issue in report.issues:
            if issue.severity != "INFO":
                lines.append(f"[{issue.severity}] {issue.message}")
    return lines
