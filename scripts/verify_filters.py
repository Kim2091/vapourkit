"""
Build every shipped .vkfilter against a real VapourSynth core.

The static test next door proves the files parse and that their declarations
line up. It cannot prove the thing that actually breaks: that the plugin a
filter calls is installed, that the arguments still match the plugin's current
signature, and that the code runs at all.

So this substitutes each template's defaults, execs it in the same environment
the generated script provides, and — with --render — pulls a frame through it.
A refusal is only believed once the filter has been given what it asked for.
A deinterlacer handed progressive frames stops at its first gate, and calling
that "working as intended" leaves everything below the gate unread — it is how
QTGMC shipped calling a plugin that is not installed. So a refusal is answered
rather than filed: an interlaced source for a deinterlacer, an HD one for a
descale whose target is an absolute size, and for a step that wants a companion
above it or a file on disk, the shipped companion template or a real file
written for the purpose. The first, unanswered run still counts — it is what
someone gets who picks the filter on its own, and Load LUT explaining itself in
a sentence is that filter working.

What is left is a fault. A namespace the core does not have is never excused,
however much its name looks like a missing GPU, and neither is a filter that
refuses the ordinary integer clip every source arrives as.

    python scripts/verify_filters.py --json report.json
    python scripts/verify_filters.py --render --only "Deband,Invert"
"""

from __future__ import annotations

import argparse
import json
import os
import re
import struct
import sys
import tempfile
import tomllib
import traceback
import zlib
from pathlib import Path

import vapoursynth as vs

REPO = Path(__file__).resolve().parent.parent
FILTER_DIR = REPO / "include" / "plugins" / "plugin_filters"
# Where the pip-managed half of the runtime lives, as opposed to the bundled
# vs-scripts that templates import and patch.
SITE_PACKAGES = Path(vs.__file__).resolve().parent.parent

# A declaration, as substituted by VapourSynthScriptGenerator. The stage form
# names another step in the chain; here every stage resolves to the source.
DECLARATION = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")
STAGE_REFERENCE = re.compile(r"\{\{\s*stage\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")

# How a refusal is read, matched against the exception text, lowercased. Some
# of these excuse the filter outright; the rest name something the filter was
# asking for, and RETRY and COMPANION/FIXTURE below go and give it to them.
# Kept narrow on purpose, and narrower than it once was: a pattern that
# swallows an ordinary mistake is worse than no check at all, and every class
# here that was written loosely turned out to be hiding a broken filter.
EXPECTED = (
    ("model", ("onnx", "engine file", ".engine", "no such file or directory: ",
               "models_path", "model not found", "failed to load model")),
    ("needs input", ("has no table yet", "cannot find", "no table", "select a",
                     "pick a ", "point it at",
                     # A path left at its placeholder, and props a companion
                     # step upstream is supposed to have written.
                     "badpathname", "couldn't open", "no tile props",
                     "no temporal pad props")),
    # Only the absence of a usable device. A build that fails, or that asks
    # for more memory than the card has, is a finding rather than an excuse:
    # the same run builds TensorRT engines for RIFE and DPIR, so "TensorRT"
    # appearing in an error is no evidence of a machine without one. The loose
    # form of this class — "cuda", "trt", "out of memory", "gpu" anywhere in
    # the text — excused Undistort failing to build at its own default
    # temp_window on an idle 16GB card.
    ("no gpu", ("no device", "no cuda-capable device", "cuda driver",
                "driver version", "nvrtc")),
    # A limit of the fixture, not an opinion of the filter: a descale target is
    # an absolute size and the synthetic source is 320x240. Retried against an
    # HD source, the same way the interlaced case below is.
    #
    # This replaced a much looser "source shape" class that also excused "must
    # be", "bit depth" and "subsampl" anywhere in an error. The app hands every
    # filter the same integer YUV clip modelled above, so a template that
    # refuses that shape refuses it for every user too — Guided Filter did, and
    # the loose class called it healthy.
    ("source too small", ("must be less than or equal to input dimension",)),
    # Not a skip on its own: a filter that says this is retried against an
    # interlaced source (see INTERLACED) and judged on what it does then. The
    # class is kept so the retry has something to trigger on, and so a filter
    # that refuses a second time is still reported as refusing for this reason
    # rather than as a fault.
    ("needs interlaced", ("_fieldbased", "field order", "not interlaced",
                          "fieldbased")),
)

# What the generated script has in scope by the time a filter's code runs.
PREAMBLE = """
import vapoursynth as vs
core = vs.core

# Long enough that a template trimming to its own default frame numbers is
# not mistaken for a broken one. A blank clip costs nothing per frame.
clip = core.std.BlankClip(width=320, height=240, format=vs.YUV420P16,
                          length=10000, fpsnum=24000, fpsden=1001, color=[32768, 32768, 32768])
clip = core.std.SetFrameProps(clip, _Matrix=vs.MATRIX_BT709, _Transfer=vs.TRANSFER_BT709,
                              _Primaries=vs.PRIMARIES_BT709, _ColorRange=vs.RANGE_LIMITED)
original_clip = clip

source_path = ""
default_matrix = "709"
default_primaries = "709"
default_transfer = "709"
default_depth = 16
overwrite_matrix = False
matrix_709 = True
input_format = clip.format.id
output_format = vs.YUV420P8
filter_format = clip.format

VK_BACKEND = "tensorrt"
VK_STAGES = {}

# vsmlrt spawns its engine builder with a nearly empty environment; these are
# what the app's trtexec shim needs to start on Windows.
import os as _os
_root = _os.environ.get("SystemRoot", "C:/Windows")
VK_BUILD_ENV = {"SystemRoot": _root, "COMSPEC": _root + "/System32/cmd.exe"}


# What a template calls to get a vsmlrt Backend for the app-selected backend.
# This mirrors VapourSynthScriptGenerator.generateBackendHelper: the stub that
# stood here returned the string it was handed, which no template could use —
# RIFE and DPIR both raise "unknown backend auto" on it — so every filter that
# calls vk_backend() was being checked against a helper the app never emits.
def vk_backend(backend="auto", **kwargs):
    from vsmlrt import Backend
    backend = VK_BACKEND if backend == "auto" else backend.lower()
    backend = {"tensorrt": Backend.TRT, "directml": Backend.ORT_DML,
               "ncnn": Backend.NCNN_VK}[backend](**kwargs)
    if hasattr(backend, "custom_env"):
        for _key, _value in VK_BUILD_ENV.items():
            backend.custom_env.setdefault(_key, _value)
    return backend
"""

# The generated script also points vsmlrt at the model zoo the app downloads
# and at the trtexec shim it writes, because the pip wheels ship neither. The
# check has to do the same or it is not the environment the app provides:
# without it RIFE and DPIR look under the plugin folder, find nothing, and the
# refusal reads as "the model is not downloaded" while it sits in
# data/vsmlrt-models. Paths follow electron/constants.ts for a dev run.
APP_DATA = REPO / "data"
PREAMBLE += f"""
try:
    import vsmlrt as _vk_vsmlrt
    _vk_vsmlrt.models_path = "{(APP_DATA / 'vsmlrt-models').as_posix()}"
    _vk_vsmlrt.trtexec_path = "{(APP_DATA / ('trtexec.cmd' if sys.platform == 'win32' else 'trtexec')).as_posix()}"
except Exception:
    pass
"""


# The same source, tagged top-field-first. A deinterlacer handed progressive
# frames refuses at its first gate, and that refusal proved nothing about the
# rest of the filter: QTGMC shipped calling a plugin that is not installed,
# because the check never got past TFF detection to find out. So a filter that
# refuses for want of interlaced input is retried against this, and only a
# second refusal is believed.
INTERLACED = """
clip = core.std.SetFrameProps(clip, _FieldBased=vs.FIELD_TOP)
original_clip = clip
"""

# Big enough to descale from. Same format and tagging as the default source.
HD = """
clip = core.resize.Point(clip, width=1920, height=1080)
original_clip = clip
input_format = clip.format.id
filter_format = clip.format
"""

# The source to retry against, per refusal class. A filter that refuses for one
# of these reasons is answered rather than believed, because the refusal lands
# before the rest of the filter has run.
RETRY = {"needs interlaced": INTERLACED, "source too small": HD}

# A filter that reads frame props another step wrote is retried with that step
# run first, out of the shipped template for it. That is the pairing the app
# expects, and the only way past the "did you pass the right clip?" gate.
COMPANION = {
    "Untile.vkfilter": "Tile.vkfilter",
    "Trim _Auto_.vkfilter": "Temporal Pad _Extend_.vkfilter",
}

# A filter that wants a file the user picks is retried pointed at a real one,
# written fresh into a temp directory. The variable named here is the template's
# own, and only its assignment is rewritten.
FIXTURE = {
    "Load LUT.vkfilter": ("lut_path", "identity.cube"),
    "Read Image.vkfilter": ("image_path", "fixture.png"),
}

# A 4x4 identity LUT, and an 8x8 opaque PNG. Both are the smallest thing that
# is unambiguously the real format rather than a stub the reader has to trust.
CUBE = "LUT_3D_SIZE 4\n" + "".join(
    f"{r / 3:.6f} {g / 3:.6f} {b / 3:.6f}\n"
    for b in range(4) for g in range(4) for r in range(4)
)


def png(width: int = 8, height: int = 8) -> bytes:
    """A real 8-bit RGB PNG, built here rather than carried as a base64
    blob no reader can check."""
    row = bytes([0]) + bytes([32, 96, 160] * width)  # filter byte, then RGB

    def chunk(kind: bytes, payload: bytes) -> bytes:
        body = kind + payload
        return (struct.pack(">I", len(payload)) + body
                + struct.pack(">I", zlib.crc32(body)))

    return (bytes([137, 80, 78, 71, 13, 10, 26, 10])
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(row * height, 9))
            + chunk(b"IEND", b""))


ASSIGNMENT = r"^([ \t]*{}[ \t]*=).*$"


def point_at(code: str, variable: str, target: Path) -> str:
    """Rewrite `variable = <placeholder>` to point at a file that exists."""
    pattern = ASSIGNMENT.format(re.escape(variable))
    code, count = re.subn(pattern, lambda m: f"{m.group(1)} {str(target)!r}",
                          code, count=1, flags=re.MULTILINE)
    if not count:
        raise SystemExit(f"verify_filters: no `{variable} =` line left to point at a fixture")
    return code


def render_code(template: dict) -> str:
    """Substitute declarations the way the script generator does."""
    code = (template.get("code") or "").strip()
    code = STAGE_REFERENCE.sub("original_clip", code)
    variables = template.get("variables") or {}

    def one(match: re.Match) -> str:
        key = match.group(1)
        spec = variables.get(key)
        if spec is None:
            return match.group(0)
        value = spec.get("default")
        if isinstance(value, bool):
            return "True" if value else "False"
        if isinstance(value, (int, float)):
            return str(value)
        if isinstance(value, str):
            return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
        return match.group(0)

    return DECLARATION.sub(one, code)


# How the core words it when a namespace is not registered at all. This is the
# whole point of the exercise and is never excusable, so it is matched before
# the patterns above rather than through them: a missing `bm3dcuda` says
# "cuda" and a missing `trt` says "trt", and reading either as "this machine
# has no GPU" is exactly how an uninstalled plugin ships unnoticed.
MISSING_PLUGIN = "did you mistype a plugin namespace or forget to install a plugin"


def classify(error: BaseException) -> tuple[str, str]:
    """(verdict, why). Only 'failed' is a finding."""
    if isinstance(error, SyntaxError):
        return "failed", "syntax"
    text = f"{type(error).__name__}: {error}".lower()

    if MISSING_PLUGIN in text:
        return "failed", "missing plugin or module"

    if isinstance(error, (AttributeError, ModuleNotFoundError, ImportError)):
        # A module that is present but unhappy, which the patterns below may
        # still excuse.
        for label, needles in EXPECTED:
            if any(n in text for n in needles):
                return "skipped", label
        return "failed", "missing plugin or module"

    for label, needles in EXPECTED:
        if any(n in text for n in needles):
            return "skipped", label
    return "failed", type(error).__name__


def build(code: list[str], name: str, render: bool, variant: str) -> tuple[str, str, str]:
    """Run a template, and anything it needs run above it. (verdict, why, detail)."""
    # Every filter gets a fresh view of the bundled scripts. Templates import
    # them, insert onto sys.path, and patch what they find wanting — QTGMC
    # (Old) swaps a `core` out from under qtgmc.py, and several install a
    # stand-in `vsutil` — and all of that otherwise persists in sys.modules for
    # the rest of the process. Leave it there and a verdict starts depending on
    # which filters sorted above it: TFMBobQ inherited QTGMC's shim and named a
    # different missing plugin in a full run than it did on its own.
    #
    # Only the bundled scripts and synthetic stand-ins are evicted, never
    # site-packages: vapoursynth is an extension module and refuses to load
    # twice in one process, and vstools hangs teardown hooks off its own entry
    # in sys.modules.
    before = set(sys.modules)
    search_path = list(sys.path)
    try:
        return _build(code, name, render, variant)
    finally:
        for name_ in set(sys.modules) - before:
            if not _is_installed(sys.modules[name_]):
                del sys.modules[name_]
        sys.path[:] = search_path


def _build(code: list[str], name: str, render: bool, variant: str) -> tuple[str, str, str]:
    scope: dict = {}
    exec(compile(PREAMBLE + RETRY.get(variant, ""), "<preamble>", "exec"), scope)  # noqa: S102
    try:
        for block in code:
            exec(compile(block, f"<{name}>", "exec"), scope)  # noqa: S102
        out = scope.get("clip")
        if out is None:
            return "failed", "no clip", "the code left no clip behind"
        if render:
            # Not just frame 0. A filter that indexes around the playhead —
            # anything comparing against the previous frame, or trimming, or
            # splicing — is fine at the start and wrong at the end, and one
            # frame from the front proves nothing about either edge.
            last = out.num_frames - 1
            for n in dict.fromkeys([0, 1, last // 2, last - 1, last]):
                if 0 <= n <= last:
                    out.get_frame(n)
    except BaseException as error:  # noqa: BLE001 - a filter may raise anything
        verdict, why = classify(error)
        if verdict == "failed" and os.environ.get("VK_FILTER_TRACE"):
            traceback.print_exc()
        return verdict, why, f"{type(error).__name__}: {error}".strip()[:400]
    return "ok", "", ""


def _is_installed(module: object) -> bool:
    """Does this module come from site-packages, rather than vs-scripts?"""
    origin = getattr(module, "__file__", None)
    if not origin:
        return False  # a stand-in a template built by hand
    try:
        return SITE_PACKAGES in Path(origin).resolve().parents
    except OSError:
        return False


def check(path: Path, render: bool, fixtures: Path) -> dict:
    result = {"file": path.name, "name": None, "verdict": "ok", "why": "", "detail": "",
              "source": "default"}
    try:
        template = tomllib.loads(path.read_text(encoding="utf-8"))
    except Exception as error:  # noqa: BLE001
        result.update(verdict="failed", why="unparseable", detail=str(error))
        return result

    result["name"] = template.get("name")
    code = render_code(template)

    # Syntax first and on its own, so a broken template is never mistaken for
    # a missing plugin.
    try:
        compile(code, f"<{path.name}>", "exec")
    except SyntaxError as error:
        result.update(verdict="failed", why="syntax", detail=f"line {error.lineno}: {error.msg}")
        return result

    verdict, why, detail = build([code], path.name, render, variant="")

    # A refusal below is the filter declining the source it was given, and the
    # whole filter below that gate goes unread if it is taken on trust. So give
    # it what it asked for and judge it on that instead. The first run still
    # earns its keep: it is what someone gets who picks the filter on its own,
    # and Load LUT saying so in a sentence is the filter working.
    if why in RETRY:
        result["source"] = why
        verdict, why, detail = build([code], path.name, render, variant=why)
    elif why == "needs input":
        answered, source = answer(path, code, fixtures)
        if answered is not None:
            result["source"] = source
            verdict, why, detail = build(answered, path.name, render, variant="")

    result.update(verdict=verdict, why=why, detail=detail)
    return result


def answer(path: Path, code: str, fixtures: Path) -> tuple[list[str] | None, str]:
    """What this filter was asking for: a step above it, or a file on disk."""
    if path.name in COMPANION:
        companion = FILTER_DIR / COMPANION[path.name]
        above = render_code(tomllib.loads(companion.read_text(encoding="utf-8")))
        return [above, code], f"after {companion.stem}"
    if path.name in FIXTURE:
        variable, filename = FIXTURE[path.name]
        return [point_at(code, variable, fixtures / filename)], f"pointed at {filename}"
    return None, ""


def write_fixtures() -> Path:
    """The files the FIXTURE templates ask the user to pick."""
    into = Path(tempfile.mkdtemp(prefix="vk-filter-fixtures-"))
    (into / "identity.cube").write_text(CUBE, encoding="utf-8")
    (into / "fixture.png").write_bytes(png())
    return into


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--render", action="store_true",
                        help="pull frames from both ends and the middle, as well "
                             "as building the graph")
    parser.add_argument("--json", type=Path, help="write the full report here")
    parser.add_argument("--only", help="comma-separated filter names to check")
    args = parser.parse_args()

    files = sorted(FILTER_DIR.glob("*.vkfilter"))
    if args.only:
        wanted = {n.strip().lower() for n in args.only.split(",")}
        files = [f for f in files if f.stem.lower() in wanted]

    fixtures = write_fixtures()
    results = [check(path, args.render, fixtures) for path in files]
    failed = [r for r in results if r["verdict"] == "failed"]
    skipped = [r for r in results if r["verdict"] == "skipped"]

    print(f"checked {len(results)} filters "
          f"({len(results) - len(failed) - len(skipped)} ok, "
          f"{len(skipped)} skipped, {len(failed)} failed)\n")

    def line(r: dict, width: int) -> str:
        tag = "" if r["source"] == "default" else f" (retried: {r['source']})"
        return f"  [{r['why']}] {r['file']}{tag}: {r['detail'][:width]}"

    if skipped:
        print("-- skipped, and why --")
        for r in sorted(skipped, key=lambda r: r["why"]):
            print(line(r, 110))
        print()

    if failed:
        print("-- failed --")
        for r in failed:
            print(line(r, 200))

    if args.json:
        args.json.write_text(json.dumps(results, indent=2), encoding="utf-8")

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
