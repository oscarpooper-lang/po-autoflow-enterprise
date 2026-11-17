pub mod stability;

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{error, info, warn};

pub struct FolderWatcher {
    incoming_dir: PathBuf,
    active_jobs: Arc<Mutex<HashSet<PathBuf>>>,
    watcher: Option<RecommendedWatcher>,
    job_tx: mpsc::Sender<PathBuf>,
    poll_running: Arc<AtomicBool>,
    poll_interval_ms: u64,
}

impl FolderWatcher {
    pub fn new<P: AsRef<Path>>(incoming_dir: P, job_tx: mpsc::Sender<PathBuf>) -> Self {
        Self {
            incoming_dir: incoming_dir.as_ref().to_path_buf(),
            active_jobs: Arc::new(Mutex::new(HashSet::new())),
            watcher: None,
            job_tx,
            poll_running: Arc::new(AtomicBool::new(false)),
            poll_interval_ms: 2500,
        }
    }

    pub fn with_poll_interval(mut self, poll_interval_ms: u64) -> Self {
        self.poll_interval_ms = poll_interval_ms.clamp(1000, 30000);
        self
    }

    fn folder_has_content(path: &Path) -> bool {
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .trim();
        if name.starts_with('.') {
            return false;
        }
        // Wait until a user-created "New folder" has at least 1 file before locking it,
        // so renaming an empty folder on a network share does not misfire.
        std::fs::read_dir(path)
            .map(|mut entries| entries.next().is_some())
            .unwrap_or(false)
    }

    /// Determines the direct child directory under `Incoming` that represents the root of a PO package.
    pub fn extract_po_folder_root(incoming_root: &Path, event_path: &Path) -> Option<PathBuf> {
        let relative = event_path.strip_prefix(incoming_root).ok()?;
        let first_component = relative.components().next()?;
        let po_folder = incoming_root.join(first_component.as_os_str());

        if po_folder.is_dir() && Self::folder_has_content(&po_folder) {
            Some(po_folder)
        } else {
            None
        }
    }

    pub fn start(&mut self) -> Result<(), notify::Error> {
        if !self.incoming_dir.exists() {
            if let Err(e) = std::fs::create_dir_all(&self.incoming_dir) {
                warn!("Could not create incoming dir {:?}: {}", self.incoming_dir, e);
            }
        }

        let incoming_root = self.incoming_dir.clone();
        let active_set = Arc::clone(&self.active_jobs);
        let tx = self.job_tx.clone();

        let mut watcher = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| match res {
                Ok(event) => {
                    match event.kind {
                        EventKind::Create(_) | EventKind::Modify(_) => {
                            for path in event.paths {
                                if let Some(po_dir) = Self::extract_po_folder_root(&incoming_root, &path) {
                                    let mut set = active_set.lock();
                                    if !set.contains(&po_dir) {
                                        set.insert(po_dir.clone());
                                        // Use try_send because notify invokes this callback on a non-Tokio OS thread;
                                        // calling tokio::spawn here panics with "there is no reactor running".
                                        if let Err(e) = tx.try_send(po_dir.clone()) {
                                            set.remove(&po_dir);
                                            error!("Failed to enqueue detected PO folder {:?}: {}", po_dir, e);
                                        }
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
                Err(e) => {
                    warn!("Watch error on incoming folder: {:?}", e);
                }
            },
            Config::default(),
        )?;

        match watcher.watch(&self.incoming_dir, RecursiveMode::Recursive) {
            Ok(()) => {
                info!("FolderWatcher actively monitoring: {:?}", self.incoming_dir);
                self.watcher = Some(watcher);
            }
            Err(e) => {
                // Mapped network drives or NAS SMB shares can reject ReadDirectoryChangesW;
                // fall back to periodic polling rather than aborting monitoring.
                warn!(
                    "OS filesystem watch unavailable on {:?} ({}); falling back to periodic polling",
                    self.incoming_dir, e
                );
                self.watcher = None;
            }
        }

        // Start periodic SMB-safe fallback polling so network share drops are always picked up
        // even when ReadDirectoryChangesW omits remote events.
        self.poll_running.store(true, Ordering::SeqCst);
        let poll_flag = Arc::clone(&self.poll_running);
        let poll_dir = self.incoming_dir.clone();
        let poll_active = Arc::clone(&self.active_jobs);
        let poll_tx = self.job_tx.clone();
        let interval_ms = self.poll_interval_ms;

        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let mut ticker = tokio::time::interval(Duration::from_millis(interval_ms));
                // First tick fires immediately; scan_existing_folders runs right below so skip duplicate tick
                ticker.tick().await;
                while poll_flag.load(Ordering::SeqCst) {
                    ticker.tick().await;
                    if !poll_flag.load(Ordering::SeqCst) {
                        break;
                    }
                    Self::enqueue_existing_in_dir(&poll_dir, &poll_active, &poll_tx);
                }
            });
        }

        // Scan for any folders that already exist in Incoming on startup
        self.scan_existing_folders();

        Ok(())
    }

    fn enqueue_existing_in_dir(
        incoming_dir: &Path,
        active_jobs: &Arc<Mutex<HashSet<PathBuf>>>,
        job_tx: &mpsc::Sender<PathBuf>,
    ) {
        if let Ok(entries) = std::fs::read_dir(incoming_dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.is_dir() && Self::folder_has_content(&path) {
                    let mut set = active_jobs.lock();
                    if !set.contains(&path) {
                        set.insert(path.clone());
                        if let Err(e) = job_tx.try_send(path.clone()) {
                            set.remove(&path);
                            error!("Failed to enqueue incoming PO folder {:?}: {}", path, e);
                        } else {
                            info!("Enqueued incoming PO folder: {:?}", path);
                        }
                    }
                }
            }
        }
    }

    /// Scans incoming directory for existing PO packages and queues them for processing.
    pub fn scan_existing_folders(&self) {
        Self::enqueue_existing_in_dir(&self.incoming_dir, &self.active_jobs, &self.job_tx);
    }

    pub fn active_jobs(&self) -> Arc<Mutex<HashSet<PathBuf>>> {
        Arc::clone(&self.active_jobs)
    }

    pub fn active_jobs_count(&self) -> usize {
        self.active_jobs.lock().len()
    }

    pub fn stop(&mut self) {
        self.poll_running.store(false, Ordering::SeqCst);
        if let Some(mut watcher) = self.watcher.take() {
            let _ = watcher.unwatch(&self.incoming_dir);
            info!("FolderWatcher stopped on: {:?}", self.incoming_dir);
        }
    }

    pub fn is_active(&self) -> bool {
        self.watcher.is_some() || self.poll_running.load(Ordering::SeqCst)
    }

    pub fn incoming_dir(&self) -> &Path {
        &self.incoming_dir
    }

    pub fn release_po_folder(&self, po_folder: &Path) {
        let mut set = self.active_jobs.lock();
        set.remove(po_folder);
    }
}

impl Drop for FolderWatcher {
    fn drop(&mut self) {
        self.stop();
    }
}
