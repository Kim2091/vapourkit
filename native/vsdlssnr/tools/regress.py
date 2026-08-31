"""Regression suite for vsdlssnr after the pipelining change."""
import os
import sys
import traceback

import numpy as np
import vapoursynth as vs

core = vs.core
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bench import load  # noqa

VIDEO = sys.argv[1]
results = []


def check(name, fn):
    try:
        fn()
        results.append((name, "PASS", ""))
        print(f"PASS  {name}", flush=True)
    except Exception as e:
        results.append((name, "FAIL", str(e)))
        print(f"FAIL  {name}: {e}", flush=True)
        traceback.print_exc()


def to_np(f):
    return np.stack([np.asarray(f[p]) for p in range(3)], axis=0).copy()


src = load(VIDEO, 960, 540)  # small, so the suite is quick
print(f"regression source: {src.width}x{src.height}, {len(src)} frames")


def multi_instance():
    a = core.dlssnr.Enhance(src, auto_motion=0)
    b = core.dlssnr.Enhance(src, auto_motion=0)
    for n in range(4):
        a.get_frame(n)
        b.get_frame(n)
    del a
    import gc
    gc.collect()
    for n in range(4, 8):
        b.get_frame(n)


def seek_matches_fresh():
    a = core.dlssnr.Enhance(src, auto_motion=0)
    for n in range(0, 11):
        a.get_frame(n)
    for n in range(100, 104):
        f = a.get_frame(n)
    seeked = to_np(f)

    b = core.dlssnr.Enhance(src, auto_motion=0)
    for n in range(100, 104):
        f = b.get_frame(n)
    fresh = to_np(f)
    assert np.array_equal(seeked, fresh), "seek then walk != fresh walk"


def end_of_clip():
    a = core.dlssnr.Enhance(src, auto_motion=0)
    last = len(src) - 1
    for n in range(last - 3, last + 1):
        a.get_frame(n)


def backwards_and_random():
    a = core.dlssnr.Enhance(src, auto_motion=0)
    for n in [50, 49, 48, 200, 0, 1, 2, 1, 7, 7]:
        a.get_frame(n)


def prefetch_matches_serial():
    a = core.dlssnr.Enhance(src, auto_motion=0)
    serial = [to_np(a.get_frame(n)) for n in range(12)]
    b = core.dlssnr.Enhance(src, auto_motion=0)
    par = []
    for i, f in enumerate(b.frames(prefetch=6, close=False)):
        par.append(to_np(f))
        if i == 11:
            break
    for i in range(12):
        assert np.array_equal(serial[i], par[i]), f"prefetch differs at frame {i}"


def auto_motion_runs():
    a = core.dlssnr.Enhance(src, auto_motion=1)
    for n in range(6):
        a.get_frame(n)
    m = core.dlssnr.Enhance(src, auto_motion=1, debug_motion=1)
    for n in range(6):
        f = m.get_frame(n)
    field = to_np(f)
    assert np.abs(field[0]).max() > 0.0, "motion field is entirely zero"


def vulkan_backend():
    a = core.dlssnr.Enhance(src, backend="vulkan")
    d = core.dlssnr.Enhance(src, auto_motion=0)
    for n in range(6):
        fa = to_np(a.get_frame(n))
        fd = to_np(d.get_frame(n))
    assert np.array_equal(fa, fd), "vulkan output differs from d3d12"


def integer_input():
    src8 = core.resize.Bicubic(src, format=vs.RGB24)
    a = core.dlssnr.Enhance(src8, auto_motion=0)
    for n in range(5):
        a.get_frame(n)
    src16 = core.resize.Bicubic(src, format=vs.RGB48)
    b = core.dlssnr.Enhance(src16, auto_motion=0)
    for n in range(5):
        b.get_frame(n)


def odd_width():
    odd = core.std.Crop(src, right=3, bottom=1)  # 957x539
    a = core.dlssnr.Enhance(odd, auto_motion=0)
    for n in range(5):
        a.get_frame(n)


check("multi-instance create/free/reuse", multi_instance)
check("seek then walk == fresh walk", seek_matches_fresh)
check("end of clip", end_of_clip)
check("backwards and repeated requests", backwards_and_random)
check("prefetched == serial", prefetch_matches_serial)
check("auto_motion + debug_motion", auto_motion_runs)
check("vulkan backend matches d3d12", vulkan_backend)
check("RGB24 / RGB48 input", integer_input)
check("odd (non-multiple-of-8) width", odd_width)

print("\n=== summary ===")
for name, status, msg in results:
    print(f"{status}  {name}" + (f"  -- {msg}" if msg else ""))
sys.exit(0 if all(r[1] == "PASS" for r in results) else 1)
