# Script to run "Turbulence Mitigation Transformer" https://github.com/xg416/TMT

# Vapoursynth Implementation by pifroggi https://github.com/pifroggi/vs_undistort
# or tepete and pifroggi on Discord

import vapoursynth as vs
import os
import torch
import numpy as np
from .TMT_dynamic_1st_stage import process_images
from .UNet3d_TMT import DetiltUNet3DS

core = vs.core


def frames_to_tensor(frames, device):
    temp_window = len(frames)
    h, w = frames[0].height, frames[0].width
    num_planes = frames[0].format.num_planes
    arr = np.empty((temp_window, num_planes, h, w), dtype=np.float32)
    for i, fr in enumerate(frames):
        for p in range(num_planes):
            arr[i, p] = np.asarray(fr[p], dtype=np.float32)
    return torch.from_numpy(arr).to(device).clamp_(0, 1)


def tensor_to_frame(tensor, frame):
    tensor_np = tensor.detach().cpu().numpy()
    for p in range(frame.format.num_planes):
        frame_arr = np.asarray(frame[p])
        np.copyto(frame_arr, tensor_np[:, :, p])


def load_model(device):
    model_tilt = DetiltUNet3DS(norm="LN", residual="pool", conv_type="dw").to(device)
    current_folder = os.path.dirname(os.path.abspath(__file__))
    path_tilt = os.path.join(current_folder, "dynamic_1st_stage.pth")
    ckpt_tilt = torch.load(path_tilt, map_location=device)
    model_tilt.load_state_dict(ckpt_tilt["state_dict"] if "state_dict" in ckpt_tilt else ckpt_tilt)
    model_tilt.eval()
    return model_tilt


def get_window(clip, temp_window):
    # how many pad frames to reach a multiple of temp_window
    num_frames = clip.num_frames
    pad = (-num_frames) % temp_window

    if pad:
        # pad black frames if too short
        pad_clip = core.std.BlankClip(clip=clip, length=pad)
        clip     = core.std.Splice([clip, pad_clip])

    return [core.std.SelectEvery(clip[i:], cycle=temp_window, offsets=[0]) for i in range(temp_window)]


def vs_undistort(clip, temp_window=10, tile_width=480, tile_height=480, device="cuda"):
    # checks
    if not isinstance(clip, vs.VideoNode):
        raise TypeError("vs_undistort: Clip must be a vapoursynth clip.")
    if clip.format.id not in [vs.RGBS]:
        raise ValueError("vs_undistort: Clip must be in RGBS format.")
    if temp_window < 1:
        raise ValueError("vs_undistort: Temporal window must be at least 1.")
    if tile_width % 16 != 0 or tile_height % 16 != 0:
        closest_w = round(tile_width  / 16) * 16
        closest_h = round(tile_height / 16) * 16
        raise ValueError(f"vs_undistort: Tile size must be a multiple of 16. Closest values: {closest_w} x {closest_h}.")

    width  = clip.width
    height = clip.height
    device = torch.device(device)
    model_tilt = load_model(device)

    def process_window(n, f):
        fout = f[0].copy()
        window_frames  = f[1:]
        frames_tensor  = frames_to_tensor(window_frames, device)
        stacked_tensor = process_images(frames_tensor, tile_height, tile_width, model_tilt)
        tensor_to_frame(stacked_tensor, fout)
        return fout

    offset_clips   = get_window(clip, temp_window)
    out_shape      = core.std.BlankClip(clip=offset_clips[0], width=width * temp_window, height=height, keep=True)
    stacked_clip   = core.std.ModifyFrame(out_shape, clips=[out_shape, *offset_clips], selector=process_window)
    offset_clips   = [core.std.Crop(stacked_clip, left=i * width, right=(temp_window - 1 - i) * width) for i in range(temp_window)]
    unstacked_clip = core.std.Interleave(offset_clips)
    unstacked_clip = core.std.Trim(unstacked_clip, last=clip.num_frames - 1)
    return core.std.CopyFrameProps(unstacked_clip, clip)
