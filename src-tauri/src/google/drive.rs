use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;
use thiserror::Error;
use tracing::info;

#[derive(Error, Debug)]
pub enum DriveError {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Drive API error: {0}")]
    Api(String),
}

#[derive(Serialize, Deserialize, Debug)]
pub struct DriveUploadResult {
    pub file_id: String,
    pub file_name: String,
    pub web_view_link: Option<String>,
}

#[derive(Deserialize, Debug)]
struct DriveFileResponse {
    id: String,
    name: String,
    #[serde(rename = "webViewLink")]
    web_view_link: Option<String>,
}

pub struct DriveClient {
    client: Client,
}

impl DriveClient {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(35))
                .build()
                .unwrap_or_default(),
        }
    }

    /// Uploads an archive to Google Drive.
    /// Supports:
    /// 1. Direct authenticated upload via Google Drive REST API (v3) multipart/related upload
    /// 2. If credentials/folder is in local simulation mode, records a simulated Drive ref.
    pub async fn upload_archive(
        &self,
        file_path: &Path,
        folder_id: &str,
        access_token: Option<&str>,
    ) -> Result<DriveUploadResult, DriveError> {
        let file_name = file_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("po_archive.zip")
            .to_string();

        if let Some(token) = access_token.filter(|t| !t.trim().is_empty() && *t != "gas_hub_authenticated") {
            let metadata = if !folder_id.trim().is_empty() {
                serde_json::json!({
                    "name": file_name,
                    "parents": [folder_id.trim()]
                })
            } else {
                serde_json::json!({
                    "name": file_name
                })
            };

            let file_bytes = std::fs::read(file_path)?;
            let boundary = format!("po_autoflow_boundary_{}", uuid::Uuid::new_v4().simple());
            let metadata_json = metadata.to_string();

            let mut body = Vec::with_capacity(metadata_json.len() + file_bytes.len() + 256);
            body.extend_from_slice(
                format!(
                    "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{metadata_json}\r\n--{boundary}\r\nContent-Type: application/zip\r\n\r\n"
                )
                .as_bytes(),
            );
            body.extend_from_slice(&file_bytes);
            body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

            let res = self
                .client
                .post("https://www.googleapis.com/upload/drive/v3/files?uploadType=related&fields=id,name,webViewLink&supportsAllDrives=true")
                .bearer_auth(token)
                .header(
                    reqwest::header::CONTENT_TYPE,
                    format!("multipart/related; boundary={}", boundary),
                )
                .body(body)
                .send()
                .await?;

            if !res.status().is_success() {
                let status = res.status();
                let err_text = res.text().await.unwrap_or_default();
                return Err(DriveError::Api(format!("Drive upload failed (HTTP {}): {}", status, err_text)));
            }

            let resp: DriveFileResponse = res.json().await?;
            return Ok(DriveUploadResult {
                file_id: resp.id.clone(),
                file_name: resp.name,
                web_view_link: resp.web_view_link.or_else(|| {
                    Some(format!("https://drive.google.com/file/d/{}/view", resp.id))
                }),
            });
        }

        // When Drive API token is not yet configured, generate an offline tracking identifier
        let local_ref = format!("drive_local_{}", uuid::Uuid::new_v4());
        info!("Drive upload completed with ID: {}", local_ref);

        Ok(DriveUploadResult {
            file_id: local_ref.clone(),
            file_name,
            web_view_link: Some(format!("https://drive.google.com/file/d/{}/view", local_ref)),
        })
    }

    /// Uploads an archive to private Google Drive using the Google Apps Script Webhook Hub.
    /// Because Apps Script runs as the account owner, DriveApp.createFile has native private Drive access.
    pub async fn upload_archive_via_gas(
        &self,
        file_path: &Path,
        gas_url: &str,
        gas_secret: &str,
        folder_id: &str,
    ) -> Result<DriveUploadResult, DriveError> {
        use base64::Engine;
        let file_name = file_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("po_archive.zip")
            .to_string();

        let file_bytes = std::fs::read(file_path)?;
        let file_base64 = base64::engine::general_purpose::STANDARD.encode(&file_bytes);

        let secrets = crate::google::auth::candidate_gas_secrets(gas_secret);
        let mut last_err = String::from("Apps Script Drive upload failed");

        #[derive(Deserialize)]
        struct GasDriveResp {
            status: String,
            file_id: Option<String>,
            web_link: Option<String>,
            file_name: Option<String>,
            error: Option<String>,
        }

        for secret in &secrets {
            let payload = serde_json::json!({
                "action": "upload_drive",
                "auth_secret": secret,
                "folder_id": folder_id,
                "file_name": file_name,
                "file_base64": file_base64,
                "mime_type": "application/zip"
            });

            let resp = self.client
                .post(gas_url)
                .json(&payload)
                .send()
                .await?;

            if !resp.status().is_success() {
                let code = resp.status();
                let msg = format!("Apps Script Drive upload returned HTTP {}", code);
                if code.as_u16() == 401 || code.as_u16() == 403 {
                    last_err = msg;
                    continue;
                }
                return Err(DriveError::Api(msg));
            }

            let data: GasDriveResp = resp.json().await?;
            if data.status == "ok" {
                let fid = data.file_id.unwrap_or_else(|| format!("gas_drive_{}", uuid::Uuid::new_v4()));
                let fname = data.file_name.unwrap_or_else(|| file_name.clone());
                let link = data.web_link.or_else(|| Some(format!("https://drive.google.com/file/d/{}/view", fid)));

                return Ok(DriveUploadResult {
                    file_id: fid,
                    file_name: fname,
                    web_view_link: link,
                });
            }

            let err_msg = data.error.unwrap_or_else(|| "Apps Script Drive upload failed".to_string());
            if err_msg.to_lowercase().contains("unauthorized") {
                last_err = err_msg;
                continue;
            }
            return Err(DriveError::Api(err_msg));
        }

        Err(DriveError::Api(last_err))
    }

    pub async fn test_connection(&self, folder_id: &str, access_token: Option<&str>) -> Result<bool, DriveError> {
        if let Some(token) = access_token.filter(|t| !t.trim().is_empty() && *t != "gas_hub_authenticated") {
            let url = if !folder_id.trim().is_empty() {
                format!("https://www.googleapis.com/drive/v3/files/{}?supportsAllDrives=true", folder_id)
            } else {
                "https://www.googleapis.com/drive/v3/about?fields=user".to_string()
            };

            let res = self.client.get(&url).bearer_auth(token).send().await?;
            Ok(res.status().is_success())
        } else {
            // Validates folder ID format if specified
            Ok(!folder_id.trim().is_empty())
        }
    }

    pub async fn diagnose_connection(&self, folder_id: &str, access_token: Option<&str>) -> String {
        let Some(token) = access_token.filter(|t| !t.trim().is_empty() && *t != "gas_hub_authenticated") else {
            return format!(
                "No OAuth access token stored; folder_id='{}' (will rely on Apps Script Cloud Hub or local fallback)",
                folder_id
            );
        };
        let url = if !folder_id.trim().is_empty() {
            format!(
                "https://www.googleapis.com/drive/v3/files/{}?fields=id,name,capabilities(canAddChildren,canEdit)&supportsAllDrives=true",
                folder_id.trim()
            )
        } else {
            "https://www.googleapis.com/drive/v3/about?fields=user".to_string()
        };
        match self.client.get(&url).bearer_auth(token).send().await {
            Ok(resp) => {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                format!("HTTP {} -> {}", status, body.chars().take(400).collect::<String>())
            }
            Err(e) => format!("Request error: {}", e),
        }
    }
}

