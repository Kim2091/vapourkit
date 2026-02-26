// src-tauri/src/model_validator.rs
//
// ONNX model validation — equivalent to electron/modelValidator.ts

use anyhow::{Context, Result};
use std::path::PathBuf;

use crate::paths;
use crate::utils::run_command;

/// Result of validating an ONNX file.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct OnnxValidationResult {
    pub is_valid: bool,
    pub error: Option<String>,
    /// Detected input shape e.g. [1, 3, 64, 64]
    pub input_shape: Option<Vec<i64>>,
    /// Scale factor inferred from model (2, 4, etc.)
    pub scale: Option<u32>,
    /// Whether the model supports dynamic shapes
    pub dynamic_shapes: bool,
    /// Model type: "vsr", "image"
    pub model_type: Option<String>,
    /// Number of input frames (for temporal/VSR models)
    pub num_frames: Option<u32>,
}

/// Validate an ONNX file using a small Python script executed through the
/// embedded Python interpreter.  We shell out to Python because onnxruntime
/// and onnx are already available in the VapourSynth Python environment.
pub async fn validate_onnx(onnx_path: &PathBuf) -> Result<OnnxValidationResult> {
    if !onnx_path.exists() {
        return Ok(OnnxValidationResult {
            is_valid: false,
            error: Some(format!("File not found: {}", onnx_path.display())),
            input_shape: None,
            scale: None,
            dynamic_shapes: false,
            model_type: None,
            num_frames: None,
        });
    }

    let ext = onnx_path.extension().and_then(|e| e.to_str()).unwrap_or("");
    if ext != "onnx" {
        return Ok(OnnxValidationResult {
            is_valid: false,
            error: Some("File is not an ONNX model (.onnx extension required)".to_string()),
            input_shape: None,
            scale: None,
            dynamic_shapes: false,
            model_type: None,
            num_frames: None,
        });
    }

    let python = paths::python();

    // Small inline Python script that validates and inspects the ONNX model
    let script = format!(
        r#"
import sys, json
try:
    import onnx
    model = onnx.load(r'{onnx}')
    onnx.checker.check_model(model)
    inputs = model.graph.input
    if not inputs:
        print(json.dumps({{"is_valid": False, "error": "No inputs found"}}))
        sys.exit(0)
    inp = inputs[0]
    shape = []
    for d in inp.type.tensor_type.shape.dim:
        shape.append(d.dim_value if d.dim_value > 0 else -1)
    dynamic = any(v < 0 for v in shape)
    # Determine scale from output/input spatial dims
    scale = None
    outputs = model.graph.output
    if outputs and len(shape) >= 4 and shape[2] > 0 and shape[3] > 0:
        out = outputs[0]
        out_shape = [d.dim_value for d in out.type.tensor_type.shape.dim]
        if len(out_shape) >= 4 and out_shape[2] > 0 and out_shape[3] > 0 and shape[2] > 0:
            scale = out_shape[2] // shape[2]
    # Detect model type (temporal vs image)
    num_frames = None
    model_type = "image"
    if len(shape) >= 2 and shape[1] > 3:
        num_frames = shape[1] // 3
        model_type = "vsr"
    print(json.dumps({{
        "is_valid": True,
        "error": None,
        "input_shape": shape,
        "scale": scale,
        "dynamic_shapes": dynamic,
        "model_type": model_type,
        "num_frames": num_frames
    }}))
except Exception as e:
    print(json.dumps({{"is_valid": False, "error": str(e)}}))
"#,
        onnx = onnx_path.to_string_lossy().replace('\\', "/")
    );

    let result = run_command(
        python.to_str().unwrap_or("python"),
        &["-c", &script],
        Some(&paths::vs()),
        Some(&crate::utils::vs_environment()),
    )
    .await;

    match result {
        Ok(proc) => {
            let output = proc.stdout.trim().to_string();
            if output.is_empty() {
                return Ok(OnnxValidationResult {
                    is_valid: false,
                    error: Some("Validator produced no output".to_string()),
                    input_shape: None,
                    scale: None,
                    dynamic_shapes: false,
                    model_type: None,
                    num_frames: None,
                });
            }
            let parsed: serde_json::Value =
                serde_json::from_str(&output).context("Parse validator JSON")?;
            Ok(serde_json::from_value(parsed).context("Deserialize validation result")?)
        }
        Err(e) => Ok(OnnxValidationResult {
            is_valid: false,
            error: Some(format!("Validation process failed: {}", e)),
            input_shape: None,
            scale: None,
            dynamic_shapes: false,
            model_type: None,
            num_frames: None,
        }),
    }
}
