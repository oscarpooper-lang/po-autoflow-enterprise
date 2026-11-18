use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Instant;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::commands::{
    builtin_vision_presets_summary, resolve_builtin_server_paths, resolve_builtin_vision_paths,
};
use crate::database::models::{
    AppSettings, CompanyCacheEntry, DashboardStats, DepartmentCcEntry, Job,
};
use crate::database::Database;
use crate::matching::thai_normalizer::ThaiNormalizer;
use crate::matching::CompanyMatcher;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatHistoryMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiMatchedJob {
    pub id: String,
    pub po_folder_name: String,
    pub po_number: Option<String>,
    pub status: String,
    pub stage_message: String,
    pub detected_company_raw: Option<String>,
    pub matched_company_name: Option<String>,
    pub matched_email: Option<String>,
    pub matched_department: Option<String>,
    pub department_cc_emails: Option<String>,
    pub match_confidence: Option<f64>,
    pub match_category: Option<String>,
    pub error_details: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiMatchedCompany {
    pub company_name: String,
    pub alternative_name: Option<String>,
    pub tax_id: Option<String>,
    pub email: String,
    pub vendor_group: Option<String>,
    pub aliases: Vec<String>,
    pub proofing_notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiMatchedDepartment {
    pub department_no: String,
    pub department_name: String,
    pub emails: String,
}

#[derive(Debug, Clone)]
pub struct AiContextBundle {
    pub system_grounding_prompt: String,
    pub matched_jobs: Vec<AiMatchedJob>,
    pub matched_companies: Vec<AiMatchedCompany>,
    pub matched_departments: Vec<AiMatchedDepartment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiAssistantResponse {
    pub answer: String,
    pub model_used: String,
    pub engine_mode: String,
    pub ai_available: bool,
    pub used_vision_image: bool,
    pub duration_ms: u64,
    pub note: Option<String>,
    pub matched_jobs: Vec<AiMatchedJob>,
    pub matched_companies: Vec<AiMatchedCompany>,
    pub matched_departments: Vec<AiMatchedDepartment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiChatStatus {
    pub ready: bool,
    pub provider: String,
    pub active_model_id: String,
    pub active_model_name: String,
    pub server_running: bool,
    pub server_running_model: Option<String>,
    pub server_port: Option<u16>,
    pub has_vulkan: bool,
    pub llama_server_installed: bool,
    pub installed_models: Vec<String>,
    pub message: String,
}

struct RunningLlamaServer {
    child: Child,
    port: u16,
    model_id: String,
    root_dir: String,
    using_vulkan: bool,
}

impl Drop for RunningLlamaServer {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

#[derive(Clone)]
pub struct AiServerManager {
    server: Arc<Mutex<Option<RunningLlamaServer>>>,
    inference_lock: Arc<Mutex<()>>,
}

impl Default for AiServerManager {
    fn default() -> Self {
        Self::new()
    }
}

impl AiServerManager {
    pub fn new() -> Self {
        Self {
            server: Arc::new(Mutex::new(None)),
            inference_lock: Arc::new(Mutex::new(())),
        }
    }

    pub async fn stop(&self) {
        let mut guard = self.server.lock().await;
        if let Some(mut srv) = guard.take() {
            let _ = srv.child.kill().await;
            info!("Stopped persistent llama-server (model={})", srv.model_id);
        }
    }

    pub async fn running_snapshot(&self) -> (bool, Option<String>, Option<u16>, bool) {
        let mut guard = self.server.lock().await;
        if let Some(srv) = guard.as_mut() {
            match srv.child.try_wait() {
                Ok(None) => {
                    return (
                        true,
                        Some(srv.model_id.clone()),
                        Some(srv.port),
                        srv.using_vulkan,
                    );
                }
                _ => {
                    *guard = None;
                }
            }
        }
        (false, None, None, false)
    }

    async fn ensure_server_ready(
        &self,
        root_dir: &str,
        model_id: &str,
        server_exe: &Path,
        model_path: &Path,
        mmproj_path: &Path,
        has_vulkan: bool,
    ) -> Result<(u16, bool), String> {
        {
            let mut guard = self.server.lock().await;
            if let Some(srv) = guard.as_mut() {
                let alive = matches!(srv.child.try_wait(), Ok(None));
                if alive
                    && srv.model_id == model_id
                    && srv.root_dir.eq_ignore_ascii_case(root_dir)
                {
                    return Ok((srv.port, srv.using_vulkan));
                }
                if let Some(mut old) = guard.take() {
                    let _ = old.child.kill().await;
                }
            }
        }

        let gpu_modes: Vec<bool> = if has_vulkan { vec![true, false] } else { vec![false] };
        let mut last_err = String::new();

        for use_gpu in gpu_modes {
            match spawn_and_wait_llama_server(
                server_exe,
                model_path,
                mmproj_path,
                model_id,
                root_dir,
                use_gpu,
            )
            .await
            {
                Ok(srv) => {
                    let port = srv.port;
                    let gpu_active = srv.using_vulkan;
                    let mut guard = self.server.lock().await;
                    *guard = Some(srv);
                    return Ok((port, gpu_active));
                }
                Err(e) => {
                    warn!(
                        "llama-server failed to start (model={}, gpu={}): {}",
                        model_id, use_gpu, e
                    );
                    last_err = e;
                }
            }
        }

        Err(last_err)
    }
}

fn allocate_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed allocating loopback TCP port: {}", e))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| format!("Failed reading allocated TCP port: {}", e))
}

async fn spawn_and_wait_llama_server(
    server_exe: &Path,
    model_path: &Path,
    mmproj_path: &Path,
    model_id: &str,
    root_dir: &str,
    use_gpu: bool,
) -> Result<RunningLlamaServer, String> {
    let port = allocate_loopback_port()?;
    let engine_dir = server_exe
        .parent()
        .ok_or_else(|| "Invalid llama-server path".to_string())?;

    let mut cmd = Command::new(server_exe);
    cmd.arg("-m")
        .arg(model_path)
        .arg("--mmproj")
        .arg(mmproj_path)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .arg("-c")
        .arg("8192")
        .arg("--image-max-tokens")
        .arg("640")
        .arg("-t")
        .arg("6")
        .arg("-ngl")
        .arg(if use_gpu { "99" } else { "0" })
        .arg("--jinja")
        .current_dir(engine_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed spawning llama-server.exe: {}", e))?;

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(2))
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| format!("Failed creating health HTTP client: {}", e))?;

    let health_url = format!("http://127.0.0.1:{}/health", port);
    let started = Instant::now();
    let max_wait = std::time::Duration::from_secs(45);

    loop {
        if let Ok(Some(exit_status)) = child.try_wait() {
            let mut err_buf = String::new();
            if let Some(mut stderr) = child.stderr.take() {
                use tokio::io::AsyncReadExt;
                let mut bytes = Vec::new();
                let _ = tokio::time::timeout(
                    std::time::Duration::from_millis(250),
                    stderr.read_to_end(&mut bytes),
                )
                .await;
                err_buf = String::from_utf8_lossy(&bytes)
                    .lines()
                    .rev()
                    .take(4)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join(" | ");
            }
            return Err(format!(
                "llama-server exited prematurely ({:?}): {}",
                exit_status.code(),
                if err_buf.is_empty() {
                    "no stderr output".to_string()
                } else {
                    err_buf
                }
            ));
        }

        if let Ok(resp) = client.get(&health_url).send().await {
            if resp.status().is_success() {
                info!(
                    "Persistent llama-server ready on 127.0.0.1:{} (model={}, gpu={}, startup={}ms)",
                    port,
                    model_id,
                    use_gpu,
                    started.elapsed().as_millis()
                );
                return Ok(RunningLlamaServer {
                    child,
                    port,
                    model_id: model_id.to_string(),
                    root_dir: root_dir.to_string(),
                    using_vulkan: use_gpu,
                });
            }
        }

        if started.elapsed() >= max_wait {
            let _ = child.kill().await;
            return Err("Timed out waiting 45s for llama-server /health readiness".to_string());
        }

        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}

pub fn clean_ai_reply_text(raw: &str) -> String {
    if raw.trim().is_empty() {
        return String::new();
    }
    let complete_think = Regex::new(r"(?is)<think>[\s\S]*?</think>").unwrap();
    let stripped = complete_think.replace_all(raw, "");
    let unclosed_think = Regex::new(r"(?is)<think>[\s\S]*$").unwrap();
    let final_clean = unclosed_think.replace_all(&stripped, "");
    let trimmed = final_clean.trim();
    if !trimmed.is_empty() {
        trimmed.to_string()
    } else {
        raw.trim().to_string()
    }
}

pub fn is_localhost_url(endpoint: &str) -> bool {
    let trimmed = endpoint.trim().to_lowercase();
    let rest = trimmed
        .strip_prefix("http://")
        .or_else(|| trimmed.strip_prefix("https://"))
        .unwrap_or("");
    let host_port = rest.split('/').next().unwrap_or("");
    let host = if let Some(stripped) = host_port.strip_prefix('[') {
        stripped.split(']').next().unwrap_or("")
    } else {
        host_port.split(':').next().unwrap_or("")
    };
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}

pub fn list_installed_builtin_models(root_dir: &str) -> Vec<String> {
    builtin_vision_presets_summary()
        .into_iter()
        .filter_map(|(id, _, _, _, _)| {
            let (_, model_path, mmproj_path) = resolve_builtin_vision_paths(root_dir, id);
            let m_ok = std::fs::metadata(&model_path)
                .map(|m| m.len() > 1_000_000)
                .unwrap_or(false);
            let p_ok = std::fs::metadata(&mmproj_path)
                .map(|m| m.len() > 1_000_000)
                .unwrap_or(false);
            if m_ok && p_ok {
                Some(id.to_string())
            } else {
                None
            }
        })
        .collect()
}

/// Picks the best installed built-in model ID, preferring `configured_id` first, then stronger chat+vision models.
pub fn select_best_installed_builtin_model(root_dir: &str, configured_id: &str) -> Option<String> {
    let installed = list_installed_builtin_models(root_dir);
    if installed.is_empty() {
        return None;
    }
    if installed.iter().any(|id| id == configured_id.trim()) {
        return Some(configured_id.trim().to_string());
    }
    let priority = [
        "qwen3-vl-4b",
        "qwen3-vl-2b",
        "lfm3-vl-2b",
        "qwen2.5-vl-3b",
        "gemma-4-e2b",
        "typhoon-ocr-3b",
        "smolvlm2-2.2b",
        "smolvlm2-500m",
    ];
    for pref in priority {
        if installed.iter().any(|id| id == pref) {
            return Some(pref.to_string());
        }
    }
    installed.into_iter().next()
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars {
        return text.to_string();
    }
    let clipped: String = text.chars().take(max_chars).collect();
    format!("{}... [truncated]", clipped)
}

fn extract_query_tokens(query: &str) -> (String, Vec<String>, Vec<String>) {
    let norm = ThaiNormalizer::normalize_unicode(query).to_lowercase();
    let stop_words: HashSet<&str> = [
        "find", "search", "show", "list", "get", "what", "which", "who", "why", "is", "are",
        "the", "for", "of", "in", "on", "to", "a", "an", "and", "or", "with", "about", "this",
        "that", "me", "my", "please", "tell", "give", "check", "can", "you", "do", "does", "did",
        "po", "email", "emails", "company", "companies", "supplier", "vendor", "dept",
        "department", "cc", "status", "pdf", "หา", "ค้นหา", "ขอ", "ดู", "แสดง", "อะไร", "คือ",
        "ไหน", "ใคร", "ทำไม", "ที่", "ของ", "ใน", "ให้", "หน่อย", "ช่วย", "บริษัท", "ผู้ขาย",
        "อีเมล", "เมล", "แผนก", "ฝ่าย", "ใบ", "ใบสั่งซื้อ", "สถานะ", "นี้", "บ้าง", "มี", "ไหม",
    ]
    .into_iter()
    .collect();

    let splitter = Regex::new(r"[\s,;:/\\|()\[\]{}<>?!\x22']+").unwrap();
    let mut all_tokens = Vec::new();
    let mut focused_tokens = Vec::new();
    let mut seen_all = HashSet::new();
    let mut seen_focused = HashSet::new();

    for raw_part in splitter.split(&norm) {
        let tok = raw_part.trim();
        if tok.chars().count() < 2 {
            continue;
        }
        if seen_all.insert(tok.to_string()) {
            all_tokens.push(tok.to_string());
        }
        if !stop_words.contains(tok) && seen_focused.insert(tok.to_string()) {
            focused_tokens.push(tok.to_string());
        }
    }

    (norm, focused_tokens, all_tokens)
}

fn detect_status_filter(q_norm: &str) -> Option<&'static str> {
    if [
        "review",
        "pending",
        "รอตรวจ",
        "รอตรวจสอบ",
        "ค้าง",
        "manual",
        "อนุมัติ",
    ]
    .iter()
    .any(|kw| q_norm.contains(kw))
    {
        return Some("needs_review");
    }
    if ["fail", "error", "ผิดพลาด", "ล้มเหลว", "ส่งไม่ผ่าน"]
        .iter()
        .any(|kw| q_norm.contains(kw))
    {
        return Some("failed");
    }
    if ["sent", "completed", "ส่งแล้ว", "สำเร็จ", "เรียบร้อย"]
        .iter()
        .any(|kw| q_norm.contains(kw))
    {
        return Some("completed");
    }
    if ["waiting", "processing", "queued", "กำลังทำ", "รอดำเนินการ"]
        .iter()
        .any(|kw| q_norm.contains(kw))
    {
        return Some("waiting");
    }
    None
}

fn wants_summary_or_recent(q_norm: &str) -> bool {
    [
        "summary", "overview", "recent", "latest", "all po", "how many", "stats", "today",
        "สรุป", "ล่าสุด", "ทั้งหมด", "กี่ใบ", "วันนี้", "ภาพรวม",
    ]
    .iter()
    .any(|kw| q_norm.contains(kw))
}

fn score_company_entry(
    company: &CompanyCacheEntry,
    aliases: &[String],
    q_norm: &str,
    tokens: &[String],
) -> i32 {
    let mut score = 0;
    let name_l = ThaiNormalizer::normalize_unicode(&company.company_name).to_lowercase();
    let alt_l = company
        .alternative_name
        .as_deref()
        .map(|s| ThaiNormalizer::normalize_unicode(s).to_lowercase())
        .unwrap_or_default();
    let email_l = company.email.to_lowercase();
    let tax_l = company.tax_id.as_deref().unwrap_or("").to_lowercase();
    let notes_l = company.notes.as_deref().unwrap_or("").to_lowercase();

    for tok in tokens {
        if tok.chars().count() >= 10 && !tax_l.is_empty() && tax_l.contains(tok) {
            score += 200;
        }
        if !name_l.is_empty() && name_l.contains(tok) {
            score += 75;
        }
        if !alt_l.is_empty() && alt_l.contains(tok) {
            score += 65;
        }
        if !email_l.is_empty() && email_l.contains(tok) {
            score += 70;
        }
        if !notes_l.is_empty() && notes_l.contains(tok) {
            score += 45;
        }
        if aliases.iter().any(|a| a.to_lowercase().contains(tok)) {
            score += 70;
        }
    }

    // Whole-query fuzzy boost against company name / alternative name when tokens weren't exact Thai word-split
    let query_focus = if tokens.is_empty() {
        q_norm.to_string()
    } else {
        tokens.join(" ")
    };
    if query_focus.chars().count() >= 3 {
        let sim_main = CompanyMatcher::token_set_ratio(&query_focus, &name_l);
        if sim_main >= 62.0 {
            score += (sim_main * 0.9) as i32;
        }
        if !alt_l.is_empty() {
            let sim_alt = CompanyMatcher::token_set_ratio(&query_focus, &alt_l);
            if sim_alt >= 62.0 {
                score += (sim_alt * 0.85) as i32;
            }
        }
        if !name_l.is_empty() && q_norm.contains(&name_l) {
            score += 140;
        }
    }

    score
}

fn to_matched_job(job: &Job) -> AiMatchedJob {
    AiMatchedJob {
        id: job.id.clone(),
        po_folder_name: job.po_folder_name.clone(),
        po_number: job.po_number.clone(),
        status: job.status.clone(),
        stage_message: job.stage_message.clone(),
        detected_company_raw: job.detected_company_raw.clone(),
        matched_company_name: job.matched_company_name.clone(),
        matched_email: job.matched_email.clone(),
        matched_department: job.matched_department.clone(),
        department_cc_emails: job.department_cc_emails.clone(),
        match_confidence: job.match_confidence,
        match_category: job.match_category.clone(),
        error_details: job.error_details.clone(),
        created_at: job.created_at.clone(),
    }
}

/// Deterministically searches live SQLite procurement records so smaller 2B-4B models stay 100% grounded.
pub fn gather_procurement_context(
    db: &Database,
    query: &str,
    focus_job_id: Option<&str>,
) -> AiContextBundle {
    let (q_norm, focused_tokens, all_tokens) = extract_query_tokens(query);
    let search_tokens = if focused_tokens.is_empty() {
        &all_tokens
    } else {
        &focused_tokens
    };

    let stats = db.get_dashboard_stats().unwrap_or(DashboardStats {
        total_processed: 0,
        successfully_sent: 0,
        waiting_processing: 0,
        needs_review: 0,
        failed_transactions: 0,
        success_rate_percent: 0.0,
        avg_ocr_confidence: 0.0,
    });
    let jobs = db.list_jobs(300, 0).unwrap_or_default();
    let companies = db.get_companies_cache().unwrap_or_default();
    let aliases = db.get_company_aliases().unwrap_or_default();
    let departments = db.get_department_cc_cache().unwrap_or_default();
    let transactions = db.list_transactions(60, 0).unwrap_or_default();

    // Group aliases by canonical company name
    let mut alias_map: HashMap<String, Vec<String>> = HashMap::new();
    for a in &aliases {
        alias_map
            .entry(a.canonical_company_name.to_lowercase())
            .or_default()
            .push(a.alias.clone());
    }

    // 1. Retrieve matching suppliers
    let mut scored_companies: Vec<(i32, &CompanyCacheEntry, Vec<String>)> = companies
        .iter()
        .filter_map(|c| {
            let co_aliases = alias_map
                .get(&c.company_name.to_lowercase())
                .cloned()
                .unwrap_or_default();
            let s = score_company_entry(c, &co_aliases, &q_norm, search_tokens);
            if s >= 55 {
                Some((s, c, co_aliases))
            } else {
                None
            }
        })
        .collect();
    scored_companies.sort_by(|a, b| b.0.cmp(&a.0));
    scored_companies.truncate(6);

    let matched_company_names_lower: Vec<String> = scored_companies
        .iter()
        .map(|(_, c, _)| c.company_name.to_lowercase())
        .collect();

    let matched_companies: Vec<AiMatchedCompany> = scored_companies
        .into_iter()
        .map(|(_, c, co_aliases)| {
            let proofing_notes = c
                .notes
                .as_deref()
                .map(|n| {
                    n.split(['|', '\n', ';'])
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            AiMatchedCompany {
                company_name: c.company_name.clone(),
                alternative_name: c.alternative_name.clone(),
                tax_id: c.tax_id.clone(),
                email: c.email.clone(),
                vendor_group: c.vendor_group.clone(),
                aliases: co_aliases,
                proofing_notes,
            }
        })
        .collect();

    // 2. Retrieve matching departments for CC
    let mut dept_scores: Vec<(i32, &DepartmentCcEntry)> = Vec::new();
    let query_vec = vec![query.to_string()];
    let (best_dept_name, _) = CompanyMatcher::match_department_cc(&query_vec, &departments);
    for d in &departments {
        let mut s = 0;
        if let Some(ref matched_name) = best_dept_name {
            if matched_name.eq_ignore_ascii_case(&d.department_name) {
                s += 220;
            }
        }
        let name_l = ThaiNormalizer::normalize_unicode(&d.department_name).to_lowercase();
        let emails_l = d.emails.to_lowercase();
        let id_l = d.id.to_lowercase();
        for tok in search_tokens {
            if !name_l.is_empty() && name_l.contains(tok) {
                s += 80;
            }
            if !emails_l.is_empty() && emails_l.contains(tok) {
                s += 60;
            }
            if id_l == *tok {
                s += 50;
            }
        }
        if !name_l.is_empty() && q_norm.contains(&name_l) {
            s += 150;
        }
        if s >= 50 {
            dept_scores.push((s, d));
        }
    }
    dept_scores.sort_by(|a, b| b.0.cmp(&a.0));
    dept_scores.truncate(5);
    let matched_departments: Vec<AiMatchedDepartment> = dept_scores
        .into_iter()
        .map(|(_, d)| AiMatchedDepartment {
            department_no: d.id.clone(),
            department_name: d.department_name.clone(),
            emails: d.emails.clone(),
        })
        .collect();

    // 3. Retrieve matching PO jobs
    let status_filter = detect_status_filter(&q_norm);
    let summary_mode = wants_summary_or_recent(&q_norm);

    let mut scored_jobs: Vec<(i32, usize, &Job)> = jobs
        .iter()
        .enumerate()
        .filter_map(|(idx, job)| {
            let mut score = 0;
            if focus_job_id == Some(job.id.as_str()) {
                score += 10_000;
            }
            let po_l = job.po_number.as_deref().unwrap_or("").to_lowercase();
            let folder_l = job.po_folder_name.to_lowercase();
            let comp_l = job
                .matched_company_name
                .as_deref()
                .unwrap_or("")
                .to_lowercase();
            let raw_l = job
                .detected_company_raw
                .as_deref()
                .unwrap_or("")
                .to_lowercase();
            let dept_l = job
                .matched_department
                .as_deref()
                .unwrap_or("")
                .to_lowercase();
            let err_l = job.error_details.as_deref().unwrap_or("").to_lowercase();
            let stage_l = job.stage_message.to_lowercase();

            if !po_l.is_empty() && q_norm.contains(&po_l) {
                score += 500;
            }
            if !folder_l.is_empty() && q_norm.contains(&folder_l) {
                score += 450;
            }

            for tok in search_tokens {
                if !po_l.is_empty() && po_l.contains(tok) {
                    score += 180;
                }
                if !folder_l.is_empty() && folder_l.contains(tok) {
                    score += 150;
                }
                if !comp_l.is_empty() && comp_l.contains(tok) {
                    score += 90;
                }
                if !raw_l.is_empty() && raw_l.contains(tok) {
                    score += 75;
                }
                if !dept_l.is_empty() && dept_l.contains(tok) {
                    score += 65;
                }
                if !err_l.is_empty() && err_l.contains(tok) {
                    score += 45;
                }
                if stage_l.contains(tok) {
                    score += 35;
                }
            }

            if !comp_l.is_empty() && matched_company_names_lower.iter().any(|mc| mc == &comp_l) {
                score += 140;
            }

            if let Some(st) = status_filter {
                let job_st = job.status.to_lowercase();
                let matches_status = match st {
                    "needs_review" => job_st == "needs_review" || job_st == "review",
                    "failed" => job_st == "failed",
                    "completed" => job_st == "completed" || job_st == "sent",
                    "waiting" => matches!(
                        job_st.as_str(),
                        "waiting" | "queued" | "processing" | "ocr_running" | "sending"
                    ),
                    _ => false,
                };
                if matches_status {
                    score += 160;
                }
            }

            if score == 0 && (summary_mode || status_filter.is_some()) {
                // Only include recent jobs when the user asks for an overview/summary or status list without hitting other records
                if status_filter.is_none() && idx < 6 {
                    score = 15 - idx as i32;
                }
            }

            if score > 0 {
                Some((score, idx, job))
            } else {
                None
            }
        })
        .collect();

    scored_jobs.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    scored_jobs.truncate(8);

    let matched_jobs: Vec<AiMatchedJob> = scored_jobs.iter().map(|(_, _, j)| to_matched_job(j)).collect();

    // Pick a primary job whose full OCR text & files should be included in the prompt
    let detailed_job_id: Option<String> = focus_job_id
        .map(str::to_string)
        .or_else(|| {
            scored_jobs
                .first()
                .filter(|(score, _, _)| *score >= 300)
                .map(|(_, _, j)| j.id.clone())
        });

    // 4. Construct concise grounded system prompt
    let mut ctx = String::new();
    ctx.push_str(
        "You are the built-in AI assistant inside PO AutoFlow Enterprise (procurement PO automation for QTC Energy).\n\
        Answer helpfully and concisely in the same language the user used (Thai or English).\n\
        STRICT GROUNDING RULES:\n\
        - ONLY state PO numbers, statuses, supplier names, emails, Tax IDs, totals, and Department CCs that appear verbatim in LIVE DATABASE CONTEXT below or are directly visible in an attached document image.\n\
        - NEVER invent or guess emails, PO numbers, totals, or company names.\n\
        - If a requested record is not present below, clearly say it was not found in the local database/cache.\n\n",
    );

    ctx.push_str(&format!(
        "[SYSTEM METRICS]\n\
        Total POs tracked: {} | Completed/Sent: {} | Needs Review: {} | Failed: {} | Waiting: {} | Success Rate: {:.1}%\n\
        Directory Cache: {} suppliers | {} department CC rules | {} custom aliases\n\n",
        stats.total_processed,
        stats.successfully_sent,
        stats.needs_review,
        stats.failed_transactions,
        stats.waiting_processing,
        stats.success_rate_percent,
        companies.len(),
        departments.len(),
        aliases.len(),
    ));

    if !matched_jobs.is_empty() {
        ctx.push_str("[MATCHED / RELEVANT PO JOBS]\n");
        for j in &matched_jobs {
            ctx.push_str(&format!(
                "- Folder: '{}' | PO: {} | Status: {} | Stage: {} | Supplier: {} (raw OCR: {}) | Email: {} | Dept CC: {} ({}) | Conf: {:.0}%{}\n",
                j.po_folder_name,
                j.po_number.as_deref().unwrap_or("-"),
                j.status,
                j.stage_message,
                j.matched_company_name.as_deref().unwrap_or("-"),
                j.detected_company_raw.as_deref().unwrap_or("-"),
                j.matched_email.as_deref().unwrap_or("-"),
                j.matched_department.as_deref().unwrap_or("-"),
                j.department_cc_emails.as_deref().unwrap_or("-"),
                j.match_confidence.unwrap_or(0.0),
                j.error_details
                    .as_deref()
                    .filter(|e| !e.is_empty())
                    .map(|e| format!(" | Error: {}", truncate_chars(e, 180)))
                    .unwrap_or_default(),
            ));
        }
        ctx.push('\n');
    }

    if !matched_companies.is_empty() {
        ctx.push_str("[MATCHED SUPPLIER DIRECTORY ENTRIES]\n");
        for c in &matched_companies {
            ctx.push_str(&format!(
                "- {} (Alt: {}, Group: {}, TaxID: {}) -> Email: {}{}{}\n",
                c.company_name,
                c.alternative_name.as_deref().unwrap_or("-"),
                c.vendor_group.as_deref().unwrap_or("-"),
                c.tax_id.as_deref().unwrap_or("-"),
                if c.email.is_empty() { "(no email)" } else { &c.email },
                if c.aliases.is_empty() {
                    String::new()
                } else {
                    format!(" | Aliases: {}", c.aliases.join(", "))
                },
                if c.proofing_notes.is_empty() {
                    String::new()
                } else {
                    format!(" | Notes: {}", c.proofing_notes.join(" / "))
                },
            ));
        }
        ctx.push('\n');
    }

    if !matched_departments.is_empty() {
        ctx.push_str("[MATCHED DEPARTMENT AUTO-CC RULES]\n");
        for d in &matched_departments {
            ctx.push_str(&format!(
                "- No.{}: {} -> CC: {}\n",
                d.department_no, d.department_name, d.emails
            ));
        }
        ctx.push('\n');
    }

    if let Some(ref fid) = detailed_job_id {
        if let Ok(Some(job)) = db.get_job(fid) {
            ctx.push_str(&format!(
                "[FOCUSED PO DOCUMENT DETAILS: {}]\nFolder: {} | PO#: {} | Status: {} | Stage: {}\n",
                job.id,
                job.po_folder_name,
                job.po_number.as_deref().unwrap_or("-"),
                job.status,
                job.stage_message,
            ));

            if let Ok(files) = db.get_processed_files_for_job(fid) {
                if !files.is_empty() {
                    let names: Vec<String> = files
                        .iter()
                        .take(10)
                        .map(|f| format!("{} ({}p, {})", f.relative_path, f.page_count, f.extraction_method))
                        .collect();
                    ctx.push_str(&format!("Files: {}\n", names.join(", ")));
                }
            }

            if let Some(tx) = transactions.iter().find(|t| t.job_id == *fid) {
                ctx.push_str(&format!(
                    "Latest Email Tx: status={} | to={} | sent_at={}\n",
                    tx.status, tx.recipient_email, tx.sent_at
                ));
            }

            if let Ok(ocr_records) = db.get_ocr_results_for_job(fid) {
                let mut combined_ocr = String::new();
                for rec in ocr_records.iter().take(3) {
                    let body = if rec.normalized_text.trim().is_empty() {
                        rec.raw_text.trim()
                    } else {
                        rec.normalized_text.trim()
                    };
                    if body.is_empty() {
                        continue;
                    }
                    combined_ocr.push_str(&format!(
                        "--- {} (Page {}, Engine: {}, Conf: {:.0}%) ---\n{}\n",
                        rec.file_path, rec.page_number, rec.engine, rec.confidence, body
                    ));
                    if combined_ocr.chars().count() >= 3200 {
                        break;
                    }
                }
                if !combined_ocr.is_empty() {
                    ctx.push_str(&format!(
                        "Extracted Document Text:\n{}\n",
                        truncate_chars(&combined_ocr, 3200)
                    ));
                }
            }
            ctx.push('\n');
        }
    }

    AiContextBundle {
        system_grounding_prompt: ctx,
        matched_jobs,
        matched_companies,
        matched_departments,
    }
}

pub fn build_ai_chat_status_snapshot(
    settings: &AppSettings,
    running_info: (bool, Option<String>, Option<u16>, bool),
) -> AiChatStatus {
    let models_dir = PathBuf::from(&settings.root_dir).join("Models");
    let engine_dir = models_dir.join("engine");
    let server_exe_installed = engine_dir.join("llama-server.exe").exists();
    let has_vulkan = engine_dir.join("ggml-vulkan.dll").exists();
    let installed_models = list_installed_builtin_models(&settings.root_dir);

    let (server_running, server_running_model, server_port, server_gpu) = running_info;
    let prov = settings.local_vision_provider.trim().to_lowercase();

    if prov == "ollama" {
        let local_ok = is_localhost_url(&settings.local_vision_endpoint);
        return AiChatStatus {
            ready: local_ok && !settings.local_vision_model.trim().is_empty(),
            provider: "ollama".to_string(),
            active_model_id: settings.local_vision_model.clone(),
            active_model_name: format!("Ollama: {}", settings.local_vision_model),
            server_running: local_ok,
            server_running_model: Some(settings.local_vision_model.clone()),
            server_port: None,
            has_vulkan: false,
            llama_server_installed: server_exe_installed,
            installed_models,
            message: if local_ok {
                format!("Using local Ollama model '{}'", settings.local_vision_model)
            } else {
                "Ollama endpoint must point to localhost / 127.0.0.1 for data privacy".to_string()
            },
        };
    }

    let picked_id = select_best_installed_builtin_model(&settings.root_dir, &settings.local_vision_model)
        .unwrap_or_else(|| settings.local_vision_model.clone());
    let (_, _, _, picked_name) = resolve_builtin_server_paths(&settings.root_dir, &picked_id);
    let model_ready = !installed_models.is_empty() && server_exe_installed;

    let message = if !server_exe_installed && !installed_models.is_empty() {
        "Downloaded model found, but llama-server.exe engine needs re-install in Settings -> Local Vision AI.".to_string()
    } else if installed_models.is_empty() {
        "No local chat/vision model downloaded yet. Install Qwen3-VL-4B, Qwen3-VL-2B, or LFM3-VL-2B in Settings -> Local Vision AI (Live DB search still works now).".to_string()
    } else if server_running {
        format!(
            "Warm AI server running on {} ({})",
            if server_gpu { "Vulkan GPU" } else { "CPU" },
            picked_name
        )
    } else {
        format!(
            "Ready to launch on demand ({}): {}",
            if has_vulkan { "Vulkan GPU" } else { "CPU" },
            picked_name
        )
    };

    AiChatStatus {
        ready: model_ready,
        provider: "builtin".to_string(),
        active_model_id: picked_id,
        active_model_name: picked_name,
        server_running,
        server_running_model,
        server_port,
        has_vulkan,
        llama_server_installed: server_exe_installed,
        installed_models,
        message,
    }
}

fn build_db_only_fallback_answer(
    prompt: &str,
    bundle: &AiContextBundle,
    reason: &str,
) -> String {
    let is_thai = prompt.chars().any(|c| ('\u{0E00}'..='\u{0E7F}').contains(&c));
    let mut out = String::new();
    if is_thai {
        out.push_str(&format!("**โหมดค้นหาฐานข้อมูลโดยตรง (ยังไม่ได้ใช้โมเดล AI: {})**\n\n", reason));
    } else {
        out.push_str(&format!("**Direct Database Search (AI model unavailable: {})**\n\n", reason));
    }

    if bundle.matched_jobs.is_empty()
        && bundle.matched_companies.is_empty()
        && bundle.matched_departments.is_empty()
    {
        if is_thai {
            out.push_str("ไม่พบข้อมูล PO, บริษัทผู้ขาย หรือแผนกที่ตรงกับคำค้นหาในฐานข้อมูลขณะนี้");
        } else {
            out.push_str("No matching PO jobs, suppliers, or department CC rules were found for your query.");
        }
        return out;
    }

    if !bundle.matched_jobs.is_empty() {
        out.push_str(&format!(
            "• POs found ({}): {}\n",
            bundle.matched_jobs.len(),
            bundle
                .matched_jobs
                .iter()
                .take(4)
                .map(|j| format!(
                    "{} [{} -> {}]",
                    j.po_number.as_deref().unwrap_or(&j.po_folder_name),
                    j.status,
                    j.matched_company_name.as_deref().unwrap_or("unmatched")
                ))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if !bundle.matched_companies.is_empty() {
        out.push_str(&format!(
            "• Suppliers found ({}): {}\n",
            bundle.matched_companies.len(),
            bundle
                .matched_companies
                .iter()
                .take(4)
                .map(|c| format!("{} ({})", c.company_name, c.email))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if !bundle.matched_departments.is_empty() {
        out.push_str(&format!(
            "• Department CCs found ({}): {}\n",
            bundle.matched_departments.len(),
            bundle
                .matched_departments
                .iter()
                .take(4)
                .map(|d| format!("{} -> {}", d.department_name, d.emails))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    out.push('\n');
    if is_thai {
        out.push_str("สามารถกดที่การ์ดด้านล่างเพื่อเปิดดู PDF หรือคัดลอกอีเมลได้เลย และหากต้องการคุยถาม-ตอบแบบเต็มรูปแบบสามารถดาวน์โหลดโมเดล Qwen3-VL / LFM3-VL ในหน้า Settings -> Local Vision AI ครับ");
    } else {
        out.push_str("You can click any matched PO, Supplier, or Department card below right now. To enable natural Q&A and visual PDF reading, download Qwen3-VL or LFM3-VL in Settings -> Local Vision AI.");
    }
    out
}

fn build_openai_messages(
    system_prompt: &str,
    history: &[ChatHistoryMessage],
    user_prompt: &str,
    image_data_url: Option<&str>,
) -> Vec<serde_json::Value> {
    let mut messages = Vec::new();
    messages.push(serde_json::json!({
        "role": "system",
        "content": system_prompt,
    }));

    // Keep last 8 conversation turns cleanly trimmed
    let start_idx = history.len().saturating_sub(8);
    for turn in &history[start_idx..] {
        let role = if turn.role == "assistant" {
            "assistant"
        } else {
            "user"
        };
        let content = truncate_chars(turn.content.trim(), 1200);
        if !content.is_empty() {
            messages.push(serde_json::json!({
                "role": role,
                "content": content,
            }));
        }
    }

    let final_user = if let Some(data_url) = image_data_url {
        serde_json::json!([
            {
                "type": "image_url",
                "image_url": { "url": data_url }
            },
            {
                "type": "text",
                "text": user_prompt
            }
        ])
    } else {
        serde_json::json!(user_prompt)
    };

    messages.push(serde_json::json!({
        "role": "user",
        "content": final_user,
    }));
    messages
}

fn build_ollama_messages(
    system_prompt: &str,
    history: &[ChatHistoryMessage],
    user_prompt: &str,
    image_data_url: Option<&str>,
) -> Vec<serde_json::Value> {
    let mut messages = Vec::new();
    messages.push(serde_json::json!({
        "role": "system",
        "content": system_prompt,
    }));

    let start_idx = history.len().saturating_sub(8);
    for turn in &history[start_idx..] {
        let role = if turn.role == "assistant" {
            "assistant"
        } else {
            "user"
        };
        let content = truncate_chars(turn.content.trim(), 1200);
        if !content.is_empty() {
            messages.push(serde_json::json!({
                "role": role,
                "content": content,
            }));
        }
    }

    if let Some(data_url) = image_data_url {
        let b64 = data_url
            .split_once("base64,")
            .map(|(_, rhs)| rhs)
            .unwrap_or(data_url);
        messages.push(serde_json::json!({
            "role": "user",
            "content": user_prompt,
            "images": [b64],
        }));
    } else {
        messages.push(serde_json::json!({
            "role": "user",
            "content": user_prompt,
        }));
    }

    messages
}

pub async fn run_ai_assistant_query(
    db: &Database,
    server_mgr: &AiServerManager,
    prompt: &str,
    history: &[ChatHistoryMessage],
    focus_job_id: Option<&str>,
    image_data_url: Option<&str>,
) -> Result<AiAssistantResponse, String> {
    let started = Instant::now();
    let trimmed_prompt = prompt.trim();
    if trimmed_prompt.is_empty() {
        return Err("Prompt cannot be empty".to_string());
    }

    let settings = db.get_settings().map_err(|e| e.to_string())?;
    let bundle = gather_procurement_context(db, trimmed_prompt, focus_job_id);
    let prov = settings.local_vision_provider.trim().to_lowercase();

    // Case 1: Local Ollama provider
    if prov == "ollama" {
        if !is_localhost_url(&settings.local_vision_endpoint) {
            let reason = "External non-localhost Ollama endpoints are blocked for data privacy";
            return Ok(AiAssistantResponse {
                answer: build_db_only_fallback_answer(trimmed_prompt, &bundle, reason),
                model_used: settings.local_vision_model,
                engine_mode: "db-only".to_string(),
                ai_available: false,
                used_vision_image: false,
                duration_ms: started.elapsed().as_millis() as u64,
                note: Some(reason.to_string()),
                matched_jobs: bundle.matched_jobs,
                matched_companies: bundle.matched_companies,
                matched_departments: bundle.matched_departments,
            });
        }

        let _lock = server_mgr.inference_lock.lock().await;
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| format!("HTTP client error: {}", e))?;

        let url = format!(
            "{}/api/chat",
            settings.local_vision_endpoint.trim_end_matches('/')
        );
        let payload = serde_json::json!({
            "model": settings.local_vision_model,
            "stream": false,
            "messages": build_ollama_messages(
                &bundle.system_grounding_prompt,
                history,
                trimmed_prompt,
                image_data_url,
            ),
            "options": {
                "temperature": 0.25,
                "num_predict": 700,
            }
        });

        match client.post(&url).json(&payload).send().await {
            Ok(resp) if resp.status().is_success() => {
                let json_val: serde_json::Value = resp
                    .json()
                    .await
                    .map_err(|e| format!("Invalid JSON response from Ollama: {}", e))?;
                let raw_reply = json_val["message"]["content"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                let cleaned = clean_ai_reply_text(&raw_reply);
                return Ok(AiAssistantResponse {
                    answer: if cleaned.is_empty() {
                        "Model returned an empty response.".to_string()
                    } else {
                        cleaned
                    },
                    model_used: format!("Ollama ({})", settings.local_vision_model),
                    engine_mode: "ollama".to_string(),
                    ai_available: true,
                    used_vision_image: image_data_url.is_some(),
                    duration_ms: started.elapsed().as_millis() as u64,
                    note: None,
                    matched_jobs: bundle.matched_jobs,
                    matched_companies: bundle.matched_companies,
                    matched_departments: bundle.matched_departments,
                });
            }
            Ok(resp) => {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                let reason = format!("Ollama HTTP {}: {}", status, truncate_chars(&body, 140));
                return Ok(AiAssistantResponse {
                    answer: build_db_only_fallback_answer(trimmed_prompt, &bundle, &reason),
                    model_used: settings.local_vision_model,
                    engine_mode: "db-only".to_string(),
                    ai_available: false,
                    used_vision_image: false,
                    duration_ms: started.elapsed().as_millis() as u64,
                    note: Some(reason),
                    matched_jobs: bundle.matched_jobs,
                    matched_companies: bundle.matched_companies,
                    matched_departments: bundle.matched_departments,
                });
            }
            Err(e) => {
                let reason = format!("Ollama unreachable ({})", e);
                return Ok(AiAssistantResponse {
                    answer: build_db_only_fallback_answer(trimmed_prompt, &bundle, &reason),
                    model_used: settings.local_vision_model,
                    engine_mode: "db-only".to_string(),
                    ai_available: false,
                    used_vision_image: false,
                    duration_ms: started.elapsed().as_millis() as u64,
                    note: Some(reason),
                    matched_jobs: bundle.matched_jobs,
                    matched_companies: bundle.matched_companies,
                    matched_departments: bundle.matched_departments,
                });
            }
        }
    }

    // Case 2: Built-In persistent llama-server.exe
    let Some(model_id) =
        select_best_installed_builtin_model(&settings.root_dir, &settings.local_vision_model)
    else {
        let reason = "No built-in chat/vision GGUF model installed on disk";
        return Ok(AiAssistantResponse {
            answer: build_db_only_fallback_answer(trimmed_prompt, &bundle, reason),
            model_used: "Database Search".to_string(),
            engine_mode: "db-only".to_string(),
            ai_available: false,
            used_vision_image: false,
            duration_ms: started.elapsed().as_millis() as u64,
            note: Some(reason.to_string()),
            matched_jobs: bundle.matched_jobs,
            matched_companies: bundle.matched_companies,
            matched_departments: bundle.matched_departments,
        });
    };

    let (server_exe, model_path, mmproj_path, model_name) =
        resolve_builtin_server_paths(&settings.root_dir, &model_id);
    if !server_exe.exists() {
        let reason = "llama-server.exe is missing inside Models\\engine — click Download Inside App or Upgrade GPU Engine in Settings";
        return Ok(AiAssistantResponse {
            answer: build_db_only_fallback_answer(trimmed_prompt, &bundle, reason),
            model_used: model_name,
            engine_mode: "db-only".to_string(),
            ai_available: false,
            used_vision_image: false,
            duration_ms: started.elapsed().as_millis() as u64,
            note: Some(reason.to_string()),
            matched_jobs: bundle.matched_jobs,
            matched_companies: bundle.matched_companies,
            matched_departments: bundle.matched_departments,
        });
    }

    let has_vulkan = server_exe
        .parent()
        .map(|d| d.join("ggml-vulkan.dll").exists())
        .unwrap_or(false);

    let _lock = server_mgr.inference_lock.lock().await;
    let (port, using_vulkan) = match server_mgr
        .ensure_server_ready(
            &settings.root_dir,
            &model_id,
            &server_exe,
            &model_path,
            &mmproj_path,
            has_vulkan,
        )
        .await
    {
        Ok(res) => res,
        Err(err) => {
            return Ok(AiAssistantResponse {
                answer: build_db_only_fallback_answer(trimmed_prompt, &bundle, &err),
                model_used: model_name,
                engine_mode: "db-only".to_string(),
                ai_available: false,
                used_vision_image: false,
                duration_ms: started.elapsed().as_millis() as u64,
                note: Some(err),
                matched_jobs: bundle.matched_jobs,
                matched_companies: bundle.matched_companies,
                matched_departments: bundle.matched_departments,
            });
        }
    };

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let payload = serde_json::json!({
        "model": model_id,
        "messages": build_openai_messages(
            &bundle.system_grounding_prompt,
            history,
            trimmed_prompt,
            image_data_url,
        ),
        "temperature": 0.25,
        "max_tokens": 768,
        "stream": false,
    });

    let url = format!("http://127.0.0.1:{}/v1/chat/completions", port);
    match client.post(&url).json(&payload).send().await {
        Ok(resp) if resp.status().is_success() => {
            let val: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("Invalid JSON from llama-server: {}", e))?;
            let raw_content = val["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or("")
                .to_string();
            let cleaned = clean_ai_reply_text(&raw_content);
            Ok(AiAssistantResponse {
                answer: if cleaned.is_empty() {
                    "The local AI model completed without returning text.".to_string()
                } else {
                    cleaned
                },
                model_used: model_name,
                engine_mode: if using_vulkan {
                    "builtin-vulkan".to_string()
                } else {
                    "builtin-cpu".to_string()
                },
                ai_available: true,
                used_vision_image: image_data_url.is_some(),
                duration_ms: started.elapsed().as_millis() as u64,
                note: if !using_vulkan && has_vulkan {
                    Some("Fell back cleanly to CPU mode because Vulkan initialization failed.".to_string())
                } else {
                    None
                },
                matched_jobs: bundle.matched_jobs,
                matched_companies: bundle.matched_companies,
                matched_departments: bundle.matched_departments,
            })
        }
        Ok(resp) => {
            let status = resp.status();
            let err_body = resp.text().await.unwrap_or_default();
            let reason = format!("llama-server HTTP {}: {}", status, truncate_chars(&err_body, 160));
            Ok(AiAssistantResponse {
                answer: build_db_only_fallback_answer(trimmed_prompt, &bundle, &reason),
                model_used: model_name,
                engine_mode: "db-only".to_string(),
                ai_available: false,
                used_vision_image: false,
                duration_ms: started.elapsed().as_millis() as u64,
                note: Some(reason),
                matched_jobs: bundle.matched_jobs,
                matched_companies: bundle.matched_companies,
                matched_departments: bundle.matched_departments,
            })
        }
        Err(e) => {
            // Reset crashed server state cleanly so next request can respawn fresh
            server_mgr.stop().await;
            let reason = format!("llama-server communication error: {}", e);
            Ok(AiAssistantResponse {
                answer: build_db_only_fallback_answer(trimmed_prompt, &bundle, &reason),
                model_used: model_name,
                engine_mode: "db-only".to_string(),
                ai_available: false,
                used_vision_image: false,
                duration_ms: started.elapsed().as_millis() as u64,
                note: Some(reason),
                matched_jobs: bundle.matched_jobs,
                matched_companies: bundle.matched_companies,
                matched_departments: bundle.matched_departments,
            })
        }
    }
}
