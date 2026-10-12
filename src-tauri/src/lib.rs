//! Kern — a local-first personal productivity workspace.
//!
//! The backend owns persistence (SQLite), file management, notifications,
//! backups and OS integration. The frontend talks to it exclusively through
//! the typed commands registered below — it never issues SQL.

pub mod db;
pub mod domain;
pub mod error;
pub mod scheduler;
pub mod state;
pub mod util;
pub mod window;

use domain::*;
use state::{AppState, Paths};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            window::show_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let paths = Paths::new(data_dir);
            std::fs::create_dir_all(&paths.data_dir)?;
            std::fs::create_dir_all(&paths.attachments_dir)?;
            let conn = match db::open(&paths.db_path, &paths.default_backups_dir) {
                Ok(c) => c,
                Err(e) => {
                    app.dialog()
                        .message(format!(
                            "Kern couldn't open its data.\n\n{e}\n\nYour data folder is:\n{}",
                            paths.data_dir.display()
                        ))
                        .kind(MessageDialogKind::Error)
                        .title("Kern")
                        .blocking_show();
                    std::process::exit(1);
                }
            };
            let _ = settings::set(
                &conn,
                "internal.attachmentsDir",
                &serde_json::json!(paths.attachments_dir.to_string_lossy()),
            );
            app.manage(AppState::new(conn, paths));
            if let Err(e) = window::create_tray(app) {
                eprintln!("tray unavailable: {e}");
            }
            window::restore_and_show(app.handle());
            scheduler::start(app.handle().clone());
            Ok(())
        })
        .on_window_event(window::on_window_event)
        .invoke_handler(tauri::generate_handler![
            // settings
            settings::settings_get_all,
            settings::settings_set,
            settings::settings_reset,
            // tasks
            tasks::tasks_query,
            tasks::task_get,
            tasks::task_create,
            tasks::task_update,
            tasks::tasks_update_many,
            tasks::tasks_patch_batch,
            tasks::task_duplicate,
            tasks::tasks_delete,
            tasks::tasks_restore,
            tasks::tasks_purge,
            tasks::tasks_reorder,
            // labels
            labels::labels_list,
            labels::label_create,
            labels::label_update,
            labels::label_delete,
            // projects
            projects::projects_list,
            projects::project_get,
            projects::project_create,
            projects::project_update,
            projects::projects_reorder,
            projects::project_duplicate,
            projects::project_delete,
            projects::project_restore,
            projects::project_touch,
            projects::groups_list,
            projects::group_create,
            projects::group_update,
            projects::group_delete,
            // boards
            boards::boards_list,
            boards::board_get,
            boards::board_create,
            boards::board_update,
            boards::board_delete,
            boards::column_create,
            boards::column_update,
            boards::column_delete,
            boards::columns_reorder,
            // notes & inbox
            notes::notes_list,
            notes::note_get,
            notes::note_create,
            notes::note_update,
            notes::notes_delete,
            notes::notes_restore,
            notes::inbox_list,
            notes::inbox_add,
            notes::inbox_update,
            notes::inbox_delete,
            notes::inbox_restore,
            notes::inbox_convert,
            // whiteboards
            whiteboards::whiteboards_list,
            whiteboards::whiteboard_get,
            whiteboards::whiteboard_preview,
            whiteboards::whiteboard_create,
            whiteboards::whiteboard_update,
            whiteboards::whiteboard_save,
            whiteboards::whiteboard_duplicate,
            whiteboards::whiteboard_import,
            whiteboards::whiteboard_delete,
            whiteboards::whiteboard_restore,
            // attachments
            attachments::attachments_list,
            attachments::attachment_add,
            attachments::attachment_delete,
            attachments::asset_import,
            attachments::asset_import_bytes,
            // dashboards
            dashboards::dashboards_list,
            dashboards::dashboard_create,
            dashboards::dashboard_update,
            dashboards::dashboard_delete,
            // daily rundown
            daily::rundown_data,
            daily::snapshot_get,
            daily::snapshot_save,
            daily::snapshot_mark_viewed,
            daily::snapshots_list,
            // focus
            focus::focus_record,
            focus::focus_sessions_list,
            focus::focus_schedule,
            focus::focus_cancel,
            // misc data
            activity::activity_list,
            recent::recent_list,
            views::views_list,
            views::view_create,
            views::view_update,
            views::view_delete,
            search::search,
            stats::stats_overview,
            stats::stats_completions,
            stats::stats_due_counts,
            stats::storage_stats,
            trash::trash_list,
            trash::trash_purge,
            trash::trash_empty,
            // backups & export
            archive::backup_create,
            archive::backups_list,
            archive::backup_preview,
            archive::backup_restore,
            archive::backup_delete,
            archive::export_all,
            archive::export_tasks_csv,
            archive::export_notes_markdown,
            archive::export_projects_json,
            archive::data_dir_size,
            // system
            system::app_info,
            system::open_external,
            system::reveal_path,
            system::path_exists,
            system::write_text_file,
            system::write_binary_file,
            system::read_text_file,
            system::link_metadata,
            system::tray_set_visible,
            system::quit_app,
            system::show_main_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kern");
}
