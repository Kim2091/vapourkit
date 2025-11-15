import torch
from torch import nn
import numpy as np
from .model_base_arch import ModelBase, ModelConfig, TrainingConfig, register_model

class DisneyModelConfig(ModelConfig):
    """Config class to initialize DisneyModel."""

    def _validate(self):
        super()._validate()
        self._must_contain('num_rdb_blocks', element_type=int, larger_than=0)
        self._must_contain('num_dense_blocks_per_rdb',
                           element_type=int, larger_than=0)
        self._must_contain('num_frames', element_type=int, in_set=(1, 3, 5))
        self._must_contain('rdb_num_filters', element_type=int, larger_than=0)
        self._must_contain('dense_block_num_filters_added',
                           element_type=int, larger_than=0)
        self._must_contain('num_color_channels', int, in_set=(1, 3))

class DisneyTrainingConfig(TrainingConfig):
    """Config class to train DisneyModel."""

    def _validate(self):
        super()._validate()
        self._must_contain('show_interpolation_interval', element_type=int,
                           larger_than=0)
        self._must_contain('selected_image', element_type=int, larger_than=0)

@register_model(model_tag='Disney', model_config_class=DisneyModelConfig,
                training_config_class=DisneyTrainingConfig)
class DisneyModel(ModelBase):
    """The model architecture presented in the 2020 paper 'Deep Deinterlacing'.
    """

    def _initialize_architecture(self):
        self.all_modules = []
        self.residual_dense_blocks = []

        # This is a layer that expands the input to the number of channels used in the RDB
        self.expand = torch.nn.Conv2d(
            in_channels=self.config.num_frames*self.config.num_color_channels,
            out_channels=self.config.rdb_num_filters,
            kernel_size=3,
            padding='same'
        )

        for n in range(self.config.num_rdb_blocks):

            self.residual_dense_blocks.append(ResidualDenseBlock(
                in_out_channels=self.config.rdb_num_filters,
                num_filters_added=self.config.dense_block_num_filters_added,
                activation=self.activation,
                num_blocks=self.config.num_dense_blocks_per_rdb,
                device=self.device))

        self.combine = torch.nn.Conv2d(
            in_channels=self.config.rdb_num_filters,
            out_channels=self.config.num_color_channels,
            kernel_size=3,
            padding='same'
        )

        self.all_modules = nn.ModuleList(
            [self.expand, *self.residual_dense_blocks, self.combine])

        self.config.num_parameters = self.count_parameters()

    def forward(self, x):
        """Performs a forward pass to compute the field corresponding to I+
        corresponding to I- in the middle channel of the input.

        Args:
            x (:obj:`Tensor` (B, C, H, W)): Input tensor containing a number of
            field with the field from the frame to be reconstructed in the
            middle channel."""

        # Remember input for later
        h = x

        # Perform fusion
        h = self.activation(self.expand(h))

        # Remember first RDB input for later
        h0 = h

        # Pass through all blocks
        for block in self.residual_dense_blocks:
            h = block(h)

        # Skip connection over all blocks
        h = h+h0

        # Sum into single channel
        # h = torch.sum(h, dim=1)[:, None]
        h = self.combine(h)

        # Add the estimated residual to the simple interpolation (this trains
        # the model to predict the residual error with linear interpolation,
        # making the learning task easier)
        start_index, end_index = DisneyModel.get_middle_field_channel_indices(
            x,
            self.config.num_color_channels
        )
        interpolated_field = self._linear_row_interpolation(x[:, start_index:end_index])
        h = interpolated_field + h

        return h

    def _linear_row_interpolation(self, x):
        """Performs linear interpolation over the rows as an initial estimate.

        Args:
            x (:obj:`Tensor`)(..., H, W): The known half of the lines from the
            frame to estimate. This must be the odd lines!

        Returns:
            The estimated missing field I_plus (..., H, W).
        """

        interpolated = torch.zeros_like(x)

        # Perform 1D linear interpolation on every line by taking the average of
        # the surrounding two lines
        interpolated[..., 1:] = 0.5*(x[..., 1:]+x[..., :-1])
        # The last line has no right neighbour. For this one we just copy the input field
        interpolated[..., 0] = x[..., 0]

        return interpolated



    @staticmethod
    def sample_to_im(sample, num_color_channels=1):
        """
        Converts a sample from the triplets dataset into an image. If sample has
        a batch dimension the first sample is used.

        Args:
            sample (tuple of tensors): (input_field, ground_truth)(Tensor `(B,
            C, H, W)` or `(C, H, W)`)

        Returns:
            The image (Numpy array (H, W, C))
        """

        input_fields, ground_truth_field = sample

        im = DisneyModel.combine_fields(input_fields, ground_truth_field,
            num_color_channels)

        # Remove possible batch dimension
        if len(im.shape) == 4:
            im = im[0]

        # Move channel dimension to the back
        im = np.transpose(im, (1, 2, 0))

        return im

    @staticmethod
    def combine_fields(I_min, I_plus, num_color_channels=1):
        """
        Combines two fields of an image into a single image.

        Args:
            I_min: The odd lines (..., H, W)
            I_plus: The even lines (..., H, W)

        returns:
            Combined image numpy.ndarray (..., H, 2*W)
        """
        # Get the shape of the fields
        shape = list(I_min.shape)
        # Double the width (because we concatenate two)
        shape[-1] = 2*shape[-1]

        start_index, end_index = DisneyModel.get_middle_field_channel_indices(
            I_min,
            num_color_channels
        )

        image_shape = shape
        image_shape[-3] = num_color_channels

        # Fill in the fields in the right columns of the image
        im = np.zeros(image_shape)
        im[..., :, :, ::2] = I_plus
        im[..., :, :, 1::2] = I_min[..., start_index:end_index, :, :]

        return im

    @staticmethod
    def get_middle_field_channel_indices(fields, num_color_channels=1):
        """
        Determines the slicing indices to get the middle field from a tensor of fields.

        Args:
            fields (..., C, H, W): The tensor of fields
            num_color_channels: The number of color channels in an image (either 1 or 3)
        """

        assert num_color_channels in (1, 3), 'num_color_channels must be 1 or 3.'

        shape = fields.shape

        # Determine the channels corresponding to the middle field
        num_channels = shape[-3]
        middle_channel = int((num_channels-1)/2)

        # Determine the channels in I_min to use as field (This makes it
        # possible to insert a tensor that also contains the preceding and
        # following fields)
        if num_color_channels == 1:
            start_index = middle_channel
        else:
            start_index = middle_channel-1

        end_index = start_index+num_color_channels

        return start_index, end_index

class ResidualDenseBlock(nn.Module):
    """Component block consisting of several dense blocks followed by a
    compression block. The input is added to the outputthrough a skip
    connection."""

    def __init__(self, in_out_channels, activation, num_blocks, num_filters_added, device):
        super().__init__()

        self.dense_blocks = []

        self.activation = activation
        self.num_blocks = num_blocks

        # Store input and output channel counts for the entire block
        self.in_out_channels = in_out_channels

        # Set channel counts for current dense block
        in_channels = in_out_channels
        out_channels = in_channels+num_filters_added

        for _ in range(num_blocks):
            self.dense_blocks.append(DenseBlock(
                in_channels=in_channels,
                out_channels=out_channels,
                kernel_size=3,
                activation=self.activation,
                device=device))

            in_channels = out_channels
            out_channels = out_channels+num_filters_added

        self.compression_block = CompressionBlock(
            in_channels=in_channels,
            out_channels=self.in_out_channels,
            kernel_size=3,
            activation=activation
        )

        self.all_modules = nn.ModuleList(
            [*self.dense_blocks, self.compression_block])

    def forward(self, x):
        """Performs a forward pass through the block by sequentially passing
        through all component DenseBlock layers, then through a CompressionBlock
        layer, and then adding the input tensor.

        Args:
            x ((B,C,H,W) Tensor): The input
        """

        # Assign new variable to hang on to the input
        h = x

        # Pass through all dense blocks
        for block in self.dense_blocks:
            h = block(h)

        # Pass through compression block
        h = self.compression_block(h)

        # Add the input to the result
        h = h + x

        return h

class DenseBlock(nn.Module):
    """Component block consisting of a Conv2D layer and an activation layer. The
    output of these layers is concatenated to the input along the channel
    dimension through a skip connection."""

    def __init__(self, in_channels, out_channels, activation, kernel_size=3,
                 device='cpu'):
        super().__init__()

        self.activation = activation
        self.in_channels = in_channels
        self.out_channels = out_channels

        # Construct a Conv2d layer such that its output layers and input layers
        # sum to the number of output_layers for the DenseBlock.
        self.conv = torch.nn.Conv2d(
            in_channels=in_channels,
            out_channels=out_channels - in_channels,
            kernel_size=kernel_size,
            device=device,
            padding='same')

    def forward(self, x):
        """Performas a forward pass through the block.

        Args:
            x: The input tensor (B, C, H, W)

        Returns:
            Output passed through the block concatenated with input
            (B, C, H, W)"""
        # Pass through layer and apply activation
        processed = self.activation(self.conv(x))
        # Concatenate input and processed input along channel dimension
        concatenated = torch.concat((x, processed), dim=1)

        return concatenated

class CompressionBlock(nn.Module):
    """Component block consisting of a Conv2D layer and an acivation layer. The
    convolutional layer reduces the number of channels."""

    def __init__(self, in_channels, out_channels, kernel_size, activation,
                 device='cpu'):
        super().__init__()

        self.activation = activation

        assert out_channels <= in_channels, 'Cannot compress and increase the channel count.'

        self.conv = torch.nn.Conv2d(
            in_channels=in_channels,
            out_channels=out_channels,
            kernel_size=kernel_size,
            device=device,
            padding='same')

    def forward(self, x):
        """Performas a forward pass through the block.

        Args:
            x: The input tensor (B, C, H, W)

        Returns:
            Output passed through the block (B, C, H, W)"""
        # Pass through layer and apply activation

        return self.activation(self.conv(x))
