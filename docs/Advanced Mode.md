#### Enabling Advanced Mode
Click the Code icon (`<>`) in the top-left corner to toggle Advanced Mode.

#### Using Custom Filters

1. **Add Filter**: Click "+ Add Filter" in the filter panel
2. **Configure**: 
   - Choose a filter template or write custom VapourSynth code
   - Enable/disable filters individually
   - Reorder filters using drag handles
3. **Apply**: Filters are automatically applied during processing

#### Creating Filter Templates

1. Write custom VapourSynth code in a filter
2. Click "Save as Template" 
3. Name your template and optionally add a description
4. Reuse the template in future projects

#### Working with Workflows

**Export Workflow**:
1. Configure your complete processing pipeline (filters, model, settings)
2. Click the Upload icon in the header
3. Choose save location for `.vkworkflow` file

**Import Workflow**:
1. Click the Download icon in the header
2. Select a `.vkworkflow` file
3. All settings will be restored (note: model paths must be valid)

**Load Workflow**:
- Similar to import, but completely replaces current configuration

### Supported Formats

**Input**: MP4, AVI, MKV, MOV, WebM, FLV, WMV  
**Output**: MP4, MKV, AVI, MOV, WebM

### Configuration Files

- **App Config**: `data/config/app-config.json` - User preferences and model metadata
- **Filter Templates**: `data/config/filter-templates/` - Custom filter definitions
- **Workflows**: User-defined location with `.vkworkflow` extension

### Model Files

- **Location**: `include/models/` (built-in) or `data/models/` (runtime)
- **Formats**: 
  - `.onnx` - ONNX model files (universal)
  - `.engine` - TensorRT engine files (NVIDIA-specific, GPU-bound)