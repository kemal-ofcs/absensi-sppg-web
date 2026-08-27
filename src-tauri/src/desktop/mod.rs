mod administration;
pub mod commands;
pub mod config;
pub mod models;
mod operational;
mod payroll_seed;
pub mod remote;
mod scanner;
pub mod secrets;
pub mod storage;
pub mod sync;
mod time_policy;
pub mod turso;

pub mod payroll;
pub use config::DesktopState;
