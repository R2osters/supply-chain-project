//! The `InstallPlan` the screens send to `start_install` (docs/installer.md).
//!
//! The installer only reads what it acts on itself (`desktopShortcut`, and a few fields to
//! validate). Everything else is handed untouched to `scip-desktop.exe --provision`, which owns
//! its meaning: a field added to the plan later needs no installer change.

use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::events::CommandError;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPlan {
    #[serde(default)]
    pub desktop_shortcut: bool,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

/// Holds passwords: print only the shape.
impl std::fmt::Debug for InstallPlan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let keys: Vec<&String> = self.rest.keys().collect();
        write!(f, "InstallPlan {{ desktop_shortcut: {}, keys: {keys:?} }}", self.desktop_shortcut)
    }
}

fn invalid(message: &str) -> CommandError {
    CommandError::new("invalid_plan", message)
}

fn text<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    path.iter().try_fold(value, |v, key| v.get(key))?.as_str().filter(|s| !s.trim().is_empty())
}

impl InstallPlan {
    pub fn kind(&self) -> Option<&str> {
        self.rest.get("kind").and_then(Value::as_str)
    }

    /// Catches a screen bug before files are copied, not five minutes later in provisioning.
    /// An upgrade keeps the existing data and settings, so it needs none of it.
    pub fn validate(&self, upgrade: bool) -> Result<(), CommandError> {
        if upgrade {
            return Ok(());
        }
        let plan = Value::Object(self.rest.clone());
        let kind = self.kind();
        if !matches!(kind, Some("production" | "demo")) {
            return Err(invalid("kind must be 'production' or 'demo'"));
        }
        match text(&plan, &["database", "mode"]) {
            Some("embedded") => {}
            Some("external") => {
                for field in ["host", "database", "user"] {
                    if text(&plan, &["database", field]).is_none() {
                        return Err(invalid(&format!("database.{field} is required")));
                    }
                }
            }
            _ => return Err(invalid("database.mode must be 'embedded' or 'external'")),
        }
        // The demo creates its own organisation and accounts (screens 06 and 08 are skipped).
        if kind == Some("production") {
            for path in [
                ["organisation", "name"],
                ["organisation", "country"],
                ["admin", "email"],
                ["admin", "password"],
            ] {
                if text(&plan, &path).is_none() {
                    return Err(invalid(&format!("{} is required", path.join("."))));
                }
            }
        }
        Ok(())
    }

    /// What goes to `scip-desktop.exe --provision` on stdin: the plan without `desktopShortcut`
    /// (the installer's business), or just `{"upgrade":true}` to run the migrations.
    pub fn provision_request(&self, upgrade: bool) -> Value {
        if upgrade {
            json!({ "upgrade": true })
        } else {
            Value::Object(self.rest.clone())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(value: Value) -> InstallPlan {
        serde_json::from_value(value).unwrap()
    }

    fn production() -> Value {
        json!({
            "kind": "production",
            "database": { "mode": "external", "host": "db", "port": 5432, "database": "scip", "user": "u", "password": "pw", "ssl": false },
            "organisation": { "name": "ACME", "country": "BF", "currency": "XOF", "timezone": "Africa/Ouagadougou", "sites": [] },
            "sources": { "vehicles": "live" },
            "admin": { "firstName": "A", "lastName": "B", "email": "a@b.c", "password": "Str0ng-passw0rd" },
            "desktopShortcut": true
        })
    }

    #[test]
    fn provisioning_gets_everything_but_the_shortcut() {
        let p = plan(production());
        assert!(p.desktop_shortcut);
        p.validate(false).unwrap();
        let request = p.provision_request(false);
        assert!(request.get("desktopShortcut").is_none());
        assert_eq!(request["admin"]["password"], "Str0ng-passw0rd");
        assert_eq!(request["database"]["mode"], "external");
        assert!(!format!("{p:?}").contains("Str0ng"));
    }

    #[test]
    fn upgrade_sends_only_the_flag() {
        let p = plan(json!({ "desktopShortcut": false }));
        p.validate(true).unwrap();
        assert_eq!(p.provision_request(true), json!({ "upgrade": true }));
    }

    #[test]
    fn validation() {
        assert_eq!(plan(json!({})).validate(false).unwrap_err().code, "invalid_plan");
        let demo = plan(
            json!({ "kind": "demo", "database": { "mode": "embedded" }, "sources": { "vehicles": "simulation" } }),
        );
        demo.validate(false).unwrap();
        let mut missing_admin = production();
        missing_admin["admin"]["password"] = json!("");
        assert!(plan(missing_admin).validate(false).unwrap_err().message.contains("admin.password"));
        let mut no_host = production();
        no_host["database"]["host"] = Value::Null;
        assert!(plan(no_host).validate(false).is_err());
    }
}
