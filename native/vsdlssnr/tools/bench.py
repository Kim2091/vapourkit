"""Benchmark dlssnr.Enhance in order from frame 0, with GPU clock sampling.

  python bench.py <video> [--frames N] [--warmup N] [--width W --height H]
                  [--auto-motion 0|1] [--backend d3d12|vulkan] [--dump out.npy]
                  [--dump-frame N] [--prefetch N]
"""
import argparse
import os
import subprocess
import sys
import threading
import time

import numpy as np
import vapoursynth as vs

core = vs.core


class SmiSampler(threading.Thread):
    def __init__(self, interval=0.25):
        super().__init__(daemon=True)
        self.interval = interval
        self.stop_flag = threading.Event()
        self.rows = []

    def run(self):
        while not self.stop_flag.is_set():
            try:
                out = subprocess.run(
                    ["nvidia-smi",
                     "--query-gpu=power.draw,clocks.sm,clocks.mem,pstate,utilization.gpu,temperature.gpu",
                     "--format=csv,noheader,nounits"],
                    capture_output=True, text=True, timeout=5)
                line = out.stdout.strip().splitlines()[0]
                parts = [p.strip() for p in line.split(",")]
                self.rows.append(parts)
            except Exception:
                pass
            self.stop_flag.wait(self.interval)

    def report(self):
        if not self.rows:
            return "no GPU samples"
        def col(i, cast=float):
            vals = []
            for r in self.rows:
                try:
                    vals.append(cast(r[i]))
                except Exception:
                    pass
            return vals
        power = col(0); sm = col(1); mem = col(2); util = col(4); temp = col(5)
        pstates = [r[3] for r in self.rows]
        def stat(v):
            if not v:
                return "n/a"
            v2 = sorted(v)
            return f"min {v2[0]:.0f} med {v2[len(v2)//2]:.0f} max {v2[-1]:.0f}"
        return (f"GPU samples n={len(self.rows)}\n"
                f"  power W:   {stat(power)}\n"
                f"  sm MHz:    {stat(sm)}\n"
                f"  mem MHz:   {stat(mem)}\n"
                f"  util %:    {stat(util)}\n"
                f"  temp C:    {stat(temp)}\n"
                f"  pstates:   {sorted(set(pstates))}")


def load(path, width=None, height=None):
    if hasattr(core, "bs"):
        clip = core.bs.VideoSource(path)
    else:
        clip = core.lsmas.LWLibavSource(path)
    props = clip.get_frame(0).props

    def known(name, fallback):
        value = props.get(name, fallback)
        return fallback if value == 2 else value

    matrix = known("_Matrix", vs.MATRIX_BT709)
    transfer = known("_Transfer", vs.TRANSFER_BT709)
    rng = props.get("_Range", vs.RANGE_LIMITED)
    clip = core.std.SetFrameProps(clip, _Matrix=matrix, _Transfer=transfer, _Range=rng)
    kw = dict(format=vs.RGBS, transfer=vs.TRANSFER_IEC_61966_2_1, range=vs.RANGE_FULL)
    if width:
        kw["width"] = width
    if height:
        kw["height"] = height
    return core.resize.Bicubic(clip, **kw)


def frame_np(f):
    return np.stack([np.asarray(f[p]) for p in range(3)], axis=0).copy()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--frames", type=int, default=60)
    ap.add_argument("--warmup", type=int, default=15)
    ap.add_argument("--width", type=int, default=0)
    ap.add_argument("--height", type=int, default=0)
    ap.add_argument("--auto-motion", type=int, default=0)
    ap.add_argument("--backend", default="d3d12")
    ap.add_argument("--dump", default="")
    ap.add_argument("--dump-frame", type=int, default=-1)
    ap.add_argument("--prefetch", type=int, default=4)
    ap.add_argument("--source-only", action="store_true")
    ap.add_argument("--synthetic", action="store_true")
    ap.add_argument("--threads", type=int, default=0)
    args = ap.parse_args()

    if args.threads:
        core.num_threads = args.threads

    if args.synthetic:
        src = core.std.BlankClip(format=vs.RGBS, width=args.width or 3840,
                                 height=args.height or 2160, length=400, color=[0.25, 0.5, 0.75])
    else:
        src = load(args.video, args.width or None, args.height or None)
    print(f"source: {src.width}x{src.height}, {len(src)} frames, vs threads={core.num_threads}", flush=True)

    if args.source_only:
        clip = src
    else:
        clip = core.dlssnr.Enhance(src, auto_motion=args.auto_motion, backend=args.backend)

    total = args.warmup + args.frames
    total = min(total, len(clip))

    sampler = SmiSampler()
    dumped = None
    times = []
    t_start = None
    n = 0
    prev = None
    for f in clip.frames(prefetch=args.prefetch, close=False):
        if n == args.warmup:
            sampler.start()
            t_start = time.perf_counter()
            prev = t_start
        elif n > args.warmup:
            now = time.perf_counter()
            times.append(now - prev)
            prev = now
        if args.dump and args.dump_frame == n:
            dumped = frame_np(f)
        del f
        n += 1
        if n >= total:
            break
    t_end = time.perf_counter()
    sampler.stop_flag.set()
    sampler.join(timeout=3)

    measured = n - args.warmup
    elapsed = t_end - t_start
    print(f"\n{measured} frames in {elapsed:.3f}s -> {measured/elapsed:.3f} fps, "
          f"{1000.0*elapsed/measured:.2f} ms/frame", flush=True)
    if times:
        ts = sorted(times)
        print(f"  per-frame ms: min {1000*ts[0]:.2f} med {1000*ts[len(ts)//2]:.2f} "
              f"p90 {1000*ts[int(len(ts)*0.9)]:.2f} max {1000*ts[-1]:.2f}")
    print(sampler.report(), flush=True)

    if dumped is not None:
        np.save(args.dump, dumped)
        print(f"dumped frame {args.dump_frame} -> {args.dump} shape={dumped.shape}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
