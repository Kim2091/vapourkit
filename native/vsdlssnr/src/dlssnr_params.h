#pragma once

// DLSS-NR ("Neural Uplift", the DLSS 5 generation) NGX parameter names.
//
// Ported verbatim from the dxvk-remix DLSS-NR integration, where every string below was
// confirmed to exist in nvngx_dlssnr.dll 310.8.0 (Streamline 2.13) rather than guessed. NGX
// silently ignores parameters it does not recognise - a misspelled name does not fail, it
// just does nothing - so nothing is defined here that was not confirmed against the binary.
//
// Only the subset this plugin actually drives is kept. UI separation inputs remain absent: video
// has no independently composited HUD layer to bind. Depth and motion vectors are supported as
// optional VapourSynth inputs; see README.md for their precise conventions.

// The NVSDK_NGX_Feature enum value DLSS-NR is registered under. NVIDIA has not published it;
// 18 (0x12) was recovered by disassembly and is what the Remix integration runs with. Exposed
// as a filter argument in case a later snippet renumbers.
#define kNgxFeatureDlssNrDefault 18

// --- Feature creation -------------------------------------------------------------------
#define NVSDK_NGX_Parameter_DLSSNR_Width                "DLSSNR.Width"
#define NVSDK_NGX_Parameter_DLSSNR_Height               "DLSSNR.Height"
#define NVSDK_NGX_Parameter_DLSSNR_Hint_Render_Preset   "DLSSNR.Hint.Render.Preset"
#define NVSDK_NGX_Parameter_DLSSNR_Enabled              "DLSSNR.Enabled"
#define NVSDK_NGX_Parameter_DLSSNR_DepthInverted        "DLSSNR.DepthInverted"

// --- Per-evaluation inputs / outputs ----------------------------------------------------
#define NVSDK_NGX_Parameter_DLSSNR_Color                "DLSSNR.Color"
#define NVSDK_NGX_Parameter_DLSSNR_Output               "DLSSNR.Output"
#define NVSDK_NGX_Parameter_DLSSNR_Depth                "DLSSNR.Depth"
#define NVSDK_NGX_Parameter_DLSSNR_MVec                 "DLSSNR.MVec"
#define NVSDK_NGX_Parameter_DLSSNR_MVecScaleX           "DLSSNR.MVecScaleX"
#define NVSDK_NGX_Parameter_DLSSNR_MVecScaleY           "DLSSNR.MVecScaleY"
#define NVSDK_NGX_Parameter_DLSSNR_Reset                "DLSSNR.Reset"
#define NVSDK_NGX_Parameter_DLSSNR_UICorrection         "DLSSNR.UICorrection"

// --- Effect controls --------------------------------------------------------------------
#define NVSDK_NGX_Parameter_DLSSNR_Style                    "DLSSNR.Style"
#define NVSDK_NGX_Parameter_DLSSNR_Intensity                "DLSSNR.Intensity"
#define NVSDK_NGX_Parameter_DLSSNR_LocalToneStrength        "DLSSNR.LocalToneStrength"
#define NVSDK_NGX_Parameter_DLSSNR_LocalStructureStrength   "DLSSNR.LocalStructureStrength"
#define NVSDK_NGX_Parameter_DLSSNR_SkinStructureStrength    "DLSSNR.SkinStructureStrength"
#define NVSDK_NGX_Parameter_DLSSNR_UseAutoMask              "DLSSNR.UseAutoMask"

// --- Subrects ---------------------------------------------------------------------------
#define NVSDK_NGX_Parameter_DLSSNR_ColorSubrectBaseX    "DLSSNR.ColorSubrectBaseX"
#define NVSDK_NGX_Parameter_DLSSNR_ColorSubrectBaseY    "DLSSNR.ColorSubrectBaseY"
#define NVSDK_NGX_Parameter_DLSSNR_ColorSubrectWidth    "DLSSNR.ColorSubrectWidth"
#define NVSDK_NGX_Parameter_DLSSNR_ColorSubrectHeight   "DLSSNR.ColorSubrectHeight"

#define NVSDK_NGX_Parameter_DLSSNR_OutputSubrectBaseX   "DLSSNR.OutputSubrectBaseX"
#define NVSDK_NGX_Parameter_DLSSNR_OutputSubrectBaseY   "DLSSNR.OutputSubrectBaseY"
#define NVSDK_NGX_Parameter_DLSSNR_OutputSubrectWidth   "DLSSNR.OutputSubrectWidth"
#define NVSDK_NGX_Parameter_DLSSNR_OutputSubrectHeight  "DLSSNR.OutputSubrectHeight"

#define NVSDK_NGX_Parameter_DLSSNR_MVecSubrectBaseX     "DLSSNR.MVecSubrectBaseX"
#define NVSDK_NGX_Parameter_DLSSNR_MVecSubrectBaseY     "DLSSNR.MVecSubrectBaseY"
#define NVSDK_NGX_Parameter_DLSSNR_MVecSubrectWidth     "DLSSNR.MVecSubrectWidth"
#define NVSDK_NGX_Parameter_DLSSNR_MVecSubrectHeight    "DLSSNR.MVecSubrectHeight"

#define NVSDK_NGX_Parameter_DLSSNR_DepthSubrectBaseX    "DLSSNR.DepthSubrectBaseX"
#define NVSDK_NGX_Parameter_DLSSNR_DepthSubrectBaseY    "DLSSNR.DepthSubrectBaseY"
#define NVSDK_NGX_Parameter_DLSSNR_DepthSubrectWidth    "DLSSNR.DepthSubrectWidth"
#define NVSDK_NGX_Parameter_DLSSNR_DepthSubrectHeight   "DLSSNR.DepthSubrectHeight"

// Highest DLSSNR.Style the 310.8 snippet ships. It holds three style blocks and clamps
// anything higher to the last one, so offering more would present duplicates of style 2.
static const int kNeuralUpliftMaxStyle = 2;
