import torch
import torch.nn as nn
import torch.nn.functional as F

def single_forward(model, inp):
    with torch.no_grad():
        model_output = model(inp)
        output = model_output[0] if isinstance(model_output, (list, tuple)) else model_output
    return output.data.float().cpu()

def make_layer(block, n_layers):
    return nn.Sequential(*[block() for _ in range(n_layers)])

class ResidualBlock_noBN(nn.Module):
    def __init__(self, nf=64):
        super(ResidualBlock_noBN, self).__init__()
        self.conv1 = nn.Conv2d(nf, nf, 3, 1, 1, bias=True)
        self.conv2 = nn.Conv2d(nf, nf, 3, 1, 1, bias=True)
        self._initialize_weights()

    def _initialize_weights(self, scale=0.1):
        for m in [self.conv1, self.conv2]:
            nn.init.kaiming_normal_(m.weight, a=0, mode='fan_in')
            m.weight.data *= scale
            if m.bias is not None:
                m.bias.data.zero_()

    def forward(self, x):
        identity = x
        out = F.relu(self.conv1(x), inplace=True)
        out = self.conv2(out)
        return identity + out