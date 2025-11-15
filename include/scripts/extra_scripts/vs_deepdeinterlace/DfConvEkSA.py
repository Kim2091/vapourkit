
# Original paper https://arxiv.org/pdf/2404.13018
# Original code https://github.com/KUIS-AI-Tekalp-Research-Group/Video-Deinterlacing

# Vapoursynth implementation by pifroggi
# or tepete on the "Enhance Everything!" Discord Server

import vapoursynth as vs
import os
import torch
import numpy as np
import functools

core = vs.core

def frame_to_array(frame: vs.VideoFrame) -> np.ndarray:
    array = np.empty((frame.height, frame.width, 3), dtype=np.float32)
    for p in range(frame.format.num_planes):
        array[..., p] = np.asarray(frame[p], dtype=np.float32)
    return array

def array_to_frame(img: np.ndarray, frame: vs.VideoFrame):
    for p in range(frame.format.num_planes):
        pls = frame[p]
        frame_arr = np.asarray(pls)
        np.copyto(frame_arr, img[:, :, p])

def tensor_to_array(tensor, min_max=(0, 1)):
    tensor = tensor.squeeze().float().cpu().clamp_(*min_max)
    tensor = (tensor - min_max[0]) / (min_max[1] - min_max[0])
    img_np = tensor.detach().numpy()
    img_np = np.transpose(img_np[[2, 1, 0], :, :], (1, 2, 0))
    return img_np.astype(np.float32)

def apply_augmentations(tensors, inverse=False, reverse=False):
    augmented_tensors = [tensor.clone() for tensor in tensors]
    if inverse:
        augmented_tensors = [1 - tensor for tensor in augmented_tensors]
    if reverse:
        augmented_tensors = augmented_tensors[::-1]
    return augmented_tensors

def reverse_augmentations(tensor, inverse=False, reverse=False):
    reversed_tensor = tensor.clone()
    if inverse:
        reversed_tensor = 1 - reversed_tensor
    return reversed_tensor

#mirror frames at start or end
def mirror_index(n: int, i: int, max_frames: int) -> int:
    index = n + i
    if index < 0:
        index = -index
    elif index >= max_frames:
        index = 2 * (max_frames - 1) - index
    return index

def calculate_padding(height, width, padding):
    pad_height = (padding - height % padding) % padding
    pad_width = (padding - width % padding) % padding
    return pad_height, pad_width

def RIFE_align(fclip, fref, model_align, device, fp16):
    _, _, h, w = fref.shape
    padding    = 32 #for 100%

    #calculate and apply padding for mocomp
    pad_h, pad_w = calculate_padding(h, w, padding)
    top_pad = pad_h // 2
    bottom_pad = pad_h - top_pad
    left_pad = pad_w // 2
    right_pad = pad_w - left_pad
    fref_padded = torch.nn.functional.pad(fref, (left_pad, right_pad, top_pad, bottom_pad), mode='replicate')
    fclip_padded = torch.nn.functional.pad(fclip, (left_pad, right_pad, top_pad, bottom_pad), mode='replicate')

    #motion compensation
    with torch.no_grad():
        aligned_img0, _ = model_align(fclip_padded, fref_padded, multiplier=1, num_iterations=1, blur_strength=0, ensemble=False, device=device, fp16=fp16) #100%
        aligned_img0, _ = model_align(aligned_img0, fref_padded, multiplier=0.25, num_iterations=1, blur_strength=0, ensemble=False, device=device, fp16=fp16) #400%

    #crop
    output_img_cropped = aligned_img0.squeeze(0)[:, top_pad:top_pad+h, left_pad:left_pad+w]

    return output_img_cropped

def DfConvEkSA_deinterlace(tensors, model_DfConvEkSA, device):
    stacked_tensors = torch.stack(tensors, dim=0).permute(0, 3, 1, 2).to(device)
    with torch.no_grad():
        c, h, w = stacked_tensors.shape[-3:]
        parity_indicator = torch.zeros((1, c, h, w), device=device)
        imgs_LQ = torch.cat([stacked_tensors, parity_indicator], dim=0).unsqueeze(0)
        output = model_DfConvEkSA(imgs_LQ)
    return output

def process_frame(n: int, f: vs.VideoFrame, clip: vs.VideoNode, device, model_DfConvEkSA, model_align=None, tff=False, tta=False, fp16=False) -> vs.VideoFrame:
    frames = [clip.get_frame(mirror_index(n, i, clip.num_frames)) for i in range(-2, 3)]
    arrays = [frame_to_array(frame) for frame in frames]

    #flip arrays if needed
    flip = (n % 2 != 0) if tff else (n % 2 == 0)
    if flip:
        arrays = [np.flipud(arr) for arr in arrays]

    #convert arrays to tensors and change the order of color channels
    dtype = torch.float16 if fp16 else torch.float32
    tensors = [torch.from_numpy(arr[:, :, [2, 1, 0]]).to(dtype).to(device) for arr in arrays]

    #align with RIFE to motion compensate the previous two and next two frames
    if model_align is not None:
        tensors = [tensor.permute(2, 0, 1).unsqueeze(0) for tensor in tensors]
        align_ref_tensor = tensors[2]
        tensors_to_align = [0, 1, 3, 4]
        for idx in tensors_to_align:
            tensors[idx] = RIFE_align(fclip=tensors[idx], fref=align_ref_tensor, model_align=model_align, device=device, fp16=fp16)

        #remove lines based on the field
        def remove_lines(tensor, start_index):
            tensor = tensor.squeeze(0).permute(1, 2, 0)
            return tensor[start_index::2, :, :]
        for i in [0, 2, 4]:
            tensors[i] = remove_lines(tensors[i], 0)
        for i in [1, 3]:
            tensors[i] = remove_lines(tensors[i], 1)

        if fp16:
            tensors = [tensor.to(torch.float32) for tensor in tensors]

    #tta
    if tta:
        augmentations = [
            {'inverse': False, 'reverse': False},
            {'inverse': True, 'reverse': False},
            {'inverse': False, 'reverse': True},
            {'inverse': True, 'reverse': True}
        ]
        augmented_results = []
        for aug in augmentations:
            augmented_tensors = apply_augmentations(tensors, **aug)
            output = DfConvEkSA_deinterlace(augmented_tensors, model_DfConvEkSA, device)
            reversed_output = reverse_augmentations(output, **aug)
            augmented_results.append(reversed_output)
        final_output = torch.mean(torch.stack(augmented_results), dim=0)
    else:
        final_output = DfConvEkSA_deinterlace(tensors, model_DfConvEkSA, device)

    output_img = tensor_to_array(final_output)

    #flip output back if needed
    if flip:
        output_img = np.flipud(output_img)

    output_frame = f.copy()
    array_to_frame(output_img, output_frame)

    return output_frame

def DfConvEkSA(clip: vs.VideoNode, tff=False, tta=False, mocomp=False, device='cuda', fp16=False) -> vs.VideoNode:
    from .DfConvEkSA_files.DfConvEkSA_arch import DfConvEkSA_arch
    
    #checks
    if clip.format.id not in [vs.RGBS]:
        raise ValueError("Input clip must be in RGBS format.")

    device = torch.device(device)
    current_dir = os.path.dirname(__file__)
    
    #load DfConvEkSA model
    model_DfConvEkSA_path = os.path.join(current_dir, 'DfConvEkSA_files', 'DfConvEkSA_dim64k50_trainonYOUKU_150000_G.pth')
    model_DfConvEkSA = DfConvEkSA_arch(64, 5, 8, 5, 7)
    model_DfConvEkSA.load_state_dict(torch.load(model_DfConvEkSA_path), strict=False)
    model_DfConvEkSA.eval().to(device)
    
    #motion compensated DfConvEkSA with RIFE
    if mocomp:
        from .RIFE_files.IFNet_HDv3_v4_14_align import IFNet
        from . import DDD
        
        #load RIFE model
        model_align_path = os.path.join(current_dir, 'RIFE_files', 'flownet_v4.19.pkl') #4.19 seems to work better for this kind of alingment, which is the newest at time of writing
        state_dict_align = torch.load(model_align_path, map_location=device)
        new_state_dict_align = {k.replace('module.', ''): v for k, v in state_dict_align.items()}
        model_align = IFNet().to(device)
        model_align.load_state_dict(new_state_dict_align, strict=False)
        model_align.eval()
        if fp16:
            model_align.half()
        
        #first deinterlacing pass as reference for motion compensation
        clip = DDD(clip, tff=tff, tta=False, device=device, fp16=fp16)

        #motion compensation and second deinterlacing pass
        return clip.std.ModifyFrame(clips=[clip], selector=functools.partial(process_frame, clip=clip, device=device, model_DfConvEkSA=model_DfConvEkSA, model_align=model_align, tff=tff, tta=tta, fp16=fp16))

    #normal DfConvEkSA
    else:
        separated = core.std.SeparateFields(clip, tff=tff)
        clip = core.std.AddBorders(separated, bottom=separated.height)
        return clip.std.ModifyFrame(clips=[clip], selector=functools.partial(process_frame, clip=separated, device=device, model_DfConvEkSA=model_DfConvEkSA, tff=tff, tta=tta))
