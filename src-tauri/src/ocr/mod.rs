use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;
use tracing::info;

#[derive(Error, Debug)]
pub enum OcrError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("OCR worker failure: {0}")]
    WorkerError(String),
    #[error("OCR process terminated")]
    ProcessTerminated,
    #[error("OCR request timeout")]
    Timeout,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundingBoxItem {
    pub box_coords: Option<serde_json::Value>,
    pub text: String,
    pub confidence: f64,
    #[serde(rename = "type")]
    pub item_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SupplierCandidate {
    pub name: String,
    pub confidence: f64,
    pub language: String,
    pub line_index: Option<usize>,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedEntities {
    pub po_numbers: Vec<String>,
    pub tax_ids: Vec<String>,
    #[serde(default)]
    pub emails: Vec<String>,
    pub supplier_candidates: Vec<SupplierCandidate>,
    pub primary_supplier: Option<String>,
    pub primary_confidence: f64,
    #[serde(default)]
    pub primary_supplier_th: Option<String>,
    #[serde(default)]
    pub primary_supplier_en: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrPageResult {
    pub page_number: i32,
    pub raw_text: String,
    pub confidence: f64,
    pub extraction_method: String,
    pub boxes: Vec<serde_json::Value>,
    pub parsed: ParsedEntities,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrFileResponse {
    pub status: String,
    pub file_path: Option<String>,
    pub pages_count: Option<usize>,
    pub pages: Option<Vec<OcrPageResult>>,
    pub aggregated: Option<ParsedEntities>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OcrHints {
    #[serde(default)]
    pub root_dir: String,
    pub negative_phrases: Vec<String>,
    pub preferred_y_band: Option<f64>,
    pub local_vision_enabled: bool,
    pub local_vision_provider: String,
    pub local_vision_endpoint: String,
    pub local_vision_model: String,
    #[serde(default)]
    pub builtin_engine_path: String,
    #[serde(default)]
    pub builtin_model_path: String,
    #[serde(default)]
    pub builtin_mmproj_path: String,
    #[serde(default)]
    pub force_vision: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PagePreviewResponse {
    pub status: String,
    pub data_url: Option<String>,
    pub page_width: Option<f64>,
    pub page_height: Option<f64>,
    pub render_width: Option<u32>,
    pub render_height: Option<u32>,
    pub message: Option<String>,
}

struct WorkerProcess {
    _child: Child,
    child_pid: Option<u32>,
    stdin: ChildStdin,
    reader: BufReader<ChildStdout>,
}

#[derive(Clone)]
pub struct OcrManager {
    worker_script: PathBuf,
    process: Arc<Mutex<Option<WorkerProcess>>>,
    terminal_logs: Arc<parking_lot::Mutex<VecDeque<String>>>,
    download_progress: Arc<parking_lot::Mutex<crate::database::models::BuiltInDownloadProgress>>,
}

impl OcrManager {
    pub fn new<P: AsRef<Path>>(worker_script_path: P) -> Self {
        Self {
            worker_script: worker_script_path.as_ref().to_path_buf(),
            process: Arc::new(Mutex::new(None)),
            terminal_logs: Arc::new(parking_lot::Mutex::new(VecDeque::with_capacity(500))),
            download_progress: Arc::new(parking_lot::Mutex::new(
                crate::database::models::BuiltInDownloadProgress::default(),
            )),
        }
    }

    pub fn get_download_progress(&self) -> crate::database::models::BuiltInDownloadProgress {
        self.download_progress.lock().clone()
    }

    pub fn set_download_progress(&self, progress: crate::database::models::BuiltInDownloadProgress) {
        *self.download_progress.lock() = progress;
    }

    pub fn push_log(&self, line: impl Into<String>) {
        let now = chrono::Local::now().format("%H:%M:%S").to_string();
        let formatted = format!("[{}] {}", now, line.into());
        let mut logs = self.terminal_logs.lock();
        if logs.len() >= 500 {
            logs.pop_front();
        }
        logs.push_back(formatted);
    }

    pub fn get_logs(&self) -> Vec<String> {
        self.terminal_logs.lock().iter().cloned().collect()
    }

    pub async fn worker_pid(&self) -> Option<u32> {
        self.process.lock().await.as_ref().and_then(|w| w.child_pid)
    }

    pub fn script_path(&self) -> PathBuf {
        self.worker_script.clone()
    }

    async fn ensure_process_running(&self) -> Result<(), OcrError> {
        let mut lock = self.process.lock().await;
        if lock.is_none() {
            info!("Spawning managed OCR worker: {:?}", self.worker_script);
            let mut cmd = Command::new("python");
            cmd.arg(&self.worker_script)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            #[cfg(target_os = "windows")]
            {
                // CREATE_NO_WINDOW (0x08000000) prevents flashing Python console windows during background OCR
                cmd.creation_flags(0x08000000);
            }

            let mut child = cmd.spawn()?;
            let child_pid = child.id();
            let stdin = child.stdin.take().ok_or_else(|| {
                OcrError::WorkerError("Failed to capture worker stdin".to_string())
            })?;
            let stdout = child.stdout.take().ok_or_else(|| {
                OcrError::WorkerError("Failed to capture worker stdout".to_string())
            })?;

            if let Some(stderr) = child.stderr.take() {
                let logs_ref = Arc::clone(&self.terminal_logs);
                tokio::spawn(async move {
                    let mut err_reader = BufReader::new(stderr);
                    let mut line = String::new();
                    while let Ok(n) = err_reader.read_line(&mut line).await {
                        if n == 0 {
                            break;
                        }
                        let trimmed = line.trim();
                        if !trimmed.is_empty() {
                            let now = chrono::Local::now().format("%H:%M:%S").to_string();
                            let entry = format!("[{}] [python-ocr stderr] {}", now, trimmed);
                            let mut logs = logs_ref.lock();
                            if logs.len() >= 500 {
                                logs.pop_front();
                            }
                            logs.push_back(entry);
                        }
                        line.clear();
                    }
                });
            }

            let mut reader = BufReader::new(stdout);
            let mut init_line = String::new();
            reader.read_line(&mut init_line).await?;
            info!("OCR Worker initialized: {}", init_line.trim());
            self.push_log(format!(
                "[python-ocr] Started PID {:?}: {}",
                child_pid,
                init_line.trim()
            ));

            *lock = Some(WorkerProcess {
                _child: child,
                child_pid,
                stdin,
                reader,
            });
        }
        Ok(())
    }

    pub async fn process_file(&self, file_path: &Path) -> Result<OcrFileResponse, OcrError> {
        self.process_file_with_hints(file_path, None).await
    }

    pub async fn process_file_with_hints(
        &self,
        file_path: &Path,
        hints: Option<&OcrHints>,
    ) -> Result<OcrFileResponse, OcrError> {
        self.ensure_process_running().await?;
        self.push_log(format!(
            "[python-ocr] Processing file: {}",
            file_path.file_name().and_then(|n| n.to_str()).unwrap_or("unknown")
        ));

        let mut lock = self.process.lock().await;
        let worker = match lock.as_mut() {
            Some(w) => w,
            None => return Err(OcrError::ProcessTerminated),
        };

        let req = match hints {
            Some(h) => serde_json::json!({
                "command": "process_file",
                "file_path": file_path.to_string_lossy(),
                "hints": h,
            }),
            None => serde_json::json!({
                "command": "process_file",
                "file_path": file_path.to_string_lossy(),
            }),
        };

        let mut req_str = serde_json::to_string(&req)?;
        req_str.push('\n');

        if let Err(e) = worker.stdin.write_all(req_str.as_bytes()).await {
            *lock = None;
            return Err(OcrError::Io(e));
        }
        if let Err(e) = worker.stdin.flush().await {
            *lock = None;
            return Err(OcrError::Io(e));
        }

        let mut resp_line = String::new();
        let read_result = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            worker.reader.read_line(&mut resp_line),
        )
        .await;

        match read_result {
            Ok(Ok(bytes_read)) => {
                if bytes_read == 0 {
                    *lock = None;
                    return Err(OcrError::ProcessTerminated);
                }
                let resp: OcrFileResponse = match serde_json::from_str(&resp_line) {
                    Ok(r) => r,
                    Err(e) => {
                        *lock = None;
                        return Err(OcrError::Json(e));
                    }
                };
                if resp.status == "error" {
                    let msg = resp.message.unwrap_or_else(|| "Unknown worker error".to_string());
                    self.push_log(format!("[python-ocr ERROR] {}", msg));
                    return Err(OcrError::WorkerError(msg));
                }
                Ok(resp)
            }
            Ok(Err(e)) => {
                *lock = None;
                Err(OcrError::Io(e))
            }
            Err(_) => {
                *lock = None;
                Err(OcrError::Timeout)
            }
        }
    }

    pub async fn render_page_preview(
        &self,
        file_path: &Path,
        page_number: i32,
    ) -> Result<PagePreviewResponse, OcrError> {
        self.ensure_process_running().await?;

        let mut lock = self.process.lock().await;
        let worker = match lock.as_mut() {
            Some(w) => w,
            None => return Err(OcrError::ProcessTerminated),
        };

        let req = serde_json::json!({
            "command": "render_preview",
            "file_path": file_path.to_string_lossy(),
            "page_number": page_number,
            "dpi": 150,
        });

        let mut req_str = serde_json::to_string(&req)?;
        req_str.push('\n');

        if let Err(e) = worker.stdin.write_all(req_str.as_bytes()).await {
            *lock = None;
            return Err(OcrError::Io(e));
        }
        if let Err(e) = worker.stdin.flush().await {
            *lock = None;
            return Err(OcrError::Io(e));
        }

        let mut resp_line = String::new();
        let read_result = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            worker.reader.read_line(&mut resp_line),
        )
        .await;

        match read_result {
            Ok(Ok(bytes_read)) => {
                if bytes_read == 0 {
                    *lock = None;
                    return Err(OcrError::ProcessTerminated);
                }
                let resp: PagePreviewResponse = match serde_json::from_str(&resp_line) {
                    Ok(r) => r,
                    Err(e) => {
                        *lock = None;
                        return Err(OcrError::Json(e));
                    }
                };
                if resp.status == "error" {
                    return Err(OcrError::WorkerError(
                        resp.message.unwrap_or_else(|| "Preview rendering failed".to_string()),
                    ));
                }
                Ok(resp)
            }
            Ok(Err(e)) => {
                *lock = None;
                Err(OcrError::Io(e))
            }
            Err(_) => {
                *lock = None;
                Err(OcrError::Timeout)
            }
        }
    }

    pub async fn ping(&self) -> Result<bool, OcrError> {
        let val = self.ping_details("").await?;
        Ok(val.get("status").and_then(|v| v.as_str()) == Some("ok"))
    }

    pub async fn ping_details(&self, root_dir: &str) -> Result<serde_json::Value, OcrError> {
        self.ensure_process_running().await?;
        let mut lock = self.process.lock().await;
        let worker = match lock.as_mut() {
            Some(w) => w,
            None => return Err(OcrError::ProcessTerminated),
        };

        let req = serde_json::json!({"command": "ping", "root_dir": root_dir});
        let mut req_str = serde_json::to_string(&req)?;
        req_str.push('\n');

        if let Err(e) = worker.stdin.write_all(req_str.as_bytes()).await {
            *lock = None;
            return Err(OcrError::Io(e));
        }
        if let Err(e) = worker.stdin.flush().await {
            *lock = None;
            return Err(OcrError::Io(e));
        }

        let mut resp_line = String::new();
        match worker.reader.read_line(&mut resp_line).await {
            Ok(bytes) => {
                if bytes == 0 {
                    *lock = None;
                    return Err(OcrError::ProcessTerminated);
                }
                let val: serde_json::Value = serde_json::from_str(&resp_line)?;
                Ok(val)
            }
            Err(e) => {
                *lock = None;
                Err(OcrError::Io(e))
            }
        }
    }

    pub async fn test_local_vision(
        &self,
        provider: &str,
        endpoint: &str,
        model: &str,
    ) -> Result<crate::database::models::LocalVisionStatus, String> {
        let ep_trim = endpoint.trim();
        let prov_clean = if provider.trim().is_empty() { "ollama" } else { provider.trim() };

        // Enforce strict localhost security policy in Rust as well when using Ollama
        if prov_clean.eq_ignore_ascii_case("ollama") {
            let lower = ep_trim.to_lowercase();
            let valid_host = lower.starts_with("http://127.0.0.1")
                || lower.starts_with("http://localhost")
                || lower.starts_with("https://127.0.0.1")
                || lower.starts_with("https://localhost")
                || lower.starts_with("http://[::1]");
            if !valid_host {
                return Ok(crate::database::models::LocalVisionStatus {
                    reachable: false,
                    endpoint: ep_trim.to_string(),
                    configured_model: model.trim().to_string(),
                    available_models: Vec::new(),
                    message: "Security block: only 127.0.0.1 / localhost endpoints are allowed so sensitive PO data never leaves this computer.".to_string(),
                });
            }
        }

        self.ensure_process_running().await.map_err(|e| e.to_string())?;
        let mut lock = self.process.lock().await;
        let worker = match lock.as_mut() {
            Some(w) => w,
            None => return Err("OCR worker process not running".to_string()),
        };

        let req = serde_json::json!({
            "command": "test_local_vision",
            "provider": prov_clean,
            "endpoint": ep_trim,
            "model": model.trim(),
        });

        let mut req_str = serde_json::to_string(&req).map_err(|e| e.to_string())?;
        req_str.push('\n');

        if let Err(e) = worker.stdin.write_all(req_str.as_bytes()).await {
            *lock = None;
            return Err(e.to_string());
        }
        if let Err(e) = worker.stdin.flush().await {
            *lock = None;
            return Err(e.to_string());
        }

        let mut resp_line = String::new();
        match tokio::time::timeout(
            std::time::Duration::from_secs(15),
            worker.reader.read_line(&mut resp_line),
        )
        .await
        {
            Ok(Ok(bytes)) if bytes > 0 => {
                let val: serde_json::Value = serde_json::from_str(&resp_line).map_err(|e| e.to_string())?;
                let available_models = val
                    .get("available_models")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|x| x.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();

                Ok(crate::database::models::LocalVisionStatus {
                    reachable: val.get("reachable").and_then(|v| v.as_bool()).unwrap_or(false),
                    endpoint: val.get("endpoint").and_then(|v| v.as_str()).unwrap_or(ep_trim).to_string(),
                    configured_model: val
                        .get("configured_model")
                        .and_then(|v| v.as_str())
                        .unwrap_or(model)
                        .to_string(),
                    available_models,
                    message: val
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Local vision check completed")
                        .to_string(),
                })
            }
            Ok(Ok(_)) => {
                *lock = None;
                Err("OCR worker process closed unexpectedly".to_string())
            }
            Ok(Err(e)) => {
                *lock = None;
                Err(e.to_string())
            }
            Err(_) => {
                *lock = None;
                Err("Local vision check timed out".to_string())
            }
        }
    }
}
