// src-tauri/src/config_manager.rs
//
// Equivalent to electron/configManager.ts
// Manages persistent application configuration stored as JSON.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tokio::fs;

pub const DEFAULT_FFMPEG_ARGS: &str =
    "-c:v libx264 -preset medium -crf 18 -vf setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709 -map_metadata 1";

pub const DEFAULT_VIDEO_COMPARE_ARGS: &str = "-W";

// ─────────────────────────────────────────────────────────────────────────────
// Domain types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ColorimetrySettings {
    pub overwrite_matrix: bool,
    pub matrix709: bool,
    pub default_matrix: String,
    pub default_primaries: String,
    pub default_transfer: String,
}

impl Default for ColorimetrySettings {
    fn default() -> Self {
        ColorimetrySettings {
            overwrite_matrix: false,
            matrix709: false,
            default_matrix: "709".into(),
            default_primaries: "709".into(),
            default_transfer: "709".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelSizes {
    pub left_panel: f64,
    pub right_panel: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_panel: Option<f64>,
}

impl Default for PanelSizes {
    fn default() -> Self {
        PanelSizes {
            left_panel: 60.0,
            right_panel: 40.0,
            queue_panel: Some(25.0),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterConfig {
    pub id: String,
    pub enabled: bool,
    #[serde(default = "default_filter_type")]
    pub filter_type: String,
    pub preset: String,
    pub code: String,
    pub order: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<serde_json::Value>,
}

fn default_filter_type() -> String { "custom".to_string() }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ModelType {
    #[serde(rename = "vsr")]
    Vsr,
    #[serde(rename = "image")]
    Image,
}

impl Default for ModelType {
    fn default() -> Self { ModelType::Image }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelMetadata {
    pub use_fp32: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_bf16: Option<bool>,
    pub model_type: ModelType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temporal_frames: Option<u32>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_tag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default)]
    pub colorimetry: ColorimetrySettings,
    #[serde(default)]
    pub panel_sizes: PanelSizes,
    #[serde(default)]
    pub show_queue: bool,
    #[serde(default)]
    pub filter_configurations: Vec<FilterConfig>,
    #[serde(default)]
    pub upscale_position: i32,
    #[serde(default = "default_ffmpeg_args")]
    pub ffmpeg_args: String,
    #[serde(default = "default_processing_format")]
    pub processing_format: String,
    #[serde(default = "default_output_format")]
    pub output_format: String,
    #[serde(default = "default_video_compare_args")]
    pub video_compare_args: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_output_folder: Option<String>,
    #[serde(default)]
    pub encoding_settings_expanded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vs_mlrt_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_filter: Option<String>,
    #[serde(default)]
    pub models: HashMap<String, ModelMetadata>,
}

fn default_ffmpeg_args() -> String { DEFAULT_FFMPEG_ARGS.to_string() }
fn default_processing_format() -> String { "vs.YUV420P8".to_string() }
fn default_output_format() -> String { "mkv".to_string() }
fn default_video_compare_args() -> String { DEFAULT_VIDEO_COMPARE_ARGS.to_string() }

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            colorimetry: ColorimetrySettings::default(),
            panel_sizes: PanelSizes::default(),
            show_queue: false,
            filter_configurations: vec![],
            upscale_position: 0,
            ffmpeg_args: DEFAULT_FFMPEG_ARGS.to_string(),
            processing_format: "vs.YUV420P8".to_string(),
            output_format: "mkv".to_string(),
            video_compare_args: DEFAULT_VIDEO_COMPARE_ARGS.to_string(),
            default_output_folder: None,
            encoding_settings_expanded: false,
            vs_mlrt_version: None,
            app_version: None,
            video_filter: None,
            models: HashMap::new(),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ConfigManager
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct ConfigManager {
    config: AppConfig,
}

impl ConfigManager {
    pub fn new() -> Self {
        ConfigManager {
            config: AppConfig::default(),
        }
    }

    /// Load config from disk, merging with stock defaults.
    pub async fn load(&mut self, resource_dir: &PathBuf) -> Result<()> {
        let config_path = crate::paths::app_config_file();

        // Ensure the config directory exists
        if let Some(parent) = config_path.parent() {
            fs::create_dir_all(parent)
                .await
                .context("create config dir")?;
        }

        if config_path.exists() {
            let data = fs::read_to_string(&config_path)
                .await
                .context("read config")?;
            let user_config: serde_json::Value =
                serde_json::from_str(&data).context("parse config")?;
            self.config = self.migrate_config(user_config, resource_dir).await?;
        } else {
            // First run: copy stock config if available
            let stock_path = resolve_stock_config(resource_dir);
            if stock_path.exists() {
                let data = fs::read_to_string(&stock_path).await?;
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) {
                    self.config = self.migrate_config(v, resource_dir).await?;
                }
            }
            self.save().await?;
        }

        Ok(())
    }

    /// Merge user config JSON with defaults (stock config).
    async fn migrate_config(
        &self,
        user_value: serde_json::Value,
        resource_dir: &PathBuf,
    ) -> Result<AppConfig> {
        // Start with defaults
        let mut base = serde_json::to_value(AppConfig::default())?;

        // Merge stock config from resources if present
        let stock_path = resolve_stock_config(resource_dir);
        if stock_path.exists() {
            if let Ok(data) = fs::read_to_string(&stock_path).await {
                if let Ok(stock) = serde_json::from_str::<serde_json::Value>(&data) {
                    json_merge(&mut base, stock);
                }
            }
        }

        // Merge user config on top
        json_merge(&mut base, user_value);

        let config: AppConfig = serde_json::from_value(base).context("deserialize merged config")?;
        Ok(config)
    }

    /// Persist the current config to disk.
    pub async fn save(&self) -> Result<()> {
        let config_path = crate::paths::app_config_file();
        if let Some(parent) = config_path.parent() {
            fs::create_dir_all(parent).await?;
        }
        let json = serde_json::to_string_pretty(&self.config)?;
        fs::write(&config_path, json).await?;
        Ok(())
    }

    // ── Getters ────────────────────────────────────────────────────────────

    pub fn get_colorimetry_settings(&self) -> &ColorimetrySettings {
        &self.config.colorimetry
    }

    pub fn get_panel_sizes(&self) -> &PanelSizes {
        &self.config.panel_sizes
    }

    pub fn get_show_queue(&self) -> bool {
        self.config.show_queue
    }

    pub fn get_filter_configurations(&self) -> &Vec<FilterConfig> {
        &self.config.filter_configurations
    }

    pub fn get_ffmpeg_args(&self) -> &str {
        &self.config.ffmpeg_args
    }

    pub fn get_default_ffmpeg_args(&self) -> &str {
        DEFAULT_FFMPEG_ARGS
    }

    pub fn get_video_filter(&self) -> Option<&str> {
        self.config.video_filter.as_deref()
    }

    pub fn get_output_format(&self) -> &str {
        &self.config.output_format
    }

    pub fn get_processing_format(&self) -> &str {
        &self.config.processing_format
    }

    pub fn get_video_compare_args(&self) -> &str {
        &self.config.video_compare_args
    }

    pub fn get_default_video_compare_args(&self) -> &str {
        DEFAULT_VIDEO_COMPARE_ARGS
    }

    pub fn get_default_output_folder(&self) -> Option<&str> {
        self.config.default_output_folder.as_deref()
    }

    pub fn get_encoding_settings_expanded(&self) -> bool {
        self.config.encoding_settings_expanded
    }

    pub fn iter_models(&self) -> impl Iterator<Item = (&String, &ModelMetadata)> {
        self.config.models.iter()
    }

    pub fn get_model_metadata(&self, model_id: &str) -> Option<&ModelMetadata> {
        self.config.models.get(model_id)
    }

    pub fn is_model_fp32(&self, model_id: &str) -> bool {
        self.config.models.get(model_id).map(|m| m.use_fp32).unwrap_or(false)
    }

    pub fn get_model_type(&self, model_id: &str) -> ModelType {
        self.config
            .models
            .get(model_id)
            .map(|m| m.model_type.clone())
            .unwrap_or_default()
    }

    pub fn get_temporal_frames(&self, model_id: &str) -> u32 {
        self.config
            .models
            .get(model_id)
            .and_then(|m| m.temporal_frames)
            .unwrap_or(5)
    }

    pub fn get_vs_mlrt_version(&self) -> Option<&str> {
        self.config.vs_mlrt_version.as_deref()
    }

    // ── Setters ────────────────────────────────────────────────────────────
    // All setters are synchronous — they update in-memory state and write to
    // disk using blocking I/O (config file is small, so this is acceptable).

    fn save_blocking(&self) -> Result<()> {
        let config_path = crate::paths::app_config_file();
        if let Some(parent) = config_path.parent() {
            std::fs::create_dir_all(parent).context("create config dir")?;
        }
        let json = serde_json::to_string_pretty(&self.config).context("serialize config")?;
        std::fs::write(&config_path, json).context("write config")?;
        Ok(())
    }

    pub fn set_colorimetry_settings(&mut self, s: ColorimetrySettings) -> Result<()> {
        self.config.colorimetry = s;
        self.save_blocking()
    }

    pub fn set_panel_sizes(&mut self, s: PanelSizes) -> Result<()> {
        self.config.panel_sizes = s;
        self.save_blocking()
    }

    pub fn set_show_queue(&mut self, show: bool) -> Result<()> {
        self.config.show_queue = show;
        self.save_blocking()
    }

    pub fn set_filter_configurations(&mut self, filters: Vec<FilterConfig>) -> Result<()> {
        self.config.filter_configurations = filters;
        self.save_blocking()
    }

    pub fn set_ffmpeg_args(&mut self, args: String) -> Result<()> {
        self.config.ffmpeg_args = args;
        self.save_blocking()
    }

    pub fn set_video_filter(&mut self, filter: Option<String>) -> Result<()> {
        self.config.video_filter = filter;
        self.save_blocking()
    }

    pub fn set_output_format(&mut self, format: String) -> Result<()> {
        self.config.output_format = format;
        self.save_blocking()
    }

    pub fn set_processing_format(&mut self, format: String) -> Result<()> {
        self.config.processing_format = format;
        self.save_blocking()
    }

    pub fn set_video_compare_args(&mut self, args: String) -> Result<()> {
        self.config.video_compare_args = args;
        self.save_blocking()
    }

    pub fn set_default_output_folder(&mut self, folder: Option<String>) -> Result<()> {
        self.config.default_output_folder = folder;
        self.save_blocking()
    }

    pub fn set_encoding_settings_expanded(&mut self, expanded: bool) -> Result<()> {
        self.config.encoding_settings_expanded = expanded;
        self.save_blocking()
    }

    pub fn set_model_metadata(&mut self, model_id: String, meta: ModelMetadata) -> Result<()> {
        self.config.models.insert(model_id, meta);
        self.save_blocking()
    }

    pub fn update_model_category(
        &mut self,
        model_id: &str,
        category: Option<serde_json::Value>,
    ) -> Result<()> {
        if let Some(meta) = self.config.models.get_mut(model_id) {
            meta.category = category;
            self.save_blocking()?;
        }
        Ok(())
    }

    pub fn delete_model_metadata(&mut self, model_id: &str) -> Result<()> {
        self.config.models.remove(model_id);
        self.save_blocking()
    }

    pub fn set_vs_mlrt_version(&mut self, version: Option<String>) -> Result<()> {
        self.config.vs_mlrt_version = version;
        self.save_blocking()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Recursively merge `other` into `base` (other wins on conflicts).
fn json_merge(base: &mut serde_json::Value, other: serde_json::Value) {
    match (base, other) {
        (serde_json::Value::Object(bm), serde_json::Value::Object(om)) => {
            for (k, v) in om {
                json_merge(bm.entry(k).or_insert(serde_json::Value::Null), v);
            }
        }
        (base, other) => {
            if !other.is_null() {
                *base = other;
            }
        }
    }
}

/// Resolve the stock-app-config.json path for both dev and production.
fn resolve_stock_config(resource_dir: &PathBuf) -> PathBuf {
    // Dev: workspace_root/include/stock-app-config.json
    let dev = crate::paths::workspace_root()
        .join("include")
        .join("stock-app-config.json");
    if dev.exists() {
        return dev;
    }
    // Prod: resource_dir/stock-app-config.json
    resource_dir.join("stock-app-config.json")
}
