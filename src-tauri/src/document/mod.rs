use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[derive(Debug, Clone)]
pub struct DiscoveredDocument {
    pub absolute_path: PathBuf,
    pub relative_path: String,
    pub file_type: String,
    pub size_bytes: u64,
    pub sha256_hash: String,
}

pub struct DocumentScanner;

impl DocumentScanner {
    const SUPPORTED_EXTENSIONS: &'static [&'static str] = &[
        "pdf", "jpg", "jpeg", "png", "tiff", "tif", "bmp", "docx",
    ];

    pub fn is_supported_file(path: &Path) -> bool {
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            let lower = ext.to_lowercase();
            Self::SUPPORTED_EXTENSIONS.contains(&lower.as_str())
        } else {
            false
        }
    }

    pub fn compute_sha256(path: &Path) -> Result<String, std::io::Error> {
        let mut file = File::open(path)?;
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 8192];

        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }

        Ok(hex::encode(hasher.finalize()))
    }

    /// Recursively discovers all supported document files inside a PO folder,
    /// skipping Office temporary lock files (`~$...`) and prioritizing primary PO documents first.
    pub fn scan_po_folder(po_dir: &Path) -> Result<Vec<DiscoveredDocument>, std::io::Error> {
        let mut documents = Vec::new();

        for entry in WalkDir::new(po_dir).into_iter().filter_map(|e| e.ok()) {
            if entry.file_type().is_file() && Self::is_supported_file(entry.path()) {
                let file_name = entry
                    .path()
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("");
                if file_name.starts_with("~$") || file_name.starts_with('.') {
                    continue;
                }

                let abs_path = entry.path().to_path_buf();
                let rel_path = match abs_path.strip_prefix(po_dir) {
                    Ok(p) => p.to_string_lossy().replace('\\', "/"),
                    Err(_) => abs_path.file_name().unwrap_or_default().to_string_lossy().to_string(),
                };

                let meta = entry.metadata()?;
                let ext = abs_path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase();

                let hash = Self::compute_sha256(&abs_path)?;

                documents.push(DiscoveredDocument {
                    absolute_path: abs_path,
                    relative_path: rel_path,
                    file_type: ext,
                    size_bytes: meta.len(),
                    sha256_hash: hash,
                });
            }
        }

        // Prioritize primary PO PDFs/docs ahead of supporting quotations/attachments
        fn doc_priority(doc: &DiscoveredDocument) -> u8 {
            let fname = doc
                .absolute_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_lowercase();
            if fname.starts_with("po") || fname.contains("ใบสั่งซื้อ") {
                0
            } else if fname.contains("ใบเสนอราคา") || fname.contains("quotation") {
                1
            } else {
                2
            }
        }

        documents.sort_by(|a, b| {
            doc_priority(a)
                .cmp(&doc_priority(b))
                .then_with(|| a.relative_path.cmp(&b.relative_path))
        });

        Ok(documents)
    }
}

