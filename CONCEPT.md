# SCIP — the concept, and the truth about the AI

> English version. Version française : [CONCEPT.fr.md](CONCEPT.fr.md).

Three questions, in order:

1. **What is the idea?**
2. **Where exactly does AI come in?**
3. **How was that AI trained?** — and the honest answer is more nuanced than "I trained it". It
   gets its own section, because that is where most product write-ups start lying.

---

## 1. The idea

Most supply-chain tools answer **"where is my cargo?"**. A few answer **"what should I order?"**.
Almost none connect the two — and the connection is where the value is.

A concrete example, the one the system actually runs:

```
14:02  Supplier A's truck loses two days on the road.
       → SCIP notices: the recomputed ETA misses the promise even at the
         optimistic end of its window. The shipment flips to DELAYED.

14:02  A durable event is written: shipment.delayed

14:02  The worker consumes it. It knows which products are on board.
       → Stockout risk for those SKUs is recomputed: 68 %.

14:03  The recommendation engine emits:
         "Order 3 000 units from Supplier C"
       with its reasoning, its cost, and its assumptions.

14:10  A human accepts.
       → A real draft purchase order exists and is tracked.
```

Not a slide. That is the code path, and it is verifiable from the UI in about three minutes — see
"Verify it yourself" in the [README](README.md).

### Two contexts, one product

| Context | Question | Scope |
|---|---|---|
| **TRACK** | Where is it, and will it be late? | suppliers, purchase orders, shipments, GPS, **vessels/AIS**, warehouses, inventory, deliveries, incidents |
| **OPTIMIZE** | What to order, from whom, when, by which route? | forecasting, inventory policy, supplier scoring, allocation, routing, scenarios, risk, recommendations |

The two original briefs shared roughly 70 % of their data model. Building them separately would
have meant duplicating it and writing a sync layer between two databases — for no benefit, while
destroying exactly the loop that makes it worth building.

### Land and sea

A container does not travel by truck end to end. It takes a road leg, an ocean leg, another road
leg. The system models both, differently, because they *are* different:

- **A truck is yours.** You bolt a tracker to it and it posts to your API.
- **A ship is not yours.** You booked forty TEU on it. You cannot install anything on it. But it
  continuously broadcasts its position over **AIS**, the collision-avoidance radio every commercial
  vessel over 300 GT is legally required to transmit.

Hence two tracking mechanisms, and vessel search by **name, IMO, MMSI or call sign** — because a
shipper holding a bill of lading has *one* identifier and does not know which kind it is.

---

## 2. Where the AI is — precisely

The full map. Each row states honestly what the thing actually is.

| Feature | What it really is | Trained? |
|---|---|---|
| **Demand forecasting** | supervised ML + classical statistics | **Yes** — per request, on your data |
| **Delay probability** | logistic scorecard *or* gradient boosting | **Conditional** — see §3 |
| **Anomaly detection** | codified expert rules | **No** — never trained |
| **ETA engine** | physics + uncertainty propagation | **No** — formula |
| **Safety stock / reorder point** | statistics (Silver–Pyke–Peterson) | **No** — closed form |
| **Supplier scoring** | weighted min-max normalisation | **No** — chosen weights |
| **Multi-supplier allocation** | **MILP** — mixed-integer programming | **No** — exact solver |
| **Route optimisation** | **CVRPTW** — guided local search | **No** — heuristic solver |
| **Scenario simulation** | **Monte Carlo** | **No** — sampling |
| **Risk engine** | probability × impact scoring | **No** — chosen weights |
| **Recommendation engine** | orchestration of the above | **No** — business logic |

### What that means

Of eleven so-called "AI" features, **one** is machine learning in the strict and systematic sense
(forecasting), **one** is conditionally (delay), and **nine** are operations research, statistics
or expert rules.

That is deliberate, and I will defend it.

**Why not learn everything?** Because learning needs labelled data a fresh deployment does not
have. A learned anomaly detector would need several hundred hand-annotated incidents: it would
start useless and stay useless for months. Codified rules fire on day one and state the threshold
they crossed, so an operator can argue with them. That is a better product, not a compromise.

**Why a solver rather than a model for allocation?** Because a minimum order quantity is a
*disjunction*: "order at least 5 000 units, **or** nothing at all". No weighted score expresses
that. It needs a binary variable and a big-M constraint — exactly what a MILP solver is for. A
neural network approximating that constraint would violate it sometimes, and a contractual
constraint violated "sometimes" is not a constraint.

**Where is learning genuinely the right tool?** Where there is abundant history, a non-trivial
signal, and ground truth that arrives on its own. Demand ticks all three: two years of daily
sales, real seasonality, and tomorrow tells you whether you were right. That — and only that — is
where the forecasting learns.

---

## 3. How was the AI trained?

**Short answer: no pre-trained model ships with this product.** I did not train anything on an
external corpus and ship weights. There is no weights file in this repository.

What exists falls into three very different categories.

### 3.1 — Models fitted at request time, on *your* data

This is the only genuine supervised learning in the system, and it is **demand forecasting**.

**Training data.** The daily demand history of the product in question, read from
`demand_history` — that is, *your* sales, not mine. No external data is involved.

**Target.** Next day's demanded quantity.

**What is fitted.**

| Model | What is learned | How |
|---|---|---|
| `NAIVE` | nothing | baseline: tomorrow equals today |
| `SEASONAL_NAIVE` | nothing | tomorrow equals the same weekday last week |
| `MOVING_AVERAGE` | the window *w* | chosen by one-step error on the training data alone |
| `EXPONENTIAL_SMOOTHING` | the level | α recursion, α = 2/(w+1) with w = 7 |
| `HOLT_WINTERS` | level, trend, seasonality | maximum likelihood (statsmodels) |
| `GRADIENT_BOOSTING` | ~200 decision trees | `HistGradientBoostingRegressor` on lags 1,2,3,7,14,28 d + rolling means + calendar features |

**Validation protocol.** Walk-forward with an expanding window: fit on everything up to *t*,
predict the next *h* days, roll forward, repeat. Never a random split — that leaks the future into
the past and flatters every model, catastrophically so for the ones with lag features.

**Selection criterion.** **WAPE**, not MAPE. MAPE divides by the actual: one zero-demand day makes
it infinite, and zero-demand days are the norm for anything slow-moving. On a tie the simpler model
wins.

**Measured result** on the demo data (synthetic series with trend + weekly rhythm + annual season):

```
HOLT_WINTERS          WAPE 24.13    ← selected
GRADIENT_BOOSTING     WAPE 24.72
SEASONAL_NAIVE        WAPE 25.74
MOVING_AVERAGE        WAPE 27.07
EXPONENTIAL_SMOOTHING WAPE 28.11
NAIVE                 WAPE 29.38
```

Note that gradient boosting **loses** to Holt-Winters. That is the normal outcome on a short noisy
series, and it is precisely why the comparison exists: it stops a complex model shipping when it
performs worse than a moving average.

**Persistence.** Models are not persisted between calls. They are refitted per request (3.6–5.5 s
for six models over two years of history). That is a choice: the data changes daily, a cached model
would be stale, and the cost is acceptable at this scale. The `model_versions` and `model_metrics`
tables exist for the day volume demands otherwise.

### 3.2 — A model that trains *if* you give it something to learn from

**Delay prediction** has two modes, and the response always names the one that produced the number.

**Scorecard mode (cold start) — NOT trained.** A fresh deployment has no labelled shipments.
Rather than ship a model trained on nothing, the engine evaluates a logistic scorecard whose
**coefficients are published in every response**:

```
logit(p) = β₀ + Σ βᵢ·xᵢ        β₀ = logit(0.18) = road-freight base late rate
```

| Factor | β | Origin |
|---|---|---|
| carrier unreliability | 2.60 | domain knowledge |
| observed speed shortfall | 1.80 | domain knowledge |
| traffic congestion | 1.10 | domain knowledge |
| weather severity | 0.95 | domain knowledge |
| corridor incident history | 0.80 | domain knowledge |
| supplier unreliability | 0.70 | domain knowledge |
| distance (per 1 000 km) | 0.55 | domain knowledge |
| intermediate stops | 0.40 | domain knowledge |
| unsocial departure | 0.35 | domain knowledge |
| weekend departure | 0.25 | domain knowledge |

**These coefficients are not learned. I chose them.** They encode ordinary freight reasoning — a
carrier late a third of the time is the strongest signal available — and the intercept is
calibrated so a completely unremarkable shipment predicts the observed industry base rate. It is a
**stated prior**, not a fit, and the response says so in its `assumptions` block.

**Learned mode.** Given **≥ 30 labelled shipments with at least 5 of each class**, a
`HistGradientBoostingClassifier` is fitted on that data and replaces the scorecard. Attribution is
by ablation: reset each feature to its benign value and measure how far the prediction moves.

Below those thresholds training is **refused** and the reason is returned. A classifier fitted on
three late shipments predicts confident nonsense, which is worse than predicting nothing.

### 3.3 — What is not trained at all, and why

| Component | Hand-set values | Why not learned |
|---|---|---|
| **Anomaly rules** | stop > 45 min, deviation > 2 km, overspeed on ≥ 3 fixes, GPS gap > 30 min | no labelled anomalies exist on day 1; rules work immediately and state their threshold |
| **ETA multipliers** | full gridlock = −50 % speed, worst weather = −35 %, night = +5 % | stated priors, published in every response; replaceable by a real weather/traffic provider |
| **Supplier scoring weights** | price 30, reliability 25, lead time 20, quality 15, capacity 5, distance 5 | these are **commercial preferences**, not facts to discover; configurable per request |
| **Risk weights** | stockout 30, supplier 25, transport 20, demand 15, geopolitical 5, weather 5 | same: this is the company's risk appetite |
| **Safety stock** | z(SL)·σ_LTD | classical statistics, defensible in review; a bespoke heuristic would not be |

One thing worth saying plainly: **calling this whole system "AI" would be overselling it**. The
honest label is *operations research + statistics + supervised learning where it is warranted*. I
kept "AI" in the service names because it is the brief's vocabulary, but the technical
documentation ([AI.md](AI.md)) spells out every formula and assumption so nobody is misled.

### 3.4 — Supplier scoring: validated against ground truth

One case deserves attention, because it shows how you *prove* a calculation works.

The supplier reliability score is not entered by hand — it is **derived from purchase-order
history**. The demo generator creates each supplier from a known profile (Supplier C: 97 % on-time,
lead time 3 d ± 0.6), then generates 301 purchase orders whose delivery dates are drawn from *that
supplier's own distribution*.

The platform then reads that history back and recomputes the score, through the same code path the
production API uses. The result:

```
SUP-C  Tema Port Distributors    measured 96.9 %   (generated from 97 %)
SUP-A  Volta Grain Cooperative   measured 94.8 %   (generated from 92 %)
SUP-D  Ashanti Wholesale Group   measured 89.3 %   (generated from 86 %)
SUP-B  Sahel Commodities Ltd     measured 79.2 %   (generated from 75 %)
SUP-E  Abidjan Import Partners   measured 74.2 %   (generated from 70 %)
```

The calculation recovers a truth it was never told. That is the kind of check that separates a
computed number from an invented one — and it only worked *after* fixing a real bug: the first
version set the promised date at the *mean* of the supplier's distribution, making every supplier
late half the time by construction, and all five measured ~50 %.

### 3.5 — On the demo data

Everything shipped is **synthetic and labelled as such**: `isDemoData` on every row, `isSimulated`
on every GPS fix, `source: SIMULATOR` on every vessel position. The UI badges them and analytics
report how much of a figure is synthetic.

It is generated by a seeded PRNG (mulberry32, seed 20260813), so it is reproducible: a demo whose
numbers move without a code change makes it impossible to tell a regression from a dice roll.

It is also **statistically coherent**, not random: trend, weekly rhythm, annual season, occasional
promotions. That matters — a random dataset produces a system that *looks* populated and behaves
like nonsense: forecasting picks the naive model for lack of signal, safety stock explodes because
the variance means nothing, and supplier scores are noise.

**Vessels are fictional, ports are real.** Ports carry their real UN/LOCODEs and real coordinates,
because a misplaced Rotterdam would break every distance calculation. Vessels have **invented**
names and IMO numbers (with a valid check digit, but matching no existing hull): putting a real IMO
on a synthetic vessel would mean that the moment someone enables an AIS key, broadcasts from an
actual ship would merge into an imaginary voyage.

---

## 4. How to train properly with real data

If you point this at a real operation, here is what improves and how.

**Forecasting** — works immediately. It needs 14 days of history minimum, 3 months for seasonal
naive to mean anything, and 4 months (120 points) before gradient boosting is even offered. No
action from you: it fits on whatever `demand_history` contains.

**Delay prediction** — switches to learned mode once you have 30 delivered shipments. In practice:
run tracking for two or three months, then pass the labelled history in `trainingHistory`. The
switch from scorecard to fitted model is visible in the response's `model.name`.

**Anomaly detection** — would stay rule-based, but the *thresholds* should be calibrated to your
corridors: a 45-minute stop is normal at a border post and abnormal on a trunk road. Those
thresholds are already request parameters.

**Weather and traffic** — replace the stubs. `OPENWEATHER_API_KEY` and a traffic provider feed
straight into the ETA engine and the delay scorecard, which today use neutral values and say so.

**Road distances** — `OSRM_URL` replaces the great-circle × 1.25 approximation with real road
distances. It is the one approximation in the system that can be tens of kilometres wrong on a
winding route.

**Vessel positions** — `AISSTREAM_API_KEY` (free) switches maritime tracking to real global AIS.
The simulator stops automatically: mixing real and invented positions for the same vessel would
produce a track nobody could untangle.

---

## 5. What I did not do, and do not claim to have done

- I did **not** train a large model, or fine-tune anything.
- I did **not** use an LLM at runtime. No text-generation API call happens in this product.
  Explanations are composed by code from the computed numbers, which guarantees they describe the
  actual calculation rather than a plausible paraphrase of it.
- I did **not** train on real freight data — I had none.
- The **eleven defects** found during construction (listed in [PROGRESS.md](PROGRESS.md)) were
  found by running the system, not by reading it. Three were modelling errors that produced
  believable, wrong numbers.

The rule applied everywhere: **no recommendation without justification**. That is not a style
convention, it is enforced at the type level — the `Recommendation` dataclass has no default for
`reasons`, so a recommendation without reasoning cannot be constructed.

---

## 6. One-page summary

**The idea**: connect tracking and decision, so an observed delay automatically becomes a
recommended order — justified, costed, and executable in one click.

**The AI**: one forecasting model genuinely trained on your data at every request; one delay model
that trains when you give it something to learn from and refuses when you do not; and nine
components that are mathematical optimisation, classical statistics or expert rules, because those
are the right tool for each.

**The training**: nothing is pre-trained. What learns, learns on your data, at runtime, with
walk-forward validation and a model selection that may perfectly well conclude the simplest model
wins — and does.

**The honesty**: every assumption is published in the response it affects. Every stub is labelled.
Every synthetic row is marked. A number the system cannot measure, it says so, instead of
displaying zero.
