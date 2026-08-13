"""Demand forecasting.

The brief asks for simple models first, a fair comparison between them, and automatic selection
per product once there is enough data. That is exactly what this does, and the ordering is not
just deference to the brief — on the short, noisy, intermittent series that a real SKU produces,
a seasonal naive baseline beats a gradient-boosted model far more often than people expect. The
value of the comparison is knowing *which* case you are in.

Models, cheapest first:

===================== ==========================================================
NAIVE                 tomorrow equals today. The honest floor: any model that
                      cannot beat it is not earning its complexity.
SEASONAL_NAIVE        tomorrow equals the same weekday last week. Strong for
                      retail and distribution, where weekly rhythm dominates.
MOVING_AVERAGE        mean of the last *w* days; *w* chosen by validation.
EXPONENTIAL_SMOOTHING simple exponential smoothing — level only, no trend.
HOLT_WINTERS          additive trend + weekly seasonality.
GRADIENT_BOOSTING     lag and calendar features, forecast recursively. Only
                      offered when the series is long enough to justify it.
===================== ==========================================================

Selection is by **WAPE** on walk-forward validation, not MAPE. MAPE divides by the actual, so a
single zero-demand day makes it infinite and a few low-demand days make it meaningless — and
zero-demand days are the norm for anything slow-moving. WAPE (total absolute error ÷ total
actual) is well defined whenever the period had any demand at all, and it weights a big miss on
a big day more heavily than a big *relative* miss on a quiet one, which is what a planner
actually cares about.

Validation is walk-forward with an expanding window: fit on everything up to time *t*, predict
the next *h* days, roll forward, repeat. A random train/test split would leak the future into
the past and flatter every model, catastrophically so for the ones with lag features.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Callable, Sequence

import numpy as np
import pandas as pd

from .data_quality import CleanedSeries, clean_demand_history

ModelName = str

#: Every model this engine can fit, cheapest first.
ALL_MODELS: tuple[ModelName, ...] = (
    "NAIVE",
    "SEASONAL_NAIVE",
    "MOVING_AVERAGE",
    "EXPONENTIAL_SMOOTHING",
    "HOLT_WINTERS",
    "GRADIENT_BOOSTING",
)

#: Default seasonal period. Weekly, because distribution demand is driven by the working week.
DEFAULT_SEASONAL_PERIOD = 7

#: Minimum observations before a model is even offered a chance to compete.
MIN_HISTORY: dict[ModelName, int] = {
    "NAIVE": 2,
    "SEASONAL_NAIVE": 2 * DEFAULT_SEASONAL_PERIOD,
    "MOVING_AVERAGE": 7,
    "EXPONENTIAL_SMOOTHING": 10,
    "HOLT_WINTERS": 3 * DEFAULT_SEASONAL_PERIOD,
    # Boosting on a few dozen points memorises noise; the payoff needs real volume.
    "GRADIENT_BOOSTING": 120,
}

#: Candidate windows for MOVING_AVERAGE, chosen by validation rather than by assertion.
MOVING_AVERAGE_WINDOWS = (3, 7, 14, 28)

#: Coverage of the prediction interval, matching the ETA engine's convention.
INTERVAL_CONFIDENCE_PERCENT = 80
#: z for that coverage.
INTERVAL_Z = 1.2816


@dataclass
class ModelEvaluation:
    model: ModelName
    mae: float = float("nan")
    rmse: float = float("nan")
    mape: float | None = None
    wape: float = float("inf")
    folds: int = 0
    selected: bool = False
    skipped_reason: str | None = None

    def to_dict(self) -> dict:
        payload = {
            "model": self.model,
            "mae": _finite(self.mae),
            "rmse": _finite(self.rmse),
            "mape": None if self.mape is None else _finite(self.mape),
            "wape": _finite(self.wape),
            "folds": self.folds,
            "selected": self.selected,
        }
        if self.skipped_reason:
            payload["skippedReason"] = self.skipped_reason
        return payload


@dataclass
class ForecastPoint:
    date: str
    demand: float
    lower_bound: float
    upper_bound: float

    def to_dict(self) -> dict:
        return {
            "date": self.date,
            "demand": self.demand,
            "lowerBound": self.lower_bound,
            "upperBound": self.upper_bound,
        }


@dataclass
class ForecastResult:
    points: list[ForecastPoint]
    selected_model: ModelName
    evaluations: list[ModelEvaluation]
    residual_std: float
    cleaned: CleanedSeries
    reasons: list[str] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)

    @property
    def metrics(self) -> ModelEvaluation:
        for evaluation in self.evaluations:
            if evaluation.selected:
                return evaluation
        return ModelEvaluation(self.selected_model)


# ---------------------------------------------------------------------------
# Point forecasters. Each takes a history and a horizon, returns `horizon` values.
# ---------------------------------------------------------------------------


def _naive(history: np.ndarray, horizon: int, **_: object) -> np.ndarray:
    return np.repeat(history[-1], horizon)


def _seasonal_naive(history: np.ndarray, horizon: int, period: int = DEFAULT_SEASONAL_PERIOD, **_: object) -> np.ndarray:
    if history.size < period:
        return _naive(history, horizon)
    season = history[-period:]
    # Tile the last full season forward, so day h maps back to the same weekday.
    return np.array([season[i % period] for i in range(horizon)], dtype=float)


def _moving_average(history: np.ndarray, horizon: int, window: int = 7, **_: object) -> np.ndarray:
    window = min(window, history.size)
    return np.repeat(float(history[-window:].mean()), horizon)


def _simple_exponential_smoothing(
    history: np.ndarray, horizon: int, alpha: float | None = None, **_: object
) -> np.ndarray:
    """SES with the level recursion written out.

    statsmodels is used for Holt-Winters, but SES is three lines and doing it directly avoids a
    fitting call — and, more importantly, makes the smoothing constant visible in the code rather
    than buried in an optimiser's output.
    """
    if alpha is None:
        # 2/(w+1) with w = 7 days: the usual EWMA-to-window correspondence.
        alpha = 2.0 / (7 + 1)
    level = float(history[0])
    for value in history[1:]:
        level = alpha * float(value) + (1 - alpha) * level
    return np.repeat(level, horizon)


def _holt_winters(
    history: np.ndarray, horizon: int, period: int = DEFAULT_SEASONAL_PERIOD, **_: object
) -> np.ndarray:
    from statsmodels.tsa.holtwinters import ExponentialSmoothing

    with warnings.catch_warnings():
        # statsmodels is chatty about convergence on short series; the fallback below handles it.
        warnings.simplefilter("ignore")
        try:
            model = ExponentialSmoothing(
                history,
                trend="add",
                seasonal="add" if history.size >= 2 * period else None,
                seasonal_periods=period if history.size >= 2 * period else None,
                initialization_method="estimated",
            ).fit(optimized=True)
            forecast = np.asarray(model.forecast(horizon), dtype=float)
            if not np.all(np.isfinite(forecast)):
                raise ValueError("non-finite forecast")
            return forecast
        except Exception:
            # A failed fit is not a reason to fail the request; fall back to the next model down.
            return _seasonal_naive(history, horizon, period=period)


def _gradient_boosting(
    history: np.ndarray,
    horizon: int,
    period: int = DEFAULT_SEASONAL_PERIOD,
    start_date: pd.Timestamp | None = None,
    **_: object,
) -> np.ndarray:
    """Lag + calendar features, forecast recursively.

    Recursive (feed each prediction back as the next lag) rather than direct (a separate model
    per horizon step) because one model per horizon step across four horizons and thousands of
    SKUs is a training bill nobody wants, and the accuracy difference at these horizons is small
    compared with the noise in the data.
    """
    from sklearn.ensemble import HistGradientBoostingRegressor

    lags = [1, 2, 3, 7, 14, 28]
    max_lag = max(lags)
    if history.size <= max_lag + 10:
        return _seasonal_naive(history, horizon, period=period)

    frame = _build_features(history, lags, start_date)
    train = frame.dropna()
    if train.shape[0] < 30:
        return _seasonal_naive(history, horizon, period=period)

    feature_columns = [c for c in train.columns if c != "y"]
    model = HistGradientBoostingRegressor(
        max_iter=200,
        learning_rate=0.08,
        max_depth=4,
        min_samples_leaf=10,
        l2_regularization=1.0,
        random_state=42,
    )
    model.fit(train[feature_columns], train["y"])

    working = list(history.astype(float))
    predictions: list[float] = []
    cursor = start_date + timedelta(days=len(history)) if start_date is not None else None

    for step in range(horizon):
        row = {}
        for lag in lags:
            row[f"lag_{lag}"] = working[-lag]
        row["rolling_7"] = float(np.mean(working[-7:]))
        row["rolling_28"] = float(np.mean(working[-28:]))
        if cursor is not None:
            row["day_of_week"] = float(cursor.dayofweek)
            row["day_of_month"] = float(cursor.day)
            row["month"] = float(cursor.month)
            row["is_weekend"] = float(cursor.dayofweek >= 5)
        else:
            index = len(history) + step
            row["day_of_week"] = float(index % 7)
            row["day_of_month"] = float((index % 30) + 1)
            row["month"] = 1.0
            row["is_weekend"] = float(index % 7 >= 5)

        features = pd.DataFrame([row])[feature_columns]
        prediction = float(model.predict(features)[0])
        prediction = max(prediction, 0.0)
        predictions.append(prediction)
        working.append(prediction)
        if cursor is not None:
            cursor = cursor + timedelta(days=1)

    return np.array(predictions, dtype=float)


def _build_features(
    history: np.ndarray, lags: Sequence[int], start_date: pd.Timestamp | None
) -> pd.DataFrame:
    series = pd.Series(history, dtype=float)
    frame = pd.DataFrame({"y": series})
    for lag in lags:
        frame[f"lag_{lag}"] = series.shift(lag)
    frame["rolling_7"] = series.shift(1).rolling(7).mean()
    frame["rolling_28"] = series.shift(1).rolling(28).mean()

    if start_date is not None:
        dates = pd.date_range(start_date, periods=len(series), freq="D")
        frame["day_of_week"] = dates.dayofweek.astype(float)
        frame["day_of_month"] = dates.day.astype(float)
        frame["month"] = dates.month.astype(float)
        frame["is_weekend"] = (dates.dayofweek >= 5).astype(float)
    else:
        index = np.arange(len(series), dtype=float)
        frame["day_of_week"] = index % 7
        frame["day_of_month"] = (index % 30) + 1
        frame["month"] = 1.0
        frame["is_weekend"] = (index % 7 >= 5).astype(float)

    return frame


Forecaster = Callable[..., np.ndarray]

FORECASTERS: dict[ModelName, Forecaster] = {
    "NAIVE": _naive,
    "SEASONAL_NAIVE": _seasonal_naive,
    "MOVING_AVERAGE": _moving_average,
    "EXPONENTIAL_SMOOTHING": _simple_exponential_smoothing,
    "HOLT_WINTERS": _holt_winters,
    "GRADIENT_BOOSTING": _gradient_boosting,
}


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


def mae(actual: np.ndarray, predicted: np.ndarray) -> float:
    return float(np.mean(np.abs(actual - predicted)))


def rmse(actual: np.ndarray, predicted: np.ndarray) -> float:
    return float(np.sqrt(np.mean((actual - predicted) ** 2)))


def mape(actual: np.ndarray, predicted: np.ndarray) -> float | None:
    """Undefined when any actual is zero; returns ``None`` rather than ``inf`` or a fudge."""
    nonzero = actual != 0
    if not np.any(nonzero):
        return None
    return float(np.mean(np.abs((actual[nonzero] - predicted[nonzero]) / actual[nonzero])) * 100)


def wape(actual: np.ndarray, predicted: np.ndarray) -> float:
    """Total absolute error as a share of total actual demand."""
    denominator = float(np.sum(np.abs(actual)))
    if denominator == 0:
        # A period with no demand at all: any non-zero forecast is infinitely wrong in relative
        # terms, so fall back to absolute error to keep the comparison meaningful.
        return float(np.sum(np.abs(predicted)))
    return float(np.sum(np.abs(actual - predicted)) / denominator * 100)


# ---------------------------------------------------------------------------
# Walk-forward validation and selection
# ---------------------------------------------------------------------------


def _fold_boundaries(n: int, horizon: int, max_folds: int) -> list[int]:
    """Cut points for an expanding window, leaving at least a third of the series for training."""
    min_train = max(int(n * 0.35), MIN_HISTORY["MOVING_AVERAGE"])
    usable = n - min_train
    if usable < horizon:
        return []

    possible = usable // horizon
    folds = min(possible, max_folds)
    if folds <= 0:
        return []
    return [n - (folds - i) * horizon for i in range(folds)]


def evaluate_models(
    series: pd.Series,
    horizon: int,
    candidates: Sequence[ModelName],
    *,
    seasonal_period: int = DEFAULT_SEASONAL_PERIOD,
    max_folds: int = 4,
) -> list[ModelEvaluation]:
    """Score every eligible candidate by walk-forward validation."""
    values = series.to_numpy(dtype=float)
    n = values.size
    start_date = series.index[0] if isinstance(series.index, pd.DatetimeIndex) else None

    # Validate at a horizon no longer than the data can support; a 180-day validation fold on a
    # 200-day series would leave nothing to train on.
    validation_horizon = max(1, min(horizon, max(1, n // 5)))
    boundaries = _fold_boundaries(n, validation_horizon, max_folds)

    evaluations: list[ModelEvaluation] = []

    for name in candidates:
        required = MIN_HISTORY.get(name, 2)
        if n < required:
            evaluations.append(
                ModelEvaluation(
                    name,
                    skipped_reason=(
                        f"needs at least {required} observations, series has {n}"
                    ),
                )
            )
            continue

        if not boundaries:
            evaluations.append(
                ModelEvaluation(
                    name,
                    skipped_reason="series too short to hold out a validation fold",
                )
            )
            continue

        fold_actuals: list[np.ndarray] = []
        fold_predictions: list[np.ndarray] = []

        for cut in boundaries:
            train = values[:cut]
            actual = values[cut : cut + validation_horizon]
            if actual.size == 0:
                continue

            predicted = _forecast_with(
                name,
                train,
                actual.size,
                seasonal_period=seasonal_period,
                start_date=start_date,
            )
            fold_actuals.append(actual)
            fold_predictions.append(predicted)

        if not fold_actuals:
            evaluations.append(ModelEvaluation(name, skipped_reason="no usable validation fold"))
            continue

        actual_all = np.concatenate(fold_actuals)
        predicted_all = np.concatenate(fold_predictions)

        evaluations.append(
            ModelEvaluation(
                model=name,
                mae=mae(actual_all, predicted_all),
                rmse=rmse(actual_all, predicted_all),
                mape=mape(actual_all, predicted_all),
                wape=wape(actual_all, predicted_all),
                folds=len(fold_actuals),
            )
        )

    return evaluations


def _forecast_with(
    name: ModelName,
    history: np.ndarray,
    horizon: int,
    *,
    seasonal_period: int,
    start_date: pd.Timestamp | None,
) -> np.ndarray:
    forecaster = FORECASTERS[name]

    if name == "MOVING_AVERAGE":
        # Pick the window on the training data alone, so window choice cannot see the fold.
        window = _best_moving_average_window(history)
        return forecaster(history, horizon, window=window)

    return forecaster(
        history,
        horizon,
        period=seasonal_period,
        start_date=start_date,
    )


def _best_moving_average_window(history: np.ndarray) -> int:
    """Choose w by one-step-ahead error on the training data only."""
    best_window, best_error = MOVING_AVERAGE_WINDOWS[0], float("inf")
    for window in MOVING_AVERAGE_WINDOWS:
        if history.size <= window + 1:
            continue
        rolled = pd.Series(history).rolling(window).mean().shift(1).to_numpy()
        mask = ~np.isnan(rolled)
        if not np.any(mask):
            continue
        error = float(np.mean(np.abs(history[mask] - rolled[mask])))
        if error < best_error:
            best_window, best_error = window, error
    return best_window


def select_model(evaluations: Sequence[ModelEvaluation]) -> ModelName:
    """Lowest WAPE wins; ties and total failure fall back to the cheapest usable model."""
    scored = [e for e in evaluations if e.skipped_reason is None and np.isfinite(e.wape)]
    if not scored:
        usable = [e for e in evaluations if e.skipped_reason is None]
        return usable[0].model if usable else "NAIVE"

    # Sort by error, then by position in ALL_MODELS so a tie prefers the simpler model.
    order = {name: index for index, name in enumerate(ALL_MODELS)}
    scored.sort(key=lambda e: (round(e.wape, 6), order.get(e.model, 99)))
    return scored[0].model


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def forecast_demand(
    history: Sequence[dict],
    horizon_days: int,
    *,
    candidate_models: Sequence[ModelName] | None = None,
    seasonal_period: int | None = None,
) -> ForecastResult:
    """Clean, compare, select, refit on everything, and forecast forward."""
    cleaned = clean_demand_history(history)
    if not cleaned.passed:
        return ForecastResult(
            points=[],
            selected_model="NAIVE",
            evaluations=[],
            residual_std=float("nan"),
            cleaned=cleaned,
            reasons=["Forecast refused: the demand history failed data-quality validation."],
            assumptions=[],
        )

    series = cleaned.series
    period = seasonal_period or DEFAULT_SEASONAL_PERIOD
    candidates = list(candidate_models or ALL_MODELS)

    evaluations = evaluate_models(series, horizon_days, candidates, seasonal_period=period)
    winner = select_model(evaluations)
    for evaluation in evaluations:
        evaluation.selected = evaluation.model == winner

    values = series.to_numpy(dtype=float)
    start_date = series.index[0] if isinstance(series.index, pd.DatetimeIndex) else None

    # Refit on the complete history — validation was for choosing, not for the final model.
    predictions = _forecast_with(
        winner, values, horizon_days, seasonal_period=period, start_date=start_date
    )
    predictions = np.maximum(predictions, 0.0)

    residual_std = _residual_std(values, winner, period, start_date)

    last_date = series.index[-1]
    points: list[ForecastPoint] = []
    for step, value in enumerate(predictions, start=1):
        # Uncertainty grows with the square root of the horizon: errors accumulate like a random
        # walk, so day 30 is genuinely less certain than day 1 and the band must say so.
        spread = INTERVAL_Z * residual_std * np.sqrt(step)
        point_date = (last_date + timedelta(days=step)).strftime("%Y-%m-%d")
        points.append(
            ForecastPoint(
                date=point_date,
                demand=round(float(value), 2),
                lower_bound=round(float(max(value - spread, 0.0)), 2),
                upper_bound=round(float(value + spread), 2),
            )
        )

    return ForecastResult(
        points=points,
        selected_model=winner,
        evaluations=evaluations,
        residual_std=round(float(residual_std), 4),
        cleaned=cleaned,
        reasons=_build_reasons(winner, evaluations, series, residual_std),
        assumptions=_build_assumptions(winner, period, horizon_days, cleaned),
    )


def _residual_std(
    values: np.ndarray, model: ModelName, period: int, start_date: pd.Timestamp | None
) -> float:
    """One-step-ahead in-sample residual spread — the basis of the prediction interval."""
    if values.size < 3:
        return float(np.std(values)) or 1.0

    residuals: list[float] = []
    start = max(MIN_HISTORY.get(model, 2), int(values.size * 0.5))
    for index in range(start, values.size):
        predicted = _forecast_with(
            model, values[:index], 1, seasonal_period=period, start_date=start_date
        )[0]
        residuals.append(float(values[index] - predicted))

    if len(residuals) < 2:
        return float(np.std(values)) or 1.0

    spread = float(np.std(residuals, ddof=1))
    # A zero spread would produce a zero-width interval, which is never honest.
    return spread if spread > 0 else max(float(np.std(values)) * 0.1, 0.5)


def _build_reasons(
    winner: ModelName,
    evaluations: Sequence[ModelEvaluation],
    series: pd.Series,
    residual_std: float,
) -> list[str]:
    reasons = []
    scored = [e for e in evaluations if e.skipped_reason is None and np.isfinite(e.wape)]

    if scored:
        best = next(e for e in scored if e.model == winner)
        reasons.append(
            f"{winner} was selected on walk-forward validation with WAPE {best.wape:.2f}% "
            f"over {best.folds} fold(s)."
        )
        runners = sorted(
            (e for e in scored if e.model != winner), key=lambda e: e.wape
        )[:2]
        for runner in runners:
            reasons.append(f"{runner.model} scored WAPE {runner.wape:.2f}% and was not selected.")
    else:
        reasons.append(
            f"No model could be validated on this series; falling back to {winner}. "
            "Treat the numbers as indicative until more history accumulates."
        )

    skipped = [e for e in evaluations if e.skipped_reason]
    if skipped:
        reasons.append(
            "Not evaluated: "
            + "; ".join(f"{e.model} ({e.skipped_reason})" for e in skipped)
            + "."
        )

    daily_mean = float(series.mean())
    if daily_mean > 0:
        reasons.append(
            f"Mean historical demand {daily_mean:.1f}/day with a one-step residual spread of "
            f"{residual_std:.1f} units."
        )
    return reasons


def _build_assumptions(
    winner: ModelName, period: int, horizon: int, cleaned: CleanedSeries
) -> list[str]:
    assumptions = [
        "History is treated as a daily series; missing days are zero demand, not interpolated.",
        f"Seasonality is assumed to have a period of {period} days.",
        f"Prediction intervals are {INTERVAL_CONFIDENCE_PERCENT}% bands built from the "
        "one-step-ahead residual spread, widened by the square root of the horizon.",
        f"The forecast extends {horizon} day(s); no exogenous driver (price, promotion, holiday) "
        "is used unless it is already reflected in the historical demand.",
    ]
    if winner == "GRADIENT_BOOSTING":
        assumptions.append(
            "Boosted forecasts are produced recursively, so an early error propagates into "
            "later days of the horizon."
        )
    if winner == "SEASONAL_NAIVE":
        assumptions.append(
            "Seasonal naive assumes next week repeats last week; a level shift will not be "
            "picked up until it has been observed for a full period."
        )
    assumptions.extend(
        f"Data quality: {issue.message}"
        for issue in cleaned.report.issues
        if issue.severity != "INFO"
    )
    return assumptions


def _finite(value: float) -> float | None:
    return None if value is None or not np.isfinite(value) else round(float(value), 4)
