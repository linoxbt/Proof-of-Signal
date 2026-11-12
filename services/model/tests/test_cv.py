import numpy as np
import pandas as pd

from pos_model.cv import assign_folds, h3_blocks, unit_folds
from pos_model.model import context_pool, oof_context, unit_evidence


def test_fold_assignment_deterministic_and_balanced():
    blocks = np.array([f"b{i % 37}" for i in range(1000)])
    a = assign_folds(blocks, n_folds=5, seed=1)
    assert a == assign_folds(blocks, n_folds=5, seed=1)
    load = pd.Series(blocks).map(a).value_counts()
    assert set(load.index) == set(range(5)) and load.max() - load.min() <= 30


def test_no_block_leakage_in_training(world, trained):
    folds = trained.folds
    assert folds["pu_code"].is_unique
    # Every H3 cell sits in exactly one fold.
    assert folds.groupby("block")["fold"].nunique().max() == 1
    # Blocks really are H3 res-6 cells of the units.
    pus = world.pus.set_index("pu_code").loc[folds["pu_code"]]
    assert list(h3_blocks(pus["lat"], pus["lng"], 6)) == list(folds["block"])
    oof = trained.oof.merge(folds, on=["pu_code"], suffixes=("", "_u"))
    assert (oof["fold"] == oof["fold_u"]).all()
    for f in range(5):
        val_blocks = set(oof.loc[oof["fold"] == f, "block"])
        train_blocks = set(oof.loc[oof["fold"] != f, "block"])
        assert val_blocks and not (val_blocks & train_blocks)


def test_out_of_fold_context_never_uses_validation_fold(world, feats, trained):
    labels = world.labels()
    ev = unit_evidence(labels)
    units = feats[["pu_code", "lat", "lng"]].drop_duplicates("pu_code")
    pool = context_pool(ev, units).merge(trained.folds[["pu_code", "fold"]], on="pu_code")
    fold_of = trained.folds.set_index("pu_code")["fold"]
    pairs = labels[["pu_code", "mnc"]].drop_duplicates().merge(units, on="pu_code").reset_index(drop=True)
    for f in range(5):
        ctx = oof_context(pairs, pool, f, return_neighbours=True)
        val = pairs["pu_code"].map(fold_of) == f
        used = {n for lst in ctx.loc[val, "neighbours"] for n in lst}
        assert used, "validation rows should still get neighbours from other folds"
        assert all(fold_of[n] != f for n in used)


def test_unit_folds_weights(world):
    u = unit_folds(world.pus, n_folds=5)
    assert set(u["fold"]) == set(range(5))
