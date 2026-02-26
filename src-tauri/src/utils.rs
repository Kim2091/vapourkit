// src-tauri/src/utils.rs
//
// Equivalent to electron/utils.ts — subprocess running, environment setup, etc.

use anyhow::{bail, Context, Result};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

/// Result of running a child process
#[derive(Debug)]
pub struct ProcessResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

/// Build the environment map for VapourSynth processes.
/// Adds VS, Python, and plugin paths to PATH and sets PYTHONPATH.
pub fn vs_environment() -> HashMap<String, String> {
    let vs = crate::paths::vs();
    let plugins = crate::paths::plugins();
    let scripts = crate::paths::scripts();

    let mut env: HashMap<String, String> = std::env::vars().collect();

    // Prepend VS directory to PATH
    let existing_path = env.get("PATH").cloned().unwrap_or_default();
    let new_path = format!(
        "{};{};{}",
        vs.display(),
        plugins.display(),
        existing_path
    );
    env.insert("PATH".to_string(), new_path);

    // Set PYTHONHOME so the portable Python can find its standard library
    env.insert(
        "PYTHONHOME".to_string(),
        vs.to_string_lossy().into_owned(),
    );

    // Set PYTHONPATH to site-packages (matching Electron behaviour)
    env.insert(
        "PYTHONPATH".to_string(),
        format!(
            "{};{}",
            vs.join("Lib").join("site-packages").display(),
            scripts.display()
        ),
    );

    // Set both VS_PLUGINS_PATH and VAPOURSYNTH_PLUGINS_PATH
    env.insert(
        "VS_PLUGINS_PATH".to_string(),
        plugins.to_string_lossy().into_owned(),
    );
    env.insert(
        "VAPOURSYNTH_PLUGINS_PATH".to_string(),
        plugins.to_string_lossy().into_owned(),
    );

    env
}

/// Run a command and capture stdout + stderr, returning an error on nonzero exit.
pub async fn run_command(
    command: &str,
    args: &[&str],
    cwd: Option<&PathBuf>,
    env: Option<&HashMap<String, String>>,
) -> Result<ProcessResult> {
    log::debug!("Running: {} {}", command, args.join(" "));

    let mut cmd = Command::new(command);
    cmd.args(args);

    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    if let Some(env_map) = env {
        cmd.envs(env_map);
    }

    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let child = cmd.spawn().context("spawn process")?;
    let output = child.wait_with_output().await.context("wait process")?;

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let code = output.status.code().unwrap_or(-1);

    if !output.status.success() {
        bail!(
            "Command '{}' exited with code {}: {}",
            command,
            code,
            stderr.trim()
        );
    }

    Ok(ProcessResult { stdout, stderr, code })
}

/// Run a command and stream stdout/stderr lines to a callback.
/// Useful for progress reporting.
pub async fn run_command_streaming<F>(
    command: &str,
    args: &[&str],
    cwd: Option<&PathBuf>,
    env: Option<HashMap<String, String>>,
    mut on_line: F,
) -> Result<i32>
where
    F: FnMut(&str, bool) + Send + 'static,
{
    log::debug!("Streaming: {} {}", command, args.join(" "));

    let mut cmd = Command::new(command);
    cmd.args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    if let Some(env_map) = env {
        cmd.envs(env_map);
    }

    let mut child = cmd.spawn().context("spawn streaming process")?;

    let stdout = child.stdout.take().expect("stdout handle");
    let stderr = child.stderr.take().expect("stderr handle");

    let mut stdout_reader = BufReader::new(stdout).lines();
    let mut stderr_reader = BufReader::new(stderr).lines();

    loop {
        tokio::select! {
            line = stdout_reader.next_line() => {
                match line {
                    Ok(Some(l)) => on_line(&l, false),
                    Ok(None) => break,
                    Err(e) => { log::debug!("stdout read error: {}", e); break; }
                }
            }
            line = stderr_reader.next_line() => {
                match line {
                    Ok(Some(l)) => on_line(&l, true),
                    Ok(None) => {}
                    Err(e) => { log::debug!("stderr read error: {}", e); }
                }
            }
        }
    }

    let status = child.wait().await.context("wait streaming process")?;
    Ok(status.code().unwrap_or(-1))
}

/// Format byte count into a human-readable string.
pub fn format_bytes(bytes: u64) -> String {
    const UNITS: &[&str] = &["B", "KB", "MB", "GB", "TB"];
    let mut size = bytes as f64;
    let mut unit_idx = 0;
    while size >= 1024.0 && unit_idx < UNITS.len() - 1 {
        size /= 1024.0;
        unit_idx += 1;
    }
    if unit_idx == 0 {
        format!("{} {}", bytes, UNITS[0])
    } else {
        format!("{:.2} {}", size, UNITS[unit_idx])
    }
}

/// Force-kill a process by PID on Windows using taskkill /F /T
pub fn force_kill_pid(pid: u32) {
    let _ = std::process::Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .output();
}
