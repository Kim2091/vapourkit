"""
Base class for models.
New model types inherit from ModelBase and should
- Define a configuration class that inherits from BaseModelConfig
- Define a configuration class that inherits from BaseTrainingConfig
- define an `_initialize_architecture` method
- be decorated with the register_model decorator to link them to a tag and a
model- and training config class
- Overwrite the `forward` method
- Overwrite the `_forward_and_compute_loss` method
- Optional: Overwrite the _create_callbacks method
"""
import torch
from torch import nn
import abc
from pathlib import Path
from .config_utils import Config

# Dict mapping a tag as used in config files to a model class
_MODEL_FROM_TAG = {}
# Dict mapping a model class to its corresponding model config class
_MODEL_CONFIG = {}
# Dict mapping a model class to its corresponding training config class
_MODEL_TRAINING_CONFIG = {}

def register_model(
        cls=None,
        *,
        model_tag=None,
        model_config_class=None,
        training_config_class=None):
    """
    A decorator for registering model classes, linking it to a model- and
    training-config class as well as to a model tag to use in config files.
    Decorate every new model with this decorator.

    Args:
        model_tag (str): An identifier to use in config files to refer
        to this model.
        model_config_class (:obj:`Config`): The config class to be used to
        initialize this model.
        training_config_class (:obj:`Config`): The config class to be used
        to train this model.

    Returns:
        The input class cls unchanged, but registered
    """

    def _register(cls):
        # Ensure that inputs are supplied
        if model_tag is None:
            raise ValueError('model_tag cannot be None')
        if model_config_class is None:
            raise ValueError('model_config_class cannot be None')
        if training_config_class is None:
            raise ValueError('training_config_class cannot be None')

        # Store the mapping from tag to model class
        _MODEL_FROM_TAG[model_tag.lower()] = cls
        # Store the mapping from model class to config classes
        _MODEL_CONFIG[cls] = model_config_class
        _MODEL_TRAINING_CONFIG[cls] = training_config_class

        # Return model class unchanged
        return cls

    # Return decorator method
    if cls is None:
        return _register
    else:
        return _register(cls)

class ModelBase(nn.Module, abc.ABC):
    """
    Abstract model base class.
    """

    def __init__(self, config, device='cpu'):
        super().__init__()
        self.device = device
        self.config = self._initialize_config(config)
        self.activation = self._get_activation(self.config.activation)
        self._initialize_architecture()
        self.to(device)

        state_dict_path = Path(Path(self.config.config_path).parent, 'model_state_dict.pt')
        self.config.state_dict_path = state_dict_path

        state_dict = torch.load(self.config.state_dict_path, map_location=self.device)
        self.load_state_dict(state_dict)

    def _initialize_config(self, config):
        """Initializes the Config subclass corresponding to the model.

        Args:
            config (path, Path): Path to config `.yaml` file
            config (dict, `Config`): Configuration dictionary"""
        self.config = _MODEL_CONFIG[self.__class__](config)
        # Return is not needed, but present to show self.config in __init__
        return self.config

    def count_parameters(self):
        """Counts all trainable parameters."""
        return sum(p.numel() for p in self.parameters() if p.requires_grad)

    def _get_activation(self, activation_type, slope=0.1):
        """Returns a callable activation function of the desired type.

        Args:
            activation_type: One of {'relu', 'leaky_relu', 'sigmoid', 'swish'}
            slope: The negative slope (only used by leaky ReLU)

        Returns:
            A callable activation function
        """
        # Define mapping from name to scheduler class
        str_to_act = {
            'relu': torch.nn.functional.relu,
            'leaky_relu': lambda x: torch.nn.functional.leaky_relu(x, slope),
            'sigmoid': torch.nn.functional.sigmoid,
            'tanh': torch.nn.functional.tanh,
            'swish': torch.nn.functional.silu,
            'silu': torch.nn.functional.silu
        }
        # Try to find the class corresponding to the given name
        try:
            activation_function = str_to_act[activation_type.lower()]
        except KeyError as exc:
            raise NotImplementedError(
                'ERROR: Invalid activation function. Choose'
                f'an activation function from {list(str_to_act.keys())}.') from exc

        return activation_function

class ModelConfig(Config):
    """Model config super class."""

    def _validate(self):
        super()._validate()
        self._must_contain('model_class', element_type=str)
        self._must_contain('state_dict_path', element_type=(str, bool))
        self._must_contain('activation', element_type=str)


class TrainingConfig(Config):
    """Model config super class."""

    def _validate(self):
        super()._validate()
        self._must_contain('model_config', element_type=str)
        self._must_contain('dataset_config', element_type=str)
        self._must_contain('train_limit_num_samples',
                           element_type=int, larger_than=0)
        self._must_contain('test_limit_num_samples',
                           element_type=int, larger_than=0)
        self._must_contain('num_iterations', element_type=int, larger_than=0)
        self._must_contain('batch_size', element_type=int, larger_than=0)
        self._must_contain('evaluation_interval',
                           element_type=int, larger_than=0)
        self._must_contain('checkpoint_interval',
                           element_type=int, larger_than=0)
        self._must_contain('optimizer', element_type=str)
        self._must_contain('optimizer_parameters')
        self._must_contain('gradient_clip_norm')
        self._must_contain('scheduler')
        self._must_contain('scheduler_parameters')
        self._must_contain('scheduler_interval', element_type=int,
                           larger_than=0)