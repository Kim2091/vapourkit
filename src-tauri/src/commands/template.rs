// src-tauri/src/commands/template.rs
//
// Equivalent to electron/templateHandlers.ts

use crate::template_manager::FilterTemplate;
use tauri::State;
use crate::AppState;
use tokio::fs;

#[tauri::command]
pub async fn get_filter_templates(
    _state: State<'_, AppState>,
) -> Result<Vec<FilterTemplate>, String> {
    log::info!("Getting filter templates");
    // TemplateManager is stateless — use a fresh instance so we never hold a
    // MutexGuard across the async file I/O.
    crate::template_manager::TemplateManager::new()
        .load_templates()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_filter_template(
    _state: State<'_, AppState>,
    template: FilterTemplate,
) -> Result<serde_json::Value, String> {
    log::info!("Saving filter template: {}", template.name);
    crate::template_manager::TemplateManager::new()
        .save_template(template)
        .await
        .map_err(|e| serde_json::json!({ "success": false, "error": e.to_string() })
            .to_string())?;
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn delete_filter_template(
    _state: State<'_, AppState>,
    name: String,
) -> Result<serde_json::Value, String> {
    log::info!("Deleting filter template: {}", name);
    match crate::template_manager::TemplateManager::new()
        .delete_template(&name)
        .await
    {
        Ok(_) => Ok(serde_json::json!({ "success": true })),
        Err(e) => Ok(serde_json::json!({ "success": false, "error": e.to_string() })),
    }
}

#[tauri::command]
pub async fn read_template_file(file_path: String) -> Result<serde_json::Value, String> {
    log::info!("Reading template file: {}", file_path);
    match fs::read_to_string(&file_path).await {
        Ok(content) => Ok(serde_json::json!({ "success": true, "content": content })),
        Err(e) => Ok(serde_json::json!({ "success": false, "error": e.to_string() })),
    }
}

#[tauri::command]
pub async fn import_template_file(file_path: String) -> Result<serde_json::Value, String> {
    log::info!("Importing template file: {}", file_path);
    match fs::read_to_string(&file_path).await {
        Ok(content) => {
            match crate::template_manager::TemplateManager::parse_template(&content) {
                Ok(template) => {
                    let value = serde_json::to_value(&template).map_err(|e| e.to_string())?;
                    Ok(serde_json::json!({ "success": true, "template": value }))
                }
                Err(e) => Ok(serde_json::json!({
                    "success": false,
                    "error": format!("Invalid template format: {}", e)
                })),
            }
        }
        Err(e) => Ok(serde_json::json!({ "success": false, "error": e.to_string() })),
    }
}
