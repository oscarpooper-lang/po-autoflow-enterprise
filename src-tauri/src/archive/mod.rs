use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use thiserror::Error;
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

#[derive(Error, Debug)]
pub enum ArchiveError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("WalkDir error: {0}")]
    WalkDir(#[from] walkdir::Error),
    #[error("ZIP error: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("Archive size ({0} MB) exceeds maximum limit ({1} MB)")]
    SizeLimitExceeded(u64, u64),
    #[error("Security violation: potential zip bomb detected ({0} files)")]
    ZipBombDetected(usize),
    #[error("Integrity verification failed for archive: {0}")]
    IntegrityFailed(String),
}

#[derive(Debug, Clone)]
pub struct ArchiveResult {
    pub archive_path: PathBuf,
    pub size_bytes: u64,
    pub sha256_hash: String,
    pub file_count: usize,
}

pub struct ArchiveManager;

impl ArchiveManager {
    const MAX_FILES_PER_PO: usize = 500;

    /// Creates a ZIP archive of the entire PO folder preserving directory structure,
    /// verifies integrity, and calculates SHA-256 and size.
    pub fn create_po_archive<P: AsRef<Path>, Q: AsRef<Path>>(
        source_dir: P,
        output_zip_path: Q,
        max_size_mb: u64,
    ) -> Result<ArchiveResult, ArchiveError> {
        let src = source_dir.as_ref();
        let out = output_zip_path.as_ref();

        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let zip_file = File::create(out)?;
        let mut zip_writer = ZipWriter::new(zip_file);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o644);

        let mut file_count = 0;
        let mut _uncompressed_total_bytes: u64 = 0;

        for entry in WalkDir::new(src).into_iter().filter_map(|e| e.ok()) {
            let path = entry.path();
            let rel_path = match path.strip_prefix(src) {
                Ok(p) => p.to_string_lossy().replace('\\', "/"),
                Err(_) => continue,
            };

            if rel_path.is_empty() {
                continue;
            }

            if entry.file_type().is_dir() {
                zip_writer.add_directory(&format!("{}/", rel_path), options)?;
            } else if entry.file_type().is_file() {
                file_count += 1;
                if file_count > Self::MAX_FILES_PER_PO {
                    return Err(ArchiveError::ZipBombDetected(file_count));
                }

                let meta = entry.metadata()?;
                _uncompressed_total_bytes += meta.len();

                zip_writer.start_file(&rel_path, options)?;
                let mut f = File::open(path)?;
                let mut buffer = [0u8; 8192];
                loop {
                    let bytes_read = f.read(&mut buffer)?;
                    if bytes_read == 0 {
                        break;
                    }
                    zip_writer.write_all(&buffer[..bytes_read])?;
                }
            }
        }

        zip_writer.finish()?;

        // Verify size limit
        let out_meta = std::fs::metadata(out)?;
        let size_bytes = out_meta.len();
        let size_mb = size_bytes / (1024 * 1024);
        if max_size_mb > 0 && size_mb > max_size_mb {
            return Err(ArchiveError::SizeLimitExceeded(size_mb, max_size_mb));
        }

        // Integrity Check: Reopen archive and verify entries
        let check_file = File::open(out)?;
        let archive = ZipArchive::new(check_file)?;
        if archive.len() < file_count {
            return Err(ArchiveError::IntegrityFailed(format!(
                "Archive entry count mismatch: expected at least {}, found {}",
                file_count,
                archive.len()
            )));
        }

        // Calculate SHA-256 of completed archive
        let mut f = File::open(out)?;
        let mut hasher = Sha256::new();
        let mut buf = [0u8; 8192];
        loop {
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        let sha256_hash = hex::encode(hasher.finalize());

        Ok(ArchiveResult {
            archive_path: out.to_path_buf(),
            size_bytes,
            sha256_hash,
            file_count,
        })
    }
}
