//! `scip-desktop.exe --provision`: the installer's headless half (docs/installer.md,
//! "Provisionnement").
//!
//! The installer pipes an install plan on stdin; this module prepares the data folder, the
//! database and the schema, starts the API, applies the plan through the API (the same code
//! paths as the app's own screens, so validation and auditing are not duplicated), then stops
//! everything. Each step reports on stdout (`output.rs`).
//!
//! Idempotent by design: the installer's "Réessayer" simply runs it again, and every step
//! checks what already exists before acting.
//!
//! The orchestration below is generic over [`Runtime`] (processes) and [`ScipApi`] (HTTP) so
//! it is tested with fakes; `runtime.rs` and `api_client.rs` are the real implementations.

pub mod api_client;
pub mod output;
pub mod plan;
pub mod runtime;

use std::collections::HashSet;
use std::io::Read;
use std::sync::Arc;

use output::{Emitter, ProvisionError, Status, StepId};
use plan::{Admin, FeedKeys, InstallPlan, Kind, Organisation, ProvisionRequest, Site};

use crate::secrets::DatabaseConfig;

/// The demo seed's administrator (apps/api/prisma/seed.ts), used only to store feed keys the
/// user typed on a demo install.
const DEMO_ADMIN_EMAIL: &str = "admin@demo-scip.com";
const DEMO_ADMIN_PASSWORD: &str = "DemoPassw0rd!2026";

/// The plan is a few KB; anything bigger is not from our installer.
const MAX_PLAN_BYTES: u64 = 1024 * 1024;

// ------------------------------------------------------------------------------ seams

/// What the orchestration asks of `config.json` before anything starts.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ConfigUpdate {
    pub database: Option<DatabaseConfig>,
    pub simulator: Option<bool>,
}

/// Local processes: folders, database, migrations, services.
pub trait Runtime {
    type Api: ScipApi;
    fn prepare(&mut self, update: &ConfigUpdate) -> Result<(), ProvisionError>;
    /// Embedded: create/start the cluster. External: check the server answers.
    fn database(&mut self) -> Result<Status, ProvisionError>;
    fn migrate(&mut self) -> Result<(), ProvisionError>;
    /// Starts the AI (optional) and the API, returns a client for the API.
    fn start_services(&mut self) -> Result<Self::Api, ProvisionError>;
    fn stop_all(&mut self);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SetupStatus {
    pub needs_setup: bool,
    pub demo_available: bool,
    pub demo_accounts: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExistingSite {
    pub code: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NewWarehouse {
    pub code: String,
    pub name: String,
    pub country: String,
    pub city: Option<String>,
    pub latitude: f64,
    pub longitude: f64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiError {
    /// Could not connect or the connection broke.
    Network(String),
    Timeout,
    Status {
        status: u16,
        message: String,
    },
    /// The API answered something we could not read.
    Decode(String),
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Network(m) => write!(f, "API injoignable : {m}"),
            Self::Timeout => f.write_str("l'API n'a pas répondu à temps"),
            Self::Status { status, message } => write!(f, "l'API a répondu {status} : {message}"),
            Self::Decode(m) => write!(f, "réponse de l'API illisible : {m}"),
        }
    }
}

/// The subset of the SCIP API the installer needs. Tokens are access tokens.
pub trait ScipApi {
    fn setup_status(&self) -> Result<SetupStatus, ApiError>;
    fn register(&self, admin: &Admin, org: &Organisation) -> Result<String, ApiError>;
    fn login(&self, email: &str, password: &str) -> Result<String, ApiError>;
    fn update_company(&self, token: &str, currency: &str, timezone: &str) -> Result<(), ApiError>;
    fn warehouses(&self, token: &str) -> Result<Vec<ExistingSite>, ApiError>;
    /// First match for a free-text place, `None` when nobody could answer (offline).
    fn geocode(&self, token: &str, query: &str) -> Result<Option<(f64, f64)>, ApiError>;
    fn create_warehouse(&self, token: &str, warehouse: &NewWarehouse) -> Result<(), ApiError>;
    fn update_feeds(&self, token: &str, keys: &FeedKeys) -> Result<(), ApiError>;
    fn load_demo(&self) -> Result<(), ApiError>;
}

// ------------------------------------------------------------------------------ errors

/// Network trouble, timeouts, throttling and server errors are worth a retry; a 4xx means the
/// plan itself is wrong and retrying would fail the same way.
pub fn api_error(step: StepId, error: ApiError) -> ProvisionError {
    let message: String = error.to_string();
    let (code, retryable) = match &error {
        ApiError::Network(_) => ("network", true),
        ApiError::Timeout => ("timeout", true),
        ApiError::Status { status: 401, .. } => ("unauthorized", false),
        ApiError::Status { status: 403, .. } => ("forbidden", false),
        ApiError::Status { status: 409, .. } => ("conflict", false),
        ApiError::Status { status: 400 | 422, .. } => ("invalid-request", false),
        ApiError::Status { status: 429, .. } => ("rate-limited", true),
        ApiError::Status { status, .. } if *status >= 500 => ("server-error", true),
        ApiError::Status { .. } => ("http-error", false),
        ApiError::Decode(_) => ("bad-response", false),
    };
    ProvisionError::new(step, code, message, retryable)
}

// ------------------------------------------------------------------------------ orchestration

/// Runs the whole provisioning, then always stops the services (even after a failure, so the
/// installer never leaves a Postgres holding the data folder).
pub fn provision<R: Runtime>(
    request: &ProvisionRequest,
    rt: &mut R,
    out: &Emitter,
) -> Result<(), ProvisionError> {
    let result: Result<(), ProvisionError> = run_steps(request, rt, out);
    out.step(StepId::Stop, Status::Running);
    rt.stop_all();
    out.step(StepId::Stop, Status::Done);
    result
}

fn run_steps<R: Runtime>(
    request: &ProvisionRequest,
    rt: &mut R,
    out: &Emitter,
) -> Result<(), ProvisionError> {
    let update: ConfigUpdate = match request {
        ProvisionRequest::Upgrade => ConfigUpdate::default(),
        ProvisionRequest::Install(plan) => {
            ConfigUpdate { database: Some(plan.database_config()), simulator: Some(plan.simulator()) }
        }
    };
    step(out, StepId::Prepare, || rt.prepare(&update).map(|()| Status::Done))?;
    step(out, StepId::Database, || rt.database())?;
    step(out, StepId::Migrate, || rt.migrate().map(|()| Status::Done))?;

    let ProvisionRequest::Install(plan) = request else { return Ok(()) };
    let api: R::Api =
        step_with(out, StepId::Services, || rt.start_services().map(|api| (Status::Done, api)))?;
    match plan.kind {
        Kind::Production => apply_production(plan, &api, out),
        Kind::Demo => apply_demo(plan, &api, out),
    }
}

fn step(
    out: &Emitter,
    id: StepId,
    run: impl FnOnce() -> Result<Status, ProvisionError>,
) -> Result<(), ProvisionError> {
    step_with(out, id, || run().map(|status| (status, ())))
}

fn step_with<T>(
    out: &Emitter,
    id: StepId,
    run: impl FnOnce() -> Result<(Status, T), ProvisionError>,
) -> Result<T, ProvisionError> {
    out.step(id, Status::Running);
    let (status, value) = run()?;
    out.step(id, status);
    Ok(value)
}

fn skip(out: &Emitter, id: StepId) {
    out.step(id, Status::Running);
    out.step(id, Status::Skipped);
}

fn apply_production(plan: &InstallPlan, api: &impl ScipApi, out: &Emitter) -> Result<(), ProvisionError> {
    // `validate` guarantees both for production.
    let (Some(org), Some(admin)) = (&plan.organisation, &plan.admin) else {
        return Err(ProvisionError::new(
            StepId::Organisation,
            "invalid-plan",
            "organisation ou administrateur manquant",
            false,
        ));
    };

    // Registration creates the company and its administrator together (one API transaction).
    out.step(StepId::Organisation, Status::Running);
    let status: SetupStatus = api.setup_status().map_err(|e| api_error(StepId::Organisation, e))?;
    let (token, created): (String, bool) = if status.needs_setup {
        (api.register(admin, org).map_err(|e| api_error(StepId::Organisation, e))?, true)
    } else {
        out.log("L'organisation existe déjà ; connexion avec le compte administrateur.");
        (login_admin(api, admin)?, false)
    };
    // Re-applied on every run: cheap, and it completes a run interrupted right after registering.
    api.update_company(&token, org.currency.trim(), org.timezone.trim())
        .map_err(|e| api_error(StepId::Organisation, e))?;
    out.step(StepId::Organisation, if created { Status::Done } else { Status::Skipped });

    out.step(StepId::Admin, Status::Running);
    out.step(StepId::Admin, if created { Status::Done } else { Status::Skipped });

    step(out, StepId::Sites, || create_sites(api, &token, org, out))?;
    step(out, StepId::Sources, || save_sources(api, &token, &plan.feed_keys()))?;
    skip(out, StepId::Demo);
    Ok(())
}

fn login_admin(api: &impl ScipApi, admin: &Admin) -> Result<String, ProvisionError> {
    api.login(admin.email.trim(), &admin.password).map_err(|e| match e {
        ApiError::Status { status: 401, .. } => ProvisionError::new(
            StepId::Organisation,
            "already-set-up",
            "SCIP est déjà configuré dans cette base avec un autre compte administrateur (ou un autre mot de passe).",
            false,
        ),
        other => api_error(StepId::Organisation, other),
    })
}

fn apply_demo(plan: &InstallPlan, api: &impl ScipApi, out: &Emitter) -> Result<(), ProvisionError> {
    skip(out, StepId::Organisation);
    skip(out, StepId::Admin);
    skip(out, StepId::Sites);
    // Before the sources: storing keys needs the demo administrator the seed creates.
    step(out, StepId::Demo, || load_demo(api))?;
    let keys: FeedKeys = plan.feed_keys();
    step(out, StepId::Sources, || {
        if keys.is_empty() {
            return Ok(Status::Skipped);
        }
        let token: String =
            api.login(DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD).map_err(|e| api_error(StepId::Sources, e))?;
        save_sources(api, &token, &keys)
    })
}

fn load_demo(api: &impl ScipApi) -> Result<Status, ProvisionError> {
    let status: SetupStatus = api.setup_status().map_err(|e| api_error(StepId::Demo, e))?;
    if status.demo_accounts {
        return Ok(Status::Skipped);
    }
    if !status.needs_setup {
        return Err(ProvisionError::new(
            StepId::Demo,
            "already-set-up",
            "Cette base contient déjà une organisation : les données de démonstration ne peuvent pas y être chargées.",
            false,
        ));
    }
    if !status.demo_available {
        return Err(ProvisionError::new(
            StepId::Demo,
            "demo-unavailable",
            "Les données de démonstration ne sont pas incluses dans cette version.",
            false,
        ));
    }
    api.load_demo().map_err(|e| api_error(StepId::Demo, e))?;
    Ok(Status::Done)
}

fn save_sources(api: &impl ScipApi, token: &str, keys: &FeedKeys) -> Result<Status, ProvisionError> {
    if keys.is_empty() {
        return Ok(Status::Skipped);
    }
    api.update_feeds(token, keys).map_err(|e| api_error(StepId::Sources, e))?;
    Ok(Status::Done)
}

fn normalise(name: &str) -> String {
    name.trim().to_lowercase()
}

/// `WH-001`, `WH-002`... the first one not taken.
pub fn next_code(taken: &HashSet<String>, from: usize) -> (String, usize) {
    let mut n: usize = from.max(1);
    loop {
        let code: String = format!("WH-{n:03}");
        if !taken.contains(&code.to_uppercase()) {
            return (code, n);
        }
        n += 1;
    }
}

/// Codes can collide with deactivated sites the listing does not show; a few tries suffice.
const MAX_CODE_ATTEMPTS: usize = 20;

fn create_sites(
    api: &impl ScipApi,
    token: &str,
    org: &Organisation,
    out: &Emitter,
) -> Result<Status, ProvisionError> {
    if org.sites.is_empty() {
        return Ok(Status::Skipped);
    }
    let existing: Vec<ExistingSite> = api.warehouses(token).map_err(|e| api_error(StepId::Sites, e))?;
    let names: HashSet<String> = existing.iter().map(|s| normalise(&s.name)).collect();
    let mut taken: HashSet<String> = existing.iter().map(|s| s.code.to_uppercase()).collect();
    let mut created: usize = 0;
    let mut counter: usize = 1;
    for site in &org.sites {
        if names.contains(&normalise(&site.name)) {
            out.log(&format!("Le site « {} » existe déjà.", site.name.trim()));
            continue;
        }
        let (latitude, longitude) = site_position(api, token, site, org, out)?;
        let mut attempt: usize = 0;
        loop {
            let (code, n) = next_code(&taken, counter);
            counter = n + 1;
            taken.insert(code.clone());
            let warehouse = NewWarehouse {
                code,
                name: site.name.trim().to_owned(),
                country: org.country.trim().to_owned(),
                city: site.city.as_deref().map(str::trim).filter(|c| !c.is_empty()).map(str::to_owned),
                latitude,
                longitude,
            };
            match api.create_warehouse(token, &warehouse) {
                Ok(()) => {
                    out.log(&format!("Site « {} » créé ({}).", warehouse.name, warehouse.code));
                    created += 1;
                    break;
                }
                Err(ApiError::Status { status: 409, .. }) if attempt + 1 < MAX_CODE_ATTEMPTS => attempt += 1,
                Err(e) => return Err(api_error(StepId::Sites, e)),
            }
        }
    }
    Ok(if created > 0 { Status::Done } else { Status::Skipped })
}

/// Given coordinates win; otherwise the API's geocoder (needs internet). Offline, the site is
/// still created so the rest of the install proceeds, and the log says to place it by hand.
fn site_position(
    api: &impl ScipApi,
    token: &str,
    site: &Site,
    org: &Organisation,
    out: &Emitter,
) -> Result<(f64, f64), ProvisionError> {
    if let (Some(lat), Some(lng)) = (site.latitude, site.longitude) {
        return Ok((lat, lng));
    }
    let place: &str =
        site.city.as_deref().map(str::trim).filter(|c| !c.is_empty()).unwrap_or(site.name.trim());
    let query: String = format!("{place}, {}", org.country.trim());
    match api.geocode(token, &query) {
        Ok(Some(position)) => return Ok(position),
        Ok(None) => {}
        // A geocoder hiccup must not fail the install over an optional convenience.
        Err(e) => out.log(&format!("Géolocalisation indisponible : {e}")),
    }
    out.log(&format!(
        "Position du site « {} » introuvable : placé en 0, 0, à corriger dans SCIP (Données de base → Entrepôts).",
        site.name.trim()
    ));
    Ok((0.0, 0.0))
}

// ------------------------------------------------------------------------------ entry point

/// `scip-desktop.exe --provision`. Returns the process exit code.
pub fn run_cli() -> i32 {
    let out: Arc<Emitter> = Arc::new(Emitter::stdout());
    runtime::install_logger(Arc::clone(&out));
    let request: ProvisionRequest = match read_request() {
        Ok(request) => request,
        Err(message) => {
            out.error(&ProvisionError::new(StepId::Prepare, "invalid-plan", message, false));
            return 1;
        }
    };
    let mut external: Option<plan::ExternalDatabase> = None;
    if let ProvisionRequest::Install(plan) = &request {
        out.add_secrets(plan.sensitive_values());
        if let plan::DatabasePlan::External(db) = &plan.database {
            external = Some(db.clone());
        }
    }
    let mut rt = runtime::SupervisorRuntime::from_process_env(Arc::clone(&out), external);
    match provision(&request, &mut rt, &out) {
        Ok(()) => 0,
        Err(error) => {
            out.error(&error);
            1
        }
    }
}

fn read_request() -> Result<ProvisionRequest, String> {
    let mut input: String = String::new();
    std::io::stdin()
        .take(MAX_PLAN_BYTES)
        .read_to_string(&mut input)
        .map_err(|e| format!("lecture du plan sur l'entrée standard impossible : {e}"))?;
    if input.trim().is_empty() {
        return Err("aucun plan reçu sur l'entrée standard".to_owned());
    }
    plan::parse(&input).map_err(|e| e.0)
}

#[cfg(test)]
mod tests;
