//! Orchestration tests with a fake runtime and a fake API that keeps state like the real one,
//! so a second run shows the idempotent skips.

use std::cell::RefCell;
use std::rc::Rc;

use super::output::testing::{emitter, Buffer};
use super::plan::{parse, Admin, FeedKeys, Organisation, ProvisionRequest};
use super::*;

#[derive(Default)]
struct ApiState {
    company: bool,
    demo: bool,
    demo_available: bool,
    admin_password: Option<String>,
    currency: Option<(String, String)>,
    sites: Vec<ExistingSite>,
    feeds: Option<FeedKeys>,
    calls: Vec<String>,
    /// Codes the API refuses as taken (a deactivated site the listing hides).
    hidden_codes: Vec<String>,
    geocoder_down: bool,
    fail_register_with: Option<ApiError>,
}

#[derive(Clone, Default)]
struct FakeApi(Rc<RefCell<ApiState>>);

impl FakeApi {
    fn call(&self, name: &str) {
        self.0.borrow_mut().calls.push(name.to_owned());
    }
}

impl ScipApi for FakeApi {
    fn setup_status(&self) -> Result<SetupStatus, ApiError> {
        let s = self.0.borrow();
        Ok(SetupStatus { needs_setup: !s.company, demo_available: s.demo_available, demo_accounts: s.demo })
    }
    fn register(&self, admin: &Admin, _org: &Organisation) -> Result<String, ApiError> {
        self.call("register");
        if let Some(e) = self.0.borrow_mut().fail_register_with.take() {
            return Err(e);
        }
        let mut s = self.0.borrow_mut();
        s.company = true;
        s.admin_password = Some(admin.password.clone());
        Ok("token".into())
    }
    fn login(&self, _email: &str, password: &str) -> Result<String, ApiError> {
        self.call("login");
        let s = self.0.borrow();
        let ok = s.admin_password.as_deref() == Some(password) || (s.demo && password == DEMO_ADMIN_PASSWORD);
        if ok {
            Ok("token".into())
        } else {
            Err(ApiError::Status { status: 401, message: "Invalid email or password".into() })
        }
    }
    fn update_company(&self, _t: &str, currency: &str, timezone: &str) -> Result<(), ApiError> {
        self.call("update_company");
        self.0.borrow_mut().currency = Some((currency.into(), timezone.into()));
        Ok(())
    }
    fn warehouses(&self, _t: &str) -> Result<Vec<ExistingSite>, ApiError> {
        Ok(self.0.borrow().sites.clone())
    }
    fn geocode(&self, _t: &str, _q: &str) -> Result<Option<(f64, f64)>, ApiError> {
        if self.0.borrow().geocoder_down {
            Ok(None)
        } else {
            Ok(Some((6.69, -1.62)))
        }
    }
    fn create_warehouse(&self, _t: &str, w: &NewWarehouse) -> Result<(), ApiError> {
        self.call(&format!("create_warehouse {} {} {:.2}", w.code, w.name, w.latitude));
        let mut s = self.0.borrow_mut();
        if s.hidden_codes.contains(&w.code) || s.sites.iter().any(|x| x.code == w.code) {
            return Err(ApiError::Status { status: 409, message: "code taken".into() });
        }
        s.sites.push(ExistingSite { code: w.code.clone(), name: w.name.clone() });
        Ok(())
    }
    fn update_feeds(&self, _t: &str, keys: &FeedKeys) -> Result<(), ApiError> {
        self.call("update_feeds");
        self.0.borrow_mut().feeds = Some(keys.clone());
        Ok(())
    }
    fn load_demo(&self) -> Result<(), ApiError> {
        self.call("load_demo");
        let mut s = self.0.borrow_mut();
        s.demo = true;
        s.company = true;
        Ok(())
    }
}

#[derive(Default)]
struct FakeRuntime {
    api: FakeApi,
    calls: Vec<String>,
    updates: Vec<ConfigUpdate>,
    fail_migrate: Option<ProvisionError>,
}

impl Runtime for FakeRuntime {
    type Api = FakeApi;
    fn prepare(&mut self, update: &ConfigUpdate) -> Result<(), ProvisionError> {
        self.calls.push("prepare".into());
        self.updates.push(update.clone());
        Ok(())
    }
    fn database(&mut self) -> Result<Status, ProvisionError> {
        self.calls.push("database".into());
        Ok(Status::Done)
    }
    fn migrate(&mut self) -> Result<(), ProvisionError> {
        self.calls.push("migrate".into());
        match self.fail_migrate.take() {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
    fn start_services(&mut self) -> Result<FakeApi, ProvisionError> {
        self.calls.push("services".into());
        Ok(self.api.clone())
    }
    fn stop_all(&mut self) {
        self.calls.push("stop".into());
    }
}

const PRODUCTION: &str = r#"{
  "kind": "production",
  "database": { "mode": "embedded" },
  "organisation": { "name": "Test Org", "country": "GH", "currency": "GHS", "timezone": "Africa/Accra",
    "sites": [ { "name": "Tema DC", "city": "Tema", "latitude": 5.67, "longitude": -0.01 }, { "name": "Kumasi", "city": "Kumasi" } ] },
  "sources": { "vehicles": "live", "aisStreamKey": "ais-secret-key" },
  "admin": { "firstName": "Ama", "lastName": "Mensah", "email": "ama@test.org", "password": "Str0ng-Passphrase!" },
  "desktopShortcut": false
}"#;

const DEMO: &str =
    r#"{ "kind": "demo", "database": { "mode": "embedded" }, "sources": { "tomtomKey": "tt-key-123" } }"#;

fn run(json: &str, rt: &mut FakeRuntime) -> (Result<(), ProvisionError>, Buffer) {
    let request: ProvisionRequest = parse(json).unwrap();
    let (out, buf) = emitter();
    if let ProvisionRequest::Install(plan) = &request {
        out.add_secrets(plan.sensitive_values());
    }
    (provision(&request, rt, &out), buf)
}

/// `(step, final status)` pairs, in order.
fn outcomes(buf: &Buffer) -> Vec<(String, String)> {
    buf.lines()
        .into_iter()
        .filter(|l| l.get("step").is_some() && l["status"] != "running")
        .map(|l| (l["step"].as_str().unwrap().to_owned(), l["status"].as_str().unwrap().to_owned()))
        .collect()
}

fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
    items.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
}

#[test]
fn production_runs_every_step_then_stops() {
    let mut rt = FakeRuntime::default();
    let (result, buf) = run(PRODUCTION, &mut rt);
    result.unwrap();
    assert_eq!(
        outcomes(&buf),
        pairs(&[
            ("prepare", "done"),
            ("database", "done"),
            ("migrate", "done"),
            ("services", "done"),
            ("organisation", "done"),
            ("admin", "done"),
            ("sites", "done"),
            ("sources", "done"),
            ("demo", "skipped"),
            ("stop", "done"),
        ])
    );
    assert_eq!(rt.calls.last().map(String::as_str), Some("stop"));
    assert_eq!(rt.updates[0].simulator, Some(false));
    let state = rt.api.0.borrow();
    assert_eq!(state.currency, Some(("GHS".into(), "Africa/Accra".into())));
    assert_eq!(state.sites.iter().map(|s| s.code.as_str()).collect::<Vec<_>>(), vec!["WH-001", "WH-002"]);
    assert!(
        state.calls.contains(&"create_warehouse WH-002 Kumasi 6.69".to_owned()),
        "geocoded: {:?}",
        state.calls
    );
    assert_eq!(state.feeds.as_ref().unwrap().ais_stream_api_key.as_deref(), Some("ais-secret-key"));
}

#[test]
fn every_running_line_is_followed_by_its_outcome() {
    let mut rt = FakeRuntime::default();
    let (_, buf) = run(PRODUCTION, &mut rt);
    let steps: Vec<serde_json::Value> = buf.lines().into_iter().filter(|l| l.get("step").is_some()).collect();
    for pair in steps.chunks(2) {
        assert_eq!(pair[0]["status"], "running");
        assert_eq!(pair[0]["step"], pair[1]["step"]);
        assert!(pair[0]["label"].as_str().is_some_and(|l| !l.is_empty()));
    }
}

#[test]
fn second_run_skips_what_exists() {
    let mut rt = FakeRuntime::default();
    run(PRODUCTION, &mut rt).0.unwrap();
    rt.api.0.borrow_mut().calls.clear();
    let (result, buf) = run(PRODUCTION, &mut rt);
    result.unwrap();
    let out = outcomes(&buf);
    assert!(out.contains(&("organisation".into(), "skipped".into())));
    assert!(out.contains(&("admin".into(), "skipped".into())));
    assert!(out.contains(&("sites".into(), "skipped".into())));
    let calls = rt.api.0.borrow().calls.clone();
    assert!(!calls.contains(&"register".to_owned()));
    assert!(calls.iter().all(|c| !c.starts_with("create_warehouse")), "{calls:?}");
    assert_eq!(rt.api.0.borrow().sites.len(), 2);
    // Currency is re-applied: it completes a run that died right after registering.
    assert!(calls.contains(&"update_company".to_owned()));
}

#[test]
fn existing_company_with_other_admin_is_a_clear_non_retryable_error() {
    let mut rt = FakeRuntime::default();
    {
        let mut s = rt.api.0.borrow_mut();
        s.company = true;
        s.admin_password = Some("Another-Passw0rd!".into());
    }
    let (result, buf) = run(PRODUCTION, &mut rt);
    let error = result.unwrap_err();
    assert_eq!(
        (error.step, error.code.as_str(), error.retryable),
        (StepId::Organisation, "already-set-up", false)
    );
    assert_eq!(rt.calls.last().map(String::as_str), Some("stop"), "services are stopped on failure too");
    assert!(!buf.text().contains("Str0ng-Passphrase!"));
}

#[test]
fn taken_codes_are_skipped_and_offline_sites_still_created() {
    let mut rt = FakeRuntime::default();
    {
        let mut s = rt.api.0.borrow_mut();
        s.hidden_codes = vec!["WH-001".into()];
        s.geocoder_down = true;
    }
    let (result, buf) = run(PRODUCTION, &mut rt);
    result.unwrap();
    let codes: Vec<String> = rt.api.0.borrow().sites.iter().map(|s| s.code.clone()).collect();
    assert_eq!(codes, vec!["WH-002", "WH-003"]);
    assert!(buf.text().contains("0, 0"), "the log tells the user to place the site");
}

#[test]
fn next_code_finds_the_first_free_number() {
    let taken: HashSet<String> = ["WH-001".to_owned(), "WH-003".to_owned()].into_iter().collect();
    assert_eq!(next_code(&taken, 1), ("WH-002".to_owned(), 2));
    assert_eq!(next_code(&taken, 3), ("WH-004".to_owned(), 4));
}

#[test]
fn demo_loads_once_then_stores_keys_as_the_demo_admin() {
    let mut rt = FakeRuntime::default();
    rt.api.0.borrow_mut().demo_available = true;
    let (result, buf) = run(DEMO, &mut rt);
    result.unwrap();
    assert_eq!(
        outcomes(&buf),
        pairs(&[
            ("prepare", "done"),
            ("database", "done"),
            ("migrate", "done"),
            ("services", "done"),
            ("organisation", "skipped"),
            ("admin", "skipped"),
            ("sites", "skipped"),
            ("demo", "done"),
            ("sources", "done"),
            ("stop", "done"),
        ])
    );
    assert_eq!(rt.updates[0].simulator, Some(true));
    assert_eq!(rt.api.0.borrow().feeds.as_ref().unwrap().tomtom_api_key.as_deref(), Some("tt-key-123"));

    let (again, buf) = run(DEMO, &mut rt);
    again.unwrap();
    assert!(outcomes(&buf).contains(&("demo".into(), "skipped".into())));
    assert_eq!(rt.api.0.borrow().calls.iter().filter(|c| *c == "load_demo").count(), 1);
}

#[test]
fn demo_refuses_a_database_with_a_real_company() {
    let mut rt = FakeRuntime::default();
    {
        let mut s = rt.api.0.borrow_mut();
        s.company = true;
        s.demo_available = true;
    }
    let error = run(DEMO, &mut rt).0.unwrap_err();
    assert_eq!((error.step, error.code.as_str()), (StepId::Demo, "already-set-up"));
}

#[test]
fn demo_unavailable_in_this_build() {
    let mut rt = FakeRuntime::default();
    let error = run(DEMO, &mut rt).0.unwrap_err();
    assert_eq!(error.code, "demo-unavailable");
}

#[test]
fn upgrade_only_touches_the_database() {
    let mut rt = FakeRuntime::default();
    let (result, buf) = run(r#"{"upgrade":true}"#, &mut rt);
    result.unwrap();
    assert_eq!(rt.calls, vec!["prepare", "database", "migrate", "stop"]);
    assert_eq!(rt.updates[0], ConfigUpdate::default(), "upgrade keeps the existing config");
    assert_eq!(
        outcomes(&buf),
        pairs(&[("prepare", "done"), ("database", "done"), ("migrate", "done"), ("stop", "done")])
    );
}

#[test]
fn a_failed_step_stops_the_run_and_the_services() {
    let mut rt = FakeRuntime {
        fail_migrate: Some(ProvisionError::new(StepId::Migrate, "db-unreachable", "down", true)),
        ..FakeRuntime::default()
    };
    let (result, buf) = run(PRODUCTION, &mut rt);
    assert_eq!(result.unwrap_err().code, "db-unreachable");
    assert_eq!(rt.calls, vec!["prepare", "database", "migrate", "stop"]);
    let out = outcomes(&buf);
    assert!(!out.iter().any(|(s, _)| s == "services"));
}

#[test]
fn api_errors_map_to_retryable_or_not() {
    let map = |e: ApiError| {
        let p = api_error(StepId::Sites, e);
        (p.code, p.retryable)
    };
    assert_eq!(map(ApiError::Network("refused".into())), ("network".into(), true));
    assert_eq!(map(ApiError::Timeout), ("timeout".into(), true));
    assert_eq!(map(ApiError::Status { status: 503, message: String::new() }), ("server-error".into(), true));
    assert_eq!(map(ApiError::Status { status: 429, message: String::new() }), ("rate-limited".into(), true));
    assert_eq!(
        map(ApiError::Status { status: 400, message: String::new() }),
        ("invalid-request".into(), false)
    );
    assert_eq!(map(ApiError::Status { status: 401, message: String::new() }), ("unauthorized".into(), false));
    assert_eq!(map(ApiError::Decode("x".into())), ("bad-response".into(), false));
}

#[test]
fn register_network_failure_is_retryable_and_rerun_completes() {
    let mut rt = FakeRuntime::default();
    rt.api.0.borrow_mut().fail_register_with = Some(ApiError::Network("connection reset".into()));
    let error = run(PRODUCTION, &mut rt).0.unwrap_err();
    assert_eq!((error.step, error.retryable), (StepId::Organisation, true));
    run(PRODUCTION, &mut rt).0.unwrap();
    assert!(rt.api.0.borrow().company);
}

#[test]
fn passwords_never_reach_the_output() {
    let mut rt = FakeRuntime::default();
    rt.api.0.borrow_mut().fail_register_with =
        Some(ApiError::Status { status: 400, message: "password Str0ng-Passphrase! rejected".into() });
    let request: ProvisionRequest = parse(PRODUCTION).unwrap();
    let (out, buf) = emitter();
    let ProvisionRequest::Install(plan) = &request else { panic!() };
    out.add_secrets(plan.sensitive_values());
    let error = provision(&request, &mut rt, &out).unwrap_err();
    out.error(&error);
    let text: String = buf.text();
    assert!(!text.contains("Str0ng-Passphrase!"), "{text}");
    assert!(text.contains("password *** rejected"));
    let last: serde_json::Value = buf.lines().pop().unwrap();
    assert_eq!(last["error"]["step"], "organisation");
}
