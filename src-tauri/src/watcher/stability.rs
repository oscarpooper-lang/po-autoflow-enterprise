use std::fs::File;
use std::path::Path;
use std::time::{Duration, Instant};
use tracing::{debug, info, warn};
use walkdir::WalkDir;

#[derive(Debug, Clone)]
pub struct FolderSnapshot {
    pub file_count: usize,
    pub total_size: u64,
    pub latest_mtime: std::time::SystemTime,
}

pub struct FileStabilityChecker {
    check_interval: Duration,
    required_consecutive_stable_checks: u32,
    max_timeout: Duration,
}

impl FileStabilityChecker {
    pub fn new(check_interval_ms: u64, required_checks: u32, timeout_secs: u64) -> Self {
        Self {
            check_interval: Duration::from_millis(check_interval_ms),
            required_consecutive_stable_checks: required_checks.max(2),
            max_timeout: Duration::from_secs(timeout_secs),
        }
    }

    /// Returns true if a file looks like a temporary browser/Office/sync partial file.
    pub fn is_temporary_sync_file(path: &Path) -> bool {
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .trim()
            .to_lowercase();
        if name.is_empty() {
            return false;
        }
        if name.starts_with("~$") || name.ends_with('~') {
            return true;
        }
        [".tmp", ".part", ".crdownload", ".partial", ".download"]
            .iter()
            .any(|ext| name.ends_with(ext))
    }

    /// Recursively computes snapshot (file count, total bytes, latest mtime) of directory.
    pub fn take_snapshot(dir_path: &Path) -> Result<FolderSnapshot, std::io::Error> {
        let mut file_count = 0;
        let mut total_size = 0;
        let mut latest_mtime = std::time::SystemTime::UNIX_EPOCH;

        for entry_res in WalkDir::new(dir_path) {
            let entry = entry_res.map_err(|e| {
                std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("Directory read error during snapshot: {}", e),
                )
            })?;
            if entry.file_type().is_file() {
                file_count += 1;
                let metadata = entry.metadata()?;
                total_size += metadata.len();
                if let Ok(mtime) = metadata.modified() {
                    if mtime > latest_mtime {
                        latest_mtime = mtime;
                    }
                }
            }
        }

        Ok(FolderSnapshot {
            file_count,
            total_size,
            latest_mtime,
        })
    }

    /// Verifies all files in directory are non-temporary and can be opened for reading (ensuring Windows file lock is released).
    pub fn can_open_all_files(dir_path: &Path) -> bool {
        for entry_res in WalkDir::new(dir_path) {
            let entry = match entry_res {
                Ok(e) => e,
                Err(e) => {
                    debug!("Directory walk error during lock check on {:?}: {}", dir_path, e);
                    return false;
                }
            };
            if entry.file_type().is_file() {
                if Self::is_temporary_sync_file(entry.path()) {
                    debug!("Temporary/partial file still present in {:?}: {:?}", dir_path, entry.path());
                    return false;
                }
                match File::open(entry.path()) {
                    Ok(_) => {}
                    Err(e) => {
                        debug!("File still locked or inaccessible: {:?}: {}", entry.path(), e);
                        return false;
                    }
                }
            }
        }
        true
    }

    /// Asynchronously waits until folder copying is complete and all files are stable and unlocked.
    pub async fn wait_for_stability(&self, dir_path: &Path) -> Result<FolderSnapshot, String> {
        if !dir_path.exists() {
            return Err(format!("Directory does not exist: {:?}", dir_path));
        }

        let start = Instant::now();
        let mut consecutive_stable_count = 0;
        let mut last_snapshot: Option<FolderSnapshot> = None;

        info!("Beginning copy stability check for folder: {:?}", dir_path);

        loop {
            if start.elapsed() > self.max_timeout {
                return Err(format!(
                    "Stability timeout exceeded ({:?}) waiting for folder: {:?}",
                    self.max_timeout, dir_path
                ));
            }

            match Self::take_snapshot(dir_path) {
                Ok(current_snapshot) => {
                    if current_snapshot.file_count == 0 {
                        // Empty folder, wait for files to start copying
                        consecutive_stable_count = 0;
                    } else if let Some(ref last) = last_snapshot {
                        if current_snapshot.file_count == last.file_count
                            && current_snapshot.total_size == last.total_size
                            && current_snapshot.latest_mtime == last.latest_mtime
                        {
                            // Size and timestamp are stable, now verify Windows file locks
                            if Self::can_open_all_files(dir_path) {
                                consecutive_stable_count += 1;
                                debug!(
                                    "Folder stable check {}/{} for {:?}",
                                    consecutive_stable_count,
                                    self.required_consecutive_stable_checks,
                                    dir_path
                                );

                                if consecutive_stable_count >= self.required_consecutive_stable_checks {
                                    info!(
                                        "Folder {:?} is stable: {} files, {} bytes in {:?}",
                                        dir_path,
                                        current_snapshot.file_count,
                                        current_snapshot.total_size,
                                        start.elapsed()
                                    );
                                    return Ok(current_snapshot);
                                }
                            } else {
                                consecutive_stable_count = 0;
                            }
                        } else {
                            // Folder is still actively being written to
                            consecutive_stable_count = 0;
                        }
                    } else {
                        // First snapshot taken
                        consecutive_stable_count = 0;
                    }

                    last_snapshot = Some(current_snapshot);
                }
                Err(e) => {
                    warn!("Error reading directory during stability check: {}", e);
                    consecutive_stable_count = 0;
                }
            }

            tokio::time::sleep(self.check_interval).await;
        }
    }
}
