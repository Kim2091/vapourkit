// src-tauri/src/vs_view_manager.rs
//
// Launch the VSE Previewer tool — port of electron/vsViewManager.ts

use anyhow::{bail, Context, Result};
use std::path::PathBuf;

use crate::paths;

/// Launch vs-preview (Python-based VapourSynth previewer) with the given script.
///
/// Mirrors the Electron `VsViewManager.launch()` which runs
/// `python -m vspreview <script_path>` inside the VS environment.
pub async fn launch_vse_previewer(script_path: Option<&PathBuf>) -> Result<()> {
    let python = paths::python();
    if !python.exists() {
        bail!("Python not found at: {}. VapourSynth dependencies may not be installed.", python.display());
    }

    let script = script_path
        .ok_or_else(|| anyhow::anyhow!("No script path provided for vs-preview"))?;

    if !script.exists() {
        bail!("Script file not found: {}. The VapourSynth script may have failed to generate.", script.display());
    }

    let env = crate::utils::vs_environment();
    let vs_dir = paths::vs();

    let script_str = script.to_string_lossy().into_owned();
    let args = ["-m", "vspreview", &script_str];
    log::info!("Launching vs-preview: {} {}", python.display(), args.join(" "));

    let mut child = tokio::process::Command::new(&python)
        .args(&args)
        .envs(&env)
        .current_dir(&vs_dir)
        .stderr(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .spawn()
        .context("Spawn vs-preview")?;

    // Mirror Electron's 2-second window: if vspreview exits immediately, report the error.
    // If it's still running after 2 s, it launched successfully — detach and return.
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        child.wait(),
    )
    .await;

    match result {
        Ok(Ok(status)) => {
            // Process exited within 2 s — always an error for a GUI app
            let stderr_text = if let Some(stderr) = child.stderr.take() {
                use tokio::io::AsyncReadExt;
                let mut buf = String::new();
                let mut r = stderr;
                let _ = r.read_to_string(&mut buf).await;
                buf
            } else {
                String::new()
            };
            let code = status.code().unwrap_or(-1);
            bail!(
                "vs-preview exited immediately with code {}.{}\nMake sure vspreview is installed: python -m pip install vspreview",
                code,
                if stderr_text.trim().is_empty() { String::new() } else { format!(" Stderr: {}", stderr_text.trim()) }
            );
        }
        Err(_timeout) => {
            // Still running after 2 s — success.  Drop child handle without killing it.
            log::info!("vs-preview launched successfully (still running after 2s)");
            Ok(())
        }
        Ok(Err(e)) => {
            bail!("vs-preview wait error: {}", e);
        }
    }
}

/// Launch the video-compare tool with two video paths and optional extra args.
pub async fn launch_video_compare(input: &PathBuf, output: &PathBuf, extra_args_str: &str) -> Result<()> {
    let exe = paths::video_compare_exe();

    if !exe.exists() {
        bail!("video-compare not found: {}", exe.display());
    }
    if !input.exists() {
        bail!("Input video not found: {}", input.display());
    }
    if !output.exists() {
        bail!("Output video not found: {}", output.display());
    }

    // Parse extra args from the config string
    let extra_args: Vec<String> = extra_args_str
        .split_whitespace()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();

    let mut args: Vec<String> = extra_args;
    args.push(input.to_string_lossy().into_owned());
    args.push(output.to_string_lossy().into_owned());

    log::info!("Launching video-compare: {} {}", exe.display(), args.join(" "));

    tokio::process::Command::new(&exe)
        .args(&args)
        .spawn()
        .context("Spawn video-compare")?;

    Ok(())
}
