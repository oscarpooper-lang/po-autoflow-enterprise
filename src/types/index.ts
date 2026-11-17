export interface AppSettings {
  root_dir: string;
  incoming_dir: string;
  processing_dir: string;
  sent_dir: string;
  failed_dir: string;
  review_dir: string;
  temp_dir: string;
  logs_dir: string;
  poll_interval_ms: number;
  stability_delay_ms: number;
  stability_checks: number;
  ocr_engine_primary: string;
  ocr_confidence_threshold_verified: number;
  ocr_confidence_threshold_high: number;
  ocr_confidence_threshold_review: number;
  google_sheets_id: string;
  google_sheets_tab_name: string;
  google_sheets_ov_tab_name?: string;
  google_drive_folder_id: string;
  gas_webhook_url: string;
  gas_auth_secret: string;
  email_subject_template: string;
  email_body_template: string;
  email_cc_default?: string;
  max_zip_file_mb: number;
  auto_monitoring_active: boolean;
  dark_mode: boolean;
  setup_completed: boolean;
  developer_mode_enabled?: boolean;
  debug_logging_enabled?: boolean;
  dry_run_simulation_mode?: boolean;
  save_debug_ocr_images?: boolean;
  google_account?: GoogleAccountInfo | null;
  google_oauth_client_id?: string;
  google_oauth_client_secret?: string;
  auto_send_email_enabled?: boolean;
  auto_send_mode?: 'verified_and_high' | 'verified_only' | 'manual_review_all';
  allow_pdf_email_fallback?: boolean;
  require_drive_backup_for_auto_send?: boolean;
  email_attachment_mode?: 'individual_files' | 'zip_archive' | 'both';
  self_learning_enabled?: boolean;
  auto_sync_learned_suppliers_to_sheets?: boolean;
  local_vision_enabled?: boolean;
  local_vision_provider?: 'builtin' | 'ollama' | 'transformers';
  local_vision_endpoint?: string;
  local_vision_model?: string;
  local_vision_trigger_mode?: 'fallback' | 'always';
  ocr_quality_preset?: 'fast' | 'balanced' | 'max_accuracy';
  ui_language?: 'en' | 'th';
}

export interface GoogleAccountInfo {
  email: string;
  name?: string;
  picture?: string;
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  connected_at: string;
}

export interface SystemDiagnostics {
  app_name: string;
  app_version: string;
  os_name: string;
  os_arch: string;
  webview2_executable: string;
  database_path: string;
  database_size_bytes: number;
  database_journal_mode: string;
  ocr_worker_path: string;
  ocr_worker_status: string;
  ocr_latency_ms: number;
  auto_monitoring_active: boolean;
  active_jobs_count: number;
  in_flight_locks_count: number;
  total_jobs_recorded: number;
  total_transactions_recorded: number;
  cached_companies_count: number;
  debug_logging_enabled: boolean;
  dry_run_simulation_mode: boolean;
  timestamp: string;
}

export interface Job {
  id: string;
  po_folder_name: string;
  source_path: string;
  status:
    | 'detected'
    | 'waiting_stability'
    | 'extracting_text'
    | 'ocr_processing'
    | 'matching_company'
    | 'preparing_zip'
    | 'uploading_drive'
    | 'sending_email'
    | 'completed'
    | 'needs_review'
    | 'failed';
  stage_message: string;
  po_number?: string;
  detected_company_raw?: string;
  matched_company_name?: string;
  matched_email?: string;
  match_confidence?: number;
  match_category?: 'verified' | 'high' | 'review' | 'no_match';
  archive_path?: string;
  archive_sha256?: string;
  archive_size_bytes?: number;
  drive_file_id?: string;
  drive_web_link?: string;
  email_transaction_id?: string;
  retry_count: number;
  error_details?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

export interface PoTransaction {
  id: string;
  job_id: string;
  po_number: string;
  folder_fingerprint: string;
  archive_sha256: string;
  company_name: string;
  recipient_email: string;
  status: 'accepted' | 'sent' | 'confirmed_delivery' | 'failed' | 'blocked_duplicate';
  gas_execution_id?: string;
  error_message?: string;
  sent_at: string;
}

export interface ProcessedFile {
  id: string;
  job_id: string;
  relative_path: string;
  file_type: string;
  file_size_bytes: number;
  file_hash: string;
  page_count: number;
  extraction_method: string;
  created_at: string;
}

export interface OcrResultRecord {
  id: string;
  job_id: string;
  file_path: string;
  page_number: number;
  raw_text: string;
  normalized_text: string;
  confidence: number;
  engine: string;
  bounding_boxes_json: string;
  detected_entities_json: string;
  created_at: string;
}

export interface CompanyCacheEntry {
  id: string;
  company_name: string;
  alternative_name?: string;
  email: string;
  active: boolean;
  tax_id?: string;
  notes?: string;
  vendor_group?: string;
  synced_at: string;
}

export interface CompanyAlias {
  id: string;
  alias: string;
  canonical_company_name: string;
  created_by: string;
  created_at: string;
}

export interface DashboardStats {
  total_processed: number;
  successfully_sent: number;
  waiting_processing: number;
  needs_review: number;
  failed_transactions: number;
  success_rate_percent: number;
  avg_ocr_confidence: number;
}

export interface ApplicationEvent {
  id: number;
  job_id?: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
  timestamp: string;
}

export interface AuditLog {
  id: string;
  action: string;
  category: string;
  actor: string;
  details: string;
  timestamp: string;
}

export interface PagePreviewResponse {
  status: string;
  data_url?: string;
  page_width?: number;
  page_height?: number;
  render_width?: number;
  render_height?: number;
  message?: string;
}

export interface DeveloperConsoleSnapshot {
  app_pid: number;
  ocr_worker_pid?: number | null;
  ocr_worker_script: string;
  watcher_active: boolean;
  watcher_dir: string;
  watcher_queued_count: number;
  in_flight_count: number;
  jobs_summary: Record<string, number>;
  terminal_lines: string[];
  recent_events: ApplicationEvent[];
  audit_logs: AuditLog[];
  timestamp: string;
}

export interface LearningStats {
  total_aliases: number;
  learned_tax_ids: number;
  learned_email_domains: number;
  learned_name_variants: number;
  negative_phrases_count: number;
  learned_zones_count: number;
  total_approvals_learned: number;
}

export interface LocalVisionStatus {
  reachable: boolean;
  endpoint: string;
  configured_model: string;
  available_models: string[];
  message: string;
}

export interface BuiltInVisionModelEntry {
  id: string;
  name: string;
  size_label: string;
  total_size_bytes: number;
  description: string;
  installed: boolean;
  active: boolean;
  model_path: string;
  mmproj_path: string;
}

export interface BuiltInDownloadProgress {
  active: boolean;
  model_id: string;
  stage: string;
  downloaded_bytes: number;
  total_bytes: number;
  percent: number;
  message: string;
  error?: string | null;
}

export interface BuiltInVisionStatus {
  engine_installed: boolean;
  engine_path: string;
  models_dir: string;
  active_model_id: string;
  models: BuiltInVisionModelEntry[];
  download: BuiltInDownloadProgress;
}

