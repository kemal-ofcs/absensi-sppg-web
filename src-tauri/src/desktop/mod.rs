mod administration;
pub mod commands;
pub mod config;
pub mod license;
pub mod models;
mod operational;
mod payroll_seed;
mod scanner;
pub mod secrets;
pub mod sql_backend;
pub mod storage;
pub mod sync;
mod time_policy;
pub mod turso;

pub mod portability;
pub mod payroll;
pub use config::DesktopState;
