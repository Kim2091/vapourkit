# Adding an inference backend

Inference backends are deliberately split into a small, declarative registry
and a provider implementation. Add behavior there rather than scattering
backend checks through the renderer, model import code, or installer.

The current providers are TensorRT, DirectML, and NCNN. Use the closest one as
a reference:

- TensorRT: `electron/providers/tensorrt/` — an engine-building provider.
- DirectML: `electron/providers/directml.ts` — an ONNX-direct provider.
- NCNN: `electron/providers/ncnn.ts` — an ONNX-direct, cross-platform provider.

## Provider contract

1. Add the identifier to `BackendId` and add a `BackendDescriptor` in
   `electron/providers/descriptors.ts`.

   This file is imported by both Electron and React, so it must remain pure:
   no Node, Electron, filesystem, or process imports. The descriptor drives
   labels, the header menu, Settings, per-filter overrides, model filtering,
   and import controls.

   Set the capability flags truthfully:

   - `requiresEngineBuild`: `true` only when models must be converted before
     inference.
   - `runsOnnxDirectly`: `true` when the provider loads portable `.onnx`
     models.
   - `importPrecisions`, `supportsShapes`, and `supportsCustomBuildParams`:
     these control the model-import UI.
   - `vsmlrtBackendAttr`: the `vsmlrt.Backend` attribute custom `.vkfilter`
     scripts use, for example `NCNN_VK` or `ORT_DML`.

2. Create `electron/providers/<id>.ts` implementing `InferenceProvider` from
   `electron/providers/types.ts`.

   It must provide:

   - `resolveModelFile`: map stored model paths to the file the runtime loads.
     ONNX-direct providers must recover the matching `.onnx` file when passed
     an old TensorRT `.engine` path.
   - `modelCallCode`: emit valid VapourSynth Python which assigns the result to
     `clip`.
   - `pipPackages`: the exact Python distributions, including intentionally
     separate version pins when upstream releases differ.
   - `pluginHealthPaths`: the installed native-plugin path(s) used to declare
     the provider healthy. Use `PATHS` getters for platform-specific names.
   - `createBuildJob`: only for engine-building providers.

3. Register the provider in `electron/providers/registry.ts`. The `providers`
   record is exhaustive, so TypeScript will force this step.

## Installation and platform policy

Provider code says *what a backend needs*. `electron/vendorPackages.ts` says
*which backends a machine gets*.

Update all three functions together when adding a backend:

- `getBackendsForVendor(vendor, platform)` — available/default backends by GPU
  vendor and operating system. Put the preferred backend first; first-run
  selection uses that order.
- `getBackendPipPackages` — derived from the provider registry; normally needs
  no independent package list.
- `getCheckPackageNames` — derived from installed provider packages; keep it
  aligned so incomplete installations trigger repair.

Do not treat every non-Windows platform as Linux. Write explicit `win32`,
`linux`, and (if supported) `darwin` policy. Confirm the upstream wheel
availability, architecture, glibc/macOS requirements, native plugin filename,
and runtime-driver requirements before exposing a backend.

When a backend is unavailable on a platform, enforce that policy in both
places:

- `src/utils/backends.ts` filters choices presented by the renderer.
- settings, imported workflows, queue items, and per-filter overrides must be
  migrated or rejected before script generation. Hiding a menu option alone
  does not make a saved backend safe.

## Generated VPy and filter templates

`electron/scriptGenerator.ts` writes the backend helper into
`{{BACKEND_HELPER}}` in `include/vapoursynth_template.vpy`, before
`{{FILTERS}}`. The helper is generated from every descriptor, so a valid
`vsmlrtBackendAttr` automatically makes `vk_backend(...)` support the new
provider.

For each bundled `.vkfilter` that uses AI inference:

1. Check the upstream filter’s supported backends and actual argument names.
2. Use `vk_backend(...)` when it accepts a `vsmlrt.Backend` object.
3. Where a filter accepts backend strings instead, explicitly map the app
   backend. Do not assume that a library supporting TensorRT and DirectML also
   supports NCNN.
4. Gate or provide a safe fallback for CUDA-only filters. A stock template must
   not hardcode `device="cuda"` on a non-NVIDIA installation.
5. Update both `include/plugins/plugin_filters/` and the deployed development
   copy only when the latter is deliberately tracked for the current task.

## Verification checklist

Before merging a provider:

- Research the provider from its official PyPI/GitHub documentation; verify
  wheels, supported OS/architectures, Python floor, plugin paths, and the exact
  VapourSynth call signature.
- Add unit tests in `electron/vendorPackages.test.ts` for each supported
  vendor/platform package set.
- Add a `electron/scriptGenerator.test.ts` assertion for the generated
  `Backend.<attribute>` helper and provider-specific model call code.
- Run `npm run test:electron`, `npm test`, and `npm run build`.
- On every claimed platform, perform a fresh install followed by a real-frame
  render through the provider. Run at least one bundled AI model and each
  backend-sensitive stock filter.
- Test upgrade behavior with a stored old default backend, a per-filter
  override, and an imported workflow. Ensure unavailable providers cannot
  generate a script.

Do not call a new platform/backend combination supported until the fresh
install and real-frame smoke test have run on that platform.
