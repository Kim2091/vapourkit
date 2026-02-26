// src-tauri/src/ffmpeg_manager.rs
//
// Equivalent to electron/ffmpegManager.ts

use anyhow::{Context, Result};
use reqwest::Client;
use std::path::PathBuf;
use tokio::fs;
use tokio::io::AsyncWriteExt;

const FFMPEG_URL: &str = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-git-full.7z";

pub struct FFmpegManager;

impl FFmpegManager {
    pub fn get_ffmpeg_path() -> Option<PathBuf> {
        let path = crate::paths::ffmpeg();
        if path.exists() { Some(path) } else { None }
    }

    pub fn get_ffprobe_path() -> Option<PathBuf> {
        let path = crate::paths::ffprobe();
        if path.exists() { Some(path) } else { None }
    }

    pub fn is_installed() -> bool {
        crate::paths::ffmpeg().exists()
    }

    /// Download and extract FFmpeg from gyan.dev
    pub async fn install<F>(mut on_progress: F) -> Result<()>
    where
        F: FnMut(&str, f64) + Send + 'static,
    {
        if FFmpegManager::is_installed() {
            on_progress("FFmpeg already installed", 100.0);
            return Ok(());
        }

        let ffmpeg_dir = crate::paths::ffmpeg_dir();
        fs::create_dir_all(&ffmpeg_dir).await?;

        let archive_path = crate::paths::app_data().join("ffmpeg-git-full.7z");

        on_progress("Downloading ffmpeg from gyan.dev...", 0.0);
        log::info!("Downloading ffmpeg from {}", FFMPEG_URL);

        let client = Client::new();
        let response = client
            .get(FFMPEG_URL)
            .send()
            .await
            .context("download ffmpeg")?;

        let total = response.content_length().unwrap_or(0);
        let mut downloaded: u64 = 0;

        let mut file = tokio::fs::File::create(&archive_path).await?;
        let mut stream = response.bytes_stream();

        use futures_util::StreamExt;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("stream chunk")?;
            file.write_all(&chunk).await?;
            downloaded += chunk.len() as u64;
            if total > 0 {
                let pct = (downloaded as f64 / total as f64) * 70.0;
                on_progress(
                    &format!(
                        "Downloading ffmpeg... {}/{}",
                        crate::utils::format_bytes(downloaded),
                        crate::utils::format_bytes(total)
                    ),
                    pct,
                );
            }
        }
        file.flush().await?;

        on_progress("Extracting ffmpeg...", 70.0);
        log::info!("Extracting ffmpeg archive");

        // Extract 7z archive
        extract_7z(&archive_path, &crate::paths::app_data()).await?;

        // Find extracted directory and move ffmpeg to expected location
        let app_data = crate::paths::app_data();
        let mut ffmpeg_extracted: Option<PathBuf> = None;
        let mut entries = fs::read_dir(&app_data).await?;
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with("ffmpeg-") && entry.metadata().await?.is_dir() {
                ffmpeg_extracted = Some(entry.path());
                break;
            }
        }

        if let Some(extracted) = ffmpeg_extracted {
            // Move the extracted directory to our expected ffmpeg_dir
            if ffmpeg_dir.exists() {
                fs::remove_dir_all(&ffmpeg_dir).await?;
            }
            tokio::fs::rename(&extracted, &ffmpeg_dir).await?;
        }

        // Clean up archive
        let _ = fs::remove_file(&archive_path).await;

        on_progress("FFmpeg installed successfully", 100.0);
        log::info!("FFmpeg installed at: {}", ffmpeg_dir.display());
        Ok(())
    }
}

/// Extract a .7z archive to a destination directory using sevenz-rust
pub async fn extract_7z(archive: &PathBuf, dest: &PathBuf) -> Result<()> {
    let archive = archive.clone();
    let dest = dest.clone();
    tokio::task::spawn_blocking(move || {
        sevenz_rust::decompress_file(&archive, &dest)
            .context("7z extraction failed")
    })
    .await??;
    Ok(())
}

/// Convenience free function so other modules can call `ffmpeg_manager::ffmpeg_exe_path()`.
pub fn ffmpeg_exe_path() -> PathBuf {
    crate::paths::ffmpeg()
}

/// Convenience free function for installation with a `FnMut(String, u32)` callback.
pub async fn install<F>(mut progress_cb: F) -> anyhow::Result<()>
where
    F: FnMut(String, u32) + Send + 'static,
{
    FFmpegManager::install(move |msg, pct| {
        progress_cb(msg.to_string(), pct as u32);
    })
    .await
}
