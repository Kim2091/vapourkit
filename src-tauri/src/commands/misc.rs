// src-tauri/src/commands/misc.rs
//
// Miscellaneous commands: file existence, vs-mlrt version management, etc.

use crate::AppState;
use tauri::{AppHandle, State};
use tokio::fs;

#[tauri::command]
pub async fn file_exists(file_path: String) -> bool {
    std::path::Path::new(&file_path).exists()
}

// ─── vs-mlrt version management ───────────────────────────────────────────────

#[tauri::command]
pub async fn check_vsmlrt_version(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let stored = {
        let cfg = state.config.lock().unwrap();
        cfg.get_vs_mlrt_version().map(|s| s.to_string())
    };

    let current = crate::paths::VS_MLRT_VERSION;
    let mismatch = stored.as_deref().map(|s| s != current).unwrap_or(false);

    let engine_count = count_engine_files().await;

    log::info!(
        "vs-mlrt version check: stored={:?}, current={}, mismatch={}, engines={}",
        stored,
        current,
        mismatch,
        engine_count
    );

    Ok(serde_json::json!({
        "storedVersion": stored,
        "currentVersion": current,
        "hasVersionMismatch": mismatch,
        "engineCount": engine_count,
        "needsNotification": mismatch && engine_count > 0
    }))
}

#[tauri::command]
pub async fn clear_engine_files(
    _state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let models_dir = crate::paths::models();
    if !models_dir.exists() {
        return Ok(serde_json::json!({ "success": true, "deletedCount": 0 }));
    }

    let mut deleted = 0u32;
    let mut entries = fs::read_dir(&models_dir).await.map_err(|e| e.to_string())?;
    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("engine") {
            fs::remove_file(&path).await.map_err(|e| e.to_string())?;
            log::info!("Deleted engine file: {:?}", path.file_name());
            deleted += 1;
        }
    }

    log::info!("Cleared {} engine files", deleted);
    Ok(serde_json::json!({ "success": true, "deletedCount": deleted }))
}

#[tauri::command]
pub async fn update_vsmlrt_version(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let version = crate::paths::VS_MLRT_VERSION;
    let mut cfg = state.config.lock().unwrap();
    cfg.set_vs_mlrt_version(Some(version.to_string()))
        .map_err(|e| e.to_string())?;
    log::info!("Updated vs-mlrt version to {}", version);
    Ok(serde_json::json!({ "success": true, "version": version }))
}

#[tauri::command]
pub async fn update_vsmlrt_plugin(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    log::info!("Starting vs-mlrt plugin update");

    // Check CUDA support first
    let cuda = detect_cuda_support().await;
    if !cuda {
        return Ok(serde_json::json!({
            "success": false,
            "error": "CUDA not detected. TensorRT plugin requires an NVIDIA GPU."
        }));
    }

    let app_handle = app.clone();
    let version = crate::paths::VS_MLRT_VERSION;

    // Spawn the download in a background task with progress events
    tokio::spawn(async move {
        let result = download_and_install_vsmlrt(&app_handle, "tensorrt").await;
        match result {
            Ok(_) => {
                log::info!("vs-mlrt plugin update completed");
            }
            Err(e) => {
                log::error!("vs-mlrt plugin update failed: {}", e);
                let _ = app_handle.emit("vsmlrt-update-progress", serde_json::json!({
                    "type": "error",
                    "message": e.to_string(),
                    "progress": 0
                }));
            }
        }
    });

    // Update stored version
    let mut cfg = state.config.lock().unwrap();
    cfg.set_vs_mlrt_version(Some(version.to_string()))
        .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({ "success": true, "version": version }))
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async fn count_engine_files() -> u32 {
    let models_dir = crate::paths::models();
    if !models_dir.exists() {
        return 0;
    }
    let mut count = 0u32;
    if let Ok(mut entries) = fs::read_dir(&models_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            if entry
                .path()
                .extension()
                .and_then(|e| e.to_str())
                == Some("engine")
            {
                count += 1;
            }
        }
    }
    count
}

pub async fn detect_cuda_support() -> bool {
    // Check for nvidia-smi presence as proxy for CUDA availability
    let mut cmd = tokio::process::Command::new("nvidia-smi");
    crate::utils::configure_tokio_command(&mut cmd);
    let output = cmd
        .arg("--query-gpu=name")
        .arg("--format=csv,noheader")
        .output()
        .await;

    match output {
        Ok(out) if out.status.success() => {
            let gpus = String::from_utf8_lossy(&out.stdout);
            log::info!("CUDA GPU detected: {}", gpus.trim());
            true
        }
        _ => {
            log::info!("No CUDA GPU detected");
            false
        }
    }
}

async fn download_and_install_vsmlrt(app: &AppHandle, variant: &str) -> anyhow::Result<()> {
    let component = match variant {
        "tensorrt" => crate::vsmlrt_manager::TENSORRT,
        "onnx-runtime" => crate::vsmlrt_manager::ONNX_RUNTIME,
        _ => crate::vsmlrt_manager::TENSORRT,
    };

    let app_clone = app.clone();
    crate::vsmlrt_manager::download_and_install(component, move |message, progress| {
        let _ = app_clone.emit("vsmlrt-update-progress", serde_json::json!({
            "type": if progress >= 100 { "complete" } else { "progress" },
            "message": message,
            "progress": progress
        }));
    })
    .await?;

    Ok(())
}

use tauri::Emitter;
