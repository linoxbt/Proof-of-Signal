import numpy as np
import pytest

from pos_model.features import feature_columns
from pos_model.model import train
from pos_model.synth import make_world, world_features


@pytest.fixture(scope="session")
def world():
    return make_world(seed=11, n_pus=900)


@pytest.fixture(scope="session")
def feats(world):
    return world_features(world)


@pytest.fixture(scope="session")
def trained(world, feats):
    return train(feats, world.labels(), feature_columns(feats))


@pytest.fixture
def rng():
    return np.random.default_rng(0)
