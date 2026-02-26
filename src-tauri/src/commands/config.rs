// src-tauri/src/commands/config.rs
//
// Equivalent to electron/configHandlers.ts

use crate::config_manager::{ColorimetrySettings, FilterConfig, PanelSizes};
use crate::AppState;
use tauri::{AppHandle, Manager, State};
use tokio::fs;

// ─── Colorimetry ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_colorimetry_settings(
    state: State<'_, AppState>,
) -> Result<ColorimetrySettings, String> {
    let cfg = state.config.lock().unwrap();
    Ok(cfg.get_colorimetry_settings().clone())
}

#[tauri::command]
pub async fn set_colorimetry_settings(
    state: State<'_, AppState>,
    settings: ColorimetrySettings,
) -> Result<serde_json::Value, String> {
    let mut cfg = state.config.lock().unwrap();
    cfg.set_colorimetry_settings(settings).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "success": true }))
}

// ─── Panel sizes ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_panel_sizes(state: State<'_, AppState>) -> Result<PanelSizes, String> {
    let cfg = state.config.lock().unwrap();
    Ok(cfg.get_panel_sizes().clone())
}

#[tauri::command]
pub async fn set_panel_sizes(
    state: State<'_, AppState>,
    sizes: PanelSizes,
) -> Result<serde_json::Value, String> {
    let mut cfg = state.config.lock().unwrap();
    cfg.set_panel_sizes(sizes).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "success": true }))
}

// ─── Show queue ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_show_queue(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let cfg = state.config.lock().unwrap();
    Ok(serde_json::json!({ "show": cfg.get_show_queue() }))
}

#[tauri::command]
pub async fn set_show_queue(
    state: State<'_, AppState>,
    show: bool,
) -> Result<serde_json::Value, String> {
    let mut cfg = state.config.lock().unwrap();
    cfg.set_show_queue(show).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "success": true }))
}

// ─── Filter configurations ────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_filter_configurations(
    state: State<'_, AppState>,
) -> Result<Vec<FilterConfig>, String> {
    let cfg = state.config.lock().unwrap();
    Ok(cfg.get_filter_configurations().clone())
}

#[tauri::command]
pub async fn set_filter_configurations(
    state: State<'_, AppState>,
    filters: Vec<FilterConfig>,
) -> Result<serde_json::Value, String> {
    let mut cfg = state.config.lock().unwrap();
    cfg.set_filter_configurations(filters).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "success": true }))
}

// ─── FFmpeg args ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_ffmpeg_args(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let cfg = state.config.lock().unwrap();
    Ok(serde_json::json!({ "args": cfg.get_ffmpeg_args() }))
}

#[tauri::command]
pub async fn set_ffmpeg_args(
    state: State<'_, AppState>,
    args: String,
) -> Result<serde_json::Value, String> {
    let mut cfg = state.config.lock().unwrap();
    cfg.set_ffmpeg_args(args).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn get_default_ffmpeg_args(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let cfg = state.config.lock().unwrap();
    Ok(serde_json::json!({ "args": cfg.get_default_ffmpeg_args() }))
}

// ─── Video filter ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_video_filter(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let cfg = state.config.lock().unwrap();
    Ok(serde_json::json!({ "filter": cfg.get_video_filter() }))
}

#[tauri::command]
pub async fn set_video_filter(
    state: State<'_, AppState>,
    filter: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut cfg = state.config.lock().unwrap();
    cfg.set_video_filter(filter).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "success": true }))
}

// ─── Output format ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_output_format(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let cfg = state.config.lock().unwrap();
    Ok(serde_json::json!({ "format": cfg.get_output_format() }))
}

#[tauri::command]
pub async fn set_output_format(
    state: State<'_, AppState>,
    format: String,
) -> Result<serde_json::Value, String> {
    let mut cfg = state.config.lock().unwrap();
    cfg.set_output_format(format).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "success": true }))
}

// ─── Processing format ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_processing_format(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let cfg = state.config.lock().unwrap();
    Ok(serde_json::json!({ "format": cfg.get_processing_format() }))
}

#[tauri::command]
pub async fn set_processing_format(
    state: State<'_, AppState>,
    format: String,
) -> Result<serde_json::Value, String> {
    let mut cfg = state.config.lock().unwrap();
    cfg.set_processing_format(format).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "success": true }))
}

// ─── Video compare args ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_video_compare_args(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let cfg = state.config.lock().unwrap();
    Ok(serde_json::json!({ "args": cfg.get_video_compare_args() }))
}

#[tauri::command]
pub async fn set_video_compare_args(
    state: State<'_, AppState>,
    args: String,
) -> Result<serde_json::Value, String> {
    let mut cfg = state.config.lock().unwrap();
    cfg.set_video_compare_args(args).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn get_default_video_compare_args(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let cfg = state.config.lock().unwrap();
    Ok(serde_json::json!({ "args": cfg.get_default_video_compare_args() }))
}

// ─── Default output folder ────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_default_output_folder(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let cfg = state.config.lock().unwrap();
    Ok(serde_json::json!({ "folder": cfg.get_default_output_folder() }))
}

#[tauri::command]
pub async fn set_default_output_folder(
    state: State<'_, AppState>,
    folder: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut cfg = state.config.lock().unwrap();
    cfg.set_default_output_folder(folder).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "success": true }))
}

// ─── Encoding settings expanded ───────────────────────────────────────────────

#[tauri::command]
pub async fn get_encoding_settings_expanded(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let cfg = state.config.lock().unwrap();
    Ok(serde_json::json!({ "expanded": cfg.get_encoding_settings_expanded() }))
}

#[tauri::command]
pub async fn set_encoding_settings_expanded(
    state: State<'_, AppState>,
    expanded: bool,
) -> Result<serde_json::Value, String> {
    let mut cfg = state.config.lock().unwrap();
    cfg.set_encoding_settings_expanded(expanded).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "success": true }))
}

// ─── App version ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_version() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "version": crate::update_checker::get_app_version() }))
}

// ─── Log tail reading ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn read_log_tail(
    state: State<'_, AppState>,
    max_lines: Option<usize>,
) -> Result<serde_json::Value, String> {
    let max = max_lines.unwrap_or(300);
    let log_path = crate::paths::log_file();

    if !log_path.exists() {
        return Ok(serde_json::json!({ "lines": [], "hasNewContent": false }));
    }

    let metadata = fs::metadata(&log_path)
        .await
        .map_err(|e| e.to_string())?;
    let current_size = metadata.len();

    let has_new = {
        let mut cache = state.log_read_cache.lock().unwrap();
        let changed = current_size != cache.last_size;
        if changed {
            cache.last_size = current_size;
        }
        changed
    };

    if !has_new {
        return Ok(serde_json::json!({ "lines": serde_json::Value::Array(vec![]), "hasNewContent": false }));
    }

    const MAX_BYTES: u64 = 512 * 1024; // 512 KB
    let content = if current_size > MAX_BYTES {
        use tokio::io::{AsyncReadExt, AsyncSeekExt};
        let mut file = tokio::fs::File::open(&log_path)
            .await
            .map_err(|e| e.to_string())?;
        file.seek(std::io::SeekFrom::End(-(MAX_BYTES as i64)))
            .await
            .ok();
        let mut buf = String::new();
        file.read_to_string(&mut buf).await.ok();
        // Strip potentially incomplete first line
        if let Some(pos) = buf.find('\n') {
            buf = buf[pos + 1..].to_string();
        }
        buf
    } else {
        fs::read_to_string(&log_path)
            .await
            .map_err(|e| e.to_string())?
    };

    let lines: Vec<&str> = content
        .lines()
        .filter(|l| !l.trim().is_empty())
        .collect();
    let start = lines.len().saturating_sub(max);
    let result: Vec<String> = lines[start..].iter().map(|s| s.to_string()).collect();

    Ok(serde_json::json!({ "lines": result, "hasNewContent": true }))
}

#[tauri::command]
pub async fn reset_log_cache(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut cache = state.log_read_cache.lock().unwrap();
    cache.last_size = 0;
    Ok(serde_json::json!({ "success": true }))
}

// ─── Reload backend ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn reload_backend(app: AppHandle, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    log::info!("Reloading backend (config)");
    let resource_dir = app.path().resource_dir().unwrap_or_default();
    // Load into a fresh instance first (no MutexGuard held across the await point)
    let mut new_cfg = crate::config_manager::ConfigManager::new();
    new_cfg.load(&resource_dir).await.map_err(|e| e.to_string())?;
    *state.config.lock().unwrap() = new_cfg;
    log::info!("Backend reload complete");
    Ok(serde_json::json!({ "success": true }))
}
