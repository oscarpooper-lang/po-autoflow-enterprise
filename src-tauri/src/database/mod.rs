pub mod models;

use models::*;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum DbError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("Database migration error: {0}")]
    Migration(String),
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("Not found: {0}")]
    NotFound(String),
}

#[derive(Clone)]
pub struct Database {
    conn: Arc<Mutex<Connection>>,
    pub db_path: PathBuf,
}

impl Database {
    pub fn new<P: AsRef<Path>>(path: P) -> Result<Self, DbError> {
        let p = path.as_ref().to_path_buf();
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).ok();
        }

        let conn = Connection::open(&p)?;
        // Enable WAL mode for high concurrency and performance
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;

        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
            db_path: p,
        };

        db.run_migrations()?;
        db.ensure_default_settings()?;
        db.deduplicate_jobs().ok();

        Ok(db)
    }

    fn run_migrations(&self) -> Result<(), DbError> {
        let conn = self.conn.lock();

        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                config_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                po_folder_name TEXT NOT NULL,
                source_path TEXT NOT NULL,
                status TEXT NOT NULL,
                stage_message TEXT NOT NULL,
                po_number TEXT,
                detected_company_raw TEXT,
                matched_company_name TEXT,
                matched_email TEXT,
                match_confidence REAL,
                match_category TEXT,
                archive_path TEXT,
                archive_sha256 TEXT,
                archive_size_bytes INTEGER,
                drive_file_id TEXT,
                drive_web_link TEXT,
                email_transaction_id TEXT,
                retry_count INTEGER NOT NULL DEFAULT 0,
                error_details TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                completed_at TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
            CREATE INDEX IF NOT EXISTS idx_jobs_po_number ON jobs(po_number);

            CREATE TABLE IF NOT EXISTS po_transactions (
                id TEXT PRIMARY KEY,
                job_id TEXT NOT NULL,
                po_number TEXT NOT NULL,
                folder_fingerprint TEXT NOT NULL,
                archive_sha256 TEXT NOT NULL,
                company_name TEXT NOT NULL,
                recipient_email TEXT NOT NULL,
                status TEXT NOT NULL,
                gas_execution_id TEXT,
                error_message TEXT,
                sent_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_tx_po_number ON po_transactions(po_number);
            CREATE INDEX IF NOT EXISTS idx_tx_archive_sha256 ON po_transactions(archive_sha256);
            CREATE INDEX IF NOT EXISTS idx_tx_folder_fingerprint ON po_transactions(folder_fingerprint);

            CREATE TABLE IF NOT EXISTS processed_files (
                id TEXT PRIMARY KEY,
                job_id TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                file_type TEXT NOT NULL,
                file_size_bytes INTEGER NOT NULL,
                file_hash TEXT NOT NULL,
                page_count INTEGER NOT NULL,
                extraction_method TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS ocr_results (
                id TEXT PRIMARY KEY,
                job_id TEXT NOT NULL,
                file_path TEXT NOT NULL,
                page_number INTEGER NOT NULL,
                raw_text TEXT NOT NULL,
                normalized_text TEXT NOT NULL,
                confidence REAL NOT NULL,
                engine TEXT NOT NULL,
                bounding_boxes_json TEXT NOT NULL,
                detected_entities_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_ocr_job ON ocr_results(job_id);

            CREATE TABLE IF NOT EXISTS companies_cache (
                id TEXT PRIMARY KEY,
                company_name TEXT NOT NULL,
                alternative_name TEXT,
                email TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1,
                tax_id TEXT,
                notes TEXT,
                vendor_group TEXT,
                synced_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS department_cc_cache (
                id TEXT PRIMARY KEY,
                department_name TEXT NOT NULL,
                emails TEXT NOT NULL,
                synced_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS company_aliases (
                id TEXT PRIMARY KEY,
                alias TEXT NOT NULL UNIQUE,
                canonical_company_name TEXT NOT NULL,
                created_by TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS email_attempts (
                id TEXT PRIMARY KEY,
                transaction_id TEXT NOT NULL,
                idempotency_key TEXT NOT NULL UNIQUE,
                recipient TEXT NOT NULL,
                subject TEXT NOT NULL,
                attempt_number INTEGER NOT NULL,
                response_code INTEGER NOT NULL,
                response_body TEXT NOT NULL,
                is_success INTEGER NOT NULL,
                attempted_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS audit_logs (
                id TEXT PRIMARY KEY,
                action TEXT NOT NULL,
                category TEXT NOT NULL,
                actor TEXT NOT NULL,
                details TEXT NOT NULL,
                timestamp TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS application_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id TEXT,
                level TEXT NOT NULL,
                message TEXT NOT NULL,
                timestamp TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS learning_memory (
                id TEXT PRIMARY KEY,
                signal_type TEXT NOT NULL,
                signal_value TEXT NOT NULL,
                canonical_company_name TEXT NOT NULL,
                recipient_email TEXT,
                hit_count INTEGER NOT NULL DEFAULT 1,
                confidence_boost REAL NOT NULL DEFAULT 10.0,
                updated_at TEXT NOT NULL,
                UNIQUE(signal_type, signal_value, canonical_company_name)
            );

            CREATE INDEX IF NOT EXISTS idx_learning_signal ON learning_memory(signal_type, signal_value);

            CREATE TABLE IF NOT EXISTS ui_state (
                state_key TEXT PRIMARY KEY,
                state_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            "#,
        )?;

        // Ensure `vendor_group` column exists on upgraded databases
        let has_vendor_group: bool = {
            let mut stmt = conn.prepare("PRAGMA table_info(companies_cache)")?;
            let cols = stmt.query_map([], |row| row.get::<_, String>(1))?;
            cols.filter_map(|r| r.ok()).any(|c| c == "vendor_group")
        };
        if !has_vendor_group {
            conn.execute("ALTER TABLE companies_cache ADD COLUMN vendor_group TEXT", [])?;
        }

        // Ensure `matched_department` & `department_cc_emails` columns exist on `jobs`
        let job_cols: Vec<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(jobs)")?;
            let cols = stmt.query_map([], |row| row.get::<_, String>(1))?;
            cols.filter_map(|r| r.ok()).collect()
        };
        if !job_cols.iter().any(|c| c == "matched_department") {
            conn.execute("ALTER TABLE jobs ADD COLUMN matched_department TEXT", [])?;
        }
        if !job_cols.iter().any(|c| c == "department_cc_emails") {
            conn.execute("ALTER TABLE jobs ADD COLUMN department_cc_emails TEXT", [])?;
        }

        Ok(())
    }

    fn ensure_default_settings(&self) -> Result<(), DbError> {
        let conn = self.conn.lock();
        let exists: Option<i64> = conn
            .query_row(
                "SELECT id FROM settings WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()?;

        if exists.is_none() {
            let default_settings = AppSettings::default();
            let json = serde_json::to_string(&default_settings)?;
            let now = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO settings (id, config_json, updated_at) VALUES (1, ?1, ?2)",
                params![json, now],
            )?;
        }

        Ok(())
    }

    // --- Settings ---
    pub fn get_settings(&self) -> Result<AppSettings, DbError> {
        let conn = self.conn.lock();
        let json: String = conn.query_row(
            "SELECT config_json FROM settings WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        let settings = serde_json::from_str(&json)?;
        Ok(settings)
    }

    pub fn save_settings(&self, settings: &AppSettings) -> Result<(), DbError> {
        let conn = self.conn.lock();
        let json = serde_json::to_string(settings)?;
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE settings SET config_json = ?1, updated_at = ?2 WHERE id = 1",
            params![json, now],
        )?;
        Ok(())
    }

    // --- Jobs ---
    pub fn insert_job(&self, job: &Job) -> Result<(), DbError> {
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT INTO jobs (
                id, po_folder_name, source_path, status, stage_message,
                po_number, detected_company_raw, matched_company_name, matched_email,
                matched_department, department_cc_emails,
                match_confidence, match_category, archive_path, archive_sha256,
                archive_size_bytes, drive_file_id, drive_web_link, email_transaction_id,
                retry_count, error_details, created_at, updated_at, completed_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24
            )
            "#,
            params![
                job.id,
                job.po_folder_name,
                job.source_path,
                job.status,
                job.stage_message,
                job.po_number,
                job.detected_company_raw,
                job.matched_company_name,
                job.matched_email,
                job.matched_department,
                job.department_cc_emails,
                job.match_confidence,
                job.match_category,
                job.archive_path,
                job.archive_sha256,
                job.archive_size_bytes,
                job.drive_file_id,
                job.drive_web_link,
                job.email_transaction_id,
                job.retry_count,
                job.error_details,
                job.created_at,
                job.updated_at,
                job.completed_at
            ],
        )?;
        Ok(())
    }

    pub fn update_job(&self, job: &Job) -> Result<(), DbError> {
        let conn = self.conn.lock();
        conn.execute(
            r#"
            UPDATE jobs SET
                po_folder_name = ?2,
                source_path = ?3,
                status = ?4,
                stage_message = ?5,
                po_number = ?6,
                detected_company_raw = ?7,
                matched_company_name = ?8,
                matched_email = ?9,
                matched_department = ?10,
                department_cc_emails = ?11,
                match_confidence = ?12,
                match_category = ?13,
                archive_path = ?14,
                archive_sha256 = ?15,
                archive_size_bytes = ?16,
                drive_file_id = ?17,
                drive_web_link = ?18,
                email_transaction_id = ?19,
                retry_count = ?20,
                error_details = ?21,
                updated_at = ?22,
                completed_at = ?23
            WHERE id = ?1
            "#,
            params![
                job.id,
                job.po_folder_name,
                job.source_path,
                job.status,
                job.stage_message,
                job.po_number,
                job.detected_company_raw,
                job.matched_company_name,
                job.matched_email,
                job.matched_department,
                job.department_cc_emails,
                job.match_confidence,
                job.match_category,
                job.archive_path,
                job.archive_sha256,
                job.archive_size_bytes,
                job.drive_file_id,
                job.drive_web_link,
                job.email_transaction_id,
                job.retry_count,
                job.error_details,
                job.updated_at,
                job.completed_at
            ],
        )?;
        Ok(())
    }

    fn row_to_job(row: &rusqlite::Row<'_>) -> Result<Job, rusqlite::Error> {
        Ok(Job {
            id: row.get(0)?,
            po_folder_name: row.get(1)?,
            source_path: row.get(2)?,
            status: row.get(3)?,
            stage_message: row.get(4)?,
            po_number: row.get(5)?,
            detected_company_raw: row.get(6)?,
            matched_company_name: row.get(7)?,
            matched_email: row.get(8)?,
            matched_department: row.get(9)?,
            department_cc_emails: row.get(10)?,
            match_confidence: row.get(11)?,
            match_category: row.get(12)?,
            archive_path: row.get(13)?,
            archive_sha256: row.get(14)?,
            archive_size_bytes: row.get(15)?,
            drive_file_id: row.get(16)?,
            drive_web_link: row.get(17)?,
            email_transaction_id: row.get(18)?,
            retry_count: row.get(19)?,
            error_details: row.get(20)?,
            created_at: row.get(21)?,
            updated_at: row.get(22)?,
            completed_at: row.get(23)?,
        })
    }

    pub fn get_job(&self, id: &str) -> Result<Option<Job>, DbError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT
                id, po_folder_name, source_path, status, stage_message,
                po_number, detected_company_raw, matched_company_name, matched_email,
                matched_department, department_cc_emails,
                match_confidence, match_category, archive_path, archive_sha256,
                archive_size_bytes, drive_file_id, drive_web_link, email_transaction_id,
                retry_count, error_details, created_at, updated_at, completed_at
            FROM jobs WHERE id = ?1
            "#,
        )?;

        let job = stmt.query_row(params![id], Self::row_to_job).optional()?;
        Ok(job)
    }

    pub fn find_reusable_job_by_folder(&self, po_folder_name: &str) -> Result<Option<Job>, DbError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT
                id, po_folder_name, source_path, status, stage_message,
                po_number, detected_company_raw, matched_company_name, matched_email,
                matched_department, department_cc_emails,
                match_confidence, match_category, archive_path, archive_sha256,
                archive_size_bytes, drive_file_id, drive_web_link, email_transaction_id,
                retry_count, error_details, created_at, updated_at, completed_at
            FROM jobs
            WHERE po_folder_name = ?1 AND status != 'completed'
            ORDER BY updated_at DESC
            LIMIT 1
            "#,
        )?;
        let job = stmt.query_row(params![po_folder_name], Self::row_to_job).optional()?;
        Ok(job)
    }

    pub fn clear_job_ocr_and_files(&self, job_id: &str) -> Result<(), DbError> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM ocr_results WHERE job_id = ?1", params![job_id])?;
        conn.execute("DELETE FROM processed_files WHERE job_id = ?1", params![job_id])?;
        Ok(())
    }

    pub fn deduplicate_jobs(&self) -> Result<usize, DbError> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        let deleted = tx.execute(
            r#"
            DELETE FROM jobs
            WHERE status != 'completed'
              AND id NOT IN (
                SELECT id FROM (
                    SELECT id,
                           ROW_NUMBER() OVER (
                               PARTITION BY po_folder_name
                               ORDER BY CASE WHEN status = 'completed' THEN 0 ELSE 1 END ASC, updated_at DESC
                           ) AS rn
                    FROM jobs
                )
                WHERE rn = 1
            )
            "#,
            [],
        )?;
        tx.commit()?;
        Ok(deleted)
    }

    pub fn list_jobs(&self, limit: i64, offset: i64) -> Result<Vec<Job>, DbError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT
                id, po_folder_name, source_path, status, stage_message,
                po_number, detected_company_raw, matched_company_name, matched_email,
                matched_department, department_cc_emails,
                match_confidence, match_category, archive_path, archive_sha256,
                archive_size_bytes, drive_file_id, drive_web_link, email_transaction_id,
                retry_count, error_details, created_at, updated_at, completed_at
            FROM jobs ORDER BY updated_at DESC LIMIT ?1 OFFSET ?2
            "#,
        )?;

        let rows = stmt.query_map(params![limit, offset], Self::row_to_job)?;

        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    pub fn get_in_flight_jobs_for_recovery(&self) -> Result<Vec<Job>, DbError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT
                id, po_folder_name, source_path, status, stage_message,
                po_number, detected_company_raw, matched_company_name, matched_email,
                matched_department, department_cc_emails,
                match_confidence, match_category, archive_path, archive_sha256,
                archive_size_bytes, drive_file_id, drive_web_link, email_transaction_id,
                retry_count, error_details, created_at, updated_at, completed_at
            FROM jobs
            WHERE status NOT IN ('completed', 'failed', 'needs_review')
            ORDER BY created_at ASC
            "#,
        )?;

        let rows = stmt.query_map([], Self::row_to_job)?;

        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    // --- Transactions & Duplicate Protection ---
    pub fn record_transaction(&self, tx: &PoTransaction) -> Result<(), DbError> {
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT INTO po_transactions (
                id, job_id, po_number, folder_fingerprint, archive_sha256,
                company_name, recipient_email, status, gas_execution_id,
                error_message, sent_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            "#,
            params![
                tx.id,
                tx.job_id,
                tx.po_number,
                tx.folder_fingerprint,
                tx.archive_sha256,
                tx.company_name,
                tx.recipient_email,
                tx.status,
                tx.gas_execution_id,
                tx.error_message,
                tx.sent_at
            ],
        )?;
        Ok(())
    }

    pub fn check_duplicate(&self, po_number: &str, folder_fingerprint: &str, archive_sha256: &str) -> Result<Option<PoTransaction>, DbError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT
                id, job_id, po_number, folder_fingerprint, archive_sha256,
                company_name, recipient_email, status, gas_execution_id,
                error_message, sent_at
            FROM po_transactions
            WHERE (po_number = ?1 OR folder_fingerprint = ?2 OR archive_sha256 = ?3)
              AND status IN ('accepted', 'sent', 'confirmed_delivery')
            ORDER BY sent_at DESC LIMIT 1
            "#,
        )?;

        let tx = stmt
            .query_row(params![po_number, folder_fingerprint, archive_sha256], |row| {
                Ok(PoTransaction {
                    id: row.get(0)?,
                    job_id: row.get(1)?,
                    po_number: row.get(2)?,
                    folder_fingerprint: row.get(3)?,
                    archive_sha256: row.get(4)?,
                    company_name: row.get(5)?,
                    recipient_email: row.get(6)?,
                    status: row.get(7)?,
                    gas_execution_id: row.get(8)?,
                    error_message: row.get(9)?,
                    sent_at: row.get(10)?,
                })
            })
            .optional()?;

        Ok(tx)
    }

    pub fn list_transactions(&self, limit: i64, offset: i64) -> Result<Vec<PoTransaction>, DbError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT
                id, job_id, po_number, folder_fingerprint, archive_sha256,
                company_name, recipient_email, status, gas_execution_id,
                error_message, sent_at
            FROM po_transactions ORDER BY sent_at DESC LIMIT ?1 OFFSET ?2
            "#,
        )?;

        let rows = stmt.query_map(params![limit, offset], |row| {
            Ok(PoTransaction {
                id: row.get(0)?,
                job_id: row.get(1)?,
                po_number: row.get(2)?,
                folder_fingerprint: row.get(3)?,
                archive_sha256: row.get(4)?,
                company_name: row.get(5)?,
                recipient_email: row.get(6)?,
                status: row.get(7)?,
                gas_execution_id: row.get(8)?,
                error_message: row.get(9)?,
                sent_at: row.get(10)?,
            })
        })?;

        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    // --- Processed Files ---
    pub fn record_processed_file(&self, file: &ProcessedFile) -> Result<(), DbError> {
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT INTO processed_files (
                id, job_id, relative_path, file_type, file_size_bytes,
                file_hash, page_count, extraction_method, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
            params![
                file.id,
                file.job_id,
                file.relative_path,
                file.file_type,
                file.file_size_bytes,
                file.file_hash,
                file.page_count,
                file.extraction_method,
                file.created_at
            ],
        )?;
        Ok(())
    }

    pub fn get_processed_files_for_job(&self, job_id: &str) -> Result<Vec<ProcessedFile>, DbError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT
                id, job_id, relative_path, file_type, file_size_bytes,
                file_hash, page_count, extraction_method, created_at
            FROM processed_files WHERE job_id = ?1
            "#,
        )?;

        let rows = stmt.query_map(params![job_id], |row| {
            Ok(ProcessedFile {
                id: row.get(0)?,
                job_id: row.get(1)?,
                relative_path: row.get(2)?,
                file_type: row.get(3)?,
                file_size_bytes: row.get(4)?,
                file_hash: row.get(5)?,
                page_count: row.get(6)?,
                extraction_method: row.get(7)?,
                created_at: row.get(8)?,
            })
        })?;

        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    // --- OCR Results ---
    pub fn record_ocr_result(&self, record: &OcrResultRecord) -> Result<(), DbError> {
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT INTO ocr_results (
                id, job_id, file_path, page_number, raw_text,
                normalized_text, confidence, engine, bounding_boxes_json,
                detected_entities_json, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            "#,
            params![
                record.id,
                record.job_id,
                record.file_path,
                record.page_number,
                record.raw_text,
                record.normalized_text,
                record.confidence,
                record.engine,
                record.bounding_boxes_json,
                record.detected_entities_json,
                record.created_at
            ],
        )?;
        Ok(())
    }

    pub fn get_ocr_results_for_job(&self, job_id: &str) -> Result<Vec<OcrResultRecord>, DbError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT
                id, job_id, file_path, page_number, raw_text,
                normalized_text, confidence, engine, bounding_boxes_json,
                detected_entities_json, created_at
            FROM ocr_results WHERE job_id = ?1 ORDER BY page_number ASC
            "#,
        )?;

        let rows = stmt.query_map(params![job_id], |row| {
            Ok(OcrResultRecord {
                id: row.get(0)?,
                job_id: row.get(1)?,
                file_path: row.get(2)?,
                page_number: row.get(3)?,
                raw_text: row.get(4)?,
                normalized_text: row.get(5)?,
                confidence: row.get(6)?,
                engine: row.get(7)?,
                bounding_boxes_json: row.get(8)?,
                detected_entities_json: row.get(9)?,
                created_at: row.get(10)?,
            })
        })?;

        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    // --- Companies Directory & Cache ---
    pub fn sync_companies_cache(&self, entries: &[CompanyCacheEntry]) -> Result<(), DbError> {
        let mut conn = self.conn.lock();

        // Preserve locally auto-learned suppliers not yet reflected in the incoming Google Sheet
        let existing_learned: Vec<CompanyCacheEntry> = {
            let mut stmt = conn.prepare(
                "SELECT id, company_name, alternative_name, email, active, tax_id, notes, vendor_group, synced_at FROM companies_cache WHERE notes LIKE 'AUTO_LEARNED%'",
            )?;
            let rows = stmt.query_map([], |row| {
                let active_int: i32 = row.get(4)?;
                Ok(CompanyCacheEntry {
                    id: row.get(0)?,
                    company_name: row.get(1)?,
                    alternative_name: row.get(2)?,
                    email: row.get(3)?,
                    active: active_int == 1,
                    tax_id: row.get(5)?,
                    notes: row.get(6)?,
                    vendor_group: row.get(7)?,
                    synced_at: row.get(8)?,
                })
            })?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r?);
            }
            out
        };

        let incoming_names: std::collections::HashSet<String> = entries
            .iter()
            .map(|e| crate::matching::thai_normalizer::ThaiNormalizer::clean_company_name(&e.company_name))
            .collect();

        let tx = conn.transaction()?;
        tx.execute("DELETE FROM companies_cache", [])?;

        for c in entries {
            tx.execute(
                r#"
                INSERT INTO companies_cache (
                    id, company_name, alternative_name, email,
                    active, tax_id, notes, vendor_group, synced_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                "#,
                params![
                    c.id,
                    c.company_name,
                    c.alternative_name,
                    c.email,
                    if c.active { 1 } else { 0 },
                    c.tax_id,
                    c.notes,
                    c.vendor_group,
                    c.synced_at
                ],
            )?;
        }

        for learned in existing_learned {
            let clean = crate::matching::thai_normalizer::ThaiNormalizer::clean_company_name(&learned.company_name);
            if !incoming_names.contains(&clean) {
                tx.execute(
                    r#"
                    INSERT OR IGNORE INTO companies_cache (
                        id, company_name, alternative_name, email,
                        active, tax_id, notes, vendor_group, synced_at
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                    "#,
                    params![
                        learned.id,
                        learned.company_name,
                        learned.alternative_name,
                        learned.email,
                        if learned.active { 1 } else { 0 },
                        learned.tax_id,
                        learned.notes,
                        learned.vendor_group,
                        learned.synced_at
                    ],
                )?;
            }
        }

        tx.commit()?;
        Ok(())
    }

    pub fn upsert_company_cache_entry(
        &self,
        company_name: &str,
        alternative_name: Option<&str>,
        email: &str,
        tax_id: Option<&str>,
        notes: Option<&str>,
    ) -> Result<CompanyCacheEntry, DbError> {
        let existing = self.get_companies_cache()?;
        let clean_target = crate::matching::thai_normalizer::ThaiNormalizer::clean_company_name(company_name);
        let now = chrono::Utc::now().to_rfc3339();
        let conn = self.conn.lock();

        if let Some(found) = existing.into_iter().find(|c| {
            crate::matching::thai_normalizer::ThaiNormalizer::clean_company_name(&c.company_name) == clean_target
                || c.company_name.eq_ignore_ascii_case(company_name.trim())
        }) {
            let final_alt = found
                .alternative_name
                .clone()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| alternative_name.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()));
            let final_tax = found
                .tax_id
                .clone()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| tax_id.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()));
            let final_email = if !email.trim().is_empty() {
                email.trim().to_string()
            } else {
                found.email.clone()
            };

            conn.execute(
                "UPDATE companies_cache SET alternative_name = ?2, email = ?3, tax_id = ?4, active = 1, synced_at = ?5 WHERE id = ?1",
                params![found.id, final_alt, final_email, final_tax, now],
            )?;

            Ok(CompanyCacheEntry {
                id: found.id,
                company_name: found.company_name,
                alternative_name: final_alt,
                email: final_email,
                active: true,
                tax_id: final_tax,
                notes: found.notes,
                vendor_group: found.vendor_group,
                synced_at: now,
            })
        } else {
            let inferred_group = if crate::google::sheets::is_overseas_vendor(
                company_name,
                alternative_name.unwrap_or(""),
                email,
                tax_id.unwrap_or(""),
            ) {
                Some("OV".to_string())
            } else {
                Some("DV".to_string())
            };
            let entry = CompanyCacheEntry {
                id: format!("learned_{}", uuid::Uuid::new_v4()),
                company_name: company_name.trim().to_string(),
                alternative_name: alternative_name.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
                email: email.trim().to_string(),
                active: true,
                tax_id: tax_id.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
                notes: notes.map(|s| s.to_string()),
                vendor_group: inferred_group,
                synced_at: now.clone(),
            };
            conn.execute(
                r#"
                INSERT INTO companies_cache (
                    id, company_name, alternative_name, email,
                    active, tax_id, notes, vendor_group, synced_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                "#,
                params![
                    entry.id,
                    entry.company_name,
                    entry.alternative_name,
                    entry.email,
                    1,
                    entry.tax_id,
                    entry.notes,
                    entry.vendor_group,
                    entry.synced_at
                ],
            )?;
            Ok(entry)
        }
    }

    pub fn get_companies_cache(&self) -> Result<Vec<CompanyCacheEntry>, DbError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT
                id, company_name, alternative_name, email,
                active, tax_id, notes, vendor_group, synced_at
            FROM companies_cache ORDER BY company_name ASC
            "#,
        )?;

        let rows = stmt.query_map([], |row| {
            let active_int: i32 = row.get(4)?;
            Ok(CompanyCacheEntry {
                id: row.get(0)?,
                company_name: row.get(1)?,
                alternative_name: row.get(2)?,
                email: row.get(3)?,
                active: active_int == 1,
                tax_id: row.get(5)?,
                notes: row.get(6)?,
                vendor_group: row.get(7)?,
                synced_at: row.get(8)?,
            })
        })?;

        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    pub fn sync_department_cc_cache(&self, entries: &[DepartmentCcEntry]) -> Result<(), DbError> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM department_cc_cache", [])?;
        for e in entries {
            tx.execute(
                "INSERT INTO department_cc_cache (id, department_name, emails, synced_at) VALUES (?1, ?2, ?3, ?4)",
                params![e.id, e.department_name, e.emails, e.synced_at],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_department_cc_cache(&self) -> Result<Vec<DepartmentCcEntry>, DbError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, department_name, emails, synced_at FROM department_cc_cache ORDER BY department_name ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(DepartmentCcEntry {
                id: row.get(0)?,
                department_name: row.get(1)?,
                emails: row.get(2)?,
                synced_at: row.get(3)?,
            })
        })?;
        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    // --- Aliases ---
    pub fn add_company_alias(&self, alias: &str, canonical: &str, actor: &str) -> Result<(), DbError> {
        let conn = self.conn.lock();
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();

        conn.execute(
            r#"
            INSERT INTO company_aliases (id, alias, canonical_company_name, created_by, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(alias) DO UPDATE SET
                canonical_company_name = excluded.canonical_company_name,
                created_by = excluded.created_by,
                created_at = excluded.created_at
            "#,
            params![id, alias, canonical, actor, now],
        )?;

        Ok(())
    }

    pub fn get_company_aliases(&self) -> Result<Vec<CompanyAlias>, DbError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT id, alias, canonical_company_name, created_by, created_at FROM company_aliases ORDER BY created_at DESC")?;
        let rows = stmt.query_map([], |row| {
            Ok(CompanyAlias {
                id: row.get(0)?,
                alias: row.get(1)?,
                canonical_company_name: row.get(2)?,
                created_by: row.get(3)?,
                created_at: row.get(4)?,
            })
        })?;

        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    pub fn delete_company_alias(&self, id: &str) -> Result<(), DbError> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM company_aliases WHERE id = ?1", params![id])?;
        Ok(())
    }

    // --- Application Events & Audit Logs ---
    pub fn add_event(&self, job_id: Option<&str>, level: &str, message: &str) -> Result<(), DbError> {
        let conn = self.conn.lock();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO application_events (job_id, level, message, timestamp) VALUES (?1, ?2, ?3, ?4)",
            params![job_id, level, message, now],
        )?;
        Ok(())
    }

    pub fn get_recent_events(&self, limit: i64) -> Result<Vec<ApplicationEvent>, DbError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, job_id, level, message, timestamp FROM application_events ORDER BY id DESC LIMIT ?1",
        )?;

        let rows = stmt.query_map(params![limit], |row| {
            Ok(ApplicationEvent {
                id: row.get(0)?,
                job_id: row.get(1)?,
                level: row.get(2)?,
                message: row.get(3)?,
                timestamp: row.get(4)?,
            })
        })?;

        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    pub fn add_audit_log(&self, action: &str, category: &str, actor: &str, details: &str) -> Result<(), DbError> {
        let conn = self.conn.lock();
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO audit_logs (id, action, category, actor, details, timestamp) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, action, category, actor, details, now],
        )?;
        Ok(())
    }

    pub fn get_audit_logs(&self, limit: i64) -> Result<Vec<AuditLog>, DbError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, action, category, actor, details, timestamp FROM audit_logs ORDER BY timestamp DESC LIMIT ?1",
        )?;

        let rows = stmt.query_map(params![limit], |row| {
            Ok(AuditLog {
                id: row.get(0)?,
                action: row.get(1)?,
                category: row.get(2)?,
                actor: row.get(3)?,
                details: row.get(4)?,
                timestamp: row.get(5)?,
            })
        })?;

        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    // --- Email Attempts ---
    pub fn record_email_attempt(
        &self,
        tx_id: &str,
        idempotency_key: &str,
        recipient: &str,
        subject: &str,
        attempt: i32,
        code: i32,
        body: &str,
        success: bool,
    ) -> Result<(), DbError> {
        let conn = self.conn.lock();
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();

        conn.execute(
            r#"
            INSERT INTO email_attempts (
                id, transaction_id, idempotency_key, recipient, subject,
                attempt_number, response_code, response_body, is_success, attempted_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            "#,
            params![
                id,
                tx_id,
                idempotency_key,
                recipient,
                subject,
                attempt,
                code,
                body,
                if success { 1 } else { 0 },
                now
            ],
        )?;
        Ok(())
    }

    // --- Dashboard Statistics ---
    pub fn get_dashboard_stats(&self) -> Result<DashboardStats, DbError> {
        let conn = self.conn.lock();

        let total_processed: i64 = conn.query_row(
            "SELECT COUNT(*) FROM jobs WHERE status IN ('completed', 'failed', 'needs_review')",
            [],
            |r| r.get(0),
        )?;

        let successfully_sent: i64 = conn.query_row(
            "SELECT COUNT(*) FROM jobs WHERE status = 'completed'",
            [],
            |r| r.get(0),
        )?;

        let waiting_processing: i64 = conn.query_row(
            "SELECT COUNT(*) FROM jobs WHERE status NOT IN ('completed', 'failed', 'needs_review')",
            [],
            |r| r.get(0),
        )?;

        let needs_review: i64 = conn.query_row(
            "SELECT COUNT(*) FROM jobs WHERE status = 'needs_review'",
            [],
            |r| r.get(0),
        )?;

        let failed_transactions: i64 = conn.query_row(
            "SELECT COUNT(*) FROM jobs WHERE status = 'failed'",
            [],
            |r| r.get(0),
        )?;

        let avg_confidence: Option<f64> = conn.query_row(
            "SELECT AVG(match_confidence) FROM jobs WHERE match_confidence IS NOT NULL",
            [],
            |r| r.get(0),
        ).optional()?;

        let success_rate = if total_processed > 0 {
            (successfully_sent as f64 / total_processed as f64) * 100.0
        } else {
            100.0
        };

        Ok(DashboardStats {
            total_processed,
            successfully_sent,
            waiting_processing,
            needs_review,
            failed_transactions,
            success_rate_percent: (success_rate * 10.0).round() / 10.0,
            avg_ocr_confidence: avg_confidence.unwrap_or(95.0),
        })
    }

    // --- Self-Learning Memory Engine ---
    pub fn record_learning_signal(
        &self,
        signal_type: &str,
        signal_value: &str,
        canonical_company: &str,
        recipient_email: Option<&str>,
        boost: f64,
    ) -> Result<(), DbError> {
        let clean_val = signal_value.trim();
        if clean_val.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock();
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            r#"
            INSERT INTO learning_memory (
                id, signal_type, signal_value, canonical_company_name,
                recipient_email, hit_count, confidence_boost, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7)
            ON CONFLICT(signal_type, signal_value, canonical_company_name) DO UPDATE SET
                hit_count = learning_memory.hit_count + 1,
                recipient_email = COALESCE(excluded.recipient_email, learning_memory.recipient_email),
                confidence_boost = MAX(learning_memory.confidence_boost, excluded.confidence_boost),
                updated_at = excluded.updated_at
            "#,
            params![id, signal_type, clean_val, canonical_company.trim(), recipient_email, boost, now],
        )?;
        Ok(())
    }

    pub fn get_learning_memories(&self) -> Result<Vec<LearningMemoryEntry>, DbError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT id, signal_type, signal_value, canonical_company_name,
                   recipient_email, hit_count, confidence_boost, updated_at
            FROM learning_memory
            ORDER BY hit_count DESC, updated_at DESC
            "#,
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(LearningMemoryEntry {
                id: row.get(0)?,
                signal_type: row.get(1)?,
                signal_value: row.get(2)?,
                canonical_company_name: row.get(3)?,
                recipient_email: row.get(4)?,
                hit_count: row.get(5)?,
                confidence_boost: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn get_learning_stats(&self) -> Result<LearningStats, DbError> {
        let aliases = self.get_company_aliases()?.len();
        let memories = self.get_learning_memories()?;

        let mut learned_tax_ids = 0;
        let mut learned_email_domains = 0;
        let mut learned_name_variants = 0;
        let mut negative_phrases_count = 0;
        let mut learned_zones_count = 0;
        let mut total_approvals_learned: i64 = 0;

        for m in &memories {
            total_approvals_learned += m.hit_count;
            match m.signal_type.as_str() {
                "tax_id" => learned_tax_ids += 1,
                "email_domain" => learned_email_domains += 1,
                "thai_name" | "english_name" => learned_name_variants += 1,
                "negative_phrase" => negative_phrases_count += 1,
                "layout_zone" => learned_zones_count += 1,
                _ => {}
            }
        }

        Ok(LearningStats {
            total_aliases: aliases,
            learned_tax_ids,
            learned_email_domains,
            learned_name_variants,
            negative_phrases_count,
            learned_zones_count,
            total_approvals_learned,
        })
    }

    /// Harvests verified supplier identity signals (Thai/English names, 13-digit Tax ID,
    /// non-generic email domain, false-positive negative phrases, and vertical layout zone)
    /// from an approved PO job so future scans continuously improve.
    pub fn learn_from_approved_job(
        &self,
        job: &Job,
        approved_company: &str,
        approved_email: &str,
    ) -> Result<usize, DbError> {
        use crate::matching::thai_normalizer::ThaiNormalizer;
        use crate::matching::CompanyMatcher;

        let clean_comp = approved_company.trim();
        let clean_email = approved_email.trim();
        if clean_comp.is_empty()
            || clean_email.is_empty()
            || ThaiNormalizer::is_ignored_self_company(clean_comp)
        {
            return Ok(0);
        }

        let ocr_records = self.get_ocr_results_for_job(&job.id).unwrap_or_default();
        let mut extracted_tax_ids: Vec<String> = Vec::new();
        let mut th_names: Vec<String> = Vec::new();
        let mut en_names: Vec<String> = Vec::new();

        for rec in &ocr_records {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&rec.detected_entities_json) {
                if let Some(arr) = parsed.get("tax_ids").and_then(|v| v.as_array()) {
                    for item in arr {
                        if let Some(tid) = item.as_str() {
                            let digits: String = tid.chars().filter(|c| c.is_ascii_digit()).collect();
                            if digits.len() == 13
                                && !ThaiNormalizer::is_ignored_self_company(&digits)
                                && !extracted_tax_ids.contains(&digits)
                            {
                                extracted_tax_ids.push(digits);
                            }
                        }
                    }
                }
                if let Some(th) = parsed.get("primary_supplier_th").and_then(|v| v.as_str()) {
                    if !th.trim().is_empty()
                        && !ThaiNormalizer::is_ignored_self_company(th)
                        && !th_names.contains(&th.trim().to_string())
                    {
                        th_names.push(th.trim().to_string());
                    }
                }
                if let Some(en) = parsed.get("primary_supplier_en").and_then(|v| v.as_str()) {
                    if !en.trim().is_empty()
                        && !ThaiNormalizer::is_ignored_self_company(en)
                        && !en_names.contains(&en.trim().to_string())
                    {
                        en_names.push(en.trim().to_string());
                    }
                }
                if let Some(cands) = parsed.get("supplier_candidates").and_then(|v| v.as_array()) {
                    for c in cands {
                        if let (Some(name), Some(lang)) = (
                            c.get("name").and_then(|v| v.as_str()),
                            c.get("language").and_then(|v| v.as_str()),
                        ) {
                            let n_trim = name.trim().to_string();
                            if n_trim.is_empty() || ThaiNormalizer::is_ignored_self_company(&n_trim) {
                                continue;
                            }
                            if lang == "th" && !th_names.contains(&n_trim) {
                                th_names.push(n_trim);
                            } else if lang != "th" && !en_names.contains(&n_trim) {
                                en_names.push(n_trim);
                            }
                        }
                    }
                }
            }
        }

        let app_is_thai = ThaiNormalizer::contains_thai(clean_comp);
        let alt_name = if app_is_thai {
            en_names.first().cloned()
        } else {
            th_names.first().cloned()
        };
        let first_tax = extracted_tax_ids.first().cloned();

        // 1. Upsert into local supplier directory cache
        self.upsert_company_cache_entry(
            clean_comp,
            alt_name.as_deref(),
            clean_email,
            first_tax.as_deref(),
            Some("AUTO_LEARNED"),
        )?;

        let mut signals_learned = 1usize;

        // 2. Record approved name signal & frequency prior
        let comp_signal_type = if app_is_thai { "thai_name" } else { "english_name" };
        self.record_learning_signal(comp_signal_type, clean_comp, clean_comp, Some(clean_email), 8.0)?;
        signals_learned += 1;

        // 3. Link 13-digit Tax IDs
        for tid in &extracted_tax_ids {
            self.record_learning_signal("tax_id", tid, clean_comp, Some(clean_email), 25.0)?;
            signals_learned += 1;
        }

        // 4. Link corporate vendor email domains (supports comma/semicolon-separated recipient lists)
        const GENERIC_DOMAINS: &[&str] = &[
            "gmail.com", "googlemail.com", "hotmail.com", "outlook.com", "live.com",
            "msn.com", "yahoo.com", "yahoo.co.th", "icloud.com", "me.com",
            "protonmail.com", "mail.com", "qtc-energy.com",
        ];
        for single_email in clean_email.split([',', ';']) {
            if let Some(domain) = single_email.trim().split('@').nth(1).map(|d| d.trim().to_lowercase()) {
                if !domain.is_empty() && !GENERIC_DOMAINS.contains(&domain.as_str()) {
                    self.record_learning_signal("email_domain", &domain, clean_comp, Some(single_email.trim()), 8.0)?;
                    signals_learned += 1;
                }
            }
        }

        // Helper to test whether two supplier names represent the same entity (same or cross-script)
        let is_same_entity = |a: &str, b: &str| -> bool {
            let ca = ThaiNormalizer::clean_company_name(a);
            let cb = ThaiNormalizer::clean_company_name(b);
            if ca.is_empty() || cb.is_empty() {
                return false;
            }
            if ca == cb || ca.contains(&cb) || cb.contains(&ca) {
                return true;
            }
            let sk_a = ThaiNormalizer::phonetic_skeleton(&ca);
            let sk_b = ThaiNormalizer::phonetic_skeleton(&cb);
            if !sk_a.is_empty() && sk_a == sk_b {
                return true;
            }
            let rom_a = ThaiNormalizer::romanize_thai(&ca);
            let rom_b = ThaiNormalizer::romanize_thai(&cb);
            CompanyMatcher::similarity_ratio(&ca, &cb) >= 50.0
                || CompanyMatcher::similarity_ratio(&rom_a, &rom_b) >= 50.0
        };

        // 5. Analyze detected raw company: positive alias or negative false-positive blacklist
        let was_auto_matched = job
            .matched_company_name
            .as_deref()
            .map(|m| m.eq_ignore_ascii_case(clean_comp))
            .unwrap_or(false);

        if let Some(ref det_raw) = job.detected_company_raw {
            let det_trim = det_raw.trim();
            if !det_trim.is_empty() && !ThaiNormalizer::is_ignored_self_company(det_trim) {
                if is_same_entity(det_trim, clean_comp) {
                    let det_type = if ThaiNormalizer::contains_thai(det_trim) {
                        "thai_name"
                    } else {
                        "english_name"
                    };
                    self.record_learning_signal(det_type, det_trim, clean_comp, Some(clean_email), 12.0)?;
                    if !det_trim.eq_ignore_ascii_case(clean_comp) {
                        self.add_company_alias(det_trim, clean_comp, "SELF_LEARN")?;
                    }
                    signals_learned += 1;
                } else {
                    // Overridden wrong guess -> blacklist so OCR stops picking this line as a supplier
                    self.record_learning_signal("negative_phrase", det_trim, "", None, 0.0)?;
                    signals_learned += 1;
                }
            }
        }

        // Link bilingual counterpart (Thai <-> English) when same entity or confirmed match
        if let Some(ref alt) = alt_name {
            if is_same_entity(alt, clean_comp) || was_auto_matched {
                let alt_type = if ThaiNormalizer::contains_thai(alt) {
                    "thai_name"
                } else {
                    "english_name"
                };
                self.record_learning_signal(alt_type, alt, clean_comp, Some(clean_email), 10.0)?;
                if !alt.eq_ignore_ascii_case(clean_comp) {
                    self.add_company_alias(alt, clean_comp, "SELF_LEARN")?;
                }
                signals_learned += 1;
            }
        }

        // 6. Spatial vertical layout zone memory from bounding boxes
        let clean_app_tokens: Vec<String> = ThaiNormalizer::clean_company_name(clean_comp)
            .split_whitespace()
            .filter(|w| w.chars().count() >= 3)
            .map(|w| w.to_lowercase())
            .collect();

        'box_search: for rec in &ocr_records {
            if let Ok(boxes) = serde_json::from_str::<Vec<serde_json::Value>>(&rec.bounding_boxes_json) {
                let max_y = boxes
                    .iter()
                    .filter_map(|b| b.get("box").and_then(|v| v.as_array()))
                    .flat_map(|pts| pts.iter())
                    .filter_map(|p| p.get(1).and_then(|y| y.as_f64()))
                    .fold(842.0_f64, f64::max);

                for b in &boxes {
                    let b_text = b.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    let b_clean = ThaiNormalizer::clean_company_name(b_text).to_lowercase();
                    if b_clean.is_empty() {
                        continue;
                    }
                    let hit = (!clean_app_tokens.is_empty()
                        && clean_app_tokens.iter().any(|tok| b_clean.contains(tok)))
                        || job
                            .detected_company_raw
                            .as_ref()
                            .map(|d| !d.is_empty() && b_text.contains(d.trim()))
                            .unwrap_or(false);
                    if hit {
                        if let Some(y0) = b
                            .get("box")
                            .and_then(|v| v.as_array())
                            .and_then(|pts| pts.first())
                            .and_then(|pt| pt.get(1))
                            .and_then(|y| y.as_f64())
                        {
                            let y_norm = (y0 / max_y.max(1.0)).clamp(0.0, 1.0);
                            let band = format!("{:.2}", y_norm);
                            self.record_learning_signal(
                                "layout_zone",
                                &band,
                                clean_comp,
                                Some(clean_email),
                                5.0,
                            )?;
                            signals_learned += 1;
                            break 'box_search;
                        }
                    }
                }
            }
        }

        Ok(signals_learned)
    }

    pub fn get_all_ui_state(&self) -> Result<std::collections::HashMap<String, String>, DbError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT state_key, state_json FROM ui_state")?;
        let rows = stmt.query_map([], |row| {
            let k: String = row.get(0)?;
            let v: String = row.get(1)?;
            Ok((k, v))
        })?;
        let mut map = std::collections::HashMap::new();
        for r in rows {
            let (k, v) = r?;
            map.insert(k, v);
        }
        Ok(map)
    }

    pub fn set_ui_state(&self, key: &str, state_json: &str) -> Result<(), DbError> {
        let trimmed = key.trim();
        if trimmed.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            r#"
            INSERT INTO ui_state (state_key, state_json, updated_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(state_key) DO UPDATE SET
                state_json = excluded.state_json,
                updated_at = excluded.updated_at
            "#,
            params![trimmed, state_json, now],
        )?;
        Ok(())
    }

    /// Removes a PO queue item and its derived OCR/file/event rows while keeping
    /// historical `po_transactions` records so duplicate-send protection remains intact.
    pub fn delete_job(&self, job_id: &str) -> Result<Option<Job>, DbError> {
        let existing = self.get_job(job_id)?;
        let Some(job) = existing else {
            return Ok(None);
        };

        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM application_events WHERE job_id = ?1", params![job_id])?;
        tx.execute("DELETE FROM ocr_results WHERE job_id = ?1", params![job_id])?;
        tx.execute("DELETE FROM processed_files WHERE job_id = ?1", params![job_id])?;
        tx.execute("DELETE FROM jobs WHERE id = ?1", params![job_id])?;
        tx.commit()?;

        Ok(Some(job))
    }
}

