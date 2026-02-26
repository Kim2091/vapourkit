// src-tauri/src/commands/workflow.rs
//
// Equivalent to electron/workflowHandlers.ts
// Workflows are stored as TOML files (.vkworkflow)

use tokio::fs;

#[tauri::command]
pub async fn export_workflow(
    workflow: serde_json::Value,
    file_path: String,
) -> Result<serde_json::Value, String> {
    log::info!("Exporting workflow to: {}", file_path);

    let toml_data = build_toml_from_workflow(&workflow)?;
    let toml_str = toml::to_string_pretty(&toml_data)
        .map_err(|e| format!("TOML serialization error: {}", e))?;

    fs::write(&file_path, toml_str)
        .await
        .map_err(|e| e.to_string())?;

    log::info!("Workflow exported successfully");
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn import_workflow(file_path: String) -> Result<serde_json::Value, String> {
    log::info!("Importing workflow from: {}", file_path);

    let content = fs::read_to_string(&file_path)
        .await
        .map_err(|e| e.to_string())?;

    let data: toml::Value = toml::from_str(&content)
        .map_err(|e| format!("Invalid workflow TOML: {}", e))?;

    let workflow = build_workflow_from_toml(&data)?;
    Ok(serde_json::json!({ "success": true, "workflow": workflow }))
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn build_toml_from_workflow(w: &serde_json::Value) -> Result<toml::Value, String> {
    let mut map = toml::map::Map::new();

    // [workflow]
    let mut wf = toml::map::Map::new();
    set_toml_str(&mut wf, "name", w.get("name"));
    set_toml_str(&mut wf, "version", w.get("version"));
    set_toml_str(&mut wf, "created_at", w.get("createdAt"));
    set_toml_str(&mut wf, "description", w.get("description"));
    map.insert("workflow".into(), toml::Value::Table(wf));

    // [[filters]]
    let filters = w
        .get("filters")
        .and_then(|f| f.as_array())
        .cloned()
        .unwrap_or_default();

    let toml_filters: Vec<toml::Value> = filters
        .iter()
        .map(|f| {
            let mut fm = toml::map::Map::new();
            set_toml_str(&mut fm, "name", f.get("name"));
            set_toml_str(&mut fm, "code", f.get("code"));
            set_toml_str(&mut fm, "description", f.get("description"));
            if let Some(v) = f.get("enabled").and_then(|v| v.as_bool()) {
                fm.insert("enabled".into(), toml::Value::Boolean(v));
            }
            if let Some(v) = f.get("order").and_then(|v| v.as_i64()) {
                fm.insert("order".into(), toml::Value::Integer(v));
            }
            set_toml_str(&mut fm, "filterType", f.get("filterType"));
            set_toml_str(&mut fm, "modelPath", f.get("modelPath"));
            set_toml_str(&mut fm, "modelType", f.get("modelType"));

            // category – can be string or array
            if let Some(cat) = f.get("category") {
                if let Some(s) = cat.as_str() {
                    fm.insert("category".into(), toml::Value::String(s.to_string()));
                } else if let Some(arr) = cat.as_array() {
                    if arr.len() == 1 {
                        if let Some(s) = arr[0].as_str() {
                            fm.insert("category".into(), toml::Value::String(s.to_string()));
                        }
                    }
                }
            }

            toml::Value::Table(fm)
        })
        .collect();

    map.insert("filters".into(), toml::Value::Array(toml_filters));

    // [encoding_settings]
    if let Some(es) = w.get("encodingSettings") {
        let mut esm = toml::map::Map::new();
        set_toml_str(&mut esm, "ffmpeg_args", es.get("ffmpegArgs"));
        set_toml_str(&mut esm, "processing_format", es.get("processingFormat"));
        set_toml_str(&mut esm, "output_format", es.get("outputFormat"));
        set_toml_str(&mut esm, "video_compare_args", es.get("videoCompareArgs"));
        if let Some(v) = es.get("numStreams").and_then(|v| v.as_i64()) {
            esm.insert("num_streams".into(), toml::Value::Integer(v));
        }

        if let Some(seg) = es.get("segment") {
            let mut sm = toml::map::Map::new();
            if let Some(v) = seg.get("enabled").and_then(|v| v.as_bool()) {
                sm.insert("enabled".into(), toml::Value::Boolean(v));
            }
            if let Some(v) = seg.get("startFrame").and_then(|v| v.as_i64()) {
                sm.insert("start_frame".into(), toml::Value::Integer(v));
            }
            if let Some(v) = seg.get("endFrame").and_then(|v| v.as_i64()) {
                sm.insert("end_frame".into(), toml::Value::Integer(v));
            }
            esm.insert("segment".into(), toml::Value::Table(sm));
        }

        if let Some(col) = es.get("colorimetry") {
            let cv = json_to_toml(col)?;
            esm.insert("colorimetry".into(), cv);
        }

        map.insert("encoding_settings".into(), toml::Value::Table(esm));
    }

    Ok(toml::Value::Table(map))
}

fn build_workflow_from_toml(data: &toml::Value) -> Result<serde_json::Value, String> {
    let wf_table = data.get("workflow").ok_or("Missing [workflow] section")?;
    let filters_arr = data
        .get("filters")
        .and_then(|f| f.as_array())
        .cloned()
        .unwrap_or_default();

    let filters: Vec<serde_json::Value> = filters_arr
        .iter()
        .map(|f| {
            let cat = f.get("category").map(|c| match c {
                toml::Value::String(s) => serde_json::Value::String(s.clone()),
                toml::Value::Array(arr) => serde_json::Value::Array(
                    arr.iter()
                        .map(|v| serde_json::Value::String(v.as_str().unwrap_or_default().into()))
                        .collect(),
                ),
                _ => serde_json::Value::Null,
            });

            let mut obj = serde_json::Map::new();
            for key in &["name", "code", "description", "filterType", "modelPath", "modelType"] {
                if let Some(v) = f.get(key).and_then(|v| v.as_str()) {
                    obj.insert(key.to_string(), serde_json::Value::String(v.into()));
                }
            }
            if let Some(v) = f.get("enabled").and_then(|v| v.as_bool()) {
                obj.insert("enabled".into(), serde_json::Value::Bool(v));
            }
            if let Some(v) = f.get("order").and_then(|v| v.as_integer()) {
                obj.insert("order".into(), serde_json::Value::Number(v.into()));
            }
            if let Some(c) = cat {
                obj.insert("category".into(), c);
            }
            serde_json::Value::Object(obj)
        })
        .collect();

    let mut workflow = serde_json::Map::new();
    workflow.insert("name".into(), get_str(wf_table, "name"));
    workflow.insert("version".into(), get_str(wf_table, "version"));
    workflow.insert("createdAt".into(), get_str(wf_table, "created_at"));
    workflow.insert("description".into(), get_str(wf_table, "description"));
    workflow.insert("filters".into(), serde_json::Value::Array(filters));

    if let Some(es) = data.get("encoding_settings") {
        let mut esm = serde_json::Map::new();
        esm.insert("ffmpegArgs".into(), get_str(es, "ffmpeg_args"));
        esm.insert("processingFormat".into(), get_str(es, "processing_format"));
        esm.insert("outputFormat".into(), get_str(es, "output_format"));
        esm.insert("videoCompareArgs".into(), get_str(es, "video_compare_args"));
        if let Some(v) = es.get("num_streams").and_then(|v| v.as_integer()) {
            esm.insert("numStreams".into(), serde_json::Value::Number(v.into()));
        }
        if let Some(seg) = es.get("segment") {
            let mut sm = serde_json::Map::new();
            if let Some(v) = seg.get("enabled").and_then(|v| v.as_bool()) {
                sm.insert("enabled".into(), serde_json::Value::Bool(v));
            }
            if let Some(v) = seg.get("start_frame").and_then(|v| v.as_integer()) {
                sm.insert("startFrame".into(), serde_json::Value::Number(v.into()));
            }
            if let Some(v) = seg.get("end_frame").and_then(|v| v.as_integer()) {
                sm.insert("endFrame".into(), serde_json::Value::Number(v.into()));
            }
            esm.insert("segment".into(), serde_json::Value::Object(sm));
        }
        workflow.insert("encodingSettings".into(), serde_json::Value::Object(esm));
    }

    Ok(serde_json::Value::Object(workflow))
}

fn set_toml_str(map: &mut toml::map::Map<String, toml::Value>, key: &str, val: Option<&serde_json::Value>) {
    if let Some(s) = val.and_then(|v| v.as_str()) {
        if !s.is_empty() {
            map.insert(key.into(), toml::Value::String(s.to_string()));
        }
    }
}

fn get_str(table: &toml::Value, key: &str) -> serde_json::Value {
    table
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| serde_json::Value::String(s.to_string()))
        .unwrap_or(serde_json::Value::Null)
}

fn json_to_toml(v: &serde_json::Value) -> Result<toml::Value, String> {
    match v {
        serde_json::Value::Null => Ok(toml::Value::String(String::new())),
        serde_json::Value::Bool(b) => Ok(toml::Value::Boolean(*b)),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(toml::Value::Integer(i))
            } else if let Some(f) = n.as_f64() {
                Ok(toml::Value::Float(f))
            } else {
                Err("invalid number".into())
            }
        }
        serde_json::Value::String(s) => Ok(toml::Value::String(s.clone())),
        serde_json::Value::Array(arr) => {
            let vals: Result<Vec<_>, _> = arr.iter().map(json_to_toml).collect();
            Ok(toml::Value::Array(vals?))
        }
        serde_json::Value::Object(obj) => {
            let mut map = toml::map::Map::new();
            for (k, val) in obj {
                map.insert(k.clone(), json_to_toml(val)?);
            }
            Ok(toml::Value::Table(map))
        }
    }
}
