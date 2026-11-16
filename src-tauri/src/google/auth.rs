use crate::database::models::GoogleAccountInfo;
use reqwest::Client;
use serde::Deserialize;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tracing::{info, warn};

pub const DEFAULT_GOOGLE_CLIENT_ID: &str = "1049281736452-autoflowenterprise.apps.googleusercontent.com";
pub const DEFAULT_GOOGLE_CLIENT_SECRET: &str = "GOCSPX-poautoflowenterprisekey";

#[derive(Deserialize, Debug)]
#[allow(dead_code)]
struct GoogleTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: i64,
    token_type: Option<String>,
}

#[derive(Deserialize, Debug)]
struct GoogleUserInfoResponse {
    email: String,
    name: Option<String>,
    picture: Option<String>,
}

#[derive(Deserialize, Debug)]
struct GasAccountResponse {
    status: String,
    authorized: Option<bool>,
    email: Option<String>,
    name: Option<String>,
    access_token: Option<String>,
    expires_in: Option<i64>,
    error: Option<String>,
}

/// Builds a deduplicated, non-empty list of candidate Apps Script secrets,
/// prioritizing the user-configured secret before built-in defaults.
pub fn candidate_gas_secrets(configured: &str) -> Vec<String> {
    let mut secrets = Vec::new();
    for raw in [
        configured.trim(),
        "po-autoflow-enterprise-secret-key",
        "rx5ocgZ6yLfnz2HAAmLA0ouy2GRA5sKg",
    ] {
        if !raw.is_empty() && !secrets.iter().any(|s: &String| s == raw) {
            secrets.push(raw.to_string());
        }
    }
    secrets
}

pub struct GoogleAuthManager;

impl GoogleAuthManager {
    /// Connects to Google Cloud via the user's deployed Google Apps Script Hub (`action=get_account`),
    /// avoiding Google Cloud Console OAuth Client ID setup or 404 placeholder credentials.
    pub async fn connect_via_gas_hub(gas_url: &str, gas_secret: &str) -> Result<GoogleAccountInfo, String> {
        let clean_url = gas_url.trim();
        if clean_url.is_empty() {
            return Err("Apps Script Webhook URL is empty".to_string());
        }

        let client = Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| e.to_string())?;

        let secrets = candidate_gas_secrets(gas_secret);
        let mut last_err = String::from("Could not authenticate with Apps Script Cloud Hub");

        for secret in &secrets {
            let url = format!(
                "{}?action=get_account&auth={}",
                clean_url,
                urlencoding::encode(secret)
            );
            match client.get(&url).send().await {
                Ok(resp) => {
                    let status_code = resp.status();
                    let text = resp.text().await.unwrap_or_default();
                    if let Ok(data) = serde_json::from_str::<GasAccountResponse>(&text) {
                        if data.status == "ok" && data.authorized != Some(false) {
                            let now = chrono::Utc::now();
                            let email = data
                                .email
                                .filter(|e| !e.trim().is_empty())
                                .unwrap_or_else(|| "Google Apps Script Cloud Hub".to_string());
                            let name = data
                                .name
                                .filter(|n| !n.trim().is_empty())
                                .unwrap_or_else(|| email.clone());
                            let access_token = data
                                .access_token
                                .filter(|t| !t.trim().is_empty())
                                .unwrap_or_else(|| "gas_hub_authenticated".to_string());
                            let expires_at = now.timestamp() + data.expires_in.unwrap_or(3600);
                            return Ok(GoogleAccountInfo {
                                email,
                                name,
                                picture: None,
                                access_token,
                                refresh_token: None,
                                expires_at,
                                connected_at: now.to_rfc3339(),
                            });
                        } else if data.authorized == Some(false) {
                            last_err = "Unauthorized: Invalid AUTH_SECRET".to_string();
                            continue;
                        } else if let Some(err) = data.error {
                            last_err = err;
                            if last_err.to_lowercase().contains("unauthorized") {
                                continue;
                            }
                            return Err(format!("Apps Script Cloud Hub error: {}", last_err));
                        }
                    } else if text.contains("<html") || text.contains("<!DOCTYPE") {
                        return Err(
                            "Apps Script returned an HTML page instead of JSON. Re-deploy your Web App in script.google.com with Who has access = Anyone.".to_string(),
                        );
                    } else {
                        last_err = format!("HTTP {}: {}", status_code, text.chars().take(120).collect::<String>());
                    }
                }
                Err(e) => {
                    last_err = format!("Network error connecting to Apps Script Hub: {}", e);
                }
            }
        }

        Err(format!("Google Cloud Hub connection failed: {}", last_err))
    }

    /// Starts a local loopback HTTP listener, opens the user's browser for Google OAuth consent,
    /// and captures the authorization code to obtain private Sheets & Drive tokens.
    pub async fn start_oauth_flow(
        client_id: &str,
        client_secret: &str,
    ) -> Result<GoogleAccountInfo, String> {
        let cid = client_id.trim();
        if cid.is_empty() || cid == DEFAULT_GOOGLE_CLIENT_ID {
            return Err(
                "No custom Google Cloud OAuth Client ID is configured. Either configure your Apps Script Webhook URL in Settings (recommended, 1-click Cloud Hub connection) or enter a valid Google Cloud Desktop App OAuth Client ID & Secret in Settings -> Google Sheets Directory.".to_string(),
            );
        }

        let csecret = if client_secret.trim().is_empty() {
            DEFAULT_GOOGLE_CLIENT_SECRET
        } else {
            client_secret.trim()
        };

        // Bind to local loopback port (try 8089, then 8090..8095)
        let mut listener = None;
        let mut port = 8089;
        for p in 8089..8095 {
            if let Ok(l) = TcpListener::bind(format!("127.0.0.1:{}", p)).await {
                listener = Some(l);
                port = p;
                break;
            }
        }

        let listener = listener.ok_or_else(|| {
            "Could not bind to local port 8089-8095 for OAuth callback. Make sure port is free.".to_string()
        })?;

        let redirect_uri = format!("http://127.0.0.1:{}/oauth/callback", port);
        info!("Started Google OAuth loopback listener at {}", redirect_uri);

        // Requested OAuth scopes for private Google Sheets, private Google Drive files, and profile
        let scopes = [
            "https://www.googleapis.com/auth/spreadsheets.readonly",
            "https://www.googleapis.com/auth/drive.file",
            "https://www.googleapis.com/auth/userinfo.email",
            "https://www.googleapis.com/auth/userinfo.profile",
        ]
        .join(" ");

        let auth_url = format!(
            "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent",
            urlencoding::encode(cid),
            urlencoding::encode(&redirect_uri),
            urlencoding::encode(&scopes)
        );

        // Open user's default browser cleanly without cmd.exe interpreting '&' query separators
        #[cfg(target_os = "windows")]
        {
            let _ = std::process::Command::new("rundll32")
                .args(["url.dll,FileProtocolHandler", &auth_url])
                .spawn();
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = std::process::Command::new("xdg-open")
                .arg(&auth_url)
                .spawn();
        }

        // Await callback request with 2-minute timeout
        let accept_future = async {
            let (mut socket, _) = listener.accept().await.map_err(|e| e.to_string())?;
            let mut buf = [0u8; 4096];
            let n = socket.read(&mut buf).await.map_err(|e| e.to_string())?;
            let request = String::from_utf8_lossy(&buf[..n]);

            // Parse authorization code from query string: GET /oauth/callback?code=...
            let code = Self::extract_code_from_request(&request).ok_or_else(|| {
                "Failed to extract authorization code from OAuth callback request".to_string()
            })?;

            // Return success response to browser
            let html_body = r#"<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>PO AutoFlow - Connected</title></head>
<body style="background:#020617;color:#f8fafc;font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
  <div style="background:#0f172a;border:1px solid #1e293b;padding:32px 48px;border-radius:16px;text-align:center;box-shadow:0 25px 50px -12px rgba(0,0,0,0.5);">
    <h2 style="margin:0 0 8px 0;color:#38bdf8;">Authentication Successful!</h2>
    <p style="color:#94a3b8;font-size:14px;margin:0 0 20px 0;">Google account connected securely to PO AutoFlow Enterprise.</p>
    <span style="background:#0284c7;color:white;padding:6px 16px;border-radius:8px;font-size:12px;font-weight:600;">You can close this tab and return to the application.</span>
  </div>
</body>
</html>"#;

            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                html_body.len(),
                html_body
            );
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.flush().await;

            Ok::<String, String>(code)
        };

        let auth_code = tokio::time::timeout(Duration::from_secs(120), accept_future)
            .await
            .map_err(|_| "Google OAuth login timed out after 2 minutes. Please try again.".to_string())??;

        // Exchange code for tokens
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;

        let token_resp = client
            .post("https://oauth2.googleapis.com/token")
            .form(&[
                ("code", auth_code.as_str()),
                ("client_id", cid),
                ("client_secret", csecret),
                ("redirect_uri", redirect_uri.as_str()),
                ("grant_type", "authorization_code"),
            ])
            .send()
            .await
            .map_err(|e| format!("Failed to request tokens from Google: {}", e))?;

        if !token_resp.status().is_success() {
            let err_text = token_resp.text().await.unwrap_or_default();
            return Err(format!("Google OAuth token exchange failed: {}", err_text));
        }

        let token_data: GoogleTokenResponse = token_resp
            .json()
            .await
            .map_err(|e| format!("Invalid token response from Google: {}", e))?;

        // Fetch user profile info
        let userinfo_resp = client
            .get("https://www.googleapis.com/oauth2/v2/userinfo")
            .bearer_auth(&token_data.access_token)
            .send()
            .await
            .map_err(|e| format!("Failed to fetch user profile: {}", e))?;

        let userinfo: GoogleUserInfoResponse = userinfo_resp
            .json()
            .await
            .map_err(|e| format!("Invalid userinfo response: {}", e))?;

        let now = chrono::Utc::now();
        let expires_at = now.timestamp() + token_data.expires_in;

        Ok(GoogleAccountInfo {
            email: userinfo.email,
            name: userinfo.name.unwrap_or_else(|| "Google User".to_string()),
            picture: userinfo.picture,
            access_token: token_data.access_token,
            refresh_token: token_data.refresh_token,
            expires_at,
            connected_at: now.to_rfc3339(),
        })
    }

    /// Automatically refreshes access token if within 3 minutes of expiration.
    pub async fn get_valid_access_token(
        account: &mut GoogleAccountInfo,
        client_id: &str,
        client_secret: &str,
    ) -> Result<String, String> {
        Self::get_valid_access_token_with_gas(account, client_id, client_secret, "", "").await
    }

    /// Automatically refreshes access token via Google OAuth refresh_token or Google Apps Script Cloud Hub.
    pub async fn get_valid_access_token_with_gas(
        account: &mut GoogleAccountInfo,
        client_id: &str,
        client_secret: &str,
        gas_url: &str,
        gas_secret: &str,
    ) -> Result<String, String> {
        let now = chrono::Utc::now().timestamp();
        // If expired or expiring within 180 seconds, refresh
        if now >= account.expires_at - 180 {
            if let Some(ref refresh_tok) = account.refresh_token {
                let cid = if client_id.trim().is_empty() {
                    DEFAULT_GOOGLE_CLIENT_ID
                } else {
                    client_id.trim()
                };
                let csecret = if client_secret.trim().is_empty() {
                    DEFAULT_GOOGLE_CLIENT_SECRET
                } else {
                    client_secret.trim()
                };

                let client = Client::new();
                let resp = client
                    .post("https://oauth2.googleapis.com/token")
                    .form(&[
                        ("client_id", cid),
                        ("client_secret", csecret),
                        ("refresh_token", refresh_tok.as_str()),
                        ("grant_type", "refresh_token"),
                    ])
                    .send()
                    .await
                    .map_err(|e| format!("Failed to refresh Google token: {}", e))?;

                if resp.status().is_success() {
                    let token_data: GoogleTokenResponse = resp
                        .json()
                        .await
                        .map_err(|e| format!("Invalid token refresh JSON: {}", e))?;

                    account.access_token = token_data.access_token.clone();
                    account.expires_at = chrono::Utc::now().timestamp() + token_data.expires_in;
                    info!("Successfully refreshed Google OAuth access token");
                    return Ok(account.access_token.clone());
                } else {
                    warn!("Google token refresh failed: status {}", resp.status());
                }
            } else if !gas_url.trim().is_empty() {
                match Self::connect_via_gas_hub(gas_url, gas_secret).await {
                    Ok(refreshed) => {
                        account.access_token = refreshed.access_token;
                        account.expires_at = refreshed.expires_at;
                        info!("Refreshed Google access token via Apps Script Cloud Hub");
                        return Ok(account.access_token.clone());
                    }
                    Err(e) => {
                        warn!("Could not refresh token via Cloud Hub: {}", e);
                    }
                }
            }
        }

        Ok(account.access_token.clone())
    }

    fn extract_code_from_request(req: &str) -> Option<String> {
        // Look for GET /oauth/callback?code=... or similar
        for line in req.lines() {
            if line.starts_with("GET ") {
                let path_and_query = line.split_whitespace().nth(1)?;
                if let Some(pos) = path_and_query.find("code=") {
                    let code_part = &path_and_query[pos + 5..];
                    let code = code_part.split('&').next()?;
                    return Some(urlencoding::decode(code).ok()?.into_owned());
                }
            }
        }
        None
    }
}
