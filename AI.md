# AI, models and optimisation

Every endpoint returns its numbers **and** an `explanation` block — `summary`, `reasons`,
`assumptions`. That is enforced by the response models, not by convention: there is no code path
that returns a recommendation without one, and the `Recommendation` dataclass has no default for
`reasons`, so one cannot be constructed without justification.

Where a number rests on a modelling assumption, the response says so. An ETA that does not admit
it assumed a road-winding factor is an ETA nobody can argue with, and one nobody can argue with is
one nobody should trust.

---

## 1. ETA engine — `apps/api/src/modules/eta/eta-engine.ts`

Deterministic and in the API rather than the AI service, so a shipment always has an ETA even when
the AI service is down.

```
remaining_km   route polyline when there is one, otherwise great-circle × winding factor
v_base         w·v_observed + (1−w)·v_prior       w = n/(n+5), n = moving GPS samples
v_effective    v_base × traffic × weather × night
duration       remaining_km / v_effective + remaining scheduled stops
```

Multipliers: full gridlock is modelled as a 50 % speed loss, worst weather as 35 %, night driving
as a 5 % *gain* (less traffic, more caution). These are stated priors, not measurements, and
appear in every response's assumptions.

**Uncertainty is propagated, not invented.** Duration is inversely proportional to speed, so a
relative speed error maps to roughly the same relative duration error, and the window is
`duration × (1 ± z·cv)` at z = 1.2816 (80 %). Observation shrinks it — the more of the trip we have
actually watched, the less the prior's spread matters — but never to zero, because the road ahead
is still unobserved.

**Stationary fixes are excluded from the speed mean.** Including them conflates "stopped" with
"slow" and produces an ETA that keeps sliding.

**Lateness uses the window, not the point estimate.** Five minutes past the promise with a two-hour
window is not news; the same five minutes with a ten-minute window is. A shipment flips to
`DELAYED` only when even the optimistic end of the window misses.

---

## 2. Delay prediction — `services/ai/app/engines/delay.py`

Two modes, and the response always names the one that produced the number.

**Scorecard (cold start).** A new deployment has no labelled shipments. Rather than ship a model
trained on nothing, the engine evaluates a logistic scorecard whose coefficients are published in
every response:

```
logit(p) = β₀ + Σ βᵢ·xᵢ        β₀ = logit(0.18), the road-freight base late rate
```

| Feature | β | Rationale |
|---|---|---|
| carrier unreliability | 2.60 | the strongest signal available |
| speed shortfall | 1.80 | already behind the plan — observation, not forecast |
| traffic congestion | 1.10 | |
| weather severity | 0.95 | |
| route incident rate | 0.80 | |
| supplier unreliability | 0.70 | ships late ⇒ the leg starts late |
| distance (per 1000 km) | 0.55 | more distance, more chances to slip |
| intermediate stops | 0.40 | |
| unsocial departure | 0.35 | |
| weekend departure | 0.25 | |

**Learned.** Given 30+ labelled shipments with at least 5 of each class, a
`HistGradientBoostingClassifier` is fitted and attribution is done by ablation — reset each feature
to its benign value, measure the change. Below those thresholds the scorecard is used and the
response says why: a classifier fitted on three late shipments predicts confident nonsense.

---

## 3. Anomaly detection — `services/ai/app/engines/anomaly.py`

Rule-based on purpose. A learned detector needs labelled anomalies a new deployment does not have;
it would start useless and stay useless until somebody hand-labelled hundreds of incidents. These
rules encode what a dispatcher already knows, fire on day one, and state the threshold they
crossed so an operator can argue with them.

| Detector | Fires when | Default |
|---|---|---|
| `PROLONGED_STOP` | speed ≤ 3 km/h for longer than tolerance | 45 min |
| `ROUTE_DEVIATION` | lateral distance from the corridor | 2 km |
| `ABNORMAL_SPEED` | ≥ 3 fixes above the vehicle's limit | 110 km/h |
| `GPS_LOSS` | gap between consecutive fixes | 30 min |
| `EXCESSIVE_DURATION` | elapsed beyond planned duration | — |
| `SUSPICIOUS_DELIVERY` | proof captured far from the destination | 1 km |

Two decisions that make the output usable rather than noisy:

- **Route deviation emits one alert for the worst point**, not one per off-corridor fix. A truck
  that leaves the corridor produces dozens; the useful signal is "it went 40 km off, here".
- **Overspeed needs three fixes to agree.** A single 130 km/h reading is GPS noise; three in a row
  is a driver.

`score` measures how far past the threshold an observation sits, saturating at a multiple of it.
It is for ranking alerts against each other, not a probability, and the response says so.

---

## 4. Demand forecasting — `services/ai/app/engines/forecasting.py`

Six models, cheapest first: `NAIVE`, `SEASONAL_NAIVE`, `MOVING_AVERAGE`,
`EXPONENTIAL_SMOOTHING`, `HOLT_WINTERS`, `GRADIENT_BOOSTING`. Each declares a minimum history and
is skipped with a stated reason below it.

**Validation is walk-forward with an expanding window.** Fit on everything up to *t*, predict the
next *h* days, roll forward, repeat. A random train/test split would leak the future into the past
and flatter every model — catastrophically so for the ones with lag features.

**Selection is by WAPE, not MAPE.** MAPE divides by the actual, so one zero-demand day makes it
infinite and a few low-demand days make it meaningless — and zero-demand days are the norm for
anything slow-moving. WAPE (total absolute error ÷ total actual) is defined whenever the period had
any demand, and it weights a big miss on a big day above a big *relative* miss on a quiet one,
which is what a planner cares about. Ties prefer the simpler model.

**Intervals widen with √h.** Errors accumulate like a random walk, so day 30 is genuinely less
certain than day 1 and the band must say so.

**Performance.** Residual spread is the basis of the interval, and the honest computation is a
rolling one-step refit. Doing that at every origin of a two-year series took 19 s and timed out the
API's client. It is now bounded: 60 sampled origins for cheap models, 16 for Holt-Winters, and a
**single-fit holdout** for the boosted model — fit once on 80 %, predict each held-out day one step
ahead using its *true* lags. Those are genuine out-of-sample one-step residuals; recursive error
compounding does not apply to a one-step residual, so nothing is lost. 19 s → 3.6–5.5 s.

---

## 5. Inventory policy — `services/ai/app/engines/inventory.py`

Textbook (Silver–Pyke–Peterson, Chopra–Meindl) rather than invented, because planners already
reason about these formulas and a bespoke heuristic is impossible to defend in a review.

```
σ_LTD = √( L·σ_d²  +  d̄²·σ_L² )
SS    = z(SL) · σ_LTD
ROP   = d̄·(L + review period) + SS
EOQ   = √( 2·D·S / H )
```

**Both variabilities are carried.** The common mistake is sizing the buffer from demand
variability alone, but the lead-time term is usually larger: a supplier swinging between 3 and 20
days hurts far more than daily demand wobbling by 10 %. The response reports **which term
dominates**, so a planner knows whether to fix the forecast or the supplier.

**Decisions are made on inventory position**, not on-hand: free stock minus reservations plus what
is already on order. Using on-hand alone is the classic double-ordering bug — reorder on Monday,
again on Tuesday, flood the warehouse on Friday.

**Stockout probability is computed against the actual projected position**, not assumed to be
1 − SL. The service level is what the policy aims for; the number a planner needs is the risk given
what is really on the shelf.

Stated assumptions: lead-time demand is approximated as normal (weak for slow movers — flagged when
mean daily demand < 1); demand and lead time are assumed independent (when supplier delays are
*caused* by demand surges they correlate and this underestimates the buffer); holding cost defaults
to 25 %/year of unit cost when not supplied.

---

## 6. Supplier scoring — `services/ai/app/engines/supplier.py`

Six criteria (price, reliability, lead time, quality, capacity, distance), min-max normalised
across the candidate set, oriented so higher is always better, then weighted. Weights are
configurable and normalised to sum to 1.

**Min-max rather than z-scores**, because the output has to be explainable to a buyer: "cheapest
gets 1.0, dearest gets 0.0, you are 0.6 of the way down" is a sentence a human can check. A z-score
is not. The cost is sensitivity to one outlier candidate, which is why the response reports both
the normalised and the weighted contribution of every criterion — an odd ranking can be traced to
the term that caused it.

A criterion on which every candidate is identical is neutralised to 1.0 for all, so it drops out
instead of dividing by a zero range. A supplier with no recorded distance scores at the midpoint
rather than being penalised, so missing master data does not masquerade as a disadvantage.

**Separate from the reliability score in the API**, which answers "how has this supplier behaved?"
from purchase-order history, with confidence shrinkage `n/(n+5)` toward a 0.85 prior so one late
delivery out of two does not brand a new supplier as 50 % reliable.

---

## 7. Multi-supplier allocation (MILP) — `services/ai/app/engines/allocation.py`

```
variables   xᵢ ≥ 0 units from supplier i      yᵢ ∈ {0,1} supplier used      u ≥ 0 unmet

minimise    Σᵢ [ pᵢ·xᵢ + t·dᵢ·xᵢ + h·Lᵢ·xᵢ + δ·max(0, Lᵢ−D)·xᵢ + ρ·(1−rᵢ)·xᵢ ] + σ·u

subject to  Σᵢ xᵢ + u = demand
            xᵢ ≤ capacityᵢ·yᵢ            capacity, and links x to y
            xᵢ ≥ moqᵢ·yᵢ                 minimum order quantity when used
            Σᵢ pᵢ·xᵢ ≤ budget
            xᵢ ≤ maxShare · demand
```

**Why a solver and not a score.** Minimum order quantity is a genuine disjunction — "order at least
5 000 units, *or* nothing at all". No weighted scoring expresses that. It needs a binary variable
and a big-M linking constraint, which is exactly what a MILP solver is for. OR-Tools' CBC backend
handles this size in single-digit milliseconds.

**Unmet demand is a priced variable, not an infeasibility.** A model that goes infeasible when
suppliers cannot cover demand tells a buyer nothing. Pricing the shortfall makes the solver reveal
*how much* is uncoverable and what it costs — which is the actual decision.

**The risk term is linear in quantity** — `ρ·(1−rᵢ)·xᵢ` prices each unit by its supplier's failure
probability. This treats failures as independent per unit, whereas a real supplier failure is
usually all-or-nothing for the whole order. The linear form keeps the problem an MILP rather than
pushing it into stochastic programming, and the concentration limit is the blunt instrument that
covers the correlated case. Both facts are in the response's assumptions.

---

## 8. Vehicle routing — `services/ai/app/engines/routing.py`

CVRPTW via OR-Tools: capacity, delivery time windows, service times, maximum driving time.
Parallel cheapest insertion for a first solution, then guided local search to the time limit.

**Status is reported `FEASIBLE`, not `OPTIMAL`.** The search stops on a time limit, not on a proof.
Claiming optimality would be a lie.

**Stops may be dropped at a heavy penalty**, so an over-subscribed fleet returns the best partial
plan and names what it could not serve, instead of failing outright.

Units are integers because the routing library requires it: metres for distance, seconds/minutes
for time, demand scaled ×1000 so fractional quantities survive.

---

## 9. Scenario simulation — `services/ai/app/engines/scenario.py`

Monte Carlo over a periodic-review inventory system. Closed forms exist for the simple case, but
the questions asked — demand +20 % *and* supplier +5 days *and* fuel +30 % — interact non-linearly
through the stockout logic.

**The policy is derived once from the baseline and held fixed while conditions vary.** This caught
a real bug during testing: re-optimising each case let the worst case adopt a *better-tuned* policy
than the base and come out with a **lower** stockout risk — the opposite of what a what-if asks. A
what-if asks "given the policy I run today, what happens if conditions worsen?"

Best and worst stretch each supplied lever by ±50 % of its own magnitude, so the spread reflects
how uncertain the inputs actually are rather than an invented range. A lever left at zero produces
no spread. Runs are seeded: the same question returns the same answer.

---

## 10. Risk and health score — `services/ai/app/engines/risk.py`

```
score  = probability × (impact / max impact in this run) × 100
health = 100 − Σ (weight_c × severity_c)
```

Weights: stockout 30, supplier 25, transport 20, demand 15, geopolitical 5, weather 5.

**Health subtracts penalties from 100 rather than averaging category scores.** Averaging lets one
catastrophic category be diluted by four healthy ones — exactly the case where the warning matters
most. Within a category the worst finding dominates and the rest add a diminishing amount, so a
long tail of minor issues cannot outweigh one severe problem.

Impact is normalised against the largest impact **in the same run**, which makes scores comparable
inside one analysis and explicitly *not* across analyses. The response says so.

---

## 11. Recommendation engine — `services/ai/app/engines/recommendations.py`

Nine types: `ORDER_NOW`, `SPLIT_ORDER`, `WAIT`, `CHANGE_SUPPLIER`, `ADD_SUPPLIER`,
`INCREASE_SAFETY_STOCK`, `REDUCE_INVENTORY`, `CHANGE_ROUTE`, `EXPEDITE_SHIPMENT`.

Every recommendation carries a machine-readable `payload` the API can execute. Accepting an
`ORDER_NOW` raises a real draft purchase order; `INCREASE_SAFETY_STOCK` writes the policy;
`REDUCE_INVENTORY` caps the maximum stock level. Types with no automatable action say so rather
than pretending to have acted.

Priority is driven by **time pressure first, money second** — a 200-unit stockout tomorrow outranks
a 50 000-unit inefficiency next quarter, because the first is unrecoverable and the second is still
negotiable.

`EXPEDITE_SHIPMENT` is the loop in miniature: a shipment with ≥ 50 % delay probability carrying a
product with ≤ 10 days of cover is flagged critical, because the delay would become a stockout
rather than merely a late delivery.

---

## Data quality gate — `services/ai/app/engines/data_quality.py`

Nothing is modelled on data that has not passed here first.

| Severity | Meaning |
|---|---|
| `INFO` | worth knowing, changes nothing |
| `WARNING` | repaired (gap filled, duplicate collapsed) and reported |
| `BLOCKING` | refuses to produce numbers at all |

Blocking: fewer than 14 observations, more than 50 % of days missing, no usable date or quantity.
Warnings: unparseable dates, future dates, negative quantities (clipped — usually a return posted
against sales), duplicate dates (summed), gaps (zero-filled), outliers beyond 6 robust σ (kept — a
genuine spike is signal).

**Gaps are zero-filled, not interpolated.** A day with no sales is a day with zero demand.
Interpolating invents sales that never happened and understates exactly the variance that safety
stock is computed from.

A pipeline that blocks on any imperfection is unusable; one that blocks on nothing produces
confident forecasts from nonsense. The three levels are the line between those.

---

## Accuracy monitoring

Every AI call lands in `ai_predictions` with input, output, model version, latency and confidence.
Once ground truth exists the stored prediction can be scored against it.

`GET /analytics/ai-accuracy` reports ETA error measured against **real arrivals** — mean absolute
error in minutes and the share within 30 minutes — not self-reported confidence. When no shipment
has both an ETA and an actual arrival it says accuracy is not measurable rather than reporting
zero.
