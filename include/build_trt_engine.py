"""Build TensorRT engines from ONNX models with trtexec-compatible arguments.

TensorRT's pip wheels do not contain trtexec, so VapourKit calls this script for
both explicit model imports and vs-mlrt's runtime engine builds.

On TensorRT 11+ networks are strongly typed: FP16/BF16 has to be expressed in
the ONNX graph, rather than set through a builder flag. The source ONNX graph is
passed to TensorRT unchanged. If a low-precision tactic fails, the builder
learns the relevant ONNX node(s), retries with small FP32 islands, and persists
the learned node blacklist by graph structure.

Supported arguments deliberately mirror the subset of trtexec used by
VapourKit and vs-mlrt:

  --onnx=PATH --saveEngine=PATH
  --shapes/--minShapes/--optShapes/--maxShapes=name:1x3x240x240[,name2:...]
  --fp16 --bf16 --noTF32
  --builderOptimizationLevel=N --timingCacheFile=PATH
  --memPoolSize=workspace:N --workspace=N --device=N --verbose
"""

import hashlib
import json
import os
import sys
import time
from collections import defaultdict
from copy import deepcopy
from pathlib import Path


# A successful final build is required before a learned blacklist is persisted.
# Thirty is intentionally conservative: most models converge in one to a few
# retries, while the structural escalation below avoids trying every repeated
# instance one by one.
MAX_BLACKLIST_RETRIES = 30
SIGNATURE_ESCALATE_AFTER = 2
EXPAND_REGION_ON_REPEAT = True
REGION_HOPS = 1
AUTO_BLACKLIST_AMBIGUOUS = False
PROBE_AVG_TIMING_ITERATIONS = 1
FINAL_AVG_TIMING_ITERATIONS = 4


# trtexec flags that have no build-time equivalent here. Inference-only or
# removed-in-TRT10+ options land in this set so user commands do not fail.
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
    """Parse trtexec shape syntax: name:1x3x240x240[,name2:...]."""
    shapes = {}
    for part in value.split(','):
        part = part.strip()
        if not part:
            continue
        name, _, dims_str = part.rpartition(':')
        if not name or not dims_str:
            raise ValueError(f'Invalid shape specification: {part}')
        shapes[name] = [int(d) for d in dims_str.lower().split('x')]
    return shapes


def parse_size_mib(value):
    """Parse pool sizes like 1024, 1024M, and 8G into MiB."""
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

        key, _, value = arg[2:].partition('=')
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
            # Strongly typed TensorRT takes I/O types from the source ONNX graph.
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

    if opts['fp16'] and opts['bf16']:
        raise ValueError('--fp16 and --bf16 cannot be used together')
    return opts


def requested_shapes(opts):
    """Return the shape set the engine is optimized for."""
    return opts['static_shapes'] or opts['opt_shapes'] or opts['min_shapes'] or opts['max_shapes']


def report_progress(percent):
    print(f'Building engine: {int(percent)}%', flush=True)
    # Parsed by the Electron engine-build protocol while vspipe waits on a
    # runtime build. This avoids the appearance of a frozen preview/export.
    print(f'[vk-build] progress {int(percent)}', flush=True)


def make_progress_monitor(trt):
    """Map TensorRT's hierarchical build phases to a 10-90% progress range."""
    if not hasattr(trt, 'IProgressMonitor'):
        return None

    class BuildProgressMonitor(trt.IProgressMonitor):
        def __init__(self):
            trt.IProgressMonitor.__init__(self)
            self._phases = {}
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
            return True

        def _fraction(self):
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


def format_seconds(seconds):
    seconds = float(seconds)
    if seconds < 60:
        return f'{seconds:.2f}s'
    minutes, sec = divmod(seconds, 60)
    if minutes < 60:
        return f'{int(minutes)}m {sec:.1f}s'
    hours, minutes = divmod(minutes, 60)
    return f'{int(hours)}h {int(minutes)}m {sec:.1f}s'


def atomic_write_bytes(path, data, temporary_suffix='.tmp'):
    """Write complete output before replacing the final file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + temporary_suffix)
    with open(temporary, 'wb') as file:
        file.write(data)
    os.replace(temporary, path)


def _shape_of_value_info(value_info):
    if not value_info.type.HasField('tensor_type'):
        return None
    tensor_type = value_info.type.tensor_type
    if not tensor_type.HasField('shape'):
        return None
    dimensions = []
    for dimension in tensor_type.shape.dim:
        if dimension.HasField('dim_value'):
            dimensions.append(['v', int(dimension.dim_value)])
        elif dimension.HasField('dim_param'):
            dimensions.append(['p', dimension.dim_param])
        else:
            dimensions.append(['?', None])
    return [int(tensor_type.elem_type), dimensions]


def _canonical_attr_for_model_fingerprint(attr):
    # onnx is imported only for low-precision builds, immediately before these
    # helpers are called. Keeping it lazy allows an FP32 build to report missing
    # TensorRT cleanly without importing ONNX unnecessarily.
    attribute_type = attr.type
    if attribute_type == onnx.AttributeProto.FLOAT:
        value = float(attr.f)
    elif attribute_type == onnx.AttributeProto.INT:
        value = int(attr.i)
    elif attribute_type == onnx.AttributeProto.STRING:
        value = bytes(attr.s).hex()
    elif attribute_type == onnx.AttributeProto.FLOATS:
        value = [float(item) for item in attr.floats]
    elif attribute_type == onnx.AttributeProto.INTS:
        value = [int(item) for item in attr.ints]
    elif attribute_type == onnx.AttributeProto.STRINGS:
        value = [bytes(item).hex() for item in attr.strings]
    elif attribute_type == onnx.AttributeProto.TENSOR:
        value = [
            int(attr.t.data_type),
            list(attr.t.dims),
            hashlib.sha256(attr.t.SerializeToString()).hexdigest(),
        ]
    elif attribute_type == onnx.AttributeProto.TENSORS:
        value = [
            [int(item.data_type), list(item.dims), hashlib.sha256(item.SerializeToString()).hexdigest()]
            for item in attr.tensors
        ]
    elif attribute_type == onnx.AttributeProto.GRAPH:
        value = _canonical_graph_for_model_fingerprint(attr.g)
    elif attribute_type == onnx.AttributeProto.GRAPHS:
        value = [_canonical_graph_for_model_fingerprint(graph) for graph in attr.graphs]
    else:
        value = hashlib.sha256(attr.SerializeToString()).hexdigest()
    return [attr.name, int(attribute_type), value]


def _canonical_graph_for_model_fingerprint(graph):
    initializers = [[item.name, int(item.data_type), list(item.dims)] for item in graph.initializer]
    sparse_initializers = [
        [
            item.values.name,
            int(item.values.data_type),
            list(item.values.dims),
            int(item.indices.data_type),
            list(item.indices.dims),
            list(item.dims),
        ]
        for item in graph.sparse_initializer
    ]
    nodes = [
        {
            'name': node.name,
            'domain': node.domain,
            'op': node.op_type,
            'inputs': list(node.input),
            'outputs': list(node.output),
            'attrs': sorted(
                (_canonical_attr_for_model_fingerprint(attr) for attr in node.attribute),
                key=lambda item: item[0],
            ),
        }
        for node in graph.node
    ]
    return {
        'name': graph.name,
        'inputs': [[item.name, _shape_of_value_info(item)] for item in graph.input],
        'outputs': [[item.name, _shape_of_value_info(item)] for item in graph.output],
        'initializers': initializers,
        'sparse_initializers': sparse_initializers,
        'nodes': nodes,
    }


def model_structure_fingerprint(model):
    """Hash graph structure but intentionally exclude initializer values."""
    payload = {
        'ir_version': int(model.ir_version),
        'opsets': sorted((item.domain, int(item.version)) for item in model.opset_import),
        'graph': _canonical_graph_for_model_fingerprint(model.graph),
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


def canonical_attr(attr):
    value = onnx.helper.get_attribute_value(attr)
    if isinstance(value, onnx.TensorProto):
        return [attr.name, 'tensor', int(value.data_type), list(value.dims)]
    if isinstance(value, bytes):
        return [attr.name, value.decode('utf-8', errors='replace')]
    if isinstance(value, (list, tuple)):
        return [attr.name, list(value)]
    if isinstance(value, (int, float, str)):
        return [attr.name, value]
    return [attr.name, str(value)]


def make_graph_index(model):
    """Create the stable node lookup and same-structure grouping used by probes."""
    nodes = [node for node in model.graph.node if node.name]
    by_name = {node.name: node for node in nodes}
    producer = {}
    consumers = defaultdict(list)
    for node in nodes:
        for output in node.output:
            if output:
                producer[output] = node.name
        for input_name in node.input:
            if input_name:
                consumers[input_name].append(node.name)

    initializer_info = {item.name: [int(item.data_type), list(item.dims)] for item in model.graph.initializer}
    shape_info = {}
    for value_info in list(model.graph.input) + list(model.graph.value_info) + list(model.graph.output):
        tensor_type = value_info.type.tensor_type
        if not tensor_type.HasField('shape'):
            continue
        shape = []
        for dimension in tensor_type.shape.dim:
            if dimension.HasField('dim_value'):
                shape.append(int(dimension.dim_value))
            elif dimension.HasField('dim_param'):
                shape.append(dimension.dim_param)
            else:
                shape.append('?')
        shape_info[value_info.name] = shape

    predecessors = defaultdict(set)
    successors = defaultdict(set)
    for node in nodes:
        for input_name in node.input:
            parent = producer.get(input_name)
            if parent:
                predecessors[node.name].add(parent)
                successors[parent].add(node.name)

    signatures = {}
    signature_members = defaultdict(list)
    for node in nodes:
        input_layout = []
        for input_name in node.input:
            if input_name in initializer_info:
                input_layout.append(['init', initializer_info[input_name]])
            else:
                input_layout.append(['data', shape_info.get(input_name)])
        signature = {
            'op': node.op_type,
            'attrs': sorted((canonical_attr(attr) for attr in node.attribute), key=lambda item: item[0]),
            'inputs': input_layout,
            'pred_ops': sorted(by_name[item].op_type for item in predecessors[node.name]),
            'succ_ops': sorted(by_name[item].op_type for item in successors[node.name]),
        }
        key = json.dumps(signature, sort_keys=True, separators=(',', ':'))
        signatures[node.name] = key
        signature_members[key].append(node.name)

    return nodes, by_name, predecessors, successors, signatures, signature_members


def load_blacklist(path, fingerprint, valid_node_names):
    """Return a matching blacklist or None if the cached graph differs."""
    path = Path(path)
    if not path.exists():
        return None
    try:
        lines = path.read_text(encoding='utf-8').splitlines()
    except Exception as error:
        print(f'Warning: could not load TensorRT blacklist {path}: {error}', file=sys.stderr)
        return None

    expected = f'# model_structure_sha256={fingerprint}'
    saved_fingerprint = next(
        (line.strip() for line in lines if line.strip().startswith('# model_structure_sha256=')),
        None,
    )
    if saved_fingerprint != expected:
        return None
    return {
        line.strip()
        for line in lines
        if line.strip() and not line.lstrip().startswith('#') and line.strip() in valid_node_names
    }


def blacklist_path_for(opts, fingerprint, precision):
    """Put reusable per-architecture state beside the generated engine.

    Importing a retrained ONNX under a different file name still reaches this
    cache because the key is its structure fingerprint, not its model name.
    """
    cache_dir = Path(opts['save_engine']).parent / '.vapourkit-trt-blacklists'
    return cache_dir / f'{fingerprint}_{precision}.txt'


def _source_low_precision_types(model):
    low_types = {onnx.TensorProto.FLOAT16, onnx.TensorProto.BFLOAT16}
    found = set()
    for value_info in list(model.graph.input) + list(model.graph.output) + list(model.graph.value_info):
        if value_info.type.HasField('tensor_type') and value_info.type.tensor_type.elem_type in low_types:
            found.add(value_info.type.tensor_type.elem_type)
    for initializer in model.graph.initializer:
        if initializer.data_type in low_types:
            found.add(initializer.data_type)
    for node in model.graph.node:
        for attr in node.attribute:
            if attr.type == onnx.AttributeProto.TENSOR and attr.t.data_type in low_types:
                found.add(attr.t.data_type)
            elif attr.type == onnx.AttributeProto.TENSORS:
                found.update(item.data_type for item in attr.tensors if item.data_type in low_types)
    return found


def prepare_precision_context(source_model, pretyped_source):
    """Prepare the source ONNX graph without an initial precision conversion."""
    started = time.perf_counter()
    model = source_model

    if pretyped_source:
        types = ', '.join(
            onnx.TensorProto.DataType.Name(item) for item in sorted(_source_low_precision_types(model))
        )
        print(
            f'Using existing strongly typed {types} graph; only learned FP32 fallback islands will be inserted.',
            flush=True,
        )
    else:
        print('Using source ONNX graph unchanged.', flush=True)

    index = make_graph_index(model)
    fingerprint = model_structure_fingerprint(model)
    print(
        f'Prepared source graph in {format_seconds(time.perf_counter() - started)}.',
        flush=True,
    )
    return {
        'model': model,
        'pretyped': True,
        'fingerprint': fingerprint,
        'index': index,
    }


def _cast_output_type(node):
    attribute = next((item for item in node.attribute if item.name == 'to'), None)
    return int(attribute.i) if attribute is not None else None


def _promote_pretyped_nodes_to_fp32(base_model, blacklisted_nodes):
    """Wrap selected FP16/BF16 nodes in local FP32 Cast islands."""
    model = deepcopy(base_model)
    if not blacklisted_nodes:
        return model

    float_types = {
        onnx.TensorProto.FLOAT,
        onnx.TensorProto.FLOAT16,
        onnx.TensorProto.BFLOAT16,
    }
    low_types = {onnx.TensorProto.FLOAT16, onnx.TensorProto.BFLOAT16}
    tensor_types = {}
    value_infos = {}
    for value_info in list(model.graph.input) + list(model.graph.value_info) + list(model.graph.output):
        value_infos[value_info.name] = value_info
        if value_info.type.HasField('tensor_type'):
            tensor_types[value_info.name] = value_info.type.tensor_type.elem_type
    for initializer in model.graph.initializer:
        tensor_types[initializer.name] = initializer.data_type

    producer = {}
    for node in model.graph.node:
        for output in node.output:
            if output:
                producer[output] = node
        if node.op_type == 'Cast':
            target_type = _cast_output_type(node)
            for output in node.output:
                if output:
                    tensor_types[output] = target_type
        elif node.op_type == 'Constant':
            attribute = next(
                (item for item in node.attribute if item.type == onnx.AttributeProto.TENSOR),
                None,
            )
            if attribute is not None:
                for output in node.output:
                    if output:
                        tensor_types[output] = attribute.t.data_type

    def tensor_type(name, seen=None):
        if not name:
            return None
        if name in tensor_types:
            return tensor_types[name]
        if seen is None:
            seen = set()
        if name in seen:
            return None
        seen.add(name)
        node = producer.get(name)
        if node is None:
            return None
        if node.op_type == 'Cast':
            return _cast_output_type(node)
        if node.op_type == 'Constant':
            attribute = next(
                (item for item in node.attribute if item.type == onnx.AttributeProto.TENSOR),
                None,
            )
            return attribute.t.data_type if attribute is not None else None
        for input_name in node.input:
            resolved = tensor_type(input_name, seen)
            if resolved in float_types:
                return resolved
        return None

    used_node_names = {node.name for node in model.graph.node if node.name}
    used_tensor_names = set(tensor_types)
    for node in model.graph.node:
        used_tensor_names.update(item for item in node.input if item)
        used_tensor_names.update(item for item in node.output if item)

    def unique_name(base, used):
        name = base
        index = 2
        while name in used:
            name = f'{base}_{index}'
            index += 1
        used.add(name)
        return name

    def add_temp_value_info(source_name, temporary_name, element_type):
        source_value_info = value_infos.get(source_name)
        if source_value_info is None:
            return
        value_info = deepcopy(source_value_info)
        value_info.name = temporary_name
        if value_info.type.HasField('tensor_type'):
            value_info.type.tensor_type.elem_type = element_type
        model.graph.value_info.append(value_info)
        value_infos[temporary_name] = value_info
        tensor_types[temporary_name] = element_type

    rebuilt = []
    for original_node in model.graph.node:
        if original_node.name not in blacklisted_nodes:
            rebuilt.append(original_node)
            continue

        node = deepcopy(original_node)
        pre_casts = []
        post_casts = []
        changed = False
        input_types = [tensor_type(item) for item in original_node.input]
        fallback_output_type = next((item for item in input_types if item in float_types), None)

        for input_index, input_name in enumerate(list(node.input)):
            input_type = input_types[input_index]
            if input_type not in low_types:
                continue
            cast_output = unique_name(f'{input_name}__{node.name}_to_fp32', used_tensor_names)
            cast_name = unique_name(f'{node.name}__input{input_index}_to_fp32', used_node_names)
            pre_casts.append(
                onnx.helper.make_node(
                    'Cast', [input_name], [cast_output], name=cast_name, to=onnx.TensorProto.FLOAT
                )
            )
            node.input[input_index] = cast_output
            add_temp_value_info(input_name, cast_output, onnx.TensorProto.FLOAT)
            changed = True

        for output_index, output_name in enumerate(list(node.output)):
            if not output_name:
                continue
            output_type = tensor_type(output_name) or fallback_output_type
            if output_type not in low_types:
                continue
            fp32_output = unique_name(f'{output_name}__{node.name}_fp32', used_tensor_names)
            node.output[output_index] = fp32_output
            add_temp_value_info(output_name, fp32_output, onnx.TensorProto.FLOAT)
            cast_name = unique_name(f'{node.name}__output{output_index}_to_low', used_node_names)
            post_casts.append(
                onnx.helper.make_node(
                    'Cast', [fp32_output], [output_name], name=cast_name, to=output_type
                )
            )
            changed = True

        if not changed:
            raise RuntimeError(
                f'Could not create an FP32 fallback island for {node.name!r}: no '
                'FP16/BF16 input or output type could be resolved.'
            )
        rebuilt.extend(pre_casts)
        rebuilt.append(node)
        rebuilt.extend(post_casts)

    del model.graph.node[:]
    model.graph.node.extend(rebuilt)
    onnx.checker.check_model(model)
    return model


def convert_model_in_memory(context, blacklisted_nodes):
    """Return a type-consistent ONNX graph without writing a temporary model."""
    started = time.perf_counter()
    mixed_model = _promote_pretyped_nodes_to_fp32(context['model'], blacklisted_nodes)
    return mixed_model, time.perf_counter() - started, set(blacklisted_nodes)


def _shape_options_given(opts):
    return bool(opts['static_shapes'] or opts['min_shapes'] or opts['opt_shapes'] or opts['max_shapes'])


def _configure_shape_profile(builder, network, config, opts):
    dynamic_inputs = [
        network.get_input(index)
        for index in range(network.num_inputs)
        if any(dimension < 0 for dimension in network.get_input(index).shape)
    ]
    if not dynamic_inputs:
        if _shape_options_given(opts):
            dims = 'x'.join(str(item) for item in network.get_input(0).shape)
            raise RuntimeError(
                'Static model does not take explicit shapes since the shape of '
                f'inference tensors will be determined by the model itself [{dims}]'
            )
        return

    optimized_shapes = requested_shapes(opts)
    missing = [tensor.name for tensor in dynamic_inputs if tensor.name not in optimized_shapes]
    if missing:
        raise RuntimeError(
            'Dynamic ONNX input(s) need an --optShapes or --shapes entry: ' + ', '.join(missing)
        )

    profile = builder.create_optimization_profile()
    for tensor in dynamic_inputs:
        optimized = optimized_shapes[tensor.name]
        minimum = opts['min_shapes'].get(tensor.name, optimized)
        maximum = opts['max_shapes'].get(tensor.name, optimized)
        try:
            result = profile.set_shape(tensor.name, minimum, optimized, maximum)
        except (TypeError, ValueError) as error:
            raise RuntimeError(
                f'Invalid optimization profile for {tensor.name!r}: '
                f'min={minimum}, opt={optimized}, max={maximum}. TensorRT says: {error}'
            ) from error
        if result is False:
            raise RuntimeError(
                f'Invalid optimization profile for {tensor.name!r}: '
                f'min={minimum}, opt={optimized}, max={maximum}.'
            )
    config.add_optimization_profile(profile)


def _configure_builder(builder, network, opts, trt, average_timing_iterations, timing_cache_bytes):
    config = builder.create_builder_config()
    if opts['optimization_level'] is not None:
        config.builder_optimization_level = opts['optimization_level']
    if opts['workspace_mib'] is not None:
        config.set_memory_pool_limit(
            trt.MemoryPoolType.WORKSPACE,
            int(opts['workspace_mib'] * (1 << 20)),
        )
    if hasattr(config, 'avg_timing_iterations'):
        config.avg_timing_iterations = average_timing_iterations
    if opts['no_tf32'] and hasattr(trt.BuilderFlag, 'TF32'):
        config.clear_flag(trt.BuilderFlag.TF32)
    _configure_shape_profile(builder, network, config, opts)

    timing_cache = None
    if timing_cache_bytes is not None:
        timing_cache = config.create_timing_cache(timing_cache_bytes)
        config.set_timing_cache(timing_cache, ignore_mismatch=False)

    monitor = make_progress_monitor(trt)
    if monitor is not None:
        config.progress_monitor = monitor
    return config, timing_cache


def _read_timing_cache(path):
    if not path or not os.path.exists(path):
        return b''
    try:
        with open(path, 'rb') as file:
            return file.read()
    except OSError as error:
        print(f'Warning: failed to read timing cache {path}: {error}', file=sys.stderr)
        return b''


def _write_timing_cache(path, timing_cache_bytes):
    if path is None or timing_cache_bytes is None:
        return
    try:
        atomic_write_bytes(path, timing_cache_bytes)
    except OSError as error:
        print(f'Warning: failed to save timing cache: {error}', file=sys.stderr)


def report_parse_errors(parser):
    for index in range(parser.num_errors):
        print(f'ONNX parse error: {parser.get_error(index)}', file=sys.stderr)


def build_from_memory(builder, onnx_bytes, opts, trt, logger, average_timing_iterations, timing_cache_bytes, want_engine):
    """Parse and build an ONNX graph entirely in RAM."""
    network = builder.create_network(
        1 << int(trt.NetworkDefinitionCreationFlag.STRONGLY_TYPED)
    )
    parser = trt.OnnxParser(network, logger)
    if not parser.parse(onnx_bytes):
        report_parse_errors(parser)
        raise RuntimeError('TensorRT could not parse the generated mixed-precision ONNX model.')

    config, timing_cache = _configure_builder(
        builder,
        network,
        opts,
        trt,
        average_timing_iterations,
        timing_cache_bytes,
    )
    logger.clear()
    report_progress(10)
    started = time.perf_counter()
    serialized_engine = builder.build_serialized_network(network, config)
    elapsed = time.perf_counter() - started
    logs = list(logger.messages)
    updated_timing_cache = (
        bytes(timing_cache.serialize()) if timing_cache is not None else timing_cache_bytes
    )
    success = serialized_engine is not None
    engine_bytes = bytes(serialized_engine) if success and want_engine else None
    del serialized_engine, timing_cache, config, parser, network
    return success, logs, updated_timing_cache, engine_bytes, elapsed


def failure_is_blacklistable(logs):
    text = '\n'.join(message for _, message in logs).lower()
    non_precision_failures = (
        'out of memory',
        'cuda error',
        'cudnn_status_alloc_failed',
        'insufficient workspace',
        'workspace size',
        'misaligned address',
        'illegal memory access',
    )
    if any(item in text for item in non_precision_failures):
        return False, 'failure looks like memory, workspace, or CUDA trouble'

    precision_hints = (
        'no matching rules found for input operand types',
        'could not infer output types for operation',
        'could not find any implementation for node',
        'could not find any implementation',
        'no tactic available',
        'no tactics to implement operation',
        'skipping tactic',
        'unsupported datatype',
        'unsupported data type',
    )
    if any(item in text for item in precision_hints):
        return True, ''
    return False, 'failure does not look like an unsupported low-precision tactic or type'


def rank_failure_nodes(logs, original_nodes, trt):
    scores = {}
    errors = [
        message
        for severity, message in logs
        if severity in (trt.ILogger.INTERNAL_ERROR, trt.ILogger.ERROR)
    ] or [message for _, message in logs]

    for message in errors:
        lower = message.lower()
        weight = 10
        if 'no matching rules found' in lower or 'could not infer output types' in lower:
            weight = 500
        elif 'skipping tactic' in lower and 'exception' in lower:
            weight = 300
        elif 'could not find any implementation' in lower or 'no tactic available' in lower:
            weight = 100

        for node in original_nodes:
            score = 100000 if f'// {node.name}' in message else 0
            if node.name in message:
                score += weight
            for output in node.output:
                if output and output in message:
                    score += max(1, weight // 4)
            if score:
                scores[node.name] = scores.get(node.name, 0) + score
    return sorted(scores.items(), key=lambda item: (-item[1], item[0]))


def neighborhood(name, node_by_name, predecessors, successors, hops):
    seen = {name}
    frontier = {name}
    for _ in range(hops):
        nearby = set()
        for item in frontier:
            nearby.update(predecessors.get(item, ()))
            nearby.update(successors.get(item, ()))
        nearby -= seen
        seen |= nearby
        frontier = nearby
    seen.discard(name)
    shape_only_ops = {
        'Constant', 'Shape', 'Gather', 'GatherElements', 'Unsqueeze', 'Squeeze',
        'Reshape', 'Concat', 'Slice', 'Expand', 'Tile',
    }
    return [item for item in seen if node_by_name[item].op_type not in shape_only_ops]


def make_capture_logger(trt, verbose):
    """Capture TensorRT diagnostics for retry decisions without hiding warnings."""

    class CaptureLogger(trt.ILogger):
        _rank = {
            trt.ILogger.INTERNAL_ERROR: 0,
            trt.ILogger.ERROR: 1,
            trt.ILogger.WARNING: 2,
            trt.ILogger.INFO: 3,
            trt.ILogger.VERBOSE: 4,
        }

        def __init__(self):
            trt.ILogger.__init__(self)
            self.messages = []
            self.print_severity = trt.ILogger.INFO if verbose else trt.ILogger.WARNING

        def clear(self):
            self.messages.clear()

        def log(self, severity, message):
            if self._rank.get(severity, 99) <= self._rank[trt.ILogger.INFO]:
                self.messages.append((severity, message))
            if self._rank.get(severity, 99) <= self._rank.get(self.print_severity, 99):
                labels = {
                    trt.ILogger.INTERNAL_ERROR: 'F',
                    trt.ILogger.ERROR: 'E',
                    trt.ILogger.WARNING: 'W',
                    trt.ILogger.INFO: 'I',
                    trt.ILogger.VERBOSE: 'V',
                }
                print(f'[TRT] [{labels.get(severity, "?")}] {message}', flush=True)

    return CaptureLogger()


def save_engine(path, engine_bytes):
    print('Serializing engine', flush=True)
    atomic_write_bytes(path, engine_bytes, temporary_suffix='.building')
    print(f'Engine saved to {path}', flush=True)


def build_low_precision_engine(opts, trt):
    """Run the TensorRT capability-probe loop without converting the source ONNX."""
    global onnx
    import onnx

    logger = make_capture_logger(trt, opts['verbose'])
    trt.init_libnvinfer_plugins(logger, '')
    precision = 'bf16' if opts['bf16'] else 'fp16'

    print(f'Loading ONNX model once: {opts["onnx"]}', flush=True)
    source_model = onnx.load(opts['onnx'], load_external_data=True)
    onnx.checker.check_model(source_model)
    source_low_types = _source_low_precision_types(source_model)
    pretyped_source = bool(source_low_types)

    context = prepare_precision_context(source_model, pretyped_source)
    (
        original_nodes,
        node_by_name,
        predecessors,
        successors,
        node_signature,
        signature_members,
    ) = context['index']
    if not node_by_name:
        raise RuntimeError(
            'The ONNX graph has no named nodes, so TensorRT failures cannot be mapped '
            'to safe FP32 fallback islands.'
        )

    cached_blacklist_path = blacklist_path_for(opts, context['fingerprint'], precision)
    cached_blacklist = load_blacklist(
        cached_blacklist_path,
        context['fingerprint'],
        set(node_by_name),
    )
    builder = trt.Builder(logger)
    report_progress(5)

    def final_build(onnx_bytes):
        print(f'Building final {precision.upper()} TensorRT engine...', flush=True)
        timing_cache_bytes = _read_timing_cache(opts['timing_cache_file']) if opts['timing_cache_file'] else None
        success, logs, updated_cache, engine_bytes, elapsed = build_from_memory(
            builder,
            onnx_bytes,
            opts,
            trt,
            logger,
            FINAL_AVG_TIMING_ITERATIONS,
            timing_cache_bytes,
            want_engine=True,
        )
        if not success:
            can_blacklist, reason = failure_is_blacklistable(logs)
            detail = 'a blacklistable precision failure' if can_blacklist else reason
            raise RuntimeError(
                f'Final {precision.upper()} TensorRT build failed ({detail}); no engine or '
                'blacklist was written.'
            )
        save_engine(opts['save_engine'], engine_bytes)
        _write_timing_cache(opts['timing_cache_file'], updated_cache)
        print(f'Final build completed in {format_seconds(elapsed)}.', flush=True)
        report_progress(100)

    if cached_blacklist is not None:
        print(
            f'Using learned TensorRT {precision.upper()} blacklist with '
            f'{len(cached_blacklist)} FP32 fallback node(s); skipping capability probes.',
            flush=True,
        )
        mixed_model, conversion_seconds, effective_high = convert_model_in_memory(context, cached_blacklist)
        mixed_onnx = mixed_model.SerializeToString()
        del mixed_model
        print(
            f'Recreated mixed ONNX in {format_seconds(conversion_seconds)} '
            f'({len(effective_high)} effective FP32 node(s)).',
            flush=True,
        )
        final_build(mixed_onnx)
        return 0

    blacklisted_nodes = set()
    failed_nodes_by_signature = defaultdict(set)
    probe_timing_cache = b''
    final_onnx = None
    effective_high = set()
    conversion_total = 0.0
    probe_total = 0.0

    def add_nodes(names, reason):
        new_nodes = sorted(
            {name for name in names if name in node_by_name and name not in blacklisted_nodes}
        )
        if not new_nodes:
            return 0
        blacklisted_nodes.update(new_nodes)
        print(f'{reason}: added {len(new_nodes)} FP32 fallback node(s).', flush=True)
        for name in new_nodes[:12]:
            print(f'  {node_by_name[name].op_type:18s} {name}', flush=True)
        if len(new_nodes) > 12:
            print(f'  ... and {len(new_nodes) - 12} more', flush=True)
        return len(new_nodes)

    for attempt in range(1, MAX_BLACKLIST_RETRIES + 1):
        print(
            f'TensorRT {precision.upper()} capability probe {attempt}/{MAX_BLACKLIST_RETRIES}...',
            flush=True,
        )
        mixed_model, conversion_seconds, effective_high = convert_model_in_memory(
            context,
            blacklisted_nodes,
        )
        conversion_total += conversion_seconds
        probe_onnx = mixed_model.SerializeToString()
        del mixed_model
        success, logs, probe_timing_cache, _, build_seconds = build_from_memory(
            builder,
            probe_onnx,
            opts,
            trt,
            logger,
            PROBE_AVG_TIMING_ITERATIONS,
            probe_timing_cache,
            want_engine=False,
        )
        probe_total += build_seconds
        if success:
            print(
                f'Capability probe succeeded in {format_seconds(build_seconds)}; '
                'reusing its generated ONNX for the final build.',
                flush=True,
            )
            final_onnx = probe_onnx
            break

        can_blacklist, reason = failure_is_blacklistable(logs)
        if not can_blacklist:
            raise RuntimeError(
                f'{precision.upper()} capability probe failed, but not from a safe '
                f'precision fallback case: {reason}.'
            )
        candidates = rank_failure_nodes(logs, original_nodes, trt)
        if not candidates:
            raise RuntimeError(
                'TensorRT reported a low-precision failure, but it could not be mapped '
                'back to a named ONNX node safely.'
            )

        print('Likely failing ONNX nodes:', flush=True)
        for name, score in candidates[:5]:
            status = ' [already FP32]' if name in effective_high else ''
            print(f'  score={score:6d}  {node_by_name[name].op_type:18s}  {name}{status}', flush=True)

        clear_direct_match = candidates[0][1] >= 100000
        clear_score_lead = len(candidates) == 1 or candidates[0][1] >= candidates[1][1] * 2
        if not clear_direct_match and not clear_score_lead and not AUTO_BLACKLIST_AMBIGUOUS:
            raise RuntimeError(
                'TensorRT named multiple equally likely failing nodes; refusing to guess an '
                'FP32 fallback island automatically.'
            )

        failing_node = candidates[0][0]
        if failing_node in effective_high and EXPAND_REGION_ON_REPEAT:
            nearby = neighborhood(
                failing_node,
                node_by_name,
                predecessors,
                successors,
                REGION_HOPS,
            )
            if add_nodes(
                nearby,
                f'Repeated failure around an FP32 node; expanding its {REGION_HOPS}-hop island',
            ):
                continue
            raise RuntimeError(
                'TensorRT repeatedly failed around an already FP32 fallback island, with '
                'no additional useful neighboring nodes to promote.'
            )

        signature = node_signature[failing_node]
        failed_nodes_by_signature[signature].add(failing_node)
        add_nodes(
            [failing_node],
            f'Exact-node fallback ({node_by_name[failing_node].op_type})',
        )
        same_shape_failures = failed_nodes_by_signature[signature]
        if len(same_shape_failures) >= SIGNATURE_ESCALATE_AFTER:
            add_nodes(
                signature_members[signature],
                f'Structural fallback after {len(same_shape_failures)} equivalent failures',
            )
    else:
        raise RuntimeError(
            f'{precision.upper()} still failed after {MAX_BLACKLIST_RETRIES} capability probes.'
        )

    if final_onnx is None:
        raise RuntimeError('Internal error: the successful TensorRT probe did not retain its ONNX bytes.')
    print(
        f'Probe totals: {format_seconds(probe_total)} TensorRT build time, '
        f'{format_seconds(conversion_total)} ONNX conversion time.',
        flush=True,
    )
    final_build(final_onnx)
    blacklist_text = (
        f'# model_structure_sha256={context["fingerprint"]}\n'
        + '\n'.join(sorted(blacklisted_nodes))
        + '\n'
    )
    atomic_write_bytes(cached_blacklist_path, blacklist_text.encode('utf-8'))
    print(
        f'Saved learned {precision.upper()} TensorRT blacklist with '
        f'{len(blacklisted_nodes)} node(s): {cached_blacklist_path}',
        flush=True,
    )
    return 0


def build_direct_engine(opts, trt, legacy_precision_flags):
    """Build FP32 or TensorRT <= 10 engines without low-precision probing."""
    log_level = trt.Logger.INFO if opts['verbose'] else trt.Logger.WARNING
    logger = trt.Logger(log_level)
    report_progress(0)
    builder = trt.Builder(logger)
    if legacy_precision_flags:
        network = builder.create_network(0)
    else:
        network = builder.create_network(
            1 << int(trt.NetworkDefinitionCreationFlag.STRONGLY_TYPED)
        )
    parser = trt.OnnxParser(network, logger)
    print(f'Parsing ONNX model: {opts["onnx"]}', flush=True)
    if not parser.parse_from_file(opts['onnx']):
        report_parse_errors(parser)
        return 1
    report_progress(5)

    config, timing_cache = _configure_builder(
        builder,
        network,
        opts,
        trt,
        FINAL_AVG_TIMING_ITERATIONS,
        _read_timing_cache(opts['timing_cache_file']) if opts['timing_cache_file'] else None,
    )
    if legacy_precision_flags and (opts['fp16'] or opts['bf16']):
        if opts['bf16'] and hasattr(trt.BuilderFlag, 'BF16'):
            config.set_flag(trt.BuilderFlag.BF16)
        else:
            config.set_flag(trt.BuilderFlag.FP16)
        for index in range(network.num_inputs):
            tensor = network.get_input(index)
            if tensor.dtype == trt.float32:
                tensor.dtype = trt.float16
        for index in range(network.num_outputs):
            tensor = network.get_output(index)
            if tensor.dtype == trt.float32:
                tensor.dtype = trt.float16

    report_progress(10)
    serialized_engine = builder.build_serialized_network(network, config)
    if serialized_engine is None:
        print('Error: TensorRT engine build failed (see log above)', file=sys.stderr)
        return 2
    engine_bytes = bytes(serialized_engine)
    save_engine(opts['save_engine'], engine_bytes)
    if timing_cache is not None:
        _write_timing_cache(opts['timing_cache_file'], bytes(timing_cache.serialize()))
    report_progress(100)
    return 0


def build(opts):
    import tensorrt as trt

    legacy_precision_flags = hasattr(trt.BuilderFlag, 'FP16')
    # TensorRT 11's strongly typed path needs graph conversion for requested
    # reduced precision. It also deliberately probes already typed FP16/BF16
    # graphs, where the only possible action is adding local FP32 fallback
    # islands around TensorRT-incompatible nodes.
    if not legacy_precision_flags and (opts['fp16'] or opts['bf16']):
        return build_low_precision_engine(opts, trt)
    return build_direct_engine(opts, trt, legacy_precision_flags)


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

    # Must happen before TensorRT initializes CUDA for --device to take effect.
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

    label = os.path.splitext(os.path.basename(opts['onnx']))[0]
    print(f'[vk-build] begin Building TensorRT engine: {label}', flush=True)
    try:
        return build(opts)
    except Exception as error:
        print(f'Error: TensorRT engine build failed: {error}', file=sys.stderr)
        return 1
    finally:
        print(f'[vk-build] end {label}', flush=True)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
