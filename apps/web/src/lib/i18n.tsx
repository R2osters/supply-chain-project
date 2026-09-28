'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * Bilingual interface, English and French.
 *
 * A dictionary in a context rather than route-based localisation (`/fr/...`, `/en/...`), because
 * every screen in this app is client-rendered behind authentication: there is nothing for a
 * search engine to index and no server-rendered HTML whose language matters for SEO. Splitting
 * the router would double every route and buy nothing. Switching is instant and the choice
 * persists, which is what an operator actually notices.
 *
 * The catalogue is flat and typed: `t('nav.map')` is checked at compile time, so a missing or
 * misspelled key is a build error rather than raw dot-notation appearing on screen.
 *
 * Dates and numbers are *not* in the dictionary. They go through `Intl` with the active locale,
 * because "13 Aug 26" and "13 août 26" are a formatting concern, not a translation one — and
 * French uses a non-breaking space as its thousands separator, which no hand-written table gets
 * right.
 */

export const LOCALES = ['en', 'fr'] as const;
export type Locale = (typeof LOCALES)[number];

const STORAGE_KEY = 'scip.locale';

const en = {
  /* ------------------------------------------------------------------ shell */
  'app.name': 'SCIP',
  'app.tagline': 'Supply Chain Intelligence Platform',
  'app.description':
    'Two halves of one system. Track follows cargo from a supplier’s gate to a customer’s dock. Optimise decides what to order, from whom, when, and by which route — and explains every answer.',

  'nav.group.track': 'Track',
  'nav.group.optimise': 'Optimise',
  'nav.group.data': 'Master data',
  'nav.control': 'Control',
  'nav.map': 'Live map',
  'nav.maritime': 'Vessels',
  'nav.shipments': 'Shipments',
  'nav.deliveries': 'Deliveries',
  'nav.incidents': 'Incidents',
  'nav.recommendations': 'Advice',
  'nav.forecasting': 'Forecasting',
  'nav.allocation': 'Allocation',
  'nav.routing': 'Routing',
  'nav.scenarios': 'Scenarios',
  'nav.inventory': 'Inventory',
  'nav.orders': 'Orders',
  'nav.suppliers': 'Suppliers',
  'nav.alerts': 'Alerts',
  'nav.signOut': 'Sign out',
  'nav.aiOnline': 'AI online',
  'nav.aiOffline': 'AI offline',
  'nav.aiOfflineHint': 'Tracking and stock still work.',
  'nav.establishing': 'Establishing session…',

  /* ------------------------------------------------------------------ login */
  'login.operator': 'Operator',
  'login.passphrase': 'Passphrase',
  'login.signIn': 'Sign in',
  'login.authenticating': 'Authenticating…',
  'login.demoAccounts': 'Demo accounts · same passphrase',
  'login.roleNote':
    'Every role sees a different system. A driver sees only their own runs; a supplier only their own orders. The interface hides what the API would refuse.',
  'login.role.admin': 'Company admin',
  'login.role.supplychain': 'Supply chain',
  'login.role.logistics': 'Logistics',
  'login.role.procurement': 'Procurement',
  'login.role.warehouse': 'Warehouse',
  'login.role.driver': 'Driver',
  'login.note.admin': 'everything',
  'login.note.supplychain': 'planning and advice',
  'login.note.logistics': 'fleet and shipments',
  'login.note.procurement': 'suppliers and orders',
  'login.note.warehouse': 'stock and receipts',
  'login.note.driver': 'own deliveries only',
  'login.feature.gps': 'Live GPS',
  'login.feature.gpsValue': 'PostGIS + WebSocket',
  'login.feature.ais': 'Live AIS',
  'login.feature.aisValue': 'vessels by name or IMO',
  'login.feature.forecast': 'Forecasting',
  'login.feature.forecastValue': '6 models compared',
  'login.feature.allocation': 'Allocation',
  'login.feature.allocationValue': 'MILP, OR-Tools',

  /* -------------------------------------------------------------- dashboard */
  'kpi.activeShipments': 'Active shipments',
  'kpi.atRisk': 'At risk',
  'kpi.deliveredToday': 'Delivered today',
  'kpi.inventoryValue': 'Inventory value',
  'kpi.stockExceptions': 'Stock exceptions',
  'kpi.fleetReporting': 'Fleet reporting',
  'kpi.runningLate': '{n} running late',
  'kpi.noneLate': 'none late',
  'kpi.delayThreshold': 'delay probability ≥ 50%',
  'kpi.onTime90d': '{pct} on time (90 d)',
  'kpi.noHistory': 'no history yet',
  'kpi.skus': '{n} SKUs',
  'kpi.outAndLow': '{out} out · {low} low',
  'kpi.inTransit': '{n} in transit',
  'dash.shipmentFlow': 'Shipment flow · 30 days',
  'dash.created': 'Created',
  'dash.delivered': 'Delivered',
  'dash.late': 'Late',
  'dash.deliveryPerformance': 'Delivery performance · 90 days',
  'dash.onTime': 'On time',
  'dash.meanDelay': 'Mean delay',
  'dash.p90Delay': 'p90 delay',
  'dash.etaError': 'ETA error',
  'dash.supplierReliability': 'Supplier reliability',
  'dash.whatNext': 'What to do next',
  'dash.allAdvice': 'all',
  'dash.nothingNeeded': 'Nothing needs attention',
  'dash.nothingNeededHint':
    'Generate advice from the Advice screen once there is enough history.',
  'dash.commits': 'commits',
  'dash.releases': 'releases',
  'dash.open': '{n} open',

  /* ------------------------------------------------------------------ common */
  'common.demoData': 'demo data',
  'common.loading': 'Reading',
  'common.fault': 'Fault',
  'common.search': 'Search',
  'common.close': 'close',
  'common.page': 'page {page} / {total}',
  'common.prev': 'prev',
  'common.next': 'next',
  'common.allStatuses': 'all statuses',
  'common.openOnly': 'open only',
  'common.assumptions': '{n} assumption',
  'common.assumptionsPlural': '{n} assumptions',
  'common.notComputed': 'not computed',
  'common.none': 'none',
  'common.language': 'Language',

  /* ---------------------------------------------------------------- maritime */
  'sea.title': 'Vessel tracking',
  'sea.intro':
    'Find a ship by name, IMO number, MMSI or call sign, and follow it live. Ocean legs are tracked over AIS — the collision-avoidance radio every commercial vessel broadcasts — not by a tracker you install.',
  'sea.searchPlaceholder': 'Vessel name, IMO, MMSI or call sign…',
  'sea.searchHint':
    'One box. Type whatever identifier you have — the system works out which kind it is. Former names are searched too, because ships get renamed and old paperwork carries the old name.',
  'sea.interpretedAs': 'read as',
  'sea.results': '{n} vessel(s)',
  'sea.noResults': 'No vessel matches',
  'sea.noResultsHint':
    'Check the spelling, or register the vessel with its IMO number so its AIS broadcasts can be matched.',
  'sea.liveAis': 'live AIS',
  'sea.simulated': 'simulated',
  'sea.sourceLive':
    'Positions are live AIS broadcasts from the vessels themselves.',
  'sea.sourceSimulated':
    'No AIS key configured, so positions are interpolated along great-circle tracks and stored as SIMULATOR. Set AISSTREAM_API_KEY for live global AIS.',
  'sea.fleet': 'Vessels',
  'sea.voyage': 'Voyage',
  'sea.noVoyage': 'No active voyage',
  'sea.imo': 'IMO',
  'sea.mmsi': 'MMSI',
  'sea.callSign': 'Call sign',
  'sea.flag': 'Flag',
  'sea.operator': 'Operator',
  'sea.type': 'Type',
  'sea.capacity': 'Capacity',
  'sea.speed': 'Speed',
  'sea.course': 'Course',
  'sea.lastFix': 'Last fix',
  'sea.position': 'Position',
  'sea.progress': 'Progress',
  'sea.remaining': 'Remaining',
  'sea.covered': 'Covered',
  'sea.eta': 'ETA',
  'sea.scheduled': 'Scheduled',
  'sea.etaBasis': 'Basis',
  'sea.aheadOfSchedule': 'ahead of schedule',
  'sea.behindSchedule': 'behind schedule',
  'sea.track': 'Track',
  'sea.plannedTrack': 'planned',
  'sea.actualTrack': 'actual',
  'sea.ports': 'Ports',
  'sea.voyages': 'Voyages',
  'sea.selectVessel': 'Select a vessel',
  'sea.selectVesselHint':
    'Search above, or pick one from the list, to see its track and voyage.',
  'sea.knots': 'kn',
  'sea.nauticalMiles': 'nm',
  'sea.ownFleet': 'own fleet',
  'sea.publicAis': 'public AIS',
  'sea.externalTrackers': 'Check elsewhere',
  'sea.externalHint':
    'Opens the public tracker page for this vessel, matched on its {id}. Free, no account — useful for a second opinion, a photo of the hull, or the port-call history this system does not keep.',

  /* --------------------------------------------------------------- shipments */
  'ship.title': 'Shipments',
  'ship.tracking': 'Tracking',
  'ship.status': 'Status',
  'ship.route': 'Route',
  'ship.carrier': 'Carrier',
  'ship.vehicle': 'Vehicle',
  'ship.promised': 'Promised',
  'ship.delayRisk': 'Delay risk',
  'ship.noMatch': 'No shipment matches',
  'ship.noMatchHint': 'Clear the filters, or plan a shipment to see it here.',

  /* --------------------------------------------------------- recommendations */
  'rec.title': 'What to do next',
  'rec.intro':
    'Every recommendation carries the reasoning that produced it and the assumptions behind it. Accepting one performs the action — it does not just tick a box.',
  'rec.regenerate': 'regenerate advice',
  'rec.analysing': 'analysing…',
  'rec.accept': 'accept & execute',
  'rec.executing': 'executing…',
  'rec.dismiss': 'dismiss',
  'rec.notePlaceholder': 'note (optional)',
  'rec.open': 'Open',
  'rec.decided': 'Decided',
  'rec.actedOn': 'Acted on',
  'rec.executed': 'Executed',
  'rec.proposedSplit': 'Proposed split',
  'rec.expires': 'expires {when}',
  'rec.nothingNeeded': 'Nothing needs attention',
  'rec.nothingNeededHint':
    'Either the supply chain is healthy, or there is not enough history yet. Regenerate to check.',
  'rec.noneOfStatus': 'No {status} advice',
  'rec.list': 'Recommendations',
  'rec.generated':
    'Analysis complete — {total} recommendation(s), {added} new. Existing open advice for the same subject was superseded rather than duplicated.',
  'rec.openPurchaseOrders': 'open purchase orders →',
  'rec.recordsDecision': 'Records the decision.',
  'rec.blurb.ORDER_NOW': 'Raises a draft purchase order you can review and confirm.',
  'rec.blurb.SPLIT_ORDER': 'Raises one draft purchase order per supplier in the split.',
  'rec.blurb.INCREASE_SAFETY_STOCK': 'Writes the new safety stock and reorder point.',
  'rec.blurb.REDUCE_INVENTORY': 'Caps the maximum stock level so overstock raises an alert.',
  'rec.blurb.CHANGE_SUPPLIER': 'Commercial decision — recorded, not automated.',
  'rec.blurb.ADD_SUPPLIER': 'Sourcing decision — recorded, not automated.',
  'rec.blurb.EXPEDITE_SHIPMENT': 'Operational decision — recorded, not automated.',

  /* ----------------------------------------------------------------- devices */
  'dev.title': 'Tracking devices',
  'dev.intro':
    'Three ways to put a truck on the map. They all feed the same validated pipeline, so a fix from a €15 tracker is checked exactly as hard as one from the API.',
  'dev.nav': 'Devices',
  'dev.kind': 'Type',
  'dev.identifier': 'Identifier',
  'dev.vehicle': 'Vehicle',
  'dev.status': 'Status',
  'dev.lastSeen': 'Last seen',
  'dev.battery': 'Battery',
  'dev.accepted': 'Accepted',
  'dev.rejected': 'Rejected',
  'dev.interval': 'Interval',
  'dev.late': 'reporting late',
  'dev.unbound': 'no vehicle',
  'dev.none': 'No device enrolled yet',
  'dev.noneHint': 'Enrol one below. A driver’s phone costs nothing and works today.',
  'dev.enrol': 'Enrol a device',
  'dev.enrolling': 'enrolling…',
  'dev.disable': 'disable',
  'dev.label': 'Label',
  'dev.labelHint': 'e.g. “Kwame’s phone”',
  'dev.identifierHint': 'IMEI printed on a hardware tracker. Any stable string for a phone.',
  'dev.pickVehicle': 'Vehicle this device travels with',
  'dev.kind.PHONE': 'Driver’s phone',
  'dev.kind.GT06': 'GT06 / Concox tracker',
  'dev.kind.TELTONIKA': 'Teltonika tracker',
  'dev.kind.MANUAL': 'Manual entry',
  'dev.kindHint.PHONE': 'No hardware. The driver opens a web page and presses start.',
  'dev.kindHint.GT06':
    'A €15–50 hardwired box. Speaks a binary protocol on a raw TCP socket, not HTTP.',
  'dev.kindHint.TELTONIKA': 'Not decoded yet — enrolling one records it but stores no positions.',
  'dev.kindHint.MANUAL': 'Positions posted by hand or by another system through the API.',
  'dev.gateway': 'Hardware gateway',
  'dev.gatewayUp': 'listening on tcp/{port}',
  'dev.gatewayDown': 'not listening',
  'dev.gatewayStats': '{decoded} packets decoded · {stored} positions stored · {rejected} rejected',
  'dev.setup': 'Setup',
  'dev.secretOnce':
    'This pairing secret is shown once and never again. Give it to the driver now, or enrol the device again.',
  'dev.copyLink': 'copy the driver link',
  'dev.copied': 'copied',

  /* ------------------------------------------------------------------- drive */
  'drive.title': 'Driver',
  'drive.pair': 'Pair this phone',
  'drive.pairIntro':
    'Enter the identifier and pairing secret your dispatcher gave you. This phone then reports its position for as long as the page is open.',
  'drive.identifier': 'Identifier',
  'drive.secret': 'Pairing secret',
  'drive.start': 'Start tracking',
  'drive.stop': 'Stop tracking',
  'drive.tracking': 'Tracking',
  'drive.stopped': 'Stopped',
  'drive.forget': 'unpair this phone',
  'drive.speed': 'Speed',
  'drive.accuracy': 'Accuracy',
  'drive.fixes': 'Fixes taken',
  'drive.queued': 'Waiting to send',
  'drive.sent': 'Sent',
  'drive.lastSent': 'Last sent',
  'drive.never': 'never',
  'drive.offline': 'No connection — positions are being saved on the phone',
  'drive.online': 'Connected',
  'drive.permissionDenied':
    'Location permission was refused. Allow it in the browser settings for this site, then press start again.',
  'drive.unsupported': 'This browser has no geolocation. Use Chrome, Safari or Firefox.',
  'drive.screenWarning':
    'Keep this screen on. A phone browser stops receiving positions once the page is hidden — positions already taken are kept and sent when you come back.',
  'drive.wakeLockOn': 'Screen kept awake',
  'drive.batteryHint': 'Plug the phone in. Continuous GPS uses roughly 5–10% of a battery per hour.',
  'drive.rejectedHint': '{n} rejected by the server',
  'drive.install': 'Add this page to your home screen to open it in one tap.',

  /* ----------------------------------------------------------------- generic */
  'common.cancel': 'Cancel',

  /* -------------------------------------------------------------- allocation */
  'alloc.title': 'Multi-supplier allocation',
  'alloc.intro':
    'A mixed-integer program over the live supplier price lists. Minimum order quantity is a real disjunction — order at least the MOQ or nothing at all — which is why this is a solver and not a weighted score. Unmet demand is priced rather than forbidden, so an under-supplied market yields a plan with a visible shortfall instead of “infeasible”.',
  'alloc.question': 'Question',
  'alloc.product': 'Product',
  'alloc.select': 'select…',
  'alloc.quantity': 'Quantity',
  'alloc.withinDays': 'Needed within (days)',
  'alloc.noDeadline': 'no deadline',
  'alloc.maxShare': 'Max share per supplier',
  'alloc.unconstrained': 'unconstrained',
  'alloc.budget': 'Budget cap (optional)',
  'alloc.noCap': 'no cap',
  'alloc.solve': 'solve',
  'alloc.solving': 'solving…',
  'alloc.branchAndBound': 'Branch and bound',
  'alloc.plan': 'Plan',
  'alloc.solvedIn': 'solved in {ms} ms',
  'alloc.infeasible': 'No feasible allocation',
  'alloc.supplier': 'Supplier',
  'alloc.share': 'Share',
  'alloc.unitPrice': 'Unit price',
  'alloc.leadTime': 'Lead time',
  'alloc.reliability': 'Reliability',
  'alloc.cost': 'Cost',
  'alloc.unmet': '{n} units could not be covered by any supplier’s capacity.',
  'alloc.outcome': 'Outcome',
  'alloc.objective': 'Objective',
  'alloc.objectiveHint': 'total modelled cost',
  'alloc.expectedLeadTime': 'Expected lead time',
  'alloc.expectedLeadTimeHint': 'quantity-weighted',
  'alloc.shortfallRisk': 'Shortfall risk',
  'alloc.shortfallRiskHint': 'given supplier reliability',
  'alloc.concentration': 'Concentration',
  'alloc.concentrationHint': '1.0 = single source',
  'alloc.costBreakdown': 'Cost breakdown',
  'alloc.constraints': 'Constraints applied',
  'alloc.noPlan': 'No plan yet',
  'alloc.noPlanHint':
    'Pick a product and a quantity. Only suppliers with a current price list for that product are considered.',
  'alloc.cost.purchase': 'Purchase',
  'alloc.cost.transport': 'Transport',
  'alloc.cost.holding': 'Holding',
  'alloc.cost.stockoutPenalty': 'Stockout penalty',
  'alloc.cost.delayPenalty': 'Delay penalty',
  'alloc.cost.riskPenalty': 'Risk penalty',

  /* ----------------------------------------------------------------- routing */
  'rt.title': 'Route optimisation',
  'rt.intro':
    'Capacitated vehicle routing with delivery windows. The problem is NP-hard, so the solver returns the best plan it found inside its time budget — good, not provably optimal, which is why the status reads FEASIBLE rather than OPTIMAL.',
  'rt.inputs': 'Inputs',
  'rt.depot': 'Depot',
  'rt.selectWarehouse': 'select a warehouse…',
  'rt.plan': 'plan routes',
  'rt.searching': 'searching…',
  'rt.allStops': 'all stops',
  'rt.stopsSelected': 'Stops · {n} selected',
  'rt.hiddenNoCoords': '({n} without coordinates hidden)',
  'rt.vehicles': 'Vehicles · {what}',
  'rt.vehiclesSelected': '{n} selected',
  'rt.allAvailable': 'all available',
  'rt.guidedSearch': 'Guided local search',
  'rt.status': 'Status',
  'rt.routes': 'Routes',
  'rt.distance': 'Distance',
  'rt.duration': 'Duration',
  'rt.cost': 'Cost',
  'rt.unassigned': '{n} stop(s) could not be served with the selected fleet.',
  'rt.plans': 'Plans',
  'rt.reasoning': 'Reasoning',
  'rt.constraints': 'Constraints',
  'rt.none': 'No plan yet',
  'rt.noneHint':
    'Choose a depot and at least one stop. Customers without coordinates cannot be routed and are hidden.',

  /* --------------------------------------------------------------- scenarios */
  'scn.title': 'Scenario simulation',
  'scn.run': 'run',
  'scn.running': 'simulating…',
  'scn.baseline': 'Baseline',
  'scn.cases': 'Cases',
  'scn.none': 'No simulation yet',

  /* ------------------------------------------------------------- forecasting */
  'fc.title': 'Demand forecasting',
  'fc.intro':
    'Six models compete on walk-forward validation and the winner is refit on the full history. Selection is by WAPE, not MAPE — MAPE divides by the actual, so a single zero-demand day makes it infinite, and zero-demand days are the norm for slow movers.',
  'fc.run': 'Run',
  'fc.product': 'Product',
  'fc.selectProduct': 'select a product…',
  'fc.horizon': 'Horizon',
  'fc.forecast': 'forecast',
  'fc.comparing': 'comparing models…',
  'fc.validating': 'Walk-forward validation across six models',
  'fc.chartTitle': '{sku} · {days}-day forecast',
  'fc.interval': '80% interval',
  'fc.series': 'Forecast',
  'fc.comparison': 'Model comparison',
  'fc.model': 'Model',
  'fc.notEvaluated': 'Not evaluated: {list}.',
  'fc.dataQuality': 'Data quality',
  'fc.passed': 'passed',
  'fc.blocked': 'blocked',
  'fc.rowsUsed': '{used} of {total} rows used',
  'fc.residual': 'residual σ {value}',
  'fc.noIssue': 'No issue found in the demand history.',
  'fc.none': 'No forecast yet',
  'fc.noneHint':
    'Pick a product and a horizon. Products need demand history — the seeded demo has two years of it.',

  /* -------------------------------------------------------------- deliveries */
  'del.scheduled': 'Scheduled',
  'del.completed': 'Completed',
  'del.outstanding': 'Outstanding',
  'del.failed': 'Failed',
  'del.run': 'Delivery run',
  'del.shipment': 'Shipment',
  'del.status': 'Status',
  'del.customer': 'Customer',
  'del.destination': 'Destination',
  'del.attempts': 'Attempts',
  'del.note': 'Note',
  'del.none': 'Nothing scheduled',
  'del.noneHint': 'Deliveries appear here once a shipment has one created against it.',
  'del.podNote':
    'Proof of delivery — signature, photos and capture location — is recorded from the driver app against {endpoint}. The capture point is compared with the declared destination and the distance stored, because a signature taken far from where the goods were meant to go is the clearest early signal of a misdelivery.',

  /* --------------------------------------------------------------- suppliers */
  'sup.title': 'Supplier performance',
  'sup.intro':
    'Reliability is computed from each supplier’s own purchase-order history, not entered by hand. Rates are shrunk toward a neutral prior when there are few orders, so one late delivery out of two does not brand a new supplier as 50 % reliable.',
  'sup.league': 'League table',
  'sup.recompute': 'recompute all',
  'sup.recomputing': 'recomputing…',
  'sup.supplier': 'Supplier',
  'sup.country': 'Country',
  'sup.reliability': 'Reliability',
  'sup.onTime': 'On time',
  'sup.quality': 'Quality',
  'sup.fillRate': 'Fill rate',
  'sup.leadTime': 'Lead time',
  'sup.orders': 'Orders',
  'sup.measured': 'measured',
  'sup.prior': 'prior',
  'sup.priorNote':
    'A “prior” badge means no performance has been computed for that supplier yet — the score is the neutral starting value, not a measurement. Lead-time spread is what drives safety stock: a supplier at 5 ± 4 days costs more buffer than one at 12 ± 0.5.',
  'sup.none': 'No suppliers',

  /* ----------------------------------------------------------- notifications */
  'notif.title': 'Alerts',
  'notif.unread': '{n} unread',
  'notif.unreadOnly': 'unread only',
  'notif.markAllRead': 'mark all read',
  'notif.markRead': 'mark read',
  'notif.open': 'open →',
  'notif.emailFailed': 'email delivery failed: {reason}',
  'notif.noneUnread': 'Nothing unread',
  'notif.none': 'No alerts',
  'notif.noneHint': 'Alerts are routed by role — you see what your role is responsible for.',

  /* ------------------------------------------------- shared table vocabulary */
  'tbl.page': 'page {page} / {total}',
  'tbl.prev': 'prev',
  'tbl.next': 'next',
  'tbl.allStatuses': 'all statuses',
  'tbl.notComputed': 'not computed',
  'tbl.demo': 'demo',
  'tbl.search': 'search',

  /* ------------------------------------------------------ shipments (listing) */
  'ship.openOnly': 'open only',
  'ship.searchPlaceholder': 'tracking, origin, destination',
  'ship.progress': 'Progress',
  'ship.eta': 'ETA',
  'ship.anomaly': 'anomaly',

  /* --------------------------------------------------------------- incidents */
  'inc.title': 'Incidents',
  'inc.window': 'Incidents · {days} d',
  'inc.stillOpen': 'Still open',
  'inc.estimatedCost': 'Estimated cost',
  'inc.bySeverity': 'By severity',
  'inc.type': 'Type',
  'inc.severity': 'Severity',
  'inc.status': 'Status',
  'inc.what': 'What happened',
  'inc.shipment': 'Shipment',
  'inc.when': 'When',
  'inc.reportedBy': 'Reported by',
  'inc.assignedTo': 'Assigned to',
  'inc.cost': 'Cost',
  'inc.none': 'No incidents',
  'inc.noneHint': 'Nothing has gone wrong in this window, or the filter excludes it.',
  'inc.allStatuses': 'all statuses',
  'inc.all': 'all',
  'inc.reportedByName': 'reported by {name}',
  'inc.assignedToName': 'assigned to {name}',
  'inc.resolvedWhen': 'resolved {when}',

  /* --------------------------------------------------------- purchase orders */
  'po.title': 'Purchase orders',
  'po.number': 'Number',
  'po.supplier': 'Supplier',
  'po.status': 'Status',
  'po.lines': 'Lines',
  'po.total': 'Total',
  'po.expectedDelivery': 'Expected delivery',
  'po.created': 'Created',
  'po.none': 'No purchase orders',
  'po.noneHint': 'Accepting an ORDER_NOW recommendation creates one here as a draft.',
  'po.received': 'received',
  'po.partiallyReceived': 'partial',
  'po.order': 'Order',
  'po.receiving': 'Receiving',
  'po.value': 'Value',
  'po.expected': 'Expected',
  'po.actual': 'Actual',
  'po.reliability': 'reliability {score}',
  'po.raisedByAi': 'Raised by accepting a recommendation',
  'po.moveTo': 'move to…',
  'po.cancelReason': 'Cancelled from the orders screen',

  /* --------------------------------------------------------------- inventory */
  'inv.title': 'Inventory',
  'inv.value': 'Stock value',
  'inv.skus': 'SKUs',
  'inv.belowReorder': 'Below reorder point',
  'inv.outOfStock': 'Out of stock',
  'inv.product': 'Product',
  'inv.warehouse': 'Warehouse',
  'inv.available': 'Available',
  'inv.reserved': 'Reserved',
  'inv.incoming': 'Incoming',
  'inv.free': 'Free',
  'inv.reorderPoint': 'Reorder point',
  'inv.safetyStock': 'Safety stock',
  'inv.movements': 'Movements',
  'inv.alerts': 'Stock alerts',
  'inv.none': 'Nothing in stock',
  'inv.noneHint': 'Receive a purchase order, or clear the filters.',
  'inv.onlyBelowReorder': 'below reorder point only',
  'inv.onlyOutOfStock': 'out of stock only',
  'inv.units': 'Units',
  'inv.overstocked': 'Overstocked',
  'inv.byProduct': 'Stock by product and warehouse',
  'inv.searchPlaceholder': 'sku or name',
  'inv.belowReorderShort': 'below reorder',
  'inv.reorderPtShort': 'Reorder pt',
  'inv.cover': 'Cover',
  'inv.valueCol': 'Value',
  'inv.noRows': 'No stock rows',
  'inv.openAlerts': 'Open alerts',
  'inv.reevaluate': 're-evaluate',
  'inv.sweeping': 'sweeping…',
  'inv.noAlerts': 'No open alerts',
  'inv.noAlertsHint':
    'Alerts resolve themselves when the condition clears, so an empty list means the stock position is healthy.',

  /* -------------------------------------------------------------- situation */
  'nav.situation': 'Situation',
  'sit.title': 'Situation room',
  'sit.close': 'close',
  'sit.loading': 'Reading…',
  'sit.unavailable': 'Source unavailable right now.',
  'sit.stale': 'stale',
  'sit.counts': '{hazards} hazards · {cameras} cameras · {radio} stations · {satellites} satellites',
  'sit.layer.hazards': 'Hazards',
  'sit.layer.cameras': 'Cameras',
  'sit.layer.radio': 'Radio',
  'sit.layer.satellites': 'Satellites',
  'sit.layer.traffic': 'Traffic',
  'sit.hint.zoomCameras': 'Zoom in to load public traffic cameras.',
  'sit.hint.zoomRadio': 'Zoom in to load radio stations near the centre.',
  'sit.hint.trafficOff': 'Live traffic needs TOMTOM_API_KEY on the API.',
  'sit.camera.title': 'Public camera',
  'sit.camera.loading': 'Fetching frame…',
  'sit.camera.unavailable': 'No frame from this camera right now.',
  'sit.camera.frameAt': 'frame {time}',
  'sit.camera.refreshFailed': 'last refresh failed',
  'sit.camera.every': 'every {s} s',
  'sit.camera.privacy':
    'Frames are relayed as the operator publishes them. Nothing is stored, and no face or plate recognition runs on them.',
  'sit.radio.title': 'Radio',
  'sit.radio.error': 'This stream will not play. The broadcaster may be offline.',
  'sit.radio.homepage': 'station site',
  'sit.radio.privacy':
    'Audio plays straight from the broadcaster, so the broadcaster sees your IP address.',
  'sit.kind.cyclone': 'Tropical cyclone',
  'sit.kind.earthquake': 'Earthquake',
  'sit.kind.fire': 'Active fire',
  'sit.kind.weather': 'Severe weather',
  'sit.hazard.officialSource': 'Official source',
  'sit.weather.title': 'Weather there now',
  'sit.weather.wind': 'wind {wind} km/h, gusts {gust}',
  'sit.weather.severity': 'transport severity {pct}',
  'sit.news.title': 'Local news · {q}',
  'sit.news.caveat':
    'Articles matching the place name in the last days. A keyword match, not a confirmed incident report.',
  'sit.news.none': 'Nothing found.',
  'sit.exposure.title': 'Exposure',
  'sit.exposure.radius': 'within {km} km',
  'sit.exposure.none': 'No asset near an active hazard',
  'sit.exposure.noneHint':
    'Warehouses, active shipments and suppliers are checked against cyclones, earthquakes, fires and severe weather.',
  'sit.subject.warehouse': 'Warehouse',
  'sit.subject.shipment': 'Shipment',
  'sit.subject.supplier': 'Supplier',
  'sit.sat.title': 'Satellites',
  'sit.sat.group': 'Constellation',
  'sit.sat.aboveCentre': 'Above map centre · {lat}, {lon}',
  'sit.sat.visibleCount': '{n} in view · {high} above 30°',
  'sit.sat.quality.good': 'good fix',
  'sit.sat.quality.fair': 'fair fix',
  'sit.sat.quality.poor': 'poor fix',
  'sit.sat.trackHint': 'next 100 min drawn',
  'sit.search.placeholder': 'Place or lat, lon',
  'sit.search.none': 'No place found.',
  'sit.sources.title': 'Sources',
  'sit.sources.tiles': '{used} / {budget} tiles today',

  'map.layer.traffic': 'Traffic',
  'map.nearestCameras': 'Nearest public cameras',
  'map.noCameras': 'No public camera within 50 km.',
  'map.weatherHere': 'Weather at the vehicle',
} as const;

export type TranslationKey = keyof typeof en;

const fr: Record<TranslationKey, string> = {
  'app.name': 'SCIP',
  'app.tagline': 'Plateforme d’intelligence Supply Chain',
  'app.description':
    'Deux moitiés d’un même système. Suivi trace la marchandise du portail du fournisseur au quai du client. Optimisation décide quoi commander, chez qui, quand et par quel itinéraire — et justifie chaque réponse.',

  'nav.group.track': 'Suivi',
  'nav.group.optimise': 'Optimisation',
  'nav.group.data': 'Référentiel',
  'nav.control': 'Contrôle',
  'nav.map': 'Carte live',
  'nav.maritime': 'Navires',
  'nav.shipments': 'Expéditions',
  'nav.deliveries': 'Livraisons',
  'nav.incidents': 'Incidents',
  'nav.recommendations': 'Recommandations',
  'nav.forecasting': 'Prévision',
  'nav.allocation': 'Allocation',
  'nav.routing': 'Tournées',
  'nav.scenarios': 'Scénarios',
  'nav.inventory': 'Stocks',
  'nav.orders': 'Commandes',
  'nav.suppliers': 'Fournisseurs',
  'nav.alerts': 'Alertes',
  'nav.signOut': 'Déconnexion',
  'nav.aiOnline': 'IA en ligne',
  'nav.aiOffline': 'IA hors ligne',
  'nav.aiOfflineHint': 'Le suivi et les stocks fonctionnent toujours.',
  'nav.establishing': 'Ouverture de session…',

  'login.operator': 'Opérateur',
  'login.passphrase': 'Mot de passe',
  'login.signIn': 'Se connecter',
  'login.authenticating': 'Authentification…',
  'login.demoAccounts': 'Comptes de démonstration · même mot de passe',
  'login.roleNote':
    'Chaque rôle voit un système différent. Un chauffeur ne voit que ses propres tournées ; un fournisseur, que ses propres commandes. L’interface masque ce que l’API refuserait.',
  'login.role.admin': 'Admin société',
  'login.role.supplychain': 'Supply chain',
  'login.role.logistics': 'Logistique',
  'login.role.procurement': 'Achats',
  'login.role.warehouse': 'Entrepôt',
  'login.role.driver': 'Chauffeur',
  'login.note.admin': 'tout',
  'login.note.supplychain': 'planification et conseil',
  'login.note.logistics': 'flotte et expéditions',
  'login.note.procurement': 'fournisseurs et commandes',
  'login.note.warehouse': 'stocks et réceptions',
  'login.note.driver': 'ses livraisons uniquement',
  'login.feature.gps': 'GPS temps réel',
  'login.feature.gpsValue': 'PostGIS + WebSocket',
  'login.feature.ais': 'AIS temps réel',
  'login.feature.aisValue': 'navires par nom ou IMO',
  'login.feature.forecast': 'Prévision',
  'login.feature.forecastValue': '6 modèles comparés',
  'login.feature.allocation': 'Allocation',
  'login.feature.allocationValue': 'MILP, OR-Tools',

  'kpi.activeShipments': 'Expéditions actives',
  'kpi.atRisk': 'À risque',
  'kpi.deliveredToday': 'Livrées aujourd’hui',
  'kpi.inventoryValue': 'Valeur du stock',
  'kpi.stockExceptions': 'Anomalies de stock',
  'kpi.fleetReporting': 'Flotte qui émet',
  'kpi.runningLate': '{n} en retard',
  'kpi.noneLate': 'aucune en retard',
  'kpi.delayThreshold': 'probabilité de retard ≥ 50 %',
  'kpi.onTime90d': '{pct} à l’heure (90 j)',
  'kpi.noHistory': 'pas encore d’historique',
  'kpi.skus': '{n} références',
  'kpi.outAndLow': '{out} en rupture · {low} bas',
  'kpi.inTransit': '{n} en transit',
  'dash.shipmentFlow': 'Flux d’expéditions · 30 jours',
  'dash.created': 'Créées',
  'dash.delivered': 'Livrées',
  'dash.late': 'En retard',
  'dash.deliveryPerformance': 'Performance de livraison · 90 jours',
  'dash.onTime': 'À l’heure',
  'dash.meanDelay': 'Retard moyen',
  'dash.p90Delay': 'Retard p90',
  'dash.etaError': 'Erreur ETA',
  'dash.supplierReliability': 'Fiabilité fournisseurs',
  'dash.whatNext': 'Que faire maintenant',
  'dash.allAdvice': 'tout',
  'dash.nothingNeeded': 'Rien ne requiert d’attention',
  'dash.nothingNeededHint':
    'Générez des recommandations depuis l’écran dédié une fois l’historique suffisant.',
  'dash.commits': 'engage',
  'dash.releases': 'libère',
  'dash.open': '{n} ouvertes',

  'common.demoData': 'données démo',
  'common.loading': 'Lecture',
  'common.fault': 'Erreur',
  'common.search': 'Rechercher',
  'common.close': 'fermer',
  'common.page': 'page {page} / {total}',
  'common.prev': 'préc.',
  'common.next': 'suiv.',
  'common.allStatuses': 'tous les statuts',
  'common.openOnly': 'en cours seulement',
  'common.assumptions': '{n} hypothèse',
  'common.assumptionsPlural': '{n} hypothèses',
  'common.notComputed': 'non calculé',
  'common.none': 'aucun',
  'common.language': 'Langue',

  'sea.title': 'Suivi des navires',
  'sea.intro':
    'Trouvez un navire par son nom, son numéro IMO, son MMSI ou son indicatif, et suivez-le en direct. Les traversées sont suivies via l’AIS — la radio anticollision que tout navire de commerce émet — et non par un traceur que vous installeriez.',
  'sea.searchPlaceholder': 'Nom du navire, IMO, MMSI ou indicatif…',
  'sea.searchHint':
    'Un seul champ. Tapez l’identifiant dont vous disposez — le système reconnaît lequel c’est. Les anciens noms sont aussi cherchés, car les navires sont rebaptisés et les vieux documents portent l’ancien nom.',
  'sea.interpretedAs': 'interprété comme',
  'sea.results': '{n} navire(s)',
  'sea.noResults': 'Aucun navire trouvé',
  'sea.noResultsHint':
    'Vérifiez l’orthographe, ou enregistrez le navire avec son numéro IMO pour que ses émissions AIS puissent être rattachées.',
  'sea.liveAis': 'AIS direct',
  'sea.simulated': 'simulé',
  'sea.sourceLive': 'Les positions sont des émissions AIS live provenant des navires eux-mêmes.',
  'sea.sourceSimulated':
    'Aucune clé AIS configurée : les positions sont interpolées sur des orthodromies et stockées avec la source SIMULATOR. Renseignez AISSTREAM_API_KEY pour de l’AIS mondial en direct.',
  'sea.fleet': 'Navires',
  'sea.voyage': 'Traversée',
  'sea.noVoyage': 'Aucune traversée en cours',
  'sea.imo': 'IMO',
  'sea.mmsi': 'MMSI',
  'sea.callSign': 'Indicatif',
  'sea.flag': 'Pavillon',
  'sea.operator': 'Armateur',
  'sea.type': 'Type',
  'sea.capacity': 'Capacité',
  'sea.speed': 'Vitesse',
  'sea.course': 'Cap',
  'sea.lastFix': 'Dernier point',
  'sea.position': 'Position',
  'sea.progress': 'Avancement',
  'sea.remaining': 'Restant',
  'sea.covered': 'Parcouru',
  'sea.eta': 'ETA',
  'sea.scheduled': 'Prévu',
  'sea.etaBasis': 'Base de calcul',
  'sea.aheadOfSchedule': 'en avance',
  'sea.behindSchedule': 'en retard',
  'sea.track': 'Trace',
  'sea.plannedTrack': 'prévue',
  'sea.actualTrack': 'réelle',
  'sea.ports': 'Ports',
  'sea.voyages': 'Traversées',
  'sea.selectVessel': 'Sélectionnez un navire',
  'sea.selectVesselHint':
    'Cherchez ci-dessus, ou choisissez-en un dans la liste, pour voir sa trace et sa traversée.',
  'sea.knots': 'nd',
  'sea.nauticalMiles': 'NM',
  'sea.ownFleet': 'flotte propre',
  'sea.publicAis': 'AIS public',
  'sea.externalTrackers': 'Vérifier ailleurs',
  'sea.externalHint':
    'Ouvre la fiche publique de ce navire, retrouvée par son {id}. Gratuit, sans compte — utile pour un second avis, une photo de la coque, ou l’historique des escales que ce système ne conserve pas.',

  'ship.title': 'Expéditions',
  'ship.tracking': 'N° de suivi',
  'ship.status': 'Statut',
  'ship.route': 'Trajet',
  'ship.carrier': 'Transporteur',
  'ship.vehicle': 'Véhicule',
  'ship.promised': 'Promis',
  'ship.delayRisk': 'Risque de retard',
  'ship.noMatch': 'Aucune expédition ne correspond',
  'ship.noMatchHint': 'Retirez les filtres, ou planifiez une expédition pour la voir ici.',

  'rec.title': 'Que faire maintenant',
  'rec.intro':
    'Chaque recommandation porte le raisonnement qui l’a produite et les hypothèses qui la sous-tendent. L’accepter exécute l’action — ce n’est pas une simple case à cocher.',
  'rec.regenerate': 'régénérer les recommandations',
  'rec.analysing': 'analyse…',
  'rec.accept': 'accepter et exécuter',
  'rec.executing': 'exécution…',
  'rec.dismiss': 'écarter',
  'rec.notePlaceholder': 'note (facultatif)',
  'rec.open': 'Ouvertes',
  'rec.decided': 'Traitées',
  'rec.actedOn': 'Suivies d’effet',
  'rec.executed': 'Exécutées',
  'rec.proposedSplit': 'Répartition proposée',
  'rec.expires': 'expire {when}',
  'rec.nothingNeeded': 'Rien ne requiert d’attention',
  'rec.nothingNeededHint':
    'Soit la chaîne est saine, soit l’historique est encore insuffisant. Régénérez pour vérifier.',
  'rec.noneOfStatus': 'Aucune recommandation « {status} »',
  'rec.list': 'Recommandations',
  'rec.generated':
    'Analyse terminée — {total} recommandation(s), dont {added} nouvelles. Les recommandations ouvertes portant sur le même sujet ont été remplacées, pas dupliquées.',
  'rec.openPurchaseOrders': 'ouvrir les commandes →',
  'rec.recordsDecision': 'Enregistre la décision.',
  'rec.blurb.ORDER_NOW':
    'Crée une commande fournisseur en brouillon, que vous pouvez relire et confirmer.',
  'rec.blurb.SPLIT_ORDER': 'Crée une commande en brouillon par fournisseur de la répartition.',
  'rec.blurb.INCREASE_SAFETY_STOCK':
    'Écrit le nouveau stock de sécurité et le nouveau point de commande.',
  'rec.blurb.REDUCE_INVENTORY':
    'Plafonne le stock maximum, de sorte qu’un surstock déclenche une alerte.',
  'rec.blurb.CHANGE_SUPPLIER': 'Décision commerciale — enregistrée, non automatisée.',
  'rec.blurb.ADD_SUPPLIER': 'Décision de sourcing — enregistrée, non automatisée.',
  'rec.blurb.EXPEDITE_SHIPMENT': 'Décision d’exploitation — enregistrée, non automatisée.',

  'dev.title': 'Boîtiers de suivi',
  'dev.intro':
    'Trois façons de mettre un camion sur la carte. Toutes alimentent la même chaîne de validation : une position venue d’un traceur à 15 € est contrôlée aussi sévèrement qu’une position venue de l’API.',
  'dev.nav': 'Boîtiers',
  'dev.kind': 'Type',
  'dev.identifier': 'Identifiant',
  'dev.vehicle': 'Véhicule',
  'dev.status': 'État',
  'dev.lastSeen': 'Vu pour la dernière fois',
  'dev.battery': 'Batterie',
  'dev.accepted': 'Acceptées',
  'dev.rejected': 'Rejetées',
  'dev.interval': 'Intervalle',
  'dev.late': 'en retard d’émission',
  'dev.unbound': 'aucun véhicule',
  'dev.none': 'Aucun boîtier enregistré',
  'dev.noneHint':
    'Enregistrez-en un ci-dessous. Le téléphone du chauffeur ne coûte rien et fonctionne aujourd’hui.',
  'dev.enrol': 'Enregistrer un boîtier',
  'dev.enrolling': 'enregistrement…',
  'dev.disable': 'désactiver',
  'dev.label': 'Libellé',
  'dev.labelHint': 'ex. « téléphone de Kwame »',
  'dev.identifierHint':
    'IMEI imprimé sur un traceur matériel. N’importe quelle chaîne stable pour un téléphone.',
  'dev.pickVehicle': 'Véhicule accompagné par ce boîtier',
  'dev.kind.PHONE': 'Téléphone du chauffeur',
  'dev.kind.GT06': 'Traceur GT06 / Concox',
  'dev.kind.TELTONIKA': 'Traceur Teltonika',
  'dev.kind.MANUAL': 'Saisie manuelle',
  'dev.kindHint.PHONE':
    'Aucun matériel. Le chauffeur ouvre une page web et appuie sur démarrer.',
  'dev.kindHint.GT06':
    'Un boîtier filaire de 15 à 50 €. Parle un protocole binaire sur socket TCP brut, pas HTTP.',
  'dev.kindHint.TELTONIKA':
    'Pas encore décodé — l’enregistrer le référence mais ne stocke aucune position.',
  'dev.kindHint.MANUAL': 'Positions envoyées à la main ou par un autre système via l’API.',
  'dev.gateway': 'Passerelle matérielle',
  'dev.gatewayUp': 'à l’écoute sur tcp/{port}',
  'dev.gatewayDown': 'pas à l’écoute',
  'dev.gatewayStats':
    '{decoded} paquets décodés · {stored} positions stockées · {rejected} rejetés',
  'dev.setup': 'Mise en service',
  'dev.secretOnce':
    'Ce code d’appairage est affiché une seule fois. Transmettez-le au chauffeur maintenant, ou réenregistrez le boîtier.',
  'dev.copyLink': 'copier le lien chauffeur',
  'dev.copied': 'copié',

  'drive.title': 'Chauffeur',
  'drive.pair': 'Appairer ce téléphone',
  'drive.pairIntro':
    'Saisissez l’identifiant et le code d’appairage donnés par votre exploitation. Ce téléphone transmettra ensuite sa position tant que la page reste ouverte.',
  'drive.identifier': 'Identifiant',
  'drive.secret': 'Code d’appairage',
  'drive.start': 'Démarrer le suivi',
  'drive.stop': 'Arrêter le suivi',
  'drive.tracking': 'Suivi en cours',
  'drive.stopped': 'Arrêté',
  'drive.forget': 'désappairer ce téléphone',
  'drive.speed': 'Vitesse',
  'drive.accuracy': 'Précision',
  'drive.fixes': 'Positions relevées',
  'drive.queued': 'En attente d’envoi',
  'drive.sent': 'Envoyées',
  'drive.lastSent': 'Dernier envoi',
  'drive.never': 'jamais',
  'drive.offline': 'Pas de réseau — les positions sont conservées dans le téléphone',
  'drive.online': 'Connecté',
  'drive.permissionDenied':
    'La localisation a été refusée. Autorisez-la dans les réglages du navigateur pour ce site, puis appuyez de nouveau sur démarrer.',
  'drive.unsupported':
    'Ce navigateur n’a pas de géolocalisation. Utilisez Chrome, Safari ou Firefox.',
  'drive.screenWarning':
    'Gardez cet écran allumé. Un navigateur de téléphone cesse de recevoir des positions dès que la page est masquée — celles déjà relevées sont conservées et envoyées à votre retour.',
  'drive.wakeLockOn': 'Écran maintenu allumé',
  'drive.batteryHint':
    'Branchez le téléphone. Le GPS en continu consomme environ 5 à 10 % de batterie par heure.',
  'drive.rejectedHint': '{n} rejetées par le serveur',
  'drive.install': 'Ajoutez cette page à votre écran d’accueil pour l’ouvrir en un geste.',

  'common.cancel': 'Annuler',

  'alloc.title': 'Répartition multi-fournisseurs',
  'alloc.intro':
    'Un programme linéaire en nombres entiers sur les tarifs fournisseurs en vigueur. La quantité minimale de commande est une vraie disjonction — commander au moins le MOQ ou rien du tout — et c’est pourquoi il s’agit d’un solveur et non d’un score pondéré. La demande non couverte est valorisée plutôt qu’interdite : un marché sous-approvisionné donne un plan avec un manque visible au lieu d’un « infaisable ».',
  'alloc.question': 'Question',
  'alloc.product': 'Produit',
  'alloc.select': 'choisir…',
  'alloc.quantity': 'Quantité',
  'alloc.withinDays': 'Requis sous (jours)',
  'alloc.noDeadline': 'aucune échéance',
  'alloc.maxShare': 'Part max par fournisseur',
  'alloc.unconstrained': 'sans contrainte',
  'alloc.budget': 'Plafond budgétaire (facultatif)',
  'alloc.noCap': 'aucun plafond',
  'alloc.solve': 'résoudre',
  'alloc.solving': 'résolution…',
  'alloc.branchAndBound': 'Séparation et évaluation',
  'alloc.plan': 'Plan',
  'alloc.solvedIn': 'résolu en {ms} ms',
  'alloc.infeasible': 'Aucune répartition réalisable',
  'alloc.supplier': 'Fournisseur',
  'alloc.share': 'Part',
  'alloc.unitPrice': 'Prix unitaire',
  'alloc.leadTime': 'Délai',
  'alloc.reliability': 'Fiabilité',
  'alloc.cost': 'Coût',
  'alloc.unmet':
    '{n} unités n’ont pu être couvertes par la capacité d’aucun fournisseur.',
  'alloc.outcome': 'Résultat',
  'alloc.objective': 'Objectif',
  'alloc.objectiveHint': 'coût total modélisé',
  'alloc.expectedLeadTime': 'Délai attendu',
  'alloc.expectedLeadTimeHint': 'pondéré par les quantités',
  'alloc.shortfallRisk': 'Risque de manque',
  'alloc.shortfallRiskHint': 'compte tenu de la fiabilité fournisseur',
  'alloc.concentration': 'Concentration',
  'alloc.concentrationHint': '1,0 = source unique',
  'alloc.costBreakdown': 'Décomposition du coût',
  'alloc.constraints': 'Contraintes appliquées',
  'alloc.noPlan': 'Aucun plan pour l’instant',
  'alloc.noPlanHint':
    'Choisissez un produit et une quantité. Seuls les fournisseurs disposant d’un tarif en cours pour ce produit sont retenus.',
  'alloc.cost.purchase': 'Achat',
  'alloc.cost.transport': 'Transport',
  'alloc.cost.holding': 'Possession',
  'alloc.cost.stockoutPenalty': 'Pénalité de rupture',
  'alloc.cost.delayPenalty': 'Pénalité de retard',
  'alloc.cost.riskPenalty': 'Pénalité de risque',

  'rt.title': 'Optimisation de tournées',
  'rt.intro':
    'Tournées de véhicules sous contrainte de capacité, avec fenêtres de livraison. Le problème est NP-difficile : le solveur rend le meilleur plan trouvé dans son budget de temps — bon, mais pas prouvé optimal, d’où le statut FEASIBLE plutôt qu’OPTIMAL.',
  'rt.inputs': 'Données',
  'rt.depot': 'Dépôt',
  'rt.selectWarehouse': 'choisir un entrepôt…',
  'rt.plan': 'calculer les tournées',
  'rt.searching': 'recherche…',
  'rt.allStops': 'tous les arrêts',
  'rt.stopsSelected': 'Arrêts · {n} sélectionnés',
  'rt.hiddenNoCoords': '({n} sans coordonnées, masqués)',
  'rt.vehicles': 'Véhicules · {what}',
  'rt.vehiclesSelected': '{n} sélectionnés',
  'rt.allAvailable': 'tous les disponibles',
  'rt.guidedSearch': 'Recherche locale guidée',
  'rt.status': 'Statut',
  'rt.routes': 'Tournées',
  'rt.distance': 'Distance',
  'rt.duration': 'Durée',
  'rt.cost': 'Coût',
  'rt.unassigned':
    '{n} arrêt(s) n’ont pas pu être desservis avec la flotte sélectionnée.',
  'rt.plans': 'Plans',
  'rt.reasoning': 'Raisonnement',
  'rt.constraints': 'Contraintes',
  'rt.none': 'Aucun plan pour l’instant',
  'rt.noneHint':
    'Choisissez un dépôt et au moins un arrêt. Les clients sans coordonnées ne peuvent pas être routés et sont masqués.',

  'scn.title': 'Simulation de scénarios',
  'scn.run': 'lancer',
  'scn.running': 'simulation…',
  'scn.baseline': 'Référence',
  'scn.cases': 'Cas',
  'scn.none': 'Aucune simulation pour l’instant',

  'fc.title': 'Prévision de la demande',
  'fc.intro':
    'Six modèles s’affrontent en validation glissante et le vainqueur est réajusté sur tout l’historique. La sélection se fait sur le WAPE, pas le MAPE — le MAPE divise par la valeur réelle, donc une seule journée à demande nulle le rend infini, et les journées à demande nulle sont la norme pour les articles à faible rotation.',
  'fc.run': 'Lancer',
  'fc.product': 'Produit',
  'fc.selectProduct': 'choisir un produit…',
  'fc.horizon': 'Horizon',
  'fc.forecast': 'prévoir',
  'fc.comparing': 'comparaison des modèles…',
  'fc.validating': 'Validation glissante sur six modèles',
  'fc.chartTitle': '{sku} · prévision à {days} jours',
  'fc.interval': 'intervalle 80 %',
  'fc.series': 'Prévision',
  'fc.comparison': 'Comparaison des modèles',
  'fc.model': 'Modèle',
  'fc.notEvaluated': 'Non évalués : {list}.',
  'fc.dataQuality': 'Qualité des données',
  'fc.passed': 'validée',
  'fc.blocked': 'bloquée',
  'fc.rowsUsed': '{used} lignes utilisées sur {total}',
  'fc.residual': 'σ résiduel {value}',
  'fc.noIssue': 'Aucun problème détecté dans l’historique de demande.',
  'fc.none': 'Aucune prévision pour l’instant',
  'fc.noneHint':
    'Choisissez un produit et un horizon. Les produits ont besoin d’un historique de demande — la démo pré-remplie en contient deux ans.',

  'del.scheduled': 'Prévues',
  'del.completed': 'Effectuées',
  'del.outstanding': 'Restantes',
  'del.failed': 'Échouées',
  'del.run': 'Tournée du',
  'del.shipment': 'Expédition',
  'del.status': 'État',
  'del.customer': 'Client',
  'del.destination': 'Destination',
  'del.attempts': 'Tentatives',
  'del.note': 'Note',
  'del.none': 'Rien de prévu',
  'del.noneHint':
    'Les livraisons apparaissent ici dès qu’une expédition en a une de créée.',
  'del.podNote':
    'La preuve de livraison — signature, photos et lieu de saisie — est enregistrée depuis l’application chauffeur via {endpoint}. Le point de saisie est comparé à la destination déclarée et l’écart est stocké : une signature prise loin de là où la marchandise devait aller est le signal le plus précoce d’une erreur de livraison.',

  'sup.title': 'Performance fournisseurs',
  'sup.intro':
    'La fiabilité est calculée à partir de l’historique de commandes de chaque fournisseur, elle n’est pas saisie à la main. Les taux sont ramenés vers une valeur neutre quand les commandes sont peu nombreuses : une livraison en retard sur deux ne doit pas étiqueter un nouveau fournisseur à 50 % de fiabilité.',
  'sup.league': 'Classement',
  'sup.recompute': 'tout recalculer',
  'sup.recomputing': 'recalcul…',
  'sup.supplier': 'Fournisseur',
  'sup.country': 'Pays',
  'sup.reliability': 'Fiabilité',
  'sup.onTime': 'À l’heure',
  'sup.quality': 'Qualité',
  'sup.fillRate': 'Taux de service',
  'sup.leadTime': 'Délai',
  'sup.orders': 'Commandes',
  'sup.measured': 'mesuré',
  'sup.prior': 'a priori',
  'sup.priorNote':
    'La mention « a priori » signifie qu’aucune performance n’a encore été calculée pour ce fournisseur : le score est la valeur neutre de départ, pas une mesure. C’est la dispersion du délai qui pilote le stock de sécurité : un fournisseur à 5 ± 4 jours coûte plus de tampon qu’un fournisseur à 12 ± 0,5.',
  'sup.none': 'Aucun fournisseur',

  'notif.title': 'Alertes',
  'notif.unread': '{n} non lues',
  'notif.unreadOnly': 'non lues seulement',
  'notif.markAllRead': 'tout marquer comme lu',
  'notif.markRead': 'marquer comme lu',
  'notif.open': 'ouvrir →',
  'notif.emailFailed': 'échec de l’envoi de l’e-mail : {reason}',
  'notif.noneUnread': 'Rien de non lu',
  'notif.none': 'Aucune alerte',
  'notif.noneHint':
    'Les alertes sont routées par rôle — vous voyez ce dont votre rôle est responsable.',

  'tbl.page': 'page {page} / {total}',
  'tbl.prev': 'précédent',
  'tbl.next': 'suivant',
  'tbl.allStatuses': 'tous les états',
  'tbl.notComputed': 'non calculé',
  'tbl.demo': 'démo',
  'tbl.search': 'rechercher',

  'ship.openOnly': 'en cours seulement',
  'ship.searchPlaceholder': 'n° de suivi, origine, destination',
  'ship.progress': 'Avancement',
  'ship.eta': 'ETA',
  'ship.anomaly': 'anomalie',

  'inc.title': 'Incidents',
  'inc.window': 'Incidents · {days} j',
  'inc.stillOpen': 'Encore ouverts',
  'inc.estimatedCost': 'Coût estimé',
  'inc.bySeverity': 'Par gravité',
  'inc.type': 'Type',
  'inc.severity': 'Gravité',
  'inc.status': 'État',
  'inc.what': 'Ce qui s’est passé',
  'inc.shipment': 'Expédition',
  'inc.when': 'Quand',
  'inc.reportedBy': 'Signalé par',
  'inc.assignedTo': 'Assigné à',
  'inc.cost': 'Coût',
  'inc.none': 'Aucun incident',
  'inc.noneHint': 'Rien n’a dérapé sur cette période, ou le filtre l’exclut.',
  'inc.allStatuses': 'tous les états',
  'inc.all': 'tous',
  'inc.reportedByName': 'signalé par {name}',
  'inc.assignedToName': 'assigné à {name}',
  'inc.resolvedWhen': 'résolu {when}',

  'po.title': 'Commandes fournisseurs',
  'po.number': 'Numéro',
  'po.supplier': 'Fournisseur',
  'po.status': 'État',
  'po.lines': 'Lignes',
  'po.total': 'Total',
  'po.expectedDelivery': 'Livraison prévue',
  'po.created': 'Créée',
  'po.none': 'Aucune commande',
  'po.noneHint':
    'Accepter une recommandation ORDER_NOW en crée une ici, à l’état brouillon.',
  'po.received': 'reçue',
  'po.partiallyReceived': 'partielle',
  'po.order': 'Commande',
  'po.receiving': 'Réception',
  'po.value': 'Montant',
  'po.expected': 'Prévu',
  'po.actual': 'Réel',
  'po.reliability': 'fiabilité {score}',
  'po.raisedByAi': 'Créée en acceptant une recommandation',
  'po.moveTo': 'passer à…',
  'po.cancelReason': 'Annulée depuis l’écran des commandes',

  'inv.title': 'Stocks',
  'inv.value': 'Valeur du stock',
  'inv.skus': 'Références',
  'inv.belowReorder': 'Sous le point de commande',
  'inv.outOfStock': 'En rupture',
  'inv.product': 'Produit',
  'inv.warehouse': 'Entrepôt',
  'inv.available': 'Disponible',
  'inv.reserved': 'Réservé',
  'inv.incoming': 'Attendu',
  'inv.free': 'Libre',
  'inv.reorderPoint': 'Point de commande',
  'inv.safetyStock': 'Stock de sécurité',
  'inv.movements': 'Mouvements',
  'inv.alerts': 'Alertes de stock',
  'inv.none': 'Rien en stock',
  'inv.noneHint': 'Réceptionnez une commande, ou retirez les filtres.',
  'inv.onlyBelowReorder': 'sous le point de commande seulement',
  'inv.onlyOutOfStock': 'en rupture seulement',
  'inv.units': 'Unités',
  'inv.overstocked': 'Surstock',
  'inv.byProduct': 'Stock par produit et entrepôt',
  'inv.searchPlaceholder': 'référence ou nom',
  'inv.belowReorderShort': 'sous le point',
  'inv.reorderPtShort': 'Pt de cde',
  'inv.cover': 'Couverture',
  'inv.valueCol': 'Valeur',
  'inv.noRows': 'Aucune ligne de stock',
  'inv.openAlerts': 'Alertes ouvertes',
  'inv.reevaluate': 'réévaluer',
  'inv.sweeping': 'balayage…',
  'inv.noAlerts': 'Aucune alerte ouverte',
  'inv.noAlertsHint':
    'Les alertes se résolvent d’elles-mêmes quand la condition disparaît : une liste vide signifie que la position de stock est saine.',

  'nav.situation': 'Situation',
  'sit.title': 'Salle de situation',
  'sit.close': 'fermer',
  'sit.loading': 'Lecture…',
  'sit.unavailable': 'Source indisponible pour le moment.',
  'sit.stale': 'périmé',
  'sit.counts': '{hazards} dangers · {cameras} caméras · {radio} stations · {satellites} satellites',
  'sit.layer.hazards': 'Dangers',
  'sit.layer.cameras': 'Caméras',
  'sit.layer.radio': 'Radio',
  'sit.layer.satellites': 'Satellites',
  'sit.layer.traffic': 'Trafic',
  'sit.hint.zoomCameras': 'Zoomez pour charger les caméras de trafic publiques.',
  'sit.hint.zoomRadio': 'Zoomez pour charger les radios autour du centre.',
  'sit.hint.trafficOff': 'Le trafic en direct nécessite TOMTOM_API_KEY côté API.',
  'sit.camera.title': 'Caméra publique',
  'sit.camera.loading': 'Récupération de l’image…',
  'sit.camera.unavailable': 'Aucune image de cette caméra pour le moment.',
  'sit.camera.frameAt': 'image {time}',
  'sit.camera.refreshFailed': 'dernier rafraîchissement échoué',
  'sit.camera.every': 'toutes les {s} s',
  'sit.camera.privacy':
    'Les images sont relayées telles que l’exploitant les publie. Rien n’est stocké, aucune reconnaissance de visage ni de plaque n’est effectuée.',
  'sit.radio.title': 'Radio',
  'sit.radio.error': 'Ce flux ne se lit pas. La station est peut-être hors ligne.',
  'sit.radio.homepage': 'site de la station',
  'sit.radio.privacy':
    'Le son vient directement du diffuseur, qui voit donc votre adresse IP.',
  'sit.kind.cyclone': 'Cyclone tropical',
  'sit.kind.earthquake': 'Séisme',
  'sit.kind.fire': 'Feu actif',
  'sit.kind.weather': 'Météo sévère',
  'sit.hazard.officialSource': 'Source officielle',
  'sit.weather.title': 'Météo sur place',
  'sit.weather.wind': 'vent {wind} km/h, rafales {gust}',
  'sit.weather.severity': 'sévérité transport {pct}',
  'sit.news.title': 'Actualités locales · {q}',
  'sit.news.caveat':
    'Articles citant le lieu ces derniers jours. Correspondance par mot-clé, pas un incident confirmé.',
  'sit.news.none': 'Rien trouvé.',
  'sit.exposure.title': 'Exposition',
  'sit.exposure.radius': 'à moins de {km} km',
  'sit.exposure.none': 'Aucun actif près d’un danger actif',
  'sit.exposure.noneHint':
    'Entrepôts, expéditions en cours et fournisseurs sont comparés aux cyclones, séismes, feux et épisodes météo sévères.',
  'sit.subject.warehouse': 'Entrepôt',
  'sit.subject.shipment': 'Expédition',
  'sit.subject.supplier': 'Fournisseur',
  'sit.sat.title': 'Satellites',
  'sit.sat.group': 'Constellation',
  'sit.sat.aboveCentre': 'Au-dessus du centre · {lat}, {lon}',
  'sit.sat.visibleCount': '{n} visibles · {high} au-dessus de 30°',
  'sit.sat.quality.good': 'bon fix',
  'sit.sat.quality.fair': 'fix moyen',
  'sit.sat.quality.poor': 'fix faible',
  'sit.sat.trackHint': 'trace des 100 prochaines min',
  'sit.search.placeholder': 'Lieu ou lat, lon',
  'sit.search.none': 'Aucun lieu trouvé.',
  'sit.sources.title': 'Sources',
  'sit.sources.tiles': '{used} / {budget} tuiles aujourd’hui',

  'map.layer.traffic': 'Trafic',
  'map.nearestCameras': 'Caméras publiques les plus proches',
  'map.noCameras': 'Aucune caméra publique à moins de 50 km.',
  'map.weatherHere': 'Météo au véhicule',
};

const CATALOGUE: Record<Locale, Record<TranslationKey, string>> = { en, fr };

/** Maps the app locale to a BCP 47 tag for `Intl`. */
export const INTL_LOCALE: Record<Locale, string> = { en: 'en-GB', fr: 'fr-FR' };

interface I18nState {
  locale: Locale;
  setLocale(locale: Locale): void;
  /** `t('kpi.runningLate', { n: 3 })` → "3 running late". */
  t(key: TranslationKey, params?: Record<string, string | number>): string;
  /** BCP 47 tag for `Intl` formatters. */
  intlLocale: string;
}

const I18nContext = createContext<I18nState | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('en');

  // Read the stored choice after mount, never during render: reading localStorage on the server
  // pass would produce different markup than the client and trip a hydration mismatch.
  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && LOCALES.includes(stored as Locale)) {
      setLocaleState(stored as Locale);
      return;
    }
    // Fall back to the browser's preference, so a French-speaking user does not have to ask.
    if (navigator.language?.toLowerCase().startsWith('fr')) setLocaleState('fr');
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    window.localStorage.setItem(STORAGE_KEY, next);
  }, []);

  const t = useCallback(
    (key: TranslationKey, params?: Record<string, string | number>) => {
      // Falling back to English rather than to the key means an untranslated string reads as
      // slightly-wrong-language prose instead of `kpi.runningLate` appearing in the interface.
      const template = CATALOGUE[locale][key] ?? en[key] ?? key;
      if (!params) return template;
      return Object.entries(params).reduce(
        (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
        template,
      );
    },
    [locale],
  );

  const value = useMemo(
    () => ({ locale, setLocale, t, intlLocale: INTL_LOCALE[locale] }),
    [locale, setLocale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nState {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside an I18nProvider');
  return context;
}

/**
 * Locale-aware formatters.
 *
 * Kept separate from the dictionary because these are not translations: French renders 2 906 717
 * with a narrow no-break space and "13 août 26", and `Intl` already knows every one of those
 * rules. Hand-writing them per language is how thousands separators end up wrong.
 */
export function makeFormat(intlLocale: string) {
  return {
    int: (value: number | string | null | undefined): string =>
      value === null || value === undefined
        ? '—'
        : Math.round(Number(value)).toLocaleString(intlLocale),

    num: (value: number | string | null | undefined, decimals = 1): string =>
      value === null || value === undefined
        ? '—'
        : Number(value).toLocaleString(intlLocale, {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
          }),

    money: (value: number | string | null | undefined, currency = 'GHS'): string =>
      value === null || value === undefined
        ? '—'
        : `${currency} ${Number(value).toLocaleString(intlLocale, { maximumFractionDigits: 0 })}`,

    pct: (value: number | null | undefined, decimals = 0): string =>
      value === null || value === undefined ? '—' : `${(value * 100).toFixed(decimals)} %`,

    date: (value: string | Date | null | undefined): string =>
      !value
        ? '—'
        : new Date(value).toLocaleDateString(intlLocale, {
            day: '2-digit',
            month: 'short',
            year: '2-digit',
          }),

    time: (value: string | Date | null | undefined): string =>
      !value
        ? '—'
        : new Date(value).toLocaleTimeString(intlLocale, { hour: '2-digit', minute: '2-digit' }),

    dateTime: (value: string | Date | null | undefined): string =>
      !value ? '—' : `${new Date(value).toLocaleDateString(intlLocale, { day: '2-digit', month: 'short' })} ${new Date(value).toLocaleTimeString(intlLocale, { hour: '2-digit', minute: '2-digit' })}`,

    /** `Intl.RelativeTimeFormat` picks the right unit and grammar in both languages. */
    relative: (value: string | Date | null | undefined): string => {
      if (!value) return '—';
      const deltaMinutes = (new Date(value).getTime() - Date.now()) / 60_000;
      const formatter = new Intl.RelativeTimeFormat(intlLocale, { numeric: 'auto' });
      const magnitude = Math.abs(deltaMinutes);

      if (magnitude < 1) return formatter.format(0, 'minute');
      if (magnitude < 60) return formatter.format(Math.round(deltaMinutes), 'minute');
      if (magnitude < 1440) return formatter.format(Math.round(deltaMinutes / 60), 'hour');
      return formatter.format(Math.round(deltaMinutes / 1440), 'day');
    },
  };
}

/** Convenience hook: translations and locale-aware formatting in one call. */
export function useFormat() {
  const { intlLocale } = useI18n();
  return useMemo(() => makeFormat(intlLocale), [intlLocale]);
}
