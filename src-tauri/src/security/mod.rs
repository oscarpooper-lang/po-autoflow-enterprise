use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum SecurityError {
    #[error("Path traversal detected: {0}")]
    PathTraversal(String),
    #[error("File size exceeds safety limit: {0} bytes")]
    FileSizeExceeded(u64),
    #[error("Disallowed file type: {0}")]
    DisallowedFileType(String),
}

pub struct SecurityManager;

impl SecurityManager {
    fn normalize_path(path: &Path) -> PathBuf {
        let s = path.to_string_lossy();
        if s.starts_with(r"\\?\") {
            PathBuf::from(&s[4..])
        } else {
            path.to_path_buf()
        }
    }

    /// Canonicalizes the deepest existing ancestor so non-existent child paths on Windows
    /// (including 8.3 short names like RUNNER~1) normalize consistently with their base directory.
    fn canonicalize_best_effort(path: &Path) -> PathBuf {
        if let Ok(canon) = path.canonicalize() {
            return Self::normalize_path(&canon);
        }

        let mut remaining: Vec<std::ffi::OsString> = Vec::new();
        let mut cursor = path;
        while let Some(name) = cursor.file_name() {
            remaining.push(name.to_os_string());
            match cursor.parent() {
                Some(parent) => {
                    cursor = parent;
                    if cursor.exists() {
                        let mut resolved = cursor
                            .canonicalize()
                            .map(|p| Self::normalize_path(&p))
                            .unwrap_or_else(|_| Self::normalize_path(cursor));
                        for seg in remaining.iter().rev() {
                            resolved.push(seg);
                        }
                        return resolved;
                    }
                }
                None => break,
            }
        }

        Self::normalize_path(path)
    }

    /// Validates that a target path is strictly contained within the allowed base directory.
    pub fn validate_path_containment<P: AsRef<Path>, Q: AsRef<Path>>(
        base_dir: P,
        target_path: Q,
    ) -> Result<PathBuf, SecurityError> {
        let base_raw = base_dir.as_ref();
        let target_raw = target_path.as_ref();

        // Check for traversal tokens
        let target_str = target_raw.to_string_lossy();
        if target_str.contains("..") || target_str.contains("\0") {
            return Err(SecurityError::PathTraversal(format!(
                "Suspicious traversal pattern in: {}",
                target_str
            )));
        }

        let base = Self::canonicalize_best_effort(base_raw);

        let full_path = if target_raw.is_absolute() {
            Self::normalize_path(target_raw)
        } else {
            base.join(target_raw)
        };

        let canon_target = Self::canonicalize_best_effort(&full_path);

        if !canon_target.starts_with(&base) {
            return Err(SecurityError::PathTraversal(format!(
                "Path {:?} escapes base {:?}",
                canon_target, base
            )));
        }

        Ok(canon_target)
    }

    /// Obfuscates sensitive tokens and secrets for display in UI or logs.
    pub fn mask_secret(secret: &str) -> String {
        let s = secret.trim();
        if s.len() <= 6 {
            return "******".to_string();
        }
        let prefix = &s[..3];
        let suffix = &s[s.len() - 3..];
        format!("{}...{}", prefix, suffix)
    }

    /// Computes a deterministic folder fingerprint based on relative file paths and hashes.
    pub fn compute_folder_fingerprint(files: &[crate::document::DiscoveredDocument]) -> String {
        let mut hasher = Sha256::new();
        for f in files {
            hasher.update(f.relative_path.as_bytes());
            hasher.update(f.sha256_hash.as_bytes());
            hasher.update(&f.size_bytes.to_le_bytes());
        }
        hex::encode(hasher.finalize())
    }
}

