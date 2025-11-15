
# Original paper https://link.springer.com/chapter/10.1007/978-981-99-8073-4_28
# Original code https://github.com/Anonymous2022-cv/DeT

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
    #remove the added border
    half_height = array.shape[0] // 2
    return array[:half_height]

def array_to_frame(img: np.ndarray, frame: vs.VideoFrame):
    for p in range(frame.format.num_planes):
        pls = frame[p]
        frame_arr = np.asarray(pls)
        np.copyto(frame_arr, img[:, :, p])

def apply_augmentations(arrays, inverse=False, reverse=False):
    augmented_arrays = arrays.copy()
    if inverse:
        augmented_arrays = [1 - arr for arr in augmented_arrays]
    if reverse:
        augmented_arrays = augmented_arrays[::-1]
    return augmented_arrays

def reverse_augmentations(arr, inverse=False, reverse=False):
    reversed_arr = arr.copy()
    if inverse:
        reversed_arr = 1 - reversed_arr
    return reversed_arr

#mirror frames at start or end
def mirror_index(n: int, i: int, max_frames: int) -> int:
    index = n + i
    if index < 0:
        index = -index
    elif index >= max_frames:
        index = 2 * (max_frames - 1) - index
    return index

def interpolate(frame, even):
    H, W, C = frame.shape
    doubled_frame = np.zeros((2 * H, W, C), dtype=np.float32)
    for i in range(H):
        doubled_frame[2 * i] = frame[i]
        if even:
            if i < H - 1:
                doubled_frame[2 * i + 1] = (frame[i] + frame[i + 1]) / 2
            else:
                doubled_frame[2 * i + 1] = frame[i]
        else:
            if i > 0:
                doubled_frame[2 * i] = (frame[i] + frame[i - 1]) / 2
            doubled_frame[2 * i + 1] = frame[i]
    return doubled_frame

def inference(arrays, even_values, model, device, fp16):
    with torch.no_grad():
        IR0_even = interpolate(arrays[0], even=even_values[0])
        IR1_odd = interpolate(arrays[1], even=even_values[1])
        IR2_even = interpolate(arrays[2], even=even_values[2])

        IR0_even = torch.from_numpy(IR0_even.transpose((2, 0, 1))).unsqueeze(0).to(device)
        IR1_odd = torch.from_numpy(IR1_odd.transpose((2, 0, 1))).unsqueeze(0).to(device)
        IR2_even = torch.from_numpy(IR2_even.transpose((2, 0, 1))).unsqueeze(0).to(device)

        if fp16:
            IR0_even = IR0_even.half()
            IR1_odd = IR1_odd.half()
            IR2_even = IR2_even.half()

        input = torch.cat((IR0_even.unsqueeze(1), IR1_odd.unsqueeze(1), IR2_even.unsqueeze(1)), dim=1)
        re_frame = model(input).cpu()
        
        if fp16:
            re_frame = re_frame.float()
        
        re_frame = re_frame.numpy().squeeze(0).transpose(1, 2, 0)
        
        return re_frame

def process_frame(n: int, f: vs.VideoFrame, clip: vs.VideoNode, model, device, tff=False, tta=False, fp16=False) -> vs.VideoFrame:
    frames = [
        clip.get_frame(mirror_index(n, i, clip.num_frames)) 
        for i in range(-1, 2)
    ]
    arrays = [frame_to_array(frame) for frame in frames]

    if tff:
        even_values = [
            (n % 2 != 0),  # for IR0
            (n % 2 == 0),  # for IR1
            (n % 2 != 0)   # for IR2
        ]
    else:
        even_values = [
            (n % 2 == 0),  # for IR0
            (n % 2 != 0),  # for IR1
            (n % 2 == 0)   # for IR2
        ]
    
    if tta:
        augmentations = [
            {'inverse': False, 'reverse': False},
            {'inverse': True, 'reverse': False},
            {'inverse': False, 'reverse': True},
            {'inverse': True, 'reverse': True}
        ]
        
        augmented_results = []
        for aug in augmentations:
            augmented_arrays = apply_augmentations(arrays, **aug)
            output_img = inference(augmented_arrays, even_values, model, device, fp16)
            reversed_img = reverse_augmentations(output_img, **aug)
            augmented_results.append(reversed_img)
        
        output_img = np.mean(augmented_results, axis=0)
    else:
        output_img = inference(arrays, even_values, model, device, fp16)
    
    output_frame = f.copy()
    array_to_frame(output_img, output_frame)
    return output_frame

def DeF(clip: vs.VideoNode, tff=False, tta=False, device='cuda', fp16=True) -> vs.VideoNode:
    from .DeF_files.DeF_arch import DeF_arch
    
    #checks
    if clip.format.id not in [vs.RGBS]:
        raise ValueError("Input clip must be in RGBS format.")

    device = torch.device(device)
    current_dir = os.path.dirname(__file__)
    model_path = os.path.join(current_dir, 'DeF_files', 'DeF.pth')
    model = DeF_arch()
    model.load_state_dict(torch.load(model_path))
    model.to(device)    
    model.eval()
    
    if fp16:
        model.half()
    
    clip = core.std.SeparateFields(clip, tff=tff)
    #double frame height because for ModifyFrame input and output frames must have same dimensions
    clip = core.std.AddBorders(clip, bottom=clip.height)
    return clip.std.ModifyFrame(clips=[clip], selector=functools.partial(process_frame, clip=clip, model=model, device=device, tff=tff, tta=tta, fp16=fp16))
