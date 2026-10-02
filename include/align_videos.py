"""Find the time mapping between two releases of the same footage.

    python align_videos.py <main video> <reference video>

Prints one JSON object per line: {"progress": 0..1, "message": ...} while it
works, then {"result": {...}} or {"error": "..."} last.

The answer is a speed and one offset per section: reference_time = speed *
main_time + offset, in seconds of each file's own timeline, with offset
changing where a scene was cut or added. `speed` catches a PAL
release's 4% speed-up as well as a plain delay; a constant offset is just
speed 1.

How, and why this way:

* Pictures are compared by their edges, never their levels. Two releases of
  the same footage are graded differently — that is usually why one is being
  matched against the other — but the line art is where it is in both.
  Edges are blurred a little first, so a few pixels of different cropping, or
  a telecined frame's combing, does not count as a different picture.

* One frame is a bad fingerprint: animation holds drawings for two or three
  frames and sits on still shots for seconds. So a moment is matched as three
  frames spread over 0.8 s, and a match only counts when it beats every other
  candidate in its window by a clear margin. Still shots, black frames and
  fades fail that and are left out rather than guessed at.

* Coarse, then fine. A few anchors search wide (±15 s) to find roughly where
  the reference sits; then ~40 samples across the whole video search narrowly
  around that, and a robust straight-line fit through them is the answer.

* Releases are not always the same cut. A scene cut or added moves every
  later moment by the same amount, so samples fall into runs that each agree
  on an offset. Each run is a section; where one ends and the next begins is
  narrowed down to a quarter second by asking which offset fits the frames
  in between. The mapping is then one speed and an offset per section.
"""

from __future__ import annotations

import json
import sys

import numpy as np
import vapoursynth as vs

core = vs.core

THUMB_W, THUMB_H = 128, 96
TRIPLE_SPAN = 0.4          # seconds between the three frames of a fingerprint
COARSE_ANCHORS = 6
COARSE_WINDOW = 15.0       # seconds either side of the guess
FINE_SAMPLES = 40
FINE_WINDOW = 1.5
RETRY_WINDOW = 45.0      # a sample the narrow window misses: is a scene cut or added?
MIN_PROMINENCE = 0.04      # best score must beat the runner-up by this much
GROUP_TOLERANCE = 0.25     # seconds: offsets this close are one timing
# Common release speed ratios, so a duration ratio a hair off one of them is
# read as that ratio rather than as an accident of how long each file runs.
KNOWN_SPEEDS = (1.0, 25 / (24000 / 1001), (24000 / 1001) / 25, 24 / (24000 / 1001), (24000 / 1001) / 24)


def emit(**fields) -> None:
    print(json.dumps(fields), flush=True)


class Edges:
    """Blurred, normalised edge maps of one video's frames, cached by index."""

    def __init__(self, clip: vs.VideoNode) -> None:
        kwargs = {} if clip.format.color_family == vs.RGB else {"matrix_in_s": "709"}
        if clip.format.color_family != vs.RGB and "_Matrix" not in clip.get_frame(0).props:
            kwargs = {"matrix_in_s": "709"}
        small = core.resize.Bicubic(clip, THUMB_W, THUMB_H, format=vs.GRAYS, **kwargs)
        self.clip = small
        self.fps = float(clip.fps) if clip.fps_num else 24000 / 1001
        self.frames = clip.num_frames
        self.cache: dict[int, np.ndarray] = {}

    def __getitem__(self, n: int) -> np.ndarray:
        n = min(max(n, 0), self.frames - 1)
        hit = self.cache.get(n)
        if hit is not None:
            return hit
        a = np.asarray(self.clip.get_frame(n)[0], dtype=np.float32)
        gy, gx = np.gradient(a)
        g = np.hypot(gx, gy)
        # A 3x3 box blur, twice: forgiving of a few pixels of crop or combing.
        for _ in range(2):
            p = np.pad(g, 1, mode="edge")
            g = sum(p[dy:dy + THUMB_H, dx:dx + THUMB_W] for dy in range(3) for dx in range(3)) / 9.0
        g = g - g.mean()
        norm = float(np.sqrt((g * g).sum()))
        out = g / norm if norm > 1e-6 else g * 0.0
        self.cache[n] = out
        if len(self.cache) > 6000:
            self.cache.clear()
        return out

    def frame_at(self, t: float) -> int:
        return int(round(t * self.fps))


def fingerprint_score(main: Edges, ref: Edges, t_main: float, m0: int, speed: float) -> float:
    """Mean edge correlation of three frames, main from t_main, ref from frame m0."""
    total = 0.0
    for k in range(3):
        a = main[main.frame_at(t_main + k * TRIPLE_SPAN)]
        b = ref[m0 + int(round(k * TRIPLE_SPAN * speed * ref.fps))]
        total += float((a * b).sum())
    return total / 3.0


def search(main: Edges, ref: Edges, t_main: float, guess: float, window: float, speed: float):
    """The reference time best matching t_main within guess ± window, and how clearly it won."""
    lo = max(0, ref.frame_at(guess - window))
    hi = min(ref.frames - 1, ref.frame_at(guess + window))
    if hi - lo < 4:
        return None
    scores = np.array([fingerprint_score(main, ref, t_main, m, speed) for m in range(lo, hi + 1)])
    best = int(scores.argmax())
    # The runner-up must be a different moment, not the same held drawing.
    away = int(round(0.25 * ref.fps))
    others = np.concatenate([scores[:max(0, best - away)], scores[best + away + 1:]])
    if others.size == 0:
        return None
    prominence = float(scores[best] - others.max())
    return (lo + best) / ref.fps, float(scores[best]), prominence


def group_sections(points: list[tuple[float, float]], speed: float) -> list[list[tuple[float, float]]]:
    """Samples split into sections: stretches of time that agree on one offset.

    Where the releases are the same cut, every sample's offset is the same to
    within GROUP_TOLERANCE (a telecined source against a 23.976 encode, and
    drawings held for several frames, scatter them by a few frames). A cut or
    added scene moves every later sample by seconds. So offsets are clustered
    first; a cluster of fewer than three samples is mismatches, not a timing.
    Then, in time order, a single sample disagreeing with neighbours that
    agree with each other is a stray, and what remains splits into runs.
    """
    ordered = sorted(points)
    offs = [r - speed * t for t, r in ordered]
    clusters: list[list[float]] = []
    for value in sorted(offs):
        if clusters and value - clusters[-1][-1] <= GROUP_TOLERANCE:
            clusters[-1].append(value)
        else:
            clusters.append([value])
    centres = [float(np.median(c)) for c in clusters if len(c) >= 3]
    labels: list[int | None] = []
    for value in offs:
        best = min(range(len(centres)), key=lambda k: abs(centres[k] - value), default=None)
        labels.append(best if best is not None and abs(centres[best] - value) <= GROUP_TOLERANCE else None)

    kept = [(p, lab) for p, lab in zip(ordered, labels) if lab is not None]
    for k in range(1, len(kept) - 1):
        if kept[k - 1][1] == kept[k + 1][1] != kept[k][1]:
            kept[k] = (kept[k][0], None)
    kept = [(p, lab) for p, lab in kept if lab is not None]

    runs: list[list[tuple[float, float]]] = []
    last = None
    for p, lab in kept:
        if runs and lab == last:
            runs[-1].append(p)
        else:
            runs.append([p])
        last = lab
    return runs


def refine_offset(main: Edges, ref: Edges, speed: float, run: list[tuple[float, float]], centre: float) -> float:
    """The offset that best fits every sample of a section at once.

    Each sample alone is only good to a frame or so — held drawings tie, and
    a telecined source has no frame exactly where the reference's is. Scored
    together over a grid of quarter frames, the section agrees on one offset
    far more precisely than its median does.
    """
    step = 0.25 / ref.fps
    best, best_score = centre, -np.inf
    for k in range(-16, 17):
        off = centre + k * step
        score = sum(fingerprint_score(main, ref, t, ref.frame_at(speed * t + off), speed) for t, _ in run)
        if score > best_score:
            best, best_score = off, score
    return float(best)


def section_boundary(main: Edges, ref: Edges, speed: float, lo: float, hi: float, off_a: float, off_b: float) -> float:
    """Where, between two samples, the earlier section's offset stops fitting and the later one's starts."""
    def prefers_b(t: float) -> bool:
        a = fingerprint_score(main, ref, t, ref.frame_at(speed * t + off_a), speed)
        b = fingerprint_score(main, ref, t, ref.frame_at(speed * t + off_b), speed)
        return b > a
    for _ in range(12):
        mid = (lo + hi) / 2
        if prefers_b(mid):
            hi = mid
        else:
            lo = mid
    return round((lo + hi) / 2, 3)


def align(main_clip: vs.VideoNode, ref_clip: vs.VideoNode) -> dict:
    main = Edges(main_clip)
    ref = Edges(ref_clip)
    main_duration = main.frames / main.fps
    ref_duration = ref.frames / ref.fps

    # Releases differ in speed by exact ratios (PAL speed-up, 24 vs 23.976),
    # and the durations say which; a known ratio is kept exactly, because a
    # fit through samples a frame or so apart drifts by frames over an hour.
    ratio = ref_duration / main_duration
    speed = min(KNOWN_SPEEDS, key=lambda k: abs(k - ratio))
    known_speed = abs(speed - ratio) <= 0.004 * speed
    if not known_speed:
        speed = 1.0

    # Coarse: where, roughly, does the reference sit?
    offsets = []
    for i in range(COARSE_ANCHORS):
        t = main_duration * (0.15 + 0.7 * i / max(1, COARSE_ANCHORS - 1))
        emit(progress=0.06 + 0.24 * i / COARSE_ANCHORS, message="Finding roughly where the reference sits")
        hit = search(main, ref, t, speed * t, COARSE_WINDOW, speed)
        if hit and hit[2] >= MIN_PROMINENCE:
            offsets.append(hit[0] - speed * t)
    if not offsets:
        raise AlignError("No moment of the main video could be found in the reference. "
                         "Are they the same footage?")
    offset = float(np.median(offsets))

    # Fine: samples across the whole video, searched narrowly; a sample that
    # finds nothing there is searched again wide, because a cut or added
    # scene moves everything after it out of the narrow window.
    points: list[tuple[float, float]] = []
    skipped = 0
    for i in range(FINE_SAMPLES):
        t = main_duration * (0.03 + 0.94 * i / (FINE_SAMPLES - 1))
        emit(progress=0.3 + 0.6 * i / FINE_SAMPLES, message=f"Matching {i + 1} of {FINE_SAMPLES} moments")
        hit = search(main, ref, t, speed * t + offset, FINE_WINDOW, speed)
        if not (hit and hit[2] >= MIN_PROMINENCE):
            hit = search(main, ref, t, speed * t + offset, RETRY_WINDOW, speed)
        if hit and hit[2] >= MIN_PROMINENCE:
            points.append((t, hit[0]))
        else:
            skipped += 1

    if len(points) < 4:
        raise AlignError(f"Only {len(points)} moments matched clearly — too few to line the videos up. "
                         "They may be different footage, or mostly still shots.")

    # One speed for the whole video, then one offset per section. Fitted from
    # the largest section only when the durations matched no known ratio.
    runs = group_sections(points, speed)
    if not runs:
        raise AlignError("The matched moments do not agree on any one timing. "
                         "The reference may be a different edit throughout.")
    largest = max(runs, key=len)
    if not known_speed and len(largest) >= 4 and largest[-1][0] - largest[0][0] > main_duration * 0.2:
        speed = float(np.polyfit([p for p, _ in largest], [q for _, q in largest], 1)[0])
        # A cut or added scene throws the durations off a known ratio, but the
        # fitted speed still lands on it, give or take the samples' scatter.
        nearest = min(KNOWN_SPEEDS, key=lambda k: abs(k - speed))
        if abs(nearest - speed) <= 0.001 * nearest:
            speed = nearest
    a = speed
    emit(progress=0.9, message="Refining the timing")
    offsets = [refine_offset(main, ref, a, run, float(np.median([q - a * p for p, q in run]))) for run in runs]

    emit(progress=0.92, message="Finding where the releases differ")
    sections = [{"from": 0.0, "offset": round(offsets[0], 4)}]
    for k in range(1, len(runs)):
        start = section_boundary(main, ref, a, runs[k - 1][-1][0], runs[k][0][0], offsets[k - 1], offsets[k])
        sections.append({"from": start, "offset": round(offsets[k], 4)})

    matched = sum(len(run) for run in runs)
    residuals = [abs(q - (a * p + offsets[k])) * ref.fps for k, run in enumerate(runs) for p, q in run]
    return {
        "speed": a,
        "sections": sections,
        "matched": matched,
        "usable": len(points),
        "samples": FINE_SAMPLES,
        "residualFrames": round(max(residuals), 2) if residuals else None,
        "mainFps": main.fps,
        "refFps": ref.fps,
    }


class AlignError(Exception):
    """A plain-language reason the videos could not be lined up."""


def main_cli(main_path: str, ref_path: str) -> None:
    emit(progress=0.0, message="Opening the videos (the first time indexes them, which can take a while)")
    main_clip = core.bs.VideoSource(source=main_path, cachemode=3)
    emit(progress=0.04, message="Opening the videos")
    ref_clip = core.bs.VideoSource(source=ref_path, cachemode=3)
    try:
        result = align(main_clip, ref_clip)
    except AlignError as exc:
        emit(error=str(exc))
        return
    emit(progress=1.0, message="Done")
    emit(result=result)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        emit(error="usage: align_videos.py <main video> <reference video>")
        sys.exit(2)
    try:
        main_cli(sys.argv[1], sys.argv[2])
    except Exception as exc:  # reported, not raised: the app reads stdout
        emit(error=f"{type(exc).__name__}: {exc}")
        sys.exit(1)
