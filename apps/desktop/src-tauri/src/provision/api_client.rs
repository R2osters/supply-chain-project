//! [`ScipApi`] over HTTP with `ureq`: blocking, no TLS (the API is on 127.0.0.1), no async
//! runtime to start for a dozen requests.

use std::time::Duration;

use serde_json::{json, Map, Value};
use ureq::http::Response;
use ureq::{Agent, Body};

use super::plan::{Admin, FeedKeys, Organisation};
use super::{ApiError, ExistingSite, NewWarehouse, ScipApi, SetupStatus};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// The demo seed writes thousands of rows before the API answers.
const DEMO_TIMEOUT: Duration = Duration::from_secs(20 * 60);
/// The listing endpoint's maximum page size; an install has a handful of sites.
const PAGE_SIZE: &str = "200";

pub struct HttpApi {
    /// `http://127.0.0.1:<port>/api/v1`
    base: String,
    agent: Agent,
    slow: Agent,
}

fn agent(timeout: Duration) -> Agent {
    Agent::config_builder()
        // Statuses are handled here, with the API's message; not as opaque transport errors.
        .http_status_as_error(false)
        .timeout_global(Some(timeout))
        .build()
        .into()
}

impl HttpApi {
    pub fn new(base: impl Into<String>) -> Self {
        Self {
            base: base.into().trim_end_matches('/').to_owned(),
            agent: agent(REQUEST_TIMEOUT),
            slow: agent(DEMO_TIMEOUT),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}/{}", self.base, path.trim_start_matches('/'))
    }
}

fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

fn transport(error: ureq::Error) -> ApiError {
    match error {
        ureq::Error::Timeout(_) => ApiError::Timeout,
        other => ApiError::Network(other.to_string()),
    }
}

/// Reads the body and turns a non-2xx into [`ApiError::Status`] with the API's own message
/// (`{ message: string | string[] }`, see the API's exception filter).
fn read(result: Result<Response<Body>, ureq::Error>) -> Result<Value, ApiError> {
    let response: Response<Body> = result.map_err(transport)?;
    let status: u16 = response.status().as_u16();
    let text: String = response.into_body().read_to_string().map_err(transport)?;
    let body: Value = if text.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&text).unwrap_or(Value::String(text))
    };
    if (200..300).contains(&status) {
        Ok(body)
    } else {
        Err(ApiError::Status { status, message: error_message(&body) })
    }
}

pub fn error_message(body: &Value) -> String {
    match body.get("message") {
        Some(Value::String(m)) => m.clone(),
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ; "),
        _ => match body {
            Value::String(s) => s.chars().take(300).collect(),
            _ => "sans détail".to_owned(),
        },
    }
}

fn access_token(body: &Value) -> Result<String, ApiError> {
    body.get("accessToken")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| ApiError::Decode("accessToken absent".to_owned()))
}

/// The JSON body for `PUT /settings/feeds`: only the keys to set, since an absent key means
/// "leave unchanged" and the API rejects unknown ones.
pub fn feeds_body(keys: &FeedKeys) -> Value {
    let mut body: Map<String, Value> = Map::new();
    let pairs = [
        ("aisStreamApiKey", &keys.ais_stream_api_key),
        ("openskyClientId", &keys.opensky_client_id),
        ("openskyClientSecret", &keys.opensky_client_secret),
        ("tomtomApiKey", &keys.tomtom_api_key),
    ];
    for (name, value) in pairs {
        if let Some(value) = value {
            body.insert(name.to_owned(), Value::String(value.clone()));
        }
    }
    Value::Object(body)
}

pub fn warehouse_body(w: &NewWarehouse) -> Value {
    let mut body = json!({
        "code": w.code,
        "name": w.name,
        "country": w.country,
        "latitude": w.latitude,
        "longitude": w.longitude,
    });
    if let Some(city) = &w.city {
        body["city"] = Value::String(city.clone());
    }
    body
}

pub fn parse_sites(body: &Value) -> Vec<ExistingSite> {
    body.get("data")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .map(|row| ExistingSite {
                    code: row.get("code").and_then(Value::as_str).unwrap_or_default().to_owned(),
                    name: row.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(),
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn parse_geocode(body: &Value) -> Option<(f64, f64)> {
    let first: &Value = body.get("results")?.as_array()?.first()?;
    Some((first.get("latitude")?.as_f64()?, first.get("longitude")?.as_f64()?))
}

impl ScipApi for HttpApi {
    fn setup_status(&self) -> Result<SetupStatus, ApiError> {
        let body: Value = read(self.agent.get(self.url("setup/status")).call())?;
        let flag = |name: &str| body.get(name).and_then(Value::as_bool);
        match (flag("needsSetup"), flag("demoAvailable"), flag("demoAccounts")) {
            (Some(needs_setup), demo_available, demo_accounts) => Ok(SetupStatus {
                needs_setup,
                demo_available: demo_available.unwrap_or(false),
                demo_accounts: demo_accounts.unwrap_or(false),
            }),
            _ => Err(ApiError::Decode("setup/status sans needsSetup".to_owned())),
        }
    }

    fn register(&self, admin: &Admin, org: &Organisation) -> Result<String, ApiError> {
        let body = json!({
            "email": admin.email.trim(),
            "password": admin.password,
            "firstName": admin.first_name.trim(),
            "lastName": admin.last_name.trim(),
            "companyName": org.name.trim(),
            "companyCountry": org.country.trim(),
        });
        access_token(&read(self.agent.post(self.url("auth/register")).send_json(body))?)
    }

    fn login(&self, email: &str, password: &str) -> Result<String, ApiError> {
        let body = json!({ "email": email, "password": password });
        access_token(&read(self.agent.post(self.url("auth/login")).send_json(body))?)
    }

    fn update_company(&self, token: &str, currency: &str, timezone: &str) -> Result<(), ApiError> {
        let body = json!({ "currency": currency, "timezone": timezone });
        read(
            self.agent.patch(self.url("companies/me")).header("Authorization", bearer(token)).send_json(body),
        )
        .map(drop)
    }

    fn warehouses(&self, token: &str) -> Result<Vec<ExistingSite>, ApiError> {
        let request = self.agent.get(self.url("warehouses")).query("limit", PAGE_SIZE);
        Ok(parse_sites(&read(request.header("Authorization", bearer(token)).call())?))
    }

    fn geocode(&self, token: &str, query: &str) -> Result<Option<(f64, f64)>, ApiError> {
        let request = self.agent.get(self.url("geocode")).query("q", query).query("limit", "1");
        Ok(parse_geocode(&read(request.header("Authorization", bearer(token)).call())?))
    }

    fn create_warehouse(&self, token: &str, warehouse: &NewWarehouse) -> Result<(), ApiError> {
        let request = self.agent.post(self.url("warehouses")).header("Authorization", bearer(token));
        read(request.send_json(warehouse_body(warehouse))).map(drop)
    }

    fn update_feeds(&self, token: &str, keys: &FeedKeys) -> Result<(), ApiError> {
        let request = self.agent.put(self.url("settings/feeds")).header("Authorization", bearer(token));
        read(request.send_json(feeds_body(keys))).map(drop)
    }

    fn load_demo(&self) -> Result<(), ApiError> {
        read(self.slow.post(self.url("setup/demo")).send_empty()).map(drop)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn error_message_reads_string_or_list() {
        assert_eq!(error_message(&json!({"message": "nope"})), "nope");
        assert_eq!(error_message(&json!({"message": ["a", "b"]})), "a ; b");
        assert_eq!(error_message(&Value::Null), "sans détail");
    }

    #[test]
    fn feeds_body_only_carries_given_keys() {
        let keys = FeedKeys { tomtom_api_key: Some("t".into()), ..FeedKeys::default() };
        assert_eq!(feeds_body(&keys), json!({"tomtomApiKey": "t"}));
    }

    #[test]
    fn warehouse_body_omits_a_missing_city() {
        let w = NewWarehouse {
            code: "WH-001".into(),
            name: "Tema".into(),
            country: "GH".into(),
            city: None,
            latitude: 5.6,
            longitude: -0.1,
        };
        let body = warehouse_body(&w);
        assert!(body.get("city").is_none());
        assert_eq!(body["code"], "WH-001");
    }

    #[test]
    fn parses_listing_and_geocoder_answers() {
        let sites = parse_sites(&json!({"data": [{"code": "WH-001", "name": "Tema"}], "meta": {}}));
        assert_eq!(sites, vec![ExistingSite { code: "WH-001".into(), name: "Tema".into() }]);
        assert_eq!(
            parse_geocode(&json!({"source":"photon","results":[{"latitude":5.6,"longitude":-0.2}]})),
            Some((5.6, -0.2))
        );
        assert_eq!(parse_geocode(&json!({"source":"none","results":[]})), None);
    }

    /// Serves one canned JSON response and returns the request it received.
    fn serve_once(
        status_line: &'static str,
        body: &'static str,
    ) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base: String = format!("http://127.0.0.1:{}/api/v1", listener.local_addr().unwrap().port());
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let request: String = read_request(&mut socket);
            let response: String = format!(
                "{status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).unwrap();
            request
        });
        (base, handle)
    }

    /// Reads headers and the whole body: answering before the client finished sending makes
    /// Windows reset the connection.
    fn read_request(socket: &mut std::net::TcpStream) -> String {
        let mut data: Vec<u8> = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let text: String = String::from_utf8_lossy(&data).into_owned();
            if let Some(end) = text.find("\r\n\r\n") {
                let length: usize = text[..end]
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().to_owned())
                    })
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                if data.len() >= end + 4 + length {
                    return text;
                }
            }
            let n: usize = socket.read(&mut buf).unwrap();
            if n == 0 {
                return String::from_utf8_lossy(&data).into_owned();
            }
            data.extend_from_slice(&buf[..n]);
        }
    }

    #[test]
    fn status_errors_carry_the_api_message() {
        let (base, server) =
            serve_once("HTTP/1.1 401 Unauthorized", r#"{"message":"Invalid email or password"}"#);
        let err = HttpApi::new(base).login("a@b.c", "pw").unwrap_err();
        assert_eq!(err, ApiError::Status { status: 401, message: "Invalid email or password".into() });
        let request: String = server.join().unwrap();
        assert!(request.starts_with("POST /api/v1/auth/login"));
    }

    #[test]
    fn setup_status_is_parsed() {
        let (base, server) =
            serve_once("HTTP/1.1 200 OK", r#"{"needsSetup":false,"demoAvailable":true,"demoAccounts":true}"#);
        let status = HttpApi::new(base).setup_status().unwrap();
        assert_eq!(status, SetupStatus { needs_setup: false, demo_available: true, demo_accounts: true });
        server.join().unwrap();
    }

    #[test]
    fn connection_refused_is_a_network_error() {
        let port: u16 = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let err = HttpApi::new(format!("http://127.0.0.1:{port}/api/v1")).setup_status().unwrap_err();
        assert!(matches!(err, ApiError::Network(_)), "{err:?}");
    }
}
