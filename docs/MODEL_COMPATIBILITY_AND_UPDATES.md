# Model preparation and component updates

## Model contracts and preparation

The ONNX inspector now records every tensor input/output, excludes initializer inputs, and finds external weight files, including attribute/subgraph tensors. Generic model import accepts one NCHW RGB output and either a single RGB input or an odd, channel-packed RGB temporal window. Other layouts require a dedicated adapter. Tensor metadata cannot establish colour space, normalization or frame ordering: custom RGB imports remain marked `unverified-rgb`; the import dialog explains the required interpretation. Catalog descriptors declare their adapter explicitly.

Imports preserve the entire model package in a content-addressed folder. Older packages are retained. External weights cannot escape the source folder or collide with another model's weights. The source model remains available when changing inference backends. Shape/type/precision facts are separate; TensorRT's actual I/O determines the VapourSynth format, and BF16 preferences are carried through to preparation.

New TensorRT imports default to **Build for workflow dimensions on first use**. An unbuilt ONNX model can be selected and processed. Preparation occurs before FFmpeg starts, at the dimensions entering that particular model after upstream filters. The original ONNX remains the workflow reference. A manual build is still available for custom settings; prebuilt engines are also checked against the requested stage and rebuilt from their source if necessary.

Catalog spatial constraints are applied by padding to the required multiple, then cropping the scaled padding from the output. The RGB adapter uses zero spatial padding and chronological, centered temporal inputs. Temporal boundaries repeat the first/last frame, including clips shorter than the requested window. Architectures with different padding, colour or state semantics need another adapter version.

## Engine validation and identity

An application model engine is first written as a candidate. Validation deserializes it using TensorRT, inspects its actual bindings/profiles, and runs real frames through the installed VapourSynth TensorRT plugin. Dynamic profile endpoints and optimum are exercised. Non-finite results are rejected. Where the original graph runs through CPU ONNX Runtime, a reference comparison checks a sample using relative tolerance 0.02 and absolute tolerance 0.01. The manifest records execution checks and whether the reference comparison passed or was unavailable. This is a numerical sanity check, not complete visual-quality certification.

Only a validated candidate is published. Previous files are preserved on validation failure, and publication attempts restore the previous pair if replacing the engine/manifest fails. Learned low-precision fallbacks are persisted after validation. Cache identity includes source and external-weight content, adapter metadata, GPU UUID, platform, CUDA driver API version, TensorRT and plugin identity, conversion packages, precision and profiles. Actual source-frame checks run before encoding as well.

Custom wrappers such as RIFE/DPIR retain their own tensor interfaces. Their builder path validates deserialization without forcing an RGB contract; workflow preparation evaluates actual first/early/last output frames through those wrappers before FFmpeg starts. Cached compilation does not certify every frame or every possible GPU condition.

## Curated catalog and updater

Settings → **Models & component updates** loads the bundled/cached catalog and can check the approved upstream catalog endpoint. Entries are checked for platform/GPU compatibility, paths, sizes, hashes and descriptor consistency. Installation requires acceptance. Experimental entries require a separate opt-in.

The initial catalog contains AnimeJaNai HD V3.1 Balanced and Performance, pinned to upstream commit `f97f44cd44326cec64db48c6f00c6fa33dda03e5` with SHA-256 and size checks. Both passed local CPU ONNX Runtime inference at 32×32. They remain **experimental because physical GPU validation is pending**. Their weights are downloaded only when selected, not added to the application bundle.

Component installation stages into a separate version directory and checks available space. A failed download, checksum, descriptor or health test leaves the selected component unchanged. Models are installed alongside existing versions without rewriting saved workflows. FFmpeg, runtime and filter selections take effect on the next process start; the previous selection and files remain available for rollback. Filter overlays replace only known unedited versions; custom templates/edits win. Saved workflows already retain their own filter code.

The updater supports approved file-based FFmpeg, portable Windows runtime and filter bundles. FFmpeg probes both executables and a CPU encode. Runtime bundles must match this app's core/dependency requirements, pass package/core checks and include a model for a local GPU inference smoke test (including an engine build for NVIDIA). Linux system FFmpeg and existing Linux Python environment management remain under their existing installation policy; relocatable Linux venv bundles are deliberately rejected.

**No runtime/FFmpeg/filter bundle is currently offered:** those entries require reviewed, complete artifacts and compatibility validation before publication. Existing pins are retained. The implementation does not independently upgrade pip packages to whatever is newest.

## Upstream discovery and publication

`component-discovery.yml` checks model publishers, inference plugins, filter projects, FFmpeg, CPython and core Python dependencies. It produces a review artifact only: no installations, issues, PRs or catalog edits. The workflow runs on relevant `main` pushes and on a weekly schedule.

To approve a component, review its license and complete artifacts, test supported platforms/GPUs and model fixtures, assign a new immutable component version, add exact file hashes/sizes and a matching adapter, and increment the catalog revision. GPU-dependent candidates must stay experimental until tested. Runtime/library updates can invalidate engines; rebuilding is intentional. A newer architecture with recurrent state, auxiliary tensors or a diffusion pipeline still requires a dedicated integration.

## Validation commands

- `npm run build`
- `npm test`
- `npm run test:electron`
- `npm run test:models` (Python with `onnx`, `onnxruntime`, `numpy`)
- `npm run test:ui` (Playwright; optionally `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`)
- `npm run test:media` (configured FFmpeg/ffprobe/VapourSynth)

The browser smoke test includes experimental opt-in, cancelled acceptance without installation, and accepted installation, alongside existing encoding/filter/batch controls. Python tests exercise real ONNX packages and CPU reference comparisons, with mocked GPU/plugin boundaries. Physical NVIDIA engine execution was not available in the development environment and must not be inferred from these tests.

## Follow-up: Windows helper imports and symbolic channels

The builder explicitly adds its own directory to `sys.path` before importing app helpers. This is necessary under Windows embedded Python's `python313._pth` isolation, including child builders launched during workflow preparation. Helper staging repairs missing/stale application copies. Missing application modules receive application repair guidance rather than plugin reinstall advice.

When channel metadata is symbolic, Electron import, package creation, and catalog validation invoke the same Python shape inspector used by runtime validation. ONNX shape inference resolves channels without rewriting the original graph or external weights. Unresolved/non-RGB layouts remain rejected with the binding name, shape and reason. Existing TensorRT workflows reconcile their saved image/temporal selection against the resolved tensor channels, using the center source frame of a generated temporal window.

`python scripts/testEmbeddedBuilder.py --download` tests the real Windows embeddable CPython configuration without a GPU. It exercises manual/workflow working directories, helper imports in precision caching, and candidate publication with only GPU work stubbed. Linux uses `python scripts/testEmbeddedBuilder.py` with isolation enabled. CI runs both.

`python scripts/testAdoreExport.py --electron` downloads the official Adore FP16 fixture, verifies SHA-256, exercises real Electron inspection and immutable package import, and checks runtime contract resolution and CPU inference. It does not certify TensorRT/GPU execution. The weights are temporary test inputs and are not committed or bundled. Existing unit fixtures additionally reject unresolved and non-RGB output channels.
