pub mod ai_chat;
pub mod archive;
pub mod commands;
pub mod database;
pub mod document;
pub mod email;
pub mod google {
    pub mod auth;
    pub mod drive;
    pub mod sheets;
}
pub mod matching;
pub mod ocr;
pub mod pipeline;
pub mod security;
pub mod watcher;

use ai_chat::AiServerManager;
use commands::*;
use database::Database;
use ocr::OcrManager;
use pipeline::PipelineCoordinator;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;
use tokio::sync::Mutex;
use tracing::{info, warn};
use watcher::FolderWatcher;

#[cfg(target_os = "windows")]
fn ensure_webview2_env() {
    if std::env::var_os("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER").is_some() {
        return;
    }

    let program_files_x86 =
        std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| "C:\\Program Files (x86)".to_string());
    let program_files =
        std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".to_string());
    let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();

    let candidate_bases = [
        format!("{}\\Microsoft\\EdgeCore", program_files_x86),
        format!("{}\\Microsoft\\EdgeCore", program_files),
        format!("{}\\Microsoft\\EdgeWebView\\Application", program_files_x86),
        format!("{}\\Microsoft\\EdgeWebView\\Application", program_files),
        format!("{}\\Microsoft\\EdgeWebView\\Application", local_app_data),
        format!("{}\\Microsoft\\Edge\\Application", program_files_x86),
    ];

    for base in &candidate_bases {
        let base_path = std::path::Path::new(base);
        if !base_path.exists() {
            continue;
        }

        if base_path.join("msedgewebview2.exe").exists() {
            unsafe {
                std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", base_path);
            }
            return;
        }

        if let Ok(entries) = std::fs::read_dir(base_path) {
            for entry in entries.filter_map(|e| e.ok()) {
                let sub = entry.path();
                if sub.is_dir() && sub.join("msedgewebview2.exe").exists() {
                    unsafe {
                        std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", &sub);
                    }
                    return;
                }
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "windows")]
    ensure_webview2_env();

    let rt = tokio::runtime::Runtime::new().expect("Failed to initialize Tokio runtime");
    let _guard = rt.enter();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            // Setup logging
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Determine data directory for SQLite database
            let app_data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("C:\\PO-AutoFlow\\Database"));
            std::fs::create_dir_all(&app_data_dir).ok();

            let db_path = app_data_dir.join("po_autoflow.db");
            info!("Initializing SQLite database at: {:?}", db_path);
            let db = Database::new(&db_path).expect("Failed to open SQLite database");

            // Resolve OCR worker path: prefer bundled standalone exe in release installs, live worker.py in dev runs
            let current_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            let mut exe_candidates: Vec<PathBuf> = Vec::new();
            let mut script_candidates: Vec<PathBuf> = Vec::new();

            if let Ok(res_dir) = app.path().resource_dir() {
                exe_candidates.push(res_dir.join("resources").join("ocr-worker").join("ocr-worker.exe"));
                exe_candidates.push(res_dir.join("ocr-worker").join("ocr-worker.exe"));
                script_candidates.push(res_dir.join("resources").join("ocr-worker").join("worker.py"));
                script_candidates.push(res_dir.join("ocr-worker").join("worker.py"));
            }
            if let Ok(exe_path) = std::env::current_exe() {
                if let Some(exe_dir) = exe_path.parent() {
                    exe_candidates.push(exe_dir.join("resources").join("ocr-worker").join("ocr-worker.exe"));
                    exe_candidates.push(exe_dir.join("ocr-worker").join("ocr-worker.exe"));
                    script_candidates.push(exe_dir.join("resources").join("ocr-worker").join("worker.py"));
                    script_candidates.push(exe_dir.join("ocr-worker").join("worker.py"));
                }
            }

            script_candidates.push(current_dir.join("ocr-worker").join("worker.py"));
            script_candidates.push(current_dir.join("..").join("ocr-worker").join("worker.py"));
            if let Some(project_root) = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent() {
                exe_candidates.push(
                    project_root
                        .join("src-tauri")
                        .join("resources")
                        .join("ocr-worker")
                        .join("ocr-worker.exe"),
                );
                script_candidates.push(project_root.join("ocr-worker").join("worker.py"));
            }

            let worker_path = if cfg!(debug_assertions) {
                script_candidates
                    .iter()
                    .chain(exe_candidates.iter())
                    .find(|p| p.exists())
                    .cloned()
                    .unwrap_or_else(|| current_dir.join("ocr-worker").join("worker.py"))
            } else {
                exe_candidates
                    .iter()
                    .chain(script_candidates.iter())
                    .find(|p| p.exists())
                    .cloned()
                    .unwrap_or_else(|| current_dir.join("ocr-worker").join("worker.py"))
            };
            info!("Configured OCR worker path: {:?}", worker_path);

            let ocr_manager = OcrManager::new(&worker_path);
            let coordinator = Arc::new(PipelineCoordinator::new(db.clone(), ocr_manager.clone()));

            // Setup background processing queue channel
            let (job_tx, job_rx) = tokio::sync::mpsc::channel::<PathBuf>(1024);
            Arc::clone(&coordinator).start_runner(job_rx);

            // Crash / Interrupted Job Recovery:
            // Transition any job left in-flight when the previous session exited into needs_review
            // so nothing stays stuck or silently dispatches an unconfirmed email at boot.
            if let Ok(in_flight) = db.get_in_flight_jobs_for_recovery() {
                if !in_flight.is_empty() {
                    let settings_opt = db.get_settings().ok();
                    info!(
                        "Recovering {} interrupted in-flight jobs -> needs_review",
                        in_flight.len()
                    );
                    for mut job in in_flight {
                        let prev_status = job.status.clone();
                        if let Some(ref settings) = settings_opt {
                            if let Some(folder) = coordinator.locate_job_folder(&job, settings) {
                                if folder.starts_with(&settings.processing_dir) {
                                    if let Ok(review_path) =
                                        pipeline::move_folder_to_dir(&folder, &settings.review_dir)
                                    {
                                        job.source_path = review_path.to_string_lossy().to_string();
                                    }
                                }
                            }
                        }
                        job.status = "needs_review".to_string();
                        job.stage_message = format!(
                            "Interrupted during previous session at '{}'. Click Retry or Approve & Send to resume.",
                            prev_status
                        );
                        job.updated_at = chrono::Utc::now().to_rfc3339();
                        db.update_job(&job).ok();
                        db.add_event(
                            Some(&job.id),
                            "warn",
                            &format!("Recovered interrupted job from '{}' -> needs_review", prev_status),
                        )
                        .ok();
                    }
                }
            }

            // System Tray Menu & Icon
            let quit_item = MenuItem::with_id(app, "quit", "Exit PO AutoFlow", true, None::<&str>)?;
            let show_item = MenuItem::with_id(app, "show", "Open Dashboard", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let mut tray_builder = TrayIconBuilder::new()
                .menu(&tray_menu)
                .tooltip("PO AutoFlow Enterprise - Running in Background")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        if let Some(st) = app.try_state::<AppState>() {
                            let srv = st.ai_server.clone();
                            tauri::async_runtime::block_on(srv.stop());
                        }
                        app.exit(0);
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| match event {
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                    | TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } => {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                });

            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }
            let _tray = tray_builder.build(app)?;

            ocr_manager.push_log(format!(
                "[system] PO AutoFlow Enterprise initialized (app PID={})",
                std::process::id()
            ));

            // Auto-resume folder monitoring on startup if enabled in settings
            let mut needs_delayed_watcher_retry: Option<(String, u64)> = None;
            let watcher_instance = if let Ok(settings) = db.get_settings() {
                if settings.auto_monitoring_active {
                    let incoming_path = std::path::Path::new(&settings.incoming_dir);
                    if !incoming_path.exists() && std::fs::create_dir_all(incoming_path).is_err() {
                        warn!(
                            "Incoming directory drive/share not mounted yet on startup ({:?}); scheduling background retry",
                            settings.incoming_dir
                        );
                        needs_delayed_watcher_retry = Some((settings.incoming_dir.clone(), settings.poll_interval_ms));
                        None
                    } else {
                        let mut watcher = FolderWatcher::new(&settings.incoming_dir, job_tx.clone())
                            .with_poll_interval(settings.poll_interval_ms);
                        match watcher.start() {
                            Ok(()) => {
                                coordinator.set_watcher_active_jobs(watcher.active_jobs());
                                info!("Auto-monitoring resumed on startup for {:?}", settings.incoming_dir);
                                Some(watcher)
                            }
                            Err(e) => {
                                warn!("Failed to resume auto-monitoring on startup ({}): scheduling background retry", e);
                                needs_delayed_watcher_retry = Some((settings.incoming_dir.clone(), settings.poll_interval_ms));
                                None
                            }
                        }
                    }
                } else {
                    None
                }
            } else {
                None
            };

            let watcher_arc = Arc::new(Mutex::new(watcher_instance));
            if let Some((retry_dir, retry_poll_ms)) = needs_delayed_watcher_retry {
                let watcher_ref = Arc::clone(&watcher_arc);
                let coordinator_ref = coordinator.clone();
                let job_tx_ref = job_tx.clone();
                let log_ref = ocr_manager.clone();
                tauri::async_runtime::spawn(async move {
                    log_ref.push_log(format!(
                        "[watcher] Waiting for network drive / folder '{}' to come online...",
                        retry_dir
                    ));
                    for attempt in 1..=60u32 {
                        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                        let mut guard = watcher_ref.lock().await;
                        if guard.is_some() {
                            return;
                        }
                        if std::path::Path::new(&retry_dir).exists() {
                            let mut w = FolderWatcher::new(&retry_dir, job_tx_ref.clone())
                                .with_poll_interval(retry_poll_ms);
                            if let Ok(()) = w.start() {
                                coordinator_ref.set_watcher_active_jobs(w.active_jobs());
                                *guard = Some(w);
                                log_ref.push_log(format!(
                                    "[watcher] Auto-monitoring started after network mount became available (attempt {}): {}",
                                    attempt, retry_dir
                                ));
                                info!("Delayed auto-monitoring resumed on attempt {} for {:?}", attempt, retry_dir);
                                return;
                            }
                        }
                    }
                    log_ref.push_log(format!(
                        "[watcher] Timed out waiting 10m for '{}' on startup — use 'Start Folder Monitoring' once connected.",
                        retry_dir
                    ));
                });
            }

            let ai_server = Arc::new(AiServerManager::new());

            // Manage global application state
            app.manage(AppState {
                db,
                ocr_manager,
                ai_server,
                coordinator,
                watcher: watcher_arc,
                job_tx,
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Keep monitoring Incoming folders in the background system tray when window is closed
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            get_dashboard_stats,
            list_jobs,
            get_job_details,
            list_transactions,
            get_ocr_results,
            get_companies_cache,
            get_department_cc_cache,
            sync_companies_from_sheets,
            add_company_alias,
            delete_company_alias,
            get_company_aliases,
            get_recent_events,
            get_audit_logs,
            retry_job,
            deep_scan_job_with_vision,
            approve_and_send_job,
            start_monitoring,
            stop_monitoring,
            is_monitoring_active,
            test_sheets_connection,
            test_drive_connection,
            test_gas_connection,
            send_test_email,
            test_ocr_on_file,
            open_devtools,
            close_devtools,
            open_path_in_explorer,
            open_job_document,
            get_system_diagnostics,
            trigger_folder_scan,
            clear_all_caches,
            start_google_login,
            logout_google,
            get_google_account,
            minimize_to_tray,
            get_document_page_preview,
            get_developer_console_snapshot,
            run_developer_command,
            check_github_update,
            install_github_update,
            get_learning_stats,
            test_local_vision_ai,
            get_builtin_vision_status,
            download_builtin_vision_model,
            delete_builtin_vision_model,
            get_ocr_engine_status,
            install_openthaigpt_ocr,
            install_vulkan_vision_engine,
            run_ocr_self_test,
            benchmark_ocr_layers,
            list_benchmark_candidates,
            ask_ai_assistant,
            get_ai_chat_status,
            stop_ai_chat_server,
            delete_job,
            get_ui_state,
            save_ui_state
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
