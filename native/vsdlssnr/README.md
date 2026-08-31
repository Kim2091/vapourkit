# vsdlssnr — DLSS-NR (Neural Uplift) for VapourSynth

A native VapourSynth plugin that runs NVIDIA's DLSS-NR snippet — the DLSS 5 "Neural Uplift"
neural enhancement — over video frames.

```python
clip = core.resize.Bicubic(clip, format=vs.RGBS, matrix_in_s="709",
                           transfer_in_s="709", transfer_s="srgb", range_s="full")
clip = core.dlssnr.Enhance(clip)
```

With aligned auxiliary clips:

```python
# depth: GRAYS, normalized device depth. motion: RGBS, R/G = signed pixel displacement.
# Motion must point from each current-frame pixel to its position in the previous frame.
clip = core.dlssnr.Enhance(clip, depth=depth, motion=motion)
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

## Depth and motion vectors

The snippet accepts `DLSSNR.Depth` and `DLSSNR.MVec` but does not require either — only `Color`
and `Output` are mandatory. `Enhance` can now generate motion itself through Windows' D3D12 Video
fixed-function motion estimator. It selects inputs in this order:

1. A supplied `motion` clip (best when it comes from the original renderer).
2. Automatic GPU motion (`auto_motion=1`, the default) when the NVIDIA driver exposes D3D12
   Video motion estimation for the clip size.
3. Colour-only DLSS-NR when neither is available.

Depth remains an explicit input. It cannot be recovered reliably from ordinary video, and
invented depth is more likely to destabilize disocclusion handling than to help it.

| Argument | Required format and convention |
|---|---|
| `depth` | `GRAYS`, `GRAY16`, or `GRAY8`, at exactly the source resolution and frame count. Values are normalized device depth: normally 0 = near and 1 = far. Use `depth_inverted=1` for the reverse convention. |
| `motion` | `RGBS`, at exactly the source resolution and frame count. R is horizontal and G is vertical **signed displacement in pixels**, pointing from the current frame to the previous frame. B is ignored. |
| `motion_scale_x`, `motion_scale_y` | Extra scale applied by the snippet after sampling motion; both default to `1.0`. Leave them there when vectors are already expressed in source pixels. |

The automatic path uploads only a neutral-chroma NV12 luma image and runs one 16×16
fixed-function video-engine search per consecutive frame pair. When both source dimensions are
divisible by four, the NV12 image is half resolution (one quarter of the image work); the compute
pass expands each resulting 16×16 cell as a 32×32 source-pixel cell and scales its displacement
back to source pixels. If that smaller image is unsupported by the driver, the plugin falls back
to a 1:1 estimator input. D3D12 resolves its output as a
small `R16G16_SINT` grid in quarter-pixel units; the plugin expands it to the RG16F source-pixel
motion texture that DLSS-NR samples. It uses the current frame as the D3D12 input and the
previous frame as its reference, so the resulting vectors point current → previous. This is
hardware motion estimation, not a CPU flow model or an inference pass.

Automatic motion requires Windows 10 2004 or newer, an even frame width and height, and a driver
that exposes `D3D12_FEATURE_VIDEO_MOTION_ESTIMATOR` for NV12. Unsupported hardware degrades
cleanly to colour-only operation; `auto_motion=0` disables the attempt. The normal first frame
and every seek seed a new reference without binding motion, paired with `DLSSNR.Reset`.

Depth should be omitted unless it is a stable, aligned depth estimate. A flickering monocular
depth sequence can make disocclusion rejection worse than the no-depth baseline. Motion alone
is nevertheless useful and is the preferred first auxiliary input for footage.

The DLSS-NR auxiliary textures stay compact: depth is `R32_FLOAT` and dense motion is
`R16G16_FLOAT` on the GPU (four bytes per source pixel each). Automatic flow adds one NV12
source upload. The D3D12 Video `R16G16_SINT` block grid is expanded directly into that existing
motion texture by a small GPU compute pass, so no motion data is read back to or re-uploaded from
the CPU. It avoids both a full-resolution motion readback and CPU/inference optical flow.

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
| `depth` | — | Optional normalized depth clip: `GRAYS`, `GRAY16`, or `GRAY8`; same dimensions and frame count as `clip`. |
| `depth_inverted` | `0` | Set to `1` when the depth clip uses 1 = near and 0 = far. |
| `motion` | — | Optional `RGBS` vector clip: R/G are current → previous horizontal/vertical motion in source pixels. |
| `motion_scale_x`, `motion_scale_y` | `1.0` | Multiplier applied to supplied or automatically generated motion vectors by DLSS-NR. |
| `auto_motion` | `1` | Generate current → previous motion with the D3D12 Video fixed-function estimator when no `motion` clip was supplied. Set `0` for colour-only operation. `backend="vulkan"` has no equivalent: setting this explicitly there is an error, and leaving it at the default runs colour-only with a log line. |
| `backend` | `"d3d12"` | Graphics API used to host the snippet: `"d3d12"` or `"vulkan"`. Both produce bitwise-identical output; see the design note below for why D3D12 is still the default. |
| `preset` | `0` | `DLSSNR.Hint.Render.Preset`. Selects nothing in the 310.8 snippet — it ships one set of weights registered as preset 1 and falls back to it for every other value. |
| `feature_id` | `18` | The `NVSDK_NGX_Feature` value DLSS-NR is registered under. Undocumented by NVIDIA; sweep this if creation fails with `FAIL_FeatureNotFound`. |
| `app_id` | `102100511` | NGX application id. |
| `snippet` | — | Explicit path to `nvngx_dlssnr.dll`. |
| `bypass_caller_check` | `1` | See above. |

## Design notes

**Two backends; D3D12 is the default.** `nvngx_dlssnr.dll` exports the D3D12, D3D11 and CUDA NGX
entry points alongside the Vulkan ones, and both a D3D12 and a Vulkan host are implemented here.
They were measured against each other on an RTX 5080 Laptop at 4K, alternating runs to cancel
clock drift, and came out level: pack, unpack and `gpu+wait` all matched within run-to-run noise,
with Vulkan only marginally cheaper to *record* (~0.45 ms against ~0.65 ms), which is a rounding
error against a frame of tens of milliseconds. That is the expected result — the frame is
dominated by the network itself and by two full-resolution PCIe copies, neither of which the API
choice changes.

So D3D12 stays the default on the strength of being the verified path, not on the strength of
being faster. Vulkan costs more to reach: it needs `VK_NVX_binary_import`,
`VK_NVX_image_view_handle`, `VK_KHR_buffer_device_address` and `VK_KHR_push_descriptor`, plus the
`timelineSemaphore`, `descriptorIndexing` and `bufferDeviceAddress` Vulkan 1.2 features, and
there is no capability query for DLSS-NR — a shortfall only surfaces when feature creation fails.
The backend checks for each of those up front so the failure says which one was missing.

`vulkan-1.dll` is resolved with `LoadLibraryW` at runtime and never linked. A static import would
mean that on any machine with a missing or broken loader, `vsdlssnr.dll` fails to load at all and
takes the working D3D12 backend down with it; resolved dynamically, that degrades to "the Vulkan
backend is unavailable" and nothing else changes. Vulkan headers are likewise confined to
`vulkan_ctx.*`, `vulkan_ngx.*` and `vulkan_backend.cpp` — `plugin.cpp` reaches the backend through
`vulkan_backend.h`, which names no Vulkan type.

**Automatic motion is D3D12-only.** It is Windows' D3D12 Video fixed-function motion estimator,
which has no Vulkan counterpart; `VK_NV_optical_flow` is a different mechanism, not a drop-in. So
is `debug_motion`, which exists to inspect that estimator's output.

**Two NGX cores.** The driver's `nvngx.dll` supplies the `NVSDK_NGX_Parameter` block — a
generic bag with a vtable, which the snippet consumes happily — while `nvngx_dlssnr.dll` is
loaded by hand and keeps its own NGX state, so it gets its own `Init` against the same device.
This mirrors the dxvk-remix integration, which is the validated arrangement.

**Parameter types are load-bearing.** NGX stores a value under the type it was *set* with, so an
`int` written as `unsigned` reads back as the type's default — silently. The `Set` calls here
match the getter the snippet reads each parameter with, one for one, against the Remix port.

**`fmFrameState`.** The snippet carries temporal state and can hold one frame's worth at a time,
which is exactly what that VapourSynth filter mode exists for.

## Performance

Measured on an RTX 5080 Laptop (610.88), 3840x2160 colour-only, walking frames in order from
zero, alternating runs to cancel clock drift. GPU state was sampled with `nvidia-smi` during
every run.

| | before | after |
|---|---|---|
| 4K, decode + sRGB convert + Enhance | 19.6 fps (51.0 ms) | **37.0 fps (27.0 ms)** |
| 1440p, same chain | 34.9 fps (28.7 ms) | **53.8 fps (18.6 ms)** |
| 4K, Enhance alone (synthetic source) | 23.9 fps (42.0 ms) | **44.8 fps (22.2 ms)** |
| 1440p, Enhance alone | 47.7 fps (21.0 ms) | **96.1 fps (10.4 ms)** |
| GPU utilisation, 4K | 41-48% | 81-97% |
| GPU power, 4K | ~95 W | ~160 W |

Output is bitwise identical before and after: 40 consecutive frames from zero hashed at both
resolutions, all 80 hashes equal, plus whole-frame `np.array_equal` on four of them per run. `VSDLSSNR_NO_SIMD=1` and `VSDLSSNR_NO_PIPELINE=1`
each force the older code path so that comparison can be re-run.

### Where the frame actually goes

`VSDLSSNR_PROFILE=1` logs a phase breakdown every 30 frames, and now also a GPU-side one taken
from timestamp queries in the command list and `GetClockCalibration`. That second line is what
settled the question, because CPU wall clock around the fence cannot tell a slow network from
slow PCIe copies. At 4K:

```
upload 0.17   evaluate 19.6   readback 1.30   gpu total 21.0   queue latency 0.22
```

**The network is the frame.** `EvaluateFeature` is ~19.6 ms at 4K and ~8.9 ms at 1440p on this
GPU - 2.36 and 2.41 ns per pixel, so it is pixel-linear and not clock-starved. There was never
a large submission overhead to remove: queue latency is 0.2 ms and the CPU-side submit is 0.14
ms. The upload copy is 0.17 ms because the upload heap lands in host-visible VRAM, which means
the PCIe cost of the input is paid by the CPU's write-combined stores during pack, not by the
GPU copy. Readback is a genuine 66 MB PCIe transfer at ~51 GB/s.

So the 41% GPU utilisation was not the GPU waiting on the driver. It was 21 ms of GPU work in a
51 ms frame - the number matches exactly - with the CPU doing all its work either side of a
blocking fence.

### What changed

**Frame pipelining (the large one).** Colour-only frames now run one evaluation ahead. Frame
n+1 is packed while the GPU is still evaluating frame n, submitted the moment the fence for n
clears, and frame n is unpacked while the GPU works on n+1. The blocking wait went from 21 ms
per frame to 0.2 ms, and with a cheap source the filter now sits at 96-97% GPU utilisation -
it is GPU-bound, which is the correct place for it to be.

The filter stays `fmFrameState`. Nothing evaluates out of order and nothing evaluates
concurrently; what overlaps is CPU work with GPU work. Speculation is only started while the
caller is walking forward - a preview being scrubbed asks for scattered single frames and gets
the old one-frame-at-a-time behaviour, rather than paying for a second frame nobody wanted.
Evaluating one frame past the request is safe because `lastFrame` records what was actually
evaluated rather than what was asked for, so a caller that then jumps elsewhere still gets
`DLSSNR.Reset` asserted exactly as before.

Only the staging pair is doubled. One submission is outstanding at a time, so the command
allocator is still only reset after a wait; what needed two of each was the upload and readback
buffer, since the one being unpacked must not be the one the GPU is writing. That is one extra
upload and one extra readback buffer - about 133 MB at 4K, half of it host memory - and they are
only allocated when the pipelined path is actually in use.

Two things follow from running ahead that are worth stating rather than discovering. While
walking forward the filter requests source frame n+1 as well as frame n, so a source that fails
to produce n+1 now fails the request for n too, where before it would have failed on its own
frame. And a forward walk that stops early has evaluated one frame past the last one returned;
that costs an evaluation, never correctness.

**AVX2 + F16C row conversion.** `XMConvertFloatToHalf` compiles to DirectXMath's *software*
path unless the translation unit is built with `/arch:AVX2`, which this plugin cannot be - it
has to load on any x64 CPU. Twenty-five million software conversions per 4K frame was the
larger half of the CPU cost, ahead of the memory traffic. `src/convert_simd.cpp` is the one
file built with `/arch:AVX2`, reached only after a CPUID check made from a baseline translation
unit, and falls back to the scalar loops for integer input and for CPUs without F16C. Pack went
7.6 to 4.8 ms and unpack 7.2 to 4.9 ms; the unpack also writes its planes with non-temporal
stores, which removes a whole frame of read-for-ownership traffic.

The auxiliary packs - automatic-motion NV12 luma, depth, and supplied motion - are now threaded
too. The NV12 one was two million scalar conversions per 4K frame on a single core.

**What was not the problem.** PCIe bandwidth (0.17 ms up, 1.30 ms down), submission cost (0.14
ms), queue latency (0.22 ms), and GPU clocks (evaluate is pixel-linear across resolutions that
boosted differently). None of these were worth touching, and the Vulkan backend was already
known to be level with D3D12.

### auto_motion=1 is not pipelined

Automatic motion still runs strictly serially, so it does not get the large win: 17.7 to 20.0
fps at 4K, from the SIMD and threading work alone. Its pre-pass costs 5.8 ms per frame on top
of the normal frame, and it contains two blocking GPU waits that exist as deliberate driver
workarounds (see `endAutoMotionInputAndGenerate`). Running that machine a frame ahead of itself
needs more evidence than a performance change should carry, so `auto_motion=1`, `depth=`,
`motion=` and `debug_motion=1` all take the original serial path. Colour-only at 37 fps against
20 fps is worth knowing about when choosing.

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

## Diagnostic environment variables

| | |
|---|---|
| `VSDLSSNR_PROFILE=1` | Log per-phase CPU timings and the GPU timestamp breakdown every 30 frames. |
| `VSDLSSNR_NO_SIMD=1` | Force the scalar row conversions on a CPU that has AVX2. |
| `VSDLSSNR_NO_PIPELINE=1` | Force the original strictly-serial one-frame-at-a-time flow. |

The last two exist so the "bitwise identical" claim above can be re-checked rather than
believed. `tools/` has the harness that does it, all of it driven with the portable Python in
`data/vapoursynth-portable`:

```powershell
$py = "..\..\data\vapoursynth-portable\python.exe"
& $py tools\regress.py <video>                     # 9 behavioural checks
& $py tools\bench.py <video> --frames 90           # fps, per-phase ms, GPU clock state
$env:VSDLSSNR_NO_SIMD = "1"; $env:VSDLSSNR_NO_PIPELINE = "1"
& $py tools\identity.py <video> before.npz --frames 40
Remove-Item Env:\VSDLSSNR_NO_SIMD, Env:\VSDLSSNR_NO_PIPELINE
& $py tools\identity.py <video> after.npz --frames 40
& $py tools\compare.py before.npz after.npz
```

`identity.py` walks from frame zero in order, which is the only way these measurements mean
anything: `DLSSNR.Reset` is asserted whenever the requested frame does not directly follow the
last one processed, so a seek straight to frame N gives a frame with no temporal history at
all. `bench.py --synthetic` swaps the decoder for a blank clip, which is how to see the
filter's own ceiling rather than the whole chain's.

## Status

The native project builds locally with the supplied Visual Studio bootstrapper. Automatic motion,
external depth/motion, and the colour-only fallback all have compile-time validation. It still
needs a real Blackwell playback test with representative footage before a long encode: verify
that the driver advertises the estimator, inspect direction and occlusion behaviour, and measure
frame time against the colour-only baseline.
