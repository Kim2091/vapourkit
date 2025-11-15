import vapoursynth as vs
core = vs.core

_KERNELS = {
    "point":    core.resize.Point,
    "bilinear": core.resize.Bilinear,
    "bicubic":  core.resize.Bicubic,
    "lanczos":  core.resize.Lanczos,
    "spline16": core.resize.Spline16,
    "spline36": core.resize.Spline36,
    "spline64": core.resize.Spline64,
}

def _pick_resizer(kernel: str):
    try:
        return _KERNELS[kernel.lower()]
    except KeyError:
        raise ValueError(f"Unknown kernel '{kernel}'. Choose from: {', '.join(_KERNELS)}")

def scale(clip: vs.VideoNode, scale: float = 1.0, kernel: str = "bilinear") -> vs.VideoNode:
    if scale <= 0:
        raise ValueError("scale must be > 0")

    # provisional size
    w = max(1, int(clip.width  * scale))
    h = max(1, int(clip.height * scale))

    # mod only if subsampled
    fmt = clip.format
    if fmt is not None:
        mod_w = 1 << fmt.subsampling_w
        mod_h = 1 << fmt.subsampling_h
        if mod_w > 1:
            w = max(mod_w, w - (w % mod_w))
        if mod_h > 1:
            h = max(mod_h, h - (h % mod_h))

    return _pick_resizer(kernel)(clip, width=w, height=h)

def pixel(clip: vs.VideoNode, width: int = None, height: int = None, kernel: str = "bilinear") -> vs.VideoNode:
    return _pick_resizer(kernel)(clip, width=width, height=height)