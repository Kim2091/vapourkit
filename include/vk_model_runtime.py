"""Model/engine compatibility shared by the builder and VapourSynth runtime.

Engine files are disposable caches. Model packages and saved workflows are not.
No third-party Python adapters or native plugins are downloaded by this module.
"""
import ctypes
from contextlib import contextmanager
import errno
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time

SCHEMA = 1
ADAPTER = 'rgb-window-v1'
# Bump when an existing validated engine becomes incompatible with this adapter.
# Logging/cache helper edits must not invalidate every model's GPU engine.
ENGINE_ABI = 1
_IDENTITY = None


def run_engine_builder(args):
    """The parent stdout is a binary video pipe, never a diagnostic channel.

    Use OS descriptors, not sys.stderr.fileno(): VSScript may replace the
    Python streams with log adapters. Inheriting fd 1 corrupts Matroska even
    when Python's sys.stdout has already been redirected.
    """
    return subprocess.run(args, check=True, timeout=1800, stdout=2, stderr=2)


@contextmanager
def engine_build_lock(engine, timeout=1800):
    """Coordinate preview/validation/render processes; OS releases locks on exit."""
    with open(str(engine) + '.prepare.lock', 'a+b') as stream:
        stream.seek(0, 2)
        if stream.tell() == 0: stream.write(b'\0'); stream.flush()
        deadline = time.monotonic() + timeout
        waiting = False
        while True:
            try:
                stream.seek(0)
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as error:
                if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK): raise
                if not waiting:
                    print('[vk-cache] Waiting for another process to prepare ' + Path(engine).name, file=sys.stderr, flush=True)
                    waiting = True
                if time.monotonic() >= deadline: raise RuntimeError('Timed out waiting for model preparation. Check the other preview/build task.') from error
                time.sleep(0.1)
        try: yield
        finally:
            stream.seek(0)
            if os.name == 'nt': msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else: fcntl.flock(stream, fcntl.LOCK_UN)


def temporal_window(clip, frames):
    if not isinstance(frames, int) or frames < 1 or frames % 2 == 0:
        raise RuntimeError('Centered temporal windows require a positive odd frame count.')
    result = []
    for offset in range(-(frames // 2), frames // 2 + 1):
        if offset < 0:
            count = min(-offset, clip.num_frames)
            shifted = clip[0] * count if count == clip.num_frames else clip[0] * count + clip[:-count]
        elif offset > 0:
            count = min(offset, clip.num_frames)
            shifted = clip[-1] * count if count == clip.num_frames else clip[count:] + clip[-1] * count
        else: shifted = clip
        result.append(shifted)
    return result


def digest(file):
    value = hashlib.sha256()
    with open(file, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def inspect_bindings(source):
    """Resolve exported symbols without rewriting the source model/weights."""
    import onnx
    model = onnx.load(str(source), load_external_data=False)
    def bindings(graph):
        initializers = {tensor.name for tensor in graph.initializer}
        def binding(item):
            value = item.type.tensor_type
            return {'name': item.name, 'dtype': int(value.elem_type),
                    'shape': [int(d.dim_value) if d.HasField('dim_value') else d.dim_param or None for d in value.shape.dim]}
        return ([binding(item) for item in graph.input if item.name not in initializers],
                [binding(item) for item in graph.output])
    ins, outs = bindings(model.graph)
    if any(len(item['shape']) == 4 and not isinstance(item['shape'][1], int) for item in ins + outs):
        try:
            inferred = onnx.shape_inference.infer_shapes(model, check_type=True, strict_mode=False, data_prop=True)
            ins, outs = bindings(inferred.graph)
        except Exception as error:
            raise RuntimeError('Could not resolve ONNX tensor channels using shape inference: ' + str(error)) from error
    return model, ins, outs


def file_stamp(file):
    stat = Path(file).stat()
    return [stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_ino, stat.st_dev]


def cached_digest(file):
    """Reuse integrity checks only while the engine's filesystem identity is unchanged."""
    cache = Path(str(file) + '.vk-integrity.json')
    before = file_stamp(file)
    try:
        saved = json.loads(cache.read_text())
        if saved.get('stamp') == before and isinstance(saved.get('sha256'), str) and len(saved['sha256']) == 64:
            return saved['sha256']
    except (OSError, ValueError, TypeError, AttributeError): pass
    value = digest(file)
    if file_stamp(file) == before:
        stage = Path(str(cache) + '.' + str(os.getpid()) + '.tmp')
        try:
            stage.write_text(json.dumps({'stamp': before, 'sha256': value}))
            os.replace(stage, cache)
        except OSError: pass
        finally:
            try: stage.unlink(missing_ok=True)
            except OSError: pass
    return value


def graph_contract(source):
    import onnx
    model, ins, outs = inspect_bindings(source)
    if len(ins) != 1 or len(outs) != 1 or any(len(item['shape']) != 4 for item in ins + outs):
        raise RuntimeError('This model needs a dedicated tensor-layout adapter; automatic RGB setup supports one NCHW input and output.')
    channels = ins[0]['shape'][1]
    if not isinstance(channels, int):
        raise RuntimeError(f"Input {ins[0]['name']!r} channel dimension is unresolved after ONNX shape inference: {channels!r}. Re-export with a fixed RGB channel count or use a dedicated adapter.")
    if channels < 3 or channels % 3 or (channels // 3) % 2 == 0:
        raise RuntimeError(f"Unsupported RGB temporal layout: input {ins[0]['name']!r} has shape {ins[0]['shape']}. Use an image model or an odd channel-packed RGB window.")
    output_channels = outs[0]['shape'][1]
    if output_channels != 3:
        reason = 'unresolved after ONNX shape inference' if not isinstance(output_channels, int) else 'incompatible with RGB'
        raise RuntimeError(f"Output {outs[0]['name']!r} channel dimension is {reason}: {output_channels!r}; shape {outs[0]['shape']}. The RGB adapter requires three output channels.")
    if any(item['dtype'] not in (1, 10, 16) for item in ins + outs):
        raise RuntimeError('The RGB adapter supports FP32/FP16/BF16 image tensors only.')
    external = set()
    def tensor_files(tensor):
        for item in tensor.external_data:
            if item.key == 'location': external.add(item.value)
    def visit(graph):
        for tensor in graph.initializer: tensor_files(tensor)
        for sparse in graph.sparse_initializer: tensor_files(sparse.values)
        for node in graph.node:
            for attr in node.attribute:
                if attr.type == onnx.AttributeProto.TENSOR: tensor_files(attr.t)
                for tensor in attr.tensors: tensor_files(tensor)
                if attr.type == onnx.AttributeProto.GRAPH: visit(attr.g)
                for child in attr.graphs: visit(child)
    visit(model.graph)
    root = Path(source).resolve().parent
    files = [{'path': str(Path(source).resolve()), 'sha256': digest(source)}]
    for relative in sorted(external):
        file = (root / relative).resolve()
        if not relative or Path(relative).is_absolute() or root not in file.parents or not file.is_file():
            raise RuntimeError('Missing or invalid external weights: ' + relative)
        files.append({'path': str(file), 'sha256': digest(file)})
    metadata_path = Path(str(source) + '.contract.json')
    metadata = json.loads(metadata_path.read_text()) if metadata_path.exists() else {}
    multiple = metadata.get('spatialMultiple', 1)
    if not isinstance(multiple, int) or not 1 <= multiple <= 256: raise RuntimeError('Invalid model spatial multiple.')
    return {'schema': SCHEMA, 'adapter': ADAPTER, 'descriptor': metadata, 'spatialMultiple': multiple, 'inputs': ins, 'outputs': outs, 'files': files,
            'weightTypes': sorted(set(int(t.data_type) for t in model.graph.initializer))}


def runtime_identity():
    global _IDENTITY
    if _IDENTITY is not None: return _IDENTITY
    import tensorrt as trt
    import vapoursynth as vs
    driver = ctypes.CDLL('nvcuda.dll' if os.name == 'nt' else 'libcuda.so.1')
    def checked(code):
        if code: raise RuntimeError('CUDA device inspection failed: ' + str(code))
    checked(driver.cuInit(0))
    device = ctypes.c_int()
    current = driver.cuCtxGetDevice(ctypes.byref(device))
    if current:
        selected = os.environ.get('CUDA_VISIBLE_DEVICES', '0').split(',')[0]
        if selected.isdigit(): checked(driver.cuDeviceGet(ctypes.byref(device), int(selected)))
        else:
            # UUID masks are resolved by the CUDA runtime, not physical ordinals.
            raise RuntimeError('Cannot identify the selected CUDA UUID without an active context. Retry after initializing this GPU.')
    uuid = (ctypes.c_ubyte * 16)()
    checked(driver.cuDeviceGetUuid(ctypes.byref(uuid), device))
    version = ctypes.c_int(); checked(driver.cuDriverGetVersion(ctypes.byref(version)))
    import importlib.metadata
    packages = {}
    for package in ('nvidia-modelopt', 'onnx', 'onnxscript', 'onnx_graphsurgeon', 'onnxruntime'):
        try: packages[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError: packages[package] = 'unavailable'
    plugin = vs.core.trt.Version()
    plugin = {str(k): v.decode(errors='replace') if isinstance(v, bytes) else str(v) for k, v in plugin.items()}
    if plugin.get('path') and Path(plugin['path']).is_file():
        plugin['binarySha256'] = cached_digest(plugin['path'])
    _IDENTITY = {'platform': platform.system(), 'machine': platform.machine(), 'tensorrt': trt.__version__,
                 'gpu': bytes(uuid).hex(), 'cudaDriver': version.value, 'plugin': plugin,
                 'adapter': ADAPTER, 'engineAbi': ENGINE_ABI, 'helper': digest(__file__), 'packages': packages}
    return _IDENTITY


def compatibility_identity(identity):
    """Exclude diagnostics/location, retaining the actual loaded plugin's bytes."""
    result = {k: v for k, v in identity.items() if k != 'helper'}
    result.setdefault('engineAbi', 1)
    if isinstance(result.get('plugin'), dict):
        plugin = dict(result['plugin'])
        location = plugin.pop('path', None)
        if not plugin.get('binarySha256') and location:
            # Upgrade a legacy manifest in place logically, without trusting a
            # different binary merely because its version string is the same.
            if Path(location).is_file(): plugin['binarySha256'] = cached_digest(location)
            else: plugin['unresolvedLegacyPath'] = location
        result['plugin'] = plugin
    return result


def engine_rejection(manifest, contract, identity, shape, precision, engine):
    if not manifest: return 'missing or invalid validation manifest'
    if manifest['contract'] != contract: return 'model source, weights, or adapter contract changed'
    saved, current = compatibility_identity(manifest['runtime']), compatibility_identity(identity)
    if saved != current:
        changed = ', '.join(k for k in sorted(set(saved) | set(current)) if saved.get(k) != current.get(k))
        return 'runtime compatibility changed: ' + changed
    if manifest.get('precision') != precision: return 'requested precision changed'
    try:
        if not covers(manifest['bindings']['inputs'][0], shape): return 'input shape is outside the validated engine profile'
    except (KeyError, TypeError, ValueError, IndexError): return 'invalid engine profile metadata'
    if manifest['engineSha256'] != cached_digest(engine): return 'engine integrity check changed'
    return None


def engine_details(engine_path):
    import tensorrt as trt
    logger = trt.Logger(trt.Logger.ERROR)
    trt.init_libnvinfer_plugins(logger, '')
    runtime = trt.Runtime(logger)
    with open(engine_path, 'rb') as stream: engine = runtime.deserialize_cuda_engine(stream.read())
    if engine is None: raise RuntimeError('TensorRT could not deserialize the built engine with the installed runtime.')
    inputs, outputs = [], []
    for i in range(engine.num_io_tensors):
        name = engine.get_tensor_name(i)
        item = {'name': name, 'shape': list(engine.get_tensor_shape(name)), 'dtype': str(engine.get_tensor_dtype(name))}
        if engine.get_tensor_mode(name) == trt.TensorIOMode.INPUT:
            item['profiles'] = [[list(shape) for shape in engine.get_tensor_profile_shape(name, p)] for p in range(engine.num_optimization_profiles)] if any(n < 0 for n in item['shape']) else []
            inputs.append(item)
        else: outputs.append(item)
    return {'inputs': inputs, 'outputs': outputs}


def covers(binding, shape):
    if len(binding['shape']) != len(shape): return False
    if all(n > 0 for n in binding['shape']): return binding['shape'] == shape
    return any(all(low <= value <= high for low, value, high in zip(profile[0], shape, profile[2])) for profile in binding.get('profiles', []))


def raw_model(clips, engine_path, streams, details):
    import vapoursynth as vs
    data_type = details['inputs'][0]['dtype'].lower()
    if data_type not in ('datatype.float', 'datatype.half', 'float32', 'float16'):
        raise RuntimeError('The engine I/O type is unsupported by the VapourSynth RGB adapter: ' + data_type)
    fmt = vs.RGBS if data_type in ('datatype.float', 'float32') else vs.RGBH
    clips = [vs.core.resize.Point(clip, format=fmt) for clip in clips]
    return vs.core.trt.Model(clips, engine_path=str(engine_path), num_streams=streams)


class EngineValidationError(RuntimeError):
    def __init__(self, kind, report):
        self.kind, self.report = kind, report
        super().__init__('Engine validation failed (' + kind + '): ' + json.dumps(report, sort_keys=True))


def compare_engine_output(actual, expected, shape, input_dtype, output_dtype):
    import numpy as np
    context = {'inputShape': list(shape), 'engineInputType': input_dtype, 'engineOutputType': output_dtype,
               'actualOutputShape': list(actual.shape), 'referenceOutputShape': list(expected.shape)}
    if actual.shape != expected.shape: raise EngineValidationError('shape-mismatch', context)
    if not np.isfinite(actual).all() or not np.isfinite(expected).all():
        raise EngineValidationError('nonfinite-output', context)
    error = np.abs(actual.astype(np.float64) - expected.astype(np.float64))
    tolerance = 0.01 + 0.02 * np.abs(expected)
    worst = np.unravel_index(int(error.argmax()), error.shape)
    context.update(maxAbsoluteError=float(error.max()), meanAbsoluteError=float(error.mean()),
                   worstCoordinate=[int(i) for i in worst], actualAtWorst=float(actual[worst]), referenceAtWorst=float(expected[worst]),
                   mismatchFraction=float(np.mean(error > tolerance)), rtol=0.02, atol=0.01)
    if np.any(error > tolerance): raise EngineValidationError('accuracy-mismatch', context)
    return context


def validate_engine(engine_path, opts):
    """Real plugin inference, not only deserialization or clip metadata."""
    import numpy as np
    import vapoursynth as vs
    details = engine_details(engine_path)
    if opts.get('adapter') != ADAPTER:
        return {'schema': SCHEMA, 'runtime': runtime_identity(), 'bindings': details,
                'engineSha256': digest(engine_path), 'validation': {'execution': [], 'accuracy': 'requires-wrapper-validation'}}
    contract = graph_contract(opts['onnx'])
    if len(details['inputs']) != 1 or len(details['outputs']) != 1: raise RuntimeError('Built engine needs a dedicated multi-tensor adapter.')
    binding = details['inputs'][0]
    shapes = binding['profiles'][0] if binding.get('profiles') else [binding['shape']]
    # Test profile endpoints as well as optimum, exposing invalid shape tactics.
    results = []
    accuracy = {'status': 'not-compared', 'samples': [], 'scope': 'first-profile-shape'}
    reference = None
    try:
        import onnxruntime as ort
        reference = ort.InferenceSession(str(opts['onnx']), providers=['CPUExecutionProvider'])
    except Exception as error:
        accuracy = {'status': 'reference-unavailable', 'reason': str(error)[:1000]}
    input_type = binding['dtype'].lower()
    if input_type not in ('datatype.float', 'datatype.half', 'float32', 'float16'):
        raise RuntimeError('Unsupported engine input type for RGB validation: ' + input_type)
    for shape in sorted(set(tuple(s) for s in shapes)):
        n, channels, height, width = shape
        if n != 1 or channels != contract['inputs'][0]['shape'][1]: raise RuntimeError('Engine profile disagrees with the ONNX RGB contract.')
        clip = vs.core.std.BlankClip(width=width, height=height, format=vs.RGBS, length=3, color=[0.2, 0.4, 0.6])
        # Read the exact planes supplied to TensorRT, after its I/O cast. The
        # original ONNX may expose FP32 while the built engine exposes FP16.
        fmt = vs.RGBH if input_type in ('datatype.half', 'float16') or contract['inputs'][0]['dtype'] == 10 else vs.RGBS
        supplied = vs.core.resize.Point(clip, format=fmt)
        window = [supplied] * (channels // 3)
        output = raw_model(window, engine_path, 1, details)
        for index in (0, 2):
            frame = output.get_frame(index)
            if not all(np.isfinite(np.asarray(frame[p])).all() for p in range(frame.format.num_planes)):
                raise EngineValidationError('nonfinite-output', {'inputShape':list(shape), 'frame':index, 'engineInputType':input_type})
        if reference is not None and not results:
            dtype = np.float16 if contract['inputs'][0]['dtype'] == 10 else np.float32
            data = np.empty(shape, dtype=dtype)
            for index, sample in enumerate(window):
                frame = sample.get_frame(0)
                for plane in range(3): data[0, index * 3 + plane] = np.asarray(frame[plane])
            expected = reference.run([contract['outputs'][0]['name']], {contract['inputs'][0]['name']: data})[0].astype(np.float32)
            frame = output.get_frame(0)
            actual = np.stack([np.asarray(frame[p], dtype=np.float32) for p in range(3)])[None]
            report = compare_engine_output(actual, expected, shape, input_type, details['outputs'][0]['dtype'])
            accuracy['status'] = 'passed'
            accuracy['reference'] = 'onnxruntime-cpu'
            accuracy['samples'].append(report)
        results.append({'input': list(shape), 'output': [output.height, output.width]})
        del output, clip, supplied, window
    return {'schema': SCHEMA, 'contract': contract, 'sourceRelative': os.path.relpath(opts['onnx'], Path(engine_path).parent), 'runtime': runtime_identity(), 'bindings': details,
            'precision': 'fp32' if not (opts['fp16'] or opts['bf16']) else 'bf16' if opts['bf16'] else 'fp16',
            'engineSha256': digest(engine_path), 'validation': {'execution': results, 'accuracy': accuracy}}


def validate_output(output):
    import numpy as np
    for index in (0,):
        frame = output.get_frame(index)
        if not all(np.isfinite(np.asarray(frame[p])).all() for p in range(frame.format.num_planes)):
            raise RuntimeError('The model produced NaN/Inf on the source video. Use a validated higher-precision model/build.')
    return output


_CHECKED = {}
_CONTRACTS = {}

def cached_contract(source):
    def stamp(files):
        result = []
        for file in files:
            p = Path(file)
            if not p.exists(): return None
            s = p.stat(); result.append((str(p), s.st_size, s.st_mtime_ns, s.st_ctime_ns))
        return tuple(result)
    key = str(source.resolve())
    previous = _CONTRACTS.get(key)
    if previous and stamp(previous[0]) == previous[1] and (str(source) + '.contract.json' in previous[0]) == Path(str(source) + '.contract.json').exists(): return previous[2]
    disk = Path(str(source) + '.vk-contract-cache.json')
    helper = digest(__file__)
    try:
        saved = json.loads(disk.read_text())
        known = saved['files']
        if saved['helper'] == helper and known[0] == key and saved['stamp'] == json.dumps(stamp(known)) and saved['descriptor'] == Path(str(source) + '.contract.json').exists():
            contract = saved['contract']
            _CONTRACTS[key] = (known, stamp(known), contract)
            return contract
    except (OSError, ValueError, KeyError, TypeError, IndexError): pass
    contract = graph_contract(source)
    files = [item['path'] for item in contract['files']]
    descriptor = Path(str(source) + '.contract.json')
    if descriptor.exists(): files.append(str(descriptor))
    # Include the descriptor's existence even when the first read had none.
    signature = (stamp(files), descriptor.exists())
    _CONTRACTS[key] = (files, signature[0], contract)
    stage = Path(str(disk) + '.' + str(os.getpid()) + '.tmp')
    try:
        stage.write_text(json.dumps({'helper': helper, 'files': files, 'stamp': json.dumps(signature[0]), 'descriptor': descriptor.exists(), 'contract': contract}))
        os.replace(stage, disk)
    except OSError: pass
    finally:
        try: stage.unlink(missing_ok=True)
        except OSError: pass
    return contract

def read_manifest(file):
    try:
        value = json.loads(Path(file).read_text())
        if not isinstance(value, dict) or value.get('schema') != SCHEMA: return None
        if not isinstance(value.get('runtime'), dict) or not isinstance(value.get('bindings'), dict): return None
        inputs = value['bindings'].get('inputs')
        if not isinstance(inputs, list) or not inputs or not all(isinstance(i, dict) and isinstance(i.get('shape'), list) for i in inputs): return None
        if not isinstance(value.get('engineSha256'), str): return None
        if not isinstance(value.get('contract'), dict): return None
        files = value['contract'].get('files')
        if not isinstance(files, list) or not files or not all(isinstance(f, dict) and isinstance(f.get('path'), str) for f in files): return None
        return value
    except (ValueError, OSError, TypeError): return None


def load_model(clips, engine_path, streams, builder, python, precision='fp16'):
    """Select/rebuild for the actual stage shape before any FFmpeg job starts."""
    supplied_window = isinstance(clips, list)
    clips = clips if supplied_window else [clips]
    first = clips[len(clips) // 2] if supplied_window else clips[0]
    if any((c.width, c.height) != (first.width, first.height) for c in clips): raise RuntimeError('Temporal input dimensions differ.')
    if first.width <= 0 or first.height <= 0: raise RuntimeError('Resize variable-resolution input before this model; fixed stage dimensions are required.')
    original = (first.width, first.height)
    shape = [1, len(clips) * 3, first.height, first.width]
    engine_path = Path(engine_path)
    sidecar = Path(str(engine_path) + '.json')
    manifest = read_manifest(sidecar)
    source = (engine_path.parent / manifest['sourceRelative']).resolve() if manifest and manifest.get('sourceRelative') else Path(manifest['contract']['files'][0]['path']) if manifest and manifest.get('contract') else engine_path.with_suffix('.onnx')
    if not source.is_file() and engine_path.with_suffix('.onnx').is_file(): source = engine_path.with_suffix('.onnx')
    if not source.is_file():
        import re
        source = Path(re.sub(r'_(fp16|fp32|bf16)\.engine$', '.onnx', str(engine_path)))
    if not source.is_file(): raise RuntimeError('This engine has no source ONNX. Import its complete model package to validate or rebuild it.')
    contract = cached_contract(source)
    required_frames = contract['inputs'][0]['shape'][1] // 3
    if len(clips) != required_frames:
        # The generator's VSR list is centered, so its middle clip is the source.
        clips = temporal_window(first, required_frames) if required_frames > 1 else [first]
        shape[1] = required_frames * 3
    contract_key = hashlib.sha256(json.dumps(contract, sort_keys=True).encode()).hexdigest()
    selected_precision = 'bf16' if contract['inputs'][0]['dtype'] == 16 or 16 in contract.get('weightTypes', []) else precision
    check_key = (str(engine_path), tuple(shape), streams, contract_key, selected_precision)
    cached = _CHECKED.get(check_key)
    if cached and Path(cached[0]).exists() and cached_digest(cached[0]) == cached[2]:
        return raw_model(clips, cached[0], streams, cached[1])
    multiple = contract.get('spatialMultiple', 1)
    if first.width % multiple or first.height % multiple:
        import vapoursynth as vs
        right, bottom = (-first.width) % multiple, (-first.height) % multiple
        clips = [vs.core.std.AddBorders(c, right=right, bottom=bottom) for c in clips]
        shape[2:4] = [clips[0].height, clips[0].width]
    if contract['inputs'][0]['shape'][1] != shape[1]: raise RuntimeError('Configured temporal window disagrees with the model. Reimport with automatic detection.')
    expected = contract['inputs'][0]['shape']
    if any(isinstance(n, int) and n > 0 and n != shape[i] for i, n in enumerate(expected)):
        raise RuntimeError('This model has a fixed input shape ' + str(expected) + '; resize/pad before the model or use a dynamic export.')
    identity = runtime_identity()
    reason = engine_rejection(manifest, contract, identity, shape, selected_precision, engine_path) if engine_path.is_file() else 'selected engine does not exist yet'
    if reason is None:
        selected, details = engine_path, manifest['bindings']
    else:
        key = hashlib.sha256(json.dumps([contract, compatibility_identity(identity), shape, selected_precision], sort_keys=True).encode()).hexdigest()[:24]
        cache = source.parent / 'engines'; cache.mkdir(exist_ok=True)
        selected = cache / (source.stem + '-' + key + '.engine')
        metadata = Path(str(selected) + '.json')
        found = None
        # A legacy key or a broader validated profile can be reused. Never
        # broaden profiles here: architecture-specific shape constraints remain.
        alternatives = sorted((p for p in cache.iterdir() if p.name.startswith(source.stem + '-') and p.suffix == '.engine' and p != selected), key=lambda p: p.name)
        rejected = []
        for candidate in [selected, *alternatives]:
            if not candidate.is_file(): continue
            candidate_manifest = read_manifest(str(candidate) + '.json')
            rejection = engine_rejection(candidate_manifest, contract, identity, shape, selected_precision, candidate)
            if rejection is None:
                selected, found = candidate, candidate_manifest
                metadata = Path(str(selected) + '.json')
                break
            if len(rejected) < 3: rejected.append(candidate.name + ': ' + rejection)
        if found is None:
            with engine_build_lock(selected):
                # The process we waited for may already have published it.
                concurrent = read_manifest(metadata) if selected.is_file() else None
                if engine_rejection(concurrent, contract, identity, shape, selected_precision, selected) is not None:
                    print('[vk-cache] Building for ' + source.name + ' at ' + 'x'.join(map(str, shape)) + ': ' + reason + ('. Cached candidates: ' + '; '.join(rejected) if rejected else ''), file=sys.stderr, flush=True)
                    args = [python, '-u', builder, '--onnx=' + str(source), '--saveEngine=' + str(selected),
                            '--shapes=' + contract['inputs'][0]['name'] + ':' + 'x'.join(map(str, shape)), '--builderOptimizationLevel=3', '--vkAdapter=' + ADAPTER]
                    if selected_precision != 'fp32': args.append('--' + selected_precision)
                    run_engine_builder(args)
        found = json.loads(metadata.read_text()); details = found['bindings']
    print('[vk-cache] Using validated engine: ' + str(selected), file=sys.stderr, flush=True)
    if original == (clips[0].width, clips[0].height): _CHECKED[check_key] = (selected, details, cached_digest(selected))
    output = raw_model(clips, selected, streams, details)
    # Force actual source-frame evaluation before the encode process is launched.
    expected_scale = contract.get('descriptor', {}).get('scale')
    if expected_scale and (output.width != clips[0].width * expected_scale or output.height != clips[0].height * expected_scale):
        raise RuntimeError('The model output dimensions disagree with its catalog adapter. Keep the previous model and report this catalog entry.')
    if original != (clips[0].width, clips[0].height):
        import vapoursynth as vs
        right = (clips[0].width - original[0]) * output.width / clips[0].width
        bottom = (clips[0].height - original[1]) * output.height / clips[0].height
        if not right.is_integer() or not bottom.is_integer(): raise RuntimeError('Cannot crop padding for this model output scale.')
        output = vs.core.std.CropRel(output, right=int(right), bottom=int(bottom))
    return output


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] != '--inspect-bindings':
        raise SystemExit('Usage: vk_model_runtime.py --inspect-bindings MODEL.onnx')
    try:
        _, inputs, outputs = inspect_bindings(sys.argv[2])
        print(json.dumps({'inputs': inputs, 'outputs': outputs}))
    except Exception as error:
        print('ONNX shape inspection failed: ' + str(error), file=sys.stderr)
        raise SystemExit(1)
