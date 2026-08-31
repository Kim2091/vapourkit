"""Compare DLSS-NR with and without automatic motion on real footage.

    <portable python> ab_test.py <video> [frame ...]

Writes, per frame, into ./dlssnr_ab/ :

    frameN_source.png       the source, after the sRGB conversion the filter requires
    frameN_motion_off.png   Enhance(auto_motion=0)
    frameN_motion_on.png    Enhance(auto_motion=1)
    frameN_motionfield.png  the estimated motion, grey = still, red/green = +x/+y

and prints how far each output moved from the source, and from each other.

Two things this script is careful about, because both produce convincing but meaningless
results if you get them wrong:

  * Frames are walked in order from a warm-up point. The filter asserts DLSSNR.Reset whenever
    the requested frame does not directly follow the last one processed, and a reset frame has
    no temporal history and no motion at all. Seeking straight to frame 500 measures nothing.

  * Colour is converted to sRGB-encoded full-range RGBS first. The model is LDR-clamped and
    trained on display-encoded frames; handing it linear light or video gamma puts it outside
    its training domain and the comparison stops meaning anything.
"""

import os
import sys

import numpy as np
import vapoursynth as vs
from PIL import Image

core = vs.core

WARMUP = 12
OUT_DIR = "dlssnr_ab"


def load(path):
    if hasattr(core, "bs"):
        clip = core.bs.VideoSource(path)
    else:
        clip = core.lsmas.LWLibavSource(path)

    props = clip.get_frame(0).props

    def known(name, fallback):
        value = props.get(name, fallback)
        return fallback if value == 2 else value  # ITU-T H.273: 2 = unspecified

    matrix = known("_Matrix", vs.MATRIX_BT709)
    transfer = known("_Transfer", vs.TRANSFER_BT709)
    rng = props.get("_Range", vs.RANGE_LIMITED)

    clip = core.std.SetFrameProps(clip, _Matrix=matrix, _Transfer=transfer, _Range=rng)
    return core.resize.Bicubic(
        clip, format=vs.RGBS, transfer=vs.TRANSFER_IEC_61966_2_1, range=vs.RANGE_FULL
    )


def frame_to_rgb(frame):
    """RGBS planes -> HxWx3 uint8, for writing."""
    planes = [np.asarray(frame[p]) for p in range(3)]
    return (np.clip(np.stack(planes, axis=-1), 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)


def motion_to_rgb(frame, span=16.0):
    """Motion field -> a picture. Mid grey is stationary; red is +x, green is +y."""
    mvx = np.asarray(frame[0])
    mvy = np.asarray(frame[1])
    out = np.stack(
        [
            np.clip(0.5 + mvx / (2 * span), 0.0, 1.0),
            np.clip(0.5 + mvy / (2 * span), 0.0, 1.0),
            np.full_like(mvx, 0.5),
        ],
        axis=-1,
    )
    return (out * 255.0 + 0.5).astype(np.uint8)


def walk(clip, target):
    """Returns frame `target`, having requested everything before it in order."""
    frame = None
    for n in range(max(0, target - WARMUP), target + 1):
        frame = clip.get_frame(n)
    return frame


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1

    path = sys.argv[1]
    targets = [int(a) for a in sys.argv[2:]] or [60, 120, 240]

    src = load(path)
    print(f"{path}: {src.width}x{src.height}, {len(src)} frames")

    off = core.dlssnr.Enhance(src, auto_motion=0)
    on = core.dlssnr.Enhance(src, auto_motion=1)
    field = core.dlssnr.Enhance(src, auto_motion=1, debug_motion=1)

    os.makedirs(OUT_DIR, exist_ok=True)

    for target in targets:
        if target >= len(src):
            print(f"frame {target}: past the end of the clip, skipped")
            continue

        source_rgb = frame_to_rgb(walk(src, target))
        off_rgb = frame_to_rgb(walk(off, target))
        on_rgb = frame_to_rgb(walk(on, target))
        field_rgb = motion_to_rgb(walk(field, target))

        for name, image in (
            ("source", source_rgb),
            ("motion_off", off_rgb),
            ("motion_on", on_rgb),
            ("motionfield", field_rgb),
        ):
            Image.fromarray(image).save(os.path.join(OUT_DIR, f"frame{target}_{name}.png"))

        a = source_rgb.astype(np.int16)
        b = off_rgb.astype(np.int16)
        c = on_rgb.astype(np.int16)
        mvx = np.asarray(walk(field, target)[0])

        print(
            f"frame {target:5d}: "
            f"off vs source {np.abs(b - a).mean():6.3f}   "
            f"on vs source {np.abs(c - a).mean():6.3f}   "
            f"on vs off {np.abs(c - b).mean():6.3f}   "
            f"| motion: {100.0 * np.mean(np.abs(mvx) > 0.5):5.1f}% of pixels moving, "
            f"max |x| {np.abs(mvx).max():.1f}px"
        )

    print(f"\nwrote PNGs to {os.path.abspath(OUT_DIR)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
