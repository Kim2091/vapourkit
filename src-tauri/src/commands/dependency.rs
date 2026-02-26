// src-tauri/src/commands/dependency.rs
//
// Tauri commands for dependency management.

use tauri::{AppHandle, Emitter, Manager};

use crate::dependency_manager::{self, SetupProgress};
use crate::plugin_installer::{PluginInstaller, PluginProgress};

/// Check whether all dependencies are present.
#[tauri::command]
pub async fn check_dependencies() -> Result<serde_json::Value, String> {
    let status = dependency_manager::check_dependencies().await;
    Ok(serde_json::json!({
        "hasVapourSynth": status.vs,
        "hasMlrtPlugin": status.mlrt,
        "hasOrtPlugin": status.ort,
        "hasBestSource": status.bestsource,
        "hasPython": status.python,
        "hasVideoCompare": status.video_compare,
        "hasFFmpeg": status.ffmpeg,
        "hasCuda": status.has_cuda,
        "allPresent": dependency_manager::all_present(&status),
    }))
}

/// Detect whether a CUDA-capable NVIDIA GPU is available.
#[tauri::command]
pub async fn detect_cuda_support() -> Result<bool, String> {
    Ok(crate::vsmlrt_manager::detect_cuda().await)
}

/// Run the full dependency setup flow.
/// Emits "setup-progress" events to the frontend.
#[tauri::command]
pub async fn setup_dependencies(app: AppHandle) -> Result<serde_json::Value, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .unwrap_or_default();

    let app_clone = app.clone();

    let result = dependency_manager::setup_dependencies(resource_dir, move |progress: SetupProgress| {
        let _ = app_clone.emit("setup-progress", &progress);
    })
    .await;

    match result {
        Ok(()) => Ok(serde_json::json!({ "success": true })),
        Err(e) => {
            let msg = e.to_string();
            log::error!("Dependency setup failed: {}", msg);
            let _ = app.emit(
                "setup-progress",
                &SetupProgress {
                    kind: "error".to_string(),
                    component: "Setup".to_string(),
                    progress: 0,
                    message: format!("Setup failed: {}", msg),
                },
            );
            Ok(serde_json::json!({ "success": false, "error": msg }))
        }
    }
}

/// Install plugin Python dependencies via pip.
/// When `packages` is empty, runs the full orchestrated installation
/// (torch, numpy, plugins, scripts, templates — matching the Electron flow).
/// When `packages` has items, installs only those specific packages.
/// Emits "plugin-dependency-progress" events.
#[tauri::command]
pub async fn install_plugin_dependencies(
    app: AppHandle,
    packages: Vec<String>,
) -> Result<serde_json::Value, String> {
    let installer = PluginInstaller::new();
    let app_clone = app.clone();

    let result = if packages.is_empty() {
        // Full orchestated install (matches Electron installDependencies)
        let resource_dir = app
            .path()
            .resource_dir()
            .unwrap_or_default();

        installer
            .install_dependencies(&resource_dir, move |progress: PluginProgress| {
                let _ = app_clone.emit("plugin-dependency-progress", &progress);
            })
            .await
    } else {
        // Install only the specified packages
        let pkgs: Vec<&str> = packages.iter().map(|s| s.as_str()).collect();
        installer
            .install_packages(&pkgs, move |progress: PluginProgress| {
                let _ = app_clone.emit("plugin-dependency-progress", &progress);
            })
            .await
    };

    match result {
        Ok(()) => Ok(serde_json::json!({ "success": true })),
        Err(e) => {
            let msg = e.to_string();
            let _ = app.emit(
                "plugin-dependency-progress",
                &PluginProgress {
                    kind: "error".to_string(),
                    progress: 0,
                    message: format!("Installation failed: {}", msg),
                },
            );
            Ok(serde_json::json!({ "success": false, "error": msg }))
        }
    }
}

/// Uninstall all standard plugin Python dependencies.
#[tauri::command]
pub async fn uninstall_plugin_dependencies(
    _packages: Vec<String>,
) -> Result<serde_json::Value, String> {
    let installer = PluginInstaller::new();
    // Always uninstall the standard set regardless of what's passed
    installer
        .uninstall_dependencies()
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "success": true }))
}

/// Check which plugin Python packages are installed.
#[tauri::command]
pub async fn check_plugin_dependencies(
    _packages: Vec<String>,
) -> Result<serde_json::Value, String> {
    let result = PluginInstaller::check_installed().await;
    Ok(serde_json::json!(result))
}

/// Cancel an in-progress plugin dependency installation.
#[tauri::command]
pub async fn cancel_plugin_dependency_install() -> Result<serde_json::Value, String> {
    // This is a no-op in the current impl since each install creates a new PluginInstaller.
    // A global shared installer would be needed for true cancellation.
    log::info!("Plugin dependency install cancel requested");
    Ok(serde_json::json!({ "success": true }))
}
