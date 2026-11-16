use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;

use crate::database::models::*;
use crate::database::Database;
use crate::email::EmailDeliveryClient;
use crate::google::drive::DriveClient;
use crate::google::sheets::SheetsClient;
use crate::ocr::OcrManager;
use crate::pipeline::PipelineCoordinator;
use crate::watcher::FolderWatcher;

pub struct AppState {
    pub db: Database,
    pub ocr_manager: OcrManager,
    pub coordinator: Arc<PipelineCoordinator>,
    pub watcher: Arc<Mutex<Option<FolderWatcher>>>,
    pub job_tx: tokio::sync::mpsc::Sender<PathBuf>,
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    state.db.get_settings().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: AppSettings) -> Result<(), String> {
    state.db.save_settings(&settings).map_err(|e| e.to_string())?;
    state.db.add_audit_log("SETTINGS_UPDATED", "CONFIG", "USER", "Application configuration updated").ok();
    Ok(())
}

#[tauri::command]
pub fn get_dashboard_stats(state: State<'_, AppState>) -> Result<DashboardStats, String> {
    state.db.get_dashboard_stats().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_jobs(state: State<'_, AppState>, limit: i64, offset: i64) -> Result<Vec<Job>, String> {
    state.db.list_jobs(limit, offset).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_job_details(state: State<'_, AppState>, job_id: String) -> Result<Option<Job>, String> {
    state.db.get_job(&job_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_transactions(state: State<'_, AppState>, limit: i64, offset: i64) -> Result<Vec<PoTransaction>, String> {
    state.db.list_transactions(limit, offset).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_ocr_results(state: State<'_, AppState>, job_id: String) -> Result<Vec<OcrResultRecord>, String> {
    state.db.get_ocr_results_for_job(&job_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_companies_cache(state: State<'_, AppState>) -> Result<Vec<CompanyCacheEntry>, String> {
    state.db.get_companies_cache().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_companies_from_sheets(state: State<'_, AppState>) -> Result<usize, String> {
    let entries = state.coordinator.sync_directory_from_google().await?;
    let count = entries.len();
    state.db.add_audit_log(
        "SHEETS_SYNCED",
        "INTEGRATION",
        "USER",
        &format!("Synchronized {} companies from Google Sheets", count),
    ).ok();

    Ok(count)
}

#[tauri::command]
pub fn add_company_alias(
    state: State<'_, AppState>,
    alias: String,
    canonical_company_name: String,
) -> Result<(), String> {
    state
        .db
        .add_company_alias(&alias, &canonical_company_name, "USER")
        .map_err(|e| e.to_string())?;
    state.db.add_audit_log(
        "ALIAS_ADDED",
        "MATCHING",
        "USER",
        &format!("Mapped alias '{}' -> '{}'", alias, canonical_company_name),
    ).ok();
    Ok(())
}

#[tauri::command]
pub fn delete_company_alias(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.db.delete_company_alias(&id).map_err(|e| e.to_string())?;
    state.db.add_audit_log(
        "ALIAS_DELETED",
        "MATCHING",
        "USER",
        &format!("Removed alias id {}", id),
    ).ok();
    Ok(())
}

#[tauri::command]
pub fn get_company_aliases(state: State<'_, AppState>) -> Result<Vec<CompanyAlias>, String> {
    state.db.get_company_aliases().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_recent_events(state: State<'_, AppState>, limit: i64) -> Result<Vec<ApplicationEvent>, String> {
    state.db.get_recent_events(limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_audit_logs(state: State<'_, AppState>, limit: i64) -> Result<Vec<AuditLog>, String> {
    state.db.get_audit_logs(limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn retry_job(state: State<'_, AppState>, job_id: String) -> Result<(), String> {
    let job = state
        .db
        .get_job(&job_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Job not found".to_string())?;

    let settings = state.db.get_settings().map_err(|e| e.to_string())?;
    let current_path = state
        .coordinator
        .locate_job_folder(&job, &settings)
        .ok_or_else(|| format!("PO folder '{}' cannot be found on disk", job.po_folder_name))?;

    state.coordinator.release_folder(&current_path);
    state.coordinator.process_po_folder(&current_path).await
}

#[tauri::command]
pub async fn approve_and_send_job(
    state: State<'_, AppState>,
    job_id: String,
    company_name: String,
    recipient_email: String,
    po_number: Option<String>,
    save_alias: Option<bool>,
) -> Result<Job, String> {
    let clean_company = company_name.trim().to_string();
    let clean_email = recipient_email.trim().to_string();

    if clean_company.is_empty() {
        return Err("Supplier company name is required".to_string());
    }
    if crate::matching::thai_normalizer::ThaiNormalizer::is_ignored_self_company(&clean_company) {
        return Err("Cannot dispatch to QTC Energy (self-company). Select the external supplier instead.".to_string());
    }
    if !EmailDeliveryClient::is_valid_email(&clean_email) {
        return Err(format!("Invalid recipient email address: '{}'", clean_email));
    }

    let mut job = state
        .db
        .get_job(&job_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Job not found".to_string())?;

    let settings = state.db.get_settings().map_err(|e| e.to_string())?;
    let folder_path = state
        .coordinator
        .locate_job_folder(&job, &settings)
        .ok_or_else(|| format!("PO folder '{}' cannot be found on disk", job.po_folder_name))?;

    crate::pipeline::flatten_nested_same_name_dir(&folder_path);
    let documents = crate::document::DocumentScanner::scan_po_folder(&folder_path)
        .map_err(|e| format!("Failed to scan PO folder: {}", e))?;
    if documents.is_empty() {
        return Err("No supported documents found inside PO folder".to_string());
    }

    let resolved_po = po_number
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| job.po_number.clone())
        .unwrap_or_else(|| job.po_folder_name.clone());

    if save_alias.unwrap_or(true) {
        if let Some(ref detected) = job.detected_company_raw {
            let det_clean = detected.trim();
            if !det_clean.is_empty()
                && det_clean != clean_company
                && !crate::matching::thai_normalizer::ThaiNormalizer::is_ignored_self_company(det_clean)
            {
                state
                    .db
                    .add_company_alias(det_clean, &clean_company, "MANUAL_APPROVE")
                    .ok();
            }
        }
    }

    job.po_number = Some(resolved_po.clone());
    job.matched_company_name = Some(clean_company.clone());
    job.matched_email = Some(clean_email.clone());
    job.match_confidence = Some(100.0);
    job.match_category = Some("verified".to_string());
    job.error_details = None;
    state.db.update_job(&job).ok();

    state
        .coordinator
        .deliver_po_package(&folder_path, job, &clean_company, &clean_email, &resolved_po, &documents)
        .await
}

#[tauri::command]
pub async fn start_monitoring(state: State<'_, AppState>) -> Result<bool, String> {
    let settings = state.db.get_settings().map_err(|e| e.to_string())?;
    let mut lock = state.watcher.lock().await;

    if lock.is_none() {
        let mut watcher = FolderWatcher::new(&settings.incoming_dir, state.job_tx.clone());
        watcher.start().map_err(|e| e.to_string())?;
        state.coordinator.set_watcher_active_jobs(watcher.active_jobs());
        *lock = Some(watcher);
    }

    let mut updated_settings = settings;
    updated_settings.auto_monitoring_active = true;
    state.db.save_settings(&updated_settings).ok();
    state.db.add_event(None, "info", "Automatic folder monitoring activated").ok();

    Ok(true)
}

#[tauri::command]
pub async fn stop_monitoring(state: State<'_, AppState>) -> Result<bool, String> {
    let mut lock = state.watcher.lock().await;
    if let Some(mut watcher) = lock.take() {
        watcher.stop();
    }

    if let Ok(mut settings) = state.db.get_settings() {
        settings.auto_monitoring_active = false;
        state.db.save_settings(&settings).ok();
    }
    state.db.add_event(None, "info", "Automatic folder monitoring paused").ok();

    Ok(false)
}

#[tauri::command]
pub async fn is_monitoring_active(state: State<'_, AppState>) -> Result<bool, String> {
    let lock = state.watcher.lock().await;
    Ok(lock.as_ref().map(|w| w.is_active()).unwrap_or(false))
}

#[tauri::command]
pub async fn test_sheets_connection(
    state: State<'_, AppState>,
    spreadsheet_id: String,
    tab_name: String,
    gas_url: Option<String>,
    gas_secret: Option<String>,
) -> Result<usize, String> {
    let mut settings = state.db.get_settings().map_err(|e| e.to_string())?;
    let client = SheetsClient::new();

    // Priority 1: Google Apps Script Webhook (native private access via SpreadsheetApp)
    let target_gas_url = gas_url
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| settings.gas_webhook_url.clone());
    let target_gas_secret = gas_secret
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| settings.gas_auth_secret.clone());

    let mut gas_error = None;
    if !target_gas_url.trim().is_empty() {
        match client
            .fetch_companies_via_gas(&target_gas_url, &target_gas_secret, &spreadsheet_id, &tab_name)
            .await
        {
            Ok(entries) => return Ok(entries.len()),
            Err(e) => {
                gas_error = Some(e.to_string());
                tracing::warn!("GAS sheet test failed: {}, trying OAuth/direct fallback", e);
            }
        }
    }

    // Priority 2: OAuth token
    let mut token_opt = None;
    if let Some(ref mut acct) = settings.google_account {
        if let Ok(tok) = crate::google::auth::GoogleAuthManager::get_valid_access_token_with_gas(
            acct,
            &settings.google_oauth_client_id,
            &settings.google_oauth_client_secret,
            &settings.gas_webhook_url,
            &settings.gas_auth_secret,
        ).await {
            token_opt = Some(tok);
            state.db.save_settings(&settings).ok();
        }
    }

    // Priority 3: Direct / Public export
    match client.test_connection(&spreadsheet_id, &tab_name, token_opt.as_deref()).await {
        Ok(count) => Ok(count),
        Err(e) => {
            if let Some(ge) = gas_error {
                Err(format!("{}. (Direct Google fallback: {})", ge, e))
            } else {
                Err(e.to_string())
            }
        }
    }
}

#[tauri::command]
pub async fn test_drive_connection(state: State<'_, AppState>, folder_id: String) -> Result<bool, String> {
    let mut settings = state.db.get_settings().map_err(|e| e.to_string())?;
    let client = DriveClient::new();
    let mut token_opt = None;
    if let Some(ref mut acct) = settings.google_account {
        if let Ok(tok) = crate::google::auth::GoogleAuthManager::get_valid_access_token_with_gas(
            acct,
            &settings.google_oauth_client_id,
            &settings.google_oauth_client_secret,
            &settings.gas_webhook_url,
            &settings.gas_auth_secret,
        ).await {
            token_opt = Some(tok);
            state.db.save_settings(&settings).ok();
        }
    }
    client.test_connection(&folder_id, token_opt.as_deref()).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn test_gas_connection(
    state: State<'_, AppState>,
    gas_url: String,
    gas_secret: Option<String>,
) -> Result<bool, String> {
    let settings = state.db.get_settings().map_err(|e| e.to_string())?;
    let secret = gas_secret
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| settings.gas_auth_secret.clone());
    let client = EmailDeliveryClient::new();
    client
        .test_connection(&gas_url, Some(&secret))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn send_test_email(
    state: State<'_, AppState>,
    recipient_email: String,
) -> Result<String, String> {
    let settings = state.db.get_settings().map_err(|e| e.to_string())?;
    let client = EmailDeliveryClient::new();
    let tx_id = uuid::Uuid::new_v4().to_string();
    let idemp = format!("test_{}", tx_id);

    let resp = client
        .send_po_email(
            &settings.gas_webhook_url,
            &settings.gas_auth_secret,
            &tx_id,
            "TEST-PO-0001",
            "Test Supplier Company Limited",
            &recipient_email,
            None,
            &idemp,
            "PO AutoFlow Test Email - {{PO_NUMBER}}",
            "This is a verification email from PO AutoFlow Enterprise setup wizard.\n\nEverything is working properly!",
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(resp.execution_id.unwrap_or_else(|| "Delivered".to_string()))
}

#[tauri::command]
pub async fn test_ocr_on_file(
    state: State<'_, AppState>,
    file_path: String,
) -> Result<serde_json::Value, String> {
    let path = PathBuf::from(file_path);
    let resp = state.ocr_manager.process_file(&path).await.map_err(|e| e.to_string())?;
    serde_json::to_value(resp).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_devtools(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        window.open_devtools();
        Ok(())
    } else {
        Err("Main window not found".to_string())
    }
}

#[tauri::command]
pub fn close_devtools(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        window.close_devtools();
        Ok(())
    } else {
        Err("Main window not found".to_string())
    }
}

#[tauri::command]
pub fn open_path_in_explorer(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        let is_workflow_dir = target.extension().is_none()
            && state
                .db
                .get_settings()
                .ok()
                .map(|s| {
                    [
                        s.root_dir,
                        s.incoming_dir,
                        s.processing_dir,
                        s.sent_dir,
                        s.failed_dir,
                        s.review_dir,
                        s.temp_dir,
                        s.logs_dir,
                    ]
                    .iter()
                    .any(|w| w.eq_ignore_ascii_case(&path))
                })
                .unwrap_or(false);
        if is_workflow_dir {
            std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        } else {
            return Err(format!("Path does not exist: {}", path));
        }
    }
    #[cfg(target_os = "windows")]
    {
        if target.is_file() {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            std::process::Command::new("cmd")
                .args(["/C", "start", "", &path])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|e| format!("Failed to open file: {}", e))?;
        } else {
            std::process::Command::new("explorer")
                .arg(&path)
                .spawn()
                .map_err(|e| format!("Failed to open Windows Explorer: {}", e))?;
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn open_job_document(
    state: State<'_, AppState>,
    job_id: String,
    file_path: Option<String>,
) -> Result<(), String> {
    let job = state
        .db
        .get_job(&job_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Job not found".to_string())?;
    let settings = state.db.get_settings().map_err(|e| e.to_string())?;

    let mut search_roots = Vec::new();
    if let Some(folder) = state.coordinator.locate_job_folder(&job, &settings) {
        search_roots.push(folder);
    }
    for base in [
        &settings.processing_dir,
        &settings.review_dir,
        &settings.incoming_dir,
        &settings.sent_dir,
        &settings.failed_dir,
    ] {
        search_roots.push(PathBuf::from(base).join(&job.po_folder_name));
    }

    let target_to_open: PathBuf = if let Some(rel_str) = file_path.filter(|s| !s.trim().is_empty()) {
        let direct = PathBuf::from(&rel_str);
        if direct.is_absolute() && direct.exists() {
            direct
        } else {
            let file_name_only = direct.file_name().map(|n| n.to_os_string());
            let mut found: Option<PathBuf> = None;
            for root in &search_roots {
                if !root.exists() {
                    continue;
                }
                let cand = root.join(&direct);
                if cand.exists() && cand.is_file() {
                    found = Some(cand);
                    break;
                }
                if let Some(ref fname) = file_name_only {
                    let by_name = root.join(fname);
                    if by_name.exists() && by_name.is_file() {
                        found = Some(by_name);
                        break;
                    }
                    for entry in walkdir::WalkDir::new(root).max_depth(3).into_iter().filter_map(|e| e.ok()) {
                        if entry.file_type().is_file() && entry.file_name() == fname {
                            found = Some(entry.path().to_path_buf());
                            break;
                        }
                    }
                    if found.is_some() {
                        break;
                    }
                }
            }
            found.ok_or_else(|| format!("File '{}' not found inside job folder", rel_str))?
        }
    } else {
        search_roots
            .into_iter()
            .find(|r| r.exists() && r.is_dir())
            .ok_or_else(|| format!("Folder '{}' not found on disk", job.po_folder_name))?
    };

    #[cfg(target_os = "windows")]
    {
        if target_to_open.is_file() {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            std::process::Command::new("cmd")
                .args(["/C", "start", "", &target_to_open.to_string_lossy()])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|e| format!("Failed to launch PDF/file viewer: {}", e))?;
        } else {
            std::process::Command::new("explorer")
                .arg(&target_to_open)
                .spawn()
                .map_err(|e| format!("Failed to open Windows Explorer: {}", e))?;
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("xdg-open")
            .arg(&target_to_open)
            .spawn()
            .map_err(|e| format!("Failed to open path: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_system_diagnostics(state: State<'_, AppState>) -> Result<SystemDiagnostics, String> {
    let settings = state.db.get_settings().map_err(|e| e.to_string())?;
    let db_path = state.db.db_path.to_string_lossy().to_string();
    let db_size = std::fs::metadata(&state.db.db_path).map(|m| m.len()).unwrap_or(0);

    // Measure OCR ping latency
    let start = std::time::Instant::now();
    let ping_res = state.ocr_manager.ping().await;
    let latency = start.elapsed().as_millis() as u64;
    let (ocr_status, ocr_latency) = match ping_res {
        Ok(true) => ("READY".to_string(), latency),
        Ok(false) => ("UNAVAILABLE".to_string(), latency),
        Err(e) => (format!("ERROR: {}", e), latency),
    };

    let watcher_lock = state.watcher.lock().await;
    let (is_watching, active_count) = match watcher_lock.as_ref() {
        Some(w) => (w.is_active(), w.active_jobs_count()),
        None => (false, 0),
    };

    let webview_exe = std::env::var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER")
        .unwrap_or_else(|_| "System Default (Auto-detected)".to_string());

    let stats = state.db.get_dashboard_stats().unwrap_or(DashboardStats {
        total_processed: 0,
        successfully_sent: 0,
        waiting_processing: 0,
        needs_review: 0,
        failed_transactions: 0,
        success_rate_percent: 100.0,
        avg_ocr_confidence: 97.5,
    });

    let cached_comps = state.db.get_companies_cache().map(|c| c.len()).unwrap_or(0);

    Ok(SystemDiagnostics {
        app_name: "PO AutoFlow Enterprise".to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os_name: std::env::consts::OS.to_string(),
        os_arch: std::env::consts::ARCH.to_string(),
        webview2_executable: webview_exe,
        database_path: db_path,
        database_size_bytes: db_size,
        database_journal_mode: "WAL".to_string(),
        ocr_worker_path: state.ocr_manager.script_path().to_string_lossy().to_string(),
        ocr_worker_status: ocr_status,
        ocr_latency_ms: ocr_latency,
        auto_monitoring_active: is_watching,
        active_jobs_count: active_count,
        in_flight_locks_count: state.coordinator.in_flight_count(),
        total_jobs_recorded: stats.total_processed,
        total_transactions_recorded: stats.successfully_sent,
        cached_companies_count: cached_comps,
        debug_logging_enabled: settings.debug_logging_enabled,
        dry_run_simulation_mode: settings.dry_run_simulation_mode,
        timestamp: chrono::Utc::now().to_rfc3339(),
    })
}

#[tauri::command]
pub async fn trigger_folder_scan(state: State<'_, AppState>) -> Result<usize, String> {
    let watcher_lock = state.watcher.lock().await;
    if let Some(w) = watcher_lock.as_ref() {
        w.scan_existing_folders();
        Ok(w.active_jobs_count())
    } else {
        let settings = state.db.get_settings().map_err(|e| e.to_string())?;
        let incoming = PathBuf::from(&settings.incoming_dir);
        let mut count = 0;
        if let Ok(entries) = std::fs::read_dir(&incoming) {
            for entry in entries.filter_map(|e| e.ok()) {
                if entry.path().is_dir() {
                    count += 1;
                    let _ = state.job_tx.send(entry.path()).await;
                }
            }
        }
        Ok(count)
    }
}

#[tauri::command]
pub async fn clear_all_caches(state: State<'_, AppState>) -> Result<(), String> {
    let settings = state.db.get_settings().map_err(|e| e.to_string())?;
    let temp_dir = PathBuf::from(&settings.temp_dir);
    if temp_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&temp_dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let p = entry.path();
                if p.is_file() {
                    std::fs::remove_file(p).ok();
                }
            }
        }
    }
    state.db.add_audit_log("CACHES_CLEARED", "SYSTEM", "USER", "Temporary processing caches cleared").ok();
    Ok(())
}

#[tauri::command]
pub async fn start_google_login(
    state: State<'_, AppState>,
    client_id: Option<String>,
    client_secret: Option<String>,
) -> Result<GoogleAccountInfo, String> {
    let settings = state.db.get_settings().map_err(|e| e.to_string())?;
    let cid = client_id.unwrap_or_else(|| settings.google_oauth_client_id.clone());
    let csecret = client_secret.unwrap_or_else(|| settings.google_oauth_client_secret.clone());

    let account_info = if cid.trim().is_empty() || cid.trim() == crate::google::auth::DEFAULT_GOOGLE_CLIENT_ID {
        if !settings.gas_webhook_url.trim().is_empty() {
            crate::google::auth::GoogleAuthManager::connect_via_gas_hub(
                &settings.gas_webhook_url,
                &settings.gas_auth_secret,
            )
            .await?
        } else {
            return Err(
                "No Google Cloud OAuth Client ID is configured and no Apps Script Webhook URL is set. Please configure your Apps Script Webhook URL in Settings -> Apps Script & Gmail (recommended for 1-click connection), or enter your Google Cloud OAuth Client ID & Secret in Settings -> Google Sheets Directory.".to_string(),
            );
        }
    } else {
        crate::google::auth::GoogleAuthManager::start_oauth_flow(&cid, &csecret).await?
    };

    // Save to database
    let mut updated_settings = settings;
    updated_settings.google_account = Some(account_info.clone());
    if !cid.is_empty() {
        updated_settings.google_oauth_client_id = cid;
    }
    if !csecret.is_empty() {
        updated_settings.google_oauth_client_secret = csecret;
    }
    state.db.save_settings(&updated_settings).map_err(|e| e.to_string())?;
    state.db.add_audit_log(
        "GOOGLE_ACCOUNT_CONNECTED",
        "AUTH",
        "USER",
        &format!("Connected Google account: {}", account_info.email),
    ).ok();

    Ok(account_info)
}

#[tauri::command]
pub fn logout_google(state: State<'_, AppState>) -> Result<(), String> {
    let mut settings = state.db.get_settings().map_err(|e| e.to_string())?;
    let prev_email = settings.google_account.as_ref().map(|a| a.email.clone()).unwrap_or_default();
    settings.google_account = None;
    state.db.save_settings(&settings).map_err(|e| e.to_string())?;
    state.db.add_audit_log(
        "GOOGLE_ACCOUNT_DISCONNECTED",
        "AUTH",
        "USER",
        &format!("Disconnected Google account: {}", prev_email),
    ).ok();
    Ok(())
}

#[tauri::command]
pub fn get_google_account(state: State<'_, AppState>) -> Result<Option<GoogleAccountInfo>, String> {
    let settings = state.db.get_settings().map_err(|e| e.to_string())?;
    Ok(settings.google_account)
}

#[tauri::command]
pub fn minimize_to_tray(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("Main window not found".to_string())
    }
}

#[tauri::command]
pub async fn get_document_page_preview(
    state: State<'_, AppState>,
    job_id: String,
    file_path: String,
    page_number: i32,
) -> Result<crate::ocr::PagePreviewResponse, String> {
    let direct = PathBuf::from(&file_path);
    let mut resolved: Option<PathBuf> = if direct.is_absolute() && direct.exists() && direct.is_file() {
        Some(direct)
    } else {
        None
    };

    if resolved.is_none() {
        let settings = state.db.get_settings().map_err(|e| e.to_string())?;
        let job_opt = state.db.get_job(&job_id).map_err(|e| e.to_string())?;
        let mut search_roots = Vec::new();

        if let Some(ref job) = job_opt {
            if let Some(folder) = state.coordinator.locate_job_folder(job, &settings) {
                search_roots.push(folder);
            }
            for base in [
                &settings.processing_dir,
                &settings.review_dir,
                &settings.incoming_dir,
                &settings.sent_dir,
                &settings.failed_dir,
            ] {
                search_roots.push(PathBuf::from(base).join(&job.po_folder_name));
            }
        }

        let rel = PathBuf::from(&file_path);
        let file_name_only = rel.file_name().map(|n| n.to_os_string());

        for root in &search_roots {
            if !root.exists() {
                continue;
            }
            let cand = root.join(&rel);
            if cand.exists() && cand.is_file() {
                resolved = Some(cand);
                break;
            }
            if let Some(ref fname) = file_name_only {
                let by_name = root.join(fname);
                if by_name.exists() && by_name.is_file() {
                    resolved = Some(by_name);
                    break;
                }
                for entry in walkdir::WalkDir::new(root).max_depth(3).into_iter().filter_map(|e| e.ok()) {
                    if entry.file_type().is_file() && entry.file_name() == fname {
                        resolved = Some(entry.path().to_path_buf());
                        break;
                    }
                }
                if resolved.is_some() {
                    break;
                }
            }
        }
    }

    let final_path = resolved.ok_or_else(|| {
        format!(
            "Document '{}' was not found on disk (checked job source & workflow directories).",
            file_path
        )
    })?;

    state
        .ocr_manager
        .render_page_preview(&final_path, page_number)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_developer_console_snapshot(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let settings = state.db.get_settings().map_err(|e| e.to_string())?;
    let watcher_lock = state.watcher.lock().await;
    let (watcher_active, watcher_dir, watcher_queued_count) = match watcher_lock.as_ref() {
        Some(w) => (
            w.is_active(),
            w.incoming_dir().to_string_lossy().to_string(),
            w.active_jobs_count(),
        ),
        None => (false, settings.incoming_dir.clone(), 0),
    };
    drop(watcher_lock);

    let jobs = state.db.list_jobs(200, 0).unwrap_or_default();
    let mut by_status = std::collections::BTreeMap::<String, usize>::new();
    for j in &jobs {
        *by_status.entry(j.status.clone()).or_insert(0) += 1;
    }

    let worker_pid = state.ocr_manager.worker_pid().await;
    let terminal_lines = state.ocr_manager.get_logs();
    let recent_events = state.db.get_recent_events(50).unwrap_or_default();
    let audit_logs = state.db.get_audit_logs(30).unwrap_or_default();

    Ok(serde_json::json!({
        "app_pid": std::process::id(),
        "ocr_worker_pid": worker_pid,
        "ocr_worker_script": state.ocr_manager.script_path().to_string_lossy().to_string(),
        "watcher_active": watcher_active,
        "watcher_dir": watcher_dir,
        "watcher_queued_count": watcher_queued_count,
        "in_flight_count": state.coordinator.in_flight_count(),
        "jobs_summary": by_status,
        "terminal_lines": terminal_lines,
        "recent_events": recent_events,
        "audit_logs": audit_logs,
        "timestamp": chrono::Utc::now().to_rfc3339(),
    }))
}

#[tauri::command]
pub async fn run_developer_command(
    state: State<'_, AppState>,
    command: String,
) -> Result<String, String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    state.ocr_manager.push_log(format!("$ {}", trimmed));
    let cmd_lower = trimmed.to_lowercase();
    let settings = state.db.get_settings().map_err(|e| e.to_string())?;

    let output = match cmd_lower.as_str() {
        "help" | "?" => [
            "PO AutoFlow Enterprise Diagnostic CLI Commands:",
            "  help         - Show this command list",
            "  status | ps  - Show running processes (app PID, Python OCR worker PID, watcher & pipeline locks)",
            "  jobs         - List all jobs with status, stage, matched company, Drive file ID & errors",
            "  test-drive   - Probe Google Drive folder API & permissions + OAuth token freshness",
            "  test-gas     - Ping Google Apps Script webhook hub endpoint",
            "  test-sheets  - Live-fetch Google Sheet supplier directory & print parsed entries",
            "  reset-stuck  - Unlock any jobs stuck in processing/uploading_drive and move to needs_review",
            "  ping-ocr     - Ping managed Python OCR worker sidecar and measure latency",
            "  scan         - Immediately scan Incoming folder and enqueue waiting PO directories",
        ]
        .join("\n"),

        "status" | "ps" => {
            let watcher_lock = state.watcher.lock().await;
            let (w_active, w_dir, w_queued) = match watcher_lock.as_ref() {
                Some(w) => (
                    w.is_active(),
                    w.incoming_dir().to_string_lossy().to_string(),
                    w.active_jobs_count(),
                ),
                None => (false, settings.incoming_dir.clone(), 0),
            };
            drop(watcher_lock);
            let worker_pid = state.ocr_manager.worker_pid().await;
            let db_size = std::fs::metadata(&state.db.db_path).map(|m| m.len()).unwrap_or(0);
            format!(
                "PROCESSES & THREADS:\n  po-autoflow.exe      PID={}  [RUNNING - Tray & WebView2]\n  python.exe (OCR)     PID={}  [{}] ({})\n  FolderWatcher        {}  dir='{}' queued={}\n  PipelineCoordinator  in_flight_locks={}\nSTORAGE & CLOUD:\n  SQLite DB            {} ({} bytes)\n  Google Account       {}\n  Sheets ID / Tab      {} / {}\n  Drive Folder ID      {}\n  GAS Webhook          {}",
                std::process::id(),
                worker_pid.map(|p| p.to_string()).unwrap_or_else(|| "NOT_SPAWNED_YET".to_string()),
                if worker_pid.is_some() { "ALIVE" } else { "IDLE" },
                state.ocr_manager.script_path().to_string_lossy(),
                if w_active { "WATCHING" } else { "PAUSED" },
                w_dir,
                w_queued,
                state.coordinator.in_flight_count(),
                state.db.db_path.to_string_lossy(),
                db_size,
                settings.google_account.as_ref().map(|a| a.email.as_str()).unwrap_or("Not connected"),
                if settings.google_sheets_id.is_empty() { "<empty>" } else { &settings.google_sheets_id },
                settings.google_sheets_tab_name,
                if settings.google_drive_folder_id.is_empty() { "<empty>" } else { &settings.google_drive_folder_id },
                if settings.gas_webhook_url.is_empty() { "<empty>" } else { &settings.gas_webhook_url },
            )
        }

        "jobs" => {
            let jobs = state.db.list_jobs(30, 0).map_err(|e| e.to_string())?;
            if jobs.is_empty() {
                "No jobs recorded in database.".to_string()
            } else {
                jobs.into_iter()
                    .map(|j| {
                        format!(
                            "[{}] {} | po={} | raw={} | matched={} ({}) | drive_id={} | path={}\n  stage: {}{}",
                            j.status,
                            j.id,
                            j.po_number.as_deref().unwrap_or("-"),
                            j.detected_company_raw.as_deref().unwrap_or("-"),
                            j.matched_company_name.as_deref().unwrap_or("-"),
                            j.matched_email.as_deref().unwrap_or("-"),
                            j.drive_file_id.as_deref().unwrap_or("-"),
                            j.source_path,
                            j.stage_message,
                            j.error_details
                                .as_ref()
                                .map(|e| format!("\n  ERROR: {}", e))
                                .unwrap_or_default()
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            }
        }

        "test-drive" => {
            let mut mut_settings = settings.clone();
            let mut token_opt = None;
            if let Some(ref mut acct) = mut_settings.google_account {
                if let Ok(tok) = crate::google::auth::GoogleAuthManager::get_valid_access_token_with_gas(
                    acct,
                    &mut_settings.google_oauth_client_id,
                    &mut_settings.google_oauth_client_secret,
                    &mut_settings.gas_webhook_url,
                    &mut_settings.gas_auth_secret,
                )
                .await
                {
                    token_opt = Some(tok);
                    state.db.save_settings(&mut_settings).ok();
                }
            }
            let detail = state
                .coordinator
                .drive_client
                .diagnose_connection(&settings.google_drive_folder_id, token_opt.as_deref())
                .await;
            format!(
                "Google Drive Folder Check (folder_id='{}'):\n  {}\n  Apps Script fallback configured: {}",
                settings.google_drive_folder_id,
                detail,
                !settings.gas_webhook_url.trim().is_empty()
            )
        }

        "test-gas" => {
            match state
                .coordinator
                .email_client
                .test_connection(&settings.gas_webhook_url, Some(&settings.gas_auth_secret))
                .await
            {
                Ok(ok) => format!("Apps Script Hub test ({}) -> authorized={}", settings.gas_webhook_url, ok),
                Err(e) => format!("Apps Script Hub error: {}", e),
            }
        }

        "test-sheets" => match state.coordinator.sync_directory_from_google().await {
            Ok(entries) => {
                let rows = entries
                    .iter()
                    .map(|c| {
                        format!(
                            "  - '{}' (alt: {}) -> {}",
                            c.company_name,
                            c.alternative_name.as_deref().unwrap_or("-"),
                            c.email
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                format!("Synced {} supplier(s) from Google Sheets:\n{}", entries.len(), rows)
            }
            Err(e) => format!("Google Sheets sync error: {}", e),
        },

        "reset-stuck" => {
            let stuck = state.db.get_in_flight_jobs_for_recovery().map_err(|e| e.to_string())?;
            if stuck.is_empty() {
                "No stuck in-flight jobs found.".to_string()
            } else {
                let count = stuck.len();
                let mut lines = Vec::new();
                for mut j in stuck {
                    let prev = j.status.clone();
                    if let Some(folder) = state.coordinator.locate_job_folder(&j, &settings) {
                        state.coordinator.release_folder(&folder);
                        if folder.starts_with(&settings.processing_dir) {
                            if let Ok(review_path) = crate::pipeline::move_folder_to_dir(&folder, &settings.review_dir) {
                                j.source_path = review_path.to_string_lossy().to_string();
                            }
                        }
                    }
                    j.status = "needs_review".to_string();
                    j.stage_message = format!("Reset from stuck '{}' state. Click Retry or Approve & Send.", prev);
                    j.error_details = None;
                    j.updated_at = chrono::Utc::now().to_rfc3339();
                    state.db.update_job(&j).ok();
                    state.db.add_event(Some(&j.id), "warn", &format!("Manually reset stuck job from '{}'", prev)).ok();
                    lines.push(format!("  Reset {} ({}) '{}' -> needs_review", j.po_folder_name, j.id, prev));
                }
                format!("Reset {} stuck job(s):\n{}", count, lines.join("\n"))
            }
        }

        "ping-ocr" => {
            let start = std::time::Instant::now();
            match state.ocr_manager.ping().await {
                Ok(ok) => {
                    let pid = state.ocr_manager.worker_pid().await;
                    format!("Python OCR worker ping ok={} in {}ms (PID={:?})", ok, start.elapsed().as_millis(), pid)
                }
                Err(e) => format!("Python OCR worker ping FAILED in {}ms: {}", start.elapsed().as_millis(), e),
            }
        }

        "scan" => {
            let count = trigger_folder_scan(state.clone()).await?;
            format!("Scanned incoming directory; queued/active folders count = {}", count)
        }

        _ => format!("Unknown command '{}'. Type 'help' to see available diagnostic commands.", trimmed),
    };

    for line in output.lines().take(20) {
        state.ocr_manager.push_log(line.to_string());
    }
    Ok(output)
}

const DEFAULT_GITHUB_REPO: &str = "oscarpooper-lang/po-autoflow-enterprise";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GitHubUpdateStatus {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub release_name: String,
    pub release_notes: String,
    pub published_at: String,
    pub release_url: String,
    pub installer_url: Option<String>,
    pub installer_name: Option<String>,
    pub installer_size_bytes: Option<u64>,
    pub repository: String,
}

fn normalize_github_repo(input: Option<String>) -> Result<String, String> {
    let raw = input
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_GITHUB_REPO.to_string());

    let trimmed = raw
        .trim_start_matches("https://github.com/")
        .trim_start_matches("http://github.com/")
        .trim_end_matches('/')
        .trim_end_matches(".git");

    let parts: Vec<&str> = trimmed.split('/').collect();
    if parts.len() != 2
        || parts[0].is_empty()
        || parts[1].is_empty()
        || trimmed.contains("..")
        || trimmed.chars().any(|c| c.is_whitespace())
    {
        return Err(format!("Invalid GitHub repository format '{}'. Expected 'owner/repo'.", raw));
    }

    Ok(format!("{}/{}", parts[0], parts[1]))
}

fn parse_semver_tuple(ver: &str) -> (u64, u64, u64) {
    let clean = ver
        .trim()
        .trim_start_matches(['v', 'V'])
        .split(['-', '+'])
        .next()
        .unwrap_or("0");
    let mut nums = clean.split('.').map(|p| p.trim().parse::<u64>().unwrap_or(0));
    (
        nums.next().unwrap_or(0),
        nums.next().unwrap_or(0),
        nums.next().unwrap_or(0),
    )
}

fn is_newer_semver(current: &str, latest: &str) -> bool {
    parse_semver_tuple(latest) > parse_semver_tuple(current)
}

#[tauri::command]
pub async fn check_github_update(repo_override: Option<String>) -> Result<GitHubUpdateStatus, String> {
    let repo = normalize_github_repo(repo_override)?;
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let api_url = format!("https://api.github.com/repos/{}/releases/latest", repo);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to initialize HTTP client: {}", e))?;

    let response = client
        .get(&api_url)
        .header("User-Agent", format!("PO-AutoFlow-Enterprise/{}", current_version))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Failed to reach GitHub API: {}", e))?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(GitHubUpdateStatus {
            current_version: current_version.clone(),
            latest_version: current_version,
            update_available: false,
            release_name: "No published GitHub releases yet".to_string(),
            release_notes: String::new(),
            published_at: String::new(),
            release_url: format!("https://github.com/{}/releases", repo),
            installer_url: None,
            installer_name: None,
            installer_size_bytes: None,
            repository: repo,
        });
    }

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("GitHub API returned {}: {}", status, body));
    }

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Invalid GitHub release JSON: {}", e))?;

    let tag_name = json["tag_name"].as_str().unwrap_or("").trim().to_string();
    let latest_version = if tag_name.is_empty() {
        current_version.clone()
    } else {
        tag_name.trim_start_matches(['v', 'V']).to_string()
    };

    let release_name = json["name"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(if tag_name.is_empty() { "Latest Release" } else { &tag_name })
        .to_string();
    let release_notes = json["body"].as_str().unwrap_or("").to_string();
    let published_at = json["published_at"].as_str().unwrap_or("").to_string();
    let release_url = json["html_url"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("https://github.com/{}/releases", repo));

    let mut chosen_asset: Option<(u8, String, String, Option<u64>)> = None;
    if let Some(assets) = json["assets"].as_array() {
        for asset in assets {
            let name = asset["name"].as_str().unwrap_or("");
            let url = asset["browser_download_url"].as_str().unwrap_or("");
            let size = asset["size"].as_u64();
            if name.is_empty() || url.is_empty() {
                continue;
            }
            let lower = name.to_lowercase();
            let priority = if lower.ends_with(".exe") && lower.contains("setup") {
                Some(0u8)
            } else if lower.ends_with(".msi") {
                Some(1u8)
            } else if lower.ends_with(".exe") {
                Some(2u8)
            } else {
                None
            };
            if let Some(p) = priority {
                let replace = chosen_asset.as_ref().map(|c| p < c.0).unwrap_or(true);
                if replace {
                    chosen_asset = Some((p, url.to_string(), name.to_string(), size));
                }
            }
        }
    }

    let (installer_url, installer_name, installer_size_bytes) = match chosen_asset {
        Some((_, url, name, size)) => (Some(url), Some(name), size),
        None => (None, None, None),
    };

    let update_available = is_newer_semver(&current_version, &latest_version);

    Ok(GitHubUpdateStatus {
        current_version,
        latest_version,
        update_available,
        release_name,
        release_notes,
        published_at,
        release_url,
        installer_url,
        installer_name,
        installer_size_bytes,
        repository: repo,
    })
}

#[tauri::command]
pub async fn install_github_update(
    installer_url: String,
    installer_name: Option<String>,
) -> Result<String, String> {
    let url = installer_url.trim().to_string();
    let allowed_host = url.starts_with("https://github.com/")
        || url.starts_with("https://objects.githubusercontent.com/")
        || url.starts_with("https://release-assets.githubusercontent.com/");
    if !allowed_host {
        return Err("Refusing update download from untrusted URL host.".to_string());
    }

    let raw_name = installer_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| url.rsplit('/').next())
        .unwrap_or("PO-AutoFlow-Update-Setup.exe");

    let safe_name = std::path::Path::new(raw_name)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "Invalid installer filename".to_string())?
        .to_string();

    let lower = safe_name.to_lowercase();
    if safe_name.contains("..") || (!lower.ends_with(".exe") && !lower.ends_with(".msi")) {
        return Err(format!("Unsupported installer file type '{}'", safe_name));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("Failed to initialize download client: {}", e))?;

    let resp = client
        .get(&url)
        .header(
            "User-Agent",
            format!("PO-AutoFlow-Enterprise/{}", env!("CARGO_PKG_VERSION")),
        )
        .send()
        .await
        .map_err(|e| format!("Failed to download update installer: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Installer download failed with HTTP {}", resp.status()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read installer bytes: {}", e))?;

    if bytes.len() < 1024 {
        return Err("Downloaded installer file appears invalid or truncated.".to_string());
    }

    let temp_dir = std::env::temp_dir().join("po-autoflow-updates");
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to prepare update temp directory: {}", e))?;
    let installer_path = temp_dir.join(&safe_name);
    std::fs::write(&installer_path, &bytes)
        .map_err(|e| format!("Failed to save installer to {:?}: {}", installer_path, e))?;

    #[cfg(target_os = "windows")]
    {
        if lower.ends_with(".msi") {
            std::process::Command::new("msiexec")
                .arg("/i")
                .arg(&installer_path)
                .spawn()
                .map_err(|e| format!("Failed to launch MSI installer: {}", e))?;
        } else {
            std::process::Command::new(&installer_path)
                .spawn()
                .map_err(|e| format!("Failed to launch Setup installer: {}", e))?;
        }
        Ok(installer_path.to_string_lossy().to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err(format!(
            "Update downloaded to {:?}, automatic execution is Windows-only.",
            installer_path
        ))
    }
}

#[cfg(test)]
mod updater_tests {
    use super::*;

    #[test]
    fn test_semver_comparison() {
        assert!(is_newer_semver("1.0.0", "v1.0.1"));
        assert!(is_newer_semver("1.0.0", "1.1.0"));
        assert!(is_newer_semver("1.0.9", "v1.0.10"));
        assert!(is_newer_semver("1.9.9", "2.0.0"));
        assert!(!is_newer_semver("1.0.0", "v1.0.0"));
        assert!(!is_newer_semver("1.2.0", "v1.1.9"));
    }

    #[test]
    fn test_normalize_github_repo() {
        assert_eq!(
            normalize_github_repo(None).unwrap(),
            "oscarpooper-lang/po-autoflow-enterprise"
        );
        assert_eq!(
            normalize_github_repo(Some("https://github.com/oscarpooper-lang/po-autoflow-enterprise.git".into())).unwrap(),
            "oscarpooper-lang/po-autoflow-enterprise"
        );
        assert!(normalize_github_repo(Some("invalid-repo".into())).is_err());
    }
}
