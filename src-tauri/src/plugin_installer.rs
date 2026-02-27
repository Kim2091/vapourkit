// src-tauri/src/plugin_installer.rs
//
// Manages pip-based plugin dependency installation — port of electron/pluginInstaller.ts.
// Includes the full multi-step orchestration: pip packages, plugin extraction,
// VS scripts download, script extraction, and filter template copying.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::paths;

/// VS scripts download URL (pinned commit from Selur/VapoursynthScriptsInHybrid)
const VS_SCRIPTS_URL: &str =
    "https://github.com/Selur/VapoursynthScriptsInHybrid/archive/d430e1973a78c2dc52a6e4aa58e5f89cc0093ae9.zip";

/// Packages to check / uninstall
const PLUGIN_PACKAGES: &[&str] = &[
    "torch",
    "torchvision",
    "numpy",
    "positional-encodings",
    "einops",
    "timm",
    "vsjetpack",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginProgress {
    #[serde(rename = "type")]
    pub kind: String,
    pub progress: u32,
    pub message: String,
}

pub struct PluginInstaller {
    pub cancel_flag: Arc<AtomicBool>,
}

impl PluginInstaller {
    pub fn new() -> Self {
        Self {
            cancel_flag: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn cancel(&self) {
        self.cancel_flag.store(true, Ordering::SeqCst);
    }

    // ───────────────────────────────────────────────────────────
    // Full install orchestration (matches Electron installDependencies)
    // ───────────────────────────────────────────────────────────

    /// Run the full plugin dependency installation flow:
    ///   0. setuptools + wheel
    ///   1. torch + torchvision (from PyTorch index)
    ///   2. numpy, positional-encodings, einops, timm, vsjetpack
    ///   3. Extract bundled plugin archives from include/plugins/
    ///   4. Download and extract VS scripts from GitHub
    ///   5. Extract bundled script archives from include/scripts/
    ///   6. Copy filter templates from include/plugins/plugin_filters/
    pub async fn install_dependencies<F>(
        &self,
        resource_dir: &PathBuf,
        mut progress_cb: F,
    ) -> Result<()>
    where
        F: FnMut(PluginProgress) + Send + 'static,
    {
        log::info!("Starting full plugin dependency installation");

        // Step 0 — setuptools + wheel (0-5%)
        log::info!("=== Step 0: Ensuring setuptools and wheel ===");
        progress_cb(PluginProgress {
            kind: "installing".into(),
            progress: 0,
            message: "Installing setuptools and wheel...".into(),
        });
        self.run_pip_install(
            &["setuptools", "wheel"],
            &["--upgrade"],
        )
        .await?;
        if self.is_cancelled() { return Ok(()); }

        // Step 1 — torch + torchvision (5-65%)
        log::info!("=== Step 1: Installing PyTorch and torchvision ===");
        progress_cb(PluginProgress {
            kind: "installing".into(),
            progress: 5,
            message: "Installing PyTorch and torchvision (this may take a while)...".into(),
        });
        self.run_pip_install(
            &["torch", "torchvision"],
            &["--index-url", "https://download.pytorch.org/whl/cu130"],
        )
        .await?;
        if self.is_cancelled() { return Ok(()); }

        // Step 2 — numpy, positional-encodings, einops, timm, vsjetpack (70-85%)
        log::info!("=== Step 2: Installing numpy, einops, timm, vsjetpack ===");
        progress_cb(PluginProgress {
            kind: "installing".into(),
            progress: 70,
            message: "Installing numpy, positional-encodings, einops, timm, vsjetpack...".into(),
        });
        self.run_pip_install(
            &["numpy==2.3.3", "positional-encodings", "einops", "timm", "vsjetpack==1.1.0"],
            &[],
        )
        .await?;
        if self.is_cancelled() { return Ok(()); }

        // Step 3 — Extract bundled plugins from include/plugins/ (85-90%)
        log::info!("=== Step 3: Extracting plugins ===");
        progress_cb(PluginProgress {
            kind: "installing".into(),
            progress: 85,
            message: "Extracting plugins...".into(),
        });
        self.extract_all_plugins(resource_dir).await?;
        if self.is_cancelled() { return Ok(()); }

        // Step 4 — Download and extract VS scripts (90-92%)
        log::info!("=== Step 4: Downloading VapourSynth scripts ===");
        progress_cb(PluginProgress {
            kind: "installing".into(),
            progress: 90,
            message: "Downloading VapourSynth scripts...".into(),
        });
        self.download_and_extract_vs_scripts().await?;
        if self.is_cancelled() { return Ok(()); }

        // Step 5 — Extract bundled scripts from include/scripts/ (92-95%)
        log::info!("=== Step 5: Extracting scripts ===");
        progress_cb(PluginProgress {
            kind: "installing".into(),
            progress: 92,
            message: "Extracting scripts...".into(),
        });
        self.extract_all_scripts(resource_dir).await?;
        if self.is_cancelled() { return Ok(()); }

        // Step 6 — Copy filter templates (95-100%)
        log::info!("=== Step 6: Copying filter templates ===");
        progress_cb(PluginProgress {
            kind: "installing".into(),
            progress: 95,
            message: "Copying filter templates...".into(),
        });
        self.copy_filter_templates(resource_dir).await?;

        log::info!("All plugin dependencies installed successfully");
        progress_cb(PluginProgress {
            kind: "complete".into(),
            progress: 100,
            message: "Dependencies installed successfully!".into(),
        });

        Ok(())
    }

    // ───────────────────────────────────────────────────────────
    // Pip helpers
    // ───────────────────────────────────────────────────────────

    /// Run `pip install` for a set of packages with optional extra args.
    async fn run_pip_install(
        &self,
        packages: &[&str],
        extra_args: &[&str],
    ) -> Result<()> {
        let python = paths::python();
        let pip_cache = paths::pip_cache();
        tokio::fs::create_dir_all(&pip_cache).await.ok();

        let mut args: Vec<String> = vec![
            "-m".into(),
            "pip".into(),
            "install".into(),
            "--no-warn-script-location".into(),
            "--cache-dir".into(),
            pip_cache.to_string_lossy().into_owned(),
        ];
        for pkg in packages {
            args.push(pkg.to_string());
        }
        for a in extra_args {
            args.push(a.to_string());
        }

        log::info!("pip install {}", packages.join(" "));

        let mut cmd = Command::new(python.to_str().unwrap_or("python"));
        crate::utils::configure_tokio_command(&mut cmd);
        cmd.args(&args)
            .envs(crate::utils::vs_environment())
            .current_dir(paths::vs())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd.spawn().context("Spawn pip")?;
        let stdout = child.stdout.take().expect("stdout");
        let stderr = child.stderr.take().expect("stderr");
        let mut out_reader = BufReader::new(stdout).lines();
        let mut err_reader = BufReader::new(stderr).lines();

        loop {
            if self.is_cancelled() {
                let _ = child.kill().await;
                return Ok(());
            }
            tokio::select! {
                line = out_reader.next_line() => {
                    match line {
                        Ok(Some(l)) => log::info!("[pip] {}", l.trim()),
                        Ok(None) => break,
                        Err(_) => break,
                    }
                }
                line = err_reader.next_line() => {
                    match line {
                        Ok(Some(l)) => log::debug!("[pip stderr] {}", l.trim()),
                        Ok(None) => {}
                        Err(_) => {}
                    }
                }
            }
        }

        let status = child.wait().await.context("Wait pip")?;
        if !status.success() {
            anyhow::bail!("pip install failed with code {:?}", status.code());
        }

        Ok(())
    }

    /// Run `pip install` for a set of packages, reporting progress via callback
    /// (used by the raw `install_plugin_dependencies` command when explicit
    /// packages are supplied).
    pub async fn install_packages<F>(
        &self,
        packages: &[&str],
        mut progress_cb: F,
    ) -> Result<()>
    where
        F: FnMut(PluginProgress) + Send + 'static,
    {
        progress_cb(PluginProgress {
            kind: "installing".into(),
            progress: 5,
            message: format!("Installing {}...", packages.join(", ")),
        });

        self.run_pip_install(packages, &[]).await?;

        progress_cb(PluginProgress {
            kind: "complete".into(),
            progress: 100,
            message: "Packages installed successfully".into(),
        });

        Ok(())
    }

    /// Uninstall packages.
    pub async fn uninstall_packages(&self, packages: &[&str]) -> Result<()> {
        let python = paths::python();
        let mut args = vec!["-m", "pip", "uninstall", "-y"];
        for pkg in packages {
            args.push(pkg);
        }

        crate::utils::run_command(python.to_str().unwrap_or("python"), &args, None, None)
            .await
            .context("pip uninstall")?;

        Ok(())
    }

    /// Uninstall all standard plugin packages.
    pub async fn uninstall_dependencies(&self) -> Result<()> {
        self.uninstall_packages(PLUGIN_PACKAGES).await
    }

    /// Check which packages are installed.
    pub async fn check_packages(packages: &[&str]) -> Vec<String> {
        let python = paths::python();
        let output = crate::utils::run_command(
            python.to_str().unwrap_or("python"),
            &["-m", "pip", "list", "--format=json"],
            Some(&paths::vs()),
            None,
        )
        .await;

        let Ok(result) = output else {
            return Vec::new();
        };

        let installed_names: Vec<String> = serde_json::from_str::<Vec<PipListEntry>>(&result.stdout)
            .unwrap_or_default()
            .into_iter()
            .map(|e| e.name.to_lowercase())
            .collect();

        packages
            .iter()
            .filter(|pkg| installed_names.contains(&pkg.to_lowercase()))
            .map(|pkg| pkg.to_string())
            .collect()
    }

    /// Check if standard plugin dependencies are installed.
    pub async fn check_installed() -> CheckResult {
        let found = Self::check_packages(PLUGIN_PACKAGES).await;
        let all = found.len() == PLUGIN_PACKAGES.len();
        CheckResult {
            installed: all,
            packages: found,
        }
    }

    // ───────────────────────────────────────────────────────────
    // File / archive helpers (replicating Electron steps 3-6)
    // ───────────────────────────────────────────────────────────

    /// Extract all .7z archives from `include/plugins/` into the VS plugins dir.
    async fn extract_all_plugins(&self, resource_dir: &PathBuf) -> Result<()> {
        let plugins_folder = paths::resolve_include(resource_dir, "plugins");
        if !plugins_folder.exists() {
            log::info!("No plugins folder found, skipping plugin extraction");
            return Ok(());
        }

        let mut entries = tokio::fs::read_dir(&plugins_folder).await?;
        let mut archives: Vec<PathBuf> = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            let p = entry.path();
            if p.extension().map(|e| e == "7z").unwrap_or(false) {
                archives.push(p);
            }
        }

        if archives.is_empty() {
            log::info!("No plugin archives found");
            return Ok(());
        }

        log::info!("Found {} plugin archive(s)", archives.len());
        let dest = paths::plugins();
        tokio::fs::create_dir_all(&dest).await.ok();

        for archive in &archives {
            let name = archive.file_name().unwrap_or_default().to_string_lossy();
            log::info!("Extracting plugin: {}", name);
            if let Err(e) = crate::dependency_manager::extract_7z(archive, &dest).await {
                log::error!("Failed to extract {}: {}", name, e);
                // Continue with other plugins
            }
        }

        Ok(())
    }

    /// Download VS scripts zip from GitHub, extract all .py files to vs-scripts.
    async fn download_and_extract_vs_scripts(&self) -> Result<()> {
        let temp_dir = paths::temp_dir();
        let zip_path = temp_dir.join("vs-scripts.zip");
        let extract_path = temp_dir.join("vs-scripts-extracted");

        tokio::fs::create_dir_all(&temp_dir).await.ok();
        tokio::fs::create_dir_all(&extract_path).await.ok();
        tokio::fs::create_dir_all(paths::scripts()).await.ok();

        // Download
        crate::dependency_manager::download_file(VS_SCRIPTS_URL, &zip_path, |_, _| {}).await?;

        // Extract zip
        crate::dependency_manager::extract_zip(&zip_path, &extract_path).await?;

        // Find all .py files recursively and copy to vs-scripts/
        let py_files = find_files_recursive(&extract_path, "py").await?;
        log::info!("Found {} .py file(s) in VS scripts archive", py_files.len());

        for py_file in &py_files {
            if let Some(fname) = py_file.file_name() {
                let dest = paths::scripts().join(fname);
                tokio::fs::copy(py_file, &dest).await.ok();
                log::info!("Copied {} to vs-scripts", fname.to_string_lossy());
            }
        }

        // Cleanup
        tokio::fs::remove_file(&zip_path).await.ok();
        tokio::fs::remove_dir_all(&extract_path).await.ok();

        log::info!("VS scripts download and extraction complete");
        Ok(())
    }

    /// Extract all .7z archives from `include/scripts/` into vs-scripts.
    async fn extract_all_scripts(&self, resource_dir: &PathBuf) -> Result<()> {
        let scripts_folder = paths::resolve_include(resource_dir, "scripts");
        if !scripts_folder.exists() {
            log::info!("No scripts folder found, skipping script extraction");
            return Ok(());
        }

        let mut entries = tokio::fs::read_dir(&scripts_folder).await?;
        let mut archives: Vec<PathBuf> = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            let p = entry.path();
            if p.extension().map(|e| e == "7z").unwrap_or(false) {
                archives.push(p);
            }
        }

        if archives.is_empty() {
            log::info!("No script archives found");
            return Ok(());
        }

        log::info!("Found {} script archive(s)", archives.len());
        let dest = paths::scripts();
        tokio::fs::create_dir_all(&dest).await.ok();

        for archive in &archives {
            let name = archive.file_name().unwrap_or_default().to_string_lossy();
            log::info!("Extracting script: {}", name);
            if let Err(e) = crate::dependency_manager::extract_7z(archive, &dest).await {
                log::error!("Failed to extract {}: {}", name, e);
            }
        }

        Ok(())
    }

    /// Copy filter templates from `include/plugins/plugin_filters/` to config.
    async fn copy_filter_templates(&self, resource_dir: &PathBuf) -> Result<()> {
        let plugin_filters = paths::resolve_include(resource_dir, "plugins")
            .join("plugin_filters");

        if !plugin_filters.exists() {
            log::info!("No plugin_filters folder found, skipping");
            return Ok(());
        }

        let dest = paths::filter_templates();
        tokio::fs::create_dir_all(&dest).await.ok();

        let mut entries = tokio::fs::read_dir(&plugin_filters).await?;
        while let Some(entry) = entries.next_entry().await? {
            let p = entry.path();
            if p.is_file() {
                if let Some(fname) = p.file_name() {
                    let dst = dest.join(fname);
                    tokio::fs::copy(&p, &dst).await.ok();
                    log::info!("Copied filter template: {}", fname.to_string_lossy());
                }
            }
        }

        Ok(())
    }

    fn is_cancelled(&self) -> bool {
        self.cancel_flag.load(Ordering::SeqCst)
    }
}

// ───────────────────────────────────────────────────────────
// Helper types / functions
// ───────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct CheckResult {
    pub installed: bool,
    pub packages: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct PipListEntry {
    name: String,
    #[allow(dead_code)]
    version: String,
}

/// Recursively find all files with a given extension under `dir`.
async fn find_files_recursive(dir: &PathBuf, ext: &str) -> Result<Vec<PathBuf>> {
    let mut result = Vec::new();
    let mut stack = vec![dir.clone()];

    while let Some(current) = stack.pop() {
        let mut entries = tokio::fs::read_dir(&current).await?;
        while let Some(entry) = entries.next_entry().await? {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().map(|e| e == ext).unwrap_or(false) {
                result.push(p);
            }
        }
    }

    Ok(result)
}

fn parse_pip_line(line: &str) -> Option<(String, u32)> {
    let l = line.trim();
    if l.is_empty() {
        return None;
    }
    if l.starts_with("Collecting") {
        let pkg = l.trim_start_matches("Collecting").trim().split_whitespace().next().unwrap_or("");
        return Some((format!("Collecting {}...", pkg), 10));
    }
    if l.starts_with("Downloading") {
        let pkg = l.trim_start_matches("Downloading").trim().split_whitespace().next().unwrap_or("");
        return Some((format!("Downloading {}...", pkg), 30));
    }
    if l.contains("Installing collected packages") {
        return Some(("Installing packages...".to_string(), 80));
    }
    if l.contains("Successfully installed") {
        return Some((l.to_string(), 95));
    }
    if l.contains("Requirement already satisfied") {
        return Some((l.to_string(), 90));
    }
    None
}
