// src-tauri/src/lib.rs
use std::sync::Mutex;
use tauri::Manager;

pub mod commands;
pub mod config_manager;
pub mod dependency_manager;
pub mod ffmpeg_manager;
pub mod model_extractor;
pub mod model_validator;
pub mod paths;
pub mod plugin_installer;
pub mod script_generator;
pub mod template_manager;
pub mod update_checker;
pub mod upscale_executor;
pub mod utils;
pub mod vs_view_manager;
pub mod vsmlrt_manager;

use commands::upscale::UpscaleState;

/// Global application state shared across all Tauri commands
pub struct AppState {
    pub config: Mutex<config_manager::ConfigManager>,
    pub template_manager: Mutex<template_manager::TemplateManager>,
    pub script_generator: Mutex<script_generator::VapourSynthScriptGenerator>,
    pub upscale_state: Mutex<UpscaleState>,
    /// Cache for log file read position (for efficient tail reading)
    pub log_read_cache: Mutex<LogReadCache>,
}

pub struct LogReadCache {
    pub last_size: u64,
}

impl AppState {
    pub fn new() -> Self {
        AppState {
            config: Mutex::new(config_manager::ConfigManager::new()),
            template_manager: Mutex::new(template_manager::TemplateManager::new()),
            script_generator: Mutex::new(script_generator::VapourSynthScriptGenerator::new()),
            upscale_state: Mutex::new(UpscaleState::new()),
            log_read_cache: Mutex::new(LogReadCache { last_size: 0 }),
        }
    }
}

/// Ensure bundled files (VapourSynth template, filter templates) are present in
/// the user config directory.  This runs on every startup so that dev-mode and
/// upgrade-in-place scenarios always have the latest template.
async fn ensure_bundled_files(resource_dir: &std::path::PathBuf) -> anyhow::Result<()> {
    use anyhow::Context;

    let config = paths::config_dir();
    tokio::fs::create_dir_all(&config).await
        .context("create config dir")?;

    // VapourSynth template — always overwrite (matches Electron updateBundledFiles)
    let include_root = paths::resolve_include(resource_dir, "");
    let src = include_root.join("vapoursynth_template.vpy");
    let dst = config.join("vapoursynth_template.vpy");
    if src.exists() {
        tokio::fs::copy(&src, &dst).await
            .context("copy VapourSynth template")?;
        log::info!("Ensured VapourSynth template at {}", dst.display());
    } else {
        log::warn!(
            "Bundled VapourSynth template not found at {} — cannot copy to config dir",
            src.display()
        );
    }

    // Filter templates — copy new ones only (preserve user edits)
    let bundled_ft = paths::resolve_include(resource_dir, "filter_templates");
    let user_ft = paths::filter_templates();
    tokio::fs::create_dir_all(&user_ft).await.ok();
    if bundled_ft.exists() {
        let mut entries = tokio::fs::read_dir(&bundled_ft).await?;
        while let Some(entry) = entries.next_entry().await? {
            let s = entry.path();
            if s.extension().map(|e| e == "vkfilter").unwrap_or(false) {
                let d = user_ft.join(s.file_name().unwrap());
                if !d.exists() {
                    tokio::fs::copy(&s, &d).await.ok();
                }
            }
        }
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_http::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .register_uri_scheme_protocol("video", |_ctx, request| {
            use tauri::http::{Response, header};

            // Parse the video path from the URL
            // URL format: video://localhost/C:/path/to/video.mp4
            // or video://C:/path/to/video.mp4
            let url = request.uri().to_string();
            let video_path = url
                .strip_prefix("video://localhost/")
                .or_else(|| url.strip_prefix("video://"))
                .unwrap_or("")
                .split('?')
                .next()
                .unwrap_or("");

            // URL-decode the path
            let video_path = urlencoding::decode(video_path)
                .unwrap_or_else(|_| video_path.into())
                .into_owned();

            let path = std::path::PathBuf::from(&video_path);
            if !path.exists() {
                return Response::builder()
                    .status(404)
                    .body(Vec::new())
                    .unwrap();
            }

            // Determine content type from extension
            let content_type = match path.extension().and_then(|e| e.to_str()) {
                Some("mp4") => "video/mp4",
                Some("mkv") => "video/x-matroska",
                Some("webm") => "video/webm",
                Some("avi") => "video/x-msvideo",
                Some("mov") => "video/quicktime",
                _ => "application/octet-stream",
            };

            // Read the file
            match std::fs::read(&path) {
                Ok(data) => {
                    Response::builder()
                        .status(200)
                        .header(header::CONTENT_TYPE, content_type)
                        .header(header::CONTENT_LENGTH, data.len())
                        .body(data)
                        .unwrap()
                }
                Err(_) => {
                    Response::builder()
                        .status(500)
                        .body(Vec::new())
                        .unwrap()
                }
            }
        })
        .setup(|app| {
            let state = AppState::new();
            app.manage(state);

            // Initialize paths now that we have the app handle
            let app_handle = app.handle().clone();

            // Initialize portable data path (exe-adjacent data/ folder)
            if let Ok(exe) = std::env::current_exe() {
                if let Some(exe_dir) = exe.parent() {
                    paths::init_app_data_path(exe_dir.to_path_buf());
                }
            }

            // Load config asynchronously
            tauri::async_runtime::spawn(async move {
                let resource_dir = app_handle
                    .path()
                    .resource_dir()
                    .unwrap_or_default();
                let state = app_handle.state::<AppState>();

                // Always ensure bundled files (template, filter templates) are
                // copied into the user config dir.  This mirrors the Electron
                // `updateBundledFiles()` call and is critical for dev mode where
                // the exe-adjacent data/ folder may exist but lack the template.
                if let Err(e) = ensure_bundled_files(&resource_dir).await {
                    log::error!("Failed to ensure bundled files: {:#}", e);
                }

                // Load into a fresh instance — no MutexGuard held across await.
                let mut new_cfg = config_manager::ConfigManager::new();
                if let Err(e) = new_cfg.load(&resource_dir).await {
                    log::error!("Failed to load config: {}", e);
                } else {
                    *state.config.lock().unwrap() = new_cfg;
                    log::info!("Config loaded successfully");
                }

                // TemplateManager is stateless — no need to touch the mutex.
                let mut tmgr = template_manager::TemplateManager::new();
                if let Err(e) = tmgr.create_default_templates().await {
                    log::error!("Failed to create default templates: {}", e);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Dialog commands
            commands::dialog::select_video_file,
            commands::dialog::select_onnx_file,
            commands::dialog::select_template_file,
            commands::dialog::select_output_file,
            commands::dialog::select_folder,
            commands::dialog::select_workflow_file,
            commands::dialog::open_output_folder,
            commands::dialog::open_logs_folder,
            commands::dialog::open_config_folder,
            commands::dialog::open_vs_plugins_folder,
            commands::dialog::open_vs_scripts_folder,
            commands::dialog::open_external,
            // Video commands (compare / preview — live in video.rs)
            commands::video::compare_videos,
            commands::video::launch_vse_previewer,
            // Config commands
            commands::config::get_colorimetry_settings,
            commands::config::set_colorimetry_settings,
            commands::config::get_panel_sizes,
            commands::config::set_panel_sizes,
            commands::config::get_show_queue,
            commands::config::set_show_queue,
            commands::config::get_filter_configurations,
            commands::config::set_filter_configurations,
            commands::config::get_ffmpeg_args,
            commands::config::set_ffmpeg_args,
            commands::config::get_default_ffmpeg_args,
            commands::config::get_video_filter,
            commands::config::set_video_filter,
            commands::config::get_output_format,
            commands::config::set_output_format,
            commands::config::get_processing_format,
            commands::config::set_processing_format,
            commands::config::get_video_compare_args,
            commands::config::set_video_compare_args,
            commands::config::get_default_video_compare_args,
            commands::config::get_default_output_folder,
            commands::config::set_default_output_folder,
            commands::config::get_encoding_settings_expanded,
            commands::config::set_encoding_settings_expanded,
            commands::config::get_version,
            commands::config::read_log_tail,
            commands::config::reset_log_cache,
            commands::config::reload_backend,
            // Video commands
            commands::video::get_video_info,
            commands::video::read_video_file,
            commands::video::get_video_thumbnail,
            commands::video::get_video_frame_at,
            commands::video::get_output_resolution,
            commands::video::cancel_validation,
            commands::video::start_upscale,
            commands::video::preview_segment,
            commands::video::cancel_upscale,
            commands::video::kill_upscale,
            // Model commands
            commands::model::get_available_models,
            commands::model::get_uninitialized_models,
            commands::model::initialize_model,
            commands::model::import_custom_model,
            commands::model::get_model_metadata,
            commands::model::update_model_metadata,
            commands::model::delete_model,
            commands::model::cancel_model_import,
            commands::model::force_stop_model_import,
            commands::model::validate_onnx_model,
            commands::model::get_model_categories,
            commands::model::update_model_category,
            // Dependency commands
            commands::dependency::check_dependencies,
            commands::dependency::detect_cuda_support,
            commands::dependency::setup_dependencies,
            commands::dependency::install_plugin_dependencies,
            commands::dependency::uninstall_plugin_dependencies,
            commands::dependency::check_plugin_dependencies,
            commands::dependency::cancel_plugin_dependency_install,
            // Queue commands
            commands::queue::get_queue,
            commands::queue::save_queue,
            commands::queue::clear_queue,
            // Template commands
            commands::template::get_filter_templates,
            commands::template::save_filter_template,
            commands::template::delete_filter_template,
            commands::template::read_template_file,
            commands::template::import_template_file,
            // Update commands
            commands::update::check_for_updates,
            commands::update::open_releases_page,
            commands::update::open_release_url,
            // Workflow commands
            commands::workflow::export_workflow,
            commands::workflow::import_workflow,
            // Misc commands
            commands::misc::file_exists,
            commands::misc::check_vsmlrt_version,
            commands::misc::clear_engine_files,
            commands::misc::update_vsmlrt_version,
            commands::misc::update_vsmlrt_plugin,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
