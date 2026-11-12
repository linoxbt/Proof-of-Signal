import pandas as pd
import pytest

from pos_model.geo import quadkey_to_tile, tile_bounds
from pos_model.loaders import (NIGERIA_BBOX, pad_pu_code, parse_pu_code, quadkey_prefixes, read_opencellid,
                               read_pu_list)


@pytest.mark.parametrize("raw,expected", [
    ("24/5/8/5", "24-05-08-005"), ("24-05-08-005", "24-05-08-005"), ("1.2.3.45", "01-02-03-045"),
    (" 28 07 05 012 ", "28-07-05-012"), ("PU: 03/11/04/120", "03-11-04-120"),
])
def test_parse_pu_code(raw, expected):
    assert parse_pu_code(raw) == expected


def test_pad_rejects_out_of_range():
    with pytest.raises(ValueError):
        pad_pu_code(1, 2, 3, 1000)
    with pytest.raises(ValueError):
        parse_pu_code("24/05")


def test_read_pu_list_separate_columns(tmp_path):
    p = tmp_path / "pus.csv"
    p.write_text("State Code,LGA Code,Ward Code,PU Number,State,LGA,Ward,Polling Unit Name,Latitude,Longitude\n"
                 "28,7,5,12,Osun,Ife,Ward 5,Town Hall,7.48,4.56\n"
                 "28,7,5,13,Osun,Ife,Ward 5,Market,0,0\n")
    df = read_pu_list(p, "crediblevote")
    assert list(df["pu_code"]) == ["28-07-05-012", "28-07-05-013"]
    assert df.loc[0, "geom_source"] == "crediblevote" and df.loc[0, "geom_conf"] == 0.8
    assert pd.isna(df.loc[1, "lat"]) and df.loc[1, "geom_source"] is None  # (0, 0) is outside Nigeria
    assert df.loc[0, "name"] == "Town Hall"


def test_read_pu_list_code_column(tmp_path):
    p = tmp_path / "inec.csv"
    p.write_text("delimitation,state_name,lga_name,ward_name,pu_name\n24/05/08/005,Lagos,Ikeja,Ward 8,School\n")
    df = read_pu_list(p, "inec")
    assert df.loc[0, "pu_code"] == "24-05-08-005" and pd.isna(df.loc[0, "lat"])


def test_read_opencellid_header_and_headerless(tmp_path):
    hdr = "radio,mcc,net,area,cell,unit,lon,lat,range,samples,changeable,created,updated,averageSignal\n"
    body = "LTE,621,30,123,456789,0,4.55,8.49,1200,15,1,0,0,0\nUMTS,621,20,1,2,0,4.6,8.5,800,3,1,0,0,0\n" \
           "GSM,234,10,1,2,0,0,51,800,3,1,0,0,0\nFOO,621,10,1,2,0,0,51,800,3,1,0,0,0\n"
    a = read_opencellid(hdr + body)
    b = tmp_path / "621.csv"
    b.write_text(body)
    c = read_opencellid(b)
    for df in (a, c):
        assert list(df["radio"]) == ["LTE", "UMTS"] and list(df["mnc"]) == [30, 20]
        assert df.loc[0, "cid"] == 456789 and df.loc[0, "range_m"] == 1200 and df.loc[0, "ocid_samples"] == 15


def test_quadkey_prefixes_cover_nigeria():
    pre = quadkey_prefixes(NIGERIA_BBOX, 8)
    w, s, e, n = NIGERIA_BBOX
    boxes = [tile_bounds(*quadkey_to_tile(q)) for q in pre]
    assert min(b[0] for b in boxes) <= w and max(b[2] for b in boxes) >= e
    assert min(b[1] for b in boxes) <= s and max(b[3] for b in boxes) >= n
