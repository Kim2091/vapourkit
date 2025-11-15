
# Script by pifroggi https://github.com/pifroggi/vs_tiletools
# or tepete and pifroggi on Discord

import json
import vapoursynth as vs
from numbers import Real

core     = vs.core
fb_modes = {"repeat", "mirror", "fillmargins", "fixborders"}

def _clamp8(x):
    return max(0, min(255, x))

def _check_modulus(value, subsampling, parameter, function, clip_format):
    if subsampling > 1 and value % subsampling != 0:
        raise ValueError(f"vs_tiletools.{function}: {parameter} must be a multiple of {subsampling} for format {clip_format.name} due to chroma subsampling.")

def _normalize_color(mode, clip_format, function):
    # none lets addborders pick format appropriate black
    if mode is None or (isinstance(mode, str) and mode in {"black", "none", "None"}):
        return None

    # get values
    if isinstance(mode, Real):
        raw_vals = [float(mode)]
    elif isinstance(mode, (list, tuple)) and len(mode) > 0 and all(isinstance(v, Real) for v in mode):
        raw_vals = [float(v) for v in mode]
    else:
        return False

    num_planes  = clip_format.num_planes
    sample_type = clip_format.sample_type

    # broadcast single value across planes
    if len(raw_vals) < num_planes:
        raw_vals = raw_vals + [raw_vals[-1]] * (num_planes - len(raw_vals))
    elif len(raw_vals) > num_planes:
        raise ValueError(f"vs_tiletools.{function}: Too many color values for the input format.")

    if not all(0.0 <= v <= 255.0 for v in raw_vals):
        raise ValueError(f"vs_tiletools.{function}: Color values must be in range 0–255.")

    if sample_type == vs.INTEGER:
        dst_max = (1 << clip_format.bits_per_sample) - 1
        return [int(round(v * dst_max / 255.0)) for v in raw_vals]

    if sample_type == vs.FLOAT:
        return [v / 255.0 for v in raw_vals]

    return False
    

def pad(clip, left=0, right=0, top=0, bottom=0, mode="mirror"):
    """Pads a clip with various padding modes.

    Args:
        clip: Clip to be padded. Any format.
        left, right, top, bottom: Padding amount in pixels.
        mode: Padding mode can be "mirror", "repeat", "fillmargins", "black", or a custom color in 8-bit scale [128, 128, 128].
    """
    if not isinstance(clip, vs.VideoNode):
        raise TypeError("vs_tiletools.pad: Clip must be a vapoursynth clip.")
        
    left, right, top, bottom = int(left), int(right), int(top), int(bottom)
    clip_format = clip.format
    orig_w      = clip.width
    orig_h      = clip.height
    sub_w       = 1 << (clip_format.subsampling_w or 0)
    sub_h       = 1 << (clip_format.subsampling_h or 0)
    prop_key    = "tiletools_padprops"

    if min(left, right, top, bottom) < 0:
        raise ValueError("vs_tiletools.pad: Padding values cannot be negative.")

    # check subsampling
    _check_modulus(left,  sub_w, "Left padding",  "pad", clip_format)
    _check_modulus(right, sub_w, "Right padding", "pad", clip_format)
    _check_modulus(top,   sub_h, "Top padding",   "pad", clip_format)
    _check_modulus(bottom,sub_h, "Bottom padding","pad", clip_format)

    # if padding is 0, skip padding but still set props so auto crop doesn't throw an error
    if not any((left, right, top, bottom)):
        out = clip

    # fillborder modes
    elif isinstance(mode, str) and mode in fb_modes:
        # convert to 16bit, fillboders, convert back
        if clip_format.sample_type != vs.INTEGER:
            clip_format_int = core.query_video_format(clip_format.color_family, vs.INTEGER, 16, clip_format.subsampling_w, clip_format.subsampling_h)
            clip = core.resize.Point(clip, format=clip_format_int.id)
            clip = core.std.AddBorders(clip, left=left, right=right, top=top, bottom=bottom)
            clip = core.fb.FillBorders(clip, left=left, right=right, top=top, bottom=bottom, mode=mode)
            out  = core.resize.Point(clip, format=clip_format.id)
        
        # if already integer use directly
        else:
            clip = core.std.AddBorders(clip, left=left, right=right, top=top, bottom=bottom)
            out  = core.fb.FillBorders(clip, left=left, right=right, top=top, bottom=bottom, mode=mode)

    # solid color
    else:
        color = _normalize_color(mode, clip_format, "pad")
        if color is False:
            raise TypeError("vs_tiletools.pad: Mode must be 'mirror', 'repeat', 'fillmargins', 'black', or custom color values [128, 128, 128].")
        out = core.std.AddBorders(clip, left=left, right=right, top=top, bottom=bottom, color=color)

    # pad props for auto crop
    cfg = dict(orig_w=int(orig_w), orig_h=int(orig_h), pad_l=int(left), pad_r=int(right), pad_t=int(top), pad_b=int(bottom))
    cfg_str = json.dumps(cfg, separators=(",", ":"))
    return core.std.SetFrameProp(out, prop=prop_key, data=[cfg_str])


def crop(clip, left=None, right=None, top=None, bottom=None):
    """Automatically crops padding added by pad() or mod(), even if the clip was since resized.

    Args:
        clip: Padded clip. Any format.
        left, right, top, bottom: Optional manual crop values in pixels.
    """
    if not isinstance(clip, vs.VideoNode):
        raise TypeError("vs_tiletools.crop: Clip must be a vapoursynth clip.")

    clip_format = clip.format
    width       = clip.width
    height      = clip.height
    sub_w       = 1 << (clip_format.subsampling_w or 0)
    sub_h       = 1 << (clip_format.subsampling_h or 0)
    prop_key    = "tiletools_padprops"
    manual      = any(v is not None for v in (left, right, top, bottom))

    # manual crop
    if manual:
        left   = 0 if left   is None else int(left)
        right  = 0 if right  is None else int(right)
        top    = 0 if top    is None else int(top)
        bottom = 0 if bottom is None else int(bottom)
        if min(left, right, top, bottom) < 0:
            raise ValueError("vs_tiletools.crop: Crop values can not be negative.")

    # auto crop
    else:
        f0 = clip.get_frame(0)
        if prop_key not in f0.props:
            raise KeyError("vs_tiletools.crop: Clip has no pad props. Did you pass the right clip? Were frame props deleted? You can also crop manually.")

        # stored pad props
        raw    = f0.props[prop_key]
        cfg    = json.loads(raw.decode() if isinstance(raw, (bytes, bytearray)) else raw)
        orig_w = int(cfg["orig_w"])
        orig_h = int(cfg["orig_h"])
        pad_l  = int(cfg["pad_l"])
        pad_r  = int(cfg["pad_r"])
        pad_t  = int(cfg["pad_t"])
        pad_b  = int(cfg["pad_b"])

        # scale to current dimensions
        padded_width  = orig_w + pad_l + pad_r
        padded_height = orig_h + pad_t + pad_b
        scale_x       = width  / padded_width
        scale_y       = height / padded_height
        left          = int(round(pad_l * scale_x))
        right         = int(round(pad_r * scale_x))
        top           = int(round(pad_t * scale_y))
        bottom        = int(round(pad_b * scale_y))

    # if pad is 0, just remove the props and return
    if not any((left, right, top, bottom)):
        return core.std.RemoveFrameProps(clip, props=[prop_key])

    # check subsampling
    _check_modulus(left,   sub_w, "Left crop",   "crop", clip_format)
    _check_modulus(right,  sub_w, "Right crop",  "crop", clip_format)
    _check_modulus(top,    sub_h, "Top crop",    "crop", clip_format)
    _check_modulus(bottom, sub_h, "Bottom crop", "crop", clip_format)

    # frame bounds
    if left + right >= width or top + bottom >= height:
        raise ValueError(f"vs_tiletools.crop: Crop can not be larger than frame dimensions.")

    # crop
    clip = core.std.Crop(clip, left=left, right=right, top=top, bottom=bottom)
    return core.std.RemoveFrameProps(clip, props=[prop_key])


def mod(clip, modulus=64, mode="mirror"):
    """Pads or crops a clip so width and height are multiples of the given modulus.

    Args:
        clip: Source clip. Any format.
        modulus: Dimensions will be a multiple of this value. Can be a single value, or a pair for width and height [64, 32].
        mode: Mode to reach the next upper multiple via padding can be "mirror", "repeat", "fillmargins", "black", a custom
            color in 8-bit scale [128, 128, 128], or "discard" to crop to the next lower multiple.
    """
    if not isinstance(clip, vs.VideoNode):
        raise TypeError("vs_tiletools.mod: Clip must be a vapoursynth clip.")
    if isinstance(modulus, (tuple, list)):
        if len(modulus) != 2:
            raise ValueError("vs_tiletools.mod: Modulus must be a single value, or a pair for width and height [64, 32].")
        mod_w, mod_h = int(modulus[0]), int(modulus[1])
    else:
        mod_w = mod_h = int(modulus)
    if mod_w < 1 or mod_h < 1:
        raise ValueError("vs_tiletools.mod: Modulus needs to be at least 1.")

    clip_format = clip.format
    width       = clip.width
    height      = clip.height
    sub_w       = 1 << (clip_format.subsampling_w or 0)
    sub_h       = 1 << (clip_format.subsampling_h or 0)

    # make sure modulus works with chroma subsampling
    _check_modulus(mod_w, sub_w, "Modulus", "mod", clip_format)
    _check_modulus(mod_h, sub_h, "Modulus", "mod", clip_format)

    # crop to next lower multiple
    if isinstance(mode, str) and mode == "discard":
        crop_r = width  % mod_w
        crop_b = height % mod_h
        if not any((crop_r, crop_b)):
            return clip
        return core.std.Crop(clip, right=crop_r, bottom=crop_b)

    # check if pad mode is valid
    if not ((isinstance(mode, str) and mode in fb_modes) or (_normalize_color(mode, clip_format, "mod") is not False)):
        raise TypeError("vs_tiletools.mod: Mode must be 'mirror', 'repeat', 'fillmargins', 'black', custom color values [128, 128, 128], or 'discard'.")

    # pad to next upper multiple
    pad_w  = (-width)  % mod_w
    pad_h  = (-height) % mod_h
    return pad(clip, right=pad_w, bottom=pad_h, mode=mode)  # call pad() even if pad is 0, so rops are written and auto crop still works 


def autofill(clip, left=0, right=0, top=0, bottom=0, offset=0, color=[16, 128, 128], tol=16, tol_c=None, fill="mirror"):
    """Detects uniform colored borders (like letterboxes/pillarboxes) and fills them with various filling modes.

    Args:
        clip: Source clip. Only YUV formats are supported.
        left, right, top, bottom: Maximum border fill amount in pixels.
        offset: Offsets the detected fill area by an extra amount in pixels. Useful if the borders are slightly blurry.
            Does not offset sides that have detected 0 pixels.
        color: Source clip border color in 8-bit scale [16, 128, 128].
        tol: Tolerance to account for fluctuations in border color.
        tol_c: Optional chroma tolerance; defaults to "tol" if not set.
        fill: Filling mode can be "mirror", "repeat", "fillmargins", "black", or a custom color in 8-bit scale [128, 128, 128].
    """
    
    # checks
    left, right, top, bottom, offset = map(int, (left, right, top, bottom, offset))
    if not isinstance(clip, vs.VideoNode):
        raise TypeError("vs_tiletools.autofill: Clip must be a vapoursynth clip.")
    clip_format = clip.format
    if clip_format.color_family != vs.YUV:
        raise ValueError("vs_tiletools.autofill: Clip must be in YUV format.")
    if not all(0.0 <= v <= 255.0 for v in color):
        raise ValueError("vs_tiletools.autofill: Color values must be in range 0–255.")
    if tol < 0:
        raise ValueError("vs_tiletools.autofill: Tolerance can not be negative.")
    if tol_c is not None and tol_c < 0:
        raise ValueError("vs_tiletools.autofill: Chroma tolerance can not negative.")
    if min(left, right, top, bottom) < 0:
        raise ValueError("vs_tiletools.autofill: Max fill values can not be negative.")
    if not any((left, right, top, bottom)):
        return clip


    sub_w = 1 << (clip_format.subsampling_w or 0)
    sub_h = 1 << (clip_format.subsampling_h or 0)
    tol_c = tol if tol_c is None else tol_c

    # check subsampling
    _check_modulus(left,        sub_w, "Left maximum",   "autofill", clip_format)
    _check_modulus(right,       sub_w, "Right maximum",  "autofill", clip_format)
    _check_modulus(top,         sub_h, "Top maximum",    "autofill", clip_format)
    _check_modulus(bottom,      sub_h, "Bottom maximum", "autofill", clip_format)
    _check_modulus(abs(offset), sub_w, "Offset",         "autofill", clip_format)
    _check_modulus(abs(offset), sub_h, "Offset",         "autofill", clip_format)

    # convert to integer if needed
    if clip_format.sample_type != vs.INTEGER:
        clip_format_int = core.query_video_format(clip_format.color_family, vs.INTEGER, 16, clip_format.subsampling_w, clip_format.subsampling_h)
        clip = core.resize.Point(clip, format=clip_format_int.id)

    # compute fill amount
    y, u, v    = map(int, color) # no color nomalization, cropvalues takes 8bit and scales
    color_low  = [_clamp8(y - tol), _clamp8(u - tol_c), _clamp8(v - tol_c)]
    color_high = [_clamp8(y + tol), _clamp8(u + tol_c), _clamp8(v + tol_c)]
    clip       = core.acrop.CropValues(clip, top=top, bottom=bottom, left=left, right=right, color=color_low, color_second=color_high)

    # fill border mode or solid color
    fb = isinstance(fill, str) and fill in fb_modes
    if not fb:
        fill_color = _normalize_color(fill, clip.format, "autofill")
        if fill_color is False:
            raise TypeError("vs_tiletools.autofill: Fill must be 'mirror', 'repeat', 'fillmargins', 'black', or custom color values [128, 128, 128].")

    def _fill(n, f):
        # get values
        p = f.props
        t = int(p.get('CropTopValue', 0))
        b = int(p.get('CropBottomValue', 0))
        l = int(p.get('CropLeftValue', 0))
        r = int(p.get('CropRightValue', 0))
        
        # shift fill by offset if not 0
        if offset:
            if t > 0: t = max(0, t + offset)
            if b > 0: b = max(0, b + offset)
            if l > 0: l = max(0, l + offset)
            if r > 0: r = max(0, r + offset)
    
        # fill
        if (t | b | l | r) == 0:
            return clip
        elif fb:
            return core.fb.FillBorders(clip, left=l, right=r, top=t, bottom=b, mode=fill)
        else:
            cropped = core.std.Crop(clip, left=l, right=r, top=t, bottom=b)
            return core.std.AddBorders(cropped, left=l, right=r, top=t, bottom=b, color=fill_color)
        
    out = core.std.FrameEval(clip, _fill, prop_src=[clip], clip_src=[clip])

    # convert back to original format if needed
    if clip_format.sample_type != vs.INTEGER:
        return core.resize.Point(out, format=clip_format.id)
    return out


def tile(clip, width=256, height=256, overlap=16, padding="mirror"):
    """Splits a clip into tiles of fixed dimensions to reduce resource requirements. Outputs a clip with all tiles in order.

    Args:
        clip: Clip to tile. Any format.
        width, height: Tile size of a single tile in pixel.
        overlap: Overlap from one tile to the next. When overlap is increased the tile size is not altered, so the amount
            of tiles per frame increases. Can be a single value or a pair for vertical and horizontal [16, 16].
        padding: How to handle tiles that are smaller than tile size.  These can be padded with modes "mirror", "repeat",
            "fillmargins", "black", a custom color in 8 bit scale [128, 128, 128], or just discarded with "discard".
    """
    
    # input checks
    if not isinstance(clip, vs.VideoNode):
        raise TypeError("vs_tiletools.tile: Clip must be a vapoursynth clip.")
    if width <= 1 or height <= 1:
        raise ValueError("vs_tiletools.tile: Width and height must be positive.")

    # overlap checks
    if isinstance(overlap, (tuple, list)):
        overlap_width, overlap_height = int(overlap[0]), int(overlap[1])
    else:
        overlap_width = overlap_height = int(overlap)
    if overlap_width < 0 or overlap_height < 0:
        raise ValueError("vs_tiletools.tile: Overlap can not be negative.")
    if overlap_width >= width or overlap_height >= height:
        raise ValueError("vs_tiletools.tile: Overlap must be smaller than tile size.")

    clip_format = clip.format
    orig_width  = clip.width
    orig_height = clip.height
    stride_x    = width  - overlap_width
    stride_y    = height - overlap_height
    sub_w       = 1 << clip_format.subsampling_w
    sub_h       = 1 << clip_format.subsampling_h
    max_tiles   = 1024
    
    # subsampling checks
    _check_modulus(width, sub_w, "Width", "tile", clip_format)
    _check_modulus(height, sub_h, "Height", "tile", clip_format)
    _check_modulus(overlap_width, sub_w, "Overlap", "tile", clip_format)
    _check_modulus(overlap_height, sub_h, "Overlap", "tile", clip_format)

    # padding
    discard = isinstance(padding, str) and padding == "discard"
    if discard:
        # crop to discard tiles that are smaller than tile size
        if orig_width < width or orig_height < height:
            raise ValueError("vs_tiletools.tile: Tile size must be smaller than frame size.")
        tiles_x     = 1 + (orig_width  - width)  // stride_x
        tiles_y     = 1 + (orig_height - height) // stride_y
        num_tiles   = tiles_x * tiles_y
        if num_tiles > max_tiles:
            raise ValueError(f"vs_tiletools.tile: This would create {num_tiles} tiles per frame (max {max_tiles}). Reduce overlap or increase tile size.")
        used_width  = width  + (tiles_x - 1) * stride_x
        used_height = height + (tiles_y - 1) * stride_y
        crop_r      = orig_width  - used_width
        crop_b      = orig_height - used_height
        clip        = clip if (crop_r == 0 and crop_b == 0) else core.std.Crop(clip, right=crop_r, bottom=crop_b)
    else:
        if not ((isinstance(padding, str) and (padding in fb_modes or padding == "black")) or isinstance(padding, (Real, list, tuple))):
            raise TypeError("vs_tiletools.tile: Padding must be 'mirror', 'repeat', 'fillmargins', 'discard', 'black', or color values [128, 128, 128].")
    
        # pad tiles that are smaller than tile size
        tiles_x          = 1 + (0 if orig_width  <= width  else (orig_width  - width  + stride_x - 1) // stride_x)
        tiles_y          = 1 + (0 if orig_height <= height else (orig_height - height + stride_y - 1) // stride_y)
        num_tiles        = tiles_x * tiles_y
        if num_tiles > max_tiles:
            raise ValueError(f"vs_tiletools.tile: This would create {num_tiles} tiles per frame (max {max_tiles}). Reduce overlap or increase tile size.")
        assembled_width  = width  + (tiles_x - 1) * stride_x
        assembled_height = height + (tiles_y - 1) * stride_y
        pad_r            = assembled_width  - orig_width
        pad_b            = assembled_height - orig_height
        if pad_r or pad_b:
            padded = pad(clip, right=pad_r, bottom=pad_b, mode=padding)
            clip   = core.std.CopyFrameProps(padded, clip)  # copy previous pad props in case pad was used already

    # create tiles via cropping in row-major order
    tiles = []
    stride_y_eff = height - overlap_height
    stride_x_eff = width  - overlap_width
    for j in range(tiles_y):
        top = j * stride_y_eff
        for i in range(tiles_x):
            left = i * stride_x_eff
            tiles.append(core.std.CropAbs(clip, width=width, height=height, left=left, top=top))
    out = core.std.Interleave(tiles, modify_duration=False)

    # add frame props for untile
    prop_key = "tiletools_tileprops"
    cfg = dict(
        tile_w    = int(width),
        tile_h    = int(height),
        overlap_w = int(overlap_width),
        overlap_h = int(overlap_height),
        orig_w    = int(orig_width),
        orig_h    = int(orig_height),
        discard   = bool(discard),
    )
    cfg_str = json.dumps(cfg, separators=(",", ":"))
    return core.std.SetFrameProp(out, prop=prop_key, data=[cfg_str])


def untile(clip, fade=False, full_width=None, full_height=None, overlap=None):
    """Automatically reassembles a clip tiled with tile(), even if tiles were since resized.

    Args:
        clip: Tiled clip. Any format.
        fade: If True, feather/blend across overlaps; if False, crop overlaps.
        full_width, full_height, overlap: Optional manual parameters. Needed is the full assembled frame dimensions
            and the overlap between tiles. In manual mode you have to account for resized or discarded tiles yourself.  
            Tip: If tiles were discarded, the full_width/full_height are now smaller and a multiple of the original tile size.  
            Tip: If tiles were resized 2x, simply double all values.
    """
    
    # check input
    if not isinstance(clip, vs.VideoNode):
        raise TypeError("vs_tiletools.untile: Clip must be a vapoursynth clip.")

    # input clip props
    tile_width  = clip.width
    tile_height = clip.height
    clip_format = clip.format
    num_frames  = clip.num_frames
    sub_w       = 1 << (clip_format.subsampling_w or 0)
    sub_h       = 1 << (clip_format.subsampling_h or 0)
    prop_key    = "tiletools_tileprops"
    max_tiles   = 1024

    # decide mode
    manual = any(x is not None for x in (overlap, full_width, full_height))
    if manual and not all(x is not None for x in (overlap, full_width, full_height)):
        raise ValueError("vs_tiletools.untile: In manual mode 'full_width', 'full_height', and 'overlap' are used together. Provide all or none to read them from the frame props.")

    if manual:
        # normalize overlap
        if isinstance(overlap, (tuple, list)):
            if len(overlap) != 2:
                raise ValueError("vs_tiletools.untile: Overlap must be a single value, or a pair [overlap_w, overlap_h].")
            overlap_width, overlap_height = int(overlap[0]), int(overlap[1])
        else:
            overlap_width = overlap_height = int(overlap)
        if overlap_width < 0 or overlap_height < 0:
            raise ValueError("vs_tiletools.untile: Overlap cannot be negative.")
        if overlap_width >= tile_width or overlap_height >= tile_height:
            raise ValueError("vs_tiletools.untile: Overlap must be smaller than tile size.")

        orig_width  = int(full_width)
        orig_height = int(full_height)

        # subsampling checks
        _check_modulus(overlap_width, sub_w, "Overlap", "untile", clip_format)
        _check_modulus(overlap_height, sub_h, "Overlap", "untile", clip_format)
        _check_modulus(orig_width, sub_w, "Full_width", "untile", clip_format)
        _check_modulus(orig_height, sub_h, "Full_height", "untile", clip_format)

        # strides
        stride_x = tile_width  - overlap_width
        stride_y = tile_height - overlap_height
        if stride_x <= 0 or stride_y <= 0:
            raise ValueError("vs_tiletools.untile: Overlap must be smaller than tile size.")

        # grid size
        tiles_x = 1 + (0 if orig_width  <= tile_width  else (orig_width  - tile_width  + stride_x - 1) // stride_x)
        tiles_y = 1 + (0 if orig_height <= tile_height else (orig_height - tile_height + stride_y - 1) // stride_y)
        assembled_width  = tile_width  + (tiles_x - 1) * stride_x
        assembled_height = tile_height + (tiles_y - 1) * stride_y
        pad_r = max(0, assembled_width  - orig_width)
        pad_b = max(0, assembled_height - orig_height)

    else:
        # check for tile props
        f0 = clip.get_frame(0)
        if prop_key not in f0.props:
            raise KeyError("vs_tiletools.untile: Clip has no tile props. Did you pass the right clip? Were some frame props deleted? You can also provide them manually.")

        # stored tile props
        raw = f0.props[prop_key]
        cfg = json.loads(raw.decode() if isinstance(raw, (bytes, bytearray)) else raw)
        orig_tile_w    = int(cfg["tile_w"])
        orig_tile_h    = int(cfg["tile_h"])
        orig_overlap_w = int(cfg["overlap_w"])
        orig_overlap_h = int(cfg["overlap_h"])
        orig_frame_w   = int(cfg["orig_w"])
        orig_frame_h   = int(cfg["orig_h"])
        discard        = bool(cfg.get("discard", False))

        # compute scales in case the tiles were resized after tiling
        scale_x = tile_width  / orig_tile_w
        scale_y = tile_height / orig_tile_h

        # scale props if needed
        overlap_width  = int(round(orig_overlap_w * scale_x))
        overlap_height = int(round(orig_overlap_h * scale_y))
        orig_width     = int(round(orig_frame_w * scale_x))
        orig_height    = int(round(orig_frame_h * scale_y))

        # make sure all dimensions are divisible by subsampling
        if sub_w > 1:
            orig_width     -= orig_width % sub_w
        if sub_h > 1:
            orig_height    -= orig_height % sub_h
        if sub_w > 1:
            overlap_width  -= overlap_width  % sub_w
        if sub_h > 1:
            overlap_height -= overlap_height % sub_h

        # keep overlaps within valid range to ensure positive strides
        overlap_width  = max(0, min(overlap_width,  tile_width  - 1))
        overlap_height = max(0, min(overlap_height, tile_height - 1))

        # strides
        stride_x = tile_width  - overlap_width
        stride_y = tile_height - overlap_height

        # derive grid size
        if discard:
            if orig_width < tile_width or orig_height < tile_height:
                raise ValueError("vs_tiletools.untile: Frame size is smaller than a single tile.")
            tiles_x = 1 + (orig_width  - tile_width)  // stride_x
            tiles_y = 1 + (orig_height - tile_height) // stride_y
            pad_r   = 0
            pad_b   = 0
        else:
            tiles_x          = 1 + (0 if orig_width  <= tile_width  else (orig_width  - tile_width  + stride_x - 1) // stride_x)
            tiles_y          = 1 + (0 if orig_height <= tile_height else (orig_height - tile_height + stride_y - 1) // stride_y)
            assembled_width  = tile_width  + (tiles_x - 1) * stride_x
            assembled_height = tile_height + (tiles_y - 1) * stride_y
            pad_r            = max(0, assembled_width  - orig_width)
            pad_b            = max(0, assembled_height - orig_height)

    # deinterleave into tiles
    num_tiles = tiles_x * tiles_y
    if num_tiles > max_tiles:
        raise ValueError(f"vs_tiletools.untile: This would assemble {num_tiles} tiles per frame (max {max_tiles}). Reduce overlap or increase tile size.")
    if num_frames and num_frames % num_tiles != 0:
        raise ValueError(f"vs_tiletools.untile: Clip length ({num_frames} frames) is not divisible by the tiles per frame ({num_tiles} tiles). Was the clip trimmed after tiling?")
    parts = [core.std.SelectEvery(clip, cycle=num_tiles, offsets=i, modify_duration=False) for i in range(num_tiles)]

    def _crop_tiles(clip, col, row):
        # split and crop overlap
        def _split_overlap(overlap, unit):
            if overlap <= 0:
                return 0, 0
            if unit > 1:
                overlap -= overlap % unit
            h = overlap // 2
            if unit > 1:
                h -= h % unit
            a = h
            b = overlap - a
            return a, b

        half_w_l, half_w_r = _split_overlap(overlap_width,  sub_w)
        half_h_t, half_h_b = _split_overlap(overlap_height, sub_h)

        crop_left   = half_w_l if col > 0 else 0
        crop_right  = half_w_r if col < tiles_x - 1 else 0
        crop_top    = half_h_t if row > 0 else 0
        crop_bottom = half_h_b if row < tiles_y - 1 else 0

        if crop_left or crop_right or crop_top or crop_bottom:
            return core.std.Crop(clip, left=crop_left, right=crop_right, top=crop_top, bottom=crop_bottom)
        return clip

    # mask format and peak 
    mask_format = core.query_video_format(color_family=vs.GRAY, sample_type=clip_format.sample_type, bits_per_sample=clip_format.bits_per_sample, subsampling_w=0, subsampling_h=0)
    mask_peak   = (1.0 if clip_format.sample_type == vs.FLOAT else (1 << clip_format.bits_per_sample) - 1)

    # generate masks for fading
    def _mask_horizontal(h):
        if overlap_width <= 0:
            return None
        black = core.std.BlankClip(clip=clip, format=mask_format.id, width=1, height=1, color=[0], keep=True)
        white = core.std.BlankClip(clip=clip, format=mask_format.id, width=1, height=1, color=[mask_peak], keep=True)
        gradient = core.std.StackHorizontal([black, white])
        return core.resize.Bilinear(gradient, width=overlap_width, height=h, src_left=0.5, src_width=1.0, src_top=0.0,  src_height=1.0)

    def _mask_vertical(w):
        if overlap_height <= 0:
            return None
        black = core.std.BlankClip(clip=clip, format=mask_format.id, width=1, height=1, color=[0], keep=True)
        white = core.std.BlankClip(clip=clip, format=mask_format.id, width=1, height=1, color=[mask_peak], keep=True)
        gradient = core.std.StackVertical([black, white])
        return core.resize.Bilinear(gradient, width=w, height=overlap_height, src_top=0.5,  src_height=1.0, src_left=0.0, src_width=1.0)

    # do fading
    def _fade_horizontal(left, right):
        # fade two tiles horizontally
        if overlap_width <= 0:
            return core.std.StackHorizontal([left, right])
        keep_left      = core.std.Crop(left,  right=overlap_width)
        keep_right     = core.std.Crop(right, left=overlap_width)
        overlap_left   = core.std.Crop(left,  left=left.width - overlap_width)
        overlap_right  = core.std.Crop(right, right=right.width - overlap_width)
        mask           = _mask_horizontal(left.height)
        overlap        = core.std.MaskedMerge(overlap_left, overlap_right, mask)
        return core.std.StackHorizontal([keep_left, overlap, keep_right])

    def _fade_vertical(top, bottom):
        # fade two rows vertically
        if overlap_height <= 0:
            return core.std.StackVertical([top, bottom])
        keep_top       = core.std.Crop(top,    bottom=overlap_height)
        keep_bottom    = core.std.Crop(bottom, top=overlap_height)
        overlap_top    = core.std.Crop(top,    top=top.height - overlap_height)
        overlap_bottom = core.std.Crop(bottom, bottom=bottom.height - overlap_height)
        mask           = _mask_vertical(top.width)
        overlap        = core.std.MaskedMerge(overlap_top, overlap_bottom, mask)
        return core.std.StackVertical([keep_top, overlap, keep_bottom])

    if not fade:
        # crop half overlaps and stack
        rows = []
        for j in range(tiles_y):
            row_tiles = [_crop_tiles(parts[j * tiles_x + i], i, j) for i in range(tiles_x)]
            row = row_tiles[0] if tiles_x == 1 else core.std.StackHorizontal(row_tiles)
            rows.append(row)
        full = rows[0] if tiles_y == 1 else core.std.StackVertical(rows)
    else:
        # fade horizontally across each row
        rows = []
        for j in range(tiles_y):
            row = parts[j * tiles_x + 0]
            for i in range(1, tiles_x):
                row = _fade_horizontal(row, parts[j * tiles_x + i])
            rows.append(row)
        # fade vertically across the rows
        full = rows[0]
        for j in range(1, tiles_y):
            full = _fade_vertical(full, rows[j])

    # remove padding if needed
    if pad_r or pad_b:
        full = core.std.Crop(full, right=pad_r, bottom=pad_b)

    return core.std.RemoveFrameProps(full, props=[prop_key])


def tpad(clip, start=0, end=0, length=None, mode="mirror"):
    """Temporally pads (extends) a clip using various padding modes.

    Args:
        clip: Clip to pad. Any format.
        start, end: Number of frames to add at the start and/or end. Mutually exclusive with length. 
        length: Pads clip to this absolute number of frames. Mutually exclusive with start/end. 
        mode: "mirror", "repeat", "black", or a custom color in 8-bit scale like [128, 128, 128].
    """
    if not isinstance(clip, vs.VideoNode):
        raise TypeError("vs_tiletools.tpad: Clip must be a vapoursynth clip.")
    if length is not None and (start or end):
        raise ValueError("vs_tiletools.tpad: Use either start and end to add that number of frames, or length to pad to an absolute length.")
    if length is not None and length < 1:
        raise ValueError("vs_tiletools.tpad: Length must be at least 1.")
    if start < 0 or end < 0:
        raise ValueError("vs_tiletools.tpad: Start or end can not be negative.")

    # determine how many frames to add
    if length is not None:
        add_start = 0
        add_end   = max(0, length - clip.num_frames)
    else:
        add_start = int(start)
        add_end   = int(end)

    color_props = ['_Matrix','_Transfer','_Primaries','_ColorRange', '_ChromaLocation','_SARNum','_SARDen','_FieldBased']
    prop_key    = "tiletools_tpadprops"
    pad_mode    = mode
    out         = clip

    def _end_pad(clip, n):
        # mirror frames
        if pad_mode == "mirror":
            if clip.num_frames == 1:
                return core.std.Loop(clip, times=n)
            reverse  = core.std.Reverse(clip[:-1])  # trim to avoid duplicates
            forward  = clip[1:]                     # trim to avoid duplicates
            pingpong = reverse + forward
            repeats  = (n + pingpong.num_frames - 1) // max(1, pingpong.num_frames)
            return (pingpong * repeats)[:n]
        
        # repeat last frame
        if pad_mode == "repeat":
            last = core.std.Trim(clip, first=clip.num_frames - 1, length=1)
            return core.std.Loop(last, times=n)
        
        # solid color
        color = _normalize_color(pad_mode, clip.format, "tpad")
        if color is False:
            raise ValueError("vs_tiletools.tpad: Mode must be 'mirror', 'repeat', 'black', or a custom color like [128, 128, 128].")
        blank = core.std.BlankClip(clip=clip, length=n, color=color, keep=True)
        last1 = core.std.Trim(clip, first=clip.num_frames - 1, length=1)
        return core.std.CopyFrameProps(blank, last1, props=color_props) # props could be needed for format convertions

    def _start_pad(clip, n):
        # mirror frames
        if pad_mode == "mirror":
            if clip.num_frames == 1:
                return core.std.Loop(clip, times=n)
            forward  = clip[1:]                     # trim to avoid duplicates
            reverse  = core.std.Reverse(clip[:-1])  # trim to avoid duplicates
            pingpong = forward + reverse
            repeats  = (n + pingpong.num_frames - 1) // max(1, pingpong.num_frames)
            trimmed  = (pingpong * repeats)[:n]
            return core.std.Reverse(trimmed)
            
        # repeat first frame
        if pad_mode == "repeat":
            first = core.std.Trim(clip, first=0, length=1)
            return core.std.Loop(first, times=n)
        
        # solid color
        color = _normalize_color(pad_mode, clip.format, "tpad")
        if color is False:
            raise ValueError("vs_tiletools.tpad: Mode must be 'mirror', 'repeat', 'black', or a custom color like [128, 128, 128].")
        blank = core.std.BlankClip(clip=clip, length=n, color=color, keep=True)
        first1 = core.std.Trim(clip, first=0, length=1)
        return core.std.CopyFrameProps(blank, first1, props=color_props) # props could be needed for format convertions
    
    # pad
    if add_start > 0:
        head = _start_pad(clip, add_start)
        out  = head + out
    if add_end > 0:
        tail = _end_pad(clip, add_end)
        out  = out + tail

    # set frame props for autotrim
    cfg = dict(start_pad=int(add_start), end_pad=int(add_end))
    cfg_str = json.dumps(cfg, separators=(",", ":"))
    return core.std.SetFrameProp(out, prop=prop_key, data=[cfg_str])


def trim(clip, start=None, end=None, length=None):
    """Automatically trims temporal padding added by tpad().
    
    Args:
        clip: Temporally padded clip. Any format.
        start, end: Optional manual number of frames to remove from start and/or end. Mutually exclusive with length.
        length: Optional manual trim to exactly this many frames. Mutually exclusive with start/end.
    """
    if not isinstance(clip, vs.VideoNode):
        raise TypeError("vs_tiletools.trim: Clip must be a vapoursynth clip.")

    prop_key = "tiletools_tpadprops"
    manual   = any(v is not None for v in (start, end, length))
    
    # manual trim
    if manual:
        if length is not None and (start or end):
            raise ValueError("vs_tiletools.trim: Use either start/end or length, not both.")
        
        if length is not None:
            length = int(length)
            if length < 1:
                raise ValueError("vs_tiletools.trim: Length must be at least 1.")
            if length > clip.num_frames:
                raise ValueError("vs_tiletools.trim: Length can not be larger than clip length.")
            start_pad = 0
            end_pad   = clip.num_frames - length
        else:
            start_pad = 0 if start is None else int(start)
            end_pad   = 0 if end   is None else int(end)

    # auto trim
    else:
        f0 = clip.get_frame(0)
        if prop_key not in f0.props:
            raise KeyError("vs_tiletools.trim: Clip has no temporal pad props. Did you pass the right clip? Were frame props deleted? You can also trim manually.")

        raw       = f0.props[prop_key]
        cfg       = json.loads(raw.decode() if isinstance(raw, (bytes, bytearray)) else raw)
        start_pad = int(cfg.get("start_pad", 0))
        end_pad   = int(cfg.get("end_pad", 0))

    # if nothing to trim, just remove props and return
    if start_pad == 0 and end_pad == 0:
        return core.std.RemoveFrameProps(clip, props=[prop_key])

    if start_pad < 0 or end_pad < 0:
        raise ValueError("vs_tiletools.trim: Start or end can not be negative.")
    if start_pad + end_pad >= clip.num_frames:
        raise ValueError("vs_tiletools.trim: Trim can not be larger than clip length.")

    # trim and remove frame props
    out = clip[start_pad: clip.num_frames - end_pad] if end_pad else clip[start_pad:]
    return core.std.RemoveFrameProps(out, props=[prop_key])


def crossfade(clipa, clipb, length=10):
    """Crossfades between two clips without FrameEval/ModifyFrame.

    Args:
        clipa, clipb: Input clips to crossfade. Any format, as long as they match.
        length: Length of the crossfade. For example, 10 will fade the last 10 frames of clipa
            into the first 10 frames of clipb.
    """
    
    # checks
    if not isinstance(clipa, vs.VideoNode):
        raise TypeError("vs_tiletools.crossfade: First input clip must be a vapoursynth clip.")
    if not isinstance(clipb, vs.VideoNode):
        raise TypeError("vs_tiletools.crossfade: Second input clip must be a vapoursynth clip.")
    if clipa.format.id != clipb.format.id or clipa.width != clipb.width or clipa.height != clipb.height:
        raise ValueError("vs_tiletools.crossfade: Both clips must have the same format and dimensions.")
    if length <= 0:
        return core.std.Splice([clipa, clipb])

    a_tail = clipa[-length:]
    b_head = clipb[:length]

    clip_format = clipa.format
    fade_levels = []
    
    # get correct gray format to match clip
    if clip_format.color_family == vs.GRAY:
        mask_fmt = clip_format
    else:
        mask_fmt = core.query_video_format(vs.GRAY, clip_format.sample_type, clip_format.bits_per_sample, 0, 0)

    # generate 1 frame long clips with increasing brightness
    if clipa.format.sample_type == vs.INTEGER:
        peak = (1 << clipa.format.bits_per_sample) - 1
        for n in range(length):
            v = int(round(peak * (n + 1) / (length + 1)))
            fade_levels.append(core.std.BlankClip(clip=a_tail, format=mask_fmt.id, length=1, color=[v], keep=True))
    else:  # float
        for n in range(length):
            w = (n + 1) / (length + 1)
            fade_levels.append(core.std.BlankClip(clip=a_tail, format=mask_fmt.id, length=1, color=[w], keep=True))

    # splice all levels together to get fade mask clip
    mask = core.std.Splice(fade_levels)

    # blend and reassemble
    fade = core.std.MaskedMerge(clipa=a_tail, clipb=b_head, mask=mask)
    parts = []
    if clipa.num_frames > length:
        parts.append(clipa[:-length])
    parts.append(fade)
    if clipb.num_frames > length:
        parts.append(clipb[length:])
    return core.std.Splice(parts)


def window(clip, length=20, overlap=5, padding="mirror"):
    """Inserts temporal overlaps at the end of each temporal window into the clip. That means a window with 
        length=20 and overlap=5 will produce a clip with this frame pattern: 0–19, 15–34, 30–49, and so on.
        In combination with the unwindow function, the overlap can then be used to crossfade between windows and
        eliminate sudden jumps/seams that can occur on window based functions like https://github.com/pifroggi/vs_undistort.

    Args:
        clip: Clip that should be windowed. Any format.
        length: Temporal window length.
        overlap: Overlap from one window to the next. When overlap is increased, the temporal window length is not
            altered, so the total amount of windows per clip increases.
        padding: How to handle the last window of the clip if it is smaller than length. It can be padded with modes "mirror",
            "repeat", "black", a custom color in 8-bit scale [128, 128, 128], discarded with "discard", or left as is with "None".
    """
    
    # checks
    if not isinstance(clip, vs.VideoNode):
        raise TypeError("vs_tiletools.window: Clip must be a vapoursynth clip.")
    if length < 1:
        raise ValueError("vs_tiletools.window: Temporal window length must be at least 1.")
    if overlap < 0 or overlap >= length:
        raise ValueError("vs_tiletools.window: Overlap can not be negative and smaller than length.")

    num_frames  = clip.num_frames
    stride      = length - overlap

    window_list = []
    start_frame = 0
    while start_frame < num_frames:
        end_frame   = min(num_frames - 1, start_frame + length - 1)
        window_clip = core.std.Trim(clip, first=start_frame, last=end_frame)

        frames_present = end_frame - start_frame + 1
        frames_missing = length - frames_present

        if frames_missing > 0:
            pad_mode = padding

            # drop final short window
            if pad_mode == "discard":
                break

            # leave shorter as is
            elif pad_mode is None or (isinstance(pad_mode, str) and pad_mode == "none"):
                padded_window = window_clip  

            # pad with tpad
            elif (isinstance(pad_mode, str) and pad_mode in {"mirror", "repeat", "black"}) or isinstance(pad_mode, (Real, list, tuple)):
                padded_window = tpad(window_clip, length=length, mode=pad_mode)
                padded_window = core.std.CopyFrameProps(padded_window, window_clip)  # copy previous tpad props in case tpad was used already

            else:
                raise ValueError("vs_tiletools.window: Padding must be 'mirror', 'repeat', 'black', or a custom color like [128, 128, 128].")
        
        else:
            padded_window = window_clip

        window_list.append(padded_window)
        start_frame += stride

    out = core.std.Splice(window_list)

    # window props
    if isinstance(padding, (list, tuple)):
        pad_tag = "color"
    elif padding is None:
        pad_tag = "none"
    elif isinstance(padding, str):
        pad_tag = padding
    else:
        pad_tag = "none"

    prop_key = "tiletools_windowprops"
    cfg = dict(
        orig_length=int(num_frames),
        window_length=int(length),
        overlap=int(overlap),
        padding=pad_tag,
    )
    cfg_str = json.dumps(cfg, separators=(",", ":"))
    return core.std.SetFrameProp(out, prop=prop_key, data=[cfg_str])


def unwindow(clip, fade=False, full_length=None, window_length=None, overlap=None):
    """Automatically removes the overlap from a clip from window() and optionally uses it to crossfade between windows.

    Args:
        clip: Windowed clip. Any format.
        fade: If True, crossfade across overlaps; if False, trim overlaps.
        full_length, window_length, overlap: Optional manual parameters. Needed is the full clip length, window
            length and the overlap between windows. In manual mode you have to account for a discarded window yourself.  
            Tip: If the last window was discarded, the full_length is now smaller and a multiple of window_length.  
            Tip: If the windowed clip was interpolated to 2x, simply double all values.
    """
    if not isinstance(clip, vs.VideoNode):
        raise TypeError("vs_tiletools.unwindow: Clip must be a vapoursynth clip.")

    # decide mode
    prop_key = "tiletools_windowprops"
    manual   = any(x is not None for x in (full_length, window_length, overlap))
    if manual and not all(x is not None for x in (full_length, window_length, overlap)):
        raise ValueError("vs_tiletools.unwindow: In manual mode 'full_length', 'window_length', and 'overlap' are used together. Provide all or none to read them from the frame props.")

    if manual:
        original_length = int(full_length)
        window_length   = int(window_length)
        overlap         = int(overlap)

        if window_length < 1:
            raise ValueError("vs_tiletools.unwindow: Window length must be at least 1.")
        if overlap < 0 or overlap >= window_length:
            raise ValueError("vs_tiletools.unwindow: Overlap can not be negative and must be smaller than window length.")

    else:
        # get stored window props
        f0 = clip.get_frame(0)
        if prop_key not in f0.props:
            raise KeyError("vs_tiletools.unwindow: Clip has no temporal window props. Did you pass the right clip? Were some frame props deleted? You can also provide them manually.")

        # stored window props
        raw = f0.props[prop_key]
        cfg = json.loads(raw.decode() if isinstance(raw, (bytes, bytearray)) else raw)
        original_length = int(cfg["orig_length"])
        window_length   = int(cfg["window_length"])
        overlap         = int(cfg["overlap"])

    # split the concatenated clip back into windows
    num_frames  = clip.num_frames
    num_windows = (num_frames + window_length - 1) // window_length
    window_list: list[vs.VideoNode] = []
    for i in range(num_windows):
        start = i * window_length
        end   = min((i + 1) * window_length, num_frames)
        window_list.append(clip[start:end])

    # remove overlap and reassemble with optional crossfade
    reassembled = window_list[0]
    for next_window in window_list[1:]:
        if fade and overlap > 0:
            crossfade_length = min(overlap, reassembled.num_frames, next_window.num_frames)
            if crossfade_length > 0:
                reassembled = crossfade(reassembled, next_window, crossfade_length)
            else:
                reassembled = core.std.Splice([reassembled, next_window])
        else:
            drop = min(overlap, next_window.num_frames)
            reassembled = core.std.Splice([reassembled, next_window[drop:]])

    # trim to original length
    final_length = min(original_length, reassembled.num_frames)
    out = reassembled[:final_length]
    return core.std.RemoveFrameProps(out, props=[prop_key])
