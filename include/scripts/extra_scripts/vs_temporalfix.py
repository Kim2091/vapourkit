# Based on plugins and functions from many different people. See function comments and readme requirements for details.

# Script by pifroggi https://github.com/pifroggi/vs_temporalfix
# or tepete on the "Enhance Everything!" Discord Server

import vapoursynth as vs

core = vs.core

def BoxBlur(clip, planes=None, hradius=1, hpasses=1, vradius=1, vpasses=1):
    # optional plugin for slight speed boost.
    if hasattr(core, "vszip"):
        return core.vszip.BoxBlur(clip, planes=planes, hradius=hradius, hpasses=hpasses, vradius=vradius, vpasses=vpasses)
    else:
        return core.std.BoxBlur(clip, planes=planes, hradius=hradius, hpasses=hpasses, vradius=vradius, vpasses=vpasses)

def Expression(clips, expr, format=None):
    # optional plugin for slight speed boost.
    if hasattr(core, "akarin"):
        return core.akarin.Expr(clips, expr, format=format)
    else:
        return core.std.Expr(clips, expr, format=format)

def TemporalMedian(clip, radius=1, planes=None):
    # fallback plugin because zsmooth does not support non AVX2 CPUs.
    if hasattr(core, "zsmooth"):
        return core.zsmooth.TemporalMedian(clip, radius=radius, planes=planes)
    else:
        return core.tmedian.TemporalMedian(clip, radius=radius, planes=planes)

def Repair(clip, repairclip, mode=[1]):
    # fallback plugin because zsmooth does not support non AVX2 CPUs.
    if hasattr(core, "zsmooth"):
        return core.zsmooth.Repair(clip, repairclip, mode=mode)
    else:
        return core.rgvs.Repair(clip, repairclip, mode=mode)

def Median(clip, radius=1, planes=None):
    # fallback plugin because zsmooth does not support non AVX2 CPUs. use std.Median for r=1 and CTMF for higher.
    if hasattr(core, "zsmooth"):
        return core.zsmooth.Median(clip, radius=radius, planes=planes)
    elif radius == 1:
        return core.std.Median(clip, planes=planes)
    else:
        return core.ctmf.CTMF(clip, radius=radius, planes=planes)

def AverageColorFix(clip, ref, radius=4, passes=4):
    # modified from https://github.com/pifroggi/vs_colorfix
    blurred_reference = BoxBlur(ref, hradius=radius, hpasses=passes, vradius=radius, vpasses=passes)
    blurred_clip = BoxBlur(clip, hradius=radius, hpasses=passes, vradius=radius, vpasses=passes)
    diff_clip = core.std.MakeDiff(blurred_reference, blurred_clip)
    return core.std.MergeDiff(clip, diff_clip)


def AverageColorFixFast(clip, ref, downscale_factor=8):
    # faster but faint blocky artifacts
    downscaled_reference = core.resize.Bilinear(ref, width=clip.width / downscale_factor, height=clip.height / downscale_factor)
    downscaled_clip = core.resize.Bilinear(clip, width=clip.width / downscale_factor, height=clip.height / downscale_factor)
    diff_clip = core.std.MakeDiff(downscaled_reference, downscaled_clip)
    diff_clip = core.resize.Bilinear(diff_clip, width=clip.width, height=clip.height)
    return core.std.MergeDiff(clip, diff_clip)


def FrequencyMerge(low, high, radius=40, passes=3):
    # merges low freqs of one clip with high freqs of another clip
    low_remaining  = BoxBlur(low,  hradius=radius, hpasses=passes, vradius=radius, vpasses=passes)
    high_removed   = BoxBlur(high, hradius=radius, hpasses=passes, vradius=radius, vpasses=passes)
    high_remaining = core.std.MakeDiff(high, high_removed)
    return core.std.MergeDiff(low_remaining, high_remaining)


def TweakDarks(src, s0=2.0, c=0.0625, chroma=True):
    # simplified DitherLumaRebuild function that works on full range
    # DitherLumaRebuild function from G41Fun https://github.com/Vapoursynth-Plugins-Gitify/G41Fun
    # originally created by cretindesalpes https://forum.doom9.org/showthread.php?p=1548318

    bd = src.format.bits_per_sample
    isFLOAT = src.format.sample_type == vs.FLOAT
    i = 0.00390625 if isFLOAT else 1 << (bd - 8)
    x = "x {} /".format(i) if bd != 8 else "x"
    expr = "x" if isFLOAT else "{} {} *".format(x, i)
    k = (s0 - 1) * c
    t = "{} 255 / 0 max 1 min".format(x)
    c1 = 1 + c
    c2 = c1 * c
    e = "{} {} {} {} {} + / - * {} 1 {} - * + {} *".format(k, c1, c2, t, c, t, k, 256 * i)
    return Expression([src], [e] if src.format.num_planes == 1 else [e, expr if chroma else ""])


def ExcludeRegions(clip, replacement, exclude=None):
    # simplified ReplaceFrames function from fvsfunc https://github.com/Irrational-Encoding-Wizardry/fvsfunc
    # which is a port of ReplaceFramesSimple by James D. Lin http://avisynth.nl/index.php/RemapFrames
    import re

    if not isinstance(exclude, str):
        raise TypeError('vs_temporalfix: Exclusions are set like this: exclude="[100 300] [600 900] [2000 2500]", where the first number in the brackets is the start frame and the second is the end frame (inclusive).')

    exclude = exclude.replace(",", " ").replace(":", " ")
    frames = re.findall(r"\d+(?!\d*\s*\d*\s*\d*\])", exclude)
    ranges = re.findall(r"\[\s*\d+\s+\d+\s*\]", exclude)
    maps = []
    for range_ in ranges:
        maps.append([int(x) for x in range_.strip("[ ]").split()])
    for frame in frames:
        maps.append([int(frame), int(frame)])

    for start, end in maps:
        if start > end:
            raise ValueError("vs_temporalfix: Exclusions start frame is bigger than end frame: [{} {}]".format(start, end))
        if start >= clip.num_frames:
            raise ValueError("vs_temporalfix: Exclusions start frame {} is outside the clip, which has only {} frames.".format(start, clip.num_frames))

    out = clip
    for start, end in maps:
        temp = replacement[start : end + 1]
        temp = replacement[start : end + 1]
        if start != 0:
            temp = out[:start] + temp
        if end < out.num_frames - 1:
            temp = temp + out[end + 1 :]
        out = temp
    return out


def TemporalFixPrefilter(clip, thsad=250, tr=6):
    # creates a temporally extremely stable reference for better motion vector estimation, but with lots of ghosting
    # based on SpotLess function from G41Fun https://github.com/Vapoursynth-Plugins-Gitify/G41Fun
    # which was modified from lostfunc https://github.com/theChaosCoder/lostfunc/blob/v1/lostfunc.py#L10
    # which was a port of Didée's original avisynth function https://forum.doom9.org/showthread.php?p=1402690

    A = core.mv.Analyse
    C = core.mv.Compensate
    S = core.mv.Super

    # first pass with temporal median
    bs  = 128  # large blocksize to reduce warping
    pel = 1
    sup = S(clip, pel=pel, sharp=1, rfilter=4, hpad=bs // 2, vpad=bs // 2)
    analyse_args = dict(blksize=bs, overlap=bs // 2, search=4, searchparam=2, truemotion=False)
    bv1 = A(sup, isb=True,  delta=1, **analyse_args)
    fv1 = A(sup, isb=False, delta=1, **analyse_args)
    bc1 = C(clip, sup, bv1)
    fc1 = C(clip, sup, fv1)
    fcb = core.std.Interleave([fc1, clip, bc1])
    clip = TemporalMedian(fcb, radius=1, planes=0)[1::3]

    # second pass with degrain and a wide radius (improves pans, zooms and similar, reduces warping)
    bs  = 128  # large blocksize to reduce warping
    pel = 1
    sup = S(clip, pel=pel, sharp=1, rfilter=4)
    analyse_args = dict(blksize=bs, overlap=0, search=4, searchparam=1, truemotion=False)
    
    # analyze
    if tr > 5:
        bv6 = A(sup, isb=True,  delta=6, **analyse_args)
        fv6 = A(sup, isb=False, delta=6, **analyse_args)
    if tr > 4:
        bv5 = A(sup, isb=True,  delta=5, **analyse_args)
        fv5 = A(sup, isb=False, delta=5, **analyse_args)
    if tr > 3:
        bv4 = A(sup, isb=True,  delta=4, **analyse_args)
        fv4 = A(sup, isb=False, delta=4, **analyse_args)
    if tr > 2:
        bv3 = A(sup, isb=True,  delta=3, **analyse_args)
        fv3 = A(sup, isb=False, delta=3, **analyse_args)
    if tr > 1:
        bv2 = A(sup, isb=True,  delta=2, **analyse_args)
        fv2 = A(sup, isb=False, delta=2, **analyse_args)
    bv1 = A(sup, isb=True,  delta=1, **analyse_args)
    fv1 = A(sup, isb=False, delta=1, **analyse_args)
    
    # degrain
    if   tr == 1:
        return clip.mv.Degrain1(sup, bv1, fv1, thsad=thsad, plane=0)
    elif tr == 2:
        return clip.mv.Degrain2(sup, bv1, fv1, bv2, fv2, thsad=thsad, plane=0)
    elif tr == 3:
        return clip.mv.Degrain3(sup, bv1, fv1, bv2, fv2, bv3, fv3, thsad=thsad, plane=0)
    elif tr == 4:
        return clip.mv.Degrain4(sup, bv1, fv1, bv2, fv2, bv3, fv3, bv4, fv4, thsad=thsad, plane=0)
    elif tr == 5:
        return clip.mv.Degrain5(sup, bv1, fv1, bv2, fv2, bv3, fv3, bv4, fv4, bv5, fv5, thsad=thsad, plane=0)
    else:
        return clip.mv.Degrain6(sup, bv1, fv1, bv2, fv2, bv3, fv3, bv4, fv4, bv5, fv5, bv6, fv6, thsad=thsad, plane=0)


def LowFreqDenoise(low, high, motionmask, thsad=200, tr=6):
    # temporally denoise low frequencies only
    
    A = core.mv.Analyse
    C = core.mv.Compensate
    S = core.mv.Super
    
    bs  = 8
    pel = 1
    analyse_args = dict(blksize=bs, overlap=bs // 2, search=4, searchparam=1, truemotion=False)
   
    # downscale clips
    low_down   = core.resize.Bicubic(low,      width=low.width // 8, height=low.height // 8)
    motionmask = core.resize.Point(motionmask, width=low.width // 8, height=low.height // 8)
    motionmask = core.std.Maximum(motionmask)                      # expand mask
    prefilter  = TweakDarks(low_down, s0=2.5, c=0.2, chroma=False) # brighten darks
    
    # create super clips
    pref_sup = S(prefilter, pel=pel, sharp=1, rfilter=4)
    low_sup  = S(low_down,  pel=pel, sharp=0, rfilter=1, levels=1)

    # analyze
    if tr > 5:
        bv6 = A(pref_sup, isb=True,  delta=6, **analyse_args)
        fv6 = A(pref_sup, isb=False, delta=6, **analyse_args)
    if tr > 4:
        bv5 = A(pref_sup, isb=True,  delta=5, **analyse_args)
        fv5 = A(pref_sup, isb=False, delta=5, **analyse_args)
    if tr > 3:
        bv4 = A(pref_sup, isb=True,  delta=4, **analyse_args)
        fv4 = A(pref_sup, isb=False, delta=4, **analyse_args)
    if tr > 2:
        bv3 = A(pref_sup, isb=True,  delta=3, **analyse_args)
        fv3 = A(pref_sup, isb=False, delta=3, **analyse_args)
    if tr > 1:
        bv2 = A(pref_sup, isb=True,  delta=2, **analyse_args)
        fv2 = A(pref_sup, isb=False, delta=2, **analyse_args)
    bv1 = A(pref_sup, isb=True,  delta=1, **analyse_args)
    fv1 = A(pref_sup, isb=False, delta=1, **analyse_args)
    
    # degrain
    if   tr == 1:
        low_degr = core.mv.Degrain1(low_down, low_sup, bv1, fv1, thsad=thsad, plane=0)
    elif tr == 2:
        low_degr = core.mv.Degrain2(low_down, low_sup, bv1, fv1, bv2, fv2, thsad=thsad, plane=0)
    elif tr == 3:
        low_degr = core.mv.Degrain3(low_down, low_sup, bv1, fv1, bv2, fv2, bv3, fv3, thsad=thsad, plane=0)
    elif tr == 4:
        low_degr = core.mv.Degrain4(low_down, low_sup, bv1, fv1, bv2, fv2, bv3, fv3, bv4, fv4, thsad=thsad, plane=0)
    elif tr == 5:
        low_degr = core.mv.Degrain5(low_down, low_sup, bv1, fv1, bv2, fv2, bv3, fv3, bv4, fv4, bv5, fv5, thsad=thsad, plane=0)
    else:
        low_degr = core.mv.Degrain6(low_down, low_sup, bv1, fv1, bv2, fv2, bv3, fv3, bv4, fv4, bv5, fv5, bv6, fv6, thsad=thsad, plane=0)
    
    low_degr = core.std.MaskedMerge(low_degr, low_down, motionmask)              # reduce blending/ghosting
    low_degr = core.resize.Bicubic(low_degr, width=low.width, height=low.height) # resize back to original res
    return FrequencyMerge(low_degr, high, 10, 3)                                 # merge low freqs with original high freqs
    

def vs_temporalfix(clip, strength=400, tr=6, denoise=False, exclude=None, debug=False):
    # based on SMDegrain function from G41Fun https://github.com/Vapoursynth-Plugins-Gitify/G41Fun
    # which is a modification of SMDegrain from havsfunc https://github.com/HomeOfVapourSynthEvolution/havsfunc/blob/r31/havsfunc.py#L3186
    # which is a port of SMDegrain from avisynth https://forum.videohelp.com/threads/369142

    ##### checks & settings #####

    if not isinstance(clip, vs.VideoNode):
        raise TypeError("vs_temporalfix: This is not a vapoursynth clip.")
    if tr < 1:
        raise ValueError("vs_temporalfix: Temporal radius (tr) must be at least 1.")

    # original properties
    props       = clip.get_frame(0).props
    orig_format = clip.format.id
    orig_family = clip.format.color_family
    orig_range  = 1 - props.get('_ColorRange', 0 if orig_family == vs.RGB else 1) # if not tagged, default to full for rgb, limited for yuv/gray (frame props range is inversed)
    orig_width  = clip.width

    # global settings
    S  = core.mv.Super if tr < 7 else core.mvsf.Super
    A  = core.mv.Analyse
    D1 = core.mv.Degrain1
    D2 = core.mv.Degrain2
    D3 = core.mv.Degrain3
    D4 = core.mv.Degrain4
    D5 = core.mv.Degrain5
    D6 = core.mv.Degrain6
    bd          = 16
    peak        = (1 << bd) - 1 if tr < 7 else 1.0
    limit       = 255
    limit       = limit * peak / 255
    limitc      = limit
    strengthc   = strength // 2
    chroma      = False if clip.format.color_family == vs.GRAY else True
    plane       = 4  if chroma else 0
    blksize     = 16 if orig_width > 2400 else 8
    overlap     = 8  if orig_width > 2400 else 4
    pel         = 1  if orig_width > 2400 else 2
    subpixel    = 0
    search      = 4
    searchparam = 1
    DCT         = 0
    thSCD1      = 1000
    thSCD2      = 1000
    MVglobal    = None
    truemotion  = False
    extra_pad   = 16
    Str         = 2.5
    Amp         = 0.2
    if pel < 2:
        subpixel = min(subpixel, 2)
    if tr > 6:
        mvsflegacy = not hasattr(core.mvsf, "Degrain")  # true is plugin version r9 or older, false is r10 pre-release or newer

    ##### prepare input clip #####

    # convert to 16 bit
    orig = clip
    if orig_format != vs.YUV444P16 or orig_range != 1:
        if orig_family == vs.RGB:
            clip = core.resize.Point(clip, format=vs.YUV444P16, range=1, matrix_s="709")
        else:
            clip = core.resize.Point(clip, format=vs.YUV444P16, range=1)

    # add borders
    clip = core.std.AddBorders(clip, left=extra_pad, right=extra_pad, top=extra_pad, bottom=extra_pad)
    clip = core.fb.FillBorders(clip, left=extra_pad, right=extra_pad, top=extra_pad, bottom=extra_pad, mode="fillmargins", interlaced=0)
    ref  = clip

    ##### motion mask #####

    # compensate next frame for motionmask so that it works on pans and zooms
    mm_pref   = core.resize.Bilinear(ref, format=vs.GRAY8)
    mm_sup    = core.mv.Super(mm_pref, pel=2, sharp=1, rfilter=4, hpad=64, vpad=64)
    mm_vec    = core.mv.Analyse(mm_sup, isb=False, delta=1, blksize=128, overlap=64, search=5, truemotion=True)
    mm_window = core.mv.Compensate(mm_pref, mm_sup, mm_vec, thsad=200000, thscd1=1000, thscd2=1000)
    mm_window = core.std.Interleave([mm_window, mm_pref])

    # create motionmask to protect large motions
    mm_window = core.resize.Bicubic(mm_window, width=(mm_window.width / mm_window.height) * 320, height=320) # downscale so that small spatial changes are not in the mask, only larger changes
    mm_window = core.retinex.MSRCP(mm_window, sigma=[mm_window.width / 57], lower_thr=0.011, upper_thr=0.011, fulls=True, fulld=True, chroma_protect=1.0) #
    mm_window = core.motionmask.MotionMask(mm_window, th1=[40], th2=[40], tht=33, sc_value=255) # mask large changes, also used for rudimentary scene change detection
    mm = core.std.SelectEvery(mm_window, cycle=2, offsets=1)

    # further process motionmask
    mm = core.std.Maximum(mm) # expand mask
    m1 = mm[1:] + mm[-1:] # shift - 1    The motion mask compares previous to current frame and masks what changed
    m2 = mm[2:] + mm[-2:] # shift - 2    on the current frame. The first -1 shift just puts the mask on the previous
    m3 = mm[3:] + mm[-3:] # shift - 3    frame as well, so that it is on both sides of the change. The following two 
    p1 = mm[:1] + mm[:-1] # shift + 1    shifts backwards and forwards are used to fade in/out the mask to hide ghosting.
    p2 = mm[:2] + mm[:-2] # shift + 2
    mm = Expression([mm, m1, m2, m3, p1, p2], expr=["x y + z 0.75 * + a 0.5 * + b 0.75 * + c 0.5 * +"])
    mm = Median(mm, radius=1) # median mask
    mm = core.resize.Point(mm, width=ref.width, height=ref.height)
    mm = BoxBlur(mm, hradius=4, vradius=4, hpasses=2, vpasses=2) # feather mask

    ##### prefilter to help with motion vectors #####
    
    # resize clips if needed, convert to low bit depth for faster motion vector search
    if pel > 1:
        pref      = core.resize.Bicubic(clip, width=clip.width * pel, height=clip.height * pel, format=vs.YUV444P8)
        mm_resize = core.resize.Bilinear(mm,  width=clip.width * pel, height=clip.height * pel)
    else:
        pref      = core.resize.Point(clip, format=vs.YUV444P8)
        mm_resize = mm
    
    # prefilter
    pref_ref = pref
    pref = TemporalFixPrefilter(pref, strength // 2, tr)   # main prefilter step
    pref = AverageColorFixFast(pref, pref_ref, 32)         # fix low freqs
    pref = core.std.MaskedMerge(pref, pref_ref, mm_resize) # fix blending/ghosting
    pref = TweakDarks(pref, s0=Str, c=Amp, chroma=chroma)  # brighten darks

    ##### degrain #####

    # resize and convert if needed
    if tr < 7:
        if pel > 1:
            pelclip = pref
            pref    = core.resize.Bicubic(pref, width=clip.width, height=clip.height)
    else:
        if pel > 1:
            pelclip = core.resize.Bicubic(pref, format=vs.YUV444PS, width=clip.width * pel, height=clip.height * pel)
        pref        = core.resize.Bicubic(pref, format=vs.YUV444PS, width=clip.width,       height=clip.height)
        clip        = core.resize.Point(clip,   format=vs.YUV444PS)

    # superclips
    if pel > 1:
        pref_sup = S(pref, chroma=chroma, rfilter=4, pel=pel, pelclip=pelclip)
    else:
        pref_sup = S(pref, chroma=chroma, rfilter=4, pel=pel, sharp=1)
    clip_sup     = S(clip, chroma=chroma, rfilter=1, pel=pel, sharp=subpixel, levels=1)

    # analyze
    analyse_args = dict(blksize=blksize, search=search, chroma=chroma, truemotion=truemotion, global_=MVglobal, overlap=overlap, dct=DCT, searchparam=searchparam, fields=False)
    if tr < 7:  # using mvtools because it is faster
        if tr > 5:
            bv6 = A(pref_sup, isb=True,  delta=6, **analyse_args)
            fv6 = A(pref_sup, isb=False, delta=6, **analyse_args)
        if tr > 4:
            bv5 = A(pref_sup, isb=True,  delta=5, **analyse_args)
            fv5 = A(pref_sup, isb=False, delta=5, **analyse_args)
        if tr > 3:
            bv4 = A(pref_sup, isb=True,  delta=4, **analyse_args)
            fv4 = A(pref_sup, isb=False, delta=4, **analyse_args)
        if tr > 2:
            bv3 = A(pref_sup, isb=True,  delta=3, **analyse_args)
            fv3 = A(pref_sup, isb=False, delta=3, **analyse_args)
        if tr > 1:
            bv2 = A(pref_sup, isb=True,  delta=2, **analyse_args)
            fv2 = A(pref_sup, isb=False, delta=2, **analyse_args)
        bv1 = A(pref_sup, isb=True,  delta=1, **analyse_args)
        fv1 = A(pref_sup, isb=False, delta=1, **analyse_args)
    
    else:  # using mvtoolssf because it has support for higher tr
        if mvsflegacy:
            vec = Analyze(pref_sup, tr=tr, **analyse_args)
        else:
            vec = core.mvsf.Analyze(pref_sup, radius=tr, **analyse_args)

    # degrain
    if tr < 7:  # using mvtools because it is faster
        degrain_args = dict(thsad=strength, thsadc=strengthc, plane=plane, limit=limit, limitc=limitc, thscd1=thSCD1, thscd2=thSCD2)
        if   tr == 6:
            clip = D6(clip, clip_sup, bv1, fv1, bv2, fv2, bv3, fv3, bv4, fv4, bv5, fv5, bv6, fv6, **degrain_args)
        elif tr == 5:
            clip = D5(clip, clip_sup, bv1, fv1, bv2, fv2, bv3, fv3, bv4, fv4, bv5, fv5, **degrain_args)
        elif tr == 4:
            clip = D4(clip, clip_sup, bv1, fv1, bv2, fv2, bv3, fv3, bv4, fv4, **degrain_args)
        elif tr == 3:
            clip = D3(clip, clip_sup, bv1, fv1, bv2, fv2, bv3, fv3, **degrain_args)
        elif tr == 2:
            clip = D2(clip, clip_sup, bv1, fv1, bv2, fv2, **degrain_args)
        else:
            clip = D1(clip, clip_sup, bv1, fv1, **degrain_args)
    
    else:  # using mvtoolssf because it has support for higher tr
        degrain_args = dict(thsad=[strength, strengthc, strengthc], plane=plane, limit=[limit, limitc, limitc], thscd1=thSCD1, thscd2=thSCD2)
        if mvsflegacy:
            clip = DegrainN(clip, clip_sup, vec, tr=tr, **degrain_args)
        else:
            clip = core.mvsf.Degrain(clip, clip_sup, vec, **degrain_args)
        clip = core.resize.Point(clip, format=vs.YUV444P16)

    ##### recover details #####

    # colorfix to counter denoising sometimes changing local brightness
    clip = AverageColorFix(clip, ref, 4, 4)

    # contrasharp to counter slight blur
    clip = ContraSharpening(clip, ref, rep=24, planes=[0])

    # mask to find areas where temporalfix may have removed some texture
    flatmask_post = core.std.ShufflePlanes(clip, planes=0, colorfamily=vs.GRAY)
    flatmask_post = core.tcanny.TCanny(flatmask_post, op=3, mode=1, sigma=0.1, scale=5.0, t_h=8.0, t_l=1.0, opt=1) # mask textures post temporalfix
    flatmask_post = Median(flatmask_post, radius=1, planes=0)
    flatmask_post = core.std.Invert(flatmask_post) # invert for flat areas instead

    # overlay original on top of flat areas as these areas may have had texture before
    # don't do if denoise as this will bring back light grain in those areas
    if not denoise:
        clip = core.std.MaskedMerge(clip, ref, flatmask_post, planes=0)

    # mask flat areas with block matching artifacts/wrong motion and overlay original
    flatmask_pre  = core.std.ShufflePlanes(ref, planes=0, colorfamily=vs.GRAY)
    flatmask_pre  = core.tcanny.TCanny(flatmask_pre, op=3, mode=1, sigma=0.1, scale=5.0, t_h=8.0, t_l=1.0, opt=1) # mask textures pre temporalfix
    flatmask_pre  = Median(flatmask_pre, radius=1, planes=0)
    flatmask_diff = Expression([flatmask_post, flatmask_pre], "65535 x y + 32767 - 2 * -") # compare masks to check if there is now more texture than before, which suggests artifacts, then only use part of mask were textures increased
    clip          = core.std.MaskedMerge(clip, ref, flatmask_diff, planes=0) # use mask to overlay original

    # overlay original in areas with large motion to fix blending/ghosting/warping
    mm = core.resize.Point(mm, format=vs.GRAY16)
    clip = core.std.MaskedMerge(clip, ref, mm)

    # denoise low frequencies
    if denoise:
        clip = LowFreqDenoise(ref, clip, mm, strength // 2, tr)

    if debug:
        ref_debug = core.std.Levels(ref, gamma=2)  # visualize unttouched areas
        clip = core.std.MaskedMerge(clip, ref_debug, mm)

    ##### finalize output clip #####

    # remove border
    clip = core.std.Crop(clip, left=extra_pad, right=extra_pad, top=extra_pad, bottom=extra_pad)
    
    # convert back to original format
    if orig_format != vs.YUV444P16 or orig_range != 1:
        if orig_family == vs.RGB:
            clip = core.resize.Point(clip, format=orig_format, range=orig_range, dither_type="error_diffusion", matrix_in_s="709")
        else:
            clip = core.resize.Point(clip, format=orig_format, range=orig_range, dither_type="error_diffusion")
    
    # exclude regions from temporal fixing
    if exclude is not None:
        if debug:
            orig = core.std.Levels(orig, gamma=2)  # visualize excluded frames
        clip = ExcludeRegions(clip, orig, exclude=exclude)
    
    # return result
    return clip


# I have consolidated a few functions here to make sure it doesn't break


# fmt: off
def Analyze(super, blksize=None, blksizev=None, levels=None, search=None, searchparam=None, pelsearch=None, lambda_=None, chroma=None, tr=None, truemotion=None, lsad=None, plevel=None, global_=None, pnew=None, pzero=None, pglobal=None, overlap=None, overlapv=None, divide=None, badsad=None, badrange=None, meander=None, trymany=None, fields=False, TFF=None, search_coarse=None, dct=None):
    #function from mvmulti: https://github.com/IFeelBloated/vapoursynth-mvtools-sf/blob/r9/src/mvmulti.py
    def getvecs(isb, delta):
        return core.mvsf.Analyze(super, isb=isb, blksize=blksize, blksizev=blksizev, levels=levels, search=search, searchparam=searchparam, pelsearch=pelsearch, lambda_=lambda_, chroma=chroma, delta=delta, truemotion=truemotion, lsad=lsad, plevel=plevel, global_=global_, pnew=pnew, pzero=pzero, pglobal=pglobal, overlap=overlap, overlapv=overlapv, divide=divide, badsad=badsad, badrange=badrange, meander=meander, trymany=trymany, fields=fields, tff=TFF, search_coarse=search_coarse, dct=dct)
    bv = [getvecs(True,  i) for i in range(tr, 0, -1)]
    fv = [getvecs(False, i) for i in range(1, tr + 1)]
    return core.std.Interleave(bv + fv)

def Recalculate(super, vectors, thsad=200.0, smooth=1, blksize=8, blksizev=None, search=4, searchparam=2, lambda_=None, chroma=True, truemotion=True, pnew=None, overlap=0, overlapv=None, divide=0, meander=True, fields=False, tff=None, dct=0, tr=3):
    #function from mvmulti: https://github.com/IFeelBloated/vapoursynth-mvtools-sf/blob/r9/src/mvmulti.py
    core         = vs.core
    def refine(delta):
        analyzed = core.std.SelectEvery(vectors, 2*tr, delta)
        refined  = core.mvsf.Recalculate(super, analyzed, thsad=thsad, smooth=smooth, blksize=blksize, blksizev=blksizev, search=search, searchparam=searchparam, lambda_=lambda_, chroma=chroma, truemotion=truemotion, pnew=pnew, overlap=overlap, overlapv=overlapv, divide=divide, meander=meander, fields=fields, tff=tff, dct=dct)
        return refined
    vmulti       = [refine(i) for i in range(0, 2*tr)]
    vmulti       = core.std.Interleave(vmulti)
    return vmulti

def DegrainN(clip, super, mvmulti, tr=3, thsad=400.0, plane=4, limit=1.0, thscd1=400.0, thscd2=130.0):
    #function from mvmulti: https://github.com/IFeelBloated/vapoursynth-mvtools-sf/blob/r9/src/mvmulti.py
    core         = vs.core
    def bvn(n):
        bv       = core.std.SelectEvery(mvmulti, tr*2, tr-n)
        return bv
    def fvn(n):
        fv       = core.std.SelectEvery(mvmulti, tr*2, tr+n-1)
        return fv
    if tr == 1:
       dgn       = core.mvsf.Degrain1(clip, super, bvn(1), fvn(1), thsad=thsad, plane=plane, limit=limit, thscd1=thscd1, thscd2=thscd2)
    elif tr == 2:
       dgn       = core.mvsf.Degrain2(clip, super, bvn(1), fvn(1), bvn(2), fvn(2), thsad=thsad, plane=plane, limit=limit, thscd1=thscd1, thscd2=thscd2)
    elif tr == 3:
       dgn       = core.mvsf.Degrain3(clip, super, bvn(1), fvn(1), bvn(2), fvn(2), bvn(3), fvn(3), thsad=thsad, plane=plane, limit=limit, thscd1=thscd1, thscd2=thscd2)
    elif tr == 4:
       dgn       = core.mvsf.Degrain4(clip, super, bvn(1), fvn(1), bvn(2), fvn(2), bvn(3), fvn(3), bvn(4), fvn(4), thsad=thsad, plane=plane, limit=limit, thscd1=thscd1, thscd2=thscd2)
    elif tr == 5:
       dgn       = core.mvsf.Degrain5(clip, super, bvn(1), fvn(1), bvn(2), fvn(2), bvn(3), fvn(3), bvn(4), fvn(4), bvn(5), fvn(5), thsad=thsad, plane=plane, limit=limit, thscd1=thscd1, thscd2=thscd2)
    elif tr == 6:
       dgn       = core.mvsf.Degrain6(clip, super, bvn(1), fvn(1), bvn(2), fvn(2), bvn(3), fvn(3), bvn(4), fvn(4), bvn(5), fvn(5), bvn(6), fvn(6), thsad=thsad, plane=plane, limit=limit, thscd1=thscd1, thscd2=thscd2)
    elif tr == 7:
       dgn       = core.mvsf.Degrain7(clip, super, bvn(1), fvn(1), bvn(2), fvn(2), bvn(3), fvn(3), bvn(4), fvn(4), bvn(5), fvn(5), bvn(6), fvn(6), bvn(7), fvn(7), thsad=thsad, plane=plane, limit=limit, thscd1=thscd1, thscd2=thscd2)
    elif tr == 8:
       dgn       = core.mvsf.Degrain8(clip, super, bvn(1), fvn(1), bvn(2), fvn(2), bvn(3), fvn(3), bvn(4), fvn(4), bvn(5), fvn(5), bvn(6), fvn(6), bvn(7), fvn(7), bvn(8), fvn(8), thsad=thsad, plane=plane, limit=limit, thscd1=thscd1, thscd2=thscd2)
    elif tr == 9:
       dgn       = core.mvsf.Degrain9(clip, super, bvn(1), fvn(1), bvn(2), fvn(2), bvn(3), fvn(3), bvn(4), fvn(4), bvn(5), fvn(5), bvn(6), fvn(6), bvn(7), fvn(7), bvn(8), fvn(8), bvn(9), fvn(9), thsad=thsad, plane=plane, limit=limit, thscd1=thscd1, thscd2=thscd2)
    elif tr == 10:
       dgn       = core.mvsf.Degrain10(clip, super, bvn(1), fvn(1), bvn(2), fvn(2), bvn(3), fvn(3), bvn(4), fvn(4), bvn(5), fvn(5), bvn(6), fvn(6), bvn(7), fvn(7), bvn(8), fvn(8), bvn(9), fvn(9), bvn(10), fvn(10), thsad=thsad, plane=plane, limit=limit, thscd1=thscd1, thscd2=thscd2)
    elif tr == 11:
       dgn       = core.mvsf.Degrain11(clip, super, bvn(1), fvn(1), bvn(2), fvn(2), bvn(3), fvn(3), bvn(4), fvn(4), bvn(5), fvn(5), bvn(6), fvn(6), bvn(7), fvn(7), bvn(8), fvn(8), bvn(9), fvn(9), bvn(10), fvn(10), bvn(11), fvn(11), thsad=thsad, plane=plane, limit=limit, thscd1=thscd1, thscd2=thscd2)
    elif tr == 12:
       dgn       = core.mvsf.Degrain12(clip, super, bvn(1), fvn(1), bvn(2), fvn(2), bvn(3), fvn(3), bvn(4), fvn(4), bvn(5), fvn(5), bvn(6), fvn(6), bvn(7), fvn(7), bvn(8), fvn(8), bvn(9), fvn(9), bvn(10), fvn(10), bvn(11), fvn(11), bvn(12), fvn(12), thsad=thsad, plane=plane, limit=limit, thscd1=thscd1, thscd2=thscd2)
    elif tr == 13:
       dgn       = core.mvsf.Degrain13(clip, super, bvn(1), fvn(1), bvn(2), fvn(2), bvn(3), fvn(3), bvn(4), fvn(4), bvn(5), fvn(5), bvn(6), fvn(6), bvn(7), fvn(7), bvn(8), fvn(8), bvn(9), fvn(9), bvn(10), fvn(10), bvn(11), fvn(11), bvn(12), fvn(12), bvn(13), fvn(13), thsad=thsad, plane=plane, limit=limit, thscd1=thscd1, thscd2=thscd2)
    elif tr == 14:
       dgn       = core.mvsf.Degrain14(clip, super, bvn(1), fvn(1), bvn(2), fvn(2), bvn(3), fvn(3), bvn(4), fvn(4), bvn(5), fvn(5), bvn(6), fvn(6), bvn(7), fvn(7), bvn(8), fvn(8), bvn(9), fvn(9), bvn(10), fvn(10), bvn(11), fvn(11), bvn(12), fvn(12), bvn(13), fvn(13), bvn(14), fvn(14), thsad=thsad, plane=plane, limit=limit, thscd1=thscd1, thscd2=thscd2)
    elif tr == 15:
       dgn       = core.mvsf.Degrain15(clip, super, bvn(1), fvn(1), bvn(2), fvn(2), bvn(3), fvn(3), bvn(4), fvn(4), bvn(5), fvn(5), bvn(6), fvn(6), bvn(7), fvn(7), bvn(8), fvn(8), bvn(9), fvn(9), bvn(10), fvn(10), bvn(11), fvn(11), bvn(12), fvn(12), bvn(13), fvn(13), bvn(14), fvn(14), bvn(15), fvn(15), thsad=thsad, plane=plane, limit=limit, thscd1=thscd1, thscd2=thscd2)
    elif tr == 16:
       dgn       = core.mvsf.Degrain16(clip, super, bvn(1), fvn(1), bvn(2), fvn(2), bvn(3), fvn(3), bvn(4), fvn(4), bvn(5), fvn(5), bvn(6), fvn(6), bvn(7), fvn(7), bvn(8), fvn(8), bvn(9), fvn(9), bvn(10), fvn(10), bvn(11), fvn(11), bvn(12), fvn(12), bvn(13), fvn(13), bvn(14), fvn(14), bvn(15), fvn(15), bvn(16), fvn(16), thsad=thsad, plane=plane, limit=limit, thscd1=thscd1, thscd2=thscd2)
    elif tr == 17:
       dgn       = core.mvsf.Degrain17(clip, super, bvn(1), fvn(1), bvn(2), fvn(2), bvn(3), fvn(3), bvn(4), fvn(4), bvn(5), fvn(5), bvn(6), fvn(6), bvn(7), fvn(7), bvn(8), fvn(8), bvn(9), fvn(9), bvn(10), fvn(10), bvn(11), fvn(11), bvn(12), fvn(12), bvn(13), fvn(13), bvn(14), fvn(14), bvn(15), fvn(15), bvn(16), fvn(16), bvn(17), fvn(17), thsad=thsad, plane=plane, limit=limit, thscd1=thscd1, thscd2=thscd2)
    elif tr == 18:
       dgn       = core.mvsf.Degrain18(clip, super, bvn(1), fvn(1), bvn(2), fvn(2), bvn(3), fvn(3), bvn(4), fvn(4), bvn(5), fvn(5), bvn(6), fvn(6), bvn(7), fvn(7), bvn(8), fvn(8), bvn(9), fvn(9), bvn(10), fvn(10), bvn(11), fvn(11), bvn(12), fvn(12), bvn(13), fvn(13), bvn(14), fvn(14), bvn(15), fvn(15), bvn(16), fvn(16), bvn(17), fvn(17), bvn(18), fvn(18), thsad=thsad, plane=plane, limit=limit, thscd1=thscd1, thscd2=thscd2)
    elif tr == 19:
       dgn       = core.mvsf.Degrain19(clip, super, bvn(1), fvn(1), bvn(2), fvn(2), bvn(3), fvn(3), bvn(4), fvn(4), bvn(5), fvn(5), bvn(6), fvn(6), bvn(7), fvn(7), bvn(8), fvn(8), bvn(9), fvn(9), bvn(10), fvn(10), bvn(11), fvn(11), bvn(12), fvn(12), bvn(13), fvn(13), bvn(14), fvn(14), bvn(15), fvn(15), bvn(16), fvn(16), bvn(17), fvn(17), bvn(18), fvn(18), bvn(19), fvn(19), thsad=thsad, plane=plane, limit=limit, thscd1=thscd1, thscd2=thscd2)
    elif tr == 20:
       dgn       = core.mvsf.Degrain20(clip, super, bvn(1), fvn(1), bvn(2), fvn(2), bvn(3), fvn(3), bvn(4), fvn(4), bvn(5), fvn(5), bvn(6), fvn(6), bvn(7), fvn(7), bvn(8), fvn(8), bvn(9), fvn(9), bvn(10), fvn(10), bvn(11), fvn(11), bvn(12), fvn(12), bvn(13), fvn(13), bvn(14), fvn(14), bvn(15), fvn(15), bvn(16), fvn(16), bvn(17), fvn(17), bvn(18), fvn(18), bvn(19), fvn(19), bvn(20), fvn(20), thsad=thsad, plane=plane, limit=limit, thscd1=thscd1, thscd2=thscd2)
    elif tr == 21:
       dgn       = core.mvsf.Degrain21(clip, super, bvn(1), fvn(1), bvn(2), fvn(2), bvn(3), fvn(3), bvn(4), fvn(4), bvn(5), fvn(5), bvn(6), fvn(6), bvn(7), fvn(7), bvn(8), fvn(8), bvn(9), fvn(9), bvn(10), fvn(10), bvn(11), fvn(11), bvn(12), fvn(12), bvn(13), fvn(13), bvn(14), fvn(14), bvn(15), fvn(15), bvn(16), fvn(16), bvn(17), fvn(17), bvn(18), fvn(18), bvn(19), fvn(19), bvn(20), fvn(20), bvn(21), fvn(21), thsad=thsad, plane=plane, limit=limit, thscd1=thscd1, thscd2=thscd2)
    elif tr == 22:
       dgn       = core.mvsf.Degrain22(clip, super, bvn(1), fvn(1), bvn(2), fvn(2), bvn(3), fvn(3), bvn(4), fvn(4), bvn(5), fvn(5), bvn(6), fvn(6), bvn(7), fvn(7), bvn(8), fvn(8), bvn(9), fvn(9), bvn(10), fvn(10), bvn(11), fvn(11), bvn(12), fvn(12), bvn(13), fvn(13), bvn(14), fvn(14), bvn(15), fvn(15), bvn(16), fvn(16), bvn(17), fvn(17), bvn(18), fvn(18), bvn(19), fvn(19), bvn(20), fvn(20), bvn(21), fvn(21), bvn(22), fvn(22), thsad=thsad, plane=plane, limit=limit, thscd1=thscd1, thscd2=thscd2)
    elif tr == 23:
       dgn       = core.mvsf.Degrain23(clip, super, bvn(1), fvn(1), bvn(2), fvn(2), bvn(3), fvn(3), bvn(4), fvn(4), bvn(5), fvn(5), bvn(6), fvn(6), bvn(7), fvn(7), bvn(8), fvn(8), bvn(9), fvn(9), bvn(10), fvn(10), bvn(11), fvn(11), bvn(12), fvn(12), bvn(13), fvn(13), bvn(14), fvn(14), bvn(15), fvn(15), bvn(16), fvn(16), bvn(17), fvn(17), bvn(18), fvn(18), bvn(19), fvn(19), bvn(20), fvn(20), bvn(21), fvn(21), bvn(22), fvn(22), bvn(23), fvn(23), thsad=thsad, plane=plane, limit=limit, thscd1=thscd1, thscd2=thscd2)
    elif tr == 24:
       dgn       = core.mvsf.Degrain24(clip, super, bvn(1), fvn(1), bvn(2), fvn(2), bvn(3), fvn(3), bvn(4), fvn(4), bvn(5), fvn(5), bvn(6), fvn(6), bvn(7), fvn(7), bvn(8), fvn(8), bvn(9), fvn(9), bvn(10), fvn(10), bvn(11), fvn(11), bvn(12), fvn(12), bvn(13), fvn(13), bvn(14), fvn(14), bvn(15), fvn(15), bvn(16), fvn(16), bvn(17), fvn(17), bvn(18), fvn(18), bvn(19), fvn(19), bvn(20), fvn(20), bvn(21), fvn(21), bvn(22), fvn(22), bvn(23), fvn(23), bvn(24), fvn(24), thsad=thsad, plane=plane, limit=limit, thscd1=thscd1, thscd2=thscd2)
    else:
       raise ValueError("vs_temporalfix: Tr must be between 1 and 24. Upgrade mvtools-sf to r10 pre-release or newer for larger radii.")
    return dgn
# fmt: on


def ContraSharpening(clip, src, radius=None, rep=24, planes=[0, 1, 2]):
    # simplified function from G41Fun https://github.com/Vapoursynth-Plugins-Gitify/G41Fun
    # original avisynth function by Didée at the VERY GRAINY thread https://forum.doom9.org/showthread.php?p=1076491

    if radius is None:
        radius = 2 if clip.width > 960 else 1
    if clip.format.num_planes == 1:
        planes = [0]
    if isinstance(planes, int):
        planes = [planes]

    mat1 = [1, 2, 1, 2, 4, 2, 1, 2, 1]
    mat2 = [1, 1, 1, 1, 1, 1, 1, 1, 1]
    bd   = clip.format.bits_per_sample
    mid  = 1 << (bd - 1)
    num  = clip.format.num_planes

    s    = MinBlur(clip, planes)  # damp down remaining spots of the denoised clip
    RG11 = core.std.Convolution(s, matrix=mat1, planes=planes).std.Convolution(matrix=mat2, planes=planes)
    ssD  = core.std.MakeDiff(s, RG11, planes)  # the difference of a simple kernel blur
    allD = core.std.MakeDiff(src, clip, planes)  # the difference achieved by the denoising
    ssDD = Repair(ssD, allD, [rep if i in planes else 0 for i in range(num)])  # limit the difference to the max of what the denoising removed locally
    expr = "x {} - abs y {} - abs < x y ?".format(mid, mid)  # abs(diff) after limiting may not be bigger than before
    ssDD = Expression([ssDD, ssD], [expr if i in planes else "" for i in range(num)])
    return core.std.MergeDiff(clip, ssDD, planes)  # apply the limited difference (sharpening is just inverse blurring)


def MinBlur(clip, planes=[0, 1, 2]):
    # simplified function from G41Fun https://github.com/Vapoursynth-Plugins-Gitify/G41Fun
    # original avisynth function by Didée https://avisynth.nl/index.php/MinBlur
    # Nifty Gauss/Median combination

    if clip.format.num_planes == 1:
        planes = [0]
    if isinstance(planes, int):
        planes = [planes]
    mat1 = [1, 2, 1, 2, 4, 2, 1, 2, 1]
    mat2 = [1, 1, 1, 1, 1, 1, 1, 1, 1]
    RG11 = core.std.Convolution(clip, matrix=mat1, planes=planes).std.Convolution(matrix=mat2, planes=planes)
    RG4  = Median(clip, radius=2, planes=planes)
    expr = "x y - x z - * 0 < x dup y - abs x z - abs < y z ? ?"
    return Expression([clip, RG11, RG4], [expr if i in planes else "" for i in range(clip.format.num_planes)])
