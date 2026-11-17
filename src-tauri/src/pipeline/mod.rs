use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::{error, info, warn};

use crate::archive::ArchiveManager;
use crate::database::models::*;
use crate::database::Database;
use crate::document::DocumentScanner;
use crate::email::EmailDeliveryClient;
use crate::google::drive::DriveClient;
use crate::matching::thai_normalizer::ThaiNormalizer;
use crate::matching::CompanyMatcher;
use crate::ocr::OcrManager;
use crate::security::SecurityManager;
use crate::watcher::stability::FileStabilityChecker;

#[derive(Clone)]
pub struct PipelineCoordinator {
    db: Database,
    ocr_manager: OcrManager,
    pub sheets_client: Arc<crate::google::sheets::SheetsClient>,
    pub drive_client: Arc<DriveClient>,
    pub email_client: Arc<EmailDeliveryClient>,
    in_flight: Arc<parking_lot::Mutex<std::collections::HashSet<PathBuf>>>,
    watcher_active_jobs: Arc<parking_lot::Mutex<Option<Arc<parking_lot::Mutex<std::collections::HashSet<PathBuf>>>>>>,
}

impl PipelineCoordinator {
    pub fn new(
        db: Database,
        ocr_manager: OcrManager,
    ) -> Self {
        Self {
            db,
            ocr_manager,
            sheets_client: Arc::new(crate::google::sheets::SheetsClient::new()),
            drive_client: Arc::new(DriveClient::new()),
            email_client: Arc::new(EmailDeliveryClient::new()),
            in_flight: Arc::new(parking_lot::Mutex::new(std::collections::HashSet::new())),
            watcher_active_jobs: Arc::new(parking_lot::Mutex::new(None)),
        }
    }

    pub fn set_watcher_active_jobs(&self, jobs: Arc<parking_lot::Mutex<std::collections::HashSet<PathBuf>>>) {
        *self.watcher_active_jobs.lock() = Some(jobs);
    }

    pub fn release_folder(&self, folder: &Path) {
        self.in_flight.lock().remove(folder);
        if let Some(ref watcher_jobs) = *self.watcher_active_jobs.lock() {
            watcher_jobs.lock().remove(folder);
        }
    }

    pub fn in_flight_count(&self) -> usize {
        self.in_flight.lock().len()
    }

    /// Spawns the main background pipeline loop listening to the channel of detected PO folders.
    pub fn start_runner(self: Arc<Self>, mut rx: mpsc::Receiver<PathBuf>) {
        tokio::spawn(async move {
            info!("PO AutoFlow Enterprise background pipeline runner active");
            while let Some(po_dir) = rx.recv().await {
                let coordinator = Arc::clone(&self);
                tokio::spawn(async move {
                    if let Err(e) = coordinator.process_po_folder(&po_dir).await {
                        error!("Pipeline error processing {:?}: {}", po_dir, e);
                    }
                });
            }
        });
    }

    /// Complete 8-stage end-to-end processing pipeline for an incoming PO directory.
    pub async fn process_po_folder(&self, incoming_po_dir: &Path) -> Result<(), String> {
        self.process_po_folder_with_options(incoming_po_dir, false).await
    }

    pub async fn process_po_folder_with_options(
        &self,
        incoming_po_dir: &Path,
        force_vision: bool,
    ) -> Result<(), String> {
        // Enforce single-flight execution per PO folder
        {
            let mut locks = self.in_flight.lock();
            if locks.contains(incoming_po_dir) {
                warn!("PO folder {:?} is already actively processing. Skipping duplicate trigger.", incoming_po_dir);
                return Ok(());
            }
            locks.insert(incoming_po_dir.to_path_buf());
        }

        self.ocr_manager.push_log(format!(
            "[pipeline] Queue started for {:?} (force_vision={})",
            incoming_po_dir, force_vision
        ));

        let result = self
            .process_po_folder_internal(incoming_po_dir, force_vision)
            .await;
        if let Err(ref err_msg) = result {
            self.ocr_manager.push_log(format!(
                "[pipeline ERROR] {:?}: {}",
                incoming_po_dir, err_msg
            ));
            let folder_name = incoming_po_dir
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("UNKNOWN_PO");
            if let Ok(Some(mut job)) = self.db.find_reusable_job_by_folder(folder_name) {
                if !matches!(job.status.as_str(), "completed" | "failed" | "needs_review") {
                    job.status = "failed".to_string();
                    job.stage_message = format!("Pipeline stopped: {}", err_msg);
                    job.error_details = Some(err_msg.clone());
                    job.updated_at = chrono::Utc::now().to_rfc3339();
                    if let Ok(settings) = self.db.get_settings() {
                        if let Some(current_dir) = self.locate_job_folder(&job, &settings) {
                            if let Ok(review_path) = move_folder_to_dir(&current_dir, &settings.review_dir) {
                                job.source_path = review_path.to_string_lossy().to_string();
                            }
                        }
                    }
                    self.db.update_job(&job).ok();
                    self.db
                        .add_event(Some(&job.id), "error", &format!("Pipeline failed: {}", err_msg))
                        .ok();
                }
            }
        }

        self.release_folder(incoming_po_dir);
        result
    }

    /// Syncs the supplier directory from Google Sheets (preferring Apps Script Cloud Hub,
    /// falling back to OAuth / direct CSV) and updates the local SQLite cache.
    pub async fn sync_directory_from_google(&self) -> Result<Vec<CompanyCacheEntry>, String> {
        let mut settings = self.db.get_settings().map_err(|e| e.to_string())?;

        let entries = if !settings.gas_webhook_url.trim().is_empty() {
            match self
                .sheets_client
                .fetch_companies_via_gas(
                    &settings.gas_webhook_url,
                    &settings.gas_auth_secret,
                    &settings.google_sheets_id,
                    &settings.google_sheets_tab_name,
                )
                .await
            {
                Ok(entries) => entries,
                Err(e) => {
                    warn!("GAS sheet sync failed: {}, trying OAuth/direct fallback", e);
                    let mut token_opt = None;
                    if let Some(ref mut acct) = settings.google_account {
                        if let Ok(tok) = crate::google::auth::GoogleAuthManager::get_valid_access_token(
                            acct,
                            &settings.google_oauth_client_id,
                            &settings.google_oauth_client_secret,
                        )
                        .await
                        {
                            token_opt = Some(tok);
                            self.db.save_settings(&settings).ok();
                        }
                    }
                    self.sheets_client
                        .fetch_companies(&settings.google_sheets_id, &settings.google_sheets_tab_name, token_opt.as_deref())
                        .await
                        .map_err(|err| err.to_string())?
                }
            }
        } else {
            let mut token_opt = None;
            if let Some(ref mut acct) = settings.google_account {
                if let Ok(tok) = crate::google::auth::GoogleAuthManager::get_valid_access_token(
                    acct,
                    &settings.google_oauth_client_id,
                    &settings.google_oauth_client_secret,
                )
                .await
                {
                    token_opt = Some(tok);
                    self.db.save_settings(&settings).ok();
                }
            }
            self.sheets_client
                .fetch_companies(&settings.google_sheets_id, &settings.google_sheets_tab_name, token_opt.as_deref())
                .await
                .map_err(|e| e.to_string())?
        };

        self.db.sync_companies_cache(&entries).map_err(|e| e.to_string())?;
        Ok(entries)
    }

    /// Resolves where a job's PO folder currently resides on disk across all workflow directories.
    /// Prefers non-empty folders so leftover empty directories never shadow active files.
    pub fn locate_job_folder(&self, job: &Job, settings: &AppSettings) -> Option<PathBuf> {
        let dir_has_entries = |p: &Path| -> bool {
            std::fs::read_dir(p)
                .map(|mut rd| rd.next().is_some())
                .unwrap_or(false)
        };

        let mut empty_fallback: Option<PathBuf> = None;
        let direct = PathBuf::from(&job.source_path);
        if direct.exists() && direct.is_dir() {
            flatten_nested_same_name_dir(&direct);
            if dir_has_entries(&direct) {
                return Some(direct);
            }
            empty_fallback = Some(direct);
        }
        for dir in [
            &settings.incoming_dir,
            &settings.processing_dir,
            &settings.review_dir,
            &settings.failed_dir,
            &settings.sent_dir,
        ] {
            let cand = PathBuf::from(dir).join(&job.po_folder_name);
            if cand.exists() && cand.is_dir() {
                flatten_nested_same_name_dir(&cand);
                if dir_has_entries(&cand) {
                    return Some(cand);
                }
                if empty_fallback.is_none() {
                    empty_fallback = Some(cand);
                }
            }
        }
        empty_fallback
    }

    async fn process_po_folder_internal(
        &self,
        incoming_po_dir: &Path,
        force_vision: bool,
    ) -> Result<(), String> {
        if !incoming_po_dir.exists() || !incoming_po_dir.is_dir() {
            return Ok(());
        }

        let folder_name = incoming_po_dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("UNKNOWN_PO")
            .to_string();

        let now = chrono::Utc::now().to_rfc3339();
        let settings = self.db.get_settings().map_err(|e| e.to_string())?;

        // Reuse existing non-completed job for the same PO folder to avoid duplicate rows on retry
        let (job_id, mut job) = match self.db.find_reusable_job_by_folder(&folder_name).ok().flatten() {
            Some(mut existing) => {
                let id = existing.id.clone();
                self.db.clear_job_ocr_and_files(&id).ok();
                existing.source_path = incoming_po_dir.to_string_lossy().to_string();
                existing.status = "detected".to_string();
                existing.stage_message = "Re-processing PO folder...".to_string();
                existing.retry_count += 1;
                existing.error_details = None;
                existing.updated_at = now.clone();
                self.db.update_job(&existing).map_err(|e| e.to_string())?;
                (id, existing)
            }
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                let new_job = Job {
                    id: id.clone(),
                    po_folder_name: folder_name.clone(),
                    source_path: incoming_po_dir.to_string_lossy().to_string(),
                    status: "detected".to_string(),
                    stage_message: "Folder detected. Preparing copy stability check.".to_string(),
                    po_number: None,
                    detected_company_raw: None,
                    matched_company_name: None,
                    matched_email: None,
                    match_confidence: None,
                    match_category: None,
                    archive_path: None,
                    archive_sha256: None,
                    archive_size_bytes: None,
                    drive_file_id: None,
                    drive_web_link: None,
                    email_transaction_id: None,
                    retry_count: 0,
                    error_details: None,
                    created_at: now.clone(),
                    updated_at: now.clone(),
                    completed_at: None,
                };
                self.db.insert_job(&new_job).map_err(|e| e.to_string())?;
                (id, new_job)
            }
        };

        self.db.add_event(Some(&job_id), "info", &format!("Detected PO folder: {}", folder_name)).ok();

        // 2. Stage: Waiting for File Stability (only needed when arriving from Incoming)
        let is_from_incoming = incoming_po_dir.starts_with(Path::new(&settings.incoming_dir));
        if is_from_incoming {
            job.status = "waiting_stability".to_string();
            job.stage_message = "Waiting for file copy completion and file lock release.".to_string();
            job.updated_at = chrono::Utc::now().to_rfc3339();
            self.db.update_job(&job).ok();

            let stability_checker = FileStabilityChecker::new(
                settings.stability_delay_ms,
                settings.stability_checks,
                120,
            );

            if let Err(e) = stability_checker.wait_for_stability(incoming_po_dir).await {
                job.status = "failed".to_string();
                job.stage_message = format!("Stability check failed: {}", e);
                job.error_details = Some(e.clone());
                self.db.update_job(&job).ok();
                self.db.add_event(Some(&job_id), "error", &format!("Stability check failed: {}", e)).ok();
                return Err(e);
            }
        }

        // Move to Processing directory and flatten redundant single nested subfolder if present
        let processing_po_dir = move_folder_to_dir(incoming_po_dir, &settings.processing_dir)
            .map_err(|e| format!("Failed to move incoming folder to processing: {}", e))?;
        flatten_nested_same_name_dir(&processing_po_dir);

        job.source_path = processing_po_dir.to_string_lossy().to_string();

        // 3. Stage: Document Extraction & OCR
        job.status = "extracting_text".to_string();
        job.stage_message = "Scanning documents and extracting text layers.".to_string();
        job.updated_at = chrono::Utc::now().to_rfc3339();
        self.db.update_job(&job).ok();

        let documents = DocumentScanner::scan_po_folder(&processing_po_dir).map_err(|e| e.to_string())?;
        if documents.is_empty() {
            let msg = "No supported document files found inside folder".to_string();
            job.status = "needs_review".to_string();
            job.stage_message = msg.clone();
            if let Ok(review_path) = move_folder_to_dir(&processing_po_dir, &settings.review_dir) {
                job.source_path = review_path.to_string_lossy().to_string();
            }
            self.db.update_job(&job).ok();
            return Err(msg);
        }

        // Record processed files
        for doc in &documents {
            let file_rec = ProcessedFile {
                id: uuid::Uuid::new_v4().to_string(),
                job_id: job_id.clone(),
                relative_path: doc.relative_path.clone(),
                file_type: doc.file_type.clone(),
                file_size_bytes: doc.size_bytes as i64,
                file_hash: doc.sha256_hash.clone(),
                page_count: 1,
                extraction_method: "scanned".to_string(),
                created_at: chrono::Utc::now().to_rfc3339(),
            };
            self.db.record_processed_file(&file_rec).ok();
        }

        job.status = "ocr_processing".to_string();
        job.stage_message = "Running PP-OCRv5 Thai & English neural OCR worker.".to_string();
        self.db.update_job(&job).ok();

        let memories = if settings.self_learning_enabled {
            self.db.get_learning_memories().unwrap_or_default()
        } else {
            Vec::new()
        };

        let neg_phrases: Vec<String> = memories
            .iter()
            .filter(|m| m.signal_type == "negative_phrase")
            .map(|m| m.signal_value.clone())
            .collect();

        let (zone_sum, zone_weight) = memories
            .iter()
            .filter(|m| m.signal_type == "layout_zone")
            .filter_map(|m| m.signal_value.parse::<f64>().ok().map(|v| (v, m.hit_count.max(1) as f64)))
            .fold((0.0_f64, 0.0_f64), |(acc_v, acc_w), (v, w)| (acc_v + v * w, acc_w + w));
        let preferred_y_band = if zone_weight > 0.0 {
            Some((zone_sum / zone_weight).clamp(0.0, 1.0))
        } else {
            None
        };

        let (builtin_engine_path, builtin_model_path, builtin_mmproj_path) =
            crate::commands::resolve_builtin_vision_paths(
                &settings.root_dir,
                &settings.local_vision_model,
            );

        let ocr_hints = crate::ocr::OcrHints {
            root_dir: settings.root_dir.clone(),
            negative_phrases: neg_phrases,
            preferred_y_band,
            local_vision_enabled: settings.local_vision_enabled,
            local_vision_provider: settings.local_vision_provider.clone(),
            local_vision_endpoint: settings.local_vision_endpoint.clone(),
            local_vision_model: settings.local_vision_model.clone(),
            builtin_engine_path: builtin_engine_path.to_string_lossy().to_string(),
            builtin_model_path: builtin_model_path.to_string_lossy().to_string(),
            builtin_mmproj_path: builtin_mmproj_path.to_string_lossy().to_string(),
            force_vision: force_vision
                || (settings.local_vision_enabled && settings.local_vision_trigger_mode == "always"),
        };

        let mut all_supplier_candidates = Vec::new();
        let mut all_po_numbers = Vec::new();
        let mut all_extracted_emails: Vec<String> = Vec::new();
        let mut all_tax_ids: Vec<String> = Vec::new();

        for doc in &documents {
            match self.ocr_manager.process_file_with_hints(&doc.absolute_path, Some(&ocr_hints)).await {
                Ok(resp) => {
                    if let Some(pages) = resp.pages {
                        for page in pages {
                            let ocr_rec = OcrResultRecord {
                                id: uuid::Uuid::new_v4().to_string(),
                                job_id: job_id.clone(),
                                file_path: doc.relative_path.clone(),
                                page_number: page.page_number,
                                raw_text: page.raw_text.clone(),
                                normalized_text: page.raw_text.clone(),
                                confidence: page.confidence * 100.0,
                                engine: page.extraction_method.clone(),
                                bounding_boxes_json: serde_json::to_string(&page.boxes).unwrap_or_default(),
                                detected_entities_json: serde_json::to_string(&page.parsed).unwrap_or_default(),
                                created_at: chrono::Utc::now().to_rfc3339(),
                            };
                            self.db.record_ocr_result(&ocr_rec).ok();

                            for c in page.parsed.supplier_candidates {
                                if !ThaiNormalizer::is_ignored_self_company(&c.name) {
                                    all_supplier_candidates.push(c);
                                }
                            }
                            for po in page.parsed.po_numbers {
                                if po.chars().filter(|c| c.is_ascii_digit()).count() >= 4 && !all_po_numbers.contains(&po) {
                                    all_po_numbers.push(po);
                                }
                            }
                            for tid in page.parsed.tax_ids {
                                let digits: String = tid.chars().filter(|c| c.is_ascii_digit()).collect();
                                if digits.len() == 13
                                    && !ThaiNormalizer::is_ignored_self_company(&digits)
                                    && !all_tax_ids.contains(&digits)
                                {
                                    all_tax_ids.push(digits);
                                }
                            }
                            for em in page.parsed.emails {
                                let em_clean = em.trim().to_string();
                                if EmailDeliveryClient::is_valid_email(&em_clean)
                                    && !ThaiNormalizer::is_ignored_self_company(&em_clean)
                                    && !all_extracted_emails.iter().any(|x| x.eq_ignore_ascii_case(&em_clean))
                                {
                                    all_extracted_emails.push(em_clean);
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    warn!("OCR error on file {:?}: {}", doc.relative_path, e);
                }
            }
        }

        // Resolve PO number: prefer valid PO-prefixed folder name, then extracted PO number
        let folder_is_valid_po = folder_name.to_uppercase().starts_with("PO")
            && folder_name.chars().filter(|c| c.is_ascii_digit()).count() >= 4;
        let resolved_po = if folder_is_valid_po {
            folder_name.to_uppercase()
        } else if let Some(first_po) = all_po_numbers.first() {
            first_po.clone()
        } else {
            folder_name.clone()
        };
        job.po_number = Some(resolved_po.clone());

        // 4. Stage: Intelligent Company Matching (Thai First -> English Fallback)
        job.status = "matching_company".to_string();
        job.stage_message = "Matching extracted supplier entity (Thai-first) against company directory.".to_string();
        self.db.update_job(&job).ok();

        all_supplier_candidates.sort_by(|a, b| {
            let rank_a = if a.language == "th" { 0 } else { 1 };
            let rank_b = if b.language == "th" { 0 } else { 1 };
            rank_a
                .cmp(&rank_b)
                .then_with(|| b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal))
        });

        let mut directory = self.db.get_companies_cache().unwrap_or_default();
        if directory.is_empty() {
            info!("Local company directory cache is empty; auto-syncing from Google Sheets...");
            match self.sync_directory_from_google().await {
                Ok(fresh) => directory = fresh,
                Err(e) => warn!("Auto-sync from Google Sheets skipped: {}", e),
            }
        }
        let aliases = self.db.get_company_aliases().unwrap_or_default();

        let match_result = CompanyMatcher::match_candidates_with_memory(
            &all_supplier_candidates,
            &all_tax_ids,
            &all_extracted_emails,
            &directory,
            &aliases,
            &memories,
            settings.ocr_confidence_threshold_verified,
            settings.ocr_confidence_threshold_high,
            settings.ocr_confidence_threshold_review,
        );

        let query_name = if !match_result.query.is_empty() {
            match_result.query.clone()
        } else if !all_supplier_candidates.is_empty() {
            ThaiNormalizer::normalize_unicode(&all_supplier_candidates[0].name)
        } else {
            folder_name.clone()
        };
        job.detected_company_raw = Some(query_name.clone());

        job.match_confidence = Some(match_result.confidence);
        job.match_category = Some(match_result.category.clone());

        let target_company = match_result.matched_company;
        if let Some(ref comp) = target_company {
            job.matched_company_name = Some(comp.company_name.clone());
            job.matched_email = Some(comp.email.clone());
        } else if settings.allow_pdf_email_fallback && !all_extracted_emails.is_empty() {
            job.matched_email = Some(all_extracted_emails[0].clone());
        }

        let auto_send_active = settings.auto_send_email_enabled
            && settings.auto_send_mode != "manual_review_all";

        let meets_confidence_policy = match settings.auto_send_mode.as_str() {
            "verified_only" => match_result.category == "verified" && !match_result.is_ambiguous,
            "manual_review_all" => false,
            _ => (match_result.category == "verified" || match_result.category == "high")
                && !match_result.is_ambiguous,
        };

        let (approved_company_name, recipient_email, auto_send_hold_reason) =
            if let Some(ref comp) = target_company {
                if auto_send_active && meets_confidence_policy {
                    (comp.company_name.clone(), comp.email.trim().to_string(), None)
                } else if !auto_send_active {
                    (
                        comp.company_name.clone(),
                        comp.email.trim().to_string(),
                        Some(format!(
                            "Auto-Send Email is OFF (Manual Approval Mode). Matched: {} ({:.1}%). Click Review & Approve to send.",
                            comp.company_name, match_result.confidence
                        )),
                    )
                } else {
                    (
                        comp.company_name.clone(),
                        comp.email.trim().to_string(),
                        Some(format!(
                            "Held by Auto-Send '{}' rule (Score: {:.1}%, Category: {}). Moved to Review.",
                            settings.auto_send_mode, match_result.confidence, match_result.category
                        )),
                    )
                }
            } else if settings.allow_pdf_email_fallback
                && !all_extracted_emails.is_empty()
                && !query_name.is_empty()
                && !ThaiNormalizer::is_ignored_self_company(&query_name)
            {
                if auto_send_active {
                    (query_name.clone(), all_extracted_emails[0].clone(), None)
                } else {
                    (
                        query_name.clone(),
                        all_extracted_emails[0].clone(),
                        Some(format!(
                            "Auto-Send Email is OFF (Manual Approval Mode). Extracted vendor: {} <{}>. Click Review & Approve to send.",
                            query_name, all_extracted_emails[0]
                        )),
                    )
                }
            } else {
                (
                    String::new(),
                    String::new(),
                    Some(if !auto_send_active {
                        format!(
                            "Auto-Send Email is OFF (Manual Approval Mode). Detected: '{}' ({:.1}%). Click Review & Approve to send.",
                            query_name, match_result.confidence
                        )
                    } else {
                        format!(
                            "Company match requires verification (Score: {:.1}%, Category: {}). Moved to Review.",
                            match_result.confidence, match_result.category
                        )
                    }),
                )
            };

        if let Some(hold_msg) = auto_send_hold_reason {
            job.status = "needs_review".to_string();
            job.stage_message = hold_msg;
            if let Ok(review_path) = move_folder_to_dir(&processing_po_dir, &settings.review_dir) {
                job.source_path = review_path.to_string_lossy().to_string();
            }
            self.db.update_job(&job).ok();
            self.db.add_audit_log(
                "MATCH_REVIEW_REQUIRED",
                "SECURITY",
                "SYSTEM",
                &format!("PO {} held for review: query '{}'", resolved_po, query_name),
            ).ok();
            return Ok(());
        }

        if recipient_email.is_empty() || !EmailDeliveryClient::is_valid_email(&recipient_email) {
            job.status = "needs_review".to_string();
            job.stage_message = format!("Invalid or empty email for company {}. Moved to Review.", approved_company_name);
            if let Ok(review_path) = move_folder_to_dir(&processing_po_dir, &settings.review_dir) {
                job.source_path = review_path.to_string_lossy().to_string();
            }
            self.db.update_job(&job).ok();
            return Ok(());
        }

        // Self-learning loop: reinforce Thai<->English names, Tax ID, email domain, and layout zone
        if settings.self_learning_enabled {
            if let Ok(signals_count) = self.db.learn_from_approved_job(&job, &approved_company_name, &recipient_email) {
                if signals_count > 0 {
                    self.ocr_manager.push_log(format!(
                        "[self-learn] Reinforced {} memory signal(s) for '{}'",
                        signals_count, approved_company_name
                    ));
                }
            }
        }

        self.deliver_po_package(
            &processing_po_dir,
            job,
            &approved_company_name,
            &recipient_email,
            &resolved_po,
            &documents,
        )
        .await?;

        Ok(())
    }

    /// Executes Stages 5-8: ZIP packaging, duplicate guard, Google Drive backup,
    /// Google Apps Script email delivery, Sent archival, and temporary cleanup.
    pub async fn deliver_po_package(
        &self,
        po_dir: &Path,
        mut job: Job,
        approved_company_name: &str,
        recipient_email: &str,
        resolved_po: &str,
        documents: &[crate::document::DiscoveredDocument],
    ) -> Result<Job, String> {
        let settings = self.db.get_settings().map_err(|e| e.to_string())?;
        let job_id = job.id.clone();
        let folder_name = job.po_folder_name.clone();

        // 5. Stage: Preparing ZIP Archive & Duplicate Protection
        job.status = "preparing_zip".to_string();
        job.stage_message = "Creating secure verified ZIP archive.".to_string();
        self.db.update_job(&job).ok();

        let temp_base = PathBuf::from(&settings.temp_dir);
        std::fs::create_dir_all(&temp_base).ok();
        let archive_file_path = temp_base.join(format!("{}.zip", folder_name));

        let archive_res = ArchiveManager::create_po_archive(
            po_dir,
            &archive_file_path,
            settings.max_zip_file_mb,
        ).map_err(|e| e.to_string())?;

        job.archive_path = Some(archive_res.archive_path.to_string_lossy().to_string());
        job.archive_sha256 = Some(archive_res.sha256_hash.clone());
        job.archive_size_bytes = Some(archive_res.size_bytes as i64);

        let folder_fingerprint = SecurityManager::compute_folder_fingerprint(documents);

        // Check for duplicate transactions
        if let Ok(Some(existing_tx)) = self.db.check_duplicate(resolved_po, &folder_fingerprint, &archive_res.sha256_hash) {
            job.status = "needs_review".to_string();
            job.stage_message = format!(
                "Blocked duplicate transmission: PO {} already delivered on {}",
                resolved_po, existing_tx.sent_at
            );
            if let Ok(review_path) = move_folder_to_dir(po_dir, &settings.review_dir) {
                job.source_path = review_path.to_string_lossy().to_string();
            }
            self.db.update_job(&job).ok();
            self.db.add_audit_log(
                "DUPLICATE_BLOCKED",
                "SECURITY",
                "SYSTEM",
                &format!("Duplicate suppressed for PO: {}", resolved_po),
            ).ok();
            std::fs::remove_file(&archive_file_path).ok();
            return Ok(job);
        }

        // 6. Stage: Upload to Google Drive (with automatic fallback to Cloud Hub -> local reference)
        job.status = "uploading_drive".to_string();
        job.stage_message = "Uploading package to Google Drive.".to_string();
        self.db.update_job(&job).ok();
        self.ocr_manager.push_log(format!(
            "[drive] Uploading {}.zip ({} bytes) to Drive folder '{}'...",
            folder_name, archive_res.size_bytes, settings.google_drive_folder_id
        ));

        let mut drive_token = None;
        let mut mut_settings = settings.clone();
        if let Some(ref mut acct) = mut_settings.google_account {
            if let Ok(tok) = crate::google::auth::GoogleAuthManager::get_valid_access_token_with_gas(
                acct,
                &mut_settings.google_oauth_client_id,
                &mut_settings.google_oauth_client_secret,
                &mut_settings.gas_webhook_url,
                &mut_settings.gas_auth_secret,
            ).await {
                drive_token = Some(tok);
                self.db.save_settings(&mut_settings).ok();
            }
        }

        let drive_upload = if settings.dry_run_simulation_mode {
            crate::google::drive::DriveUploadResult {
                file_id: format!("drive_simulated_{}", uuid::Uuid::new_v4()),
                file_name: format!("{}.zip", folder_name),
                web_view_link: Some("https://drive.google.com/file/d/dry_run_simulated/view".to_string()),
            }
        } else if !settings.gas_webhook_url.trim().is_empty() {
            // Priority 1: Upload directly using built-in Apps Script DriveApp (no Drive API v3 service needed)
            match self.drive_client.upload_archive_via_gas(
                &archive_res.archive_path,
                &settings.gas_webhook_url,
                &settings.gas_auth_secret,
                &settings.google_drive_folder_id,
            ).await {
                Ok(res) => {
                    self.ocr_manager.push_log(format!("[drive] Apps Script DriveApp upload succeeded: file_id={}", res.file_id));
                    res
                }
                Err(gas_err) => {
                    warn!("GAS Drive upload failed ({}), trying direct OAuth Drive API fallback...", gas_err);
                    self.ocr_manager.push_log(format!("[drive WARN] Apps Script Drive upload failed: {}. Trying direct Drive API...", gas_err));
                    if let Some(ref tok) = drive_token {
                        match self.drive_client.upload_archive(
                            &archive_res.archive_path,
                            &settings.google_drive_folder_id,
                            Some(tok),
                        ).await {
                            Ok(res) => {
                                self.ocr_manager.push_log(format!("[drive] Direct OAuth upload succeeded: file_id={}", res.file_id));
                                res
                            }
                            Err(oauth_err) => {
                                warn!("Direct Drive fallback also failed ({}), using offline tracking ref", oauth_err);
                                self.ocr_manager.push_log(format!("[drive WARN] Direct Drive upload failed: {}. Continuing with offline ref.", oauth_err));
                                self.drive_client.upload_archive(
                                    &archive_res.archive_path,
                                    &settings.google_drive_folder_id,
                                    None,
                                ).await.map_err(|err| err.to_string())?
                            }
                        }
                    } else {
                        self.drive_client.upload_archive(
                            &archive_res.archive_path,
                            &settings.google_drive_folder_id,
                            None,
                        ).await.map_err(|err| err.to_string())?
                    }
                }
            }
        } else if let Some(ref tok) = drive_token {
            match self.drive_client.upload_archive(
                &archive_res.archive_path,
                &settings.google_drive_folder_id,
                Some(tok),
            ).await {
                Ok(res) => {
                    self.ocr_manager.push_log(format!("[drive] Direct OAuth upload succeeded: file_id={}", res.file_id));
                    res
                }
                Err(e) => {
                    warn!("Direct Drive upload failed ({}), using offline tracking ref", e);
                    self.ocr_manager.push_log(format!("[drive WARN] Direct upload failed: {}. Continuing with offline ref.", e));
                    self.drive_client.upload_archive(
                        &archive_res.archive_path,
                        &settings.google_drive_folder_id,
                        None,
                    ).await.map_err(|err| err.to_string())?
                }
            }
        } else {
            self.drive_client.upload_archive(
                &archive_res.archive_path,
                &settings.google_drive_folder_id,
                None,
            ).await.map_err(|e| e.to_string())?
        };

        job.drive_file_id = Some(drive_upload.file_id.clone());
        job.drive_web_link = drive_upload.web_view_link.clone();

        if settings.require_drive_backup_for_auto_send
            && drive_upload.file_id.starts_with("drive_local_")
        {
            job.status = "needs_review".to_string();
            job.stage_message = "Held in Review: Cloud Google Drive backup is required before sending email, and Drive upload was offline.".to_string();
            if let Ok(review_path) = move_folder_to_dir(po_dir, &settings.review_dir) {
                job.source_path = review_path.to_string_lossy().to_string();
            }
            self.db.update_job(&job).ok();
            self.db
                .add_event(
                    Some(&job_id),
                    "warn",
                    &format!("PO {} held in Review because Google Drive cloud backup was offline.", resolved_po),
                )
                .ok();
            std::fs::remove_file(&archive_file_path).ok();
            return Ok(job);
        }

        let attachment_mode = if settings.email_attachment_mode.trim().is_empty() {
            "individual_files"
        } else {
            settings.email_attachment_mode.as_str()
        };

        let mut individual_attachments = Vec::new();
        if attachment_mode == "individual_files" || attachment_mode == "both" {
            use base64::Engine;
            const MAX_TOTAL_RAW_BYTES: usize = 18 * 1024 * 1024;
            let mut running_bytes: usize = 0;

            for doc in documents {
                if let Ok(bytes) = std::fs::read(&doc.absolute_path) {
                    if running_bytes + bytes.len() > MAX_TOTAL_RAW_BYTES {
                        warn!(
                            "Skipping extra attachment {:?} because total raw size exceeds 18MB Gmail inline cap",
                            doc.relative_path
                        );
                        continue;
                    }
                    running_bytes += bytes.len();
                    let file_name = doc
                        .absolute_path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or(&doc.relative_path)
                        .to_string();
                    let mime_type = EmailDeliveryClient::mime_type_for_path(&doc.absolute_path).to_string();
                    let file_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    individual_attachments.push(crate::email::EmailAttachmentPayload {
                        file_name,
                        mime_type,
                        file_base64,
                    });
                }
            }
        }

        // 7. Stage: Triggering Google Apps Script Delivery
        job.status = "sending_email".to_string();
        job.stage_message = format!(
            "Dispatching email ({}, {} file(s)) to {} via Apps Script.",
            attachment_mode,
            individual_attachments.len(),
            recipient_email
        );
        self.db.update_job(&job).ok();
        self.ocr_manager.push_log(format!(
            "[gmail] Dispatching PO {} to {} (mode={}, inline_files={}, drive_file_id={})",
            resolved_po,
            recipient_email,
            attachment_mode,
            individual_attachments.len(),
            drive_upload.file_id
        ));

        let idempotency_key = format!("idemp_{}_{}", resolved_po, &archive_res.sha256_hash[..16]);
        let tx_id = uuid::Uuid::new_v4().to_string();

        let gas_resp = if settings.dry_run_simulation_mode {
            self.db.add_event(
                Some(&job_id),
                "info",
                &format!("[DRY-RUN SIMULATION] Mocked email delivery for PO {} to {}", resolved_po, recipient_email),
            ).ok();
            Ok(crate::email::GasDeliveryResponse {
                status: "accepted".to_string(),
                execution_id: Some(format!("dry_run_exec_{}", uuid::Uuid::new_v4())),
                transaction_id: Some(tx_id.clone()),
                po_number: Some(resolved_po.to_string()),
                recipient: Some(recipient_email.to_string()),
                timestamp: Some(chrono::Utc::now().to_rfc3339()),
                duplicate_suppressed: Some(false),
                attachment_sent: Some(true),
                error: None,
            })
        } else {
            self.email_client.send_po_email_with_attachments(
                &settings.gas_webhook_url,
                &settings.gas_auth_secret,
                &tx_id,
                resolved_po,
                approved_company_name,
                recipient_email,
                Some(&drive_upload.file_id),
                &idempotency_key,
                &settings.email_subject_template,
                &settings.email_body_template,
                attachment_mode,
                individual_attachments,
            ).await
        };

        match gas_resp {
            Ok(resp) => {
                job.email_transaction_id = Some(tx_id.clone());

                // Record delivery attempt
                self.db.record_email_attempt(
                    &tx_id,
                    &idempotency_key,
                    recipient_email,
                    &settings.email_subject_template,
                    1,
                    200,
                    &serde_json::to_string(&resp).unwrap_or_default(),
                    true,
                ).ok();

                // 8. Stage: Completed & Moved to Sent
                job.status = "completed".to_string();
                job.stage_message = format!("Delivered to {}. Execution ID: {:?}", recipient_email, resp.execution_id);
                job.completed_at = Some(chrono::Utc::now().to_rfc3339());
                job.updated_at = chrono::Utc::now().to_rfc3339();
                self.db.update_job(&job).ok();

                // Record permanent transaction
                let tx_record = PoTransaction {
                    id: tx_id,
                    job_id: job_id.clone(),
                    po_number: resolved_po.to_string(),
                    folder_fingerprint,
                    archive_sha256: archive_res.sha256_hash,
                    company_name: approved_company_name.to_string(),
                    recipient_email: recipient_email.to_string(),
                    status: "sent".to_string(),
                    gas_execution_id: resp.execution_id,
                    error_message: None,
                    sent_at: chrono::Utc::now().to_rfc3339(),
                };
                self.db.record_transaction(&tx_record).ok();

                // Move folder to Sent
                if let Ok(sent_path) = move_folder_to_dir(po_dir, &settings.sent_dir) {
                    job.source_path = sent_path.to_string_lossy().to_string();
                    self.db.update_job(&job).ok();
                }

                self.db.add_event(
                    Some(&job_id),
                    "success",
                    &format!("Successfully processed & delivered PO {} to {}", resolved_po, recipient_email),
                ).ok();

                self.db.add_audit_log(
                    "PO_DELIVERED",
                    "DELIVERY",
                    "SYSTEM",
                    &format!("Delivered PO {} to {}", resolved_po, recipient_email),
                ).ok();

                // Cleanup temp zip
                std::fs::remove_file(&archive_file_path).ok();
                self.ocr_manager.push_log(format!(
                    "[gmail OK] Delivered PO {} to {} (tx={})",
                    resolved_po, recipient_email, job.email_transaction_id.as_deref().unwrap_or("-")
                ));
                Ok(job)
            }
            Err(e) => {
                error!("Delivery failure for PO {}: {}", resolved_po, e);
                self.ocr_manager.push_log(format!(
                    "[gmail ERROR] Delivery failed for PO {}: {}",
                    resolved_po, e
                ));
                job.status = "failed".to_string();
                job.stage_message = format!("Email delivery failed: {}", e);
                job.error_details = Some(e.to_string());
                job.updated_at = chrono::Utc::now().to_rfc3339();

                if let Ok(failed_path) = move_folder_to_dir(po_dir, &settings.failed_dir) {
                    job.source_path = failed_path.to_string_lossy().to_string();
                }
                self.db.update_job(&job).ok();

                self.db.record_email_attempt(
                    &tx_id,
                    &idempotency_key,
                    recipient_email,
                    &settings.email_subject_template,
                    1,
                    500,
                    &e.to_string(),
                    false,
                ).ok();

                self.db.add_event(
                    Some(&job_id),
                    "error",
                    &format!("Delivery failed for PO {}: {}", resolved_po, e),
                ).ok();

                std::fs::remove_file(&archive_file_path).ok();
                Err(e.to_string())
            }
        }
    }
}

/// Flattens a single nested subfolder that shares the parent folder's name
/// (e.g. `PO-26004156/PO-26004156/*` -> `PO-26004156/*`) so paths stay clean.
pub fn flatten_nested_same_name_dir(parent_dir: &Path) {
    let parent_name = match parent_dir.file_name().and_then(|n| n.to_str()) {
        Some(n) => n,
        None => return,
    };
    let entries: Vec<PathBuf> = match std::fs::read_dir(parent_dir) {
        Ok(rd) => rd.filter_map(|e| e.ok().map(|x| x.path())).collect(),
        Err(_) => return,
    };
    if entries.len() != 1 || !entries[0].is_dir() {
        return;
    }
    let child_dir = &entries[0];
    let child_name = child_dir.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if !child_name.eq_ignore_ascii_case(parent_name) {
        return;
    }

    // Rename nested dir temporarily so files inside with the same name never collide
    let staging = parent_dir.join(format!("__flatten_tmp_{}", uuid::Uuid::new_v4().simple()));
    if std::fs::rename(child_dir, &staging).is_err() {
        return;
    }
    if let Ok(inner_entries) = std::fs::read_dir(&staging) {
        for item in inner_entries.filter_map(|e| e.ok()) {
            let src = item.path();
            let dst = parent_dir.join(item.file_name());
            if !dst.exists() {
                if std::fs::rename(&src, &dst).is_err() && src.is_dir() {
                    let _ = copy_dir_recursive(&src, &dst);
                    let _ = std::fs::remove_dir_all(&src);
                }
            }
        }
    }
    let _ = std::fs::remove_dir_all(&staging);
}

pub fn move_folder_to_dir(source_dir: &Path, target_parent: &str) -> std::io::Result<PathBuf> {
    let parent = PathBuf::from(target_parent);
    std::fs::create_dir_all(&parent)?;

    let folder_name = source_dir.file_name().unwrap_or_default();
    let dest = parent.join(folder_name);

    let src_norm = source_dir.to_string_lossy().trim_end_matches(['\\', '/']).to_string();
    let dst_norm = dest.to_string_lossy().trim_end_matches(['\\', '/']).to_string();
    if src_norm.eq_ignore_ascii_case(&dst_norm) {
        return Ok(dest);
    }

    if dest.exists() {
        std::fs::remove_dir_all(&dest).ok();
    }

    let mut last_err = None;
    for attempt in 1..=5 {
        if std::fs::rename(source_dir, &dest).is_ok() {
            return Ok(dest);
        }
        match copy_dir_recursive(source_dir, &dest) {
            Ok(()) => {
                if std::fs::remove_dir_all(source_dir).is_ok() {
                    return Ok(dest);
                }
            }
            Err(e) => {
                last_err = Some(e);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(150 * attempt));
    }

    if dest.exists() {
        Ok(dest)
    } else {
        Err(last_err.unwrap_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::Other, "Failed to move folder after 5 retries")
        }))
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in walkdir::WalkDir::new(src).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if let Ok(rel) = path.strip_prefix(src) {
            let target = dst.join(rel);
            if entry.file_type().is_dir() {
                std::fs::create_dir_all(&target)?;
            } else if entry.file_type().is_file() {
                if let Some(p) = target.parent() {
                    std::fs::create_dir_all(p)?;
                }
                std::fs::copy(path, target)?;
            }
        }
    }
    Ok(())
}
