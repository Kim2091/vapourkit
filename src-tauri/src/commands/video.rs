// src-tauri/src/commands/video.rs
//
// Tauri commands for video information, thumbnails, and orchestrated upscaling.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};

use crate::paths;
use crate::script_generator::{ScriptConfig, extract_model_id};
use crate::upscale_executor::{self, SegmentSelection};
use crate::AppState;

// ──────────────────────────────────────────────────────────────
// get-video-info
// ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_video_info(file_path: String) -> Result<serde_json::Value, String> {
    let path = PathBuf::from(&file_path);

    if !path.exists() {
        return Err(format!("File not found: {}", file_path));
    }

    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|e| e.to_string())?;
    let size = meta.len();
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    // Use ffprobe to get video metadata
    let probe = run_ffprobe_json(&file_path).await;

    let (resolution, fps, pixel_format, codec, container, duration, frame_count) =
        parse_ffprobe_output(probe);

    // If ffprobe didn't return a frame count (common for MKV and other containers),
    // fall back to BestSource via VapourSynth for an accurate count.
    let frame_count = match frame_count {
        Some(fc) => Some(fc),
        None => get_frame_count_via_bestsource(&file_path).await,
    };

    log::info!(
        "Video info: {} size={} res={:?} fps={:?} frames={:?}",
        name,
        size,
        resolution,
        fps,
        frame_count,
    );

    Ok(serde_json::json!({
        "path": file_path,
        "name": name,
        "size": size,
        "sizeFormatted": crate::utils::format_bytes(size),
        "resolution": resolution,
        "fps": fps,
        "pixelFormat": pixel_format,
        "codec": codec,
        "container": container,
        "scanType": null,
        "colorSpace": null,
        "duration": duration,
        "frameCount": frame_count,
    }))
}

/// Get the exact frame count using BestSource via VapourSynth (fallback for containers
/// like MKV where ffprobe returns "N/A" for nb_frames).
async fn get_frame_count_via_bestsource(file_path: &str) -> Option<u64> {
    let vspipe = paths::vs().join("vspipe.exe");
    if !vspipe.exists() {
        log::warn!("vspipe not available for BestSource frame count");
        return None;
    }

    let bestsource = paths::plugins().join("bestsource.dll");
    if !bestsource.exists() {
        log::warn!("BestSource plugin not available for frame count extraction");
        return None;
    }

    // Create a temporary VapourSynth script
    let temp_dir = std::env::temp_dir().join("vapourkit_framecount");
    let _ = tokio::fs::create_dir_all(&temp_dir).await;

    let script_path = temp_dir.join(format!(
        "framecount_{}.vpy",
        chrono::Utc::now().timestamp_millis()
    ));
    let escaped_path = file_path.replace('\\', "\\\\");

    let script = format!(
        r#"import vapoursynth as vs
core = vs.core

# Load video with BestSource
clip = core.bs.VideoSource(source="{}", cachemode=0)

# Set output
clip.set_output()
"#,
        escaped_path
    );

    if tokio::fs::write(&script_path, &script).await.is_err() {
        return None;
    }

    let env = crate::utils::vs_environment();
    let vs_dir = paths::vs();

    let result = crate::utils::run_command(
        vspipe.to_str().unwrap(),
        &["-i", script_path.to_str().unwrap(), "-"],
        Some(&vs_dir),
        Some(&env),
    )
    .await;

    // Cleanup
    let _ = tokio::fs::remove_file(&script_path).await;

    match result {
        Ok(out) => {
            let combined = format!("{}\n{}", out.stdout, out.stderr);
            for line in combined.lines() {
                let trimmed = line.trim();
                if let Some(rest) = trimmed.strip_prefix("Frames:") {
                    if let Ok(n) = rest.trim().parse::<u64>() {
                        log::info!("BestSource detected {} frames", n);
                        return Some(n);
                    }
                }
            }
            log::warn!("Could not parse frame count from BestSource vspipe output");
            None
        }
        Err(e) => {
            log::warn!("BestSource frame count failed: {}", e);
            None
        }
    }
}

async fn run_ffprobe_json(file_path: &str) -> serde_json::Value {
    let ffprobe = paths::ffprobe();
    if !ffprobe.exists() {
        return serde_json::Value::Null;
    }

    let result = crate::utils::run_command(
        ffprobe.to_str().unwrap(),
        &[
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
            file_path,
        ],
        None,
        None,
    )
    .await;

    match result {
        Ok(out) => serde_json::from_str(&out.stdout).unwrap_or(serde_json::Value::Null),
        Err(_) => serde_json::Value::Null,
    }
}

fn parse_ffprobe_output(
    probe: serde_json::Value,
) -> (
    Option<String>,
    Option<f64>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<f64>,
    Option<u64>,
) {
    let streams = probe["streams"].as_array();
    let format = &probe["format"];

    let mut resolution: Option<String> = None;
    let mut fps: Option<f64> = None;
    let mut pixel_format: Option<String> = None;
    let mut codec: Option<String> = None;
    let mut frame_count: Option<u64> = None;

    if let Some(streams) = streams {
        for stream in streams {
            if stream["codec_type"].as_str() == Some("video") {
                let w = stream["width"].as_u64();
                let h = stream["height"].as_u64();
                if let (Some(w), Some(h)) = (w, h) {
                    resolution = Some(format!("{}x{}", w, h));
                }

                // Parse FPS from r_frame_rate "24000/1001"
                if let Some(rfr) = stream["r_frame_rate"].as_str() {
                    fps = parse_fraction(rfr);
                }

                if let Some(pf) = stream["pix_fmt"].as_str() {
                    pixel_format = Some(pf.to_string());
                }

                if let Some(cn) = stream["codec_name"].as_str() {
                    codec = Some(cn.to_string());
                }

                if let Some(fc) = stream["nb_frames"].as_str() {
                    frame_count = fc.parse().ok();
                }

                break;
            }
        }
    }

    let container = format["format_name"].as_str().map(|s| s.to_string());
    let duration = format["duration"]
        .as_str()
        .and_then(|d| d.parse::<f64>().ok());

    (resolution, fps, pixel_format, codec, container, duration, frame_count)
}

fn parse_fraction(frac: &str) -> Option<f64> {
    if let Some((n, d)) = frac.split_once('/') {
        let n: f64 = n.trim().parse().ok()?;
        let d: f64 = d.trim().parse().ok()?;
        if d == 0.0 {
            return None;
        }
        Some(n / d)
    } else {
        frac.parse().ok()
    }
}

// ──────────────────────────────────────────────────────────────
// read-video-file
// ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn read_video_file(file_path: String) -> Result<Vec<u8>, String> {
    tokio::fs::read(&file_path)
        .await
        .map_err(|e| e.to_string())
}

// ──────────────────────────────────────────────────────────────
// get-video-thumbnail
// ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_video_thumbnail(video_path: String) -> Result<Option<String>, String> {
    let ffmpeg = paths::ffmpeg();
    if !ffmpeg.exists() {
        return Ok(None);
    }

    let path = PathBuf::from(&video_path);
    if !path.exists() {
        return Ok(None);
    }

    // Create a deterministic cache path from video path hash
    let hash = format!("{:x}", md5_hash(&video_path));
    let thumb_dir = std::env::temp_dir().join("vapourkit_thumbnails");
    tokio::fs::create_dir_all(&thumb_dir)
        .await
        .map_err(|e| e.to_string())?;
    let thumb_path = thumb_dir.join(format!("{}.jpg", hash));

    if thumb_path.exists() {
        let data = tokio::fs::read(&thumb_path)
            .await
            .map_err(|e| e.to_string())?;
        return Ok(Some(format!(
            "data:image/jpeg;base64,{}",
            STANDARD.encode(&data)
        )));
    }

    // Try to extract embedded thumbnail first
    let thumb_str = thumb_path.to_string_lossy().into_owned();
    let embedded = crate::utils::run_command(
        ffmpeg.to_str().unwrap(),
        &[
            "-i", &video_path,
            "-map", "0:v:0",
            "-map_metadata", "0",
            "-frames:v", "1",
            "-q:v", "1",
            "-y",
            &thumb_str,
        ],
        None,
        None,
    )
    .await;

    // If embedded extraction failed, generate from video content
    if embedded.is_err() || !thumb_path.exists() {
        let _ = crate::utils::run_command(
            ffmpeg.to_str().unwrap(),
            &[
                "-i", &video_path,
                "-ss", "5",
                "-frames:v", "1",
                "-vf", "scale=-2:480",
                "-q:v", "2",
                "-y",
                &thumb_str,
            ],
            None,
            None,
        )
        .await;
    }

    if thumb_path.exists() {
        let data = tokio::fs::read(&thumb_path)
            .await
            .map_err(|e| e.to_string())?;
        Ok(Some(format!(
            "data:image/jpeg;base64,{}",
            STANDARD.encode(&data)
        )))
    } else {
        Ok(None)
    }
}

fn md5_hash(s: &str) -> u64 {
    // Simple non-cryptographic hash for cache key
    use std::hash::Hash;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    std::hash::Hasher::finish(&h)
}

// ──────────────────────────────────────────────────────────────
// get-video-frame-at
// ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_video_frame_at(
    video_path: String,
    frame_number: u64,
    fps: f64,
) -> Result<Option<String>, String> {
    let ffmpeg = paths::ffmpeg();
    if !ffmpeg.exists() {
        return Ok(None);
    }

    let time = if fps > 0.0 {
        format!("{:.6}", frame_number as f64 / fps)
    } else {
        "0".to_string()
    };

    let frame_dir = std::env::temp_dir().join("vapourkit_frames");
    tokio::fs::create_dir_all(&frame_dir)
        .await
        .map_err(|e| e.to_string())?;
    let frame_path = frame_dir.join(format!("frame_{}.jpg", frame_number));
    let frame_str = frame_path.to_string_lossy().into_owned();

    crate::utils::run_command(
        ffmpeg.to_str().unwrap(),
        &[
            "-ss", &time,
            "-i", &video_path,
            "-frames:v", "1",
            "-vf", "scale=-2:480",
            "-q:v", "2",
            "-y",
            &frame_str,
        ],
        None,
        None,
    )
    .await
    .map_err(|e| e.to_string())?;

    if frame_path.exists() {
        let data = tokio::fs::read(&frame_path)
            .await
            .map_err(|e| e.to_string())?;
        Ok(Some(format!(
            "data:image/jpeg;base64,{}",
            STANDARD.encode(&data)
        )))
    } else {
        Ok(None)
    }
}

// ──────────────────────────────────────────────────────────────
// get-output-resolution (delegates to upscale_executor)
// ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_output_resolution(
    state: State<'_, AppState>,
    video_path: String,
    model_path: Option<String>,
    use_direct_ml: Option<bool>,
    upscaling_enabled: Option<bool>,
    filters: Option<Vec<serde_json::Value>>,
    upscale_position: Option<u32>,
    num_streams: Option<u32>,
    source_fps: Option<f64>,
) -> Result<serde_json::Value, String> {
    // Generate a validation script and run vspipe --info
    let config = {
        let cfg = state.config.lock().unwrap();
        build_script_config(
            &video_path,
            model_path.as_deref(),
            use_direct_ml.unwrap_or(false),
            upscaling_enabled.unwrap_or(true),
            filters.as_deref(),
            num_streams.unwrap_or(2),
            None,
            true, // validation mode
            source_fps,
            &cfg,
        )
    };

    let cfg_clone = state.config.lock().unwrap().clone();
    let script_path = crate::script_generator::VapourSynthScriptGenerator
        .generate_script(&config, &cfg_clone)
        .await
        .map_err(|e| e.to_string())?;

    let info = upscale_executor::get_output_info(&script_path)
        .await
        .unwrap_or(upscale_executor::OutputInfo {
            resolution: None,
            fps: None,
            fps_string: None,
            pixel_format: None,
            error: None,
        });

    // Cleanup temp script
    let _ = tokio::fs::remove_file(&script_path).await;

    Ok(serde_json::json!({
        "resolution": info.resolution,
        "fps": info.fps,
        "pixelFormat": info.pixel_format,
        "codec": "H.264",
        "scanType": "Progressive",
        "error": info.error
    }))
}

/// Cancel ongoing validation process
#[tauri::command]
pub async fn cancel_validation(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let s = state.upscale_state.lock().unwrap();
    s.cancel();
    Ok(serde_json::json!({ "success": true, "cancelled": true }))
}

// ──────────────────────────────────────────────────────────────
// start-upscale (full pipeline, generates script first)
// ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn start_upscale(
    app: AppHandle,
    state: State<'_, AppState>,
    video_path: String,
    model_path: Option<String>,
    output_path: String,
    use_direct_ml: Option<bool>,
    upscaling_enabled: Option<bool>,
    filters: Option<Vec<serde_json::Value>>,
    upscale_position: Option<u32>,
    num_streams: Option<u32>,
    segment: Option<SegmentSelection>,
) -> Result<serde_json::Value, String> {
    use std::sync::Arc;

    // Build script
    let config = {
        let cfg = state.config.lock().unwrap();
        build_script_config(
            &video_path,
            model_path.as_deref(),
            use_direct_ml.unwrap_or(false),
            upscaling_enabled.unwrap_or(true),
            filters.as_deref(),
            num_streams.unwrap_or(2),
            segment.as_ref(),
            false,
            None,
            &cfg,
        )
    };

    let cfg_clone = state.config.lock().unwrap().clone();
    let script_path = crate::script_generator::VapourSynthScriptGenerator
        .generate_script(&config, &cfg_clone)
        .await
        .map_err(|e| e.to_string())?;

    // Get video FPS for audio trimming
    let fps: f64 = {
        let probe = run_ffprobe_json(&video_path).await;
        let (_, f, _, _, _, _, _) = parse_ffprobe_output(probe);
        f.unwrap_or(24.0)
    };

    // Get frame count
    let total_frames = upscale_executor::get_frame_count(&script_path)
        .await
        .unwrap_or(0);

    // Get user-configured FFmpeg args
    let ffmpeg_args_str = {
        let cfg = state.config.lock().unwrap();
        cfg.get_ffmpeg_args().to_string()
    };

    // Execute
    let upscale_state = {
        let s = state.upscale_state.lock().unwrap();
        Arc::new(crate::upscale_executor::UpscaleState {
            cancel_flag: s.cancel_flag.clone(),
            kill_flag: s.kill_flag.clone(),
            vspipe_pid: s.vspipe_pid.clone(),
            ffmpeg_pid: s.ffmpeg_pid.clone(),
            model_cancel_flag: None,
            trtexec_pid: None,
        })
    };
    upscale_state.reset();

    let out = output_path.clone();
    let sp = script_path.clone();
    let vp = video_path.clone();
    let app_clone = app.clone();
    let us = upscale_state.clone();

    let result = upscale_executor::execute(
        sp.into(),
        out.into(),
        vp.into(),
        total_frames,
        false,
        segment,
        Some(fps),
        us,
        ffmpeg_args_str,
        move |progress| {
            let _ = app_clone.emit("upscale-progress", &progress);
        },
    )
    .await;

    // Cleanup temp script
    let _ = tokio::fs::remove_file(&script_path).await;

    match result {
        Ok(()) => Ok(serde_json::json!({ "success": true, "outputPath": output_path })),
        Err(e) => {
            let msg = e.to_string();
            log::error!("Upscale error: {}", msg);
            let _ = app.emit(
                "upscale-progress",
                serde_json::json!({
                    "type": "error",
                    "currentFrame": 0,
                    "totalFrames": total_frames,
                    "fps": 0,
                    "percentage": 0,
                    "message": msg
                }),
            );
            Ok(serde_json::json!({ "success": false, "error": msg }))
        }
    }
}

/// Cancel upscale
#[tauri::command]
pub async fn cancel_upscale(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let s = state.upscale_state.lock().unwrap();
    s.cancel();
    Ok(serde_json::json!({ "success": true }))
}

/// Force kill upscale
#[tauri::command]
pub async fn kill_upscale(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let s = state.upscale_state.lock().unwrap();
    s.kill();
    Ok(serde_json::json!({ "success": true }))
}

// ──────────────────────────────────────────────────────────────
// preview-segment
// ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn preview_segment(
    app: AppHandle,
    state: State<'_, AppState>,
    video_path: String,
    model_path: Option<String>,
    use_direct_ml: Option<bool>,
    upscaling_enabled: Option<bool>,
    filters: Option<Vec<serde_json::Value>>,
    num_streams: Option<u32>,
    start_frame: Option<u32>,
    end_frame: Option<i64>,
) -> Result<serde_json::Value, String> {
    use std::sync::Arc;

    let segment = SegmentSelection {
        enabled: true,
        start_frame: start_frame.unwrap_or(0),
        end_frame: end_frame.unwrap_or(-1),
    };

    let config = {
        let cfg = state.config.lock().unwrap();
        build_script_config(
            &video_path,
            model_path.as_deref(),
            use_direct_ml.unwrap_or(false),
            upscaling_enabled.unwrap_or(true),
            filters.as_deref(),
            num_streams.unwrap_or(2),
            Some(&segment),
            false,
            None,
            &cfg,
        )
    };

    let cfg_clone = state.config.lock().unwrap().clone();
    let script_path = crate::script_generator::VapourSynthScriptGenerator
        .generate_script(&config, &cfg_clone)
        .await
        .map_err(|e| e.to_string())?;

    let preview_path = std::env::temp_dir()
        .join(format!("vapourkit_preview_{}.mkv", chrono::Utc::now().timestamp_millis()));

    let fps: f64 = {
        let probe = run_ffprobe_json(&video_path).await;
        let (_, f, _, _, _, _, _) = parse_ffprobe_output(probe);
        f.unwrap_or(24.0)
    };

    let total = upscale_executor::get_frame_count(&script_path)
        .await
        .unwrap_or(0);

    let upscale_state = {
        let s = state.upscale_state.lock().unwrap();
        Arc::new(crate::upscale_executor::UpscaleState {
            cancel_flag: s.cancel_flag.clone(),
            kill_flag: s.kill_flag.clone(),
            vspipe_pid: s.vspipe_pid.clone(),
            ffmpeg_pid: s.ffmpeg_pid.clone(),
            model_cancel_flag: None,
            trtexec_pid: None,
        })
    };
    upscale_state.reset();

    // Get user-configured FFmpeg args for preview
    let ffmpeg_args_str = {
        let cfg = state.config.lock().unwrap();
        cfg.get_ffmpeg_args().to_string()
    };

    let preview_str = preview_path.to_string_lossy().into_owned();
    let sp = script_path.clone();
    let vp = video_path.clone();
    let app_clone = app.clone();

    let result = upscale_executor::execute(
        sp.into(),
        preview_path.clone(),
        vp.into(),
        total,
        true,
        Some(segment),
        Some(fps),
        upscale_state,
        ffmpeg_args_str,
        move |progress| {
            let _ = app_clone.emit("upscale-progress", &progress);
        },
    )
    .await;

    let _ = tokio::fs::remove_file(&script_path).await;

    match result {
        Ok(()) => Ok(serde_json::json!({ "success": true, "previewPath": preview_str })),
        Err(e) => Ok(serde_json::json!({ "success": false, "error": e.to_string() })),
    }
}

// ──────────────────────────────────────────────────────────────
// compare_videos / launch_vse_previewer
// ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn compare_videos(
    state: State<'_, AppState>,
    input_path: String,
    output_path: String,
) -> Result<serde_json::Value, String> {
    let compare_args = {
        let cfg = state.config.lock().unwrap();
        cfg.get_video_compare_args().to_string()
    };
    crate::vs_view_manager::launch_video_compare(&input_path.into(), &output_path.into(), &compare_args)
        .await
        .map(|_| serde_json::json!({ "success": true }))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn launch_vse_previewer(
    state: State<'_, AppState>,
    video_path: String,
    model_path: Option<String>,
    use_direct_ml: Option<bool>,
    upscaling_enabled: Option<bool>,
    filters: Option<Vec<serde_json::Value>>,
    num_streams: Option<u32>,
    segment: Option<SegmentSelection>,
) -> Result<serde_json::Value, String> {
    let config = {
        let cfg = state.config.lock().unwrap();
        let mut sc = build_script_config(
            &video_path,
            model_path.as_deref(),
            use_direct_ml.unwrap_or(false),
            upscaling_enabled.unwrap_or(true),
            filters.as_deref(),
            num_streams.unwrap_or(2),
            segment.as_ref(),
            false,
            None,
            &cfg,
        );
        sc.generate_preview_outputs = true;
        sc
    };

    let cfg_clone = state.config.lock().unwrap().clone();
    let script_path = crate::script_generator::VapourSynthScriptGenerator
        .generate_script(&config, &cfg_clone)
        .await
        .map_err(|e| e.to_string())?;

    crate::vs_view_manager::launch_vse_previewer(Some(&script_path))
        .await
        .map(|_| serde_json::json!({ "success": true }))
        .map_err(|e| serde_json::json!({ "success": false, "error": e.to_string() }))
        .or_else(|v| Ok(v))
}

// ──────────────────────────────────────────────────────────────
// Helper: build ScriptConfig from frontend params
// ──────────────────────────────────────────────────────────────

fn build_script_config(
    video_path: &str,
    model_path: Option<&str>,
    use_direct_ml: bool,
    upscaling_enabled: bool,
    filters: Option<&[serde_json::Value]>,
    num_streams: u32,
    segment: Option<&SegmentSelection>,
    validation_mode: bool,
    source_fps: Option<f64>,
    cfg: &crate::config_manager::ConfigManager,
) -> ScriptConfig {
    let engine_path = paths::mlrt_plugin().to_string_lossy().into_owned();
    let plugins_path = paths::plugins().to_string_lossy().into_owned();

    // Determine model metadata from config — must use model ID (basename without
    // extension), not the full file path, because ConfigManager is keyed by ID.
    let model_id = model_path.map(|mp| extract_model_id(mp));
    let model_type = model_id.as_ref().map(|id| {
        let mt = cfg.get_model_type(id);
        format!("{:?}", mt).to_lowercase() // "Image" -> "image", "Vsr" -> "vsr"
    });
    let use_fp32 = model_id.as_ref().map(|id| cfg.is_model_fp32(id)).unwrap_or(false);

    let colorimetry = cfg.get_colorimetry_settings();
    // Convert ColorimetrySettings -> ColorimetryConfig via JSON (same fields)
    let colorimetry_cfg: Option<crate::script_generator::ColorimetryConfig> =
        serde_json::to_value(colorimetry)
            .ok()
            .and_then(|v| serde_json::from_value(v).ok());

    // Parse filters from JSON.  If model_path is set and there are no ai-model filters,
    // synthesise a default one so the script generator has something to work with.
    let mut parsed_filters: Vec<crate::script_generator::Filter> = filters
        .map(|fs| {
            fs.iter()
                .filter_map(|f| serde_json::from_value(f.clone()).ok())
                .collect()
        })
        .unwrap_or_default();

    if parsed_filters.is_empty() {
        if let Some(mp) = model_path {
            let mt = model_type.clone().unwrap_or_else(|| "image".to_string());
            parsed_filters.push(crate::script_generator::Filter {
                id: "default-upscale".to_string(),
                enabled: upscaling_enabled,
                filter_type: "aiModel".to_string(),
                preset: "default".to_string(),
                code: String::new(),
                order: 0,
                model_path: Some(mp.to_string()),
                model_type: Some(mt),
            });
        }
    }

    // Map segment
    let seg = segment.map(|s| crate::script_generator::SegmentSelection {
        enabled: s.enabled,
        start_frame: s.start_frame as i64,
        end_frame: s.end_frame,
    });

    // Get processing format from config, handling "match_input" like Electron does
    let processing_format = cfg.get_processing_format();
    let output_format = if processing_format == "match_input" {
        "original_clip.format.id".to_string()
    } else {
        processing_format.to_string()
    };

    ScriptConfig {
        input_video: video_path.to_string(),
        engine_path,
        plugins_path,
        output_path: None,
        use_direct_ml,
        use_fp32,
        model_type,
        upscaling_enabled,
        colorimetry: colorimetry_cfg,
        filters: parsed_filters,
        num_streams: Some(num_streams),
        output_format: Some(output_format),
        segment: seg,
        source_fps,
        validation_mode,
        generate_preview_outputs: false,
    }
}
