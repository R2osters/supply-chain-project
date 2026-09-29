//! SCIP desktop shell: a Tauri window plus a supervisor for the local sidecars
//! (Postgres, API, AI). Architecture: docs/desktop-architecture.md.

mod bridge;
pub mod events;
pub mod paths;
pub mod ports;
pub mod provision;
pub mod secrets;
pub mod services;
pub mod startup;
pub mod supervisor;
mod win_job;

pub use bridge::run;
