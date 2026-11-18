use crate::database::models::{CompanyCacheEntry, DepartmentCcEntry};
use reqwest::Client;
use serde::Deserialize;
use std::time::Duration;
use thiserror::Error;
use tracing::info;

#[derive(Error, Debug)]
pub enum SheetsError {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("Parse error: {0}")]
    Parse(String),
    #[error("No data found in spreadsheet")]
    Empty,
}

#[derive(Deserialize, Debug)]
struct SheetsApiResponse {
    values: Option<Vec<Vec<String>>>,
}

#[derive(Deserialize, Debug)]
struct GasSuppliersResponse {
    status: String,
    suppliers: Option<Vec<GasSupplierItem>>,
    tab_used: Option<String>,
    tab_missing: Option<bool>,
    access_token: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize, Debug)]
struct GasDepartmentItem {
    department_name: String,
    emails: String,
}

#[derive(Deserialize, Debug)]
struct GasDepartmentsResponse {
    status: String,
    departments: Option<Vec<GasDepartmentItem>>,
    #[serde(default)]
    tab_missing: Option<bool>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize, Debug)]
struct GasSupplierItem {
    company_name: String,
    alternative_name: Option<String>,
    email: String,
    tax_id: Option<String>,
    notes: Option<String>,
    vendor_group: Option<String>,
    active: Option<bool>,
}

pub fn resolve_sheet_tabs(primary_tab: &str, ov_tab: &str) -> Vec<String> {
    let mut tabs: Vec<String> = Vec::new();
    for raw in [primary_tab, ov_tab] {
        for part in raw.split([',', ';']) {
            let trimmed = part.trim();
            if !trimmed.is_empty() && !tabs.iter().any(|t| t.eq_ignore_ascii_case(trimmed)) {
                tabs.push(trimmed.to_string());
            }
        }
    }
    if tabs.is_empty() {
        tabs.push("Suppliers".to_string());
    }
    tabs
}

pub fn vendor_group_label(tab_name: &str, ov_tab: &str) -> String {
    let clean = tab_name.trim();
    let low = clean.to_lowercase();
    let ov_low = ov_tab.trim().to_lowercase();
    if (!ov_low.is_empty() && low == ov_low)
        || low == "ov"
        || low.contains("oversea")
        || low.contains("foreign")
        || low.contains("ต่างประเทศ")
    {
        "OV".to_string()
    } else if low == "dv" || low.contains("domestic") || low.contains("ในประเทศ") {
        "DV".to_string()
    } else if clean.is_empty() {
        "DV".to_string()
    } else {
        clean.to_string()
    }
}

/// Classifies whether a newly discovered vendor appears to be an overseas supplier (`OV`)
/// vs a domestic Thai supplier (`DV`) based on Thai script, Tax ID length, email TLD, and legal forms.
pub fn is_overseas_vendor(
    company_name: &str,
    alternative_name: &str,
    email: &str,
    tax_id: &str,
) -> bool {
    if crate::matching::thai_normalizer::ThaiNormalizer::contains_thai(company_name)
        || crate::matching::thai_normalizer::ThaiNormalizer::contains_thai(alternative_name)
    {
        return false;
    }

    let tax_digits: String = tax_id.chars().filter(|c| c.is_ascii_digit()).collect();
    if tax_digits.len() == 13 {
        return false;
    }

    let emails: Vec<String> = email
        .split([',', ';'])
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    if emails.iter().any(|e| {
        e.ends_with(".co.th")
            || e.ends_with(".in.th")
            || e.ends_with(".or.th")
            || e.ends_with(".ac.th")
            || e.ends_with(".go.th")
            || e.ends_with(".th")
    }) {
        return false;
    }

    let combined_low = format!("{} {}", company_name, alternative_name).to_lowercase();
    let overseas_markers = [
        "pte. ltd",
        "pte ltd",
        "gmbh",
        "sdn. bhd",
        "sdn bhd",
        "k.k.",
        "b.v.",
        "n.v.",
        "s.a.",
        "s.r.l.",
        "s.p.a.",
        "pty. ltd",
        "pty ltd",
        "ag",
        "llc",
        "llp",
        "inc.",
        "incorporated",
        "corp.",
        "corporation",
    ];
    if overseas_markers.iter().any(|m| combined_low.contains(m)) {
        return true;
    }

    // Foreign non-.th corporate domain without any Thai name or Tax ID defaults cleanly only if clearly foreign TLD
    for e in &emails {
        if let Some(domain) = e.split('@').nth(1) {
            let country_tlds = [
                ".sg", ".jp", ".cn", ".tw", ".kr", ".de", ".uk", ".co.uk", ".us", ".eu",
                ".my", ".vn", ".id", ".in", ".fr", ".it", ".ch", ".nl", ".au", ".hk",
            ];
            if country_tlds.iter().any(|tld| domain.ends_with(tld)) {
                return true;
            }
        }
    }

    false
}

enum GasParseFailure {
    Unauthorized(String),
    Fatal(String),
    Retryable(String),
}

pub struct SheetsClient {
    client: Client,
}

impl SheetsClient {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .unwrap_or_default(),
        }
    }

    /// Fetches company records from Google Sheets.
    /// Supports:
    /// 1. Direct CSV export URL (works seamlessly with public or shared sheets):
    ///    `https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet={TAB_NAME}`
    /// 2. Google Sheets API v4 with OAuth token:
    ///    `https://sheets.googleapis.com/v4/spreadsheets/{SPREADSHEET_ID}/values/{TAB_NAME}!A:E`
    pub async fn fetch_companies(
        &self,
        spreadsheet_id: &str,
        tab_name: &str,
        access_token: Option<&str>,
    ) -> Result<Vec<CompanyCacheEntry>, SheetsError> {
        if spreadsheet_id.trim().is_empty() {
            return Err(SheetsError::Parse("Spreadsheet ID is required".to_string()));
        }

        let clean_id = spreadsheet_id.trim();
        let clean_tab = if tab_name.trim().is_empty() {
            "Sheet1"
        } else {
            tab_name.trim()
        };

        if let Some(token) = access_token.filter(|t| !t.trim().is_empty() && *t != "gas_hub_authenticated") {
            let url = format!(
                "https://sheets.googleapis.com/v4/spreadsheets/{}/values/{}!A1:Z500",
                clean_id, clean_tab
            );

            let res = self
                .client
                .get(&url)
                .bearer_auth(token)
                .send()
                .await?;

            if res.status().is_success() {
                let data: SheetsApiResponse = res.json().await?;
                let values = data.values.ok_or(SheetsError::Empty)?;
                return Self::parse_matrix(values);
            }

            // Fallback with bearer token on gviz CSV endpoint (works when token has drive.readonly scope)
            let csv_url = format!(
                "https://docs.google.com/spreadsheets/d/{}/gviz/tq?tqx=out:csv&sheet={}",
                clean_id,
                urlencoding_simple(clean_tab)
            );
            let csv_resp = self.client.get(&csv_url).bearer_auth(token).send().await?;
            if csv_resp.status().is_success() {
                let csv_text = csv_resp.text().await?;
                if !csv_text.trim_start().starts_with('<') {
                    return Self::parse_csv_text(&csv_text);
                }
            }

            return Err(SheetsError::Parse(format!(
                "Sheets API returned status: {}",
                res.status()
            )));
        }

        // Fallback: Use Google Visualization CSV Export endpoint
        let csv_url = format!(
            "https://docs.google.com/spreadsheets/d/{}/gviz/tq?tqx=out:csv&sheet={}",
            clean_id,
            urlencoding_simple(clean_tab)
        );

        info!("Fetching Google Sheet CSV export from: {}", csv_url);
        let resp = self.client.get(&csv_url).send().await?;

        if !resp.status().is_success() {
            if resp.status().as_u16() == 401 {
                return Err(SheetsError::Parse(
                    "401 Unauthorized: This Google Sheet is private. Ensure your Apps Script Webhook URL is saved in Settings, or sign in with Google to access private sheets without sharing them publicly.".to_string(),
                ));
            }
            return Err(SheetsError::Parse(format!(
                "Google Sheets export returned status: {}",
                resp.status()
            )));
        }

        let csv_text = resp.text().await?;
        if csv_text.trim_start().starts_with('<') {
            return Err(SheetsError::Parse(
                "401 Unauthorized: This Google Sheet is private (Google returned a sign-in HTML page). Configure your Apps Script Webhook URL or Sign in with Google.".to_string(),
            ));
        }
        Self::parse_csv_text(&csv_text)
    }

    fn map_gas_suppliers_body(
        text: &str,
        http_status: reqwest::StatusCode,
    ) -> Result<Option<(Vec<CompanyCacheEntry>, Option<String>)>, GasParseFailure> {
        if let Ok(data) = serde_json::from_str::<GasSuppliersResponse>(text) {
            if data.status == "ok" {
                if let Some(items) = data.suppliers {
                    let now = chrono::Utc::now().to_rfc3339();
                    let tab_hint = data.tab_used.clone();
                    let entries = items
                        .into_iter()
                        .enumerate()
                        .filter_map(|(idx, item)| {
                            let primary = item.company_name.trim().to_string();
                            let alt_clean = item
                                .alternative_name
                                .as_deref()
                                .map(str::trim)
                                .filter(|s| !s.is_empty())
                                .map(str::to_string);
                            let (name, alt) = if !primary.is_empty() {
                                (primary, alt_clean)
                            } else if let Some(only_alt) = alt_clean {
                                (only_alt, None)
                            } else {
                                return None;
                            };
                            Some(CompanyCacheEntry {
                                id: format!("gas_{}_{}", idx, uuid::Uuid::new_v4().simple()),
                                company_name: name,
                                alternative_name: alt,
                                email: item.email.trim().to_string(),
                                active: item.active.unwrap_or(true),
                                tax_id: item.tax_id.filter(|t| !t.trim().is_empty()),
                                notes: item.notes.filter(|n| !n.trim().is_empty()),
                                vendor_group: item
                                    .vendor_group
                                    .filter(|v| !v.trim().is_empty())
                                    .or_else(|| tab_hint.clone()),
                                synced_at: now.clone(),
                            })
                        })
                        .collect();
                    return Ok(Some((
                        entries,
                        if data.tab_missing.unwrap_or(false) {
                            None
                        } else {
                            data.access_token
                        },
                    )));
                }
                // HTTP ok healthcheck without `suppliers` array (e.g. GET hit v1 script) -> try POST
                return Ok(None);
            } else if let Some(err) = data.error {
                let lower = err.to_lowercase();
                if lower.contains("unauthorized") || lower.contains("invalid auth_secret") {
                    return Err(GasParseFailure::Unauthorized(err));
                }
                if err.contains("SpreadsheetApp.openById")
                    || err.contains("https://www.googleapis.com/auth/spreadsheets")
                    || err.contains("คุณไม่ได้รับอนุญาต")
                {
                    return Err(GasParseFailure::Fatal(
                        "Google Apps Script needs Sheets permission: Open script.google.com, paste the updated Code.gs & appsscript.json, select 'authorizeAllPermissions' in the top bar and click Run -> Allow, then click Deploy -> Manage deployments -> Edit -> New version -> Deploy.".to_string(),
                    ));
                }
                return Err(GasParseFailure::Fatal(format!("Apps Script error: {}", err)));
            }
        }
        if text.contains("<html") || text.contains("<!DOCTYPE") {
            return Err(GasParseFailure::Fatal(
                "Apps Script returned an HTML page. Please deploy a NEW VERSION in Deploy > Manage deployments on script.google.com".to_string(),
            ));
        }
        Err(GasParseFailure::Retryable(format!(
            "Apps Script returned: HTTP {} {}",
            http_status,
            text.chars().take(120).collect::<String>()
        )))
    }

    /// Fetches company records privately via the deployed Google Apps Script Webhook.
    /// Because Apps Script runs as the sheet owner ("Execute as: Me"), it reads private sheets directly.
    /// When `suppliers` is empty (e.g. headerless 1-row sheet on an older script) and `access_token` is present,
    /// automatically fetches via Bearer CSV export so headerless sheets load cleanly.
    pub async fn fetch_companies_via_gas(
        &self,
        gas_url: &str,
        gas_secret: &str,
        spreadsheet_id: &str,
        tab_name: &str,
    ) -> Result<Vec<CompanyCacheEntry>, SheetsError> {
        self.fetch_companies_via_gas_with_options(gas_url, gas_secret, spreadsheet_id, tab_name, false)
            .await
    }

    pub async fn fetch_companies_via_gas_with_options(
        &self,
        gas_url: &str,
        gas_secret: &str,
        spreadsheet_id: &str,
        tab_name: &str,
        strict_tab: bool,
    ) -> Result<Vec<CompanyCacheEntry>, SheetsError> {
        let clean_url = gas_url.trim();
        if clean_url.is_empty() {
            return Err(SheetsError::Parse("Apps Script Webhook URL is not configured".to_string()));
        }

        let secrets = crate::google::auth::candidate_gas_secrets(gas_secret);
        let mut last_error = String::from("No response from Apps Script");
        let strict_q = if strict_tab { "&strict_tab=1" } else { "" };

        for secret in &secrets {
            // Try GET first with query parameters (robust across Google redirect hops)
            let get_url = format!(
                "{}?action=sync_suppliers&auth={}&sheet_id={}&tab_name={}{}",
                clean_url,
                urlencoding::encode(secret),
                urlencoding::encode(spreadsheet_id),
                urlencoding::encode(tab_name),
                strict_q,
            );

            let mut secret_unauthorized = false;
            match self.client.get(&get_url).send().await {
                Ok(resp) => {
                    let status = resp.status();
                    if let Ok(text) = resp.text().await {
                        match Self::map_gas_suppliers_body(&text, status) {
                            Ok(Some((entries, tok_opt))) => {
                                if !entries.is_empty() {
                                    return Ok(entries);
                                }
                                if let Some(ref tok) = tok_opt.filter(|t| !t.trim().is_empty()) {
                                    if let Ok(fetched) = self.fetch_companies(spreadsheet_id, tab_name, Some(tok)).await {
                                        if !fetched.is_empty() {
                                            return Ok(fetched);
                                        }
                                    }
                                }
                                return Ok(entries);
                            }
                            Ok(None) => {}
                            Err(GasParseFailure::Unauthorized(err)) => {
                                last_error = format!("Apps Script error: {}", err);
                                secret_unauthorized = true;
                            }
                            Err(GasParseFailure::Fatal(msg)) => {
                                return Err(SheetsError::Parse(msg));
                            }
                            Err(GasParseFailure::Retryable(msg)) => {
                                last_error = msg;
                            }
                        }
                    }
                }
                Err(e) => {
                    last_error = format!("HTTP GET error: {}", e);
                }
            }

            if secret_unauthorized {
                continue;
            }

            // Fallback: Try POST with JSON payload
            let payload = serde_json::json!({
                "action": "sync_suppliers",
                "auth_secret": secret,
                "sheet_id": spreadsheet_id,
                "tab_name": tab_name,
                "strict_tab": strict_tab
            });

            match self.client.post(clean_url).json(&payload).send().await {
                Ok(resp) => {
                    let status = resp.status();
                    let text = resp.text().await.unwrap_or_default();
                    match Self::map_gas_suppliers_body(&text, status) {
                        Ok(Some((entries, tok_opt))) => {
                            if !entries.is_empty() {
                                return Ok(entries);
                            }
                            if let Some(ref tok) = tok_opt.filter(|t| !t.trim().is_empty()) {
                                if let Ok(fetched) = self.fetch_companies(spreadsheet_id, tab_name, Some(tok)).await {
                                    if !fetched.is_empty() {
                                        return Ok(fetched);
                                    }
                                }
                            }
                            return Ok(entries);
                        }
                        Ok(None) => {
                            return Err(SheetsError::Parse(
                                "Apps Script returned OK but no supplier rows. Ensure the latest Code.gs is deployed as a New version.".to_string(),
                            ));
                        }
                        Err(GasParseFailure::Unauthorized(err)) => {
                            last_error = format!("Apps Script error: {}", err);
                            continue;
                        }
                        Err(GasParseFailure::Fatal(msg)) => {
                            return Err(SheetsError::Parse(msg));
                        }
                        Err(GasParseFailure::Retryable(msg)) => {
                            last_error = format!("{} (POST HTTP {})", msg, status);
                        }
                    }
                }
                Err(e) => {
                    last_error = format!("Apps Script connection failed: {} (GET detail: {})", e, last_error);
                }
            }
        }

        Err(SheetsError::Parse(last_error))
    }

    pub async fn fetch_companies_for_tabs_via_gas(
        &self,
        gas_url: &str,
        gas_secret: &str,
        spreadsheet_id: &str,
        primary_tab: &str,
        ov_tab: &str,
    ) -> Result<Vec<CompanyCacheEntry>, SheetsError> {
        let tabs = resolve_sheet_tabs(primary_tab, ov_tab);
        if tabs.len() == 1 {
            let mut entries = self
                .fetch_companies_via_gas(gas_url, gas_secret, spreadsheet_id, &tabs[0])
                .await?;
            let grp = vendor_group_label(&tabs[0], ov_tab);
            for entry in &mut entries {
                if entry.vendor_group.as_deref().map(str::trim).unwrap_or("").is_empty() {
                    entry.vendor_group = Some(grp.clone());
                } else if let Some(ref g) = entry.vendor_group {
                    entry.vendor_group = Some(vendor_group_label(g, ov_tab));
                }
            }
            return Ok(entries);
        }

        let mut merged: Vec<CompanyCacheEntry> = Vec::new();
        let mut seen_keys = std::collections::HashSet::<String>::new();
        let mut errors: Vec<String> = Vec::new();

        for (tab_idx, tab) in tabs.iter().enumerate() {
            match self
                .fetch_companies_via_gas_with_options(gas_url, gas_secret, spreadsheet_id, tab, true)
                .await
            {
                Ok(mut entries) => {
                    let grp = vendor_group_label(tab, ov_tab);
                    for (row_idx, entry) in entries.iter_mut().enumerate() {
                        entry.id = format!("gas_t{}_{}_{}", tab_idx, row_idx, uuid::Uuid::new_v4().simple());
                        entry.vendor_group = Some(
                            entry
                                .vendor_group
                                .as_deref()
                                .map(|g| vendor_group_label(g, ov_tab))
                                .unwrap_or_else(|| grp.clone()),
                        );
                        let key = format!(
                            "{}|{}",
                            entry.company_name.trim().to_lowercase(),
                            entry.email.trim().to_lowercase()
                        );
                        if seen_keys.insert(key) {
                            merged.push(entry.clone());
                        }
                    }
                }
                Err(e) => {
                    let msg = e.to_string();
                    // Empty data rows on an optional second tab (e.g. brand-new empty OV sheet) shouldn't block DV
                    if msg.contains("No data") || msg.contains("0 rows") || msg.contains("0 data rows") {
                        continue;
                    }
                    errors.push(format!("Tab '{}': {}", tab, msg));
                }
            }
        }

        if merged.is_empty() && !errors.is_empty() {
            return Err(SheetsError::Parse(errors.join(" | ")));
        }
        Ok(merged)
    }

    pub async fn fetch_companies_for_tabs(
        &self,
        spreadsheet_id: &str,
        primary_tab: &str,
        ov_tab: &str,
        access_token: Option<&str>,
    ) -> Result<Vec<CompanyCacheEntry>, SheetsError> {
        let tabs = resolve_sheet_tabs(primary_tab, ov_tab);
        if tabs.len() == 1 {
            let mut entries = self
                .fetch_companies(spreadsheet_id, &tabs[0], access_token)
                .await?;
            let grp = vendor_group_label(&tabs[0], ov_tab);
            for entry in &mut entries {
                if entry.vendor_group.is_none() {
                    entry.vendor_group = Some(grp.clone());
                }
            }
            return Ok(entries);
        }

        let mut merged: Vec<CompanyCacheEntry> = Vec::new();
        let mut seen_keys = std::collections::HashSet::<String>::new();
        let mut errors: Vec<String> = Vec::new();

        for (tab_idx, tab) in tabs.iter().enumerate() {
            match self.fetch_companies(spreadsheet_id, tab, access_token).await {
                Ok(entries) => {
                    let grp = vendor_group_label(tab, ov_tab);
                    for (row_idx, mut entry) in entries.into_iter().enumerate() {
                        entry.id = format!("sheet_t{}_{}", tab_idx, row_idx + 1);
                        entry.vendor_group = Some(grp.clone());
                        let key = format!(
                            "{}|{}",
                            entry.company_name.trim().to_lowercase(),
                            entry.email.trim().to_lowercase()
                        );
                        if seen_keys.insert(key) {
                            merged.push(entry);
                        }
                    }
                }
                Err(SheetsError::Empty) => continue,
                Err(e) => errors.push(format!("Tab '{}': {}", tab, e)),
            }
        }

        if merged.is_empty() {
            if !errors.is_empty() {
                return Err(SheetsError::Parse(errors.join(" | ")));
            }
            return Err(SheetsError::Empty);
        }
        Ok(merged)
    }

    pub fn parse_matrix(matrix: Vec<Vec<String>>) -> Result<Vec<CompanyCacheEntry>, SheetsError> {
        if matrix.is_empty() {
            return Err(SheetsError::Empty);
        }

        let first_row = &matrix[0];
        let first_row_has_email = first_row
            .iter()
            .any(|c| crate::email::EmailDeliveryClient::is_valid_email(c.trim()));
        let has_header_keyword = find_header_col(
            first_row,
            &[
                "company", "ชื่อบริษัท", "ชื่อผู้ขาย", "บริษัท", "supplier", "vendor",
                "thai", "english", "ชื่อไทย", "ชื่ออังกฤษ", "email", "อีเมล", "proofing",
            ],
        )
        .is_some();
        let is_headerless = first_row_has_email || !has_header_keyword;

        let (name_idx, email_idx, alt_idx, notes_idx, tax_idx, active_idx, start_row) = if is_headerless {
            let e_idx = first_row
                .iter()
                .position(|c| c.contains('@'))
                .unwrap_or(1);
            let n_idx = first_row
                .iter()
                .enumerate()
                .position(|(idx, c)| idx != e_idx && !c.trim().is_empty())
                .unwrap_or(if e_idx == 0 { 1 } else { 0 });
            let mut text_cols = first_row
                .iter()
                .enumerate()
                .filter(|(idx, c)| *idx != n_idx && *idx != e_idx && !c.trim().is_empty())
                .map(|(idx, _)| idx);
            let a_idx = text_cols.next();
            let note_idx = text_cols.next();
            (n_idx, e_idx, a_idx, note_idx, None, None, 0usize)
        } else {
            if matrix.len() <= 1 {
                return Err(SheetsError::Empty);
            }
            let n_idx = find_header_col_excluding(
                first_row,
                &[
                    "company name", "thai name", "name (th)", "name th", "company (th)",
                    "ชื่อบริษัท", "ชื่อผู้ขาย", "ชื่อไทย", "ชื่อภาษาไทย", "บริษัท", "company", "supplier",
                ],
                &[],
            )
            .unwrap_or(0);
            let e_idx = find_header_col_excluding(
                first_row,
                &["email", "email address", "อีเมล", "e-mail"],
                &[n_idx],
            )
            .unwrap_or(if first_row.len() == 2 { 1 } else { 2 });
            let a_idx = find_header_col_excluding(
                first_row,
                &[
                    "alternative name", "alt name", "english name", "name (en)", "name en",
                    "company (en)", "company en", "alias", "ชื่ออังกฤษ", "ชื่อภาษาอังกฤษ", "ภาษาอังกฤษ",
                    "ชื่อสำรอง", "ชื่ออื่น", "thai name", "name (th)", "name th", "ชื่อไทย", "ชื่อภาษาไทย",
                ],
                &[n_idx, e_idx],
            );
            let mut excluded = vec![n_idx, e_idx];
            if let Some(a) = a_idx {
                excluded.push(a);
            }
            let note_idx = find_header_col_excluding(
                first_row,
                &[
                    "proofing", "proof", "reference", "ref.", "remark", "remarks", "notes", "note",
                    "หมายเหตุ", "ตรวจทาน", "ตรวจสอบ", "อ้างอิง",
                ],
                &excluded,
            );
            if let Some(n) = note_idx {
                excluded.push(n);
            }
            let t_idx = find_header_col_excluding(
                first_row,
                &["tax id", "tax_id", "tax no", "tin", "เลขประจำตัวผู้เสียภาษี", "เลขผู้เสียภาษี"],
                &excluded,
            );
            if let Some(t) = t_idx {
                excluded.push(t);
            }
            let act_idx = find_header_col_excluding(
                first_row,
                &["active", "status", "สถานะ", "ใช้งาน"],
                &excluded,
            );
            (n_idx, e_idx, a_idx, note_idx, t_idx, act_idx, 1usize)
        };

        let mut entries = Vec::new();
        let now = chrono::Utc::now().to_rfc3339();

        for (i, row) in matrix.iter().skip(start_row).enumerate() {
            if row.is_empty() {
                continue;
            }

            let primary_raw = row.get(name_idx).map(|s| s.trim()).unwrap_or("");
            let alt_raw = alt_idx
                .and_then(|idx| row.get(idx))
                .map(|s| s.trim())
                .filter(|s| !s.is_empty());

            // Support keeping both English & Thai, OR filling only one of them per row
            let (name, alt) = if !primary_raw.is_empty() {
                (primary_raw.to_string(), alt_raw.map(|s| s.to_string()))
            } else if let Some(only_alt) = alt_raw {
                (only_alt.to_string(), None)
            } else {
                continue;
            };

            let email = row.get(email_idx).map(|s| s.trim()).unwrap_or("");
            let notes = notes_idx
                .and_then(|idx| row.get(idx))
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            let tax_id = tax_idx
                .and_then(|idx| row.get(idx))
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            let active_str = active_idx
                .and_then(|idx| row.get(idx))
                .map(|s| s.trim().to_lowercase())
                .unwrap_or_default();
            let active = active_str != "false" && active_str != "0" && active_str != "inactive" && active_str != "no";

            entries.push(CompanyCacheEntry {
                id: format!("sheet_row_{}", i + start_row + 1),
                company_name: name,
                alternative_name: alt,
                email: email.to_string(),
                active,
                tax_id,
                notes,
                vendor_group: None,
                synced_at: now.clone(),
            });
        }

        if entries.is_empty() {
            return Err(SheetsError::Empty);
        }

        Ok(entries)
    }

    fn parse_csv_text(csv_text: &str) -> Result<Vec<CompanyCacheEntry>, SheetsError> {
        let mut lines = Vec::new();
        for line in csv_text.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let row = split_csv_line(trimmed);
            if !row.is_empty() {
                lines.push(row);
            }
        }
        Self::parse_matrix(lines)
    }

    pub async fn fetch_departments_via_gas(
        &self,
        gas_url: &str,
        gas_secret: &str,
        spreadsheet_id: &str,
        dept_tab: &str,
    ) -> Result<Vec<DepartmentCcEntry>, SheetsError> {
        let clean_url = gas_url.trim();
        if clean_url.is_empty() || spreadsheet_id.trim().is_empty() {
            return Ok(Vec::new());
        }
        let secrets = crate::google::auth::candidate_gas_secrets(gas_secret);
        let mut last_err = String::new();

        for secret in &secrets {
            let get_url = format!(
                "{}?action=sync_departments&auth={}&sheet_id={}&tab_name={}",
                clean_url,
                urlencoding::encode(secret),
                urlencoding::encode(spreadsheet_id.trim()),
                urlencoding::encode(dept_tab.trim()),
            );
            if let Ok(resp) = self.client.get(&get_url).send().await {
                if let Ok(text) = resp.text().await {
                    if let Ok(parsed) = serde_json::from_str::<GasDepartmentsResponse>(&text) {
                        if parsed.status == "ok" {
                            if let Some(items) = parsed.departments {
                                if !items.is_empty() || parsed.tab_missing.unwrap_or(false) {
                                    let now = chrono::Utc::now().to_rfc3339();
                                    let list = items
                                        .into_iter()
                                        .enumerate()
                                        .filter_map(|(idx, item)| {
                                            let emails = crate::email::EmailDeliveryClient::merge_cc_lists(&[&item.emails]);
                                            if item.department_name.trim().is_empty() || emails.is_empty() {
                                                None
                                            } else {
                                                Some(DepartmentCcEntry {
                                                    id: format!("dept_gas_{}", idx + 1),
                                                    department_name: item.department_name.trim().to_string(),
                                                    emails,
                                                    synced_at: now.clone(),
                                                })
                                            }
                                        })
                                        .collect();
                                    return Ok(list);
                                }
                            }
                        } else if let Some(err) = parsed.error {
                            if err.to_lowercase().contains("unauthorized") {
                                last_err = err;
                                continue;
                            }
                            return Err(SheetsError::Parse(err));
                        }
                    }
                }
            }

            let payload = serde_json::json!({
                "action": "sync_departments",
                "auth_secret": secret,
                "sheet_id": spreadsheet_id.trim(),
                "tab_name": dept_tab.trim(),
            });
            if let Ok(resp) = self.client.post(clean_url).json(&payload).send().await {
                if let Ok(text) = resp.text().await {
                    if let Ok(parsed) = serde_json::from_str::<GasDepartmentsResponse>(&text) {
                        if parsed.status == "ok" {
                            let items = parsed.departments.unwrap_or_default();
                            let now = chrono::Utc::now().to_rfc3339();
                            let list = items
                                .into_iter()
                                .enumerate()
                                .filter_map(|(idx, item)| {
                                    let emails = crate::email::EmailDeliveryClient::merge_cc_lists(&[&item.emails]);
                                    if item.department_name.trim().is_empty() || emails.is_empty() {
                                        None
                                    } else {
                                        Some(DepartmentCcEntry {
                                            id: format!("dept_gas_{}", idx + 1),
                                            department_name: item.department_name.trim().to_string(),
                                            emails,
                                            synced_at: now.clone(),
                                        })
                                    }
                                })
                                .collect();
                            return Ok(list);
                        } else if let Some(err) = parsed.error {
                            if err.to_lowercase().contains("unauthorized") {
                                last_err = err;
                                continue;
                            }
                            return Err(SheetsError::Parse(err));
                        }
                    }
                }
            }
        }

        if !last_err.is_empty() {
            Err(SheetsError::Parse(last_err))
        } else {
            Ok(Vec::new())
        }
    }

    pub async fn fetch_departments(
        &self,
        spreadsheet_id: &str,
        dept_tab: &str,
        access_token: Option<&str>,
    ) -> Result<Vec<DepartmentCcEntry>, SheetsError> {
        let clean_id = spreadsheet_id.trim();
        let clean_tab = dept_tab.trim();
        if clean_id.is_empty() || clean_tab.is_empty() {
            return Ok(Vec::new());
        }

        if let Some(token) = access_token.filter(|t| !t.trim().is_empty() && *t != "gas_hub_authenticated") {
            let url = format!(
                "https://sheets.googleapis.com/v4/spreadsheets/{}/values/{}!A1:Z500",
                clean_id, clean_tab
            );
            if let Ok(res) = self.client.get(&url).bearer_auth(token).send().await {
                if res.status().is_success() {
                    let data: SheetsApiResponse = res.json().await?;
                    if let Some(values) = data.values {
                        return Self::parse_department_matrix(values);
                    }
                }
            }
        }

        let csv_url = format!(
            "https://docs.google.com/spreadsheets/d/{}/gviz/tq?tqx=out:csv&sheet={}",
            clean_id,
            urlencoding_simple(clean_tab)
        );
        let mut req = self.client.get(&csv_url);
        if let Some(token) = access_token.filter(|t| !t.trim().is_empty() && *t != "gas_hub_authenticated") {
            req = req.bearer_auth(token);
        }
        let resp = req.send().await?;
        if !resp.status().is_success() {
            return Ok(Vec::new());
        }
        let csv_text = resp.text().await?;
        if csv_text.trim_start().starts_with('<') {
            return Ok(Vec::new());
        }
        let mut rows = Vec::new();
        for line in csv_text.lines() {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                rows.push(split_csv_line(trimmed));
            }
        }
        Self::parse_department_matrix(rows)
    }

    /// Parses a Department -> Email mapping sheet (supports `No. | แผนก | Email`, merging duplicate departments).
    pub fn parse_department_matrix(matrix: Vec<Vec<String>>) -> Result<Vec<DepartmentCcEntry>, SheetsError> {
        if matrix.is_empty() {
            return Ok(Vec::new());
        }
        let first_row = &matrix[0];
        let has_header = find_header_col(
            first_row,
            &["แผนก", "department", "dept", "email", "อีเมล", "no.", "no", "#"],
        )
        .is_some();

        let (dept_idx, email_idx, start_row) = if has_header {
            let d_idx = find_header_col_excluding(
                first_row,
                &["แผนก", "department", "dept", "section", "division"],
                &[],
            )
            .unwrap_or(if first_row.len() >= 3 { 1 } else { 0 });
            let e_idx = find_header_col_excluding(
                first_row,
                &["email", "อีเมล", "e-mail", "mail", "cc"],
                &[d_idx],
            )
            .unwrap_or(if first_row.len() >= 3 { 2 } else { 1 });
            (d_idx, e_idx, 1usize)
        } else {
            let e_idx = first_row
                .iter()
                .position(|c| c.contains('@'))
                .unwrap_or(if first_row.len() >= 3 { 2 } else { 1 });
            let d_idx = first_row
                .iter()
                .enumerate()
                .position(|(idx, c)| {
                    idx != e_idx
                        && !c.trim().is_empty()
                        && !c.trim().chars().all(|ch| ch.is_ascii_digit())
                })
                .unwrap_or(if first_row.len() >= 3 { 1 } else { 0 });
            (d_idx, e_idx, 0usize)
        };

        let now = chrono::Utc::now().to_rfc3339();
        let mut merged_order: Vec<String> = Vec::new();
        let mut merged_map: std::collections::HashMap<String, (String, Vec<String>)> =
            std::collections::HashMap::new();

        for row in matrix.iter().skip(start_row) {
            let dept_name = row.get(dept_idx).map(|s| s.trim()).unwrap_or("");
            let raw_email = row.get(email_idx).map(|s| s.trim()).unwrap_or("");
            if dept_name.is_empty() || raw_email.is_empty() {
                continue;
            }
            let normalized_email = crate::email::EmailDeliveryClient::merge_cc_lists(&[raw_email]);
            if normalized_email.is_empty() {
                continue;
            }
            let (_, key) = crate::matching::CompanyMatcher::normalize_department_key(dept_name);
            if key.is_empty() {
                continue;
            }
            let entry = merged_map
                .entry(key.clone())
                .or_insert_with(|| {
                    merged_order.push(key.clone());
                    (dept_name.to_string(), Vec::new())
                });
            entry.1.push(normalized_email);
        }

        let entries = merged_order
            .into_iter()
            .enumerate()
            .filter_map(|(idx, key)| {
                merged_map.remove(&key).map(|(dept_name, email_chunks)| {
                    let refs: Vec<&str> = email_chunks.iter().map(|s| s.as_str()).collect();
                    DepartmentCcEntry {
                        id: format!("dept_row_{}", idx + 1),
                        department_name: dept_name,
                        emails: crate::email::EmailDeliveryClient::merge_cc_lists(&refs),
                        synced_at: now.clone(),
                    }
                })
            })
            .collect();

        Ok(entries)
    }

    pub async fn test_connection(&self, spreadsheet_id: &str, tab_name: &str, access_token: Option<&str>) -> Result<usize, SheetsError> {
        let list = self.fetch_companies(spreadsheet_id, tab_name, access_token).await?;
        Ok(list.len())
    }
}

fn split_csv_line(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            '"' => {
                if in_quotes && chars.peek() == Some(&'"') {
                    chars.next();
                    current.push('"');
                } else {
                    in_quotes = !in_quotes;
                }
            }
            ',' if !in_quotes => {
                fields.push(current.trim().to_string());
                current.clear();
            }
            _ => current.push(c),
        }
    }
    fields.push(current.trim().to_string());
    fields
}

fn find_header_col(header: &[String], targets: &[&str]) -> Option<usize> {
    find_header_col_excluding(header, targets, &[])
}

fn find_header_col_excluding(
    header: &[String],
    targets: &[&str],
    excluded: &[usize],
) -> Option<usize> {
    for (idx, col) in header.iter().enumerate() {
        if excluded.contains(&idx) {
            continue;
        }
        let clean = col.trim().to_lowercase();
        for t in targets {
            if clean == *t || clean.contains(t) {
                return Some(idx);
            }
        }
    }
    None
}

fn urlencoding_simple(s: &str) -> String {
    s.replace(' ', "%20")
}

