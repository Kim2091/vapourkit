"""Walk frames 0..N-1 in order and record a hash of every output frame, plus full dumps.

  python identity.py <video> <out.npz> [--frames N] [--width W --height H]
                     [--auto-motion 0|1] [--backend d3d12|vulkan] [--dumps 3,17,40]

Frames are requested strictly in order from 0 so DLSSNR.Reset is asserted exactly once, on
frame 0, and every later frame carries real temporal history.
"""
import argparse
import hashlib
import os
import sys

import numpy as np
import vapoursynth as vs

core = vs.core
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bench import load  # noqa


def to_np(f):
    return np.stack([np.asarray(f[p]) for p in range(3)], axis=0).copy()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("out")
    ap.add_argument("--frames", type=int, default=40)
    ap.add_argument("--width", type=int, default=0)
    ap.add_argument("--height", type=int, default=0)
    ap.add_argument("--auto-motion", type=int, default=0)
    ap.add_argument("--backend", default="d3d12")
    ap.add_argument("--dumps", default="1,7,25")
    args = ap.parse_args()

    dumps = {int(x) for x in args.dumps.split(",") if x != ""}
    src = load(args.video, args.width or None, args.height or None)
    clip = core.dlssnr.Enhance(src, auto_motion=args.auto_motion, backend=args.backend)

    hashes = []
    saved = {}
    for n in range(min(args.frames, len(clip))):
        f = clip.get_frame(n)
        a = to_np(f)
        hashes.append(hashlib.sha256(a.tobytes()).hexdigest())
        if n in dumps:
            saved[f"f{n}"] = a
        del f, a

    np.savez_compressed(args.out, hashes=np.array(hashes), **saved)
    print(f"{len(hashes)} frames, first hash {hashes[0][:16]}, last {hashes[-1][:16]}")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
