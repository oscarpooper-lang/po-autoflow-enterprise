use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub root_dir: String,
    pub incoming_dir: String,
    pub processing_dir: String,
    pub sent_dir: String,
    pub failed_dir: String,
    pub review_dir: String,
    pub temp_dir: String,
    pub logs_dir: String,
    pub poll_interval_ms: u64,
    pub stability_delay_ms: u64,
    pub stability_checks: u32,
    pub ocr_engine_primary: String,
    pub ocr_confidence_threshold_verified: f64,
    pub ocr_confidence_threshold_high: f64,
    pub ocr_confidence_threshold_review: f64,
    pub google_sheets_id: String,
    pub google_sheets_tab_name: String,
    #[serde(default)]
    pub google_sheets_ov_tab_name: String,
    pub google_drive_folder_id: String,
    pub gas_webhook_url: String,
    pub gas_auth_secret: String,
    pub email_subject_template: String,
    pub email_body_template: String,
    #[serde(default)]
    pub email_cc_default: String,
    pub max_zip_file_mb: u64,
    pub auto_monitoring_active: bool,
    pub dark_mode: bool,
    pub setup_completed: bool,

    // Developer / Debugging Options
    #[serde(default)]
    pub developer_mode_enabled: bool,
    #[serde(default)]
    pub debug_logging_enabled: bool,
    #[serde(default)]
    pub dry_run_simulation_mode: bool,
    #[serde(default)]
    pub save_debug_ocr_images: bool,

    // Google Cloud & OAuth Authentication
    #[serde(default)]
    pub google_account: Option<GoogleAccountInfo>,
    #[serde(default)]
    pub google_oauth_client_id: String,
    #[serde(default)]
    pub google_oauth_client_secret: String,

    // Auto-Send Email Options
    #[serde(default = "default_true")]
    pub auto_send_email_enabled: bool,
    #[serde(default = "default_auto_send_mode")]
    pub auto_send_mode: String, // "verified_and_high" | "verified_only" | "manual_review_all"
    #[serde(default)]
    pub allow_pdf_email_fallback: bool,
    #[serde(default)]
    pub require_drive_backup_for_auto_send: bool,
    #[serde(default = "default_attachment_mode")]
    pub email_attachment_mode: String, // "individual_files" | "zip_archive" | "both"

    // Self-Learning Memory & 100% Offline Local Vision AI
    #[serde(default = "default_true")]
    pub self_learning_enabled: bool,
    #[serde(default = "default_true")]
    pub auto_sync_learned_suppliers_to_sheets: bool,
    #[serde(default)]
    pub local_vision_enabled: bool,
    #[serde(default = "default_local_vision_provider")]
    pub local_vision_provider: String, // "ollama" | "transformers"
    #[serde(default = "default_local_vision_endpoint")]
    pub local_vision_endpoint: String,
    #[serde(default = "default_local_vision_model")]
    pub local_vision_model: String,
    #[serde(default = "default_local_vision_trigger_mode")]
    pub local_vision_trigger_mode: String, // "fallback" | "always"
    #[serde(default = "default_ocr_quality_preset")]
    pub ocr_quality_preset: String, // "fast" | "balanced" | "max_accuracy"
    #[serde(default = "default_ui_language")]
    pub ui_language: String, // "en" | "th"
}

fn default_ui_language() -> String {
    "en".to_string()
}

fn default_true() -> bool {
    true
}

fn default_auto_send_mode() -> String {
    "verified_and_high".to_string()
}

fn default_attachment_mode() -> String {
    "individual_files".to_string()
}

fn default_local_vision_provider() -> String {
    "builtin".to_string()
}

fn default_local_vision_endpoint() -> String {
    "http://127.0.0.1:11434".to_string()
}

fn default_local_vision_model() -> String {
    "qwen2.5-vl-3b".to_string()
}

fn default_local_vision_trigger_mode() -> String {
    "fallback".to_string()
}

fn default_ocr_quality_preset() -> String {
    "balanced".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleAccountInfo {
    pub email: String,
    pub name: String,
    pub picture: Option<String>,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: i64,
    pub connected_at: String,
}

pub fn default_workspace_root() -> String {
    #[cfg(target_os = "windows")]
    {
        let c_root = std::path::Path::new("C:\\PO-AutoFlow");
        if c_root.exists() {
            return "C:\\PO-AutoFlow".to_string();
        }
        // Prefer the drive where the executable is installed (e.g. D:\Program Files -> D:\PO-AutoFlow)
        if let Ok(exe) = std::env::current_exe() {
            let exe_str = exe.to_string_lossy();
            if exe_str.len() >= 2 && exe_str.as_bytes()[1] == b':' {
                let drive = (exe_str.as_bytes()[0] as char).to_ascii_uppercase();
                if drive != 'C' {
                    let candidate = format!("{}:\\PO-AutoFlow", drive);
                    if std::path::Path::new(&format!("{}:\\", drive)).exists() {
                        return candidate;
                    }
                }
            }
        }
    }
    "C:\\PO-AutoFlow".to_string()
}

impl Default for AppSettings {
    fn default() -> Self {
        let base = default_workspace_root();
        Self {
            incoming_dir: format!("{}\\Incoming", base),
            processing_dir: format!("{}\\Processing", base),
            sent_dir: format!("{}\\Sent", base),
            failed_dir: format!("{}\\Failed", base),
            review_dir: format!("{}\\Review", base),
            temp_dir: format!("{}\\Temp", base),
            logs_dir: format!("{}\\Logs", base),
            root_dir: base,
            poll_interval_ms: 2000,
            stability_delay_ms: 1500,
            stability_checks: 3,
            ocr_engine_primary: "openthaigpt".to_string(),
            ocr_confidence_threshold_verified: 98.0,
            ocr_confidence_threshold_high: 90.0,
            ocr_confidence_threshold_review: 75.0,
            google_sheets_id: "".to_string(),
            google_sheets_tab_name: "Suppliers".to_string(),
            google_sheets_ov_tab_name: "".to_string(),
            google_drive_folder_id: "".to_string(),
            gas_webhook_url: "".to_string(),
            gas_auth_secret: "po-autoflow-enterprise-secret-key".to_string(),
            email_subject_template: "Purchase Order - {{PO_NUMBER}} - {{COMPANY_NAME}}".to_string(),
            email_body_template: "Dear {{COMPANY_NAME}},\n\nPlease find attached the Purchase Order documents for your reference.\n\nPO Number: {{PO_NUMBER}}\n\nPlease acknowledge receipt.\n\nBest regards,\nPO Automation System".to_string(),
            email_cc_default: "".to_string(),
            max_zip_file_mb: 25,
            auto_monitoring_active: false,
            dark_mode: true,
            setup_completed: false,
            developer_mode_enabled: false,
            debug_logging_enabled: true,
            dry_run_simulation_mode: false,
            save_debug_ocr_images: false,
            google_account: None,
            google_oauth_client_id: "".to_string(),
            google_oauth_client_secret: "".to_string(),
            auto_send_email_enabled: true,
            auto_send_mode: "verified_and_high".to_string(),
            allow_pdf_email_fallback: false,
            require_drive_backup_for_auto_send: false,
            email_attachment_mode: "individual_files".to_string(),
            self_learning_enabled: true,
            auto_sync_learned_suppliers_to_sheets: true,
            local_vision_enabled: false,
            local_vision_provider: "builtin".to_string(),
            local_vision_endpoint: "http://127.0.0.1:11434".to_string(),
            local_vision_model: "qwen2.5-vl-3b".to_string(),
            local_vision_trigger_mode: "fallback".to_string(),
            ocr_quality_preset: "balanced".to_string(),
            ui_language: "en".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemDiagnostics {
    pub app_name: String,
    pub app_version: String,
    pub os_name: String,
    pub os_arch: String,
    pub webview2_executable: String,
    pub database_path: String,
    pub database_size_bytes: u64,
    pub database_journal_mode: String,
    pub ocr_worker_path: String,
    pub ocr_worker_status: String,
    pub ocr_latency_ms: u64,
    pub auto_monitoring_active: bool,
    pub active_jobs_count: usize,
    pub in_flight_locks_count: usize,
    pub total_jobs_recorded: i64,
    pub total_transactions_recorded: i64,
    pub cached_companies_count: usize,
    pub debug_logging_enabled: bool,
    pub dry_run_simulation_mode: bool,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Job {
    pub id: String,
    pub po_folder_name: String,
    pub source_path: String,
    pub status: String,
    pub stage_message: String,
    pub po_number: Option<String>,
    pub detected_company_raw: Option<String>,
    pub matched_company_name: Option<String>,
    pub matched_email: Option<String>,
    pub match_confidence: Option<f64>,
    pub match_category: Option<String>,
    pub archive_path: Option<String>,
    pub archive_sha256: Option<String>,
    pub archive_size_bytes: Option<i64>,
    pub drive_file_id: Option<String>,
    pub drive_web_link: Option<String>,
    pub email_transaction_id: Option<String>,
    pub retry_count: i32,
    pub error_details: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoTransaction {
    pub id: String,
    pub job_id: String,
    pub po_number: String,
    pub folder_fingerprint: String,
    pub archive_sha256: String,
    pub company_name: String,
    pub recipient_email: String,
    pub status: String, // accepted, sent, confirmed_delivery, failed, blocked_duplicate
    pub gas_execution_id: Option<String>,
    pub error_message: Option<String>,
    pub sent_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessedFile {
    pub id: String,
    pub job_id: String,
    pub relative_path: String,
    pub file_type: String,
    pub file_size_bytes: i64,
    pub file_hash: String,
    pub page_count: i32,
    pub extraction_method: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrResultRecord {
    pub id: String,
    pub job_id: String,
    pub file_path: String,
    pub page_number: i32,
    pub raw_text: String,
    pub normalized_text: String,
    pub confidence: f64,
    pub engine: String,
    pub bounding_boxes_json: String,
    pub detected_entities_json: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompanyCacheEntry {
    pub id: String,
    pub company_name: String,
    pub alternative_name: Option<String>,
    pub email: String,
    pub active: bool,
    pub tax_id: Option<String>,
    pub notes: Option<String>,
    #[serde(default)]
    pub vendor_group: Option<String>, // "DV" (Domestic), "OV" (Overseas), or source sheet tab
    pub synced_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompanyAlias {
    pub id: String,
    pub alias: String,
    pub canonical_company_name: String,
    pub created_by: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditLog {
    pub id: String,
    pub action: String,
    pub category: String,
    pub actor: String,
    pub details: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplicationEvent {
    pub id: i64,
    pub job_id: Option<String>,
    pub level: String,
    pub message: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DashboardStats {
    pub total_processed: i64,
    pub successfully_sent: i64,
    pub waiting_processing: i64,
    pub needs_review: i64,
    pub failed_transactions: i64,
    pub success_rate_percent: f64,
    pub avg_ocr_confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearningMemoryEntry {
    pub id: String,
    pub signal_type: String,
    pub signal_value: String,
    pub canonical_company_name: String,
    pub recipient_email: Option<String>,
    pub hit_count: i64,
    pub confidence_boost: f64,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearningStats {
    pub total_aliases: usize,
    pub learned_tax_ids: usize,
    pub learned_email_domains: usize,
    pub learned_name_variants: usize,
    pub negative_phrases_count: usize,
    pub learned_zones_count: usize,
    pub total_approvals_learned: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalVisionStatus {
    pub reachable: bool,
    pub endpoint: String,
    pub configured_model: String,
    pub available_models: Vec<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuiltInVisionModelEntry {
    pub id: String,
    pub name: String,
    pub size_label: String,
    pub total_size_bytes: u64,
    pub description: String,
    pub installed: bool,
    pub active: bool,
    pub model_path: String,
    pub mmproj_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BuiltInDownloadProgress {
    pub active: bool,
    pub model_id: String,
    pub stage: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub percent: f64,
    pub message: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuiltInVisionStatus {
    pub engine_installed: bool,
    pub engine_path: String,
    pub models_dir: String,
    pub active_model_id: String,
    pub models: Vec<BuiltInVisionModelEntry>,
    pub download: BuiltInDownloadProgress,
}

