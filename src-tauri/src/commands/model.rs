// src-tauri/src/commands/model.rs
//
// Equivalent to electron/modelHandlers.ts
// Manages ONNX models and TensorRT engine conversion.

use crate::config_manager::ModelMetadata;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::fs;

// ─────────────────────────────────────────────────────────────────────────────
// Model initialization parameters
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitModelParams {
    pub onnx_path: String,
    pub model_name: String,
    pub min_shapes: String,
    pub opt_shapes: String,
    pub max_shapes: String,
    pub use_fp32: bool,
    pub use_bf16: Option<bool>,
    pub model_type: Option<String>,
    pub display_tag: Option<String>,
    pub use_static_shape: Option<bool>,
    pub use_custom_trtexec_params: Option<bool>,
    pub custom_trtexec_params: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportModelParams {
    pub onnx_path: String,
    pub model_name: String,
    pub min_shapes: String,
    pub opt_shapes: String,
    pub max_shapes: String,
    pub use_fp32: bool,
    pub use_bf16: Option<bool>,
    pub model_type: Option<String>,
    pub use_direct_ml: Option<bool>,
    pub display_tag: Option<String>,
    pub use_static_shape: Option<bool>,
    pub use_custom_trtexec_params: Option<bool>,
    pub custom_trtexec_params: Option<String>,
    pub skip_validation: Option<bool>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_available_models(
    state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    log::info!("Getting available models");
    let models_dir = crate::paths::models();
    fs::create_dir_all(&models_dir)
        .await
        .map_err(|e| e.to_string())?;

    let mut entries = fs::read_dir(&models_dir).await.map_err(|e| e.to_string())?;
    let mut engine_files: Vec<String> = Vec::new();
    let mut onnx_files: Vec<String> = Vec::new();

    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".engine") {
            engine_files.push(name);
        } else if name.ends_with(".onnx") {
            onnx_files.push(name);
        }
    }

    // Build set of ONNX basenames that have engines
    let onnx_with_engines: std::collections::HashSet<String> = engine_files
        .iter()
        .filter_map(|e| {
            let stem = e.trim_end_matches(".engine");
            // Engine files: modelname_fp16_fp16.engine → ONNX: modelname_fp16.onnx
            let re = stem.rsplitn(2, '_').last()?;
            Some(re.to_string())
        })
        .collect();

    let cfg = state.config.lock().unwrap();
    let mut models: Vec<serde_json::Value> = Vec::new();

    for file in &engine_files {
        let stem = file.trim_end_matches(".engine");
        let meta = cfg.get_model_metadata(stem);
        models.push(serde_json::json!({
            "id": format!("{}::engine", stem),
            "metadataId": stem,
            "name": stem,
            "path": models_dir.join(file).to_string_lossy(),
            "precision": if meta.map(|m| m.use_fp32).unwrap_or(false) { "FP32" } else { "FP16" },
            "backend": "tensorrt",
            "modelType": meta.map(|m| match &m.model_type { crate::config_manager::ModelType::Vsr => "vsr", crate::config_manager::ModelType::Image => "image" }).unwrap_or("image"),
            "displayTag": meta.and_then(|m| m.display_tag.as_deref()),
            "description": meta.and_then(|m| m.description.as_deref()),
            "category": meta.and_then(|m| m.category.as_ref()),
        }));
    }

    for file in &onnx_files {
        let stem = file.trim_end_matches(".onnx");
        let meta = cfg.get_model_metadata(stem);
        let has_engine = onnx_with_engines.contains(stem);
        models.push(serde_json::json!({
            "id": format!("{}::onnx", stem),
            "metadataId": stem,
            "name": stem,
            "path": models_dir.join(file).to_string_lossy(),
            "precision": if meta.map(|m| m.use_fp32).unwrap_or(false) { "FP32" } else { "FP16" },
            "backend": "onnx",
            "hasEngine": has_engine,
            "modelType": meta.map(|m| match &m.model_type { crate::config_manager::ModelType::Vsr => "vsr", crate::config_manager::ModelType::Image => "image" }).unwrap_or("image"),
            "displayTag": meta.and_then(|m| m.display_tag.as_deref()),
            "description": meta.and_then(|m| m.description.as_deref()),
            "category": meta.and_then(|m| m.category.as_ref()),
        }));
    }

    log::info!("Found {} model(s)", models.len());
    Ok(models)
}

#[tauri::command]
pub async fn get_uninitialized_models(
    state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    log::info!("Getting uninitialized models");
    let models_dir = crate::paths::models();
    fs::create_dir_all(&models_dir)
        .await
        .map_err(|e| e.to_string())?;

    let mut entries = fs::read_dir(&models_dir).await.map_err(|e| e.to_string())?;
    let mut onnx_files: Vec<String> = Vec::new();
    let mut engine_basenames: std::collections::HashSet<String> = Default::default();

    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".engine") {
            engine_basenames.insert(name.trim_end_matches(".engine").to_string());
        } else if name.ends_with(".onnx") {
            onnx_files.push(name);
        }
    }

    let cfg = state.config.lock().unwrap();
    let uninit: Vec<serde_json::Value> = onnx_files
        .iter()
        .filter(|f| {
            let eng = f.trim_end_matches(".onnx").to_string() + "_fp16";
            !engine_basenames.contains(&eng)
        })
        .map(|f| {
            let id = f.trim_end_matches(".onnx");
            let meta = cfg.get_model_metadata(id);
            serde_json::json!({
                "id": id,
                "name": id,
                "onnxPath": models_dir.join(f).to_string_lossy(),
                "modelType": meta.map(|m| match m.model_type { crate::config_manager::ModelType::Vsr => "vsr", crate::config_manager::ModelType::Image => "image" }),
                "displayTag": meta.and_then(|m| m.display_tag.as_deref()),
            })
        })
        .collect();

    log::info!("Found {} uninitialized model(s)", uninit.len());
    Ok(uninit)
}

#[tauri::command]
pub async fn initialize_model(
    app: AppHandle,
    state: State<'_, AppState>,
    params: InitModelParams,
) -> Result<serde_json::Value, String> {
    log::info!("Starting model initialization: {}", params.model_name);

    let precision_suffix = if params.use_fp32 {
        "_fp32"
    } else if params.use_bf16.unwrap_or(false) {
        "_bf16"
    } else {
        "_fp16"
    };
    let model_name_with_precision = format!("{}{}", params.model_name, precision_suffix);
    let engine_path = crate::paths::models().join(format!("{}.engine", model_name_with_precision));

    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut us = state.upscale_state.lock().unwrap();
        us.model_cancel_flag = Some(cancel_flag.clone());
    }

    // Emit starting progress
    let _ = app.emit("model-init-progress", serde_json::json!({
        "type": "converting",
        "progress": 0,
        "message": "Starting TensorRT engine conversion..."
    }));

    let result = run_trtexec(
        &params.onnx_path,
        &engine_path.to_string_lossy(),
        &params.min_shapes,
        &params.opt_shapes,
        &params.max_shapes,
        params.use_fp32,
        params.use_bf16.unwrap_or(false),
        params.use_static_shape.unwrap_or(false),
        params.use_custom_trtexec_params.unwrap_or(false),
        params.custom_trtexec_params.as_deref(),
        "model-init-progress",
        cancel_flag.clone(),
        &app,
    )
    .await;

    {
        let mut us = state.upscale_state.lock().unwrap();
        us.model_cancel_flag = None;
    }

    match result {
        Ok(_) => {
            log::info!("Engine created: {:?}", engine_path);

            // Save metadata
            let meta = ModelMetadata {
                use_fp32: params.use_fp32,
                use_bf16: params.use_bf16,
                model_type: if params.model_type.as_deref() == Some("vsr") {
                    crate::config_manager::ModelType::Vsr
                } else {
                    crate::config_manager::ModelType::Image
                },
                created_at: chrono::Utc::now().to_rfc3339(),
                display_tag: params.display_tag,
                ..Default::default()
            };

            let mut cfg = state.config.lock().unwrap();
            cfg.set_model_metadata(model_name_with_precision.clone(), meta)
                .map_err(|e| e.to_string())?;

            let _ = app.emit("model-init-progress", serde_json::json!({
                "type": "complete",
                "progress": 100,
                "message": "Model initialized successfully!",
                "enginePath": engine_path.to_string_lossy()
            }));

            Ok(serde_json::json!({ "success": true, "enginePath": engine_path.to_string_lossy() }))
        }
        Err(e) => {
            log::error!("Model initialization failed: {}", e);
            let _ = app.emit("model-init-progress", serde_json::json!({
                "type": "error",
                "progress": 0,
                "message": format!("Initialization failed: {}", e)
            }));
            Ok(serde_json::json!({ "success": false, "error": e.to_string() }))
        }
    }
}

#[tauri::command]
pub async fn import_custom_model(
    app: AppHandle,
    state: State<'_, AppState>,
    params: ImportModelParams,
) -> Result<serde_json::Value, String> {
    log::info!("Starting custom model import: {}", params.model_name);

    // Validate ONNX unless skipped
    if !params.skip_validation.unwrap_or(false) {
        let _ = app.emit("model-import-progress", serde_json::json!({
            "type": "validating",
            "progress": 10,
            "message": "Validating ONNX model..."
        }));

        let validation = validate_onnx_file(&params.onnx_path);
        if !validation.is_valid {
            let _ = app.emit("model-import-progress", serde_json::json!({
                "type": "error",
                "progress": 0,
                "message": validation.error.as_deref().unwrap_or("Model validation failed")
            }));
            return Ok(serde_json::json!({
                "success": false,
                "error": validation.error.unwrap_or_else(|| "Model validation failed".into())
            }));
        }
        log::info!("Model validation passed");
    }

    let precision_suffix = if params.use_fp32 {
        "_fp32"
    } else if params.use_bf16.unwrap_or(false) {
        "_bf16"
    } else {
        "_fp16"
    };
    let model_name_with_precision = format!("{}{}", params.model_name, precision_suffix);
    let models_dir = crate::paths::models();
    fs::create_dir_all(&models_dir).await.map_err(|e| e.to_string())?;

    if params.use_direct_ml.unwrap_or(false) {
        // DirectML mode: just copy the ONNX file
        let _ = app.emit("model-import-progress", serde_json::json!({
            "type": "copying",
            "progress": 30,
            "message": "Copying ONNX model..."
        }));

        let dest_onnx = models_dir.join(format!("{}.onnx", model_name_with_precision));
        fs::copy(&params.onnx_path, &dest_onnx)
            .await
            .map_err(|e| e.to_string())?;

        // Save metadata
        let meta = ModelMetadata {
            use_fp32: params.use_fp32,
            use_bf16: params.use_bf16,
            model_type: if params.model_type.as_deref() == Some("vsr") {
                crate::config_manager::ModelType::Vsr
            } else {
                crate::config_manager::ModelType::Image
            },
            created_at: chrono::Utc::now().to_rfc3339(),
            display_tag: params.display_tag,
            ..Default::default()
        };

        let mut cfg = state.config.lock().unwrap();
        cfg.set_model_metadata(model_name_with_precision, meta)
            .map_err(|e| e.to_string())?;

        let _ = app.emit("model-import-progress", serde_json::json!({
            "type": "complete",
            "progress": 100,
            "message": "Model imported successfully (DirectML)!",
            "modelPath": dest_onnx.to_string_lossy()
        }));

        Ok(serde_json::json!({ "success": true }))
    } else {
        // TensorRT mode: run trtexec conversion
        let cancel_flag = Arc::new(AtomicBool::new(false));
        {
            let mut us = state.upscale_state.lock().unwrap();
            us.model_cancel_flag = Some(cancel_flag.clone());
        }

        let engine_path = models_dir.join(format!("{}.engine", model_name_with_precision));
        let result = run_trtexec(
            &params.onnx_path,
            &engine_path.to_string_lossy(),
            &params.min_shapes,
            &params.opt_shapes,
            &params.max_shapes,
            params.use_fp32,
            params.use_bf16.unwrap_or(false),
            params.use_static_shape.unwrap_or(false),
            params.use_custom_trtexec_params.unwrap_or(false),
            params.custom_trtexec_params.as_deref(),
            "model-import-progress",
            cancel_flag.clone(),
            &app,
        )
        .await;

        {
            let mut us = state.upscale_state.lock().unwrap();
            us.model_cancel_flag = None;
        }

        match result {
            Ok(_) => {
                let meta = ModelMetadata {
                    use_fp32: params.use_fp32,
                    use_bf16: params.use_bf16,
                    model_type: if params.model_type.as_deref() == Some("vsr") {
                        crate::config_manager::ModelType::Vsr
                    } else {
                        crate::config_manager::ModelType::Image
                    },
                    created_at: chrono::Utc::now().to_rfc3339(),
                    display_tag: params.display_tag,
                    ..Default::default()
                };

                let mut cfg = state.config.lock().unwrap();
                cfg.set_model_metadata(model_name_with_precision, meta)
                    .map_err(|e| e.to_string())?;

                let _ = app.emit("model-import-progress", serde_json::json!({
                    "type": "complete",
                    "progress": 100,
                    "message": "Model imported successfully!"
                }));

                Ok(serde_json::json!({ "success": true }))
            }
            Err(e) => {
                let _ = app.emit("model-import-progress", serde_json::json!({
                    "type": "error",
                    "progress": 0,
                    "message": e.to_string()
                }));
                Ok(serde_json::json!({ "success": false, "error": e.to_string() }))
            }
        }
    }
}

#[tauri::command]
pub async fn cancel_model_import(state: State<'_, AppState>) -> Result<(), String> {
    log::info!("Canceling model import");
    let us = state.upscale_state.lock().unwrap();
    if let Some(flag) = &us.model_cancel_flag {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
pub async fn force_stop_model_import(state: State<'_, AppState>) -> Result<(), String> {
    log::info!("Force stopping model import");
    let mut us = state.upscale_state.lock().unwrap();
    if let Some(flag) = &us.model_cancel_flag {
        flag.store(true, Ordering::SeqCst);
    }
    if let Some(pid) = us.trtexec_pid.take() {
        crate::utils::force_kill_pid(pid);
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_model(
    state: State<'_, AppState>,
    model_path: String,
    model_id: String,
) -> Result<serde_json::Value, String> {
    log::info!("Deleting model: {}", model_id);

    match fs::remove_file(&model_path).await {
        Ok(_) => {
            let mut cfg = state.config.lock().unwrap();
            let _ = cfg.delete_model_metadata(&model_id);
            Ok(serde_json::json!({ "success": true }))
        }
        Err(e) => Ok(serde_json::json!({ "success": false, "error": e.to_string() })),
    }
}

#[tauri::command]
pub async fn get_model_metadata(
    state: State<'_, AppState>,
    model_id: String,
) -> Result<Option<serde_json::Value>, String> {
    let cfg = state.config.lock().unwrap();
    let meta = cfg.get_model_metadata(&model_id);
    Ok(meta.and_then(|m| serde_json::to_value(m).ok()))
}

#[tauri::command]
pub async fn update_model_metadata(
    state: State<'_, AppState>,
    model_id: String,
    metadata: serde_json::Value,
) -> Result<serde_json::Value, String> {
    log::info!("Updating model metadata: {}", model_id);
    let mut cfg = state.config.lock().unwrap();

    // Fetch and clone the existing record so we can patch individual fields.
    // The frontend sends a *partial* payload (no `createdAt`, etc.), so we
    // cannot deserialise directly into the full ModelMetadata struct.
    let mut meta = cfg
        .get_model_metadata(&model_id)
        .ok_or_else(|| format!("Model not found: {}", model_id))?
        .clone();

    if let Some(v) = metadata.get("useFp32").and_then(|v| v.as_bool()) {
        meta.use_fp32 = v;
    }
    if let Some(v) = metadata.get("useBf16") {
        meta.use_bf16 = v.as_bool();
    }
    if let Some(v) = metadata.get("modelType") {
        if let Ok(mt) = serde_json::from_value::<crate::config_manager::ModelType>(v.clone()) {
            meta.model_type = mt;
        }
    }
    if let Some(v) = metadata.get("temporalFrames") {
        meta.temporal_frames = v.as_u64().map(|n| n as u32);
    }
    if let Some(v) = metadata.get("displayTag") {
        meta.display_tag = if v.is_null() { None } else { v.as_str().map(|s| s.to_string()) };
    }
    if let Some(v) = metadata.get("description") {
        meta.description = if v.is_null() { None } else { v.as_str().map(|s| s.to_string()) };
    }
    if let Some(v) = metadata.get("category") {
        meta.category = if v.is_null() { None } else { Some(v.clone()) };
    }

    cfg.set_model_metadata(model_id, meta)
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn get_model_categories(
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let cfg = state.config.lock().unwrap();
    // Collect unique categories from all models
    let mut cats: std::collections::HashSet<String> = Default::default();
    // Iterate all model metadata and collect category values
    for (_id, meta) in cfg.iter_models() {
        if let Some(cat) = &meta.category {
            match cat {
                serde_json::Value::String(s) => { cats.insert(s.clone()); }
                serde_json::Value::Array(arr) => {
                    for v in arr {
                        if let serde_json::Value::String(s) = v {
                            cats.insert(s.clone());
                        }
                    }
                }
                _ => {}
            }
        }
    }
    drop(cfg);
    let mut result: Vec<String> = cats.into_iter().collect();
    result.sort();
    Ok(result)
}

#[tauri::command]
pub async fn update_model_category(
    state: State<'_, AppState>,
    model_id: String,
    category: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    log::info!("Updating category for model: {}", model_id);
    let mut cfg = state.config.lock().unwrap();
    cfg.update_model_category(&model_id, category)
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn validate_onnx_model(onnx_path: String) -> Result<serde_json::Value, String> {
    log::info!("Validating ONNX model: {}", onnx_path);
    let result = validate_onnx_file(&onnx_path);
    Ok(serde_json::to_value(&result).map_err(|e| e.to_string())?)
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnnxValidationResult {
    pub is_valid: bool,
    pub error: Option<String>,
    pub input_shape: Option<Vec<i64>>,
    pub output_shape: Option<Vec<i64>>,
    pub input_name: Option<String>,
    pub is_static: Option<bool>,
}

/// Basic ONNX file validation without loading the model into a runtime.
/// Checks file size and the protobuf magic bytes.
pub fn validate_onnx_file(path: &str) -> OnnxValidationResult {
    use std::fs::File;
    use std::io::Read;

    let p = Path::new(path);
    if !p.exists() {
        return OnnxValidationResult {
            is_valid: false,
            error: Some("File does not exist".into()),
            input_shape: None,
            output_shape: None,
            input_name: None,
            is_static: None,
        };
    }

    let size = match std::fs::metadata(p) {
        Ok(m) => m.len(),
        Err(e) => {
            return OnnxValidationResult {
                is_valid: false,
                error: Some(format!("Cannot read file: {}", e)),
                input_shape: None,
                output_shape: None,
                input_name: None,
                is_static: None,
            };
        }
    };

    if size < 100 {
        return OnnxValidationResult {
            is_valid: false,
            error: Some("File is too small to be a valid ONNX model".into()),
            input_shape: None,
            output_shape: None,
            input_name: None,
            is_static: None,
        };
    }

    // Read first few bytes to check protobuf structure
    let mut buf = [0u8; 16];
    match File::open(p).and_then(|mut f| f.read_exact(&mut buf)) {
        Ok(_) => {}
        Err(e) => {
            return OnnxValidationResult {
                is_valid: false,
                error: Some(format!("Cannot read file: {}", e)),
                input_shape: None,
                output_shape: None,
                input_name: None,
                is_static: None,
            };
        }
    }

    // ONNX protobuf starts with a field tag byte — check it's a valid protobuf
    // Field 1 (ir_version) has tag 0x08 (field 1, wire type 0 = varint)
    // Field 7 (opset_import) has tag 0x3A (field 7, wire type 2 = length-delimited)
    // A valid ONNX file typically starts with one of these field tags.
    let first_byte = buf[0];
    let is_probable_protobuf = first_byte == 0x08 || first_byte == 0x0A || first_byte == 0x3A
        || first_byte == 0x12 || first_byte == 0x42 || first_byte == 0x4A;

    if !is_probable_protobuf {
        return OnnxValidationResult {
            is_valid: false,
            error: Some("File does not appear to be a valid ONNX model (invalid protobuf header)".into()),
            input_shape: None,
            output_shape: None,
            input_name: None,
            is_static: None,
        };
    }

    OnnxValidationResult {
        is_valid: true,
        error: None,
        input_shape: None,
        output_shape: None,
        input_name: None,
        is_static: None,
    }
}

/// Run trtexec to convert an ONNX model to a TensorRT engine
async fn run_trtexec(
    onnx_path: &str,
    engine_path: &str,
    min_shapes: &str,
    opt_shapes: &str,
    max_shapes: &str,
    use_fp32: bool,
    use_bf16: bool,
    use_static_shape: bool,
    use_custom_params: bool,
    custom_params: Option<&str>,
    progress_event: &str,
    cancel_flag: Arc<AtomicBool>,
    app: &AppHandle,
) -> anyhow::Result<()> {
    let _ = app.emit(progress_event, serde_json::json!({
        "type": "converting",
        "progress": 0,
        "message": "Starting TensorRT engine conversion..."
    }));

    let trtexec = crate::paths::trtexec();
    if !trtexec.exists() {
        anyhow::bail!("trtexec not found at {:?}. Please set up TensorRT first.", trtexec);
    }

    let mut args: Vec<String> = vec![
        format!("--onnx={}", onnx_path),
    ];

    if use_custom_params {
        if let Some(params) = custom_params {
            // Replace the OUTPUT_PATH placeholder with the actual engine path,
            // matching the Electron modelExtractor.ts behaviour.
            let resolved = params.replace("OUTPUT_PATH", engine_path);
            for p in resolved.split_whitespace() {
                args.push(p.to_string());
            }
        } else {
            // No custom params supplied — fall back to the standard --saveEngine flag
            args.push(format!("--saveEngine={}", engine_path));
        }
    } else {
        args.push(format!("--saveEngine={}", engine_path));
        if !use_static_shape && !min_shapes.is_empty() {
            args.push(format!("--minShapes={}", min_shapes));
            args.push(format!("--optShapes={}", opt_shapes));
            args.push(format!("--maxShapes={}", max_shapes));
        }

        if use_fp32 {
            args.push("--inputIOFormats=fp32:chw".into());
            args.push("--outputIOFormats=fp32:chw".into());
        } else if use_bf16 {
            args.push("--bf16".into());
        } else {
            args.push("--fp16".into());
        }

        args.push("--builderOptimizationLevel=3".into());
        args.push("--useCudaGraph".into());
        args.push("--tacticSources=+CUDNN,-CUBLAS,-CUBLAS_LT".into());
        args.push("--verbose".into());
    }

    log::info!("Running trtexec: {} {}", trtexec.display(), args.join(" "));

    let mut cmd = tokio::process::Command::new(&trtexec);
    crate::utils::configure_tokio_command(&mut cmd);
    cmd.args(&args)
        .stderr(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped());

    let mut child = cmd.spawn()?;
    let _pid = child.id();
    
    // Store PID for force-kill support (handled via upscale_state in the caller)

    // Stream stderr/stdout (different trtexec builds may use either)
    let stderr = child.stderr.take().expect("stderr");
    let stdout = child.stdout.take().expect("stdout");
    let app_clone2 = app.clone();
    let flag = cancel_flag.clone();
    let flag2 = cancel_flag.clone();
    let progress_event2 = progress_event.to_string();

    // stderr: log only (trtexec --verbose goes to stdout)
    let stderr_reader_task = tokio::spawn(async move {
        use tokio::io::AsyncBufReadExt;
        let mut reader = tokio::io::BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if flag.load(Ordering::SeqCst) {
                break;
            }
            log::debug!("[trtexec stderr] {}", line);
        }
    });

    // stdout: parse progress exactly as modelExtractor.ts does
    let stdout_reader_task = tokio::spawn(async move {
        use tokio::io::AsyncBufReadExt;
        let mut reader = tokio::io::BufReader::new(stdout).lines();
        let mut last_progress: u32 = 0;
        while let Ok(Some(line)) = reader.next_line().await {
            if flag2.load(Ordering::SeqCst) {
                break;
            }
            log::debug!("[trtexec stdout] {}", line);

            let mut new_progress: Option<u32> = None;

            // Pattern 1: first `N%` literal in the line (only advance)
            'pct: for (pct_end, _) in line.match_indices('%') {
                let digits_start = line[..pct_end]
                    .rfind(|c: char| !c.is_ascii_digit())
                    .map(|i| i + 1)
                    .unwrap_or(0);
                if digits_start < pct_end {
                    if let Ok(p) = line[digits_start..pct_end].parse::<u32>() {
                        if p <= 100 && p > last_progress {
                            new_progress = Some(p);
                            break 'pct;
                        }
                    }
                }
            }

            // Pattern 2: phase keywords (mirrors modelExtractor.ts thresholds)
            if new_progress.is_none() {
                if line.contains("Starting inference") && last_progress < 95 {
                    new_progress = Some(95);
                } else if (line.contains("Serializing") || line.contains("Saving engine")) && last_progress < 90 {
                    new_progress = Some(90);
                } else if line.contains("Building") && last_progress < 30 {
                    new_progress = Some(30);
                }
            }

            if let Some(p) = new_progress {
                last_progress = p;
            }

            let _ = app_clone2.emit(&progress_event2, serde_json::json!({
                "type": "converting",
                "progress": last_progress,
                "message": &line
            }));
        }
    });

    let status = child.wait().await?;
    stderr_reader_task.abort();
    stdout_reader_task.abort();

    if cancel_flag.load(Ordering::SeqCst) {
        anyhow::bail!("Model conversion canceled by user");
    }

    if !status.success() {
        anyhow::bail!("trtexec exited with code {:?}", status.code());
    }

    Ok(())
}
