// src-tauri/src/commands/update.rs
//
// Equivalent to electron/updateHandlers.ts

use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

#[tauri::command]
pub async fn check_for_updates() -> Result<serde_json::Value, String> {
    log::info!("Checking for updates");
    match crate::update_checker::check_for_updates().await {
        Ok(info) => {
            let data = serde_json::to_value(&info).map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "success": true, "data": data }))
        }
        Err(e) => {
            log::error!("Error checking for updates: {}", e);
            Ok(serde_json::json!({ "success": false, "error": e.to_string() }))
        }
    }
}

#[tauri::command]
pub async fn open_releases_page(app: AppHandle) -> Result<serde_json::Value, String> {
    let url = crate::update_checker::get_releases_page_url();
    log::info!("Opening releases page: {}", url);
    app.shell().open(&url, None).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn open_release_url(app: AppHandle, url: String) -> Result<serde_json::Value, String> {
    log::info!("Opening release URL: {}", url);
    app.shell().open(&url, None).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "success": true }))
}
