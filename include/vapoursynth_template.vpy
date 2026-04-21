import vapoursynth as vs
core = vs.core
core.max_cache_size = 15000

# Load source video
source_path = "{{INPUT_VIDEO}}"
clip = core.bs.VideoSource(source=source_path, cachemode=3)


# default values
default_matrix    = "{{DEFAULT_MATRIX}}"
default_primaries = "{{DEFAULT_PRIMARIES}}"
default_transfer  = "{{DEFAULT_TRANSFER}}"
default_depth     = 16
overwrite_matrix  = {{OVERWRITE_MATRIX}}
matrix_709        = {{MATRIX_709}}
input_format      = clip.format.id
output_format     = {{OUTPUT_FORMAT}}


# overwrite clip color tagging
if overwrite_matrix and clip.format.color_family != vs.RGB: # rgb has no matrix
    if matrix_709: # mostly HD
        clip = core.std.SetFrameProps(clip, _Matrix=vs.MATRIX_BT709,   _Transfer=vs.TRANSFER_BT709, _Primaries=vs.PRIMARIES_BT709,   _ColorRange=vs.RANGE_LIMITED)
    else:          # mostly SD
        clip = core.std.SetFrameProps(clip, _Matrix=vs.MATRIX_ST170_M, _Transfer=vs.TRANSFER_BT601, _Primaries=vs.PRIMARIES_ST170_M, _ColorRange=vs.RANGE_LIMITED)


# find and convert to filter format
filter_format = core.query_video_format(vs.YUV, vs.INTEGER, default_depth, clip.format.subsampling_w, clip.format.subsampling_h)
if clip.format.id != filter_format.id:
    if clip.format.color_family == vs.RGB:
        clip = core.resize.Point(clip, format=filter_format.id, primaries_in_s="709", transfer_in_s="709", matrix_s=default_matrix, primaries_s=default_primaries, transfer_s=default_transfer)
    else:
        clip = core.resize.Point(clip, format=filter_format.id, matrix_in_s=default_matrix, primaries_in_s=default_primaries, transfer_in_s=default_transfer)


# reference to original unprocessed clip
original_clip = clip


{{FILTERS}}


# convert to output format and output
output_format = core.get_video_format(output_format)
color_family  = output_format.color_family 
if clip.format.id != output_format:
    if color_family == vs.RGB:
        clip = core.resize.Bilinear(clip, format=output_format, primaries_s="709", transfer_s="709", dither_type="error_diffusion")
    else:
        clip = core.resize.Bilinear(clip, format=output_format, primaries_s="709", transfer_s="709", dither_type="error_diffusion", matrix_s="709")
clip.set_output()
