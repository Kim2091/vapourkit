// src-tauri/src/commands/queue.rs
//
// Equivalent to electron/queueHandlers.ts

use crate::AppState;
use tauri::State;
use tokio::fs;

#[tauri::command]
pub async fn get_queue(_state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    log::info!("Loading queue from disk");
    let path = crate::paths::queue_file();
    if !path.exists() {
        log::info!("No existing queue found");
        return Ok(serde_json::Value::Array(vec![]));
    }
    let data = fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
    let queue: serde_json::Value = serde_json::from_str(&data).unwrap_or(serde_json::Value::Array(vec![]));
    log::info!("Loaded queue");
    Ok(queue)
}

#[tauri::command]
pub async fn save_queue(
    _state: State<'_, AppState>,
    queue: serde_json::Value,
) -> Result<serde_json::Value, String> {
    log::info!("Saving queue");
    let path = crate::paths::queue_file();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&queue).map_err(|e| e.to_string())?;
    fs::write(&path, json).await.map_err(|e| e.to_string())?;
    log::info!("Queue saved");
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn clear_queue(_state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    log::info!("Clearing queue");
    let path = crate::paths::queue_file();
    if path.exists() {
        fs::remove_file(&path).await.map_err(|e| e.to_string())?;
    }
    log::info!("Queue cleared");
    Ok(serde_json::json!({ "success": true }))
}
