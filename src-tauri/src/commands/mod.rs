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
pub async fn save_settings(state: State<'_, AppState>, mut settings: AppSettings) -> Result<(), String> {
    let trim_dir = |s: String| s.trim().trim_end_matches(['\\', '/']).to_string();
    settings.root_dir = trim_dir(settings.root_dir);
    settings.incoming_dir = trim_dir(settings.incoming_dir);
    settings.processing_dir = trim_dir(settings.processing_dir);
    settings.sent_dir = trim_dir(settings.sent_dir);
    settings.failed_dir = trim_dir(settings.failed_dir);
    settings.review_dir = trim_dir(settings.review_dir);
    settings.temp_dir = trim_dir(settings.temp_dir);
    settings.logs_dir = trim_dir(settings.logs_dir);

    for dir in [
        &settings.root_dir,
        &settings.incoming_dir,
        &settings.processing_dir,
        &settings.sent_dir,
        &settings.failed_dir,
        &settings.review_dir,
        &settings.temp_dir,
        &settings.logs_dir,
    ] {
        if !dir.is_empty() {
            std::fs::create_dir_all(dir).ok();
        }
    }

    state.db.save_settings(&settings).map_err(|e| e.to_string())?;

    // Restart live FolderWatcher automatically if Incoming path changed while monitoring is active
    {
        let mut lock = state.watcher.lock().await;
        if let Some(existing) = lock.as_ref() {
            let current_dir = existing.incoming_dir().to_string_lossy().to_string();
            if !current_dir.eq_ignore_ascii_case(&settings.incoming_dir) {
                if let Some(mut old) = lock.take() {
                    old.stop();
                }
                let mut new_watcher = FolderWatcher::new(&settings.incoming_dir, state.job_tx.clone())
                    .with_poll_interval(settings.poll_interval_ms);
                if let Err(e) = new_watcher.start() {
                    state.db.add_event(None, "warn", &format!("Failed restarting watcher on '{}': {}", settings.incoming_dir, e)).ok();
                } else {
                    state.coordinator.set_watcher_active_jobs(new_watcher.active_jobs());
                    *lock = Some(new_watcher);
                }
            }
        }
    }

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
pub fn get_department_cc_cache(state: State<'_, AppState>) -> Result<Vec<DepartmentCcEntry>, String> {
    state.db.get_department_cc_cache().map_err(|e| e.to_string())
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
pub async fn deep_scan_job_with_vision(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<(), String> {
    let job = state
        .db
        .get_job(&job_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Job not found".to_string())?;

    let settings = state.db.get_settings().map_err(|e| e.to_string())?;
    if settings.local_vision_provider.eq_ignore_ascii_case("builtin")
        || settings.local_vision_provider.trim().is_empty()
    {
        let status = verify_builtin_vision_ready(&settings.root_dir, &settings.local_vision_model);
        if !status.reachable {
            return Err(
                "Built-in Vision AI model is not downloaded yet. Open Settings -> OCR & AI Engine and click 'Download Inside App' first."
                    .to_string(),
            );
        }
    }

    let current_path = state
        .coordinator
        .locate_job_folder(&job, &settings)
        .ok_or_else(|| format!("PO folder '{}' cannot be found on disk", job.po_folder_name))?;

    state.coordinator.release_folder(&current_path);
    state
        .coordinator
        .process_po_folder_with_options(&current_path, true)
        .await
}

pub fn spawn_upsert_supplier_to_sheets(
    db: &Database,
    ocr_manager: &OcrManager,
    settings: &AppSettings,
    company_name: &str,
    recipient_email: &str,
) {
    if !settings.auto_sync_learned_suppliers_to_sheets
        || settings.gas_webhook_url.trim().is_empty()
        || settings.google_sheets_id.trim().is_empty()
    {
        return;
    }

    let matched_entry = db
        .get_companies_cache()
        .ok()
        .and_then(|list| {
            list.into_iter().find(|c| {
                c.company_name.eq_ignore_ascii_case(company_name)
                    || c.alternative_name
                        .as_deref()
                        .map(|a| a.eq_ignore_ascii_case(company_name))
                        .unwrap_or(false)
            })
        });
    let comp_is_thai = crate::matching::thai_normalizer::ThaiNormalizer::contains_thai(company_name);
    let mut alt_name = matched_entry.as_ref().and_then(|c| c.alternative_name.clone());
    if alt_name.as_deref().map(str::trim).unwrap_or("").is_empty() {
        let wanted_signal = if comp_is_thai { "english_name" } else { "thai_name" };
        if let Ok(memories) = db.get_learning_memories() {
            alt_name = memories
                .into_iter()
                .find(|m| {
                    m.signal_type == wanted_signal
                        && m.canonical_company_name.eq_ignore_ascii_case(company_name)
                        && !m.signal_value.eq_ignore_ascii_case(company_name)
                })
                .map(|m| m.signal_value);
        }
    }
    let tax_id = matched_entry.as_ref().and_then(|c| c.tax_id.clone());
    let notes_val = matched_entry.as_ref().and_then(|c| c.notes.clone());
    let webhook = settings.gas_webhook_url.clone();
    let secret = settings.gas_auth_secret.clone();
    let sheet_id = settings.google_sheets_id.clone();
    let tabs = crate::google::sheets::resolve_sheet_tabs(
        &settings.google_sheets_tab_name,
        &settings.google_sheets_ov_tab_name,
    );
    let primary_tab = tabs.first().cloned().unwrap_or_else(|| "Suppliers".to_string());
    let ov_tab_clean = settings.google_sheets_ov_tab_name.trim().to_string();
    let tab_name = if let Some(existing_grp) = matched_entry
        .as_ref()
        .and_then(|c| c.vendor_group.as_deref())
        .map(str::trim)
        .filter(|g| !g.is_empty())
    {
        if existing_grp.eq_ignore_ascii_case("OV") && !ov_tab_clean.is_empty() {
            ov_tab_clean
        } else if existing_grp.eq_ignore_ascii_case("DV") {
            primary_tab
        } else {
            existing_grp.to_string()
        }
    } else if !ov_tab_clean.is_empty()
        && crate::google::sheets::is_overseas_vendor(
            company_name,
            alt_name.as_deref().unwrap_or(""),
            recipient_email,
            tax_id.as_deref().unwrap_or(""),
        )
    {
        ov_tab_clean
    } else {
        primary_tab
    };
    let comp_clone = company_name.to_string();
    let email_clone = recipient_email.to_string();
    let db_clone = db.clone();
    let mgr_clone = ocr_manager.clone();

    tokio::spawn(async move {
        let Ok(client) = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
        else {
            return;
        };
        let payload = serde_json::json!({
            "action": "upsert_supplier",
            "auth_secret": secret,
            "sheet_id": sheet_id,
            "tab_name": tab_name,
            "company_name": comp_clone,
            "alternative_name": alt_name.unwrap_or_default(),
            "notes": notes_val.unwrap_or_default(),
            "email": email_clone,
            "tax_id": tax_id.unwrap_or_default(),
        });
        match client.post(&webhook).json(&payload).send().await {
            Ok(resp) => {
                let status_code = resp.status();
                let text = resp.text().await.unwrap_or_default();
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                    if val.get("status").and_then(|v| v.as_str()) == Some("ok") {
                        let mode = val.get("mode").and_then(|v| v.as_str()).unwrap_or("saved");
                        mgr_clone.push_log(format!(
                            "[sheets OK] Supplier '{}' ({}) synced back to Google Sheet ({}).",
                            comp_clone, email_clone, mode
                        ));
                    } else {
                        let err = val.get("error").and_then(|v| v.as_str()).unwrap_or(&text);
                        let msg = format!("Google Sheet supplier auto-save warning for '{}': {}", comp_clone, err);
                        mgr_clone.push_log(format!("[sheets WARN] {}", msg));
                        db_clone.add_event(None, "warn", &msg).ok();
                    }
                } else if !status_code.is_success() {
                    let msg = format!("Google Sheet supplier auto-save HTTP {} for '{}'", status_code, comp_clone);
                    mgr_clone.push_log(format!("[sheets WARN] {}", msg));
                    db_clone.add_event(None, "warn", &msg).ok();
                }
            }
            Err(e) => {
                let msg = format!("Failed auto-saving supplier '{}' to Google Sheet: {}", comp_clone, e);
                mgr_clone.push_log(format!("[sheets WARN] {}", msg));
                db_clone.add_event(None, "warn", &msg).ok();
            }
        }
    });
}

#[tauri::command]
pub async fn approve_and_send_job(
    state: State<'_, AppState>,
    job_id: String,
    company_name: String,
    recipient_email: String,
    po_number: Option<String>,
    save_alias: Option<bool>,
    cc_emails: Option<String>,
) -> Result<Job, String> {
    let clean_company = company_name.trim().to_string();

    if clean_company.is_empty() {
        return Err("Supplier company name is required".to_string());
    }
    if crate::matching::thai_normalizer::ThaiNormalizer::is_ignored_self_company(&clean_company) {
        return Err("Cannot dispatch to QTC Energy (self-company). Select the external supplier instead.".to_string());
    }
    let parsed_emails = EmailDeliveryClient::parse_recipient_emails(&recipient_email)
        .map_err(|_| format!("Invalid recipient email address: '{}'", recipient_email.trim()))?;
    for single in &parsed_emails {
        if single.to_lowercase().contains("qtc-energy")
            || crate::matching::thai_normalizer::ThaiNormalizer::is_ignored_self_company(single)
        {
            return Err(format!("Invalid or self-company recipient email address: '{}'", single));
        }
    }
    let clean_email = parsed_emails.join(", ");

    let mut job = state
        .db
        .get_job(&job_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Job not found".to_string())?;

    let settings = state.db.get_settings().map_err(|e| e.to_string())?;
    let clean_cc = match cc_emails.as_deref() {
        Some(ov) => EmailDeliveryClient::normalize_cc_list(ov)
            .map_err(|_| format!("Invalid CC email address: '{}'", ov.trim()))?,
        None => EmailDeliveryClient::merge_cc_lists(&[
            &settings.email_cc_default,
            job.department_cc_emails.as_deref().unwrap_or(""),
        ]),
    };

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

    if settings.self_learning_enabled {
        let learned_count = state
            .db
            .learn_from_approved_job(&job, &clean_company, &clean_email)
            .unwrap_or(0);
        if learned_count > 0 {
            state.ocr_manager.push_log(format!(
                "[self-learn] Learned {} signal(s) from manual approval of '{}' -> {}",
                learned_count, clean_company, clean_email
            ));
        }

        spawn_upsert_supplier_to_sheets(
            &state.db,
            &state.ocr_manager,
            &settings,
            &clean_company,
            &clean_email,
        );
    } else if save_alias.unwrap_or(true) {
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
        .deliver_po_package(
            &folder_path,
            job,
            &clean_company,
            &clean_email,
            &resolved_po,
            &documents,
            Some(clean_cc.as_str()),
        )
        .await
}

#[tauri::command]
pub async fn start_monitoring(state: State<'_, AppState>) -> Result<bool, String> {
    let settings = state.db.get_settings().map_err(|e| e.to_string())?;
    let mut lock = state.watcher.lock().await;

    if lock.is_none() {
        let mut watcher = FolderWatcher::new(&settings.incoming_dir, state.job_tx.clone())
            .with_poll_interval(settings.poll_interval_ms);
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
    ov_tab_name: Option<String>,
    gas_url: Option<String>,
    gas_secret: Option<String>,
) -> Result<usize, String> {
    let mut settings = state.db.get_settings().map_err(|e| e.to_string())?;
    let client = SheetsClient::new();
    let target_ov_tab = ov_tab_name
        .unwrap_or_else(|| settings.google_sheets_ov_tab_name.clone())
        .trim()
        .to_string();

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
            .fetch_companies_for_tabs_via_gas(
                &target_gas_url,
                &target_gas_secret,
                &spreadsheet_id,
                &tab_name,
                &target_ov_tab,
            )
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

    // Priority 3: Direct / Public export across configured tabs
    match client
        .fetch_companies_for_tabs(&spreadsheet_id, &tab_name, &target_ov_tab, token_opt.as_deref())
        .await
    {
        Ok(entries) => Ok(entries.len()),
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
    let clean_cc = EmailDeliveryClient::normalize_cc_list(&settings.email_cc_default)
        .map_err(|_| format!("Invalid default CC email address: '{}'", settings.email_cc_default.trim()))?;

    let resp = client
        .send_po_email_with_options(
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
            "individual_files",
            Vec::new(),
            false,
            &clean_cc,
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
    let settings = state.db.get_settings().map_err(|e| e.to_string())?;
    let (engine_path, model_path, mmproj_path) =
        resolve_builtin_vision_paths(&settings.root_dir, &settings.local_vision_model);
    let hints = crate::ocr::OcrHints {
        root_dir: settings.root_dir,
        negative_phrases: Vec::new(),
        preferred_y_band: None,
        local_vision_enabled: settings.local_vision_enabled,
        local_vision_provider: settings.local_vision_provider,
        local_vision_endpoint: settings.local_vision_endpoint,
        local_vision_model: settings.local_vision_model,
        builtin_engine_path: engine_path.to_string_lossy().to_string(),
        builtin_model_path: model_path.to_string_lossy().to_string(),
        builtin_mmproj_path: mmproj_path.to_string_lossy().to_string(),
        force_vision: false,
        ocr_quality_preset: settings.ocr_quality_preset,
        ocr_engine_primary: settings.ocr_engine_primary,
    };
    let resp = state
        .ocr_manager
        .process_file_with_hints(&path, Some(&hints))
        .await
        .map_err(|e| e.to_string())?;
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
    if path.contains('\0')
        || PathBuf::from(&path)
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("Invalid path segments rejected for security".to_string());
    }
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
        // Launch Windows Explorer directly without `cmd /C` so special characters in paths cannot trigger shell injection
        std::process::Command::new("explorer")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("Failed to open path in Windows Explorer: {}", e))?;
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
        if rel_str.contains('\0')
            || PathBuf::from(&rel_str)
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err("Invalid document path segments rejected".to_string());
        }
        let direct = PathBuf::from(&rel_str);
        if direct.is_absolute()
            && direct.exists()
            && crate::security::SecurityManager::validate_path_containment(&settings.root_dir, &direct).is_ok()
        {
            direct
        } else {
            let file_name_only = direct.file_name().map(|n| n.to_os_string());
            let mut found: Option<PathBuf> = None;
            for root in &search_roots {
                if !root.exists() {
                    continue;
                }
                let cand = root.join(&direct);
                if cand.exists()
                    && cand.is_file()
                    && crate::security::SecurityManager::validate_path_containment(root, &cand).is_ok()
                {
                    found = Some(cand);
                    break;
                }
                if let Some(ref fname) = file_name_only {
                    let by_name = root.join(fname);
                    if by_name.exists()
                        && by_name.is_file()
                        && crate::security::SecurityManager::validate_path_containment(root, &by_name).is_ok()
                    {
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
        std::process::Command::new("explorer")
            .arg(&target_to_open)
            .spawn()
            .map_err(|e| format!("Failed to open document or folder: {}", e))?;
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
            "  ping-ocr     - Ping managed OCR worker sidecar and measure latency",
            "  learning     - Show Self-Learning Memory statistics (learned names, Tax IDs, negative filters)",
            "  test-vision  - Test 100% offline Local Vision AI (Qwen2.5-VL-3B / SmolVLM2 / Ollama)",
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
                "PROCESSES & THREADS:\n  po-autoflow.exe      PID={}  [RUNNING - Tray & WebView2]\n  ocr-worker           PID={}  [{}] ({})\n  FolderWatcher        {}  dir='{}' queued={}\n  PipelineCoordinator  in_flight_locks={}\nSTORAGE & CLOUD:\n  SQLite DB            {} ({} bytes)\n  Google Account       {}\n  Sheets ID / Tab      {} / {}\n  Drive Folder ID      {}\n  GAS Webhook          {}",
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

        "learning" => {
            let stats = state.db.get_learning_stats().map_err(|e| e.to_string())?;
            format!(
                "SELF-LEARNING MEMORY ENGINE (enabled={}):\n  Learned Name Variants : {}\n  Learned 13-Digit Tax IDs: {}\n  Learned Email Domains   : {}\n  Blacklist Neg Phrases   : {}\n  Spatial Layout Zones    : {}\n  Company Aliases         : {}\n  Total Approvals Learned : {}",
                settings.self_learning_enabled,
                stats.learned_name_variants,
                stats.learned_tax_ids,
                stats.learned_email_domains,
                stats.negative_phrases_count,
                stats.learned_zones_count,
                stats.total_aliases,
                stats.total_approvals_learned
            )
        }

        "test-vision" => {
            let res = if settings.local_vision_provider == "builtin" {
                verify_builtin_vision_ready(&settings.root_dir, &settings.local_vision_model)
            } else {
                state
                    .ocr_manager
                    .test_local_vision(
                        &settings.local_vision_provider,
                        &settings.local_vision_endpoint,
                        &settings.local_vision_model,
                    )
                    .await?
            };
            format!(
                "LOCAL VISION AI (100% On-Device):\n  Enabled    : {}\n  Provider   : {}\n  Endpoint   : {}\n  Model      : {}\n  Reachable  : {}\n  Available  : {}\n  Message    : {}",
                settings.local_vision_enabled,
                settings.local_vision_provider,
                res.endpoint,
                res.configured_model,
                res.reachable,
                if res.available_models.is_empty() { "<none>".to_string() } else { res.available_models.join(", ") },
                res.message
            )
        }

        _ => format!("Unknown command '{}'. Type 'help' to see available diagnostic commands.", trimmed),
    };

    for line in output.lines().take(20) {
        state.ocr_manager.push_log(line.to_string());
    }
    Ok(output)
}

#[tauri::command]
pub fn get_learning_stats(state: State<'_, AppState>) -> Result<LearningStats, String> {
    state.db.get_learning_stats().map_err(|e| e.to_string())
}

const BUILTIN_ENGINE_ZIP_URL: &str =
    "https://github.com/ggml-org/llama.cpp/releases/download/b12430/llama-b12430-bin-win-vulkan-x64.zip";

struct BuiltinModelPreset {
    id: &'static str,
    name: &'static str,
    size_label: &'static str,
    total_size_bytes: u64,
    description: &'static str,
    model_filename: &'static str,
    mmproj_filename: &'static str,
    model_url: &'static str,
    mmproj_url: &'static str,
}

const BUILTIN_VISION_MODELS: &[BuiltinModelPreset] = &[
    BuiltinModelPreset {
        id: "smolvlm2-500m",
        name: "SmolVLM2-500M-Instruct (Ultra Tiny)",
        size_label: "520 MB",
        total_size_bytes: 545_579_008,
        description: "Fastest tiny helper for simple English PO numbers & Tax IDs.",
        model_filename: "SmolVLM2-500M-Video-Instruct-Q8_0.gguf",
        mmproj_filename: "mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf",
        model_url: "https://huggingface.co/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/resolve/main/SmolVLM2-500M-Video-Instruct-Q8_0.gguf",
        mmproj_url: "https://huggingface.co/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/resolve/main/mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf",
    },
    BuiltinModelPreset {
        id: "smolvlm2-2.2b",
        name: "SmolVLM2-2.2B-Instruct (Light Fallback)",
        size_label: "1.63 GB",
        total_size_bytes: 1_705_190_000,
        description: "Compact 2.2B vision-language model. Good lightweight helper for English headers.",
        model_filename: "SmolVLM2-2.2B-Instruct-Q4_K_M.gguf",
        mmproj_filename: "mmproj-SmolVLM2-2.2B-Instruct-Q8_0.gguf",
        model_url: "https://huggingface.co/ggml-org/SmolVLM2-2.2B-Instruct-GGUF/resolve/main/SmolVLM2-2.2B-Instruct-Q4_K_M.gguf",
        mmproj_url: "https://huggingface.co/ggml-org/SmolVLM2-2.2B-Instruct-GGUF/resolve/main/mmproj-SmolVLM2-2.2B-Instruct-Q8_0.gguf",
    },
    BuiltinModelPreset {
        id: "qwen2.5-vl-3b",
        name: "Qwen2.5-VL-3B-Instruct (Best Visual Helper)",
        size_label: "2.65 GB",
        total_size_bytes: 2_774_630_000,
        description: "Runs in ~8-12s with Vulkan GPU for English/Thai tables when fast OpenThai OCR needs a second opinion.",
        model_filename: "Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf",
        mmproj_filename: "mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf",
        model_url: "https://huggingface.co/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf",
        mmproj_url: "https://huggingface.co/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf",
    },
    BuiltinModelPreset {
        id: "typhoon-ocr-3b",
        name: "Typhoon-OCR-3B (SCB 10X Thai VLM)",
        size_label: "2.77 GB",
        total_size_bytes: 2_909_456_000,
        description: "Thai-specialized Qwen2.5-VL fine-tune by SCB 10X (Note: SCB 10X recommends Ollama for peak fidelity vs GGUF).",
        model_filename: "typhoon-ocr-3b.Q4_K_M.gguf",
        mmproj_filename: "typhoon-ocr-3b.mmproj-Q8_0.gguf",
        model_url: "https://huggingface.co/mradermacher/typhoon-ocr-3b-GGUF/resolve/main/typhoon-ocr-3b.Q4_K_M.gguf",
        mmproj_url: "https://huggingface.co/mradermacher/typhoon-ocr-3b-GGUF/resolve/main/typhoon-ocr-3b.mmproj-Q8_0.gguf",
    },
];

pub fn resolve_builtin_vision_paths(root_dir: &str, model_id: &str) -> (PathBuf, PathBuf, PathBuf) {
    let models_dir = PathBuf::from(root_dir).join("Models");
    let engine_exe = models_dir.join("engine").join("llama-mtmd-cli.exe");
    let preset = BUILTIN_VISION_MODELS
        .iter()
        .find(|p| p.id == model_id)
        .unwrap_or(&BUILTIN_VISION_MODELS[1]);
    let model_dir = models_dir.join(preset.id);
    (
        engine_exe,
        model_dir.join(preset.model_filename),
        model_dir.join(preset.mmproj_filename),
    )
}

fn verify_builtin_vision_ready(root_dir: &str, model_id: &str) -> LocalVisionStatus {
    let (engine_exe, model_path, mmproj_path) = resolve_builtin_vision_paths(root_dir, model_id);
    let mut installed_models = Vec::new();
    for preset in BUILTIN_VISION_MODELS {
        let (_, m_path, p_path) = resolve_builtin_vision_paths(root_dir, preset.id);
        let m_ok = std::fs::metadata(&m_path).map(|m| m.len() > 1_000_000).unwrap_or(false);
        let p_ok = std::fs::metadata(&p_path).map(|m| m.len() > 1_000_000).unwrap_or(false);
        if m_ok && p_ok {
            installed_models.push(preset.id.to_string());
        }
    }

    let engine_ok = engine_exe.exists();
    let has_vulkan = engine_exe
        .parent()
        .map(|d| d.join("ggml-vulkan.dll").exists())
        .unwrap_or(false);
    let model_ok = std::fs::metadata(&model_path).map(|m| m.len() > 1_000_000).unwrap_or(false);
    let mmproj_ok = std::fs::metadata(&mmproj_path).map(|m| m.len() > 1_000_000).unwrap_or(false);

    if !engine_ok || !model_ok || !mmproj_ok {
        return LocalVisionStatus {
            reachable: false,
            endpoint: engine_exe.to_string_lossy().to_string(),
            configured_model: model_id.to_string(),
            available_models: installed_models,
            message: format!(
                "Built-in model '{}' is not downloaded yet. Click 'Download Inside App' above to install it with zero external apps.",
                model_id
            ),
        };
    }

    let mut cmd = std::process::Command::new(&engine_exe);
    cmd.arg("--version");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    match cmd.output() {
        Ok(out) if out.status.success() => LocalVisionStatus {
            reachable: true,
            endpoint: engine_exe.to_string_lossy().to_string(),
            configured_model: model_id.to_string(),
            available_models: installed_models,
            message: format!(
                "Built-in {} engine & '{}' verified on disk (~{} per page).",
                if has_vulkan { "Vulkan GPU" } else { "CPU-only (upgrade to Vulkan GPU above for 5x speed)" },
                model_id,
                if has_vulkan { "8-12s" } else { "35-90s" }
            ),
        },
        Ok(out) => LocalVisionStatus {
            reachable: false,
            endpoint: engine_exe.to_string_lossy().to_string(),
            configured_model: model_id.to_string(),
            available_models: installed_models,
            message: format!(
                "Native engine exited with status {:?}: {}",
                out.status.code(),
                String::from_utf8_lossy(&out.stderr).trim()
            ),
        },
        Err(e) => LocalVisionStatus {
            reachable: false,
            endpoint: engine_exe.to_string_lossy().to_string(),
            configured_model: model_id.to_string(),
            available_models: installed_models,
            message: format!("Failed to execute native engine {:?}: {}", engine_exe, e),
        },
    }
}

fn build_builtin_vision_status(db: &Database, ocr_manager: &OcrManager) -> Result<BuiltInVisionStatus, String> {
    let settings = db.get_settings().map_err(|e| e.to_string())?;
    let models_dir = PathBuf::from(&settings.root_dir).join("Models");
    let engine_exe = models_dir.join("engine").join("llama-mtmd-cli.exe");
    let active_id = if BUILTIN_VISION_MODELS.iter().any(|p| p.id == settings.local_vision_model) {
        settings.local_vision_model.clone()
    } else {
        "smolvlm2-2.2b".to_string()
    };

    let models = BUILTIN_VISION_MODELS
        .iter()
        .map(|preset| {
            let (_, m_path, p_path) = resolve_builtin_vision_paths(&settings.root_dir, preset.id);
            let m_ok = std::fs::metadata(&m_path).map(|m| m.len() > 1_000_000).unwrap_or(false);
            let p_ok = std::fs::metadata(&p_path).map(|m| m.len() > 1_000_000).unwrap_or(false);
            BuiltInVisionModelEntry {
                id: preset.id.to_string(),
                name: preset.name.to_string(),
                size_label: preset.size_label.to_string(),
                total_size_bytes: preset.total_size_bytes,
                description: preset.description.to_string(),
                installed: m_ok && p_ok,
                active: settings.local_vision_enabled && active_id == preset.id,
                model_path: m_path.to_string_lossy().to_string(),
                mmproj_path: p_path.to_string_lossy().to_string(),
            }
        })
        .collect();

    Ok(BuiltInVisionStatus {
        engine_installed: engine_exe.exists(),
        engine_path: engine_exe.to_string_lossy().to_string(),
        models_dir: models_dir.to_string_lossy().to_string(),
        active_model_id: active_id,
        models,
        download: ocr_manager.get_download_progress(),
    })
}

async fn stream_download_file(
    client: &reqwest::Client,
    url: &str,
    dest_path: &std::path::Path,
    stage: &str,
    model_id: &str,
    ocr_manager: &OcrManager,
    base_offset: u64,
    grand_total_hint: u64,
    label: &str,
) -> Result<u64, String> {
    use std::io::Write;

    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory {:?}: {}", parent, e))?;
    }

    let part_path = dest_path.with_file_name(format!(
        "{}.part",
        dest_path.file_name().and_then(|n| n.to_str()).unwrap_or("download")
    ));

    let mut resp = client
        .get(url)
        .header(
            "User-Agent",
            format!("PO-AutoFlow-Enterprise/{}", env!("CARGO_PKG_VERSION")),
        )
        .send()
        .await
        .map_err(|e| format!("Network error downloading {}: {}", label, e))?;

    if !resp.status().is_success() {
        return Err(format!("Download failed for {} (HTTP {})", label, resp.status()));
    }

    let content_len = resp.content_length().unwrap_or(0);
    let effective_total = grand_total_hint.max(base_offset + content_len).max(1);

    let mut file = std::fs::File::create(&part_path)
        .map_err(|e| format!("Failed to create temp file {:?}: {}", part_path, e))?;

    let mut downloaded: u64 = 0;
    let mut last_reported: u64 = 0;

    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| {
            let _ = std::fs::remove_file(&part_path);
            format!("Stream error downloading {}: {}", label, e)
        })?
    {
        file.write_all(&chunk).map_err(|e| {
            let _ = std::fs::remove_file(&part_path);
            format!("Disk write error on {:?}: {}", part_path, e)
        })?;
        downloaded += chunk.len() as u64;

        if downloaded - last_reported >= 524_288 {
            last_reported = downloaded;
            let overall = base_offset + downloaded;
            let pct = ((overall as f64 / effective_total as f64) * 100.0).clamp(0.0, 99.5);
            ocr_manager.set_download_progress(BuiltInDownloadProgress {
                active: true,
                model_id: model_id.to_string(),
                stage: stage.to_string(),
                downloaded_bytes: overall,
                total_bytes: effective_total,
                percent: (pct * 10.0).round() / 10.0,
                message: format!(
                    "Downloading {} ({:.1} MB)...",
                    label,
                    downloaded as f64 / 1_048_576.0
                ),
                error: None,
            });
        }
    }

    file.flush()
        .map_err(|e| format!("Failed to flush file {:?}: {}", part_path, e))?;
    drop(file);

    if dest_path.exists() {
        std::fs::remove_file(dest_path).ok();
    }
    std::fs::rename(&part_path, dest_path)
        .map_err(|e| format!("Failed to finalize {:?}: {}", dest_path, e))?;

    Ok(downloaded)
}

#[tauri::command]
pub fn get_builtin_vision_status(state: State<'_, AppState>) -> Result<BuiltInVisionStatus, String> {
    build_builtin_vision_status(&state.db, &state.ocr_manager)
}

async fn install_engine_zip_internal(
    client: &reqwest::Client,
    models_dir: &std::path::Path,
    engine_dir: &std::path::Path,
    engine_exe: &std::path::Path,
    progress_id: &str,
    ocr_manager: &OcrManager,
    offset: &mut u64,
    total_expected: u64,
) -> Result<(), String> {
    let zip_path = models_dir.join("llama-engine-win-x64.zip");
    let bytes = stream_download_file(
        client,
        BUILTIN_ENGINE_ZIP_URL,
        &zip_path,
        "downloading_engine",
        progress_id,
        ocr_manager,
        *offset,
        total_expected,
        "Built-in Vulkan GPU Vision Engine (llama.cpp)",
    )
    .await?;
    *offset += bytes;
    ocr_manager.set_download_progress(BuiltInDownloadProgress {
        active: true,
        model_id: progress_id.to_string(),
        stage: "extracting_engine".to_string(),
        downloaded_bytes: *offset,
        total_bytes: total_expected,
        percent: ((*offset as f64 / total_expected.max(1) as f64) * 100.0).clamp(0.0, 99.5),
        message: "Extracting Vulkan GPU inference binaries...".to_string(),
        error: None,
    });

    let extract_res: Result<(), String> = (|| {
        std::fs::create_dir_all(engine_dir)
            .map_err(|e| format!("Failed creating engine dir: {}", e))?;
        let f = std::fs::File::open(&zip_path)
            .map_err(|e| format!("Failed opening engine zip: {}", e))?;
        let mut archive = zip::ZipArchive::new(f)
            .map_err(|e| format!("Invalid engine zip archive: {}", e))?;
        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| format!("Zip entry error: {}", e))?;
            if entry.is_dir() {
                continue;
            }
            if let Some(fname) = entry.enclosed_name().and_then(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|s| s.to_string())
            }) {
                let lower = fname.to_lowercase();
                if lower.ends_with(".exe") || lower.ends_with(".dll") {
                    let out_file_path = engine_dir.join(&fname);
                    let mut out_f = std::fs::File::create(&out_file_path)
                        .map_err(|e| format!("Failed creating {:?}: {}", out_file_path, e))?;
                    std::io::copy(&mut entry, &mut out_f)
                        .map_err(|e| format!("Failed extracting {}: {}", fname, e))?;
                }
            }
        }
        if !engine_exe.exists() {
            return Err("llama-mtmd-cli.exe was not found inside engine package".to_string());
        }
        Ok(())
    })();

    std::fs::remove_file(&zip_path).ok();
    extract_res
}

#[tauri::command]
pub async fn download_builtin_vision_model(
    state: State<'_, AppState>,
    model_id: String,
) -> Result<BuiltInVisionStatus, String> {
    let preset = BUILTIN_VISION_MODELS
        .iter()
        .find(|p| p.id == model_id.trim())
        .ok_or_else(|| format!("Unknown built-in model ID '{}'", model_id))?;

    if state.ocr_manager.get_download_progress().active {
        return build_builtin_vision_status(&state.db, &state.ocr_manager);
    }

    let settings = state.db.get_settings().map_err(|e| e.to_string())?;
    let root_dir = settings.root_dir.clone();
    let (engine_exe, model_path, mmproj_path) = resolve_builtin_vision_paths(&root_dir, preset.id);
    let models_dir = PathBuf::from(&root_dir).join("Models");
    let engine_dir = models_dir.join("engine");
    let has_vulkan_dll = engine_dir.join("ggml-vulkan.dll").exists();
    let need_engine = !engine_exe.exists() || !has_vulkan_dll;
    let engine_estimate: u64 = if need_engine { 40_160_000 } else { 0 };
    let total_expected = engine_estimate + preset.total_size_bytes;

    state.ocr_manager.set_download_progress(BuiltInDownloadProgress {
        active: true,
        model_id: preset.id.to_string(),
        stage: "starting".to_string(),
        downloaded_bytes: 0,
        total_bytes: total_expected,
        percent: 0.0,
        message: format!("Starting in-app download for {}...", preset.name),
        error: None,
    });

    let db = state.db.clone();
    let ocr_manager = state.ocr_manager.clone();

    tokio::spawn(async move {
        let client = match reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(30))
            .timeout(std::time::Duration::from_secs(3600))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                ocr_manager.set_download_progress(BuiltInDownloadProgress {
                    active: false,
                    model_id: preset.id.to_string(),
                    stage: "error".to_string(),
                    downloaded_bytes: 0,
                    total_bytes: total_expected,
                    percent: 0.0,
                    message: format!("HTTP client error: {}", e),
                    error: Some(e.to_string()),
                });
                return;
            }
        };

        let mut offset: u64 = 0;

        // 1. Download & extract native Windows Vulkan GPU inference engine (llama-mtmd-cli.exe + DLLs)
        if need_engine {
            if let Err(err) = install_engine_zip_internal(
                &client,
                &models_dir,
                &engine_dir,
                &engine_exe,
                preset.id,
                &ocr_manager,
                &mut offset,
                total_expected,
            )
            .await
            {
                ocr_manager.set_download_progress(BuiltInDownloadProgress {
                    active: false,
                    model_id: preset.id.to_string(),
                    stage: "error".to_string(),
                    downloaded_bytes: offset,
                    total_bytes: total_expected,
                    percent: 0.0,
                    message: err.clone(),
                    error: Some(err),
                });
                return;
            }
        }

        // 2. Download Vision Projector (mmproj.gguf)
        if !std::fs::metadata(&mmproj_path).map(|m| m.len() > 1_000_000).unwrap_or(false) {
            match stream_download_file(
                &client,
                preset.mmproj_url,
                &mmproj_path,
                "downloading_mmproj",
                preset.id,
                &ocr_manager,
                offset,
                total_expected,
                &format!("{} Vision Projector", preset.id),
            )
            .await
            {
                Ok(bytes) => offset += bytes,
                Err(err) => {
                    ocr_manager.set_download_progress(BuiltInDownloadProgress {
                        active: false,
                        model_id: preset.id.to_string(),
                        stage: "error".to_string(),
                        downloaded_bytes: offset,
                        total_bytes: total_expected,
                        percent: 0.0,
                        message: err.clone(),
                        error: Some(err),
                    });
                    return;
                }
            }
        }

        // 3. Download Quantized Model Weights (.gguf)
        if !std::fs::metadata(&model_path).map(|m| m.len() > 1_000_000).unwrap_or(false) {
            match stream_download_file(
                &client,
                preset.model_url,
                &model_path,
                "downloading_model",
                preset.id,
                &ocr_manager,
                offset,
                total_expected,
                preset.name,
            )
            .await
            {
                Ok(bytes) => offset += bytes,
                Err(err) => {
                    ocr_manager.set_download_progress(BuiltInDownloadProgress {
                        active: false,
                        model_id: preset.id.to_string(),
                        stage: "error".to_string(),
                        downloaded_bytes: offset,
                        total_bytes: total_expected,
                        percent: 0.0,
                        message: err.clone(),
                        error: Some(err),
                    });
                    return;
                }
            }
        }

        // Activate in settings
        if let Ok(mut s) = db.get_settings() {
            s.local_vision_enabled = true;
            s.local_vision_provider = "builtin".to_string();
            s.local_vision_model = preset.id.to_string();
            db.save_settings(&s).ok();
        }
        ocr_manager.push_log(format!(
            "[vision-ai] Built-in model '{}' downloaded and activated inside {:?}",
            preset.id, models_dir
        ));
        ocr_manager.set_download_progress(BuiltInDownloadProgress {
            active: false,
            model_id: preset.id.to_string(),
            stage: "completed".to_string(),
            downloaded_bytes: offset.max(total_expected),
            total_bytes: total_expected,
            percent: 100.0,
            message: format!("{} is downloaded and active!", preset.name),
            error: None,
        });
    });

    build_builtin_vision_status(&state.db, &state.ocr_manager)
}

#[tauri::command]
pub fn delete_builtin_vision_model(
    state: State<'_, AppState>,
    model_id: String,
) -> Result<BuiltInVisionStatus, String> {
    let preset = BUILTIN_VISION_MODELS
        .iter()
        .find(|p| p.id == model_id.trim())
        .ok_or_else(|| format!("Unknown built-in model ID '{}'", model_id))?;

    let mut settings = state.db.get_settings().map_err(|e| e.to_string())?;
    let model_dir = PathBuf::from(&settings.root_dir).join("Models").join(preset.id);
    if model_dir.exists() {
        std::fs::remove_dir_all(&model_dir)
            .map_err(|e| format!("Failed deleting model files at {:?}: {}", model_dir, e))?;
    }

    if settings.local_vision_model == preset.id {
        settings.local_vision_enabled = false;
        state.db.save_settings(&settings).ok();
    }

    build_builtin_vision_status(&state.db, &state.ocr_manager)
}

#[tauri::command]
pub async fn test_local_vision_ai(
    state: State<'_, AppState>,
    provider: Option<String>,
    endpoint: Option<String>,
    model: Option<String>,
) -> Result<LocalVisionStatus, String> {
    let settings = state.db.get_settings().map_err(|e| e.to_string())?;
    let prov = provider
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(settings.local_vision_provider);
    let ep = endpoint
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(settings.local_vision_endpoint);
    let mdl = model
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(settings.local_vision_model);

    if prov.eq_ignore_ascii_case("builtin") {
        return Ok(verify_builtin_vision_ready(&settings.root_dir, &mdl));
    }

    state.ocr_manager.test_local_vision(&prov, &ep, &mdl).await
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct OcrEngineStatus {
    pub python_version: String,
    pub worker_reachable: bool,
    pub pymupdf_available: bool,
    pub openthaigpt_available: bool,
    pub openthaigpt_path: String,
    pub openthaigpt_backend: String,
    pub openthaigpt_note: String,
    pub paddleocr_available: bool,
    pub paddleocr_note: String,
    pub tesseract_available: bool,
    pub tesseract_path: String,
    pub tesseract_langs: Vec<String>,
    pub winrt_available: bool,
    pub winrt_thai_installed: bool,
    pub active_scanned_engine: String,
    pub vision_engine_vulkan: bool,
    pub vision_ai_enabled: bool,
    pub vision_ai_trigger_mode: String,
    pub vision_ai_model: String,
    pub vision_ai_ready: bool,
    pub vision_ai_status_label: String,
    pub vision_ai_message: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct OcrSelfTestResult {
    pub status: String,
    pub file_tested: String,
    pub duration_ms: u64,
    pub engine_used: String,
    pub confidence: f64,
    pub supplier_detected: Option<String>,
    pub po_numbers: Vec<String>,
    pub tax_ids: Vec<String>,
    pub vision_ai_status: Option<String>,
    pub vision_ai_error: Option<String>,
    pub vision_ai_duration_ms: Option<f64>,
    pub vision_ai_device: Option<String>,
    pub text_preview: String,
}

fn collect_benchmark_candidate_files(settings: &AppSettings) -> Vec<String> {
    let mut files: Vec<String> = Vec::new();
    let exts = ["pdf", "png", "jpg", "jpeg", "tif", "tiff", "bmp"];

    for dir_str in [
        &settings.review_dir,
        &settings.incoming_dir,
        &settings.processing_dir,
        &settings.sent_dir,
    ] {
        let dir = PathBuf::from(dir_str);
        if !dir.exists() {
            continue;
        }
        for entry in walkdir::WalkDir::new(&dir).max_depth(3).into_iter().filter_map(|e| e.ok()) {
            let p = entry.path();
            if !p.is_file() {
                continue;
            }
            let ext_ok = p
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| exts.contains(&e.to_lowercase().as_str()))
                .unwrap_or(false);
            if ext_ok {
                let s = p.to_string_lossy().to_string();
                if !files.contains(&s) {
                    files.push(s);
                }
                if files.len() >= 25 {
                    return files;
                }
            }
        }
    }

    if files.is_empty() {
        if let Some(proj_root) = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent() {
            let sample_dir = proj_root.join("sample_data");
            if sample_dir.exists() {
                for entry in walkdir::WalkDir::new(&sample_dir).max_depth(3).into_iter().filter_map(|e| e.ok()) {
                    let p = entry.path();
                    if p.is_file()
                        && p.extension()
                            .and_then(|e| e.to_str())
                            .map(|e| exts.contains(&e.to_lowercase().as_str()))
                            .unwrap_or(false)
                    {
                        files.push(p.to_string_lossy().to_string());
                        if files.len() >= 10 {
                            break;
                        }
                    }
                }
            }
        }
    }
    files
}

fn create_synthetic_selftest_image(temp_dir: &std::path::Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(temp_dir)
        .map_err(|e| format!("Failed creating Temp folder {:?}: {}", temp_dir, e))?;
    let out_path = temp_dir.join("po-autoflow-selftest.png");
    let out_str = out_path.to_string_lossy().replace('\'', "''");
    let ps_script = format!(
        "Add-Type -AssemblyName System.Drawing; \
        $bmp = New-Object System.Drawing.Bitmap 1100, 420; \
        $g = [System.Drawing.Graphics]::FromImage($bmp); \
        $g.Clear([System.Drawing.Color]::White); \
        $fontTitle = New-Object System.Drawing.Font('Tahoma', 22, [System.Drawing.FontStyle]::Bold); \
        $fontBody = New-Object System.Drawing.Font('Tahoma', 18); \
        $brush = [System.Drawing.Brushes]::Black; \
        $g.DrawString('PURCHASE ORDER / ใบสั่งซื้อ', $fontTitle, $brush, 40, 30); \
        $g.DrawString('Supplier: บริษัท สยาม ซัพพลาย แอนด์ เทรดดิ้ง จำกัด', $fontBody, $brush, 40, 100); \
        $g.DrawString('SIAM SUPPLY AND TRADING CO., LTD.', $fontBody, $brush, 40, 150); \
        $g.DrawString('Tax ID: 0105558012345   PO Number: PO-26009999', $fontBody, $brush, 40, 210); \
        $g.DrawString('Email: sales@siamsupply.co.th', $fontBody, $brush, 40, 270); \
        $bmp.Save('{out_str}', [System.Drawing.Imaging.ImageFormat]::Png); \
        $g.Dispose(); $bmp.Dispose();"
    );
    let mut cmd = std::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &ps_script]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("Failed creating self-test image: {}", e))?;
    if !out.status.success() || !out_path.exists() {
        return Err(format!(
            "Failed rendering self-test sample image: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(out_path)
}

#[tauri::command]
pub async fn install_vulkan_vision_engine(
    state: State<'_, AppState>,
) -> Result<BuiltInVisionStatus, String> {
    if state.ocr_manager.get_download_progress().active {
        return build_builtin_vision_status(&state.db, &state.ocr_manager);
    }
    let settings = state.db.get_settings().map_err(|e| e.to_string())?;
    let models_dir = PathBuf::from(&settings.root_dir).join("Models");
    let engine_dir = models_dir.join("engine");
    let engine_exe = engine_dir.join("llama-mtmd-cli.exe");

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let mut offset: u64 = 0;
    let total_expected: u64 = 40_160_000;
    state.ocr_manager.set_download_progress(BuiltInDownloadProgress {
        active: true,
        model_id: "engine-vulkan".to_string(),
        stage: "starting".to_string(),
        downloaded_bytes: 0,
        total_bytes: total_expected,
        percent: 0.0,
        message: "Downloading Vulkan GPU inference engine (llama.cpp ~38 MB)...".to_string(),
        error: None,
    });

    if let Err(err) = install_engine_zip_internal(
        &client,
        &models_dir,
        &engine_dir,
        &engine_exe,
        "engine-vulkan",
        &state.ocr_manager,
        &mut offset,
        total_expected,
    )
    .await
    {
        state.ocr_manager.set_download_progress(BuiltInDownloadProgress {
            active: false,
            model_id: "engine-vulkan".to_string(),
            stage: "error".to_string(),
            downloaded_bytes: offset,
            total_bytes: total_expected,
            percent: 0.0,
            message: err.clone(),
            error: Some(err.clone()),
        });
        return Err(err);
    }

    state.ocr_manager.set_download_progress(BuiltInDownloadProgress {
        active: false,
        model_id: "engine-vulkan".to_string(),
        stage: "completed".to_string(),
        downloaded_bytes: total_expected,
        total_bytes: total_expected,
        percent: 100.0,
        message: "Vulkan GPU Vision Engine installed and ready!".to_string(),
        error: None,
    });

    build_builtin_vision_status(&state.db, &state.ocr_manager)
}

#[tauri::command]
pub async fn install_openthaigpt_ocr(state: State<'_, AppState>) -> Result<OcrEngineStatus, String> {
    let settings = state.db.get_settings().map_err(|e| e.to_string())?;
    let dest_dir = PathBuf::from(&settings.root_dir)
        .join("Models")
        .join("openthaigpt-ocr-text");
    std::fs::create_dir_all(dest_dir.join("runtime"))
        .map_err(|e| format!("Failed creating OpenThai 2.0 folder {:?}: {}", dest_dir, e))?;

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let hf_files = [
        "config.json",
        "det.yml",
        "det.onnx",
        "rec.onnx",
        "rec_dict.txt",
        "runtime/__init__.py",
        "runtime/line_engine.py",
        "runtime/thai_norm.py",
    ];

    for rel in hf_files {
        let out_file = dest_dir.join(rel.replace('/', "\\"));
        let already_ok = std::fs::metadata(&out_file).is_ok()
            && (rel.ends_with("__init__.py") || std::fs::metadata(&out_file).map(|m| m.len() > 0).unwrap_or(false));
        if already_ok {
            continue;
        }
        let url = format!("https://huggingface.co/iapp/OpenThai2.0-OCR-Text/resolve/main/{}", rel);
        let resp = client
            .get(&url)
            .header("User-Agent", format!("PO-AutoFlow-Enterprise/{}", env!("CARGO_PKG_VERSION")))
            .send()
            .await
            .map_err(|e| format!("Network error fetching {}: {}", rel, e))?;
        if !resp.status().is_success() {
            return Err(format!("Failed downloading OpenThai file {} (HTTP {})", rel, resp.status()));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("Failed reading bytes for {}: {}", rel, e))?;
        if let Some(parent) = out_file.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        std::fs::write(&out_file, &bytes)
            .map_err(|e| format!("Failed saving {:?}: {}", out_file, e))?;
    }

    // Ensure Python onnxruntime + pyclipper runtime dependencies exist
    let mut py_check = std::process::Command::new("python");
    py_check.args(["-c", "import onnxruntime, pyclipper"]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        py_check.creation_flags(0x08000000);
    }
    let deps_ok = py_check.output().map(|o| o.status.success()).unwrap_or(false);
    if !deps_ok {
        let mut pip_cmd = std::process::Command::new("python");
        pip_cmd.args(["-m", "pip", "install", "--user", "onnxruntime", "pyclipper"]);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            pip_cmd.creation_flags(0x08000000);
        }
        let pip_out = pip_cmd
            .output()
            .map_err(|e| format!("Failed installing onnxruntime/pyclipper: {}", e))?;
        if !pip_out.status.success() {
            return Err(format!(
                "pip install onnxruntime pyclipper failed: {}",
                String::from_utf8_lossy(&pip_out.stderr).trim()
            ));
        }
    }

    get_ocr_engine_status(state).await
}

#[tauri::command]
pub async fn run_ocr_self_test(
    state: State<'_, AppState>,
    file_path: Option<String>,
) -> Result<OcrSelfTestResult, String> {
    let settings = state.db.get_settings().map_err(|e| e.to_string())?;
    let mut is_synthetic = false;
    let target_path = if let Some(fp) = file_path.filter(|s| !s.trim().is_empty()) {
        let p = PathBuf::from(fp.trim());
        if !p.exists() {
            return Err(format!("Selected test file does not exist: {}", fp));
        }
        p
    } else if let Some(first) = collect_benchmark_candidate_files(&settings).into_iter().next() {
        PathBuf::from(first)
    } else {
        is_synthetic = true;
        create_synthetic_selftest_image(&PathBuf::from(&settings.temp_dir))?
    };

    let (engine_path, model_path, mmproj_path) =
        resolve_builtin_vision_paths(&settings.root_dir, &settings.local_vision_model);

    let hints = crate::ocr::OcrHints {
        root_dir: settings.root_dir.clone(),
        negative_phrases: Vec::new(),
        preferred_y_band: None,
        local_vision_enabled: settings.local_vision_enabled,
        local_vision_provider: settings.local_vision_provider.clone(),
        local_vision_endpoint: settings.local_vision_endpoint.clone(),
        local_vision_model: settings.local_vision_model.clone(),
        builtin_engine_path: engine_path.to_string_lossy().to_string(),
        builtin_model_path: model_path.to_string_lossy().to_string(),
        builtin_mmproj_path: mmproj_path.to_string_lossy().to_string(),
        force_vision: settings.local_vision_enabled,
        ocr_quality_preset: settings.ocr_quality_preset.clone(),
        ocr_engine_primary: settings.ocr_engine_primary.clone(),
    };

    let started = std::time::Instant::now();
    let resp = state
        .ocr_manager
        .process_file_with_hints(&target_path, Some(&hints))
        .await
        .map_err(|e| e.to_string())?;
    let elapsed_ms = started.elapsed().as_millis() as u64;

    if is_synthetic {
        let _ = std::fs::remove_file(&target_path);
    }

    let first_page = resp.pages.as_ref().and_then(|p| p.first());
    let engine_used = first_page
        .map(|p| p.extraction_method.clone())
        .unwrap_or_else(|| "unknown".to_string());
    let confidence = first_page
        .map(|p| (p.confidence * 100.0).min(100.0))
        .unwrap_or(0.0);
    let raw_preview = first_page
        .map(|p| p.raw_text.chars().take(420).collect::<String>())
        .unwrap_or_default();
    let supplier = resp
        .aggregated
        .as_ref()
        .and_then(|a| a.primary_supplier.clone());
    let po_numbers = resp
        .aggregated
        .as_ref()
        .map(|a| a.po_numbers.clone())
        .unwrap_or_default();
    let tax_ids = resp
        .aggregated
        .as_ref()
        .map(|a| a.tax_ids.clone())
        .unwrap_or_default();

    Ok(OcrSelfTestResult {
        status: resp.status,
        file_tested: if is_synthetic {
            "Built-in Thai+English PO Sample".to_string()
        } else {
            target_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("sample")
                .to_string()
        },
        duration_ms: elapsed_ms,
        engine_used,
        confidence: (confidence * 10.0).round() / 10.0,
        supplier_detected: supplier,
        po_numbers,
        tax_ids,
        vision_ai_status: resp.vision_ai_status,
        vision_ai_error: resp.vision_ai_error,
        vision_ai_duration_ms: resp.vision_ai_duration_ms,
        vision_ai_device: resp.vision_ai_device,
        text_preview: raw_preview,
    })
}

#[tauri::command]
pub async fn get_ocr_engine_status(state: State<'_, AppState>) -> Result<OcrEngineStatus, String> {
    let settings = state.db.get_settings().map_err(|e| e.to_string())?;
    let has_vulkan_dll = PathBuf::from(&settings.root_dir)
        .join("Models")
        .join("engine")
        .join("ggml-vulkan.dll")
        .exists();
    let vision = if settings.local_vision_provider.eq_ignore_ascii_case("builtin") {
        verify_builtin_vision_ready(&settings.root_dir, &settings.local_vision_model)
    } else {
        state
            .ocr_manager
            .test_local_vision(
                &settings.local_vision_provider,
                &settings.local_vision_endpoint,
                &settings.local_vision_model,
            )
            .await
            .unwrap_or(LocalVisionStatus {
                reachable: false,
                endpoint: settings.local_vision_endpoint.clone(),
                configured_model: settings.local_vision_model.clone(),
                available_models: Vec::new(),
                message: "Local Vision server unreachable".to_string(),
            })
    };

    let accel_note = if settings.local_vision_provider.eq_ignore_ascii_case("builtin") {
        if has_vulkan_dll {
            "Vulkan GPU"
        } else {
            "CPU-only (upgrade GPU engine for 5x speed)"
        }
    } else {
        "External"
    };

    let (vision_status_label, vision_message) = if !settings.local_vision_enabled {
        (
            "Disabled (Optional)".to_string(),
            "Standard PDF Reader + OpenThai 2.0 OCR handles 95%+ of POs in <1s. Turn on Vision AI below only if you want an AI second opinion on messy scans.".to_string(),
        )
    } else if !vision.reachable {
        (
            "Enabled — Model Missing!".to_string(),
            format!(
                "Vision AI is turned ON for '{}', but its files are not downloaded yet inside {}\\Models.",
                settings.local_vision_model,
                settings.root_dir.trim_end_matches(['\\', '/'])
            ),
        )
    } else if settings.local_vision_trigger_mode == "always" {
        (
            format!("Active • {}", accel_note),
            format!("Runs '{}' ({}) on every PO document.", settings.local_vision_model, accel_note),
        )
    } else {
        (
            format!("Smart Fallback • {}", accel_note),
            format!(
                "Helps automatically with '{}' ({}) only when OCR confidence is below 85% or supplier is missing.",
                settings.local_vision_model, accel_note
            ),
        )
    };

    match state.ocr_manager.ping_details(&settings.root_dir).await {
        Ok(val) => {
            let caps = &val["capabilities"];
            let langs = caps["tesseract_langs"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();

            Ok(OcrEngineStatus {
                python_version: caps["python_version"].as_str().unwrap_or("unknown").to_string(),
                worker_reachable: val["status"].as_str() == Some("ok"),
                pymupdf_available: caps["pymupdf_available"].as_bool().unwrap_or(true),
                openthaigpt_available: caps["openthaigpt_available"].as_bool().unwrap_or(false),
                openthaigpt_path: caps["openthaigpt_path"].as_str().unwrap_or("").to_string(),
                openthaigpt_backend: caps["openthaigpt_backend"].as_str().unwrap_or("").to_string(),
                openthaigpt_note: caps["openthaigpt_note"]
                    .as_str()
                    .unwrap_or("Check Python environment")
                    .to_string(),
                paddleocr_available: caps["paddleocr_available"]
                    .as_bool()
                    .or_else(|| val["paddleocr"].as_bool())
                    .unwrap_or(false),
                paddleocr_note: caps["paddleocr_note"]
                    .as_str()
                    .unwrap_or("Not installed")
                    .to_string(),
                tesseract_available: caps["tesseract_available"].as_bool().unwrap_or(false),
                tesseract_path: caps["tesseract_path"].as_str().unwrap_or("").to_string(),
                tesseract_langs: langs,
                winrt_available: caps["winrt_available"].as_bool().unwrap_or(cfg!(target_os = "windows")),
                winrt_thai_installed: caps["winrt_thai_installed"].as_bool().unwrap_or(false),
                active_scanned_engine: caps["active_scanned_engine"]
                    .as_str()
                    .unwrap_or("tesseract_tha_eng")
                    .to_string(),
                vision_engine_vulkan: has_vulkan_dll,
                vision_ai_enabled: settings.local_vision_enabled,
                vision_ai_trigger_mode: settings.local_vision_trigger_mode,
                vision_ai_model: settings.local_vision_model,
                vision_ai_ready: vision.reachable,
                vision_ai_status_label: vision_status_label,
                vision_ai_message: vision_message,
            })
        }
        Err(e) => Ok(OcrEngineStatus {
            python_version: "offline".to_string(),
            worker_reachable: false,
            pymupdf_available: false,
            openthaigpt_available: false,
            openthaigpt_path: String::new(),
            openthaigpt_backend: String::new(),
            openthaigpt_note: format!("Worker offline: {}", e),
            paddleocr_available: false,
            paddleocr_note: format!("OCR worker unreachable: {}", e),
            tesseract_available: false,
            tesseract_path: String::new(),
            tesseract_langs: Vec::new(),
            winrt_available: cfg!(target_os = "windows"),
            winrt_thai_installed: false,
            active_scanned_engine: "none".to_string(),
            vision_engine_vulkan: has_vulkan_dll,
            vision_ai_enabled: settings.local_vision_enabled,
            vision_ai_trigger_mode: settings.local_vision_trigger_mode,
            vision_ai_model: settings.local_vision_model,
            vision_ai_ready: vision.reachable,
            vision_ai_status_label: vision_status_label,
            vision_ai_message: vision_message,
        }),
    }
}

#[tauri::command]
pub fn list_benchmark_candidates(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let settings = state.db.get_settings().map_err(|e| e.to_string())?;
    Ok(collect_benchmark_candidate_files(&settings))
}

#[tauri::command]
pub async fn benchmark_ocr_layers(
    state: State<'_, AppState>,
    file_path: String,
) -> Result<serde_json::Value, String> {
    let trimmed = file_path.trim();
    if trimmed.is_empty() {
        return Err("Please select or enter a PDF/image file path to benchmark.".to_string());
    }
    let path = PathBuf::from(trimmed);
    if !path.exists() {
        return Err(format!("Benchmark file not found: {}", trimmed));
    }

    let settings = state.db.get_settings().map_err(|e| e.to_string())?;
    let vision_models: Vec<serde_json::Value> = BUILTIN_VISION_MODELS
        .iter()
        .map(|preset| {
            let (engine_exe, model_path, mmproj_path) =
                resolve_builtin_vision_paths(&settings.root_dir, preset.id);
            let installed = engine_exe.exists()
                && std::fs::metadata(&model_path).map(|m| m.len() > 1_000_000).unwrap_or(false)
                && std::fs::metadata(&mmproj_path).map(|m| m.len() > 1_000_000).unwrap_or(false);
            serde_json::json!({
                "id": preset.id,
                "name": preset.name,
                "size_label": preset.size_label,
                "installed": installed,
                "engine_path": engine_exe.to_string_lossy(),
                "model_path": model_path.to_string_lossy(),
                "mmproj_path": mmproj_path.to_string_lossy(),
            })
        })
        .collect();

    let req = serde_json::json!({
        "command": "benchmark_file",
        "file_path": path.to_string_lossy(),
        "hints": {
            "root_dir": settings.root_dir,
            "local_vision_endpoint": settings.local_vision_endpoint,
            "vision_models": vision_models,
        }
    });

    let resp = state
        .ocr_manager
        .send_json_request(req, 300)
        .await
        .map_err(|e| format!("Benchmark worker error: {}", e))?;

    if resp.get("status").and_then(|v| v.as_str()) == Some("error") {
        return Err(
            resp.get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Benchmark execution failed")
                .to_string(),
        );
    }
    Ok(resp)
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
    #[serde(default)]
    pub detected_install_kind: String,
    #[serde(default)]
    pub detected_install_dir: String,
    #[serde(default)]
    pub msi_url: Option<String>,
    #[serde(default)]
    pub msi_name: Option<String>,
    #[serde(default)]
    pub msi_size_bytes: Option<u64>,
    #[serde(default)]
    pub nsis_url: Option<String>,
    #[serde(default)]
    pub nsis_name: Option<String>,
    #[serde(default)]
    pub nsis_size_bytes: Option<u64>,
    pub repository: String,
}

pub fn detect_installed_package_kind() -> (&'static str, String) {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let dir_str = dir.to_string_lossy().to_string();
            let dir_low = dir_str.to_lowercase();
            let has_msi_lnk = dir.join("Uninstall PO AutoFlow Enterprise.lnk").exists();
            let has_nsis_exe = dir.join("uninstall.exe").exists();
            if has_msi_lnk && !has_nsis_exe {
                return ("msi", dir_str);
            }
            if has_nsis_exe && !has_msi_lnk {
                return ("nsis", dir_str);
            }
            if dir_low.contains("\\program files") {
                return ("msi", dir_str);
            }
            return ("nsis", dir_str);
        }
    }
    ("nsis", String::new())
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

fn extract_tag_from_release_url(url: &str) -> Option<String> {
    let marker = "/releases/tag/";
    let idx = url.find(marker)?;
    let tail = &url[idx + marker.len()..];
    let tag = tail.split(['?', '#', '/']).next().unwrap_or("").trim();
    if tag.is_empty() {
        None
    } else {
        Some(tag.to_string())
    }
}

#[tauri::command]
pub async fn check_github_update(
    repo_override: Option<String>,
    package_preference: Option<String>,
) -> Result<GitHubUpdateStatus, String> {
    let repo = normalize_github_repo(repo_override)?;
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let (detected_kind, detected_dir) = detect_installed_package_kind();
    let chosen_kind = match package_preference
        .as_deref()
        .map(str::trim)
        .unwrap_or("auto")
        .to_lowercase()
        .as_str()
    {
        "msi" => "msi",
        "nsis" | "exe" => "nsis",
        _ => detected_kind,
    };
    let ua = format!("PO-AutoFlow-Enterprise/{}", current_version);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to initialize HTTP client: {}", e))?;

    // 1. Primary: Rate-limit-free release manifest asset (github.com/releases/latest/download/latest.json)
    let manifest_url = format!(
        "https://github.com/{}/releases/latest/download/latest.json",
        repo
    );
    if let Ok(resp) = client
        .get(&manifest_url)
        .header("User-Agent", &ua)
        .send()
        .await
    {
        if resp.status().is_success() {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if let Some(tag_raw) = json["tag_name"].as_str().map(str::trim).filter(|s| !s.is_empty()) {
                    let latest_version = tag_raw.trim_start_matches(['v', 'V']).to_string();
                    let release_name = json["release_name"]
                        .as_str()
                        .or_else(|| json["name"].as_str())
                        .filter(|s| !s.trim().is_empty())
                        .unwrap_or(tag_raw)
                        .to_string();
                    let release_notes = json["release_notes"]
                        .as_str()
                        .or_else(|| json["body"].as_str())
                        .unwrap_or("")
                        .to_string();
                    let published_at = json["published_at"].as_str().unwrap_or("").to_string();

                    let nsis_name = json["installer_name"]
                        .as_str()
                        .filter(|s| !s.trim().is_empty())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| format!("PO.AutoFlow.Enterprise_{}_x64-setup.exe", latest_version));
                    let nsis_url = json["installer_url"]
                        .as_str()
                        .filter(|s| !s.trim().is_empty())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| {
                            format!(
                                "https://github.com/{}/releases/download/{}/{}",
                                repo, tag_raw, nsis_name
                            )
                        });
                    let nsis_size_bytes = json["installer_size_bytes"].as_u64();

                    let msi_name = json["msi_name"]
                        .as_str()
                        .filter(|s| !s.trim().is_empty())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| format!("PO.AutoFlow.Enterprise_{}_x64_en-US.msi", latest_version));
                    let msi_url = json["msi_url"]
                        .as_str()
                        .filter(|s| !s.trim().is_empty())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| {
                            format!(
                                "https://github.com/{}/releases/download/{}/{}",
                                repo, tag_raw, msi_name
                            )
                        });
                    let msi_size_bytes = json["msi_size_bytes"].as_u64();

                    let (active_url, active_name, active_size) = if chosen_kind == "msi" {
                        (msi_url.clone(), msi_name.clone(), msi_size_bytes)
                    } else {
                        (nsis_url.clone(), nsis_name.clone(), nsis_size_bytes)
                    };
                    let release_url = format!("https://github.com/{}/releases/tag/{}", repo, tag_raw);

                    return Ok(GitHubUpdateStatus {
                        update_available: is_newer_semver(&current_version, &latest_version),
                        current_version,
                        latest_version,
                        release_name,
                        release_notes,
                        published_at,
                        release_url,
                        installer_url: Some(active_url),
                        installer_name: Some(active_name),
                        installer_size_bytes: active_size,
                        detected_install_kind: detected_kind.to_string(),
                        detected_install_dir: detected_dir,
                        msi_url: Some(msi_url),
                        msi_name: Some(msi_name),
                        msi_size_bytes,
                        nsis_url: Some(nsis_url),
                        nsis_name: Some(nsis_name),
                        nsis_size_bytes,
                        repository: repo,
                    });
                }
            }
        }
    }

    // 2. Fallback: Rate-limit-free GitHub web redirect (https://github.com/{repo}/releases/latest -> /releases/tag/vX.Y.Z)
    let web_latest_url = format!("https://github.com/{}/releases/latest", repo);
    let web_resp = client
        .head(&web_latest_url)
        .header("User-Agent", &ua)
        .send()
        .await
        .map_err(|e| format!("Failed to reach GitHub Releases: {}", e))?;

    if web_resp.status() == reqwest::StatusCode::NOT_FOUND {
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
            detected_install_kind: detected_kind.to_string(),
            detected_install_dir: detected_dir,
            msi_url: None,
            msi_name: None,
            msi_size_bytes: None,
            nsis_url: None,
            nsis_name: None,
            nsis_size_bytes: None,
            repository: repo,
        });
    }

    let final_url = web_resp.url().as_str().to_string();
    let tag_name = match extract_tag_from_release_url(&final_url) {
        Some(t) => t,
        None => {
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
                detected_install_kind: detected_kind.to_string(),
                detected_install_dir: detected_dir,
                msi_url: None,
                msi_name: None,
                msi_size_bytes: None,
                nsis_url: None,
                nsis_name: None,
                nsis_size_bytes: None,
                repository: repo,
            });
        }
    };

    let latest_version = tag_name.trim_start_matches(['v', 'V']).to_string();
    let default_nsis_name = format!("PO.AutoFlow.Enterprise_{}_x64-setup.exe", latest_version);
    let default_nsis_url = format!(
        "https://github.com/{}/releases/download/{}/{}",
        repo, tag_name, default_nsis_name
    );
    let default_msi_name = format!("PO.AutoFlow.Enterprise_{}_x64_en-US.msi", latest_version);
    let default_msi_url = format!(
        "https://github.com/{}/releases/download/{}/{}",
        repo, tag_name, default_msi_name
    );

    let mut release_name = format!("PO AutoFlow Enterprise {}", tag_name);
    let mut release_notes = String::new();
    let mut published_at = String::new();
    let mut msi_name = Some(default_msi_name);
    let mut msi_url = Some(default_msi_url);
    let mut msi_size_bytes = None;
    let mut nsis_name = Some(default_nsis_name);
    let mut nsis_url = Some(default_nsis_url);
    let mut nsis_size_bytes = None;

    // 3. Optional best-effort API enrichment for release notes (never fails if 403 rate-limited)
    let api_tag_url = format!("https://api.github.com/repos/{}/releases/tags/{}", repo, tag_name);
    if let Ok(Ok(api_resp)) = tokio::time::timeout(
        std::time::Duration::from_secs(4),
        client
            .get(&api_tag_url)
            .header("User-Agent", &ua)
            .header("Accept", "application/vnd.github+json")
            .send(),
    )
    .await
    {
        if api_resp.status().is_success() {
            if let Ok(json) = api_resp.json::<serde_json::Value>().await {
                if let Some(n) = json["name"].as_str().filter(|s| !s.trim().is_empty()) {
                    release_name = n.to_string();
                }
                if let Some(b) = json["body"].as_str() {
                    release_notes = b.to_string();
                }
                if let Some(p) = json["published_at"].as_str() {
                    published_at = p.to_string();
                }
                if let Some(assets) = json["assets"].as_array() {
                    for asset in assets {
                        let name = asset["name"].as_str().unwrap_or("");
                        let url = asset["browser_download_url"].as_str().unwrap_or("");
                        let size = asset["size"].as_u64();
                        if name.is_empty() || url.is_empty() {
                            continue;
                        }
                        let lower = name.to_lowercase();
                        if lower.ends_with(".msi") {
                            msi_url = Some(url.to_string());
                            msi_name = Some(name.to_string());
                            msi_size_bytes = size;
                        } else if lower.ends_with(".exe") {
                            nsis_url = Some(url.to_string());
                            nsis_name = Some(name.to_string());
                            nsis_size_bytes = size;
                        }
                    }
                }
            }
        }
    }

    let (installer_url, installer_name, installer_size_bytes) = if chosen_kind == "msi" {
        (msi_url.clone(), msi_name.clone(), msi_size_bytes)
    } else {
        (nsis_url.clone(), nsis_name.clone(), nsis_size_bytes)
    };

    Ok(GitHubUpdateStatus {
        update_available: is_newer_semver(&current_version, &latest_version),
        current_version,
        latest_version,
        release_name,
        release_notes,
        published_at,
        release_url: final_url,
        installer_url,
        installer_name,
        installer_size_bytes,
        detected_install_kind: detected_kind.to_string(),
        detected_install_dir: detected_dir,
        msi_url,
        msi_name,
        msi_size_bytes,
        nsis_url,
        nsis_name,
        nsis_size_bytes,
        repository: repo,
    })
}

pub fn format_msi_installdir_raw_arg(install_dir: &str) -> Option<String> {
    let clean = install_dir
        .trim()
        .trim_matches('"')
        .trim_end_matches(['\\', '/'])
        .trim();
    if clean.is_empty() {
        None
    } else {
        Some(format!("INSTALLDIR=\"{}\"", clean))
    }
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
            use std::os::windows::process::CommandExt;
            let mut cmd = std::process::Command::new("msiexec");
            cmd.arg("/i").arg(&installer_path);
            let (_, install_dir) = detect_installed_package_kind();
            if let Some(raw_install_arg) = format_msi_installdir_raw_arg(&install_dir) {
                cmd.raw_arg(raw_install_arg);
            }
            cmd.spawn()
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

    #[test]
    fn test_extract_tag_from_release_url() {
        assert_eq!(
            extract_tag_from_release_url(
                "https://github.com/oscarpooper-lang/po-autoflow-enterprise/releases/tag/v1.2.0"
            )
            .as_deref(),
            Some("v1.2.0")
        );
        assert_eq!(
            extract_tag_from_release_url(
                "https://github.com/oscarpooper-lang/po-autoflow-enterprise/releases"
            ),
            None
        );
    }

    #[test]
    fn test_format_msi_installdir_raw_arg() {
        assert_eq!(
            format_msi_installdir_raw_arg("D:\\Program Files\\PO AutoFlow Enterprise\\"),
            Some("INSTALLDIR=\"D:\\Program Files\\PO AutoFlow Enterprise\"".to_string())
        );
        assert_eq!(format_msi_installdir_raw_arg("   "), None);
    }
}
