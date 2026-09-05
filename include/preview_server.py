"""
preview_server.py — the warm preview session behind the in-app previewer.

One of these runs for as long as the preview panel is open. It executes a
script produced by VapourSynthScriptGenerator with generatePreviewOutputs set,
which registers the untouched source as output 0 and one output after every
enabled filter. Selecting a step in the UI is therefore just choosing an output
index; VapourSynth shares the upstream work between them on its own.

It deliberately EXECUTES the generated script rather than re-implementing its
head. Copying the template's source open into this file is how the preview
drifts away from the render again, which is the bug this whole feature exists
to fix.

Protocol
--------
stdin   one JSON object per line, each with a "cmd" and a "seq".
stdout  binary only. Every reply is

            uint32 big-endian header length
            header, UTF-8 JSON
            payload, header["bytes"] of raw packed RGB24

        Anything that is not a reply goes to stderr, and stdout is put into
        binary mode on Windows, because a stray print or a CRLF translation in
        the middle of a frame corrupts every frame after it.
"""

from __future__ import annotations

import json
import os
import struct
import sys
import traceback
import types

# stdout is the binary channel and nothing else. Take the real buffer now, then
# point sys.stdout at stderr so that a print() anywhere — ours, a plugin's, or
# the executed script's — cannot land in the middle of a frame.
_out = sys.stdout.buffer
sys.stdout = sys.stderr

if sys.platform == "win32":
    import msvcrt

    msvcrt.setmode(_out.fileno(), os.O_BINARY)
    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)

import vapoursynth as vs  # noqa: E402  (after the stdout swap, on purpose)

core = vs.core

try:
    import numpy as np
except ImportError:  # pragma: no cover - numpy ships with vsmlrt
    np = None


def _stub_vsview() -> None:
    """
    Neutralise `from vsview import set_output` in the generated script.

    vsview's package __init__ imports vsview.main, which pulls in PySide6 — 363
    ms and a Qt dependency, in a process that will never open a window. The
    generated script already has an ImportError fallback that calls
    clip.set_output(i) directly, so standing in for the module here takes the
    path it would take on a machine without vsview installed.

    Output names are dropped along with the import. That is fine: the app built
    the script and already knows the filter list, so it labels the steps itself.
    """
    if "vsview" in sys.modules:
        return

    module = types.ModuleType("vsview")

    def set_output(node, index=0, name=None, **kwargs):  # noqa: ANN001, ANN003
        node.set_output(index)

    module.set_output = set_output  # type: ignore[attr-defined]
    sys.modules["vsview"] = module


class PreviewSession:
    """Holds the executed script, its outputs, and one preview node per size."""

    def __init__(self) -> None:
        self.outputs: dict[int, vs.VideoNode] = {}
        self.selected: int = 0
        # Keyed by (output index, preview width). A resize node rebuilt per
        # frame would throw away the cache it is supposed to be feeding.
        self._preview_nodes: dict[tuple[int, int], vs.VideoNode] = {}
        self._buffer: "np.ndarray | None" = None
        self._buffer_shape: tuple[int, int] | None = None

    # -- lifecycle ---------------------------------------------------------

    def open(self, script_path: str, max_cache_mb: int) -> dict:
        self.close()
        _stub_vsview()

        with open(script_path, "r", encoding="utf-8") as handle:
            source = handle.read()

        script_globals: dict = {
            "__file__": script_path,
            "__name__": "__vapourkit_preview__",
        }
        exec(compile(source, script_path, "exec"), script_globals)  # noqa: S102

        # AFTER the script, never before: the shipped template opens with
        # core.max_cache_size = 15000, and a preview process sitting beside a
        # running queue job has no business asking for a 15 GB ceiling.
        core.max_cache_size = max_cache_mb

        outputs = {}
        for index, output in vs.get_outputs().items():
            clip = getattr(output, "clip", output)
            if isinstance(clip, vs.VideoNode):
                outputs[index] = clip

        if not outputs:
            raise RuntimeError(
                "The script registered no video outputs. It was probably "
                "generated without generatePreviewOutputs."
            )

        self.outputs = outputs
        self.selected = max(outputs)

        return {
            "outputs": [
                {
                    "index": index,
                    "width": clip.width,
                    "height": clip.height,
                    "frames": clip.num_frames,
                    "fpsNum": clip.fps_num,
                    "fpsDen": clip.fps_den,
                    "format": clip.format.name if clip.format else None,
                }
                for index, clip in sorted(outputs.items())
            ],
            "selected": self.selected,
        }

    def close(self) -> None:
        self.outputs = {}
        self._preview_nodes = {}
        self._buffer = None
        self._buffer_shape = None
        vs.clear_outputs()

    # -- frames ------------------------------------------------------------

    def select(self, index: int) -> None:
        if index not in self.outputs:
            raise KeyError(f"No output {index}; have {sorted(self.outputs)}")
        self.selected = index

    def _preview_node(self, index: int, width: int) -> vs.VideoNode:
        key = (index, width)
        cached = self._preview_nodes.get(key)
        if cached is not None:
            return cached

        clip = self.outputs[index]
        target_w, target_h = clip.width, clip.height
        if width and width < clip.width:
            target_w = width - (width % 2)
            target_h = max(2, round(clip.height * target_w / clip.width))
            target_h -= target_h % 2

        kwargs = {"format": vs.RGB24, "width": target_w, "height": target_h}
        if clip.format and clip.format.color_family != vs.RGB:
            # Stated explicitly, matching the deliberate 709 hard-coding in the
            # filter templates rather than trusting whatever a mid-chain filter
            # left in _Matrix.
            kwargs["matrix_in_s"] = "709"

        node = core.resize.Bilinear(clip, **kwargs)
        self._preview_nodes[key] = node
        return node

    def frame(self, n: int, width: int) -> tuple[dict, memoryview]:
        node = self._preview_node(self.selected, width)
        n = max(0, min(n, node.num_frames - 1))

        # One frame, so there is nothing to pipeline: get_frame and
        # get_frame_async cost the same here. The prefetch ring that makes
        # async worth 2.3x arrives with playback.
        frame = node.get_frame(n)
        height, frame_width = node.height, node.width

        payload = self._pack(frame, frame_width, height)
        header = {
            "type": "frame",
            "n": n,
            "width": frame_width,
            "height": height,
            "output": self.selected,
            "bytes": len(payload),
        }
        return header, payload

    def _pack(self, frame: vs.VideoFrame, width: int, height: int) -> memoryview:
        """
        Planar RGB24 out of VapourSynth, packed RGB24 into one reused buffer.

        Measured at 1080p: three bytes() copies cost 2.84 ms/frame, this costs
        1.75 ms. Packing is not a tax here, it is the cheaper path, and it
        keeps the renderer on a single RGB texture.
        """
        if np is None:
            return memoryview(bytes(frame[0]) + bytes(frame[1]) + bytes(frame[2]))

        shape = (height, width)
        if self._buffer is None or self._buffer_shape != shape:
            self._buffer = np.empty((height, width, 3), dtype=np.uint8)
            self._buffer_shape = shape

        for plane in range(3):
            self._buffer[:, :, plane] = np.asarray(frame[plane])

        return memoryview(self._buffer).cast("B")


def reply(header: dict, payload: memoryview | bytes = b"") -> None:
    encoded = json.dumps(header).encode("utf-8")
    _out.write(struct.pack(">I", len(encoded)))
    _out.write(encoded)
    if payload:
        _out.write(payload)
    _out.flush()


def main() -> int:
    session = PreviewSession()

    # readline() rather than `for line in ...`, so a command is acted on the
    # moment its newline arrives instead of whenever an iterator's read-ahead
    # happens to fill.
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue

        try:
            command = json.loads(line)
        except ValueError:
            reply({"type": "error", "seq": -1, "error": "Malformed command"})
            continue

        name = command.get("cmd")
        seq = command.get("seq", -1)

        try:
            if name == "open":
                result = session.open(
                    command["script"],
                    int(command.get("maxCacheMb", 1000)),
                )
                reply({"type": "outputs", "seq": seq, **result})

            elif name == "select":
                session.select(int(command["index"]))
                reply({"type": "ok", "seq": seq, "selected": session.selected})

            elif name == "frame":
                header, payload = session.frame(
                    int(command["n"]),
                    int(command.get("width", 0)),
                )
                reply({**header, "seq": seq}, payload)

            elif name == "ping":
                reply({"type": "ok", "seq": seq})

            elif name == "close":
                session.close()
                reply({"type": "ok", "seq": seq})
                return 0

            else:
                reply({"type": "error", "seq": seq, "error": f"Unknown command {name!r}"})

        except Exception as error:  # noqa: BLE001 - one bad command must not end the session
            traceback.print_exc(file=sys.stderr)
            reply({"type": "error", "seq": seq, "error": f"{type(error).__name__}: {error}"})

    return 0


if __name__ == "__main__":
    sys.exit(main())
