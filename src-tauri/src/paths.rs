// src-tauri/src/paths.rs
//
// Centralized path constants for all app data.
// In production the exe-adjacent `data/` folder is used (portable mode).
// In development the workspace root `data/` folder is used.

use std::path::PathBuf;
use once_cell::sync::OnceCell;

/// Current vs-mlrt TensorRT version
pub const VS_MLRT_VERSION: &str = "15.13";

static APP_DATA_PATH: OnceCell<PathBuf> = OnceCell::new();

/// Initialize the app data path.  Must be called once from `lib.rs` setup.
///
/// In production the exe-adjacent `data/` folder is used (portable mode).
/// In development (cargo run / tauri dev) the exe lives inside `target/debug/`
/// so we fall back to the workspace-root `data/` folder.
pub fn init_app_data_path(exe_dir: PathBuf) {
    let prod_data = exe_dir.join("data");
    let path = if prod_data.exists() {
        prod_data
    } else {
        // Dev mode: use workspace_root()/data
        let dev_data = workspace_root().join("data");
        log::info!(
            "exe-adjacent data/ not found ({}), using dev path: {}",
            prod_data.display(),
            dev_data.display()
        );
        dev_data
    };
    APP_DATA_PATH.set(path).ok(); // ignore if already set
}

pub fn app_data() -> PathBuf {
    APP_DATA_PATH
        .get()
        .cloned()
        .unwrap_or_else(|| {
            // Fallback: derive from current exe location
            std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|d| d.join("data")))
                .unwrap_or_else(|| PathBuf::from("data"))
        })
}

/// The workspace root directory (parent of `src-tauri/`).
/// Only meaningful in dev mode; used to locate the `include/` directory.
pub fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("CARGO_MANIFEST_DIR has no parent")
        .to_path_buf()
}

/// Resolve a bundled include path that works in both dev and production.
///
/// In dev mode the `include/` tree lives at `<workspace_root>/include/`.
/// In production Tauri bundles resources into `resource_dir/` with the
/// sub-path defined in `tauri.conf.json` resources mapping — the `include/`
/// prefix is stripped (e.g. `include/models/*.onnx` → `models/`).
///
/// `resource_dir` — the value returned by `app.path().resource_dir()`.
/// `sub_path`     — the sub-path relative to `include/`, e.g. `"models"`.
pub fn resolve_include(resource_dir: &PathBuf, sub_path: &str) -> PathBuf {
    // Dev mode: workspace_root/include/<sub_path>
    let dev_path = workspace_root().join("include").join(sub_path);
    if dev_path.exists() {
        log::info!("resolve_include (dev): {}", dev_path.display());
        return dev_path;
    }

    // Production: resource_dir/<sub_path>  (include/ prefix stripped by Tauri bundler)
    let prod_path = resource_dir.join(sub_path);
    if prod_path.exists() {
        log::info!("resolve_include (prod): {}", prod_path.display());
        return prod_path;
    }

    // Legacy fallback: resource_dir/include/<sub_path>
    let legacy_path = resource_dir.join("include").join(sub_path);
    log::warn!("resolve_include fallback: {}", legacy_path.display());
    legacy_path
}

pub fn vs() -> PathBuf {
    app_data().join("vapoursynth-portable")
}

pub fn plugins() -> PathBuf {
    vs().join("vs-plugins")
}

pub fn scripts() -> PathBuf {
    vs().join("vs-scripts")
}

pub fn mlrt_plugin() -> PathBuf {
    plugins().join("vsmlrt-cuda")
}

pub fn models() -> PathBuf {
    app_data().join("models")
}

pub fn models2() -> PathBuf {
    app_data().join("models2")
}

pub fn config_dir() -> PathBuf {
    app_data().join("config")
}

pub fn logs_dir() -> PathBuf {
    app_data().join("logs")
}

pub fn log_file() -> PathBuf {
    logs_dir().join("main.log")
}

pub fn filter_templates() -> PathBuf {
    config_dir().join("filter-templates")
}

pub fn pip_cache() -> PathBuf {
    app_data().join("pip-cache")
}

pub fn video_compare_dir() -> PathBuf {
    app_data().join("video-compare")
}

pub fn temp_dir() -> PathBuf {
    app_data().join("temp")
}

pub fn vse_previewer_dir() -> PathBuf {
    app_data().join("vse-previewer")
}

// Executables
pub fn vspipe() -> PathBuf {
    vs().join("vspipe.exe")
}

pub fn python() -> PathBuf {
    vs().join("python.exe")
}

pub fn trtexec() -> PathBuf {
    mlrt_plugin().join("trtexec.exe")
}

pub fn video_compare_exe() -> PathBuf {
    video_compare_dir().join("video-compare.exe")
}

// FFmpeg
pub fn ffmpeg_dir() -> PathBuf {
    app_data().join("ffmpeg")
}

pub fn ffmpeg() -> PathBuf {
    ffmpeg_dir().join("bin").join("ffmpeg.exe")
}

pub fn ffprobe() -> PathBuf {
    ffmpeg_dir().join("bin").join("ffprobe.exe")
}

// Config files
pub fn app_config_file() -> PathBuf {
    config_dir().join("app-config.json")
}

pub fn queue_file() -> PathBuf {
    config_dir().join("queue.json")
}

pub fn vapoursynth_template() -> PathBuf {
    config_dir().join("vapoursynth_template.vpy")
}

/// Alias for config_dir() used by various modules
pub fn config() -> PathBuf {
    config_dir()
}

/// Alias for video_compare_dir() used by dependency_manager
pub fn video_compare() -> PathBuf {
    video_compare_dir()
}

/// VSE Previewer executable path
pub fn vse_previewer_exe() -> PathBuf {
    vse_previewer_dir().join("vse-previewer.exe")
}

/// VSE Previewer config file path
pub fn vse_previewer_conf() -> PathBuf {
    vse_previewer_dir().join("vse-previewer.conf")
}

/// Ffmpeg manager helper — raw exe path
pub fn ffmpeg_settings_file() -> PathBuf {
    config_dir().join("ffmpeg_settings.json")
}
