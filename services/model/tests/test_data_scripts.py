"""The data/ download scripts' offline parts (tile naming, VRT mosaic)."""

import importlib.util
import sys

import numpy as np

from pos_model.config import REPO_ROOT
from pos_model.raster import Raster

sys.path.insert(0, str(REPO_ROOT / "data"))
spec = importlib.util.spec_from_file_location("copernicus_dem", REPO_ROOT / "data" / "copernicus_dem.py")
dem_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dem_mod)


def test_tile_names_for_bbox():
    assert dem_mod.tiles_for_bbox((4.35, 8.25, 4.95, 8.85)) == ["Copernicus_DSM_COG_10_N08_00_E004_00_DEM"]
    names = dem_mod.tiles_for_bbox((2.67, 4.27, 14.68, 13.89))
    assert len(names) == 10 * 13 and "Copernicus_DSM_COG_10_N13_00_E014_00_DEM" in names


def test_vrt_mosaic_reads_back(tmp_path):
    res = 1 / 120
    a = Raster(np.full((120, 120), 100.0, dtype="float32"), west=4.0, north=9.0, dx=res, dy=res)
    b = Raster(np.full((120, 120), 200.0, dtype="float32"), west=5.0, north=9.0, dx=res, dy=res)
    a.to_file(tmp_path / "a.tif")
    b.to_file(tmp_path / "b.tif")
    dem_mod.write_vrt([tmp_path / "a.tif", tmp_path / "b.tif"], tmp_path / "dem.vrt")
    m = Raster.from_file(tmp_path / "dem.vrt")
    assert m.shape == (120, 240)
    assert np.allclose(m.sample([8.5, 8.5], [4.5, 5.5]), [100.0, 200.0])
    w = Raster.from_file(tmp_path / "dem.vrt", bbox=(4.9, 8.4, 5.1, 8.6))
    assert np.allclose(w.sample([8.5], [5.05]), [200.0]) and w.shape[1] < 240
