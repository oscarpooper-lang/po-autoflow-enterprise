use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use thiserror::Error;
use tracing::{info, warn};

#[derive(Error, Debug)]
pub enum EmailError {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("Apps Script delivery failed: {0}")]
    DeliveryFailed(String),
    #[error("Invalid email address: {0}")]
    InvalidEmail(String),
    #[error("Configuration missing: {0}")]
    ConfigMissing(String),
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct EmailAttachmentPayload {
    pub file_name: String,
    pub mime_type: String,
    pub file_base64: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GasDeliveryRequest {
    pub transaction_id: String,
    pub po_number: String,
    pub company_name: String,
    pub recipient_email: String,
    pub drive_file_id: Option<String>,
    pub idempotency_key: String,
    pub auth_secret: String,
    pub subject: String,
    pub body: String,
    #[serde(default)]
    pub attachment_mode: String,
    #[serde(default)]
    pub force_drive_link: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub cc_emails: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<EmailAttachmentPayload>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GasDeliveryResponse {
    pub status: String,
    pub execution_id: Option<String>,
    pub transaction_id: Option<String>,
    pub po_number: Option<String>,
    pub recipient: Option<String>,
    #[serde(default)]
    pub cc: Option<String>,
    pub timestamp: Option<String>,
    pub duplicate_suppressed: Option<bool>,
    pub attachment_sent: Option<bool>,
    pub error: Option<String>,
}

pub struct EmailDeliveryClient {
    client: Client,
}

impl EmailDeliveryClient {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(45))
                .build()
                .unwrap_or_default(),
        }
    }

    /// Interpolates email template variables.
    pub fn format_template(
        template: &str,
        po_number: &str,
        company_name: &str,
        date_str: &str,
    ) -> String {
        template
            .replace("{{PO_NUMBER}}", po_number)
            .replace("{{COMPANY_NAME}}", company_name)
            .replace("{{DATE}}", date_str)
    }

    /// Returns the MIME content type for previewable email attachments.
    pub fn mime_type_for_path(path: &std::path::Path) -> &'static str {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        match ext.as_str() {
            "pdf" => "application/pdf",
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "tif" | "tiff" => "image/tiff",
            "bmp" => "image/bmp",
            "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            _ => "application/octet-stream",
        }
    }

    /// Validates a single trimmed email address syntax (no delimiters/whitespace).
    pub fn is_valid_single_email(email: &str) -> bool {
        let trimmed = email.trim();
        if trimmed.len() < 5
            || !trimmed.contains('@')
            || trimmed.chars().any(|c| c.is_whitespace() || c == ',' || c == ';')
        {
            return false;
        }
        let parts: Vec<&str> = trimmed.split('@').collect();
        if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
            return false;
        }
        parts[1].contains('.') && !parts[1].starts_with('.') && !parts[1].ends_with('.')
    }

    /// Parses one or more recipient emails separated by commas (`,`) or semicolons (`;`).
    /// Returns deduplicated, trimmed addresses, or an error if empty or any entry is malformed.
    pub fn parse_recipient_emails(raw: &str) -> Result<Vec<String>, String> {
        let mut out: Vec<String> = Vec::new();
        for part in raw.split([',', ';']) {
            let trimmed = part.trim();
            if trimmed.is_empty() {
                continue;
            }
            if !Self::is_valid_single_email(trimmed) {
                return Err(format!("Invalid email address: '{}'", trimmed));
            }
            if !out.iter().any(|existing| existing.eq_ignore_ascii_case(trimmed)) {
                out.push(trimmed.to_string());
            }
        }
        if out.is_empty() {
            return Err("Recipient email is empty".to_string());
        }
        Ok(out)
    }

    /// Normalizes a single or comma/semicolon-separated recipient list into `"a@b.com, c@d.com"`.
    pub fn normalize_recipient_list(raw: &str) -> Result<String, String> {
        Ok(Self::parse_recipient_emails(raw)?.join(", "))
    }

    /// Normalizes optional CC emails (returns empty string if empty; allows internal company domains).
    pub fn normalize_cc_list(raw: &str) -> Result<String, String> {
        if raw.split([',', ';']).all(|part| part.trim().is_empty()) {
            return Ok(String::new());
        }
        Self::normalize_recipient_list(raw)
    }

    /// Merges multiple optional CC strings (e.g. global default CC + department auto-CC),
    /// validating and deduplicating addresses case-insensitively while preserving order.
    pub fn merge_cc_lists(parts: &[&str]) -> String {
        let mut out: Vec<String> = Vec::new();
        for raw in parts {
            for token in raw.split([',', ';', '\n', '\r']) {
                let trimmed = token.trim();
                if Self::is_valid_single_email(trimmed)
                    && !out.iter().any(|existing| existing.eq_ignore_ascii_case(trimmed))
                {
                    out.push(trimmed.to_string());
                }
            }
        }
        out.join(", ")
    }

    /// Validates one or more comma/semicolon-separated email addresses.
    pub fn is_valid_email(email: &str) -> bool {
        Self::parse_recipient_emails(email).is_ok()
    }

    /// Delivers PO package through Google Apps Script endpoint with idempotency and retry protection.
    pub async fn send_po_email(
        &self,
        gas_url: &str,
        auth_secret: &str,
        tx_id: &str,
        po_number: &str,
        company_name: &str,
        recipient_email: &str,
        drive_file_id: Option<&str>,
        idempotency_key: &str,
        subject_template: &str,
        body_template: &str,
    ) -> Result<GasDeliveryResponse, EmailError> {
        self.send_po_email_with_attachments(
            gas_url,
            auth_secret,
            tx_id,
            po_number,
            company_name,
            recipient_email,
            drive_file_id,
            idempotency_key,
            subject_template,
            body_template,
            "individual_files",
            Vec::new(),
        )
        .await
    }

    /// Delivers PO package with explicit attachment mode and previewable inline document attachments.
    pub async fn send_po_email_with_attachments(
        &self,
        gas_url: &str,
        auth_secret: &str,
        tx_id: &str,
        po_number: &str,
        company_name: &str,
        recipient_email: &str,
        drive_file_id: Option<&str>,
        idempotency_key: &str,
        subject_template: &str,
        body_template: &str,
        attachment_mode: &str,
        attachments: Vec<EmailAttachmentPayload>,
    ) -> Result<GasDeliveryResponse, EmailError> {
        self.send_po_email_with_options(
            gas_url,
            auth_secret,
            tx_id,
            po_number,
            company_name,
            recipient_email,
            drive_file_id,
            idempotency_key,
            subject_template,
            body_template,
            attachment_mode,
            attachments,
            false,
            "",
        )
        .await
    }

    /// Delivers PO package with explicit attachment mode, inline attachments, Drive link enforcement, and optional CC.
    #[allow(clippy::too_many_arguments)]
    pub async fn send_po_email_with_options(
        &self,
        gas_url: &str,
        auth_secret: &str,
        tx_id: &str,
        po_number: &str,
        company_name: &str,
        recipient_email: &str,
        drive_file_id: Option<&str>,
        idempotency_key: &str,
        subject_template: &str,
        body_template: &str,
        attachment_mode: &str,
        attachments: Vec<EmailAttachmentPayload>,
        force_drive_link: bool,
        cc_emails: &str,
    ) -> Result<GasDeliveryResponse, EmailError> {
        if gas_url.trim().is_empty() {
            return Err(EmailError::ConfigMissing(
                "Google Apps Script Webhook URL is not configured".to_string(),
            ));
        }

        let normalized_recipients = Self::normalize_recipient_list(recipient_email)
            .map_err(|_| EmailError::InvalidEmail(recipient_email.to_string()))?;
        let normalized_cc = Self::normalize_cc_list(cc_emails)
            .map_err(EmailError::InvalidEmail)?;

        let now_str = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let subject = Self::format_template(subject_template, po_number, company_name, &now_str);
        let body = Self::format_template(body_template, po_number, company_name, &now_str);

        let secrets = crate::google::auth::candidate_gas_secrets(auth_secret);
        let mut last_auth_err: Option<EmailError> = None;

        'secret_loop: for secret in &secrets {
            let payload = GasDeliveryRequest {
                transaction_id: tx_id.to_string(),
                po_number: po_number.to_string(),
                company_name: company_name.to_string(),
                recipient_email: normalized_recipients.clone(),
                drive_file_id: drive_file_id.map(|s| s.to_string()),
                idempotency_key: idempotency_key.to_string(),
                auth_secret: secret.clone(),
                subject: subject.clone(),
                body: body.clone(),
                attachment_mode: attachment_mode.to_string(),
                force_drive_link,
                cc_emails: normalized_cc.clone(),
                attachments: attachments.clone(),
            };

            info!(
                "Invoking GAS endpoint for PO: {}, Recipient: {}, Idempotency: {}",
                po_number, recipient_email, idempotency_key
            );

            // Attempt delivery with controlled retry (up to 3 attempts with exponential backoff)
            let mut attempts = 0;
            let max_attempts = 3;
            let mut backoff_ms = 1000;

            loop {
                attempts += 1;
                match self.client.post(gas_url).json(&payload).send().await {
                    Ok(resp) => {
                        let status_code = resp.status();
                        let raw_body = resp.text().await.unwrap_or_default();
                        if status_code.is_success() {
                            let gas_resp: GasDeliveryResponse = match serde_json::from_str(&raw_body) {
                                Ok(parsed) => parsed,
                                Err(parse_err) => {
                                    let low_body = raw_body.to_lowercase();
                                    let snippet: String = raw_body.chars().take(220).collect();
                                    let hint = if low_body.contains("<!doctype html") || low_body.contains("<html") {
                                        if low_body.contains("servicelogin") || low_body.contains("accounts.google.com") {
                                            "Google Apps Script returned a login/permission HTML page — verify Web App Execute as 'Me' & Who has access 'Anyone'."
                                        } else if low_body.contains("too many times") || low_body.contains("quota") {
                                            "Google Apps Script daily Gmail/execution quota exceeded."
                                        } else {
                                            "Google Apps Script returned an HTML error page instead of JSON."
                                        }
                                    } else {
                                        "Unexpected non-JSON response from Google Apps Script."
                                    };
                                    return Err(EmailError::DeliveryFailed(format!(
                                        "{} ({}) [{}]",
                                        hint,
                                        parse_err,
                                        snippet.replace(['\r', '\n'], " ")
                                    )));
                                }
                            };
                            if gas_resp.status == "failed" {
                                let err_msg = gas_resp.error.unwrap_or_else(|| "Unknown GAS error".to_string());
                                if err_msg.to_lowercase().contains("unauthorized") {
                                    last_auth_err = Some(EmailError::DeliveryFailed(err_msg));
                                    continue 'secret_loop;
                                }
                                return Err(EmailError::DeliveryFailed(err_msg));
                            }
                            info!(
                                "Email delivery succeeded via Apps Script: Execution ID: {:?}",
                                gas_resp.execution_id
                            );
                            return Ok(gas_resp);
                        } else if attempts < max_attempts && (status_code.is_server_error() || status_code.as_u16() == 429) {
                            warn!(
                                "GAS returned {}: retrying attempt {}/{} in {}ms",
                                status_code, attempts, max_attempts, backoff_ms
                            );
                            tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                            backoff_ms *= 2;
                            continue;
                        } else {
                            let snippet: String = raw_body.chars().take(280).collect();
                            return Err(EmailError::DeliveryFailed(format!(
                                "GAS error (HTTP {}): {}",
                                status_code, snippet
                            )));
                        }
                    }
                    Err(e) => {
                        if attempts < max_attempts && (e.is_timeout() || e.is_connect()) {
                            warn!(
                                "Network connection failed to GAS: {}: retrying {}/{} in {}ms",
                                e, attempts, max_attempts, backoff_ms
                            );
                            tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                            backoff_ms *= 2;
                            continue;
                        }
                        return Err(EmailError::Http(e));
                    }
                }
            }
        }

        Err(last_auth_err.unwrap_or_else(|| EmailError::DeliveryFailed("Unauthorized: Invalid AUTH_SECRET".to_string())))
    }

    /// Health and authorization check for the Apps Script endpoint.
    pub async fn test_connection(&self, gas_url: &str, auth_secret: Option<&str>) -> Result<bool, EmailError> {
        let clean_url = gas_url.trim();
        if clean_url.is_empty() {
            return Err(EmailError::ConfigMissing("URL is empty".to_string()));
        }

        #[derive(Deserialize)]
        struct HealthResp {
            status: String,
            authorized: Option<bool>,
            error: Option<String>,
        }

        let secrets = crate::google::auth::candidate_gas_secrets(auth_secret.unwrap_or(""));
        let mut last_err = String::from("Webhook did not verify authorization");

        for secret in &secrets {
            let url = format!("{}?auth={}", clean_url, urlencoding::encode(secret));
            let resp = self.client.get(&url).send().await?;
            let status_code = resp.status();
            let text = resp.text().await.unwrap_or_default();

            if !status_code.is_success() {
                last_err = format!("HTTP {}", status_code);
                continue;
            }

            if let Ok(parsed) = serde_json::from_str::<HealthResp>(&text) {
                if parsed.status == "ok" && parsed.authorized != Some(false) {
                    return Ok(true);
                }
                if parsed.authorized == Some(false) {
                    last_err = "Unauthorized: Webhook AUTH_SECRET does not match Script Properties".to_string();
                    continue;
                }
                if let Some(err) = parsed.error {
                    last_err = err;
                    continue;
                }
            } else if text.contains("<html") || text.contains("<!DOCTYPE") {
                return Err(EmailError::DeliveryFailed(
                    "Webhook returned HTML instead of JSON. Ensure Web App access is set to 'Anyone'.".to_string(),
                ));
            }
        }

        Err(EmailError::DeliveryFailed(last_err))
    }
}
