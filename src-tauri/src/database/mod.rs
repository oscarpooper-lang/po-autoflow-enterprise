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
            "#,
        )?;

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
                match_confidence, match_category, archive_path, archive_sha256,
                archive_size_bytes, drive_file_id, drive_web_link, email_transaction_id,
                retry_count, error_details, created_at, updated_at, completed_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22
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
                match_confidence = ?10,
                match_category = ?11,
                archive_path = ?12,
                archive_sha256 = ?13,
                archive_size_bytes = ?14,
                drive_file_id = ?15,
                drive_web_link = ?16,
                email_transaction_id = ?17,
                retry_count = ?18,
                error_details = ?19,
                updated_at = ?20,
                completed_at = ?21
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
            match_confidence: row.get(9)?,
            match_category: row.get(10)?,
            archive_path: row.get(11)?,
            archive_sha256: row.get(12)?,
            archive_size_bytes: row.get(13)?,
            drive_file_id: row.get(14)?,
            drive_web_link: row.get(15)?,
            email_transaction_id: row.get(16)?,
            retry_count: row.get(17)?,
            error_details: row.get(18)?,
            created_at: row.get(19)?,
            updated_at: row.get(20)?,
            completed_at: row.get(21)?,
        })
    }

    pub fn get_job(&self, id: &str) -> Result<Option<Job>, DbError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT
                id, po_folder_name, source_path, status, stage_message,
                po_number, detected_company_raw, matched_company_name, matched_email,
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
        let tx = conn.transaction()?;

        tx.execute("DELETE FROM companies_cache", [])?;

        for c in entries {
            tx.execute(
                r#"
                INSERT INTO companies_cache (
                    id, company_name, alternative_name, email,
                    active, tax_id, notes, synced_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                "#,
                params![
                    c.id,
                    c.company_name,
                    c.alternative_name,
                    c.email,
                    if c.active { 1 } else { 0 },
                    c.tax_id,
                    c.notes,
                    c.synced_at
                ],
            )?;
        }

        tx.commit()?;
        Ok(())
    }

    pub fn get_companies_cache(&self) -> Result<Vec<CompanyCacheEntry>, DbError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT
                id, company_name, alternative_name, email,
                active, tax_id, notes, synced_at
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
                synced_at: row.get(7)?,
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
}

