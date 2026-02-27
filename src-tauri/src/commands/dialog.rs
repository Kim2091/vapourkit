// src-tauri/src/commands/dialog.rs
//
// Equivalent to electron/dialogHandlers.ts

use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_shell::ShellExt;
use std::path::Path;
use crate::AppState;

// ─── File selection dialogs ──────────────────────────────────────────────────

#[tauri::command]
pub async fn select_video_file(app: AppHandle) -> Result<Option<Vec<String>>, String> {
    log::info!("Opening video file selection dialog");
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Videos", &["mp4", "avi", "mkv", "mov", "webm", "flv", "wmv"])
        .pick_files(move |result| { let _ = tx.send(result); });
    let result = rx.await.ok().flatten();
    match result {
        Some(paths) => {
            let strings: Vec<String> = paths.into_iter().filter_map(file_path_to_string).collect();
            log::info!("Selected {} video file(s)", strings.len());
            Ok(Some(strings))
        }
        None => { log::info!("Video file selection canceled"); Ok(None) }
    }
}

#[tauri::command]
pub async fn select_onnx_file(app: AppHandle) -> Result<Option<String>, String> {
    log::info!("Opening ONNX file selection dialog");
    pick_single_file(&app, "ONNX Models", vec!["onnx"]).await
}

#[tauri::command]
pub async fn select_template_file(app: AppHandle) -> Result<Option<String>, String> {
    log::info!("Opening template file selection dialog");
    pick_single_file(&app, "VapourSynth Templates", vec!["vkfilter"]).await
}

#[tauri::command]
pub async fn select_output_file(
    app: AppHandle,
    state: State<'_, AppState>,
    default_name: String,
) -> Result<Option<String>, String> {
    log::info!("Opening output file save dialog: {}", default_name);
    let ext = Path::new(&default_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp4")
        .to_string();
    let default_folder = {
        let cfg = state.config.lock().unwrap();
        cfg.get_default_output_folder().map(|s| s.to_string())
    };
    let default_path = if let Some(folder) = default_folder {
        let basename = Path::new(&default_name)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or(default_name.clone());
        format!("{}\\{}", folder, basename)
    } else {
        default_name.clone()
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(&default_path)
        .add_filter("Video Files", &[ext.as_str()])
        .add_filter("All Videos", &["mp4", "mkv", "avi", "mov", "webm"])
        .save_file(move |result| { let _ = tx.send(result); });
    Ok(rx.await.ok().flatten().and_then(file_path_to_string))
}

#[tauri::command]
pub async fn select_folder(app: AppHandle) -> Result<Option<String>, String> {
    log::info!("Opening folder selection dialog");
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |result| { let _ = tx.send(result); });
    Ok(rx.await.ok().flatten().and_then(file_path_to_string))
}

#[tauri::command]
pub async fn select_workflow_file(app: AppHandle, mode: String) -> Result<Option<String>, String> {
    log::info!("Selecting workflow file (mode: {})", mode);
    if mode == "open" {
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.dialog()
            .file()
            .add_filter("Vapourkit Workflow", &["vkworkflow"])
            .add_filter("All Files", &["*"])
            .pick_file(move |result| { let _ = tx.send(result); });
        Ok(rx.await.ok().flatten().and_then(file_path_to_string))
    } else {
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.dialog()
            .file()
            .set_file_name("My Workflow.vkworkflow")
            .add_filter("Vapourkit Workflow", &["vkworkflow"])
            .add_filter("All Files", &["*"])
            .save_file(move |result| { let _ = tx.send(result); });
        Ok(rx.await.ok().flatten().and_then(file_path_to_string))
    }
}

// ─── Folder opening ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn open_output_folder(app: AppHandle, file_path: String) -> Result<(), String> {
    log::info!("Opening output folder for: {}", file_path);
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(format!("File does not exist: {}", file_path));
    }
    let folder = path.parent().unwrap_or(path);
    open_path_in_explorer(&app, folder.to_string_lossy().as_ref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_logs_folder(app: AppHandle) -> Result<serde_json::Value, String> {
    log::info!("Opening logs folder");
    let dir = crate::paths::logs_dir();
    tokio::fs::create_dir_all(&dir).await.ok();
    open_path_in_explorer(&app, &dir.to_string_lossy())
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json! {{ "success": true }})
}

#[tauri::command]
pub async fn open_config_folder(app: AppHandle) -> Result<serde_json::Value, String> {
    log::info!("Opening config folder");
    let dir = crate::paths::config_dir();
    tokio::fs::create_dir_all(&dir).await.ok();
    open_path_in_explorer(&app, &dir.to_string_lossy())
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json! {{ "success": true }})
}

#[tauri::command]
pub async fn open_vs_plugins_folder(app: AppHandle) -> Result<serde_json::Value, String> {
    log::info!("Opening VS plugins folder");
    let dir = crate::paths::plugins();
    tokio::fs::create_dir_all(&dir).await.ok();
    open_path_in_explorer(&app, &dir.to_string_lossy())
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json! {{ "success": true }})
}

#[tauri::command]
pub async fn open_vs_scripts_folder(app: AppHandle) -> Result<serde_json::Value, String> {
    log::info!("Opening VS scripts folder");
    let dir = crate::paths::scripts();
    tokio::fs::create_dir_all(&dir).await.ok();
    open_path_in_explorer(&app, &dir.to_string_lossy())
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json! {{ "success": true }})
}

// ─── External URL / app launching ─────────────────────────────────────────────

#[tauri::command]
pub async fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    log::info!("Opening external URL: {}", url);
    app.shell().open(&url, None::<tauri_plugin_shell::open::Program>).map_err(|e| e.to_string())
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async fn pick_single_file(
    app: &AppHandle,
    filter_name: &str,
    extensions: Vec<&str>,
) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file()
        .add_filter(filter_name, &extensions)
        .pick_file(move |result| { let _ = tx.send(result); });
    Ok(rx.await.ok().flatten().and_then(file_path_to_string))
}

fn file_path_to_string(fp: FilePath) -> Option<String> {
    match fp {
        FilePath::Path(p) => Some(p.to_string_lossy().into_owned()),
        FilePath::Url(u) => u.to_file_path().ok().map(|p| p.to_string_lossy().into_owned()),
    }
}

async fn open_path_in_explorer(app: &AppHandle, path: &str) -> anyhow::Result<()> {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = tokio::process::Command::new("explorer");
        crate::utils::configure_tokio_command(&mut cmd);
        cmd.arg(path).spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        tokio::process::Command::new("open").arg(path).spawn()?;
    }
    #[cfg(target_os = "linux")]
    {
        tokio::process::Command::new("xdg-open").arg(path).spawn()?;
    }
    Ok(())
}

