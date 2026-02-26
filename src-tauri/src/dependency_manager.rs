// src-tauri/src/dependency_manager.rs
//
// Download, extraction, and dependency setup — port of electron/dependencyManager.ts.

use anyhow::{bail, Context, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tokio::fs::File;
use tokio::io::AsyncWriteExt;

use crate::paths;

// ──────────────────────────────────────────────────────────────
// Progress types (emitted as Tauri events "setup-progress")
// ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupProgress {
    #[serde(rename = "type")]
    pub kind: String,
    pub component: String,
    pub progress: u32,
    pub message: String,
}

// ──────────────────────────────────────────────────────────────
// Dependency check
// ──────────────────────────────────────────────────────────────

pub struct DepStatus {
    pub vs: bool,
    pub mlrt: bool,
    pub ort: bool,
    pub bestsource: bool,
    pub python: bool,
    pub video_compare: bool,
    pub ffmpeg: bool,
    pub has_cuda: bool,
}

pub async fn check_dependencies() -> DepStatus {
    let has_cuda = crate::vsmlrt_manager::detect_cuda().await;

    let vs = paths::vspipe().exists();
    let mlrt = if has_cuda {
        paths::trtexec().exists()
    } else {
        true // skip if no CUDA
    };
    let ort = paths::plugins().join("vsort.dll").exists();
    let bs = paths::plugins().join("bestsource.dll").exists();
    let python = paths::python().exists();
    let video_compare = paths::video_compare_exe().exists();
    let ffmpeg = crate::ffmpeg_manager::ffmpeg_exe_path().exists();

    log::info!(
        "Deps — VS:{} MLRT:{} ORT:{} BS:{} PY:{} VC:{} FF:{} CUDA:{}",
        vs, mlrt, ort, bs, python, video_compare, ffmpeg, has_cuda
    );

    DepStatus {
        vs,
        mlrt,
        ort,
        bestsource: bs,
        python,
        video_compare,
        ffmpeg,
        has_cuda,
    }
}

pub fn all_present(s: &DepStatus) -> bool {
    s.vs && s.mlrt && s.ort && s.bestsource && s.python && s.video_compare && s.ffmpeg
}

// ──────────────────────────────────────────────────────────────
// Download helper
// ──────────────────────────────────────────────────────────────

/// Download a URL to a local file, calling `on_progress(pct, message)` periodically.
pub async fn download_file<F>(url: &str, dest: &PathBuf, mut on_progress: F) -> Result<()>
where
    F: FnMut(u32, String),
{
    log::info!("Downloading {} -> {}", url, dest.display());

    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .context("Create download dir")?;
    }

    let client = reqwest::Client::builder()
        .user_agent("vapourkit/0.14")
        .build()
        .context("Build HTTP client")?;

    let resp = client
        .get(url)
        .send()
        .await
        .context("Send GET request")?
        .error_for_status()
        .context("HTTP error")?;

    let total = resp.content_length().unwrap_or(0);
    let mut file = File::create(dest).await.context("Create dest file")?;
    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("Read chunk")?;
        file.write_all(&chunk).await.context("Write chunk")?;
        downloaded += chunk.len() as u64;

        let pct = if total > 0 {
            (downloaded * 100 / total) as u32
        } else {
            0
        };

        on_progress(pct, format!("Downloading... {}%", pct));
    }

    file.flush().await.context("Flush file")?;
    log::info!("Download complete: {}", dest.display());
    Ok(())
}

// ──────────────────────────────────────────────────────────────
// Extraction helpers
// ──────────────────────────────────────────────────────────────

/// Extract a zip archive to `dest_dir`.
pub async fn extract_zip(archive: &PathBuf, dest_dir: &PathBuf) -> Result<()> {
    log::info!("Extracting zip {} -> {}", archive.display(), dest_dir.display());
    tokio::fs::create_dir_all(dest_dir).await?;

    let archive = archive.clone();
    let dest_dir = dest_dir.clone();

    tokio::task::spawn_blocking(move || -> Result<()> {
        let file = std::fs::File::open(&archive).context("Open zip")?;
        let mut zip = zip::ZipArchive::new(file).context("Parse zip")?;
        zip.extract(&dest_dir).context("Extract zip")?;
        Ok(())
    })
    .await
    .context("spawn_blocking extract_zip")??;

    log::info!("Zip extraction complete");
    Ok(())
}

/// Extract a 7z archive to `dest_dir`.
/// Prefers the native `7z.exe` from the VapourSynth portable directory (handles
/// all compression methods including BCJ2+LZMA2 used by vs-mlrt archives).
/// Falls back to the pure-Rust `sevenz-rust` library if the native binary is
/// not yet available (e.g. during the very first setup before VS is installed).
pub async fn extract_7z(archive: &PathBuf, dest_dir: &PathBuf) -> Result<()> {
    log::info!("Extracting 7z {} -> {}", archive.display(), dest_dir.display());
    tokio::fs::create_dir_all(dest_dir).await?;

    // Try native 7z.exe first (from VS portable dir)
    let native_7z = paths::vs().join("7z.exe");
    if native_7z.exists() {
        log::info!("Using native 7z.exe: {}", native_7z.display());
        let output = tokio::process::Command::new(&native_7z)
            .args(["x", "-y", &format!("-o{}", dest_dir.display()), archive.to_str().unwrap_or("")])
            .output()
            .await
            .context("Spawn 7z.exe")?;

        if output.status.success() {
            log::info!("7z extraction complete (native)");
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        log::error!("Native 7z.exe failed (code {:?}): {} {}", output.status.code(), stdout, stderr);
        bail!("7z extraction failed: {}", stdout);
    }

    // Fallback: pure-Rust sevenz-rust (works for simple 7z archives)
    log::info!("Native 7z.exe not found, falling back to sevenz-rust");
    let archive = archive.clone();
    let dest_dir = dest_dir.clone();

    tokio::task::spawn_blocking(move || -> Result<()> {
        sevenz_rust::decompress_file(&archive, &dest_dir)
            .map_err(|e| anyhow::anyhow!("7z extraction failed: {}", e))?;
        Ok(())
    })
    .await
    .context("spawn_blocking extract_7z")??;

    log::info!("7z extraction complete (sevenz-rust fallback)");
    Ok(())
}

/// Extract archive — dispatches to zip or 7z based on extension.
pub async fn extract_archive(archive: &PathBuf, dest_dir: &PathBuf) -> Result<()> {
    let ext = archive
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "zip" => extract_zip(archive, dest_dir).await,
        "7z" => extract_7z(archive, dest_dir).await,
        other => bail!("Unsupported archive format: {}", other),
    }
}

// ──────────────────────────────────────────────────────────────
// Full setup
// ──────────────────────────────────────────────────────────────

struct ComponentConfig {
    name: String,
    url: String,
    archive_name: String,
    check_path: PathBuf,
    extract_to: PathBuf,
}

async fn download_and_install_component<F>(
    cfg: &ComponentConfig,
    mut progress_cb: F,
) -> Result<()>
where
    F: FnMut(SetupProgress),
{
    if cfg.check_path.exists() {
        log::info!("{} already installed", cfg.name);
        return Ok(());
    }

    log::info!("{} not found, downloading from {}", cfg.name, cfg.url);
    tokio::fs::create_dir_all(&cfg.extract_to).await?;

    let archive = paths::app_data().join(&cfg.archive_name);
    let name = cfg.name.clone();
    let name2 = cfg.name.clone();

    download_file(&cfg.url, &archive, |pct, msg| {
        progress_cb(SetupProgress {
            kind: "download".to_string(),
            component: name.clone(),
            progress: pct,
            message: msg,
        });
    })
    .await?;

    progress_cb(SetupProgress {
        kind: "extract".to_string(),
        component: name2.clone(),
        progress: 0,
        message: format!("Extracting {}...", name2),
    });

    extract_archive(&archive, &cfg.extract_to).await?;
    tokio::fs::remove_file(&archive).await.ok();

    progress_cb(SetupProgress {
        kind: "extract".to_string(),
        component: name2.clone(),
        progress: 100,
        message: format!("{} installed", name2),
    });

    Ok(())
}

/// Full dependency setup flow.
pub async fn setup_dependencies<F>(
    resource_dir: PathBuf,
    progress_cb: F,
) -> Result<()>
where
    F: FnMut(SetupProgress) + Send + 'static,
{
    // Wrap in Arc<Mutex<>> so the closure can be shared across multiple sequential async calls.
    let cb: std::sync::Arc<std::sync::Mutex<dyn FnMut(SetupProgress) + Send>> =
        std::sync::Arc::new(std::sync::Mutex::new(progress_cb));

    log::info!("Starting dependency setup");

    let has_cuda = crate::vsmlrt_manager::detect_cuda().await;
    log::info!("CUDA: {}", has_cuda);

    // Standard components
    let components = vec![
        ComponentConfig {
            name: "VapourSynth R72".to_string(),
            url: "https://github.com/vapoursynth/vapoursynth/releases/download/R72/VapourSynth64-Portable-R72.zip".to_string(),
            archive_name: "vs-portable.zip".to_string(),
            check_path: paths::vspipe(),
            extract_to: paths::vs(),
        },
        ComponentConfig {
            name: "BestSource R13".to_string(),
            url: "https://github.com/vapoursynth/bestsource/releases/download/R13/BestSource-R13.7z".to_string(),
            archive_name: "bestsource.7z".to_string(),
            check_path: paths::plugins().join("bestsource.dll"),
            extract_to: paths::plugins(),
        },
        ComponentConfig {
            name: "Video Compare Tool".to_string(),
            url: "https://github.com/pixop/video-compare/releases/download/20250928/video-compare-20250928-win10-x86_64.zip".to_string(),
            archive_name: "video-compare.zip".to_string(),
            check_path: paths::video_compare_exe(),
            extract_to: paths::video_compare(),
        },
    ];

    for component in &components {
        let cb2 = cb.clone();
        download_and_install_component(component, move |p| cb2.lock().unwrap()(p)).await?;
    }

    // vs-mlrt ONNX Runtime (always needed)
    if !crate::vsmlrt_manager::is_installed(crate::vsmlrt_manager::ONNX_RUNTIME).await {
        let name_clone = "vs-mlrt ONNX Runtime".to_string();
        let cb2 = cb.clone();
        crate::vsmlrt_manager::download_and_install(
            crate::vsmlrt_manager::ONNX_RUNTIME,
            move |msg, pct| {
                cb2.lock().unwrap()(SetupProgress {
                    kind: "download".to_string(),
                    component: name_clone.clone(),
                    progress: pct,
                    message: msg,
                });
            },
        )
        .await?;
    }

    // vs-mlrt TensorRT (only with CUDA)
    if has_cuda && !crate::vsmlrt_manager::is_installed(crate::vsmlrt_manager::TENSORRT).await {
        let name_clone = "vs-mlrt TensorRT".to_string();
        let cb2 = cb.clone();
        crate::vsmlrt_manager::download_and_install(
            crate::vsmlrt_manager::TENSORRT,
            move |msg, pct| {
                cb2.lock().unwrap()(SetupProgress {
                    kind: "download".to_string(),
                    component: name_clone.clone(),
                    progress: pct,
                    message: msg,
                });
            },
        )
        .await?;
    }

    // Embedded Python setup
    {
        let cb2 = cb.clone();
        let mut closure = move |p: SetupProgress| cb2.lock().unwrap()(p);
        setup_embedded_python(&mut closure).await?;
    }

    // Extract bundled ONNX models
    if crate::model_extractor::needs_extraction(&resource_dir).await {
        let cb2 = cb.clone();
        crate::model_extractor::extract_bundled_models(&resource_dir, move |msg, pct| {
            cb2.lock().unwrap()(SetupProgress {
                kind: "model-extract".to_string(),
                component: "ONNX Models".to_string(),
                progress: pct,
                message: msg,
            });
        })
        .await?;
    }

    // Install FFmpeg
    if !crate::ffmpeg_manager::ffmpeg_exe_path().exists() {
        let cb2 = cb.clone();
        crate::ffmpeg_manager::install(move |msg, pct| {
            cb2.lock().unwrap()(SetupProgress {
                kind: "download".to_string(),
                component: "FFmpeg".to_string(),
                progress: pct as u32,
                message: msg,
            });
        })
        .await?;
    }

    // Initialize user config
    initialize_user_config(&resource_dir).await?;

    cb.lock().unwrap()(SetupProgress {
        kind: "complete".to_string(),
        component: "All Dependencies".to_string(),
        progress: 100,
        message: "All dependencies installed successfully!".to_string(),
    });

    log::info!("Dependency setup complete");
    Ok(())
}

// ──────────────────────────────────────────────────────────────
// Embedded Python setup
// ──────────────────────────────────────────────────────────────

async fn setup_embedded_python<F>(progress_cb: &mut F) -> Result<()>
where
    F: FnMut(SetupProgress),
{
    let python = paths::python();

    progress_cb(SetupProgress {
        kind: "python-setup".to_string(),
        component: "Python Embedded".to_string(),
        progress: 0,
        message: "Setting up embedded Python for VapourSynth...".to_string(),
    });

    if python.exists() {
        progress_cb(SetupProgress {
            kind: "python-setup".to_string(),
            component: "Python Embedded".to_string(),
            progress: 100,
            message: "Embedded Python already configured".to_string(),
        });
        return Ok(());
    }

    let python_version = "3.13.0";
    let zip_url = format!(
        "https://www.python.org/ftp/python/{}/python-{}-embed-amd64.zip",
        python_version, python_version
    );
    let zip_path = paths::app_data().join(format!("python-{}-embed-amd64.zip", python_version));

    progress_cb(SetupProgress {
        kind: "python-setup".to_string(),
        component: "Python Embedded".to_string(),
        progress: 10,
        message: "Downloading Python 3.13 embedded...".to_string(),
    });

    download_file(&zip_url, &zip_path, |_, _| {}).await?;

    progress_cb(SetupProgress {
        kind: "python-setup".to_string(),
        component: "Python Embedded".to_string(),
        progress: 40,
        message: "Extracting Python...".to_string(),
    });

    extract_zip(&zip_path, &paths::vs()).await?;
    tokio::fs::remove_file(&zip_path).await.ok();

    // Modify python313._pth
    let pth = paths::vs().join("python313._pth");
    if pth.exists() {
        let mut content = tokio::fs::read_to_string(&pth).await.unwrap_or_default();
        content.push_str("\nvs-scripts\nLib\\site-packages\n");
        tokio::fs::write(&pth, content).await?;
    }

    tokio::fs::create_dir_all(paths::plugins()).await.ok();
    tokio::fs::create_dir_all(paths::vs().join("vs-scripts")).await.ok();

    // Download and run get-pip.py
    let get_pip = paths::app_data().join("get-pip.py");
    download_file("https://bootstrap.pypa.io/get-pip.py", &get_pip, |_, _| {}).await?;

    let py = paths::python();
    crate::utils::run_command(
        py.to_str().unwrap(),
        &[get_pip.to_str().unwrap(), "--no-warn-script-location"],
        Some(&paths::app_data()),
        None,
    )
    .await?;

    tokio::fs::remove_file(&get_pip).await.ok();

    // Remove Scripts/*.exe
    let scripts_dir = paths::vs().join("Scripts");
    if scripts_dir.exists() {
        let mut entries = tokio::fs::read_dir(&scripts_dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let p = entry.path();
            if p.extension().map(|e| e == "exe").unwrap_or(false) {
                tokio::fs::remove_file(p).await.ok();
            }
        }
    }

    // Remove Python 3.8 VSScript DLL
    let old_dll = paths::vs().join("VSScriptPython38.dll");
    if old_dll.exists() {
        tokio::fs::remove_file(old_dll).await.ok();
    }

    // Install VapourSynth wheel or from PyPI
    let wheel = paths::vs().join("wheel").join("VapourSynth-72-cp312-abi3-win_amd64.whl");
    if wheel.exists() {
        crate::utils::run_command(
            py.to_str().unwrap(),
            &["-m", "pip", "install", wheel.to_str().unwrap()],
            None,
            None,
        )
        .await?;
    } else {
        crate::utils::run_command(
            py.to_str().unwrap(),
            &["-m", "pip", "install", "vapoursynth"],
            None,
            None,
        )
        .await?;
    }

    progress_cb(SetupProgress {
        kind: "python-setup".to_string(),
        component: "Python Embedded".to_string(),
        progress: 100,
        message: "Embedded Python configured successfully".to_string(),
    });

    Ok(())
}

// ──────────────────────────────────────────────────────────────
// User config initialization
// ──────────────────────────────────────────────────────────────

async fn initialize_user_config(resource_dir: &PathBuf) -> Result<()> {
    tokio::fs::create_dir_all(paths::config()).await?;

    // Stock app config
    let include_root = paths::resolve_include(resource_dir, "");
    let stock = include_root.join("stock-app-config.json");
    let user_cfg = paths::config().join("app-config.json");
    if !user_cfg.exists() && stock.exists() {
        tokio::fs::copy(&stock, &user_cfg).await.ok();
    }

    // VapourSynth template (always overwrite)
    let vs_tpl_src = include_root.join("vapoursynth_template.vpy");
    let vs_tpl_dst = paths::config().join("vapoursynth_template.vpy");
    if vs_tpl_src.exists() {
        tokio::fs::copy(&vs_tpl_src, &vs_tpl_dst).await.ok();
    }

    // Filter templates (copy new ones only)
    let bundled_ft = paths::resolve_include(resource_dir, "filter_templates");
    let user_ft = paths::filter_templates();
    tokio::fs::create_dir_all(&user_ft).await.ok();
    if bundled_ft.exists() {
        let mut entries = tokio::fs::read_dir(&bundled_ft).await?;
        while let Some(entry) = entries.next_entry().await? {
            let src = entry.path();
            if src.extension().map(|e| e == "vkfilter").unwrap_or(false) {
                let dst = user_ft.join(src.file_name().unwrap());
                if !dst.exists() {
                    tokio::fs::copy(&src, &dst).await.ok();
                }
            }
        }
    }

    // FFmpeg settings
    let ff_cfg = paths::config().join("ffmpeg_settings.json");
    if !ff_cfg.exists() {
        let default_ff = serde_json::json!({
            "_comment": "Edit these args to customize FFmpeg encoding.",
            "args": ["-c:v", "libx264", "-preset", "medium", "-crf", "18"]
        });
        tokio::fs::write(&ff_cfg, serde_json::to_string_pretty(&default_ff)?)
            .await
            .ok();
    }

    log::info!("User config initialized");
    Ok(())
}
