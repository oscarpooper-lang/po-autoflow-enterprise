// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "windows")]
fn ensure_webview2_env() {
    if std::env::var_os("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER").is_some() {
        return;
    }

    let program_files_x86 =
        std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| "C:\\Program Files (x86)".to_string());
    let program_files =
        std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".to_string());
    let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();

    let candidate_bases = [
        format!("{}\\Microsoft\\EdgeCore", program_files_x86),
        format!("{}\\Microsoft\\EdgeCore", program_files),
        format!("{}\\Microsoft\\EdgeWebView\\Application", program_files_x86),
        format!("{}\\Microsoft\\EdgeWebView\\Application", program_files),
        format!("{}\\Microsoft\\EdgeWebView\\Application", local_app_data),
        format!("{}\\Microsoft\\Edge\\Application", program_files_x86),
    ];

    for base in &candidate_bases {
        let base_path = std::path::Path::new(base);
        if !base_path.exists() {
            continue;
        }

        if base_path.join("msedgewebview2.exe").exists() {
            unsafe {
                std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", base_path);
            }
            return;
        }

        if let Ok(entries) = std::fs::read_dir(base_path) {
            for entry in entries.filter_map(|e| e.ok()) {
                let sub = entry.path();
                if sub.is_dir() && sub.join("msedgewebview2.exe").exists() {
                    unsafe {
                        std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", &sub);
                    }
                    return;
                }
            }
        }
    }
}

fn main() {
    #[cfg(target_os = "windows")]
    ensure_webview2_env();

    app_lib::run();
}
