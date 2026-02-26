// src-tauri/src/model_extractor.rs
//
// Equivalent to electron/modelExtractor.ts — model extraction and TRT conversion.

use anyhow::{bail, Context, Result};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::paths;

/// Shared cancellation flag for in-flight conversions.
#[derive(Default)]
pub struct ConversionState {
    pub cancel_flag: Arc<AtomicBool>,
    pub trtexec_pid: Arc<Mutex<Option<u32>>>,
}

impl ConversionState {
    pub fn new() -> Self {
        Self {
            cancel_flag: Arc::new(AtomicBool::new(false)),
            trtexec_pid: Arc::new(Mutex::new(None)),
        }
    }

    pub fn reset(&self) {
        self.cancel_flag.store(false, Ordering::SeqCst);
        *self.trtexec_pid.lock().unwrap() = None;
    }

    pub fn cancel(&self) {
        self.cancel_flag.store(true, Ordering::SeqCst);
        // Kill trtexec if running
        if let Ok(guard) = self.trtexec_pid.lock() {
            if let Some(pid) = *guard {
                crate::utils::force_kill_pid(pid);
            }
        }
    }
}

/// Convert ONNX model to TensorRT engine using trtexec.
/// `progress_cb` receives (message, percentage) updates.
pub async fn convert_to_engine_with_progress<F>(
    onnx_path: &PathBuf,
    engine_path: &PathBuf,
    use_fp16: bool,
    static_shape_fallback: bool,
    cancel_flag: Arc<AtomicBool>,
    trtexec_pid_slot: Arc<Mutex<Option<u32>>>,
    mut progress_cb: F,
) -> Result<()>
where
    F: FnMut(String, u32) + Send + 'static,
{
    let trtexec = paths::trtexec();
    if !trtexec.exists() {
        bail!("trtexec not found at: {}", trtexec.display());
    }

    let onnx_str = onnx_path.to_string_lossy();
    let engine_str = engine_path.to_string_lossy();

    let mut args = vec![
        format!("--onnx={}", onnx_str),
        format!("--saveEngine={}", engine_str),
        "--verbose".to_string(),
    ];

    if use_fp16 {
        args.push("--fp16".to_string());
    }

    if !static_shape_fallback {
        // Dynamic shape profile
        args.push("--minShapes=input:1x3x8x8".to_string());
        args.push("--optShapes=input:1x3x256x256".to_string());
        args.push("--maxShapes=input:1x3x1080x1920".to_string());
    }

    log::info!("Running trtexec: {} {}", trtexec.display(), args.join(" "));
    progress_cb("Starting TensorRT engine conversion...".to_string(), 0);

    let mut cmd = Command::new(&trtexec);
    cmd.args(&args)
        .envs(crate::utils::vs_environment())
        .current_dir(paths::vs())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().context("Failed to spawn trtexec")?;

    // Store PID for force-kill
    if let Some(pid) = child.id() {
        *trtexec_pid_slot.lock().unwrap() = Some(pid);
    }

    let stdout = child.stdout.take().expect("stdout");
    let stderr = child.stderr.take().expect("stderr");
    let mut out_reader = BufReader::new(stdout).lines();
    let mut err_reader = BufReader::new(stderr).lines();

    let mut pct: u32 = 0;

    loop {
        if cancel_flag.load(Ordering::SeqCst) {
            log::info!("Conversion cancelled by user");
            let _ = child.kill().await;
            bail!("Conversion cancelled by user");
        }

        tokio::select! {
            line = out_reader.next_line() => {
                match line {
                    Ok(Some(l)) => {
                        log::debug!("[trtexec] {}", l);
                        if l.contains("Building engine") { pct = 30; }
                        else if l.contains("Timing") { pct = 60; }
                        else if l.contains("Engine built") { pct = 90; }
                        else if l.contains("Saved engine") { pct = 100; }
                        progress_cb(l.clone(), pct);
                    }
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
            line = err_reader.next_line() => {
                match line {
                    Ok(Some(l)) => {
                        log::debug!("[trtexec stderr] {}", l);
                        progress_cb(l.clone(), pct);
                    }
                    Ok(None) => {}
                    Err(_) => {}
                }
            }
        }
    }

    let status = child.wait().await.context("Wait trtexec")?;
    *trtexec_pid_slot.lock().unwrap() = None;

    if !status.success() {
        let code = status.code().unwrap_or(-1);
        bail!("trtexec exited with code {}", code);
    }

    Ok(())
}

/// Extract bundled ONNX models from `include/models/` to `data/models/`.
pub async fn extract_bundled_models<F>(
    resource_dir: &PathBuf,
    mut progress_cb: F,
) -> Result<()>
where
    F: FnMut(String, u32),
{
    let bundled = paths::resolve_include(resource_dir, "models");
    let target = paths::models();

    if !bundled.exists() {
        log::warn!("Bundled models dir not found: {}", bundled.display());
        return Ok(());
    }

    tokio::fs::create_dir_all(&target).await.context("Create models dir")?;

    let mut entries = tokio::fs::read_dir(&bundled).await.context("Read bundled models dir")?;
    let mut files: Vec<PathBuf> = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let p = entry.path();
        if p.extension().map(|e| e == "onnx").unwrap_or(false) {
            files.push(p);
        }
    }

    let total = files.len() as u32;
    for (i, src) in files.iter().enumerate() {
        let fname = src.file_name().unwrap();
        let dst = target.join(fname);

        let should_copy = if dst.exists() {
            let src_meta = tokio::fs::metadata(src).await?;
            let dst_meta = tokio::fs::metadata(&dst).await?;
            src_meta.len() != dst_meta.len()
        } else {
            true
        };

        if should_copy {
            progress_cb(format!("Extracting {}...", fname.to_string_lossy()), (i * 100 / total as usize) as u32);
            tokio::fs::copy(src, &dst).await.context("Copy model")?;
            log::info!("Extracted model: {:?}", fname);
        } else {
            log::info!("Model already up-to-date: {:?}", fname);
        }
    }

    progress_cb("Models extracted".to_string(), 100);
    Ok(())
}

/// Check if bundled models need to be extracted.
pub async fn needs_extraction(resource_dir: &PathBuf) -> bool {
    let bundled = paths::resolve_include(resource_dir, "models");
    let target = paths::models();

    if !target.exists() {
        return true;
    }

    if !bundled.exists() {
        return false;
    }

    let Ok(mut entries) = tokio::fs::read_dir(&bundled).await else {
        return false;
    };

    while let Ok(Some(entry)) = entries.next_entry().await {
        let p = entry.path();
        if p.extension().map(|e| e == "onnx").unwrap_or(false) {
            let dst = target.join(p.file_name().unwrap());
            if !dst.exists() {
                return true;
            }
        }
    }

    false
}
