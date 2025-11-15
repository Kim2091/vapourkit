
import vapoursynth as vs
core = vs.core

#deinterlacers
from .DeF import DeF
from .DfConvEkSA import DfConvEkSA
from .DDD import DDD

#interlaced content is often subsampled, which does not work with these deinterlacers. this wrapper function works around this by deinterlacing luma and chroma seperately.
def YUV(clip: vs.VideoNode, matrix_in_s="709", range_in_s="limited", deinterlacer=[3, 1], tff=True, tta=[False, False], mocomp=[False, False], device="cuda", fp16=True) -> vs.VideoNode:
    original_format = clip.format.id
    if clip.format.color_family != vs.ColorFamily.YUV:
        raise ValueError("Input clip must be in YUV format.")
    if (mocomp[0] and deinterlacer[0] != 3) or (mocomp[1] and deinterlacer[1] != 3):
        raise ValueError("Mocomp is only available for DfConvEkSA (deinterlacer 3).")

    def deinterlace_plane(clip, plane, deinterlacer, tta, mocomp):
        p = core.std.ShufflePlanes(clip, planes=plane, colorfamily=vs.GRAY)
        p = core.resize.Point(p, format=vs.RGBS, matrix_in_s=matrix_in_s, range_in_s=range_in_s, range_s='full')
        
        if deinterlacer == 1:
            p = DDD(p, tff=tff, tta=tta, device=device, fp16=fp16)
        elif deinterlacer == 2:
            p = DeF(p, tff=tff, tta=tta, device=device, fp16=fp16)
        elif deinterlacer == 3:
            p = DfConvEkSA(p, tff=tff, tta=tta, mocomp=mocomp, device=device, fp16=fp16)
        else:
            raise ValueError("Deinterlacer must be either 1 for DDD, 2 for DeF, or 3 for DfConvEkSA.")
        
        return core.resize.Point(p, format=original_format, matrix_s=matrix_in_s, range_in_s='full', range_s=range_in_s)

    Y = deinterlace_plane(clip, 0, deinterlacer[0], tta[0], mocomp[0])
    U = deinterlace_plane(clip, 1, deinterlacer[1], tta[1], mocomp[1])
    V = deinterlace_plane(clip, 2, deinterlacer[1], tta[1], mocomp[1])

    return core.std.ShufflePlanes([Y, U, V], planes=[0, 0, 0], colorfamily=vs.YUV)
