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
