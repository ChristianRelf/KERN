//! Application services. Each module holds pure service functions that take
//! a `&Connection` (unit-testable) and thin `#[tauri::command]` wrappers.

pub mod activity;
pub mod archive;
pub mod attachments;
pub mod boards;
pub mod daily;
pub mod dashboards;
pub mod focus;
pub mod labels;
pub mod notes;
pub mod notify;
pub mod projects;
pub mod recent;
pub mod recurrence;
pub mod search;
pub mod settings;
pub mod stats;
pub mod system;
pub mod tasks;
pub mod trash;
pub mod views;
pub mod whiteboards;
