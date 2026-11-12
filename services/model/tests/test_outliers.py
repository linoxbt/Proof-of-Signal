import pandas as pd

from pos_model.outliers import flag_outliers


def _rows(times, pu="99-02-01-001", mnc=30):
    return pd.DataFrame({"test_id": [f"t{i}" for i in range(len(times))], "pu_code": pu, "mnc": mnc,
                         "total_ms": times})


def test_extreme_fast_upload_flagged():
    times = [80_000, 95_000, 70_000, 110_000, 88_000, 1_200]
    assert flag_outliers(_rows(times)) == {"t5"}


def test_within_three_mad_not_flagged():
    assert flag_outliers(_rows([80_000, 95_000, 70_000, 110_000, 88_000, 140_000])) == set()


def test_small_groups_and_zero_mad_skipped():
    assert flag_outliers(_rows([80_000, 81_000, 1_000])) == set()  # fewer than 4
    assert flag_outliers(_rows([80_000] * 5 + [1_000])) == set()  # MAD = 0


def test_groups_are_per_unit_and_carrier():
    a = _rows([80_000, 95_000, 70_000, 110_000], mnc=30)
    b = _rows([2_000, 2_100, 1_900, 2_050], mnc=20).assign(test_id=lambda d: "b" + d["test_id"])
    assert flag_outliers(pd.concat([a, b])) == set()
