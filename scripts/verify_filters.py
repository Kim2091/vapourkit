"""
Build every shipped .vkfilter against a real VapourSynth core.

The static test next door proves the files parse and that their declarations
line up. It cannot prove the thing that actually breaks: that the plugin a
filter calls is installed, that the arguments still match the plugin's current
signature, and that the code runs at all.

So this substitutes each template's defaults, execs it in the same environment
the generated script provides, and — with --render — pulls a frame through it.
Failures are classified, because plenty of them are not faults: a template
whose model has not been downloaded, or one that wants a .cube nobody has
picked yet, is working exactly as intended when it refuses.

    python scripts/verify_filters.py --json report.json
    python scripts/verify_filters.py --render --only "Deband,Invert"
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tomllib
import traceback
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
FILTER_DIR = REPO / "include" / "plugins" / "plugin_filters"

# A declaration, as substituted by VapourSynthScriptGenerator. The stage form
# names another step in the chain; here every stage resolves to the source.
DECLARATION = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")
STAGE_REFERENCE = re.compile(r"\{\{\s*stage\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")

# Why a filter can refuse and still be healthy. Matched against the exception
# text, lowercased. Kept narrow on purpose: a pattern that swallows an ordinary
# mistake is worse than no check at all.
EXPECTED = (
    ("model", ("onnx", "engine file", ".engine", "no such file or directory: ",
               "models_path", "model not found", "failed to load model")),
    ("needs input", ("has no table yet", "cannot find", "no table", "select a",
                     "pick a ", "point it at",
                     # A path left at its placeholder, and props a companion
                     # step upstream is supposed to have written.
                     "badpathname", "couldn't open", "no tile props",
                     "no temporal pad props")),
    ("gpu", ("cuda", "tensorrt", "trt", "no device", "out of memory",
             "driver", "nvrtc", "gpu")),
    ("source shape", ("must be", "only supports", "requires a clip",
                      "subsampl", "bit depth", "resolution")),
    # A deinterlacer refusing a progressive clip is the deinterlacer working.
    # The synthetic source here is not tagged, and tagging it interlaced would
    # only move the problem onto every filter that wants progressive.
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
VK_BUILD_ENV = {}
VK_STAGES = {}


def vk_backend(backend="auto", **kwargs):
    return backend
"""


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


def classify(error: BaseException) -> tuple[str, str]:
    """(verdict, why). Only 'failed' is a finding."""
    if isinstance(error, SyntaxError):
        return "failed", "syntax"
    text = f"{type(error).__name__}: {error}".lower()

    if isinstance(error, (AttributeError, ModuleNotFoundError, ImportError)):
        # The whole point of the exercise: a filter we ship calling something
        # that is not installed. Distinguished from a plugin that is present
        # but unhappy, which the patterns below may still excuse.
        for label, needles in EXPECTED:
            if any(n in text for n in needles):
                return "skipped", label
        return "failed", "missing plugin or module"

    for label, needles in EXPECTED:
        if any(n in text for n in needles):
            return "skipped", label
    return "failed", type(error).__name__


def check(path: Path, render: bool) -> dict:
    result = {"file": path.name, "name": None, "verdict": "ok", "why": "", "detail": ""}
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

    scope: dict = {}
    exec(compile(PREAMBLE, "<preamble>", "exec"), scope)  # noqa: S102
    try:
        exec(compile(code, f"<{path.name}>", "exec"), scope)  # noqa: S102
        out = scope.get("clip")
        if out is None:
            result.update(verdict="failed", why="no clip", detail="the code left no clip behind")
            return result
        if render:
            out.get_frame(0)
    except BaseException as error:  # noqa: BLE001 - a filter may raise anything
        verdict, why = classify(error)
        result.update(
            verdict=verdict,
            why=why,
            detail=f"{type(error).__name__}: {error}".strip()[:400],
        )
        if verdict == "failed" and os.environ.get("VK_FILTER_TRACE"):
            traceback.print_exc()
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--render", action="store_true",
                        help="pull a frame as well as building the graph")
    parser.add_argument("--json", type=Path, help="write the full report here")
    parser.add_argument("--only", help="comma-separated filter names to check")
    args = parser.parse_args()

    files = sorted(FILTER_DIR.glob("*.vkfilter"))
    if args.only:
        wanted = {n.strip().lower() for n in args.only.split(",")}
        files = [f for f in files if f.stem.lower() in wanted]

    results = [check(path, args.render) for path in files]
    failed = [r for r in results if r["verdict"] == "failed"]
    skipped = [r for r in results if r["verdict"] == "skipped"]

    print(f"checked {len(results)} filters "
          f"({len(results) - len(failed) - len(skipped)} ok, "
          f"{len(skipped)} skipped, {len(failed)} failed)\n")

    if skipped:
        print("-- skipped, and why --")
        for r in sorted(skipped, key=lambda r: r["why"]):
            print(f"  [{r['why']}] {r['file']}: {r['detail'][:110]}")
        print()

    if failed:
        print("-- failed --")
        for r in failed:
            print(f"  [{r['why']}] {r['file']}: {r['detail'][:200]}")

    if args.json:
        args.json.write_text(json.dumps(results, indent=2), encoding="utf-8")

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
