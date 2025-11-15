import yaml
from pathlib import Path

class Config(dict):
    """Config class derived from dictionary. The class has several extra features:
    - Dot indexing (e.g. config.values.a)
    - Saving to and loading from yaml
    - Checking for validity

    A config recursively turns any internal dictionaries into Config objects.

    The Config class can be subclassed to use in several contexts. When
    subclassing the Config object overwrite the `_validate` method to add
    application specific error checking. Make sure to call the parent
    constructor to also perform super class error checking.
    """

    def __init__(self, initializer=None):
        """Initializes a new config object.

        Args:
            initializer (dict, :obj:`Config`, optional): Input dict to initialize
            with
            initializer (str, Path): Path to config file to initialize with
        """
        super().__init__(self)

        # Detect when the object is initialized with a path and load yaml file
        if isinstance(initializer, (Path, str)):
            initializer = _load_dict_from_yaml(initializer)

        # Initialize with empty dict if nothing is supplied
        if initializer is None:
            initializer = {}

        # Ensure the correct data type
        assert isinstance(initializer, (dict, Config))

        # Copy over all elements to self
        # Initialize element as new Config object if a dict is found
        for key, value in initializer.items():
            if isinstance(value, dict):
                self[key] = Config(value)
            else:
                self[key] = value

        self._validate()

    def __setattr__(self, __name: str, __value) -> None:
        """Overwrites the setattr method to allow for dot indexing."""
        return super().__setitem__(__name, __value)

    def __getattr__(self, key: str):
        """Overwrites the getattr method to allow for dot indexing."""
        return super().__getitem__(key)

    def __setitem__(self, __key, __value):
        """Wraps the setitem method to turn internal dicts into Config
        objects."""
        if isinstance(__value, dict):
            __value = Config(__value)
        return super().__setitem__(__key, __value)

    def _validate(self):
        """Checks if the config is valid. This method can be overridden by
        subclasses to provide specific error checking."""

    def to_dict(self):
        """Builds regular dictionary from Config object, recursively turning any
        internal dicts into dictionaries."""

        # Initialize dict to return
        dictionary = {}

        # Copy and convert all elements
        for key, value in self.items():

            if isinstance(value, Config):
                value = value.to_dict()

            # Copy over to dict
            dictionary[key] = value

        return dictionary

    def save_to_yaml(self, path):
        """Saves config object to yaml file."""
        # Convert to regular dictionary
        dictionary = self.to_dict()
        # Save to file
        with open(Path(path), 'w', encoding='utf-8') as file:
            yaml.dump(dictionary, file, indent=4)

    def _must_contain(self, key, element_type=None, larger_than=None,
                      smaller_than=None, in_set=None):
        """Raises an error if object does not contain an element with the given
        key. Optionally also checks the type."""
        try:
            # Raise error when element is of wrong type
            if element_type is not None and not isinstance(
                    self[key], element_type):
                raise ConfigTypeError(key, element_type)

            # Raise error if input too small
            if larger_than is not None and self[key] < larger_than:
                raise ConfigValueError(
                    f"Element {key} must be larger than {larger_than}")

            # Raise error if input too large
            if smaller_than is not None and self[key] > smaller_than:
                raise ConfigValueError(
                    f"Element {key} must be smaller than {smaller_than}")

            # Raise error if input not in allowed set
            if in_set is not None and not self[key] in in_set:
                raise ConfigValueError(
                    f"Element {key} must be one of {in_set}")
        # Raise error when element is not present
        except KeyError as exc:
            raise MissingElementError(key, element_type) from exc


def _load_dict_from_yaml(path):
    with open(path, 'r', encoding='utf-8') as file:
        file_contents = yaml.load(file, yaml.FullLoader)
    return file_contents


def load_config_from_yaml(path):
    """Loads a Config object from a .yml file."""

    dictionary = _load_dict_from_yaml(path)

    return Config(dictionary)


class InvalidConfigError(RuntimeError):
    """Raised when invalid input is encountered while loading a config file."""
    pass


class MissingElementError(InvalidConfigError):
    def __init__(self, key, element_type):
        super().__init__(
            f"Config must contain element '{key}' of type {element_type}")


class ConfigTypeError(InvalidConfigError):
    """Raised when element in config is of the wrong type."""

    def __init__(self, key, element_type):
        super().__init__(
            f"Config must contain element '{key}' of type {element_type}")


class ConfigValueError(InvalidConfigError):
    """Raised when an element in config has a forbidden value."""

    def __init__(self, message):
        super().__init__(self, message)
