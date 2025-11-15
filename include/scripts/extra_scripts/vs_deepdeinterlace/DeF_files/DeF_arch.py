import torch
from torch import nn
from torch.nn import functional as F
from .arch_util import (ResidualBlockNoBN, make_layer)
from positional_encodings.torch_encodings import PositionalEncodingPermute3D

# Transformer
class Residual(nn.Module):
    def __init__(self, fn):
        super().__init__()
        self.fn = fn
    def forward(self, x, **kwargs):
        return self.fn(x, **kwargs) + x


class PreNorm(nn.Module):
    def __init__(self, num_feat, feat_size, fn):
        super().__init__()
        self.norm = nn.LayerNorm([num_feat, feat_size, feat_size])
        self.fn = fn
    def forward(self, x, **kwargs):
        return self.fn(self.norm(x), **kwargs)

class Fusion(nn.Module):
    def __init__(self, n_FusionB, channels):
        super(Fusion, self).__init__()
        self.n_FusionB = n_FusionB
        self.Block = Fusion_Block(channels)
        self.conv = nn.Conv2d(9, channels, 3, 1, 1)

    def forward(self, x):
        frame1 = x[:, 0, :, :, :]
        IR1_odd = x[:, 1, :, :, :]
        frame2 = x[:, 2, :, :, :]
        for i in range(self.n_FusionB):
            frame1, IR1_odd, frame2 = self.Block(frame1, IR1_odd, frame2)
        # out = self.conv(torch.cat((frame1, IR1_odd, frame2), dim=1))
        out = torch.cat((frame1.unsqueeze(1), IR1_odd.unsqueeze(1), frame2.unsqueeze(1)), dim=1)
        return out

class Set_net(nn.Module):
    def __init__(self, channels):
        super(Set_net, self).__init__()
        ##1
        self.conv11_k3_s1 = nn.Conv2d(channels, channels, 3, 1, 1)  # k3 s1
        self.conv12_k3_s1 = nn.Conv2d(channels, channels, 3, 1, 1)  # k3 s1
        self.conv13_k3_s1 = nn.Conv2d(channels, channels, 3, 1, 1)  # k3 s2

        ##2
        self.conv21_k3_s1 = nn.Conv2d(channels, channels, 3, 1, 1)  # k3 s1
        self.conv22_k3_s1 = nn.Conv2d(channels, channels, 3, 1, 1)  # k3 s2

        ##3
        self.conv31_k3_s1 = nn.Conv2d(channels, channels, 3, 1, 1)  # k3 s1
        self.conv32_k3_s1 = nn.Conv2d(channels, channels, 3, 1, 1)  # k3 s2

        ##4
        self.conv41_k3_s1 = nn.Conv2d(channels*2, channels, 3, 1, 1)  # k3 s1
        self.conv42_k3_s1 = nn.Conv2d(channels, channels, 3, 1, 1)  # k3 s1

        ##5
        self.conv51_k3_s1 = nn.Conv2d(channels*2, channels, 3, 1, 1)  # k3 s1
        self.conv52_k3_s1 = nn.Conv2d(channels, channels, 3, 1, 1)  # k3 s1

        ##6
        self.conv61_k3_s1 = nn.Conv2d(channels, channels, 3, 1, 1)  # k3 s1
        self.conv62_k3_s1 = nn.Conv2d(channels, channels, 3, 1, 1)  # k3 s1
        self.conv63_k3_s1 = nn.Conv2d(channels, 64, 3, 1, 1)  # k3 s1

        self.pool = nn.AvgPool2d(kernel_size=2)
        self.LRelu = nn.LeakyReLU(0.1, inplace=True)
        self.upsample = nn.Upsample(scale_factor=2, mode='bilinear')

    def forward(self, feature):
        ##1
        out = self.LRelu(self.conv12_k3_s1(self.conv11_k3_s1(feature)))
        out1 = self.pool(self.LRelu(self.conv13_k3_s1(out)))

        ##2
        out = self.LRelu(self.conv21_k3_s1(out1))
        out2 = self.pool(self.LRelu(self.conv22_k3_s1(out)))

        ##3
        out = self.LRelu(self.conv31_k3_s1(out2))
        out3 = self.pool(self.upsample(self.LRelu(self.conv32_k3_s1(out))))

        ##4
        out = self.LRelu(self.conv41_k3_s1(torch.cat((out3, out2), dim=1)))
        out4 = self.upsample(self.LRelu(self.conv42_k3_s1(out)))

        ##5
        out = self.LRelu(self.conv51_k3_s1(torch.cat((out4, out1), dim=1)))
        out5 = self.upsample(self.LRelu(self.conv52_k3_s1(out)))

        ##6
        out = self.LRelu(self.conv61_k3_s1(out5))
        out6 = self.conv63_k3_s1(self.LRelu(self.conv62_k3_s1(out)))

        return out6

class Fusion_Block(nn.Module):
    def __init__(self, channels):
        super(Fusion_Block, self).__init__()
        self.conv1 = nn.Conv2d(channels, channels, 3, 1, 1)
        self.conv2 = nn.Conv2d(channels, channels, 3, 1, 1)
        # self.conv3 = nn.Conv2d(channels*3, channels, 1, 1, 0)
        self.set_net = Set_net(channels*3)
        self.conv4 = nn.Conv2d(channels*2, channels, 3, 1, 1)

    def forward(self, frame1, IR1_odd, frame2):
        out1 = self.conv1(frame1)
        out2 = self.conv2(IR1_odd)
        out3 = self.conv1(frame2)
        input = self.set_net(torch.cat((out1, out2, out3), dim=1))
        out1 = self.conv4(torch.cat((out1, input), dim=1)) + frame1
        out2 = self.conv4(torch.cat((out2, input), dim=1)) + IR1_odd
        out3 = self.conv4(torch.cat((out3, input), dim=1)) + frame2
        return out1, out2, out3

class Densenet(nn.Module):
    def __init__(self, n_RDB, channels):
        super(Densenet, self).__init__()
        body = []
        end = []
        for i in range(n_RDB):
            body.append(RDB(n_RDB, channels))
        self.body = nn.Sequential(*body)
        end.append(nn.Conv2d(channels, 64 * 4, 1, 1, 0, bias=False))
        end.append(nn.LeakyReLU(0.1, inplace=True))
        end.append(nn.Conv2d(64 * 4, 64, 1, 1, 0, bias=False))
        end.append(nn.LeakyReLU(0.1, inplace=True))
        end.append(nn.Conv2d(64, 32, 1, 1, 0, bias=False))
        end.append(nn.LeakyReLU(0.1, inplace=True))
        end.append(nn.Conv2d(32, 3, 1, 1, 0, bias=False))
        end.append(nn.LeakyReLU(0.1, inplace=True))
        self.end = nn.Sequential(*end)

    def forward(self, x):
        return self.end(self.body(x) + x)

class DesB(nn.Module):
    def __init__(self, channels):
        super(DesB, self).__init__()
        self.conv = nn.Conv2d(channels, channels // 2, 1, 1, 0, bias=False)
        self.body = nn.Sequential(
            nn.Conv2d(channels // 2, channels // 2, 1, 1, 0, bias=False),
            nn.LeakyReLU(0.1, inplace=True),
        )

    def forward(self, x):
        x = self.conv(x)
        out = self.body(x)
        out = torch.cat((x, out), dim=1)
        return out

class RDB(nn.Module):
    def __init__(self, n_DesB, channels):
        super(RDB, self).__init__()
        body = []
        for i in range(n_DesB):
            body.append(DesB(channels))
        self.body = nn.Sequential(
            *body,
            nn.Conv2d(channels, channels, 1, 1, 0, bias=False),
            nn.LeakyReLU(0.1, inplace=True),
        )

    def forward(self, x):
        return self.body(x) + x

class globalAttention(nn.Module):
    def __init__(self, num_feat=64, patch_size=8, heads=1):
        super(globalAttention, self).__init__()
        self.heads = heads
        self.dim = patch_size ** 2 * num_feat
        self.hidden_dim = self.dim // heads
        self.num_patch = (64 // patch_size) ** 2

        self.to_q = nn.Conv2d(in_channels=num_feat, out_channels=num_feat, kernel_size=3, padding=1, groups=num_feat)
        self.to_k = nn.Conv2d(in_channels=num_feat, out_channels=num_feat, kernel_size=3, padding=1, groups=num_feat)
        self.to_v = nn.Conv2d(in_channels=num_feat, out_channels=num_feat, kernel_size=3, padding=1)

        self.conv = nn.Conv2d(in_channels=num_feat, out_channels=num_feat, kernel_size=3, padding=1)

        # self.feat2patch = torch.nn.Unfold(kernel_size=patch_size, padding=0, stride=patch_size)
        # self.patch2feat = torch.nn.Fold(output_size=(h, w), kernel_size=patch_size, padding=0, stride=patch_size)

    def forward(self, x):
        b, t, c, h, w = x.shape                                # B, 5, 64, 64, 64
        H, D = self.heads, self.dim
        n, d = self.num_patch, self.hidden_dim

        q = self.to_q(x.view(-1, c, h, w))                     # [B*5, 64, 64, 64]
        k = self.to_k(x.view(-1, c, h, w))                     # [B*5, 64, 64, 64]
        v = self.to_v(x.view(-1, c, h, w))                     # [B*5, 64, 64, 64]

        # unfold_q = self.feat2patch(q)                          # [B*5, 8*8*64, 8*8]
        # unfold_k = self.feat2patch(k)                          # [B*5, 8*8*64, 8*8]
        # unfold_v = self.feat2patch(v)                          # [B*5, 8*8*64, 8*8]
        unfold_q = F.unfold(q, kernel_size=(8, 8), padding=0, stride=8)
        unfold_k = F.unfold(k, kernel_size=(8, 8), padding=0, stride=8)
        unfold_v = F.unfold(v, kernel_size=(8, 8), padding=0, stride=8)

        unfold_q = unfold_q.view(b, t, H, d, -1)                # [B, 5, H, 8*8*64/H, 8*8]
        unfold_k = unfold_k.view(b, t, H, d, -1)                # [B, 5, H, 8*8*64/H, 8*8]
        unfold_v = unfold_v.view(b, t, H, d, -1)                # [B, 5, H, 8*8*64/H, 8*8]

        unfold_q = unfold_q.permute(0,2,3,1,4).contiguous()    # [B, H, 8*8*64/H, 5, 8*8]
        unfold_k = unfold_k.permute(0,2,3,1,4).contiguous()    # [B, H, 8*8*64/H, 5, 8*8]
        unfold_v = unfold_v.permute(0,2,3,1,4).contiguous()    # [B, H, 8*8*64/H, 5, 8*8]

        unfold_q = unfold_q.view(b, H, d, -1)                 # [B, H, 8*8*64/H, 5*8*8]
        unfold_k = unfold_k.view(b, H, d, -1)                 # [B, H, 8*8*64/H, 5*8*8]
        unfold_v = unfold_v.view(b, H, d, -1)                 # [B, H, 8*8*64/H, 5*8*8]

        if hasattr(torch.cuda, 'empty_cache'):
            torch.cuda.empty_cache()

        attn = torch.matmul(unfold_q.transpose(2,3), unfold_k) # [B, H, 5*8*8, 5*8*8]
        attn = attn * (d ** (-0.5))                            # [B, H, 5*8*8, 5*8*8]
        attn = F.softmax(attn, dim=-1)                         # [B, H, 5*8*8, 5*8*8]
        if hasattr(torch.cuda, 'empty_cache'):
            torch.cuda.empty_cache()

        attn_x = torch.matmul(attn, unfold_v.transpose(2,3))   # [B, H, 5*8*8, 8*8*64/H]
        attn_x = attn_x.view(b, H, t, -1, d)                    # [B, H, 5, 8*8, 8*8*64/H]
        attn_x = attn_x.permute(0, 2, 1, 4, 3).contiguous()    # [B, 5, H, 8*8*64/H, 8*8]
        attn_x = attn_x.view(b*t, D, -1)                        # [B*5, 8*8*64, 8*8]
        # feat = self.patch2feat(attn_x)                         # [B*5, 64, 64, 64]
        feat = F.fold(attn_x, output_size=(h, w), kernel_size=8, padding=0, stride=8)

        out = self.conv(feat).view(x.shape)                    # [B, 5, 64, 64, 64]
        out += x                                               # [B, 5, 64, 64, 64]

        return out

class DeF_arch(nn.Module):
    def __init__(self,
                 image_ch=3,
                 num_feat=64,
                 feat_size=64,
                 num_frame=5,
                 num_extract_block=5,
                 num_reconstruct_block=30,
                 depth=10,
                 heads=1,
                 patch_size=8,
                 n_FusionB = 3,
                 n_RDB = 6
                 ):
        super(DeF_arch, self).__init__()
        self.num_reconstruct_block = num_reconstruct_block
        self.center_frame_idx = num_frame // 2
        self.num_frame = num_frame

        # Feature extractor
        self.conv_first = nn.Conv2d(image_ch, num_feat, 3, 1, 1)
        self.feature_extraction = make_layer(ResidualBlockNoBN, num_extract_block, num_feat=num_feat)
        self.lrelu = nn.LeakyReLU(negative_slope=0.1, inplace=True)


        # Transformer
        self.pos_embedding = PositionalEncodingPermute3D(num_frame)
        self.globalAttention = globalAttention(num_feat, patch_size, heads)
        self.Fusion = Fusion(n_FusionB, num_feat)
        # self.transformer = Transformer(num_feat, feat_size, depth, patch_size, heads, n_FusionB)

        # Reconstruction
        self.reconstruction = make_layer(ResidualBlockNoBN, num_reconstruct_block, num_feat=num_feat)

        self.conv_fusion = nn.Conv2d(num_feat * 3, num_feat, 3, 1, 1)
        self.Densenet = Densenet(n_RDB, num_feat)

    def forward(self, x):

        b, t, c, h, w = x.size()                                         # [B, 5, 3, 64, 64]
        assert h%4==0 and w%4==0, ('w and h must be multiple of 4')

        # extract features for each frame
        feat = self.lrelu(self.conv_first(x.view(-1, c, h, w)))          # [B*5, 64, 64, 64]
        feat = self.feature_extraction(feat).view(b, t, -1, h, w)        # [B, 5, 64, 64, 64]

        # compute optical flow
        # flows = self.spynet(x)                                           # [B, 4, 2, 64, 64] x 2

        # transformer
        feat = feat + self.pos_embedding(feat)                           # [B, 5, 64, 64, 64]
        # tr_feat = self.transformer(feat)                                 # [B, 5, 64, 64, 64]
        feat = feat + self.globalAttention(feat)
        tr_feat = feat + self.Fusion(feat)
        feat = self.conv_fusion(torch.cat((tr_feat[:, 0, :, :, :], tr_feat[:, 1, :, :, :], tr_feat[:, 2, :, :, :]), dim=1))
        feat = self.reconstruction(feat)                                 # [B, 64, 64, 64]   -> [B*5, 64, 64, 64]
        out = self.Densenet(feat)
        out = out + x[:, 1, :, :, :]

        return out

if __name__ == '__main__':
    sim_data = torch.rand(1, 3, 3, 512, 512)
    h, w = sim_data.size()[-2:]
    net = DeF_arch()
    pred = net(sim_data)
    print(pred.size())
