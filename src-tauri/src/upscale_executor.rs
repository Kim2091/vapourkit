// src-tauri/src/upscale_executor.rs
//
// Port of electron/upscaleExecutor.ts — spawns vspipe | ffmpeg and reports progress.

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;

use crate::paths;
use crate::utils::{force_kill_pid, vs_environment};

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentSelection {
    pub enabled: bool,
    pub start_frame: u32,
    pub end_frame: i64, // -1 means end of video
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpscaleProgress {
    #[serde(rename = "type")]
    pub kind: String,
    pub current_frame: u64,
    pub total_frames: u64,
    pub fps: f64,
    pub percentage: u32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_frame: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_stopping: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputInfo {
    pub resolution: Option<String>,
    pub fps: Option<f64>,
    pub fps_string: Option<String>,
    pub pixel_format: Option<String>,
    pub error: Option<String>,
}

// ──────────────────────────────────────────────────────────────
// Shared cancellation state
// ──────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct UpscaleState {
    pub cancel_flag: Arc<AtomicBool>,
    pub kill_flag: Arc<AtomicBool>,
    pub vspipe_pid: Arc<Mutex<Option<u32>>>,
    pub ffmpeg_pid: Arc<Mutex<Option<u32>>>,
    /// Used by model.rs for TRT conversion cancellation
    pub model_cancel_flag: Option<Arc<AtomicBool>>,
    /// PID of a running trtexec process (for force-kill)
    pub trtexec_pid: Option<u32>,
}

impl UpscaleState {
    pub fn new() -> Self {
        Self {
            cancel_flag: Arc::new(AtomicBool::new(false)),
            kill_flag: Arc::new(AtomicBool::new(false)),
            vspipe_pid: Arc::new(Mutex::new(None)),
            ffmpeg_pid: Arc::new(Mutex::new(None)),
            model_cancel_flag: None,
            trtexec_pid: None,
        }
    }

    pub fn reset(&self) {
        self.cancel_flag.store(false, Ordering::SeqCst);
        self.kill_flag.store(false, Ordering::SeqCst);
        *self.vspipe_pid.lock().unwrap() = None;
        *self.ffmpeg_pid.lock().unwrap() = None;
    }

    pub fn cancel(&self) {
        self.cancel_flag.store(true, Ordering::SeqCst);
    }

    pub fn kill(&self) {
        self.kill_flag.store(true, Ordering::SeqCst);
        self.cancel_flag.store(true, Ordering::SeqCst);
        if let Ok(g) = self.vspipe_pid.lock() {
            if let Some(pid) = *g { force_kill_pid(pid); }
        }
        if let Ok(g) = self.ffmpeg_pid.lock() {
            if let Some(pid) = *g { force_kill_pid(pid); }
        }
    }
}

// ──────────────────────────────────────────────────────────────
// Helper: resolve vspipe + ffmpeg paths
// ──────────────────────────────────────────────────────────────

fn vspipe_path() -> PathBuf { paths::vs().join("vspipe.exe") }
fn ffmpeg_path() -> PathBuf { crate::ffmpeg_manager::ffmpeg_exe_path() }

// ──────────────────────────────────────────────────────────────
// Get output info (frame count, resolution, pixel format)
// ──────────────────────────────────────────────────────────────

/// Call `vspipe --info <script>` and parse output.
pub async fn get_output_info(script_path: &PathBuf) -> Result<OutputInfo> {
    let vspipe = vspipe_path();
    if !vspipe.exists() {
        bail!("vspipe not found at {}", vspipe.display());
    }

    let env = vs_environment();
    let vs_dir = paths::vs();

    let out = crate::utils::run_command(
        vspipe.to_str().unwrap(),
        &["--info", script_path.to_str().unwrap()],
        Some(&vs_dir),
        Some(&env),
    )
    .await?;

    let combined = format!("{}\n{}", out.stdout, out.stderr);
    parse_output_info(&combined)
}

/// Parse `vspipe --info` textual output.
fn parse_output_info(text: &str) -> Result<OutputInfo> {
    let mut width: Option<u32> = None;
    let mut height: Option<u32> = None;
    let mut fps_num: Option<u64> = None;
    let mut fps_den: Option<u64> = None;
    let mut pixel_format: Option<String> = None;

    for line in text.lines() {
        if let Some(v) = strip_prefix_val(line, "Width:") {
            width = v.parse().ok();
        } else if let Some(v) = strip_prefix_val(line, "Height:") {
            height = v.parse().ok();
        } else if let Some(v) = strip_prefix_val(line, "FPS:") {
            // "FPS: 24000/1001" or "FPS: 24"
            let v = v.trim();
            if let Some((n, d)) = v.split_once('/') {
                fps_num = n.trim().parse().ok();
                fps_den = d.trim().parse().ok();
            } else {
                fps_num = v.parse::<u64>().ok();
                fps_den = Some(1);
            }
        } else if let Some(v) = strip_prefix_val(line, "Format Name:") {
            pixel_format = Some(v.trim().to_string());
        }
    }

    let resolution = if let (Some(w), Some(h)) = (width, height) {
        Some(format!("{}x{}", w, h))
    } else {
        None
    };

    let (fps, fps_string) = match (fps_num, fps_den) {
        (Some(n), Some(d)) if d > 0 => {
            let f = n as f64 / d as f64;
            let s = if d == 1 {
                format!("{}", n)
            } else {
                format!("{}/{}", n, d)
            };
            (Some(f), Some(s))
        }
        _ => (None, None),
    };

    Ok(OutputInfo {
        resolution,
        fps,
        fps_string,
        pixel_format,
        error: None,
    })
}

fn strip_prefix_val<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
    let line = line.trim();
    if line.starts_with(prefix) {
        Some(line[prefix.len()..].trim())
    } else {
        None
    }
}

/// Get the number of frames from a generated script using `vspipe --info`.
pub async fn get_frame_count(script_path: &PathBuf) -> Result<u64> {
    let vspipe = vspipe_path();
    let env = vs_environment();
    let vs_dir = paths::vs();

    let out = crate::utils::run_command(
        vspipe.to_str().unwrap(),
        &["--info", script_path.to_str().unwrap()],
        Some(&vs_dir),
        Some(&env),
    )
    .await?;

    let combined = format!("{}\n{}", out.stdout, out.stderr);
    for line in combined.lines() {
        if let Some(v) = strip_prefix_val(line, "Frames:") {
            if let Ok(n) = v.trim().parse::<u64>() {
                return Ok(n);
            }
        }
    }
    bail!("Could not parse frame count from vspipe output:\n{}", combined)
}

// ──────────────────────────────────────────────────────────────
// Main execute function
// ──────────────────────────────────────────────────────────────

/// Run the vspipe → ffmpeg pipeline and stream progress events.
/// `emit_progress` is called for each progress update.
/// `ffmpeg_args_str` is the user-configured FFmpeg encoding args string (e.g. "-c:v libx264 -crf 18").
pub async fn execute<F>(
    script_path: PathBuf,
    output_path: PathBuf,
    input_path: PathBuf,
    total_frames: u64,
    preview_mode: bool,
    segment: Option<SegmentSelection>,
    fps: Option<f64>,
    state: Arc<UpscaleState>,
    ffmpeg_args_str: String,
    mut emit_progress: F,
) -> Result<()>
where
    F: FnMut(UpscaleProgress) + Send + 'static,
{
    log::info!("Starting upscale: {:?} -> {:?}", input_path, output_path);

    // Validate inputs
    if !script_path.exists() {
        bail!("Script not found: {}", script_path.display());
    }
    if !input_path.exists() {
        bail!("Input not found: {}", input_path.display());
    }

    let vspipe = vspipe_path();
    let ffmpeg = ffmpeg_path();

    if !vspipe.exists() { bail!("vspipe not found: {}", vspipe.display()); }
    if !ffmpeg.exists() { bail!("ffmpeg not found: {}", ffmpeg.display()); }

    let env = vs_environment();
    let vs_dir = paths::vs();

    // Determine pixel format
    let output_info = get_output_info(&script_path).await.unwrap_or(OutputInfo {
        resolution: None, fps: None, fps_string: None, pixel_format: None, error: None,
    });
    let is_raw = is_raw_format(output_info.pixel_format.as_deref());
    let pix_fmt_ffmpeg = map_vs_to_ffmpeg(output_info.pixel_format.as_deref());

    // Build vspipe args
    let script_str = script_path.to_str().unwrap().to_string();
    let vs_args: Vec<&str> = if is_raw {
        vec![&script_str, "-"]
    } else {
        vec!["-c", "y4m", &script_str, "-"]
    };

    // Spawn vspipe
    let mut vs_cmd = Command::new(&vspipe);
    crate::utils::configure_tokio_command(&mut vs_cmd);
    vs_cmd.args(&vs_args)
        .envs(&env)
        .current_dir(&vs_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);

    let mut vspipe_proc = vs_cmd.spawn().context("Spawn vspipe")?;
    if let Some(pid) = vspipe_proc.id() {
        *state.vspipe_pid.lock().unwrap() = Some(pid);
    }

    // Build ffmpeg args
    let ffmpeg_args = build_ffmpeg_args(
        &input_path, &output_path, &output_info, is_raw, &pix_fmt_ffmpeg,
        preview_mode, segment.as_ref(), fps, &ffmpeg_args_str,
    );

    // Spawn ffmpeg
    let mut ff_cmd = Command::new(&ffmpeg);
    crate::utils::configure_tokio_command(&mut ff_cmd);
    ff_cmd.args(&ffmpeg_args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let mut ffmpeg_proc = ff_cmd.spawn().context("Spawn ffmpeg")?;
    if let Some(pid) = ffmpeg_proc.id() {
        *state.ffmpeg_pid.lock().unwrap() = Some(pid);
    }

    // Pipe vspipe stdout → ffmpeg stdin in a dedicated task
    let vspipe_stdout = vspipe_proc.stdout.take().expect("vspipe stdout");
    let ffmpeg_stdin = ffmpeg_proc.stdin.take().expect("ffmpeg stdin");

    let cancel_flag_pipe = state.cancel_flag.clone();
    tokio::spawn(async move {
        let mut reader = vspipe_stdout;
        let mut writer = ffmpeg_stdin;
        let mut buf = vec![0u8; 65536];
        loop {
            if cancel_flag_pipe.load(Ordering::SeqCst) { break; }
            match reader.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    use tokio::io::AsyncWriteExt;
                    if writer.write_all(&buf[..n]).await.is_err() { break; }
                }
            }
        }
    });

    // Read vspipe stderr — route into the progress channel so "Frame: N/M" lines
    // drive the progress bar even before ffmpeg emits any stats.
    let vspipe_stderr = vspipe_proc.stderr.take().expect("vspipe stderr");
    let vs_cancel = state.cancel_flag.clone();

    // Use channels to send previews and progress lines back
    let (tx_line, mut rx_line) = tokio::sync::mpsc::channel::<(String, bool)>(512);
    let tx_line2 = tx_line.clone();
    let tx_vs = tx_line.clone();

    let vs_stderr_handle = tokio::spawn(async move {
        let mut lines = BufReader::new(vspipe_stderr).lines();
        let mut buf = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            if vs_cancel.load(Ordering::SeqCst) { break; }
            log::debug!("[vspipe] {}", line);
            buf.push_str(&line);
            buf.push('\n');
            if buf.len() > 1024 * 1024 { buf.clear(); }
            // Forward to progress loop for "Frame: N/M" parsing
            let _ = tx_vs.send((line, true)).await;
        }
        buf
    });

    // Read ffmpeg stderr for progress and ffmpeg stdout for preview frames
    let ffmpeg_stderr = ffmpeg_proc.stderr.take().expect("ffmpeg stderr");
    let ffmpeg_stdout = ffmpeg_proc.stdout.take().expect("ffmpeg stdout");

    let ff_cancel = state.cancel_flag.clone();

    // stderr reader task
    // ffmpeg often writes progress with carriage returns and partial chunks,
    // so split on both '\n' and '\r' from a rolling text buffer.
    tokio::spawn(async move {
        let mut reader = ffmpeg_stderr;
        let mut chunk = [0u8; 4096];
        let mut pending = String::new();

        loop {
            if ff_cancel.load(Ordering::SeqCst) { break; }

            let n = match reader.read(&mut chunk).await {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => break,
            };

            let text = String::from_utf8_lossy(&chunk[..n]);
            pending.push_str(&text);

            let mut start = 0usize;
            for (idx, ch) in pending.char_indices() {
                if ch == '\n' || ch == '\r' {
                    let line = pending[start..idx].trim();
                    if !line.is_empty() {
                        if tx_line.send((line.to_string(), true)).await.is_err() {
                            return;
                        }
                    }
                    start = idx + ch.len_utf8();
                }
            }

            if start > 0 {
                pending = pending[start..].to_string();
            }

            if pending.len() > 4096 {
                pending = pending[pending.len().saturating_sub(2048)..].to_string();
            }
        }

        let tail = pending.trim();
        if !tail.is_empty() {
            let _ = tx_line.send((tail.to_string(), true)).await;
        }
    });

    // stdout (preview JPEG) reader task
    let ff_cancel2 = state.cancel_flag.clone();
    tokio::spawn(async move {
        let mut reader = ffmpeg_stdout;
        let mut buf = Vec::<u8>::new();
        let mut chunk = vec![0u8; 65536];
        let soi = [0xFF_u8, 0xD8];
        let eoi = [0xFF_u8, 0xD9];

        while let Ok(n) = reader.read(&mut chunk).await {
            if n == 0 { break; }
            if ff_cancel2.load(Ordering::SeqCst) { break; }

            if buf.len() < 5 * 1024 * 1024 {
                buf.extend_from_slice(&chunk[..n]);
            }

            // Extract complete JPEG frames
            loop {
                let start = find_bytes(&buf, &soi);
                let end = find_bytes(&buf, &eoi);
                if let (Some(s), Some(e)) = (start, end) {
                    if e > s {
                        let frame = buf[s..e + 2].to_vec();
                        buf.drain(..e + 2);
                        let b64 = STANDARD.encode(&frame);
                        let _ = tx_line2.send((b64, false)).await;
                        continue;
                    }
                }
                break;
            }
        }
    });

    // Collect progress / preview
    let mut current_frame: u64 = 0;
    let mut current_fps: f64 = 0.0;
    let mut last_preview_ms: u128 = 0;
    let min_preview_interval = 750u128;

    while let Some((msg, is_stderr)) = rx_line.recv().await {
        if state.kill_flag.load(Ordering::SeqCst) { break; }

        if is_stderr {
            log::debug!("[ffmpeg] {}", msg);
            // Parse progress: "frame=  662 fps=187 q=24.0"
            if let Some((frame, fps_val)) = parse_ffmpeg_progress(&msg) {
                current_frame = frame;
                if let Some(fps) = fps_val {
                    current_fps = fps;
                }
                let pct = if total_frames > 0 {
                    (current_frame * 100 / total_frames) as u32
                } else {
                    0
                };
                let stopping = state.cancel_flag.load(Ordering::SeqCst);
                emit_progress(UpscaleProgress {
                    kind: "progress".to_string(),
                    current_frame,
                    total_frames,
                    fps: current_fps,
                    percentage: pct,
                    message: if stopping {
                        "Stopping processing...".to_string()
                    } else {
                        format!("Processing frame {}/{}", current_frame, total_frames)
                    },
                    preview_frame: None,
                    is_stopping: if stopping { Some(true) } else { None },
                });
            }
        } else {
            // Preview JPEG base64
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            if now - last_preview_ms >= min_preview_interval {
                last_preview_ms = now;
                let pct = if total_frames > 0 {
                    (current_frame * 100 / total_frames) as u32
                } else { 0 };
                emit_progress(UpscaleProgress {
                    kind: "preview-frame".to_string(),
                    current_frame,
                    total_frames,
                    fps: current_fps,
                    percentage: pct,
                    message: String::new(),
                    preview_frame: Some(msg),
                    is_stopping: None,
                });
            }
        }

        if state.cancel_flag.load(Ordering::SeqCst) { break; }
    }

    // Wait for vspipe exit
    let vs_stderr_text = vs_stderr_handle.await.unwrap_or_default();
    let vs_status = vspipe_proc.wait().await.context("Wait vspipe")?;
    let ff_status = ffmpeg_proc.wait().await.context("Wait ffmpeg")?;

    *state.vspipe_pid.lock().unwrap() = None;
    *state.ffmpeg_pid.lock().unwrap() = None;

    if state.cancel_flag.load(Ordering::SeqCst) {
        // Cancelled — not an error
        return Ok(());
    }

    if !vs_status.success() {
        let code = vs_status.code().unwrap_or(-1);
        let err = extract_error_from_stderr(&vs_stderr_text);
        bail!("vspipe exited with code {}: {}", code, err);
    }

    if !ff_status.success() {
        let code = ff_status.code().unwrap_or(-1);
        bail!("ffmpeg exited with code {}", code);
    }

    emit_progress(UpscaleProgress {
        kind: "complete".to_string(),
        current_frame: total_frames,
        total_frames,
        fps: current_fps,
        percentage: 100,
        message: "Processing completed successfully!".to_string(),
        preview_frame: None,
        is_stopping: None,
    });

    Ok(())
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

fn is_raw_format(fmt: Option<&str>) -> bool {
    fmt.map(|f| f.contains("RGB") || f.contains("GBR")).unwrap_or(false)
}

fn map_vs_to_ffmpeg(fmt: Option<&str>) -> String {
    match fmt {
        Some("RGB24") => "gbrp".to_string(),
        Some("RGB48") => "gbrp16le".to_string(),
        Some("RGBS") => "gbrpf32le".to_string(),
        Some("RGBH") => "gbrpf16le".to_string(),
        _ => "gbrp".to_string(),
    }
}

fn build_ffmpeg_args(
    input: &PathBuf,
    output: &PathBuf,
    info: &OutputInfo,
    is_raw: bool,
    pix_fmt: &str,
    preview_mode: bool,
    segment: Option<&SegmentSelection>,
    fps: Option<f64>,
    ffmpeg_args_str: &str,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();

    if is_raw {
        args.push("-f".into()); args.push("rawvideo".into());
        args.push("-pix_fmt".into()); args.push(pix_fmt.to_string());
        if let Some(res) = &info.resolution {
            args.push("-s".into()); args.push(res.clone());
        }
        if let Some(fstr) = &info.fps_string {
            args.push("-r".into()); args.push(fstr.clone());
        } else if let Some(f) = info.fps {
            args.push("-r".into()); args.push(format!("{}", f));
        }
    } else {
        args.push("-f".into()); args.push("yuv4mpegpipe".into());
    }

    args.push("-i".into()); args.push("pipe:0".into());

    // Audio segment trimming
    if let (Some(seg), Some(fps_val)) = (segment, fps) {
        if seg.enabled && fps_val > 0.0 {
            let start_time = seg.start_frame as f64 / fps_val;
            args.push("-ss".into()); args.push(format!("{:.6}", start_time));
            if seg.end_frame > 0 {
                let end_time = seg.end_frame as f64 / fps_val;
                let duration = end_time - start_time;
                args.push("-t".into()); args.push(format!("{:.6}", duration));
            }
        }
    }

    args.push("-i".into()); args.push(input.to_string_lossy().into_owned());

    // Video map
    args.push("-map".into()); args.push("0:v:0".into());
    // Audio
    args.push("-map".into()); args.push("1:a?".into());
    args.push("-c:a".into()); args.push("copy".into());
    // Subtitles (skip in preview mode — MP4 doesn't support SRT)
    if !preview_mode {
        args.push("-map".into()); args.push("1:s?".into());
        args.push("-c:s".into()); args.push("copy".into());
    }

    // Video encoding settings from user config
    let user_args: Vec<&str> = ffmpeg_args_str.split_whitespace().filter(|a| !a.is_empty()).collect();
    for arg in &user_args {
        args.push(arg.to_string());
    }

    // Output
    args.push("-y".into());
    args.push(output.to_string_lossy().into_owned());

    // Force stats output to stderr even when stderr is piped
    args.push("-stats".into());

    // Preview output: JPEG frames to stdout
    args.push("-map".into()); args.push("0:v:0".into());
    args.push("-vf".into()); args.push("fps=1,scale=-2:720".into());
    args.push("-f".into()); args.push("image2pipe".into());
    args.push("-c:v".into()); args.push("mjpeg".into());
    args.push("-pix_fmt".into()); args.push("yuvj422p".into());
    args.push("-q:v".into()); args.push("1".into());
    args.push("pipe:1".into());

    args
}

fn parse_ffmpeg_progress(line: &str) -> Option<(u64, Option<f64>)> {
    let trimmed = line.trim();

    // vspipe format: "Frame: 100/1000" or "Frame: 100" printed to stderr
    if let Some(rest) = trimmed.strip_prefix("Frame:") {
        let rest = rest.trim();
        if let Some((current, _total)) = rest.split_once('/') {
            if let Ok(frame) = current.trim().parse::<u64>() {
                return Some((frame, None));
            }
        } else if let Ok(frame) = rest.parse::<u64>() {
            return Some((frame, None));
        } else {
            // Handles variants like "Frame: 123 (something...)"
            let value: String = rest
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if let Ok(frame) = value.parse::<u64>() {
                return Some((frame, None));
            }
        }
    }

    // ffmpeg format: "frame=  662 fps=187 q=24.0 ..."
    let lower = trimmed.to_ascii_lowercase();
    let frame_match = regex_capture(&lower, "frame=")?;
    let fps_match = regex_capture(&lower, "fps=").unwrap_or_else(|| "0".to_string());
    let frame: u64 = frame_match.parse().ok()?;
    let fps: f64 = fps_match.parse().unwrap_or(0.0);
    Some((frame, Some(fps)))
}

/// Minimal key=value capture: given `"frame=  662 fps=187"` and key `"frame="`,
/// returns `"662"`.  `key` must include the trailing `=`.
fn regex_capture(input: &str, key: &str) -> Option<String> {
    let idx = input.find(key)?;
    let rest = &input[idx + key.len()..]; // after "key="
    let value: String = rest.trim_start().chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    if value.is_empty() { None } else { Some(value) }
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn extract_error_from_stderr(stderr: &str) -> String {
    // Try to find the last meaningful error line
    let lines: Vec<&str> = stderr.lines().collect();
    for line in lines.iter().rev() {
        let l = line.trim();
        if l.starts_with("Error") || l.starts_with("VapourSynthError") || l.contains("Error:") {
            return l.to_string();
        }
    }
    stderr.lines().last().unwrap_or("Unknown error").trim().to_string()
}
