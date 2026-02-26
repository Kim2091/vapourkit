// src-tauri/src/vsmlrt_manager.rs
//
// Manages vs-mlrt component download and installation.

use anyhow::{Context, Result};
use std::path::PathBuf;

use crate::paths::{self, VS_MLRT_VERSION};

pub type Component = &'static str;
pub const ONNX_RUNTIME: Component = "onnx-runtime";
pub const TENSORRT: Component = "tensorrt";

pub struct ComponentInfo {
    pub name: String,
    pub url: String,
    pub archive_name: String,
    pub check_path: PathBuf,
    pub extract_to: PathBuf,
}

pub fn component_info(component: Component) -> ComponentInfo {
    let base = format!(
        "https://github.com/AmusementClub/vs-mlrt/releases/download/v{}",
        VS_MLRT_VERSION
    );
    match component {
        "onnx-runtime" => ComponentInfo {
            name: format!("vs-mlrt ONNX Runtime v{}", VS_MLRT_VERSION),
            url: format!("{}/VSORT-Windows-x64.v{}.7z", base, VS_MLRT_VERSION),
            archive_name: "vsort.7z".to_string(),
            check_path: paths::plugins().join("vsort.dll"),
            extract_to: paths::plugins(),
        },
        "tensorrt" => ComponentInfo {
            name: format!("vs-mlrt TensorRT v{}", VS_MLRT_VERSION),
            url: format!("{}/vsmlrt-windows-x64-tensorrt.v{}.7z", base, VS_MLRT_VERSION),
            archive_name: "vsmlrt.7z".to_string(),
            check_path: paths::mlrt_plugin().join("trtexec.exe"),
            extract_to: paths::plugins(),
        },
        other => panic!("Unknown vs-mlrt component: {}", other),
    }
}

pub async fn is_installed(component: Component) -> bool {
    let info = component_info(component);
    info.check_path.exists()
}

pub async fn download_and_install<F>(
    component: Component,
    mut progress_cb: F,
) -> Result<()>
where
    F: FnMut(String, u32) + Send + 'static,
{
    let info = component_info(component);

    if info.check_path.exists() {
        log::info!("{} already installed", info.name);
        return Ok(());
    }

    let archive_path = paths::app_data().join(&info.archive_name);
    tokio::fs::create_dir_all(&info.extract_to)
        .await
        .context("Create extract dir")?;

    // Download
    log::info!("Downloading {} from {}", info.name, info.url);
    progress_cb(format!("Downloading {}...", info.name), 0);

    crate::dependency_manager::download_file(&info.url, &archive_path, |pct, msg| {
        progress_cb(msg, pct)
    })
    .await
    .context("Download component")?;

    progress_cb(format!("Extracting {}...", info.name), 50);

    // Extract (.7z)
    crate::dependency_manager::extract_7z(&archive_path, &info.extract_to)
        .await
        .context("Extract component")?;

    tokio::fs::remove_file(&archive_path).await.ok();

    progress_cb(format!("{} installed successfully", info.name), 100);
    log::info!("{} installed", info.name);

    Ok(())
}

/// Detect if CUDA (NVIDIA GPU) is available via nvidia-smi.
pub async fn detect_cuda() -> bool {
    use tokio::process::Command;
    let result = Command::new("nvidia-smi")
        .args(["--query-gpu=name", "--format=csv,noheader"])
        .output()
        .await;
    match result {
        Ok(out) if out.status.success() => {
            let text = String::from_utf8_lossy(&out.stdout);
            let found = !text.trim().is_empty();
            if found {
                log::info!("CUDA GPU detected: {}", text.trim());
            }
            found
        }
        _ => {
            log::info!("No CUDA GPU detected (nvidia-smi failed or missing)");
            false
        }
    }
}
