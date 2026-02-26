// src-tauri/src/commands/upscale.rs
//
// Re-exports UpscaleState so lib.rs can include it in AppState,
// and provides get_frame_count as a lightweight stand-alone command.

use crate::upscale_executor;

// Re-export UpscaleState for use in lib.rs AppState
pub use crate::upscale_executor::UpscaleState;

/// Return the frame count of an already-generated .vpy script.
/// Useful for queue-based processing where scripts are pre-built.
#[tauri::command]
pub async fn get_frame_count(script_path: String) -> Result<u64, String> {
    upscale_executor::get_frame_count(&script_path.into())
        .await
        .map_err(|e| e.to_string())
}
