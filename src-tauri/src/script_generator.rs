// src-tauri/src/script_generator.rs
//
// Equivalent to electron/scriptGenerator.ts
// Generates VapourSynth .vpy scripts from a template and config.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tokio::fs;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ModelType {
    Vsr,
    Image,
}

impl Default for ModelType {
    fn default() -> Self { ModelType::Image }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub id: String,
    pub enabled: bool,
    #[serde(default)]
    pub filter_type: String, // "aiModel" | "custom"
    pub preset: String,
    pub code: String,
    pub order: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SegmentSelection {
    pub enabled: bool,
    pub start_frame: i64,
    pub end_frame: i64, // -1 = end of video
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ColorimetryConfig {
    pub overwrite_matrix: bool,
    pub matrix709: bool,
    pub default_matrix: String,
    pub default_primaries: String,
    pub default_transfer: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptConfig {
    pub input_video: String,
    pub engine_path: String,
    pub plugins_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    #[serde(default)]
    pub use_direct_ml: bool,
    #[serde(default)]
    pub use_fp32: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_type: Option<String>,
    #[serde(default = "default_true")]
    pub upscaling_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub colorimetry: Option<ColorimetryConfig>,
    #[serde(default)]
    pub filters: Vec<Filter>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub num_streams: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub segment: Option<SegmentSelection>,
    #[serde(default)]
    pub validation_mode: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_fps: Option<f64>,
    #[serde(default)]
    pub generate_preview_outputs: bool,
}

fn default_true() -> bool { true }

pub struct VapourSynthScriptGenerator;

impl VapourSynthScriptGenerator {
    pub fn new() -> Self {
        VapourSynthScriptGenerator
    }

    /// Resolve the template path, falling back to the bundled `include/` copy
    /// when the user config-dir copy doesn't exist (e.g. first launch or dev
    /// mode where target/debug/data/ was created without it).
    fn get_template_path(&self) -> PathBuf {
        let primary = crate::paths::vapoursynth_template();
        if primary.exists() {
            return primary;
        }
        // Fallback: include/vapoursynth_template.vpy (dev) or workspace root
        let fallback = crate::paths::workspace_root()
            .join("include")
            .join("vapoursynth_template.vpy");
        if fallback.exists() {
            log::warn!(
                "Template not found at {}; using fallback at {}",
                primary.display(),
                fallback.display()
            );
            return fallback;
        }
        // Return primary so the error message references the expected location
        primary
    }

    /// Generate a temporary .vpy script from config and return its path.
    pub async fn generate_script(
        &self,
        config: &ScriptConfig,
        config_manager: &crate::config_manager::ConfigManager,
    ) -> Result<PathBuf> {
        let template_path = self.get_template_path();
        let mut template = fs::read_to_string(&template_path)
            .await
            .with_context(|| format!(
                "Failed to read VapourSynth template at '{}'. Run dependency setup or ensure the file exists.",
                template_path.display()
            ))?;

        let c = config.colorimetry.as_ref();
        let overwrite_matrix = if c.map(|c| c.overwrite_matrix).unwrap_or(false) { "True" } else { "False" };
        let matrix709 = if c.map(|c| c.matrix709).unwrap_or(false) { "True" } else { "False" };
        let default_matrix = c.map(|c| c.default_matrix.as_str()).unwrap_or("709");
        let default_primaries = c.map(|c| c.default_primaries.as_str()).unwrap_or("709");
        let default_transfer = c.map(|c| c.default_transfer.as_str()).unwrap_or("709");
        let output_format = config.output_format.as_deref().unwrap_or("vs.YUV420P8");

        let mut enabled_filters: Vec<&Filter> = config
            .filters
            .iter()
            .filter(|f| f.enabled)
            .collect();
        enabled_filters.sort_by_key(|f| f.order);

        let mut filter_code = String::new();

        // Validation mode: trim to first 5 seconds
        if config.validation_mode {
            let fps = config.source_fps.unwrap_or(30.0);
            let frames = (fps * 5.0).ceil() as i64;
            filter_code.push_str("# Validation Mode - Only process first 5 seconds\n");
            filter_code.push_str(&format!(
                "clip = core.std.Trim(clip, first=0, last={})\n",
                frames - 1
            ));
            filter_code.push_str(&format!(
                "original_clip = core.std.Trim(original_clip, first=0, last={})\n\n",
                frames - 1
            ));
        } else if let Some(seg) = &config.segment {
            if seg.enabled {
                filter_code.push_str("# Segment Selection (Trim)\n");
                if seg.end_frame == -1 {
                    filter_code.push_str(&format!(
                        "clip = core.std.Trim(clip, first={})\n",
                        seg.start_frame
                    ));
                    filter_code.push_str(&format!(
                        "original_clip = core.std.Trim(original_clip, first={})\n\n",
                        seg.start_frame
                    ));
                } else {
                    filter_code.push_str(&format!(
                        "clip = core.std.Trim(clip, first={}, last={})\n",
                        seg.start_frame,
                        seg.end_frame - 1
                    ));
                    filter_code.push_str(&format!(
                        "original_clip = core.std.Trim(original_clip, first={}, last={})\n\n",
                        seg.start_frame,
                        seg.end_frame - 1
                    ));
                }
            }
        }

        let total = enabled_filters.len();
        for (i, filter) in enabled_filters.iter().enumerate() {
            if filter.filter_type == "aiModel" {
                if let Some(model_path) = &filter.model_path {
                    let use_fp32 = config_manager.is_model_fp32(&extract_model_id(model_path));
                    let model_type_str = config_manager.get_model_type(&extract_model_id(model_path));
                    let temporal_frames = config_manager.get_temporal_frames(&extract_model_id(model_path));
                    let model_type = match model_type_str {
                        crate::config_manager::ModelType::Vsr => ModelType::Vsr,
                        crate::config_manager::ModelType::Image => ModelType::Image,
                    };
                    filter_code.push_str(&self.generate_ai_model_code(
                        filter,
                        config.use_direct_ml,
                        use_fp32,
                        &model_type,
                        default_matrix,
                        default_primaries,
                        default_transfer,
                        config.num_streams,
                        Some(temporal_frames),
                    ));
                }
            } else if filter.filter_type == "custom" && !filter.code.trim().is_empty() {
                filter_code.push_str(&format!(
                    "# Custom Filter: {}\n{}\n\n",
                    filter.preset.as_str().if_empty("Unnamed"),
                    filter.code.trim()
                ));
            }

            if config.generate_preview_outputs {
                let output_index = total - 1 - i;
                let filter_name = filter.preset.as_str().if_empty("Filter");
                filter_code.push_str(&format!(
                    "set_output(clip, {}, \"{}\")\n\n",
                    output_index, filter_name
                ));
            }
        }

        // Replace template placeholders
        let input_forward_slash = config.input_video.replace('\\', "/");
        template = template
            .replace("{{INPUT_VIDEO}}", &input_forward_slash)
            .replace("{{OVERWRITE_MATRIX}}", overwrite_matrix)
            .replace("{{MATRIX_709}}", matrix709)
            .replace("{{DEFAULT_MATRIX}}", default_matrix)
            .replace("{{DEFAULT_PRIMARIES}}", default_primaries)
            .replace("{{DEFAULT_TRANSFER}}", default_transfer)
            .replace("{{OUTPUT_FORMAT}}", output_format)
            .replace("{{FILTERS}}", &filter_code);

        if config.generate_preview_outputs {
            // Remove trailing set_output(clip, 0, "Output") if present
            let re = regex_lite(&template);
            let _ = re; // handled below with simple string replace
            if let Some(pos) = template.rfind("set_output(clip, 0, \"Output\")") {
                let tail = &template[pos..];
                if tail.trim() == "set_output(clip, 0, \"Output\")" {
                    template.truncate(pos);
                    template.push('\n');
                }
            }
        }

        // Write to temp file
        let tmp = std::env::temp_dir().join(format!("VSR_upscale_{}.vpy", Uuid::new_v4()));
        fs::write(&tmp, &template).await.context("write temp script")?;
        log::info!("Generated script: {}", tmp.display());
        Ok(tmp)
    }

    /// Generate VapourSynth code for an AI model filter
    fn generate_ai_model_code(
        &self,
        filter: &Filter,
        use_direct_ml: bool,
        use_fp32: bool,
        model_type: &ModelType,
        default_matrix: &str,
        default_primaries: &str,
        default_transfer: &str,
        num_streams: Option<u32>,
        temporal_frames: Option<u32>,
    ) -> String {
        let model_path = match &filter.model_path {
            Some(p) => p,
            None => return String::new(),
        };

        let rgb_format = if use_fp32 { "vs.RGBS" } else { "vs.RGBH" };
        let streams = num_streams.unwrap_or(2);

        let mut code = String::new();
        code.push_str("# AI Model\n");
        code.push_str("# Convert to RGB format for upscaling\n");
        code.push_str(&format!(
            "if clip.format.id != {}:\n    clip = core.resize.Bilinear(clip, format={}, matrix_in_s=\"{}\", primaries_in_s=\"{}\", transfer_in_s=\"{}\")\n",
            rgb_format, rgb_format, default_matrix, default_primaries, default_transfer
        ));
        code.push_str("clip = core.std.Expr(clip, expr=['x 0 max 1 min'])\n");

        let (model_plugin, model_path_param, effective_model_path, fp16_param) = if use_direct_ml {
            let onnx_path = model_path.replace(".engine", ".onnx");
            let use_fp16 = !use_fp32;
            let fp16 = format!(
                ", provider=\"DML\", device_id=0, fp16={}, verbosity=4",
                if use_fp16 { "True" } else { "False" }
            );
            ("ort", "network_path", onnx_path, fp16)
        } else {
            ("trt", "engine_path", model_path.clone(), String::new())
        };

        let model_path_fwd = effective_model_path.replace('\\', "/");

        match model_type {
            ModelType::Vsr => {
                let frames = temporal_frames.unwrap_or(5);
                let half = (frames / 2) as i64;
                code.push_str(&format!(
                    "# Temporal upscaling ({}-frame VSR architecture)\n",
                    frames
                ));

                let mut frame_vars: Vec<String> = Vec::new();
                for i in -half..=half {
                    let var = if i == 0 {
                        "clip".to_string()
                    } else if i < 0 {
                        let abs = i.unsigned_abs() as usize;
                        let name = format!("m{}", abs);
                        code.push_str(&format!(
                            "{} = clip[:{}] + clip[:-{}]   # shift {}\n",
                            name, abs, abs, i
                        ));
                        name
                    } else {
                        let abs = i as usize;
                        let name = format!("p{}", abs);
                        code.push_str(&format!(
                            "{} = clip[{}:] + clip[-{}:]   # shift +{}\n",
                            name, abs, abs, i
                        ));
                        name
                    };
                    frame_vars.push(var);
                }

                code.push_str(&format!(
                    "clip = core.{}.Model([{}], {}=\"{}\", num_streams={}{})\n\n",
                    model_plugin,
                    frame_vars.join(", "),
                    model_path_param,
                    model_path_fwd,
                    streams,
                    fp16_param
                ));
            }
            ModelType::Image => {
                code.push_str("# Single-frame upscaling (non-temporal architecture)\n");
                code.push_str(&format!(
                    "clip = core.{}.Model(clip, {}=\"{}\", num_streams={}{})\n\n",
                    model_plugin, model_path_param, model_path_fwd, streams, fp16_param
                ));
            }
        }

        code.push_str("# Convert to YUV for filter compatibility\n");
        code.push_str(
            "clip = core.resize.Point(clip, format=vs.YUV444P16, matrix_s=\"709\", primaries_s=\"709\", transfer_s=\"709\")\n\n",
        );

        code
    }

    /// Remove a temporary script file
    pub async fn cleanup_script(&self, path: &PathBuf) {
        let _ = fs::remove_file(path).await;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Extract the model ID (basename without extension) from a full model path
pub fn extract_model_id(path: &str) -> String {
    std::path::Path::new(path)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

/// Simple placeholder for a regex trim (avoid pulling in regex crate)
fn regex_lite(_s: &str) {}

trait StrExt {
    fn if_empty<'a>(&'a self, fallback: &'a str) -> &'a str;
}
impl StrExt for str {
    fn if_empty<'a>(&'a self, fallback: &'a str) -> &'a str {
        if self.is_empty() { fallback } else { self }
    }
}
