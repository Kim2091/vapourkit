# vsdlssnr — DLSS-NR (Neural Uplift) for VapourSynth

A native VapourSynth plugin that runs NVIDIA's DLSS-NR snippet — the DLSS 5 "Neural Uplift"
neural enhancement — over video frames.

```python
clip = core.resize.Bicubic(clip, format=vs.RGBS, matrix_in_s="709",
                           transfer_in_s="709", transfer_s="srgb", range_s="full")
clip = core.dlssnr.Enhance(clip)
```

## What this is, and is not

DLSS-NR **is not an upscaler**. The snippet pins `DLSSNR.ScalingRatio` to 1.0 — input and
output are the same resolution. It is a finisher, and belongs at the end of a chain after
whatever actually changed the resolution.

What it does is neural image enhancement: local tone and structure, with a separate strength
for skin so faces are not over-sharpened by the general structure control.

## Requirements

| | |
|---|---|
| GPU | Blackwell (RTX 50-series). The snippet explicitly rejects Turing through Ada with `Unsupported GPU architecture 0x%x, minimum required 0x1b0`. |
| Driver | 570 or newer |
| `nvngx_dlssnr.dll` | **Not shipped with the driver.** Place it next to `vsdlssnr.dll`, or pass `snippet="C:/path/to/nvngx_dlssnr.dll"`. |

The snippet also enforces a caller-origin check: every export refuses with `FAIL_PlatformError`
unless the call arrives from the driver's own `nvngx.dll`, and the driver does not know this
feature at all. `bypass_caller_check` (on by default) redirects the snippet's own
`GetModuleFileNameW` import so the check sees this module as `nvngx.dll`. The snippet's code is
not modified. Set `bypass_caller_check=0` to confirm the check is what a failure is hitting.

This is defeating a restriction NVIDIA put there deliberately. It is fine for local use on
hardware you own; redistributing a build that does it, alongside a snippet that ships without a
licence file, is a separate decision that has not been made here.

## Colour space is a correctness requirement

The model is **LDR-clamped and trained on tonemapped, sRGB-encoded frames**. Two things follow,
and neither is a tuning preference:

- **Range.** Values must be 0–1. HDR sources (PQ/HLG) must be tonemapped to SDR first.
- **Transfer.** Values must carry the sRGB curve. Hand it linear light and it reads them as
  though they were already gamma-encoded — lifted blacks and washed-out greys. This is the
  exact bug the dxvk-remix integration hit before it anchored the pass after its sRGB encode.

Video is *near* this domain but not in it: BT.709 with a ~2.4 display gamma is close to sRGB
(linear toe, ~2.2 effective) but not identical, and video is usually limited-range YUV rather
than full-range RGB. Convert explicitly. The bundled `DLSS Neural Uplift.vkfilter` does this
round trip for you.

Note the staging texture is `DXGI_FORMAT_R16G16B16A16_FLOAT`, a plain float format rather than
an `_SRGB`-typed one, on purpose: the curve lives in the *values*. An `_SRGB` view would have
the hardware linearise on read, producing the inverse of the same bug.

## No depth, no motion vectors

The snippet accepts `DLSSNR.Depth` and `DLSSNR.MVec` but **does not require them** — only
`Color` and `Output` are checked. Without them it loses temporal reprojection and still runs,
and that is the mode this plugin ships.

That is a deliberate choice rather than an unfinished one. The temporal path uses depth for
reprojection and disocclusion; monocular depth estimated from video is relative and temporally
unstable, so flickering depth would mean flickering history rejection. With neither bound there
is no way to feed it a bad G-buffer. If estimated depth and flow are added later, they should
be proven to beat this baseline, not assumed to.

Temporal history is still live across frames within the snippet. `DLSSNR.Reset` is asserted
whenever the requested frame does not directly follow the last one processed — a seek in the
preview, a re-request after a dropped cache entry — and after any failed evaluation, since a
rejected evaluation does not advance the history the snippet holds.

## Arguments

| Argument | Default | Meaning |
|---|---|---|
| `clip` | — | RGB only: `RGBS` (32-bit float), `RGB24`, or `RGB48`. |
| `style` | `0` | 0–2. Style block baked into the weights; 0 is neutral. Higher values are clamped to 2 by the snippet, not ignored. |
| `style_strength` | `1.0` | 0–1. How far the style is blended in from neutral. This is `DLSSNR.LocalToneStrength`, which despite the name is the style blend weight, not a tone control. |
| `intensity` | `1.0` | Wet/dry blend against the original. Below 1 the snippet keeps a copy of the input, so it also costs a little more. |
| `local_structure` | `1.0` | Detail enhancement strength. Only consulted while `auto_mask` is on. |
| `skin_structure` | `-1.0` | Structure strength for skin, kept separate so faces are not over-sharpened. `-1` is the snippet's "unset" sentinel meaning "use `local_structure`" — not the same as `0`, which disables it on skin. |
| `auto_mask` | `1` | Let the snippet derive its own protection mask. Turning it off also disables both structure strengths. |
| `preset` | `0` | `DLSSNR.Hint.Render.Preset`. Selects nothing in the 310.8 snippet — it ships one set of weights registered as preset 1 and falls back to it for every other value. |
| `feature_id` | `18` | The `NVSDK_NGX_Feature` value DLSS-NR is registered under. Undocumented by NVIDIA; sweep this if creation fails with `FAIL_FeatureNotFound`. |
| `app_id` | `102100511` | NGX application id. |
| `snippet` | — | Explicit path to `nvngx_dlssnr.dll`. |
| `bypass_caller_check` | `1` | See above. |

## Design notes

**D3D12, not Vulkan.** `nvngx_dlssnr.dll` exports the D3D12, D3D11 and CUDA NGX entry points
alongside the Vulkan ones. The Vulkan path requires `VK_NVX_binary_import`,
`VK_NVX_image_view_handle`, `VK_EXT_buffer_device_address` and `VK_KHR_push_descriptor`; for a
plugin that owns its own device and renders nothing, that is all cost and no benefit.

**Two NGX cores.** The driver's `nvngx.dll` supplies the `NVSDK_NGX_Parameter` block — a
generic bag with a vtable, which the snippet consumes happily — while `nvngx_dlssnr.dll` is
loaded by hand and keeps its own NGX state, so it gets its own `Init` against the same device.
This mirrors the dxvk-remix integration, which is the validated arrangement.

**Parameter types are load-bearing.** NGX stores a value under the type it was *set* with, so an
`int` written as `unsigned` reads back as the type's default — silently. The `Set` calls here
match the getter the snippet reads each parameter with, one for one, against the Remix port.

**`fmFrameState`.** The snippet carries temporal state and can hold one frame's worth at a time,
which is exactly what that VapourSynth filter mode exists for.

## Building

```powershell
.\build.ps1 -Install
```

Needs Visual Studio 2022 with the C++ workload; it uses the CMake and Ninja inside the VS
install, so nothing else has to be on `PATH`. `-Install` copies the DLL into the Vapourkit
VapourSynth plugins folder.

`NGX_SDK_DIR` only supplies the driver-core parameter block (`Init_Ext`,
`GetCapabilityParameters`). Nothing DLSS-NR specific comes from an SDK — NVIDIA does not
publish one — so every DLSS-NR symbol is resolved out of the snippet at runtime and every
parameter name in `src/dlssnr_params.h` was confirmed against the binary rather than guessed.

## Status

**Written, not yet compiled or run.** The NGX call sequence, the parameter-type discipline and
the caller-check bypass are ported from a DLSS-NR integration that has been exercised against a
real snippet in dxvk-remix; the D3D12 host, the VapourSynth binding and the colour handling
around them are new here and unverified.

Open questions for first light, in the order they will bite:

1. Does the feature create at all over D3D12? Vulkan is the validated path; the D3D12 exports
   are present but untried.
2. What does a model trained to make *rendered* frames photoreal do to footage that already is?
   `auto_mask` and `skin_structure` suggest faces got attention, but this is genuinely unknown.
3. Per-frame upload/evaluate/readback cost. Measure peak VRAM and frame time before this goes
   anywhere near a long encode.
