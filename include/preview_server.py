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
stdin   one JSON object per line, each with a "cmd" and a "seq". Read on its
        own thread, so a command lands during a slow frame rather than behind
        it — that is what makes a stop mid-playback take milliseconds.
stdout  binary only. Every reply is

            uint32 big-endian header length
            header, UTF-8 JSON
            payload, header["bytes"] of raw packed RGB24

        Anything that is not a reply goes to stderr, and stdout is put into
        binary mode on Windows, because a stray print or a CRLF translation in
        the middle of a frame corrupts every frame after it.

Playback
--------
`play` starts a stream: frames are pushed as `pframe` replies, unasked, until
the credit granted runs out. The renderer returns a credit per frame it
consumes, which is the whole of the flow control — out of credit, this process
blocks on the command queue and the chain goes idle. Frames are requested
ahead through `get_frame_async` so decode, filtering and packing overlap.

A `pframe` carries no levels and no frame props. Both cost milliseconds per
frame and answer questions nobody can read at playing speed; pausing re-asks
for the frame through `frame`, which brings them back.
"""

from __future__ import annotations

import json
import os
import queue
import struct
import sys
import threading
import time
import traceback
import types
from collections import deque
from concurrent.futures import TimeoutError as FutureTimeout

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
        # Frame props of the clip feeding each output, before the conversion
        # to RGB. Cached because they answer a question about the file, which
        # does not change frame to frame.
        self._source_props: dict[int, dict] = {}
        # Keyed by (output index, preview width). A resize node rebuilt per
        # frame would throw away the cache it is supposed to be feeding.
        self._preview_nodes: dict[tuple[int, int], vs.VideoNode] = {}
        self._buffer: "np.ndarray | None" = None
        self._buffer_shape: tuple[int, int] | None = None
        # The one playback stream, if any. A `play` replaces whatever was
        # running, so there is never more than one.
        self.stream: "Stream | None" = None

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
        self.stream = None
        self.outputs = {}
        self._preview_nodes = {}
        self._source_props = {}
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
        # get_frame_async cost the same here. Playback is where the overlap
        # pays, and it has its own ring in Stream.
        frame = node.get_frame(n)
        height, frame_width = node.height, node.width

        payload = self._pack(frame, frame_width, height)
        header = {
            "type": "frame",
            "n": n,
            "width": frame_width,
            "height": height,
            "output": self.selected,
            "levels": self._levels(),
            "source": self._props(self.selected, n),
            "bytes": len(payload),
        }
        return header, payload

    def _levels(self) -> dict | None:
        """
        Where the picture actually sits, per channel, in 8-bit code values.

        Reported alongside the pixels because the question it answers — are
        these blacks raised, and by how much — is otherwise a judgement about
        the height of an unlabelled line on a waveform.

        Percentiles as well as the extremes: one stray hot pixel should not be
        the whole answer for the ceiling.
        """
        if np is None or self._buffer is None:
            return None

        # Every fourth pixel. A floor is a property of the picture, not of the
        # sample rate, and this keeps the cost off the frame budget.
        sample = self._buffer[::2, ::2, :]
        out = {}
        for index, name in enumerate(("r", "g", "b")):
            out[name] = _spread(sample[:, :, index])

        # Luma as well, and it is the one that answers the question. On
        # anything with saturated colour in it, a channel's own floor is set
        # by the primaries rather than by the shadows — pure red pins green
        # and blue at 0 no matter where black sits. The waveform a colourist
        # reads for a black level is luma, so report that too.
        luma = (
            sample[:, :, 0].astype(np.float32) * 0.2126
            + sample[:, :, 1].astype(np.float32) * 0.7152
            + sample[:, :, 2].astype(np.float32) * 0.0722
        )
        out["y"] = _spread(luma)
        return out

    def _props(self, index: int, n: int) -> dict | None:
        """
        The tagging of the clip feeding this output, before RGB conversion.

        This is what tells a raised-blacks complaint apart from a range
        mismatch: a limited-range file read as full lands its floor at 16
        rather than 0, and no amount of grading is the right fix for that.

        The frame is already in VapourSynth's cache from rendering the preview
        that depends on it, so this costs a lookup rather than a render.
        """
        cached = self._source_props.get(index)
        if cached is not None:
            return cached

        try:
            props = self.outputs[index].get_frame(n).props
            resolved = {
                "colorRange": _prop_int(props, "_ColorRange"),
                "matrix": _prop_int(props, "_Matrix"),
                "transfer": _prop_int(props, "_Transfer"),
                "primaries": _prop_int(props, "_Primaries"),
                "format": self.outputs[index].format.name if self.outputs[index].format else None,
            }
        except Exception:  # noqa: BLE001 - a diagnostic must never break the frame
            return None

        self._source_props[index] = resolved
        return resolved

    # -- playback ----------------------------------------------------------

    def _ring_depth(self, index: int, requested: "int | None") -> int:
        """
        How many frames to keep in flight, as a memory budget.

        Every outstanding request pins one frame at every node feeding it, so
        the cost of depth is the whole upstream graph, not one picture. The
        enabled outputs are a fair stand-in for those nodes: they are exactly
        the points the chain was cut at.
        """
        per_frame = 0
        for i, clip in self.outputs.items():
            if i > index:
                continue
            fmt = clip.format
            if fmt is None:
                continue
            for plane in range(fmt.num_planes):
                pw = clip.width >> (fmt.subsampling_w if plane else 0)
                ph = clip.height >> (fmt.subsampling_h if plane else 0)
                per_frame += pw * ph * fmt.bytes_per_sample

        # Enough to keep every worker thread fed, then whatever memory allows.
        ceiling = min(PREFETCH_CEILING, max(MIN_PREFETCH, core.num_threads))
        affordable = ceiling if per_frame <= 0 else int(
            (PREFETCH_BUDGET_MB * 1024 * 1024) // per_frame
        )
        depth = max(MIN_PREFETCH, min(ceiling, affordable))
        if requested:
            depth = min(depth, max(1, int(requested)))
        return depth

    def play(self, ident: int, index: int, start: int, width: int,
             credits: int, prefetch: "int | None" = None) -> dict:
        if index not in self.outputs:
            raise KeyError(f"No output {index}; have {sorted(self.outputs)}")

        node = self._preview_node(index, width)
        start = max(0, min(int(start), node.num_frames - 1))
        depth = self._ring_depth(index, prefetch)

        # Replaces whatever was running. The old ring's futures are dropped
        # rather than awaited: VapourSynth finishes them into its own cache,
        # where a seek back over the same frames will find them.
        self.stream = Stream(ident, index, node, start, depth, max(0, int(credits)))
        return {"stream": ident, "prefetch": depth, "from": start}

    def stop_stream(self, ident: int) -> "int | None":
        stream = self.stream
        if stream is None or stream.id != ident:
            return None
        self.stream = None
        return stream.last_emitted

    def add_credit(self, ident: int, count: int) -> None:
        stream = self.stream
        if stream is not None and stream.id == ident:
            stream.credits += max(0, int(count))

    def stream_ready(self) -> bool:
        """
        True when there is work to push. False means block on the command
        queue — which is what out-of-credit looks like, and it costs nothing.
        """
        return self.stream is not None and self.stream.credits > 0

    def pump(self) -> None:
        """
        Emit at most one frame, or give up quickly so a command can be read.

        Never blocks for long: the caller polls the command queue between
        calls, and that is what lets a stop land in milliseconds on a chain
        taking a second a frame.
        """
        stream = self.stream
        if stream is None:
            return

        if not stream.ring:
            if stream.exhausted:
                self.stream = None
                reply({"type": "end", "stream": stream.id, "n": stream.last_emitted})
            else:
                stream.fill()
            return

        n, future = stream.ring[0]
        started = time.monotonic()
        try:
            frame = future.result(timeout=PUMP_POLL_SECONDS)
        except FutureTimeout:
            # Still rendering. The time still counts against the chain.
            stream.waited += time.monotonic() - started
            return
        except Exception as error:  # noqa: BLE001 - report and end the stream
            traceback.print_exc(file=sys.stderr)
            self.stream = None
            reply({
                "type": "error",
                "stream": stream.id,
                "n": n,
                "error": f"{type(error).__name__}: {error}",
            })
            return

        stream.waited += time.monotonic() - started
        stream.waits += 1
        stream.ring.popleft()
        stream.fill()

        width = stream.node.width
        height = stream.node.height
        payload = self._pack(frame, width, height)
        stream.last_emitted = n
        stream.credits -= 1
        reply({
            "type": "pframe",
            "stream": stream.id,
            "n": n,
            "output": stream.output,
            "width": width,
            "height": height,
            "bytes": len(payload),
        }, payload)

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


# Depth is what makes playback fast, and it is close to linear until the core
# runs out of threads to spend. Measured on a 720x480 chain with a heavy blur,
# pushing as fast as the pipe would take it:
#
#     depth  1  ->   210 fps
#     depth  2  ->   350 fps
#     depth  4  ->   637 fps
#     depth  8  ->  1079 fps
#
# So the ceiling belongs at the number of threads the core will actually use,
# not at some small constant. What bounds it instead is memory: every request
# in flight pins a frame at every node feeding it, and those frames are
# refcounted, so they sit outside `max_cache_size` rather than inside it. An
# over-deep ring does not crash — it evicts the source filter's own cache and
# makes the next seek cold — but it is still real memory, so the budget below
# is what decides depth on a chain with big intermediate formats.
PREFETCH_BUDGET_MB = 512
# Absolute ceiling, whatever the thread count. Past this the ring stops buying
# throughput and starts costing seek latency, because a switch waits for the
# frames already requested.
PREFETCH_CEILING = 32
MIN_PREFETCH = 2
# How long to sit on a frame before going back to look for a command. Short
# enough that a stop or a step switch feels immediate on a slow chain.
PUMP_POLL_SECONDS = 0.02


class Stream:
    """One run of consecutive frames from one output, requested ahead."""

    def __init__(self, ident: int, output: int, node: "vs.VideoNode", start: int,
                 prefetch: int, credits: int) -> None:
        self.id = ident
        self.output = output
        self.node = node
        self.next_n = start
        self.prefetch = prefetch
        self.credits = credits
        self.ring: "deque[tuple[int, object]]" = deque()
        self.last_emitted: int | None = None
        self.waited = 0.0
        self.waits = 0
        self.fill()

    def fill(self) -> None:
        while len(self.ring) < self.prefetch and self.next_n < self.node.num_frames:
            self.ring.append((self.next_n, self.node.get_frame_async(self.next_n)))
            self.next_n += 1

    @property
    def exhausted(self) -> bool:
        return not self.ring and self.next_n >= self.node.num_frames

    @property
    def mean_wait(self) -> float:
        return self.waited / self.waits if self.waits else 0.0


def _spread(plane) -> dict:
    """Floor, ceiling and the 0.1/99.9 percentiles, in 8-bit code values."""
    low, high = np.percentile(plane, (0.1, 99.9))
    return {
        "min": round(float(plane.min()), 1),
        "max": round(float(plane.max()), 1),
        "low": round(float(low), 1),
        "high": round(float(high), 1),
    }


def _prop_int(props, name: str) -> int | None:
    """A frame prop as a plain int, or None when the file does not say."""
    value = props.get(name)
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def reply(header: dict, payload: memoryview | bytes = b"") -> None:
    encoded = json.dumps(header).encode("utf-8")
    _out.write(struct.pack(">I", len(encoded)))
    _out.write(encoded)
    if payload:
        _out.write(payload)
    _out.flush()


def _read_commands(commands: "queue.Queue") -> None:
    """
    stdin, on its own thread.

    readline() rather than `for line in ...`, so a command is acted on the
    moment its newline arrives instead of whenever an iterator's read-ahead
    happens to fill. On a thread because the main loop cannot afford to sit in
    a blocking read while a stream has frames to push — and, the other way
    round, a stop must not queue behind a frame that takes a second to render.
    """
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            commands.put(None)
            return
        line = line.strip()
        if line:
            commands.put(line)


def main() -> int:
    session = PreviewSession()
    commands: "queue.Queue" = queue.Queue()
    threading.Thread(
        target=_read_commands, args=(commands,), daemon=True, name="vk-preview-stdin"
    ).start()

    while True:
        if session.stream_ready():
            # Commands win over frames: a stop, a seek or a step switch must
            # not wait behind the picture it is about to make irrelevant.
            try:
                line = commands.get_nowait()
            except queue.Empty:
                session.pump()
                continue
        else:
            # No stream, or no credit. Blocking here IS the backpressure: the
            # renderer has not consumed what it was sent, so nothing is
            # rendered and nothing is spent until it does.
            line = commands.get()

        if line is None:
            break

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

            elif name == "play":
                result = session.play(
                    int(command["stream"]),
                    int(command["output"]),
                    int(command.get("from", 0)),
                    int(command.get("width", 0)),
                    int(command.get("credits", 0)),
                    command.get("prefetch"),
                )
                reply({"type": "ok", "seq": seq, **result})

            elif name == "stop":
                ident = int(command["stream"])
                reply({
                    "type": "ok",
                    "seq": seq,
                    "stream": ident,
                    "n": session.stop_stream(ident),
                })

            elif name == "credit":
                # Flow control, not a request: no seq, no reply. Replying
                # would put one message per frame back on the return path,
                # which is the cost the push model exists to remove.
                session.add_credit(
                    int(command["stream"]),
                    int(command.get("count", 1)),
                )

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
