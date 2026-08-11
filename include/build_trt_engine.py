"""Builds a TensorRT engine from an ONNX model using the TensorRT Python API.

The TensorRT pip wheels do not ship trtexec, so this script replaces it. It
accepts trtexec-style arguments so existing Vapourkit build commands (including
user-customized ones) keep working:

    --onnx=PATH --saveEngine=PATH
    --shapes/--minShapes/--optShapes/--maxShapes=name:1x3x240x240[,name2:...]
    --fp16 --bf16 --noTF32 --inputIOFormats=fp16:chw --outputIOFormats=fp16:chw
    --builderOptimizationLevel=N --timingCacheFile=PATH
    --memPoolSize=workspace:N --workspace=N --device=N --verbose

Unsupported trtexec flags are ignored with a warning. Progress is printed to
stdout as "Building engine: N%" lines, which the Electron side's progress
parser (modelExtractor) tracks.

Precision handling: TensorRT 11 removed the FP16/BF16 builder flags — networks
are strongly typed and precision comes from the model's own tensor types. When
--fp16 is requested for an fp32 model, the ONNX graph is converted to fp16
in-memory (onnxconverter-common) before parsing, which also gives the engine
fp16 I/O as --inputIOFormats/--outputIOFormats=fp16:chw used to. On older
TensorRT versions that still have the builder flags, the legacy path is used.
"""

import os
import sys

# trtexec flags that have no build-time equivalent here. Inference-only or
# removed-in-TRT10+ options land in this set so user commands don't error.
IGNORED_FLAGS = {
    'useCudaGraph',
    'tacticSources',
    'noDataTransfers',
    'profilingVerbosity',
    'useSpinWait',
    'skipInference',
    'buildOnly',
    'separateProfileRun',
    'warmUp',
    'duration',
    'iterations',
}


def strip_quotes(value):
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
        return value[1:-1]
    return value


def parse_shape_list(value):
    """Parses trtexec shape syntax: name:1x3x240x240[,name2:...]."""
    shapes = {}
    for part in value.split(','):
        part = part.strip()
        if not part:
            continue
        name, _, dims_str = part.rpartition(':')
        if not name:
            raise ValueError(f'Invalid shape specification: {part}')
        shapes[name] = [int(d) for d in dims_str.lower().split('x')]
    return shapes


def parse_size_mib(value):
    """Parses trtexec pool sizes like '1024', '1024M', '8G' into MiB."""
    value = value.strip()
    unit = 1
    if value and value[-1] in 'KkMmGg':
        unit = {'k': 1.0 / 1024, 'm': 1, 'g': 1024}[value[-1].lower()]
        value = value[:-1]
    return float(value) * unit


def parse_args(argv):
    opts = {
        'onnx': None,
        'save_engine': None,
        'min_shapes': {},
        'opt_shapes': {},
        'max_shapes': {},
        'static_shapes': {},
        'fp16': False,
        'bf16': False,
        'no_tf32': False,
        'verbose': False,
        'optimization_level': None,
        'timing_cache_file': None,
        'workspace_mib': None,
        'device': None,
    }

    for raw in argv:
        arg = strip_quotes(raw.strip())
        if not arg.startswith('--'):
            if arg:
                print(f'Warning: ignoring unrecognized argument: {arg}', file=sys.stderr)
            continue

        key, sep, value = arg[2:].partition('=')
        value = strip_quotes(value)

        if key == 'onnx':
            opts['onnx'] = value
        elif key == 'saveEngine':
            opts['save_engine'] = value
        elif key == 'minShapes':
            opts['min_shapes'] = parse_shape_list(value)
        elif key == 'optShapes':
            opts['opt_shapes'] = parse_shape_list(value)
        elif key == 'maxShapes':
            opts['max_shapes'] = parse_shape_list(value)
        elif key == 'shapes':
            opts['static_shapes'] = parse_shape_list(value)
        elif key == 'fp16':
            opts['fp16'] = True
        elif key == 'bf16':
            opts['bf16'] = True
        elif key == 'noTF32':
            opts['no_tf32'] = True
        elif key == 'tf32':
            opts['no_tf32'] = False
        elif key == 'verbose':
            opts['verbose'] = True
        elif key in ('inputIOFormats', 'outputIOFormats'):
            # I/O tensor types follow the (converted) model's precision; the
            # fp16 conversion triggered by --fp16 covers what these flags did.
            pass
        elif key == 'builderOptimizationLevel':
            opts['optimization_level'] = int(value)
        elif key == 'timingCacheFile':
            opts['timing_cache_file'] = value
        elif key == 'memPoolSize':
            for pool in value.split(','):
                pool_name, _, pool_size = pool.partition(':')
                if pool_name.strip().lower() == 'workspace':
                    opts['workspace_mib'] = parse_size_mib(pool_size)
        elif key == 'workspace':
            opts['workspace_mib'] = float(value)
        elif key == 'device':
            opts['device'] = value
        elif key in IGNORED_FLAGS:
            print(f'Note: --{key} has no effect with the TensorRT API builder, ignoring', file=sys.stderr)
        else:
            print(f'Warning: ignoring unsupported trtexec argument: --{key}', file=sys.stderr)

    return opts


def report_progress(percent):
    print(f'Building engine: {int(percent)}%', flush=True)
    # Machine-readable build status for the Vapourkit UI. When this builder runs
    # inside vspipe (vsmlrt engine builds via the trtexec shim), stdout is
    # redirected to vspipe's stderr, where the app's executors parse these
    # lines and show a "building engine" banner instead of an apparent freeze.
    print(f'[vk-build] progress {int(percent)}', flush=True)


def make_progress_monitor(trt):
    """Maps TensorRT's hierarchical build phases onto a 10-90% progress range."""
    if not hasattr(trt, 'IProgressMonitor'):
        return None

    class BuildProgressMonitor(trt.IProgressMonitor):
        def __init__(self):
            trt.IProgressMonitor.__init__(self)
            self._phases = {}  # name -> [num_steps, completed_steps, parent]
            self._last_reported = -1

        def phase_start(self, phase_name, parent_phase, num_steps):
            self._phases[phase_name] = [max(num_steps, 1), 0, parent_phase]

        def phase_finish(self, phase_name):
            self._phases.pop(phase_name, None)

        def step_complete(self, phase_name, step):
            if phase_name in self._phases:
                self._phases[phase_name][1] = step
            percent = 10 + int(self._fraction() * 80)
            if percent > self._last_reported:
                self._last_reported = percent
                report_progress(percent)
            return True  # returning False would cancel the build

        def _fraction(self):
            # Walk the single active phase chain from the root, weighting each
            # nested phase by its parent's step size.
            children = {info[2]: name for name, info in self._phases.items()}
            fraction = 0.0
            scale = 1.0
            name = children.get(None)
            while name is not None:
                num_steps, completed, _ = self._phases[name]
                fraction += scale * (completed / num_steps)
                scale /= num_steps
                name = children.get(name)
            return min(fraction, 1.0)

    return BuildProgressMonitor()


def model_has_float32_inputs(onnx_path):
    import onnx
    model = onnx.load(onnx_path, load_external_data=False)
    initializer_names = {init.name for init in model.graph.initializer}
    for graph_input in model.graph.input:
        if graph_input.name in initializer_names:
            continue
        if graph_input.type.tensor_type.elem_type == onnx.TensorProto.FLOAT:
            return True
    return False


def convert_model_to_fp16(onnx_path):
    """Converts an fp32 ONNX model to fp16 in-memory, returning serialized bytes."""
    import onnx
    from onnxconverter_common import float16

    print('Converting ONNX model to FP16...', flush=True)
    model = onnx.load(onnx_path)
    try:
        converted = float16.convert_float_to_float16(model, keep_io_types=False)
    except Exception as convert_error:
        print(f'Note: fp16 conversion with shape inference failed ({convert_error}), retrying without', file=sys.stderr)
        model = onnx.load(onnx_path)
        converted = float16.convert_float_to_float16(model, keep_io_types=False, disable_shape_infer=True)
    return converted.SerializeToString()


def report_parse_errors(parser):
    for i in range(parser.num_errors):
        print(f'ONNX parse error: {parser.get_error(i)}', file=sys.stderr)


def build(opts):
    import tensorrt as trt

    log_level = trt.Logger.INFO if opts['verbose'] else trt.Logger.WARNING
    logger = trt.Logger(log_level)

    # TensorRT 11 removed the FP16/BF16 builder flags in favor of strongly
    # typed networks, where precision is dictated by the model's tensor types.
    legacy_precision_flags = hasattr(trt.BuilderFlag, 'FP16')

    want_fp16 = opts['fp16'] or opts['bf16']
    if opts['bf16'] and not legacy_precision_flags:
        print('Note: BF16 is not supported with this TensorRT version, building FP16 instead', file=sys.stderr)

    report_progress(0)
    builder = trt.Builder(logger)

    if legacy_precision_flags:
        network = builder.create_network(0)
    else:
        network = builder.create_network(1 << int(trt.NetworkDefinitionCreationFlag.STRONGLY_TYPED))

    parser = trt.OnnxParser(network, logger)

    print(f'Parsing ONNX model: {opts["onnx"]}', flush=True)
    if not legacy_precision_flags and want_fp16 and model_has_float32_inputs(opts['onnx']):
        # Strongly typed + fp16 requested for an fp32 model: convert the graph
        # to fp16 first (this also makes the engine I/O fp16, as the app expects)
        model_bytes = convert_model_to_fp16(opts['onnx'])
        if not parser.parse(model_bytes):
            report_parse_errors(parser)
            return 1
    else:
        if not parser.parse_from_file(opts['onnx']):
            report_parse_errors(parser)
            return 1
    report_progress(5)

    shapes_given = bool(opts['static_shapes'] or opts['min_shapes'] or opts['opt_shapes'] or opts['max_shapes'])
    has_dynamic_inputs = any(
        any(d < 0 for d in network.get_input(i).shape)
        for i in range(network.num_inputs)
    )

    if shapes_given and not has_dynamic_inputs:
        # Same error text as trtexec — the Electron side detects this message
        # (including the [AxBxCxD] shape) and retries without shape arguments.
        dims = 'x'.join(str(d) for d in network.get_input(0).shape)
        print(
            'Error: Static model does not take explicit shapes since the shape of '
            f'inference tensors will be determined by the model itself [{dims}]',
            file=sys.stderr,
        )
        return 1

    config = builder.create_builder_config()

    if legacy_precision_flags:
        if opts['fp16'] or opts['bf16']:
            if opts['bf16'] and hasattr(trt.BuilderFlag, 'BF16'):
                config.set_flag(trt.BuilderFlag.BF16)
            else:
                config.set_flag(trt.BuilderFlag.FP16)
            # trtexec's --inputIOFormats/--outputIOFormats fp16:chw equivalent
            for i in range(network.num_inputs):
                tensor = network.get_input(i)
                if tensor.dtype == trt.float32:
                    tensor.dtype = trt.float16
            for i in range(network.num_outputs):
                tensor = network.get_output(i)
                if tensor.dtype == trt.float32:
                    tensor.dtype = trt.float16
        if opts['no_tf32']:
            config.clear_flag(trt.BuilderFlag.TF32)
    elif opts['no_tf32']:
        print('Note: --noTF32 has no effect with strongly typed networks, ignoring', file=sys.stderr)

    if opts['optimization_level'] is not None:
        config.builder_optimization_level = opts['optimization_level']
    if opts['workspace_mib'] is not None:
        config.set_memory_pool_limit(trt.MemoryPoolType.WORKSPACE, int(opts['workspace_mib'] * (1 << 20)))

    if shapes_given and has_dynamic_inputs:
        profile = builder.create_optimization_profile()
        # Static mode passes a single shape set (via --shapes or --optShapes);
        # dynamic mode passes min/opt/max. Missing bounds fall back to opt.
        opt_shapes = opts['static_shapes'] or opts['opt_shapes'] or opts['min_shapes'] or opts['max_shapes']
        for name, opt_dims in opt_shapes.items():
            min_dims = opts['min_shapes'].get(name, opt_dims)
            max_dims = opts['max_shapes'].get(name, opt_dims)
            profile.set_shape(name, min_dims, opt_dims, max_dims)
        config.add_optimization_profile(profile)

    timing_cache = None
    if opts['timing_cache_file']:
        cache_data = b''
        if os.path.exists(opts['timing_cache_file']):
            with open(opts['timing_cache_file'], 'rb') as f:
                cache_data = f.read()
        timing_cache = config.create_timing_cache(cache_data)
        config.set_timing_cache(timing_cache, ignore_mismatch=False)

    monitor = make_progress_monitor(trt)
    if monitor is not None:
        config.progress_monitor = monitor

    report_progress(10)
    serialized_engine = builder.build_serialized_network(network, config)
    if serialized_engine is None:
        print('Error: TensorRT engine build failed (see log above)', file=sys.stderr)
        return 2

    # Write-then-rename so a killed build never leaves a truncated engine at
    # the final path (a corrupt engine there would be silently reused as a
    # cache hit by vsmlrt and the app and break the filter until deleted).
    print('Serializing engine', flush=True)
    tmp_engine_path = opts['save_engine'] + '.building'
    with open(tmp_engine_path, 'wb') as f:
        f.write(serialized_engine)
    os.replace(tmp_engine_path, opts['save_engine'])

    if timing_cache is not None and opts['timing_cache_file']:
        try:
            with open(opts['timing_cache_file'], 'wb') as f:
                f.write(memoryview(timing_cache.serialize()))
        except Exception as cache_error:  # best-effort — the engine is already saved
            print(f'Warning: failed to save timing cache: {cache_error}', file=sys.stderr)

    report_progress(100)
    print(f'Engine saved to {opts["save_engine"]}', flush=True)
    return 0


def main(argv):
    try:
        opts = parse_args(argv)
    except (ValueError, IndexError) as parse_error:
        print(f'Error: failed to parse arguments: {parse_error}', file=sys.stderr)
        return 1

    if not opts['onnx'] or not opts['save_engine']:
        print('Error: --onnx and --saveEngine are required', file=sys.stderr)
        return 1
    if not os.path.exists(opts['onnx']):
        print(f'Error: ONNX model not found: {opts["onnx"]}', file=sys.stderr)
        return 1

    # Must be set before TensorRT initializes CUDA for --device to take effect.
    if opts['device'] is not None:
        os.environ['CUDA_VISIBLE_DEVICES'] = str(opts['device'])

    try:
        import tensorrt  # noqa: F401
    except ImportError as import_error:
        print(
            f'Error: the TensorRT Python package is not installed ({import_error}). '
            'Reinstall plugins from the Plugins menu.',
            file=sys.stderr,
        )
        return 1

    # Build-status protocol markers (see report_progress). The label is what
    # the app shows to the user while the build runs.
    label = os.path.splitext(os.path.basename(opts['onnx']))[0]
    print(f'[vk-build] begin Building TensorRT engine: {label}', flush=True)
    try:
        result = build(opts)
    finally:
        print(f'[vk-build] end {label}', flush=True)
    return result


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
