
# Code from "Turbulence Mitigation Transformer" https://github.com/xg416/TMT

import torch
import torch.nn as nn
import torch.nn.functional as F
from einops import rearrange
import random

class LayerNorm3D(nn.Module):
    def __init__(self, dim, bias=True):
        super(LayerNorm3D, self).__init__()
        self.LN = nn.LayerNorm(dim, elementwise_affine=bias)
    
    def to_3d(self, x):
        return rearrange(x, 'b c t h w -> b (t h w) c')

    def to_5d(self,x,t,h,w):
        return rearrange(x, 'b (t h w) c -> b c t h w', t=t, h=h,w=w)

    def forward(self, x):
        t, h, w = x.shape[-3:]
        return self.to_5d(self.LN(self.to_3d(x)), t, h, w)
        
def add_noise(img, sigma):
    noise = (sigma**0.5)*torch.randn(img.shape, device=img.device)
    out = img + noise
    return out.clamp(0,1)
        
class DetiltUNet3DS(nn.Module):
    # __                            __
    #  1|__   ________________   __|1
    #     2|__  ____________  __|2
    #        3|__  ______  __|3
    #           4|__ __ __|4
    # The convolution operations on either side are residual subject to 1*1 Convolution for channel homogeneity
    def __init__(self, num_channels=3, feat_channels=[64, 256, 256, 512], norm='BN', conv_type='normal', residual='conv', noise=0):
        # residual: conv for residual input x through 1*1 conv across every layer for downsampling, None for removal of residuals
        super(DetiltUNet3DS, self).__init__()

        # Encoder downsamplers
        self.pool1 = nn.MaxPool3d((1, 2, 2))
        self.pool2 = nn.MaxPool3d((1, 2, 2))
        self.pool3 = nn.MaxPool3d((1, 2, 2))
        self.pool4 = nn.MaxPool3d((1, 2, 2))

        # Encoder convolutions
        if norm =='BN': 
            norm3d = nn.BatchNorm3d 
        elif norm == 'LN':
            norm3d = LayerNorm3D
            
        self.conv_blk1 = Conv3D_Block(num_channels, feat_channels[0], kernel=7, stride=1, padding=3, norm=norm3d, conv_type='normal', residual=residual, first=True)
        self.conv_blk2 = Conv3D_Block(feat_channels[0], feat_channels[1], kernel=7, stride=1, padding=3, norm=norm3d, conv_type=conv_type, residual=residual)
        self.conv_blk3 = Conv3D_Block(feat_channels[1], feat_channels[2], kernel=5, stride=1, padding=2, norm=norm3d, conv_type=conv_type, residual=residual)
        self.conv_blk4 = Conv3D_Block(feat_channels[2], feat_channels[3], kernel=3, stride=1, padding=1, norm=norm3d, conv_type=conv_type, residual=residual)

        # Decoder convolutions
        self.dec_conv_blk3 = Conv3D_Block(2 * feat_channels[2], feat_channels[2], norm=norm3d, conv_type=conv_type, residual=residual)
        self.dec_conv_blk2 = Conv3D_Block(2 * feat_channels[1], feat_channels[1], norm=norm3d, conv_type=conv_type, residual=residual)
        self.dec_conv_blk1 = Conv3D_Block(2 * feat_channels[0], feat_channels[0], norm=norm3d, conv_type=conv_type, residual=residual)

        # Decoder upsamplers
        self.deconv_blk3 = Deconv3D_Block(feat_channels[3], feat_channels[2], conv_type=conv_type)
        self.deconv_blk2 = Deconv3D_Block(feat_channels[2], feat_channels[1], conv_type=conv_type)
        self.deconv_blk1 = Deconv3D_Block(feat_channels[1], feat_channels[0], conv_type=conv_type)

        # Final 1*1 Conv Segmentation map
        self.out_conv3 = nn.Conv3d(feat_channels[2], 2, kernel_size=3, stride=1, padding=1, bias=True)
        self.out_conv2 = nn.Conv3d(feat_channels[1], 2, kernel_size=3, stride=1, padding=1, bias=True)
        self.out_conv1 = nn.Conv3d(feat_channels[0], 2, kernel_size=3, stride=1, padding=1, bias=True)
        
        self.upsample3 = nn.Upsample(size=None, scale_factor=(1,4,4), mode='trilinear', align_corners=True)
        self.upsample2 = nn.Upsample(size=None, scale_factor=(1,2,2), mode='trilinear', align_corners=True)
        self.noise = noise

    def forward(self, x):
        # Encoder part
        xin = x.permute(0,2,1,3,4)
        xin = add_noise(xin, self.noise*random.random())
        x1 = self.conv_blk1(xin)

        x_low1 = self.pool1(x1)
        x2 = self.conv_blk2(x_low1)

        x_low2 = self.pool2(x2)
        x3 = self.conv_blk3(x_low2)

        x_low3 = self.pool3(x3)
        base = self.conv_blk4(x_low3)

        # Decoder part

        d3 = torch.cat([self.deconv_blk3(base), x3], dim=1)
        d_high3 = self.dec_conv_blk3(d3)
        d2 = torch.cat([self.deconv_blk2(d_high3), x2], dim=1)
        d_high2 = self.dec_conv_blk2(d2)
        d1 = torch.cat([self.deconv_blk1(d_high2), x1], dim=1)
        d_high1 = self.dec_conv_blk1(d1)
        
        flow3 = self.out_conv3(d_high3)
        flow2 = self.out_conv2(d_high2)
        flow1 = self.out_conv1(d_high1)
        out_3 = TiltWarp(x, self.upsample3(flow3))
        out_2 = TiltWarp(out_3, self.upsample2(flow2))
        out = TiltWarp(out_2, flow1)
        return out_3, out_2, out

class UNet3D(nn.Module):
    # __                            __
    #  1|__   ________________   __|1
    #     2|__  ____________  __|2
    #        3|__  ______  __|3
    #           4|__ __ __|4
    # The convolution operations on either side are residual subject to 1*1 Convolution for channel homogeneity

    def __init__(self, num_channels=3, feat_channels=[64, 256, 256, 512, 1024], norm='BN', out_channels=2, conv_type='normal', residual='conv'):
        # residual: conv for residual input x through 1*1 conv across every layer for downsampling, None for removal of residuals

        super(UNet3D, self).__init__()

        # Encoder downsamplers
        self.pool1 = nn.MaxPool3d((1, 2, 2))
        self.pool2 = nn.MaxPool3d((1, 2, 2))
        self.pool3 = nn.MaxPool3d((1, 2, 2))
        self.pool4 = nn.MaxPool3d((1, 2, 2))

        # Encoder convolutions
        if norm =='BN': 
            norm3d = nn.BatchNorm3d 
        elif norm == 'LN':
            norm3d = LayerNorm3D
            
        self.conv_blk1 = Conv3D_Block(num_channels, feat_channels[0], norm=norm3d, conv_type='normal', residual=residual)
        self.conv_blk2 = Conv3D_Block(feat_channels[0], feat_channels[1], norm=norm3d, conv_type=conv_type, residual=residual)
        self.conv_blk3 = Conv3D_Block(feat_channels[1], feat_channels[2], norm=norm3d, conv_type=conv_type, residual=residual)
        self.conv_blk4 = Conv3D_Block(feat_channels[2], feat_channels[3], norm=norm3d, conv_type=conv_type, residual=residual)
        self.conv_blk5 = Conv3D_Block(feat_channels[3], feat_channels[4], norm=norm3d,conv_type=conv_type, residual=residual)

        # Decoder convolutions
        self.dec_conv_blk4 = Conv3D_Block(2 * feat_channels[3], feat_channels[3], norm=norm3d, conv_type=conv_type, residual=residual)
        self.dec_conv_blk3 = Conv3D_Block(2 * feat_channels[2], feat_channels[2], norm=norm3d, conv_type=conv_type, residual=residual)
        self.dec_conv_blk2 = Conv3D_Block(2 * feat_channels[1], feat_channels[1], norm=norm3d, conv_type=conv_type, residual=residual)
        self.dec_conv_blk1 = Conv3D_Block(2 * feat_channels[0], feat_channels[0], norm=norm3d, conv_type=conv_type, residual=residual)

        # Decoder upsamplers
        self.deconv_blk4 = Deconv3D_Block(feat_channels[4], feat_channels[3], conv_type=conv_type)
        self.deconv_blk3 = Deconv3D_Block(feat_channels[3], feat_channels[2], conv_type=conv_type)
        self.deconv_blk2 = Deconv3D_Block(feat_channels[2], feat_channels[1], conv_type=conv_type)
        self.deconv_blk1 = Deconv3D_Block(feat_channels[1], feat_channels[0], conv_type=conv_type)

        # Final output stage
        self.out_conv = nn.Conv3d(feat_channels[0], out_channels, kernel_size=3, stride=1, padding=1, bias=False)
        
    def forward(self, x):
        # Encoder part
        x1 = self.conv_blk1(x)

        x_low1 = self.pool1(x1)
        x2 = self.conv_blk2(x_low1)

        x_low2 = self.pool2(x2)
        x3 = self.conv_blk3(x_low2)

        x_low3 = self.pool3(x3)
        x4 = self.conv_blk4(x_low3)

        x_low4 = self.pool4(x4)
        base = self.conv_blk5(x_low4)

        # Decoder part
        d4 = torch.cat([self.deconv_blk4(base), x4], dim=1)
        d_high4 = self.dec_conv_blk4(d4)
        d3 = torch.cat([self.deconv_blk3(d_high4), x3], dim=1)
        d_high3 = self.dec_conv_blk3(d3)
        d2 = torch.cat([self.deconv_blk2(d_high3), x2], dim=1)
        d_high2 = self.dec_conv_blk2(d2)
        d1 = torch.cat([self.deconv_blk1(d_high2), x1], dim=1)
        d_high1 = self.dec_conv_blk1(d1)

        # seg = self.tanh(self.one_conv(d_high1))
        seg = self.out_conv(d_high1)
        return seg

class DWconv3D(nn.Module):
    def __init__(self, in_channels, out_channels, kernel_size, stride=1, padding=0, dilation=1, bias=True):
        super(DWconv3D, self).__init__()

        self.conv = nn.Sequential(
            nn.Conv3d(in_channels=in_channels, out_channels=in_channels, kernel_size=kernel_size, stride=stride, padding=padding, dilation=dilation, 
                                groups=in_channels, bias=bias),
            nn.Conv3d(in_channels=in_channels, out_channels=out_channels, kernel_size=1))

    def forward(self, x):
        return self.conv(x)

class DWconvTFL(nn.Module):
    def __init__(self, in_channels, out_channels, kernel_size, stride=1, padding=0, dilation=1, bias=True, n_frames=12):
        super(DWconvTFL, self).__init__()

        self.conv = nn.Sequential(
                nn.Conv3d(in_channels=in_channels, out_channels=in_channels, kernel_size=(1,kernel_size,kernel_size), 
                            stride=stride, padding=(0,padding,padding), dilation=dilation, groups=in_channels, bias=bias),
                Rearrange('b c t h w -> b c h w t'),
                nn.Linear(n_frames, n_frames),
                Rearrange('b c h w t -> b c t h w'),
                nn.Conv3d(in_channels=in_channels, out_channels=out_channels, kernel_size=1))
                
    def forward(self, x):
        return self.conv(x)
            
class Conv3D_Block(nn.Module):
    def __init__(self, inp_feat, out_feat, kernel=3, stride=1, padding=1, norm=LayerNorm3D, conv_type='dw', residual=None, first=False):
        super(Conv3D_Block, self).__init__()
        if conv_type == 'normal' or first:
            conv3d = nn.Conv3d
        elif conv_type == 'dw':
            conv3d = DWconv3D

        self.conv1 = nn.Sequential(
            conv3d(inp_feat, out_feat, kernel_size=kernel, stride=stride, padding=padding, bias=True),
            norm(out_feat),
            nn.GELU())
        if first:
            self.conv2 = nn.Sequential(
                DWconv3D(out_feat, out_feat, kernel_size=kernel, stride=stride, padding=padding, bias=True),
                norm(out_feat),
                nn.GELU())
        else:      
            self.conv2 = nn.Sequential(
                conv3d(out_feat, out_feat, kernel_size=kernel, stride=stride, padding=padding, bias=True),
                norm(out_feat),
                nn.GELU())
        self.residual = residual
        if self.residual is not None:
            self.residual_upsampler = conv3d(inp_feat, out_feat, kernel_size=1, bias=False)

    def forward(self, x):
        res = x
        if not self.residual:
            return self.conv2(self.conv1(x))
        else:
            return self.conv2(self.conv1(x)) + self.residual_upsampler(res)


class Deconv3D_Block(nn.Module):
    def __init__(self, inp_feat, out_feat, kernel=3, stride=2, padding=1, norm=LayerNorm3D, conv_type='dw'):
        super(Deconv3D_Block, self).__init__()
        if conv_type == 'normal':
            self.deconv = nn.Sequential(
                norm(inp_feat),
                nn.ConvTranspose3d(inp_feat, out_feat, kernel_size=(kernel, kernel, kernel),
                                stride=(1, stride, stride), padding=(padding, padding, padding), 
                                output_padding=(0,1,1), bias=True),
                nn.GELU())
        if conv_type == 'dw':
            self.deconv = nn.Sequential(
                norm(inp_feat),
                nn.ConvTranspose3d(inp_feat, inp_feat, kernel_size=(kernel, kernel, kernel),
                                stride=(1, stride, stride), padding=(padding, padding, padding), 
                                output_padding=(0,1,1), groups=inp_feat, bias=True),
                nn.Conv3d(in_channels=inp_feat, out_channels=out_feat, kernel_size=1),
                nn.GELU())

    def forward(self, x):
        return self.deconv(x)

def TiltWarp(x, flow, interp_mode='bicubic', padding_mode='reflection', align_corners=True, use_pad_mask=False):
    """
    Args:
        x (Tensor): Tensor with size (b, n, c, h, w) -> (b*n, c, h, w).
        flow (Tensor): Tensor with size (b, 2, n, h, w) -> (b*n, h, w, 2), normal value.
        interp_mode (str): 'nearest' or 'bilinear' or 'nearest4'. Default: 'bilinear'.
        padding_mode (str): 'zeros' or 'border' or 'reflection'.
            Default: 'zeros'.
        align_corners (bool): Before pytorch 1.3, the default value is
            align_corners=True. After pytorch 1.3, the default value is
            align_corners=False. Here, we use the True as default.
        use_pad_mask (bool): only used for PWCNet, x is first padded with ones along the channel dimension.
            The mask is generated according to the grid_sample results of the padded dimension.
    Returns:
        Tensor: Warped image or feature map.
    """
    _, n, c, h, w = x.size()
    x = x.reshape((-1, c, h, w))
    
    flow = flow.permute(0,2,3,4,1).reshape((-1, h, w, 2))
    # create mesh grid
    grid_y, grid_x = torch.meshgrid(torch.arange(0, h, dtype=x.dtype, device=x.device), 
                                    torch.arange(0, w, dtype=x.dtype, device=x.device), indexing='ij')
    grid = torch.stack((grid_x, grid_y), 2).float()  # W(x), H(y), 2
    grid.requires_grad = False
    vgrid = grid + flow

    vgrid_x = 2.0 * vgrid[:, :, :, 0] / max(w - 1, 1) - 1.0
    vgrid_y = 2.0 * vgrid[:, :, :, 1] / max(h - 1, 1) - 1.0
    vgrid_scaled = torch.stack((vgrid_x, vgrid_y), dim=3)
    output = F.grid_sample(x, vgrid_scaled, mode=interp_mode, padding_mode=padding_mode, align_corners=align_corners)
    output = output.reshape((-1, n, c, h, w))
    return output
