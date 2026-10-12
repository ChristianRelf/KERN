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
    let mut builder = tauri::Builder::default();
    // An isolated test/development instance (KERN_DATA_DIR) runs alongside
    // the normal one instead of handing over to it.
    if std::env::var_os("KERN_DATA_DIR").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            window::show_main(app);
        }));
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .setup(|app| {
            // KERN_DATA_DIR points a development or test run at a separate
            // data folder so real data is never touched.
            let data_dir = match std::env::var_os("KERN_DATA_DIR") {
                Some(d) if !d.is_empty() => std::path::PathBuf::from(d),
                _ => app.path().app_data_dir()?,
            };
            let paths = Paths::new(data_dir);
            std::fs::create_dir_all(&paths.data_dir)?;
            std::fs::create_dir_all(&paths.attachments_dir)?;
            // The asset protocol may read managed attachments and cached
            // favicons only, wherever the data folder actually is.
            let scope = app.asset_protocol_scope();
            let _ = scope.allow_directory(&paths.attachments_dir, true);
            let _ = scope.allow_directory(paths.favicons_dir(), true);
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
            if let Err(e) = folders::apply_trust_retention(&conn) {
                eprintln!("couldn't apply trust retention: {e}");
            }
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
            projects::projects_arrange,
            projects::projects_reset_order,
            projects::groups_reorder,
            projects::project_duplicate,
            projects::project_delete,
            projects::project_restore,
            projects::project_touch,
            projects::groups_list,
            projects::group_create,
            projects::group_update,
            projects::group_delete,
            // project folders & workspace trust
            folders::folder_inspect,
            folders::project_folder_get,
            folders::project_folder_link,
            folders::project_folder_unlink,
            folders::project_folder_set_trust,
            folders::project_files_list,
            folders::project_file_open,
            folders::project_file_reveal,
            folders::project_file_path,
            folders::project_folder_create,
            folders::project_file_rename,
            folders::trusted_folders_list,
            folders::trusted_folder_update,
            // AI API accounts & routing
            ai::ai_accounts_list,
            ai::ai_account_create,
            ai::ai_account_update,
            ai::ai_account_replace_key,
            ai::ai_account_delete,
            ai::ai_accounts_reorder,
            ai::ai_account_test,
            ai::ai_key_test,
            ai::ai_request,
            ai::ai_request_cancel,
            ai::ai_usage,
            ai::ai_history_clear,
            ai::ai_security_check,
            // git & GitHub
            git::git_remote,
            git::git_status,
            git::git_diff,
            git::git_log,
            git::git_branches,
            git::git_switch,
            git::git_sync,
            git::git_clone,
            git::git_available,
            git::project_scan_todos,
            github::github_status,
            github::github_set_token,
            github::github_clear_token,
            github::github_repos,
            github::github_project,
            github::github_connect,
            github::github_disconnect,
            github::github_update_connection,
            github::github_sync,
            github::github_sync_task,
            github::github_create_issue,
            github::github_pulls,
            github::github_overview,
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
            attachments::attachment_add_link,
            attachments::attachment_rename,
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
            views::views_reorder,
            search::search,
            stats::stats_overview,
            stats::stats_completions,
            stats::stats_due_counts,
            stats::storage_stats,
            storage::storage_report,
            storage::storage_scan,
            storage::storage_scan_cancel,
            storage::storage_cleanup,
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
            links::link_metadata,
            links::favicon_get,
            system::tray_set_visible,
            system::quit_app,
            system::show_main_window,
            updates::check_for_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kern");
}
