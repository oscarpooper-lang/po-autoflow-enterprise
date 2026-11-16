pub mod stability;

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::{error, info, warn};

pub struct FolderWatcher {
    incoming_dir: PathBuf,
    active_jobs: Arc<Mutex<HashSet<PathBuf>>>,
    watcher: Option<RecommendedWatcher>,
    job_tx: mpsc::Sender<PathBuf>,
}

impl FolderWatcher {
    pub fn new<P: AsRef<Path>>(incoming_dir: P, job_tx: mpsc::Sender<PathBuf>) -> Self {
        Self {
            incoming_dir: incoming_dir.as_ref().to_path_buf(),
            active_jobs: Arc::new(Mutex::new(HashSet::new())),
            watcher: None,
            job_tx,
        }
    }

    /// Determines the direct child directory under `Incoming` that represents the root of a PO package.
    pub fn extract_po_folder_root(incoming_root: &Path, event_path: &Path) -> Option<PathBuf> {
        let relative = event_path.strip_prefix(incoming_root).ok()?;
        let first_component = relative.components().next()?;
        let po_folder = incoming_root.join(first_component.as_os_str());

        if po_folder.is_dir() {
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

        watcher.watch(&self.incoming_dir, RecursiveMode::Recursive)?;
        info!("FolderWatcher actively monitoring: {:?}", self.incoming_dir);
        self.watcher = Some(watcher);

        // Scan for any folders that already exist in Incoming on startup
        self.scan_existing_folders();

        Ok(())
    }

    /// Scans incoming directory for existing PO packages and queues them for processing.
    pub fn scan_existing_folders(&self) {
        if let Ok(entries) = std::fs::read_dir(&self.incoming_dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.is_dir() {
                    let mut set = self.active_jobs.lock();
                    if !set.contains(&path) {
                        set.insert(path.clone());
                        if let Err(e) = self.job_tx.try_send(path.clone()) {
                            set.remove(&path);
                            error!("Failed to enqueue existing PO folder on startup {:?}: {}", path, e);
                        } else {
                            info!("Enqueued pre-existing incoming PO folder: {:?}", path);
                        }
                    }
                }
            }
        }
    }

    pub fn active_jobs(&self) -> Arc<Mutex<HashSet<PathBuf>>> {
        Arc::clone(&self.active_jobs)
    }

    pub fn active_jobs_count(&self) -> usize {
        self.active_jobs.lock().len()
    }

    pub fn stop(&mut self) {
        if let Some(mut watcher) = self.watcher.take() {
            let _ = watcher.unwatch(&self.incoming_dir);
            info!("FolderWatcher stopped on: {:?}", self.incoming_dir);
        }
    }

    pub fn is_active(&self) -> bool {
        self.watcher.is_some()
    }

    pub fn incoming_dir(&self) -> &Path {
        &self.incoming_dir
    }

    pub fn release_po_folder(&self, po_folder: &Path) {
        let mut set = self.active_jobs.lock();
        set.remove(po_folder);
    }
}
