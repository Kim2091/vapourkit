"""
vk_runtime.py - the fixed Python every generated Vapourkit script imports.

VapourSynthScriptGenerator writes only what depends on the workflow: the
source, the steps and their settings. Everything that is the same in every
script lives here, and the generated script calls configure() once, before
its filter chain, with the values the app chose for this run. The app copies
this file into data/config/ beside preview_server.py, and
scripts/verify_filters.py imports the same file, so a filter is checked
against the helpers the app actually runs.

Helpers take what they work on as arguments. The script's own globals
(original_clip, vk_source, the template's colour settings) are passed in at
the call site, so a call sees exactly the values bound at that point of the
script.
"""

import os
import shutil
import sys
from fractions import Fraction

import vapoursynth as vs

_backend = "tensorrt"
_backend_attrs = {}
_build_env = {}


def configure(backend, backend_attrs, build_env, models_path, trtexec_path, migraphx_driver_path=None):
    """
    Records the app's choices for vk_backend() and points vsmlrt at the files
    the app provides.

    backend         the app-selected backend id, which "auto" resolves to
    backend_attrs   backend id -> vsmlrt Backend attribute, from the app's registry
    build_env       environment seeded into a backend's custom_env; vsmlrt
                    builds TensorRT engines by spawning trtexec with a nearly
                    empty environment, and these are what the app's trtexec
                    shim needs to start
    models_path     the vsmlrt model zoo the app downloads (the pip wheels
                    ship no models folder)
    trtexec_path    the app's trtexec shim (pip TensorRT ships no trtexec)
    migraphx_driver_path
                    the migraphx-driver to run; when None it is
                    $VK_MIGRAPHX_DRIVER, then migraphx-driver on PATH, then
                    $ROCM_PATH/bin (the ROCm chosen in Settings names its own
                    driver, so one from another ROCm cannot pair with its
                    libraries)
    """
    global _backend, _backend_attrs, _build_env
    _backend = backend
    _backend_attrs = dict(backend_attrs)
    _build_env = dict(build_env)
    try:
        import vsmlrt
        vsmlrt.models_path = models_path
        vsmlrt.trtexec_path = trtexec_path
        # vsmlrt looks for migraphx-driver in a vsmlrt-hip folder beside the
        # first vs-mlrt plugin it finds, which a pip install doesn't have.
        vsmlrt.migraphx_driver_path = migraphx_driver_path or (
            os.environ.get("VK_MIGRAPHX_DRIVER")
            or shutil.which("migraphx-driver")
            or os.path.join(os.environ.get("ROCM_PATH", "/opt/rocm"), "bin", "migraphx-driver"))
    except Exception:
        pass


def vk_backend(backend="auto", **kwargs):
    """
    A vsmlrt Backend for the app-selected backend, or for the one named.
    Custom filters call this so they follow the backend dropdown; kwargs pass
    through (e.g. fp16=True).
    """
    from vsmlrt import Backend
    backend = _backend if backend == "auto" else backend.lower()
    backend = {key: getattr(Backend, attr) for key, attr in _backend_attrs.items()}[backend](**kwargs)
    if hasattr(backend, "custom_env"):
        for key, value in _build_env.items():
            backend.custom_env.setdefault(key, value)
    # vsmlrt runs migraphx-driver with custom_env as its WHOLE environment,
    # so an empty one leaves HIP without PATH, HOME or its cache folders.
    if type(backend).__name__ == "MIGX":
        for key, value in os.environ.items():
            backend.custom_env.setdefault(key, value)
    return backend


def vk_migx_model(clips, network_path, input_name="input", fp16=True, num_streams=1):
    """
    Runs an ONNX model through vsmigx, which the MIGraphX provider's model step
    calls. vsmigx runs programs compiled for one input size, so one is compiled
    at the clip's resolution on first use - through vsmlrt's own
    migraphx_driver(), which caches it beside the ONNX keyed by size,
    precision, MIGraphX version, GPU and model checksum - and the compile is
    announced with the [vk-build] protocol so the app shows a banner.

    The clip is prepared in the float format of the model's import precision,
    but vsmigx demands the program's I/O type, so on a mismatch the call is
    retried once in the other float format.
    """
    import vsmlrt
    core = vs.core
    clips = clips if isinstance(clips, list) else [clips]
    width, height = clips[0].width, clips[0].height
    program = dict(network_path=network_path, opt_shapes=(width, height), fp16=fp16,
                   fast_math=True, exhaustive_tune=False, device_id=0, short_path=None)
    compiled = os.access(vsmlrt.get_mxr_path(**program), os.R_OK)
    label = f"Compiling MIGraphX program: {os.path.basename(network_path)} at {width}x{height}"
    if not compiled:
        print(f"[vk-build] begin {label}", file=sys.stderr, flush=True)
    try:
        mxr = vsmlrt.migraphx_driver(channels=sum(c.format.num_planes for c in clips), input_name=input_name,
                                     custom_env=dict(os.environ), **program)
    finally:
        if not compiled:
            print(f"[vk-build] end {label}", file=sys.stderr, flush=True)
    try:
        return core.migx.Model(clips, mxr, num_streams=num_streams)
    except vs.Error as error:
        # "sample type mismatch" / "bytes per sample mismatch"
        if "sample" not in str(error) or "mismatch" not in str(error):
            raise
        bits = 32 if clips[0].format.bits_per_sample == 16 else 16
        clips = [core.resize.Point(c, format=c.format.replace(bits_per_sample=bits)) for c in clips]
        return core.migx.Model(clips, mxr, num_streams=num_streams)


def vk_paired_by_time(ref, like, first=0, offset=0, *, source):
    """
    `ref`, a picture from another timeline, lined up by time with `like`, the
    clip at the step reading it.

    Another video is another release of the same footage, and two releases
    rarely share a frame rate, so frames are paired by time, not by number.
    Each frame of `like` gets the frame of `ref` nearest its timestamp,
    counted from `first` - where the reading chain's segment starts, in the
    frames of `source`, the script's original_clip - then moved by `offset`
    frames of `ref`. Past either end the nearest frame is held. A clip with
    no constant frame rate is paired by number.
    """
    core = vs.core
    if offset >= ref.num_frames:
        raise ValueError("The reference offset %d is past its end; it has %d frames." % (offset, ref.num_frames))
    last = ref.num_frames - 1
    if source.fps_num and like.fps_num and ref.fps_num:
        start = Fraction(first) / source.fps

        def _at(n):
            return offset + int((start + Fraction(n) / like.fps) * ref.fps + Fraction(1, 2))
    else:
        def _at(n):
            return offset + first + n
    timing = {"fpsnum": like.fps_num, "fpsden": like.fps_den} if like.fps_num else {}
    base = core.std.BlankClip(ref, length=like.num_frames, **timing)
    return core.std.FrameEval(base, lambda n: ref[min(max(_at(n), 0), last)])


def vk_reference_video(path, offset, like, first=0, *, source):
    """A video file named as a step's picture, paired by time with `like`."""
    if not os.path.isfile(path):
        raise ValueError("The reference video " + path + " is not there any more. Pick it again.")
    return vk_paired_by_time(vs.core.bs.VideoSource(source=path, cachemode=3), like, first, offset, source=source)


def vk_open_video(path, settings):
    """
    A side chain's source, prepared the way the template prepares the main
    one: the same colour tagging when the app overwrites it, then the same
    16-bit YUV working format, so every filter meets the same kind of picture
    in either chain. `settings` is the script's globals(); the template's own
    settings are read from it, with its defaults when a customised template
    does not define one.
    """
    core = vs.core
    if not os.path.isfile(path):
        raise ValueError("The side chain video " + path + " is not there any more. Choose it again on its Load Video step.")
    v = core.bs.VideoSource(source=path, cachemode=3)
    matrix = settings.get("default_matrix", "709")
    primaries = settings.get("default_primaries", "709")
    transfer = settings.get("default_transfer", "709")
    if settings.get("overwrite_matrix", False) and v.format.color_family != vs.RGB:
        if settings.get("matrix_709", True):
            v = core.std.SetFrameProps(v, _Matrix=vs.MATRIX_BT709, _Transfer=vs.TRANSFER_BT709, _Primaries=vs.PRIMARIES_BT709, _ColorRange=vs.RANGE_LIMITED)
        else:
            v = core.std.SetFrameProps(v, _Matrix=vs.MATRIX_ST170_M, _Transfer=vs.TRANSFER_BT601, _Primaries=vs.PRIMARIES_ST170_M, _ColorRange=vs.RANGE_LIMITED)
    fmt = core.query_video_format(vs.YUV, vs.INTEGER, settings.get("default_depth", 16), v.format.subsampling_w, v.format.subsampling_h)
    if v.format.id != fmt.id:
        if v.format.color_family == vs.RGB:
            v = core.resize.Point(v, format=fmt.id, primaries_in_s="709", transfer_in_s="709", matrix_s=matrix, primaries_s=primaries, transfer_s=transfer)
        else:
            v = core.resize.Point(v, format=fmt.id, matrix_in_s=matrix, primaries_in_s=primaries, transfer_in_s=transfer)
    return v


def vk_conform(ref, source, speed, sections, framing=()):
    """
    An aligned side chain's video, put on the timeline of `source` (the main
    source as loaded, before any trim): frame n is the moment at main frame n,
    by the mapping align_videos.py measured (reference time = speed * main
    time + the offset of that time's section). Each framing (from, left, top,
    width, height) is the part of the video, as fractions of it, that shows
    the whole main frame; it is cut out and drawn at the video's own size, so
    the picture sits where the main one does.
    """
    core = vs.core
    w, h = ref.width, ref.height
    framed = [(start, core.resize.Bicubic(ref, w, h, src_left=left * w, src_top=top * h, src_width=fw * w, src_height=fh * h))
              for start, left, top, fw, fh in framing] or [(0, ref)]
    if not (source.fps_num and ref.fps_num):
        return framed[0][1]
    src_fps, ref_fps, last = float(source.fps), float(ref.fps), ref.num_frames - 1

    def _pick(n):
        t = n / src_fps
        offset = sections[0][1]
        for start, value in sections:
            if t >= start:
                offset = value
        picture = framed[0][1]
        for start, c in framed:
            if t >= start:
                picture = c
        return picture[min(max(int((speed * t + offset) * ref_fps + 0.5), 0), last)]

    base = core.std.BlankClip(ref, length=source.num_frames, fpsnum=source.fps_num, fpsden=source.fps_den)
    return core.std.FrameEval(base, _pick)


def vk_stage_missing(message):
    """Raised by a step reading a picture that is not there to read."""
    raise ValueError(message)


def _read_timecodes(path):
    """The frame start times, in milliseconds, of a timecodes v2 file; [] when it cannot be read."""
    try:
        with open(path, encoding="utf-8") as f:
            return [float(line) for line in f if line.strip() and not line.startswith("#")]
    except (OSError, ValueError):
        return []


def _frame_rate_varies(times):
    """
    Whether the frame durations in `times` vary by more than container rounding:
    a frame differs from the median duration by more than 10% of it, or by more
    than 1.5 ms, whichever is larger. A Matroska file stores times in whole
    milliseconds, so a constant 23.976 fps there has 41 and 42 ms frames.
    """
    durations = sorted(b - a for a, b in zip(times, times[1:]))
    if len(durations) < 2:
        return False
    median = durations[len(durations) // 2]
    tolerance = max(1.5, 0.1 * median)
    return durations[0] < median - tolerance or durations[-1] > median + tolerance


def vk_interpolated_timing(clip, source, multi):
    """
    Gives each frame of `clip`, made by interpolating `source` `multi` times
    (frames k*multi to k*multi + multi - 1 from source frame k onwards), an
    equal share of source frame k's duration. Interpolators set one constant
    rate, which would flatten a variable frame rate source. A fractional
    `multi` makes a constant rate on purpose, and `clip` is returned as it is.
    """
    if int(multi) != multi or multi < 2:
        return clip
    timing = vs.core.std.Interleave([source] * int(multi))
    return vs.core.std.CopyFrameProps(clip, timing, props=["_DurationNum", "_DurationDen"])


def vk_timed_output(clip, source_fps, timecodes):
    """
    The script's output clip, written with each frame's own duration when the
    source has a variable frame rate.

    `timecodes` is the file BestSource wrote for the source and `source_fps`
    the rate BestSource gave the source clip, which for a variable frame rate
    file is its average. vspipe writes per-frame timestamps only for a clip
    with no constant rate, so the output is marked as variable. That happens
    only while the output rate is a whole multiple of the source's (as it is
    after RIFE or a bob deinterlacer); a step that sets another rate, such as
    AssumeFPS or a decimation, asks for a constant one. Frames with no
    duration, such as the source's last, get the average one. A line starting
    [vk-timing] on stderr tells the app the result.
    """
    core = vs.core
    times = _read_timecodes(timecodes)
    if not _frame_rate_varies(times) or not clip.fps_num or not source_fps:
        return clip
    durations = [b - a for a, b in zip(times, times[1:])]
    low, high = 1000 / max(durations), 1000 / max(min(durations), 1e-3)
    ratio = clip.fps / source_fps
    if ratio.denominator != 1:
        print(f"[vk-timing] cfr The source has a variable frame rate ({low:.3f} to {high:.3f} fps); "
              f"the steps set a constant {float(clip.fps):.3f} fps, which the output keeps.", file=sys.stderr, flush=True)
        return clip
    print(f"[vk-timing] vfr average_rate={clip.fps_num}/{clip.fps_den} The source has a variable frame rate "
          f"({low:.3f} to {high:.3f} fps); the output keeps each frame's timestamp.", file=sys.stderr, flush=True)
    average = (clip.fps_den, clip.fps_num)

    def _fill(n, f):
        if f.props.get("_DurationNum", 0) > 0 and f.props.get("_DurationDen", 0) > 0:
            return f
        f = f.copy()
        f.props["_DurationNum"], f.props["_DurationDen"] = average
        return f

    clip = core.std.ModifyFrame(clip, clip, _fill)
    variable = core.std.Splice([clip, core.std.BlankClip(clip, length=1, fpsnum=0, fpsden=1)], mismatch=True)
    return variable[:clip.num_frames]
