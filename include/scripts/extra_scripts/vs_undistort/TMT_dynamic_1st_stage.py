# Code from "Turbulence Mitigation Transformer" https://github.com/xg416/TMT

# Vapoursynth Implementation by pifroggi https://github.com/pifroggi/vs_undistort
# or tepete and pifroggi on Discord

import torch


def split_to_patches(h, w, s_h, s_w):
    nh = h // s_h + (1 if h % s_h != 0 else 0)
    nw = w // s_w + (1 if w % s_w != 0 else 0)
    ol_h = int((nh * s_h - h) / (nh - 1)) if nh > 1 else 0
    ol_w = int((nw * s_w - w) / (nw - 1)) if nw > 1 else 0
    hpos, wpos = [0], [0]
    for _ in range(1, nh):
        hpos.append(min(hpos[-1] + s_h - ol_h, h - s_h))
    for _ in range(1, nw):
        wpos.append(min(wpos[-1] + s_w - ol_w, w - s_w))
    return hpos, wpos

def test_spatial_overlap(input_blk, model_tilt, patch_height, patch_width):
    b, l, c, h, w = input_blk.shape
    hpos, wpos = split_to_patches(h, w, patch_height, patch_width)
    out_spaces = torch.zeros_like(input_blk)                                               # (B, L, C, H, W)
    out_counts = torch.zeros((b, 1, 1, h, w), device=input_blk.device, dtype=torch.int16)  # (B, 1, 1, H, W)
    ones_count = None

    for hi in hpos:
        for wi in wpos:
            inp = input_blk[..., hi:hi + patch_height, wi:wi + patch_width]                # (B, L, C, ph, pw)
            _, _, rectified = model_tilt(inp)
            hs, ws = rectified.shape[-2:]
            out_spaces[..., hi:hi + hs, wi:wi + ws].add_(rectified)
            if ones_count is None or ones_count.shape[-2:] != (hs, ws):
                ones_count = torch.ones((1, 1, 1, hs, ws), device=input_blk.device, dtype=out_counts.dtype)
            out_counts[..., hi:hi + hs, wi:wi + ws].add_(ones_count)

    return out_spaces / out_counts


def process_images(frames_tensor, patch_height, patch_width, model_tilt):
    T, C, H, W = frames_tensor.shape
    input_blk  = frames_tensor.unsqueeze(0)                                                # (1, T, C, H, W)

    with torch.inference_mode():
        if input_blk.device.type == "cuda":
            with torch.amp.autocast(device_type="cuda"):
                recovered = test_spatial_overlap(input_blk, model_tilt, patch_height, patch_width)
        else:
            recovered = test_spatial_overlap(input_blk, model_tilt, patch_height, patch_width)

    recovered = recovered[0]
    stacked   = recovered.permute(2, 0, 3, 1).contiguous().reshape(H, T * W, C)  # output one large frame to let vs handle the caching
    return stacked
